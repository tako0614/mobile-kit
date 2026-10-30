import type {
  FetchLike,
  HostDiscovery,
  MobileAuthRequest,
  MobileProductAdapter,
  MobileSession,
  NativeBridge,
  OidcTokenResponse,
} from "./types.ts";
import { createMobileReturnUri } from "./shell.ts";
import {
  createOidcAuthorizationUrl,
  createPkcePair,
  createRandomState,
  decodeOidcTokenResponse,
  exchangeOidcCode,
  fetchOidcMetadata,
  parseOidcCallback,
} from "./oidc.ts";
import {
  mobileWireBlocker,
  mobileWireRequirementSummary,
} from "./conformance.ts";
import { requireMobileProductKey } from "./product-key.ts";
import {
  deleteCredentialFromStores,
  readCredential,
  writeCredential,
} from "./credential-store.ts";
import {
  loadActiveMobileAccountSession,
  mobileSessionStorageKey,
  readIdTokenAccount,
  removeActiveMobileAccountSession,
  removeMobileAccountSessionFor,
  sameOriginApiBaseUrl,
  saveMobileAccountSession,
} from "./accounts.ts";
import { requireSecureWebUrl } from "./url.ts";

export { mobileSessionStorageKey };

const MOBILE_AUTH_REQUEST_TTL_MS = 10 * 60 * 1000;

export interface BeginMobileOidcSignInInput {
  readonly adapter: MobileProductAdapter;
  readonly discovery: HostDiscovery;
  readonly nativeBridge: NativeBridge;
  readonly redirectPath?: string;
  readonly scope?: string;
  readonly fetch?: FetchLike;
  readonly crypto?: Crypto;
  readonly now?: () => Date;
}

export interface BeginMobileOidcSignInResult {
  readonly authorizationUrl: string;
  readonly request: MobileAuthRequest;
}

export interface CompleteMobileOidcSignInInput {
  readonly adapter: MobileProductAdapter;
  readonly nativeBridge: NativeBridge;
  readonly callbackUrl: string;
  /**
   * Persist the exchanged session before returning it. Defaults to true for
   * backward compatibility. Controllers that need to reject stale async
   * completions can set this to false and call persistMobileSession only after
   * their generation check succeeds.
   */
  readonly persistSession?: boolean;
  readonly fetch?: FetchLike;
  readonly now?: () => Date;
}

export interface PersistMobileSessionInput {
  readonly adapter: MobileProductAdapter;
  readonly nativeBridge: NativeBridge;
  readonly session: MobileSession;
}

export interface SignInWithMobilePasswordInput {
  readonly adapter: MobileProductAdapter;
  readonly discovery: HostDiscovery;
  readonly nativeBridge: NativeBridge;
  readonly password: string;
  readonly persistSession?: boolean;
  readonly fetch?: FetchLike;
  readonly now?: () => Date;
}

export interface RefreshMobileSessionInput {
  readonly adapter: MobileProductAdapter;
  readonly nativeBridge: NativeBridge;
  readonly session: MobileSession;
  /**
   * Persist the refreshed session before returning it. Defaults to true.
   * Lifecycle-aware controllers can disable this and commit only after their
   * generation check succeeds.
   */
  readonly persistSession?: boolean;
  readonly fetch?: FetchLike;
  readonly now?: () => Date;
}

export interface EnsureFreshMobileSessionInput extends RefreshMobileSessionInput {
  readonly expiresSkewMs?: number;
}

export interface RevokeMobileHostSessionInput {
  readonly session: MobileSession;
  readonly fetch?: FetchLike;
}

export function mobileAuthRequestStorageKey(
  adapter: MobileProductAdapter,
): string {
  return `takosumi.mobile.${requireMobileProductKey(adapter.product)}.auth.pending`;
}

