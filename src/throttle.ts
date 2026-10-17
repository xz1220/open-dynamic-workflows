/**
 * Per-adapter concurrency and cache-friendly fan-outs (ODW extensions): how a
 * run paces its agents, said in words, and the staggered fan-out itself.
 *
 * The slots — the run-wide cap, each adapter's own cap, and adaptive
 * back-pressure lowering an adapter's cap after a rate limit — are handed out
 * by the scheduler (./scheduler). What lives here sits above it:
 *
 *   - {@link describeConcurrency}: the caps in force, for the run's start
 *     banner and `odw doctor`; {@link capChangeMessage}: what the run's log
 *     says when adaptive back-pressure moves an adapter's cap.
 *   - {@link FanOut}: a staggered fan-out. A model API with a prompt cache
 *     (Anthropic's, behind the built-in claude adapter) stores a prompt's
 *     prefix while it reads the first request that sends it, and later
 *     requests read it from there at a fraction of the price — but a fan-out
 *     that starts every agent at once sends them all before anything is
 *     stored, so each pays for the whole prefix. So in one parallel() or
 *     pipeline() call, agents on an adapter that declares `promptCache`, whose
 *     prompts share at least {@link STAGGER_MIN_PREFIX} characters from their
 *     start, go `first` at a time: the rest wait until the first one's CLI
 *     has produced output, or `delayMs`, whichever comes first.
 */

import { formatSeconds } from "./adapters/failures.js";
import { resolveAdapterConcurrency, resolveConcurrency } from "./adapters/config.js";
import type { Config, StaggerFanOut } from "./adapters/types.js";
import type { AdapterCapChange } from "./scheduler.js";

/**
 * The run's agent caps in one line — "8 agents at once (auto) · per adapter:
 * codex 4, gemini 2" — the per-adapter ones at most the run-wide one. With
 * `details`, also what adaptive back-pressure and staggered fan-outs do.
 */
export function describeConcurrency(config: Config, opts: { details?: boolean } = {}): string {
  const { settings } = config;
  const run = resolveConcurrency(settings.concurrency);
  const parts = [`${run} agent${run === 1 ? "" : "s"} at once${settings.concurrency === null ? " (auto)" : ""}`];
  const caps = Object.entries(resolveAdapterConcurrency(config)).map(([name, cap]) => `${name} ${cap}`);
  if (caps.length > 0) parts.push(`per adapter: ${caps.join(", ")}`);
  if (!opts.details) return parts.join(" · ");
  parts.push(settings.adaptiveConcurrency ? "a rate limit halves its adapter's cap" : "adaptive back-pressure off");
  const cached = Object.keys(config.adapters)
    .filter((name) => config.adapters[name]!.promptCache)
    .sort();
  const stagger = settings.staggerFanOut;
  if (!stagger) parts.push("staggered fan-outs off");
  else if (cached.length === 0) parts.push("no adapter declares promptCache, so no fan-out is staggered");
  else {
    parts.push(
      `fan-outs on ${cached.join(", ")} staggered: ${stagger.first} first, ` +
        `the rest after its output or ${formatSeconds(stagger.delayMs / 1000)}`,
    );
  }
  return parts.join(" · ");
}

/**
 * The log line for an adapter's cap moving under adaptive back-pressure: a
 * cut, and the slot that brings it back to its full cap. Null for the slots
 * given back on the way (one a minute: the line that matters is the last).
 */
export function capChangeMessage(change: AdapterCapChange): string | null {
  const { adapter, limit, previous, max } = change;
  if (change.reason === "rate_limit") {
    return (
      `adaptive concurrency: ${adapter} hit a rate limit — at most ${limit} of its agents at once now ` +
      `(was ${previous}); one slot comes back for each minute without another`
    );
  }
  if (limit < max) return null;
  return `adaptive concurrency: no rate limit on ${adapter} for ${formatSeconds(change.quietMs / 1000)} — back to ${max} of its agents at once`;
}

/** Characters two prompts must share from their start before a fan-out staggers them. */
export const STAGGER_MIN_PREFIX = 1024;

/** How one agent takes part in a staggered fan-out (see {@link FanOut.enter}). */
export interface StaggerTurn {
  /**
   * For an agent held back: resolves once the agents it waits for have warmed
   * the cache, or rejects with the run's reason when `signal` aborts first.
   * Absent for an agent that starts at once.
   */
  readonly gate?: (signal: AbortSignal) => Promise<void>;
  /** The agent started (it holds its slots): the wait it leads runs `delayMs` from the first start. */
  started(): void;
  /** The agent's CLI produced output: the agents it leads may go. */
  output(): void;
  /** The agent settled, however it ended: the agents it leads may go. */
  settled(): void;
}

