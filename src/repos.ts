/**
 * Multi-repository runs (U6; an ODW extension — Claude Code's Workflow tool
 * works in one repository).
 *
 * A run works in its source repository. It may also name other repositories,
 * each by an alias: the `repos` setting (`{ "api": "../api" }`, relative to
 * the run's source, `~` allowed) and `odw run --repo api=../api` (relative to
 * where odw runs; it overrides the setting's alias of the same name, and is
 * kept in the run's meta for `odw rerun`, `resume` and `replay`). A
 * workflow's `meta.repos` lists the aliases it needs: a run without one of
 * them fails before any agent starts.
 *
 * `agent(p, { repo: "api" })` runs its CLI in that repository — with
 * `isolation: "worktree"` in a worktree of it, its diff kept as any isolated
 * agent's and applied there by `odw apply`; its `expect`, `untouched` and
 * `scope` read that repository, and scoped calls wait only for overlapping
 * scopes in the same one. In place, the repository gets a safety snapshot of
 * its own before the first agent that may change it (`odw restore <run>
 * --repo api`). `exec(cmd, { repo })` runs a command there, `cwd` relative to
 * it. An alias the run does not declare is refused — never a path: a script
 * cannot point an agent at an arbitrary directory.
 *
 * An untrusted run (see ./untrusted) reads no repository's paths from the
 * repository's own config: an alias it names outside the source repository is
 * dropped, and said so. The user's own config and `--repo` still name any.
 */

import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { expandHome } from "./adapters/config.js";
import { ConfigError } from "./errors.js";
import { LOG, event, type WorkflowEvent } from "./events.js";
import { SafetySnapshot } from "./safety.js";
import { ScopeLocks } from "./scope.js";

/** What an alias may be: a letter, then letters, digits, `_` and `-` (at most 64). */
const ALIAS = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** Whether `name` is a valid repository alias. */
export function isRepoAlias(name: unknown): name is string {
  return typeof name === "string" && ALIAS.test(name);
}

const ALIAS_RULE = "a letter, then letters, digits, _ or - (at most 64)";

/** One repository a run may work in besides its source: its alias and its git top level. */
export interface RunRepo {
  name: string;
  /** The repository's top level, links resolved. */
  path: string;
  /** Where it was named: `--repo` or the config's `repos`. */
  from: "flag" | "config";
}

/** Validate the `repos` setting: `{ "<alias>": "<path>" }`. */
export function buildRepos(raw: unknown): Record<string, string> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(`"repos" must be an object of alias → path, like { "api": "../api" }; got ${JSON.stringify(raw)}`);
  }
  const out: Record<string, string> = {};
  for (const [name, path] of Object.entries(raw as Record<string, unknown>)) {
    if (!isRepoAlias(name)) throw new ConfigError(`"repos": '${name}' is not an alias — ${ALIAS_RULE}`);
    if (typeof path !== "string" || path.trim() === "") {
      throw new ConfigError(`"repos.${name}" must be the path of a git repository (a non-empty string); got ${JSON.stringify(path)}`);
    }
    out[name] = path.trim();
  }
  return out;
}

/**
 * `odw run --repo name=path` (repeatable): each alias and its path made
 * absolute against `cwd`. Throws a ConfigError naming the bad one; an alias
 * given twice is refused.
 */
export function parseRepoFlags(values: readonly string[], cwd: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const value of values) {
    const at = value.indexOf("=");
    const name = at === -1 ? value : value.slice(0, at);
    const path = at === -1 ? "" : value.slice(at + 1).trim();
    if (!isRepoAlias(name)) throw new ConfigError(`--repo ${JSON.stringify(value)}: '${name}' is not an alias — ${ALIAS_RULE}`);
    if (path === "") throw new ConfigError(`--repo ${JSON.stringify(value)}: give it as name=path, e.g. --repo ${name}=../${name}`);
    if (name in out) throw new ConfigError(`--repo: '${name}' is given twice`);
    out[name] = resolve(cwd, expandHome(path));
  }
  return out;
}

