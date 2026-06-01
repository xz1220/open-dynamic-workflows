/**
 * Concurrency scheduler (L3) — STUB (M2).
 *
 * Unlike the Python reference (which needed OS threads because its agent calls
 * blocked), the Node runtime is async to the core: there are NO threads. This
 * layer is just two limits over Promises:
 *
 *   - **Concurrency cap** — at most N agent CLIs run at once, enforced by a
 *     small async semaphore (a queue that admits N runners and parks the rest).
 *   - **Total-agent backstop** — a hard ceiling on how many agents a single run
 *     may ever dispatch, so a buggy `while` loop cannot fan out forever.
 *
 * `gather` runs a batch of thunks concurrently under those limits; a recoverable
 * failure becomes a `null` slot, a fatal one (backstop hit / stop) aborts.
 * `parallel` and `pipeline` are both expressed in terms of it.
 */

import { notImplemented } from "./errors.js";

export interface SchedulerOptions {
  concurrency: number;
  maxAgents: number;
  /** The pause/stop safe point, run right before each dispatch. */
  checkpoint?: () => void | Promise<void>;
}

export class Scheduler {
  constructor(private readonly options: SchedulerOptions) {
    void this.options;
  }

  /** How many agents have been dispatched so far in this run. */
  get dispatched(): number {
    throw notImplemented("scheduler (M2)");
  }

  /** Run one agent unit under the concurrency cap and total backstop. */
  async runAgent<T>(_fn: () => Promise<T>): Promise<T> {
    throw notImplemented("scheduler (M2)");
  }

  /** Run thunks concurrently; results in input order, `null` for a recoverable failure. */
  async gather<T>(_thunks: Array<() => Promise<T>>): Promise<Array<T | null>> {
    throw notImplemented("scheduler (M2)");
  }
}
