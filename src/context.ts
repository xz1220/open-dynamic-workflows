/**
 * The per-run context shared by the primitives.
 *
 * A {@link RunContext} is the single object a running workflow talks to,
 * indirectly, through the primitives. It bundles the wired-up layers (bridge,
 * scheduler), the control and event sink, the run's `args` and budget target,
 * and the mutable display state (`currentPhase`). {@link buildContext} is the one
 * place that wires the layers together from a {@link Config}.
 */

import { resolveAdapterConcurrency, resolveConcurrency } from "./adapters/config.js";
import type { Config } from "./adapters/types.js";
import { Bridge } from "./bridge.js";
import type { WaitingCheckpoint } from "./checkpoint.js";
import { NullControl, type Control } from "./control.js";
import { BudgetExhausted } from "./errors.js";
import { LOG, NullSink, event, type EventSink, type WorkflowEvent } from "./events.js";
import type { AgentResultRecord, ReplayJournal } from "./journal.js";
import { Scheduler } from "./scheduler.js";
import { capChangeMessage } from "./throttle.js";
import type { TranscriptPaths } from "./transcript.js";

export interface RunContext {
  config: Config;
  bridge: Bridge;
  scheduler: Scheduler;
  control: Control;
  sink: EventSink;
  args: unknown;
  /** The run's working directory; anchors nested workflow() name resolution. */
  source: string;
  /** The run's id (`ODW_RUN_ID` for its processes); absent where no run is persisted. */
  runId?: string;
  /** The run's token target (for `budget`), or null when none was set. */
  budgetTotal: number | null;
  /**
   * Shared usage tally behind `budget.spent()`, shared across nested
   * workflow() calls: the output tokens CLIs reported (`outputTokens`), plus
   * the characters of replies whose CLI reported none (`outputChars`, counted
   * as chars/4 — not every adapter reports usage).
   */
  usage: { outputChars: number; outputTokens: number };
  /**
   * Monotonic per-run agent-dispatch counter behind the `agentId` event field.
   * A shared object (not a number) so nested workflow() children — built by
   * spreading the parent context — keep allocating from the same sequence and
   * ids stay unique across the whole run.
   */
  seq: { value: number };
  /**
   * The same, for exec() command steps (the `commandId` event field): its own
   * sequence, so agent ids keep numbering agent dispatches only.
   */
  commandSeq: { value: number };
  /** The same, for checkpoint() calls (the `checkpointId` event field; ODW extension). */
  checkpointSeq: { value: number };
  /**
   * Adapters whose permissions note (a tier they cannot run as asked) the run
   * has logged, so each is said once per run (ODW extension). Shared like `seq`.
   */
  permissionNotes?: Set<string>;
  currentPhase: string | null;
  /**
   * Save a completed agent's record (the worker writes the run directory's
   * `agents/<agentId>.json`). Absent where nothing is persisted (in-process
   * runs). It may throw: the agent still succeeds, and the failure is logged.
   */
  saveAgentResult?: (rec: AgentResultRecord) => void;
  /**
   * Where an isolated agent's change is kept as a diff (ODW extension): the
   * run directory's `agents/<agentId>.diff`. Absent where nothing is
   * persisted (in-process runs): such a run keeps no diffs and no branches.
   */
  agentDiffPath?: (agentId: number) => string;
  /**
   * Where each agent's transcript is kept as it runs (ODW extension): the run
   * directory's `agents/<agentId>.transcript.jsonl` and `.stderr.txt`. Absent
   * where nothing is persisted (in-process runs): such a run keeps none.
   */
  agentTranscriptPaths?: (agentId: number) => TranscriptPaths;
  /**
   * `odw resume`: the source run's saved results, replayed by the agent()
   * calls that are unchanged. Shared like `seq`, so a nested workflow()
   * replays its calls too.
   */
  replay?: ReplayJournal;
  /**
   * checkpoint() (ODW extension): told when a checkpoint starts waiting for a
   * person (`waiting` true) and when it stops, so the worker can show it in
   * status.json and fire the "waiting" hooks. Absent for in-process runs. It
   * may throw: the checkpoint goes on, and the failure is logged.
   */
  onCheckpoint?: (cp: WaitingCheckpoint, waiting: boolean) => void;
  emit(ev: WorkflowEvent): void;
}

/**
 * Output tokens spent so far in this run: what the CLIs reported, plus chars/4
 * of the replies whose CLI reported none.
 */
export function spentTokens(usage: { outputChars: number; outputTokens?: number }): number {
  return (usage.outputTokens ?? 0) + Math.ceil(usage.outputChars / 4);
}

export interface BuildContextOptions {
  source?: string;
  runId?: string;
  args?: unknown;
  sink?: EventSink;
  control?: Control;
  budgetTotal?: number | null;
  saveAgentResult?: (rec: AgentResultRecord) => void;
  agentDiffPath?: (agentId: number) => string;
  agentTranscriptPaths?: (agentId: number) => TranscriptPaths;
  replay?: ReplayJournal;
  onCheckpoint?: (cp: WaitingCheckpoint, waiting: boolean) => void;
  /** Where an agent's schema file goes for a CLI that reads one (the bridge's `agentSchemaPath`). */
  agentSchemaPath?: (agentId: number) => string;
}

/** Wire a full run context from a config and the run's surroundings. */
export function buildContext(config: Config, options: BuildContextOptions = {}): RunContext {
  const sink = options.sink ?? new NullSink();
  const control: Control = options.control ?? new NullControl();
  const bridge = new Bridge(config, { source: options.source, runId: options.runId, agentSchemaPath: options.agentSchemaPath });
  const budgetTotal = options.budgetTotal ?? null;
  // The shared tally `budget.spent()` reads: reported output tokens, else
  // chars/4 of the reply; the guard makes --budget a real ceiling, not advisory.
  const usage = { outputChars: 0, outputTokens: 0 };
  const scheduler = new Scheduler({
    concurrency: resolveConcurrency(config.settings.concurrency),
    maxAgents: config.settings.maxAgents,
    // Per-adapter caps, lowered by rate limits while adaptive (ODW extensions):
    // a cut, and the slot that brings a cap back in full, are logged.
    adapterConcurrency: resolveAdapterConcurrency(config),
    adaptive: config.settings.adaptiveConcurrency,
    onAdapterCap: (change) => {
      const message = capChangeMessage(change);
      if (message) sink.emit(event(LOG, { message, adapter: change.adapter, concurrency: change.limit }));
    },
    checkpoint: (signal) => control.checkpoint(signal),
    // A stop must reach agents that are already running, not just the next dispatch.
    watchStop: control.watchStop ? (onStop) => control.watchStop!(onStop) : undefined,
    budgetGuard: () => {
      if (budgetTotal !== null && spentTokens(usage) >= budgetTotal) {
        throw new BudgetExhausted(
          `run reached its budget ceiling of ${budgetTotal} output tokens (spent ${usage.outputChars > 0 ? "~" : ""}${spentTokens(usage)})`,
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
    runId: options.runId,
    budgetTotal,
    usage,
    seq: { value: 0 },
    commandSeq: { value: 0 },
    checkpointSeq: { value: 0 },
    permissionNotes: new Set(),
    currentPhase: null,
    saveAgentResult: options.saveAgentResult,
    agentDiffPath: options.agentDiffPath,
    agentTranscriptPaths: options.agentTranscriptPaths,
    replay: options.replay,
    onCheckpoint: options.onCheckpoint,
    emit(ev: WorkflowEvent): void {
      sink.emit(ev);
    },
  };
}
