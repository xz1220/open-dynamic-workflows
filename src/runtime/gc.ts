/**
 * What ODW leaves on disk, reported — and reclaimed when asked (an ODW
 * extension; `odw gc`, `odw pin`, see ./gc-cli). Four kinds:
 *
 *   1. orphaned worktrees — `$TMPDIR/odw-wt-*` directories (and their git
 *      registrations) whose process is gone: a worker that was SIGKILLed or
 *      lost its machine never ran its cleanup. Each worktree names its owner
 *      in `odw-owner.json` beside it (see ../workspace); one whose process
 *      lives, or whose run is still active, is never touched, and one with no
 *      owner file (an older odw) only once it is a day old. Removed as the
 *      worker would have: `worktree unlock`, `worktree remove --force
 *      --force`, the directory, `worktree prune`.
 *   2. keep branches — `odw/<runId>/<agentId>-<label>` (keep: true,
 *      keepBranches) of a run in this runs root, whose change HEAD already
 *      holds (`odw apply`'d and committed: `git cherry` finds it upstream, or
 *      HEAD contains the commit), or whose run is past retention. A branch of
 *      a run this runs root does not know is counted, never deleted.
 *   3. expired run directories — an ended run past retention has its agents'
 *      transcripts and stderr (the largest part) trimmed; meta.json, status,
 *      events, saved results and diffs stay, so `odw list`, `estimate` and
 *      `compare` still work. `gc.json` in the run says what went.
 *   4. safety snapshots — `refs/odw/safety/<runId>` (see ../safety) of a run
 *      in this runs root that is past retention. A snapshot of a run this
 *      runs root does not know is counted, never deleted.
 *   5. totals — the runs root's size, and what each kind would reclaim.
 *   6. compose projects — `odw-*` docker compose projects (an agent's
 *      `ODW_SLOT` is its `COMPOSE_PROJECT_NAME`; see ../slot) whose
 *      run is not active: what a `worktreeTeardown` did not take down.
 *      Reported only, never removed, and only when `docker compose ls`
 *      answers at once; ODW does not manage services.
 *
 * A run that is running, paused or waiting at a checkpoint, or that `odw pin`
 * marked (`pinned.json` in its directory), is skipped in every kind: the
 * operator's mark wins. Nothing is deleted unless `apply` is asked to (`odw gc
 * --yes`); no worktree or branch odw did not make is ever looked at.
 */

import { execFile } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import { SAFE_GIT } from "../git-safety.js";
import { SAFETY_REF_PREFIX } from "../safety.js";
import { runSlotPart, SLOT_PREFIX } from "../slot.js";
import { OWNER_FILE, WORKTREE_PREFIX } from "../workspace.js";
import { readJsonFile, readdirSafe, writeJsonAtomic } from "./fs-util.js";
import { isRunActive } from "./run-liveness.js";
import type { RunStore } from "./run-store.js";
import { pidReused } from "./process-identity.js";
import { isProcessAlive } from "./runs-view.js";

const run = promisify(execFile);

/** The marker `odw pin` writes in a run's directory. */
export const PIN_FILE = "pinned.json";
/** What `odw gc` trimmed of a run, written in its directory. */
export const GC_FILE = "gc.json";
/** A worktree without an owner file (made by an older odw) counts as an orphan only once untouched this long. */
export const UNOWNED_GRACE_SECONDS = 24 * 3600;
/** The temporary directory of an isolated agent's worktree: `odw-wt-` and mkdtemp's six characters. */
const TMP_DIR_RE = new RegExp(`^${WORKTREE_PREFIX}[A-Za-z0-9]{6}$`);
/** A kept branch, as ../changes branchName makes it: `odw/<run>/<agentId>-<slug>`. */
const BRANCH_RE = /^refs\/heads\/(odw\/([A-Za-z0-9-]+)\/\d+-[a-z0-9-]*)$/;
const GIT_TIMEOUT_MS = 15_000;

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", dir, ...SAFE_GIT, ...args], {
    maxBuffer: 16 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  });
  return stdout;
}

// --- pins ------------------------------------------------------------------------

/** Who pinned a run, and when (epoch seconds). */
export interface Pin {
  at: number;
  by: string | null;
}

