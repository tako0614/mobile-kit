import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Read release identity from product-owned source files. CLI arguments may
 * assert these values, but never become their authority.
 */
export function inspectMobileReleaseIdentity(appDir) {
  const issues = [];
  const tauriPath = path.join(appDir, "src-tauri/tauri.conf.json");
  const productPath = path.join(appDir, "src/product.ts");
  const tauriConfig = readJson(tauriPath, issues);
  const productSource = readText(productPath, issues);
  const productMatch =
    /(?:^|[\s{,])product:\s*["']([^"']+)["']/m.exec(productSource);
  const product = productMatch?.[1]?.trim();
  const productName = text(tauriConfig?.productName);
  const bundleId = text(tauriConfig?.identifier);

  if (!product) {
    issues.push({
      id: "identity.product_missing",
      detail: "src/product.ts does not declare a literal adapter product key.",
    });
  }
  if (!productName) {
    issues.push({
      id: "identity.product_name_missing",
      detail: "src-tauri/tauri.conf.json does not declare productName.",
    });
  }
  if (!bundleId) {
    issues.push({
      id: "identity.bundle_id_missing",
      detail: "src-tauri/tauri.conf.json does not declare identifier.",
    });
  }

  return {
    product,
    productName,
    bundleId,
    tauriConfig,
    issues,
  };
}

function readJson(filePath, issues) {
  const source = readText(filePath, issues);
  if (!source) return undefined;
  try {
    return JSON.parse(source);
  } catch (error) {
    issues.push({
      id: "identity.tauri_config_invalid",
      detail: `src-tauri/tauri.conf.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    });
    return undefined;
  }
}

function readText(filePath, issues) {
  if (!existsSync(filePath)) {
    issues.push({
      id: "identity.source_missing",
      detail: `${path.basename(filePath)} is missing from the mobile app.`,
    });
    return "";
  }
  return readFileSync(filePath, "utf8");
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
