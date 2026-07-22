import type { FetchLike, MobileSession } from "./types.ts";
import {
  NOTIFICATION_PUSHER_REGISTRATION_PATH,
  parseNotificationPusherDeleteRequest,
  parseNotificationPusherSetRequest,
  type NotificationPusher,
} from "./contract/notification-pushers.ts";
import { hostEndpoint } from "./url.ts";
import { decodeWire, type WireDecoder } from "./wire.ts";

export { NOTIFICATION_PUSHER_REGISTRATION_PATH };

export interface MobileApiClient {
  readonly session: MobileSession;
  readonly json: <T = unknown>(path: string, init?: RequestInit) => Promise<T>;
}

export class MobileApiError extends Error {
  readonly status: number;
  readonly path: string;
  /** Host-supplied explanation, when the failure body carried one. */
  readonly detail: string | null;

  constructor(status: number, path: string, detail: string | null = null) {
    super(
      `Mobile API request failed: ${status} ${path}${detail ? ` - ${detail}` : ""}`,
    );
    this.name = "MobileApiError";
    this.status = status;
    this.path = path;
    this.detail = detail;
  }
}

export interface MobileHostNotificationPusherRegistrationInput {
  readonly session: MobileSession;
  readonly pusher: NotificationPusher;
  readonly scope?: string;
  readonly path?: string;
  readonly fetch?: FetchLike;
}

export interface MobileHostNotificationPusherUnregistrationInput {
  readonly session: MobileSession;
  readonly appId: string;
  readonly pushkey: string;
  readonly scope?: string;
  readonly path?: string;
  readonly fetch?: FetchLike;
}

export function createMobileApiClient(input: {
  readonly session: MobileSession;
  readonly fetch?: FetchLike;
}): MobileApiClient {
  const fetcher = input.fetch ?? globalThis.fetch.bind(globalThis);
  return {
    session: input.session,
    async json<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
      const response = await fetcher(
        hostEndpoint(input.session.hostUrl, path),
        {
          ...init,
          headers: {
            accept: "application/json",
            authorization: `${input.session.tokenType} ${input.session.accessToken}`,
            ...init.headers,
          },
        },
      );
      if (!response.ok) {
        throw new MobileApiError(
          response.status,
          path,
          await readErrorDetail(response),
        );
      }
      return (await response.json()) as T;
    },
  };
}

const MAX_ERROR_DETAIL_BYTES = 1024;

/**
 * Hosts explain rejections in the body (e.g. "pusher.data.url is not allowed by
 * this server"). Without this the shell can only show a bare status code, which
 * is indistinguishable from a network fault.
 */
async function readErrorDetail(response: Response): Promise<string | null> {
  let body: string;
  try {
    body = (await response.text()).slice(0, MAX_ERROR_DETAIL_BYTES);
  } catch {
    return null;
  }
  if (!body.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object") {
      const error = (parsed as { readonly error?: unknown }).error;
      if (typeof error === "string" && error.trim()) return error.trim();
    }
  } catch {
    // Not JSON; fall through to the raw body.
  }
  return body.trim();
}

export async function registerNotificationPusherWithHost(
  input: MobileHostNotificationPusherRegistrationInput,
): Promise<void> {
  const gatewayUrl = await resolveNotificationPusherGatewayUrl({
    session: input.session,
    fallbackGatewayUrl: input.pusher.data.url,
    path: input.path,
    fetch: input.fetch,
  });
  const pusher: NotificationPusher =
    gatewayUrl === input.pusher.data.url
      ? input.pusher
      : { ...input.pusher, data: { ...input.pusher.data, url: gatewayUrl } };
  const parsed = parseNotificationPusherSetRequest(
    {
      product: input.session.product,
      scope: input.scope,
      pusher,
    },
    { product: input.session.product },
  );
  if (!parsed.ok) throw invalidPusherError(parsed.error);

  const client = createMobileApiClient({
    session: input.session,
    fetch: input.fetch,
  });
  await client.json(
    input.path ?? resolveNotificationPusherEndpoint(input.session),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        product: input.session.product,
        ...(parsed.value.scope ? { scope: parsed.value.scope } : {}),
        pusher: parsed.value.pusher,
      }),
    },
  );
}