/** The run's pin, or null when it has none. */
export function readPin(runDir: string): Pin | null {
  const pin = readJsonFile(join(runDir, PIN_FILE));
  if (pin === null) return existsSync(join(runDir, PIN_FILE)) ? { at: 0, by: null } : null;
  return { at: typeof pin.at === "number" ? pin.at : 0, by: typeof pin.by === "string" ? pin.by : null };
}

/** Pin a run: `odw gc` skips it in every kind until it is unpinned. */
export function pinRun(runDir: string, by: string | null, now = Date.now() / 1000): void {
  writeJsonAtomic(join(runDir, PIN_FILE), { at: now, by });
}

/** Unpin a run; false when it was not pinned. */
export function unpinRun(runDir: string): boolean {
  if (!existsSync(join(runDir, PIN_FILE))) return false;
  rmSync(join(runDir, PIN_FILE), { force: true });
  return true;
}

/** What `odw gc` trimmed of a run — when, and how many files — or null when nothing. */
export function readTrimmed(runDir: string): { at: number; files: number } | null {
  const gc = readJsonFile(join(runDir, GC_FILE));
  if (gc === null || !Array.isArray(gc.trimmed)) return null;
  return { at: typeof gc.at === "number" ? gc.at : 0, files: gc.trimmed.length };
}

// --- sizes -----------------------------------------------------------------------

/** Bytes under `path`, symlinks counted as links (never followed); 0 when it is gone. */
export function diskBytes(path: string): number {
  let st: Stats;
  try {
    st = lstatSync(path);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.size;
  let total = 0;
  const stack = [path];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSafe(dir)) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else {
        try {
          total += lstatSync(full).size;
        } catch {
          /* gone meanwhile */
        }
      }
    }
  }
  return total;
}

/** `1.2 GB`, `340 KB`, `12 B`. */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit++;
  }
  return unit === 0 ? `${n} B` : `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[unit]}`;
}

// --- 1. orphaned worktrees -------------------------------------------------------------

/** One isolated agent's worktree directory, and whether it is an orphan. */
export interface WorktreeFinding {
  /** The `odw-wt-*` directory: what is removed. */
  dir: string;
  /** The worktree in it (null: none left). */
  worktree: string | null;
  /** The repository it is a worktree of (null: not known). */
  repo: string | null;
  /** Git still lists it as a worktree of `repo`. */
  registered: boolean;
  /** The run it was for, when its owner file names one. */
  run: string | null;
  /** The process that made it, when its owner file names one. */
  pid: number | null;
  /** When that process started (ODW extension; see ./process-identity): a live pid that started otherwise is another process. */
  pidStart?: string;
  /** Why it is an orphan, or why it is kept. */
  why: string;
  orphan: boolean;
  /** Its run is pinned (`odw pin`): kept whatever else holds. */
  pinned?: boolean;
  /** Its size on disk — measured for an orphan only (0 for one kept). */
  bytes: number;
}

export interface WorktreeScanOptions {
  /** Where worktree directories are made (default: os.tmpdir()); null: scan no directory, only the repos' registrations. */
  tmpRoot?: string | null;
  /** Repositories whose registered worktrees to look at, besides those the directories name. */
  repos?: string[];
  /** The runs root, to tell an active or pinned run (null: owner processes only). */
  store?: RunStore | null;
  isAlive?: typeof isProcessAlive;
  /** Epoch seconds. */
  now?: number;
  /** Measure each directory (a walk of the whole tree); false: bytes stay 0. */
  measure?: boolean;
}

interface Registration {
  repo: string;
  worktree: string;
}

/** The worktrees git lists for `repo` that live in an `odw-wt-*` directory. */
async function odwRegistrations(repo: string): Promise<Registration[]> {
  let out: string;
  try {
    out = await git(repo, ["worktree", "list", "--porcelain", "-z"]);
  } catch {
    return [];
  }
  const found: Registration[] = [];
  for (const field of out.split("\0")) {
    if (!field.startsWith("worktree ")) continue;
    const worktree = field.slice("worktree ".length);
    if (TMP_DIR_RE.test(basename(dirname(worktree)))) found.push({ repo, worktree });
  }
  return found;
}

