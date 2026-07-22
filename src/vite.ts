import { fileURLToPath, URL } from "node:url";

export interface CreateTauriMobileViteConfigInput {
  readonly devPort: number;
  readonly importMetaUrl: string;
  /** Override for product repos that are not nested at `<product>/mobile`. */
  readonly mobileKitRootUrl?: string;
  /** Resolve an installed file/workspace package instead of source aliases. */
  readonly resolveMobileKitFromPackage?: boolean;
  readonly plugins?: readonly unknown[];
  readonly env?: {
    readonly TAURI_DEV_HOST?: string | undefined;
  };
}

export function createTauriMobileViteConfig(
  input: CreateTauriMobileViteConfigInput,
) {
  const host = (input.env ?? process.env).TAURI_DEV_HOST;
  const mobileKitRoot = input.mobileKitRootUrl
    ? new URL(input.mobileKitRootUrl, input.importMetaUrl)
    : new URL("../mobile-kit/", input.importMetaUrl);
  return {
    plugins: [...(input.plugins ?? [])],
    resolve: {
      preserveSymlinks: input.resolveMobileKitFromPackage === true,
      alias: input.resolveMobileKitFromPackage
        ? {}
        : {
            "@takosjp/mobile-kit/solid": fileURLToPath(
              new URL("src/solid.ts", mobileKitRoot),
            ),
            "@takosjp/mobile-kit": fileURLToPath(
              new URL("src/index.ts", mobileKitRoot),
            ),
          },
    },
    optimizeDeps: input.resolveMobileKitFromPackage
      ? {
          exclude: [
            "@takosjp/mobile-kit",
            "@takosjp/mobile-kit/solid",
            "@takosjp/mobile-kit/vite",
          ],
        }
      : undefined,
    server: {
      port: input.devPort,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
            protocol: "ws",
            host,
            port: input.devPort + 1,
          }
        : undefined,
      fs: {
        allow: [fileURLToPath(new URL("../..", input.importMetaUrl))],
      },
      // Rust build scripts (libsodium-sys-stable の autoconf 等) が
      // `src-tauri/target/` に symlink loop を含む一時ファイルを作るため、
      // watcher が walk すると ELOOP で dev server ごと落ちる。 Rust 側は
      // cargo が watch するので Vite は `src-tauri` を丸ごと見ない。
      watch: {
        ignored: ["**/src-tauri/**"],
      },
    },
    clearScreen: false,
  };
}