export async function beginMobileOidcSignIn(
  input: BeginMobileOidcSignInInput,
): Promise<BeginMobileOidcSignInResult> {
  const oidcClientId = mobileClientId(input.discovery);
  const oidcIssuer = requireDiscoveryOidcIssuer(input.discovery);
  const metadata = await fetchOidcMetadata({
    issuer: oidcIssuer,
    fetch: input.fetch,
  });
  const pkce = await createPkcePair(input.crypto);
  const state = createRandomState(input.crypto);
  const redirectUri = createMobileReturnUri(
    input.adapter,
    input.redirectPath ?? "oauth/callback",
  );
  const apiBaseUrl = sameOriginApiBaseUrl(
    input.discovery.apiBaseUrl,
    input.discovery.hostUrl,
  );
  const request: MobileAuthRequest = {
    hostUrl: input.discovery.hostUrl,
    product: input.adapter.product,
    oidcIssuer,
    oidcClientId,
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
    productEndpoints: normalizeProductEndpoints(
      input.discovery.product?.endpoints,
    ),
    redirectUri,
    state,
    codeVerifier: pkce.codeVerifier,
    createdAt: (input.now?.() ?? new Date()).toISOString(),
  };

  await writeCredential(
    input.nativeBridge,
    mobileAuthRequestStorageKey(input.adapter),
    stringify(request),
  );

  return {
    request,
    authorizationUrl: createOidcAuthorizationUrl({
      metadata,
      clientId: oidcClientId,
      redirectUri,
      state,
      codeChallenge: pkce.codeChallenge,
      scope: input.scope,
    }),
  };
}

export async function completeMobileOidcSignIn(
  input: CompleteMobileOidcSignInInput,
): Promise<MobileSession> {
  const request = await loadMobileAuthRequest(
    input.adapter,
    input.nativeBridge,
    input.now,
  );
  if (!request) throw new Error("No pending mobile sign-in request.");

  const callback = parseOidcCallback(
    input.callbackUrl,
    request.state,
    request.redirectUri,
  );
  const metadata = await fetchOidcMetadata({
    issuer: request.oidcIssuer,
    fetch: input.fetch,
  });
  const token = await exchangeOidcCode({
    metadata,
    clientId: request.oidcClientId,
    redirectUri: request.redirectUri,
    code: callback.code,
    codeVerifier: request.codeVerifier,
    fetch: input.fetch,
  });
  let session = createMobileSession({
    request,
    token,
    now: input.now,
  });
  const exchangePath = request.productEndpoints?.mobileOidcExchange?.trim();
  if (exchangePath) {
    if (!token.id_token) {
      throw new Error("OIDC provider did not return an ID token.");
    }
    session = await exchangeHostSession({
      hostUrl: request.hostUrl,
      product: request.product,
      oidcIssuer: request.oidcIssuer,
      oidcClientId: request.oidcClientId,
      apiBaseUrl: request.apiBaseUrl,
      account: readIdTokenAccount({
        idToken: token.id_token,
        issuer: request.oidcIssuer,
        clientId: request.oidcClientId,
      }),
      productEndpoints: request.productEndpoints,
      path: exchangePath,
      body: { id_token: token.id_token },
      fetch: input.fetch,
      now: input.now,
    });
  }

  if (input.persistSession !== false) {
    await storeMobileSession(input.adapter, input.nativeBridge, session);
  }
  await deleteCredentialFromStores(
    input.nativeBridge,
    mobileAuthRequestStorageKey(input.adapter),
  );
  return session;
}

export async function signInWithMobilePassword(
  input: SignInWithMobilePasswordInput,
): Promise<MobileSession> {
  const password = input.password;
  if (password.length === 0) throw new Error("Password is required.");
  const path = input.discovery.product?.endpoints?.mobilePasswordLogin?.trim();
  if (!path) throw new Error("Host does not advertise native password login.");
  const session = await exchangeHostSession({
    hostUrl: input.discovery.hostUrl,
    product: input.adapter.product,
    oidcIssuer: input.discovery.oidcIssuer,
    oidcClientId: input.discovery.oidcClientId,
    productEndpoints: normalizeProductEndpoints(
      input.discovery.product?.endpoints,
    ),
    path,
    body: { password },
    fetch: input.fetch,
    now: input.now,
  });
  if (input.persistSession !== false) {
    await storeMobileSession(input.adapter, input.nativeBridge, session);
  }
  return session;
}