/** A repository's top level, or null outside one. */
export async function repoTop(dir: string): Promise<string | null> {
  try {
    const top = (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
    return top === "" ? null : top;
  } catch {
    return null;
  }
}

/** The repository a worktree belongs to, read from its `.git` file: `gitdir: <repo>/.git/worktrees/<name>`. */
function repoOfWorktree(worktree: string): string | null {
  try {
    const line = readFileSync(join(worktree, ".git"), "utf8").trim();
    if (!line.startsWith("gitdir: ")) return null;
    const gitdir = resolve(worktree, line.slice("gitdir: ".length));
    const common = dirname(dirname(gitdir));
    return basename(common) === ".git" ? dirname(common) : null;
  } catch {
    return null;
  }
}

/** The single directory inside an `odw-wt-*` directory: the worktree (its name is the repository's). */
function worktreeIn(dir: string): string | null {
  const subdirs = readdirSafe(dir).filter((e) => e.isDirectory());
  return subdirs.length === 1 ? join(dir, subdirs[0]!.name) : null;
}

/** A path with its symlinks resolved (macOS /tmp is /private/tmp) — its parent's, when it is gone itself. */
function realOr(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    try {
      return join(realpathSync.native(dirname(path)), basename(path));
    } catch {
      return resolve(path);
    }
  }
}

/**
 * Every `odw-wt-*` worktree directory in `tmpRoot` and every one the repos
 * register, with its verdict: an orphan when its owner process is gone (and
 * its run, when this runs root knows it, is not active), or — with no owner
 * file — when it was untouched for a day. Read-only.
 */
export async function scanWorktrees(opts: WorktreeScanOptions = {}): Promise<WorktreeFinding[]> {
  const isAlive = opts.isAlive ?? isProcessAlive;
  const now = opts.now ?? Date.now() / 1000;
  const tmpRoot = opts.tmpRoot === undefined ? tmpdir() : opts.tmpRoot;
  // Every candidate directory, by its real path: one found in the tmp root and registered in a repo is one finding.
  const dirs = new Map<string, { dir: string; registration: Registration | null }>();
  if (tmpRoot !== null) {
    for (const entry of readdirSafe(tmpRoot)) {
      if (entry.isDirectory() && TMP_DIR_RE.test(entry.name)) {
        const dir = join(tmpRoot, entry.name);
        dirs.set(realOr(dir), { dir, registration: null });
      }
    }
  }
  const repos = new Set<string>();
  for (const repo of opts.repos ?? []) repos.add(realOr(repo));
  for (const { dir } of dirs.values()) {
    const owner = readJsonFile(join(dir, OWNER_FILE));
    if (owner && typeof owner.repo === "string" && isAbsolute(owner.repo)) repos.add(realOr(owner.repo));
    const worktree = worktreeIn(dir);
    const repo = worktree ? repoOfWorktree(worktree) : null;
    if (repo) repos.add(realOr(repo));
  }
  for (const repo of repos) {
    for (const registration of await odwRegistrations(repo)) {
      const dir = dirname(registration.worktree);
      const key = realOr(dir);
      const known = dirs.get(key);
      if (known) known.registration = registration;
      else dirs.set(key, { dir, registration });
    }
  }

  const findings: WorktreeFinding[] = [];
  for (const { dir, registration } of dirs.values()) {
    const present = existsSync(dir);
    const owner = present ? readJsonFile(join(dir, OWNER_FILE)) : null;
    const pid = owner && typeof owner.pid === "number" && Number.isSafeInteger(owner.pid) && owner.pid > 0 ? owner.pid : null;
    const runId = owner && typeof owner.run === "string" ? owner.run : null;
    const worktree = registration?.worktree ?? (present ? worktreeIn(dir) : null);
    const repo =
      registration?.repo ??
      (owner && typeof owner.repo === "string" ? owner.repo : null) ??
      (worktree ? repoOfWorktree(worktree) : null);
    const finding: WorktreeFinding = {
      dir,
      worktree,
      repo,
      registered: registration !== null,
      run: runId,
      pid,
      ...(typeof owner?.pidStart === "string" ? { pidStart: owner.pidStart } : {}),
      why: "",
      orphan: false,
      bytes: 0,
    };
    // Neither registered, nor named by an owner file, nor holding a git worktree: some other
    // `odw-wt-*` directory (a test's scratch, say) — not one of ours to judge.
    if (!registration && !owner && !(worktree && existsSync(join(worktree, ".git")))) continue;
    const store = opts.store ?? null;
    const known = runId !== null && store !== null && store.exists(runId);
    if (known && readPin(store!.runDir(runId!))) {
      finding.pinned = true;
      finding.why = `its run ${runId} is pinned`;
    } else if (!present) {
      finding.orphan = true;
      finding.why = "registered with git, but its directory is gone";
    } else if (pid !== null && isAlive(pid) !== false && !pidReused({ pid, pidStart: owner?.pidStart })) {
      finding.why = `in use by process ${pid}`;
    } else if (known && isRunActive(store!, runId!, isAlive)) {
      finding.why = `its run ${runId} is still active`;
    } else if (pid !== null) {
      finding.orphan = true;
      finding.why = `process ${pid} is gone` + (runId ? ` (run ${runId})` : "");
    } else {
      const age = now - mtimeSeconds(dir);
      finding.orphan = age >= UNOWNED_GRACE_SECONDS;
      finding.why = finding.orphan
        ? "no owner file (an older odw), untouched for a day or more"
        : "no owner file, and too recent to tell";
    }
    if (finding.orphan && present && opts.measure !== false) finding.bytes = diskBytes(dir);
    findings.push(finding);
  }
  return findings.sort((a, b) => a.dir.localeCompare(b.dir));
}

