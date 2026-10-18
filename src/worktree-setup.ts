/**
 * Ready-to-work worktrees: what an isolated agent's worktree gets before the
 * agent starts.
 *
 * A fresh git worktree is a clean checkout of the base commit, so the source
 * tree's `.env`, `.venv` and `node_modules` are not in it. {@link prepareWorktree}
 * runs right after `git worktree add`:
 *
 *   1. **`.worktreeinclude`** — the file at the repository root (where Claude
 *      Code reads it too) lists, in .gitignore syntax, what to bring in: every
 *      file and directory git does not track — ignored or merely untracked —
 *      that its patterns match is copied into the worktree. (Claude Code copies
 *      the ignored ones only.) A `symlink:` prefix on a line — an ODW
 *      extension — links what that line matches to the source instead of
 *      copying it: a heavy directory (`symlink: node_modules`) then costs
 *      nothing, but it is shared with the source tree and every other agent.
 *      `.git` is never copied, and a file over {@link MAX_INCLUDE_FILE_BYTES}
 *      is left out with a note.
 *   2. **`worktreeSetup`** (an ODW extension) — a command run in the agent's
 *      workspace with the agent's `ODW_*` variables, killed after
 *      `worktreeSetupTimeout` seconds. A setup that fails or times out fails
 *      the agent, not the run ({@link WorktreeSetupError} is recoverable), and
 *      the end of its output is in the error.
 *
 * In an untrusted run (an ODW extension; see adapters/trust.ts) the
 * `symlink:` lines link nothing, and a `worktreeSetup` the repository's own
 * config set is dropped before the run starts (see ./untrusted).
 *
 * Each worktree is prepared on its own: every CLI attempt of an agent call (a
 * schema retry, a stall restart) starts from a fresh worktree.
 */

import { execFile } from "node:child_process";
import { constants, type Dirent } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, readlink, stat, symlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { SAFE_GIT } from "./git-safety.js";
import { DEFAULT_SETTINGS } from "./adapters/builtin.js";
import { runCommand } from "./adapters/runner.js";
import { cliOk } from "./adapters/types.js";
import { DynamicWorkflowError, RunStopped } from "./errors.js";

const run = promisify(execFile);

export const WORKTREE_INCLUDE_FILE = ".worktreeinclude";

/** A file bigger than this is left out of the copy, with a note: a `symlink:` line shares it instead. */
export const MAX_INCLUDE_FILE_BYTES = 100 * 1024 * 1024;

/** Characters of the setup's output (stdout and stderr as they came) that its failure quotes. */
const SETUP_TAIL_CHARS = 2000;

/** The listing is paths only, but a tree of small matched files can still be long. */
const LIST_MAX_BUFFER = 64 * 1024 * 1024;

/** Characters of exclusion pathspecs passed to git at most (Windows caps a command line at 32K). */
const EXCLUDE_ARGS_MAX = 8000;

/** Files copied at once; directories are walked one at a time, so little is in flight. */
const COPY_BATCH = 32;

/** Paths a note names before it counts the rest. */
const NOTE_PATHS = 5;

const IS_WINDOWS = process.platform === "win32";

/** An isolated agent's worktree could not be made ready: a recoverable failure of that agent. */
export class WorktreeSetupError extends DynamicWorkflowError {}

/** How to prepare a new worktree beyond `.worktreeinclude` (which always applies). */
export interface WorktreeSetupOptions {
  /** `settings.worktreeSetup`: a command line for the shell, or an argv; absent or null => none. */
  command?: string | string[] | null;
  /** Seconds before the setup command is killed (`settings.worktreeSetupTimeout`, default 600). */
  timeout?: number;
  /** The setup command's environment (the worker's by default); the bridge adds the agent's `ODW_*` ids and port. */
  env?: Record<string, string>;
  /** The run's abort signal: a stop kills the setup and abandons the copy. */
  signal?: AbortSignal;
  /** Receives what the run should log: files left out, links that could not be made. */
  onNote?: (message: string) => void;
  /**
   * The agent runs untrusted (an ODW extension; see adapters/trust.ts): the
   * `symlink:` lines of the repository's `.worktreeinclude` link nothing —
   * a link hands the agent the source tree itself — and `onRefused` hears it.
   */
  untrusted?: boolean;
  /** Receives what an untrusted run refused to do, for the run's log (once per run is the caller's to keep). */
  onRefused?: (message: string) => void;
  /**
   * The commit the worktree checks out, in place of the source's HEAD: the
   * base its agent_started event names (ODW extension; `odw replay` starts a
   * replayed agent where the original started). A full hex commit id.
   */
  base?: string;
  /** The run the worktree is for, written beside it so `odw gc` can tell an orphan (ODW extension; see runtime/gc). */
  owner?: string;
}

