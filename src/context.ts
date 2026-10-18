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
import { Bridge, type BridgeOptions } from "./bridge.js";
import type { WaitingCheckpoint } from "./checkpoint.js";
import { NullControl, type Control } from "./control.js";
import { BudgetExhausted } from "./errors.js";
import { EGRESS_DENIED, LOG, NullSink, event, type EventSink, type WorkflowEvent } from "./events.js";
import type { Breaks } from "./breaks.js";
import type { CostHistory } from "./forecast.js";
import type { AgentCallRecord, AgentResultRecord, ReplayJournal } from "./journal.js";
import { quotaPauseMessage, type QuotaPauseChange } from "./quota-wait.js";
import { redactorFor, type Redactor } from "./redact.js";
import type { NotesBoard } from "./notes.js";
import type { PhaseDefaults } from "./routing.js";
import { Scheduler } from "./scheduler.js";
import type { ScopeLocks } from "./scope.js";
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
  /**
   * The run's directory; absent where no run is persisted. ODW writes there
   * while agents work, so an in-place `expect` check leaves it out of what an
   * agent changed when it lies in the source tree (ODW extension).
   */
  runDir?: string;
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
  /**
   * The MCP servers, with their status, whose not being connected the run has
   * logged, so each (server, status) is said once per run (ODW extension).
   * Shared like `seq`.
   */
  mcpNotes?: Set<string>;
  /**
   * Each phase's defaults (ODW extension; see ./routing): the adapter and
   * model its agents run with when they name none — from `meta.phases` and
   * phase(title, {…}), by phase title. Shared like `seq`: a nested
   * workflow()'s phases are there under their prefixed titles.
   */
  phaseDefaults?: Map<string, PhaseDefaults>;
  /**
   * The scoped agent() calls not settled yet (ODW extension; see ./scope):
   * what a call whose declared scope overlaps waits for. Shared like `seq`.
   */
  scopeLocks?: ScopeLocks;
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
   * Where the brief of a fallback that handed an agent's work over is kept
   * (ODW extension; see ./handoff): the run directory's
   * `agents/<agentId>.handoff.md`. Absent where nothing is persisted.
   */
  agentHandoffPath?: (agentId: number) => string;
  /**
   * `odw resume`: the source run's saved results, replayed by the agent()
   * calls that are unchanged. Shared like `seq`, so a nested workflow()
   * replays its calls too.
   */
  replay?: ReplayJournal;
  /**
   * Save what an agent() call was asked as it starts (ODW extension; the
   * worker writes the run directory's `agents/<agentId>.call.json`, which
   * `odw replay` reads). Absent where nothing is persisted. It may throw:
   * the agent still runs, and the failure is logged.
   */
  saveAgentCall?: (call: AgentCallRecord) => void;
  /**
   * The commit every isolated agent's worktree checks out, in place of the
   * source's HEAD (ODW extension: a run of `odw replay` starts its agent
   * where the original started). Absent: each one's HEAD as it starts.
   */
  worktreeBase?: string;
  /**
   * Where `odw run --break`/`--step` stops the run for a person (ODW
   * extension; see ./breaks). Shared like `seq`; absent: no breaks.
   */
  breaks?: Breaks;
  /**
   * checkpoint() (ODW extension): told when a checkpoint starts waiting for a
   * person (`waiting` true) and when it stops, so the worker can show it in
   * status.json and fire the "waiting" hooks. Absent for in-process runs. It
   * may throw: the checkpoint goes on, and the failure is logged.
   */
  onCheckpoint?: (cp: WaitingCheckpoint, waiting: boolean) => void;
  /**
   * What keeps likely secrets out of what the run writes down — transcripts,
   * saved results, events, exec() failures (ODW extension; see ./redact).
   * Built once per run, shared like `seq`; absent: nothing is redacted.
   */
  redactor?: Redactor;
  /**
   * The run's notes board (ODW extension; see ./notes): what agents with
   * notes on post and read. Shared like `seq`; absent where no run is
   * persisted (in-process runs), which then have none.
   */
  notes?: NotesBoard;
  /**
   * The workflow's earlier runs, as fan-out forecasts and cost gates read
   * them (ODW extension; see ./forecast) — read once, on the first fan-out
   * that asks; null without history. Absent where no run is persisted.
   */
  costHistory?: () => CostHistory | null;
  /**
   * What the run has said about cost gates without history, so it is said
   * once per run (ODW extension). Shared like `seq`.
   */
  costNotes?: Set<string>;
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
  runDir?: string;
  args?: unknown;
  sink?: EventSink;
  control?: Control;
  budgetTotal?: number | null;
  saveAgentResult?: (rec: AgentResultRecord) => void;
  agentDiffPath?: (agentId: number) => string;
  agentTranscriptPaths?: (agentId: number) => TranscriptPaths;
  agentHandoffPath?: (agentId: number) => string;
  replay?: ReplayJournal;
  saveAgentCall?: (call: AgentCallRecord) => void;
  worktreeBase?: string;
  breaks?: Breaks;
  onCheckpoint?: (cp: WaitingCheckpoint, waiting: boolean) => void;
  /** Where an agent's schema file goes for a CLI that reads one (the bridge's `agentSchemaPath`). */
  agentSchemaPath?: (agentId: number) => string;
  /** The run's redactor; built from the config's `redact` when absent. */
  redactor?: Redactor;
  /** The run's notes board (ODW extension; see ./notes). */
  notes?: NotesBoard;
  /** The workflow's earlier runs, for fan-out forecasts and cost gates (ODW extension; see ./forecast). */
  costHistory?: () => CostHistory | null;
  /**
   * quotaWait (ODW extension): told whenever the run's pause for an adapter's
   * spent quota starts, moves or ends — after the run's log has said so — so
   * the worker can show it in status.json and fire the "paused" hooks. It
   * may throw: the pause goes on.
   */
  onQuotaPause?: (change: QuotaPauseChange) => void;
  /** Test seams for the run's bridge: the command runner, and the clock, sleep and jitter its waits run on. */
  bridge?: Pick<BridgeOptions, "runner" | "sleep" | "now" | "random">;
  /** Told as each agent CLI run starts (the bridge's `onCliRun`): the worker records CLI versions by it (ODW extension). */
  onCliRun?: BridgeOptions["onCliRun"];
}

