/**
 * Workflows shipped in installed Claude Code plugins (an ODW extension).
 *
 * A Claude Code plugin can ship workflow scripts — the same dialect as a saved
 * workflow — in its `workflows/` directory, or wherever its manifest's
 * `workflows` field points instead ("Path, or array of paths … Replaces the
 * default `workflows/` scan", https://code.claude.com/docs/en/plugins/manifest-reference).
 * Claude Code runs one as `/<plugin>:<meta.name>` ("Plugin workflows are
 * namespaced by the plugin name", https://code.claude.com/docs/en/workflows);
 * ODW runs it as `odw run <plugin>:<meta.name>`.
 *
 * Discovery reads, and only reads, what Claude Code keeps on disk
 * (https://code.claude.com/docs/en/plugins/loading):
 *
 *   - the plugins root: `$CLAUDE_CODE_PLUGIN_CACHE_DIR`, else `plugins/` under
 *     `$CLAUDE_CONFIG_DIR` (default `~/.claude`);
 *   - its `installed_plugins.json`: each install by id (`name@marketplace`)
 *     with its `scope`, `installPath` and `version` — a `project` or `local`
 *     install applies only under its `projectPath`;
 *   - whether each is enabled: `enabledPlugins` (`"name@marketplace": bool`)
 *     in the user's settings.json, then the project's `.claude/settings.json`
 *     and `.claude/settings.local.json` — later wins — else the manifest's
 *     `defaultEnabled` (default true; a marketplace entry's override of it and
 *     managed settings are not read). In an untrusted run the repository's
 *     settings may disable a plugin, never enable one;
 *   - each enabled plugin's `.claude-plugin/plugin.json` (optional): its
 *     `name` (the namespace) and `workflows`.
 *
 * A script is listed by its `meta`, read through the dual-compat audit
 * (../dual-compat): parsed, never run; one whose meta is not a pure literal is
 * left out, as Claude Code leaves it out. Nothing here writes, and a script
 * runs in place from the plugin's own directory, through the same loader as
 * any workflow. Paths that leave a plugin's directory are refused.
 */

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import { homeDir } from "../adapters/config.js";
import type { TrustLevel } from "../adapters/types.js";
import { checkMeta, workflowStem } from "../dual-compat.js";
import { readWorkflowMeta, type WorkflowMeta } from "../loader.js";

/** A plugin's name, or a workflow's within it: what `<plugin>:<name>` is made of. */
const PART = /^[A-Za-z0-9._-]+$/;

/** `<plugin>:<name>`, as `odw run` takes it (a single letter before the colon is a Windows drive). */
const QUALIFIED = /^([A-Za-z0-9._-]{2,}):([A-Za-z0-9._-]+)$/;

/** The provider a plugin's workflows are listed under: `claude-plugin:<plugin>`. */
export type PluginProvider = `claude-plugin:${string}`;

/** One workflow an installed, enabled Claude Code plugin ships. */
export interface PluginWorkflow {
  /** `<plugin>:<meta.name>`: what `odw run` takes. */
  name: string;
  /** Its own name in the plugin: `meta.name`. */
  workflow: string;
  /** The plugin's name (its manifest's), the namespace. */
  plugin: string;
  provider: PluginProvider;
  /** The install's id: `name@marketplace`. */
  id: string;
  version: string | null;
  /** Where it was installed: `user`, `project`, `local` or `managed`. */
  scope: string;
  /** The installed plugin's directory. */
  installPath: string;
  /** The script, absolute. */
  path: string;
  meta: WorkflowMeta | null;
}

/** What discovery found, and what it left out and why (for `odw workflows list` and a run's log). */
export interface PluginDiscovery {
  workflows: PluginWorkflow[];
  notes: string[];
}

export interface PluginDiscoveryOptions {
  /** The project directory: its `.claude/settings*.json` and where project-scoped installs apply. */
  cwd: string;
  /** Untrusted (ODW extension: trust): the project's settings may disable a plugin, never enable one. */
  trust?: TrustLevel;
}

/** Claude Code's configuration directory: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeConfigDir(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (!dir) return join(homeDir(), ".claude");
  return dir === "~" || dir.startsWith("~/") ? join(homeDir(), dir.slice(2)) : dir;
}

/** Where Claude Code keeps installed plugins: `$CLAUDE_CODE_PLUGIN_CACHE_DIR`, else `<config dir>/plugins`. */
export function claudePluginsRoot(): string {
  const dir = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR?.trim();
  return dir ? dir : join(claudeConfigDir(), "plugins");
}

