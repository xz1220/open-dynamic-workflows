/**
 * Keeping what isolated agents changed (an ODW extension).
 *
 * An agent that runs with `isolation: "worktree"` works in a throwaway git
 * worktree that is removed when its call settles. Before it goes,
 * {@link captureChanges} keeps the agent's change as a unified diff in the run
 * directory (`agents/<agentId>.diff`) — what a person reviews (`odw diff`, the
 * dashboard's Changes tab) and applies (`odw apply`) — and, with `keep: true`
 * or `keepBranches`, as a commit on a branch of the source repository that can
 * be checked out.
 *
 * The change is everything that differs from the base commit when the CLI
 * exits — edits, new files, deletions, renames, binary files and mode changes,
 * staged, committed or not — except what was there before the agent started:
 * what `.worktreeinclude` placed and what the `worktreeSetup` command produced
 * ({@link snapshotWorktree}, taken just before the agent starts). Such a path
 * stays out unless the agent changed it afterwards (its content fingerprint
 * differs). Symlinks are compared by their target and never followed.
 *
 * How: the worktree's index is copied to a private index file and `git add
 * --all` stages the worktree into it (respecting .gitignore; the copy keeps
 * git's stat cache, so unchanged files are not read again). The paths that are
 * not the agent's are reset to the base, and the diff is taken between the
 * base commit and that index. The agent's own index is never touched. Staging
 * writes the changed blobs into the repository's object store, which the
 * worktree shares: the diff can then name a binary file by its full object id
 * instead of carrying its bytes and `git apply` still applies it, and a kept
 * branch commits exactly the tree the diff describes.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, open, readlink, rename, rm, stat, utimes, type FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { isDeadlineStop } from "./errors.js";
import { SAFE_GIT } from "./git-safety.js";
import type { Workspace } from "./workspace.js";

/** The diffstat of an isolated agent's change, as its events and saved record carry it. */
export interface AgentChanges {
  /** Files changed (a rename is one). */
  files: number;
  /** Lines added and removed, over the whole change (a binary file counts none). */
  insertions: number;
  deletions: number;
  /** The kept diff was cut at `maxDiffBytes`: the counts still describe the whole change. */
  truncated: boolean;
}

/** What an agent call kept: its change, and the branch it was committed to (null: none). */
export interface KeptChanges {
  changes: AgentChanges;
  branch: string | null;
}

/** How a kept diff that was cut at `maxDiffBytes` ends: one last line starting with this. */
export const TRUNCATION_NOTE = "# odw: diff truncated";

/**
 * The `git diff` behind a kept diff — the text contract the dashboard's
 * parser (web/src/components/diff.ts) and `odw apply` rely on: `a/` and `b/`
 * prefixes whatever the user's config says, unusual paths C-quoted, renames
 * detected, and no color, external or textconv driver in the way.
 */
const DIFF_CONFIG = ["-c", "core.quotePath=true", "-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false"];
const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "-M", "--src-prefix=a/", "--dst-prefix=b/"];

/** Bytes of output kept from a git command that lists paths (one per changed file, at most). */
const GIT_OUTPUT_MAX = 64 * 1024 * 1024;

/** Files fingerprinted at once. */
const FINGERPRINT_BATCH = 8;

/** Who a kept branch's commit is by. */
const COMMIT_IDENTITY = {
  GIT_AUTHOR_NAME: "odw",
  GIT_AUTHOR_EMAIL: "odw@localhost",
  GIT_COMMITTER_NAME: "odw",
  GIT_COMMITTER_EMAIL: "odw@localhost",
};

// --- before the agent starts ------------------------------------------------------

/** What a worktree held, beyond its base commit, right before its agent started. */
export interface WorktreeBaseline {
  /** Fingerprint of each such path ({@link fingerprint}; null: absent), relative to the root. */
  paths: Map<string, string | null>;
  /** Directories `.worktreeinclude` placed while git ignored them: nothing in them is the agent's. */
  ignoredDirs: string[];
}

