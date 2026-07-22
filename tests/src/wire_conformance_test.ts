import { expect, test } from "bun:test";
import {
  assertMobileHostWire,
  checkMobileHostWire,
  checkMobileWireDefectCorpus,
  discoverHost,
  fetchHostNotificationPusherConfig,
  fetchOidcMetadata,
  mobileProductWellKnownPath,
  HOST_CAPABILITIES_PATH,
  MOBILE_PRODUCT_WELL_KNOWN_DECODER,
  MOBILE_PRODUCT_WELL_KNOWN_FIXTURES,
  MOBILE_SIGNIN_REQUIREMENTS,
  TAKOSUMI_WELL_KNOWN_PATH,
  WireDecodeError,
  type FetchLike,
  type MobileHostWireBundle,
  type MobileWireDefectCase,
} from "../../src/index.ts";

// Producer/consumer conformance. These tests exist because both known wire
// defects were invisible to every producer-side and consumer-side suite: the
// producer tested what it emitted, the consumer tested a fixture it wrote
// itself, and nothing compared the two. The comparison is the requirement
// list, so the tests below run it over recorded producer output.
//
// The recorded documents name real products, which shipped kit source may not,
// so the corpus lives here rather than in src/.

const DEFECT_CORPUS: readonly MobileWireDefectCase[] = [
  {
    id: "product-token-renamed-under-the-shell",
    producer: 'yurumeet worker build (`product: "yurumeet"`)',
    why:
      "The yurumeet shell asks for /.well-known/yurucommu because it embeds " +
      "the yurucommu engine, while the worker build bakes in the token " +
      "`yurumeet`. Connect fails 100% against the real worker; the dev mock " +
      "server answered `yurucommu`, so only the mock agreed with the shell.",
    bundle: {
      hostUrl: "https://talk.example",
      expectedProduct: "yurucommu",
      productWellKnown: {
        product: "yurumeet",
        name: "Yurumeet",
        issuer: "https://accounts.example",
        oidcClientId: "yurume-mobile",
      },
    },
    expected: ["product-key-matches-requested-product"],
  },
  {
    id: "product-document-without-a-product-key",
    producer: "any host serving /.well-known/<product> without `product`",
    why:
      "A producer that renames its token and drops the field would otherwise " +
      "pass the mismatch check vacuously — the same defect with the evidence " +
      "removed.",
    bundle: {
      hostUrl: "https://talk.example",
      expectedProduct: "yurucommu",
      productWellKnown: {
        name: "Yurumeet",
        issuer: "https://accounts.example",
        oidcClientId: "yurume-mobile",
      },
    },
    expected: ["product-document-declares-its-product"],
  },
  {
    id: "well-known-without-oidc-client-id",
    producer: "takos worker /.well-known/takos",
    why:
      "The document carries no `oidcClientId`, so the shell throws before the " +
      "first network call, and it names the takos origin as `issuer` while " +
      "/v1/capabilities declares identity.oidc_issuer=false — takos is an " +
      "OIDC client of an external accounts plane and serves no discovery " +
      "document, so both halves must be fixed together.",
    bundle: {
      hostUrl: "https://takos.example",
      expectedProduct: "takos",
      productWellKnown: {
        product: "takos",
        name: "Takos",
        issuer: "https://takos.example",
        apiBaseUrl: "https://takos.example",
        endpoints: {
          api: "https://takos.example/api",
          currentUser: "https://takos.example/api/auth/me",
        },
      },
      capabilities: { identity: { oidc_issuer: false } },
    },
    expected: [
      "oidc-host-advertises-a-mobile-client-id",
      "oidc-issuer-is-actually-an-issuer",
    ],
  },
  {
    id: "host-without-any-auth-method",
    producer: "any host that advertises neither OIDC nor password sign-in",
    why: "The shell has nothing to sign in with, so connect must fail loudly.",
    bundle: {
      hostUrl: "https://takos.example",
      expectedProduct: "takos",
      productWellKnown: { product: "takos", name: "Takos" },
      capabilities: {},
    },
    expected: ["host-advertises-an-auth-method"],
  },
];