/**
 * Revoke a host-owned bearer session when the connected product advertises a
 * logout endpoint. Provider access tokens are deliberately not sent to an
 * unadvertised endpoint.
 */
export async function revokeMobileHostSession(
  input: RevokeMobileHostSessionInput,
): Promise<boolean> {
  const path = input.session.productEndpoints?.mobileLogout?.trim();
  if (!path) return false;
  const fetcher = input.fetch ?? globalThis.fetch.bind(globalThis);
  const response = await fetcher(
    hostSessionEndpoint(input.session.hostUrl, path),
    {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `${input.session.tokenType} ${input.session.accessToken}`,
      },
    },
  );
  if (!response.ok) {
    throw new Error(`Host sign-out failed: ${response.status}`);
  }
  return true;
}

export interface RevokeMobileOidcSessionInput {
  readonly session: MobileSession;
  readonly fetch?: FetchLike;
}

/**
 * Revoke the tokens of a session the issuer minted directly for this app
 * (RFC 7009), at the revocation endpoint the session's own issuer advertises.
 * Sessions exchanged for a host session are revoked by the host instead, and
 * tokens are never sent to an endpoint outside the issuer's origin. Returns
 * whether a revocation request was accepted.
 */
export async function revokeMobileOidcSession(
  input: RevokeMobileOidcSessionInput,
): Promise<boolean> {
  const session = input.session;
  if (session.productEndpoints?.mobileOidcExchange?.trim()) return false;
  if (!session.oidcIssuer || !session.oidcClientId) return false;
  const metadata = await fetchOidcMetadata({
    issuer: session.oidcIssuer,
    fetch: input.fetch,
  });
  const endpoint = metadata.revocation_endpoint;
  if (typeof endpoint !== "string" || !endpoint.trim()) return false;
  const revocationUrl = requireSecureWebUrl(
    endpoint.trim(),
    "OIDC revocation endpoint",
  );
  if (revocationUrl.origin !== new URL(metadata.issuer).origin) {
    throw new Error("OIDC revocation endpoint must stay on the issuer.");
  }
  const fetcher = input.fetch ?? globalThis.fetch.bind(globalThis);
  const tokens: Array<readonly [string, string]> = [];
  if (session.refreshToken) {
    tokens.push([session.refreshToken, "refresh_token"]);
  }
  tokens.push([session.accessToken, "access_token"]);
  let accepted = false;
  for (const [token, hint] of tokens) {
    const response = await fetcher(revocationUrl.toString(), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        token,
        token_type_hint: hint,
        client_id: session.oidcClientId,
      }),
    });
    if (response.ok) accepted = true;
  }
  return accepted;
}

export async function persistMobileSession(
  input: PersistMobileSessionInput,
): Promise<void> {
  await storeMobileSession(input.adapter, input.nativeBridge, input.session);
}

export async function ensureFreshMobileSession(
  input: EnsureFreshMobileSessionInput,
): Promise<MobileSession> {
  if (
    !mobileSessionNeedsRefresh(input.session, input.now, input.expiresSkewMs)
  ) {
    return input.session;
  }
  return await refreshMobileSession(input);
}

