import type {
  MobileAccountList,
  MobileAccountSummary,
  MobileProductAdapter,
  MobilePersistentStore,
  MobileSession,
  NativeBridge,
} from "./types.ts";
import {
  deleteCredentialFromStores,
  mobileCredentialStore,
  readCredential,
  writeCredential,
} from "./credential-store.ts";
import { isMobileProductKind } from "./contract/mobile.ts";
import { requireMobileProductKey } from "./product-key.ts";
import { normalizeHostUrl, requireSecureWebUrl } from "./url.ts";

/**
 * Sessions are kept per (host origin, account subject). Each one has its own
 * credential-store slot keyed by an opaque random id; the list of rows (host,
 * label, last use, which one is active) is not secret and lives in ordinary
 * persistence. One session is active at a time.
 *
 * Isolation: a slot is only ever returned for the row whose host and account
 * it was written for. A slot whose stored session names a different host or
 * account is discarded, so a token issued by one host is never handed to a
 * caller that asked for another.
 */

const ACCOUNT_LIST_VERSION = 1;
const ACCOUNT_LIMIT = 32;
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_LABEL_LENGTH = 256;
const MAX_ACCOUNT_SUBJECT_LENGTH = 512;

export interface MobileAccountStoreInput {
  readonly adapter: MobileProductAdapter;
  readonly nativeBridge: NativeBridge;
}

export interface SaveMobileAccountSessionInput extends MobileAccountStoreInput {
  readonly session: MobileSession;
  /**
   * `true` (default) makes this the active account; `false` leaves the active
   * account as is; `"if-none"` activates it only when no account is active.
   */
  readonly activate?: boolean | "if-none";
  /**
   * Only update a session that is still saved. Used for token rotation, so a
   * refresh that finishes after sign-out cannot bring the account back.
   */
  readonly onlyIfExisting?: boolean;
  readonly now?: () => Date;
}

export interface MobileAccountIdInput extends MobileAccountStoreInput {
  readonly accountId: string;
}

export interface SetActiveMobileAccountInput extends MobileAccountIdInput {
  readonly now?: () => Date;
}

/** Legacy single-session key, read once and migrated into the account list. */
export function mobileSessionStorageKey(adapter: MobileProductAdapter): string {
  return `takosumi.mobile.${requireMobileProductKey(adapter.product)}.session`;
}

export function mobileAccountListStorageKey(
  adapter: MobileProductAdapter,
): string {
  return `takosumi.mobile.${requireMobileProductKey(adapter.product)}.accounts`;
}

export function mobileAccountSessionStorageKey(
  adapter: MobileProductAdapter,
  accountId: string,
): string {
  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new Error("Mobile account id is invalid.");
  }
  return `${mobileSessionStorageKey(adapter)}.${accountId}`;
}

/** Identity of a saved session: the host origin plus the account subject. */
export function mobileAccountIdentity(
  session: Pick<MobileSession, "hostUrl" | "accountId">,
): string {
  return `${normalizeHostUrl(session.hostUrl)}\u0000${session.accountId ?? ""}`;
}

export async function loadMobileAccounts(
  input: MobileAccountStoreInput,
): Promise<MobileAccountList> {
  return await withAccountLock(input.nativeBridge, async () => {
    await migrateLegacySessionLocked(input);
    return await readAccountList(input);
  });
}

export async function saveMobileAccountSession(
  input: SaveMobileAccountSessionInput,
): Promise<MobileAccountSummary | undefined> {
  return await withAccountLock(input.nativeBridge, async () => {
    // An unreadable legacy value is superseded by the session being saved.
    await migrateLegacySessionLocked(input, { discardInvalid: true });
    return await saveAccountSessionLocked(input);
  });
}

/** The active account's session, after moving a legacy session into the list. */
export async function loadActiveMobileAccountSession(
  input: MobileAccountStoreInput,
): Promise<MobileSession | undefined> {
  return await withAccountLock(input.nativeBridge, async () => {
    await migrateLegacySessionLocked(input);
    const list = await readAccountList(input);
    if (!list.activeId) return undefined;
    return await loadAccountSessionLocked(input, list, list.activeId);
  });
}

