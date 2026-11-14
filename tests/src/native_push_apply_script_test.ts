import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));
const scriptPath = path.join(
  rootDir,
  "scripts/apply-tauri-mobile-push-native.mjs",
);

for (const kotlinDsl of [true, false]) {
  test(`custom ${kotlinDsl ? "Kotlin" : "Groovy"} Google Services configuration is refused before any project mutation`, () => {
    const appDir = mkdtempSync(path.join(tmpdir(), "takos-mobile-push-custom-"));
    try {
      seedGeneratedNativeProject(appDir);
      const suffix = kotlinDsl ? ".gradle.kts" : ".gradle";
      const appPath = `src-tauri/gen/android/app/build${suffix}`;
      if (!kotlinDsl) {
        rmSync(path.join(appDir, "src-tauri/gen/android/app/build.gradle.kts"));
        rmSync(path.join(appDir, "src-tauri/gen/android/build.gradle.kts"));
        write(appDir, "src-tauri/gen/android/build.gradle", "plugins {\n    id 'com.android.application' version '8.5.0' apply false\n}\n");
      }
      for (const configuration of [
        "googleServices { disableVersionCheck = true }",
        'extensions.getByName("googleServices")',
        'tasks.named("processDebugGoogleServices")',
        kotlinDsl ? 'apply(from = "firebase.gradle.kts")' : "apply from: 'firebase.gradle'",
        kotlinDsl ? 'apply(from = "tauri.build.gradle.kts")' : "apply from: 'tauri.build.gradle'",
      ]) {
        write(appDir, `src-tauri/gen/android/app/tauri.build${suffix}`, "googleServices { disableVersionCheck = true }\n");
        write(appDir, `src-tauri/gen/android/app/firebase${suffix}`, "googleServices { disableVersionCheck = true }\n");
        const pluginLine = kotlinDsl ? '    id("com.google.gms.google-services")' : "    id 'com.google.gms.google-services'";
        write(appDir, appPath, `plugins {\n${pluginLine}\n}\n${configuration}\n`);
        const paths = [appPath, `src-tauri/gen/android/build${suffix}`, "src-tauri/gen/android/settings.gradle", "src-tauri/gen/apple/App.entitlements", `src-tauri/gen/android/app/tauri.build${suffix}`, `src-tauri/gen/android/app/firebase${suffix}`];
        const before = paths.map((file) => read(appDir, file));
        const result = spawnSync("bun", [scriptPath, "--app-dir", appDir, "--apple-environment", "development"], { encoding: "utf8" });
        expect(result.status).toBe(1);
        expect(result.stdout).toContain("refusing automatic migration before mutation");
        expect(paths.map((file) => read(appDir, file))).toEqual(before);
      }
    } finally {
      rmSync(appDir, { recursive: true, force: true });
    }
  });

  test(`existing ${kotlinDsl ? "Kotlin" : "Groovy"} push wiring becomes conditional without relaxing strict verification`, () => {
    const appDir = mkdtempSync(path.join(tmpdir(), "takos-mobile-push-migrate-"));
    try {
      seedGeneratedNativeProject(appDir);
      rmSync(path.join(appDir, "src-tauri/gen/android/app/google-services.json"));
      const suffix = kotlinDsl ? ".gradle.kts" : ".gradle";
      const appPath = `src-tauri/gen/android/app/build${suffix}`;
      if (!kotlinDsl) {
        rmSync(path.join(appDir, "src-tauri/gen/android/app/build.gradle.kts"));
        rmSync(path.join(appDir, "src-tauri/gen/android/build.gradle.kts"));
        write(appDir, "src-tauri/gen/android/build.gradle", "plugins {\n    id 'com.android.application' version '8.5.0' apply false\n}\n");
      }
      const pluginLine = kotlinDsl ? '    id("com.google.gms.google-services")' : "    id 'com.google.gms.google-services'";
      const generated = kotlinDsl ? 'apply(from = "tauri.build.gradle.kts")' : "apply from: 'tauri.build.gradle'";
      write(appDir, `src-tauri/gen/android/app/tauri.build${suffix}`, "// Generated Tauri dependencies.\n");
      write(appDir, appPath, `plugins {\n${pluginLine}\n}\n${generated}\n\ndependencies {\n}\n`);
      const apply = () => spawnSync("bun", [scriptPath, "--app-dir", appDir, "--platform", "android"], { encoding: "utf8" });
      const result = apply();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("google-services.json is missing");
      const migrated = read(appDir, appPath);
      expect(migrated).not.toContain(pluginLine);
      expect(migrated).toContain(kotlinDsl ? 'if (file("google-services.json").exists())' : "if (file('google-services.json').exists())");
      expect(migrated).toContain(kotlinDsl ? 'apply(plugin = "com.google.gms.google-services")' : "apply plugin: 'com.google.gms.google-services'");
      expect(read(appDir, `src-tauri/gen/android/build${suffix}`)).toContain("apply false");
      expect(apply().status).toBe(0);
      expect(read(appDir, appPath)).toBe(migrated);
      const verify = spawnSync("bun", [scriptPath, "--app-dir", appDir, "--platform", "android", "--dry-run", "--strict"], { encoding: "utf8" });
      expect(verify.status).toBe(1);
      expect(verify.stdout).toContain("google-services.json is missing");
      expect(read(appDir, appPath)).toBe(migrated);
    } finally {
      rmSync(appDir, { recursive: true, force: true });
    }
  });
}