function mtimeSeconds(path: string): number {
  try {
    return statSync(path).mtimeMs / 1000;
  } catch {
    return 0;
  }
}

/** Remove an orphaned worktree as the worker would have; throws what failed. */
async function removeWorktree(f: WorktreeFinding): Promise<void> {
  // Only ever a directory odw made: `odw-wt-` and six characters.
  if (!TMP_DIR_RE.test(basename(f.dir))) throw new Error(`not an odw worktree directory: ${f.dir}`);
  if (f.repo && f.worktree && f.registered && existsSync(f.worktree)) {
    await git(f.repo, ["worktree", "unlock", f.worktree]).catch(() => {});
    await git(f.repo, ["worktree", "remove", "--force", "--force", f.worktree]).catch(() => {});
  }
  rmSync(f.dir, { recursive: true, force: true });
  if (f.repo && existsSync(f.repo)) await git(f.repo, ["worktree", "prune"]);
}

// --- 2. keep branches -----------------------------------------------------------------

export interface BranchFinding {
  repo: string;
  branch: string;
  commit: string;
  run: string;
  /** Why it would go: HEAD holds its change already, or its run is past retention. */
  reason: "applied" | "expired";
}

export interface BranchScan {
  candidates: BranchFinding[];
  /** odw branches whose run this runs root does not know: counted, never deleted. */
  unknown: Array<{ repo: string; branch: string }>;
  /** Branches of a run that is active or pinned. */
  kept: number;
}

/** HEAD holds the branch's change: it contains the commit, or `git cherry` finds every commit of it upstream. */
async function headHolds(repo: string, commit: string): Promise<boolean> {
  try {
    await git(repo, ["merge-base", "--is-ancestor", commit, "HEAD"]);
    return true;
  } catch {
    /* not an ancestor */
  }
  try {
    const lines = (await git(repo, ["cherry", "HEAD", commit])).split("\n").filter((l) => l.trim() !== "");
    return lines.length > 0 && lines.every((l) => l.startsWith("-"));
  } catch {
    return false;
  }
}

// --- 4. safety snapshots -------------------------------------------------------------

export interface SnapshotFinding {
  repo: string;
  /** `refs/odw/safety/<run>`. */
  ref: string;
  run: string;
}

export interface SnapshotScan {
  /** Snapshots of runs past retention. */
  candidates: SnapshotFinding[];
  /** Snapshots of runs this runs root does not know: counted, never deleted. */
  unknown: number;
  /** Snapshots of runs that are active, pinned, or within retention. */
  kept: number;
}

// --- 6. compose projects --------------------------------------------------------------

