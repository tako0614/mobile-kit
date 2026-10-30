import type { FetchLike, HostDiscovery, MobileProductKind } from "./types.ts";
import {
  MOBILE_PRODUCT_WELL_KNOWN_DECODER,
  TAKOSUMI_WELL_KNOWN_DECODER,
  TAKOSUMI_WELL_KNOWN_PATH,
  detectBundleProduct,
  mobileProductWellKnownPath,
  readOidcClientId,
  resolveAuthMethods,
  resolveOidcIssuer,
  type MobileHostWireBundle,
} from "./contract/mobile-discovery.ts";
import { checkMobileHostWire } from "./conformance.ts";
import { decodeWire } from "./wire.ts";
import { hostEndpoint, normalizeHostUrl } from "./url.ts";
import { requireMobileProductKey } from "./product-key.ts";
import { sameOriginApiBaseUrl } from "./accounts.ts";

/**
 * Reads a host's discovery documents. The retired `/v1/capabilities` document
 * is no longer requested; hosts publish everything a shell needs in
 * `/.well-known/<product>` (and Takosumi hosts in `/.well-known/takosumi`).
 */
export async function discoverHost(input: {
  readonly hostUrl: string;
  readonly expectedProduct?: MobileProductKind;
  readonly fetch?: FetchLike;
  readonly signal?: AbortSignal;
}): Promise<HostDiscovery> {
  const fetcher = input.fetch ?? globalThis.fetch.bind(globalThis);
  const hostUrl = normalizeHostUrl(input.hostUrl);
  const expectedProduct = input.expectedProduct
    ? requireMobileProductKey(input.expectedProduct, "Expected product")
    : undefined;
  const productPath = expectedProduct
    ? mobileProductWellKnownPath(expectedProduct)
    : undefined;

  // A Takosumi shell's product document is the Takosumi document itself, so it
  // is fetched once and decoded through both contracts.
  const takosumiUrl = hostEndpoint(hostUrl, TAKOSUMI_WELL_KNOWN_PATH);
  const productUrl = productPath ? hostEndpoint(hostUrl, productPath) : undefined;
  const [takosumiRaw, productRaw] = await Promise.all([
    fetchOptionalJson(fetcher, takosumiUrl, input.signal),
    productUrl && productUrl !== takosumiUrl
      ? fetchOptionalJson(fetcher, productUrl, input.signal)
      : undefined,
  ]);
  const takosumi =
    takosumiRaw === undefined
      ? undefined
      : decodeWire(TAKOSUMI_WELL_KNOWN_DECODER, takosumiRaw, takosumiUrl);
  const productSource = productUrl === takosumiUrl ? takosumiRaw : productRaw;
  const product =
    productUrl === undefined || productSource === undefined
      ? undefined
      : decodeWire(MOBILE_PRODUCT_WELL_KNOWN_DECODER, productSource, productUrl);

  const bundle: MobileHostWireBundle = {
    hostUrl,
    expectedProduct,
    productWellKnown: product,
    takosumiWellKnown: takosumi,
  };

  // The wire requirements are the contract, not a client-side opinion: a
  // producer-side gate runs the same list over the same bundle shape. Connect
  // blockers throw here; sign-in blockers travel on the discovery so the shell
  // can show the host and report exactly which document is wrong.
  const wireViolations = checkMobileHostWire(bundle);
  const connectBlocker = wireViolations.find(
    (violation) => violation.blocks === "connect",
  );
  if (connectBlocker) throw new Error(connectBlocker.detail);

  const oidcIssuer = resolveOidcIssuer(bundle);
  const normalizedOidcIssuer = oidcIssuer
    ? normalizeHostUrl(oidcIssuer)
    : undefined;
  const apiBaseUrl =
    sameOriginApiBaseUrl(product?.apiBaseUrl, hostUrl) ??
    sameOriginApiBaseUrl(takosumi?.apiBaseUrl, hostUrl);

  return {
    hostUrl,
    expectedProduct,
    detectedProduct: detectBundleProduct(bundle),
    takosumi,
    product,
    oidcIssuer: normalizedOidcIssuer,
    oidcClientId: readOidcClientId(product),
    oidcDiscoveryUrl: normalizedOidcIssuer
      ? hostEndpoint(normalizedOidcIssuer, "/.well-known/openid-configuration")
      : undefined,
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
    authMethods: resolveAuthMethods(bundle),
    wireViolations,
  };
}

async function fetchOptionalJson(
  fetcher: FetchLike,
  url: string,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const response = await fetcher(url, {
    headers: { accept: "application/json" },
    signal,
  });
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(`Discovery request failed: ${response.status} ${url}`);
  }
  return await response.json();
}
