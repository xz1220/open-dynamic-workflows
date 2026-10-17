/**
 * Concurrency scheduler (L3): bounded async fan-out with a runaway guard.
 *
 * Unlike a thread pool, this is pure async: `agent()` is a non-blocking
 * subprocess call, so concurrency is bounded by a small semaphore over Promises,
 * not by OS threads. Two limits are enforced here and only here:
 *
 *   - **Concurrency cap** — at most N agent CLIs run at once. A free slot is
 *     handed to the next waiter in the same step that frees it, so the cap can
 *     never be over-subscribed by a racing acquire.
 *   - **Total-agent backstop** — a hard ceiling on total dispatches per run, so
 *     a buggy loop cannot fan out forever.
 *
 * Inside the run-wide cap, an adapter may have a cap of its own (an ODW
 * extension): an agent then needs a run slot and a slot on its adapter, both
 * handed out together — it never holds one while it waits for the other. The
 * queue is first come, first served per adapter, and a run slot goes to the
 * oldest request whose adapter has room, so one throttled adapter never holds
 * up the others. With adaptive back-pressure, a rate limit (which a running
 * agent reports through its {@link AgentSlot}) halves its adapter's cap, and
 * each minute without another gives one slot back. An agent that falls back
 * to another adapter (an ODW extension) moves its slots there the same way:
 * it lets go of both, then waits for the pair on the new adapter. One that
 * waits for its adapter's spent quota to reset (an ODW extension: quotaWait)
 * lets go of both while it waits, and takes a pair again to go on.
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
 *
 * Command steps (`exec()`) are not agents: they bypass both limits, but share
 * the checkpoint, the abort signal, the stop watch and the drain (see
 * {@link Scheduler.runCommand}). A person's answer to a `checkpoint()` call is
 * waited for outside the dispatch gate too (see {@link Scheduler.runWait}).
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
  /**
   * Per-adapter caps (an ODW extension): adapter name → at most this many of
   * its agents at once, inside `concurrency`. An adapter not listed is held
   * to the run-wide cap alone.
   */
  adapterConcurrency?: Record<string, number>;
  /**
   * Adaptive back-pressure (an ODW extension): a rate limit an agent reports
   * through its {@link AgentSlot} halves its adapter's cap for the rest of the
   * run (never below 1), and every {@link RESTORE_MS} without another gives
   * one slot back. Off unless set.
   */
  adaptive?: boolean;
  /** Told whenever adaptive back-pressure changes an adapter's cap, so the run can say so. */
  onAdapterCap?: (change: AdapterCapChange) => void;
  /** The clock adaptive back-pressure measures its quiet minutes on, in ms; defaults to Date.now. */
  now?: () => number;
}

/** How long an adapter must go without a rate limit to get one slot of its cap back, in ms. */
export const RESTORE_MS = 60_000;

/**
 * What a running agent holds: a run slot and, when its adapter is throttled,
 * a slot on its adapter. Handed to the agent's work by {@link Scheduler.runAgent}.
 */
export interface AgentSlot {
  /**
   * Report that this agent's CLI hit a rate limit: with adaptive
   * back-pressure, its adapter's cap is halved — once per wave: the agents
   * dispatched before the latest cut report the limit that caused it — and
   * its quiet minute starts over.
   */
  rateLimited(): void;
  /**
   * Move this agent to another adapter (a fallback, an ODW extension): its
   * slot on the old adapter, and its run slot, are let go first; then it
   * waits — ahead of every agent that has not started — for a run slot and a
   * slot on the new adapter, handed out together as at dispatch. It never
   * holds two adapters' slots. Rejects with the run's reason when the run
   * ends meanwhile. Not a dispatch: the backstop does not count it. After
   * {@link release}, it takes a pair again — on `adapter` — the same way.
   */
  moveTo(adapter: string): Promise<void>;
  /**
   * Let go of both slots while the agent waits for something that is not
   * work — its adapter's spent quota to reset (an ODW extension: quotaWait) —
   * so other agents may have them; {@link moveTo} takes a pair back. The
   * agent is still the run's pending work, and a stop still reaches it.
   */
  release(): void;
}

/** An adapter's cap changed under adaptive back-pressure (an ODW extension). */
export interface AdapterCapChange {
  adapter: string;
  /** The cap now in force, and the one before. */
  limit: number;
  previous: number;
  /** Its full cap: where giving slots back stops. */
  max: number;
  /** A rate limit cut it, or a quiet minute gave a slot back. */
  reason: "rate_limit" | "restored";
  /** How long ago its last rate limit was, in ms. */
  quietMs: number;
}

