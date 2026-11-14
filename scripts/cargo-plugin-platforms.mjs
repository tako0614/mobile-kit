// Static capability coverage, not Cargo resolution or native qualification.
// Parse TOML rather than treating a negated Android predicate as mobile-only.
const platforms = ["android", "ios", "linux", "macos", "windows"];

function targetPlatforms(selector) {
  // Ignore whitespace outside strings only: "and roid" must never become Android.
  const compact = selector.replace(/"(?:[^"\\]|\\.)*"|\s+/g, (part) =>
    part.startsWith('"') ? part : "",
  );
  const cfg = /^cfg\((.*)\)$/.exec(compact);
  if (!cfg) return undefined;
  let predicate = cfg[1];
  const negated = predicate.startsWith("not(") && predicate.endsWith(")");
  if (negated) predicate = predicate.slice(4, -1);
  const any = /^any\((.*)\)$/.exec(predicate);
  const terms = any ? any[1].replace(/,$/, "").split(",") : [predicate];
  const selected = new Set();
  for (const term of terms) {
    const os = /^target_os="(android|ios|linux|macos|windows)"$/.exec(term);
    if (!os) return undefined;
    selected.add(os[1]);
  }
  return platforms.filter((os) => negated !== selected.has(os));
}

export function inspectCargoPluginPlatforms(cargoToml) {
  const issues = [];
  let manifest;
  try {
    manifest = Bun.TOML.parse(cargoToml);
  } catch {
    return { dependencies: [], issues: ["invalid Cargo.toml for plugin capability coverage"] };
  }
  const byPlugin = new Map();
  function collect(table, selector) {
    for (const [key, value] of Object.entries(table ?? {})) {
      const name = typeof value?.package === "string" ? value.package : key;
      const match = /^tauri-plugin-([a-z0-9-]+)$/.exec(name);
      if (!match) continue;
      const plugin = match[1];
      const supported = selector === undefined ? platforms : targetPlatforms(selector);
      if (supported === undefined) {
        issues.push(`unsupported Cargo target predicate for plugin ${plugin}: ${selector}`);
        continue;
      }
      const scope = byPlugin.get(plugin) ?? new Set();
      for (const os of supported) scope.add(os);
      byPlugin.set(plugin, scope);
    }
  }
  collect(manifest.dependencies);
  for (const [selector, table] of Object.entries(manifest.target ?? {})) {
    collect(table.dependencies, selector);
  }
  return {
    dependencies: [...byPlugin].filter(([, scope]) => scope.size > 0).map(([plugin, scope]) => ({
      plugin,
      mobileOnly: [...scope].every((os) => os === "android" || os === "ios"),
    })),
    issues,
  };
}
