/**
 * A full disk under the run directory (ODW extension).
 *
 * Without care, a write that fails with ENOSPC throws wherever it happens —
 * an event in a timer, a status update — the worker dies, the status it would
 * have written to say so fails too, and the run is left "running", then
 * "stale", with no word of why. So:
 *
 *   - a run directory holds a small reserve file, `.odw-reserve` (64 KB of
 *     zeros, written when the run is created): the room to say it;
 *   - the worker treats a write that fails with ENOSPC or EDQUOT as the run's
 *     end: it stops dispatching, kills its agents as for any fatal error,
 *     deletes the reserve and writes the run failed with
 *     `failureReason: "disk_full"` and a plain error;
 *   - should even that fail, the reason goes to the worker's stderr.
 *
 * Nothing is deleted to make room besides the run's own reserve: the error
 * points at `odw gc`.
 */

import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The run directory's reserve: deleted to make room for the run's last status write. */
export const RESERVE_FILE = ".odw-reserve";
const RESERVE_BYTES = 64 * 1024;

/** The `failureReason` a run that filled its disk fails with. */
export const DISK_FULL = "disk_full";

/** Write the run directory's reserve; best-effort — a disk already full fails the run's own files first. */
export function writeReserve(runDir: string): void {
  try {
    writeFileSync(join(runDir, RESERVE_FILE), Buffer.alloc(RESERVE_BYTES));
  } catch {
    /* no reserve: the last status write may then fail, and stderr says why */
  }
}

/** Give the reserve's room back: before the last status write of a full disk, and once a run ends. */
export function releaseReserve(runDir: string): void {
  try {
    rmSync(join(runDir, RESERVE_FILE), { force: true });
  } catch {
    /* nothing to release */
  }
}

/** Whether `err` — or what it wraps, as its `cause` — is a write that found the disk or the quota full. */
export function isDiskFullError(err: unknown): boolean {
  for (let e = err, depth = 0; e && typeof e === "object" && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOSPC" || code === "EDQUOT") return true;
  }
  return false;
}

/** What a run that filled its disk says: where, what failed, and what to do. */
export function diskFullMessage(runDir: string, err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code ?? "ENOSPC";
  const what = code === "EDQUOT" ? "the disk quota is exhausted" : "the disk is full";
  return (
    `${what} (${code}): the run could not write to ${runDir} and was stopped — ` +
    "free some space (`odw gc` lists old runs and orphaned worktrees it can remove), then `odw resume` it"
  );
}
