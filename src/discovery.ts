import type { FetchLike, HostDiscovery, MobileProductKind } from "./types.ts";
import {
  HOST_CAPABILITIES_DECODER,
  HOST_CAPABILITIES_PATH,
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
import { fetchOptionalWire } from "./wire.ts";
import { hostEndpoint, normalizeHostUrl } from "./url.ts";
import { requireMobileProductKey } from "./product-key.ts";

export async function discoverHost(input: {
  readonly hostUrl: string;
  readonly expectedProduct?: MobileProductKind;
  readonly fetch?: FetchLike;
}): Promise<HostDiscovery> {
  const fetcher = input.fetch ?? globalThis.fetch.bind(globalThis);
  const hostUrl = normalizeHostUrl(input.hostUrl);
  const expectedProduct = input.expectedProduct
    ? requireMobileProductKey(input.expectedProduct, "Expected product")
    : undefined;
  const productPath = expectedProduct
    ? mobileProductWellKnownPath(expectedProduct)
    : undefined;

  const [takosumi, capabilities, product] = await Promise.all([
    fetchOptionalWire(
      fetcher,
      hostEndpoint(hostUrl, TAKOSUMI_WELL_KNOWN_PATH),
      TAKOSUMI_WELL_KNOWN_DECODER,
    ),
    fetchOptionalWire(
      fetcher,
      hostEndpoint(hostUrl, HOST_CAPABILITIES_PATH),
      HOST_CAPABILITIES_DECODER,
    ),
    productPath
      ? fetchOptionalWire(
          fetcher,
          hostEndpoint(hostUrl, productPath),
          MOBILE_PRODUCT_WELL_KNOWN_DECODER,
        )
      : undefined,
  ]);

  const bundle: MobileHostWireBundle = {
    hostUrl,
    expectedProduct,
    productWellKnown: product,
    takosumiWellKnown: takosumi,
    capabilities,
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

  return {
    hostUrl,
    expectedProduct,
    detectedProduct: detectBundleProduct(bundle),
    takosumi,
    capabilities,
    product,
    oidcIssuer: normalizedOidcIssuer,
    oidcClientId: readOidcClientId(product),
    oidcDiscoveryUrl: normalizedOidcIssuer
      ? hostEndpoint(normalizedOidcIssuer, "/.well-known/openid-configuration")
      : undefined,
    authMethods: resolveAuthMethods(bundle),
    wireViolations,
  };
}
