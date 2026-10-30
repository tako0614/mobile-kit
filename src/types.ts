import type {
  MobileHostableProductKind as ContractMobileHostableProductKind,
  MobileProductKind as ContractMobileProductKind,
  MobileProductWellKnown as ContractMobileProductWellKnown,
  MobileProductWellKnownEndpoints,
  MobilePushClientRegistration,
  MobilePushProvider as ContractMobilePushProvider,
} from "./contract/mobile.ts";
import type {
  HostCapabilitiesDocument,
  TakosumiWellKnownDocument,
} from "./contract/mobile-discovery.ts";
import type { MobileWireViolation } from "./conformance.ts";

export type MobileHostableProductKind = ContractMobileHostableProductKind;
export type MobileProductKind = ContractMobileProductKind;
export type MobilePushProvider = ContractMobilePushProvider;

export type ProductWellKnown = ContractMobileProductWellKnown;
export type ProductWellKnownEndpoints = MobileProductWellKnownEndpoints;

export interface MobileHostCenterSource {
  readonly source?: string;
  readonly git?: string;
  readonly ref?: string;
  readonly path?: string;
  readonly name?: string;
}

export interface MobileProductAdapter {
  readonly product: MobileProductKind;
  /** Product well-known document to discover when multiple clients share one host. */
  readonly discoveryProduct?: MobileProductKind;
  readonly appName: string;
  readonly hostNoun: string;
  readonly hostCenterLabel?: string;
  /**
   * Explicit operator dashboard install endpoint. The shared mobile kit never
   * assumes the official Takosumi Hosted deployment.
   */
  readonly hostCenterUrl?: string;
  readonly hostCenterProduct?: MobileHostableProductKind;
  readonly hostCenterSource?: MobileHostCenterSource;
  /** Optional product-owned direct deployment path outside Host Center. */
  readonly directDeployLabel?: string;
  readonly directDeployUrl?: string;
  readonly directDeployDescription?: string;
  readonly strictDiscoveryProduct?: boolean;
  readonly acceptAnyConnectProduct?: boolean;
  readonly acceptedConnectProducts?: readonly MobileProductKind[];
  readonly urlPlaceholder: string;
  readonly primaryActionLabel: string;
  readonly accentColor: string;
  readonly mobileScheme: string;
  /** Explicit OAuth/OIDC scopes required by this product shell. */
  readonly oidcScopes?: readonly string[];
  /**
   * The issuer's tokens are API credentials for the host itself (for example
   * a Takosumi instance). Sign-in then starts only when the issuer is the host
   * (same origin) or the issuer's own `/.well-known/takosumi` names the host as
   * its API, so a host cannot point at another instance's issuer and receive
   * that instance's tokens. The sign-in callback must then also carry the
   * RFC 9207 `iss` parameter naming that issuer.
   */
  readonly requireHostIssuer?: boolean;
  readonly requiredHostCapabilities?: readonly string[];
}

export interface MobileConnectPayload {
  readonly hostUrl: string;
  readonly product?: MobileProductKind;
  readonly setupTicket?: string;
}

export interface MobileRoutePayload {
  readonly path: string;
  readonly hostUrl?: string;
  readonly product?: MobileProductKind;
}

export interface MobileKnownHost {
  readonly hostUrl: string;
  readonly product: MobileProductKind;
  readonly oidcIssuer?: string;
  readonly lastSeenAt: string;
  readonly label?: string;
}

// Host document shapes live in the wire contract next to the decoders that
// accept them; these aliases keep the historical mobile-kit names.
export type TakosumiWellKnown = TakosumiWellKnownDocument;

export type HostCapabilities = HostCapabilitiesDocument;

