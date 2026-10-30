import { expect, test } from "bun:test";
import {
  createMobileClientController,
  isFirstTimeMobileHost,
  mobileSessionStorageKey,
  type FetchLike,
  type MobileProductAdapter,
  type MobileSession,
  type NativeBridge,
} from "../../src/index.ts";

const adapter: MobileProductAdapter = {
  product: "takosumi",
  discoveryProduct: "takosumi",
  strictDiscoveryProduct: true,
  appName: "Takosumi",
  hostNoun: "Takosumi",
  urlPlaceholder: "https://app.example",
  primaryActionLabel: "Connect",
  accentColor: "#f5483d",
  mobileScheme: "takosumi",
  oidcScopes: ["openid", "profile", "offline_access", "capsules:read", "capsules:write"],
  requireHostIssuer: true,
};

interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly authorization?: string;
  readonly body?: string;
}

function encode(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** Two independent Takosumi instances; each mints tokens that name it. */
function instances(): { fetch: FetchLike; requests: Recorded[] } {
  const requests: Recorded[] = [];
  let counter = 0;
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const origin = url.origin;
    const host = url.hostname.split(".")[0];
    const headers = new Headers(init?.headers);
    requests.push({
      url: url.toString(),
      method: init?.method ?? "GET",
      authorization: headers.get("authorization") ?? undefined,
      body: init?.body ? String(init.body) : undefined,
    });
    if (url.pathname === "/.well-known/takosumi") {
      return Response.json({
        product: "takosumi",
        name: "Takosumi",
        oidcClientId: "takosumi-mobile",
        auth: { oidc: true, password: false },
        apiBaseUrl: `${origin}/api/v1`,
        api_versions: ["takosumi.dev/v1alpha1"],
        endpoints: {
          api: `${origin}/api/v1`,
          capabilities: `${origin}/api/v1/capabilities`,
          openapi: `${origin}/openapi.json`,
          oidc_issuer: origin,
          extensions: { "openai.models.v1": `${origin}/api/v1/ai` },
        },
      });
    }
    if (url.pathname === "/.well-known/openid-configuration") {
      return Response.json({
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        revocation_endpoint: `${origin}/oauth/revoke`,
      });
    }
    if (url.pathname === "/oauth/token" && init?.method === "POST") {
      const body = new URLSearchParams(String(init.body));
      expect(body.get("client_id")).toBe("takosumi-mobile");
      counter += 1;
      return Response.json({
        access_token: `${host}-access-${counter}`,
        refresh_token: `${host}-refresh-${counter}`,
        token_type: "Bearer",
        expires_in: 300,
        scope: "openid profile offline_access capsules:read capsules:write",
        id_token: `${encode({ alg: "ES256" })}.${encode({
          iss: origin,
          aud: "takosumi-mobile",
          sub: `tsub_${host}`,
          name: `${host} owner`,
        })}.sig`,
      });
    }
    if (url.pathname === "/oauth/revoke" && init?.method === "POST") {
      return new Response(null, { status: 200 });
    }
    if (url.pathname === "/api/v1/apps") {
      return Response.json({ apps: [{ id: `${host}-app` }] });
    }
    return new Response(null, { status: 404 });
  };
  return { fetch, requests };
}

function memoryBridge(): NativeBridge & { readonly opened: string[] } {
  const secure = new Map<string, string>();
  const plain = new Map<string, string>();
  const opened: string[] = [];
  return {
    opened,
    capabilities: {
      launchPayload: true,
      launchPayloadEvents: false,
      externalBrowser: true,
      inAppBrowser: false,
      qrScanner: false,
      localNotifications: false,
      pushNotifications: false,
      biometricAuth: false,
      callIntent: false,
      clipboardText: false,
      secureStorage: true,
      persistentStorage: true,
    },
    storage: {
      kind: "device-persistent",
      get: async (key) => plain.get(key),
      set: async (key, value) => void plain.set(key, value),
      delete: async (key) => void plain.delete(key),
    },
    secureStore: {
      kind: "secure",
      get: async (key) => secure.get(key),
      set: async (key, value) => void secure.set(key, value),
      delete: async (key) => void secure.delete(key),
    },
    getLaunchPayload: async () => undefined,
    openExternalUrl: async (url) => void opened.push(url),
  };
}

