/**
 * Pause for a spent quota (an ODW extension): a run whose agents ran out of
 * usage quota waits for it to reset, instead of failing them.
 *
 * Off unless the `quotaWait` setting says how long a run may wait — `{ "max":
 * <seconds> }`: a run that sits silently for hours would surprise anyone who
 * did not ask for it. With it, an agent() call whose fallback chain is out of
 * quota — its last adapter's quota failed, or the quota breaker took every one
 * out — waits for the first of its adapters' quotas to reset, when a CLI said
 * when (adapters/failures.ts reads "try again in 3h 22m", "resets 7pm", Claude
 * Code's "usage limit reached|<epoch>") and that is at most `max` seconds
 * away; then it starts over from its chain's start. A quota failure that names
 * no reset, or one past `max`, still fails the call, and the run says why.
 *
 * A reset a CLI named is honored: until then the run's calls pass over that
 * adapter — one with a fallback moves on, one with nowhere else to go waits
 * too, before it is dispatched — and its quota failures count toward no
 * quota breaker. A waiting call holds no slot, so agents on adapters with
 * quota left keep running. The pause ends when the quota resets — each call
 * comes back with a little jitter, so they do not all reach the CLI in the
 * same second — or at once when the run is resumed (`odw resume`); either
 * way the run's quota breaker forgets the adapter. A stop ends the wait like
 * any other.
 *
 * The pause lives in the worker: one that dies leaves its run stale, and `odw
 * resume` replays it like any run that ended. This module keeps the pauses —
 * the bridge decides which call waits on which (./bridge), the worker shows
 * them as the run's `pausedFor` (runtime/worker.ts) — and words them.
 */

import { formatSeconds } from "./adapters/failures.js";
import { RunStopped } from "./errors.js";

/** One adapter's pause for its spent quota, as the run shows it (status.json's `pausedFor`, with reason "quota"). */
export interface QuotaPause {
  /** The adapter whose usage quota is spent. */
  adapter: string;
  /** When its quota resets and its calls go on, in epoch seconds. */
  resumeAt: number;
}

/**
 * What a run paused for a spent quota waits for — status.json's and the run
 * views' `pausedFor`: the adapter whose quota resets first, and when.
 */
export interface PausedFor extends QuotaPause {
  reason: "quota";
}

/** status.json's `pausedFor` when it is a quota pause; null otherwise (none, or a hand-edited file). */
export function pausedForOf(raw: unknown): PausedFor | null {
  if (raw === null || typeof raw !== "object") return null;
  const { reason, adapter, resumeAt } = raw as Record<string, unknown>;
  if (reason !== "quota" || typeof adapter !== "string" || typeof resumeAt !== "number" || !Number.isFinite(resumeAt)) {
    return null;
  }
  return { reason, adapter, resumeAt };
}

/** A pause that changed (see {@link QuotaWaitsOptions.onChange}). */
export interface QuotaPauseChange {
  pause: QuotaPause;
  /**
   * `started`: a call began waiting for the adapter's quota; `extended`: its
   * CLI has since named a later reset; `reset`: the reset came; `resumed`: the
   * run was resumed (`odw resume`); `withdrawn`: its calls ended with the run.
   */
  change: "started" | "extended" | "reset" | "resumed" | "withdrawn";
}

/** The most a call waiting for a quota adds to its reset, at random, in ms: the jitter that spreads them out. */
export const RESUME_JITTER_MS = 30_000;

export interface QuotaWaitsOptions {
  /** The clock resets are read against, in ms. */
  now: () => number;
  /** How a call waits; it must end early when the signal aborts. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Where the jitter comes from, in [0, 1). */
  random: () => number;
  /** Told whenever a pause starts, moves or ends: the run's log and its status show it. */
  onChange?: (change: QuotaPauseChange) => void;
  /** Told when an adapter has its quota back — a pause over, or a reset gone by — so the quota breaker forgets it. */
  onBack?: (adapter: string) => void;
  /** Call `onResume` for each `odw resume` while calls wait (see Control.watchResume); returns a function that stops. */
  watchResume?: (onResume: () => void) => () => void;
}

/** A pause on one adapter, while calls wait for it. */
interface Pause {
  readonly adapter: string;
  /** When its quota resets, in ms. */
  resumeAt: number;
  /** The calls waiting for it. */
  waiters: number;
  /** How it ended; undefined while it is on. */
  how?: "reset" | "resumed" | "withdrawn";
  /** Aborted when the run is resumed: its calls go on at once. */
  readonly resumed: AbortController;
}

/**
 * The run's pauses for spent quotas, one per adapter, and the resets its
 * CLIs named. Built by the bridge, which owns the run's quota breaker.
 */
export class QuotaWaits {
  /** Per adapter: when its quota resets, in ms — the latest reset a quota failure named since it last came back. */
  private readonly resets = new Map<string, number>();
  private readonly pauses = new Map<string, Pause>();
  /** Calls waiting, on every pause: a resume is watched for while any does. */
  private waiting = 0;
  private unwatch: (() => void) | undefined;

  constructor(private readonly options: QuotaWaitsOptions) {}

  /**
   * A quota failure on `adapter` said its quota resets in `retryAfter`
   * seconds: the latest reset named holds, and a pause on the adapter lasts
   * until then.
   */
  noteReset(adapter: string, retryAfter: number): void {
    const at = this.options.now() + retryAfter * 1000;
    if ((this.resets.get(adapter) ?? -Infinity) >= at) return;
    this.resets.set(adapter, at);
    const pause = this.pauses.get(adapter);
    if (!pause || at <= pause.resumeAt) return;
    pause.resumeAt = at;
    this.tell(pause, "extended");
  }

