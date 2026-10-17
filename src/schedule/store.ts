/**
 * Where `odw schedule` keeps things (an ODW extension), and the lock that
 * keeps a schedule's runs from overlapping.
 *
 *   ~/.config/odw/schedules.json                   the definitions: the source of truth
 *   ~/.local/state/odw/schedules/<name>.log        one line per run outcome, plus the OS entry's output
 *   ~/.local/state/odw/schedules/<name>.lock       held while `odw schedule run <name>` runs
 *   ~/.local/state/odw/schedules/<name>.last.json  the last run: its id, state and when
 *
 * `~` is $HOME, exactly as for config.json (which reads no XDG variable either).
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { homeDir } from "../adapters/config.js";
import { readJsonFile, writeJsonAtomic } from "../runtime/fs-util.js";
import { isProcessAlive } from "../runtime/runs-view.js";
import { BACKENDS, ScheduleError, type Backend } from "./backends.js";

/** One schedule, as schedules.json records it. */
export interface ScheduleDefinition {
  name: string;
  /** A workflow name (resolved from `cwd` at each run) or an absolute script path. */
  workflow: string;
  /** The five-field cron expression. */
  cron: string;
  /** The workflow's input (JSON), null for none. */
  args: unknown;
  /** The run-level default adapter (`--adapter`). */
  adapter?: string;
  /** The config file each run uses; absent: the one found from `cwd`, as for `odw run`. */
  configPath?: string;
  /** The run's working directory (`odw run --source`). */
  cwd: string;
  backend: Backend;
  /** When it was added (ISO 8601). */
  createdAt: string;
  /** How the OS entry calls odw: node and the CLI entry, or the odw binary. */
  odwCommand: string[];
  /** The PATH the OS entry sets. */
  path: string;
}

/** A schedule name: what the files, crontab markers, launchd labels and unit names are made of. */
export const SCHEDULE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export interface SchedulePaths {
  /** schedules.json */
  definitions: string;
  /** The directory each schedule's log, lock and last run live in. */
  stateDir: string;
}

export function schedulePaths(home: string = homeDir()): SchedulePaths {
  return {
    definitions: join(home, ".config", "odw", "schedules.json"),
    stateDir: join(home, ".local", "state", "odw", "schedules"),
  };
}

export function logPath(stateDir: string, name: string): string {
  return join(stateDir, `${name}.log`);
}

export function lockPath(stateDir: string, name: string): string {
  return join(stateDir, `${name}.lock`);
}

export function lastRunPath(stateDir: string, name: string): string {
  return join(stateDir, `${name}.last.json`);
}

// --- definitions ------------------------------------------------------------------

/**
 * The entries of schedules.json as written — [] when there is no file yet.
 * Throws a ScheduleError for a file that cannot be read or is not
 * `{ "schedules": [ … ] }`; single entries are checked by {@link checkDefinition}.
 */
