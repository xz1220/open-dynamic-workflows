/**
 * Cross-process run control backed by the run directory.
 *
 * Same contract as the in-process controls in `control.ts`, but the pause/stop
 * signal arrives through a file the CLI writes. The worker polls that file at
 * each safe point, and — while agents run — on an interval, so a stop reaches
 * them without waiting for the next dispatch. Decoupled from the
 * {@link RunStore} through callbacks so it has no knowledge of the directory
 * layout.
 */

import { PAUSED, RUNNING, STOPPED, type Control } from "../control.js";
import { RunStopped } from "../errors.js";

export interface FileControlOptions {
  readAction: () => string | null;
  onState?: (state: string) => void;
  /** How often a paused checkpoint re-reads the control file. */
  pollIntervalMs?: number;
  /** How often {@link FileControl.watchStop} re-reads it while agents run. */
  watchIntervalMs?: number;
}

/** Wait `ms`, or less if `signal` aborts first. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

export class FileControl implements Control {
  private readonly poll: number;
  private readonly watchInterval: number;
  private reported = RUNNING;

  constructor(private readonly options: FileControlOptions) {
    this.poll = options.pollIntervalMs ?? 200;
    this.watchInterval = options.watchIntervalMs ?? 500;
  }

  async checkpoint(signal?: AbortSignal): Promise<void> {
    for (;;) {
      signal?.throwIfAborted();
      const action = this.options.readAction();
      if (action === "stop") {
        this.report(STOPPED);
        throw new RunStopped("run was stopped");
      }
      if (action === "pause") {
        this.report(PAUSED);
        await delay(this.poll, signal);
        continue;
      }
      this.report(RUNNING);
      return;
    }
  }

  state(): string {
    const action = this.options.readAction();
    if (action === "stop") return STOPPED;
    if (action === "pause") return PAUSED;
    return RUNNING;
  }

  /**
   * Poll for a stop while agents run: the dispatch checkpoint alone would let
   * a running agent continue until its timeout. The timer is unref'd, so it
   * never keeps a finished worker alive.
   */
  watchStop(onStop: () => void): () => void {
    const timer = setInterval(() => {
      if (this.options.readAction() !== "stop") return;
      clearInterval(timer);
      onStop();
    }, this.watchInterval);
    timer.unref();
    return () => clearInterval(timer);
  }

  private report(state: string): void {
    if (state === this.reported) return;
    this.reported = state;
    this.options.onState?.(state);
  }
}