async function loadApps(fetch: FetchLike, session: MobileSession) {
  const base = session.apiBaseUrl ?? `${session.hostUrl}/api/v1`;
  const response = await fetch(`${base}/apps`, {
    headers: { authorization: `${session.tokenType} ${session.accessToken}` },
  });
  return (await response.json()) as { apps: Array<{ id: string }> };
}

async function signInVia(
  controller: Pick<
    ReturnType<typeof createMobileClientController>,
    "startSignIn" | "completeSignIn"
  >,
  bridge: ReturnType<typeof memoryBridge>,
) {
  await controller.startSignIn();
  const authorize = new URL(bridge.opened.at(-1)!);
  expect(authorize.searchParams.get("scope")).toBe(
    "openid profile offline_access capsules:read capsules:write",
  );
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  await controller.completeSignIn(
    `takosumi://oauth/callback?code=code&state=${authorize.searchParams.get("state")}&iss=${encodeURIComponent(authorize.origin)}`,
  );
}

function assertNoCrossInstanceTokens(requests: readonly Recorded[]) {
  for (const request of requests) {
    const host = new URL(request.url).hostname.split(".")[0]!;
    if (request.authorization) {
      expect(request.authorization).toContain(`${host}-access-`);
    }
    if (request.body) {
      const body = new URLSearchParams(request.body);
      for (const name of ["token", "refresh_token"]) {
        const value = body.get(name);
        if (value) expect(value.startsWith(`${host}-`)).toBe(true);
      }
    }
  }
}

test("a second instance is added from a connect link, switching changes the home, and tokens stay per instance", async () => {
  const bridge = memoryBridge();
  const { fetch, requests } = instances();
  const controller = createMobileClientController({
    adapter,
    nativeBridge: bridge,
    fetch,
    loadHome: (session) => loadApps(fetch, session),
  });
  await controller.start();

  await controller.connectWithInput("a.example");
  expect(controller.getState().discovery?.apiBaseUrl).toBe("https://a.example/api/v1");
  // The Takosumi document is read once and the retired capabilities path never.
  expect(requests.filter((r) => r.url.endsWith("/.well-known/takosumi"))).toHaveLength(1);
  expect(requests.some((r) => r.url.includes("/v1/capabilities"))).toBe(false);
  await signInVia(controller, bridge);
  expect(controller.getState().session?.hostUrl).toBe("https://a.example");
  expect(controller.getState().session?.accountId).toBe("tsub_a");
  expect(controller.getState().home?.apps[0]?.id).toBe("a-app");

  // A connect link for another instance while signed in is shown, not hidden.
  await controller.handleLaunchPayload(
    "takosumi://connect?host_url=https://b.example&product=takosumi",
  );
  expect(controller.getState().session?.hostUrl).toBe("https://a.example");
  expect(controller.getState().discovery?.hostUrl).toBe("https://b.example");

  await signInVia(controller, bridge);
  const afterB = controller.getState();
  expect(afterB.session?.hostUrl).toBe("https://b.example");
  expect(afterB.home?.apps[0]?.id).toBe("b-app");
  expect(afterB.accounts.map((account) => account.hostUrl).sort()).toEqual([
    "https://a.example",
    "https://b.example",
  ]);
  expect(afterB.accounts.find((a) => a.hostUrl === "https://b.example")?.label).toBe("b owner");

  const accountA = afterB.accounts.find((a) => a.hostUrl === "https://a.example")!;
  await controller.switchAccount(accountA.id);
  expect(controller.getState().session?.hostUrl).toBe("https://a.example");
  expect(controller.getState().activeAccountId).toBe(accountA.id);
  expect(controller.getState().home?.apps[0]?.id).toBe("a-app");

  // Signing out of A revokes A's tokens at A only, then continues with B.
  const before = requests.length;
  await controller.signOut();
  const revocations = requests.slice(before).filter((r) => r.url.endsWith("/oauth/revoke"));
  expect(revocations.map((r) => new URL(r.url).origin)).toEqual([
    "https://a.example",
    "https://a.example",
  ]);
  expect(revocations.map((r) => new URLSearchParams(r.body).get("token_type_hint"))).toEqual([
    "refresh_token",
    "access_token",
  ]);
  expect(controller.getState().session?.hostUrl).toBe("https://b.example");
  expect(controller.getState().accounts).toHaveLength(1);
  expect(controller.getState().home?.apps[0]?.id).toBe("b-app");

  assertNoCrossInstanceTokens(requests);
  controller.stop();
});

