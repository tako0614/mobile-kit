import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const doctor = fileURLToPath(new URL("../../scripts/check-tauri-mobile.mjs", import.meta.url));
const grant = "app-screen:allow-open";
const mobile = '[target.\'cfg(any(target_os = "android", target_os = "ios"))\'.dependencies]\ntauri-plugin-app-screen = { path = "plugins/app-screen" }';
const desktop = '[target.\'cfg(not(any(target_os = "android", target_os = "ios")))\'.dependencies]\ntauri-plugin-app-screen = { path = "plugins/app-screen", features = ["desktop"] }';

function inspect(cargo: string, desktopGrant = true) {
  const app = mkdtempSync(path.join(tmpdir(), "kit-doctor-platform-"));
  try {
    mkdirSync(path.join(app, "src-tauri/capabilities"), { recursive: true });
    writeFileSync(path.join(app, "src-tauri/Cargo.toml"), cargo);
    writeFileSync(path.join(app, "src-tauri/capabilities/default.json"), JSON.stringify({ permissions: desktopGrant ? [grant] : [] }));
    writeFileSync(path.join(app, "src-tauri/capabilities/mobile.json"), JSON.stringify({ platforms: ["iOS", "android"], permissions: [grant] }));
    const result = spawnSync(process.execPath, [doctor, "--app-dir", app,
      "--product", "fixture", "--scheme", "fixture", "--product-name", "Fixture", "--dev-port", "1440"],
    { encoding: "utf8", timeout: 10_000, env: { ...process.env, PATH: "" } });
    // Incomplete static fixture; native probes are unavailable, not green.
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("WARN Tauri CLI is unavailable");
    return result.stdout;
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
}

test("doctor combines desktop and mobile declarations in either order", () => {
  for (const cargo of [`${desktop}\n${mobile}`, `${mobile}\n${desktop}`, `[dependencies]\ntauri-plugin-app-screen = "1"\n${mobile}`]) {
    const output = inspect(cargo);
    expect(output).toContain("OK desktop capability grants a permission for app-screen");
    expect(output).not.toContain("FAIL desktop capability does not grant mobile-only app-screen");
    expect(output.split("OK desktop capability grants a permission for app-screen")).toHaveLength(2);
  }
});

test("doctor still rejects desktop grants for Android-only and iOS-only plugins", () => {
  for (const os of ["android", "ios"]) {
    expect(inspect(`[target.'cfg(target_os = "${os}")'.dependencies]\ntauri-plugin-app-screen = "1"`))
      .toContain("FAIL desktop capability does not grant mobile-only app-screen");
  }
});

test("desktop complement and unconditional plugins still require desktop grants", () => {
  for (const cargo of [desktop, '[dependencies]\ntauri-plugin-app-screen = "1"']) {
    expect(inspect(cargo, false)).toContain("FAIL desktop capability grants a permission for app-screen");
  }
});

test("TOML comments, dependency tables and whitespace retain target meaning", () => {
  const cargo = `[target.'cfg( not( any( target_os="ios", target_os="android", ) ) )'.dependencies.app-screen-alias] # desktop
package = "tauri-plugin-app-screen"
path = "plugins/app-screen"
${mobile}`;
  expect(inspect(cargo)).toContain("OK desktop capability grants a permission for app-screen");
});

test("unknown plugin target predicates fail instead of assuming desktop support", () => {
  expect(inspect('[target.\'cfg(all(target_os = "android", target_arch = "aarch64"))\'.dependencies]\ntauri-plugin-app-screen = "1"'))
    .toContain("FAIL unsupported Cargo target predicate for plugin app-screen");
});

test("malformed manifests and unknown OS strings cannot justify capability grants", () => {
  // Bun 1.3.14 accepts this unfinished header as an empty table. It still
  // cannot justify a runtime permission; do not assume the newer parser's error.
  expect(inspect("[dependencies")).toContain("FAIL desktop capability grants app-screen only because Cargo.toml depends on it");
  expect(inspect("invalid = = =")).toContain("FAIL invalid Cargo.toml for plugin capability coverage");
  expect(inspect('[target.\'cfg(target_os = "and roid")\'.dependencies]\ntauri-plugin-app-screen = "1"'))
    .toContain("FAIL unsupported Cargo target predicate for plugin app-screen");
});

test("build and dev dependencies do not justify runtime capability grants", () => {
  const cargo = '[build-dependencies]\ntauri-plugin-app-screen = "1"\n[target.\'cfg(target_os="android")\'.dev-dependencies]\ntauri-plugin-app-screen = "1"';
  expect(inspect(cargo)).toContain("FAIL desktop capability grants app-screen only because Cargo.toml depends on it");
});
