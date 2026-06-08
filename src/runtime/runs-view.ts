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
 * Each agent_started opens a new node; the next matching (label+phase)
 * agent_finished/agent_failed that is still open settles it. Opening a fresh
 * node per start (rather than keying by label) keeps loop-until-dry workflows
 * honest — the same label dispatched across rounds shows as distinct runs.
 */
export function foldAgents(events: WorkflowEvent[]): AgentView[] {
  const agents: AgentView[] = [];
  const key = (label: unknown, phase: unknown) => `${String(phase ?? "")}\u0000${String(label ?? "")}`;

  for (const ev of events) {
    if (ev.type === "agent_started") {
      agents.push({
        label: String(ev.label ?? "agent"),
        phase: ev.phase != null ? String(ev.phase) : null,
        state: "running",
        adapter: ev.adapter != null ? String(ev.adapter) : null,
        attempts: null,
        error: null,
        startedAt: typeof ev.ts === "number" ? ev.ts : null,
        finishedAt: null,
        durationMs: null,
      });
      continue;
    }
    if (ev.type === "agent_finished" || ev.type === "agent_failed") {
      const k = key(ev.label, ev.phase);
      // Settle the most recent still-running node with the same label+phase.
      let target: AgentView | undefined;
      for (let i = agents.length - 1; i >= 0; i--) {
        const a = agents[i]!;
        if (a.state === "running" && key(a.label, a.phase) === k) {
          target = a;
          break;
        }
      }
      if (!target) continue; // a stray finish with no matching start — ignore
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
    }
  }
  return agents;
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

function staleOpenAgents(agents: AgentView[]): AgentView[] {
  return agents.map((a) => (a.state === "running" ? { ...a, state: "stale" } : a));
}

function phaseOrderFrom(events: WorkflowEvent[], declared: Array<{ title: string }>): string[] {
  const order: string[] = [];
  for (const ev of events) {
    if (ev.type === "phase_started" && ev.phase != null) {
      const p = String(ev.phase);
      if (!order.includes(p)) order.push(p);
    }
  }
  for (const d of declared) {
    if (d?.title && !order.includes(d.title)) order.push(d.title);
  }
  return order;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Build the lightweight summary used for the run list / sidebar.
 *
 * `events` may be passed in by a caller that already read them (e.g. detail())
 * so the JSONL file isn't read and parsed twice on one request.
 */
export function summarize(store: RunStore, runId: string, events?: WorkflowEvent[]): RunSummary {
  const status = store.readStatus(runId);
  const meta = store.readMeta(runId);
  const evs = events ?? store.readEvents(runId);
  const rawState = String(status.state ?? "pending");
  const pid = asNumber(status.pid);
  const { state, stale } = reconcileState(rawState, pid);
  const agents = stale ? staleOpenAgents(foldAgents(evs)) : foldAgents(evs);
  const counts = countAgents(agents);

  const name =
    (status.name as string) || baseName(meta.script as string | undefined) || runId;
  const settled = counts.done + counts.failed;
  const progress = counts.agents > 0 ? settled / counts.agents : 0;
  const lastActivityTs = evs.length > 0 ? asNumber(evs[evs.length - 1]!.ts) : null;

  return {
    runId,
    // summarize() reads the ODW RunStore; a Claude run is built by ClaudeRunSource,
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
    lastActivityTs,
  };
}

/** Build the full per-run detail (summary + folded agents + phase order). */
export function detail(store: RunStore, runId: string): RunDetail {
  const events = store.readEvents(runId);
  const base = summarize(store, runId, events);
  const meta = store.readMeta(runId);
  const agents = base.stale ? staleOpenAgents(foldAgents(events)) : foldAgents(events);
  return {
    ...base,
    script: (meta.script as string) ?? null,
    args: meta.args ?? null,
    agents,
    phaseOrder: phaseOrderFrom(events, base.phases),
    hasResult: store.hasResult(runId),
    error: store.readError(runId) as { error?: string; stack?: string } | null,
  };
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