export interface HostDiscovery {
  readonly hostUrl: string;
  readonly expectedProduct?: MobileProductKind;
  readonly detectedProduct?: MobileProductKind;
  readonly takosumi?: TakosumiWellKnown;
  readonly capabilities?: HostCapabilities;
  readonly product?: ProductWellKnown;
  readonly oidcIssuer?: string;
  readonly oidcClientId?: string;
  readonly oidcDiscoveryUrl?: string;
  /**
   * Host-advertised API root (`apiBaseUrl`), accepted only on the host's own
   * origin so a discovery document cannot route the host's token elsewhere.
   */
  readonly apiBaseUrl?: string;
  readonly authMethods?: {
    readonly oidc: boolean;
    readonly password: boolean;
  };
  /**
   * Wire requirements this host violates. Connect blockers never reach here
   * (discovery throws), so these are the sign-in blockers a shell must report
   * against the producing document rather than as a client error.
   */
  readonly wireViolations?: readonly MobileWireViolation[];
}

export interface OidcMetadata {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint?: string;
  readonly revocation_endpoint?: string;
  readonly introspection_endpoint?: string;
  readonly [key: string]: unknown;
}

export interface PkcePair {
  readonly codeVerifier: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: "S256";
}

export interface OidcAuthorizationUrlInput {
  readonly metadata: OidcMetadata;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge: string;
  readonly scope?: string;
}

export interface OidcCallbackResult {
  readonly code: string;
  readonly state: string;
}

export interface OidcTokenExchangeInput {
  readonly metadata: OidcMetadata;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly code: string;
  readonly codeVerifier: string;
  readonly fetch?: FetchLike;
}

export interface OidcTokenResponse {
  readonly access_token: string;
  readonly token_type: string;
  readonly expires_in?: number;
  readonly refresh_token?: string;
  readonly id_token?: string;
  readonly scope?: string;
  readonly [key: string]: unknown;
}

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface NativeBridgeCapabilities {
  readonly launchPayload: boolean;
  readonly launchPayloadEvents: boolean;
  readonly externalBrowser: boolean;
  readonly inAppBrowser: boolean;
  readonly qrScanner: boolean;
  readonly localNotifications: boolean;
  readonly pushNotifications: boolean;
  readonly biometricAuth: boolean;
  readonly callIntent: boolean;
  readonly clipboardText: boolean;
  readonly secureStorage: boolean;
  readonly persistentStorage: boolean;
}

interface MobileKeyValueStoreOperations {
  readonly get: (key: string) => Promise<string | undefined>;
  readonly set: (key: string, value: string) => Promise<void>;
  readonly delete: (key: string) => Promise<void>;
}

/** Non-credential persistence for preferences and recent-host metadata. */
export type MobilePersistentStore = MobileKeyValueStoreOperations & {
  readonly kind: "device-persistent" | "browser-local";
};

/**
 * Credential-capable persistent storage.
 *
 * `NativeBridge.secureStore` must never be backed by browser localStorage or a
 * plain device preference store. Keeping the discriminator exact makes that
 * boundary compile-time visible to every bridge implementation.
 */
export type MobileSecureStore = MobileKeyValueStoreOperations & {
  readonly kind: "secure";
};

/** A store accepted by APIs that deliberately support either storage class. */
export type MobileKeyValueStore = MobilePersistentStore | MobileSecureStore;

export interface MobileAuthRequest {
  readonly hostUrl: string;
  readonly product: MobileProductKind;
  readonly oidcIssuer: string;
  readonly oidcClientId: string;
  readonly apiBaseUrl?: string;
  readonly productEndpoints?: ProductWellKnownEndpoints;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeVerifier: string;
  readonly createdAt: string;
}