export async function unregisterNotificationPusherWithHost(
  input: MobileHostNotificationPusherUnregistrationInput,
): Promise<void> {
  const parsed = parseNotificationPusherDeleteRequest(
    {
      product: input.session.product,
      scope: input.scope,
      app_id: input.appId,
      pushkey: input.pushkey,
    },
    { product: input.session.product },
  );
  if (!parsed.ok) throw invalidPusherError(parsed.error);

  const client = createMobileApiClient({
    session: input.session,
    fetch: input.fetch,
  });
  await client.json(
    input.path ?? resolveNotificationPusherEndpoint(input.session),
    {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        product: input.session.product,
        ...(parsed.value.scope ? { scope: parsed.value.scope } : {}),
        app_id: parsed.value.appId,
        pushkey: parsed.value.pushkey,
      }),
    },
  );
}

export function resolveNotificationPusherEndpoint(
  session: Pick<MobileSession, "productEndpoints">,
): string {
  const endpoint = session.productEndpoints?.notificationPushers?.trim();
  return endpoint || NOTIFICATION_PUSHER_REGISTRATION_PATH;
}

export function resolveNotificationPusherConfigEndpoint(
  session: Pick<MobileSession, "productEndpoints">,
): string {
  return `${resolveNotificationPusherEndpoint(session).replace(/\/+$/u, "")}/config`;
}

/** Non-secret runtime push values advertised by the connected host. */
export interface HostNotificationPusherConfig {
  readonly gatewayUrl: string | null;
  readonly webPushPublicKey: string | null;
}

/**
 * The host answer is decoded through a value, not an `as` cast, so a host that
 * renames or retypes a field fails loudly here instead of silently degrading
 * to the shell's build-time gateway URL.
 */
export const HOST_NOTIFICATION_PUSHER_CONFIG_DECODER: WireDecoder<HostNotificationPusherConfig> =
  {
    document: "host notification pusher config",
    decode(value) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("document must be a JSON object");
      }
      const record = value as Record<string, unknown>;
      return {
        gatewayUrl: decodeOptionalConfigString(record.gateway_url, "gateway_url"),
        webPushPublicKey: decodeOptionalConfigString(
          record.web_push_public_key,
          "web_push_public_key",
        ),
      };
    },
  };

function decodeOptionalConfigString(
  value: unknown,
  field: string,
): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return nonEmptyString(value);
}

/**
 * Read the connected host's runtime pusher config. Returns null when the host
 * does not answer (older build, push disabled, offline), which is a fallback
 * condition rather than a registration failure.
 */
export async function fetchHostNotificationPusherConfig(input: {
  readonly session: MobileSession;
  readonly path?: string;
  readonly fetch?: FetchLike;
}): Promise<HostNotificationPusherConfig | null> {
  const path =
    input.path ?? resolveNotificationPusherConfigEndpoint(input.session);
  // Resolve eagerly so a cross-origin advertised endpoint still fails loudly
  // instead of being swallowed as "host did not answer".
  hostEndpoint(input.session.hostUrl, path);
  let body: unknown;
  try {
    body = await createMobileApiClient({
      session: input.session,
      fetch: input.fetch,
    }).json(path);
  } catch {
    return null;
  }
  // Decoded outside the catch above: "the host did not answer" is a fallback
  // condition, but "the host answered with a shape we do not understand" is a
  // producer/consumer disagreement and must not be silently swallowed.
  return decodeWire(
    HOST_NOTIFICATION_PUSHER_CONFIG_DECODER,
    body,
    hostEndpoint(input.session.hostUrl, path),
  );
}

/**
 * The host owns the gateway allowlist, so a host that advertises a gateway is
 * the deployment authority: one shell binary talks to many self-hosted servers
 * and a build-time URL cannot be right for all of them. The build-time value
 * stays as the fallback for hosts that predate the config endpoint.
 */
export async function resolveNotificationPusherGatewayUrl(input: {
  readonly session: MobileSession;
  readonly fallbackGatewayUrl?: string;
  readonly path?: string;
  readonly fetch?: FetchLike;
}): Promise<string> {
  const configPath = input.path
    ? `${input.path.replace(/\/+$/u, "")}/config`
    : resolveNotificationPusherConfigEndpoint(input.session);
  const config = await fetchHostNotificationPusherConfig({
    session: input.session,
    path: configPath,
    fetch: input.fetch,
  });
  const resolved =
    config?.gatewayUrl ?? nonEmptyString(input.fallbackGatewayUrl);
  if (!resolved) {
    throw new Error(
      "This host does not advertise a notification push gateway.",
    );
  }
  return resolved;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text : null;
}

function invalidPusherError(input: {
  readonly error: string;
  readonly field?: string;
}): Error {
  const field = input.field ? ` (${input.field})` : "";
  return new Error(`Notification pusher is invalid${field}: ${input.error}`);
}
