/**
 * A process's identity beyond its pid (ODW extension).
 *
 * A pid alone does not name a process for long: after a reboot, or once the
 * pid space wraps (macOS stops at 99,999), another process — often a root
 * one, which `kill(pid, 0)` answers with EPERM, "alive" — holds the dead
 * worker's pid, and a run that died would show "running" forever: `odw gc`
 * skips it, a schedule's overlap guard and a trigger's dedupe wait on it.
 *
 * So the worker records, beside its pid, when its process started
 * (`pidStart` in status.json): on Linux the boot's id and the start time in
 * clock ticks from `/proc/<pid>/stat`, on macOS and other Unixes `ps -o
 * lstart=` — and elsewhere (Windows) nothing, where liveness stays the bare
 * pid probe. A live pid whose start differs is another process: the worker is
 * gone. A run whose status was last written before this machine booted cannot
 * have a live worker either, whatever its pid — on every platform.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { uptime } from "node:os";

/** Clock slack when comparing a status write with the boot time. */
const BOOT_SLACK_MS = 60_000;

/** How long one reading of a process's start is reused: `ps` is a process of its own. */
const CACHE_MS = 2000;
const cache = new Map<number, { at: number; start: string | null }>();

/**
 * When process `pid` started, as an opaque token — `linux:<boot id>:<ticks>`
 * or `ps:<lstart>` — equal for the same process and different for another
 * that reuses its pid; null when it cannot be read (no such process, no
 * `/proc` and no `ps`, Windows).
 */
export function processStartTime(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const now = Date.now();
  const hit = cache.get(pid);
  if (hit && now - hit.at < CACHE_MS) return hit.start;
  const start = readStart(pid);
  if (cache.size > 256) cache.clear();
  cache.set(pid, { at: now, start });
  return start;
}

function readStart(pid: number): string | null {
  if (process.platform === "win32") return null;
  if (process.platform === "linux") {
    const linux = procStart(pid);
    if (linux !== undefined) return linux;
  }
  return psStart(pid);
}

/** From /proc: the boot id and field 22 of stat; undefined when /proc is not there to read. */
function procStart(pid: number): string | null | undefined {
  let bootId: string;
  try {
    bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return undefined;
  }
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null; // no such process
  }
  // The command name (field 2) is in parentheses and may hold spaces and ")": fields resume after the last ")".
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const ticks = fields[19]; // field 22, counting from the state (field 3)
  return ticks && /^\d+$/.test(ticks) ? `linux:${bootId}:${ticks}` : null;
}

/** From `ps -o lstart=`: the start's date and time, to the second, in the C locale. */
function psStart(pid: number): string | null {
  try {
    const out = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2000,
      windowsHide: true,
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    });
    const line = out.status === 0 ? out.stdout.trim().replace(/\s+/g, " ") : "";
    return line ? `ps:${line}` : null;
  } catch {
    return null;
  }
}

/** When this machine booted, in ms since the epoch. */
export function bootedAt(): number {
  return Date.now() - uptime() * 1000;
}

export interface WorkerIdentity {
  pid: number;
  /** What processStartTime said of the worker when it recorded itself; absent from older runs. */
  pidStart?: unknown;
  /** When its status was last written, in seconds since the epoch. */
  updatedAt?: unknown;
}

export interface IdentityProbe {
  startOf?: (pid: number) => string | null;
  bootedAt?: number;
}

/**
 * Whether a live `pid` is provably not the worker that recorded itself: its
 * status was last written before this machine booted, or the process now
 * holding the pid started at another time. False when nothing tells — a
 * start that cannot be read, or one recorded another way, keeps the bare pid
 * probe's answer.
 */
export function pidReused(worker: WorkerIdentity, probe: IdentityProbe = {}): boolean {
  if (typeof worker.updatedAt === "number" && Number.isFinite(worker.updatedAt)) {
    const booted = probe.bootedAt ?? bootedAt();
    if (worker.updatedAt * 1000 < booted - BOOT_SLACK_MS) return true;
  }
  if (typeof worker.pidStart !== "string" || worker.pidStart === "") return false;
  const now = (probe.startOf ?? processStartTime)(worker.pid);
  if (now === null) return false;
  // Two readings taken different ways (/proc then ps) are not comparable.
  if (scheme(now) !== scheme(worker.pidStart)) return false;
  return now !== worker.pidStart;
}

function scheme(token: string): string {
  return token.slice(0, token.indexOf(":") + 1);
}