/**
 * One parallel() or pipeline() call's agents on prompt-caching adapters, for
 * staggering. Agents whose prompts share a prefix (on the same adapter, model
 * and persona: the same cache) form a wave: its first `first` agents lead and
 * start at once; the rest are held until a leader's CLI has produced output,
 * a leader has settled, or `delayMs` has passed since the first one started.
 * An agent whose prompt is shorter than {@link STAGGER_MIN_PREFIX} starts at
 * once; one that shares that much with no earlier agent leads a wave of its
 * own — a lone agent is never held. Held agents wait before they ask for a
 * slot, so they hold none. One line is logged per wave that held agents back.
 */
export class FanOut {
  /** By cache and the prompts' first {@link STAGGER_MIN_PREFIX} characters: equal exactly when they share that much. */
  private readonly waves = new Map<string, Wave>();

  /**
   * `signal` is the run's: once it aborts, a held agent stops waiting at
   * once and nothing more is logged. `log` writes the run's log line.
   */
  constructor(
    private readonly stagger: StaggerFanOut,
    private readonly signal: AbortSignal,
    private readonly log: (message: string, fields: Record<string, unknown>) => void,
  ) {}

  /**
   * Place one agent: `adapter` is the one it runs on, `cache` says which
   * cache its prompt goes to (adapter, model and persona), `prompt` is its own.
   */
  enter(adapter: string, cache: string, prompt: string): StaggerTurn | undefined {
    if (prompt.length < STAGGER_MIN_PREFIX) return undefined;
    const key = `${cache}\u0000${prompt.slice(0, STAGGER_MIN_PREFIX)}`;
    let wave = this.waves.get(key);
    if (!wave) {
      wave = new Wave(adapter, prompt, this.stagger.delayMs, this.signal, this.log);
      this.waves.set(key, wave);
    }
    if (wave.leaders < this.stagger.first) return wave.lead();
    if (wave.released) return undefined;
    return wave.hold(sharedPrefixLength(wave.prompt, prompt));
  }
}

/** Why a wave's held agents were let go. */
type Release = "output" | "settled" | "delay";

/** Agents of one fan-out that share a prompt prefix: the leaders that run first, and the agents they hold. */
class Wave {
  leaders = 0;
  held = 0;
  released = false;
  /** The shortest prefix a held agent shares with the first leader's prompt. */
  private shared = Infinity;
  private readonly createdAt = Date.now();
  private timer: NodeJS.Timeout | undefined;
  private open!: () => void;
  private readonly opened = new Promise<void>((resolve) => (this.open = resolve));

  constructor(
    private readonly adapter: string,
    readonly prompt: string,
    private readonly delayMs: number,
    private readonly signal: AbortSignal,
    private readonly log: (message: string, fields: Record<string, unknown>) => void,
  ) {}

  lead(): StaggerTurn {
    this.leaders++;
    return {
      started: () => this.start(),
      output: () => this.release("output"),
      settled: () => this.release("settled"),
    };
  }

  hold(shared: number): StaggerTurn {
    this.held++;
    this.shared = Math.min(this.shared, shared);
    const idle = (): void => {};
    return { gate: (signal) => this.wait(signal), started: idle, output: idle, settled: idle };
  }

  /** A leader started: the held agents go `delayMs` after the first start at the latest. */
  private start(): void {
    if (this.released || this.timer) return;
    this.timer = setTimeout(() => this.release("delay"), this.delayMs);
  }

  private release(why: Release): void {
    if (this.released) return;
    this.released = true;
    clearTimeout(this.timer);
    this.open();
    // A run that was stopped (or failed) let its held agents go by aborting them.
    if (this.held === 0 || this.signal.aborted) return;
    const until =
      why === "output"
        ? "until it produced output"
        : why === "settled"
          ? "until it finished"
          : `until staggerFanOut.delayMs (${this.delayMs}ms) ran out`;
    const agents = `${this.held} ${this.adapter} agent${this.held === 1 ? "" : "s"}`;
    this.log(
      `staggered fan-out: ${agents} sharing a ${this.shared}-character prompt prefix waited ` +
        `${formatSeconds((Date.now() - this.createdAt) / 1000)} while the first warmed the prompt cache, ${until}`,
      { adapter: this.adapter, staggered: this.held },
    );
  }

  private wait(signal: AbortSignal): Promise<void> {
    if (this.released) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const onAbort = (): void => {
        reject(signal.reason);
        this.release("settled"); // nothing is logged: the run was aborted
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void this.opened.then(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      });
    });
  }
}

/** How many characters `a` and `b` share from their start. */
export function sharedPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}
