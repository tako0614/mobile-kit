import { expect, test } from "bun:test";
import {
  createMobileClientController,
  type FetchLike,
  type HostDiscovery,
  type MobileCustomSignIn,
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
  readonly headers: Headers;
  readonly body?: string;
}

/**
 * `standard.example` is an ordinary instance (mobile client id, own issuer).
 * `shared.example` offers no mobile client id; a product hook signs in there.
 */
function hosts(): { fetch: FetchLike; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const origin = url.origin;
    requests.push({
      url: url.toString(),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body ? String(init.body) : undefined,
    });
    if (url.pathname === "/.well-known/takosumi") {
      const shared = url.hostname === "shared.example";
      return Response.json({
        product: "takosumi",
        name: "Takosumi",
        ...(shared ? {} : { oidcClientId: "takosumi-mobile" }),
        auth: { oidc: true, password: false },
        apiBaseUrl: `${origin}/api/v1`,
        api_versions: ["takosumi.dev/v1alpha1"],
        endpoints: {
          api: `${origin}/api/v1`,
          capabilities: `${origin}/api/v1/capabilities`,
          openapi: `${origin}/openapi.json`,
          oidc_issuer: origin,
        },
        ...(shared ? { shared_account_sign_in: { issuer: "https://issuer.example" } } : {}),
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
    if (url.pathname === "/oauth/token") {
      return Response.json({
        access_token: "standard-access",
        refresh_token: "standard-refresh",
        token_type: "Bearer",
        expires_in: 300,
      });
    }
    if (url.pathname === "/oauth/revoke") return new Response(null, { status: 200 });
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

function hook(): MobileCustomSignIn & {
  readonly begun: HostDiscovery[];
  readonly completed: string[];
  readonly revoked: MobileSession[];
} {
  const begun: HostDiscovery[] = [];
  const completed: string[] = [];
  const revoked: MobileSession[] = [];
  return {
    begun, completed, revoked,
    handles: (discovery) => discovery.hostUrl === "https://shared.example",
    async begin({ discovery }) {
      begun.push(discovery);
      return { authorizationUrl: "https://issuer.example/oauth/authorize?state=hook-state" };
    },
    async complete({ callbackUrl }) {
      if (new URL(callbackUrl).searchParams.get("state") !== "hook-state") return undefined;
      completed.push(callbackUrl);
      return {
        hostUrl: "https://shared.example",
        product: "takosumi",
        apiBaseUrl: "https://shared.example/api/v1",
        accountId: "tsub_shared",
        accessToken: "hook-session-secret",
        tokenType: "takosumi-native-session",
        createdAt: new Date().toISOString(),
      };
    },
    async revokeSession({ session }) {
      if (session.hostUrl !== "https://shared.example") return false;
      revoked.push(session);
      return true;
    },
  };
}

test("a host the hook claims signs in through the hook, and mobile-kit saves, activates and signs out its session", async () => {
  const bridge = memoryBridge();
  const { fetch, requests } = hosts();
  const custom = hook();
  const controller = createMobileClientController({ adapter, nativeBridge: bridge, fetch, customSignIn: custom });
  await controller.start();

  await controller.connectWithInput("shared.example");
  await controller.startSignIn();
  expect(custom.begun.map((discovery) => discovery.hostUrl)).toEqual(["https://shared.example"]);
  expect(bridge.opened.at(-1)).toBe("https://issuer.example/oauth/authorize?state=hook-state");
  // mobile-kit's own flow never ran: no issuer metadata, no token request.
  expect(requests.some((r) => r.url.includes("openid-configuration") || r.url.includes("/oauth/"))).toBe(false);

  await controller.handleLaunchPayload("takosumi://oauth/callback?code=c&state=hook-state");
  expect(custom.completed).toHaveLength(1);
  const state = controller.getState();
  expect(state.session?.hostUrl).toBe("https://shared.example");
  expect(state.session?.accountId).toBe("tsub_shared");
  expect(state.accounts.map((account) => account.hostUrl)).toEqual(["https://shared.example"]);

  const before = requests.length;
  await controller.signOut();
  expect(custom.revoked.map((session) => session.accessToken)).toEqual(["hook-session-secret"]);
  // The hook's credential was never sent to an issuer or host revocation.
  expect(requests.slice(before).some((r) => r.body?.includes("hook-session-secret") ||
    r.headers.get("authorization")?.includes("hook-session-secret"))).toBe(false);
  expect(controller.getState().session).toBeUndefined();
  controller.stop();
});

test("other hosts keep mobile-kit's own sign-in and revocation even with a hook installed", async () => {
  const bridge = memoryBridge();
  const { fetch, requests } = hosts();
  const custom = hook();
  const controller = createMobileClientController({ adapter, nativeBridge: bridge, fetch, customSignIn: custom });
  await controller.start();

  await controller.connectWithInput("standard.example");
  await controller.startSignIn();
  expect(custom.begun).toHaveLength(0);
  const authorize = new URL(bridge.opened.at(-1)!);
  expect(authorize.origin).toBe("https://standard.example");
  // A callback the hook does not recognize falls through to mobile-kit.
  await controller.completeSignIn(
    `takosumi://oauth/callback?code=code&state=${authorize.searchParams.get("state")}&iss=${encodeURIComponent(authorize.origin)}`,
  );
  expect(custom.completed).toHaveLength(0);
  expect(controller.getState().session?.accessToken).toBe("standard-access");

  await controller.signOut();
  expect(custom.revoked).toHaveLength(0);
  expect(requests.filter((r) => r.url.endsWith("/oauth/revoke"))).toHaveLength(2);
  controller.stop();
});

test("a hook session for another product is refused", async () => {
  const bridge = memoryBridge();
  const { fetch } = hosts();
  const custom = hook();
  const controller = createMobileClientController({
    adapter,
    nativeBridge: bridge,
    fetch,
    customSignIn: {
      ...custom,
      complete: async (input) => {
        const session = await custom.complete(input);
        return session ? { ...session, product: "yurucommu" } : undefined;
      },
    },
  });
  await controller.start();
  await controller.connectWithInput("shared.example");
  await controller.startSignIn();
  await controller.completeSignIn("takosumi://oauth/callback?code=c&state=hook-state");
  expect(controller.getState().session).toBeUndefined();
  expect(controller.getState().accounts).toHaveLength(0);
  controller.stop();
});
