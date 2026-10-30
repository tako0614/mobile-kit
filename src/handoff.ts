import type {
  MobileConnectPayload,
  MobileProductAdapter,
  MobileProductKind,
  MobileRoutePayload,
} from "./types.ts";
import { isMobileProductKind } from "./contract/mobile.ts";
import { requireMobileProductKey } from "./product-key.ts";
import { normalizeHostUrl } from "./url.ts";
import { assertSafeMobileRoutePath } from "./route-safety.ts";

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
  adapter: Pick<MobileProductAdapter, "mobileScheme" | "product"> &
    Partial<Pick<MobileProductAdapter, "allowRouteCodeParameter">>,
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
      allowCodeParameter: adapter.allowRouteCodeParameter,
    });
  }

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return undefined;
  const url = new URL(raw);
  if (url.protocol === "https:" || url.protocol === "http:") {
    return normalizeRoutePayload({
      routeValue: raw,
      expectedProduct,
      allowCodeParameter: adapter.allowRouteCodeParameter,
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
    allowCodeParameter: adapter.allowRouteCodeParameter,
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
  readonly allowCodeParameter?: boolean;
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
    // Only web URLs name a host route. Other schemes have an opaque origin
    // ("null"), which would otherwise be read as the host `https://null`.
    if (routeUrl.protocol !== "https:" && routeUrl.protocol !== "http:") {
      throw new Error("Mobile route URL must use http or https.");
    }
    const routeOrigin = normalizeHostUrl(routeUrl.origin);
    if (explicitHostUrl && routeOrigin !== explicitHostUrl) {
      throw new Error("Mobile route URL must stay on the route host.");
    }
    hostUrl = explicitHostUrl ?? routeOrigin;
    path = `${routeUrl.pathname}${routeUrl.search}${routeUrl.hash}`;
  }

  assertSafeMobileRoutePath(path, {
    allowCodeParameter: input.allowCodeParameter,
  });
  return {
    path,
    hostUrl,
    product: input.product,
  };
}

function isRouteLikeJson(value: Record<string, unknown>): boolean {
  const kind = firstString(value.kind, value.type, value.action);
  if (kind === "route" || kind === "open") return true;
  return Boolean(firstString(value.path, value.route, value.url, value.href));
}

function firstString(...values: readonly unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string");
}