test("signing out of an inactive account revokes only it and keeps the active session", async () => {
  const bridge = memoryBridge();
  const { fetch, requests } = instances();
  const controller = createMobileClientController({ adapter, nativeBridge: bridge, fetch });
  await controller.start();
  await controller.connectWithInput("a.example");
  await signInVia(controller, bridge);
  controller.addAccount();
  expect(controller.getState().addingAccount).toBe(true);
  expect(controller.getState().session?.hostUrl).toBe("https://a.example");
  await controller.connectWithInput("b.example");
  await signInVia(controller, bridge);
  expect(controller.getState().addingAccount).toBe(false);

  const accountA = controller.getState().accounts.find((a) => a.hostUrl === "https://a.example")!;
  const before = requests.length;
  await controller.signOutAccount(accountA.id);
  const revocations = requests.slice(before).filter((r) => r.url.endsWith("/oauth/revoke"));
  expect(new Set(revocations.map((r) => new URL(r.url).origin))).toEqual(new Set(["https://a.example"]));
  expect(controller.getState().session?.hostUrl).toBe("https://b.example");
  expect(controller.getState().accounts.map((a) => a.hostUrl)).toEqual(["https://b.example"]);
  assertNoCrossInstanceTokens(requests);
  controller.stop();
});

test("cancelling an added account returns to the current session", async () => {
  const bridge = memoryBridge();
  const { fetch } = instances();
  const controller = createMobileClientController({ adapter, nativeBridge: bridge, fetch });
  await controller.start();
  await controller.connectWithInput("a.example");
  await signInVia(controller, bridge);
  controller.addAccount();
  await controller.connectWithInput("b.example");
  expect(controller.getState().discovery?.hostUrl).toBe("https://b.example");
  controller.cancelAddAccount();
  expect(controller.getState().addingAccount).toBe(false);
  expect(controller.getState().discovery).toBeUndefined();
  expect(controller.getState().session?.hostUrl).toBe("https://a.example");
  controller.stop();
});

