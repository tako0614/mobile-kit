#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
const appDir = path.resolve(args.appDir ?? process.cwd());
const product = args.product;
const dryRun = Boolean(args.dryRun);
const strict = Boolean(args.strict);
const results = [];

const KEYSTORE_PREFERENCES_FALLBACK = "jp.takos.mobile.keystore.v1";

if (!product) {
  fail("--product is required");
  printResults();
  process.exit(2);
}

applyAndroidManifestHardening();
printResults();

if (
  results.some((result) => result.kind === "fail") ||
  (strict && results.some((result) => result.kind === "warn"))
) {
  process.exit(1);
}

function applyAndroidManifestHardening() {
  const androidDir = path.join(appDir, "src-tauri/gen/android");
  if (!existsSync(androidDir)) {
    warn(
      "src-tauri/gen/android is missing; run tauri android init before applying manifest hardening",
    );
    return;
  }

  const manifestPath = path.join(
    androidDir,
    "app/src/main/AndroidManifest.xml",
  );
  if (!existsSync(manifestPath)) {
    fail(
      "Android manifest is missing at src-tauri/gen/android/app/src/main/AndroidManifest.xml",
    );
    return;
  }

  const rulesPath = path.join(
    androidDir,
    "app/src/main/res/xml/data_extraction_rules.xml",
  );
  writeIfChanged(
    rulesPath,
    renderDataExtractionRules(secureStoreFileNames()),
    "Android secure-store backup exclusions",
  );

  writeIfChanged(
    manifestPath,
    patchManifest(readText(manifestPath)),
    "Android manifest backup and camera hardening",
  );
}

function patchManifest(xml) {
  return ensureOptionalCameraFeatures(
    upsertApplicationAttribute(
      upsertApplicationAttribute(
        ensureToolsNamespace(xml),
        "android:dataExtractionRules",
        "@xml/data_extraction_rules",
      ),
      "android:allowBackup",
      "false",
    ),
  );
}

function ensureToolsNamespace(xml) {
  if (xml.includes("xmlns:tools=")) return xml;
  const patched = xml.replace(
    /(<manifest\b[^>]*?xmlns:android="[^"]*")/,
    '$1\n    xmlns:tools="http://schemas.android.com/tools"',
  );
  if (patched === xml) {
    // Without the namespace the tools:replace below is not merely inert, it is a
    // manifest-merger error, so a missed anchor must not pass silently.
    fail("Android manifest has no xmlns:android declaration to anchor xmlns:tools to");
  }
  return patched;
}

function upsertApplicationAttribute(xml, name, value) {
  const existing = new RegExp(
    `(<application\\b[^>]*?\\s${name.replace(":", "\\:")}=")[^"]*(")`,
  );
  if (existing.test(xml)) {
    return xml.replace(existing, `$1${value}$2`);
  }
  return xml.replace(
    /<application\b/,
    (match) => `${match}\n        ${name}="${value}"`,
  );
}

function ensureOptionalCameraFeatures(xml) {
  // Every camera feature Play can imply from the merged CAMERA permission. The
  // barcode-scanner plugin merges android.hardware.camera.any with no
  // android:required (defaulting to true), and Play's implied-feature rule derives
  // android.hardware.camera AND android.hardware.camera.autofocus from the
  // permission itself. Declaring only some of them still filters devices, so each
  // is tracked separately and a manifest patched by an older revision of this
  // script gets topped up rather than skipped.
  const OPTIONAL_CAMERA_FEATURES = [
    {
      name: "android.hardware.camera.any",
      // Only this one is merged in as an element, so only this one needs to
      // override the merger's required="true".
      lines: [
        "    <uses-feature",
        '        android:name="android.hardware.camera.any"',
        '        android:required="false"',
        '        tools:replace="android:required" />',
      ],
    },
    {
      name: "android.hardware.camera",
      lines: [
        '    <uses-feature android:name="android.hardware.camera" android:required="false" />',
      ],
    },
    {
      name: "android.hardware.camera.autofocus",
      lines: [
        '    <uses-feature android:name="android.hardware.camera.autofocus" android:required="false" />',
      ],
    },
  ];

  const missing = OPTIONAL_CAMERA_FEATURES.filter(
    (feature) => !xml.includes(`android:name="${feature.name}"`),
  );
  if (missing.length === 0) return xml;
  const block = [
    "    <!-- QR scanning is one optional entry path, so no camera capability may be",
    "         a Play install filter. -->",
    ...missing.flatMap((feature) => feature.lines),
    "",
    "",
  ].join("\n");
  const patched = xml.replace(
    /^([ \t]*)<application\b/m,
    (match) => `${block}${match}`,
  );
  if (patched === xml) {
    // The anchor moved (e.g. <manifest> and <application> share a line). Failing
    // loudly beats reporting success for an insertion that silently did nothing.
    fail(
      "Android manifest has no <application> line to anchor camera features to",
    );
  }
  return patched;
}

