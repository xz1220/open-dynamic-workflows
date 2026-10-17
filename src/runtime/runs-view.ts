/**
 * Read-model for the dashboard (L5).
 *
 * `odw serve` does not get a privileged view of a running workflow — it is just
 * another reader of the run directory, exactly like `odw list`/`status`/`logs`.
 * This module turns the raw artifacts (status.json + events.jsonl + meta.json)
 * into the shape a UI wants: a per-run summary and a per-agent breakdown, with
 * three deliberate honesty fixes that the raw files don't give you for free:
 *
 *   1. Stale runs. A detached worker that is `kill -9`'d never writes its
 *      terminal state, so status.json says "running" forever. We reconcile a
 *      non-terminal run against its pid: if the process is gone, or a legacy
 *      "running" status never recorded a pid, it's "stale", not "running".
 *      The dashboard's headline question — what is *actually* running — must
 *      not be answered by a field that lies on crash.
 *
 *   2. Live counts. status.dispatched is only persisted at terminal states
 *      (worker.ts), so a running run reports 0 dispatched for its whole life.
 *      We count agents by folding events instead.
 *
 *   3. No fabricated progress. There is no token/cost accounting (budget.spent
 *      is a stub) and no declared agent total, so "progress" here is strictly
 *      settled/observed agents — a fraction of work *seen*, never invented.
 */

import type { WorkflowEvent } from "../events.js";
import { RunStore, TERMINAL_STATES } from "./run-store.js";

export type AgentState = "running" | "done" | "failed" | "stale";

export interface AgentView {
  /** Stable per-dispatch id from the engine (null for pre-agentId event files). */
  agentId: number | null;
  /** Display label (the `label`/adapter/`agent` passed to agent()). */
  label: string;
  /** Phase the call was made under, or null if none was active. */
  phase: string | null;
  state: AgentState;
  adapter: string | null;
  attempts: number | null;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** Wall-clock from agent_started to agent_finished/failed, in ms. */
  durationMs: number | null;
}

export type RunDisplayState =
  | "pending"
  | "running"
  | "paused"
  | "done"
  | "failed"
  | "stopped"
  | "stale";

export interface RunCounts {
  agents: number;
  running: number;
  done: number;
  failed: number;
  stale: number;
}

export interface RunSummary {
  runId: string;
  /** Which engine produced this run: ODW's own RunStore, or Claude Code's. */
  provider: "odw" | "claude";
  /** Reconciled state shown to the user (may be "stale"). */
  state: RunDisplayState;
  /** The on-disk status.state before staleness reconciliation. */
  rawState: string;
  stale: boolean;
  name: string;
  description: string | null;
  phases: Array<{ title: string }>;
  source: string | null;
  pid: number | null;
  createdAt: number | null;
  updatedAt: number | null;
  counts: RunCounts;
  /** settled (done+failed) / agents, in [0,1]; 0 when no agents seen yet. */
  progress: number;
  lastActivityTs: number | null;
}

export interface RunDetail extends RunSummary {
  script: string | null;
  args: unknown;
  agents: AgentView[];
  /** Phases in the order their phase_started fired, plus any declared-not-started. */
  phaseOrder: string[];
  hasResult: boolean;
  error: { error?: string; stack?: string } | null;
  /** Where the run was initiated from (meta.origin, e.g. "chat"); null for CLI runs. */
  origin: string | null;
  /** Run-level adapter override recorded at launch (meta.adapter), if any. */
  adapter: string | null;
  /** The workflow identity recorded at create time (meta.workflowName). */
  workflowName: string | null;
}

/** Is `pid` a live process on this host? null when unknowable (no pid). */
export function isProcessAlive(pid: number | null | undefined): boolean | null {
  if (pid === null || pid === undefined || !Number.isFinite(pid)) return null;
  try {
    process.kill(pid, 0); // signal 0: liveness probe, no actual signal sent
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    // EPERM: the process exists but is owned by someone else — still alive.
    if (e.code === "EPERM") return true;
    return false; // ESRCH (no such process) and anything else: treat as gone
  }
}

/**
 * Reconcile the on-disk state with process liveness.
 *
 * Terminal states are trusted as-is. A running/paused run whose worker pid is
 * missing or provably gone is "stale". Pending runs can legitimately be
 * pre-fork and pid-less for a moment, so they stay pending. We intentionally do
 * NOT use an updatedAt-timeout heuristic: the worker only rewrites status on
 * state transitions, so a legitimately long-running phase looks "idle" and
 * would be wrongly flagged.
 */
