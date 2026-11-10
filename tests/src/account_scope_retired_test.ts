import { expect, test } from "bun:test";
import {
  createMobileClientController,
  mobileSessionStorageKey,
  type FetchLike,
  type MobileProductAdapter,
  type MobileRetiredAccountScope,
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

function encode(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** Two independent Takosumi instances; each mints tokens that name it. */
function instances(refreshStatus = 200): { fetch: FetchLike } {
  let counter = 0;
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const origin = url.origin;
    const host = url.hostname.split(".")[0];
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
      if (body.get("grant_type") === "refresh_token") {
        return new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: refreshStatus,
          headers: { "content-type": "application/json" },
        });
      }
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
    return new Response(null, { status: 404 });
  };
  return { fetch };
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

async function signInVia(
  controller: Pick<
    ReturnType<typeof createMobileClientController>,
    "startSignIn" | "completeSignIn"
  >,
  bridge: ReturnType<typeof memoryBridge>,
) {
  await controller.startSignIn();
  const authorize = new URL(bridge.opened.at(-1)!);
  await controller.completeSignIn(
    `takosumi://oauth/callback?code=code&state=${authorize.searchParams.get("state")}&iss=${encodeURIComponent(authorize.origin)}`,
  );
}

/** The notification is detached; a macrotask drains it. */
const drained = () => new Promise((resolve) => setTimeout(resolve, 0));

async function twoAccounts(
  bridge: ReturnType<typeof memoryBridge>,
  fetch: FetchLike,
  onAccountScopeRetired: (scope: MobileRetiredAccountScope) => void,
) {
  const controller = createMobileClientController({
    adapter,
    nativeBridge: bridge,
    fetch,
    onAccountScopeRetired,
  });
  await controller.start();
  await controller.connectWithInput("a.example");
  await signInVia(controller, bridge);
  controller.addAccount();
  await controller.connectWithInput("b.example");
  await signInVia(controller, bridge);
  return controller;
}

test("explicit sign-out of the active account reports exactly its retired scope", async () => {
  const bridge = memoryBridge();
  const { fetch } = instances();
  const retired: MobileRetiredAccountScope[] = [];
  const controller = await twoAccounts(bridge, fetch, (scope) => {
    retired.push(scope);
  });
  expect(controller.getState().session?.hostUrl).toBe("https://b.example");

  const accountA = controller
    .getState()
    .accounts.find((account) => account.hostUrl === "https://a.example")!;
  const accountB = controller
    .getState()
    .accounts.find((account) => account.hostUrl === "https://b.example")!;
  await controller.switchAccount(accountA.id);
  await controller.signOut();
  await drained();

  expect(retired).toEqual([
    {
      id: accountA.id,
      hostUrl: "https://a.example",
      product: "takosumi",
      accountId: "tsub_a",
      reason: "signed-out",
    },
  ]);
  // The switch back to B continued without firing for B's live scope.
  expect(controller.getState().session?.hostUrl).toBe("https://b.example");
  expect(controller.getState().accounts.map((a) => a.id)).toEqual([accountB.id]);
  controller.stop();
  await drained();
  expect(retired).toHaveLength(1);
});

test("signing out of a saved inactive account reports only that row", async () => {
  const bridge = memoryBridge();
  const { fetch } = instances();
  const retired: MobileRetiredAccountScope[] = [];
  const controller = await twoAccounts(bridge, fetch, (scope) => {
    retired.push(scope);
  });

  const accountA = controller
    .getState()
    .accounts.find((account) => account.hostUrl === "https://a.example")!;
  await controller.signOutAccount(accountA.id);
  await drained();

  expect(retired).toEqual([
    {
      id: accountA.id,
      hostUrl: "https://a.example",
      product: "takosumi",
      accountId: "tsub_a",
      reason: "signed-out",
    },
  ]);
  expect(controller.getState().session?.hostUrl).toBe("https://b.example");
  controller.stop();
});

test("transient teardown, switching, and bookmark removal never retire a scope", async () => {
  const bridge = memoryBridge();
  const { fetch } = instances();
  const retired: MobileRetiredAccountScope[] = [];
  const controller = await twoAccounts(bridge, fetch, (scope) => {
    retired.push(scope);
  });

  const accountA = controller
    .getState()
    .accounts.find((account) => account.hostUrl === "https://a.example")!;
  await controller.switchAccount(accountA.id);
  await controller.switchAccount(
    controller
      .getState()
      .accounts.find((account) => account.hostUrl === "https://b.example")!.id,
  );
  await controller.forgetKnownHost("https://a.example");
  controller.stop();
  await drained();

  expect(retired).toEqual([]);
  // A sign-out request for a row that no longer exists retires nothing.
  const restarted = createMobileClientController({
    adapter,
    nativeBridge: bridge,
    fetch,
    onAccountScopeRetired: (scope) => {
      retired.push(scope);
    },
  });
  await restarted.start();
  await restarted.signOutAccount("account-that-is-gone");
  await drained();
  expect(retired).toEqual([]);
  restarted.stop();
});

test("an issuer-invalidated saved session reports session-invalidated", async () => {
  const bridge = memoryBridge();
  const { fetch } = instances(400);
  await bridge.secureStore!.set(
    mobileSessionStorageKey(adapter),
    JSON.stringify({
      hostUrl: "https://a.example",
      product: "takosumi",
      oidcIssuer: "https://a.example",
      oidcClientId: "takosumi-mobile",
      accountId: "tsub_a",
      accountLabel: "a owner",
      accessToken: "a-access-stale",
      tokenType: "Bearer",
      refreshToken: "a-refresh-stale",
      createdAt: "2026-10-29T00:00:00.000Z",
      expiresAt: "2026-10-29T00:05:00.000Z",
    } satisfies Partial<MobileSession>),
  );
  const retired: MobileRetiredAccountScope[] = [];
  const controller = createMobileClientController({
    adapter,
    nativeBridge: bridge,
    fetch,
    onAccountScopeRetired: (scope) => {
      retired.push(scope);
    },
  });
  await controller.start();
  await drained();

  expect(controller.getState().session).toBeUndefined();
  expect(controller.getState().accounts).toEqual([]);
  expect(retired).toEqual([
    {
      id: expect.any(String),
      hostUrl: "https://a.example",
      product: "takosumi",
      accountId: "tsub_a",
      reason: "session-invalidated",
    },
  ]);
  controller.stop();
});

test("a throwing cleanup callback cannot keep the user signed in and is surfaced", async () => {
  const bridge = memoryBridge();
  const { fetch } = instances();
  const statuses: string[] = [];
  const controller = createMobileClientController({
    adapter,
    nativeBridge: bridge,
    fetch,
    onAccountScopeRetired: () => {
      throw new Error("recovery store write failed");
    },
  });
  controller.subscribe((state) => {
    if (state.status) statuses.push(state.status);
  });
  await controller.start();
  await controller.connectWithInput("a.example");
  await signInVia(controller, bridge);
  expect(controller.getState().session?.hostUrl).toBe("https://a.example");

  await controller.signOut();
  await drained();

  // The row is gone and the failure reached the status stream, detached.
  expect(controller.getState().accounts).toEqual([]);
  expect(controller.getState().session).toBeUndefined();
  expect(statuses.some((s) => s.includes("recovery store write failed"))).toBe(
    true,
  );
  controller.stop();
});

