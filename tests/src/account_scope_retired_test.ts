import { expect, test } from "bun:test";
import {
  createMobileClientController,
  loadActiveMobileAccountSession,
  loadMobileAccountSession,
  loadMobileAccounts,
  mobileAccountSessionStorageKey,
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

test("account session public read keeps explicit missing id separate from active selection", async () => {
  const bridge = memoryBridge();
  const controller = await twoAccounts(bridge, instances().fetch, () => {});
  const accountA = controller.getState().accounts.find((row) => row.hostUrl === "https://a.example")!;
  // JavaScript callers can omit a required TypeScript property. That must not
  // become an implicit request for the active account's credential slot.
  expect(await Reflect.apply(loadMobileAccountSession, undefined, [{ adapter, nativeBridge: bridge }])).toBeUndefined();
  expect((await Reflect.apply(loadActiveMobileAccountSession, undefined, [{
    adapter, nativeBridge: bridge, accountId: accountA.id,
  }]))?.hostUrl).toBe("https://b.example");
  expect(await loadMobileAccountSession({ adapter, nativeBridge: bridge, accountId: "unknown-account" })).toBeUndefined();
  controller.stop();
});

for (const operation of ["sign-out", "switch", "restore"] as const) {
  for (const defect of ["missing", "malformed", "host", "subject"] as const) {
    test(`invalid stored account retirement: ${operation}/${defect}`, async () => {
      const bridge = memoryBridge();
      const { fetch } = instances();
      const retired: MobileRetiredAccountScope[] = [];
      let controller = await twoAccounts(bridge, fetch, (scope) => { retired.push(scope); });
      const target = controller.getState().accounts.find((row) =>
        row.hostUrl === (operation === "restore" ? "https://b.example" : "https://a.example"))!;
      const key = mobileAccountSessionStorageKey(adapter, target.id);
      const raw = await bridge.secureStore!.get(key);
      if (defect === "missing") await bridge.secureStore!.delete(key);
      else if (defect === "malformed") await bridge.secureStore!.set(key, "{");
      else {
        const session = JSON.parse(raw!);
        if (defect === "host") session.hostUrl = "https://different.example";
        else session.accountId = "different-subject";
        await bridge.secureStore!.set(key, JSON.stringify(session));
      }
      if (operation === "restore") {
        controller.stop();
        controller = createMobileClientController({
          adapter, nativeBridge: bridge, fetch,
          onAccountScopeRetired: (scope) => { retired.push(scope); },
        });
      }
      const act = () => operation === "sign-out" ? controller.signOutAccount(target.id)
        : operation === "switch" ? controller.switchAccount(target.id) : controller.start();
      let rejected = false;
      try { await act(); } catch { rejected = true; }
      expect(rejected).toBe(operation === "restore" && defect !== "missing");
      await drained();
      expect(retired).toEqual([{
        id: target.id, hostUrl: target.hostUrl, product: target.product,
        accountId: target.accountId, reason: operation === "sign-out" ? "signed-out" : "session-invalidated",
      }]);
      const saved = await loadMobileAccounts({ adapter, nativeBridge: bridge });
      expect(saved.accounts).toHaveLength(1);
      expect(saved.accounts.some((row) => row.id === target.id)).toBe(false);
      expect(await bridge.secureStore!.get(key)).toBeUndefined();
      if (operation !== "restore") expect(controller.getState().session?.hostUrl).toBe("https://b.example");
      await act();
      await drained();
      expect(retired).toHaveLength(1);
      controller.stop();
    });
  }
}

test("invalid stored account retirement: failed credential read keeps the saved scope", async () => {
  const backing = memoryBridge();
  let blockedKey: string | undefined;
  const bridge: ReturnType<typeof memoryBridge> = {
    ...backing,
    secureStore: {
      ...backing.secureStore!,
      async get(key) {
        if (key === blockedKey) throw new Error("temporary credential read failure");
        return await backing.secureStore!.get(key);
      },
    },
  };
  const retired: MobileRetiredAccountScope[] = [];
  const controller = await twoAccounts(bridge, instances().fetch, (scope) => { retired.push(scope); });
  const target = controller.getState().accounts.find((row) => row.hostUrl === "https://a.example")!;
  blockedKey = mobileAccountSessionStorageKey(adapter, target.id);
  await controller.switchAccount(target.id);
  await drained();
  expect(retired).toEqual([]);
  expect((await loadMobileAccounts({ adapter, nativeBridge: bridge })).accounts).toHaveLength(2);
  blockedKey = undefined;
  await controller.switchAccount(target.id);
  expect(controller.getState().session?.hostUrl).toBe("https://a.example");
  controller.stop();
});

test("invalid stored account retirement: failed row removal cannot report retirement", async () => {
  const backing = memoryBridge();
  let blockWrites = false;
  const bridge: ReturnType<typeof memoryBridge> = {
    ...backing,
    storage: {
      ...backing.storage!,
      async set(key, value) {
        if (blockWrites && key.endsWith(".accounts")) throw new Error("temporary account write failure");
        await backing.storage!.set(key, value);
      },
    },
  };
  const retired: MobileRetiredAccountScope[] = [];
  const controller = await twoAccounts(bridge, instances().fetch, (scope) => { retired.push(scope); });
  const target = controller.getState().accounts.find((row) => row.hostUrl === "https://a.example")!;
  await bridge.secureStore!.delete(mobileAccountSessionStorageKey(adapter, target.id));
  blockWrites = true;
  await controller.switchAccount(target.id);
  await drained();
  expect(retired).toEqual([]);
  expect((await loadMobileAccounts({ adapter, nativeBridge: bridge })).accounts).toHaveLength(2);
  blockWrites = false;
  await controller.switchAccount(target.id);
  await drained();
  expect(retired).toHaveLength(1);
  controller.stop();
});

test("completed retirement survives a later sign-out storage failure", async () => {
  const backing = memoryBridge();
  const failure = new Error("account storage became unavailable after removal");
  let removedId: string | undefined;
  let removalCommitted = false;
  const bridge: ReturnType<typeof memoryBridge> = {
    ...backing,
    storage: {
      ...backing.storage!,
      async set(key, value) {
        if (key.endsWith(".accounts") && removalCommitted) throw failure;
        await backing.storage!.set(key, value);
        if (key.endsWith(".accounts") && removedId) {
          const list = JSON.parse(value) as { accounts: { id: string }[] };
          removalCommitted = list.accounts.every((row) => row.id !== removedId);
        }
      },
    },
  };
  const retired: MobileRetiredAccountScope[] = [];
  const controller = await twoAccounts(bridge, instances().fetch, (scope) => { retired.push(scope); });
  const target = controller.getState().accounts.find((row) => row.hostUrl === "https://a.example")!;
  removedId = target.id;
  await bridge.secureStore!.delete(mobileAccountSessionStorageKey(adapter, target.id));
  let rejected: unknown;
  try { await controller.signOutAccount(target.id); } catch (error) { rejected = error; }
  await drained();
  expect(rejected).toBe(failure);
  expect(removalCommitted).toBe(true);
  const saved = await loadMobileAccounts({ adapter, nativeBridge: backing });
  expect(saved.accounts).toHaveLength(1);
  expect(saved.accounts.some((row) => row.id === target.id)).toBe(false);
  expect(controller.getState().session?.hostUrl).toBe("https://b.example");
  expect(retired).toEqual([{
    id: target.id, hostUrl: target.hostUrl, product: target.product,
    accountId: target.accountId, reason: "signed-out",
  }]);
  controller.stop();
});

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

