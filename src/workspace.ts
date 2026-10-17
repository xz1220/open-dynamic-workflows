/**
 * Workspace isolation via git worktrees (cross-cutting).
 *
 * Each `agent` call runs against a *workspace*. Two modes:
 *   - `inplace` (default): the agent runs directly in the source directory —
 *     the same semantics as Claude Code's Workflow tool subagents. No isolation,
 *     no diff.
 *   - `worktree` (per-agent opt-in via `isolation: "worktree"`): the agent runs
 *     in a throwaway `git worktree` of the source repository — again the same
 *     mechanism Claude Code uses. Worktrees share the repo's object store, so
 *     setup is near-free regardless of tree size. The worktree is removed
 *     afterwards and nothing is merged back: `agent()` returns the reply.
 *     {@link Workspace.diff} can capture the agent's changes as a unified diff
 *     against the commit the worktree started from (staging or even committing
 *     inside the worktree does not hide work), but only on demand — it costs
 *     an index walk and a file read, so the bridge does not call it.
 *
 * Known properties of the git mechanism (shared with Claude Code's worktrees):
 *   - the source must be a git repository with at least one commit; asking for
 *     isolation elsewhere fails the run with an actionable ConfigError
 *   - the worktree is a clean checkout of the base commit — the agent sees the
 *     last commit, not any uncommitted edits in the source tree
 *   - submodules are NOT initialised (their directories are empty), and
 *     absolute symlinks are checked out verbatim — a link that points back
 *     into the source tree escapes the isolation if the agent writes through it
 */

import { execFile } from "node:child_process";
import { mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { ConfigError } from "./errors.js";

const run = promisify(execFile);

export type WorkspaceMode = "inplace" | "worktree";

export interface Workspace {
  /** Directory the agent runs in. */
  path: string;
  /** The original source tree. */
  source: string;
  /** Unified diff of the agent's changes, computed on demand (empty for inplace). */
  diff(): Promise<string>;
}

/** Everything the runner captures from git directly is small; diffs go to a file. */
const GIT_MAX_BUFFER = 4 * 1024 * 1024;
/** Diffs beyond this are truncated with a marker (nothing downstream wants 1 GiB). */
const DIFF_CAP_BYTES = 32 * 1024 * 1024;

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", dir, ...args], {
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
  });
  return stdout;
}

function gitDetail(err: unknown): string {
  return (err as { stderr?: string }).stderr?.trim() || (err as Error).message;
}

/** Read at most `cap` bytes of `path`, appending a truncation marker if cut. */
async function readCapped(path: string, cap: number): Promise<string> {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    const buf = Buffer.alloc(Math.min(size, cap));
    const { bytesRead } = await file.read(buf, 0, buf.length, 0);
    const text = buf.subarray(0, bytesRead).toString("utf8");
    return size <= cap ? text : `${text}\n... [diff truncated: ${size} bytes total, first ${cap} shown]\n`;
  } finally {
    await file.close();
  }
}

/** Open a workspace, run `fn` inside it, then clean up (worktree mode only). */
export async function withWorkspace<T>(
  source: string,
  mode: WorkspaceMode,
  fn: (workspace: Workspace) => Promise<T>,
): Promise<T> {
  if (mode === "inplace") {
    return fn({ path: source, source, diff: async () => "" });
  }
  if (mode !== "worktree") {
    throw new Error(`unknown workspace mode '${mode}'; use 'inplace' or 'worktree'`);
  }

  // Resolve the repo first so "not a repo / no commits" gets its own targeted
  // message, and a later `worktree add` failure (LFS, filters, permissions)
  // reports git's actual complaint instead of misleading init advice.
  let top: string;
  let base: string;
  try {
    top = (await git(source, ["rev-parse", "--show-toplevel"])).trim();
    base = (await git(source, ["rev-parse", "--verify", "HEAD"])).trim();
  } catch (err) {
    // A ConfigError is fatal: every isolated agent of the run would fail the
    // same way, and swallowing each as a null result would turn a setup
    // problem into a "successful" run full of empty slots.
    throw new ConfigError(
      `isolation "worktree" needs a git repository with at least one commit at '${source}' ` +
        `(agents are isolated via git worktrees, as in Claude Code). ` +
        `Run without isolation, or initialise the repo first. git said: ${gitDetail(err)}`,
    );
  }

  const tmp = await mkdtemp(join(tmpdir(), "odw-wt-"));
  const work = join(tmp, basename(top));
  try {
    // Pin the worktree to the resolved base commit: immune to concurrent HEAD
    // movement, and the later diff is taken against this exact baseline.
    await git(top, ["worktree", "add", "--detach", work, base]);
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    throw new Error(`could not create an isolated git worktree from '${top}': ${gitDetail(err)}`);
  }

  // The worktree mirrors the REPO root; the agent's workspace is the source's
  // corresponding subdirectory inside it (`--source repo/packages/foo` must not
  // silently promote the agent to the repo root). realpath BOTH sides: git
  // reports the resolved toplevel while `source` may arrive through a symlink
  // (macOS /tmp, /var), and a mismatched `relative()` would escape the worktree.
  const rel = relative(await realpath(top), await realpath(resolve(source)));
  const wsPath = rel === "" || rel.startsWith("..") ? work : join(work, rel);

  const ws: Workspace = {
    path: wsPath,
    source,
    diff: async () => {
      // Intent-to-add stages the *paths* of brand-new files (respecting
      // .gitignore) so they appear in the diff; diffing against the pinned
      // base commit keeps staged and even committed work visible.
      await git(work, ["add", "--all", "--intent-to-add", "."]);
      const out = join(tmp, "odw-diff.patch");
      // --output writes to a file: no stdout buffer to overflow, any size.
      await git(work, ["diff", base, `--output=${out}`]);
      return readCapped(out, DIFF_CAP_BYTES);
    },
  };
  try {
    return await fn(ws);
  } finally {
    // An agent may have locked its worktree; unlock (best-effort), then
    // remove with double --force (dirty AND locked); if git still refuses,
    // delete the tree and prune the stale registration.
    await git(top, ["worktree", "unlock", work]).catch(() => {});
    try {
      await git(top, ["worktree", "remove", "--force", "--force", work]);
    } catch {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
      await git(top, ["worktree", "prune"]).catch(() => {});
    }
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