for (const dictionary of ["<dict/>", "<dict />"]) {
  test(`Apple push wiring handles XcodeGen's empty ${dictionary} plist`, () => {
    const appDir = mkdtempSync(path.join(tmpdir(), "takos-mobile-push-empty-"));
    try {
      seedGeneratedNativeProject(appDir);
      const file = "src-tauri/gen/apple/App.entitlements";
      write(appDir, file, `<?xml version="1.0"?><plist version="1.0">\n${dictionary}\n</plist>\n`);
      const apply = (environment: string, extra: string[] = []) => spawnSync("bun", [
        scriptPath, "--app-dir", appDir, "--platform", "ios",
        "--apple-environment", environment, "--strict", ...extra,
      ], { encoding: "utf8" });
      const result = apply("development");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("iOS aps-environment entitlement updated");
      const updated = read(appDir, file);
      expect(updated).toContain("<key>aps-environment</key>\n\t<string>development</string>");
      expect(updated.match(/<key>aps-environment<\/key>/g)).toHaveLength(1);
      expect(apply("development").status).toBe(0);
      expect(read(appDir, file)).toBe(updated);
      expect(apply("production", ["--dry-run"]).status).toBe(1);
      expect(read(appDir, file)).toBe(updated);
      expect(apply("production").status).toBe(0);
      expect(read(appDir, file)).toContain("<string>production</string>");
    } finally {
      rmSync(appDir, { recursive: true, force: true });
    }
  });
}

