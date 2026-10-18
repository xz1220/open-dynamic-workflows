/**
 * Applying what isolated agents changed (L5, an ODW extension): `odw apply`.
 *
 * An isolated agent that changed anything kept a unified diff in the run
 * directory (see ../changes). `odw apply` applies one agent's — or, with
 * `--all`, every finished agent's, in agentId order — to the git working tree
 * it runs in, at its root, with `git apply --3way`: what applies is staged,
 * and a hunk that does not apply as is is merged three-way. It refuses while a
 * path a diff touches has uncommitted changes, unless `--force`.
 *
 * Nothing is touched before a preview. The same apply runs against a scratch
 * copy of the index (`--cached`), and each file of a diff comes out clean,
 * CONFLICT — with its conflicting lines, as the merge would leave them in the
 * file, or with why git cannot merge it at all (a file deleted on one side) —
 * or already applied: the file holds what the agent made of it, or the merge
 * would change nothing. What the index cannot show is checked in the working
 * tree: a diff that would write over a file where a rename lands or an
 * untracked or ignored file, or that needs a directory where a file is, is
 * not applied at all — nor is one with a path that is not UTF-8. `--all`
 * previews the agents stacked, each on top of the ones before it; one that
 * would conflict is left out of the stack, so the agents after it are
 * previewed without it. `--check` stops after the preview. Then one agent is
 * applied with its conflicts left marked, while `--all` applies the agents in
 * order and stops before the first that would conflict. What an apply touches
 * is saved first: should git give up halfway through writing the tree, the
 * rollback below puts back what it wrote.
 *
 * `--verify <command>` (or the `applyVerify` setting) runs a shell command at
 * the repository root after each apply, bounded by the `timeout` setting.
 * When it fails, or a signal cuts it short, that apply is rolled back: every
 * path it touched gets back exactly what it held — the file's bytes, its mode
 * or link target, and its index entries (conflict stages, assume-unchanged and
 * skip-worktree bits included) — saved just before the apply. What changed
 * in those paths while the command ran is set aside first, not lost. Nothing
 * else is touched (no stash, no reset), so uncommitted work elsewhere in the
 * tree stays as it is.
 *
 * `--resolve` hands an agent whose diff would conflict to a resolver agent
 * instead of stopping (or leaving markers): a run of its own (./apply-resolve)
 * in a temporary worktree at the state the diff lands on, told the base and
 * both sides of each conflicting file. Its change is applied only when it
 * touches the conflicting files alone, leaves no conflict markers, and passes
 * the verify command in that worktree — and, with `--confirm`, a person says
 * y — together with the agent's files that applied cleanly; see resolveOne.
 */

import { spawn } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readdir, readFile, readlink, rm, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { SAFE_GIT } from "../git-safety.js";
import { prepareWorktree } from "../worktree-setup.js";
import { runCommand } from "../adapters/runner.js";
import { cliOk } from "../adapters/types.js";
import { fingerprint, git, runGit, splitNul, type GitOptions } from "../changes.js";
import { displayWidth, padEndWidth, palette, sanitizeText, truncateToWidth, type TermCaps } from "../tty.js";
import type { AgentRow } from "./agents-view.js";
import { diffFiles, fileLabel, truncationNoteOf, type DiffFile } from "./changes-view.js";

// --- a kept diff, file by file ----------------------------------------------------------

/** One file of a kept diff, with its own section of the diff: a patch git applies on its own. */
interface DiffSection extends DiffFile {
  patch: Buffer;
  /** The blob it changes and the blob it makes (its `index` line); null for none: a new or deleted file, a mode change or a pure rename. */
  before: string | null;
  after: string | null;
  /** Its mode once changed; null when it is deleted, or the header does not say. */
  mode: string | null;
}

const SECTION_START = "diff --git ";

/**
 * A kept diff, split into its files. The bytes stay as they are — the patch
 * of a file in another encoding must reach git unchanged — and only each
 * file's text is read, for its header.
 */
function diffSections(bytes: Buffer): DiffSection[] {
  const starts: number[] = [];
  if (bytes.subarray(0, SECTION_START.length).toString("latin1") === SECTION_START) starts.push(0);
  const marker = Buffer.from(`\n${SECTION_START}`);
  for (let at = bytes.indexOf(marker); at !== -1; at = bytes.indexOf(marker, at + 1)) starts.push(at + 1);
  const sections: DiffSection[] = [];
  starts.forEach((start, i) => {
    const patch = bytes.subarray(start, starts[i + 1] ?? bytes.length);
    const text = patch.toString("utf8");
    const file = diffFiles(text)[0];
    if (file) sections.push({ ...file, patch, ...headerFacts(text) });
  });
  return sections;
}

const NO_BLOB = /^0+$/;

/** The blobs and the resulting mode a file's header names. */
function headerFacts(text: string): Pick<DiffSection, "before" | "after" | "mode"> {
  let before: string | null = null;
  let after: string | null = null;
  let mode: string | null = null;
  let changedMode: string | null = null;
  for (const line of text.split("\n", 16)) {
    if (line.startsWith("--- ") || line.startsWith("@@") || line.startsWith("Binary files ") || line === "GIT binary patch") break;
    const index = /^index ([0-9a-f]+)\.\.([0-9a-f]+)(?: ([0-7]+))?$/.exec(line);
    if (index) {
      before = NO_BLOB.test(index[1]!) ? null : index[1]!;
      after = NO_BLOB.test(index[2]!) ? null : index[2]!;
      mode = index[3] ?? mode;
      continue;
    }
    const changed = /^new (?:file )?mode ([0-7]+)$/.exec(line);
    if (changed) changedMode = changed[1]!;
  }
  return { before, after, mode: changedMode ?? mode };
}

/** The path a file's change lands on. */
function target(f: DiffFile): string {
  return f.newPath ?? f.oldPath ?? "";
}

/** Every path `files` touch: both sides of a rename. */
function touchedPaths(files: DiffFile[]): string[] {
  const paths = new Set<string>();
  for (const f of files) {
    if (f.oldPath !== null) paths.add(f.oldPath);
    if (f.newPath !== null) paths.add(f.newPath);
  }
  return [...paths];
}

// --- the index --------------------------------------------------------------------------

/** One entry of an index: a path at one stage (0, or 1–3 while it is conflicted). */
interface IndexEntry {
  mode: string;
  oid: string;
  stage: number;
}

/** Characters of pathspecs given to one git command (Windows caps a command line at 32K). */
const PATHSPEC_CHARS = 8000;

/** The entries of `paths` — every stage — in the index `opts.env` names (the repository's own by default). */
async function indexEntries(repo: string, paths: Iterable<string>, opts: GitOptions = {}): Promise<Map<string, IndexEntry[]>> {
  const wanted = new Set(paths);
  const found = new Map<string, IndexEntry[]>();
  for (const chunk of chunked([...wanted])) {
    const out = await git(repo, ["--literal-pathspecs", "ls-files", "--stage", "-z", "--", ...chunk], opts);
    for (const record of splitNul(out)) {
      const tab = record.indexOf("\t");
      const path = record.slice(tab + 1);
      // A pathspec names what is inside a directory of that name too.
      if (!wanted.has(path)) continue;
      const [mode, oid, stage] = record.slice(0, tab).split(" ");
      const list = found.get(path) ?? [];
      list.push({ mode: mode!, oid: oid!, stage: Number(stage) });
      found.set(path, list);
    }
  }
  return found;
}

/** `paths` in runs short enough for one command line. */
function chunked(paths: string[]): string[][] {
  const out: string[][] = [];
  let chunk: string[] = [];
  let length = 0;
  for (const path of paths) {
    if (chunk.length > 0 && length + path.length + 1 > PATHSPEC_CHARS) {
      out.push(chunk);
      chunk = [];
      length = 0;
    }
    chunk.push(path);
    length += path.length + 1;
  }
  if (chunk.length > 0) out.push(chunk);
  return out;
}

function sameEntries(a: IndexEntry[] | undefined, b: IndexEntry[] | undefined): boolean {
  const key = (list: IndexEntry[] | undefined): string =>
    (list ?? [])
      .map((e) => `${e.stage} ${e.mode} ${e.oid}`)
      .sort()
      .join("\n");
  return key(a) === key(b);
}

/** A scratch copy of the repository's index: what a preview applies to. */
interface Scratch {
  index: string;
  env: NodeJS.ProcessEnv;
}

async function scratchIndex(repo: string, work: string): Promise<Scratch> {
  const index = join(work, "index");
  const own = resolve(repo, (await git(repo, ["rev-parse", "--git-path", "index"])).trim());
  await copyIfThere(own, index);
  return { index, env: { ...process.env, GIT_INDEX_FILE: index } };
}

