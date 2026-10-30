import { expect, test } from "bun:test";
import {
  loadMobileAccounts,
  loadMobileAccountSession,
  loadMobileSession,
  mobileAccountListStorageKey,
  mobileAccountSessionStorageKey,
  mobileSessionStorageKey,
  readIdTokenAccount,
  removeMobileAccountSession,
  sameOriginApiBaseUrl,
  saveMobileAccountSession,
  setActiveMobileAccount,
  type MobileProductAdapter,
  type MobileSession,
  type NativeBridge,
} from "../../src/index.ts";

const adapter: MobileProductAdapter = {
  product: "takosumi",
  appName: "Takosumi",
  hostNoun: "Takosumi",
  urlPlaceholder: "https://app.example",
  primaryActionLabel: "Connect",
  accentColor: "#f5483d",
  mobileScheme: "takosumi",
};

function bridge(): NativeBridge & {
  readonly secure: Map<string, string>;
  readonly plain: Map<string, string>;
} {
  const secure = new Map<string, string>();
  const plain = new Map<string, string>();
  return {
    secure,
    plain,
    capabilities: {
      launchPayload: false,
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
    openExternalUrl: async () => undefined,
  };
}

function idToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  return `${encode({ alg: "ES256" })}.${encode(claims)}.signature`;
}

function session(
  hostUrl: string,
  accountId: string | undefined,
  accessToken: string,
): MobileSession {
  return {
    hostUrl,
    product: "takosumi",
    oidcIssuer: hostUrl,
    oidcClientId: "takosumi-mobile",
    ...(accountId ? { accountId } : {}),
    accessToken,
    tokenType: "Bearer",
    refreshToken: `${accessToken}-refresh`,
    createdAt: "2026-10-30T00:00:00.000Z",
  };
}

test("a legacy single-key session becomes the first, active account", async () => {
  const native = bridge();
  native.secure.set(
    mobileSessionStorageKey(adapter),
    JSON.stringify({
      ...session("https://a.example", undefined, "legacy-access"),
      idToken: idToken({
        iss: "https://a.example",
        aud: "takosumi-mobile",
        sub: "tsub_alice",
        email: "alice@example.test",
      }),
    }),
  );

  const restored = await loadMobileSession({ adapter, nativeBridge: native });
  expect(restored?.accessToken).toBe("legacy-access");
  expect(restored?.accountId).toBe("tsub_alice");
  expect(native.secure.has(mobileSessionStorageKey(adapter))).toBe(false);

  const list = await loadMobileAccounts({ adapter, nativeBridge: native });
  expect(list.accounts).toHaveLength(1);
  expect(list.activeId).toBe(list.accounts[0]?.id);
  expect(list.accounts[0]).toMatchObject({
    hostUrl: "https://a.example",
    accountId: "tsub_alice",
    label: "alice@example.test",
  });
  expect(
    native.secure.get(mobileAccountSessionStorageKey(adapter, list.activeId!)),
  ).toContain("legacy-access");
});

test("a legacy plaintext session moves into the secure store, never back to plaintext", async () => {
  const native = bridge();
  native.plain.set(
    mobileSessionStorageKey(adapter),
    JSON.stringify(session("https://a.example", "tsub_alice", "plain-access")),
  );
  expect((await loadMobileSession({ adapter, nativeBridge: native }))?.accessToken)
    .toBe("plain-access");
  expect(native.plain.has(mobileSessionStorageKey(adapter))).toBe(false);
  for (const value of native.plain.values()) {
    expect(value).not.toContain("plain-access");
  }
});

test("sessions are kept per host and account, and switching changes the active one", async () => {
  const native = bridge();
  const a = await saveMobileAccountSession({
    adapter,
    nativeBridge: native,
    session: session("https://a.example", "tsub_alice", "a-access"),
  });
  const b = await saveMobileAccountSession({
    adapter,
    nativeBridge: native,
    session: session("https://b.example", "tsub_alice", "b-access"),
  });
  const a2 = await saveMobileAccountSession({
    adapter,
    nativeBridge: native,
    session: session("https://a.example", "tsub_bob", "a2-access"),
  });
  const list = await loadMobileAccounts({ adapter, nativeBridge: native });
  expect(list.accounts.map((row) => row.id).sort()).toEqual(
    [a!.id, b!.id, a2!.id].sort(),
  );
  expect(list.activeId).toBe(a2!.id);

  await setActiveMobileAccount({ adapter, nativeBridge: native, accountId: a!.id });
  expect((await loadMobileSession({ adapter, nativeBridge: native }))?.accessToken)
    .toBe("a-access");
  expect(
    (await loadMobileAccountSession({ adapter, nativeBridge: native, accountId: b!.id }))
      ?.accessToken,
  ).toBe("b-access");

  // Signing in again to the same host and account replaces that session.
  const again = await saveMobileAccountSession({
    adapter,
    nativeBridge: native,
    session: session("https://a.example/", "tsub_alice", "a-access-2"),
  });
  expect(again?.id).toBe(a!.id);
  expect((await loadMobileAccounts({ adapter, nativeBridge: native })).accounts)
    .toHaveLength(3);
});

