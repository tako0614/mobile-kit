import type { MobilePushNotificationCallbackInput } from "./client.ts";
import {
  isSafeMobileRoutePath,
  type MobileRouteSafetyOptions,
} from "./route-safety.ts";

/**
 * The same-origin host route a tapped notification asks for, or undefined.
 * The route goes through the same screening as screen links: another origin,
 * another scheme, control characters or credential-named parameters drop it.
 */
export function resolvePushNotificationPath(
  input: MobilePushNotificationCallbackInput,
  options: MobileRouteSafetyOptions = {},
): string | undefined {
  const path = rawPushNotificationPath(input);
  return path !== undefined && isSafeMobileRoutePath(path, options)
    ? path
    : undefined;
}

function rawPushNotificationPath(
  input: MobilePushNotificationCallbackInput,
): string | undefined {
  const value = firstString(
    input.notification.data.path,
    input.notification.data.route,
    input.notification.data.url,
    input.notification.data.href,
  );
  if (!value) {
    return typeof input.notification.data.event_id === "string" &&
      input.notification.data.event_id.trim()
      ? "/notifications"
      : undefined;
  }
  if (value.startsWith("/")) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    if (url.origin !== new URL(input.session.hostUrl).origin) return undefined;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return undefined;
  }
}

function firstString(...values: readonly unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string");
}
