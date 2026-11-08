import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const doctor = fileURLToPath(new URL("../../scripts/check-tauri-mobile.mjs", import.meta.url));
const commandCheck = "script tauri:android:dev directly runs Tauri Android dev (host is optional)";
const hostCheck = "script tauri:android:dev does not publish a wildcard address as the device host";
const vite = "const devPort = 1440; createTauriMobileViteConfig({ importMetaUrl: import.meta.url });";

function inspect(script: string, config = vite) {
  const app = mkdtempSync(path.join(tmpdir(), "kit-doctor-android-"));
  try {
    writeFileSync(path.join(app, "package.json"), JSON.stringify({ scripts: { "tauri:android:dev": script } }));
    writeFileSync(path.join(app, "vite.config.ts"), config);
    const result = spawnSync(process.execPath, [doctor, "--app-dir", app,
      "--product", "fixture", "--scheme", "fixture", "--product-name", "Fixture", "--dev-port", "1440"],
    { encoding: "utf8", timeout: 10_000, env: { ...process.env, PATH: "" } });
    // Deliberately incomplete static fixture, never a native/SDK qualification.
    // Empty PATH makes the native probes unavailable and prevents bunx installs.
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("WARN Tauri CLI is unavailable");
    return result.stdout;
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
}

test("doctor accepts direct device defaults and explicit Studio/LAN options", () => {
  for (const script of [
    "bunx tauri android dev", "bunx tauri android dev --open --host",
    "bunx tauri android dev --host 192.168.1.20", "bunx tauri android dev --host=dev.example",
    'bunx tauri android dev "Pixel 8" --host "192.168.1.20"',
    "bunx tauri android dev --force-ip-prompt", "bunx tauri android dev --host --open",
  ]) {
    const output = inspect(script);
    expect(output).toContain(`OK ${commandCheck}`);
    expect(output).toContain(`OK ${hostCheck}`);
  }
});

test("doctor refuses unrelated commands, shell syntax and non-dev invocations", () => {
  for (const script of [
    "echo --host", "echo bunx tauri android dev --host", "bunx tauri android build --host",
    "bunx tauri android dev; echo --host", "bunx tauri android dev && echo --host",
    "bunx tauri android dev --host $(hostname)", "bunx tauri android dev --host `hostname`",
    "bunx tauri android dev # --host", "bunx tauri android dev --help", "bunx tauri android dev --host=",
    'bunx tau"ri" android dev --host', "bunx tauri android dev\necho --host",
    '"bunx tauri android dev"', 'bunx "tauri android" dev', "bunx\u00a0tauri android dev",
    "bunx tauri android dev --host [::]",
    "bunx tauri android dev (echo)", "bunx tauri android dev )",
  ]) expect(inspect(script)).toContain(`FAIL ${commandCheck}`);
});

test("doctor rejects wildcard device hosts with space, equals and quoted forms", () => {
  for (const tail of ["--host 0.0.0.0", "--host=0.0.0.0", '--host "0.0.0.0"', "--host '0.0.0.0'", "--host ::", '--host "[::]"']) {
    expect(inspect(`bunx tauri android dev ${tail}`)).toContain(`FAIL ${hostCheck}`);
  }
});

test("optional CLI host does not waive Vite mobile host or HMR plumbing", () => {
  const output = inspect("bunx tauri android dev", "const devPort = 1440;");
  expect(output).toContain(`OK ${commandCheck}`);
  expect(output).toContain("FAIL Vite config reads TAURI_DEV_HOST for mobile devices");
  expect(output).toContain("FAIL Vite config exposes the dev server through the selected mobile host");
  expect(output).toContain("FAIL Vite config pins HMR to the selected mobile host");
});