/** Copy `from` to `to`; where `from` does not exist (a repository with no index yet), `to` goes too. */
async function copyIfThere(from: string, to: string): Promise<void> {
  try {
    await copyFile(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    await rm(to, { force: true });
  }
}

// --- applying -------------------------------------------------------------------------

/** How one `git apply --3way` went: its exit code and stderr, and the paths it left conflicted. */
interface ApplyResult {
  code: number | null;
  stderr: string;
  conflicted: Set<string>;
}

let patches = 0;

/**
 * `git apply --3way` the patches of `files` at the repository's root: to the
 * index `env` names alone (`cached`), or to the working tree and the index.
 */
async function applyFiles(
  repo: string,
  files: DiffSection[],
  work: string,
  opts: { cached: boolean; env?: NodeJS.ProcessEnv },
): Promise<ApplyResult> {
  const targets = new Set(files.map(target));
  const unmerged = async (): Promise<Set<string>> =>
    new Set(
      splitNul(await git(repo, ["ls-files", "--unmerged", "-z"], { env: opts.env }))
        .map((entry) => entry.slice(entry.indexOf("\t") + 1))
        .filter((path) => targets.has(path)),
    );
  const patch = join(work, `patch-${++patches}.diff`);
  await writeFile(patch, Buffer.concat(files.map((f) => f.patch)));
  try {
    // A path the user left in the middle of a merge is not a conflict of this apply (git refuses to touch it).
    const before = await unmerged();
    const applied = await runGit(repo, ["apply", "--3way", ...(opts.cached ? ["--cached"] : []), patch], { env: opts.env });
    const conflicted = new Set([...(await unmerged())].filter((path) => !before.has(path)));
    return { code: applied.code, stderr: applied.stderr, conflicted };
  } finally {
    await rm(patch, { force: true }).catch(() => {});
  }
}

// --- the preview ----------------------------------------------------------------------

/** What applying one file would do: apply cleanly, conflict, or nothing — it is applied already. */
type FileOutcome = "clean" | "conflict" | "applied";

interface FilePreview {
  file: DiffSection;
  outcome: FileOutcome;
  /** A conflict: why, when there are no markers to show ("deleted here", "binary: …") or what git said; else null. */
  reason: string | null;
  /** The conflicting regions, as the merge leaves them in the file. */
  hunks: ConflictHunk[];
  /** Conflicting regions not shown. */
  moreHunks: number;
  /** Refused before git ran: by its path, or by what stands in the working tree where it goes. */
  blocked?: boolean;
  /** A text conflict's blobs — the common base (null when added on both sides), ours, theirs: what `--resolve` shows its resolver. */
  stages?: { base: string | null; ours: string; theirs: string };
}

/** One conflicting region of a file: `<<<<<<< ours` … `>>>>>>> theirs`. */
interface ConflictHunk {
  /** The line of the merged file its first marker is on. */
  line: number;
  lines: string[];
  /** Lines of it not shown. */
  more: number;
}

/** What applying one agent's diff would do. */
interface Preview {
  files: FilePreview[];
  /** git would refuse the diff as a whole and apply none of it: what it said. Null when it applies. */
  refused: string | null;
}

type Verdict = "clean" | "applied" | "conflict" | "refused";

function verdictOf(p: Preview): Verdict {
  if (p.refused !== null) return "refused";
  if (p.files.some((f) => f.outcome === "conflict")) return "conflict";
  return p.files.every((f) => f.outcome === "applied") ? "applied" : "clean";
}

/** Conflicting regions shown per file, and lines shown per region. */
const SHOWN_HUNKS = 5;
const SHOWN_HUNK_LINES = 40;

/**
 * Preview `files` on a scratch index: apply them there (`--cached`) and say,
 * file by file, what came of it. A file the tree holds already stays out of
 * the apply: git refuses to create a file that exists or to delete one that
 * does not, even one exactly as the agent left it. The scratch index keeps
 * the result, for the next agent of a stack to apply on top of.
 */
async function previewFiles(repo: string, files: DiffSection[], scratch: Scratch, work: string): Promise<Preview> {
  const before = await indexEntries(repo, touchedPaths(files), { env: scratch.env });
  const previews: FilePreview[] = files.map((file) => {
    const problem = pathProblem(file);
    return {
      file,
      outcome: problem ? "conflict" : holdsAlready(file, before) ? "applied" : "clean",
      reason: problem,
      hunks: [],
      moreHunks: 0,
      blocked: problem !== null,
    };
  });
  // A type change (a file become a link, …) is a deletion and an addition of one path: applied when the addition is.
  for (const p of previews) {
    if (p.file.status !== "deleted" || p.outcome !== "clean") continue;
    const twin = previews.find((q) => q.file.status === "added" && q.file.newPath === p.file.oldPath);
    if (twin?.outcome === "applied") p.outcome = "applied";
  }
  const obstacles = await inTheWay(repo, previews.filter((p) => p.outcome === "clean").map((p) => p.file), before, scratch);
  for (const [file, why] of obstacles) Object.assign(previews.find((p) => p.file === file)!, { outcome: "conflict", reason: why, blocked: true });
  // What odw itself will not apply makes the whole diff one it cannot: git would write the rest, or over something.
  const named = (f: DiffFile): string => (f.oldPath && f.newPath && f.oldPath !== f.newPath ? `${f.oldPath} → ${f.newPath}` : target(f));
  const refusals = previews.filter((p) => p.outcome === "conflict").map((p) => `${named(p.file)}: ${p.reason}`);
  const rest = previews.filter((p) => p.outcome === "clean");
  const refused = (more: string[] = []): string | null => (refusals.length + more.length > 0 ? [...refusals, ...more].join("\n") : null);
  if (rest.length === 0) return { files: previews, refused: refused() };
  const applied = await applyFiles(repo, rest.map((p) => p.file), work, { cached: true, env: scratch.env });
  if (applied.code === 0 || applied.conflicted.size > 0) {
    await settle(repo, rest, before, scratch, work);
    return { files: previews, refused: refused() };
  }
  // git applies nothing of a diff it refuses: find out which files, one at a time.
  for (const p of rest) {
    const one = await applyFiles(repo, [p.file], work, { cached: true, env: scratch.env });
    if (one.code === 0 || one.conflicted.size > 0) {
      await settle(repo, [p], before, scratch, work);
    } else {
      p.outcome = "conflict";
      p.reason = refusalReason(p.file, before) ?? gitSaid(one.stderr);
    }
  }
  return { files: previews, refused: refused(gitErrors(applied.stderr, applied.code)) };
}

/** What applying `previews` did to the scratch index: left a file conflicted, changed nothing, or applied it. */
async function settle(
  repo: string,
  previews: FilePreview[],
  before: Map<string, IndexEntry[]>,
  scratch: Scratch,
  work: string,
): Promise<void> {
  const after = await indexEntries(repo, touchedPaths(previews.map((p) => p.file)), { env: scratch.env });
  const unmerged = (entries: IndexEntry[] | undefined): boolean => (entries ?? []).some((e) => e.stage > 0);
  for (const p of previews) {
    const entries = after.get(target(p.file)) ?? [];
    if (unmerged(entries) && !unmerged(before.get(target(p.file)))) {
      p.outcome = "conflict";
      Object.assign(p, await conflictOf(repo, p.file, entries, work));
      continue;
    }
    const unchanged = touchedPaths([p.file]).every((path) => sameEntries(before.get(path), after.get(path)));
    p.outcome = unchanged ? "applied" : "clean";
  }
}

/**
 * Whether the index holds what the agent made of `f` already — its blob and
 * mode, and no file where it deleted or renamed one away — so that applying
 * it would change nothing.
 */
function holdsAlready(f: DiffSection, entries: Map<string, IndexEntry[]>): boolean {
  const at = (path: string | null): IndexEntry[] => (path === null ? [] : (entries.get(path) ?? []));
  if (f.status === "deleted") return at(f.oldPath).length === 0;
  const now = at(f.newPath);
  if (now.length !== 1 || now[0]!.stage !== 0) return false;
  if (f.after !== null && !now[0]!.oid.startsWith(f.after)) return false;
  if (f.mode !== null && now[0]!.mode !== f.mode) return false;
  return f.status !== "renamed" || at(f.oldPath).length === 0;
}

/** Why git refuses `f`, where the index tells: a file the agent changed that is gone here, one it deleted that changed here. */
function refusalReason(f: DiffSection, entries: Map<string, IndexEntry[]>): string | null {
  const at = (path: string | null): IndexEntry[] => (path === null ? [] : (entries.get(path) ?? []));
  if (f.status === "deleted") {
    const now = at(f.oldPath);
    return now.length > 0 && !now.some((e) => f.before !== null && e.oid.startsWith(f.before)) ? "changed here, deleted by the agent" : null;
  }
  if (f.status === "added") return at(f.newPath).length > 0 ? "already exists here" : null;
  if (at(f.oldPath).length === 0) return "deleted here";
  if (f.status === "renamed" && at(f.newPath).length > 0) return `renamed onto a file that exists here`;
  return null;
}

/**
 * Mark the files of a preview that touch `paths` — uncommitted changes git
 * will not apply over, even with --force: unstaged, untracked or unmerged —
 * as conflicts git refuses. The scratch index cannot see the working tree.
 */
function refuseUnstaged(preview: Preview, paths: Set<string>): void {
  const hit = preview.files.filter((f) => f.outcome !== "applied" && touchedPaths([f.file]).some((path) => paths.has(path)));
  if (hit.length === 0) return;
  for (const f of hit) {
    // What stands in the way, or the path itself, says more.
    if (f.blocked) continue;
    Object.assign(f, { outcome: "conflict", reason: "uncommitted changes here that are not staged", hunks: [], moreHunks: 0 });
  }
  const note = `uncommitted changes that are not staged in ${hit.map((f) => target(f.file)).join(", ")}`;
  preview.refused = preview.refused === null ? note : `${preview.refused}\n${note}`;
}

/**
 * Why odw will not apply a file, whatever the tree holds: a path that is not
 * UTF-8 (odw reads paths as text, so it would look at the wrong file), or one
 * that leaves the repository or reaches into .git.
 */
function pathProblem(f: DiffFile): string | null {
  for (const path of [f.oldPath, f.newPath]) {
    if (path === null) continue;
    if (path.includes("�")) return "its path is not UTF-8, which odw cannot apply (git apply --3way can)";
    const rooted = path.startsWith("/") || /^[A-Za-z]:/.test(path) || (process.platform === "win32" && path.includes("\\"));
    const steps = path.split("/");
    if (rooted || steps.some((step) => step === "" || step === "." || step === ".." || step.toLowerCase() === ".git")) {
      return "its path does not stay inside the repository";
    }
  }
  return null;
}

/** Entries odw looks through in a directory that stands where a file is created; past that, it is in the way. */
const DIR_SCAN_LIMIT = 2000;

/**
 * What stands where `files` create a path, that git would write over or only
 * trip on halfway through writing the tree: a tracked file where a rename
 * lands (git writes over it); an untracked or ignored file where a file is
 * created; a directory holding anything the diff does not delete, where a
 * file goes; a file where a directory is needed. `before` holds the scratch
 * index's entries of the files' paths: in a stack, what an agent before this
 * one deletes is no obstacle, though the working tree still has it.
 */
async function inTheWay(
  repo: string,
  files: DiffSection[],
  before: Map<string, IndexEntry[]>,
  scratch: Scratch,
): Promise<Map<DiffSection, string>> {
  const out = new Map<DiffSection, string>();
  const creating = files.filter((f) => f.newPath !== null && f.status !== "modified");
  if (creating.length === 0) return out;
  // What the diff deletes or renames away: git removes it before it writes.
  const deleted = new Set(files.filter((f) => f.status === "deleted" || f.status === "renamed").map((f) => f.oldPath!));
  const dirs = new Set(creating.flatMap((f) => ancestors(f.newPath!)));
  const own = await indexEntries(repo, [...creating.map((f) => f.newPath!), ...dirs]);
  const stacked = await indexEntries(repo, dirs, { env: scratch.env });
  for (const f of creating) {
    const path = f.newPath!;
    if (before.has(path)) {
      // git merges an added file with a tracked one (or refuses it), but a rename writes over it.
      if (f.status === "renamed" || f.status === "copied") out.set(f, "renamed onto a file that exists here");
      continue;
    }
    const info = await lstat(join(repo, path)).catch(() => null);
    // Untracked or ignored. (A tracked file missing from the stack's index is one an agent before this one deletes.)
    if (info && !info.isDirectory() && !own.has(path)) {
      out.set(f, "a file git does not track is in the way");
      continue;
    }
    if (info?.isDirectory() && !(await emptiedBy(repo, path, deleted))) {
      out.set(f, "a directory is in the way");
      continue;
    }
    for (const dir of ancestors(path)) {
      const at = await lstat(join(repo, dir)).catch(() => null);
      if (!at || at.isDirectory() || deleted.has(dir) || (own.has(dir) && !stacked.has(dir))) continue;
      out.set(f, `${dir} is a file here, where the diff needs a directory`);
      break;
    }
  }
  return out;
}

/** Whether the diff deletes everything in directory `dir` (relative to the root), so that a file can take its place. */
async function emptiedBy(repo: string, dir: string, deleted: Set<string>): Promise<boolean> {
  let seen = 0;
  const walk = async (rel: string): Promise<boolean> => {
    for (const entry of await readdir(join(repo, rel), { withFileTypes: true })) {
      if (++seen > DIR_SCAN_LIMIT) return false;
      const path = `${rel}/${entry.name}`;
      if (entry.isDirectory() ? !(await walk(path)) : !deleted.has(path)) return false;
    }
    return true;
  };
  return walk(dir).catch(() => false);
}

/** The directories above a path, outermost first: "a/b/c" has "a" and "a/b". */
function ancestors(path: string): string[] {
  const out: string[] = [];
  for (let at = path.indexOf("/"); at !== -1; at = path.indexOf("/", at + 1)) out.push(path.slice(0, at));
  return out;
}

/** git's error lines — all it said, when it marked none so — or how it ended, when it said nothing. */
function gitErrors(stderr: string, code: number | null): string[] {
  const lines = stderr.split("\n").filter((line) => line.trim() !== "");
  const errors = lines.filter((line) => /^(?:error|fatal): /.test(line));
  const said = errors.length > 0 ? errors : lines;
  return said.length > 0 ? said.slice(-10) : [`git apply exited with code ${code}`];
}

/** What git said when it refused a patch: its error lines, past their "error: ". */
function gitSaid(stderr: string): string {
  const lines = stderr.split("\n").filter((line) => line.trim() !== "");
  const errors = lines.filter((line) => line.startsWith("error: ")).map((line) => line.slice("error: ".length));
  return (errors.length > 0 ? errors : lines).slice(-2).join("; ") || "git refuses it";
}

/** A conflicted file's regions, merged from its stages in the scratch index — or why there are none to show. */
async function conflictOf(
  repo: string,
  file: DiffSection,
  entries: IndexEntry[],
  work: string,
): Promise<Pick<FilePreview, "reason" | "hunks" | "moreHunks" | "stages">> {
  const stage = (n: number): IndexEntry | undefined => entries.find((e) => e.stage === n);
  const [base, ours, theirs] = [stage(1), stage(2), stage(3)];
  const none = (reason: string | null) => ({ reason, hunks: [], moreHunks: 0 });
  if (!ours) return none("deleted here");
  if (!theirs) return none("deleted by the agent");
  if (file.binary) return none("binary: changed on both sides");
  try {
    const blobs = { ours: join(work, "ours"), base: join(work, "base"), theirs: join(work, "theirs") };
    await writeBlob(repo, ours.oid, blobs.ours);
    if (base) await writeBlob(repo, base.oid, blobs.base);
    else await writeFile(blobs.base, "");
    await writeBlob(repo, theirs.oid, blobs.theirs);
    // The labels git apply --3way writes; its exit code is the number of conflicts, 255 when git cannot merge (binary).
    const merged = await runGit(repo, ["merge-file", "-p", "-L", "ours", "-L", "base", "-L", "theirs", blobs.ours, blobs.base, blobs.theirs]);
    if (merged.code === null || merged.code > 127) return none("binary: changed on both sides");
    const stages = { base: base?.oid ?? null, ours: ours.oid, theirs: theirs.oid };
    return { reason: base ? null : "added on both sides", ...conflictRegions(merged.stdout), stages };
  } catch {
    return none(null); // a conflict all the same, with nothing to show
  }
}

/** Write blob `oid` of the repository to `path`, byte for byte. */
async function writeBlob(repo: string, oid: string, path: string): Promise<void> {
  const out = await open(path, "w");
  try {
    await new Promise<void>((done, fail) => {
      const child = spawn("git", ["-C", repo, ...SAFE_GIT, "cat-file", "blob", oid], { stdio: ["ignore", out.fd, "ignore"], windowsHide: true });
      child.once("error", fail);
      child.once("close", (code) => (code === 0 ? done() : fail(new Error(`git cat-file exited with code ${code}`))));
    });
  } finally {
    await out.close();
  }
}

/** The conflicting regions of a merged file, the first few of them. */
function conflictRegions(text: string): Pick<FilePreview, "hunks" | "moreHunks"> {
  const lines = text.split("\n");
  const hunks: ConflictHunk[] = [];
  let found = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.startsWith("<<<<<<< ours")) continue;
    const start = i;
    while (i < lines.length - 1 && !lines[i]!.startsWith(">>>>>>> theirs")) i++;
    found++;
    if (hunks.length === SHOWN_HUNKS) continue;
    const region = lines.slice(start, i + 1);
    hunks.push({ line: start + 1, lines: region.slice(0, SHOWN_HUNK_LINES), more: Math.max(0, region.length - SHOWN_HUNK_LINES) });
  }
  return { hunks, moreHunks: found - hunks.length };
}

