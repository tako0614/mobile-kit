import type {
  MobileConnectPayload,
  MobileProductAdapter,
  MobileProductKind,
  MobileRoutePayload,
} from "./types.ts";
import { isMobileProductKind } from "./contract/mobile.ts";
import { requireMobileProductKey } from "./product-key.ts";
import { normalizeHostUrl } from "./url.ts";

export function parseMobileProductKind(
  value: unknown,
): MobileProductKind | undefined {
  return isMobileProductKind(value) ? value : undefined;
}

export function parseMobileConnectInput(input: string): MobileConnectPayload {
  const raw = input.trim();
  if (!raw) throw new Error("Connect payload is required.");

  if (raw.startsWith("{")) {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return normalizePayload({
      hostUrl: String(parsed.host_url ?? parsed.hostUrl ?? ""),
      product: parseMobileProductKind(parsed.product),
      setupTicket:
        typeof parsed.setup_ticket === "string"
          ? parsed.setup_ticket
          : typeof parsed.setupTicket === "string"
            ? parsed.setupTicket
            : undefined,
    });
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    ? raw
    : `https://${raw}`;
  const url = new URL(withScheme);
  const hostUrlParam =
    url.searchParams.get("host_url") ?? url.searchParams.get("hostUrl");

  if (hostUrlParam) {
    return normalizePayload({
      hostUrl: hostUrlParam,
      product: parseMobileProductKind(url.searchParams.get("product")),
      setupTicket:
        url.searchParams.get("setup_ticket") ??
        url.searchParams.get("setupTicket") ??
        undefined,
    });
  }

  return normalizePayload({ hostUrl: raw });
}

export function parseMobileRouteInput(
  input: string,
  adapter: Pick<MobileProductAdapter, "mobileScheme" | "product">,
): MobileRoutePayload | undefined {
  const expectedProduct = requireMobileProductKey(
    adapter.product,
    "Expected product",
  );
  const raw = input.trim();
  if (!raw) return undefined;

  if (raw.startsWith("{")) {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!isRouteLikeJson(parsed)) return undefined;
    return normalizeRoutePayload({
      routeValue: firstString(
        parsed.path,
        parsed.route,
        parsed.url,
        parsed.href,
      ),
      hostUrl: firstString(parsed.host_url, parsed.hostUrl),
      product: parseMobileProductKind(parsed.product),
      expectedProduct,
    });
  }

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return undefined;
  const url = new URL(raw);
  if (url.protocol === "https:" || url.protocol === "http:") {
    return normalizeRoutePayload({
      routeValue: raw,
      expectedProduct,
    });
  }
  if (url.protocol !== `${adapter.mobileScheme}:`) return undefined;
  if (url.hostname !== "open" && url.hostname !== "route") {
    return undefined;
  }

  return normalizeRoutePayload({
    routeValue:
      url.searchParams.get("path") ??
      url.searchParams.get("route") ??
      url.searchParams.get("url") ??
      url.searchParams.get("href") ??
      (url.pathname ? `${url.pathname}${url.search}${url.hash}` : undefined),
    hostUrl:
      url.searchParams.get("host_url") ??
      url.searchParams.get("hostUrl") ??
      undefined,
    product: parseMobileProductKind(url.searchParams.get("product")),
    expectedProduct,
  });
}

function normalizePayload(payload: {
  readonly hostUrl: string;
  readonly product?: MobileProductKind;
  readonly setupTicket?: string;
}): MobileConnectPayload {
  return {
    hostUrl: normalizeHostUrl(payload.hostUrl),
    product: payload.product,
    setupTicket: payload.setupTicket,
  };
}

function normalizeRoutePayload(input: {
  readonly routeValue: string | undefined;
  readonly hostUrl?: string;
  readonly product?: MobileProductKind;
  readonly expectedProduct: MobileProductKind;
}): MobileRoutePayload {
  if (input.product && input.product !== input.expectedProduct) {
    throw new Error("Mobile route payload product mismatch.");
  }
  const explicitHostUrl = input.hostUrl
    ? normalizeHostUrl(input.hostUrl)
    : undefined;
  if (!input.routeValue) throw new Error("Mobile route path is required.");

  const routeValue = input.routeValue.trim();
  let hostUrl = explicitHostUrl;
  let path: string;
  if (routeValue.startsWith("/") && !routeValue.startsWith("//")) {
    path = routeValue;
  } else {
    let routeUrl: URL;
    try {
      routeUrl = new URL(routeValue);
    } catch {
      throw new Error("Mobile route path must be an absolute same-origin path.");
    }
    const routeOrigin = normalizeHostUrl(routeUrl.origin);
    if (explicitHostUrl && routeOrigin !== explicitHostUrl) {
      throw new Error("Mobile route URL must stay on the route host.");
    }
    hostUrl = explicitHostUrl ?? routeOrigin;
    path = `${routeUrl.pathname}${routeUrl.search}${routeUrl.hash}`;
  }

  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error("Mobile route path must be an absolute same-origin path.");
  }
  requireSafeRoutePath(path);
  return {
    path,
    hostUrl,
    product: input.product,
  };
}

const MAX_ROUTE_PATH_LENGTH = 2048;

/**
 * Query and fragment names that carry a credential. A route link comes from
 * outside the app, so one that tries to hand a host route a token, session or
 * OAuth code (login CSRF, session fixation) is refused before it is opened.
 * Names are compared lowercased with non-alphanumerics removed.
 */
const CREDENTIAL_ROUTE_PARAMETER_NAMES = new Set([
  "accesskey",
  "accesstoken",
  "apikey",
  "auth",
  "authorization",
  "bearertoken",
  "clientsecret",
  "code",
  "cookie",
  "credential",
  "credentials",
  "idtoken",
  "jwt",
  "passwd",
  "password",
  "privatekey",
  "refreshtoken",
  "secret",
  "session",
  "sessionid",
  "sessiontoken",
  "sig",
  "signature",
  "token",
]);

function requireSafeRoutePath(path: string): void {
  if (path.length > MAX_ROUTE_PATH_LENGTH) {
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
  const fragment = resolved.hash.startsWith("#") ? resolved.hash.slice(1) : "";
  if (
    hasCredentialParameter(resolved.searchParams) ||
    hasCredentialParameter(new URLSearchParams(fragment))
  ) {
    throw new Error("Mobile route links must not carry credentials.");
  }
}

function hasCredentialParameter(parameters: URLSearchParams): boolean {
  for (const name of parameters.keys()) {
    const normalized = name.toLowerCase().replace(/[^a-z0-9]/gu, "");
    if (CREDENTIAL_ROUTE_PARAMETER_NAMES.has(normalized)) return true;
  }
  return false;
}

function isRouteLikeJson(value: Record<string, unknown>): boolean {
  const kind = firstString(value.kind, value.type, value.action);
  if (kind === "route" || kind === "open") return true;
  return Boolean(firstString(value.path, value.route, value.url, value.href));
}

function firstString(...values: readonly unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string");
}
