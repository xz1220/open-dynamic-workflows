/**
 * The environment an agent CLI starts with (an ODW extension).
 *
 * `agentEnv: "inherit"` (the default) passes ODW's whole environment, as ODW
 * always did. `"minimal"` passes only what a CLI needs to start and find its
 * home, the auth and config variables the built-in CLIs document, ODW's own
 * `ODW_*` variables, and the names or `*` globs listed in `agentEnvPass` — so
 * a cloud key, a database URL or a registry token in the shell that started
 * ODW does not reach every agent. The adapter's `env` and the agent's run
 * variables (`ODW_RUN_ID`, `ODW_AGENT_ID`, `ODW_PORT`) are layered on top
 * either way (see bridge.ts). Agent CLIs only: `exec()` commands, the
 * worktree setup and the notify hooks keep the whole environment.
 */

import type { Settings } from "./types.js";

/**
 * What any CLI needs to start: its PATH, home, user, shell, locale, terminal,
 * temp directory and time zone — and, on Windows, the system variables a
 * process cannot start without.
 */
export const BASE_ENV: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_*",
  "TERM",
  "TMPDIR",
  "TZ",
  // Windows (names match without regard to case there)
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "USERNAME",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
];

/**
 * The auth and config variables the built-in CLIs document — Claude Code
 * (ANTHROPIC_*, CLAUDE_*), Codex (OPENAI_*, CODEX_*), Gemini (GEMINI_*,
 * GOOGLE_*), Qwen (DASHSCOPE_*, QWEN_*, and OPENAI_* for its OpenAI-compatible
 * mode), Kimi (MOONSHOT_*, KIMI_*), Cursor (CURSOR_*), OpenCode (OPENCODE_*) —
 * and the proxy and CA variables Claude Code documents for corporate networks
 * (https://code.claude.com/docs/en/network-config).
 */
export const VENDOR_ENV: readonly string[] = [
  "ANTHROPIC_*",
  "CLAUDE_*",
  "OPENAI_*",
  "CODEX_*",
  "GEMINI_*",
  "GOOGLE_*",
  "DASHSCOPE_*",
  "QWEN_*",
  "MOONSHOT_*",
  "KIMI_*",
  "CURSOR_*",
  "OPENCODE_*",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
];

/**
 * `env` as an agent CLI gets it under `agentEnv`: all of it ("inherit"), or
 * only the variables {@link BASE_ENV}, {@link VENDOR_ENV}, `ODW_*` and
 * `agentEnvPass` name ("minimal"). Windows matches names without regard to
 * case, as it looks them up.
 */
export function agentBaseEnv(
  env: Record<string, string | undefined>,
  settings: Partial<Pick<Settings, "agentEnv" | "agentEnvPass">>,
  platform: NodeJS.Platform = process.platform,
): Record<string, string | undefined> {
  if (settings.agentEnv !== "minimal") return { ...env };
  const allowed = globMatcher([...BASE_ENV, ...VENDOR_ENV, "ODW_*", ...(settings.agentEnvPass ?? [])], platform === "win32");
  const out: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && allowed(name)) out[name] = value;
  }
  return out;
}

/** A test for names against `*` globs (`*` matches any run of characters, nothing else is special). */
function globMatcher(patterns: string[], ignoreCase: boolean): (name: string) => boolean {
  const alternatives = patterns.map((pattern) =>
    pattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*"),
  );
  const re = new RegExp(`^(?:${alternatives.join("|")})$`, ignoreCase ? "i" : "");
  return (name) => re.test(name);
}