export async function loadMobileAccountSession(
  input: MobileAccountIdInput,
): Promise<MobileSession | undefined> {
  return await withAccountLock(input.nativeBridge, async () => {
    await migrateLegacySessionLocked(input);
    const list = await readAccountList(input);
    return await loadAccountSessionLocked(input, list, input.accountId);
  });
}

export async function setActiveMobileAccount(
  input: SetActiveMobileAccountInput,
): Promise<MobileAccountList> {
  return await withAccountLock(input.nativeBridge, async () => {
    const list = await readAccountList(input);
    const row = list.accounts.find((account) => account.id === input.accountId);
    if (!row) throw new Error("Saved account was not found.");
    const touched: MobileAccountSummary = {
      ...row,
      lastUsedAt: (input.now?.() ?? new Date()).toISOString(),
    };
    const next: MobileAccountList = {
      activeId: row.id,
      accounts: [
        touched,
        ...list.accounts.filter((account) => account.id !== row.id),
      ],
    };
    await writeAccountList(input, next);
    return next;
  });
}

/** Deletes one saved session and its row. The caller revokes tokens first. */
export async function removeMobileAccountSession(
  input: MobileAccountIdInput,
): Promise<MobileAccountList> {
  return await withAccountLock(input.nativeBridge, async () => {
    const list = await readAccountList(input);
    return await removeAccountLocked(input, list, input.accountId);
  });
}

/** Removes the saved session with this host and account, if any. */
export async function removeMobileAccountSessionFor(
  input: MobileAccountStoreInput & {
    readonly session: Pick<MobileSession, "hostUrl" | "accountId">;
  },
): Promise<MobileAccountList> {
  return await withAccountLock(input.nativeBridge, async () => {
    const list = await readAccountList(input);
    const identity = mobileAccountIdentity(input.session);
    const row = list.accounts.find(
      (account) => mobileAccountIdentity(account) === identity,
    );
    if (!row) return list;
    return await removeAccountLocked(input, list, row.id);
  });
}

/** Removes the active session, leaving other saved accounts in place. */
export async function removeActiveMobileAccountSession(
  input: MobileAccountStoreInput,
): Promise<MobileAccountList> {
  return await withAccountLock(input.nativeBridge, async () => {
    // A legacy single-key session is the active one until migrated.
    await deleteCredentialFromStores(
      input.nativeBridge,
      mobileSessionStorageKey(input.adapter),
    );
    const list = await readAccountList(input);
    if (!list.activeId) return list;
    return await removeAccountLocked(input, list, list.activeId);
  });
}

// --- locked helpers -----------------------------------------------------------

async function saveAccountSessionLocked(
  input: SaveMobileAccountSessionInput,
): Promise<MobileAccountSummary | undefined> {
  const session = input.session;
  if (session.product !== input.adapter.product) {
    throw new Error("Mobile session product does not match this app.");
  }
  const hostUrl = normalizeHostUrl(session.hostUrl);
  const accountId = boundedText(session.accountId, MAX_ACCOUNT_SUBJECT_LENGTH);
  const identity = mobileAccountIdentity({ hostUrl, accountId });
  const list = await readAccountList(input);
  const existing = list.accounts.find(
    (account) => mobileAccountIdentity(account) === identity,
  );
  if (!existing && input.onlyIfExisting) return undefined;
  const id = existing?.id ?? createAccountId();
  const stored: MobileSession = { ...session, hostUrl, accountId };
  await writeCredential(
    input.nativeBridge,
    mobileAccountSessionStorageKey(input.adapter, id),
    JSON.stringify(stored),
  );
  const label =
    boundedText(session.accountLabel, MAX_LABEL_LENGTH) ?? existing?.label;
  const row: MobileAccountSummary = {
    id,
    hostUrl,
    product: input.adapter.product,
    ...(accountId ? { accountId } : {}),
    ...(label ? { label } : {}),
    lastUsedAt: (input.now?.() ?? new Date()).toISOString(),
  };
  const activate = input.activate ?? true;
  const activeId =
    activate === true || (activate === "if-none" && !list.activeId)
      ? id
      : list.activeId;
  let accounts = [row, ...list.accounts.filter((account) => account.id !== id)];
  if (accounts.length > ACCOUNT_LIMIT) {
    // Keep the most recently used rows and always the active one.
    const keep = accounts.slice(0, ACCOUNT_LIMIT);
    const active = accounts.find((account) => account.id === activeId);
    if (active && !keep.includes(active)) keep[keep.length - 1] = active;
    for (const account of accounts) {
      if (keep.includes(account)) continue;
      await deleteCredentialFromStores(
        input.nativeBridge,
        mobileAccountSessionStorageKey(input.adapter, account.id),
      );
    }
    accounts = keep;
  }
  await writeAccountList(input, { activeId, accounts });
  return row;
}

