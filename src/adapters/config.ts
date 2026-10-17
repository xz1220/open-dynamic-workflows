/**
 * Configuration loader (L1).
 *
 * A {@link Config} is the immutable description of *which* agent CLIs exist
 * ({@link Adapter}) and *how* a run behaves ({@link Settings}). It is loaded once
 * at run start and then only read.
 *
 * Config sources, highest priority first:
 *   1. an explicit path passed to {@link loadConfig}
 *   2. `$ODW_CONFIG`
 *   3. `./odw.config.json`
 *   4. `~/.config/odw/config.json`
 *
 * Built-in adapters and default settings are always present as a base layer; any
 * file found above is merged on top, so a user only specifies what they change.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, homedir } from "node:os";
import { dirname, join } from "node:path";

import { AdapterNotFound, ConfigError } from "../errors.js";
import { BUILTIN_ADAPTERS, DEFAULT_SETTINGS, type RawAdapter } from "./builtin.js";
import { isOnPath } from "./executable.js";
import type { Adapter, AdapterFlags, AdapterOutput, Config, Settings } from "./types.js";

export const CONFIG_ENV_VAR = "ODW_CONFIG";

/**
 * Load configuration, merging any discovered file over the built-ins.
 * `quiet` suppresses the stderr lint warnings — for preflight checks that load
 * the same file a subsequent full load will lint anyway (else they'd print twice).
 * `cwd` overrides where the project-local `./odw.config.json` is searched —
 * pass the run's --source dir so a launch preflight sees the same file the
 * worker (spawned with cwd = source) will actually load.
 */
export function loadConfig(
  path?: string | null,
  opts?: { quiet?: boolean; cwd?: string },
): Config {
  const raw = readRaw(path, opts?.cwd);
  if (!opts?.quiet) {
    for (const w of collectConfigWarnings(raw)) {
      process.stderr.write(`odw: config warning: ${w}\n`);
    }
  }
  return {
    adapters: buildAdapters((raw.adapters as Record<string, RawAdapter>) ?? {}),
    settings: buildSettings(raw),
  };
}

// Every key buildSettings reads, plus the adapters map. Anything else in a
// config file is dead weight the user almost certainly meant to be live.
const KNOWN_TOP_KEYS = [
  "adapters",
  "defaultAdapter",
  "concurrency",
  "maxAgents",
  "timeout",
  "stallTimeout",
  "stallRestarts",
  "schemaRetries",
  "runsRoot",
  "workflowsRoot",
  "claudeWorkflowsRoot",
  "claudeJobsScope",
] as const;

const KNOWN_ADAPTER_KEYS = ["command", "stdin", "env", "timeout", "stallTimeout", "label", "flags", "output"] as const;

/**
 * Lint a parsed config object for keys odw would silently ignore.
 *
 * Settings are read flat off the top level, so a nested `"settings": {…}`
 * wrapper or a misspelled key falls back to defaults with no error — which once
 * cost a real debugging session (a nested key was silently ignored and the run
 * behaved as if unconfigured). Surface those as warnings instead.
 */
export function collectConfigWarnings(raw: Record<string, unknown>): string[] {
  const warnings: string[] = [];
  for (const key of Object.keys(raw)) {
    if ((KNOWN_TOP_KEYS as readonly string[]).includes(key)) continue;
    if (key.startsWith("$") || key.startsWith("//")) continue; // comment conventions
    const nested = raw[key];
    const nestedKnown =
      nested !== null && typeof nested === "object" && !Array.isArray(nested)
        ? Object.keys(nested).filter((k) => (KNOWN_TOP_KEYS as readonly string[]).includes(k))
        : [];
    if (nestedKnown.length > 0) {
      warnings.push(
        `"${key}" is not a config key and everything inside it is IGNORED — ` +
          `odw reads settings from the top level; move ${nestedKnown.map((k) => `"${k}"`).join(", ")} up one level`,
      );
      continue;
    }
    const guess = nearestKey(key, KNOWN_TOP_KEYS);
    warnings.push(`unknown key "${key}" is ignored${guess ? ` — did you mean "${guess}"?` : ""}`);
  }
  const adapters = raw.adapters;
  if (adapters !== null && typeof adapters === "object" && !Array.isArray(adapters)) {
    for (const [name, spec] of Object.entries(adapters as Record<string, unknown>)) {
      if (spec === null || typeof spec !== "object" || Array.isArray(spec)) continue;
      for (const key of Object.keys(spec)) {
        if ((KNOWN_ADAPTER_KEYS as readonly string[]).includes(key)) continue;
        if (key.startsWith("$") || key.startsWith("//")) continue;
        const guess = nearestKey(key, KNOWN_ADAPTER_KEYS);
        warnings.push(
          `adapter "${name}": unknown field "${key}" is ignored${guess ? ` — did you mean "${guess}"?` : ""}`,
        );
      }
    }
  }
  return warnings;
}

