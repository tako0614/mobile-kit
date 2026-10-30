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
    ["yurucommu://open?path=javascript%3Aalert(1)", "same-origin"],
    ["yurucommu://open?path=data%3Atext%2Fhtml%2Cx", "same-origin"],
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