async function loadAccountSessionLocked(
  input: MobileAccountStoreInput,
  list: MobileAccountList,
  accountId: string,
): Promise<MobileSession | undefined> {
  const row = list.accounts.find((account) => account.id === accountId);
  if (!row) return undefined;
  const key = mobileAccountSessionStorageKey(input.adapter, row.id);
  const raw = await mobileCredentialStore(input.nativeBridge).get(key);
  if (!raw) {
    // The credential store lost the slot (reinstall, keystore reset): drop the
    // row instead of showing an account that can no longer sign requests.
    await removeAccountLocked(input, list, row.id);
    return undefined;
  }
  let session: MobileSession;
  try {
    session = parseStoredMobileSession(raw, input.adapter.product);
  } catch (error) {
    await removeAccountLocked(input, list, row.id);
    throw error;
  }
  if (mobileAccountIdentity(session) !== mobileAccountIdentity(row)) {
    await removeAccountLocked(input, list, row.id);
    throw new Error("Stored mobile session does not belong to its account.");
  }
  return session;
}

async function removeAccountLocked(
  input: MobileAccountStoreInput,
  list: MobileAccountList,
  accountId: string,
): Promise<MobileAccountList> {
  await deleteCredentialFromStores(
    input.nativeBridge,
    mobileAccountSessionStorageKey(input.adapter, accountId),
  );
  const next: MobileAccountList = {
    ...(list.activeId && list.activeId !== accountId
      ? { activeId: list.activeId }
      : {}),
    accounts: list.accounts.filter((account) => account.id !== accountId),
  };
  await writeAccountList(input, next);
  return next;
}

/**
 * Moves the pre-multi-account session (one key per product) into the list as
 * its first, active row. Runs before every account read so the session a
 * product app already had keeps working after the update.
 */
async function migrateLegacySessionLocked(
  input: MobileAccountStoreInput,
  options: { readonly discardInvalid?: boolean } = {},
): Promise<void> {
  const key = mobileSessionStorageKey(input.adapter);
  const { raw } = await readCredential(input.nativeBridge, key);
  if (!raw) return;
  let session: MobileSession;
  try {
    session = parseStoredMobileSession(raw, input.adapter.product);
  } catch (error) {
    await deleteCredentialFromStores(input.nativeBridge, key);
    if (options.discardInvalid) return;
    throw error;
  }
  const migrated = withIdTokenAccount(session);
  await saveAccountSessionLocked({
    ...input,
    session: migrated,
    activate: true,
  });
  await deleteCredentialFromStores(input.nativeBridge, key);
}

// --- list persistence -----------------------------------------------------------

const volatileAccountLists = new WeakMap<NativeBridge, Map<string, string>>();

