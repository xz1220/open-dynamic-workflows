/**
 * The per-run context shared by the primitives.
 *
 * A {@link RunContext} is the single object a running workflow talks to,
 * indirectly, through the primitives. It bundles the wired-up layers (bridge,
 * scheduler), the control and event sink, the run's `args` and budget target,
 * and the mutable display state (`currentPhase`). {@link buildContext} is the one
 * place that wires the layers together from a {@link Config}.
 */

import { resolveConcurrency } from "./adapters/config.js";
import type { Config } from "./adapters/types.js";
import { Bridge } from "./bridge.js";
import { NullControl, type Control } from "./control.js";
import { BudgetExhausted } from "./errors.js";
import { NullSink, type EventSink, type WorkflowEvent } from "./events.js";
import { Scheduler } from "./scheduler.js";

export interface RunContext {
  config: Config;
  bridge: Bridge;
  scheduler: Scheduler;
  control: Control;
  sink: EventSink;
  args: unknown;
  /** The run's working directory; anchors nested workflow() name resolution. */
  source: string;
  /** The run's token target (for `budget`), or null when none was set. */
  budgetTotal: number | null;
  /**
   * Shared usage tally behind `budget.spent()`. Tokens are ESTIMATED from agent
   * reply text (chars/4) — adapters do not report real usage uniformly — so the
   * budget is an honest approximation, shared across nested workflow() calls.
   */
  usage: { outputChars: number };
  currentPhase: string | null;
  emit(ev: WorkflowEvent): void;
}

/** Estimated tokens spent so far (chars/4 of every agent reply in this run). */
export function spentTokens(usage: { outputChars: number }): number {
  return Math.ceil(usage.outputChars / 4);
}

export interface BuildContextOptions {
  source?: string;
  args?: unknown;
  sink?: EventSink;
  control?: Control;
  budgetTotal?: number | null;
}

/** Wire a full run context from a config and the run's surroundings. */
export function buildContext(config: Config, options: BuildContextOptions = {}): RunContext {
  const sink = options.sink ?? new NullSink();
  const control = options.control ?? new NullControl();
  const bridge = new Bridge(config, { source: options.source });
  const budgetTotal = options.budgetTotal ?? null;
  // The shared tally `budget.spent()` reads. Estimated (chars/4 of agent
  // replies); the guard makes --budget a real ceiling, not advisory.
  const usage = { outputChars: 0 };
  const scheduler = new Scheduler({
    concurrency: resolveConcurrency(config.settings.concurrency),
    maxAgents: config.settings.maxAgents,
    checkpoint: () => control.checkpoint(),
    budgetGuard: () => {
      if (budgetTotal !== null && spentTokens(usage) >= budgetTotal) {
        throw new BudgetExhausted(
          `run reached its budget ceiling of ${budgetTotal} estimated tokens (spent ~${spentTokens(usage)})`,
        );
      }
    },
  });
  return {
    config,
    bridge,
    scheduler,
    control,
    sink,
    args: options.args ?? null,
    source: options.source ?? process.cwd(),
    budgetTotal,
    usage,
    currentPhase: null,
    emit(ev: WorkflowEvent): void {
      sink.emit(ev);
    },
  };
}