// --- uncommitted changes in the way ---------------------------------------------------------

/** Uncommitted changes in `paths` — staged, unstaged, untracked or unmerged — as `git status` lists them. */
async function uncommitted(repo: string, paths: Set<string>): Promise<Array<{ path: string; how: string }>> {
  return statusEntries(await git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]))
    .filter((entry) => paths.has(entry.path))
    .map(({ path, xy }) => ({ path, how: describeStatus(xy) }));
}

/** The entries of `git status --porcelain=v1 -z`: each path with its two-letter state (a rename's source too). */
function statusEntries(out: string): Array<{ path: string; xy: string }> {
  const entries: Array<{ path: string; xy: string }> = [];
  const fields = out.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    if (field.length < 4) continue;
    const xy = field.slice(0, 2);
    entries.push({ path: field.slice(3).replace(/\/$/, ""), xy });
    if (/[RC]/.test(xy) && fields[i + 1]) entries.push({ path: fields[++i]!, xy });
  }
  return entries;
}

function describeStatus(xy: string): string {
  if (xy === "??") return "untracked";
  if (xy.includes("U") || xy === "AA" || xy === "DD") return "unmerged";
  if (xy[1] !== " ") return "changed, not staged";
  return "staged";
}

// --- rolling an apply back ------------------------------------------------------------