/** `<plugin>:<name>` split, or null for anything else. */
export function parsePluginRef(arg: string): { plugin: string; name: string } | null {
  const m = QUALIFIED.exec(arg);
  return m ? { plugin: m[1]!, name: m[2]! } : null;
}

/** One installed, enabled plugin that applies in the project: what its workflows and agents are read from. */
export interface EnabledPlugin {
  /** The install's id: `name@marketplace`. */
  id: string;
  /** Its manifest's name (else the id's), the namespace. */
  plugin: string;
  version: string | null;
  scope: string;
  installPath: string;
  /** Its `.claude-plugin/plugin.json`, or `{}` without one. */
  manifest: Record<string, unknown>;
}

/** The installed, enabled plugins that apply in `opts.cwd`, by id; what was left out goes in `notes`. */
export function enabledPluginInstalls(opts: PluginDiscoveryOptions, notes: string[]): EnabledPlugin[] {
  const root = claudePluginsRoot();
  const installed = readJson(join(root, "installed_plugins.json"));
  if (!isObject(installed) || !isObject(installed.plugins)) return [];
  const enabled = enabledPlugins(opts);
  const out: EnabledPlugin[] = [];
  for (const id of Object.keys(installed.plugins).sort()) {
    const record = applicableInstall(installed.plugins[id], opts.cwd);
    if (!record) continue;
    const manifest = readJson(join(record.installPath, ".claude-plugin", "plugin.json"));
    const spec = isObject(manifest) ? manifest : {};
    const on = enabled.get(id) ?? (spec.defaultEnabled === false ? false : true);
    if (!on) continue;
    const plugin = typeof spec.name === "string" && spec.name ? spec.name : id.split("@")[0]!;
    if (!PART.test(plugin)) {
      notes.push(`plugin ${id}: its name '${plugin}' cannot name a workflow (letters, digits, . _ - only); left out`);
      continue;
    }
    out.push({ id, plugin, version: record.version, scope: record.scope, installPath: record.installPath, manifest: spec });
  }
  return out;
}

/** Every workflow the installed, enabled plugins ship, by name; what was left out goes in `notes`. */
export function discoverPluginWorkflows(opts: PluginDiscoveryOptions): PluginDiscovery {
  const notes: string[] = [];
  const out: PluginWorkflow[] = [];
  const seen = new Set<string>();
  for (const { id, plugin, version, scope, installPath, manifest } of enabledPluginInstalls(opts, notes)) {
    for (const path of pluginFiles(installPath, manifest.workflows, "workflows", ".js", id, notes)) {
      const found = auditedMeta(path, id, notes);
      if (!found) continue;
      const name = `${plugin}:${found.name}`;
      if (seen.has(name)) {
        notes.push(`plugin ${id}: ${path} is another workflow named '${name}'; the first one wins`);
        continue;
      }
      seen.add(name);
      out.push({
        name,
        workflow: found.name,
        plugin,
        provider: `claude-plugin:${plugin}`,
        id,
        version,
        scope,
        installPath,
        path,
        meta: found.meta,
      });
    }
  }
  return { workflows: out, notes };
}

/** Where a plugin workflow came from, in one line: for `odw workflows` and the run's log. */
export function pluginOrigin(w: Pick<PluginWorkflow, "id" | "version" | "scope">): string {
  return `Claude Code plugin ${w.id}${w.version ? ` ${w.version}` : ""} (${w.scope} scope)`;
}

// --- internals ---------------------------------------------------------------

interface InstallRecord {
  installPath: string;
  version: string | null;
  scope: string;
}

/** Scopes from the most specific: a project's own install wins over the user's. */
const SCOPE_ORDER = ["local", "project", "user", "managed"];

/**
 * The install of a plugin that applies in `cwd`: a `project` or `local` one
 * whose `projectPath` holds `cwd`, else a `user` or `managed` one. Records
 * come as a list (version 2 of the file) or as one object.
 */