/** The lines of a `.worktreeinclude`: the patterns to copy, and the `symlink:` ones to link. */
export interface WorktreeInclude {
  copy: string[];
  link: string[];
}

/**
 * Parse a `.worktreeinclude`. Lines follow .gitignore rules — a `#` line is a
 * comment, blank lines are skipped, trailing spaces count only when escaped
 * with a backslash — and a line starting `symlink:` is a pattern to link.
 */
export function parseWorktreeInclude(text: string): WorktreeInclude {
  const copy: string[] = [];
  const link: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "").replace(/(?<!\\) +$/, "");
    if (line === "" || line.startsWith("#")) continue;
    const prefix = /^symlink:\s*/.exec(line);
    if (!prefix) copy.push(line);
    else if (line.length > prefix[0].length) link.push(line.slice(prefix[0].length));
  }
  return { copy, link };
}

/**
 * Make a new worktree ready for its agent: bring in what `.worktreeinclude`
 * names, then run the setup command. `top` is the source repository's root,
 * `work` the new worktree's, and `path` the agent's workspace inside it. Each
 * link is pushed onto `links` as it is made, so the caller can remove the
 * links before the worktree, whatever happens here. Resolves to what the
 * include step placed — the copied and linked entries, relative to the root
 * and "/"-separated — which is not the agent's change (see ./changes).
 */
export async function prepareWorktree(
  top: string,
  work: string,
  path: string,
  options: WorktreeSetupOptions,
  links: string[],
): Promise<string[]> {
  const placed = await includeFiles(top, work, options, links);
  if (options.command) await runSetup(options.command, path, options);
  return placed;
}

// --- .worktreeinclude ------------------------------------------------------------

async function includeFiles(top: string, work: string, options: WorktreeSetupOptions, links: string[]): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(join(top, WORKTREE_INCLUDE_FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new WorktreeSetupError(`could not read ${WORKTREE_INCLUDE_FILE}: ${(err as Error).message}`);
  }
  const patterns = parseWorktreeInclude(text);
  if (options.untrusted && patterns.link.length > 0) {
    const shown = patterns.link.slice(0, NOTE_PATHS).join(", ");
    const more = patterns.link.length > NOTE_PATHS ? ` and ${patterns.link.length - NOTE_PATHS} more` : "";
    options.onRefused?.(
      `untrusted run: ${WORKTREE_INCLUDE_FILE} is the repository's own, so its symlink: lines link nothing ` +
        `(${shown}${more}) — a link would hand agents the source tree itself; run trusted to link them`,
    );
    patterns.link = [];
  }
  const linked = await matchUntracked(top, patterns.link);
  const copied = [...(await matchUntracked(top, patterns.copy))].filter((path) => !within(linked, path));
  const copier = new Copier(top, work, linked, options.signal);
  for (let i = 0; i < copied.length; i += COPY_BATCH) {
    await settled(copied.slice(i, i + COPY_BATCH).map((path) => copier.copyEntry(path)));
  }
  for (const path of linked) await copier.linkEntry(path, links);
  throwIfAborted(options.signal);
  for (const note of copier.notes()) options.onNote?.(`${WORKTREE_INCLUDE_FILE} ${note}`);
  // What is there now was placed here: an entry left out (too big, not a regular file) is not.
  const placed: string[] = [];
  for (const path of [...copied, ...linked]) {
    if (await lstat(join(work, path)).then(() => true, () => false)) placed.push(path);
  }
  return placed;
}

/**
 * The files and directories git does not track (ignored or not) that
 * `patterns` match, relative to the repository root: a matched directory as
 * one entry, files elsewhere one by one. The patterns are git's only exclude
 * rules here — no .gitignore — so "ignored" means "matched". git never lists
 * `.git`, nor anything inside a nested repository.
 */
async function matchUntracked(top: string, patterns: string[]): Promise<Set<string>> {
  if (patterns.length === 0) return new Set();
  const list = ["-C", top, "ls-files", "-z", "--others", "--ignored", ...patterns.map((p) => `--exclude=${p}`)];
  // `--directory` names a wholly matched directory once, without walking it,
  // and what it names is right; but it can miss a match inside an untracked
  // directory that is not matched itself. So every matched file is listed too
  // (git walks fast), keeping out of the directories already found.
  const dirs = (await gitList([...list, "--directory", "--no-empty-directory"]))
    .filter((path) => path.endsWith("/"))
    .map((path) => path.slice(0, -1));
  const files = await gitList([...list, "--", ".", ...excluding(dirs)]);
  return outermost([...dirs, ...files]);
}

