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
 *     Before it goes, {@link Workspace.captureChanges} can keep the agent's
 *     change as a unified diff against the commit the worktree started from
 *     (staging or even committing inside the worktree does not hide work),
 *     leaving out what was placed there before the agent started — the bridge
 *     does so for a persisted run (an ODW extension; see ./changes).
 *
 * Known properties of the git mechanism (shared with Claude Code's worktrees):
 *   - the source must be a git repository with at least one commit; asking for
 *     isolation elsewhere fails the run with an actionable ConfigError
 *   - the worktree is a clean checkout of the base commit — the agent sees the
 *     last commit, not any uncommitted edits in the source tree. What a
 *     checkout lacks (`.env`, `node_modules`, …) `.worktreeinclude` brings in
 *     and `worktreeSetup` builds, before the agent starts (./worktree-setup)
 *   - submodules are NOT initialised (their directories are empty), and
 *     absolute symlinks are checked out verbatim — a link that points back
 *     into the source tree escapes the isolation if the agent writes through it
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  captureChanges,
  listChanges,
  relativeToDir,
  snapshotWorktree,
  type CaptureOptions,
  type CapturedChanges,
  type WorktreeBaseline,
} from "./changes.js";
import { ConfigError } from "./errors.js";
import { prepareWorktree, type WorktreeSetupOptions } from "./worktree-setup.js";

const run = promisify(execFile);

export type WorkspaceMode = "inplace" | "worktree";

export interface Workspace {
  /** Directory the agent runs in. */
  path: string;
  /** The original source tree. */
  source: string;
  /** Unified diff of the agent's changes, computed on demand (empty for inplace). */
  diff(): Promise<string>;
  /**
   * Write the agent's change to `options.path` as a unified diff — and commit
   * it, when asked — before the worktree goes (see ./changes). Null, with no
   * file written, when it changed nothing, and always for inplace.
   */
  captureChanges(options: CaptureOptions): Promise<CapturedChanges | null>;
  /**
   * The paths the agent changed — the files of the diff {@link captureChanges}
   * keeps — relative to {@link path}, with forward slashes (ODW extension: an
   * `expect` check reads them). Null for inplace: the source tree is shared,
   * so what one agent changed there is told against a snapshot of it instead
   * (see `snapshotTree` in ./changes).
   */
  changedPaths(signal?: AbortSignal): Promise<string[] | null>;
}

/** Everything the runner captures from git directly is small; diffs go to a file. */
const GIT_MAX_BUFFER = 4 * 1024 * 1024;
/** {@link Workspace.diff} keeps at most this much of a diff (nothing downstream wants 1 GiB). */
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

/**
 * Open a workspace, run `fn` inside it, then clean up (worktree mode only). A
 * new worktree is made ready first — `.worktreeinclude`, then the `setup`
 * command, see {@link prepareWorktree} — and a failure there fails the call
 * with a recoverable WorktreeSetupError, after the same cleanup.
 */
export async function withWorkspace<T>(
  source: string,
  mode: WorkspaceMode,
  fn: (workspace: Workspace) => Promise<T>,
  setup: WorktreeSetupOptions = {},
): Promise<T> {
  if (mode === "inplace") {
    return fn({ path: source, source, diff: async () => "", captureChanges: async () => null, changedPaths: async () => null });
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
  const inRoot = rel === "" || rel.startsWith("..");
  const wsPath = inRoot ? work : join(work, rel);

  // What the worktree holds before the agent starts is not the agent's change.
  let baseline: WorktreeBaseline | Error = new Error("the worktree was never made ready");
  const known = (): WorktreeBaseline => {
    if (baseline instanceof Error) {
      throw new Error(`what was in the worktree before the agent started is unknown: ${baseline.message}`);
    }
    return baseline;
  };
  const capture = async (options: CaptureOptions): Promise<CapturedChanges | null> =>
    captureChanges({ top, work, base, scratch: tmp }, known(), options);
  const ws: Workspace = {
    path: wsPath,
    source,
    diff: async () => {
      // Diffed against the pinned base commit: staged and even committed work stays visible.
      const out = join(tmp, "odw-diff.patch");
      return (await capture({ path: out, maxDiffBytes: DIFF_CAP_BYTES })) ? readFile(out, "utf8") : "";
    },
    captureChanges: capture,
    changedPaths: async (signal) => {
      const paths = await listChanges({ top, work, base, scratch: tmp }, known(), signal);
      return inRoot ? paths : paths.map((path) => relativeToDir(rel.split(sep).join("/"), path));
    },
  };
  // The links .worktreeinclude made to the source tree go first, so removing
  // the worktree can never reach through one into the source.
  const links: string[] = [];
  try {
    const placed = await prepareWorktree(top, work, wsPath, setup, links);
    // Just before the agent starts: what the include step and the setup left here.
    baseline = await snapshotWorktree(work, placed, setup.signal).catch((err: unknown) =>
      err instanceof Error ? err : new Error(String(err)),
    );
    return await fn(ws);
  } finally {
    for (const link of links) await unlink(link).catch(() => {});
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