function applicableInstall(raw: unknown, cwd: string): InstallRecord | null {
  const records = (Array.isArray(raw) ? raw : [raw]).filter(isObject);
  const usable: InstallRecord[] = [];
  for (const r of records) {
    if (typeof r.installPath !== "string" || !isAbsolute(r.installPath)) continue;
    const scope = typeof r.scope === "string" ? r.scope : "user";
    if (scope === "project" || scope === "local") {
      if (typeof r.projectPath !== "string" || !inside(r.projectPath, cwd)) continue;
    }
    if (!isDirectory(r.installPath)) continue;
    usable.push({ installPath: r.installPath, version: typeof r.version === "string" ? r.version : null, scope });
  }
  const rank = (scope: string): number => {
    const at = SCOPE_ORDER.indexOf(scope);
    return at === -1 ? SCOPE_ORDER.length : at;
  };
  return usable.sort((a, b) => rank(a.scope) - rank(b.scope))[0] ?? null;
}

/**
 * `enabledPlugins`, merged key by key: the user's settings, then the
 * project's and its local settings. Untrusted, the project's may only say false.
 */
function enabledPlugins(opts: PluginDiscoveryOptions): Map<string, boolean> {
  const merged = new Map<string, boolean>();
  const layers: Array<{ path: string; project: boolean }> = [
    { path: join(claudeConfigDir(), "settings.json"), project: false },
    { path: join(opts.cwd, ".claude", "settings.json"), project: true },
    { path: join(opts.cwd, ".claude", "settings.local.json"), project: true },
  ];
  for (const layer of layers) {
    const settings = readJson(layer.path);
    const map = isObject(settings) && isObject(settings.enabledPlugins) ? settings.enabledPlugins : {};
    for (const [id, value] of Object.entries(map)) {
      if (typeof value !== "boolean") continue;
      if (layer.project && value && opts.trust === "untrusted") continue;
      merged.set(id, value);
    }
  }
  return merged;
}

/**
 * The `ext` files a plugin ships under one manifest field: those the field
 * names (files, or directories scanned one level), else its `<dir>/`
 * directory — `.js` workflows under `workflows`, `.md` agents under `agents`.
 * A manifest path must start with `./` and stay inside the plugin.
 */
export function pluginFiles(installPath: string, declared: unknown, dir: string, ext: string, id: string, notes: string[]): string[] {
  const listed =
    declared === undefined || declared === null ? null : Array.isArray(declared) ? declared : [declared];
  const entries: string[] = [];
  if (listed === null) {
    entries.push(join(installPath, dir));
  } else {
    for (const entry of listed) {
      if (typeof entry !== "string" || !entry.startsWith("./")) {
        notes.push(`plugin ${id}: its manifest's ${dir} entry ${JSON.stringify(entry)} is not a ./ path; left out`);
        continue;
      }
      entries.push(resolve(installPath, entry));
    }
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (!inside(installPath, entry)) {
      notes.push(`plugin ${id}: ${entry} lies outside the plugin; left out`);
      continue;
    }
    let files: string[];
    if (isDirectory(entry)) {
      files = readdirSafe(entry)
        .filter((name) => name.endsWith(ext))
        .sort()
        .map((name) => join(entry, name));
    } else if (entry.endsWith(ext)) {
      files = [entry];
    } else {
      if (listed !== null) notes.push(`plugin ${id}: its manifest's ${dir} entry ${entry} is not a ${ext} file or a directory; left out`);
      continue;
    }
    for (const file of files) {
      if (isFile(file) && inside(installPath, file)) out.push(file);
    }
  }
  return out;
}

/** A script's meta, through the dual-compat audit: null (with a note) when it is not a pure literal with a usable name. */
function auditedMeta(path: string, id: string, notes: string[]): { name: string; meta: WorkflowMeta | null } | null {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (err) {
    notes.push(`plugin ${id}: could not read ${path}: ${(err as Error).message}`);
    return null;
  }
  const audit = checkMeta(source);
  if (!audit.pure) {
    notes.push(`plugin ${id}: ${basename(path)} is left out — ${audit.reason}`);
    return null;
  }
  let meta: WorkflowMeta | null = null;
  try {
    meta = readWorkflowMeta(source, path);
  } catch {
    meta = null;
  }
  const name = audit.name && PART.test(audit.name) ? audit.name : null;
  if (name) return { name, meta };
  const stem = workflowStem(path);
  notes.push(`plugin ${id}: ${basename(path)} has no usable meta.name; listed by its file name '${stem}'`);
  return PART.test(stem) ? { name: stem, meta } : null;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Whether `path` (links resolved) is `root` or under it. */
function inside(root: string, path: string): boolean {
  const rel = relative(real(root), real(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
