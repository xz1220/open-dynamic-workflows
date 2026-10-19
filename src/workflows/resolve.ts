/**
 * Workflow resolution (L5): turn a `run` argument into an absolute script path.
 *
 * `odw run <arg>` accepts the argument three ways, and this module is the single
 * place that tells them apart and resolves each:
 *
 *   - a PATH (`./wf.js`, `/abs/wf.js`, `foo.js`) → used literally, exactly as the
 *     CLI always has (backward compatible);
 *   - a NAME (`deep-research`) → looked up by FILENAME STEM in a managed
 *     directory ODW or Claude Code owns, project-local first (from the
 *     directory up to the repository root, nearest first) then global;
 *   - `<plugin>:<name>` (an ODW extension) → the workflow an installed, enabled
 *     Claude Code plugin ships under that name (see ./plugins); a bare name no
 *     project or global workflow has resolves to the one plugin that ships it.
 *
 * It never compiles or runs a workflow body, so a malformed neighbour can never
 * poison resolution and listing can never execute someone else's code. The
 * managed directories are searched by stat alone; a plugin's workflows are
 * named by their `meta`, which is parsed as a literal, never evaluated. The
 * same `resolveWorkflow` is meant to back both the CLI and (in v2) the inline
 * `workflow(nameOrRef)` primitive, so the two can never resolve a name differently.
 *
 * Precedence is decided up front and is decisive: a path-shaped argument is
 * ALWAYS a file (so `odw run foo.js` is the file foo.js even if a workflow named
 * "foo" exists). Only a clean, flat name reaches the managed-directory search.
 */

import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import { resolveClaudeWorkflowsRoot, resolveWorkflowsRoot } from "../adapters/config.js";
import type { Config, TrustLevel } from "../adapters/types.js";
import { ConfigError, WorkflowScriptError } from "../errors.js";
import { projectLevels } from "../project-levels.js";
import {
  claudePluginsRoot,
  discoverPluginWorkflows,
  parsePluginRef,
  pluginOrigin,
  type PluginProvider,
  type PluginWorkflow,
} from "./plugins.js";

/** How a `run` argument was resolved: `plugin` — a workflow an installed Claude Code plugin ships (ODW extension). */
export type WorkflowOrigin = "path" | "project" | "global" | "plugin";
export type WorkflowProvider = "odw" | "claude" | PluginProvider;

export interface ResolvedWorkflow {
  /** Absolute path of the script to load and run. */
  scriptPath: string;
  origin: WorkflowOrigin;
  /** Present for named workflows; omitted for literal path runs. */
  provider?: WorkflowProvider;
  /** Human-readable root label, e.g. `.claude/workflows`, or where a plugin workflow came from. */
  rootLabel?: string;
  /** A workflow a Claude Code plugin ships (by name, or by its path): where it came from (ODW extension). */
  plugin?: PluginWorkflow;
  /** What the run should say about how the name resolved: a plugin workflow it did not pick, a project one it skipped. */
  notes?: string[];
}

export interface ResolveOptions {
  /**
   * Directory the run operates against (the run's `source`, NOT necessarily
   * `process.cwd()`). Both literal-path resolution and the project-local
   * `.odw/workflows` / `.claude/workflows` lookup are anchored here (the
   * lookup walks up from it to the repository root, nearest first), so
   * `--source` is honoured consistently for paths and names alike.
   */
  cwd: string;
  config: Config;
  /**
   * The run's trust (ODW extension; default the config's): untrusted, a name
   * never resolves to the repository's own `.odw/workflows` or
   * `.claude/workflows` — a path still runs what it names — and the
   * repository's settings cannot enable a plugin.
   */
  trust?: TrustLevel;
}

/** One non-path workflow name: letters, digits and `. _ -`, nothing else. */
const NAME_RE = /^[A-Za-z0-9._-]+$/;
const MAX_NAME_LEN = 255;

/** A managed directory names are searched in, with its precedence label. */
interface SearchRoot {
  dir: string;
  origin: "project" | "global";
  provider: WorkflowProvider;
  label: string;
}

/** Resolve a `run` argument to an absolute script path. Throws on miss/invalid. */
export function resolveWorkflow(arg: string, opts: ResolveOptions): ResolvedWorkflow {
  if (!arg || !arg.trim()) {
    throw new WorkflowScriptError("no workflow specified");
  }
  // Decide path-vs-name from the raw string, before touching the filesystem.
  if (isPathLike(arg)) return withPluginOrigin(resolveAsPath(arg, opts.cwd), opts);
  const ref = parsePluginRef(arg);
  if (ref) return resolveAsPluginRef(arg, opts);
  if (isValidName(arg)) return resolveAsName(arg, opts);
  // Not path-shaped, but not a clean name either (e.g. has a space or '@'):
  // fall back to path semantics so the user gets the familiar not-found error.
  return resolveAsPath(arg, opts.cwd);
}

