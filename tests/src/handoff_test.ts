import { expect, test } from "bun:test";
import {
  parseMobileConnectInput,
  parseMobileRouteInput,
} from "../../src/index.ts";

test("parseMobileConnectInput accepts plain host URLs", () => {
  expect(parseMobileConnectInput("host.example/path")).toEqual({
    hostUrl: "https://host.example",
    product: undefined,
    setupTicket: undefined,
  });
});

test("parseMobileConnectInput accepts app handoff URLs", () => {
  expect(
    parseMobileConnectInput(
      "yurucommu://connect?host_url=https%3A%2F%2Fy.example%2Ffeed&product=yurucommu&setup_ticket=s1",
    ),
  ).toEqual({
    hostUrl: "https://y.example",
    product: "yurucommu",
    setupTicket: "s1",
  });
});

test("parseMobileConnectInput accepts JSON QR payloads", () => {
  expect(
    parseMobileConnectInput(
      JSON.stringify({
        host_url: "https://takos.example/workspace",
        product: "takos",
      }),
    ),
  ).toEqual({
    hostUrl: "https://takos.example",
    product: "takos",
    setupTicket: undefined,
  });
});

test("parseMobileConnectInput accepts Host Center return payloads without a Takosumi app scheme", () => {
  expect(
    parseMobileConnectInput(
      "notesapp://connect?host_url=https%3A%2F%2Fnotes.example&product=notes-app",
    ),
  ).toEqual({
    hostUrl: "https://notes.example",
    product: "notes-app",
    setupTicket: undefined,
  });
});

test("parseMobileRouteInput accepts mobile open URLs", () => {
  expect(
    parseMobileRouteInput(
      "takos://open?path=%2Fchat&host_url=https%3A%2F%2Fhost.example%2Fworkspace&product=takos",
      { mobileScheme: "takos", product: "takos" },
    ),
  ).toEqual({
    path: "/chat",
    hostUrl: "https://host.example",
    product: "takos",
  });
});

test("parseMobileRouteInput infers host from absolute route URLs", () => {
  expect(
    parseMobileRouteInput(
      "yurucommu://open?url=https%3A%2F%2Fy.example%2Fnotifications%3Funread%3D1",
      { mobileScheme: "yurucommu", product: "yurucommu" },
    ),
  ).toEqual({
    path: "/notifications?unread=1",
    hostUrl: "https://y.example",
    product: undefined,
  });
});

test("parseMobileRouteInput accepts direct hosted route URLs", () => {
  expect(
    parseMobileRouteInput("https://host.example/chat?thread=1#latest", {
      mobileScheme: "takos",
      product: "takos",
    }),
  ).toEqual({
    path: "/chat?thread=1#latest",
    hostUrl: "https://host.example",
    product: undefined,
  });
});

test("parseMobileRouteInput accepts generic product mobile open URLs", () => {
  expect(
    parseMobileRouteInput(
      "notesapp://open?path=%2Fruns&host_url=https%3A%2F%2Fnotes.example&product=notes-app",
      { mobileScheme: "notesapp", product: "notes-app" },
    ),
  ).toEqual({
    path: "/runs",
    hostUrl: "https://notes.example",
    product: "notes-app",
  });
});

test("parseMobileRouteInput ignores connect URLs and rejects mismatched products", () => {
  expect(
    parseMobileRouteInput(
      "takos://connect?host_url=https%3A%2F%2Fhost.example",
      {
        mobileScheme: "takos",
        product: "takos",
      },
    ),
  ).toBeUndefined();
  expect(() =>
    parseMobileRouteInput("takos://open?path=%2Fchat&product=yurucommu", {
      mobileScheme: "takos",
      product: "takos",
    }),
  ).toThrow("Mobile route payload product mismatch.");
});

test("parseMobileRouteInput refuses paths that leave the host or carry credentials", () => {
  const adapter = { mobileScheme: "yurucommu", product: "yurucommu" };
  const refused: Array<[string, string]> = [
    // Backslash spellings resolve to another origin under the URL parser.
    ["yurucommu://open?path=%2F%5Cevil.example%2Fx&host_url=https%3A%2F%2Fy.example", "same-origin"],
    ["yurucommu://open?path=%2F%5C%5Cevil.example", "same-origin"],
    ["yurucommu://open?path=%2F%2Fevil.example", "same-origin"],
    ["yurucommu://open?path=javascript%3Aalert(1)", "http or https"],
    ["yurucommu://open?path=data%3Atext%2Fhtml%2Cx", "http or https"],
    // Whitespace and control characters.
    ["yurucommu://open?path=%2Ffeed%0Ax", "control characters"],
    ["yurucommu://open?path=%2Ffe%09ed", "control characters"],
    ["yurucommu://open?path=%2Ffeed%20x", "control characters"],
    // Credentials in the query or the fragment.
    ["yurucommu://open?path=%2Foauth%2Fcallback%3Fcode%3Dattacker%26state%3Ds", "credentials"],
    ["yurucommu://open?path=%2F%3Faccess_token%3Dt", "credentials"],
    ["yurucommu://open?path=%2F%3FAccess-Token%3Dt", "credentials"],
    ["yurucommu://open?path=%2Fsettings%23id_token%3Dt", "credentials"],
    ["https://y.example/login?session=s", "credentials"],
    ["https://y.example/#refresh_token=r", "credentials"],
  ];
  for (const [input, reason] of refused) {
    expect(() => parseMobileRouteInput(input, adapter), input).toThrow(reason);
  }
  expect(() =>
    parseMobileRouteInput(`yurucommu://open?path=/${"a".repeat(2048)}`, adapter),
  ).toThrow("too long");
});