/** Wire a full run context from a config and the run's surroundings. */
export function buildContext(config: Config, options: BuildContextOptions = {}): RunContext {
  const sink = options.sink ?? new NullSink();
  const control: Control = options.control ?? new NullControl();
  // Compiled once for the whole run (ODW extension; see ./redact).
  const redactor = options.redactor ?? redactorFor(config);
  const bridge = new Bridge(config, {
    source: options.source,
    runId: options.runId,
    // A sandbox's egress denials (ODW extension): logged in the run directory, tailed into events.
    runDir: options.runDir,
    onEgressDenied: (denial) => sink.emit(event(EGRESS_DENIED, { ...denial })),
    agentSchemaPath: options.agentSchemaPath,
    redactor,
    onCliRun: options.onCliRun,
    // What an untrusted run still lets through, or refused, is the run's to say once (ODW extension: trust).
    onRunNote: (message, fields) => sink.emit(event(LOG, { message, ...fields })),
    ...options.bridge,
    // quotaWait (ODW extension): a pause for a spent quota is logged and
    // shown, and `odw resume` ends it at once.
    onQuotaPause: (change) => {
      const message = quotaPauseMessage(change, (options.bridge?.now ?? Date.now)());
      if (message) {
        const { adapter, resumeAt } = change.pause;
        sink.emit(event(LOG, { message, adapter, reason: "quota", resumeAt, quotaPause: change.change }));
      }
      options.onQuotaPause?.(change);
    },
    watchResume: control.watchResume ? (onResume) => control.watchResume!(onResume) : undefined,
  });
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
    runDir: options.runDir,
    budgetTotal,
    usage,
    seq: { value: 0 },
    commandSeq: { value: 0 },
    checkpointSeq: { value: 0 },
    permissionNotes: new Set(),
    mcpNotes: new Set(),
    phaseDefaults: new Map(),
    currentPhase: null,
    saveAgentResult: options.saveAgentResult,
    agentDiffPath: options.agentDiffPath,
    agentTranscriptPaths: options.agentTranscriptPaths,
    agentHandoffPath: options.agentHandoffPath,
    replay: options.replay,
    saveAgentCall: options.saveAgentCall,
    worktreeBase: options.worktreeBase,
    breaks: options.breaks,
    onCheckpoint: options.onCheckpoint,
    redactor,
    notes: options.notes,
    costHistory: options.costHistory,
    costNotes: new Set(),
    emit(ev: WorkflowEvent): void {
      sink.emit(ev);
    },
  };
}