export interface MobileSession {
  readonly hostUrl: string;
  readonly product: MobileProductKind;
  readonly oidcIssuer?: string;
  readonly oidcClientId?: string;
  /** Same-origin API root the host advertised when this session was created. */
  readonly apiBaseUrl?: string;
  /**
   * Account subject (`sub`) from the ID token, when the sign-in returned one
   * for this exact issuer and client. Sessions are kept per (host, account).
   */
  readonly accountId?: string;
  /** Display label for the account (email or name claim); never a credential. */
  readonly accountLabel?: string;
  readonly productEndpoints?: ProductWellKnownEndpoints;
  readonly accessToken: string;
  readonly tokenType: string;
  readonly refreshToken?: string;
  readonly idToken?: string;
  readonly scope?: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
}

/**
 * Non-secret row describing one saved (host, account) session. The tokens live
 * only in the credential store under the row's opaque `id`.
 */
export interface MobileAccountSummary {
  readonly id: string;
  readonly hostUrl: string;
  readonly product: MobileProductKind;
  readonly accountId?: string;
  readonly label?: string;
  readonly lastUsedAt: string;
}

export interface MobileAccountList {
  readonly activeId?: string;
  /** Most recently used first. */
  readonly accounts: readonly MobileAccountSummary[];
}

export interface MobilePushRegistrationInput {
  readonly hostUrl: string;
  readonly product: MobileProductKind;
  readonly accountId?: string;
}

export type MobilePushRegistration = MobilePushClientRegistration;

export interface MobilePushNotification {
  readonly title?: string;
  readonly body?: string;
  readonly data: Record<string, unknown>;
  readonly badge?: number;
  readonly sound?: string;
}

export type MobilePushNotificationEventKind = "received" | "tapped";

export interface MobileCallIntent {
  readonly roomUrl: string;
  readonly title?: string;
}

export interface MobileClipboardText {
  readonly text: string;
  readonly label?: string;
}

export interface MobileLocalNotification {
  readonly title: string;
  readonly body?: string;
}

export interface MobileBiometricPrompt {
  readonly message: string;
  readonly allowDeviceCredential?: boolean;
  readonly cancelTitle?: string;
  readonly fallbackTitle?: string;
  readonly title?: string;
  readonly subtitle?: string;
  readonly confirmationRequired?: boolean;
}

export type MobileSessionUnlockMode = "off" | "if-available" | "required";

export interface MobileSessionUnlockOptions {
  readonly restoreMode?: MobileSessionUnlockMode;
  readonly prompt?:
    MobileBiometricPrompt | ((session: MobileSession) => MobileBiometricPrompt);
}

export interface NativeBridge {
  readonly capabilities: NativeBridgeCapabilities;
  readonly storage?: MobilePersistentStore;
  readonly secureStore?: MobileSecureStore;
  readonly getLaunchPayload: () => Promise<string | undefined>;
  readonly onLaunchPayload?: (
    handler: (payload: string) => void,
  ) => Promise<() => void>;
  readonly openExternalUrl: (url: string) => Promise<void>;
  readonly scanConnectionPayload?: () => Promise<string | undefined>;
  readonly requestLocalNotificationPermission?: () => Promise<boolean>;
  readonly sendLocalNotification?: (
    notification: MobileLocalNotification,
  ) => Promise<void>;
  readonly registerPushNotifications?: (
    input: MobilePushRegistrationInput,
  ) => Promise<MobilePushRegistration | undefined>;
  readonly unregisterPushNotifications?: () => Promise<void>;
  readonly onPushNotificationReceived?: (
    handler: (notification: MobilePushNotification) => void,
  ) => Promise<() => void>;
  readonly onPushNotificationTapped?: (
    handler: (notification: MobilePushNotification) => void,
  ) => Promise<() => void>;
  readonly onPushTokenRefresh?: (
    input: MobilePushRegistrationInput,
    handler: (registration: MobilePushRegistration) => void,
  ) => Promise<() => void>;
  readonly authenticateBiometric?: (
    prompt: MobileBiometricPrompt,
  ) => Promise<boolean>;
  readonly requestCall?: (input: MobileCallIntent) => Promise<void>;
  readonly writeClipboardText?: (input: MobileClipboardText) => Promise<void>;
}
