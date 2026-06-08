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

import { existsSync, readFileSync } from "node:fs";
import { cpus, homedir } from "node:os";
import { join } from "node:path";

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
  return {
    adapters: buildAdapters((raw.adapters as Record<string, RawAdapter>) ?? {}),
    settings: buildSettings(raw),
  };
}

/** Config from built-ins only — handy for tests and programmatic use. */
export function defaultConfig(): Config {
  return { adapters: buildAdapters({}), settings: { ...DEFAULT_SETTINGS } };
}

/**
 * Resolve an adapter by name, falling back to the configured default (or the
 * sole adapter). Raises {@link AdapterNotFound} with the available names listed.
 */
export function resolveAdapter(config: Config, name?: string | null): Adapter {
  const chosen = name ?? config.settings.defaultAdapter;
  const available = Object.keys(config.adapters).sort();
  if (!chosen) {
    if (available.length === 1) return config.adapters[available[0]!]!;
    throw new AdapterNotFound(
      `no adapter specified and no defaultAdapter set; available: ${available.join(", ")}`,
    );
  }
  const adapter = config.adapters[chosen];
  if (!adapter) {
    throw new AdapterNotFound(`unknown adapter '${chosen}'; available: ${available.join(", ")}`);
  }
  return adapter;
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