  /** When `adapter`'s quota resets (ms), as its CLI said since it last came back; undefined when none said. */
  resetOf(adapter: string): number | undefined {
    return this.resets.get(adapter);
  }

  /** Calls wait for `adapter`'s quota now. */
  isPaused(adapter: string): boolean {
    return this.pauses.has(adapter);
  }

  /** `adapter`'s quota is spent until a reset its CLI named, or calls wait for it: the run passes over it. */
  isOut(adapter: string): boolean {
    return this.pauses.has(adapter) || (this.resets.get(adapter) ?? -Infinity) > this.options.now();
  }

  /** `adapter`'s reset has gone by with no call waiting for it: it is back, and the quota breaker forgets it. */
  back(adapter: string): void {
    this.resets.delete(adapter);
    this.options.onBack?.(adapter);
  }

  /**
   * Hold a call until `adapter`'s quota resets — the reset its CLI named,
   * plus up to {@link RESUME_JITTER_MS} — or the run is resumed. The call
   * joins the adapter's pause first, starting it when none is on; then
   * `before` runs (the time to let go of its slots, and say so); then it
   * waits. Resolves with how the pause ended; rejects with the run's reason
   * once `signal` aborts.
   */
  async wait(adapter: string, signal?: AbortSignal, before?: () => void | Promise<void>): Promise<"reset" | "resumed"> {
    let pause = this.pauses.get(adapter);
    if (!pause) {
      pause = { adapter, resumeAt: this.resets.get(adapter) ?? this.options.now(), waiters: 0, resumed: new AbortController() };
      this.pauses.set(adapter, pause);
      this.tell(pause, "started");
    }
    pause.waiters++;
    if (this.waiting++ === 0) this.unwatch = this.options.watchResume?.(() => this.resumeNow());
    try {
      await before?.();
      const jitter = this.options.random() * RESUME_JITTER_MS;
      for (;;) {
        throwIfAborted(signal);
        if (pause.how === "resumed") return "resumed";
        const left = pause.resumeAt + jitter - this.options.now();
        if (left <= 0) {
          this.end(pause, "reset"); // the first call back ends it; the rest come back on their own jitter
          return "reset";
        }
        await this.nap(left, signal, pause.resumed.signal);
      }
    } finally {
      pause.waiters--;
      if (--this.waiting === 0) {
        this.unwatch?.();
        this.unwatch = undefined;
      }
      // Its last call left with the pause still on: the run ended under it.
      if (pause.waiters === 0 && pause.how === undefined) this.end(pause, "withdrawn");
    }
  }

  /** The run was resumed (`odw resume`): every pause ends now, and its calls go on at once. */
  resumeNow(): void {
    for (const pause of [...this.pauses.values()]) this.end(pause, "resumed");
  }

  private end(pause: Pause, how: NonNullable<Pause["how"]>): void {
    if (pause.how !== undefined) return;
    pause.how = how;
    if (this.pauses.get(pause.adapter) === pause) this.pauses.delete(pause.adapter);
    if (how !== "withdrawn") this.back(pause.adapter);
    if (how === "resumed") pause.resumed.abort();
    this.tell(pause, how);
  }

  /** Sleep `ms`, or until the run aborts or is resumed. */
  private async nap(ms: number, signal: AbortSignal | undefined, resumed: AbortSignal): Promise<void> {
    if (!signal) return this.options.sleep(ms, resumed);
    const either = new AbortController();
    const wake = (): void => either.abort();
    signal.addEventListener("abort", wake, { once: true });
    resumed.addEventListener("abort", wake, { once: true });
    try {
      if (!signal.aborted && !resumed.aborted) await this.options.sleep(ms, either.signal);
    } finally {
      signal.removeEventListener("abort", wake);
      resumed.removeEventListener("abort", wake);
    }
  }

  /** Tell the run; a log or status that could not be written must not cost a call its wait. */
  private tell(pause: Pause, change: QuotaPauseChange["change"]): void {
    try {
      this.options.onChange?.({ pause: { adapter: pause.adapter, resumeAt: pause.resumeAt / 1000 }, change });
    } catch {
      // the pause goes on
    }
  }
}

/** End a wait the run aborted with its reason: a fatal error, so it propagates (the bridge's convention). */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new RunStopped("run was stopped");
}

// --- in words ------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** When a pause ends, in local time: "19:10" — "Oct 18 19:10" when that is not today. */
export function clockTime(epochSeconds: number, now: number = Date.now()): string {
  const at = new Date(epochSeconds * 1000);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return at.toDateString() === new Date(now).toDateString() ? time : `${MONTHS[at.getMonth()]} ${at.getDate()} ${time}`;
}

/** A run's pause in a few words: "paused until 19:10 (codex quota)". */
export function pausedText(pause: QuotaPause, now?: number): string {
  return `paused until ${clockTime(pause.resumeAt, now)} (${pause.adapter} quota)`;
}

/** The run's log line for a pause that changed; null when the run ended under it. */
export function quotaPauseMessage({ pause, change }: QuotaPauseChange, now: number = Date.now()): string | null {
  const until = `${clockTime(pause.resumeAt, now)} (in ${formatSeconds(Math.max(0, pause.resumeAt - now / 1000))})`;
  switch (change) {
    case "started":
      return (
        `quota pause: ${pause.adapter} is out of usage quota until ${until} — its agents wait, holding no slot, ` +
        `and go on then (quotaWait); odw resume goes on now`
      );
    case "extended":
      return `quota pause: ${pause.adapter} is out of usage quota until ${until}, later than it said before`;
    case "reset":
      return `quota pause over: ${pause.adapter}'s quota reset — its agents go on`;
    case "resumed":
      return `quota pause over: the run was resumed — ${pause.adapter}'s agents go on now`;
    default:
      return null;
  }
}