function accountListStore(
  nativeBridge: NativeBridge,
): Pick<MobilePersistentStore, "get" | "set" | "delete"> {
  if (nativeBridge.storage) return nativeBridge.storage;
  let values = volatileAccountLists.get(nativeBridge);
  if (!values) {
    values = new Map();
    volatileAccountLists.set(nativeBridge, values);
  }
  const map = values;
  return {
    async get(key) {
      return map.get(key);
    },
    async set(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

async function readAccountList(
  input: MobileAccountStoreInput,
): Promise<MobileAccountList> {
  const raw = await accountListStore(input.nativeBridge).get(
    mobileAccountListStorageKey(input.adapter),
  );
  if (!raw) return { accounts: [] };
  try {
    return normalizeAccountList(JSON.parse(raw), input.adapter);
  } catch {
    return { accounts: [] };
  }
}

async function writeAccountList(
  input: MobileAccountStoreInput,
  list: MobileAccountList,
): Promise<void> {
  const store = accountListStore(input.nativeBridge);
  const key = mobileAccountListStorageKey(input.adapter);
  if (list.accounts.length === 0) {
    await store.delete(key);
    return;
  }
  await store.set(
    key,
    JSON.stringify({
      version: ACCOUNT_LIST_VERSION,
      ...(list.activeId ? { activeId: list.activeId } : {}),
      accounts: list.accounts,
    }),
  );
}

function normalizeAccountList(
  value: unknown,
  adapter: MobileProductAdapter,
): MobileAccountList {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { accounts: [] };
  }
  const record = value as Record<string, unknown>;
  if (record.version !== ACCOUNT_LIST_VERSION || !Array.isArray(record.accounts)) {
    return { accounts: [] };
  }
  const seenIds = new Set<string>();
  const seenIdentities = new Set<string>();
  const accounts: MobileAccountSummary[] = [];
  for (const entry of record.accounts) {
    const row = normalizeAccountRow(entry, adapter);
    if (!row) continue;
    const identity = mobileAccountIdentity(row);
    if (seenIds.has(row.id) || seenIdentities.has(identity)) continue;
    seenIds.add(row.id);
    seenIdentities.add(identity);
    accounts.push(row);
  }
  accounts.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
  const activeId =
    typeof record.activeId === "string" && seenIds.has(record.activeId)
      ? record.activeId
      : undefined;
  return {
    ...(activeId ? { activeId } : {}),
    accounts: accounts.slice(0, ACCOUNT_LIMIT),
  };
}

function normalizeAccountRow(
  value: unknown,
  adapter: MobileProductAdapter,
): MobileAccountSummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !ACCOUNT_ID_PATTERN.test(row.id)) {
    return undefined;
  }
  if (row.product !== adapter.product || typeof row.hostUrl !== "string") {
    return undefined;
  }
  if (typeof row.lastUsedAt !== "string" || !Number.isFinite(Date.parse(row.lastUsedAt))) {
    return undefined;
  }
  let hostUrl: string;
  try {
    hostUrl = normalizeHostUrl(row.hostUrl);
  } catch {
    return undefined;
  }
  const accountId = boundedText(row.accountId, MAX_ACCOUNT_SUBJECT_LENGTH);
  const label = boundedText(row.label, MAX_LABEL_LENGTH);
  return {
    id: row.id,
    hostUrl,
    product: adapter.product,
    ...(accountId ? { accountId } : {}),
    ...(label ? { label } : {}),
    lastUsedAt: row.lastUsedAt,
  };
}

// --- session parsing ---------------------------------------------------------------

export function parseStoredMobileSession(
  raw: string,
  expectedProduct: MobileProductAdapter["product"],
): MobileSession {
  const parsed = JSON.parse(raw) as Partial<MobileSession>;
  if (
    typeof parsed.hostUrl !== "string" ||
    !isMobileProductKind(parsed.product) ||
    (parsed.oidcIssuer !== undefined && typeof parsed.oidcIssuer !== "string") ||
    (parsed.oidcClientId !== undefined &&
      typeof parsed.oidcClientId !== "string") ||
    (parsed.apiBaseUrl !== undefined && typeof parsed.apiBaseUrl !== "string") ||
    (parsed.accountId !== undefined && typeof parsed.accountId !== "string") ||
    (parsed.accountLabel !== undefined &&
      typeof parsed.accountLabel !== "string") ||
    !isOptionalStringRecord(parsed.productEndpoints) ||
    typeof parsed.accessToken !== "string" ||
    typeof parsed.tokenType !== "string" ||
    typeof parsed.createdAt !== "string"
  ) {
    throw new Error("Stored mobile session is invalid.");
  }
  if (parsed.product !== expectedProduct) {
    throw new Error("Mobile session product does not match this app.");
  }
  const apiBaseUrl = parsed.apiBaseUrl
    ? sameOriginApiBaseUrl(parsed.apiBaseUrl, parsed.hostUrl)
    : undefined;
  const session: MobileSession = {
    ...(parsed as MobileSession),
    productEndpoints: normalizeStringRecord(parsed.productEndpoints),
  };
  if (apiBaseUrl) return { ...session, apiBaseUrl };
  const { apiBaseUrl: _dropped, ...withoutApiBase } = session;
  return withoutApiBase;
}

