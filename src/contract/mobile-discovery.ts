// Mobile host discovery wire surface: types, decoders, requirements, fixtures.
//
// This is the vendored mirror of the discovery half of the mobile wire
// contract owned by `takosumi-contract`. mobile-kit ships as a standalone repo
// and cannot reach the owning module through a tsconfig path alias. The
// ecosystem root wire-contract gate therefore verifies that mirrored members
// only narrow the owning contract, exercises the shipped requirements and
// fixtures, and compares producer/consumer product tokens. Treat uncoordinated
// hand-edits here as drift: update the owning wire surface first, then this
// mirror and its conformance fixtures together.
//
// The point of keeping decoders, requirements and fixtures in ONE module is
// that a mobile shell cannot read a host document without also importing the
// rules that document must satisfy, and cannot write a test fixture that
// contradicts those rules. The two defects this surface exists to make loud:
//
//   1. a producer renames the product token it bakes into
//      `/.well-known/<product>` while the consuming shell still asks for the
//      old key (every connect fails, 100%);
//   2. a producer omits `oidcClientId` — or points `issuer` at itself while
//      declaring `identity.oidc_issuer: false` — so sign-in dies before the
//      first network call.
//
// Both are producer/consumer disagreements, so the rules are expressed as data
// (`MOBILE_SIGNIN_REQUIREMENTS`) that a producer-side gate can run over its own
// real output, not as `if` statements buried in the client.

import type {
  MobileProductKind,
  MobileProductWellKnown,
  MobileProductWellKnownEndpoints,
} from "./mobile.ts";
import { isMobileProductKind } from "./mobile.ts";

export type {
  MobileProductKind,
  MobileProductWellKnown,
  MobileProductWellKnownEndpoints,
};
export { isMobileProductKind };

/** Takosumi host descriptor served by every Takosumi-shaped host. */
export interface TakosumiWellKnownDocument {
  readonly api_versions?: readonly string[];
  readonly issuer?: string;
  readonly capabilitiesUrl?: string;
  readonly product?: string;
  readonly endpoints?: {
    readonly api?: string;
    readonly capabilities?: string;
    readonly oidc_issuer?: string;
  };
  readonly [key: string]: unknown;
}

/** Host capability descriptor served at `/v1/capabilities`. */
export interface HostCapabilitiesDocument {
  readonly product?: string | { readonly kind?: string };
  readonly identity?: {
    readonly oidc_issuer?: boolean;
    readonly issuer?: string;
  };
  readonly resources?: Record<string, unknown>;
  readonly extensions?: readonly string[];
  readonly [key: string]: unknown;
}

export const TAKOSUMI_WELL_KNOWN_PATH = "/.well-known/takosumi" as const;
export const HOST_CAPABILITIES_PATH = "/v1/capabilities" as const;

/**
 * The product document path is derived from the product key, so the key a
 * shell asks for and the key a host answers with are the same token by
 * construction. A host that answers this path with a different `product` is
 * the mismatch class, not a naming preference.
 */
export function mobileProductWellKnownPath(product: MobileProductKind): string {
  return `/.well-known/${product}`;
}

// --- decoders -------------------------------------------------------------

/**
 * A decoder is a value, not a type argument. Consumers cannot read a host
 * document without importing the decoder, which is what makes `as T` drift
 * between producer and consumer unrepresentable.
 */
export interface WireDecoder<T> {
  readonly document: string;
  readonly decode: (value: unknown) => T;
}

export const MOBILE_PRODUCT_WELL_KNOWN_DECODER: WireDecoder<MobileProductWellKnown> =
  {
    document: "mobile product well-known",
    decode(value) {
      const record = requireRecord(value);
      if (record.product !== undefined && !isMobileProductKind(record.product)) {
        throw new Error("product must be a product key");
      }
      requireOptionalString(record, "name");
      requireOptionalString(record, "issuer");
      requireOptionalString(record, "oidcClientId");
      requireOptionalString(record, "apiBaseUrl");
      if (record.auth !== undefined) {
        const auth = requireRecordAt(record.auth, "auth");
        requireOptionalBoolean(auth, "oidc", "auth.oidc");
        requireOptionalBoolean(auth, "password", "auth.password");
      }
      if (record.endpoints !== undefined) {
        const endpoints = requireRecordAt(record.endpoints, "endpoints");
        for (const [key, endpoint] of Object.entries(endpoints)) {
          if (endpoint !== undefined && typeof endpoint !== "string") {
            throw new Error(`endpoints.${key} must be a string`);
          }
        }
      }
      return record as MobileProductWellKnown;
    },
  };