/** The `--repo` aliases a run's meta keeps (`meta.repos`), when they are well-formed (untrusted JSON). */
export function repoFlagsOf(raw: unknown): Record<string, string> | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  for (const [name, path] of Object.entries(raw as Record<string, unknown>)) {
    if (isRepoAlias(name) && typeof path === "string" && isAbsolute(path)) out[name] = path;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** The top level of the git repository at `path`; a ConfigError when it is not one. */
export function repoTop(name: string, path: string): string {
  let dir = false;
  try {
    dir = statSync(path).isDirectory();
  } catch {
    // reported below
  }
  if (!dir) throw new ConfigError(`repository '${name}': ${path} is not a directory`);
  let top: string;
  try {
    top = execFileSync("git", ["-C", path, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      windowsHide: true,
    }).trim();
  } catch {
    top = "";
  }
  if (!top) throw new ConfigError(`repository '${name}': ${path} is not in a git repository — the repositories a run names must be git repositories`);
  return real(top);
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Whether `path` is `root` or lies under it. */
function inside(root: string, path: string): boolean {
  const rel = relative(real(root), real(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * The repositories a run works in besides its source: the setting's, with
 * `--repo` over them. In an untrusted run whose config is the repository's
 * own (`repositoryConfig`), an alias that config names outside the source
 * repository (`sourceRoot`) is dropped, with a note. Each path must be a git
 * repository: a ConfigError otherwise.
 */
export function resolveRunRepos(opts: {
  setting: Record<string, string>;
  flags: Record<string, string> | null;
  source: string;
  sourceRoot: string;
  untrusted: boolean;
  repositoryConfig: string | null;
}): { repos: RunRepo[]; notes: string[] } {
  const notes: string[] = [];
  const repos = new Map<string, RunRepo>();
  for (const [name, given] of Object.entries(opts.setting)) {
    if (opts.flags && name in opts.flags) continue;
    const path = resolve(opts.source, expandHome(given));
    if (opts.untrusted && opts.repositoryConfig && !inside(opts.sourceRoot, path)) {
      notes.push(
        `untrusted run: not using the repository '${name}' (${path}) that the repository's own config (${opts.repositoryConfig}) names ` +
          `outside the source — name it in a config of your own (--config) or with --repo ${name}=<path>`,
      );
      continue;
    }
    repos.set(name, { name, path: repoTop(name, path), from: "config" });
  }
  for (const [name, path] of Object.entries(opts.flags ?? {})) repos.set(name, { name, path: repoTop(name, path), from: "flag" });
  return { repos: [...repos.values()].sort((a, b) => a.name.localeCompare(b.name)), notes };
}

/**
 * The aliases a workflow's `meta.repos` lists that the run does not declare:
 * a ConfigError naming them and how to declare them. Nothing to do without one.
 */
export function checkMetaRepos(needed: unknown, repos: readonly RunRepo[], workflow: string): void {
  if (!Array.isArray(needed)) return;
  const have = new Set(repos.map((r) => r.name));
  const missing = needed.filter((n): n is string => typeof n === "string" && !have.has(n));
  if (missing.length === 0) return;
  throw new ConfigError(
    `${workflow} needs the repositor${missing.length === 1 ? "y" : "ies"} ${missing.map((n) => `'${n}'`).join(", ")} (its meta.repos) — ` +
      `name ${missing.length === 1 ? "it" : "each"} with odw run --repo ${missing[0]}=<path>, or in the "repos" setting`,
  );
}

/** What the loader refuses in a `meta.repos`, or null: a list of aliases. */
export function metaReposProblem(raw: unknown): string | null {
  if (raw === undefined) return null;
  if (!Array.isArray(raw) || raw.some((n) => !isRepoAlias(n))) {
    return `meta.repos must be a list of repository aliases (${ALIAS_RULE}), like ["api", "web"]; got ${JSON.stringify(raw)}`;
  }
  return null;
}

/**
 * The repositories of one run, shared by its nested workflow()s: what an
 * alias names, and each repository's own safety snapshot and scope locks.
 */
export class RunRepos {
  private readonly byName: Map<string, RunRepo>;
  private readonly snapshots = new Map<string, SafetySnapshot>();
  private readonly locks = new Map<string, ScopeLocks>();

  constructor(
    repos: readonly RunRepo[],
    private readonly options: {
      runId?: string;
      runDir?: string;
      emit?: (ev: WorkflowEvent) => void;
      /** Take safety snapshots (not in a run no model answers). */
      snapshots?: boolean;
    } = {},
  ) {
    this.byName = new Map(repos.map((r) => [r.name, r]));
  }

  get size(): number {
    return this.byName.size;
  }

  get(name: string): RunRepo | undefined {
    return this.byName.get(name);
  }

  list(): RunRepo[] {
    return [...this.byName.values()];
  }

  /** Alias → path, as status.json and the run's log show them. */
  paths(): Record<string, string> {
    return Object.fromEntries(this.list().map((r) => [r.name, r.path]));
  }

  /** The repository's safety snapshot (see ./safety), made on first use; none in a run no model answers. */
  safety(name: string): SafetySnapshot | undefined {
    const repo = this.byName.get(name);
    const { runId, runDir, emit, snapshots } = this.options;
    if (!repo || !snapshots || !runId || !emit) return undefined;
    let snap = this.snapshots.get(name);
    if (!snap) {
      snap = new SafetySnapshot({ source: repo.path, runId, ...(runDir ? { runDir } : {}), emit, repo: name });
      this.snapshots.set(name, snap);
    }
    return snap;
  }

  /** The scoped calls not settled yet in this repository (see ./scope): scopes in other repositories never overlap. */
  scopeLocks(name: string): ScopeLocks {
    let locks = this.locks.get(name);
    if (!locks) {
      locks = new ScopeLocks();
      this.locks.set(name, locks);
    }
    return locks;
  }
}

/**
 * The repository an `agent()` or `exec()` call names (`what`), or null when
 * it names none. A non-string is the script's misuse (`misuse`); an alias the
 * run does not declare is a ConfigError — a script never gives a path.
 */
export function repoOf(repos: RunRepos | undefined, raw: unknown, what: string, misuse: (message: string) => Error): RunRepo | null {
  if (raw === undefined) return null;
  if (typeof raw !== "string" || raw === "") throw misuse(`${what}: repo must be the alias of a repository the run declares (a string); got ${JSON.stringify(raw) ?? String(raw)}`);
  const repo = repos?.get(raw);
  if (repo) return repo;
  const known = repos && repos.size > 0 ? `; the run declares ${repos.list().map((r) => `'${r.name}'`).join(", ")}` : "; the run declares none";
  throw new ConfigError(
    `${what}: repo '${raw}' is not a repository this run declares${known} — name it with odw run --repo ${isRepoAlias(raw) ? raw : "<name>"}=<path> or in the "repos" setting`,
  );
}

/** The run's log line of the repositories it works in besides its source. */
export function reposEvent(repos: readonly RunRepo[]): WorkflowEvent {
  const listed = repos.map((r) => `${r.name} → ${r.path}${r.from === "flag" ? " (--repo)" : ""}`).join(", ");
  return event(LOG, {
    message: `repositories besides the source: ${listed} — agent(…, { repo }) and exec(…, { repo }) name them`,
    repos: Object.fromEntries(repos.map((r) => [r.name, r.path])),
  });
}