export interface ComposeFinding {
  /** The compose project: `odw-<run>-<agent>`, an agent's ODW_SLOT. */
  name: string;
  /** As `docker compose ls` says it: `running(2)`, `exited(1)`. */
  status: string;
  /** The run of this runs root it belongs to; null when none here matches. */
  run: string | null;
}

export interface ComposeScan {
  /** Projects whose run is not active nor pinned (or unknown here): reported, never removed. */
  leftover: ComposeFinding[];
  /** Projects of runs still active or pinned. */
  inUse: number;
}

/** `docker compose ls` gets this long: a daemon that does not answer at once is not looked at. */
const COMPOSE_TIMEOUT_MS = 5_000;

/**
 * The `odw-*` compose projects `docker` (a program name or path) lists, by
 * run; null when it cannot say — no docker, no daemon, no compose plugin.
 */
async function scanCompose(docker: string, runIds: string[], held: Set<string>): Promise<ComposeScan | null> {
  let listed: unknown;
  try {
    const { stdout } = await run(docker, ["compose", "ls", "--all", "--format", "json", "--filter", `name=${SLOT_PREFIX}`], {
      maxBuffer: 4 * 1024 * 1024,
      timeout: COMPOSE_TIMEOUT_MS,
      windowsHide: true,
    });
    listed = JSON.parse(stdout.trim() || "[]");
  } catch {
    return null;
  }
  if (!Array.isArray(listed)) return null;
  const byPart = new Map<string, string>();
  for (const runId of runIds) byPart.set(runSlotPart(runId), runId);
  const scan: ComposeScan = { leftover: [], inUse: 0 };
  for (const entry of listed as Array<Record<string, unknown>>) {
    const name = typeof entry?.Name === "string" ? entry.Name : "";
    const m = /^odw-([a-z0-9-]+)-[a-z0-9]+$/.exec(name);
    if (!m) continue; // the filter matches anywhere in the name
    const runId = byPart.get(m[1]!) ?? null;
    if (runId !== null && held.has(runId)) scan.inUse++;
    else scan.leftover.push({ name, status: typeof entry.Status === "string" ? entry.Status : "", run: runId });
  }
  return scan;
}

// --- 3. run directories ---------------------------------------------------------------

export interface RunFinding {
  runId: string;
  workflow: string | null;
  /** Days since its last activity. */
  ageDays: number;
  /** The transcripts and stderr files to trim. */
  files: string[];
  bytes: number;
}

// --- the whole plan ------------------------------------------------------------------

export interface GcOptions {
  store: RunStore;
  /** An ended run older than this many days is past retention. */
  olderThanDays: number;
  /** Trim expired runs' transcripts and stderr (retention.transcripts). */
  transcripts: boolean;
  /** Repositories to look at besides those runs and worktrees name (the current one). */
  repos?: string[];
  tmpRoot?: string | null;
  isAlive?: typeof isProcessAlive;
  now?: number;
  /** The docker to ask for leftover `odw-*` compose projects (`odw gc` passes "docker"); absent => not looked at. */
  docker?: string | null;
}

export interface GcPlan {
  runsRoot: string;
  olderThanDays: number;
  worktrees: WorktreeFinding[];
  branches: BranchScan;
  snapshots: SnapshotScan;
  /** Leftover `odw-*` compose projects, reported only; null when not looked at or docker could not say. */
  compose: ComposeScan | null;
  runs: RunFinding[];
  /** Runs skipped in every kind: still active, or pinned. */
  skipped: { active: string[]; pinned: string[] };
  totals: { runsRootBytes: number; worktreeBytes: number; transcriptBytes: number };
}

/** Days since a run's last recorded activity: status.updatedAt, else meta.createdAt. */
function runAgeDays(store: RunStore, runId: string, now: number): number {
  const status = store.readStatus(runId);
  const meta = store.readMeta(runId);
  const at = typeof status.updatedAt === "number" ? status.updatedAt : typeof meta.createdAt === "number" ? meta.createdAt : now;
  return Math.max(0, (now - at) / 86_400);
}