/**
 * Returns the API root if it is on the host's own origin (https, or http on a
 * loopback development host), else undefined. A host's token is only ever
 * sent to that host.
 */
export function sameOriginApiBaseUrl(
  value: unknown,
  hostUrl: string,
): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = requireSecureWebUrl(value.trim(), "API base URL");
    if (url.search || url.hash) return undefined;
    if (url.origin !== normalizeHostUrl(hostUrl)) return undefined;
    return url.toString().replace(/\/+$/u, "");
  } catch {
    return undefined;
  }
}

// --- ID token identity -------------------------------------------------------------

export interface MobileIdTokenAccount {
  readonly accountId: string;
  readonly accountLabel?: string;
}

/**
 * Reads the account subject from an ID token received directly from the
 * issuer's token endpoint over TLS (OIDC Core 3.1.3.7 permits TLS server
 * validation in place of a signature check for this flow). The claims are
 * used only to key and label the saved session, and only when `iss` and `aud`
 * name the issuer and client of this sign-in.
 */
export function readIdTokenAccount(input: {
  readonly idToken: string | undefined;
  readonly issuer: string | undefined;
  readonly clientId: string | undefined;
}): MobileIdTokenAccount | undefined {
  if (!input.idToken || !input.issuer || !input.clientId) return undefined;
  const claims = decodeJwtPayload(input.idToken);
  if (!claims) return undefined;
  let issuer: string;
  try {
    issuer = normalizeHostUrl(String(claims.iss ?? ""));
    if (issuer !== normalizeHostUrl(input.issuer)) return undefined;
  } catch {
    return undefined;
  }
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(input.clientId)) return undefined;
  const accountId = boundedText(claims.sub, MAX_ACCOUNT_SUBJECT_LENGTH);
  if (!accountId) return undefined;
  const accountLabel = boundedText(
    claims.email ?? claims.preferred_username ?? claims.name,
    MAX_LABEL_LENGTH,
  );
  return { accountId, ...(accountLabel ? { accountLabel } : {}) };
}

function withIdTokenAccount(session: MobileSession): MobileSession {
  if (session.accountId) return session;
  const account = readIdTokenAccount({
    idToken: session.idToken,
    issuer: session.oidcIssuer,
    clientId: session.oidcClientId,
  });
  return account ? { ...session, ...account } : session;
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

// --- small helpers -----------------------------------------------------------------

const accountLocks = new WeakMap<NativeBridge, Promise<unknown>>();

async function withAccountLock<T>(
  nativeBridge: NativeBridge,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = accountLocks.get(nativeBridge) ?? Promise.resolve();
  const next = previous.then(operation, operation);
  accountLocks.set(
    nativeBridge,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return await next;
}

function createAccountId(): string {
  const bytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/u.test(text)) {
    return undefined;
  }
  return text;
}

function isOptionalStringRecord(value: unknown): boolean {
  return (
    value == null ||
    (typeof value === "object" &&
      !Array.isArray(value) &&
      Object.values(value as Record<string, unknown>).every(
        (entry) => typeof entry === "string",
      ))
  );
}

function normalizeStringRecord(
  value: unknown,
): MobileSession["productEndpoints"] {
  if (value == null || !isOptionalStringRecord(value)) return undefined;
  const endpoints: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, string>)) {
    const trimmed = entry.trim();
    if (trimmed) endpoints[key] = trimmed;
  }
  return Object.keys(endpoints).length > 0 ? endpoints : undefined;
}