/** One adapter's share of the run: its cap, and its agents holding a slot. */
interface Lane {
  readonly adapter: string;
  /** Its configured cap, at most the run-wide one. */
  readonly max: number;
  /** The cap in force: `max`, or less while adaptive back-pressure holds it down. */
  limit: number;
  /** Its agents holding a slot. */
  active: number;
  /** Bumped by every cut; an agent remembers the wave it was dispatched in. */
  wave: number;
  /** When its quiet minute started: its latest rate limit, or the latest slot given back. */
  since: number;
  /** When it last hit a rate limit. */
  limitedAt: number;
}

/** A request waiting for its slots, in arrival order. */
interface Waiter {
  lane: Lane | undefined;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

/** What a running agent holds: a run slot and its lane's slot, the lane it is in now, and the wave it entered that lane in. */
interface Held {
  lane: Lane | undefined;
  /** It holds its slots: false while a move waits for the new ones. */
  slotted: boolean;
  wave: number;
}

export class Scheduler {
  private readonly concurrency: number;
  private readonly maxAgents: number;
  private readonly checkpoint: (signal: AbortSignal) => void | Promise<void>;
  private readonly budgetGuard: () => void;
  private readonly watchStop: ((onStop: () => void) => () => void) | undefined;
  private readonly adapterConcurrency: Record<string, number>;
  private readonly adaptive: boolean;
  private readonly onAdapterCap: ((change: AdapterCapChange) => void) | undefined;
  private readonly now: () => number;
  private readonly controller = new AbortController();
  private fatal: { error: unknown } | undefined;
  private dispatchedCount = 0;
  private active = 0;
  private readonly waiters: Waiter[] = [];
  /** Per-adapter lanes, made as each adapter is first used: throttled adapters, or all with adaptive back-pressure. */
  private readonly lanes = new Map<string, Lane>();
  /** Wakes the queue when a held-down adapter is due a slot back. */
  private restoreTimer: NodeJS.Timeout | undefined;
  /** runAgent/runCommand/runWait calls not yet settled: queued, paused at the checkpoint, running, or waiting. */
  private pending = 0;
  /** Agents and commands whose work is in flight, requests held at their gate, and checkpoint() waits: the stop watch is armed while any is. */
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
    for (const [adapter, cap] of Object.entries(options.adapterConcurrency ?? {})) {
      if (Number.isNaN(cap)) throw new ConfigError(`scheduler limits must be numbers (adapter '${adapter}' concurrency=${cap})`);
    }
    this.concurrency = Math.max(1, options.concurrency);
    this.maxAgents = options.maxAgents;
    this.checkpoint = options.checkpoint ?? (() => {});
    this.budgetGuard = options.budgetGuard ?? (() => {});
    this.watchStop = options.watchStop;
    this.adapterConcurrency = { ...options.adapterConcurrency };
    this.adaptive = options.adaptive ?? false;
    this.onAdapterCap = options.onAdapterCap;
    this.now = options.now ?? Date.now;
    // Every running agent listens on the signal; a high concurrency cap must
    // not trip Node's listener-leak warning.
    setMaxListeners(0, this.controller.signal);
  }

  /** How many agents have been dispatched so far in this run. */
  get dispatched(): number {
    return this.dispatchedCount;
  }

  /**
   * How many of an adapter's agents may run at once now (an ODW extension):
   * its cap, as adaptive back-pressure has lowered it; undefined when only
   * the run-wide cap holds it.
   */
  adapterLimit(adapter: string): number | undefined {
    const lane = this.laneFor(adapter);
    if (lane) this.pump(); // a slot due back is given — to a waiting agent too
    return lane?.limit;
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
    clearTimeout(this.restoreTimer);
  }