/**
 * Record what a ready worktree holds beyond its base commit, just before the
 * agent starts: every path `git status` lists — what the setup command wrote
 * or edited, what `.worktreeinclude` brought in that git does not ignore — and
 * the `placed` entries git does ignore (a copied `.env`, a linked
 * `node_modules`), which no status lists. Each gets a content fingerprint, so
 * a capture can tell whether the agent changed it afterwards.
 */
export async function snapshotWorktree(
  work: string,
  placed: readonly string[],
  signal?: AbortSignal,
): Promise<WorktreeBaseline> {
  const listed = statusPaths(await git(work, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { signal }));
  const ignoredDirs: string[] = [];
  if (placed.length > 0) {
    // Exit 1 means none of them is ignored.
    const ignored = await git(work, ["check-ignore", "-z", "--stdin"], {
      input: `${placed.join("\0")}\0`,
      signal,
      okCodes: [0, 1],
    });
    for (const path of splitNul(ignored)) {
      if ((await lstat(join(work, path)).catch(() => null))?.isDirectory()) ignoredDirs.push(path);
      else listed.push(path);
    }
  }
  const paths = new Map<string, string | null>();
  await eachLimited([...new Set(listed)], async (path) => {
    paths.set(path, await fingerprint(join(work, path)));
  });
  return { paths, ignoredDirs };
}

/** The paths of a `git status --porcelain=v1 -z` listing, both sides of a rename included. */
function statusPaths(out: string): string[] {
  const paths: string[] = [];
  const entries = out.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.length < 4) continue;
    paths.push(entry.slice(3).replace(/\/$/, ""));
    // A rename or copy: the path it came from follows.
    if (/[RC]/.test(entry.slice(0, 2)) && entries[i + 1]) paths.push(entries[++i]!);
  }
  return paths;
}

/**
 * What a path holds, without following a symlink: "link:<target>" for a link,
 * the content hash and executable bit for a file, "dir" for a directory (a
 * nested repository), null when nothing is there.
 */
export async function fingerprint(path: string): Promise<string | null> {
  const info = await lstat(path).catch(() => null);
  if (!info) return null;
  if (info.isSymbolicLink()) return `link:${await readlink(path).catch(() => "?")}`;
  if (info.isDirectory()) return "dir";
  if (!info.isFile()) return "other";
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  } catch {
    return `unreadable:${info.size}`;
  }
  return `file:${info.mode & 0o111 ? "x" : "-"}:${hash.digest("hex")}`;
}

// --- after it ran --------------------------------------------------------------

/** A git worktree, as {@link captureChanges} sees it. */
export interface WorktreeRef {
  /** The source repository's root, where a kept branch is created. */
  top: string;
  /** The worktree's root. */
  work: string;
  /** The commit the worktree was made from. */
  base: string;
  /** A private directory for scratch files, removed with the worktree. */
  scratch: string;
}

export interface CaptureOptions {
  /** Where the diff is written; its directory must exist. */
  path: string;
  /** Past this many bytes, the diff keeps its head, cut at a line, and a note. */
  maxDiffBytes: number;
  /** Commit the change, with this message, for a kept branch; null: no commit. */
  commitMessage?: string | null;
  /** The branch the change is to be kept on, named by a truncation note. */
  branch?: string | null;
  signal?: AbortSignal;
}

export interface CapturedChanges {
  changes: AgentChanges;
  /** The commit holding the change, on top of the base (with `commitMessage`); else null. */
  commit: string | null;
  /** Why the commit could not be made, when it could not. */
  commitError?: string;
  /** The source repository's root, where a kept branch is created. */
  repo: string;
}

let captures = 0;

/**
 * Write the agent's change in `tree` to `opts.path` as a unified diff (see
 * the module doc for what counts), and commit it when asked. Null — and no
 * file — when the agent changed nothing.
 */