/** What `odw gc` would do. Read-only. */
export async function planGc(opts: GcOptions): Promise<GcPlan> {
  const { store } = opts;
  const now = opts.now ?? Date.now() / 1000;
  const isAlive = opts.isAlive ?? isProcessAlive;
  const skipped = { active: [] as string[], pinned: [] as string[] };
  const runs: RunFinding[] = [];
  const held = new Set<string>(); // active or pinned
  const ages = new Map<string, number>();
  const sources = new Set<string>();
  for (const ref of store.listRuns()) {
    const runId = ref.runId;
    const dir = store.runDir(runId);
    const source = store.readMeta(runId).source;
    if (typeof source === "string" && isAbsolute(source)) sources.add(source);
    if (readPin(dir)) {
      skipped.pinned.push(runId);
      held.add(runId);
      continue;
    }
    if (isRunActive(store, runId, isAlive)) {
      skipped.active.push(runId);
      held.add(runId);
      continue;
    }
    const age = runAgeDays(store, runId, now);
    ages.set(runId, age);
    if (!opts.transcripts || age < opts.olderThanDays) continue;
    const files: string[] = [];
    let bytes = 0;
    for (const entry of readdirSafe(join(dir, "agents"))) {
      if (!entry.isFile() || !/^\d+\.(?:transcript\.jsonl|stderr\.txt)$/.test(entry.name)) continue;
      const path = join(dir, "agents", entry.name);
      files.push(path);
      bytes += diskBytes(path);
    }
    if (files.length > 0) runs.push({ runId, workflow: ref.workflowName, ageDays: age, files, bytes });
  }

  // The repositories: the current one, and each run's source — deduplicated by top level.
  const repos = new Set<string>();
  for (const dir of [...(opts.repos ?? []), ...sources]) {
    if (!existsSync(dir)) continue;
    const top = await repoTop(dir);
    if (top) repos.add(top);
  }

  const worktrees = await scanWorktrees({ tmpRoot: opts.tmpRoot, repos: [...repos], store, isAlive, now });

  // Branch segments name runs as ../changes branchName writes them.
  const bySegment = new Map<string, string>();
  for (const runId of store.listRunIds()) bySegment.set(runId.replace(/[^A-Za-z0-9-]+/g, "-"), runId);
  const branches: BranchScan = { candidates: [], unknown: [], kept: 0 };
  for (const repo of repos) {
    let out: string;
    try {
      out = await git(repo, ["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads/odw/"]);
    } catch {
      continue;
    }
    for (const line of out.split("\n")) {
      const [ref, commit] = line.split("\0");
      const m = ref ? BRANCH_RE.exec(ref) : null;
      if (!m || !commit) continue;
      const branch = m[1]!;
      const runId = bySegment.get(m[2]!);
      if (runId === undefined) {
        branches.unknown.push({ repo, branch });
        continue;
      }
      if (held.has(runId)) {
        branches.kept++;
        continue;
      }
      if (await headHolds(repo, commit)) branches.candidates.push({ repo, branch, commit, run: runId, reason: "applied" });
      else if ((ages.get(runId) ?? 0) >= opts.olderThanDays) branches.candidates.push({ repo, branch, commit, run: runId, reason: "expired" });
    }
  }

  const known = new Set(store.listRunIds());
  const snapshots: SnapshotScan = { candidates: [], unknown: 0, kept: 0 };
  for (const repo of repos) {
    let out: string;
    try {
      out = await git(repo, ["for-each-ref", "--format=%(refname)", SAFETY_REF_PREFIX]);
    } catch {
      continue;
    }
    for (const ref of out.split("\n")) {
      if (!ref.startsWith(SAFETY_REF_PREFIX)) continue;
      const runId = ref.slice(SAFETY_REF_PREFIX.length);
      if (!known.has(runId)) snapshots.unknown++;
      else if (!held.has(runId) && (ages.get(runId) ?? 0) >= opts.olderThanDays) snapshots.candidates.push({ repo, ref, run: runId });
      else snapshots.kept++;
    }
  }

  const compose = opts.docker ? await scanCompose(opts.docker, [...known], held) : null;

  return {
    runsRoot: store.root,
    olderThanDays: opts.olderThanDays,
    worktrees,
    branches,
    snapshots,
    compose,
    runs,
    skipped,
    totals: {
      runsRootBytes: diskBytes(store.root),
      worktreeBytes: worktrees.filter((w) => w.orphan).reduce((n, w) => n + w.bytes, 0),
      transcriptBytes: runs.reduce((n, r) => n + r.bytes, 0),
    },
  };
}