/** What one path held before an apply: its index entries, and what the working tree had there. */
interface SavedPath {
  path: string;
  entries: IndexEntry[];
  /** Its index entry's bits git apply drops: "a" assume-unchanged, "s" skip-worktree (entryFlags). */
  flags: string;
  /** fingerprint() of the working tree's entry; null when nothing was there. */
  print: string | null;
  /** fingerprint() of what the apply left there, once noted (appliedBy): what differs from both later is someone's edit. */
  after?: string | null;
  kind: "absent" | "file" | "link" | "dir" | "other";
  /** A file's permission bits. */
  mode?: number;
  /** A symlink's target. */
  target?: string;
  /** Where a file's bytes are kept. */
  copy?: string;
  /** The directories above the path that were not there (outermost first): an apply that creates the path makes them. */
  madeDirs: string[];
}

/** The paths an apply touches, saved just before it. */
interface Backup {
  repo: string;
  dir: string;
  /** The all-zero object id of the repository's hash: how an index-info line removes a path. */
  zero: string;
  saved: SavedPath[];
}

/** Save what `paths` hold — their content in a private directory, their index entries — so that restore() can put it back. */
async function backup(repo: string, paths: string[], zero: string): Promise<Backup> {
  const dir = await mkdtemp(join(tmpdir(), "odw-apply-backup-"));
  try {
    const entries = await indexEntries(repo, paths);
    const flags = await entryFlags(repo, paths);
    const saved: SavedPath[] = [];
    for (const [i, path] of paths.entries()) {
      const full = join(repo, path);
      const info = await lstat(full).catch(() => null);
      const s: SavedPath = {
        path,
        entries: entries.get(path) ?? [],
        flags: flags.get(path) ?? "",
        print: await fingerprint(full),
        kind: "absent",
        madeDirs: [],
      };
      if (!info) {
        s.madeDirs = await missingDirs(repo, path);
      } else if (info.isSymbolicLink()) {
        s.kind = "link";
        s.target = await readlink(full);
      } else if (info.isFile()) {
        s.kind = "file";
        s.mode = info.mode & 0o7777;
        s.copy = join(dir, String(i));
        await copyFile(full, s.copy);
      } else {
        s.kind = info.isDirectory() ? "dir" : "other";
      }
      saved.push(s);
    }
    // For a rollback by hand, should odw's own fail: git update-index -z --index-info < index-info
    await writeFile(join(dir, "index-info"), indexInfo(saved, zero));
    return { repo, dir, zero, saved };
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/** The directories above `path` (relative to the root) that are not there as directories, outermost first. */
async function missingDirs(repo: string, path: string): Promise<string[]> {
  const out: string[] = [];
  for (let dir = parentOf(path); dir !== ""; dir = parentOf(dir)) {
    if ((await lstat(join(repo, dir)).catch(() => null))?.isDirectory()) break;
    out.unshift(dir);
  }
  return out;
}

function parentOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at);
}

/**
 * The bits of `paths`' index entries that git apply drops when it rewrites an
 * entry: "a" for assume-unchanged, "s" for skip-worktree (`ls-files -v` tags
 * them with a lowercase letter and an S).
 */
async function entryFlags(repo: string, paths: Iterable<string>, opts: GitOptions = {}): Promise<Map<string, string>> {
  const wanted = new Set(paths);
  const flags = new Map<string, string>();
  for (const chunk of chunked([...wanted])) {
    for (const record of splitNul(await git(repo, ["--literal-pathspecs", "ls-files", "-v", "-z", "--", ...chunk], opts))) {
      const tag = record[0]!;
      const path = record.slice(2);
      const bits = (tag !== tag.toUpperCase() ? "a" : "") + (tag.toUpperCase() === "S" ? "s" : "");
      if (wanted.has(path) && bits) flags.set(path, bits);
    }
  }
  return flags;
}

/** `git update-index -z --index-info` input that puts saved entries back: each path removed, then its entries (any stage) added. */
function indexInfo(saved: SavedPath[], zero: string): string {
  let out = "";
  for (const s of saved) {
    out += `0 ${zero}\t${s.path}\0`;
    for (const e of s.entries) out += `${e.mode} ${e.oid} ${e.stage}\t${s.path}\0`;
  }
  return out;
}

/** Note what the apply left at each saved path: what differs from both that and the saved state later is someone's edit. */
async function appliedBy(b: Backup): Promise<void> {
  for (const s of b.saved) s.after = await fingerprint(join(b.repo, s.path));
}

/** What a rollback did: the paths still not as saved, what went wrong, and the edits it set aside first. */
interface Restored {
  differ: string[];
  errors: string[];
  /** Paths edited after the apply (while the verify ran): their content is kept in the backup's `changed/`. */
  setAside: string[];
}

/**
 * Put every saved path back as it was. First, what changed at a path after
 * the apply — while the verify ran, by the command or by someone — is copied
 * aside, never lost. Then what the apply made where nothing (or an empty
 * directory) was is removed, with the directories it made for it, once empty;
 * the saved files and links are written where they differ; and the index
 * entries go back in one write, with their assume-unchanged and skip-worktree
 * bits. Only the saved paths are touched, and git runs out of reach of a
 * second Ctrl-C. Both `differ` and `errors` are empty for an exact rollback.
 */
async function restore(b: Backup): Promise<Restored> {
  const errors: string[] = [];
  const setAside: string[] = [];
  const attempt = async (what: string, step: () => Promise<unknown>): Promise<void> => {
    try {
      await step();
    } catch (err) {
      errors.push(`${what}: ${errorText(err)}`);
    }
  };
  const quiet: GitOptions = { detached: true };
  for (const s of b.saved) {
    if (s.after === undefined) continue;
    const full = join(b.repo, s.path);
    const now = await fingerprint(full);
    if (now === null || now === "dir" || now === s.print || now === s.after) continue;
    await attempt(s.path, async () => {
      const keep = join(b.dir, "changed", s.path);
      await mkdir(dirname(keep), { recursive: true });
      if ((await lstat(full)).isSymbolicLink()) await symlink(await readlink(full), keep);
      else await copyFile(full, keep);
      setAside.push(s.path);
    });
  }
  for (const s of b.saved) {
    if (s.kind !== "absent" && s.kind !== "dir") continue;
    const full = join(b.repo, s.path);
    const info = await lstat(full).catch(() => null);
    if (info && !info.isDirectory()) await attempt(s.path, () => unlink(full));
  }
  const made = [...new Set(b.saved.flatMap((s) => s.madeDirs))].sort((x, y) => y.length - x.length);
  // A directory that is not empty now holds something else too: it stays.
  for (const dir of made) await rmdir(join(b.repo, dir)).catch(() => {});
  for (const s of b.saved) {
    const full = join(b.repo, s.path);
    if (s.kind === "dir") {
      // A directory git put a file in place of: it was empty.
      if (!(await lstat(full).catch(() => null))) await attempt(s.path, () => mkdir(full, { recursive: true }));
      continue;
    }
    if (s.kind !== "file" && s.kind !== "link") continue;
    if ((await fingerprint(full)) === s.print) continue;
    await attempt(s.path, async () => {
      const info = await lstat(full).catch(() => null);
      if (info && !info.isDirectory()) await unlink(full);
      await mkdir(dirname(full), { recursive: true });
      if (s.kind === "link") {
        await symlink(s.target!, full);
      } else {
        await copyFile(s.copy!, full);
        await chmod(full, s.mode!);
      }
    });
  }
  const paths = b.saved.map((s) => s.path);
  const now = await indexEntries(b.repo, paths, quiet);
  const changed = b.saved.filter((s) => !sameEntries(s.entries, now.get(s.path)));
  if (changed.length > 0) {
    await attempt("the index", () => git(b.repo, ["update-index", "-z", "--index-info"], { ...quiet, input: indexInfo(changed, b.zero) }));
    // Entries written so carry no stat data: refresh it (only content-equal entries are), before the
    // bits below stop git from ever refreshing them — else git apply would take those files for changed.
    await attempt("the index", () => git(b.repo, ["update-index", "-q", "--refresh"], { ...quiet, okCodes: [0, 1] }));
  }
  const flagsNow = await entryFlags(b.repo, paths, quiet);
  for (const [bit, option] of [["a", "assume-unchanged"], ["s", "skip-worktree"]] as const) {
    const has = (s: SavedPath): boolean => (flagsNow.get(s.path) ?? "").includes(bit);
    const turnOn = b.saved.filter((s) => s.flags.includes(bit) && !has(s)).map((s) => s.path);
    const turnOff = b.saved.filter((s) => !s.flags.includes(bit) && has(s)).map((s) => s.path);
    for (const [list, flag] of [[turnOn, `--${option}`], [turnOff, `--no-${option}`]] as const) {
      if (list.length === 0) continue;
      await attempt("the index", () => git(b.repo, ["update-index", flag, "-z", "--stdin"], { ...quiet, input: `${list.join("\0")}\0` }));
    }
  }
  const after = await indexEntries(b.repo, paths, quiet);
  const flagsAfter = await entryFlags(b.repo, paths, quiet);
  const differ: string[] = [];
  for (const s of b.saved) {
    const tree = s.kind === "other" || (await fingerprint(join(b.repo, s.path))) === s.print;
    const index = sameEntries(s.entries, after.get(s.path)) && (flagsAfter.get(s.path) ?? "") === s.flags;
    if (!tree || !index) differ.push(s.path);
  }
  return { differ, errors, setAside };
}