test("parseMobileRouteInput keeps ordinary same-origin paths", () => {
  const adapter = { mobileScheme: "yurucommu", product: "yurucommu" };
  expect(
    parseMobileRouteInput(
      "yurucommu://open?path=%2Fusers%2Falice%3Ftab%3Dposts%23top&host_url=https%3A%2F%2Fy.example",
      adapter,
    ),
  ).toEqual({
    path: "/users/alice?tab=posts#top",
    hostUrl: "https://y.example",
    product: undefined,
  });
  // A Takosumi screen URL (`{url}`) is a full same-origin URL.
  expect(
    parseMobileRouteInput(
      "yurucommu://open?url=https%3A%2F%2Fy.example%2F",
      adapter,
    ),
  ).toEqual({ path: "/", hostUrl: "https://y.example", product: undefined });
  // Encoded slashes stay inside the path.
  expect(
    parseMobileRouteInput("yurucommu://open?path=%2F%252F%252Fevil", adapter)?.path,
  ).toBe("/%2F%2Fevil");
});

test("parseMobileRouteInput only reads web URLs as route URLs", () => {
  const adapter = { mobileScheme: "yurucommu", product: "yurucommu" };
  for (const value of [
    "ftp://y.example/x",
    "yurucommu://open?path=/",
    "file:///etc/passwd",
    "blob:https://y.example/1",
    "about:blank",
  ]) {
    expect(
      () => parseMobileRouteInput(`yurucommu://open?url=${encodeURIComponent(value)}`, adapter),
      value,
    ).toThrow("http or https");
  }
});

test("parseMobileRouteInput screens credential names like Takosumi does, and more", () => {
  const adapter = { mobileScheme: "yurucommu", product: "yurucommu" };
  const refused = [
    "/?auth_token=t",
    "/?oauth_token=t",
    "/?oauth_verifier=v",
    "/?setup_ticket=s",
    "/?ticket=ST-1",
    "/?X-Amz-Signature=s",
    "/?X-Amz-Date=20260101T000000Z",
    "/?x-goog-credential=c",
    "/?signing_key=k",
    "/?client_assertion=a",
    "/?SAMLResponse=r",
    "/?csrfToken=t",
    "/?a=1;code=x",
    "/?a=1;Session_Id=x",
    "/files;jsessionid=abc/list",
    "/x;PHPSESSID=abc",
    "/#/callback?code=x",
    "/#!/cb?access_token=t",
    "/#state=s&id_token=t",
    "/?%2561ccess_token=t",
    "/?access%5Ftoken=t",
    "/join?code=abc",
  ];
  for (const path of refused) {
    expect(
      () => parseMobileRouteInput(`yurucommu://open?path=${encodeURIComponent(path)}`, adapter),
      path,
    ).toThrow("must not carry credentials");
  }
  const kept = [
    "/docs#code",
    "/docs#session",
    "/settings#token-help",
    "/?pageToken=abc&nextPageToken=def",
    "/?continuationToken=c",
    "/?token=",
    "/?code",
    "/search?q=password+reset",
    "/users/session-notes",
  ];
  for (const path of kept) {
    expect(
      parseMobileRouteInput(`yurucommu://open?path=${encodeURIComponent(path)}`, adapter)?.path,
      path,
    ).toBe(path);
  }
});

test("a product can accept invite codes in routes, never on OAuth paths", () => {
  const adapter = {
    mobileScheme: "yurucommu",
    product: "yurucommu",
    allowRouteCodeParameter: true,
  };
  expect(
    parseMobileRouteInput("yurucommu://open?path=%2Fjoin%3Fcode%3Dabc", adapter)?.path,
  ).toBe("/join?code=abc");
  expect(
    parseMobileRouteInput("yurucommu://open?path=%2F%23%2Fjoin%3Fcode%3Dabc", adapter)?.path,
  ).toBe("/#/join?code=abc");
  for (const path of [
    "/oauth/callback?code=x",
    "/auth/callback?code=x",
    "/oauth2/authorize?code=x",
    "/join?code=abc&token=t",
  ]) {
    expect(
      () => parseMobileRouteInput(`yurucommu://open?path=${encodeURIComponent(path)}`, adapter),
      path,
    ).toThrow("must not carry credentials");
  }
});
