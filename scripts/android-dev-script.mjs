// Recognize the bounded, direct package-script form. Extra CLI options may
// still be forwarded by `bun run tauri:android:dev -- ...`; this is not a shell
// interpreter and must not accept commands that only mention Tauri or --host.
export function inspectAndroidDevScript(script) {
  const invalid = { direct: false, wildcardHost: false };
  if (typeof script !== "string" || /[\r\n\v\f\0;&|<>`$\\#*?]/.test(script)) return invalid;
  const words = [];
  let rest = script.replace(/^[ \t]+|[ \t]+$/g, "");
  while (rest) {
    const match = /^(?:"([^"]*)"|'([^']*)'|([^ \t"']+))(?:[ \t]+|$)/.exec(rest);
    if (!match) return invalid;
    if (match[3] && /[()[\]]/.test(match[3])) return invalid;
    words.push(match[1] ?? match[2] ?? match[3]);
    rest = rest.slice(match[0].length);
  }
  if (!["bunx", "tauri", "android", "dev"].every((word, i) => words[i] === word)) return invalid;
  let device = false;
  let hostSeen = false;
  let wildcardHost = false;
  for (let i = 4; i < words.length; i += 1) {
    const word = words[i];
    if (["--open", "-o", "--force-ip-prompt"].includes(word)) continue;
    if (word === "--host" || word.startsWith("--host=")) {
      if (hostSeen) return invalid;
      hostSeen = true;
      let host = word === "--host" ? undefined : word.slice(7);
      if (host === undefined && words[i + 1] && !words[i + 1].startsWith("-")) host = words[++i];
      if (host !== undefined) {
        if (!host || !/^[\w.:[\]-]+$/.test(host)) return invalid;
        wildcardHost = host === "0.0.0.0" || host === "::" || host === "[::]";
      }
      continue;
    }
    // A literal device name, including a quoted name containing spaces.
    if (device || !word || word.startsWith("-") || /[\[\]]/.test(word)) return invalid;
    device = true;
  }
  return { direct: true, wildcardHost };
}