/** The all-zero object id of the repository's hash function. */
async function zeroOid(repo: string): Promise<string> {
  const empty = (await git(repo, ["hash-object", "--stdin"], { input: "" })).trim();
  return "0".repeat(empty.length || 40);
}

// --- verifying an apply ---------------------------------------------------------------

/** How a verify command went. */
interface VerifyResult {
  ok: boolean;
  /** A signal cut it short. */
  interrupted: boolean;
  /** How it ended when it failed: "exited with code 1", "timed out after 600s", "was killed by SIGKILL". */
  why: string;
  /** The end of what it printed, stdout and stderr as they came; empty when it printed nothing. */
  tail: string[];
  seconds: number;
}

/** Lines, and characters, of a failed verify command's output that its report quotes. */
const VERIFY_TAIL_LINES = 40;
const VERIFY_TAIL_CHARS = 8000;

/**
 * Run the verify command at the repository root through the platform shell,
 * killed (with everything it started) after `timeout` seconds or when
 * `signal` fires. Its output is not shown as it runs: only its end is kept.
 */
async function runVerify(repo: string, command: string, timeout: number | null, signal?: AbortSignal): Promise<VerifyResult> {
  let output = "";
  let cut = false;
  const keep = (chunk: string): void => {
    output += chunk;
    if (output.length > VERIFY_TAIL_CHARS * 2) {
      output = output.slice(-VERIFY_TAIL_CHARS);
      cut = true;
    }
  };
  const result = await runCommand([command], {
    shell: true,
    cwd: repo,
    timeout: timeout ?? undefined,
    signal,
    onStdout: keep,
    onStderr: keep,
  });
  const interrupted = signal?.aborted === true;
  const killed = /\[process terminated by signal (\w+)\]/.exec(result.stderr)?.[1];
  const took = `after ${result.duration.toFixed(1)}s`;
  const why = interrupted
    ? `was interrupted ${took}`
    : result.timedOut
      ? `timed out after ${timeout}s`
      : killed
        ? `was killed by ${killed} ${took}`
        : `exited with code ${result.returncode} ${took}`;
  // A command that could not start printed nothing: the runner says why.
  let text = output.trim() !== "" || interrupted ? output : result.stderr;
  if (text.length > VERIFY_TAIL_CHARS) {
    text = text.slice(-VERIFY_TAIL_CHARS);
    cut = true;
  }
  const lines = text.trim() === "" ? [] : text.replace(/\s+$/, "").split("\n");
  const tail = lines.slice(-VERIFY_TAIL_LINES);
  if (cut || lines.length > tail.length) tail.unshift("…");
  return { ok: cliOk(result) && !interrupted, interrupted, why, tail, seconds: result.duration };
}

// --- odw apply ----------------------------------------------------------------------------

/** An agent that kept a diff, and where. */
export interface AgentDiff {
  row: AgentRow & { agentId: number };
  file: string;
  /** What the report calls it, in place of "agent <id> (<label>)": `odw restore`'s "the safety snapshot" (ODW extension). */
  name?: string;
}

export interface Writer {
  write(text: string): unknown;
}

export interface ApplyOptions {
  /** Where odw runs: the diffs go to the root of the git working tree it is in. */
  cwd: string;
  runId: string;
  /** The agent `--agent` names, or every agent of the run that kept a diff (`all`), in agentId order. */
  agents: AgentDiff[];
  all: boolean;
  /** Preview only (`--check`). */
  check: boolean;
  /** Apply over uncommitted changes in the paths the diffs touch (`--force`). */
  force: boolean;
  /** The command that verifies each apply (`--verify`, the `applyVerify` setting); null for none. */
  verify: string | null;
  /** Seconds the verify command may run (the `timeout` setting); null for no limit. */
  timeout: number | null;
  /** Fires on a signal: what is not applied yet stays so, and an apply being verified is rolled back. */
  interrupt?: AbortSignal;
  /** Where the run worked, named when odw runs outside a repository. */
  source?: string;
  /** `--resolve`: an agent whose diff would conflict goes to a resolver agent instead of stopping the apply; null without it. */
  resolve?: ResolveOptions | null;
  out: Writer;
  err: Writer;
  caps: TermCaps;
  /** Columns a line may take. */
  width: number;
  /** Told of each agent whose diff is now in the tree, cleanly — applied, verified when asked, or there already (the review queue's `applied`; ODW extension). */
  onApplied?: (agent: AgentDiff) => void;
}

/** One agent on its way through `odw apply`. */
interface Item {
  agent: AgentDiff;
  /** "agent 3 (fix:auth)". */
  name: string;
  files: DiffSection[];
  /** The note a diff cut at maxDiffBytes ends with: such a diff cannot be applied. */
  cut: string | null;
  preview: Preview | null;
}

/** What became of applying one agent. */
type Applied =
  | { kind: "applied"; conflicts: number }
  | { kind: "refused"; said: string }
  | { kind: "rolled back"; why: string }
  | { kind: "stuck"; why: string }
  /** `--resolve` did not get to an apply: nothing of the agent's diff was changed in the tree. */
  | { kind: "unresolved"; why: string };

/**
 * `odw apply` (ODW extension): preview, then — unless `check` — apply and
 * verify, as the module doc describes. Writes its report and returns the
 * exit code: 0 when everything applied cleanly (and passed its verify), or
 * would; 1 otherwise.
 */
