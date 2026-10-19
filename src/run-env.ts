/**
 * `odw doctor`'s run-environment checks (ODW extension): what a fan-out of
 * agents needs from this machine beyond the agent CLIs themselves —
 *
 *   - the open-file limit odw runs with, against a planned fan-out: each agent
 *     holds ~{@link FDS_PER_AGENT} descriptors in the run's process (its three
 *     pipes and its transcript), on top of {@link FD_BASELINE} for odw itself;
 *   - free space where runs are kept and in the temp dir, where each
 *     `isolation: "worktree"` agent gets its checkout — a warning under
 *     {@link LOW_SPACE} — and whether that temp dir is a tmpfs (RAM-backed;
 *     Linux, read from /proc/mounts), with its size;
 *   - the git on PATH: present, and new enough for the worktree commands
 *     isolation uses ({@link MIN_GIT}).
 *
 * Each warning carries a concrete fix line. Read-only: nothing here changes a
 * limit, a mount or a file. What does not apply on a platform (the open-file
 * limit on Windows, tmpfs off Linux) is skipped, never failed.
 *
 * The facts are gathered once ({@link gatherRunEnv}) and judged by a pure
 * function ({@link runEnvChecks}), so every verdict is testable on any machine.
 */

import { existsSync, readFileSync, realpathSync, statfsSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

import type { CommandRunner } from "./adapters/runner.js";
import type { DoctorCheck } from "./doctor.js";
import { formatBytes } from "./runtime/gc.js";

/** Descriptors one running agent holds in the run's process: stdin, stdout, stderr and its transcript. */
export const FDS_PER_AGENT = 4;
/** Descriptors odw itself keeps open regardless of agents: the runtime, the run's files, a dashboard. */
export const FD_BASELINE = 64;
/** Free space under this is a warning: a few worktrees and transcripts fill it. */
export const LOW_SPACE = 1024 ** 3;
/** Isolation's `git worktree remove --force --force` (a locked worktree) needs this git or newer. */
export const MIN_GIT: readonly [number, number] = [2, 17];

/** The open-file limit odw runs with; `Infinity` is unlimited. */
export interface OpenFiles {
  soft: number;
  hard: number;
}

/** The filesystem holding one directory. */
export interface SpaceFact {
  /** The directory asked about. */
  path: string;
  /** Bytes an unprivileged process may still write; null when unknown. */
  free: number | null;
  /** The filesystem's size; null when unknown. */
  total: number | null;
  /** Its type ("tmpfs", "ext4", …) and mount point — Linux only, null elsewhere. */
  fsType: string | null;
  mount: string | null;
}

/** What {@link runEnvChecks} judges. */
export interface RunEnvFacts {
  platform: NodeJS.Platform;
  /** Agents meant to run at once: `--fanout`, or the concurrency cap. */
  fanout: number;
  /** The run-wide concurrency cap, to say when a fan-out exceeds it. */
  concurrency: number;
  /** null: unknown (or Windows, which has no such limit). */
  openFiles: OpenFiles | null;
  runsRoot: SpaceFact;
  tmp: SpaceFact;
  /** `git --version`'s line; null: git is not on PATH (or did not answer). */
  git: string | null;
}

/** Descriptors a fan-out of `fanout` agents needs in the run's process. */
export function fdsNeeded(fanout: number): number {
  return FD_BASELINE + FDS_PER_AGENT * Math.max(1, fanout);
}

/** The checks, from facts: open files, free space at the runs root and the temp dir, git. */
export function runEnvChecks(facts: RunEnvFacts): DoctorCheck[] {
  return [openFilesCheck(facts), runsSpaceCheck(facts), tmpSpaceCheck(facts), gitCheck(facts)];
}

function openFilesCheck(facts: RunEnvFacts): DoctorCheck {
  const check = { id: "open-files", title: "Open-file limit" };
  if (facts.platform === "win32") return { ...check, status: "skip", detail: "Windows has no per-process ulimit -n" };
  if (!facts.openFiles) return { ...check, status: "skip", detail: "could not read the open-file limit" };
  const { soft, hard } = facts.openFiles;
  const need = fdsNeeded(facts.fanout);
  const over = facts.fanout > facts.concurrency ? ` (one run's concurrency cap is ${facts.concurrency}: that many is several runs at once)` : "";
  const plan = `a fan-out of ${facts.fanout} agent(s) needs ~${need}${over}`;
  const limit = soft === Infinity ? "unlimited" : String(soft);
  if (soft >= need) return { ...check, status: "ok", detail: `${limit} per process · ${plan}` };
  // Node raises its soft limit to the hard one at start, so a soft limit below
  // the hard one is rare here — but where it is, the shell can lift it alone.
  const target = Math.max(4096, 2 ** Math.ceil(Math.log2(need)));
  const hint =
    hard >= need
      ? `raise it in the shell that starts odw: \`ulimit -n ${Math.min(target, hard)}\` (add it to ~/.zshrc or ~/.bashrc)`
      : facts.platform === "darwin"
        ? `the hard limit is ${hard}: \`sudo launchctl limit maxfiles ${target} unlimited\`, then \`ulimit -n ${target}\` in a new terminal`
        : `the hard limit is ${hard}: raise \`nofile\` in /etc/security/limits.conf (LimitNOFILE= for a systemd unit, --ulimit nofile= for a container), log in again, then \`ulimit -n ${target}\``;
  return { ...check, status: "warn", detail: `${limit} per process (hard ${hard === Infinity ? "unlimited" : hard}) · ${plan}`, hint };
}

/** "87 GB free of 120 GB", or what is known of it. */
function describeSpace(fact: SpaceFact): string {
  if (fact.free === null) return "free space unknown";
  return `${formatBytes(fact.free)} free${fact.total !== null ? ` of ${formatBytes(fact.total)}` : ""}`;
}

function runsSpaceCheck(facts: RunEnvFacts): DoctorCheck {
  const check = { id: "free-runs", title: "Free space (runs)" };
  const fact = facts.runsRoot;
  if (fact.free === null) return { ...check, status: "skip", detail: `${fact.path}: free space unknown` };
  if (fact.free >= LOW_SPACE) return { ...check, status: "ok", detail: `${describeSpace(fact)} at ${fact.path}` };
  return {
    ...check,
    status: "warn",
    detail: `only ${describeSpace(fact)} at ${fact.path}: a run's transcripts and kept diffs may not fit`,
    hint: "`odw gc --yes` removes what runs left behind; or free space on that disk, or set runsRoot in your config (or --runs-root) to a larger one",
  };
}

function tmpSpaceCheck(facts: RunEnvFacts): DoctorCheck {
  const check = { id: "free-tmp", title: "Free space (temp)" };
  const fact = facts.tmp;
  const tmpfs = fact.fsType === "tmpfs";
  const where = `${fact.path}${tmpfs ? ` — tmpfs (RAM-backed${fact.mount ? `, mounted at ${fact.mount}` : ""})` : ""}`;
  if (fact.free === null) return { ...check, status: "skip", detail: `${where}: free space unknown` };
  const worktrees = 'each isolation: "worktree" agent checks the repository out here';
  if (fact.free >= LOW_SPACE) {
    return { ...check, status: "ok", detail: `${describeSpace(fact)} at ${where}${tmpfs ? ` · ${worktrees}, in memory` : ""}` };
  }
  const variable = facts.platform === "win32" ? "TEMP" : "TMPDIR";
  const elsewhere =
    facts.platform === "win32"
      ? "point TEMP at a directory on a larger disk (`setx TEMP D:\\odw-tmp`, then a new terminal)"
      : `point ${variable} at a directory on a larger disk: \`mkdir -p ~/.cache/odw-tmp && export TMPDIR=~/.cache/odw-tmp\``;
  return {
    ...check,
    status: "warn",
    detail: `only ${describeSpace(fact)} at ${where}: ${worktrees}`,
    hint: tmpfs
      ? `grow the tmpfs (\`sudo mount -o remount,size=8G ${fact.mount ?? fact.path}\`), or ${elsewhere}`
      : `\`odw gc --yes\` removes orphaned worktrees; or ${elsewhere}`,
  };
}

/** `git version 2.43.0` → [2, 43]; null when there is no version in it. */
export function parseGitVersion(line: string): [number, number] | null {
  const m = /(\d+)\.(\d+)/.exec(line);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

function gitCheck(facts: RunEnvFacts): DoctorCheck {
  const check = { id: "git", title: "Git" };
  const min = `${MIN_GIT[0]}.${MIN_GIT[1]}`;
  if (facts.git === null) {
    return {
      ...check,
      status: "warn",
      detail: "not found on PATH — isolation: \"worktree\", odw diff/apply/restore and repositories need it; other runs do not",
      hint: `install git ${min} or newer (https://git-scm.com/downloads), then open a new terminal`,
    };
  }
  const version = parseGitVersion(facts.git);
  const line = facts.git.slice(0, 80);
  if (version && (version[0] < MIN_GIT[0] || (version[0] === MIN_GIT[0] && version[1] < MIN_GIT[1]))) {
    return {
      ...check,
      status: "warn",
      detail: `${line} — removing an isolated agent's worktree needs git ${min} or newer`,
      hint: `upgrade git to ${min} or newer (https://git-scm.com/downloads)`,
    };
  }
  return { ...check, status: "ok", detail: line };
}

// --- gathering --------------------------------------------------------------------

export interface GatherOptions {
  runsRoot: string;
  /** Where worktrees are made: os.tmpdir() unless a test says otherwise. */
  tmpRoot: string;
  fanout: number;
  concurrency: number;
  runner: CommandRunner;
  platform?: NodeJS.Platform;
  /** Linux's mount table; read from /proc/mounts when absent. */
  mounts?: string | null;
}

/** The facts, from this machine: never throws — what cannot be read is null. */
export async function gatherRunEnv(opts: GatherOptions): Promise<RunEnvFacts> {
  const platform = opts.platform ?? process.platform;
  const mounts = platform === "linux" ? (opts.mounts !== undefined ? opts.mounts : readOptional("/proc/mounts")) : null;
  const gitRun = await opts.runner(["git", "--version"], { timeout: 15 }).catch(() => null);
  const gitLine = gitRun && gitRun.returncode === 0 ? gitRun.stdout.trim().split("\n")[0] || null : null;
  return {
    platform,
    fanout: opts.fanout,
    concurrency: opts.concurrency,
    openFiles: platform === "win32" ? null : await openFiles(opts.runner, platform),
    runsRoot: spaceOf(opts.runsRoot, mounts),
    tmp: spaceOf(opts.tmpRoot, mounts),
    git: gitLine,
  };
}

function readOptional(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** `unlimited` → Infinity; a number → itself; anything else → null. */
function limitValue(text: string | undefined): number | null {
  if (text === undefined) return null;
  if (text === "unlimited" || text === "infinity") return Infinity;
  const n = Number(text);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * The limit as this process has it — Node raises its soft limit to the hard
 * one at start, and the agents inherit it — from /proc/self/limits on Linux,
 * else from a shell this process starts (which inherits the same).
 */
async function openFiles(runner: CommandRunner, platform: NodeJS.Platform): Promise<OpenFiles | null> {
  if (platform === "linux") {
    const line = readOptional("/proc/self/limits")?.split("\n").find((l) => l.startsWith("Max open files"));
    const [soft, hard] = (line?.slice("Max open files".length).trim().split(/\s+/) ?? []).map(limitValue);
    if (soft != null && hard != null) return { soft, hard };
  }
  const res = await runner(["/bin/sh", "-c", "ulimit -Sn; ulimit -Hn"], { timeout: 15 }).catch(() => null);
  if (!res || res.returncode !== 0) return null;
  const [soft, hard] = res.stdout.trim().split(/\s+/).map(limitValue);
  return soft != null && hard != null ? { soft, hard } : null;
}

/** The nearest existing directory at or above `path` (a runs root not made yet is measured where it will be). */
function existingAncestor(path: string): string {
  let dir = resolve(path);
  while (!existsSync(dir)) {
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return dir;
}

/** Undo /proc/mounts' octal escapes (`\040` is a space). */
function unescapeMount(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}

/** The mount holding `path` in a /proc/mounts table: the longest mount point it is under. */
export function mountOf(path: string, mounts: string): { mount: string; fsType: string } | null {
  let best: { mount: string; fsType: string } | null = null;
  for (const line of mounts.split("\n")) {
    const fields = line.split(" ");
    if (fields.length < 3) continue;
    const mount = unescapeMount(fields[1]!);
    const under = mount === "/" || path === mount || path.startsWith(mount.endsWith(sep) ? mount : mount + sep);
    if (under && (!best || mount.length >= best.mount.length)) best = { mount, fsType: fields[2]! };
  }
  return best;
}

function spaceOf(path: string, mounts: string | null): SpaceFact {
  const dir = existingAncestor(path);
  let real = dir;
  try {
    real = realpathSync(dir);
  } catch {
    // Measured as named.
  }
  let free: number | null = null;
  let total: number | null = null;
  try {
    const st = statfsSync(real);
    free = Number(st.bavail) * Number(st.bsize);
    total = Number(st.blocks) * Number(st.bsize);
  } catch {
    // An older runtime or an odd filesystem: unknown, and the check is skipped.
  }
  const at = mounts ? mountOf(real, mounts) : null;
  return { path, free, total, fsType: at?.fsType ?? null, mount: at?.mount ?? null };
}
