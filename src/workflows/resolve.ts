/**
 * Workflow resolution (L5): turn a `run` argument into an absolute script path.
 *
 * `odw run <arg>` accepts the argument two ways, and this module is the single
 * place that tells them apart and resolves each:
 *
 *   - a PATH (`./wf.js`, `/abs/wf.js`, `foo.js`) → used literally, exactly as the
 *     CLI always has (backward compatible);
 *   - a NAME (`deep-research`) → looked up by FILENAME STEM in a managed
 *     directory ODW or Claude Code owns, project-local first then global.
 *
 * It is a PURE path/fs-stat resolver: it never reads, parses, or compiles a
 * workflow body, so a malformed neighbour can never poison resolution and
 * listing can never execute someone else's code. The same `resolveWorkflow` is
 * meant to back both the CLI and (in v2) the inline `workflow(nameOrRef)`
 * primitive, so the two can never resolve a name differently.
 *
 * Precedence is decided up front and is decisive: a path-shaped argument is
 * ALWAYS a file (so `odw run foo.js` is the file foo.js even if a workflow named
 * "foo" exists). Only a clean, flat name reaches the managed-directory search.
 */

import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

import { resolveClaudeWorkflowsRoot, resolveWorkflowsRoot } from "../adapters/config.js";
import type { Config } from "../adapters/types.js";
import { ConfigError, WorkflowScriptError } from "../errors.js";

/** How a `run` argument was resolved. */
export type WorkflowOrigin = "path" | "project" | "global";
export type WorkflowProvider = "odw" | "claude";

export interface ResolvedWorkflow {
  /** Absolute path of the script to load and run. */
  scriptPath: string;
  origin: WorkflowOrigin;
  /** Present for named workflows; omitted for literal path runs. */
  provider?: WorkflowProvider;
  /** Human-readable root label, e.g. `.claude/workflows`. */
  rootLabel?: string;
}

export interface ResolveOptions {
  /**
   * Directory the run operates against (the run's `source`, NOT necessarily
   * `process.cwd()`). Both literal-path resolution and the project-local
   * `.odw/workflows` / `.claude/workflows` lookup are anchored here, so
   * `--source` is honoured consistently for paths and names alike.
   */
  cwd: string;
  config: Config;
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
  if (isPathLike(arg)) return resolveAsPath(arg, opts.cwd);
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
  origin: "project" | "global";
  provider: WorkflowProvider;
  rootLabel: string;
  path: string;
  /** A higher-precedence root defines this name, so this entry never wins. */
  shadowed: boolean;
}

export function listWorkflows(cwd: string, config: Config): WorkflowListing[] {
  const winners = new Set<string>();
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
      const shadowed = winners.has(name);
      if (!shadowed) winners.add(name);
      out.push({
        name,
        origin: root.origin,
        provider: root.provider,
        rootLabel: root.label,
        path: join(root.dir, file),
        shadowed,
      });
    }
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

function isValidName(arg: string): boolean {
  return arg.length <= MAX_NAME_LEN && arg !== "." && arg !== ".." && NAME_RE.test(arg);
}

function resolveAsPath(arg: string, cwd: string): ResolvedWorkflow {
  const scriptPath = resolve(cwd, arg);
  if (!existsSync(scriptPath)) {
    throw new WorkflowScriptError(`workflow script not found: ${scriptPath}`);
  }
  return { scriptPath, origin: "path" };
}

function resolveAsName(name: string, opts: ResolveOptions): ResolvedWorkflow {
  const roots = searchRoots(opts.cwd, opts.config);
  for (const root of roots) {
    const candidate = join(root.dir, `${name}.js`);
    if (!existsSync(candidate)) continue;
    assertContained(name, root.dir, candidate);
    if (!isRegularFile(candidate)) continue; // a dir named "<name>.js": skip, don't run
    return { scriptPath: candidate, origin: root.origin, provider: root.provider, rootLabel: root.label };
  }
  throw notFound(name, roots, opts.cwd);
}

/** Project roots then global roots, deduped by realpath. */
function searchRoots(cwd: string, config: Config): SearchRoot[] {
  const candidates: SearchRoot[] = [
    { dir: join(cwd, ".odw", "workflows"), origin: "project", provider: "odw", label: ".odw/workflows" },
    {
      dir: join(cwd, ".claude", "workflows"),
      origin: "project",
      provider: "claude",
      label: ".claude/workflows",
    },
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