/** Closest known key within an edit distance of 2, for did-you-mean hints. */
function nearestKey(key: string, known: readonly string[]): string | null {
  const lower = key.toLowerCase();
  let best: string | null = null;
  let bestDist = 3;
  for (const k of known) {
    const d = editDistance(lower, k.toLowerCase());
    if (d < bestDist) {
      bestDist = d;
      best = k;
    }
  }
  return best;
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length)]);
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length]![b.length]!;
}

/** Config from built-ins only — handy for tests and programmatic use. */
export function defaultConfig(): Config {
  return { adapters: buildAdapters({}), settings: { ...DEFAULT_SETTINGS } };
}

/**
 * Resolve an adapter by name, falling back to the configured default, the sole
 * configured adapter, or — so a fresh install works with zero config — the sole
 * adapter whose CLI is actually installed. Raises {@link AdapterNotFound} with
 * the available names and how to pick one.
 */
export function resolveAdapter(config: Config, name?: string | null): Adapter {
  const chosen = name ?? config.settings.defaultAdapter;
  const available = Object.keys(config.adapters).sort();
  if (!chosen) {
    if (available.length === 1) return config.adapters[available[0]!]!;
    const installed = available.filter((n) => isOnPath(config.adapters[n]!.command[0]!));
    if (installed.length === 1) return config.adapters[installed[0]!]!;
    const found =
      installed.length > 0
        ? `installed here: ${installed.join(", ")}`
        : "none of their CLIs were found on PATH";
    // Name a REAL installed adapter in every suggested fix — a copy-pasteable
    // remediation is the whole error UX for non-interactive (agent) callers.
    const pick = installed[0] ?? available[0]!;
    throw new AdapterNotFound(
      `no adapter specified and no defaultAdapter set; available: ${available.join(", ")} (${found}). ` +
        `Fix: run 'odw init' to pick a default (non-interactive: odw init --adapter ${pick}); ` +
        `or pass --adapter ${pick} to odw run; ` +
        `or set "defaultAdapter" in odw.config.json; ` +
        `or name one per call: agent(prompt, { adapter: "${pick}" })`,
    );
  }
  const adapter = config.adapters[chosen];
  if (!adapter) {
    throw new AdapterNotFound(`unknown adapter '${chosen}'; available: ${available.join(", ")}`);
  }
  return adapter;
}

/** Result of persisting a default-adapter choice. */
export interface DefaultAdapterWrite {
  /** The config file the default was written to. */
  path: string;
  /** Set when a higher-priority config source will shadow the file written. */
  shadowWarning: string | null;
}

/**
 * Persist `defaultAdapter` into the config file a future run will read: an
 * explicit path (`--config`), else `$ODW_CONFIG`, else the user-global
 * `~/.config/odw/config.json` (created if absent). Existing keys are kept;
 * formatting is normalized to 2-space JSON.
 *
 * The user-global target sits at the BOTTOM of the search order, so when a
 * `./odw.config.json` would shadow it the caller gets a warning to surface —
 * a silently ineffective write is this codebase's most expensive bug class.
 */
