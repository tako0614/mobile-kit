import type { MobileKeyValueStore, NativeBridge } from "./types.ts";

export type MobileCredentialStore = Pick<
  MobileKeyValueStore,
  "get" | "set" | "delete"
> & {
  readonly kind: "secure" | "memory";
};

const volatileCredentialStores = new WeakMap<
  NativeBridge,
  MobileCredentialStore
>();

/**
 * Credentials are persisted only by a `kind: secure` store. A browser or a
 * native runtime without a keystore receives a bridge-scoped in-memory store:
 * sign-in can continue while the process lives, but a reload intentionally
 * forgets the PKCE verifier and tokens.
 */
export function mobileCredentialStore(
  nativeBridge: NativeBridge,
): MobileCredentialStore {
  const secureStore = nativeBridge.secureStore;
  if (secureStore) {
    if (secureStore.kind !== "secure") {
      throw new Error("Mobile secureStore must use kind=secure.");
    }
    return secureStore;
  }
  const existing = volatileCredentialStores.get(nativeBridge);
  if (existing) return existing;
  const values = new Map<string, string>();
  const memoryStore: MobileCredentialStore = {
    kind: "memory",
    async get(key) {
      return values.get(key);
    },
    async set(key, value) {
      values.set(key, value);
    },
    async delete(key) {
      values.delete(key);
    },
  };
  volatileCredentialStores.set(nativeBridge, memoryStore);
  return memoryStore;
}

/**
 * Read one pre-hardening credential value from ordinary persistence and delete
 * it before returning. Callers may move a validated value to secure storage or
 * volatile memory, but never write credentials back to this legacy store.
 */
export async function readCredential(
  nativeBridge: NativeBridge,
  key: string,
): Promise<{
  readonly raw: string | undefined;
  readonly fromLegacy: boolean;
}> {
  const credentialStore = mobileCredentialStore(nativeBridge);
  const legacyStore = nativeBridge.storage;
  const credential = await credentialStore.get(key);
  if (credential !== undefined) {
    await legacyStore?.delete(key);
    return { raw: credential, fromLegacy: false };
  }
  if (!legacyStore) return { raw: undefined, fromLegacy: false };
  const value = await legacyStore.get(key);
  if (value === undefined) return { raw: undefined, fromLegacy: false };
  await legacyStore.delete(key);
  return { raw: value, fromLegacy: true };
}

export async function writeCredential(
  nativeBridge: NativeBridge,
  key: string,
  value: string,
): Promise<void> {
  const credentialStore = mobileCredentialStore(nativeBridge);
  // Remove stale plaintext before committing the replacement. If the secure
  // write fails, failing closed is preferable to retaining a usable token in
  // ordinary persistence.
  await nativeBridge.storage?.delete(key);
  await credentialStore.set(key, value);
}

export async function deleteCredentialFromStores(
  nativeBridge: NativeBridge,
  key: string,
): Promise<void> {
  const credentialStore = mobileCredentialStore(nativeBridge);
  const legacyStore = nativeBridge.storage;
  await Promise.all([
    credentialStore.delete(key),
    legacyStore ? legacyStore.delete(key) : Promise.resolve(),
  ]);
}