export function reconcileState(rawState: string, pid: number | null): {
  state: RunDisplayState;
  stale: boolean;
} {
  if (TERMINAL_STATES.has(rawState)) {
    return { state: rawState as RunDisplayState, stale: false };
  }
  if (rawState === "running" || rawState === "paused") {
    if (pid == null || isProcessAlive(pid) === false) {
      return { state: "stale", stale: true };
    }
  }
  return { state: (rawState || "pending") as RunDisplayState, stale: false };
}

/**
 * Fold the event stream into a list of agent runs, in start order.
 *
 * Each agent_started opens a new node. A finish/fail event settles the open
 * node carrying the same `agentId` when the event has one (exact pairing);
 * legacy events without agentId fall back to the oldest still-running
 * label+phase match. Opening a fresh node per start (rather than keying by
 * label) keeps loop-until-dry workflows honest — the same label dispatched
 * across rounds shows as distinct runs.
 */
export function foldAgents(events: WorkflowEvent[]): AgentView[] {
  const agents: AgentView[] = [];
  for (const ev of events) applyAgentEvent(agents, ev);
  return agents;
}

const pairKey = (label: unknown, phase: unknown) =>
  `${String(phase ?? "")}\u0000${String(label ?? "")}`;

/**
 * Apply one event to a growing agent list — the incremental form of
 * {@link foldAgents}, shared with the CLI's live view so every observer pairs
 * events identically. Returns what changed: the node a start opened, or the
 * node a finish/fail settled; `{}` for non-agent events and stray finishes.
 */
export function applyAgentEvent(
  agents: AgentView[],
  ev: WorkflowEvent,
): { opened?: AgentView; settled?: AgentView } {
  if (ev.type === "agent_started") {
    const opened: AgentView = {
      agentId: typeof ev.agentId === "number" ? ev.agentId : null,
      label: String(ev.label ?? "agent"),
      phase: ev.phase != null ? String(ev.phase) : null,
      state: "running",
      adapter: ev.adapter != null ? String(ev.adapter) : null,
      attempts: null,
      error: null,
      startedAt: typeof ev.ts === "number" ? ev.ts : null,
      finishedAt: null,
      durationMs: null,
    };
    agents.push(opened);
    return { opened };
  }
  if (ev.type === "agent_finished" || ev.type === "agent_failed") {
    let target: AgentView | undefined;
    if (typeof ev.agentId === "number") {
      // Exact pairing: settle the open node with this dispatch id.
      const id = ev.agentId;
      target = agents.find((a) => a.state === "running" && a.agentId === id);
    } else {
      // Legacy (pre-agentId) events: settle the OLDEST still-running node with
      // the same label+phase. Deterministic compatibility heuristic only —
      // with concurrent same-label agents the duration/attempts attribution
      // is best-effort, not exact.
      const k = pairKey(ev.label, ev.phase);
      target = agents.find(
        (a) => a.state === "running" && a.agentId === null && pairKey(a.label, a.phase) === k,
      );
    }
    if (!target) return {}; // a stray finish with no matching start — ignore
    target.finishedAt = typeof ev.ts === "number" ? ev.ts : null;
    if (target.startedAt !== null && target.finishedAt !== null) {
      target.durationMs = Math.max(0, Math.round((target.finishedAt - target.startedAt) * 1000));
    }
    if (ev.type === "agent_failed") {
      target.state = "failed";
      target.error = ev.error != null ? String(ev.error) : null;
    } else {
      target.state = "done";
      target.adapter = ev.adapter != null ? String(ev.adapter) : null;
      target.attempts = typeof ev.attempts === "number" ? ev.attempts : null;
    }
    return { settled: target };
  }
  return {};
}

function countAgents(agents: AgentView[]): RunCounts {
  let running = 0;
  let done = 0;
  let failed = 0;
  let stale = 0;
  for (const a of agents) {
    if (a.state === "running") running++;
    else if (a.state === "done") done++;
    else if (a.state === "failed") failed++;
    else stale++;
  }
  return { agents: agents.length, running, done, failed, stale };
}

/** Copies of `agents` (folds are cached, so never hand out their nodes), open ones marked stale if asked. */
function copyAgents(agents: AgentView[], stale: boolean): AgentView[] {
  return agents.map((a) => (stale && a.state === "running" ? { ...a, state: "stale" } : { ...a }));
}

