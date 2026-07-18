import { expect, test } from "bun:test";
import { createTauriMobileViteConfig } from "../../src/vite.ts";

test("createTauriMobileViteConfig builds shared mobile dev-server wiring", () => {
  const config = createTauriMobileViteConfig({
    devPort: 1420,
    importMetaUrl: "file:///repo/takos/mobile/vite.config.ts",
    plugins: ["solid-plugin"],
    env: { TAURI_DEV_HOST: "192.0.2.10" },
  });

  expect(config.plugins).toEqual(["solid-plugin"]);
  expect(config.resolve.alias["@takosjp/takosumi-mobile-kit"]).toBe(
    "/repo/takosumi/mobile-kit/src/index.ts",
  );
  expect(config.resolve.alias["@takosjp/takosumi-mobile-kit/solid"]).toBe(
    "/repo/takosumi/mobile-kit/src/solid.ts",
  );
  expect(config.server).toEqual({
    port: 1420,
    strictPort: true,
    host: "192.0.2.10",
    hmr: {
      protocol: "ws",
      host: "192.0.2.10",
      port: 1421,
    },
    fs: {
      allow: ["/repo/"],
    },
  });
  expect(config.clearScreen).toBe(false);
});

test("createTauriMobileViteConfig keeps desktop dev server local by default", () => {
  const config = createTauriMobileViteConfig({
    devPort: 1421,
    importMetaUrl: "file:///repo/yurucommu-mobile/vite.config.ts",
    env: {},
  });

  expect(config.server.host).toBe(false);
  expect(config.server.hmr).toBeUndefined();
});

test("createTauriMobileViteConfig keeps source packages out of dev prebundling", () => {
  const config = createTauriMobileViteConfig({
    devPort: 1430,
    importMetaUrl: "file:///repo/yurucommu-mobile/vite.config.ts",
    resolveMobileKitFromPackage: true,
    env: {},
  });

  expect(config.resolve.preserveSymlinks).toBe(true);
  expect(config.resolve.alias).toEqual({});
  expect(config.optimizeDeps?.exclude).toContain(
    "@takosjp/takosumi-mobile-kit/solid",
  );
  expect(config.optimizeDeps?.exclude).toContain("takosumi-contract");
});
