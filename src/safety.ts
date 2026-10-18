/**
 * A safety snapshot of the user's working tree (T3; an ODW extension).
 *
 * An agent that works in place — no `isolation: "worktree"` — with a tier
 * that lets it change things (`edit` or `full`) works in the user's own
 * working tree, beside their uncommitted work. Before the first such agent of
 * a run starts, ODW keeps what that tree holds, when it holds anything git
 * would not already have:
 *
 *   - `git stash create` — a commit of the tracked files' changes, staged and
 *     not, that leaves the working tree, the index and the stash list as they
 *     are;
 *   - the untracked files git does not ignore, added to a tree of their own
 *     through a scratch index (the real one is never touched). Ignored files
 *     are not kept — their size is anyone's guess — nor is an untracked file
 *     over {@link MAX_UNTRACKED_BYTES}, nor one whose name says it holds a
 *     secret ({@link isSecretLikeFile}: `.env`, `*.pem`, `id_rsa`, …), which
 *     the snapshot names instead;
 *
 * together as one commit — its tree the whole working tree as it stood, its
 * parents HEAD and (when there was one) the stash commit — at
 * `refs/odw/safety/<run>`. A ref, not a stash entry or a branch: nothing the
 * user lists day to day shows it, and `git gc` keeps it — as does `git push
 * --mirror`, which would publish it, until `odw gc` deletes it with its run
 * (hence no secret-named files in it). The run says so in a
 * `safety_snapshot` event; `odw restore <run>` previews and puts it back (see
 * runtime/restore.ts). A clean tree needs no snapshot and gets none. A
 * snapshot that cannot be taken — not a git repository, no commit yet, a
 * merge in progress — never stops the agent: the run's log says why.
 */

import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

import { git, runGit, splitNul } from "./changes.js";
import { LOG, SAFETY_SNAPSHOT, event, type WorkflowEvent } from "./events.js";

/** Where a run's snapshot is kept: `refs/odw/safety/<run>`. */
export const SAFETY_REF_PREFIX = "refs/odw/safety/";

/** An untracked file larger than this is left out of a snapshot — and named in it. */
export const MAX_UNTRACKED_BYTES = 50 * 1024 * 1024;

/** Untracked files left out that a snapshot names; past them, a count. */
const SKIPPED_NAMED = 20;

/** Untracked files whose names say they hold a secret: never kept in a snapshot (a ref `git push --mirror` would publish). */
const SECRET_LIKE_FILE = /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12)|id_(?:rsa|ed25519|ecdsa)|credentials\.json)$/i;

/** Whether an untracked file's name says it holds a secret: `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `id_rsa`, `id_ed25519`, `id_ecdsa`, `credentials.json`. */
export function isSecretLikeFile(path: string): boolean {
  return SECRET_LIKE_FILE.test(path.slice(path.lastIndexOf("/") + 1));
}

/** Who a snapshot's commits are by: ODW, whatever the repository's identity (it may have none). */
const IDENTITY = {
  GIT_AUTHOR_NAME: "odw",
  GIT_AUTHOR_EMAIL: "odw@localhost",
  GIT_COMMITTER_NAME: "odw",
  GIT_COMMITTER_EMAIL: "odw@localhost",
};

/** The ref a run's snapshot is kept at, or null for a run id git would not take as a ref name. */
export function safetyRef(runId: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) || runId.includes("..") || runId.endsWith(".lock") || runId.endsWith(".")) return null;
  return `${SAFETY_REF_PREFIX}${runId}`;
}

/** A snapshot as it was taken. */
export interface SafetySnapshotInfo {
  ref: string;
  /** The snapshot commit: the whole working tree as it stood. */
  commit: string;
  /** HEAD as it stood: the snapshot's first parent. */
  head: string;
  /** The `git stash create` commit, when tracked files had changes; null otherwise. */
  stash: string | null;
  /** Tracked files whose changes it kept. */
  tracked: number;
  /** Untracked files it kept. */
  untracked: number;
  /** Untracked files left out for their size (at most {@link SKIPPED_NAMED}, then "… and N more"). */
  skipped: string[];
  /** Untracked files left out for a name that says they hold a secret (at most {@link SKIPPED_NAMED}, then "… and N more"). */
  secretLike: string[];
}

/** What came of trying: a snapshot, a clean tree, or why none could be taken. */
export type SnapshotOutcome = { taken: SafetySnapshotInfo } | { clean: true } | { none: string };

/**
 * Snapshot the working tree `source` lies in (see the module doc) at
 * `refs/odw/safety/<runId>`. `exclude` are directories ODW itself writes
 * while the run goes on — its run directory, should it lie in the tree —
 * whose files are left out. Never throws: a failure is the outcome's `none`.
 */
