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
 * The answers to `checkpoint()` calls (ODW extension) arrive next to it, in
 * the run's append-only decision log: requests
 * `{ action: "approve" | "reject", checkpointId?, note?, payload?, by, at }`
 * that the CLI and the server append — never rewriting the control file, so
 * an answer and a stop can never undo each other. While any checkpoint waits,
 * the log is read on the poll interval and each request is taken once: it
 * answers the checkpoint it names — or, without an id, the oldest one waiting
 * — if that checkpoint is still waiting; otherwise it is reported and
 * dropped, so an answer can never carry over to a later question. Requests
 * already in the log when a first checkpoint starts waiting predate it and
 * are skipped. An approval's edited `payload` goes to the checkpoint, which
 * may refuse it (one that does not match its schema): that answer is
 * dropped, and the checkpoint goes on waiting.
 *
 * While the run waits for a spent quota to reset (an ODW extension:
 * quotaWait), the control file is also watched for a new resume, which ends
 * that wait at once.
 */

import { createHash } from "node:crypto";

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
  /**
   * The control file's request whole — its action and when it was written —
   * so {@link FileControl.watchResume} tells a new `odw resume` from an old one.
   * Without it, only a change of action to "resume" counts.
   */
  readRequest?: () => { action: string | null; at: number | null } | null;
  /** The checkpoint answers in the decision log, oldest first (malformed ones left out). */
  readDecisions?: () => CheckpointRequest[];
  /** A request that answered nothing: its checkpoint was not (or no longer) waiting. */
  onUnmatchedDecision?: (request: CheckpointRequest) => void;
  onState?: (state: string) => void;
  /** How often a paused checkpoint re-reads the control file — and a checkpoint() waiting for an answer, the decision log. */
  pollIntervalMs?: number;
  /** How often {@link FileControl.watchStop} re-reads it while agents run. */
  watchIntervalMs?: number;
}

/**
 * A short stand-in for a request's payload in the set of taken requests: two
 * requests may differ only by it, and a payload can be large.
 */
function digest(payload: unknown): string | null {
  if (payload === undefined) return null;
  try {
    return createHash("sha256").update(JSON.stringify(payload) ?? "").digest("base64");
  } catch {
    return "?"; // not JSON (an in-process request): the checkpoint refuses it anyway
  }
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
  /** checkpoint id → the call waiting for its answer; false: the answer was refused. */
  private readonly asked = new Map<number, (decision: CheckpointDecision) => boolean>();
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
   * Call `onResume` for each resume written to the control file from now on —
   * `odw resume` on a run paused for a spent quota (an ODW extension) — while
   * watched. A request already there when watching starts was answered
   * before. Unref'd like the stop watch: the pause's own wait keeps the
   * worker alive.
   */
  watchResume(onResume: () => void): () => void {
    let seen = "";
    const read = (): { key: string; resume: boolean } => {
      try {
        const request = this.options.readRequest?.();
        const action = request ? request.action : this.options.readAction();
        return { key: request ? `${request.action}@${request.at}` : String(action), resume: action === "resume" };
      } catch {
        return { key: seen, resume: false }; // unreadable for a moment: the next poll tries again
      }
    };
    seen = read().key;
    const timer = setInterval(() => {
      const now = read();
      if (now.key === seen) return;
      seen = now.key;
      if (now.resume) onResume();
    }, this.watchInterval);
    timer.unref();
    return () => clearInterval(timer);
  }

  /**
   * Wait for the answer to checkpoint `checkpointId`, read from the control
   * file; `accept` may refuse one (see {@link Control.awaitDecision}). The
   * poll timer is NOT unref'd: a waiting checkpoint may be all a worker has
   * left to do, and it must stay alive to hear the answer.
   */
  awaitDecision(
    checkpointId: number,
    signal: AbortSignal,
    accept?: (decision: CheckpointDecision) => boolean,
  ): Promise<CheckpointDecision> {
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
        if (accept && !accept(decision)) return false;
        signal.removeEventListener("abort", onAbort);
        this.forget(checkpointId);
        resolve(decision);
        return true;
      });
      this.decisionTimer ??= setInterval(() => this.take(), this.poll);
    });
  }

  /**
   * Take every request not taken yet, oldest first, and answer the checkpoint
   * each one is for. `unmatched` (by default the option) hears the requests
   * that answered nothing. A request the checkpoint refused is taken all the
   * same: it never answers anything later.
   */
  private take(unmatched = this.options.onUnmatchedDecision): void {
    let requests: CheckpointRequest[];
    try {
      requests = this.options.readDecisions?.() ?? [];
    } catch {
      return; // unreadable for a moment: the next poll tries again
    }
    for (const request of requests) {
      const key = JSON.stringify([request.action, request.checkpointId, request.note, request.by, request.at, digest(request.payload)]);
      if (this.taken.has(key)) continue;
      this.taken.add(key);
      const id = request.checkpointId ?? Math.min(...this.asked.keys());
      const answer = this.asked.get(id);
      if (!answer) {
        unmatched?.(request);
        continue;
      }
      try {
        answer(decisionOf(request));
      } catch {
        // A checkpoint that cannot weigh an answer refuses it: never a crash on a poll.
      }
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