export async function refreshMobileSession(
  input: RefreshMobileSessionInput,
): Promise<MobileSession> {
  requireSessionProduct(input.adapter, input.session);
  if (!input.session.refreshToken) {
    throw new Error("Mobile session has no refresh token.");
  }
  if (!input.session.oidcIssuer) {
    throw new Error("Mobile session has no OIDC issuer.");
  }
  const oidcClientId = requireSessionMobileClientId(input.session);
  const metadata = await fetchOidcMetadata({
    issuer: input.session.oidcIssuer,
    fetch: input.fetch,
  });
  if (!metadata.token_endpoint) {
    throw new Error("OIDC issuer does not advertise a token endpoint.");
  }

  const fetcher = input.fetch ?? globalThis.fetch.bind(globalThis);
  const response = await fetcher(metadata.token_endpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: oidcClientId,
      refresh_token: input.session.refreshToken,
    }),
  });
  if (!response.ok) {
    if (input.persistSession !== false) {
      await removeMobileAccountSessionFor({
        adapter: input.adapter,
        nativeBridge: input.nativeBridge,
        session: input.session,
      });
    }
    throw new Error(`Mobile session refresh failed: ${response.status}`);
  }
  const token = decodeOidcTokenResponse(
    await response.json(),
    metadata.token_endpoint,
  );
  const session = createMobileSessionFromRefresh({
    session: input.session,
    token,
    now: input.now,
  });
  if (input.persistSession !== false) {
    // A rotation keeps the account it belongs to; it becomes the active one
    // only when no account is active, never by displacing another.
    await saveMobileAccountSession({
      adapter: input.adapter,
      nativeBridge: input.nativeBridge,
      session,
      activate: "if-none",
    });
  }
  return session;
}

export async function loadMobileSession(input: {
  readonly adapter: MobileProductAdapter;
  readonly nativeBridge: NativeBridge;
}): Promise<MobileSession | undefined> {
  return await loadActiveMobileAccountSession(input);
}

/** Removes the active session; other saved accounts stay. */
export async function clearMobileSession(input: {
  readonly adapter: MobileProductAdapter;
  readonly nativeBridge: NativeBridge;
}): Promise<void> {
  await removeActiveMobileAccountSession(input);
}

/** Removes the active session and any pending sign-in request. */
export async function clearMobileCredentials(input: {
  readonly adapter: MobileProductAdapter;
  readonly nativeBridge: NativeBridge;
}): Promise<void> {
  await Promise.all([
    removeActiveMobileAccountSession(input),
    deleteCredentialFromStores(
      input.nativeBridge,
      mobileAuthRequestStorageKey(input.adapter),
    ),
  ]);
}

export function isOidcCallbackPayload(payload: string): boolean {
  try {
    const url = new URL(payload);
    return url.searchParams.has("code") || url.searchParams.has("error");
  } catch {
    return false;
  }
}

function createMobileSession(input: {
  readonly request: MobileAuthRequest;
  readonly token: OidcTokenResponse;
  readonly now?: () => Date;
}): MobileSession {
  const createdAtDate = input.now?.() ?? new Date();
  const createdAt = createdAtDate.toISOString();
  const account = readIdTokenAccount({
    idToken: input.token.id_token,
    issuer: input.request.oidcIssuer,
    clientId: input.request.oidcClientId,
  });
  return {
    hostUrl: input.request.hostUrl,
    product: input.request.product,
    oidcIssuer: input.request.oidcIssuer,
    oidcClientId: input.request.oidcClientId,
    ...(input.request.apiBaseUrl
      ? { apiBaseUrl: input.request.apiBaseUrl }
      : {}),
    ...(account ?? {}),
    productEndpoints: input.request.productEndpoints,
    accessToken: input.token.access_token,
    tokenType: input.token.token_type,
    refreshToken: input.token.refresh_token,
    idToken: input.token.id_token,
    scope: input.token.scope,
    createdAt,
    expiresAt:
      typeof input.token.expires_in === "number"
        ? new Date(
            createdAtDate.getTime() + input.token.expires_in * 1000,
          ).toISOString()
        : undefined,
  };
}