function secureStoreFileNames() {
  // Mirrors createTauriMobileProductStorageNames in mobile-kit/src/tauri-bridge.ts.
  // On Android tauri resolves both AppData and AppLocalData to the app data dir
  // itself, so all three files sit at the root backup domain.
  return [
    `${product}-mobile.hold`,
    strongholdSaltFileName(),
    `${product}-mobile-session.json`,
  ];
}

function strongholdSaltFileName() {
  // The salt file name is chosen in each shell's Rust entry point rather than
  // derived from the product key, so read it instead of guessing.
  const libPath = path.join(appDir, "src-tauri/src/lib.rs");
  const match = existsSync(libPath)
    ? /"([^"]*stronghold-salt\.bin)"/.exec(readText(libPath))
    : undefined;
  if (match) return match[1];
  const fallback = `${product}-mobile-stronghold-salt.bin`;
  warn(
    `stronghold salt file name not found in src-tauri/src/lib.rs; assuming ${fallback}`,
  );
  return fallback;
}

function keystorePreferencesFileName() {
  // The keystore plugin's SharedPreferences file holds the ciphertext whose key
  // never leaves AndroidKeyStore, so read the constant instead of guessing.
  const pluginPath = path.join(
    appDir,
    "src-tauri/plugins/keystore/android/src/main/java/KeystorePlugin.kt",
  );
  const match = existsSync(pluginPath)
    ? /PREFERENCES_NAME\s*=\s*"([^"]+)"/.exec(readText(pluginPath))
    : undefined;
  if (match) return `${match[1]}.xml`;
  warn(
    `keystore preferences name not found in src-tauri/plugins/keystore; assuming ${KEYSTORE_PREFERENCES_FALLBACK}`,
  );
  return `${KEYSTORE_PREFERENCES_FALLBACK}.xml`;
}

function renderDataExtractionRules(fileNames) {
  const preferences = keystorePreferencesFileName();
  const excludes = [
    ...fileNames.map(
      (fileName) => `        <exclude domain="root" path="${fileName}" />`,
    ),
    `        <exclude domain="sharedpref" path="${preferences}" />`,
  ].join("\n");
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    "<!--",
    "  Generated by mobile-kit/scripts/apply-tauri-mobile-android-manifest.mjs.",
    "",
    "  The secure store's AES key lives in AndroidKeyStore and is neither backed",
    "  up nor transferred, while the ciphertext beside it is. Restoring the blob",
    "  without its key makes KeystorePlugin.retrieve reject forever with",
    '  "Secure storage key is unavailable", and the Stronghold vault that blob',
    "  unlocks becomes permanently unopenable. Excluding both ends the restore in",
    "  a clean signed-out state instead.",
    "-->",
    "<data-extraction-rules>",
    "    <cloud-backup>",
    excludes,
    "    </cloud-backup>",
    "    <device-transfer>",
    excludes,
    "    </device-transfer>",
    "</data-extraction-rules>",
    "",
  ].join("\n");
}

function readText(filePath) {
  return readFileSync(filePath, "utf8");
}

function writeIfChanged(filePath, updated, label) {
  const current = existsSync(filePath) ? readText(filePath) : undefined;
  if (current === updated) {
    ok(`${label} already present: ${relative(filePath)}`);
    return;
  }
  if (dryRun) {
    warn(`${label} would be updated: ${relative(filePath)}`);
    return;
  }
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, updated);
  ok(`${label} updated: ${relative(filePath)}`);
}

function normalizePath(filePath) {
  return filePath.split(path.sep).join("/");
}

function relative(filePath) {
  return normalizePath(path.relative(appDir, filePath));
}

function ok(message) {
  results.push({ kind: "ok", message });
}

function warn(message) {
  results.push({ kind: "warn", message });
}

function fail(message) {
  results.push({ kind: "fail", message });
}

function printResults() {
  console.log(`Tauri mobile Android manifest apply: ${appDir}`);
  for (const result of results) {
    const label =
      result.kind === "ok" ? "OK" : result.kind === "warn" ? "WARN" : "FAIL";
    console.log(`${label} ${result.message}`);
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith("--")) continue;
    const key = arg
      .slice(2)
      .replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (key === "dryRun" || key === "strict") {
      parsed[key] = true;
      continue;
    }
    parsed[key] = argv[index + 1];
    index += 1;
  }
  return parsed;
}