test("the non-secret account list carries no tokens", async () => {
  const native = bridge();
  await saveMobileAccountSession({
    adapter,
    nativeBridge: native,
    session: { ...session("https://a.example", "tsub_alice", "secret-access"), idToken: "secret-id-token" },
  });
  const raw = native.plain.get(mobileAccountListStorageKey(adapter)) ?? "";
  expect(raw).toContain("https://a.example");
  expect(raw).not.toContain("secret-access");
  expect(raw).not.toContain("secret-access-refresh");
  expect(raw).not.toContain("secret-id-token");
});

test("a slot holding another host's session is discarded instead of returned", async () => {
  const native = bridge();
  const a = await saveMobileAccountSession({
    adapter,
    nativeBridge: native,
    session: session("https://a.example", "tsub_alice", "a-access"),
  });
  // Simulate a mixed-up slot: host B's token stored under host A's row.
  native.secure.set(
    mobileAccountSessionStorageKey(adapter, a!.id),
    JSON.stringify(session("https://b.example", "tsub_alice", "b-access")),
  );
  await expect(
    loadMobileAccountSession({ adapter, nativeBridge: native, accountId: a!.id }),
  ).rejects.toThrow("does not belong to its account");
  expect(native.secure.has(mobileAccountSessionStorageKey(adapter, a!.id))).toBe(false);
  expect((await loadMobileAccounts({ adapter, nativeBridge: native })).accounts).toEqual([]);
});

test("a row whose secure slot is gone is dropped", async () => {
  const native = bridge();
  const a = await saveMobileAccountSession({
    adapter,
    nativeBridge: native,
    session: session("https://a.example", "tsub_alice", "a-access"),
  });
  native.secure.delete(mobileAccountSessionStorageKey(adapter, a!.id));
  expect(await loadMobileSession({ adapter, nativeBridge: native })).toBeUndefined();
  expect((await loadMobileAccounts({ adapter, nativeBridge: native })).accounts).toEqual([]);
});

test("a rotation saved after sign-out does not bring the account back", async () => {
  const native = bridge();
  const a = await saveMobileAccountSession({
    adapter,
    nativeBridge: native,
    session: session("https://a.example", "tsub_alice", "a-access"),
  });
  await removeMobileAccountSession({ adapter, nativeBridge: native, accountId: a!.id });
  const saved = await saveMobileAccountSession({
    adapter,
    nativeBridge: native,
    session: session("https://a.example", "tsub_alice", "a-rotated"),
    activate: false,
    onlyIfExisting: true,
  });
  expect(saved).toBeUndefined();
  expect((await loadMobileAccounts({ adapter, nativeBridge: native })).accounts).toEqual([]);
  expect([...native.secure.values()].some((value) => value.includes("a-rotated"))).toBe(false);
});

test("a rotation for an inactive account updates it without switching", async () => {
  const native = bridge();
  const a = await saveMobileAccountSession({
    adapter,
    nativeBridge: native,
    session: session("https://a.example", "tsub_alice", "a-access"),
  });
  const b = await saveMobileAccountSession({
    adapter,
    nativeBridge: native,
    session: session("https://b.example", "tsub_alice", "b-access"),
  });
  await saveMobileAccountSession({
    adapter,
    nativeBridge: native,
    session: session("https://a.example", "tsub_alice", "a-rotated"),
    activate: false,
    onlyIfExisting: true,
  });
  const list = await loadMobileAccounts({ adapter, nativeBridge: native });
  expect(list.activeId).toBe(b!.id);
  expect(
    (await loadMobileAccountSession({ adapter, nativeBridge: native, accountId: a!.id }))
      ?.accessToken,
  ).toBe("a-rotated");
});

test("ID token claims key the account only for this issuer and client", () => {
  const token = idToken({
    iss: "https://a.example",
    aud: ["takosumi-mobile", "other"],
    sub: "tsub_alice",
    name: "Alice",
  });
  expect(
    readIdTokenAccount({ idToken: token, issuer: "https://a.example/", clientId: "takosumi-mobile" }),
  ).toEqual({ accountId: "tsub_alice", accountLabel: "Alice" });
  expect(
    readIdTokenAccount({ idToken: token, issuer: "https://b.example", clientId: "takosumi-mobile" }),
  ).toBeUndefined();
  expect(
    readIdTokenAccount({ idToken: token, issuer: "https://a.example", clientId: "takos-mobile" }),
  ).toBeUndefined();
  expect(
    readIdTokenAccount({ idToken: "not-a-jwt", issuer: "https://a.example", clientId: "takosumi-mobile" }),
  ).toBeUndefined();
});

test("an API base URL is accepted only on the host's own origin", () => {
  expect(sameOriginApiBaseUrl("https://a.example/api/v1/", "https://a.example")).toBe(
    "https://a.example/api/v1",
  );
  expect(sameOriginApiBaseUrl("https://evil.example/api/v1", "https://a.example")).toBeUndefined();
  expect(sameOriginApiBaseUrl("http://a.example/api/v1", "https://a.example")).toBeUndefined();
  expect(sameOriginApiBaseUrl("https://user:pw@a.example/api", "https://a.example")).toBeUndefined();
  expect(sameOriginApiBaseUrl("https://a.example/api?x=1", "https://a.example")).toBeUndefined();
  expect(sameOriginApiBaseUrl("http://localhost:8787/api/v1", "http://localhost:8787")).toBe(
    "http://localhost:8787/api/v1",
  );
});