function createMobileSessionFromRefresh(input: {
  readonly session: MobileSession;
  readonly token: OidcTokenResponse;
  readonly now?: () => Date;
}): MobileSession {
  const createdAtDate = input.now?.() ?? new Date();
  const createdAt = createdAtDate.toISOString();
  return {
    hostUrl: input.session.hostUrl,
    product: input.session.product,
    oidcIssuer: input.session.oidcIssuer,
    oidcClientId: input.session.oidcClientId,
    ...(input.session.apiBaseUrl ? { apiBaseUrl: input.session.apiBaseUrl } : {}),
    ...(input.session.accountId ? { accountId: input.session.accountId } : {}),
    ...(input.session.accountLabel
      ? { accountLabel: input.session.accountLabel }
      : {}),
    productEndpoints: input.session.productEndpoints,
    accessToken: input.token.access_token,
    tokenType: input.token.token_type,
    refreshToken: input.token.refresh_token ?? input.session.refreshToken,
    idToken: input.token.id_token ?? input.session.idToken,
    scope: input.token.scope ?? input.session.scope,
    createdAt,
    expiresAt:
      typeof input.token.expires_in === "number"
        ? new Date(
            createdAtDate.getTime() + input.token.expires_in * 1000,
          ).toISOString()
        : undefined,
  };
}

function mobileSessionNeedsRefresh(
  session: MobileSession,
  now: (() => Date) | undefined,
  expiresSkewMs = 60_000,
): boolean {
  if (!session.expiresAt) return false;
  const expiresAtMs = Date.parse(session.expiresAt);
  if (!Number.isFinite(expiresAtMs)) return true;
  return expiresAtMs - (now?.() ?? new Date()).getTime() <= expiresSkewMs;
}

async function loadMobileAuthRequest(
  adapter: MobileProductAdapter,
  nativeBridge: NativeBridge,
  now: (() => Date) | undefined,
): Promise<MobileAuthRequest | undefined> {
  const key = mobileAuthRequestStorageKey(adapter);
  const { raw } = await readCredential(nativeBridge, key);
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as Partial<MobileAuthRequest>;
  if (
    typeof parsed.hostUrl !== "string" ||
    parsed.product !== adapter.product ||
    typeof parsed.oidcIssuer !== "string" ||
    typeof parsed.oidcClientId !== "string" ||
    (parsed.apiBaseUrl !== undefined && typeof parsed.apiBaseUrl !== "string") ||
    !isOptionalProductEndpoints(parsed.productEndpoints) ||
    typeof parsed.redirectUri !== "string" ||
    typeof parsed.state !== "string" ||
    typeof parsed.codeVerifier !== "string" ||
    typeof parsed.createdAt !== "string"
  ) {
    throw new Error("Stored mobile sign-in request is invalid.");
  }
  const createdAtMs = Date.parse(parsed.createdAt);
  if (!Number.isFinite(createdAtMs)) {
    throw new Error("Stored mobile sign-in request is invalid.");
  }
  if (
    (now?.() ?? new Date()).getTime() - createdAtMs >
    MOBILE_AUTH_REQUEST_TTL_MS
  ) {
    await deleteCredentialFromStores(nativeBridge, key);
    throw new Error("Pending mobile sign-in request has expired.");
  }
  return {
    ...(parsed as MobileAuthRequest),
    productEndpoints: normalizeProductEndpoints(parsed.productEndpoints),
  };
}