test("native push apply script patches generated iOS and Android projects", () => {
  const appDir = mkdtempSync(path.join(tmpdir(), "takos-mobile-push-"));
  try {
    seedGeneratedNativeProject(appDir);

    const result = spawnSync(
      "bun",
      [scriptPath, "--app-dir", appDir, "--apple-environment", "production"],
      {
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("iOS aps-environment entitlement updated");
    expect(result.stdout).toContain(
      "Android app Firebase Messaging Gradle wiring updated",
    );
    expect(read(appDir, "src-tauri/gen/apple/App.entitlements")).toContain(
      "<string>production</string>",
    );
    expect(read(appDir, "src-tauri/gen/android/build.gradle.kts")).toContain(
      'id("com.google.gms.google-services") version "4.5.0" apply false',
    );
    expect(read(appDir, "src-tauri/gen/android/settings.gradle")).toContain(
      "google()",
    );
    expect(
      read(appDir, "src-tauri/gen/android/app/build.gradle.kts"),
    ).toContain(
      'implementation(platform("com.google.firebase:firebase-bom:34.15.0"))',
    );
    expect(
      read(appDir, "src-tauri/gen/android/app/build.gradle.kts"),
    ).toContain('implementation("com.google.firebase:firebase-installations")');
    expect(
      read(appDir, "src-tauri/gen/android/app/build.gradle.kts"),
    ).toContain('implementation("com.google.firebase:firebase-messaging")');
    expect(
      read(appDir, "src-tauri/gen/android/app/src/main/AndroidManifest.xml"),
    ).not.toContain("FCMService");

    const second = spawnSync(
      "bun",
      [scriptPath, "--app-dir", appDir, "--apple-environment", "production"],
      {
        encoding: "utf8",
      },
    );
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("already present");
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

test("native push apply script strictly verifies generated wiring without mutation", () => {
  const appDir = mkdtempSync(path.join(tmpdir(), "takos-mobile-push-"));
  try {
    seedGeneratedNativeProject(appDir);

    const before = read(appDir, "src-tauri/gen/android/app/build.gradle.kts");
    const dryRun = spawnSync(
      "bun",
      [
        scriptPath,
        "--app-dir",
        appDir,
        "--apple-environment",
        "development",
        "--dry-run",
        "--strict",
      ],
      {
        encoding: "utf8",
      },
    );

    expect(dryRun.status).toBe(1);
    expect(dryRun.stdout).toContain("would be updated");
    expect(read(appDir, "src-tauri/gen/android/app/build.gradle.kts")).toBe(
      before,
    );

    const apply = spawnSync(
      "bun",
      [scriptPath, "--app-dir", appDir, "--apple-environment", "development"],
      { encoding: "utf8" },
    );
    expect(apply.status).toBe(0);

    const verify = spawnSync(
      "bun",
      [
        scriptPath,
        "--app-dir",
        appDir,
        "--apple-environment",
        "development",
        "--dry-run",
        "--strict",
      ],
      {
        encoding: "utf8",
      },
    );
    expect(verify.status).toBe(0);
    expect(verify.stdout).toContain("already present");
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

test("native push production verification rejects development entitlements", () => {
  const appDir = mkdtempSync(path.join(tmpdir(), "takos-mobile-push-"));
  try {
    seedGeneratedNativeProject(appDir);
    const developmentApply = spawnSync(
      "bun",
      [scriptPath, "--app-dir", appDir, "--apple-environment", "development"],
      { encoding: "utf8" },
    );
    expect(developmentApply.status).toBe(0);

    const productionAgainstDevelopment = spawnSync(
      "bun",
      [
        scriptPath,
        "--app-dir",
        appDir,
        "--apple-environment",
        "production",
        "--dry-run",
        "--strict",
      ],
      { encoding: "utf8" },
    );
    expect(productionAgainstDevelopment.status).toBe(1);
    expect(productionAgainstDevelopment.stdout).toContain("would be updated");

    const productionApply = spawnSync(
      "bun",
      [scriptPath, "--app-dir", appDir, "--apple-environment", "production"],
      { encoding: "utf8" },
    );
    expect(productionApply.status).toBe(0);

    const productionVerify = spawnSync(
      "bun",
      [
        scriptPath,
        "--app-dir",
        appDir,
        "--apple-environment",
        "production",
        "--dry-run",
        "--strict",
      ],
      { encoding: "utf8" },
    );
    expect(productionVerify.status).toBe(0);

    const developmentAgainstProduction = spawnSync(
      "bun",
      [
        scriptPath,
        "--app-dir",
        appDir,
        "--apple-environment",
        "development",
        "--dry-run",
        "--strict",
      ],
      { encoding: "utf8" },
    );
    expect(developmentAgainstProduction.status).toBe(1);
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

test("native push apply script strict mode fails on missing generated projects", () => {
  const appDir = mkdtempSync(path.join(tmpdir(), "takos-mobile-push-"));
  try {
    const result = spawnSync(
      "bun",
      [
        scriptPath,
        "--app-dir",
        appDir,
        "--apple-environment",
        "development",
        "--dry-run",
        "--strict",
      ],
      {
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("src-tauri/gen/apple is missing");
    expect(result.stdout).toContain("src-tauri/gen/android is missing");
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

test("native push apply script can verify one generated platform", () => {
  const appDir = mkdtempSync(path.join(tmpdir(), "takos-mobile-push-"));
  try {
    seedGeneratedNativeProject(appDir);
    const appleBefore = read(appDir, "src-tauri/gen/apple/App.entitlements");

    const applyAndroid = spawnSync(
      "bun",
      [scriptPath, "--app-dir", appDir, "--platform", "android"],
      { encoding: "utf8" },
    );
    expect(applyAndroid.status).toBe(0);
    expect(applyAndroid.stdout).toContain(
      "Tauri mobile push native apply (android)",
    );
    expect(applyAndroid.stdout).not.toContain("iOS aps-environment");
    expect(read(appDir, "src-tauri/gen/apple/App.entitlements")).toBe(
      appleBefore,
    );

    const verifyAndroid = spawnSync(
      "bun",
      [
        scriptPath,
        "--app-dir",
        appDir,
        "--platform",
        "android",
        "--dry-run",
        "--strict",
      ],
      { encoding: "utf8" },
    );
    expect(verifyAndroid.status).toBe(0);
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

function seedGeneratedNativeProject(appDir: string) {
  write(
    appDir,
    "src-tauri/gen/apple/App.entitlements",
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0">',
      "<dict>",
      "</dict>",
      "</plist>",
      "",
    ].join("\n"),
  );
  write(
    appDir,
    "src-tauri/gen/android/build.gradle.kts",
    [
      "plugins {",
      '    id("com.android.application") version "8.5.0" apply false',
      "}",
      "",
    ].join("\n"),
  );
  write(
    appDir,
    "src-tauri/gen/android/app/build.gradle.kts",
    [
      "plugins {",
      '    id("com.android.application")',
      "}",
      "",
      "dependencies {",
      "}",
      "",
    ].join("\n"),
  );
  write(appDir, "src-tauri/gen/android/app/google-services.json", "{}\n");
  write(
    appDir,
    "src-tauri/gen/android/settings.gradle",
    "include ':app'\n\napply from: 'tauri.settings.gradle'\n",
  );
  write(
    appDir,
    "src-tauri/gen/android/app/src/main/AndroidManifest.xml",
    [
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android">',
      '    <application android:theme="@style/AppTheme">',
      "    </application>",
      "</manifest>",
      "",
    ].join("\n"),
  );
}

function write(appDir: string, relativePath: string, text: string) {
  const filePath = path.join(appDir, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, text);
}

function read(appDir: string, relativePath: string) {
  return readFileSync(path.join(appDir, relativePath), "utf8");
}
