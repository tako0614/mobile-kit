import { expect, test } from "bun:test";
import {
  resolvePushNotificationPath,
  type MobilePushNotificationCallbackInput,
} from "../../src/index.ts";

function tap(data: Record<string, unknown>): MobilePushNotificationCallbackInput {
  return {
    kind: "tapped",
    session: {
      hostUrl: "https://host.example",
      product: "takos",
      accessToken: "t",
      tokenType: "Bearer",
      createdAt: "2026-10-30T00:00:00.000Z",
    },
    notification: { data },
  } as MobilePushNotificationCallbackInput;
}

test("notification routes on the session host are opened", () => {
  expect(resolvePushNotificationPath(tap({ path: "/chat/me/thread-1" }))).toBe(
    "/chat/me/thread-1",
  );
  expect(
    resolvePushNotificationPath(tap({ url: "https://host.example/runs/1?view=log#end" })),
  ).toBe("/runs/1?view=log#end");
  expect(resolvePushNotificationPath(tap({ event_id: "e1" }))).toBe("/notifications");
});

test("notification routes go through the screen-link screening", () => {
  for (const data of [
    { path: "//evil.example/x" },
    { path: "/\\evil.example/x" },
    { path: "/x?access_token=t" },
    { path: "/x#/cb?code=c" },
    { path: "/x;jsessionid=s" },
    { path: "/a b" },
    { path: `/${"a".repeat(2048)}` },
    { url: "https://evil.example/x" },
    { url: "javascript:alert(1)" },
    { href: "data:text/html,x" },
    { route: "/join?code=abc" },
  ]) {
    expect(resolvePushNotificationPath(tap(data)), JSON.stringify(data)).toBeUndefined();
  }
});

test("a product that accepts invite codes gets them from notifications too", () => {
  expect(
    resolvePushNotificationPath(tap({ route: "/join?code=abc" }), {
      allowCodeParameter: true,
    }),
  ).toBe("/join?code=abc");
  expect(
    resolvePushNotificationPath(tap({ route: "/oauth/callback?code=abc" }), {
      allowCodeParameter: true,
    }),
  ).toBeUndefined();
});