async function exchangeHostSession(input: {
  readonly hostUrl: string;
  readonly product: MobileSession["product"];
  readonly oidcIssuer?: string;
  readonly oidcClientId?: string;
  readonly apiBaseUrl?: string;
  readonly account?: { readonly accountId: string; readonly accountLabel?: string };
  readonly productEndpoints?: MobileSession["productEndpoints"];
  readonly path: string;
  readonly body: Record<string, string>;
  readonly fetch?: FetchLike;
  readonly now?: () => Date;
}): Promise<MobileSession> {
  const fetcher = input.fetch ?? globalThis.fetch.bind(globalThis);
  const response = await fetcher(
    hostSessionEndpoint(input.hostUrl, input.path),
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(input.body),
    },
  );
  if (!response.ok) {
    throw new Error(`Host sign-in failed: ${response.status}`);
  }
  const token = (await response.json()) as Partial<OidcTokenResponse>;
  if (!token.access_token || !token.token_type) {
    throw new Error("Host returned an invalid mobile session.");
  }
  const now = input.now?.() ?? new Date();
  return {
    hostUrl: input.hostUrl,
    product: input.product,
    oidcIssuer: input.oidcIssuer,
    oidcClientId: input.oidcClientId,
    ...(input.apiBaseUrl ? { apiBaseUrl: input.apiBaseUrl } : {}),
    ...(input.account ?? {}),
    productEndpoints: input.productEndpoints,
    accessToken: token.access_token,
    tokenType: token.token_type,
    createdAt: now.toISOString(),
    expiresAt:
      typeof token.expires_in === "number"
        ? new Date(now.getTime() + token.expires_in * 1000).toISOString()
        : undefined,
  };
}

function hostSessionEndpoint(hostUrl: string, endpoint: string): string {
  const url = new URL(endpoint, `${hostUrl.replace(/\/+$/, "")}/`);
  if (url.origin !== new URL(hostUrl).origin) {
    throw new Error("Mobile auth endpoint must stay on the connected host.");
  }
  return url.toString();
}

function requireDiscoveryOidcIssuer(discovery: HostDiscovery): string {
  const issuer = discovery.oidcIssuer?.trim();
  if (!issuer) throw new Error("Host does not advertise an OIDC issuer.");
  return issuer;
}

function normalizeProductEndpoints(
  value: unknown,
): MobileSession["productEndpoints"] {
  if (value == null) return undefined;
  if (!isProductEndpointsRecord(value)) return undefined;
  const endpoints: Record<string, string> = {};
  for (const [key, endpoint] of Object.entries(value)) {
    const trimmed = endpoint.trim();
    if (trimmed) endpoints[key] = trimmed;
  }
  return Object.keys(endpoints).length > 0 ? endpoints : undefined;
}

function isOptionalProductEndpoints(value: unknown): boolean {
  return value == null || isProductEndpointsRecord(value);
}

function isProductEndpointsRecord(
  value: unknown,
): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((endpoint) => typeof endpoint === "string")
  );
}

function mobileClientId(discovery: HostDiscovery): string {
  const clientId = discovery.oidcClientId?.trim();
  if (clientId) return clientId;
  // Report the wire requirement the producing host violates, so the shell and
  // the producer-side gate name the same defect in the same words.
  throw new Error(
    mobileWireBlocker(
      discovery.wireViolations,
      "oidc-host-advertises-a-mobile-client-id",
    ) ??
      `Host does not advertise a mobile OIDC client id. ${mobileWireRequirementSummary(
        "oidc-host-advertises-a-mobile-client-id",
      )}`,
  );
}

function requireSessionMobileClientId(session: MobileSession): string {
  const clientId = session.oidcClientId?.trim();
  if (!clientId) {
    throw new Error("Mobile session is missing its OIDC client id.");
  }
  return clientId;
}

async function storeMobileSession(
  adapter: MobileProductAdapter,
  nativeBridge: NativeBridge,
  session: MobileSession,
): Promise<void> {
  requireSessionProduct(adapter, session);
  await saveMobileAccountSession({ adapter, nativeBridge, session });
}

function requireSessionProduct(
  adapter: MobileProductAdapter,
  session: MobileSession,
): void {
  if (session.product !== adapter.product) {
    throw new Error("Mobile session product does not match this app.");
  }
}

function stringify(value: unknown): string {
  return JSON.stringify(value);
}