test("an existing single-session install keeps its session after the update", async () => {
  const bridge = memoryBridge();
  const { fetch } = instances();
  await bridge.secureStore!.set(
    mobileSessionStorageKey(adapter),
    JSON.stringify({
      hostUrl: "https://a.example",
      product: "takosumi",
      oidcIssuer: "https://a.example",
      oidcClientId: "takosumi-mobile",
      accessToken: "a-access-legacy",
      tokenType: "Bearer",
      refreshToken: "a-refresh-legacy",
      createdAt: "2026-10-29T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    }),
  );
  const controller = createMobileClientController({
    adapter,
    nativeBridge: bridge,
    fetch,
    loadHome: (session) => loadApps(fetch, session),
  });
  await controller.start();
  expect(controller.getState().session?.accessToken).toBe("a-access-legacy");
  expect(controller.getState().accounts).toHaveLength(1);
  expect(controller.getState().activeAccountId).toBe(controller.getState().accounts[0]?.id);
  expect(controller.getState().home?.apps[0]?.id).toBe("a-app");
  controller.stop();
});

test("a route link for another saved instance switches to it", async () => {
  const bridge = memoryBridge();
  const { fetch } = instances();
  const opened: string[] = [];
  const controller = createMobileClientController({
    adapter,
    nativeBridge: bridge,
    fetch,
    openHostRoute: async ({ url }) => void opened.push(url),
  });
  await controller.start();
  await controller.connectWithInput("a.example");
  await signInVia(controller, bridge);
  controller.addAccount();
  await controller.connectWithInput("b.example");
  await signInVia(controller, bridge);
  expect(controller.getState().session?.hostUrl).toBe("https://b.example");

  await controller.handleLaunchPayload("https://a.example/runs/run_1");
  expect(controller.getState().session?.hostUrl).toBe("https://a.example");
  expect(opened).toEqual(["https://a.example/runs/run_1"]);
  controller.stop();
});

test("a host that names another instance's issuer cannot start a sign-in", async () => {
  const bridge = memoryBridge();
  const requests: string[] = [];
  const fetch: FetchLike = async (input) => {
    const url = new URL(String(input));
    requests.push(url.toString());
    if (url.origin === "https://evil.example" && url.pathname === "/.well-known/takosumi") {
      return Response.json({
        product: "takosumi",
        oidcClientId: "takosumi-mobile",
        apiBaseUrl: "https://evil.example/api/v1",
        endpoints: { oidc_issuer: "https://victim.example" },
      });
    }
    if (url.origin === "https://victim.example" && url.pathname === "/.well-known/takosumi") {
      return Response.json({
        product: "takosumi",
        oidcClientId: "takosumi-mobile",
        apiBaseUrl: "https://victim.example/api/v1",
        endpoints: { api: "https://victim.example/api/v1", oidc_issuer: "https://victim.example" },
      });
    }
    if (url.pathname === "/.well-known/openid-configuration") {
      return Response.json({
        issuer: url.origin,
        authorization_endpoint: `${url.origin}/oauth/authorize`,
        token_endpoint: `${url.origin}/oauth/token`,
      });
    }
    return new Response(null, { status: 404 });
  };
  const controller = createMobileClientController({
    adapter: { ...adapter, requireHostIssuer: true },
    nativeBridge: bridge,
    fetch,
  });
  await controller.start();
  await controller.connectWithInput("evil.example");
  expect(controller.getState().discovery?.oidcIssuer).toBe("https://victim.example");
  await controller.startSignIn();
  expect(bridge.opened).toEqual([]);
  expect(controller.getState().status).toContain("Sign-in stopped");
  expect(requests.some((url) => url.startsWith("https://victim.example/.well-known/openid-configuration"))).toBe(false);
  controller.stop();
});

test("a separate issuer that names the host as its API may sign in", async () => {
  const { assertHostIssuerBinding } = await import("../../src/index.ts");
  const fetch: FetchLike = async (input) => {
    const url = new URL(String(input));
    if (url.origin === "https://accounts.example" && url.pathname === "/.well-known/takosumi") {
      return Response.json({ product: "takosumi", apiBaseUrl: "https://app.example/api/v1" });
    }
    return new Response(null, { status: 404 });
  };
  await assertHostIssuerBinding({ hostUrl: "https://app.example", issuer: "https://app.example/", fetch });
  await assertHostIssuerBinding({ hostUrl: "https://app.example", issuer: "https://accounts.example", fetch });
  await expect(
    assertHostIssuerBinding({ hostUrl: "https://other.example", issuer: "https://accounts.example", fetch }),
  ).rejects.toThrow("does not serve https://other.example");
  await expect(
    assertHostIssuerBinding({ hostUrl: "https://app.example", issuer: "https://silent.example", fetch }),
  ).rejects.toThrow("Sign-in stopped");
});

test("a host that is its own issuer cannot route authorize to another issuer (mix-up)", async () => {
  const bridge = memoryBridge();
  const requests: string[] = [];
  const fetch: FetchLike = async (input) => {
    const url = new URL(String(input));
    requests.push(url.toString());
    if (url.pathname === "/.well-known/takosumi") {
      return Response.json({
        product: "takosumi",
        oidcClientId: "takosumi-mobile",
        apiBaseUrl: "https://evil.example/api/v1",
        endpoints: { oidc_issuer: "https://evil.example" },
      });
    }
    if (url.pathname === "/.well-known/openid-configuration") {
      return Response.json({
        issuer: "https://evil.example",
        authorization_endpoint: "https://victim.example/oauth/authorize",
        token_endpoint: "https://evil.example/steal",
      });
    }
    return new Response(null, { status: 404 });
  };
  const controller = createMobileClientController({ adapter, nativeBridge: bridge, fetch });
  await controller.start();
  await controller.connectWithInput("evil.example");
  await controller.startSignIn();
  expect(bridge.opened).toEqual([]);
  expect(controller.getState().status).toContain("issuer's origin");
  expect(requests.some((url) => url.includes("victim.example") || url.endsWith("/steal"))).toBe(false);
  controller.stop();
});

test("a host-API shell refuses a callback that does not name its issuer", async () => {
  const bridge = memoryBridge();
  const { fetch, requests } = instances();
  const controller = createMobileClientController({ adapter, nativeBridge: bridge, fetch });
  await controller.start();
  await controller.connectWithInput("a.example");
  await controller.startSignIn();
  const authorize = new URL(bridge.opened.at(-1)!);
  await controller.completeSignIn(
    `takosumi://oauth/callback?code=code&state=${authorize.searchParams.get("state")}`,
  );
  expect(controller.getState().session).toBeUndefined();
  expect(controller.getState().status).toContain("does not name its issuer");
  expect(requests.some((r) => r.url.endsWith("/oauth/token"))).toBe(false);
  controller.stop();
});

test("a connect link for the host already in use just opens without a prompt", async () => {
  const bridge = memoryBridge();
  const { fetch, requests } = instances();
  const controller = createMobileClientController({ adapter, nativeBridge: bridge, fetch });
  await controller.start();
  await controller.connectWithInput("a.example");
  await signInVia(controller, bridge);
  const before = requests.length;

  // Takosumi fills `{origin}` URL-encoded into the trusted template.
  await controller.handleLaunchPayload(
    "takosumi://connect?host_url=https%3A%2F%2Fa.example&product=takosumi",
  );
  expect(controller.getState().discovery).toBeUndefined();
  expect(controller.getState().session?.hostUrl).toBe("https://a.example");
  expect(controller.getState().status).toBe("このTakosumiにはすでに接続しています。");
  expect(requests.length).toBe(before);

  // Adding a second account on the same host is still possible on purpose.
  controller.addAccount();
  await controller.connectWithInput("a.example");
  expect(controller.getState().discovery?.hostUrl).toBe("https://a.example");
  controller.stop();
});

test("a connect link for the locked host leaves the lock in place without a prompt", async () => {
  const bridge = memoryBridge();
  const { fetch } = instances();
  await bridge.secureStore!.set(
    mobileSessionStorageKey(adapter),
    JSON.stringify({
      hostUrl: "https://a.example",
      product: "takosumi",
      accessToken: "a-access-legacy",
      tokenType: "Bearer",
      createdAt: "2026-10-29T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    }),
  );
  const controller = createMobileClientController({
    adapter,
    nativeBridge: bridge,
    fetch,
    sessionUnlock: { restoreMode: "required" },
  });
  await controller.start();
  expect(controller.getState().lockedSession?.hostUrl).toBe("https://a.example");
  await controller.handleLaunchPayload("takosumi://connect?host_url=https%3A%2F%2Fa.example");
  expect(controller.getState().discovery).toBeUndefined();
  expect(controller.getState().lockedSession?.hostUrl).toBe("https://a.example");
  controller.stop();
});

test("with confirmRouteAccountSwitch a route link for another saved instance asks before switching", async () => {
  const bridge = memoryBridge();
  const { fetch } = instances();
  const opened: string[] = [];
  const controller = createMobileClientController({
    adapter: { ...adapter, confirmRouteAccountSwitch: true },
    nativeBridge: bridge,
    fetch,
    openHostRoute: async ({ url }) => void opened.push(url),
  });
  await controller.start();
  await controller.connectWithInput("a.example");
  await signInVia(controller, bridge);
  controller.addAccount();
  await controller.connectWithInput("b.example");
  await signInVia(controller, bridge);
  expect(controller.getState().session?.hostUrl).toBe("https://b.example");

  await controller.handleLaunchPayload("https://a.example/runs/run_1");
  // Nothing switched: B stays usable and A is offered.
  expect(controller.getState().session?.hostUrl).toBe("https://b.example");
  expect(controller.getState().discovery?.hostUrl).toBe("https://a.example");
  expect(controller.getState().pendingRoute?.path).toBe("/runs/run_1");
  expect(opened).toEqual([]);

  // Choosing the saved account opens the route on it.
  const accountA = controller.getState().accounts.find((a) => a.hostUrl === "https://a.example")!;
  await controller.switchAccount(accountA.id);
  expect(controller.getState().session?.hostUrl).toBe("https://a.example");
  expect(opened).toEqual(["https://a.example/runs/run_1"]);
  expect(controller.getState().pendingRoute).toBeUndefined();
  controller.stop();
});

test("dismissing the prompt drops the pending route", async () => {
  const bridge = memoryBridge();
  const { fetch } = instances();
  const opened: string[] = [];
  const controller = createMobileClientController({
    adapter: { ...adapter, confirmRouteAccountSwitch: true },
    nativeBridge: bridge,
    fetch,
    openHostRoute: async ({ url }) => void opened.push(url),
  });
  await controller.start();
  await controller.connectWithInput("a.example");
  await signInVia(controller, bridge);
  controller.addAccount();
  await controller.connectWithInput("b.example");
  await signInVia(controller, bridge);

  await controller.handleLaunchPayload(
    "takosumi://open?path=%2Fapps&host_url=https%3A%2F%2Fa.example",
  );
  expect(controller.getState().pendingRoute?.path).toBe("/apps");
  controller.cancelAddAccount();
  expect(controller.getState().discovery).toBeUndefined();
  expect(controller.getState().pendingRoute).toBeUndefined();

  const accountA = controller.getState().accounts.find((a) => a.hostUrl === "https://a.example")!;
  await controller.switchAccount(accountA.id);
  expect(controller.getState().session?.hostUrl).toBe("https://a.example");
  expect(opened).toEqual([]);
  controller.stop();
});

test("the host just signed in to or added is not offered again as another host", async () => {
  const bridge = memoryBridge();
  const { fetch } = instances();
  const controller = createMobileClientController({ adapter, nativeBridge: bridge, fetch });
  await controller.start();
  await controller.connectWithInput("a.example");
  await signInVia(controller, bridge);
  expect(controller.getState().session?.hostUrl).toBe("https://a.example");
  expect(controller.getState().discovery).toBeUndefined();

  // Added from a connect link while signed in.
  await controller.handleLaunchPayload("takosumi://connect?host_url=https%3A%2F%2Fb.example");
  expect(controller.getState().discovery?.hostUrl).toBe("https://b.example");
  await signInVia(controller, bridge);
  expect(controller.getState().session?.hostUrl).toBe("https://b.example");
  expect(controller.getState().discovery).toBeUndefined();

  // Added through "add account".
  controller.addAccount();
  await controller.connectWithInput("c.example");
  await signInVia(controller, bridge);
  expect(controller.getState().session?.hostUrl).toBe("https://c.example");
  expect(controller.getState().addingAccount).toBe(false);
  expect(controller.getState().discovery).toBeUndefined();
  controller.stop();
});

/** The same instances, with some hosts unreachable on demand. */
function flakyInstances() {
  const base = instances();
  const offline = new Set<string>();
  const fetch: FetchLike = async (input, init) => {
    if (offline.has(new URL(String(input)).origin)) {
      throw new TypeError("network unreachable");
    }
    return await base.fetch(input, init);
  };
  return { ...base, fetch, offline };
}

test("with confirmRouteAccountSwitch an unreachable saved instance drops the screen", async () => {
  const bridge = memoryBridge();
  const { fetch, offline } = flakyInstances();
  const opened: string[] = [];
  const controller = createMobileClientController({
    adapter: { ...adapter, confirmRouteAccountSwitch: true },
    nativeBridge: bridge,
    fetch,
    openHostRoute: async ({ url }) => void opened.push(url),
  });
  await controller.start();
  await controller.connectWithInput("a.example");
  await signInVia(controller, bridge);
  controller.addAccount();
  await controller.connectWithInput("b.example");
  await signInVia(controller, bridge);

  offline.add("https://a.example");
  await controller.handleLaunchPayload("https://a.example/runs/run_1");
  // Nothing to confirm or dismiss: B stays, and the screen is not kept.
  expect(controller.getState().session?.hostUrl).toBe("https://b.example");
  expect(controller.getState().discovery).toBeUndefined();
  expect(controller.getState().pendingRoute).toBeUndefined();
  expect(controller.getState().status).toContain("network unreachable");

  // Switching to A later for another reason does not open it.
  offline.delete("https://a.example");
  const accountA = controller.getState().accounts.find((a) => a.hostUrl === "https://a.example")!;
  await controller.switchAccount(accountA.id);
  expect(controller.getState().session?.hostUrl).toBe("https://a.example");
  expect(opened).toEqual([]);
  controller.stop();
});

test("a screen link for an unreachable host while signed out is not kept either", async () => {
  const bridge = memoryBridge();
  const { fetch, offline } = flakyInstances();
  const opened: string[] = [];
  const controller = createMobileClientController({
    adapter,
    nativeBridge: bridge,
    fetch,
    openHostRoute: async ({ url }) => void opened.push(url),
  });
  await controller.start();
  offline.add("https://a.example");
  await controller.handleLaunchPayload("https://a.example/apps");
  expect(controller.getState().pendingRoute).toBeUndefined();
  offline.delete("https://a.example");
  await controller.connectWithInput("a.example");
  await signInVia(controller, bridge);
  expect(opened).toEqual([]);
  controller.stop();
});

test("a connect link adds a host to the recent list only after signing in to it", async () => {
  const bridge = memoryBridge();
  const { fetch } = instances();
  const controller = createMobileClientController({ adapter, nativeBridge: bridge, fetch });
  await controller.start();

  await controller.handleLaunchPayload("takosumi://connect?host_url=https%3A%2F%2Fa.example");
  expect(controller.getState().discovery?.hostUrl).toBe("https://a.example");
  expect(controller.getState().knownHosts).toEqual([]);
  expect(isFirstTimeMobileHost(controller.getState(), "https://a.example")).toBe(true);

  // Probing another host and leaving it does not remember it either.
  await controller.connectWithInput("b.example");
  expect(controller.getState().knownHosts).toEqual([]);

  await controller.connectWithInput("a.example");
  await signInVia(controller, bridge);
  expect(controller.getState().knownHosts.map((host) => host.hostUrl)).toEqual([
    "https://a.example",
  ]);
  expect(isFirstTimeMobileHost(controller.getState(), "https://a.example")).toBe(false);
  expect(isFirstTimeMobileHost(controller.getState(), "https://b.example")).toBe(true);
  controller.stop();
});

test("a screen whose host lookup is cut short is dropped, not opened later", async () => {
  const bridge = memoryBridge();
  const base = instances();
  let releaseA: (() => void) | undefined;
  let holdA = false;
  const fetch: FetchLike = async (input, init) => {
    if (holdA && new URL(String(input)).origin === "https://a.example") {
      await new Promise<void>((resolve) => {
        releaseA = resolve;
      });
    }
    return await base.fetch(input, init);
  };
  const opened: string[] = [];
  const controller = createMobileClientController({
    adapter: { ...adapter, confirmRouteAccountSwitch: true },
    nativeBridge: bridge,
    fetch,
    openHostRoute: async ({ url }) => void opened.push(url),
  });
  await controller.start();
  await controller.connectWithInput("a.example");
  await signInVia(controller, bridge);
  controller.addAccount();
  await controller.connectWithInput("b.example");
  await signInVia(controller, bridge);
  expect(controller.getState().session?.hostUrl).toBe("https://b.example");

  holdA = true;
  const link = controller.handleLaunchPayload("https://a.example/runs/run_1");
  while (!releaseA) await new Promise((resolve) => setTimeout(resolve, 1));
  // The lookup is cut short ("add account" here) before A could be shown.
  controller.addAccount();
  holdA = false;
  releaseA();
  await link;
  expect(controller.getState().discovery).toBeUndefined();
  expect(controller.getState().pendingRoute).toBeUndefined();

  controller.cancelAddAccount();
  const accountA = controller.getState().accounts.find((a) => a.hostUrl === "https://a.example")!;
  await controller.switchAccount(accountA.id);
  expect(controller.getState().session?.hostUrl).toBe("https://a.example");
  expect(opened).toEqual([]);
  controller.stop();
});
