import type {
  FetchLike,
  OidcAuthorizationUrlInput,
  OidcCallbackResult,
  OidcMetadata,
  OidcTokenExchangeInput,
  OidcTokenResponse,
  PkcePair,
} from "./types.ts";
import { hostEndpoint, normalizeHostUrl, requireSecureWebUrl } from "./url.ts";
import { decodeWire, type WireDecoder } from "./wire.ts";

/**
 * RFC 8414 discovery document, decoded through a value instead of an `as`
 * cast: the shell must not assert what an issuer emits, and a mistyped field
 * has to name the document and the issuer URL that produced it.
 */
export const OIDC_DISCOVERY_DECODER: WireDecoder<Partial<OidcMetadata>> = {
  document: "OIDC discovery",
  decode(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("document must be a JSON object");
    }
    const record = value as Record<string, unknown>;
    for (const field of [
      "issuer",
      "authorization_endpoint",
      "token_endpoint",
      "revocation_endpoint",
      "introspection_endpoint",
    ] as const) {
      const entry = record[field];
      if (entry !== undefined && typeof entry !== "string") {
        throw new Error(`${field} must be a string`);
      }
    }
    return record as Partial<OidcMetadata>;
  },
};

export const OIDC_TOKEN_RESPONSE_DECODER: WireDecoder<OidcTokenResponse> = {
  document: "OIDC token response",
  decode(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("document must be a JSON object");
    }
    const record = value as Record<string, unknown>;
    requireNonEmptyTokenString(record, "access_token");
    requireNonEmptyTokenString(record, "token_type");
    for (const field of ["refresh_token", "id_token", "scope"] as const) {
      const entry = record[field];
      if (entry !== undefined && typeof entry !== "string") {
        throw new Error(`${field} must be a string`);
      }
    }
    if (
      record.expires_in !== undefined &&
      (typeof record.expires_in !== "number" ||
        !Number.isFinite(record.expires_in) ||
        record.expires_in < 0)
    ) {
      throw new Error("expires_in must be a non-negative finite number");
    }
    return record as unknown as OidcTokenResponse;
  },
};

const verifierAlphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

export async function createPkcePair(
  cryptoSource: Crypto = globalThis.crypto,
): Promise<PkcePair> {
  const codeVerifier = createRandomVerifier(cryptoSource);
  const data = new TextEncoder().encode(codeVerifier);
  const digest = await cryptoSource.subtle.digest("SHA-256", data);
  return {
    codeVerifier,
    codeChallenge: base64UrlEncode(new Uint8Array(digest)),
    codeChallengeMethod: "S256",
  };
}

export function createRandomState(
  cryptoSource: Crypto = globalThis.crypto,
): string {
  return createRandomVerifier(cryptoSource, 32);
}

export async function fetchOidcMetadata(input: {
  readonly issuer: string;
  readonly fetch?: FetchLike;
}): Promise<OidcMetadata> {
  const fetcher = input.fetch ?? globalThis.fetch.bind(globalThis);
  const expectedIssuer = normalizeOidcIssuer(input.issuer, "OIDC issuer");
  const discoveryUrl = hostEndpoint(
    expectedIssuer,
    "/.well-known/openid-configuration",
  );
  const response = await fetcher(discoveryUrl, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`OIDC discovery failed: ${response.status}`);
  }
  const value = decodeWire(
    OIDC_DISCOVERY_DECODER,
    await response.json(),
    discoveryUrl,
  );
  const metadataIssuer = normalizeOidcIssuer(
    value.issuer,
    "OIDC metadata issuer",
  );
  if (metadataIssuer !== expectedIssuer) {
    throw new Error("OIDC metadata issuer does not match requested issuer.");
  }
  const authorizationEndpoint = normalizeOidcEndpoint(
    value.authorization_endpoint,
    "OIDC authorization endpoint",
  );
  const tokenEndpoint = normalizeOidcEndpoint(
    value.token_endpoint,
    "OIDC token endpoint",
  );
  // The issuer must serve its own authorize and token endpoints. Otherwise a
  // host that is its own issuer could send the browser to another issuer's
  // genuine consent and receive that issuer's code and PKCE verifier at its
  // own token endpoint (an authorization-server mix-up).
  for (const [label, endpoint] of [
    ["authorization", authorizationEndpoint],
    ["token", tokenEndpoint],
  ] as const) {
    if (new URL(endpoint).origin !== metadataIssuer) {
      throw new Error(`OIDC ${label} endpoint must be on the issuer's origin.`);
    }
  }
  return {
    ...value,
    issuer: metadataIssuer,
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: tokenEndpoint,
  } as OidcMetadata;
}

