/**
 * Best-effort screening of a host route (an absolute path with optional
 * query and fragment) that arrived from outside the app: a deep link, a
 * universal link or a push notification. It refuses paths that leave the
 * host and parameters whose names say they carry a credential, so a link
 * cannot hand a host screen a token, a session or an OAuth code (login CSRF,
 * session fixation). Names are a list and patterns, not proof: a credential
 * under an innocuous name still passes, and the host must not trust a value
 * only because the mobile app opened the route.
 */
export interface MobileRouteSafetyOptions {
  /**
   * Accept a `code` parameter (for example `/join?code=…` invites). It is
   * still refused on OAuth-looking paths (`callback`, `oauth`, `authorize`).
   */
  readonly allowCodeParameter?: boolean;
}

export const MAX_MOBILE_ROUTE_PATH_LENGTH = 2048;

/**
 * Exact credential names, compared lowercased with non-alphanumerics removed.
 * Includes Takosumi's `CREDENTIAL_QUERY_NAMES` (contract/interface-display.ts)
 * plus OAuth, SSO and session names.
 */
const CREDENTIAL_NAMES = new Set([
  // Takosumi CREDENTIAL_QUERY_NAMES
  "accesskey",
  "accesstoken",
  "apikey",
  "auth",
  "authorization",
  "bearertoken",
  "clientsecret",
  "cookie",
  "credential",
  "credentials",
  "credentialvalue",
  "jwt",
  "passwd",
  "password",
  "privatekey",
  "proxyauthorization",
  "refreshtoken",
  "secret",
  "session",
  "sessionid",
  "sessiontoken",
  "sig",
  "signature",
  "signingkey",
  "token",
  "xamzcredential",
  "xamzsecuritytoken",
  "xamzsignature",
  "xgoogcredential",
  "xgoogsignature",
  "xapikey",
  // OAuth / OIDC / SAML / CAS / product setup
  "assertion",
  "authcode",
  "authorizationcode",
  "clientassertion",
  "idtoken",
  "oauthverifier",
  "samlrequest",
  "samlresponse",
  "setupticket",
  "sid",
  "ticket",
]);

/** Prefixes of signed-URL parameter families (AWS SigV4, Google Cloud). */
const CREDENTIAL_PREFIXES = ["xamz", "xgoog"];

/** Endings that name a credential under any prefix (`auth_token`, `jsessionid`). */
const CREDENTIAL_SUFFIXES = [
  "token",
  "secret",
  "password",
  "passwd",
  "signature",
  "credential",
  "credentials",
  "apikey",
  "accesskey",
  "privatekey",
  "signingkey",
  "sessionid",
  "sessid",
];

/** `…token` names that are pagination cursors, not credentials. */
const NON_CREDENTIAL_TOKEN_SUFFIXES = ["pagetoken", "continuationtoken"];

const OAUTH_LIKE_PATH = /callback|oauth|authorize/u;

/** Throws when `path` is not a safe same-origin host route. */
export function assertSafeMobileRoutePath(
  path: string,
  options: MobileRouteSafetyOptions = {},
): void {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error("Mobile route path must be an absolute same-origin path.");
  }
  if (path.length > MAX_MOBILE_ROUTE_PATH_LENGTH) {
    throw new Error("Mobile route path is too long.");
  }
  // Control characters and whitespace have no place in a route and are how
  // header or log injection and lookalike paths start.
  if (/[\u0000-\u0020\u007f-\u009f\u2028\u2029]/u.test(path)) {
    throw new Error("Mobile route path must not contain spaces or control characters.");
  }
  // `/\host` and similar spellings resolve to another origin under the URL
  // parser even though they start with a single slash.
  const base = "https://route.invalid";
  let resolved: URL;
  try {
    resolved = new URL(path, `${base}/`);
  } catch {
    throw new Error("Mobile route path must be an absolute same-origin path.");
  }
  if (resolved.origin !== base) {
    throw new Error("Mobile route path must be an absolute same-origin path.");
  }
  // An OAuth-looking path, in the URL or in a fragment route (`#/oauth/…`),
  // keeps `code` refused even for a product that accepts invite codes.
  const fragmentPath = resolved.hash.slice(1).split("?")[0] ?? "";
  const oauthLikePath = [resolved.pathname, fragmentPath].some((candidate) =>
    OAUTH_LIKE_PATH.test(decodeLoosely(candidate).toLowerCase())
  );
  const allowCode = Boolean(options.allowCodeParameter) && !oauthLikePath;
  const sources = [
    // `;name=value` path parameters (`/x;jsessionid=…`).
    ...resolved.pathname
      .split("/")
      .filter((segment) => segment.includes(";"))
      .map((segment) => segment.slice(segment.indexOf(";") + 1)),
    resolved.search.slice(1),
    // The whole fragment and any query inside it (`#access_token=…`,
    // `#/callback?code=…`); a plain `#section` anchor has no `=` and passes.
    resolved.hash.slice(1),
  ];
  for (const source of sources) {
    for (const [name, value] of parameterPairs(source)) {
      if (!value.trim()) continue;
      // Compatibility forms (full-width `ｔｏｋｅｎ`) fold to ASCII; any other
      // non-ASCII name could spell a credential in lookalike letters, so it is
      // refused rather than guessed at.
      const folded = name.normalize("NFKC");
      if ([...folded].some((character) => character.charCodeAt(0) > 0x7e)) {
        throw new Error("Mobile route parameter names must be ASCII.");
      }
      if (parameterNameParts(folded).some((part) => isCredentialName(part, allowCode))) {
        throw new Error("Mobile route links must not carry credentials.");
      }
    }
  }
}

/** True when `path` is a safe same-origin host route. */
export function isSafeMobileRoutePath(
  path: string,
  options: MobileRouteSafetyOptions = {},
): boolean {
  try {
    assertSafeMobileRoutePath(path, options);
    return true;
  } catch {
    return false;
  }
}

/** `name=value` pairs separated by `&`, `;` or `?`; parts without `=` are skipped. */
function parameterPairs(text: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const part of text.split(/[&;?]/u)) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    pairs.push([
      decodeLoosely(part.slice(0, separator)),
      decodeLoosely(part.slice(separator + 1)),
    ]);
  }
  return pairs;
}

/**
 * A name and the keys of its trailing `[…]` groups: `token[]` → `token`,
 * `auth[token]` → `auth`, `token`; `user[password]` → `user`, `password`.
 */
function parameterNameParts(name: string): string[] {
  const match = /^(.*?)((?:\[[^\[\]]*\])+)$/u.exec(name);
  if (!match) return [name];
  const keys = [...(match[2] ?? "").matchAll(/\[([^\[\]]*)\]/gu)].map(
    (key) => key[1] ?? "",
  );
  return [match[1] ?? "", ...keys];
}

/** Percent-decodes up to three times so double-encoded names are still read. */
function decodeLoosely(value: string): string {
  let current = value.replace(/\+/gu, " ");
  for (let round = 0; round < 3; round += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return current;
    }
    if (next === current) return current;
    current = next;
  }
  return current;
}

function isCredentialName(name: string, allowCode: boolean): boolean {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/gu, "");
  if (!normalized) return false;
  if (normalized === "code") return !allowCode;
  if (CREDENTIAL_NAMES.has(normalized)) return true;
  if (CREDENTIAL_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return true;
  }
  if (NON_CREDENTIAL_TOKEN_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) {
    return false;
  }
  return CREDENTIAL_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}
