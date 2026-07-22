import { expect, test } from "bun:test";
import {
  isSafeLinkHref,
  parseTakosumiAppReturnUri,
} from "../../src/contract/app-handoff.ts";

// Codex finding 768f98d2 (unsafe app handoff return_uri can create JavaScript
// hrefs), fixed in takosumi/contract/app-handoff.ts. This file is a VENDORED
// COPY of that contract consumed by all four mobile shells, so it carried the
// same bug: the authority form of a script-capable scheme survives URL parsing —
// `javascript://x/%0Aalert(1)//` keeps `javascript:` as its protocol, and the
// connect payload appended after it lands behind the `//` line comment, so a
// click executes in the host origin.

test("a javascript: return_uri in authority form is rejected", () => {
  expect(
    parseTakosumiAppReturnUri("javascript://x/%0Aalert(1)//"),
  ).toBeUndefined();
});

test("every script-capable scheme is rejected as a return_uri", () => {
  for (
    const raw of [
      "javascript://x/%0Aalert(1)//",
      "data://x/,alert(1)",
      "vbscript://x/msgbox(1)",
      "blob://x/y",
      "file://host/etc/passwd",
      "about://x/blank",
      "filesystem://x/temporary/y",
      "view-source://x/y",
    ]
  ) {
    expect(parseTakosumiAppReturnUri(raw)).toBeUndefined();
  }
});

test("a client custom scheme still works", () => {
  expect(parseTakosumiAppReturnUri("notesapp://connect")).toBe(
    "notesapp://connect",
  );
});

test("isSafeLinkHref fails closed but keeps ordinary links", () => {
  expect(isSafeLinkHref("javascript://x/%0Aalert(1)//")).toBe(false);
  expect(isSafeLinkHref("JavaScript:alert(1)")).toBe(false);
  expect(isSafeLinkHref("")).toBe(false);
  expect(isSafeLinkHref(undefined)).toBe(false);

  expect(isSafeLinkHref("/settings")).toBe(true);
  expect(isSafeLinkHref("https://example.test/x")).toBe(true);
  expect(isSafeLinkHref("notesapp://connect")).toBe(true);
});