export function createOidcAuthorizationUrl(
  input: OidcAuthorizationUrlInput,
): string {
  const url = new URL(
    normalizeOidcEndpoint(
      input.metadata.authorization_endpoint,
      "OIDC authorization endpoint",
    ),
  );
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", input.scope ?? "openid profile offline_access");
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export function parseOidcCallback(
  callbackUrl: string,
  expectedState: string,
  expectedRedirectUri?: string,
  expectedIssuer?: string,
  requireIssuer = false,
): OidcCallbackResult {
  const url = new URL(callbackUrl);
  if (
    expectedRedirectUri &&
    callbackTarget(url) !== callbackTarget(new URL(expectedRedirectUri))
  ) {
    throw new Error(
      "OIDC callback URL does not match the registered redirect URI.",
    );
  }
  if (url.hash) {
    throw new Error("OIDC callback URL must not include a fragment.");
  }
  // RFC 9207: when the server names the issuer of the response, it must be
  // the issuer this sign-in started with.
  const responseIssuer = url.searchParams.get("iss");
  if (requireIssuer && responseIssuer === null) {
    throw new Error("OIDC callback does not name its issuer.");
  }
  if (responseIssuer !== null && expectedIssuer !== undefined) {
    let matches = false;
    try {
      matches = normalizeHostUrl(responseIssuer) === normalizeHostUrl(expectedIssuer);
    } catch {
      matches = false;
    }
    if (!matches) {
      throw new Error("OIDC callback issuer does not match this sign-in.");
    }
  }
  const error = url.searchParams.get("error");
  if (error) throw new Error(`OIDC callback failed: ${error}`);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code) throw new Error("OIDC callback is missing code.");
  if (!state) throw new Error("OIDC callback is missing state.");
  if (state !== expectedState) throw new Error("OIDC callback state mismatch.");
  return { code, state };
}

export async function exchangeOidcCode(
  input: OidcTokenExchangeInput,
): Promise<OidcTokenResponse> {
  if (!input.metadata.token_endpoint) {
    throw new Error("OIDC metadata is missing token endpoint.");
  }
  const tokenEndpoint = normalizeOidcEndpoint(
    input.metadata.token_endpoint,
    "OIDC token endpoint",
  );
  const fetcher = input.fetch ?? globalThis.fetch.bind(globalThis);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    code: input.code,
    code_verifier: input.codeVerifier,
  });
  const response = await fetcher(tokenEndpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!response.ok) {
    throw new Error(`OIDC token exchange failed: ${response.status}`);
  }
  return decodeOidcTokenResponse(await response.json(), tokenEndpoint);
}

export function decodeOidcTokenResponse(
  value: unknown,
  source: string,
): OidcTokenResponse {
  return decodeWire(OIDC_TOKEN_RESPONSE_DECODER, value, source);
}

function normalizeOidcIssuer(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is missing.`);
  }
  const url = requireSecureWebUrl(value.trim(), label);
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${label} must be a bare origin.`);
  }
  return normalizeHostUrl(url.toString());
}

function normalizeOidcEndpoint(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is missing.`);
  }
  const url = requireSecureWebUrl(value.trim(), label);
  if (url.hash) throw new Error(`${label} must not include a fragment.`);
  return url.toString();
}

function callbackTarget(url: URL): string {
  const target = new URL(url.toString());
  target.search = "";
  target.hash = "";
  return target.toString();
}

function requireNonEmptyTokenString(
  record: Record<string, unknown>,
  field: string,
): void {
  const value = record[field];
  if (typeof value !== "string" || !value) {
    throw new Error(`${field} must be a non-empty string`);
  }
}

function createRandomVerifier(cryptoSource: Crypto, length = 64): string {
  const bytes = new Uint8Array(length);
  cryptoSource.getRandomValues(bytes);
  let verifier = "";
  for (const byte of bytes) {
    verifier += verifierAlphabet[byte % verifierAlphabet.length];
  }
  return verifier;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