/**
 * The names resolvable from `cwd`, project then global, each flagged when a
 * higher-precedence root already defines the same name. Drives `odw workflows
 * list`. Pure readdir — never opens a file.
 */
export interface WorkflowListing {
  name: string;
  origin: "project" | "global" | "plugin";
  provider: WorkflowProvider;
  rootLabel: string;
  path: string;
  /** A higher-precedence root defines this name, so this entry never wins. */
  shadowed: boolean;
  /** For a shadowed entry: the root label and path of the one that wins. */
  shadowedBy?: { rootLabel: string; path: string };
  /** A plugin workflow's bare name runs a project or global workflow instead (ODW extension). */
  note?: string;
  /** A plugin workflow: the plugin it came from (ODW extension). */
  plugin?: PluginWorkflow;
}

/**
 * The names resolvable from `cwd` (see above), then the workflows installed
 * Claude Code plugins ship, as `<plugin>:<name>` (ODW extension) — each
 * noted when its bare name runs a project or global workflow instead.
 * Reading a plugin's workflows parses their `meta`, never their body.
 */
export function listWorkflows(cwd: string, config: Config, opts: { trust?: TrustLevel } = {}): WorkflowListing[] {
  const out = listRootWorkflows(cwd, config);
  const bare = new Map(out.filter((e) => !e.shadowed).map((e) => [e.name, e]));
  for (const w of discoverPluginWorkflows({ cwd, trust: opts.trust ?? config.settings.trust }).workflows) {
    const winner = bare.get(w.workflow);
    out.push({
      name: w.name,
      origin: "plugin",
      provider: w.provider,
      rootLabel: pluginOrigin(w),
      path: w.path,
      shadowed: false,
      ...(winner ? { note: `'${w.workflow}' alone runs ${winner.rootLabel}/${basename(winner.path)} (the ${winner.origin} one wins)` } : {}),
      plugin: w,
    });
  }
  return out;
}

function listRootWorkflows(cwd: string, config: Config): WorkflowListing[] {
  const winners = new Map<string, { rootLabel: string; path: string }>();
  const out: WorkflowListing[] = [];
  for (const root of searchRoots(cwd, config)) {
    if (!existsSync(root.dir)) continue;
    // Use the SAME link-following file test as resolveAsName, so a runnable name
    // (e.g. an in-dir symlink alias) is never hidden, and a non-runnable entry
    // (dangling/dir-pointing symlink) is never listed.
    const files = readdirSync(root.dir)
      .filter((name) => name.endsWith(".js") && isRegularFile(join(root.dir, name)))
      .sort();
    for (const file of files) {
      const name = file.slice(0, -".js".length);
      const path = join(root.dir, file);
      const winner = winners.get(name);
      if (!winner) winners.set(name, { rootLabel: root.label, path });
      out.push({
        name,
        origin: root.origin,
        provider: root.provider,
        rootLabel: root.label,
        path,
        shadowed: winner !== undefined,
        ...(winner ? { shadowedBy: winner } : {}),
      });
    }
  }
  return out;
}

/** One file a name could resolve to, in precedence order (see {@link workflowCandidates}). */
export interface WorkflowCandidate {
  origin: "project" | "global";
  provider: WorkflowProvider;
  rootLabel: string;
  path: string;
}

/**
 * Every file in the managed directories a bare `name` could resolve to, in
 * precedence order — the first is the one `odw run <name>` runs (an
 * untrusted run aside, which skips the project's). Drives `odw workflows
 * where`. Pure stat — never opens a file.
 */
export function workflowCandidates(name: string, cwd: string, config: Config): WorkflowCandidate[] {
  if (!isValidName(name)) return [];
  const out: WorkflowCandidate[] = [];
  for (const root of searchRoots(cwd, config)) {
    const path = join(root.dir, `${name}.js`);
    if (isRegularFile(path)) out.push({ origin: root.origin, provider: root.provider, rootLabel: root.label, path });
  }
  return out;
}

// --- internals ---------------------------------------------------------------

/** True when `arg` should be treated as a filesystem path, not a name. */
function isPathLike(arg: string): boolean {
  return (
    arg.includes("/") || // any path separator → a path (also blocks namespacing in v1)
    arg.includes("\\") ||
    arg.startsWith(".") || // ./x  ../x  .hidden
    isAbsolute(arg) || // /x
    /^[A-Za-z]:/.test(arg) || // C:\x (Windows drive)
    /\.(?:js|mjs|cjs)$/i.test(arg) // an explicit script filename the user means literally
  );
}

/** A safe, flat workflow name (the same rule `odw run <name>` resolves by). */
export function isValidWorkflowName(arg: string): boolean {
  return arg.length > 0 && arg.length <= MAX_NAME_LEN && arg !== "." && arg !== ".." && NAME_RE.test(arg);
}

