/** Shared, read-only completion/liveness checks for wait, logs, and attach. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkflowEvent } from "../events.js";
import { RunStore, TERMINAL_STATES, type EventsCursor } from "./run-store.js";
import { isProcessAlive } from "./runs-view.js";

export interface RunObservation {
  status: Record<string, unknown>;
  events: WorkflowEvent[];
  terminal: boolean;
  /** An observer failure; never written back over the worker's status. */
  error?: string;
  note?: string;
}

export class RunObserver {
  private cursor: EventsCursor = { offset: 0 };
  private terminalEvent: { at: number; state: string; error?: string } | null = null;
  private emptyStatusSince: number | null = null;
  private readonly startedAt: number;

  constructor(
    private readonly store: RunStore,
    private readonly runId: string,
    private readonly now: () => number = Date.now,
    private readonly isAlive = isProcessAlive,
  ) {
    this.startedAt = now();
  }

  read(): RunObservation {
    const events: WorkflowEvent[] = [];
    const drain = () => {
      const read = this.store.readEventsSince(this.runId, this.cursor);
      this.cursor = read.cursor;
      events.push(...read.events);
      for (const ev of read.events) {
        const state = ev.type === "run_finished" ? "done"
          : ev.type === "run_failed" ? "failed" : ev.type === "run_stopped" ? "stopped" : null;
        if (state) {
          this.terminalEvent = {
            at: this.now(), state,
            error: typeof ev.error === "string" ? ev.error : undefined,
          };
        }
      }
    };
    drain();
    let status = this.store.readStatus(this.runId);
    let state = String(status.state ?? "");
    const pid = this.workerPid(status);
    const dead = pid !== null && this.isAlive(pid) === false;
    // The worker can finish between the event read and the process probe.
    // Once it is gone, reread its final writes before declaring a crash.
    if (dead || TERMINAL_STATES.has(state)) {
      drain();
      status = this.store.readStatus(this.runId);
      state = String(status.state ?? "");
    }
    if (TERMINAL_STATES.has(state)) return { status, events, terminal: true };
    if (this.terminalEvent) {
      if (dead || this.now() - this.terminalEvent.at >= 2000) {
        const ended = this.terminalEvent;
        return {
          status: { ...status, state: ended.state, error: ended.error }, events, terminal: true,
          note: `run ended (${ended.state}) but its status never settled`,
        };
      }
      // The event precedes status/error writes. Give those writes time to land.
      return { status, events, terminal: false };
    }

    let error: string | undefined;
    if (!this.store.exists(this.runId)) {
      error = `run ${this.runId} is unreadable (directory removed?)`;
    } else if (dead) {
      error = state === "pending"
        ? `worker process (pid ${pid}) exited before the run started; see ${this.store.logPath(this.runId)}`
        : `worker process (pid ${pid}) is gone; the run will not progress (see ${this.store.logPath(this.runId)})`;
    } else if (state === "") {
      this.emptyStatusSince ??= this.now();
      if (this.now() - this.emptyStatusSince >= 5000) {
        error = `run ${this.runId} is unreadable (status unavailable)`;
      }
    } else {
      this.emptyStatusSince = null;
      // Older launchers did not record a pid until the worker started. Allow
      // startup time, but never expire a pending worker known to be alive.
      if (pid === null && this.now() - this.startedAt >= (state === "pending" ? 10_000 : 5000)) {
        error = state === "pending"
          ? `run never started (still pending) — no worker pid was recorded; see ${this.store.logPath(this.runId)}`
          : `run reports "${state}" but never recorded a worker pid — treating as stale`;
      }
    }
    return { status, events, terminal: false, error };
  }

  private workerPid(status: Record<string, unknown>): number | null {
    return workerPid(this.store, this.runId, status);
  }
}

/**
 * Whether a run may still be executing: it is not in a terminal state and its
 * worker is alive — or not known yet (a pending run whose worker has recorded
 * no pid). A run whose worker is provably gone is not active: it is stale.
 */
export function isRunActive(store: RunStore, runId: string, isAlive = isProcessAlive): boolean {
  const status = store.readStatus(runId);
  const state = String(status.state ?? "");
  if (TERMINAL_STATES.has(state)) return false;
  const pid = workerPid(store, runId, status);
  if (pid === null) return state === "pending" || state === "";
  return isAlive(pid) !== false;
}

/** The run's worker pid: status.pid, else the launcher's worker.pid file. */
function workerPid(store: RunStore, runId: string, status: Record<string, unknown>): number | null {
  let pid = status.pid;
  if (!validPid(pid)) {
    try {
      pid = Number(readFileSync(join(store.runDir(runId), "worker.pid"), "utf8"));
    } catch {
      return null;
    }
  }
  return validPid(pid) ? pid : null;
}

function validPid(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0;
}