export function writeDefaultAdapter(
  name: string,
  explicitPath?: string | null,
): DefaultAdapterWrite {
  const env = process.env[CONFIG_ENV_VAR];
  const target = explicitPath
    ? expandHome(explicitPath)
    : env
      ? expandHome(env)
      : join(homeDir(), ".config", "odw", "config.json");
  let raw: Record<string, unknown> = {};
  if (existsSync(target)) {
    const text = readFileSync(target, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new ConfigError(`could not parse config ${target}: ${(err as Error).message}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ConfigError(`config ${target} must be a JSON object`);
    }
    raw = parsed as Record<string, unknown>;
  }
  raw.defaultAdapter = name;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(raw, null, 2) + "\n");

  let shadowWarning: string | null = null;
  if (!explicitPath && !env) {
    const cwdConfig = join(process.cwd(), "odw.config.json");
    if (existsSync(cwdConfig)) {
      shadowWarning =
        `${cwdConfig} takes precedence over ${target} — ` +
        `runs started from this directory will ignore the default just written`;
    }
  }
  return { path: target, shadowWarning };
}

/** One adapter row shown in settings and config diagnostics. */
export interface AdapterListing {
  name: string;
  /** Display label (adapter.label, else the name). */
  label: string;
  /** Whether the CLI's executable resolves on PATH right now. */
  installed: boolean;
  /** Whether this is the configured defaultAdapter. */
  isDefault: boolean;
  /**
   * The adapter's permission posture in one human-readable line, derived from
   * its command flags — shown before a user lets it loose on a directory.
   */
  permissionNote: string;
}

/** Every configured adapter with install/default/permission info, sorted by name. */
export function listAdapters(config: Config): AdapterListing[] {
  return Object.keys(config.adapters)
    .sort()
    .map((name) => {
      const a = config.adapters[name]!;
      return {
        name,
        label: a.label ?? name,
        installed: isOnPath(a.command[0]!),
        isDefault: config.settings.defaultAdapter === name,
        permissionNote: permissionNote(a.command),
      };
    });
}

/**
 * Derive a one-line permission summary from known CLI flags (else the command).
 * Handles both `--flag value` and `--flag=value` spellings — the `=` form is
 * common and a security-transparency note that missed it would silently
 * under-report the most dangerous (`--sandbox=danger-full-access`,
 * `--permission-mode=bypassPermissions`) configurations.
 */
function permissionNote(command: string[]): string {
  const notes: string[] = [];
  /** The value of `flag`, whether spelled `--flag value` or `--flag=value`. */
  const valueOf = (flag: string, i: number): string | null => {
    const arg = command[i]!;
    if (arg === flag) return command[i + 1] ?? null;
    if (arg.startsWith(flag + "=")) return arg.slice(flag.length + 1) || null;
    return null;
  };
  for (let i = 0; i < command.length; i++) {
    const arg = command[i]!;
    const pm = valueOf("--permission-mode", i);
    const sb = valueOf("--sandbox", i);
    const am = valueOf("--approval-mode", i);
    if (pm) notes.push(`permission mode: ${pm}`);
    else if (sb) notes.push(`sandbox: ${sb}`);
    else if (am) notes.push(`approval mode: ${am}`);
    else if (arg === "--dangerously-skip-permissions") notes.push("full autonomy (permission prompts skipped)");
    else if (arg === "--yolo" || arg === "--full-auto") notes.push("full autonomy");
    else if (arg === "--auto") {
      notes.push(command[0] === "kilo" ? "full autonomy" : "full autonomy (explicit denies remain)");
    } else if (arg === "--force") {
      notes.push("full autonomy (explicit denies remain)");
    }
  }
  return notes.length ? notes.join(" · ") : `runs: ${command[0]}`;
}

export { executableCandidates, isOnPath } from "./executable.js";

/** Concrete concurrency cap, auto-derived from CPU count when unset. */
export function resolveConcurrency(concurrency: number | null): number {
  if (concurrency !== null) return Math.max(1, concurrency);
  const n = cpus().length || 4;
  return Math.max(1, Math.min(16, n - 2));
}

/** Directory runs are stored under; defaults to `~/.odw/runs`. */
export function resolveRunsRoot(runsRoot: string | null): string {
  return runsRoot ? expandHome(runsRoot) : join(homeDir(), ".odw", "runs");
}

/** Directory workflows are resolved by name from; defaults to `~/.odw/workflows`. */
export function resolveWorkflowsRoot(workflowsRoot: string | null): string {
  return workflowsRoot ? expandHome(workflowsRoot) : join(homeDir(), ".odw", "workflows");
}

/**
 * Directory Claude Code saved workflows are resolved by name from.
 *
 * Claude Code lets `CLAUDE_CONFIG_DIR` relocate every `~/.claude` path, so this
 * mirrors that rule for the personal workflow directory.
 */
export function resolveClaudeWorkflowsRoot(claudeWorkflowsRoot: string | null): string {
  if (claudeWorkflowsRoot) return expandHome(claudeWorkflowsRoot);
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  return join(configDir ? expandHome(configDir) : join(homeDir(), ".claude"), "workflows");
}

/**
 * Root of Claude Code's per-project session store (`~/.claude/projects`), where
 * Claude Code writes its OWN workflow runs — terminal journals under
 * `<encoded-cwd>/<session>/workflows/wf_<id>.json` and live progress under
 * `<encoded-cwd>/<session>/subagents/workflows/wf_<id>/`. Honors `CLAUDE_CONFIG_DIR`
 * exactly like {@link resolveClaudeWorkflowsRoot}, so a relocated `~/.claude` is
 * followed for runs too.
 */
export function resolveClaudeProjectsRoot(claudeProjectsRoot?: string | null): string {
  if (claudeProjectsRoot) return expandHome(claudeProjectsRoot);
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  return join(configDir ? expandHome(configDir) : join(homeDir(), ".claude"), "projects");
}

// --- internals ---------------------------------------------------------------

function homeDir(): string {
  return process.env.HOME?.trim() || homedir();
}

function expandHome(p: string): string {
  if (p === "~") return homeDir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homeDir(), p.slice(2));
  return p;
}

/**
 * The config file `loadConfig` would read for these arguments — an explicit
 * path, `$ODW_CONFIG`, then the discovered locations — or null for built-in
 * defaults. Throws ConfigError when an explicit path or $ODW_CONFIG is missing.
 */
export function locateConfig(path?: string | null, cwd?: string): string | null {
  return locate(path, cwd);
}

function readRaw(path?: string | null, cwd?: string): Record<string, unknown> {
  const located = locate(path, cwd);
  if (located === null) return {};
  let text: string;
  try {
    text = readFileSync(located, "utf8");
  } catch (err) {
    throw new ConfigError(`could not read config ${located}: ${(err as Error).message}`);
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ConfigError(`config ${located} must be a JSON object`);
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(`could not parse config ${located}: ${(err as Error).message}`);
  }
}

function locate(path?: string | null, cwd?: string): string | null {
  if (path) {
    const p = expandHome(path);
    if (!existsSync(p)) throw new ConfigError(`config file not found: ${p}`);
    return p;
  }
  const env = process.env[CONFIG_ENV_VAR];
  if (env) {
    const p = expandHome(env);
    if (!existsSync(p)) throw new ConfigError(`${CONFIG_ENV_VAR} points to a missing file: ${p}`);
    return p;
  }
  for (const candidate of [
    join(cwd ?? process.cwd(), "odw.config.json"),
    join(homeDir(), ".config", "odw", "config.json"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function buildAdapters(user: Record<string, RawAdapter>): Record<string, Adapter> {
  const merged: Record<string, RawAdapter> = { ...BUILTIN_ADAPTERS, ...user };
  const out: Record<string, Adapter> = {};
  for (const [name, spec] of Object.entries(merged)) {
    out[name] = buildAdapter(name, spec);
  }
  if (Object.keys(out).length === 0) throw new ConfigError("no adapters configured");
  return out;
}

function buildAdapter(name: string, spec: RawAdapter): Adapter {
  const command = spec.command;
  if (!Array.isArray(command) || command.length === 0 || !command.every((p) => typeof p === "string")) {
    throw new ConfigError(`adapter '${name}' must have a non-empty 'command' array of strings`);
  }
  if (spec.env !== undefined && (typeof spec.env !== "object" || spec.env === null)) {
    throw new ConfigError(`adapter '${name}' 'env' must be an object`);
  }
  const adapter: Adapter = { name, command: [...command] };
  if (spec.stdin !== undefined) adapter.stdin = spec.stdin;
  if (spec.env !== undefined) {
    adapter.env = Object.fromEntries(Object.entries(spec.env).map(([k, v]) => [k, String(v)]));
  }
  // null means "not set": the adapter inherits the run-wide timeout.
  if (spec.timeout !== undefined && spec.timeout !== null) {
    adapter.timeout = numberSetting(`adapter '${name}' 'timeout'`, spec.timeout, "a positive number of seconds", {
      min: 0,
      exclusiveMin: true,
    });
  }
  // Likewise for the stall watchdog; 0 turns it off for this CLI alone.
  if (spec.stallTimeout !== undefined && spec.stallTimeout !== null) {
    adapter.stallTimeout = numberSetting(
      `adapter '${name}' 'stallTimeout'`,
      spec.stallTimeout,
      "a positive number of seconds, or 0 to turn the stall watchdog off",
      { min: 0 },
    );
  }
  if (spec.label !== undefined) adapter.label = spec.label;
  if (spec.flags !== undefined) adapter.flags = buildFlags(name, spec.flags);
  if (spec.output !== undefined) adapter.output = buildOutput(name, spec.output);
  return adapter;
}

/** Validate and normalise an adapter's capability declaration. */
function buildFlags(name: string, raw: unknown): AdapterFlags {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`adapter '${name}' 'flags' must be an object`);
  }
  const out: AdapterFlags = {};
  const model = (raw as Record<string, unknown>).model;
  if (model !== undefined) {
    if (!Array.isArray(model) || !model.every((p) => typeof p === "string")) {
      throw new ConfigError(`adapter '${name}' 'flags.model' must be an array of strings`);
    }
    out.model = [...(model as string[])];
  }
  return out;
}

/** Validate and normalize an adapter's stdout decoding declaration. */
function buildOutput(name: string, raw: unknown): AdapterOutput {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`adapter '${name}' 'output' must be an object`);
  }
  const value = raw as Record<string, unknown>;
  if (value.format === "text") return { format: "text" };
  if (value.format !== "jsonl") {
    throw new ConfigError(`adapter '${name}' 'output.format' must be 'text' or 'jsonl'`);
  }
  if (typeof value.eventType !== "string" || !value.eventType.trim()) {
    throw new ConfigError(`adapter '${name}' 'output.eventType' must be a non-empty string`);
  }
  if (
    !Array.isArray(value.textPath) ||
    value.textPath.length === 0 ||
    !value.textPath.every((segment) => typeof segment === "string" && segment.length > 0)
  ) {
    throw new ConfigError(`adapter '${name}' 'output.textPath' must be a non-empty array of strings`);
  }
  if (value.select !== "last") {
    throw new ConfigError(`adapter '${name}' 'output.select' must be 'last'`);
  }
  return {
    format: "jsonl",
    eventType: value.eventType,
    textPath: [...(value.textPath as string[])],
    select: "last",
  };
}

/**
 * Read a numeric config value: a JSON number or a numeric string ("8"), as
 * before. Anything else — or a value out of range — is a {@link ConfigError}
 * naming the key. Coercing blindly let `"concurrency": "auto"` become NaN,
 * which deadlocked every dispatch; NaN timeouts and caps failed just as quietly.
 */
function numberSetting(
  key: string,
  raw: unknown,
  expected: string,
  rule: { min: number; exclusiveMin?: boolean; integer?: boolean },
): number {
  const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
  const inRange = rule.exclusiveMin ? value > rule.min : value >= rule.min;
  if (!Number.isFinite(value) || !inRange || (rule.integer && !Number.isInteger(value))) {
    throw new ConfigError(`${key} must be ${expected}; got ${JSON.stringify(raw)}`);
  }
  return value;
}

function buildSettings(raw: Record<string, unknown>): Settings {
  const pick = <T>(key: keyof Settings, fallback: T): T =>
    raw[key as string] === undefined || raw[key as string] === null
      ? fallback
      : (raw[key as string] as T);
  const num = <F extends number | null>(
    key: keyof Settings,
    fallback: F,
    expected: string,
    rule: { min: number; exclusiveMin?: boolean; integer?: boolean },
  ): number | F => {
    const value = raw[key as string];
    return value === undefined || value === null ? fallback : numberSetting(`"${key}"`, value, expected, rule);
  };
  return {
    defaultAdapter: pick("defaultAdapter", DEFAULT_SETTINGS.defaultAdapter),
    concurrency: num("concurrency", DEFAULT_SETTINGS.concurrency, "a positive integer, or null for auto", {
      min: 1,
      integer: true,
    }),
    maxAgents: num("maxAgents", DEFAULT_SETTINGS.maxAgents, "a positive integer", { min: 1, integer: true }),
    timeout: num("timeout", DEFAULT_SETTINGS.timeout, "a positive number of seconds, or null for no timeout", {
      min: 0,
      exclusiveMin: true,
    }),
    // 0 is accepted as "off", like null.
    stallTimeout:
      num(
        "stallTimeout",
        DEFAULT_SETTINGS.stallTimeout,
        "a positive number of seconds, or null for no stall watchdog",
        { min: 0 },
      ) || null,
    stallRestarts: num("stallRestarts", DEFAULT_SETTINGS.stallRestarts, "a non-negative integer", {
      min: 0,
      integer: true,
    }),
    schemaRetries: num("schemaRetries", DEFAULT_SETTINGS.schemaRetries, "a non-negative integer", {
      min: 0,
      integer: true,
    }),
    runsRoot: pick("runsRoot", DEFAULT_SETTINGS.runsRoot),
    workflowsRoot: pick("workflowsRoot", DEFAULT_SETTINGS.workflowsRoot),
    claudeWorkflowsRoot: pick("claudeWorkflowsRoot", DEFAULT_SETTINGS.claudeWorkflowsRoot),
    // Only "project" narrows; anything else (incl. null/garbage) keeps the "all" default.
    claudeJobsScope: raw["claudeJobsScope"] === "project" ? "project" : DEFAULT_SETTINGS.claudeJobsScope,
  };
}