  /**
   * Run one agent unit under the concurrency cap and total backstop — and,
   * when `adapter` names it, under that adapter's cap too (an ODW extension).
   * `fn` receives the run's abort signal, and must stop its agent when it
   * fires, and the agent's {@link AgentSlot}. A `gate` holds the request
   * back before it asks for any slot — a staggered fan-out's later agents
   * wait there (see ./throttle), and so does a call waiting for a spent quota
   * to reset (quotaWait) — yet it is pending work all along: the run's drain
   * waits for it, the stop watch is armed while it waits, and an abort ends it.
   */
  async runAgent<T>(
    fn: (signal: AbortSignal, slot: AgentSlot) => Promise<T>,
    options: { adapter?: string; gate?: (signal: AbortSignal) => Promise<void> } = {},
  ): Promise<T> {
    this.pending++;
    try {
      this.throwIfAborted();
      if (options.gate) {
        // A stop must reach a request held here: it may be all the run has left (a quota wait).
        await this.track(options.gate);
        this.throwIfAborted();
      }
      const lane = options.adapter !== undefined ? this.laneFor(options.adapter) : undefined;
      await this.acquire(lane);
      // A fallback may move the agent to another lane (see AgentSlot.moveTo).
      const held: Held = { lane, slotted: true, wave: 0 };
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
        const slot = this.slotIn(held);
        return await this.track((signal) => fn(signal, slot));
      } finally {
        // Guard failures must also hand the slot to the next queued request.
        // (A move the run's end cut short left the agent holding none.)
        if (held.slotted) this.release(held.lane);
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
   * Run one command step (`exec()`) outside the agent limits: it takes no
   * concurrency slot, never counts toward the backstop, and skips the budget
   * guard (a command spends no tokens). It still stops at the pause/stop
   * checkpoint first, keeps the stop watch armed while it runs, and is pending
   * work for {@link drain} — so a stop kills it, and a run waits for it, exactly
   * as for an agent. `fn` receives the run's abort signal.
   */
  async runCommand<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.pending++;
    try {
      this.throwIfAborted();
      await this.checkpoint(this.signal);
      this.throwIfAborted();
      return await this.track(fn);
    } catch (err) {
      if (isFatalError(err)) this.abort(err);
      throw err;
    } finally {
      if (--this.pending === 0) this.notifyIdle();
    }
  }

  /**
   * Wait for a person — a `checkpoint()` call (ODW extension) — outside the
   * agent limits AND the dispatch gate: waiting is not work, so it takes no
   * slot, counts toward neither the backstop nor the budget, and is asked even
   * while the run is paused. It is still pending work for {@link drain}, and
   * the stop watch stays armed while it waits, so a stop (or any fatal error)
   * aborts `fn`'s signal at once. `fn` receives the run's abort signal.
   */
  async runWait<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.pending++;
    try {
      this.throwIfAborted();
      return await this.track(fn);
    } catch (err) {
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

  /** Run an agent's (or command's, or gate's, or checkpoint wait's) work, watching for a stop while any is in flight. */
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
    // Nothing is left to wake: a slot due back is given at the next dispatch.
    clearTimeout(this.restoreTimer);
    this.restoreTimer = undefined;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const idle of waiters) idle();
  }

  /**
   * Park until {@link pump} hands this request a run slot — together with a
   * slot on its adapter, when it has a lane — or until the run is aborted.
   */
  private acquire(lane: Lane | undefined): Promise<void> {
    const granted = new Promise<void>((resolve, reject) => this.waiters.push({ lane, resolve, reject }));
    this.pump();
    return granted;
  }

  private release(lane: Lane | undefined): void {
    this.active--;
    if (lane) lane.active--;
    this.pump();
  }

  /**
   * Hand free slots out, oldest request first: a request whose adapter is at
   * its cap is passed over — it keeps its place, and its adapter's later
   * requests stay behind it — so it never blocks the run slot from another
   * adapter. Run after every change, so no waiting request could ever take a
   * free slot: a new one never jumps ahead, and the cap can never be exceeded.
   */
  private pump(): void {
    if (this.lanes.size > 0 && !this.fatal) this.giveBack(this.now());
    for (let i = 0; i < this.waiters.length && this.active < this.concurrency; ) {
      const waiter = this.waiters[i]!;
      const lane = waiter.lane;
      if (lane && lane.active >= lane.limit) {
        i++;
        continue;
      }
      this.waiters.splice(i, 1);
      this.active++;
      if (lane) lane.active++;
      waiter.resolve();
    }
  }