/** What `odw gc --yes` did: each removal, and each that failed. */
export interface GcResult {
  worktrees: number;
  branches: number;
  snapshots: number;
  runs: number;
  bytes: number;
  errors: string[];
}

/**
 * Carry out a plan: remove the orphaned worktrees, delete the branches, trim
 * the runs. Each is checked again just before it goes — a run that became
 * active or pinned, or a worktree whose process came back, is left — and a
 * failure is recorded and the rest goes on.
 */
export async function applyGc(plan: GcPlan, opts: Pick<GcOptions, "store" | "isAlive" | "now">): Promise<GcResult> {
  const { store } = opts;
  const isAlive = opts.isAlive ?? isProcessAlive;
  const now = opts.now ?? Date.now() / 1000;
  const result: GcResult = { worktrees: 0, branches: 0, snapshots: 0, runs: 0, bytes: 0, errors: [] };
  const stillFree = (runId: string): boolean =>
    !store.exists(runId) || (!readPin(store.runDir(runId)) && !isRunActive(store, runId, isAlive));

  for (const w of plan.worktrees) {
    if (!w.orphan) continue;
    if (w.pid !== null && isAlive(w.pid) !== false && !pidReused({ pid: w.pid, pidStart: w.pidStart })) continue;
    if (w.run !== null && !stillFree(w.run)) continue;
    try {
      await removeWorktree(w);
      result.worktrees++;
      result.bytes += w.bytes;
    } catch (err) {
      result.errors.push(`worktree ${w.dir}: ${message(err)}`);
    }
  }
  for (const b of plan.branches.candidates) {
    if (!stillFree(b.run)) continue;
    try {
      // -D refuses a branch checked out in any worktree: that one stays.
      await git(b.repo, ["branch", "-D", b.branch]);
      result.branches++;
    } catch (err) {
      result.errors.push(`branch ${b.branch} in ${b.repo}: ${message(err)}`);
    }
  }
  for (const snap of plan.snapshots.candidates) {
    if (!stillFree(snap.run)) continue;
    try {
      await git(snap.repo, ["update-ref", "-d", snap.ref]);
      result.snapshots++;
    } catch (err) {
      result.errors.push(`snapshot ${snap.ref} in ${snap.repo}: ${message(err)}`);
    }
  }
  for (const r of plan.runs) {
    if (!stillFree(r.runId)) continue;
    let bytes = 0;
    const trimmed: string[] = [];
    for (const path of r.files) {
      try {
        const size = diskBytes(path);
        rmSync(path, { force: true });
        bytes += size;
        trimmed.push(basename(path));
      } catch (err) {
        result.errors.push(`run ${r.runId}: ${message(err)}`);
      }
    }
    if (trimmed.length === 0) continue;
    try {
      const dir = store.runDir(r.runId);
      const before = readJsonFile(join(dir, GC_FILE));
      const earlier = Array.isArray(before?.trimmed) ? (before!.trimmed as unknown[]).filter((x) => typeof x === "string") : [];
      writeFileSync(join(dir, GC_FILE), JSON.stringify({ at: now, trimmed: [...earlier, ...trimmed], bytes: bytes + (typeof before?.bytes === "number" ? before.bytes : 0) }) + "\n");
    } catch {
      /* the trim stands; only its note is missing */
    }
    result.runs++;
    result.bytes += bytes;
  }
  return result;
}

function message(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (e.stderr?.trim() || e.message || String(err)).split("\n")[0]!;
}

/**
 * The worker's start-up look (read-only): orphaned worktrees of the run's
 * repository, by its registrations only — never a walk of their trees. Empty
 * outside a repository, and on any failure.
 */
export async function orphanedWorktreesOf(source: string, store: RunStore | null): Promise<WorktreeFinding[]> {
  try {
    const top = await repoTop(source);
    if (!top) return [];
    const found = await scanWorktrees({ tmpRoot: null, repos: [top], store, measure: false });
    return found.filter((w) => w.orphan);
  } catch {
    return [];
  }
}