export async function captureChanges(
  tree: WorktreeRef,
  baseline: WorktreeBaseline,
  opts: CaptureOptions,
): Promise<CapturedChanges | null> {
  const { work, base } = tree;
  const signal = opts.signal;
  return withAgentIndex(tree, baseline, signal, async (env) => {
    const stat = numstat(
      await git(work, [...DIFF_CONFIG, "diff", "--cached", "--numstat", "-z", "--no-textconv", "-M", base], { env, signal }),
    );
    if (stat.files === 0) return null;
    const truncated = await writeDiff(work, base, env, opts, stat.files);
    const result: CapturedChanges = { changes: { ...stat, truncated }, commit: null, repo: tree.top };
    if (opts.commitMessage) {
      try {
        result.commit = await commitIndex(work, base, env, opts.commitMessage, signal);
      } catch (err) {
        if (signal?.aborted) throw err;
        result.commitError = errorText(err);
      }
    }
    return result;
  });
}

/**
 * The paths the agent changed in `tree` — the files {@link captureChanges}
 * puts in its diff, a rename as both its paths — relative to the worktree's
 * root. What an `expect` check of an isolated agent reads (ODW extension).
 */
export async function listChanges(tree: WorktreeRef, baseline: WorktreeBaseline, signal?: AbortSignal): Promise<string[]> {
  return withAgentIndex(tree, baseline, signal, async (_env, paths) => paths);
}

/**
 * A path relative to a repository's root, made relative to `dir` — one of its
 * directories, given relative to the root ("" for the root itself) — with
 * forward slashes: `src/a.ts` is `a.ts` from `src`, `README.md` is
 * `../README.md` from it.
 */
export function relativeToDir(dir: string, path: string): string {
  if (dir === "") return path;
  const from = dir.split("/");
  const to = path.split("/");
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++;
  return [...from.slice(common).map(() => ".."), ...to.slice(common)].join("/");
}

/**
 * Stage the agent's change in `tree` into a private copy of its index (see the
 * module doc: everything that differs from the base, less what was there
 * before the agent started), and run `fn` with that index's environment and
 * the paths of the change. The copy is removed afterwards.
 */
async function withAgentIndex<T>(
  tree: WorktreeRef,
  baseline: WorktreeBaseline,
  signal: AbortSignal | undefined,
  fn: (env: NodeJS.ProcessEnv, paths: string[]) => Promise<T>,
): Promise<T> {
  const { work, base } = tree;
  const index = join(tree.scratch, `changes-${process.pid}-${++captures}.index`);
  // A copy of the worktree's own index carries git's stat cache: staging the
  // tree then reads only what changed. The copy keeps the index's mtime: git
  // re-reads any entry not older than its index file ("racily clean"), and a
  // fresh mtime would make it trust the cache for a same-size edit made in
  // the second the worktree was checked out — and miss it.
  const own = resolve(work, (await git(work, ["rev-parse", "--git-path", "index"], { signal })).trim());
  const copied = await copyFile(own, index).then(
    () => true,
    (err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
      return false;
    },
  );
  if (copied) {
    const times = await stat(own);
    await utimes(index, times.atime, times.mtime);
  }
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    await git(work, ["add", "--all", "--", "."], { env, signal });
    const changed = splitNul(await git(work, ["diff", "--cached", "--name-only", "-z", "--no-renames", base], { env, signal }));
    const notTheAgents = await placedBeforeStart(work, baseline, changed);
    if (notTheAgents.length > 0) {
      await git(work, ["--literal-pathspecs", "reset", "-q", base, "--pathspec-from-file=-", "--pathspec-file-nul"], {
        env,
        signal,
        input: `${notTheAgents.join("\0")}\0`,
      });
    }
    const skip = new Set(notTheAgents);
    return await fn(env, changed.filter((path) => !skip.has(path)));
  } finally {
    await rm(index, { force: true }).catch(() => {});
  }
}

/**
 * Of the paths that differ from the base, those that are not the agent's:
 * there, as they are now, before it started — or inside a directory the
 * include step placed while git ignored it.
 */