  /** The lane an adapter's agents queue in, or none when nothing limits that adapter but the run. */
  private laneFor(adapter: string): Lane | undefined {
    let lane = this.lanes.get(adapter);
    if (lane) return lane;
    const own = Object.prototype.hasOwnProperty.call(this.adapterConcurrency, adapter)
      ? this.adapterConcurrency[adapter]!
      : undefined;
    if (own === undefined && !this.adaptive) return undefined;
    const max = Math.max(1, Math.min(this.concurrency, own ?? this.concurrency));
    lane = { adapter, max, limit: max, active: 0, wave: 0, since: 0, limitedAt: 0 };
    this.lanes.set(adapter, lane);
    return lane;
  }

  /** The slot handle of an agent dispatched now: its rate limits count against its lane's current wave. */
  private slotIn(held: Held): AgentSlot {
    held.wave = held.lane?.wave ?? 0;
    return {
      rateLimited: () => this.rateLimited(held.lane, held.wave),
      moveTo: (adapter) => this.move(held, adapter),
      release: () => this.letGo(held),
    };
  }

  /**
   * Move a running agent to `adapter`'s lane (see AgentSlot.moveTo): both its
   * slots go back in the same step that queues it, first, for the new pair —
   * so it never holds one while it waits for the other, and a free pair goes
   * to it before any agent that has not started. An agent that let go of its
   * slots (AgentSlot.release) queues for a pair the same way.
   */
  private async move(held: Held, adapter: string): Promise<void> {
    const lane = this.laneFor(adapter);
    if (held.slotted && lane === held.lane) return; // nothing but the run limits either adapter, or the same lane
    this.throwIfAborted();
    if (held.slotted) {
      held.slotted = false;
      this.active--;
      if (held.lane) held.lane.active--;
    }
    held.lane = lane;
    const granted = new Promise<void>((resolve, reject) => this.waiters.unshift({ lane, resolve, reject }));
    this.pump();
    await granted;
    held.slotted = true;
    held.wave = lane?.wave ?? 0;
  }

  /** Let go of a running agent's slots while it waits (see AgentSlot.release): the next request has them at once. */
  private letGo(held: Held): void {
    if (!held.slotted) return;
    held.slotted = false;
    this.release(held.lane);
  }

  /**
   * Adaptive back-pressure: halve the adapter's cap (never below 1) and start
   * its quiet minute over. An agent dispatched before the latest cut reports
   * the same wave of rate limits — a fan-out that hit the limit together
   * cuts once, not once per agent — so it only restarts the quiet minute.
   */
  private rateLimited(lane: Lane | undefined, wave: number): void {
    if (!lane || !this.adaptive || this.fatal) return;
    const now = this.now();
    this.giveBack(now);
    lane.since = now;
    lane.limitedAt = now;
    if (wave !== lane.wave || lane.limit <= 1) return;
    const previous = lane.limit;
    lane.limit = Math.max(1, Math.floor(previous / 2));
    lane.wave++;
    this.onAdapterCap?.({ adapter: lane.adapter, limit: lane.limit, previous, max: lane.max, reason: "rate_limit", quietMs: 0 });
    this.armRestore();
  }

  /** Give each held-down lane one slot back per quiet minute that has passed. */
  private giveBack(now: number): void {
    for (const lane of this.lanes.values()) {
      if (lane.limit >= lane.max) continue;
      const minutes = Math.floor((now - lane.since) / RESTORE_MS);
      if (minutes <= 0) continue;
      const previous = lane.limit;
      lane.limit = Math.min(lane.max, previous + minutes);
      lane.since += minutes * RESTORE_MS;
      this.onAdapterCap?.({
        adapter: lane.adapter,
        limit: lane.limit,
        previous,
        max: lane.max,
        reason: "restored",
        quietMs: now - lane.limitedAt,
      });
    }
  }

  /**
   * Wake the queue when the next held-down lane is due a slot back, while
   * there is work to wake (a slot due once the run is idle is given at its
   * next dispatch). Unref'd: a running agent is what keeps the run alive.
   */
  private armRestore(): void {
    if (this.restoreTimer || this.fatal || this.pending === 0) return;
    let due = Infinity;
    for (const lane of this.lanes.values()) {
      if (lane.limit < lane.max) due = Math.min(due, lane.since + RESTORE_MS);
    }
    if (due === Infinity) return;
    const delay = Math.min(RESTORE_MS, Math.max(0, due - this.now()));
    this.restoreTimer = setTimeout(() => {
      this.restoreTimer = undefined;
      this.pump();
      this.armRestore();
    }, delay);
    this.restoreTimer.unref();
  }
}