test("every shipped fixture satisfies every mobile sign-in requirement", () => {
  for (const fixture of MOBILE_PRODUCT_WELL_KNOWN_FIXTURES) {
    expect([fixture.id, checkMobileHostWire(fixture.bundle)]).toEqual([
      fixture.id,
      [],
    ]);
  }
});

test("shipped fixtures decode through the contract decoder", () => {
  for (const fixture of MOBILE_PRODUCT_WELL_KNOWN_FIXTURES) {
    if (!fixture.bundle.productWellKnown) continue;
    const decoded = MOBILE_PRODUCT_WELL_KNOWN_DECODER.decode(
      JSON.parse(JSON.stringify(fixture.bundle.productWellKnown)),
    );
    expect(decoded).toEqual(fixture.bundle.productWellKnown);
  }
});

test("every recorded producer defect still reports its exact requirement set", () => {
  expect(checkMobileWireDefectCorpus(DEFECT_CORPUS)).toEqual([]);
});

test("the product-token mismatch is a connect blocker", async () => {
  // Real shape: the yurumeet worker bakes in `yurumeet` while the shell asks
  // for `/.well-known/yurucommu`, because it embeds the yurucommu engine.
  const defect = requireDefect("product-token-renamed-under-the-shell");
  const violations = checkMobileHostWire(defect.bundle);
  expect(violations).toHaveLength(1);
  expect(violations[0]?.blocks).toBe("connect");
  expect(violations[0]?.detail).toBe("Host is yurumeet, not yurucommu.");

  await expect(
    discoverHost({
      hostUrl: defect.bundle.hostUrl,
      expectedProduct: "yurucommu",
      fetch: hostServing(defect.bundle),
    }),
  ).rejects.toThrow("Host is yurumeet, not yurucommu.");
});

test("a product document that names no product is a connect blocker too", async () => {
  // Otherwise the mismatch check is vacuous: rename the token, drop the field,
  // and the shell connects to the wrong product in silence.
  const defect = requireDefect("product-document-without-a-product-key");
  await expect(
    discoverHost({
      hostUrl: defect.bundle.hostUrl,
      expectedProduct: "yurucommu",
      fetch: hostServing(defect.bundle),
    }),
  ).rejects.toThrow(
    `${mobileProductWellKnownPath("yurucommu")} does not declare a product key.`,
  );
});

test("the missing oidcClientId is reported at discovery, not at the OIDC call", async () => {
  const defect = requireDefect("well-known-without-oidc-client-id");
  const discovery = await discoverHost({
    hostUrl: defect.bundle.hostUrl,
    expectedProduct: "takos",
    fetch: hostServing(defect.bundle),
  });

  // Connect still works — the host exists — but the shell now carries the
  // reason sign-in cannot start, pointing at the producing document.
  expect(discovery.oidcClientId).toBeUndefined();
  const reported = (discovery.wireViolations ?? []).map(
    (violation) => violation.requirement,
  );
  expect(reported.sort()).toEqual([
    "oidc-host-advertises-a-mobile-client-id",
    "oidc-issuer-is-actually-an-issuer",
  ]);
  expect(
    (discovery.wireViolations ?? []).every(
      (violation) => violation.blocks === "sign-in",
    ),
  ).toBe(true);
  expect(
    discovery.wireViolations?.[0]?.detail.includes(
      mobileProductWellKnownPath("takos"),
    ),
  ).toBe(true);
});

