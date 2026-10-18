/**
 * Run control: the pause / resume / stop safe point.
 *
 * The scheduler calls `checkpoint()` right before dispatching each agent. That
 * single call site is where a run honours external control:
 *   - paused  -> `checkpoint` waits until resumed (or stopped),
 *   - stopped -> `checkpoint` throws {@link RunStopped}, unwinding the run.
 *
 * Agents already running cannot wait for the next dispatch: while any is in
 * flight the scheduler also `watchStop`s, and a stop aborts them at once.
 *
 * The same channel carries the answers to the `checkpoint()` primitive (an ODW
 * extension — not to be confused with the dispatch safe point above): a
 * person approves (perhaps with an edited payload) or rejects a checkpoint,
 * and `awaitDecision` hands the answer to the call waiting for it. A resume
 * also ends a run's pause for a spent quota (an ODW extension: quotaWait, see
 * ./quota-wait) at once: `watchResume` hears it.
 *
 * The cross-process variant (driven by a control file the CLI writes) lives in
 * `runtime/file-control.ts` and implements the same tiny contract.
 */

import { RunStopped } from "./errors.js";

export const RUNNING = "running";
export const PAUSED = "paused";
export const STOPPED = "stopped";

/**
 * Who answered a checkpoint(): `odw approve|reject`, the dashboard (`odw
 * serve`), or a signed approve link (ODW extension; see ./runtime/approve-links).
 */
export type CheckpointDecider = "cli" | "dashboard" | "link";

/** Who answered, as a log line says it: "the cli", "the dashboard", "an approve link". */
export function deciderText(by: CheckpointDecider | undefined): string {
  return by === "dashboard" ? "the dashboard" : by === "link" ? "an approve link" : "the cli";
}

/** A person's answer to a waiting checkpoint(). */
export interface CheckpointDecision {
  approved: boolean;
  note: string | null;
  by: CheckpointDecider;
  /**
   * The payload an approval was given with — the person's edit of the
   * checkpoint's own. Absent when they sent none, and always with a
   * rejection: edits are only accepted with approve.
   */
  payload?: unknown;
}

/**
 * A request to answer a checkpoint(), as the CLI and the server send it:
 * `{ action: "approve" | "reject", checkpointId?, note?, payload? }`. Without
 * a `checkpointId` it answers the oldest checkpoint waiting when the run reads
 * it. `payload` is an approval's edit of the checkpoint's payload — any JSON
 * value, `null` included; a rejection's is ignored. Writers stamp `by` and
 * `at` (epoch seconds), which also tell two otherwise equal requests apart.
 */
export interface CheckpointRequest {
  action: "approve" | "reject";
  checkpointId?: number;
  note?: string | null;
  payload?: unknown;
  by?: CheckpointDecider;
  at?: number;
}

/** Characters of a decision's note kept; the CLI and the server refuse longer ones. */
export const CHECKPOINT_NOTE_MAX = 4000;

/** Whether a value read from a run's decision log is a well-formed {@link CheckpointRequest}. */
export function isCheckpointRequest(value: unknown): value is CheckpointRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    (r.action === "approve" || r.action === "reject") &&
    (r.checkpointId === undefined || isCheckpointId(r.checkpointId)) &&
    (r.note === undefined || r.note === null || typeof r.note === "string") &&
    (r.by === undefined || r.by === "cli" || r.by === "dashboard" || r.by === "link")
  );
}

/** A checkpoint id is a positive integer (ids count from 1 in each run). */
export function isCheckpointId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * The answer a request carries; an empty note is no note, a long one is cut
 * (never mid-character). An approval's payload goes along as it came — the
 * checkpoint waiting for it checks it — and a rejection's is dropped.
 */
export function decisionOf(request: CheckpointRequest): CheckpointDecision {
  const note = typeof request.note === "string" && request.note.trim() !== "" ? request.note : null;
  const approved = request.action === "approve";
  return {
    approved,
    note:
      note !== null && note.length > CHECKPOINT_NOTE_MAX
        ? note.slice(0, CHECKPOINT_NOTE_MAX).replace(/[\uD800-\uDBFF]$/, "")
        : note,
    by: request.by === "dashboard" || request.by === "link" ? request.by : "cli",
    ...(approved && request.payload !== undefined ? { payload: request.payload } : {}),
  };
}