function phaseOrderFrom(started: string[], declared: Array<{ title: string }>): string[] {
  const order = [...started];
  for (const d of declared) {
    if (d?.title && !order.includes(d.title)) order.push(d.title);
  }
  return order;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * What a run's summary/detail is derived from, BEFORE liveness reconciliation:
 * the on-disk status + meta and the agents folded from events.jsonl. These are
 * pure functions of the run's files, so a reader may cache them keyed by file
 * signatures — but the pid probe in {@link reconcileState} is not, so it is
 * re-applied by {@link summaryFrom}/{@link detailFrom} on every read (a
 * `kill -9`'d worker changes no file, yet must turn the run stale).
 */
export interface RunFacts {
  status: Record<string, unknown>;
  meta: Record<string, unknown>;
  /** What the event stream folds to (see {@link EventFold}). */
  fold: EventFold;
}

/**
 * Everything the read-model needs from events.jsonl, folded one event at a
 * time so a reader that tails the file (byte cursor) can keep folding where it
 * left off instead of re-reading the whole stream. Liveness-free: open agents
 * stay "running" here; reconciliation happens per read.
 */
export class EventFold {
  /** Agents in start order, open ones still "running". */
  readonly agents: AgentView[] = [];
  /** Phases in the order their phase_started fired. */
  readonly startedPhases: string[] = [];
  /** ts of the last event folded, or null for an empty stream. */
  lastActivityTs: number | null = null;

  apply(events: WorkflowEvent[]): this {
    for (const ev of events) {
      applyAgentEvent(this.agents, ev);
      if (ev.type === "phase_started" && ev.phase != null) {
        const p = String(ev.phase);
        if (!this.startedPhases.includes(p)) this.startedPhases.push(p);
      }
    }
    if (events.length > 0) this.lastActivityTs = asNumber(events[events.length - 1]!.ts);
    return this;
  }
}

/** Read a run's facts from the store (one read of each file). */
export function readFacts(store: RunStore, runId: string, events?: WorkflowEvent[]): RunFacts {
  return {
    status: store.readStatus(runId),
    meta: store.readMeta(runId),
    fold: new EventFold().apply(events ?? store.readEvents(runId)),
  };
}

/**
 * Reconcile liveness and build the run-list summary from cached or fresh
 * facts. Cheap enough to run on every list: one pid probe for a non-terminal
 * run, and a count over the folded agents.
 */
export function summaryFrom(runId: string, facts: RunFacts): RunSummary {
  const { status, meta, fold } = facts;
  const rawState = String(status.state ?? "pending");
  const pid = asNumber(status.pid);
  const { state, stale } = reconcileState(rawState, pid);
  const folded = countAgents(fold.agents);
  // A stale run's open agents will never settle: count them stale, not running.
  const counts = stale ? { ...folded, running: 0, stale: folded.stale + folded.running } : folded;

  const name =
    (status.name as string) || baseName(meta.script as string | undefined) || runId;
  const settled = counts.done + counts.failed;
  const progress = counts.agents > 0 ? settled / counts.agents : 0;

  return {
    runId,
    // Facts come from the ODW RunStore; a Claude run is built by ClaudeRunSource,
    // never here, so this is always "odw".
    provider: "odw",
    state,
    rawState,
    stale,
    name,
    description: (status.description as string) ?? null,
    phases: (status.phases as Array<{ title: string }>) ?? [],
    source: (meta.source as string) ?? null,
    pid,
    createdAt: asNumber(meta.createdAt),
    updatedAt: asNumber(status.updatedAt),
    counts,
    progress,
    lastActivityTs: fold.lastActivityTs,
  };
}

/** Reconcile liveness and build the full detail from cached or fresh facts. */
export function detailFrom(
  runId: string,
  facts: RunFacts,
  extra: { hasResult: boolean; error: { error?: string; stack?: string } | null },
): RunDetail {
  const summary = summaryFrom(runId, facts);
  const { meta, fold } = facts;
  return {
    ...summary,
    script: (meta.script as string) ?? null,
    args: meta.args ?? null,
    agents: copyAgents(fold.agents, summary.stale),
    phaseOrder: phaseOrderFrom(fold.startedPhases, summary.phases),
    hasResult: extra.hasResult,
    error: extra.error,
    origin: (meta.origin as string) ?? null,
    adapter: (meta.adapter as string) ?? null,
    workflowName: (meta.workflowName as string) ?? null,
  };
}

/**
 * Build the lightweight summary used for the run list / sidebar.
 *
 * `events` may be passed in by a caller that already read them so the JSONL
 * file isn't read and parsed twice on one request.
 */
export function summarize(store: RunStore, runId: string, events?: WorkflowEvent[]): RunSummary {
  return summaryFrom(runId, readFacts(store, runId, events));
}

/** Build the full per-run detail (summary + folded agents + phase order). */
export function detail(store: RunStore, runId: string): RunDetail {
  return detailFrom(runId, readFacts(store, runId), {
    hasResult: store.hasResult(runId),
    error: store.readError(runId) as { error?: string; stack?: string } | null,
  });
}

/** Summaries for every known run, newest first. */
export function listSummaries(store: RunStore): RunSummary[] {
  return store
    .listRuns()
    .map((ref) => summarize(store, ref.runId))
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

function baseName(path: string | undefined): string {
  if (!path) return "";
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}
