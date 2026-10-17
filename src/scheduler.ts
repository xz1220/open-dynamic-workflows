/**
 * Concurrency scheduler (L3): bounded async fan-out with a runaway guard.
 *
 * Unlike a thread pool, this is pure async: `agent()` is a non-blocking
 * subprocess call, so concurrency is bounded by a small semaphore over Promises,
 * not by OS threads. Two limits are enforced here and only here:
 *
 *   - **Concurrency cap** — at most N agent CLIs run at once. A free slot is
 *     handed *directly* to the next waiter on release, so the cap can never be
 *     over-subscribed by a racing acquire.
 *   - **Total-agent backstop** — a hard ceiling on total dispatches per run, so
 *     a buggy loop cannot fan out forever.
 *
 * `gather` runs a batch concurrently: a recoverable failure becomes a `null`
 * slot; a fatal error (backstop hit / stop requested) is re-thrown to abort the
 * surrounding workflow. `parallel` and `pipeline` both build on it.
 */

import { AgentLimitExceeded, ConfigError, isFatalError } from "./errors.js";

export interface SchedulerOptions {
  concurrency: number;
  maxAgents: number;
  /** The pause/stop safe point, run right before each dispatch. */
  checkpoint?: () => void | Promise<void>;
  /**
   * The budget ceiling, run right before the runaway backstop on each dispatch.
   * Throw a fatal error (e.g. {@link BudgetExhausted}) to abort the run when the
   * token budget is spent. The default is a no-op for callers without a budget.
   */
  budgetGuard?: () => void;
}

export class Scheduler {
  private readonly concurrency: number;
  private readonly maxAgents: number;
  private readonly checkpoint: () => void | Promise<void>;
  private readonly budgetGuard: () => void;
  private dispatchedCount = 0;
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(options: SchedulerOptions) {
    // NaN slips through Math.max and every comparison: a NaN cap would park
    // every acquire() forever, a NaN backstop would never fire. Fail loudly.
    if (Number.isNaN(options.concurrency) || Number.isNaN(options.maxAgents)) {
      throw new ConfigError(
        `scheduler limits must be numbers (concurrency=${options.concurrency}, maxAgents=${options.maxAgents})`,
      );
    }
    this.concurrency = Math.max(1, options.concurrency);
    this.maxAgents = options.maxAgents;
    this.checkpoint = options.checkpoint ?? (() => {});
    this.budgetGuard = options.budgetGuard ?? (() => {});
  }

  /** How many agents have been dispatched so far in this run. */
  get dispatched(): number {
    return this.dispatchedCount;
  }

  /** Run one agent unit under the concurrency cap and total backstop. */
  async runAgent<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      // Control and usage can change while this request waits for a slot.
      // Check at the actual dispatch boundary; a paused request holds its slot
      // until resumed or stopped, without starting the agent.
      await this.checkpoint();
      this.budgetGuard();
      // Count actual dispatches, not queued requests. There is no await between
      // checking the cap, incrementing it, and starting the agent.
      if (this.dispatchedCount >= this.maxAgents) {
        throw new AgentLimitExceeded(`run reached its cap of ${this.maxAgents} agent dispatches`);
      }
      this.dispatchedCount++;
      return await fn();
    } finally {
      // Guard failures must also hand the slot to the next queued request.
      this.release();
    }
  }

  /** Run thunks concurrently; results in input order, `null` for a recoverable failure. */
  async gather<T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>> {
    const settled = await Promise.allSettled(thunks.map((t) => t()));
    let fatal: unknown;
    const out: Array<T | null> = settled.map((r) => {
      if (r.status === "fulfilled") return r.value;
      if (isFatalError(r.reason) && fatal === undefined) fatal = r.reason;
      return null;
    });
    if (fatal !== undefined) throw fatal;
    return out;
  }

  // --- internal semaphore ----------------------------------------------------

  private async acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active++;
      return;
    }
    // Park until a slot is handed to us; ownership transfers without a re-count.
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next(); // hand our slot directly to the next waiter; `active` is unchanged
    } else {
      this.active--;
    }
  }
}