/** The minimal contract the scheduler depends on. */
export interface Control {
  /**
   * Wait while paused; throw {@link RunStopped} if a stop was requested. An
   * aborted `signal` (the run is ending anyway) ends the wait with its reason.
   */
  checkpoint(signal?: AbortSignal): void | Promise<void>;
  /** Current control state: `running` / `paused` / `stopped`. */
  state(): string;
  /**
   * Call `onStop` once a stop is requested; returns a function that stops
   * watching. Optional: without it, a stop takes effect at the next dispatch.
   */
  watchStop?(onStop: () => void): () => void;
  /**
   * Wait for a person's answer to checkpoint `checkpointId` (the checkpoint()
   * primitive). Rejects with the abort reason once `signal` aborts. Optional:
   * without it nobody can answer, and a checkpoint ends only by its timeout.
   * `accept`, when given, sees each answer first: one it refuses (false) is
   * dropped, and the checkpoint goes on waiting — saying why is up to it.
   */
  awaitDecision?(
    checkpointId: number,
    signal: AbortSignal,
    accept?: (decision: CheckpointDecision) => boolean,
  ): Promise<CheckpointDecision>;
  /**
   * Call `onResume` for every resume asked for from now on — `odw resume` on
   * a run paused for a spent quota (an ODW extension: quotaWait) — and return
   * a function that stops watching. Optional: without it, a quota pause ends
   * only when the quota resets (or the run ends).
   */
  watchResume?(onResume: () => void): () => void;
}

/** A control that never pauses or stops. The default for unmanaged runs. */
export class NullControl implements Control {
  checkpoint(): void {
    // never blocks
  }

  state(): string {
    return RUNNING;
  }
}

/** In-process control (used by tests and in-process runs). */
export class MemoryControl implements Control {
  private stopped = false;
  private paused = false;
  private waiters: Array<() => void> = [];
  private readonly stopListeners = new Set<() => void>();
  private readonly resumeListeners = new Set<() => void>();
  /** checkpoint id → the call waiting for its answer; false: the answer was refused. */
  private readonly asked = new Map<number, (decision: CheckpointDecision) => boolean>();

  pause(): void {
    this.paused = true;
  }

  /** Go on: a paused run dispatches again, and a pause for a spent quota ends now. */
  resume(): void {
    this.paused = false;
    this.wake();
    for (const onResume of [...this.resumeListeners]) onResume();
  }

  stop(): void {
    this.stopped = true;
    this.wake();
    for (const onStop of [...this.stopListeners]) onStop();
  }

  async checkpoint(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.stopped) throw new RunStopped("run was stopped");
    while (this.paused && !this.stopped) {
      await untilWokenOrAborted(this.waiters, signal);
      signal?.throwIfAborted();
    }
    if (this.stopped) throw new RunStopped("run was stopped");
  }

  state(): string {
    if (this.stopped) return STOPPED;
    return this.paused ? PAUSED : RUNNING;
  }

  watchStop(onStop: () => void): () => void {
    if (this.stopped) {
      onStop();
      return () => {};
    }
    this.stopListeners.add(onStop);
    return () => this.stopListeners.delete(onStop);
  }

  watchResume(onResume: () => void): () => void {
    this.resumeListeners.add(onResume);
    return () => this.resumeListeners.delete(onResume);
  }

  awaitDecision(
    checkpointId: number,
    signal: AbortSignal,
    accept?: (decision: CheckpointDecision) => boolean,
  ): Promise<CheckpointDecision> {
    return new Promise<CheckpointDecision>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const onAbort = (): void => {
        this.asked.delete(checkpointId);
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.asked.set(checkpointId, (decision) => {
        if (accept && !accept(decision)) return false;
        signal.removeEventListener("abort", onAbort);
        this.asked.delete(checkpointId);
        resolve(decision);
        return true;
      });
    });
  }

  /** The checkpoints waiting for an answer, oldest first. */
  waiting(): number[] {
    return [...this.asked.keys()].sort((a, b) => a - b);
  }

  /**
   * Answer a waiting checkpoint — the oldest, without an id. False when none
   * matched, or when the checkpoint refused the answer (an edit it does not take).
   */
  decide(request: CheckpointRequest): boolean {
    const id = request.checkpointId ?? this.waiting()[0];
    const answer = id === undefined ? undefined : this.asked.get(id);
    if (!answer) return false;
    return answer(decisionOf(request));
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}

/** Park on `waiters` until woken, or until `signal` aborts. */
function untilWokenOrAborted(waiters: Array<() => void>, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = (): void => {
      signal?.removeEventListener("abort", done);
      resolve();
    };
    waiters.push(done);
    signal?.addEventListener("abort", done, { once: true });
  });
}