async function gitList(args: string[]): Promise<string[]> {
  try {
    const { stdout } = await run("git", [...SAFE_GIT, ...args], { maxBuffer: LIST_MAX_BUFFER, windowsHide: true });
    return stdout.split("\0").filter(Boolean);
  } catch (err) {
    const detail = (err as { stderr?: string }).stderr?.trim() || (err as Error).message;
    throw new WorktreeSetupError(`could not list what ${WORKTREE_INCLUDE_FILE} matches: ${detail}`);
  }
}

/** Pathspecs that keep a listing out of `dirs`, as many as a command line comfortably takes. */
function excluding(dirs: string[]): string[] {
  const specs: string[] = [];
  let length = 0;
  for (const dir of dirs) {
    const spec = `:(exclude,literal)${dir}`;
    length += spec.length + 1;
    if (length > EXCLUDE_ARGS_MAX) break; // the rest is filtered out by outermost()
    specs.push(spec);
  }
  return specs;
}

/** Await every promise, then throw the first failure: none is left running when the caller unwinds. */
async function settled(work: Array<Promise<unknown>>): Promise<void> {
  const failed = (await Promise.allSettled(work)).find((r) => r.status === "rejected");
  if (failed) throw failed.reason;
}

/** The paths not inside another path of the list. */
function outermost(paths: string[]): Set<string> {
  const kept = new Set<string>();
  for (const path of [...paths].sort((a, b) => a.length - b.length)) {
    if (!within(kept, path)) kept.add(path);
  }
  return kept;
}

/** Whether `path` or a directory above it is in `paths` ("/"-separated, as git lists them). */
function within(paths: Set<string>, path: string): boolean {
  for (let at = path.indexOf("/"); at !== -1; at = path.indexOf("/", at + 1)) {
    if (paths.has(path.slice(0, at))) return true;
  }
  return paths.has(path);
}

/** Brings listed entries into the worktree, bounded, and remembers what it left out and why. */
class Copier {
  /** Source paths of the `symlink:` entries: skipped when a copied directory contains one. */
  private readonly linked: Set<string>;
  /** The new worktree's temporary directory: never copied into itself (a TMPDIR inside the repo). */
  private readonly own: string;
  private readonly left = new Map<string, string[]>();

  constructor(
    private readonly top: string,
    private readonly work: string,
    linked: Set<string>,
    private readonly signal: AbortSignal | undefined,
  ) {
    this.linked = new Set([...linked].map((path) => join(top, path)));
    this.own = dirname(work);
  }

  /** Copy one listed entry; a failure other than "it vanished" fails the agent, naming the entry. */
  async copyEntry(path: string, opts: { linkFailed?: boolean } = {}): Promise<void> {
    throwIfAborted(this.signal);
    const dest = join(this.work, path);
    try {
      await mkdir(dirname(dest), { recursive: true });
      await this.copy(join(this.top, path), dest, opts.linkFailed === true);
    } catch (err) {
      throw new WorktreeSetupError(`could not copy '${path}' into the worktree: ${(err as Error).message}`);
    }
    throwIfAborted(this.signal);
  }

  /** Link one `symlink:` entry to the source; copy it after all when the link cannot be made. */
  async linkEntry(path: string, links: string[]): Promise<void> {
    throwIfAborted(this.signal);
    const target = join(this.top, path);
    const dest = join(this.work, path);
    if (await lstat(dest).then(() => true, () => false)) {
      this.leftOut("did not link what the checkout already has", path);
      return;
    }
    try {
      await mkdir(dirname(dest), { recursive: true });
      // Windows: a junction links a directory without the privilege a symlink needs.
      const type = IS_WINDOWS ? ((await stat(target)).isDirectory() ? "junction" : "file") : undefined;
      await symlink(target, dest, type);
      links.push(dest);
    } catch (err) {
      this.leftOut(`could not link these, so it copied them (${errorCode(err)})`, path);
      await this.copyEntry(path, { linkFailed: true });
    }
  }

  /** What was left out, one note per reason: "<reason>: a, b and 3 more". */
  notes(): string[] {
    return [...this.left].map(([reason, paths]) => {
      const more = paths.length > NOTE_PATHS ? ` and ${paths.length - NOTE_PATHS} more` : "";
      return `${reason}: ${paths.slice(0, NOTE_PATHS).join(", ")}${more}`;
    });
  }