export async function applyAgents(o: ApplyOptions): Promise<number> {
  let agents = o.agents;
  if (o.all) {
    // A failed agent's diff is unfinished work: it is applied only when asked for by name.
    for (const a of agents.filter((a) => a.row.state !== "done")) {
      const why = a.row.state === "failed" ? "failed" : `is ${a.row.state}`;
      o.err.write(`odw apply: --all leaves out agent ${a.row.agentId} (${labelOf(a.row)}), which ${why}: apply its diff on its own with --agent ${a.row.agentId}\n`);
    }
    agents = agents.filter((a) => a.row.state === "done");
    if (agents.length === 0) {
      o.err.write(`run ${o.runId} has no finished agent that kept a diff: agents that run with isolation: "worktree" keep one of what they changed\n`);
      return 0;
    }
  }
  const items: Item[] = [];
  for (const agent of agents) {
    const bytes = await readFile(agent.file);
    // The note is the last line: no need to read the whole diff as text for it.
    const cut = truncationNoteOf(bytes.subarray(Math.max(0, bytes.length - 4096)).toString("utf8"));
    const name = agent.name ?? `agent ${agent.row.agentId} (${labelOf(agent.row)})`;
    items.push({ agent, name, files: cut ? [] : diffSections(bytes), cut, preview: null });
  }
  const single = o.all ? null : items[0]!;
  const who = single ? `${single.name} of run ${o.runId}` : "";
  if (single?.cut) {
    o.err.write(`odw apply: the diff ${who} kept was cut at maxDiffBytes, so it cannot be applied:\n  ${sanitizeText(single.cut, 300)}\n${branchHint(single, "  ")}`);
    return 1;
  }

  let repo: string;
  try {
    repo = (await git(o.cwd, ["rev-parse", "--show-toplevel"])).trim();
  } catch (err) {
    const where = o.source ? ` (the run worked in ${o.source})` : "";
    o.err.write(`odw apply: run it inside the git repository to apply the change to${where}: ${errorText(err)}\n`);
    return 1;
  }

  const touchers = new Map<string, Item[]>();
  for (const item of items) for (const path of touchedPaths(item.files)) touchers.set(path, [...(touchers.get(path) ?? []), item]);
  const blocked = await uncommitted(repo, new Set(touchers.keys()));
  if (blocked.length > 0) {
    const listed = blocked
      .map((b) => `  ${sanitizeText(b.path, 200)} (${b.how})${o.all ? ` — ${touchers.get(b.path)!.map((i) => i.name).join(", ")}` : ""}`)
      .join("\n");
    if (!o.force) {
      o.err.write(`odw apply: uncommitted changes in the way of ${single ? `the diff ${who}` : "the diffs"} — commit or stash them, or pass --force:\n${listed}\n`);
      return 1;
    }
    o.err.write(`odw apply: --force: ${o.check ? "checking" : "applying"} over uncommitted changes in:\n${listed}\n`);
  }
  // --force goes past staged edits; git refuses a path whose working tree differs from the index all the same.
  const unstaged = new Set(blocked.filter((b) => b.how !== "staged").map((b) => b.path));

  const work = await mkdtemp(join(tmpdir(), "odw-apply-"));
  try {
    await previewStack(o, repo, items, work, unstaged);
    if (single) {
      for (const line of previewLines(o, single, `${who} `, ` to ${repo}`)) o.out.write(`${line}\n`);
    } else {
      o.out.write(`previewing ${items.length} agent(s) of run ${o.runId} against ${repo}, each on top of the ones before it:\n`);
      for (const item of items) for (const line of previewLines(o, item, `${item.name} `, "")) o.out.write(`${line}\n`);
    }
    if (o.check) {
      const stops = items.some((item) => item.cut !== null || ["conflict", "refused"].includes(verdictOf(item.preview!)));
      return stops ? 1 : 0;
    }
    const zero = await zeroOid(repo);
    return single ? await applySingle(o, repo, single, who, work, zero) : await applyAll(o, repo, items, work, zero, unstaged);
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

let stacks = 0;

/** Tell `onApplied` of an agent now in the tree; failing to note it never fails the apply. */
function markApplied(o: ApplyOptions, item: Item): void {
  try {
    o.onApplied?.(item.agent);
  } catch (err) {
    o.err.write(`odw apply: could not mark ${item.name} applied on the review queue: ${errorText(err)}\n`);
  }
}

/**
 * Preview `items` against the repository's index as it is now, each on top of
 * the ones before it under `--all`; one that would conflict is left out of the
 * stack, so the agents after it are previewed without it.
 */
async function previewStack(o: ApplyOptions, repo: string, items: Item[], work: string, unstaged: Set<string>): Promise<void> {
  const dir = join(work, `preview-${++stacks}`);
  await mkdir(dir);
  const scratch = await scratchIndex(repo, dir);
  const before = `${scratch.index}.before`;
  for (const item of items) {
    if (item.cut) continue;
    if (o.all) await copyIfThere(scratch.index, before);
    item.preview = await previewFiles(repo, item.files, scratch, dir);
    if (unstaged.size > 0) refuseUnstaged(item.preview, unstaged);
    const verdict = verdictOf(item.preview);
    // Left out of the stack: the agents after it are previewed without it.
    if (o.all && (verdict === "conflict" || verdict === "refused")) await copyIfThere(before, scratch.index);
  }
}

/** Apply the one agent `--agent` names: its conflicts are left marked, unless it is to be verified. */
async function applySingle(o: ApplyOptions, repo: string, item: Item, who: string, work: string, zero: string): Promise<number> {
  const preview = item.preview!;
  const verdict = verdictOf(preview);
  if (verdict === "applied") {
    markApplied(o, item);
    return 0;
  }
  if (verdict === "refused") {
    o.err.write(`odw apply: ${who} cannot be applied, so nothing was changed:\n${quoted(preview.refused!, o.width)}\n`);
    return 1;
  }
  if (verdict === "conflict" && o.resolve) {
    if (o.interrupt?.aborted) return 1;
    const resolved = await resolveOne(o, repo, item, work, zero);
    if (resolved.kind === "applied" && resolved.conflicts === 0) {
      markApplied(o, item);
      return 0;
    }
    return 1;
  }
  if (verdict === "conflict" && o.verify) {
    o.err.write(
      `odw apply: ${who} was not applied: it would conflict, and --verify takes only a change that applies cleanly — apply it without verifying to resolve the conflicts by hand\n`,
    );
    return 1;
  }
  if (o.interrupt?.aborted) return 1;
  const result = await applyOne(o, repo, item, who, work, zero);
  switch (result.kind) {
    case "applied":
      if (result.conflicts > 0) {
        o.out.write(`${result.conflicts} file(s) conflicted: resolve the <<<<<<< markers, then git add them\n`);
        return 1;
      }
      markApplied(o, item);
      return 0;
    case "refused":
      o.err.write(`odw apply: git could not apply the diff ${who}; nothing was changed:\n${quoted(result.said, o.width)}\n`);
      return 1;
    default:
      return 1;
  }
}

/** Apply every agent in order — each verified, when asked — and stop before the first that would conflict. */
async function applyAll(o: ApplyOptions, repo: string, items: Item[], work: string, zero: string, unstaged: Set<string>): Promise<number> {
  const applied: Item[] = [];
  const already: Item[] = [];
  let stop: { at: number; why: string } | null = null;
  for (const [at, item] of items.entries()) {
    if (o.interrupt?.aborted) {
      stop = { at, why: "interrupted" };
      break;
    }
    if (item.cut) {
      stop = { at, why: "its diff was cut at maxDiffBytes" };
      break;
    }
    const verdict = verdictOf(item.preview!);
    if (verdict === "applied") {
      already.push(item);
      continue;
    }
    if (verdict === "conflict" && o.resolve) {
      const resolved = await resolveOne(o, repo, item, work, zero);
      if (resolved.kind !== "applied") {
        stop = { at, why: resolved.kind === "refused" ? "git could not apply its resolution" : resolved.why };
        break;
      }
      applied.push(item);
      // The agents after it were previewed without it: preview them again, on top of what it applied.
      const rest = items.slice(at + 1).filter((i) => !i.cut);
      if (rest.length > 0) {
        await previewStack(o, repo, rest, work, unstaged);
        o.out.write(`previewing the ${rest.length} agent(s) after it again, on top of its resolution:\n`);
        for (const i of rest) for (const line of previewLines(o, i, `${i.name} `, "")) o.out.write(`${line}\n`);
      }
      continue;
    }
    if (verdict === "conflict" || verdict === "refused") {
      stop = { at, why: verdict === "conflict" ? "it would conflict" : "it cannot be applied" };
      break;
    }
    const result = await applyOne(o, repo, item, item.name, work, zero);
    if (result.kind === "applied") {
      applied.push(item);
      continue;
    }
    if (result.kind === "refused") o.err.write(`odw apply: git could not apply the diff of ${item.name}; nothing was changed:\n${quoted(result.said, o.width)}\n`);
    stop = { at, why: result.kind === "refused" ? "git could not apply its diff" : result.why };
    break;
  }
  for (const item of [...already, ...applied]) markApplied(o, item);
  const names = (list: Item[]): string => list.map((i) => i.name).join(", ");
  if (applied.length > 0) o.out.write(`applied to ${repo} (staged, as git apply --3way does): ${names(applied)}\n`);
  if (already.length > 0) o.out.write(`already applied: ${names(already)}\n`);
  if (!stop) return 0;
  const left = items.slice(stop.at);
  const first = left[0]!;
  o.out.write(`not applied: ${names(left)} — stopped at ${first.name}: ${stop.why}\n`);
  if (stop.why === "it would conflict" || (o.resolve && first.preview && verdictOf(first.preview) === "conflict")) {
    // Its paths may hold what the agents before it changed: uncommitted, they are in the way of --agent.
    const commitFirst = applied.length > 0 ? "commit what applied, then " : "";
    o.out.write(`  to apply it and resolve its conflicts by hand: ${commitFirst}odw apply ${o.runId} --agent ${first.agent.row.agentId}\n`);
  } else if (first.cut) {
    o.out.write(branchHint(first, "  "));
  }
  return 1;
}

/**
 * Apply one agent's previewed diff — the files not applied already — to the
 * working tree and its index. What it touches is saved first: git can give
 * up halfway through writing the tree, and then the rollback puts back what
 * it wrote. Conflicts stay marked for one agent applied by itself; under
 * `--all` or `--verify` an apply that conflicts after all is rolled back, as
 * is one whose verify fails or is interrupted.
 */
async function applyOne(o: ApplyOptions, repo: string, item: Item, who: string, work: string, zero: string): Promise<Applied> {
  const files = item.preview!.files.filter((f) => f.outcome !== "applied").map((f) => f.file);
  const saved = await backup(repo, touchedPaths(files), zero);
  try {
    const result = await applyFiles(repo, files, work, { cached: false });
    if (result.code !== 0 && result.conflicted.size === 0) {
      const said = gitErrors(result.stderr, result.code).join("\n");
      return (await rollBack(o, saved, who, false)) ? { kind: "refused", said } : { kind: "stuck", why: "git could not apply its diff" };
    }
    if (!o.all) o.out.write(`applied ${who} to ${repo} (staged, as git apply --3way does)\n`);
    let why: string;
    if (result.conflicted.size > 0) {
      if (!o.all && !o.verify) {
        await discard(saved);
        return { kind: "applied", conflicts: result.conflicted.size };
      }
      why = "it conflicted after all";
      o.err.write(`odw apply: ${who} conflicted after all (did the tree change since the preview?)\n`);
    } else if (!o.verify) {
      await discard(saved);
      return { kind: "applied", conflicts: 0 };
    } else if (o.interrupt?.aborted) {
      why = "interrupted";
    } else {
      await appliedBy(saved);
      o.err.write(`verifying ${who}: ${o.verify}\n`);
      const verified = await runVerify(repo, o.verify, o.timeout, o.interrupt);
      if (verified.ok) {
        await discard(saved);
        o.out.write(`verified ${who}: \`${o.verify}\` passed in ${verified.seconds.toFixed(1)}s\n`);
        return { kind: "applied", conflicts: 0 };
      }
      why = verified.interrupted ? "interrupted" : "its verify failed";
      const said =
        verified.tail.length > 0
          ? `; the end of its output:\n${verified.tail.map((line) => `  ${printable(line, o.width - 2)}`).join("\n")}`
          : "; it printed nothing";
      o.err.write(`odw apply: verify failed for ${who} — \`${o.verify}\` ${verified.why}${said}\n`);
    }
    return (await rollBack(o, saved, who, true)) ? { kind: "rolled back", why } : { kind: "stuck", why };
  } catch (err) {
    await rollBack(o, saved, who, true).catch(() => false);
    throw err;
  }
}

/**
 * Put back what an apply touched; true once it all is as it was. The saved
 * copy is kept, and its place said, when it is not — or when edits made after
 * the apply had to be set aside.
 */
async function rollBack(o: ApplyOptions, saved: Backup, who: string, report: boolean): Promise<boolean> {
  let restored: Restored;
  try {
    restored = await restore(saved);
  } catch (err) {
    restored = { differ: saved.saved.map((s) => s.path), errors: [errorText(err)], setAside: [] };
  }
  const { differ, errors, setAside } = restored;
  const list = (paths: string[]): string => paths.map((path) => sanitizeText(path, 200)).join(", ");
  if (setAside.length > 0) {
    o.err.write(`odw apply: ${list(setAside)} changed while the verify ran; that version is kept in ${join(saved.dir, "changed")}\n`);
  }
  if (differ.length === 0) {
    if (setAside.length === 0) await discard(saved);
    if (report) o.err.write(`rolled back ${who}: the ${saved.saved.length} path(s) it touched are as they were before the apply\n`);
    return true;
  }
  o.err.write(
    `odw apply: could not roll back ${who} completely — still different: ${list(differ)}${errors.length > 0 ? ` (${errors.map((e) => sanitizeText(e, 300)).join("; ")})` : ""}\n` +
      `  what those paths held before the apply is saved in ${saved.dir}; their index entries go back with:\n` +
      `  git update-index -z --index-info < ${join(saved.dir, "index-info")}\n`,
  );
  return false;
}

async function discard(saved: Backup): Promise<void> {
  await rm(saved.dir, { recursive: true, force: true }).catch(() => {});
}

// --- resolving a conflict (--resolve) -------------------------------------------------

/** What `--resolve` needs beyond the apply: how to run a resolver, how to note the outcome, whether to ask first. */
export interface ResolveOptions {
  /** Start the resolver run in `request.source` and wait until it ends (or `request.signal` stops it). */
  dispatch(request: ResolveRequest): Promise<ResolverRun>;
  /** Note in the agent's own run how its resolution ended. */
  settled(outcome: ResolveOutcome): void;
  /** `--confirm`: show the resolved diff and ask y/N before applying it. */
  confirm: boolean;
  /** Where the y/N answer is read from: it must be a terminal. */
  input?: NodeJS.ReadableStream & { isTTY?: boolean };
}

export interface ResolveRequest {
  /** The agent whose diff conflicts, in the run being applied. */
  agentId: number;
  label: string;
  /** The temporary worktree: the repository's HEAD, its index, and the agent's files that apply cleanly. */
  source: string;
  prompt: string;
  signal?: AbortSignal;
  /** Hears the resolver's run id once the run exists. */
  started(runId: string): void;
}

/** How a resolver run ended: its state, its error, and the diff it kept (null: it changed nothing). */
export interface ResolverRun {
  runId: string;
  state: string;
  error: string | null;
  diff: string | null;
}

export interface ResolveOutcome {
  agentId: number;
  resolverRunId: string;
  outcome: "applied" | "refused" | "declined" | "interrupted";
  /** Why it was not applied; null when it was. */
  why: string | null;
}

/** Characters of each version of a conflicting file the resolver's prompt quotes; it can read the rest in its workspace. */
const PROMPT_FILE_CHARS = 20_000;

/** A line git leaves as a conflict marker: `<<<<<<< `, `||||||| `, `>>>>>>> ` (and the bare forms). */
const MARKER = /^(?:<{7}|\|{7}|>{7})(?: |$)/;

/** Who commits the tree a resolver starts from: never the user's own identity, nor a config hook. */
const RESOLVE_IDENTITY = { GIT_AUTHOR_NAME: "odw", GIT_AUTHOR_EMAIL: "odw@localhost", GIT_COMMITTER_NAME: "odw", GIT_COMMITTER_EMAIL: "odw@localhost" };

let resolves = 0;

/**
 * `--resolve`: hand `item`'s conflicts to a resolver agent, check its work,
 * and only then apply it. The resolver runs in a temporary worktree at the
 * state the agent's diff lands on — HEAD, the index (what was applied before
 * it included), and the agent's files that apply cleanly — told the base and
 * both sides of each conflicting file. Its change must touch only those
 * files, leave no conflict markers, apply there, and pass the verify command
 * there; then the agent's clean files and the resolved ones are previewed
 * and applied to the tree the normal way, rolled back should git give up.
 * Anything short of that changes nothing in the tree, and says why.
 */
async function resolveOne(o: ApplyOptions, repo: string, item: Item, work: string, zero: string): Promise<Applied> {
  const r = o.resolve!;
  const preview = item.preview!;
  const conflicts = preview.files.filter((f) => f.outcome === "conflict");
  const unresolved = (why: string): Applied => {
    o.err.write(`odw apply: ${item.name} was not applied: ${why}\n`);
    return { kind: "unresolved", why };
  };
  const odd = conflicts.filter((f) => !f.stages || (f.file.status !== "modified" && f.file.status !== "added"));
  if (odd.length > 0) {
    const list = odd.map((f) => `${sanitizeText(target(f.file), 200)} (${f.reason ? sanitizeText(f.reason, 100) : f.file.status})`).join(", ");
    return unresolved(`--resolve takes conflicting lines of text only, not ${list}`);
  }
  const paths = new Set(conflicts.map((f) => target(f.file)));
  const clean = preview.files.filter((f) => f.outcome === "clean").map((f) => f.file);

  const dir = join(work, `resolve-${++resolves}`);
  await mkdir(dir);
  // The state the agent's diff lands on, as a commit: the index as it is, the agent's clean files applied.
  let commit: string;
  try {
    const scratch = await scratchIndex(repo, dir);
    if (clean.length > 0) {
      const applied = await applyFiles(repo, clean, dir, { cached: true, env: scratch.env });
      if (applied.code !== 0) return unresolved(`its files that apply cleanly do not apply on their own: ${gitSaid(applied.stderr)}`);
    }
    const lands = (await git(repo, ["write-tree"], { env: scratch.env })).trim();
    const head = (await git(repo, ["rev-parse", "--verify", "-q", "HEAD"], { okCodes: [0, 1] })).trim();
    const message = `odw apply --resolve: what agent ${item.agent.row.agentId} of run ${o.runId} lands on`;
    commit = (await git(repo, ["commit-tree", "--no-gpg-sign", lands, ...(head ? ["-p", head] : []), "-m", message], { env: { ...process.env, ...RESOLVE_IDENTITY } })).trim();
  } catch (err) {
    return unresolved(`could not make the tree its resolver starts from: ${errorText(err)}`);
  }
  const tree = join(dir, basename(repo));
  try {
    await git(repo, ["worktree", "add", "--detach", tree, commit]);
  } catch (err) {
    return unresolved(`could not make a temporary worktree for its resolver: ${errorText(err)}`);
  }
  const links: string[] = [];
  try {
    // What .worktreeinclude brings an isolated agent (node_modules, .env, …), the verify command gets too.
    await prepareWorktree(repo, tree, tree, { onNote: (note) => o.err.write(`odw apply: ${sanitizeText(note, 300)}\n`) }, links).catch((err: unknown) =>
      o.err.write(`odw apply: the temporary worktree could not be made ready: ${sanitizeText(errorText(err), 300)}\n`),
    );
    const prompt = await resolverPrompt(repo, item, conflicts);
    let run: ResolverRun;
    try {
      run = await r.dispatch({
        agentId: item.agent.row.agentId,
        label: item.agent.row.label,
        source: tree,
        prompt,
        signal: o.interrupt,
        started: (runId) => o.out.write(`resolving the conflicts of ${item.name} with an agent: run ${runId}\n`),
      });
    } catch (err) {
      return unresolved(`its resolver could not run: ${errorText(err)}`);
    }
    const settle = (outcome: ResolveOutcome["outcome"], why: string | null): void => {
      try {
        r.settled({ agentId: item.agent.row.agentId, resolverRunId: run.runId, outcome, why });
      } catch (err) {
        o.err.write(`odw apply: could not note the resolution in run ${o.runId}: ${errorText(err)}\n`);
      }
    };
    const refuse = (why: string): Applied => {
      settle("refused", why);
      return unresolved(`its resolution (run ${run.runId}) was refused — ${why}`);
    };
    if (o.interrupt?.aborted) {
      settle("interrupted", "interrupted");
      return unresolved(`interrupted while run ${run.runId} resolved it`);
    }
    if (run.state !== "done") return refuse(`the resolver run ${run.state}${run.error ? `: ${sanitizeText(run.error, 300)}` : ""}`);
    if (run.diff === null) return refuse("the resolver changed nothing");
    const bytes = await readFile(run.diff);
    if (truncationNoteOf(bytes.subarray(Math.max(0, bytes.length - 4096)).toString("utf8"))) return refuse("its diff was cut at maxDiffBytes");
    const sections = diffSections(bytes);
    if (sections.length === 0) return refuse("the resolver changed nothing");
    // expect-style: only the conflicting files, edited in place.
    const outside = sections.filter((s) => s.status !== "modified" || s.oldPath !== s.newPath || !paths.has(target(s)));
    if (outside.length > 0) {
      const list = outside.map((s) => `${sanitizeText(target(s), 200)}${s.status === "modified" ? "" : ` (${s.status})`}`).join(", ");
      return refuse(`it may only edit the conflicting files (${[...paths].map((p) => sanitizeText(p, 200)).join(", ")}), and it changed ${list}`);
    }
    const patch = join(dir, "resolved.diff");
    await writeFile(patch, bytes);
    const there = await runGit(tree, ["apply", "--index", patch]);
    if (there.code !== 0) return refuse(`it does not apply to the tree it was made in: ${gitSaid(there.stderr)}`);
    const marked: string[] = [];
    for (const path of paths) {
      const text = await readFile(join(tree, path), "utf8").catch(() => "");
      const at = text.split("\n").findIndex((line) => MARKER.test(line));
      if (at !== -1) marked.push(`${sanitizeText(path, 200)} (line ${at + 1})`);
    }
    if (marked.length > 0) return refuse(`it left conflict markers in ${marked.join(", ")}`);
    if (o.verify) {
      o.err.write(`verifying the resolution of ${item.name} in a temporary worktree: ${o.verify}\n`);
      const verified = await runVerify(tree, o.verify, o.timeout, o.interrupt);
      if (verified.interrupted) {
        settle("interrupted", "interrupted");
        return unresolved(`interrupted while its resolution (run ${run.runId}) was verified`);
      }
      if (!verified.ok) {
        const said = verified.tail.length > 0 ? `; the end of its output:\n${verified.tail.map((line) => `  ${printable(line, o.width - 2)}`).join("\n")}` : "; it printed nothing";
        return refuse(`\`${o.verify}\` ${verified.why}${said}`);
      }
      o.out.write(`verified the resolution of ${item.name}: \`${o.verify}\` passed in ${verified.seconds.toFixed(1)}s\n`);
    } else {
      o.err.write(`odw apply: no verify command (--verify, applyVerify): the resolution of ${item.name} is checked for its files and conflict markers only\n`);
    }
    if (r.confirm) {
      o.out.write(`the resolution of ${item.name} (run ${run.runId}):\n${quoted(bytes.toString("utf8").replace(/\n$/, ""), o.width)}\n`);
      const yes = await askYes(r.input, o, `apply ${item.name} with this resolution? [y/N] `);
      if (yes !== true) {
        const why = yes === null ? "--confirm needs a terminal to ask on" : "not confirmed";
        settle("declined", why);
        return unresolved(`its resolution (run ${run.runId}) was ${yes === null ? "not applied: --confirm needs a terminal to ask on" : "not confirmed"}`);
      }
    }
    // Now the user's tree: the agent's clean files and the resolved ones, previewed and applied the normal way.
    const resolved: Item = { agent: item.agent, name: `${item.name} (resolved by run ${run.runId})`, files: [...clean, ...sections], cut: null, preview: null };
    const final = join(dir, "final");
    await mkdir(final);
    resolved.preview = await previewFiles(repo, resolved.files, await scratchIndex(repo, final), final);
    const verdict = verdictOf(resolved.preview);
    if (verdict !== "clean" && verdict !== "applied") return refuse(`it no longer applies cleanly here (did the tree change meanwhile?)`);
    // Verified already, on this very content: no second run of the command; a conflict after all rolls back.
    const result = verdict === "applied" ? ({ kind: "applied", conflicts: 0 } as Applied) : await applyOne({ ...o, all: true, verify: null }, repo, resolved, resolved.name, final, zero);
    if (result.kind === "applied") {
      settle("applied", null);
      o.out.write(`applied ${item.name} to ${repo} with its conflicts resolved by run ${run.runId} (staged)\n`);
    } else {
      settle("refused", result.kind === "refused" ? `git could not apply it: ${result.said}` : result.why);
    }
    return result;
  } finally {
    for (const link of links) await unlink(link).catch(() => {});
    try {
      await git(repo, ["worktree", "remove", "--force", "--force", tree]);
    } catch {
      await rm(tree, { recursive: true, force: true }).catch(() => {});
      await git(repo, ["worktree", "prune"]).catch(() => {});
    }
  }
}

/** What a resolver is told: each conflicting file's base, both sides and conflicting lines, and to keep both intents. */
async function resolverPrompt(repo: string, item: Item, conflicts: FilePreview[]): Promise<string> {
  const blob = async (oid: string | null): Promise<string> => {
    if (oid === null) return "(none: the file was added on both sides)";
    const text = await git(repo, ["cat-file", "blob", oid]);
    return text.length > PROMPT_FILE_CHARS ? `${text.slice(0, PROMPT_FILE_CHARS)}\n… (cut here: the rest is in the file)` : text;
  };
  const files = conflicts.map((f) => target(f.file));
  const parts = [
    `You resolve merge conflicts. Another agent (${item.agent.row.label}, agent ${item.agent.row.agentId}) changed this repository, ` +
      `and its change conflicts with what the repository holds now in ${files.length} file(s): ${files.join(", ")}.`,
    "Your working directory holds the repository as it is now: each of those files holds OURS (below). " +
      "Edit each of them so that it keeps BOTH intents — what changed on our side since the base, and what the other agent changed. " +
      "Rules: edit only these files; do not create, delete, rename or touch any other file; " +
      "leave no conflict markers (<<<<<<<, =======, >>>>>>>); do not commit. Reply with one short paragraph saying how you merged each file.",
  ];
  for (const f of conflicts) {
    const s = f.stages!;
    const hunks = f.hunks.map((h) => `at line ${h.line}:\n${h.lines.join("\n")}${h.more > 0 ? `\n… ${h.more} more line(s)` : ""}`).join("\n\n");
    parts.push(
      [
        `=== ${target(f.file)} ===`,
        `--- BASE (before either change) ---\n${await blob(s.base)}`,
        `--- OURS (what the file holds now) ---\n${await blob(s.ours)}`,
        `--- THEIRS (the other agent's version) ---\n${await blob(s.theirs)}`,
        `--- the conflicting lines, as a merge marks them (ours, then theirs) ---\n${hunks}${f.moreHunks > 0 ? `\n… ${f.moreHunks} more conflict(s)` : ""}`,
      ].join("\n"),
    );
  }
  return parts.join("\n\n");
}

/** Ask `question` and read a line: true for y/yes, false for anything else, null when `input` is no terminal. */
async function askYes(input: ResolveOptions["input"], o: ApplyOptions, question: string): Promise<boolean | null> {
  if (!input || input.isTTY !== true) return null;
  o.err.write(question);
  const rl = createInterface({ input, terminal: false });
  try {
    const line = await new Promise<string | null>((done) => {
      rl.once("line", done);
      rl.once("close", () => done(null));
      o.interrupt?.addEventListener("abort", () => done(null), { once: true });
    });
    return line !== null && /^\s*y(?:es)?\s*$/i.test(line);
  } finally {
    rl.close();
  }
}

// --- the report --------------------------------------------------------------------------

/** One agent's preview: a verdict line, then a line per file, with the conflicting lines under a conflict. */
function previewLines(o: ApplyOptions, item: Item, head: string, to: string): string[] {
  const p = palette(o.caps);
  if (item.cut) {
    return [`${head}cannot be applied${to} — its diff was cut at maxDiffBytes:`, `  ${sanitizeText(item.cut, o.width - 2)}`, branchHint(item, "  ").trimEnd()];
  }
  const preview = item.preview!;
  const conflicts = preview.files.filter((f) => f.outcome === "conflict").length;
  const verdict = {
    clean: `applies cleanly${to}`,
    applied: `is already applied${to}`,
    conflict: `would apply with ${conflicts} conflict(s)${to}`,
    refused: `cannot be applied${to}`,
  }[verdictOf(preview)];
  const lines = [`${head}${verdict}:`];
  const labels = preview.files.map((f) => fileLabel(f.file, o.caps));
  const width = Math.min(Math.max(0, ...labels.map(displayWidth)), Math.max(20, o.width - 40));
  let hunks = false;
  preview.files.forEach((f, i) => {
    const status =
      f.outcome === "clean"
        ? "clean"
        : f.outcome === "applied"
          ? p.dim("already applied")
          : p.err("CONFLICT") + (f.reason ? ` (${sanitizeText(f.reason, 200)})` : "");
    lines.push(truncateToWidth(`  ${padEndWidth(truncateToWidth(labels[i]!, width), width)}  ${status}`, o.width));
    for (const hunk of f.hunks) {
      hunks = true;
      lines.push(p.dim(`      at line ${hunk.line}:`));
      for (const line of hunk.lines) lines.push(`      ${printable(line, o.width - 6)}`);
      if (hunk.more > 0) lines.push(p.dim(`      … ${hunk.more} more line(s)`));
    }
    if (f.moreHunks > 0) lines.push(p.dim(`      … ${f.moreHunks} more conflict(s) in this file`));
  });
  if (hunks) lines.push(p.dim(`  (ours: what this tree holds · theirs: ${item.agent.name ?? "the agent's change"})`));
  return lines;
}

/** Where the whole change of an agent whose diff was cut is, or how to keep it next time. */
function branchHint(item: Item, indent: string): string {
  const branch = item.agent.row.branch;
  return branch
    ? `${indent}The whole change is on branch ${branch}: merge or cherry-pick it, or check it out.\n`
    : `${indent}To keep the whole change next time, give the agent keep: true (or set keepBranches), or raise maxDiffBytes.\n`;
}

/** A line of a file or of a command's output, safe to print: control characters out, its indentation kept. */
function printable(line: string, width: number): string {
  const indent = /^[ \t]*/.exec(line)![0].replace(/\t/g, "  ");
  return truncateToWidth(indent + sanitizeText(line, Math.max(20, width)), Math.max(20, width));
}

/** Why a diff cannot be applied — odw's reasons, git's error lines (gitErrors) — indented under a message. */
function quoted(text: string, width: number): string {
  return text
    .split("\n")
    .map((line) => `  ${printable(line, width - 2)}`)
    .join("\n");
}

function labelOf(row: AgentRow): string {
  return sanitizeText(row.label, 80);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