async function placedBeforeStart(work: string, baseline: WorktreeBaseline, changed: string[]): Promise<string[]> {
  const out = changed.filter(
    (path) => !baseline.paths.has(path) && baseline.ignoredDirs.some((dir) => path.startsWith(`${dir}/`)),
  );
  await eachLimited(
    changed.filter((path) => baseline.paths.has(path)),
    async (path) => {
      if ((await fingerprint(join(work, path))) === baseline.paths.get(path)) out.push(path);
    },
  );
  return out;
}

/** Files, insertions and deletions of a `git diff --numstat -z -M` listing (a binary file counts no lines). */
function numstat(out: string): { files: number; insertions: number; deletions: number } {
  const fields = out.split("\0");
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  for (let i = 0; i < fields.length; i++) {
    const [added, removed, path] = fields[i]!.split("\t");
    if (removed === undefined) continue;
    if (path === "") i += 2; // a rename: its old and new paths follow
    files++;
    insertions += Number(added) || 0;
    deletions += Number(removed) || 0;
  }
  return { files, insertions, deletions };
}

/**
 * Stream the diff into `opts.path`, at most `maxDiffBytes` of it: past that,
 * git is stopped, the text is cut after its last whole line, and one note
 * line says what is missing. Nothing is held in memory but a pipe's chunk.
 * Returns whether it was cut.
 */
