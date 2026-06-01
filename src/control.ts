/**
 * Run control: the pause / resume / stop safe point.
 *
 * The scheduler calls `checkpoint()` right before dispatching each agent. That
 * single call site is where a run honours external control:
 *   - paused  -> `checkpoint` waits until resumed (or stopped),
 *   - stopped -> `checkpoint` throws {@link RunStopped}, unwinding the run.
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
  /** Wait while paused; throw {@link RunStopped} if a stop was requested. */
  checkpoint(): void | Promise<void>;
  /** Current control state: `running` / `paused` / `stopped`. */
  state(): string;
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
  }

  async checkpoint(): Promise<void> {
    if (this.stopped) throw new RunStopped("run was stopped");
    while (this.paused && !this.stopped) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    if (this.stopped) throw new RunStopped("run was stopped");
  }

  state(): string {
    if (this.stopped) return STOPPED;
    return this.paused ? PAUSED : RUNNING;
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}
