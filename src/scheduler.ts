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
 * The scheduler also owns the run's abort signal. The first fatal error (stop,
 * budget, backstop, configuration) is recorded as the run's outcome and aborts
 * it: running agents are killed, queued ones are released, and every later
 * dispatch fails with the same error — a stopped or doomed run must not keep
 * agents working until their timeouts.
 *
 * `gather` runs a batch concurrently: a recoverable failure becomes a `null`
 * slot; a fatal error is re-thrown to abort the surrounding workflow once the
 * batch has settled (the abort makes its running agents settle promptly).
 * `parallel` and `pipeline` both build on it.
 */

import { setMaxListeners } from "node:events";

import { AgentLimitExceeded, ConfigError, RunStopped, isFatalError } from "./errors.js";

export interface SchedulerOptions {
  concurrency: number;
  maxAgents: number;
  /**
   * The pause/stop safe point, run right before each dispatch. It receives the
   * run's abort signal, so a paused wait ends when the run is aborted.
   */
  checkpoint?: (signal: AbortSignal) => void | Promise<void>;
  /**
   * The budget ceiling, run right before the runaway backstop on each dispatch.
   * Throw a fatal error (e.g. {@link BudgetExhausted}) to abort the run when the
   * token budget is spent. The default is a no-op for callers without a budget.
   */
  budgetGuard?: () => void;
  /**
   * Watch for a stop request while agents run: call `onStop` when one arrives
   * and return a function that stops watching. It is started when the first
   * agent starts and stopped when the last one settles, so an idle run does
   * not poll. Without it, a stop takes effect at the next dispatch only.
   */
  watchStop?: (onStop: () => void) => () => void;
}

export class Scheduler {
  private readonly concurrency: number;
  private readonly maxAgents: number;
  private readonly checkpoint: (signal: AbortSignal) => void | Promise<void>;
  private readonly budgetGuard: () => void;
  private readonly watchStop: ((onStop: () => void) => () => void) | undefined;
  private readonly controller = new AbortController();
  private fatal: { error: unknown } | undefined;
  private dispatchedCount = 0;
  private active = 0;
  private readonly waiters: Array<{ resolve: () => void; reject: (reason: unknown) => void }> = [];
  /** runAgent calls not yet settled: queued, paused at the checkpoint, or running. */
  private pending = 0;
  /** Agents whose work is in flight. */
  private running = 0;
  private stopWatching: (() => void) | undefined;
  private idleWaiters: Array<() => void> = [];

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
    this.watchStop = options.watchStop;
    // Every running agent listens on the signal; a high concurrency cap must
    // not trip Node's listener-leak warning.
    setMaxListeners(0, this.controller.signal);
  }

  /** How many agents have been dispatched so far in this run. */
  get dispatched(): number {
    return this.dispatchedCount;
  }

  /** Aborted, with the run's fatal error as its reason, once the run must end. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /**
   * The first fatal error of the run (stop, budget, backstop, configuration),
   * or `undefined`. It decides the run's outcome even when the workflow script
   * catches it and carries on.
   */
  get fatalError(): unknown {
    return this.fatal?.error;
  }

  /**
   * End the run: record `reason` (the first one wins), abort every running
   * agent, and fail every queued and later dispatch with it. Idempotent.
   */
  abort(reason: unknown): void {
    if (this.fatal) return;
    this.fatal = { error: reason };
    this.controller.abort(reason);
    for (const waiter of this.waiters.splice(0)) waiter.reject(reason);
  }

  /**
   * Run one agent unit under the concurrency cap and total backstop. `fn`
   * receives the run's abort signal and must stop its agent when it fires.
   */
  async runAgent<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.pending++;
    try {
      this.throwIfAborted();
      await this.acquire();
      try {
        // Control and usage can change while this request waits for a slot.
        // Check at the actual dispatch boundary; a paused request holds its slot
        // until resumed or stopped, without starting the agent.
        await this.checkpoint(this.signal);
        this.throwIfAborted();
        this.budgetGuard();
        // Count actual dispatches, not queued requests. There is no await between
        // checking the cap, incrementing it, and starting the agent.
        if (this.dispatchedCount >= this.maxAgents) {
          throw new AgentLimitExceeded(`run reached its cap of ${this.maxAgents} agent dispatches`);
        }
        this.dispatchedCount++;
        return await this.track(fn);
      } finally {
        // Guard failures must also hand the slot to the next queued request.
        this.release();
      }
    } catch (err) {
      // One fatal error ends the run: stop the other agents now instead of
      // letting them run on to their timeouts.
      if (isFatalError(err)) this.abort(err);
      throw err;
    } finally {
      if (--this.pending === 0) this.notifyIdle();
    }
  }

  /**
   * Re-run the dispatch guards (pause/stop, budget) before an extra CLI
   * attempt inside an agent that already holds its slot — a schema retry. A
   * retry is not a new dispatch, so it does not count toward the backstop; a
   * guard failure is fatal and ends the run, exactly as at dispatch.
   */
  async recheck(): Promise<void> {
    try {
      this.throwIfAborted();
      await this.checkpoint(this.signal);
      this.throwIfAborted();
      this.budgetGuard();
    } catch (err) {
      if (isFatalError(err)) this.abort(err);
      throw err;
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

  /**
   * Resolve `true` once no agent is queued, paused, or running — or `false`
   * when `timeoutMs` runs out first. The worker waits on this before recording
   * an outcome, so agents a script never awaited still finish (or die) and
   * clean up their worktrees.
   */
  drain(timeoutMs?: number): Promise<boolean> {
    if (this.pending === 0) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const idle = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      this.idleWaiters.push(idle);
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          this.idleWaiters = this.idleWaiters.filter((waiter) => waiter !== idle);
          resolve(false);
        }, timeoutMs);
      }
    });
  }

  // --- internals ---------------------------------------------------------------

  private throwIfAborted(): void {
    if (this.fatal) throw this.fatal.error;
  }

  /** Run an agent's work, watching for a stop while any agent is in flight. */
  private async track<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.running++ === 0 && this.watchStop) {
      this.stopWatching = this.watchStop(() => this.abort(new RunStopped("run was stopped")));
    }
    try {
      return await fn(this.signal);
    } finally {
      if (--this.running === 0) {
        this.stopWatching?.();
        this.stopWatching = undefined;
      }
    }
  }

  private notifyIdle(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const idle of waiters) idle();
  }

  private async acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active++;
      return;
    }
    // Park until a slot is handed to us (ownership transfers without a
    // re-count), or until the run is aborted.
    await new Promise<void>((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next.resolve(); // hand our slot directly to the next waiter; `active` is unchanged
    } else {
      this.active--;
    }
  }
}