async function writeDiff(
  work: string,
  base: string,
  env: NodeJS.ProcessEnv,
  opts: CaptureOptions,
  files: number,
): Promise<boolean> {
  const cap = opts.maxDiffBytes;
  const file = await open(opts.path, "w+");
  let written = 0;
  let cut = 0; // just past the last newline written
  let truncated = false;
  try {
    const child = spawn("git", ["-C", work, ...SAFE_GIT, ...DIFF_CONFIG, "diff", "--cached", ...DIFF_FLAGS, "--full-index", base], {
      env,
      signal: opts.signal,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const closed = new Promise<number | null>((done, fail) => {
      child.once("error", fail);
      child.once("close", done);
    });
    closed.catch(() => {}); // awaited below; never an unhandled rejection meanwhile
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    // Read from the first tick: Node drains the output nobody reads once the process exits.
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      const room = cap - written;
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (part.length > 0) {
        await file.write(part, 0, part.length, written);
        const newline = part.lastIndexOf(0x0a);
        if (newline !== -1) cut = written + newline + 1;
        written += part.length;
      }
      if (chunk.length > room) {
        truncated = true;
        break;
      }
    }
    if (truncated) child.kill();
    const code = await closed;
    if (!truncated && code !== 0) throw new Error(`git diff exited with code ${code}: ${stderr.trim()}`);
    if (truncated) {
      await file.truncate(cut);
      const shown = await countFiles(file, cut);
      await file.write(truncationNote(cap, files - shown, opts.branch ?? null), cut);
    }
  } finally {
    await file.close();
  }
  return truncated;
}

/** The `diff --git` headers in the first `end` bytes of `file`: the files a cut diff shows, the last maybe in part. */
async function countFiles(file: FileHandle, end: number): Promise<number> {
  const marker = Buffer.from("\ndiff --git ");
  const buf = Buffer.alloc(64 * 1024);
  let carry = Buffer.from("\n"); // the very start is a line start too
  let count = 0;
  for (let pos = 0; pos < end; ) {
    const { bytesRead } = await file.read(buf, 0, Math.min(buf.length, end - pos), pos);
    if (bytesRead === 0) break;
    const view = Buffer.concat([carry, buf.subarray(0, bytesRead)]);
    for (let at = view.indexOf(marker); at !== -1; at = view.indexOf(marker, at + 1)) count++;
    carry = view.subarray(Math.max(0, view.length - (marker.length - 1)));
    pos += bytesRead;
  }
  return count;
}

/** The last line of a cut diff: where it was cut, what is missing, and where the whole change is. */
function truncationNote(cap: number, notShown: number, branch: string | null): string {
  const missing =
    notShown > 0 ? `${notShown} file${notShown === 1 ? "" : "s"} not shown` : "the last file is cut short";
  const whole = branch ? `the full change is on branch ${branch}` : "keep: true keeps the full change on a branch";
  return `${TRUNCATION_NOTE} at ${formatBytes(cap)} — ${missing}; ${whole}\n`;
}

/** "2.0 MB", "512.0 KB", "300 bytes". */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} bytes`;
}

/** Commit the private index on top of the base, as odw; returns the commit's id. No ref moves. */
async function commitIndex(
  work: string,
  base: string,
  env: NodeJS.ProcessEnv,
  message: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const tree = (await git(work, ["write-tree"], { env, signal })).trim();
  // --no-gpg-sign: a background run must never wait for a signing key.
  const commit = await git(work, ["commit-tree", "--no-gpg-sign", "-p", base, "-m", message, tree], {
    env: { ...env, ...COMMIT_IDENTITY },
    signal,
  });
  return commit.trim();
}

// --- in place -------------------------------------------------------------------

/**
 * A working tree as it stood before an agent ran in it in place — its HEAD,
 * and what `git status` listed, fingerprinted — so {@link changedSince} can
 * tell what changed in a tree that may already hold uncommitted work. What an
 * `expect` check of an in-place agent compares against (ODW extension).
 */
export interface TreeSnapshot {
  /** The repository's root: the snapshot's paths are relative to it. */
  root: string;
  /** The commit HEAD named; null before the first commit. */
  head: string | null;
  /** Fingerprint of each path `git status` listed ({@link fingerprint}; null: absent). */
  paths: Map<string, string | null>;
}

/** Snapshot the git working tree `dir` is in; throws when it is in none. */
export async function snapshotTree(dir: string, signal?: AbortSignal): Promise<TreeSnapshot> {
  const root = (await git(dir, ["rev-parse", "--show-toplevel"], { signal })).trim();
  const { paths } = await snapshotWorktree(root, [], signal);
  return { root, head: await headCommit(root, signal), paths };
}

/**
 * What changed in a snapshot's tree since it was taken — by whoever changed
 * it — as paths relative to its root, sorted: what `git status` lists now and
 * did not then, what it listed then whose content differs now (a revert or a
 * deletion included), and what the commits made since then changed.
 */
export async function changedSince(snap: TreeSnapshot, signal?: AbortSignal): Promise<string[]> {
  const { root } = snap;
  const listed = statusPaths(await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { signal }));
  const changed = new Set(listed.filter((path) => !snap.paths.has(path)));
  await eachLimited([...snap.paths.keys()], async (path) => {
    if ((await fingerprint(join(root, path))) !== snap.paths.get(path)) changed.add(path);
  });
  const head = await headCommit(root, signal);
  if (head !== null && head !== snap.head) {
    const committed =
      snap.head === null
        ? await git(root, ["ls-tree", "-r", "-z", "--name-only", head], { signal })
        : await git(root, ["diff", "--name-only", "-z", "--no-renames", snap.head, head], { signal });
    for (const path of splitNul(committed)) changed.add(path);
  }
  return [...changed].sort();
}

/**
 * Take what `paths` (relative to the snapshot's root) hold now as where they
 * started: what was done to them since — by a check's command, not the agent
 * — is no longer a change, while a later edit to them is.
 */
export async function rebaseline(snap: TreeSnapshot, paths: readonly string[]): Promise<void> {
  await eachLimited([...paths], async (path) => {
    snap.paths.set(path, await fingerprint(join(snap.root, path)));
  });
}

/** The commit HEAD names in `dir`'s repository, or null before the first one. */
async function headCommit(dir: string, signal?: AbortSignal): Promise<string | null> {
  // Exit 1, quietly: no commit yet.
  return (await git(dir, ["rev-parse", "-q", "--verify", "HEAD"], { signal, okCodes: [0, 1] })).trim() || null;
}

// --- branches ---------------------------------------------------------------------

/**
 * The branch an agent's change is kept on: `odw/<runId>/<agentId>-<label-slug>`.
 * The slug is the label in lowercase ASCII letters and digits, dashes between.
 */
export function branchName(runId: string, agentId: number, label: string): string {
  const slug = label
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `odw/${runId.replace(/[^A-Za-z0-9-]+/g, "-")}/${agentId}-${slug || "agent"}`;
}

/**
 * Create `branch` at `commit` in the source repository. Only a new ref is
 * written: HEAD, the index and every existing branch stay as they are, and a
 * branch of that name that already exists is an error, never moved.
 */
export async function createBranch(repo: string, branch: string, commit: string): Promise<void> {
  await git(repo, ["update-ref", "-m", "odw: keep an isolated agent's change", `refs/heads/${branch}`, commit, ""]);
}

// --- one agent call -----------------------------------------------------------

export interface ChangeRecorderOptions {
  /** Where the kept diff goes: the run directory's `agents/<agentId>.diff`. */
  path: string;
  maxDiffBytes: number;
  /** The branch to keep the change on (`keep: true`, `keepBranches`); null: none. */
  branch: string | null;
  /** The kept commit's message: the agent's label and the run id. */
  message: string;
  /** The run's abort signal: a stop ends a capture at once, and keeps nothing — but the run's deadline's (see DeadlinePassed). */
  signal?: AbortSignal;
  /** Receives what the run should log: a change that could not be kept, a branch that could not be made. */
  onNote?: (message: string) => void;
}

/** A captured change, waiting in a scratch file beside the kept diff until the call settles. */
interface Pending extends CapturedChanges {
  file: string;
}

/**
 * Keeps the change of one isolated agent call. Each CLI run of the call works
 * in a fresh worktree, so the bridge reports every run's worktree before it is
 * removed ({@link capture}), and the attempts' boundaries ({@link endAttempt}).
 * A run supersedes the earlier runs of its attempt: a stall restart or a
 * rate-limit retry redoes the work from scratch. A schema retry is asked only
 * to reformat its reply, so an attempt that changed nothing leaves the earlier
 * attempt's change standing; one that did change files replaces it. A retry of
 * work that missed its `expect` checks ({@link redo}) starts the work over:
 * once a run of it is in, the earlier attempts' change is gone, even when it
 * changed nothing. When the call settles, {@link settle} keeps the winner as
 * `agents/<agentId>.diff` and creates its branch; {@link discard} drops
 * everything (a stop, or a fallback that starts the work over on another
 * adapter).
 */
export class ChangeRecorder {
  private kept: Pending | null = null;
  private latest: Pending | null = null;
  private runs = 0;
  /** The next run starts the work over (see {@link redo}). */
  private redoing = false;

  constructor(private readonly opts: ChangeRecorderOptions) {}

  /** Capture what one CLI run changed in `ws`, before its worktree goes. Never throws. */
  async capture(ws: Workspace): Promise<void> {
    const { path, maxDiffBytes, branch, message } = this.opts;
    // The run's deadline (ODW extension) keeps what a killed agent had changed:
    // that capture runs to its end, past the aborted signal (see DeadlinePassed).
    const signal = this.opts.signal?.aborted && isDeadlineStop(this.opts.signal.reason) ? undefined : this.opts.signal;
    const file = `${path}.${++this.runs}.tmp`;
    let pending: Pending | null = null;
    try {
      await mkdir(dirname(file), { recursive: true });
      const captured = await ws.captureChanges({
        path: file,
        maxDiffBytes,
        branch,
        commitMessage: branch ? message : null,
        signal,
      });
      if (captured) pending = { ...captured, file };
    } catch (err) {
      if (!signal?.aborted) this.opts.onNote?.(`could not keep what it changed: ${errorText(err)}`);
    }
    if (!pending) await rm(file, { force: true }).catch(() => {});
    await this.drop(this.latest);
    this.latest = pending;
    if (this.redoing) {
      this.redoing = false;
      await this.drop(this.kept);
      this.kept = null;
    }
  }

  /**
   * The next attempt starts the call's work over in a fresh worktree — a retry
   * of work that missed its `expect` checks — so what it changes, even
   * nothing, supersedes the earlier attempts' change once a run of it is in.
   */
  redo(): void {
    this.redoing = true;
  }

  /** An attempt's last CLI run is in: what it changed, if anything, replaces an earlier attempt's change. */
  async endAttempt(): Promise<void> {
    if (!this.latest) return;
    await this.drop(this.kept);
    this.kept = this.latest;
    this.latest = null;
  }

  /** The call settled: keep the change as the agent's diff, and on its branch. Null when it changed nothing. */
  async settle(): Promise<KeptChanges | null> {
    await this.endAttempt();
    const kept = this.kept;
    this.kept = null;
    if (!kept) return null;
    await rename(kept.file, this.opts.path);
    let branch: string | null = null;
    if (this.opts.branch) {
      try {
        if (!kept.commit) throw new Error(kept.commitError ?? "no commit was made");
        await createBranch(kept.repo, this.opts.branch, kept.commit);
        branch = this.opts.branch;
      } catch (err) {
        this.opts.onNote?.(`could not keep its change on branch ${this.opts.branch}: ${errorText(err)}`);
      }
    }
    return { changes: kept.changes, branch };
  }

  /**
   * Keep nothing captured so far: the call ended with the run (a stop), or it
   * starts its work over on another adapter (a fallback, an ODW extension) —
   * whose runs the recorder goes on capturing.
   */
  async discard(): Promise<void> {
    await this.drop(this.latest);
    await this.drop(this.kept);
    this.latest = null;
    this.kept = null;
    this.redoing = false;
  }

  private async drop(pending: Pending | null): Promise<void> {
    if (pending) await rm(pending.file, { force: true }).catch(() => {});
  }
}

// --- git ------------------------------------------------------------------------

export interface GitOptions {
  env?: NodeJS.ProcessEnv;
  /** Written to the command's stdin. */
  input?: string;
  signal?: AbortSignal;
  /** Exit codes that are not a failure (default: 0). */
  okCodes?: number[];
  /** POSIX: run git in a process group of its own, out of reach of the terminal's Ctrl-C. */
  detached?: boolean;
}

/** How a git command ended: its exit code (null: killed), stdout, and the end of its stderr. */
export interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run git in `cwd`; resolves however it exits, rejects only when it cannot run (or printed too much). */
export function runGit(cwd: string, args: string[], opts: GitOptions = {}): Promise<GitResult> {
  return new Promise((done, fail) => {
    const child = spawn("git", ["-C", cwd, ...SAFE_GIT, ...args], {
      env: opts.env,
      signal: opts.signal,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: opts.detached === true && process.platform !== "win32",
    });
    const out: Buffer[] = [];
    let size = 0;
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= GIT_OUTPUT_MAX) out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.stdin.on("error", () => {}); // git may exit before reading it all
    child.stdin.end(opts.input ?? "");
    child.once("error", fail);
    child.once("close", (code) => {
      if (size > GIT_OUTPUT_MAX) fail(new Error(`git ${subcommand(args)} printed more than ${formatBytes(GIT_OUTPUT_MAX)}`));
      else done({ code, stdout: Buffer.concat(out).toString("utf8"), stderr });
    });
  });
}

/** Run git in `cwd` and return its stdout; a failure throws with the end of its stderr. */
export async function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<string> {
  const { code, stdout, stderr } = await runGit(cwd, args, opts);
  if ((opts.okCodes ?? [0]).includes(code ?? -1)) return stdout;
  throw new Error(`git ${subcommand(args)} failed: ${stderr.trim() || `exit code ${code}`}`);
}

/** The git command among `args`, past the global options (`-c key=value` included). */
function subcommand(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-c") i++;
    else if (!args[i]!.startsWith("-")) return args[i]!;
  }
  return "";
}

/** The entries of a NUL-separated git listing (`-z`). */
export function splitNul(out: string): string[] {
  return out.split("\0").filter(Boolean);
}

/** Run `fn` over `items`, a few at a time. */
async function eachLimited<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += FINGERPRINT_BATCH) {
    await Promise.all(items.slice(i, i + FINGERPRINT_BATCH).map(fn));
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