function isValidName(arg: string): boolean {
  return isValidWorkflowName(arg);
}

function resolveAsPath(arg: string, cwd: string): ResolvedWorkflow {
  const scriptPath = resolve(cwd, arg);
  if (!existsSync(scriptPath)) {
    throw new WorkflowScriptError(`workflow script not found: ${scriptPath}`);
  }
  return { scriptPath, origin: "path" };
}

function resolveAsName(name: string, opts: ResolveOptions): ResolvedWorkflow {
  const untrusted = (opts.trust ?? opts.config.settings.trust) === "untrusted";
  const roots = searchRoots(opts.cwd, opts.config);
  const notes: string[] = [];
  let found: ResolvedWorkflow | null = null;
  for (const root of roots) {
    const candidate = join(root.dir, `${name}.js`);
    if (!existsSync(candidate)) continue;
    assertContained(name, root.dir, candidate);
    if (!isRegularFile(candidate)) continue; // a dir named "<name>.js": skip, don't run
    // Untrusted (ODW extension: trust): the repository's own workflows run
    // only when their path is given — a name could shadow one of the user's.
    if (untrusted && root.origin === "project") {
      const rel = relative(opts.cwd, candidate).split(sep).join("/");
      notes.push(
        `untrusted run: not running the repository's own ${root.label}/${name}.js by name — ` +
          `pass its path (${rel.startsWith("../") ? rel : `./${rel}`}) to run it anyway`,
      );
      continue;
    }
    found = { scriptPath: candidate, origin: root.origin, provider: root.provider, rootLabel: root.label };
    break;
  }
  // A Claude Code plugin's workflow answers to its bare name too, after every
  // project and global one (ODW extension): it runs only when none has the
  // name, and only when one plugin ships it.
  const plugins = discoverPluginWorkflows({ cwd: opts.cwd, trust: opts.trust ?? opts.config.settings.trust }).workflows;
  const same = plugins.filter((w) => w.workflow === name);
  if (found) {
    for (const w of same) {
      notes.push(
        `${pluginOrigin(w)} also ships '${name}': this runs ${found.rootLabel}/${name}.js (the ${found.origin} one wins) — ` +
          `run ${w.name} for the plugin's`,
      );
    }
    return notes.length > 0 ? { ...found, notes } : found;
  }
  if (same.length === 1) return { ...pluginResolution(same[0]!), ...(notes.length > 0 ? { notes } : {}) };
  if (same.length > 1) {
    throw new WorkflowScriptError(
      `'${name}' is a workflow of ${same.length} Claude Code plugins: run one by its plugin's name — ${same.map((w) => w.name).join(", ")}`,
    );
  }
  const err = notFound(name, roots, opts.cwd);
  if (notes.length > 0) err.message += `\n${notes.join("\n")}`;
  throw err;
}

/** `<plugin>:<name>`: the workflow an installed, enabled plugin ships under that name — else a file of that name, as before. */
function resolveAsPluginRef(arg: string, opts: ResolveOptions): ResolvedWorkflow {
  const discovered = discoverPluginWorkflows({ cwd: opts.cwd, trust: opts.trust ?? opts.config.settings.trust });
  const match = discovered.workflows.find((w) => w.name === arg);
  if (match) return pluginResolution(match);
  if (existsSync(resolve(opts.cwd, arg))) return resolveAsPath(arg, opts.cwd);
  const lines = [`no workflow named '${arg}' in an installed, enabled Claude Code plugin (${claudePluginsRoot()})`];
  const names = discovered.workflows.map((w) => w.name);
  const suggestions = nearest(arg, names);
  if (suggestions.length) lines.push(`did you mean: ${suggestions.join(", ")}?`);
  else if (names.length) lines.push(`plugin workflows: ${names.slice(0, 10).join(", ")}${names.length > 10 ? ", …" : ""}`);
  lines.push(...discovered.notes);
  throw new WorkflowScriptError(lines.join("\n"));
}

function pluginResolution(w: PluginWorkflow): ResolvedWorkflow {
  return { scriptPath: w.path, origin: "plugin", provider: w.provider, rootLabel: pluginOrigin(w), plugin: w };
}

/**
 * A path inside Claude Code's plugins directory that is a workflow an
 * installed plugin ships — a rerun of a plugin workflow's run, say — keeps
 * saying where it came from (ODW extension).
 */
function withPluginOrigin(found: ResolvedWorkflow, opts: ResolveOptions): ResolvedWorkflow {
  const root = claudePluginsRoot();
  const rel = relative(root, found.scriptPath);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return found;
  const real = realpathSync(found.scriptPath);
  const w = discoverPluginWorkflows({ cwd: opts.cwd, trust: opts.trust ?? opts.config.settings.trust }).workflows.find(
    (x) => existsSync(x.path) && realpathSync(x.path) === real,
  );
  return w ? { ...found, provider: w.provider, rootLabel: pluginOrigin(w), plugin: w } : found;
}

