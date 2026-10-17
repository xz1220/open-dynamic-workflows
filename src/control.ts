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
 * The cross-process variant (driven by a control file the CLI writes) lives in
 * `runtime/file-control.ts` and implements the same tiny contract.
 */

import { RunStopped } from "./errors.js";

export const RUNNING = "running";
export const PAUSED = "paused";
export const STOPPED = "stopped";

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

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.wake();
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
