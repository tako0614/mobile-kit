import { expect, test } from "bun:test";
import {
  discoverHost,
  mobileProductWellKnownPath,
  HOST_CAPABILITIES_PATH,
  MOBILE_PRODUCT_WELL_KNOWN_FIXTURES,
  TAKOSUMI_WELL_KNOWN_PATH,
  type FetchLike,
  type MobileHostWireBundle,
} from "../../src/index.ts";

// Host documents come from the shipped wire fixtures rather than from literals
// written here: a hand-written fixture is how this suite previously stayed
// green while pinning a document shape no producer emits.
function fixtureBundle(id: string): MobileHostWireBundle {
  const fixture = MOBILE_PRODUCT_WELL_KNOWN_FIXTURES.find(
    (candidate) => candidate.id === id,
  );
  if (!fixture) throw new Error(`Missing wire fixture: ${id}`);
  return fixture.bundle;
}

function bundleFetch(bundle: MobileHostWireBundle): FetchLike {
  return async (input) => {
    const url = String(input);
    if (
      bundle.expectedProduct &&
      bundle.productWellKnown &&
      url.endsWith(mobileProductWellKnownPath(bundle.expectedProduct))
    ) {
      return json(bundle.productWellKnown);
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

test("discoverHost reads product discovery and the upstream OIDC issuer", async () => {
  const bundle = fixtureBundle("external-issuer-oidc-host");

  const discovery = await discoverHost({
    hostUrl: "https://app.example/path",
    expectedProduct: "example-app",
    fetch: bundleFetch(bundle),
  });

  expect(discovery.hostUrl).toBe("https://app.example");
  expect(discovery.detectedProduct).toBe("example-app");
  // This host is an OIDC client: the issuer is the external accounts plane,
  // never the host origin itself.
  expect(discovery.oidcIssuer).toBe("https://accounts.example");
  expect(discovery.oidcClientId).toBe("example-app-mobile");
  expect(discovery.oidcDiscoveryUrl).toBe(
    "https://accounts.example/.well-known/openid-configuration",
  );
  expect(discovery.product?.endpoints?.notificationPushers).toBe(
    "https://app.example/api/notifications/pushers",
  );
  expect(discovery.wireViolations).toEqual([]);
});

test("discoverHost reads product discovery from a shared-engine host", async () => {
  const bundle = fixtureBundle("shared-engine-host");

  const discovery = await discoverHost({
    hostUrl: "https://social.example",
    expectedProduct: "example-social",
    fetch: bundleFetch(bundle),
  });

  expect(discovery.detectedProduct).toBe("example-social");
  expect(discovery.oidcIssuer).toBe("https://accounts.example");
  expect(discovery.product?.endpoints?.notificationPushers).toBe(
    "https://social.example/api/notifications/pushers",
  );
});

test("discoverHost preserves advertised product capability tokens", async () => {
  const fixture = fixtureBundle("shared-engine-host");
  const bundle: MobileHostWireBundle = {
    ...fixture,
    productWellKnown: {
      ...fixture.productWellKnown,
      capabilities: [
        "api.social.v1",
        "client.example-social.feed.v1",
      ],
    },
  };

  const discovery = await discoverHost({
    hostUrl: "https://social.example",
    expectedProduct: "example-social",
    fetch: bundleFetch(bundle),
  });

  expect(discovery.product?.capabilities).toEqual([
    "api.social.v1",
    "client.example-social.feed.v1",
  ]);
});

test("discoverHost accepts a password-only direct host without OIDC", async () => {
  const bundle = fixtureBundle("password-only-host");
  const discovery = await discoverHost({
    hostUrl: "https://social.example",
    expectedProduct: "example-social",
    fetch: bundleFetch(bundle),
  });
  expect(discovery.oidcIssuer).toBeUndefined();
  expect(discovery.authMethods).toEqual({ oidc: false, password: true });
});

test("discoverHost reads the current Takosumi well-known endpoints shape", async () => {
  const fetcher: FetchLike = async (input) => {
    const url = String(input);
    if (url.endsWith("/.well-known/takosumi")) {
      return json({
        api_versions: ["takosumi.dev/v1alpha1"],
        endpoints: {
          api: "https://host.example/api",
          capabilities: "https://host.example/v1/capabilities",
          oidc_issuer: "https://host.example",
        },
      });
    }
    if (url.endsWith("/v1/capabilities")) return json({});
    return new Response("", { status: 404 });
  };

  const discovery = await discoverHost({
    hostUrl: "https://host.example",
    expectedProduct: "takos",
    fetch: fetcher,
  });

  expect(discovery.detectedProduct).toBeUndefined();
  expect(discovery.oidcIssuer).toBe("https://host.example");
  expect(discovery.oidcDiscoveryUrl).toBe(
    "https://host.example/.well-known/openid-configuration",
  );
});

test("discoverHost accepts product discovery from the Takosumi well-known document", async () => {
  const fetcher: FetchLike = async (input) => {
    const url = String(input);
    if (url.endsWith("/.well-known/takosumi")) {
      return json({
        product: "notes-app",
        issuer: "https://notes.example",
        endpoints: {
          api: "https://notes.example/api",
          oidc_issuer: "https://notes.example",
        },
      });
    }
    if (url.endsWith("/v1/capabilities")) return json({});
    return new Response("", { status: 404 });
  };

  const discovery = await discoverHost({
    hostUrl: "https://notes.example",
    expectedProduct: "notes-app",
    fetch: fetcher,
  });

  expect(discovery.detectedProduct).toBe("notes-app");
  expect(discovery.oidcIssuer).toBe("https://notes.example");
});

test("discoverHost rejects mismatched products", async () => {
  const fetcher: FetchLike = async (input) => {
    const url = String(input);
    if (url.endsWith("/.well-known/takosumi"))
      return json({ product: "takos" });
    if (url.endsWith("/v1/capabilities")) return json({});
    if (url.endsWith("/.well-known/yurucommu"))
      return json({ product: "takos" });
    return new Response("", { status: 404 });
  };

  await expect(
    discoverHost({
      hostUrl: "https://host.example",
      expectedProduct: "yurucommu",
      fetch: fetcher,
    }),
  ).rejects.toThrow("Host is takos, not yurucommu.");
});

test("discoverHost requires an explicitly advertised OIDC issuer", async () => {
  const fetcher: FetchLike = async (input) => {
    const url = String(input);
    if (url.endsWith("/.well-known/takos")) {
      return json({
        product: "takos",
        oidcClientId: "takos-mobile-host-example",
      });
    }
    if (url.endsWith("/v1/capabilities")) return json({});
    return new Response("", { status: 404 });
  };

  await expect(
    discoverHost({
      hostUrl: "https://host.example",
      expectedProduct: "takos",
      fetch: fetcher,
    }),
  ).rejects.toThrow("Host does not advertise an OIDC issuer.");
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

test("discoverHost reads a Takosumi instance from one well-known document", async () => {
  const requested: string[] = [];
  const fetcher: FetchLike = async (input) => {
    const url = String(input);
    requested.push(url);
    if (url === "https://app.takosumi.example/.well-known/takosumi") {
      // Shape served by Takosumi today, including extension endpoints.
      return json({
        product: "takosumi",
        name: "Takosumi",
        oidcClientId: "takosumi-mobile",
        auth: { oidc: true, password: false },
        apiBaseUrl: "https://app.takosumi.example/api/v1",
        api_versions: ["takosumi.dev/v1alpha1"],
        endpoints: {
          api: "https://app.takosumi.example/api/v1",
          capabilities: "https://app.takosumi.example/api/v1/capabilities",
          openapi: "https://app.takosumi.example/openapi.json",
          oidc_issuer: "https://accounts.takosumi.example",
          extensions: {
            "openai.models.v1": "https://app.takosumi.example/api/v1/ai",
          },
        },
      });
    }
    return new Response("", { status: 404 });
  };

  const discovery = await discoverHost({
    hostUrl: "app.takosumi.example",
    expectedProduct: "takosumi",
    fetch: fetcher,
  });

  expect(requested).toEqual(["https://app.takosumi.example/.well-known/takosumi"]);
  expect(discovery.detectedProduct).toBe("takosumi");
  expect(discovery.oidcClientId).toBe("takosumi-mobile");
  expect(discovery.oidcIssuer).toBe("https://accounts.takosumi.example");
  expect(discovery.apiBaseUrl).toBe("https://app.takosumi.example/api/v1");
  expect(discovery.product?.endpoints?.api).toBe("https://app.takosumi.example/api/v1");
  expect("extensions" in (discovery.product?.endpoints ?? {})).toBe(false);
  expect(discovery.wireViolations).toEqual([]);
});

test("discoverHost drops an API base URL on another origin and rejects malformed extensions", async () => {
  const discovery = await discoverHost({
    hostUrl: "https://app.takosumi.example",
    expectedProduct: "takosumi",
    fetch: async () =>
      json({
        product: "takosumi",
        oidcClientId: "takosumi-mobile",
        apiBaseUrl: "https://collector.example/api/v1",
        endpoints: { oidc_issuer: "https://app.takosumi.example" },
      }),
  });
  expect(discovery.apiBaseUrl).toBeUndefined();

  await expect(
    discoverHost({
      hostUrl: "https://app.takosumi.example",
      expectedProduct: "takosumi",
      fetch: async () =>
        json({
          product: "takosumi",
          endpoints: {
            oidc_issuer: "https://app.takosumi.example",
            extensions: { "a.v1": 42 },
          },
        }),
    }),
  ).rejects.toThrow("endpoints.extensions.a.v1 must be a string");
});

test("discoverHost no longer requests the retired capabilities document", async () => {
  const requested: string[] = [];
  await discoverHost({
    hostUrl: "https://app.example",
    expectedProduct: "example-app",
    fetch: async (input) => {
      requested.push(String(input));
      return bundleFetch(fixtureBundle("external-issuer-oidc-host"))(input);
    },
  });
  expect(requested.some((url) => url.endsWith(HOST_CAPABILITIES_PATH))).toBe(false);
});
