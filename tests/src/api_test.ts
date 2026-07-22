import { expect, test } from "bun:test";
import {
  createMobileApiClient,
  MobileApiError,
  NOTIFICATION_PUSHER_REGISTRATION_PATH,
  registerNotificationPusherWithHost,
  resolveNotificationPusherEndpoint,
  resolveNotificationPusherGatewayUrl,
  unregisterNotificationPusherWithHost,
  type MobileSession,
  type NotificationPusher,
} from "../../src/index.ts";

const pusher = {
  kind: "http",
  app_id: "jp.example.mobile",
  app_display_name: "Example",
  pushkey: "push-token",
  data: {
    url: "https://push.example/_matrix/push/v1/notify",
    format: "event_id_only",
    provider: "fcm",
    environment: "production",
  },
} satisfies NotificationPusher;

test("createMobileApiClient sends bearer auth to host API", async () => {
  const requests: Request[] = [];
  const client = createMobileApiClient({
    session: session(),
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return json({ ok: true });
    },
  });

  const result = await client.json<{ ok: boolean }>("/api/auth/me");

  expect(result.ok).toBe(true);
  expect(requests[0].url).toBe("https://host.example/api/auth/me");
  expect(requests[0].headers.get("authorization")).toBe("Bearer access-1");
});

test("createMobileApiClient exposes authorization failures as typed errors", async () => {
  const client = createMobileApiClient({
    session: session(),
    fetch: async () => new Response("forbidden", { status: 403 }),
  });

  try {
    await client.json("/api/spaces");
    throw new Error("expected request to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(MobileApiError);
    expect((error as MobileApiError).status).toBe(403);
    expect((error as MobileApiError).path).toBe("/api/spaces");
  }
});

test("registerNotificationPusherWithHost posts the product-neutral pusher", async () => {
  const requests: Request[] = [];

  await registerNotificationPusherWithHost({
    session: session({
      productEndpoints: { notificationPushers: "/custom/pushers" },
    }),
    pusher,
    scope: "account:user-1",
    fetch: collect(requests),
  });

  // The runtime config lookup precedes the registration POST.
  expect(requests[0].url).toBe("https://host.example/custom/pushers/config");
  expect(requests[1].url).toBe("https://host.example/custom/pushers");
  expect(requests[1].method).toBe("POST");
  expect(requests[1].headers.get("authorization")).toBe("Bearer access-1");
  expect(requests[1].headers.get("content-type")).toBe("application/json");
  expect(await requests[1].json()).toEqual({
    product: "takos",
    scope: "account:user-1",
    pusher,
  });
});

test("registerNotificationPusherWithHost accepts a same-origin advertised endpoint", async () => {
  const requests: Request[] = [];

  await registerNotificationPusherWithHost({
    session: session({
      productEndpoints: {
        notificationPushers: "https://host.example/api/notifications/pushers",
      },
    }),
    pusher,
    fetch: collect(requests),
  });

  expect(requests[1].url).toBe(
    "https://host.example/api/notifications/pushers",
  );
});

test("unregisterNotificationPusherWithHost deletes by app id and pushkey", async () => {
  const requests: Request[] = [];

  await unregisterNotificationPusherWithHost({
    session: session(),
    appId: pusher.app_id,
    pushkey: pusher.pushkey,
    fetch: collect(requests),
  });

  expect(requests[0].url).toBe(
    "https://host.example/api/notifications/pushers",
  );
  expect(requests[0].method).toBe("DELETE");
  expect(requests[0].headers.get("authorization")).toBe("Bearer access-1");
  expect(await requests[0].json()).toEqual({
    product: "takos",
    app_id: "jp.example.mobile",
    pushkey: "push-token",
  });
});

test("notification pusher helper rejects cross-origin host endpoints", async () => {
  await expect(
    registerNotificationPusherWithHost({
      session: session({
        productEndpoints: {
          notificationPushers: "https://evil.example/pushers",
        },
      }),
      pusher,
      fetch: async () => {
        throw new Error("must not send request");
      },
    }),
  ).rejects.toThrow("Host endpoint must stay on the connected host.");
});

test("notification pusher helper rejects insecure remote gateways before fetch", async () => {
  await expect(
    registerNotificationPusherWithHost({
      session: session(),
      pusher: {
        ...pusher,
        data: { ...pusher.data, url: "http://push.example/notify" },
      },
      fetch: async () => {
        throw new Error("must not send request");
      },
    }),
  ).rejects.toThrow("Notification pusher is invalid (pusher.data)");
});

test("the host-advertised gateway wins over the build-time gateway", async () => {
  const requests: Request[] = [];

  await registerNotificationPusherWithHost({
    session: session(),
    pusher,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return request.url.endsWith("/config")
        ? json({
            gateway_url:
              "https://gateway.selfhost.example/_matrix/push/v1/notify",
            web_push_public_key: null,
          })
        : json({ ok: true });
    },
  });

  const registered = (await requests[1].json()) as {
    pusher: { data: { url: string } };
  };
  expect(registered.pusher.data.url).toBe(
    "https://gateway.selfhost.example/_matrix/push/v1/notify",
  );
});

test("the build-time gateway is used when the host advertises none", async () => {
  const requests: Request[] = [];

  await registerNotificationPusherWithHost({
    session: session(),
    pusher,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return request.url.endsWith("/config")
        ? json({ gateway_url: null, web_push_public_key: null })
        : json({ ok: true });
    },
  });

  const registered = (await requests[1].json()) as {
    pusher: { data: { url: string } };
  };
  expect(registered.pusher.data.url).toBe(pusher.data.url);
});

test("a host without a config endpoint still registers the build-time gateway", async () => {
  const requests: Request[] = [];

  await registerNotificationPusherWithHost({
    session: session(),
    pusher,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return request.url.endsWith("/config")
        ? new Response("not found", { status: 404 })
        : json({ ok: true });
    },
  });

  const registered = (await requests[1].json()) as {
    pusher: { data: { url: string } };
  };
  expect(registered.pusher.data.url).toBe(pusher.data.url);
});

test("resolveNotificationPusherGatewayUrl fails when nothing supplies a gateway", async () => {
  await expect(
    resolveNotificationPusherGatewayUrl({
      session: session(),
      fetch: async () => json({ gateway_url: null }),
    }),
  ).rejects.toThrow(
    "This host does not advertise a notification push gateway.",
  );
});

test("host rejection messages reach the caller instead of a bare status", async () => {
  const client = createMobileApiClient({
    session: session(),
    fetch: async () =>
      new Response(
        JSON.stringify({
          code: "BAD_REQUEST",
          error: "pusher.data.url is not allowed by this server",
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
  });

  try {
    await client.json("/api/notifications/pushers", { method: "POST" });
    throw new Error("expected request to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(MobileApiError);
    expect((error as MobileApiError).detail).toBe(
      "pusher.data.url is not allowed by this server",
    );
    expect((error as MobileApiError).message).toContain(
      "pusher.data.url is not allowed by this server",
    );
  }
});

test("resolveNotificationPusherEndpoint falls back to the standard path", () => {
  expect(resolveNotificationPusherEndpoint(session())).toBe(
    NOTIFICATION_PUSHER_REGISTRATION_PATH,
  );
});

function session(input: Partial<MobileSession> = {}): MobileSession {
  return {
    hostUrl: "https://host.example",
    product: "takos",
    oidcIssuer: "https://host.example",
    accessToken: "access-1",
    tokenType: "Bearer",
    createdAt: "2026-06-30T00:00:00.000Z",
    ...input,
  };
}

function collect(requests: Request[]) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return json({ ok: true });
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}
