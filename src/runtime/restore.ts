/**
 * `odw restore <run> [--check] [--force]` (T3; an ODW extension): put back
 * the working tree a run's safety snapshot kept (see ../safety).
 *
 * The snapshot is a commit at `refs/odw/safety/<run>` in the run's source
 * repository: the working tree as it stood before the run's first in-place
 * agent, its first parent HEAD as it stood. What it kept is what differs
 * between the two — each file's content, mode, or absence. A file the tree
 * holds as the snapshot kept it already (an untracked file `git reset
 * --hard` left alone) is left out; the rest go through `odw apply`'s
 * machinery (./apply) as one diff, from that HEAD to the snapshot: the same
 * file-by-file preview — clean, CONFLICT with the conflicting lines, already
 * applied — the same refusal while a path it touches holds uncommitted
 * changes (unless `--force`) or something is in the way, and the same
 * three-way apply, staged. `--check` stops after the preview.
 *
 * When HEAD has moved since — an agent's `git reset --hard origin/main` —
 * the changes go on top of where it is now, three-way, and the report names
 * the commit HEAD was at, which the snapshot keeps reachable.
 */

import { lstat, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DIFF_CONFIG, DIFF_FLAGS, git, runGit, splitNul } from "../changes.js";
import { safetyRef } from "../safety.js";
import type { TermCaps } from "../tty.js";
import { applyAgents, type Writer } from "./apply.js";
import type { AgentRow } from "./agents-view.js";

export interface RestoreOptions {
  runId: string;
  /** Where the run worked: the snapshot is in its repository, and goes back there. */
  source: string;
  /** Preview only (`--check`). */
  check: boolean;
  /** Restore over uncommitted changes in the paths the snapshot touches (`--force`). */
  force: boolean;
  /** Fires on a signal: nothing more is applied. */
  interrupt?: AbortSignal;
  out: Writer;
  err: Writer;
  caps: TermCaps;
  /** Columns a line may take. */
  width: number;
}

/** One file the snapshot kept: its path, and what it kept of it (mode "000000": deleted). */
interface Kept {
  path: string;
  mode: string;
  blob: string;
}

/** Paths per `git diff` of the restore's diff: well within any command-line limit. */
const PATHS_PER_DIFF = 200;

/** What the apply's report calls the snapshot. */
const NAME = "the safety snapshot";

/**
 * `odw restore` (see the module doc): writes its report and returns the exit
 * code — 0 when everything was put back (or would be, or was there already),
 * 1 otherwise.
 */