export const TAKOSUMI_WELL_KNOWN_DECODER: WireDecoder<TakosumiWellKnownDocument> =
  {
    document: "takosumi well-known",
    decode(value) {
      const record = requireRecord(value);
      requireOptionalString(record, "issuer");
      requireOptionalString(record, "capabilitiesUrl");
      requireOptionalString(record, "product");
      if (record.api_versions !== undefined && !Array.isArray(record.api_versions)) {
        throw new Error("api_versions must be an array");
      }
      if (record.endpoints !== undefined) {
        const endpoints = requireRecordAt(record.endpoints, "endpoints");
        requireOptionalString(endpoints, "api", "endpoints.api");
        requireOptionalString(
          endpoints,
          "capabilities",
          "endpoints.capabilities",
        );
        requireOptionalString(
          endpoints,
          "oidc_issuer",
          "endpoints.oidc_issuer",
        );
      }
      return record as TakosumiWellKnownDocument;
    },
  };

export const HOST_CAPABILITIES_DECODER: WireDecoder<HostCapabilitiesDocument> = {
  document: "host capabilities",
  decode(value) {
    const record = requireRecord(value);
    if (record.product !== undefined) {
      if (typeof record.product !== "string") {
        const product = requireRecordAt(record.product, "product");
        requireOptionalString(product, "kind", "product.kind");
      }
    }
    if (record.identity !== undefined) {
      const identity = requireRecordAt(record.identity, "identity");
      requireOptionalBoolean(identity, "oidc_issuer", "identity.oidc_issuer");
      requireOptionalString(identity, "issuer", "identity.issuer");
    }
    return record as HostCapabilitiesDocument;
  },
};

// --- requirements ---------------------------------------------------------

/**
 * Everything a mobile shell reads from a host before it can connect and sign
 * in. Requirements are evaluated over the whole bundle because the known
 * defects are cross-document (product doc vs. the path it was served at,
 * product doc `issuer` vs. capabilities `identity.oidc_issuer`).
 */
export interface MobileHostWireBundle {
  readonly hostUrl: string;
  /** Product key the shell asked for, i.e. the path it fetched. */
  readonly expectedProduct?: MobileProductKind;
  readonly productWellKnown?: MobileProductWellKnown;
  readonly takosumiWellKnown?: TakosumiWellKnownDocument;
  readonly capabilities?: HostCapabilitiesDocument;
}

export type MobileWireRequirementId =
  | "product-key-matches-requested-product"
  | "product-document-declares-its-product"
  | "host-advertises-an-auth-method"
  | "oidc-host-advertises-a-mobile-client-id"
  | "oidc-issuer-is-actually-an-issuer";

/**
 * `connect` violations make the host unusable; `sign-in` violations let the
 * shell show the host but block the OIDC flow. Both are producer defects.
 */
export type MobileWireBlocks = "connect" | "sign-in";

export interface MobileWireRequirement {
  readonly id: MobileWireRequirementId;
  readonly blocks: MobileWireBlocks;
  /** Message used when the requirement is violated without a bundle at hand. */
  readonly summary: string;
  /** Returns the violation detail, or undefined when the bundle satisfies it. */
  readonly evaluate: (bundle: MobileHostWireBundle) => string | undefined;
}

