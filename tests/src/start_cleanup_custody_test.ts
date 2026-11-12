import { expect, test } from "bun:test";
import {
  createMobileClientController,
  mobileAccountListStorageKey,
  type MobileProductAdapter,
  type NativeBridge,
} from "../../src/index.ts";
import { createStartupRetry } from "../../src/startup-retry.ts";

const adapter: MobileProductAdapter = {
  product: "takos",
  appName: "Takos",
  hostNoun: "Takos host",
  hostCenterLabel: "Host Takos",
  hostCenterUrl: "https://operator.example/install",
  hostCenterSource: {
    git: "https://github.com/acme/takos.git",
    path: "deploy/opentofu",
  },
  directDeployLabel: "Cloudflare",
  directDeployUrl: "https://deploy.example/?source=takos",
  urlPlaceholder: "https://workspace.example.com",
  primaryActionLabel: "Connect",
  accentColor: "#166534",
  mobileScheme: "takos",
  oidcScopes: ["openid", "profile", "offline_access"],
};

const readError = new Error("synthetic account-list read failure");
const cleanupError = new Error("synthetic unlisten failure");

// A bridge whose account-list read and launch-payload unlisten can each be
// made to fail a counted number of times, tracking live registrations so a
// leaked listener is directly observable.
function custodyBridge() {
  const plain = new Map<string, string>();
  const secure = new Map<string, string>();
  const opened: string[] = [];
  const counts = { registered: 0, unlistenCalls: 0, live: 0, fetches: 0 };
  let readFailures = 0;
  let unlistenFailures = 0;
  let asyncUnlisten = false;
  let deferredRemoval: { settle: (error?: unknown) => void } | undefined;
  const bridge: NativeBridge & {
    readonly opened: string[];
    readonly counts: typeof counts;
    failReads: (count: number) => void;
    failUnlisten: (count: number) => void;
    asyncUnlisten: (yes?: boolean) => void;
    deferUnlisten: () => void;
    settleUnlisten: (error?: unknown) => Promise<void>;
    plain: Map<string, string>;
    secure: Map<string, string>;
  } = {
    opened,
    counts,
    failReads: (count) => {
      readFailures += count;
    },
    failUnlisten: (count) => {
      unlistenFailures += count;
    },
    asyncUnlisten: (yes = true) => {
      asyncUnlisten = yes;
    },
    deferUnlisten: () => {
      deferredRemoval = {} as { settle: (error?: unknown) => void };
    },
    settleUnlisten: async (error?: unknown) => {
      if (!deferredRemoval) throw new Error("no deferred unlisten is pending");
      while (!deferredRemoval.settle) {
        await Promise.resolve();
      }
      const pending = deferredRemoval;
      deferredRemoval = undefined;
      pending.settle(error);
    },
    plain,
    secure,
    capabilities: {
      launchPayload: true,
      launchPayloadEvents: true,
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
      get: async (key) => {
        if (readFailures > 0 && key === mobileAccountListStorageKey(adapter)) {
          readFailures -= 1;
          throw readError;
        }
        return plain.get(key);
      },
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
    onLaunchPayload: async () => {
      counts.registered += 1;
      counts.live += 1;
      return () => {
        counts.unlistenCalls += 1;
        if (deferredRemoval) {
          const removal = deferredRemoval;
          return new Promise<void>((resolve, reject) => {
            removal.settle = (error?: unknown) => {
              if (error === undefined) {
                counts.live -= 1;
                resolve();
              } else {
                reject(error);
              }
            };
          });
        }
        if (asyncUnlisten) {
          return (async () => {
            if (unlistenFailures > 0) {
              unlistenFailures -= 1;
              throw cleanupError;
            }
            counts.live -= 1;
          })();
        }
        if (unlistenFailures > 0) {
          unlistenFailures -= 1;
          throw cleanupError;
        }
        counts.live -= 1;
      };
    },
    openExternalUrl: async (url) => void opened.push(url),
  };
  return bridge;
}

function makeController(bridge: NativeBridge) {
  return createMobileClientController({
    adapter,
    nativeBridge: bridge,
    fetch: async () => {
      throw new Error("fetch is outside this test's contract");
    },
    loadHome: async () => ({ title: "unused" }),
    homeLabel: "workspace",
  });
}

test("a single account-list read failure keeps the original rejection, saved data, and an operable manual retry", async () => {
  const bridge = custodyBridge();
  bridge.plain.set("seed", "kept");
  const controller = makeController(bridge);
  bridge.failReads(1);

  await expect(controller.start()).rejects.toBe(readError);
  expect(controller.getState().status).toBe("起動に失敗しました。");
  expect(bridge.plain.get("seed")).toBe("kept");
  expect(bridge.opened).toEqual([]);
  // The failed attempt cleaned its own listener before rethrowing.
  expect(bridge.counts).toMatchObject({
    registered: 1,
    unlistenCalls: 1,
    live: 0,
    fetches: 0,
  });

  // The explicit retry drives the same start and leaves exactly one live
  // registration with no failure status left behind.
  await controller.start();
  expect(bridge.counts).toMatchObject({ registered: 2, live: 1 });
  expect(controller.getState().status).not.toBe("起動に失敗しました。");
});

test("start plus cleanup double failure preserves both causes and never doubles listeners", async () => {
  const bridge = custodyBridge();
  const controller = makeController(bridge);
  bridge.failReads(1);
  bridge.failUnlisten(1);

  const first = await controller.start().then(
    () => {
      throw new Error("start unexpectedly resolved");
    },
    (error: unknown) => error,
  );
  // The original start error stays the cause; the cleanup failure rides
  // alongside it instead of replacing it.
  expect(first).toBeInstanceOf(AggregateError);
  const aggregated = first as AggregateError;
  expect(aggregated.errors).toContain(readError);
  expect(aggregated.errors).toContain(cleanupError);
  expect(aggregated.cause).toBe(readError);
  // Custody: the unconfirmed listener stays the only live registration.
  expect(bridge.counts).toMatchObject({
    registered: 1,
    unlistenCalls: 1,
    live: 1,
    fetches: 0,
  });

  // While the cleanup still refuses through both removal attempts inside
  // one retry, it must not add a second live registration.
  bridge.failUnlisten(2);
  const second = await controller.start().then(
    () => {
      throw new Error("start unexpectedly resolved");
    },
    (error: unknown) => error,
  );
  // Both removal refusals ride as causes; custody still holds the one
  // unconfirmed registration.
  expect(second).toBeInstanceOf(AggregateError);
  expect((second as AggregateError).errors).toContain(cleanupError);
  expect(bridge.counts.registered).toBe(1);
  expect(bridge.counts.live).toBe(1);

  // Once cleanup can be confirmed, an explicit recovery removes the
  // original exactly once before acquiring one replacement.
  await controller.start();
  expect(bridge.counts.registered).toBe(2);
  expect(bridge.counts.live).toBe(1);
});

test("repeated failed retries keep at most the original unconfirmed listener", async () => {
  const bridge = custodyBridge();
  const controller = makeController(bridge);
  bridge.failReads(10);
  bridge.failUnlisten(10);

  for (let i = 0; i < 3; i += 1) {
    await expect(controller.start()).rejects.toBeDefined();
  }
  expect(bridge.counts.registered).toBe(1);
  expect(bridge.counts.live).toBe(1);
});

test("stop keeps custody of an unconfirmed cleanup instead of reporting retirement", async () => {
  const bridge = custodyBridge();
  const controller = makeController(bridge);
  bridge.failReads(1);
  bridge.failUnlisten(2);
  await expect(controller.start()).rejects.toBeDefined();
  expect(bridge.counts.live).toBe(1);

  // stop() must attempt the retained cleanup again; its refusal propagates
  // rather than reporting a completed retirement with a live listener.
  expect(() => controller.stop()).toThrow(cleanupError);
  expect(bridge.counts.live).toBe(1);

  // Custody survives the stop: the next start finishes the removal before
  // registering a single replacement.
  await controller.start();
  expect(bridge.counts.registered).toBe(2);
  expect(bridge.counts.live).toBe(1);

  // A healthy stop still returns normally with nothing left live.
  controller.stop();
  expect(bridge.counts.live).toBe(0);
});

test("an async removal rejection keeps custody like a synchronous refusal", async () => {
  // Tauri's listen() resolves to an async _unlisten: a removal failure
  // arrives as a rejected promise, not a thrown error. The start catch's
  // awaited retire surfaces it as the second cause exactly like a throw.
  const bridge = custodyBridge();
  bridge.asyncUnlisten(true);
  const controller = makeController(bridge);
  bridge.failReads(1);
  bridge.failUnlisten(1);

  const first = await controller.start().then(
    () => {
      throw new Error("start unexpectedly resolved");
    },
    (error: unknown) => error,
  );
  expect(first).toBeInstanceOf(AggregateError);
  expect((first as AggregateError).errors).toEqual([readError, cleanupError]);
  expect((first as AggregateError).cause).toBe(readError);
  expect(bridge.counts).toMatchObject({ registered: 1, unlistenCalls: 1, live: 1 });

  // The retained handle lets the next explicit start finish the removal
  // before registering exactly one replacement.
  bridge.asyncUnlisten(false);
  await controller.start();
  expect(bridge.counts).toMatchObject({ registered: 2, live: 1 });
});

test("a still-pending removal is awaited before a retry registers", async () => {
  const bridge = custodyBridge();
  const controller = makeController(bridge);
  bridge.failReads(1);
  bridge.deferUnlisten();

  let rejected: unknown;
  let settled = false;
  const attempt = controller.start().then(
    () => {
      throw new Error("start unexpectedly resolved");
    },
    (error: unknown) => error,
  ).finally(() => {
    settled = true;
  });
  // The failed start cannot settle while its own cleanup is unconfirmed:
  // once the deferred removal was invoked, the attempt must still be open.
  while (bridge.counts.unlistenCalls === 0) {
    await Promise.resolve();
  }
  expect(settled).toBe(false);
  await bridge.settleUnlisten();
  rejected = await attempt;
  expect(rejected).toBe(readError);
  expect(bridge.counts).toMatchObject({ registered: 1, unlistenCalls: 1, live: 0 });

  await controller.start();
  expect(bridge.counts).toMatchObject({ registered: 2, live: 1 });
});

test("stop cannot wait on an async removal but keeps its custody and surfaces a refusal", async () => {
  const bridge = custodyBridge();
  const controller = makeController(bridge);
  await controller.start();
  expect(bridge.counts).toMatchObject({ registered: 1, live: 1 });

  // A pending removal: stop() initiates it and returns while the promise is
  // still open — no false retirement, no swallowed rejection.
  bridge.deferUnlisten();
  controller.stop();
  expect(bridge.counts).toMatchObject({ unlistenCalls: 1, live: 1 });

  // Its refusal is drained to a diagnostic, and the retained handle lets the
  // next explicit start finish the removal before registering once.
  await bridge.settleUnlisten(cleanupError);
  await Promise.resolve(); // let the drained rejection land
  bridge.deferUnlisten();
  const retry = controller.start();
  await bridge.settleUnlisten();
  await retry;
  await Promise.resolve();
  expect(bridge.counts).toMatchObject({ registered: 2, unlistenCalls: 2, live: 1 });
});

test("startup retry dedupes in-flight attempts, recovers on success, and honors disposal", async () => {
  let calls = 0;
  let release: ((error: unknown) => void) | undefined;
  const pending = new Promise<never>((_, reject) => {
    release = reject;
  });
  const retry = createStartupRetry(() => {
    calls += 1;
    return pending;
  });

  // Two overlapping clicks share one start operation.
  const first = retry.attempt();
  const second = retry.attempt();
  expect(calls).toBe(1);
  release?.(new Error("late failure"));
  await Promise.all([first, second]);
  expect(retry.failed()).toBe(true);
  expect(retry.starting()).toBe(false);

  // A later explicit retry recovers and clears the failure.
  let succeed = true;
  const recovered = createStartupRetry(async () => {
    calls += 1;
    if (!succeed) throw new Error("still failing");
  });
  succeed = false;
  await recovered.attempt();
  expect(recovered.failed()).toBe(true);
  succeed = true;
  await recovered.attempt();
  expect(recovered.failed()).toBe(false);

  // Disposal blocks further attempts and a late completion writes nothing.
  const callsBeforeDispose = calls;
  recovered.dispose();
  await recovered.attempt();
  const settledRetry = createStartupRetry(async () => {
    calls += 1;
  });
  settledRetry.dispose();
  await settledRetry.attempt();
  expect(calls).toBe(callsBeforeDispose);
});

test("startup retry marks failure without swallowing the controller's rejection", async () => {
  const bridge = custodyBridge();
  const controller = makeController(bridge);
  bridge.failReads(1);
  const retry = createStartupRetry(() => controller.start());

  await retry.attempt();
  expect(retry.failed()).toBe(true);
  // The rejection reached the retry surface but the run stayed unhandled-
  // rejection free: attempt() resolves either way.
  await retry.attempt();
  expect(retry.failed()).toBe(false);
});