export async function restoreSnapshot(o: RestoreOptions): Promise<number> {
  const ref = safetyRef(o.runId);
  if (!ref) {
    o.err.write(`odw restore: ${o.runId} is not a run id a snapshot could be kept under\n`);
    return 1;
  }
  let repo: string;
  try {
    repo = (await git(o.source, ["rev-parse", "--show-toplevel"])).trim();
  } catch (err) {
    o.err.write(`odw restore: run ${o.runId} worked in ${o.source}, which is not a git working tree here: ${errorText(err)}\n`);
    return 1;
  }
  const commit = (await runGit(repo, ["rev-parse", "--verify", "-q", `${ref}^{commit}`])).stdout.trim();
  if (!commit) {
    o.err.write(
      `odw restore: run ${o.runId} has no safety snapshot in ${repo} — one is taken before a run's first in-place agent ` +
        `with edit or full permissions, when the working tree has uncommitted changes\n`,
    );
    return 1;
  }
  const base = (await git(repo, ["rev-parse", `${commit}^1`])).trim();
  const head = (await runGit(repo, ["rev-parse", "--verify", "-q", "HEAD^{commit}"])).stdout.trim();
  o.out.write(`run ${o.runId}'s safety snapshot ${commit.slice(0, 12)} (${ref}), taken at HEAD ${base.slice(0, 12)}\n`);
  if (head !== base) {
    o.out.write(
      `HEAD has moved since: it is at ${head ? head.slice(0, 12) : "no commit"} now — the snapshot's changes go on top of it, ` +
        `three-way; the commit HEAD was at is ${base}\n`,
    );
  }

  const kept = await keptFiles(repo, base, commit);
  const submodules = kept.filter((k) => k.mode === "160000");
  const files = kept.filter((k) => k.mode !== "160000");
  const held = await heldAlready(repo, files);
  const pending = files.filter((k) => !held.has(k.path));
  if (submodules.length > 0) {
    o.err.write(`odw restore: left out ${submodules.length} submodule(s) the snapshot names: ${submodules.map((k) => k.path).join(", ")}\n`);
  }
  if (pending.length === 0) {
    o.out.write(`nothing to restore: ${repo} holds all ${files.length} file(s) the snapshot kept as it kept them\n`);
    return 0;
  }
  if (held.size > 0) {
    o.out.write(`${held.size} of the snapshot's ${files.length} file(s) are as it kept them already; the other ${pending.length}:\n`);
  }

  const work = await mkdtemp(join(tmpdir(), "odw-restore-"));
  try {
    const file = join(work, "snapshot.diff");
    await writeDiff(repo, base, commit, pending.map((k) => k.path), work, file);
    return await applyAgents({
      cwd: repo,
      runId: o.runId,
      agents: [{ row: snapshotRow(), file, name: NAME }],
      all: false,
      check: o.check,
      force: o.force,
      verify: null,
      timeout: null,
      interrupt: o.interrupt,
      source: o.source,
      resolve: null,
      out: o.out,
      err: o.err,
      caps: o.caps,
      width: o.width,
    });
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/** The files that differ from `base` to `commit`: each one's path, and its mode and blob in `commit`. */
async function keptFiles(repo: string, base: string, commit: string): Promise<Kept[]> {
  const fields = splitNul(await git(repo, ["diff", "--raw", "-z", "--no-renames", "--no-abbrev", "--no-ext-diff", base, commit]));
  const kept: Kept[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    // ":<old mode> <new mode> <old blob> <new blob> <status>", then the path.
    const parts = fields[i]!.replace(/^:/, "").split(" ");
    if (parts.length < 5) continue;
    kept.push({ path: fields[i + 1]!, mode: parts[1]!, blob: parts[3]! });
  }
  return kept;
}

/**
 * The paths of `files` the working tree holds already as the snapshot kept
 * them: the same content (hashed as git would add it), the same mode or link
 * target — or, for one the snapshot kept deleted, nothing there.
 */
async function heldAlready(repo: string, files: Kept[]): Promise<Set<string>> {
  const held = new Set<string>();
  const toHash: Kept[] = [];
  for (const k of files) {
    const st = await lstat(join(repo, k.path)).catch(() => null);
    if (/^0+$/.test(k.mode)) {
      if (!st) held.add(k.path);
    } else if (k.mode === "120000") {
      if (st?.isSymbolicLink()) {
        const target = await readlink(join(repo, k.path)).catch(() => null);
        const kept = await git(repo, ["cat-file", "blob", k.blob]).catch(() => null);
        if (target !== null && target === kept) held.add(k.path);
      }
    } else if (st?.isFile() && !k.path.includes("\n")) {
      const executable = (st.mode & 0o111) !== 0;
      if (process.platform === "win32" || executable === (k.mode === "100755")) toHash.push(k);
    }
  }
  if (toHash.length > 0) {
    const hashes = (await git(repo, ["hash-object", "--stdin-paths"], { input: `${toHash.map((k) => k.path).join("\n")}\n` })).split("\n");
    toHash.forEach((k, i) => {
      if (hashes[i]?.trim() === k.blob) held.add(k.path);
    });
  }
  return held;
}

/** The diff from `base` to `commit` of `paths` alone, as `odw apply` takes one, in `file`. */
async function writeDiff(repo: string, base: string, commit: string, paths: string[], work: string, file: string): Promise<void> {
  const parts: Buffer[] = [];
  for (let i = 0; i < paths.length; i += PATHS_PER_DIFF) {
    const part = join(work, `part-${i}.diff`);
    await git(repo, [
      ...DIFF_CONFIG,
      "--literal-pathspecs",
      "diff",
      ...DIFF_FLAGS,
      "--no-renames",
      "--binary",
      "--full-index",
      `--output=${part}`,
      base,
      commit,
      "--",
      ...paths.slice(i, i + PATHS_PER_DIFF),
    ]);
    parts.push(await readFile(part));
  }
  await writeFile(file, Buffer.concat(parts));
}

/** The row `odw apply`'s machinery takes the snapshot as: no agent, only a name. */
function snapshotRow(): AgentRow & { agentId: number } {
  return {
    agentId: 0,
    state: "done",
    label: NAME,
    phase: null,
    adapter: null,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    cached: false,
    error: null,
    record: null,
    changes: null,
    branch: null,
    permissions: null,
    trust: "trusted",
    fellBackFrom: null,
    quotaWait: null,
    limits: null,
    scope: null,
    outOfScope: null,
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