export function readScheduleFile(path: string): unknown[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new ScheduleError(`could not read ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ScheduleError(`could not parse ${path}: ${(err as Error).message}`);
  }
  if (!isObject(parsed) || !Array.isArray(parsed.schedules)) {
    throw new ScheduleError(`${path} must be a JSON object with a "schedules" list`);
  }
  return parsed.schedules;
}

/** Write schedules.json whole, atomically (a reader never sees half a file). */
export function writeScheduleFile(path: string, entries: unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeJsonAtomic(path, { schedules: entries }, 2);
}

/** The name an entry of schedules.json claims, if it has one. */
export function entryName(entry: unknown): string | undefined {
  return isObject(entry) && typeof entry.name === "string" ? entry.name : undefined;
}

/** One entry of schedules.json checked: the definition, or what is wrong with it. */
export function checkDefinition(entry: unknown): ScheduleDefinition | string {
  if (!isObject(entry)) return "it is not an object";
  const { name, workflow, cron, adapter, configPath, cwd, backend, createdAt, odwCommand, path } = entry;
  if (typeof name !== "string" || !SCHEDULE_NAME_RE.test(name)) return `"name" must match ${SCHEDULE_NAME_RE.source}`;
  if (typeof workflow !== "string" || workflow === "") return `"workflow" must be a workflow name or a script path`;
  if (typeof cron !== "string") return `"cron" must be a cron expression`;
  if (adapter !== undefined && typeof adapter !== "string") return `"adapter" must be an adapter name`;
  if (configPath !== undefined && (typeof configPath !== "string" || !isAbsolute(configPath))) {
    return `"configPath" must be an absolute path`;
  }
  if (typeof cwd !== "string" || !isAbsolute(cwd)) return `"cwd" must be an absolute directory`;
  if (!(BACKENDS as readonly unknown[]).includes(backend)) return `"backend" must be one of ${BACKENDS.join(", ")}`;
  if (!Array.isArray(odwCommand) || odwCommand.length === 0 || !odwCommand.every((p) => typeof p === "string")) {
    return `"odwCommand" must be a non-empty list of strings`;
  }
  return {
    name,
    workflow,
    cron,
    args: entry.args ?? null,
    ...(adapter !== undefined ? { adapter } : {}),
    ...(configPath !== undefined ? { configPath } : {}),
    cwd,
    backend: backend as Backend,
    createdAt: typeof createdAt === "string" ? createdAt : "",
    odwCommand: odwCommand as string[],
    path: typeof path === "string" ? path : "",
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// --- the lock ---------------------------------------------------------------------

/** Who holds a schedule's lock. */
export interface LockHolder {
  pid: number;
  /** When it took the lock (local ISO 8601). */
  startedAt: string;
  /** The run it started, once it has one, and the runs root that run lives under. */
  runId?: string;
  runsRoot?: string;
}

export interface LockOptions {
  /** Whether a process is alive; process.kill(pid, 0) by default. */
  isAlive?: (pid: number) => boolean | null;
  /** When this machine booted (ms since the epoch): a lock taken before that is stale whatever its pid. */
  bootedAt?: number;
  /** Whether the run a dead holder started still goes on: then the lock still holds. */
  runActive?: (holder: LockHolder) => boolean;
  now?: () => Date;
}

export type LockAttempt = { acquired: true; lock: ScheduleLock } | { acquired: false; holder: LockHolder | null };

/** A lock file still empty or garbled this long after it was written was abandoned mid-write. */
const UNREADABLE_GRACE_MS = 10_000;
/** A takeover token lives for microseconds; one this old was left by a crash. */
const TOKEN_STALE_MS = 10_000;
/** Clock slack when comparing a lock's start with the boot time. */
const BOOT_SLACK_MS = 60_000;

/**
 * Take the lock at `path`: created atomically (O_EXCL) holding this pid and
 * the start time, so of two `odw schedule run`s exactly one gets it.
 *
 * A held lock is stale — and taken over — when its holder is dead (or the
 * machine rebooted since it was taken, which also covers a reused pid) and
 * the run it started, if any, is no longer going. A dead holder's run that
 * goes on keeps the lock: the worker outlives the process that waits for it.
 * Taking over is itself exclusive: under a `<lock>.takeover` token, and only
 * while the lock still reads as the dead holder's.
 */
export function acquireLock(path: string, options: LockOptions = {}): LockAttempt {
  const now = options.now ?? (() => new Date());
  const content = JSON.stringify({ pid: process.pid, startedAt: localIso(now()) }) + "\n";
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      writeFileSync(path, content, { flag: "wx", mode: 0o600 });
      return { acquired: true, lock: new ScheduleLock(path, content) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const seen = readLockFile(path, now);
    if (seen === null) continue; // released meanwhile: try again
    const holder = parseHolder(seen.raw);
    if (!isStale(holder, seen.ageMs, options)) return { acquired: false, holder };
    if (!takeOver(path, seen.raw, now)) sleep(20); // another contender is replacing it right now
  }
  return { acquired: false, holder: parseHolder(readLockFile(path, now)?.raw ?? "") };
}

/** A lock this process holds. */
export class ScheduleLock {
  constructor(
    readonly path: string,
    private content: string,
  ) {}

  /** Record the run the lock now covers, so a holder that dies while its run goes on keeps the lock. */
  record(run: { runId: string; runsRoot: string }): void {
    const next = JSON.stringify({ ...(JSON.parse(this.content) as LockHolder), ...run }) + "\n";
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, next, { mode: 0o600 });
    renameSync(tmp, this.path);
    this.content = next;
  }

  /** Give the lock up — only while it is still this one, never another process's. */
  release(): void {
    if (readLockFile(this.path, () => new Date())?.raw === this.content) rmSync(this.path, { force: true });
  }
}

function isStale(holder: LockHolder | null, ageMs: number, options: LockOptions): boolean {
  if (holder === null) return ageMs > UNREADABLE_GRACE_MS; // being written, unless it has been for long
  const bootedAt = options.bootedAt ?? Date.now() - uptime() * 1000;
  const startedAt = Date.parse(holder.startedAt);
  if (Number.isFinite(startedAt) && startedAt < bootedAt - BOOT_SLACK_MS) return true;
  if ((options.isAlive ?? isProcessAlive)(holder.pid) !== false) return false;
  return !(holder.runId !== undefined && options.runActive?.(holder));
}

/**
 * Remove the dead holder's lock — `stale` is its exact content — so a new one
 * can be taken; false when another contender holds the takeover token.
 */
function takeOver(path: string, stale: string, now: () => Date): boolean {
  const token = `${path}.takeover`;
  try {
    writeFileSync(token, String(process.pid), { flag: "wx", mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const left = readLockFile(token, now);
    if (left !== null && left.ageMs > TOKEN_STALE_MS) rmSync(token, { force: true });
    return false;
  }
  try {
    // Still the dead holder's (no new lock taken meanwhile)? Then it goes.
    if (readLockFile(path, now)?.raw === stale) rmSync(path, { force: true });
  } finally {
    rmSync(token, { force: true });
  }
  return true;
}

function readLockFile(path: string, now: () => Date): { raw: string; ageMs: number } | null {
  try {
    const raw = readFileSync(path, "utf8");
    return { raw, ageMs: now().getTime() - statSync(path).mtimeMs };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function parseHolder(raw: string): LockHolder | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const { pid, startedAt, runId, runsRoot } = value;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 || typeof startedAt !== "string") return null;
    return {
      pid,
      startedAt,
      ...(typeof runId === "string" ? { runId } : {}),
      ...(typeof runsRoot === "string" ? { runsRoot } : {}),
    };
  } catch {
    return null;
  }
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// --- the last run and the log ---------------------------------------------------------

/** What `odw schedule run` last did for a schedule. */
export interface LastRun {
  /** Null when the run could not even be started. */
  runId: string | null;
  /** "running" while it goes on, then its final state; "failed" for a run that could not start. */
  state: string;
  /** Local ISO 8601 times. */
  startedAt: string;
  finishedAt?: string;
  /** Why it failed, or could not start. */
  error?: string;
  /** The runs root the run lives under. */
  runsRoot?: string;
}

export function readLastRun(path: string): LastRun | null {
  const last = readJsonFile<LastRun>(path);
  if (!isObject(last) || typeof last.state !== "string" || typeof last.startedAt !== "string") return null;
  return { ...last, runId: typeof last.runId === "string" ? last.runId : null };
}

export function writeLastRun(path: string, last: LastRun): void {
  writeJsonAtomic(path, last, 2);
}

/** Append one line to a schedule's log, stamped with the local time; returns the line. */
export function appendLog(path: string, text: string, at: Date): string {
  const line = `${localIso(at)} ${text}\n`;
  appendFileSync(path, line);
  return line;
}

// --- local time ---------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");

/** 2026-10-17T08:00:01+02:00 — local time with its UTC offset, as the log and last run record it. */
export function localIso(at: Date): string {
  const offset = -at.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** 2026-10-17 08:00 — local time to the minute, as tables show it. */
export function localMinute(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}