export async function takeSafetySnapshot(source: string, runId: string, exclude: string[] = []): Promise<SnapshotOutcome> {
  const ref = safetyRef(runId);
  if (!ref) return { none: `run id ${JSON.stringify(runId)} is not a name git takes for a ref` };
  let top: string;
  try {
    top = (await git(source, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    return { none: "the run's directory is not in a git repository" };
  }
  if (!top) return { none: "the run's directory is not in a git working tree" };
  const head = (await runGit(top, ["rev-parse", "--verify", "-q", "HEAD^{commit}"])).stdout.trim();
  if (!head) return { none: "the repository has no commit yet" };
  const env = { ...process.env, ...IDENTITY };
  let scratch: string | null = null;
  try {
    const stash = (await git(top, ["stash", "create", `odw: safety snapshot before run ${runId}`], { env })).trim() || null;
    // The directories left out, as git lists paths: relative to the top, with slashes.
    const left: string[] = [];
    for (const dir of exclude) {
      const rel = relative(top, await realpath(dir).catch(() => dir));
      if (rel && !rel.startsWith("..") && !isAbsolute(rel)) left.push(rel.split(sep).join("/"));
    }
    const skipped: string[] = [];
    const secretLike: string[] = [];
    const untracked: string[] = [];
    for (const path of splitNul(await git(top, ["ls-files", "--others", "--exclude-standard", "-z"]))) {
      // A nested repository is listed as its directory: it is not ours to keep.
      if (path.endsWith("/")) continue;
      if (left.some((dir) => path === dir || path.startsWith(`${dir}/`))) continue;
      if (isSecretLikeFile(path)) {
        secretLike.push(path);
        continue;
      }
      const size = await lstat(join(top, path)).then(
        (st) => (st.isFile() ? st.size : 0),
        () => -1,
      );
      if (size < 0) continue; // gone since it was listed
      if (size > MAX_UNTRACKED_BYTES) skipped.push(path);
      else untracked.push(path);
    }
    if (!stash && untracked.length === 0) return { clean: true };
    // The untracked files go into a tree through a scratch index: the user's index is never touched.
    scratch = await mkdtemp(join(tmpdir(), "odw-safety-"));
    const indexEnv = { ...env, GIT_INDEX_FILE: join(scratch, "index") };
    await git(top, ["read-tree", stash ?? head], { env: indexEnv });
    if (untracked.length > 0) {
      await git(top, ["update-index", "--add", "-z", "--stdin"], { env: indexEnv, input: `${untracked.join("\0")}\0` });
    }
    const tree = (await git(top, ["write-tree"], { env: indexEnv })).trim();
    const message = `odw: safety snapshot before run ${runId}'s first in-place agent`;
    const commit = (await git(top, ["commit-tree", tree, "-p", head, ...(stash ? ["-p", stash] : []), "-m", message], { env })).trim();
    await git(top, ["update-ref", "-m", message, ref, commit]);
    const tracked = stash ? splitNul(await git(top, ["diff", "--name-only", "-z", "--no-renames", head, stash])).length : 0;
    return { taken: { ref, commit, head, stash, tracked, untracked: untracked.length, skipped: named(skipped), secretLike: named(secretLike) } };
  } catch (err) {
    return { none: err instanceof Error ? err.message : String(err) };
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/** The first {@link SKIPPED_NAMED} of `paths`, then "… and N more". */
function named(paths: string[]): string[] {
  const out = paths.slice(0, SKIPPED_NAMED);
  if (paths.length > out.length) out.push(`… and ${paths.length - out.length} more`);
  return out;
}

/** The `safety_snapshot` event of a snapshot taken for `runId`. */
export function snapshotEvent(runId: string, info: SafetySnapshotInfo): WorkflowEvent {
  const files = [
    ...(info.tracked > 0 ? [`${info.tracked} changed tracked file${info.tracked === 1 ? "" : "s"}`] : []),
    ...(info.untracked > 0 ? [`${info.untracked} untracked file${info.untracked === 1 ? "" : "s"}`] : []),
  ].join(" and ");
  const left =
    (info.skipped.length > 0 ? ` (left out for their size: ${info.skipped.join(", ")})` : "") +
    (info.secretLike.length > 0 ? ` (left out as secret-like: ${info.secretLike.join(", ")})` : "");
  return event(SAFETY_SNAPSHOT, {
    message:
      `safety snapshot of the working tree before the first in-place agent: ${files || "its changes"}${left} ` +
      `kept at ${info.ref} (${info.commit.slice(0, 12)}) — odw restore ${runId} puts them back`,
    ref: info.ref,
    commit: info.commit,
    head: info.head,
    ...(info.stash ? { stash: info.stash } : {}),
    tracked: info.tracked,
    untracked: info.untracked,
    ...(info.skipped.length > 0 ? { skipped: [...info.skipped] } : {}),
    ...(info.secretLike.length > 0 ? { secretLike: [...info.secretLike] } : {}),
  });
}

/** What a run's {@link SafetySnapshot} needs. */
export interface SafetySnapshotOptions {
  /** The run's working directory: the tree its in-place agents work in. */
  source: string;
  runId: string;
  /** The run's directory, left out of the snapshot should it lie in the tree. */
  runDir?: string;
  emit(ev: WorkflowEvent): void;
}

/**
 * A run's safety snapshot (see the module doc): taken once, before its first
 * in-place agent that may change things starts. Shared by the whole run — a
 * nested workflow()'s agents included — so it is taken once, and every such
 * agent that starts meanwhile waits for it.
 */
export class SafetySnapshot {
  private taking: Promise<void> | null = null;
  /** The snapshot, once taken; null before, or when there was none to take. */
  info: SafetySnapshotInfo | null = null;

  constructor(private readonly options: SafetySnapshotOptions) {}

  /** Before an in-place agent with `edit` or `full` starts: the first call takes the snapshot, the rest wait for it. Never throws. */
  before(): Promise<void> {
    this.taking ??= this.take();
    return this.taking;
  }

  private async take(): Promise<void> {
    const { source, runId, runDir, emit } = this.options;
    const outcome = await takeSafetySnapshot(source, runId, runDir ? [runDir] : []);
    if ("taken" in outcome) {
      this.info = outcome.taken;
      emit(snapshotEvent(runId, outcome.taken));
    } else if ("none" in outcome) {
      emit(
        event(LOG, {
          message:
            `safety: no snapshot of the working tree before the first in-place agent — ${outcome.none}; ` +
            `what a destructive git command of an agent throws away cannot be put back with odw restore`,
          safety: "none",
        }),
      );
    }
  }
}