test("a host naming itself as issuer while serving no OIDC discovery is a defect", () => {
  const bundle: MobileHostWireBundle = {
    hostUrl: "https://takos.example",
    expectedProduct: "takos",
    productWellKnown: {
      product: "takos",
      issuer: "https://takos.example",
      oidcClientId: "takos-mobile",
    },
    capabilities: { identity: { oidc_issuer: false } },
  };
  expect(checkMobileHostWire(bundle).map((v) => v.requirement)).toEqual([
    "oidc-issuer-is-actually-an-issuer",
  ]);

  // The same host is conformant once it advertises the upstream issuer.
  expect(
    checkMobileHostWire({
      ...bundle,
      productWellKnown: {
        ...bundle.productWellKnown,
        issuer: "https://accounts.example",
      },
    }),
  ).toEqual([]);
});

test("assertMobileHostWire raises the connect blocker before sign-in blockers", () => {
  expect(() =>
    assertMobileHostWire({
      hostUrl: "https://talk.example",
      expectedProduct: "yurucommu",
      productWellKnown: { product: "yurumeet", issuer: "https://a.example" },
    }),
  ).toThrow("Host is yurumeet, not yurucommu.");
});

test("every requirement is exercised by the defect corpus", () => {
  // A requirement nobody can violate in the corpus is a requirement whose
  // evaluation is never proven, which is how a dead check hides a live defect.
  const covered = new Set(DEFECT_CORPUS.flatMap((defect) => defect.expected));
  expect(
    MOBILE_SIGNIN_REQUIREMENTS.map((requirement) => requirement.id)
      .filter((id) => !covered.has(id))
      .sort(),
  ).toEqual([]);
});

test("a host document with the wrong field types fails loudly at the seam", async () => {
  const fetcher: FetchLike = async (input) =>
    String(input).endsWith("/.well-known/takos")
      ? json({ product: "takos", oidcClientId: 42 })
      : new Response("", { status: 404 });

  await expect(
    discoverHost({
      hostUrl: "https://takos.example",
      expectedProduct: "takos",
      fetch: fetcher,
    }),
  ).rejects.toThrow(WireDecodeError);
});

test("a host pusher config with the wrong field types fails loudly", async () => {
  // Previously a retyped field degraded to `null`, which the caller reads as
  // "host has no gateway" and silently falls back to the build-time URL.
  const session = {
    hostUrl: "https://host.example",
    product: "takos",
    accessToken: "token",
    tokenType: "Bearer",
    createdAt: "2026-07-20T00:00:00.000Z",
  } as const;

  await expect(
    fetchHostNotificationPusherConfig({
      session,
      fetch: async () => json({ gateway_url: { url: "https://gw.example" } }),
    }),
  ).rejects.toThrow(WireDecodeError);

  // An absent endpoint stays a fallback, not an error.
  expect(
    await fetchHostNotificationPusherConfig({
      session,
      fetch: async () => new Response("", { status: 404 }),
    }),
  ).toBeNull();
});

test("an OIDC discovery document with the wrong field types fails loudly", async () => {
  await expect(
    fetchOidcMetadata({
      issuer: "https://accounts.example",
      fetch: async () =>
        json({
          issuer: "https://accounts.example",
          authorization_endpoint: ["https://accounts.example/oauth/authorize"],
        }),
    }),
  ).rejects.toThrow(WireDecodeError);
});

function requireDefect(id: string): MobileWireDefectCase {
  const defect = DEFECT_CORPUS.find((entry) => entry.id === id);
  if (!defect) throw new Error(`Missing defect corpus entry: ${id}`);
  return defect;
}

/** Serves a recorded bundle as the host that produced it. */
function hostServing(bundle: MobileHostWireBundle): FetchLike {
  return async (input) => {
    const url = String(input);
    if (bundle.productWellKnown && bundle.expectedProduct) {
      if (url.endsWith(mobileProductWellKnownPath(bundle.expectedProduct))) {
        return json(bundle.productWellKnown);
      }
    }
    if (bundle.takosumiWellKnown && url.endsWith(TAKOSUMI_WELL_KNOWN_PATH)) {
      return json(bundle.takosumiWellKnown);
    }
    if (bundle.capabilities && url.endsWith(HOST_CAPABILITIES_PATH)) {
      return json(bundle.capabilities);
    }
    return new Response("", { status: 404 });
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}