/**
 * Project roots then global roots, deduped by realpath. The project roots
 * are every `.odw/workflows` and `.claude/workflows` from `cwd` up to its
 * repository root, nearest first — as Claude Code loads every
 * `.claude/workflows/` along that path, the one closest to the working
 * directory winning a name: in a monorepo, a package's own workflow shadows
 * the root's. At each level `.odw` comes before `.claude`, as it always has.
 * Outside a git repository only `cwd` is searched, and the walk stops below a
 * parent not owned by the current user (see ../project-levels).
 */
function searchRoots(cwd: string, config: Config): SearchRoot[] {
  const project: SearchRoot[] = [];
  for (const level of projectLevels(cwd)) {
    const rel = relative(cwd, level).split(sep).join("/");
    const prefix = rel ? `${rel}/` : "";
    project.push(
      { dir: join(level, ".odw", "workflows"), origin: "project", provider: "odw", label: `${prefix}.odw/workflows` },
      {
        dir: join(level, ".claude", "workflows"),
        origin: "project",
        provider: "claude",
        label: `${prefix}.claude/workflows`,
      },
    );
  }
  const candidates: SearchRoot[] = [
    ...project,
    {
      dir: resolveWorkflowsRoot(config.settings.workflowsRoot),
      origin: "global",
      provider: "odw",
      label: config.settings.workflowsRoot ?? "~/.odw/workflows",
    },
    {
      dir: resolveClaudeWorkflowsRoot(config.settings.claudeWorkflowsRoot),
      origin: "global",
      provider: "claude",
      label: config.settings.claudeWorkflowsRoot ?? defaultClaudeWorkflowsLabel(),
    },
  ];
  const seen = new Set<string>();
  const out: SearchRoot[] = [];
  for (const root of candidates) {
    // When cwd is itself ~/.odw, the project and global roots coincide; dedupe by
    // realpath so the same directory is not searched (or "claimed") twice.
    const key = existsSync(root.dir) ? realpathSync(root.dir) : resolve(root.dir);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(root);
  }
  return out;
}

function defaultClaudeWorkflowsLabel(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  return configDir ? `${configDir.replace(/[/\\]+$/, "")}/workflows` : "~/.claude/workflows";
}

/**
 * Refuse a candidate whose realpath escapes its root (a symlink pointing out of
 * the workflows directory). The trailing separator is required so a sibling like
 * `workflows-evil` does not pass the `startsWith` prefix test against `workflows`.
 */
function assertContained(name: string, rootDir: string, candidate: string): void {
  const realRoot = realpathSync(rootDir);
  const realCandidate = realpathSync(candidate);
  if (realCandidate !== realRoot && !realCandidate.startsWith(realRoot + sep)) {
    throw new ConfigError(`workflow '${name}' resolves outside its workflows directory (${rootDir})`);
  }
}

/** True when `p` is (or symlinks to) a regular file — the test resolveAsName gates on. */
function isRegularFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false; // missing, dangling symlink, or a race: not runnable, so not listed
  }
}

function notFound(name: string, roots: SearchRoot[], cwd: string): WorkflowScriptError {
  const known = new Set<string>();
  for (const root of roots) {
    if (!existsSync(root.dir)) continue;
    for (const file of readdirSync(root.dir)) {
      if (file.endsWith(".js") && isRegularFile(join(root.dir, file))) {
        known.add(file.slice(0, -".js".length));
      }
    }
  }
  const lines = [`no workflow named '${name}'`, "searched:"];
  for (const root of roots) lines.push(`  ${root.dir} (${root.label}, ${root.origin})`);
  const suggestions = nearest(name, [...known]);
  if (suggestions.length) lines.push(`did you mean: ${suggestions.join(", ")}?`);
  // If the user typed a name but a same-named local file exists, point them at it.
  if (isRegularFile(resolve(cwd, `${name}.js`))) {
    lines.push(`(a file ${name}.js exists here — run it with: odw run ./${name}.js)`);
  } else if (isRegularFile(resolve(cwd, name))) {
    lines.push(`(a file ${name} exists here — run it with: odw run ./${name})`);
  }
  return new WorkflowScriptError(lines.join("\n"));
}

/** Up to 3 candidate names within edit distance 2, closest first. */
function nearest(target: string, candidates: string[]): string[] {
  return candidates
    .map((c) => ({ c, d: editDistance(target, c) }))
    .filter((x) => x.d <= 2)
    .sort((a, b) => a.d - b.d || a.c.localeCompare(b.c))
    .slice(0, 3)
    .map((x) => x.c);
}

function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}
