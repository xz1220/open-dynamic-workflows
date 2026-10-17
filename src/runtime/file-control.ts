/**
 * Cross-process run control backed by the run directory.
 *
 * Same contract as the in-process controls in `control.ts`, but the pause/stop
 * signal arrives through a file the CLI writes. The worker polls that file at
 * each safe point, and — while agents run — on an interval, so a stop reaches
 * them without waiting for the next dispatch. Decoupled from the
 * {@link RunStore} through callbacks so it has no knowledge of the directory
 * layout.
 *
 * The same file carries the answers to `checkpoint()` calls (ODW extension):
 * next to the run-level `action`, a list of requests
 * `{ action: "approve" | "reject", checkpointId?, note?, by, at }` that the
 * CLI and the server append to. While any checkpoint waits, the file is read
 * on the poll interval and each request is taken once: it answers the
 * checkpoint it names — or, without an id, the oldest one waiting — if that
 * checkpoint is still waiting; otherwise it is reported and dropped, so an
 * answer can never carry over to a later question. Requests already in the
 * file when a first checkpoint starts waiting predate it and are skipped.
 */

import {
  PAUSED,
  RUNNING,
  STOPPED,
  decisionOf,
  type CheckpointDecision,
  type CheckpointRequest,
  type Control,
} from "../control.js";
import { RunStopped } from "../errors.js";

export interface FileControlOptions {
  readAction: () => string | null;
  /** The checkpoint answers in the control file, oldest first (malformed ones left out). */
  readDecisions?: () => CheckpointRequest[];
  /** A request that answered nothing: its checkpoint was not (or no longer) waiting. */
  onUnmatchedDecision?: (request: CheckpointRequest) => void;
  onState?: (state: string) => void;
  /** How often a paused checkpoint — or a checkpoint() waiting for an answer — re-reads the control file. */
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
  /** checkpoint id → the call waiting for its answer. */
  private readonly asked = new Map<number, (decision: CheckpointDecision) => void>();
  /** The requests already taken (or skipped), by content. */
  private readonly taken = new Set<string>();
  private decisionTimer: NodeJS.Timeout | undefined;

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

  /**
   * Wait for the answer to checkpoint `checkpointId`, read from the control
   * file. The poll timer is NOT unref'd: a waiting checkpoint may be all a
   * worker has left to do, and it must stay alive to hear the answer.
   */
  awaitDecision(checkpointId: number, signal: AbortSignal): Promise<CheckpointDecision> {
    return new Promise<CheckpointDecision>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      // The first question in a while: whatever the file already holds was
      // meant for earlier ones (or none) and must not answer this one.
      if (this.asked.size === 0) this.take(() => {});
      const onAbort = (): void => {
        this.forget(checkpointId);
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.asked.set(checkpointId, (decision) => {
        signal.removeEventListener("abort", onAbort);
        this.forget(checkpointId);
        resolve(decision);
      });
      this.decisionTimer ??= setInterval(() => this.take(), this.poll);
    });
  }

  /**
   * Take every request not taken yet, oldest first, and answer the checkpoint
   * each one is for. `unmatched` (by default the option) hears the requests
   * that answered nothing.
   */
  private take(unmatched = this.options.onUnmatchedDecision): void {
    let requests: CheckpointRequest[];
    try {
      requests = this.options.readDecisions?.() ?? [];
    } catch {
      return; // unreadable for a moment: the next poll tries again
    }
    for (const request of requests) {
      const key = JSON.stringify([request.action, request.checkpointId, request.note, request.by, request.at]);
      if (this.taken.has(key)) continue;
      this.taken.add(key);
      const id = request.checkpointId ?? Math.min(...this.asked.keys());
      const answer = this.asked.get(id);
      if (answer) answer(decisionOf(request));
      else unmatched?.(request);
    }
  }

  private forget(checkpointId: number): void {
    this.asked.delete(checkpointId);
    if (this.asked.size > 0) return;
    clearInterval(this.decisionTimer);
    this.decisionTimer = undefined;
  }

  private report(state: string): void {
    if (state === this.reported) return;
    this.reported = state;
    this.options.onState?.(state);
  }
}