export const MOBILE_SIGNIN_REQUIREMENTS: readonly MobileWireRequirement[] = [
  {
    id: "product-key-matches-requested-product",
    blocks: "connect",
    summary:
      "The product document must declare the product key it was served under.",
    evaluate(bundle) {
      const declared = detectBundleProduct(bundle);
      if (!bundle.expectedProduct || !declared) return undefined;
      if (declared === bundle.expectedProduct) return undefined;
      // Kept verbatim: shells surface this string to the operator, and the
      // producer-side gate reports the same sentence for the same defect.
      return `Host is ${declared}, not ${bundle.expectedProduct}.`;
    },
  },
  {
    id: "product-document-declares-its-product",
    blocks: "connect",
    summary: "The product document must carry a `product` key.",
    evaluate(bundle) {
      if (!bundle.productWellKnown || !bundle.expectedProduct) return undefined;
      if (isMobileProductKind(bundle.productWellKnown.product)) return undefined;
      // Without this, the mismatch check above is vacuous: a producer that
      // renames its token AND drops the field would connect silently.
      return `${mobileProductWellKnownPath(
        bundle.expectedProduct,
      )} does not declare a product key.`;
    },
  },
  {
    id: "host-advertises-an-auth-method",
    blocks: "connect",
    summary: "The host must advertise OIDC or native password sign-in.",
    evaluate(bundle) {
      const auth = resolveAuthMethods(bundle);
      if (auth.oidc || auth.password) return undefined;
      return "Host does not advertise an OIDC issuer.";
    },
  },
  {
    id: "oidc-host-advertises-a-mobile-client-id",
    blocks: "sign-in",
    summary:
      "An OIDC host must advertise the operator-registered public native client id.",
    evaluate(bundle) {
      if (!resolveAuthMethods(bundle).oidc) return undefined;
      if (readOidcClientId(bundle.productWellKnown)) return undefined;
      const path = bundle.expectedProduct
        ? mobileProductWellKnownPath(bundle.expectedProduct)
        : "the product well-known document";
      return `Host does not advertise a mobile OIDC client id. ${path} must carry oidcClientId (the public native client the host operator registered); a product-wide fallback id is not host registration authority.`;
    },
  },
  {
    id: "oidc-issuer-is-actually-an-issuer",
    blocks: "sign-in",
    summary:
      "A host that names itself as OIDC issuer must also serve OIDC discovery.",
    evaluate(bundle) {
      const issuer = resolveOidcIssuer(bundle);
      if (!issuer) return undefined;
      if (!sameOrigin(issuer, bundle.hostUrl)) return undefined;
      if (bundle.capabilities?.identity?.oidc_issuer !== false) return undefined;
      // A host that is an OIDC *client* must advertise the upstream issuer.
      // Naming itself sends the shell to a `/.well-known/openid-configuration`
      // that the host answers with 404.
      return `Host advertises itself (${issuer}) as its OIDC issuer while ${HOST_CAPABILITIES_PATH} declares identity.oidc_issuer=false; the upstream issuer must be advertised instead.`;
    },
  },
];

export function mobileWireRequirement(
  id: MobileWireRequirementId,
): MobileWireRequirement {
  const requirement = MOBILE_SIGNIN_REQUIREMENTS.find(
    (candidate) => candidate.id === id,
  );
  if (!requirement) throw new Error(`Unknown mobile wire requirement: ${id}`);
  return requirement;
}

// --- shared readers (used by requirements and by the discovery client) -----

export function detectBundleProduct(
  bundle: MobileHostWireBundle,
): MobileProductKind | undefined {
  const capabilityProduct =
    typeof bundle.capabilities?.product === "string"
      ? bundle.capabilities.product
      : bundle.capabilities?.product?.kind;
  return (
    asProductKind(bundle.productWellKnown?.product) ??
    asProductKind(bundle.takosumiWellKnown?.product) ??
    asProductKind(capabilityProduct)
  );
}

export function resolveOidcIssuer(
  bundle: MobileHostWireBundle,
): string | undefined {
  const takosumi = bundle.takosumiWellKnown;
  return (
    trimmed(bundle.productWellKnown?.issuer) ??
    trimmed(bundle.capabilities?.identity?.issuer) ??
    trimmed(takosumi?.issuer) ??
    trimmed(takosumi?.endpoints?.oidc_issuer)
  );
}

export function readOidcClientId(
  product: MobileProductWellKnown | undefined,
): string | undefined {
  return trimmed(product?.oidcClientId);
}

