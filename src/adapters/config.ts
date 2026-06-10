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

import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { cpus, homedir } from "node:os";
import { delimiter, join } from "node:path";

import { AdapterNotFound, ConfigError } from "../errors.js";
import { BUILTIN_ADAPTERS, DEFAULT_SETTINGS, type RawAdapter } from "./builtin.js";
import type { Adapter, AdapterFlags, Config, Settings } from "./types.js";

export const CONFIG_ENV_VAR = "ODW_CONFIG";

const SEARCH_PATHS = [
  join(process.cwd(), "odw.config.json"),
  join(homedir(), ".config", "odw", "config.json"),
];

/** Load configuration, merging any discovered file over the built-ins. */
export function loadConfig(path?: string | null): Config {
  const raw = readRaw(path);
  for (const w of collectConfigWarnings(raw)) {
    process.stderr.write(`odw: config warning: ${w}\n`);
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
  "workspaceMode",
  "timeout",
  "schemaRetries",
  "runsRoot",
  "workflowsRoot",
  "claudeWorkflowsRoot",
  "claudeJobsScope",
] as const;

const KNOWN_ADAPTER_KEYS = ["command", "stdin", "env", "timeout", "label", "flags"] as const;

/**
 * Lint a parsed config object for keys odw would silently ignore.
 *
 * Settings are read flat off the top level, so a nested `"settings": {…}`
 * wrapper or a misspelled key falls back to defaults with no error — which once
 * cost a real debugging session (`workspaceMode` quietly reverted to `copy` and
 * in-place edits evaporated). Surface those as warnings instead.
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
    throw new AdapterNotFound(
      `no adapter specified and no defaultAdapter set; available: ${available.join(", ")} (${found}). ` +
        `Set "defaultAdapter" in odw.config.json, or pass one per call: agent(prompt, { adapter: "claude" })`,
    );
  }
  const adapter = config.adapters[chosen];
  if (!adapter) {
    throw new AdapterNotFound(`unknown adapter '${chosen}'; available: ${available.join(", ")}`);
  }
  return adapter;
}

/** One row of `GET /api/adapters` / the Launch view's agent picker. */
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

/** Derive a one-line permission summary from known CLI flags (else the command). */
function permissionNote(command: string[]): string {
  const notes: string[] = [];
  for (let i = 0; i < command.length; i++) {
    const arg = command[i]!;
    const next = command[i + 1];
    if (arg === "--permission-mode" && next) notes.push(`permission mode: ${next}`);
    else if (arg === "--dangerously-skip-permissions") notes.push("full autonomy (permission prompts skipped)");
    else if (arg === "--sandbox" && next) notes.push(`sandbox: ${next}`);
    else if (arg === "--approval-mode" && next) notes.push(`approval mode: ${next}`);
    else if (arg === "--yolo" || arg === "--full-auto") notes.push("full autonomy");
  }
  return notes.length ? notes.join(" · ") : `runs: ${command[0]}`;
}

/** Whether an adapter's executable resolves on the current PATH. */
export function isOnPath(cmd: string): boolean {
  if (cmd.includes("/")) return existsSync(expandHome(cmd));
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, cmd), constants.X_OK);
      return true;
    } catch {
      /* keep looking */
    }
  }
  return false;
}

/** Concrete concurrency cap, auto-derived from CPU count when unset. */
export function resolveConcurrency(concurrency: number | null): number {
  if (concurrency !== null) return Math.max(1, concurrency);
  const n = cpus().length || 4;
  return Math.max(1, Math.min(16, n - 2));
}

/** Directory runs are stored under; defaults to `~/.odw/runs`. */
export function resolveRunsRoot(runsRoot: string | null): string {
  return runsRoot ? expandHome(runsRoot) : join(homedir(), ".odw", "runs");
}

/** Directory workflows are resolved by name from; defaults to `~/.odw/workflows`. */
export function resolveWorkflowsRoot(workflowsRoot: string | null): string {
  return workflowsRoot ? expandHome(workflowsRoot) : join(homedir(), ".odw", "workflows");
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
  return join(configDir ? expandHome(configDir) : join(homedir(), ".claude"), "workflows");
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
  return join(configDir ? expandHome(configDir) : join(homedir(), ".claude"), "projects");
}

// --- internals ---------------------------------------------------------------

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function readRaw(path?: string | null): Record<string, unknown> {
  const located = locate(path);
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

function locate(path?: string | null): string | null {
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
  for (const candidate of SEARCH_PATHS) {
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
  if (spec.timeout !== undefined) adapter.timeout = Number(spec.timeout);
  if (spec.label !== undefined) adapter.label = spec.label;
  if (spec.flags !== undefined) adapter.flags = buildFlags(name, spec.flags);
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

function buildSettings(raw: Record<string, unknown>): Settings {
  const pick = <T>(key: keyof Settings, fallback: T): T =>
    raw[key as string] === undefined || raw[key as string] === null
      ? fallback
      : (raw[key as string] as T);
  const numOrNull = (key: keyof Settings, fallback: number | null): number | null =>
    raw[key as string] === undefined || raw[key as string] === null
      ? fallback
      : Number(raw[key as string]);
  return {
    defaultAdapter: pick("defaultAdapter", DEFAULT_SETTINGS.defaultAdapter),
    concurrency: numOrNull("concurrency", DEFAULT_SETTINGS.concurrency),
    maxAgents: Number(pick("maxAgents", DEFAULT_SETTINGS.maxAgents)),
    workspaceMode: pick("workspaceMode", DEFAULT_SETTINGS.workspaceMode),
    timeout: numOrNull("timeout", DEFAULT_SETTINGS.timeout),
    schemaRetries: Number(pick("schemaRetries", DEFAULT_SETTINGS.schemaRetries)),
    runsRoot: pick("runsRoot", DEFAULT_SETTINGS.runsRoot),
    workflowsRoot: pick("workflowsRoot", DEFAULT_SETTINGS.workflowsRoot),
    claudeWorkflowsRoot: pick("claudeWorkflowsRoot", DEFAULT_SETTINGS.claudeWorkflowsRoot),
    // Only "project" narrows; anything else (incl. null/garbage) keeps the "all" default.
    claudeJobsScope: raw["claudeJobsScope"] === "project" ? "project" : DEFAULT_SETTINGS.claudeJobsScope,
  };
}
