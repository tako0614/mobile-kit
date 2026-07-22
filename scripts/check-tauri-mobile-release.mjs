#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const doctorScript = fileURLToPath(
  new URL("./check-tauri-mobile.mjs", import.meta.url),
);
const nativePushScript = fileURLToPath(
  new URL("./apply-tauri-mobile-push-native.mjs", import.meta.url),
);
const androidManifestScript = fileURLToPath(
  new URL("./apply-tauri-mobile-android-manifest.mjs", import.meta.url),
);

const doctorArgs = process.argv.slice(2).includes("--strict-native-env")
  ? process.argv.slice(2)
  : [...process.argv.slice(2), "--strict-native-env"];

const checks = [
  {
    label: "strict Tauri mobile doctor",
    args: [doctorScript, ...doctorArgs],
  },
  {
    label: "strict generated native push wiring",
    args: [
      nativePushScript,
      "--apple-environment",
      "production",
      "--dry-run",
      "--strict",
    ],
  },
  {
    // Without this, a shell whose generated project never had the manifest step
    // applied still passes release:native-check and ships with Auto Backup on
    // and the camera declared as a required feature.
    label: "strict generated Android manifest hardening",
    args: [
      androidManifestScript,
      "--product",
      productArg(),
      "--dry-run",
      "--strict",
    ],
  },
];

function productArg() {
  const argv = process.argv.slice(2);
  const index = argv.indexOf("--product");
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value) {
    console.error("check-tauri-mobile-release: --product is required");
    process.exit(2);
  }
  return value;
}

const failures = [];

for (const check of checks) {
  console.log(`\n==> ${check.label}`);
  const code = await run("bun", check.args);
  if (code !== 0) failures.push({ label: check.label, code });
}

if (failures.length > 0) {
  console.error("\nTauri mobile release check failed:");
  for (const failure of failures) {
    console.error(`- ${failure.label} exited with ${failure.code}`);
  }
  process.exit(1);
}

console.log("\nTauri mobile release check passed.");

function run(command, args) {
  return new Promise((resolveExit) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: "inherit",
      env: process.env,
    });
    child.on("close", (code) => resolveExit(code ?? 1));
    child.on("error", (error) => {
      console.error(error);
      resolveExit(1);
    });
  });
}