export function resolveAuthMethods(bundle: MobileHostWireBundle): {
  readonly oidc: boolean;
  readonly password: boolean;
} {
  const auth = bundle.productWellKnown?.auth;
  return {
    oidc: auth?.oidc ?? Boolean(resolveOidcIssuer(bundle)),
    password: auth?.password ?? false,
  };
}

// --- fixtures -------------------------------------------------------------

/**
 * Conformant host wire, one per host *shape* a mobile shell can meet. Product
 * keys here are opaque placeholders: this kit never knows product nouns, so a
 * fixture describes an identity topology (client of an external issuer, host
 * that is its own issuer, password-only host), not a named product.
 *
 * Consumer tests build host responses from these instead of hand-writing
 * literals, so a test cannot pin a shape the requirements reject. Producer
 * repos check their own real document with `assertMobileHostWire` instead.
 */
export interface MobileHostWireFixture {
  readonly id: string;
  /** Identity topology this fixture stands for. */
  readonly shape: string;
  readonly bundle: MobileHostWireBundle;
}

export const MOBILE_PRODUCT_WELL_KNOWN_FIXTURES: readonly MobileHostWireFixture[] =
  [
    {
      id: "external-issuer-oidc-host",
      shape:
        "host is an OIDC client of a separate accounts plane and serves no discovery document itself",
      bundle: {
        hostUrl: "https://app.example",
        expectedProduct: "example-app",
        productWellKnown: {
          product: "example-app",
          name: "Example App",
          issuer: "https://accounts.example",
          oidcClientId: "example-app-mobile",
          apiBaseUrl: "https://app.example",
          endpoints: {
            api: "https://app.example/api",
            currentUser: "https://app.example/api/auth/me",
            notificationPushers: "https://app.example/api/notifications/pushers",
          },
        },
        capabilities: {
          identity: { oidc_issuer: false },
        },
      },
    },
    {
      id: "self-issuer-oidc-host",
      shape: "host is its own OIDC issuer and serves discovery",
      bundle: {
        hostUrl: "https://control.example",
        expectedProduct: "example-control",
        productWellKnown: {
          product: "example-control",
          name: "Example Control",
          issuer: "https://control.example",
          oidcClientId: "example-control-mobile",
        },
        takosumiWellKnown: {
          api_versions: ["takosumi.dev/v1alpha1"],
          issuer: "https://control.example",
          endpoints: {
            api: "https://control.example/api",
            capabilities: "https://control.example/v1/capabilities",
            oidc_issuer: "https://control.example",
          },
        },
        capabilities: { identity: { oidc_issuer: true } },
      },
    },
    {
      id: "shared-engine-host",
      shape:
        "host is built from a shared engine, and the token it advertises is the key its shell asks for",
      bundle: {
        hostUrl: "https://social.example",
        expectedProduct: "example-social",
        productWellKnown: {
          product: "example-social",
          name: "Example Social",
          issuer: "https://accounts.example",
          oidcClientId: "example-social-mobile",
          apiBaseUrl: "https://social.example",
          endpoints: {
            currentUser: "https://social.example/api/auth/me",
            notificationPushers:
              "https://social.example/api/notifications/pushers",
          },
        },
      },
    },
    {
      id: "password-only-host",
      shape: "host offers native password sign-in and no OIDC",
      bundle: {
        hostUrl: "https://social.example",
        expectedProduct: "example-social",
        productWellKnown: {
          product: "example-social",
          auth: { oidc: false, password: true },
          endpoints: { mobilePasswordLogin: "/api/auth/mobile/login" },
        },
      },
    },
  ];

// --- local helpers --------------------------------------------------------

function asProductKind(value: unknown): MobileProductKind | undefined {
  return isMobileProductKind(value) ? value : undefined;
}

function trimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text || undefined;
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("document must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function requireRecordAt(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function requireOptionalString(
  record: Record<string, unknown>,
  key: string,
  label = key,
): void {
  const value = record[key];
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
}

function requireOptionalBoolean(
  record: Record<string, unknown>,
  key: string,
  label = key,
): void {
  const value = record[key];
  if (value !== undefined && typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
}