  private leftOut(reason: string, path: string): void {
    const paths = this.left.get(reason);
    if (paths) paths.push(path);
    else this.left.set(reason, [path]);
  }

  private async copy(src: string, dest: string, evenIfLinked = false): Promise<void> {
    if (this.signal?.aborted || basename(src) === ".git" || src === this.own) return;
    if (this.linked.has(src) && !evenIfLinked) return;
    const info = await lstat(src).catch(vanished);
    if (!info) return;
    const path = relative(this.top, src).split(sep).join("/");
    if (info.isDirectory()) {
      await mkdir(dest, { recursive: true });
      const entries: Dirent[] = (await readdir(src, { withFileTypes: true }).catch(vanished)) ?? [];
      const files: string[] = [];
      for (const entry of entries) {
        if (entry.isDirectory()) await this.copy(join(src, entry.name), join(dest, entry.name));
        else files.push(entry.name);
      }
      for (let i = 0; i < files.length; i += COPY_BATCH) {
        await settled(files.slice(i, i + COPY_BATCH).map((name) => this.copy(join(src, name), join(dest, name))));
      }
    } else if (info.isSymbolicLink()) {
      await this.copyLink(src, dest, path);
    } else if (!info.isFile()) {
      this.leftOut("skipped what is not a regular file (a socket, pipe or device)", path);
    } else if (info.size > MAX_INCLUDE_FILE_BYTES) {
      this.leftOut(
        `left out files over ${MAX_INCLUDE_FILE_BYTES / 2 ** 20} MB (a "symlink:" line shares a big file instead)`,
        `${path} (${size(info.size)})`,
      );
    } else {
      // A copy-on-write clone where the filesystem supports one, a plain copy elsewhere.
      await copyFile(src, dest, constants.COPYFILE_FICLONE).catch(vanished);
    }
  }

  /**
   * Recreate a symlink. A relative one that stays inside the repository keeps
   * pointing at its counterpart in the worktree; one that climbs out of the
   * repository is pinned to the absolute path it reached; an absolute one is
   * kept as is, as git checks absolute links out.
   */
  private async copyLink(src: string, dest: string, path: string): Promise<void> {
    let target = await readlink(src);
    const reached = resolve(dirname(src), target);
    if (!isAbsolute(target) && !inside(this.top, reached)) target = reached;
    try {
      await symlink(target, dest);
    } catch (err) {
      this.leftOut(`could not recreate these symlinks (${errorCode(err)})`, path);
    }
  }
}

/** `undefined` for an entry that vanished since it was listed; any other error is rethrown. */
function vanished(err: unknown): undefined {
  if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
  throw err;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function errorCode(err: unknown): string {
  return (err as NodeJS.ErrnoException).code ?? (err as Error).message;
}

function size(bytes: number): string {
  return bytes >= 2 ** 30 ? `${(bytes / 2 ** 30).toFixed(1)} GB` : `${(bytes / 2 ** 20).toFixed(1)} MB`;
}

// --- the setup command -----------------------------------------------------------

/** Run `settings.worktreeSetup` in the agent's workspace; throw a WorktreeSetupError unless it succeeds. */
async function runSetup(command: string | string[], cwd: string, options: WorktreeSetupOptions): Promise<void> {
  const timeout = options.timeout ?? DEFAULT_SETTINGS.worktreeSetupTimeout;
  let output = "";
  let cut = false;
  const keep = (chunk: string): void => {
    output += chunk;
    if (output.length > SETUP_TAIL_CHARS * 2) {
      output = output.slice(-SETUP_TAIL_CHARS);
      cut = true;
    }
  };
  const shell = typeof command === "string";
  const result = await runCommand(shell ? [command] : command, {
    shell,
    cwd,
    env: options.env,
    timeout,
    signal: options.signal,
    onStdout: keep,
    onStderr: keep,
  });
  throwIfAborted(options.signal);
  if (cliOk(result)) return;
  const why = result.timedOut ? `timed out after ${timeout}s` : `exited with code ${result.returncode}`;
  const tail = output.slice(-SETUP_TAIL_CHARS).trim();
  // A command that could not start printed nothing: the runner says why instead.
  const said = tail ? `${cut || output.length > SETUP_TAIL_CHARS ? "…" : ""}${tail}` : result.stderr.trim();
  throw new WorktreeSetupError(`the worktree setup ("worktreeSetup") ${why}${said ? `; the end of its output:\n${said}` : ""}`);
}

/** End with the run's reason once it is aborted (a fatal error), as the bridge does. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new RunStopped("run was stopped");
}
