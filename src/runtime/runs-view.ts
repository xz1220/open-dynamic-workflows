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
 *      We count agents by folding events instead — and exec() command steps
 *      with them, as nodes of their own kind (see {@link RunCounts}).
 *
 *   3. No fabricated progress. There is no declared agent total, so "progress"
 *      here is strictly settled/observed agents — a fraction of work *seen*,
 *      never invented. Likewise usage: a run's tokens and cost are the sum of
 *      what its settled agents' events carry (an ODW extension) — what their
 *      CLIs reported, or chars/4 estimates that stay marked `estimated`.
 */

import { isPermissionTier } from "../adapters/permissions.js";
import type { PermissionTier, TrustLevel } from "../adapters/types.js";
import { addUsage, readUsage, type Usage } from "../adapters/usage.js";
import type { AgentChanges } from "../changes.js";
import type { WaitingCheckpoint } from "../checkpoint.js";
import { readDrift, type RunDrift } from "../drift.js";
import type { WorkflowEvent } from "../events.js";
import { LIMIT_NAMES, type AgentLimits, type LimitHit } from "../limits.js";
import { readCliVersion, type CliVersion } from "../provenance.js";
import { pausedForOf, type PausedFor } from "../quota-wait.js";
import { RunStore, TERMINAL_STATES, type EvalRunTag, type ResolveLink } from "./run-store.js";

export type AgentState = "running" | "done" | "failed" | "stale";

/** The container an agent's CLI ran in (ODW extension; see adapters/sandbox.ts). */
export interface AgentSandbox {
  kind: "container";
  /** null: no engine was found when it started. */
  engine: "docker" | "podman" | null;
  image: string;
  /** "allowlist": only the hosts of `allow`, through its run's egress proxy (see adapters/egress.ts). */
  network: "none" | "default" | "allowlist";
  allow?: string[];
}

/** The limits an agent runs under, and the one it ran into (ODW extension; see limits.ts). */
export interface AgentLimitsView extends AgentLimits {
  hit?: LimitHit;
}

/**
 * One node of a run's graph: an agent() dispatch or, with `kind: "command"`,
 * an exec() step (ODW extension). A command has no agent id, adapter or
 * attempts; it carries its `commandId` and, once settled, its `exitCode`.
 */
export interface AgentView {
  /** Stable per-dispatch id from the engine (null for pre-agentId event files, and for commands). */
  agentId: number | null;
  /** "command" for an exec() step; "agent" for everything else (Claude Code runs included). */
  kind: "agent" | "command";
  /** Display label (the `label`/adapter/`agent` passed to agent(); for a command, its label or command). */
  label: string;
  /** Phase the call was made under, or null if none was active. */
  phase: string | null;
  state: AgentState;
  adapter: string | null;
  attempts: number | null;
  error: string | null;
  /**
   * Why a failed agent's CLI failed (agent_failed's `reason`): rate_limit,
   * quota, auth, timeout, stalled, not_found, permission or exit — or, ODW
   * extensions, empty_reply, unmet_expectation, mcp_unavailable, runaway, orphaned_background and out_of_scope. Absent while running, for
   * other failures (schema, stop) and for older event files.
   */
  failureReason?: string;
  /**
   * Agents only (ODW extension): the `expect` checks a failed agent's work did
   * not meet (agent_failed's `misses`, with reason "unmet_expectation"), one
   * line each. Absent otherwise.
   */
  misses?: string[];
  /**
   * Agents only (ODW extension): the tool calls its CLI refused under a reply
   * that stood anyway (agent_finished's `denied`), one line each. Absent otherwise.
   */
  denied?: string[];
  /**
   * Agents only (ODW extension): the background work its CLI left running
   * under a reply that stood anyway (agent_finished's `orphaned`), one line
   * each. Absent otherwise.
   */
  orphaned?: string[];
  /**
   * Agents only (ODW extension; see scope.ts): the files it declared it means
   * to change — agent_started's `scope`. Absent: no scope.
   */
  scope?: string[];
  /**
   * Agents only (ODW extension; see scope.ts): the files it changed outside
   * its scope — its terminal event's `outOfScope`. Absent otherwise.
   */
  outOfScope?: string[];
  startedAt: number | null;
  finishedAt: number | null;
  /** Wall-clock from agent_started to agent_finished/failed, in ms (a command's own measurement). */
  durationMs: number | null;
  /** Replayed from an earlier run's saved result by `odw resume` (no agent ran). */
  cached: boolean;
  /** Commands only: the per-run step id that pairs its events. */
  commandId?: number | null;
  /** Commands only: the exit status once settled; null while running or when a signal ended it. */
  exitCode?: number | null;
  /**
   * Commands only (ODW extension): the agent whose `expect.command` check
   * this step is — it belongs under that agent. Absent for exec() steps.
   */
  forAgentId?: number;
  /**
   * What a settled agent spent (its event's `usage`; ODW extension): tokens
   * and cost as its CLI reported them, `estimated` where output tokens are
   * chars/4 of its replies. Absent while running and for older event files.
   */
  usage?: Usage;
  /**
   * Agents only (ODW extension): what an isolated agent changed — the diffstat
   * of its kept diff, `GET /api/runs/:id/agents/:agentId/diff` — once it
   * settled; null when it kept none.
   */
  changes?: AgentChanges | null;
  /** Agents only: the branch its change was kept on (`keep: true`, `keepBranches`), else null. */
  branch?: string | null;
  /**
   * Agents only (ODW extension): the permission tier its CLI runs at —
   * agent_started's `permissions`. Absent for older event files.
   */
  permissions?: PermissionTier;
  /**
   * Agents only (ODW extension): `untrusted` when its CLI runs untrusted —
   * agent_started's `trust` (see adapters/trust.ts). Absent: trusted.
   */
  trust?: TrustLevel;
  /**
   * Agents only (ODW extension): the container its CLI runs in — engine,
   * image and network — agent_started's `sandbox` (see adapters/sandbox.ts).
   * Absent: on the host.
   */
  sandbox?: AgentSandbox;
  /**
   * Agents only (ODW extension): the limits it runs under — agent_started's
   * `limits` (see limits.ts) — and, once it ran into one, `hit`: the limit,
   * what it reached and the evidence (agent_failed's `limitHit`, reason
   * "runaway"). Absent: no limits.
   */
  limits?: AgentLimitsView;
  /**
   * Agents only (ODW extension): the adapters it fell back from, in order —
   * their quota was spent or their login refused — before `adapter`, the one
   * it runs on now and, once settled, the one that produced its value (or
   * failed last). Absent when it never left the adapter it started on.
   */
  fellBackFrom?: string[];
  /**
   * Agents only (ODW extension: quotaWait): while a running agent waits for
   * `adapter`'s spent quota to reset — holding no slot — that adapter and when
   * its CLI said the quota resets (epoch seconds). Absent otherwise.
   */
  quotaWait?: { adapter: string; resumeAt?: number };
  /**
   * Agents only (ODW extension): the MCP servers its CLI started it without —
   * any status but "connected" (Claude Code's init event) — on its terminal
   * event. Absent otherwise.
   */
  mcp?: Array<{ name: string; status: string }>;
}

export type RunDisplayState =
  | "pending"
  | "running"
  | "paused"
  | "done"
  | "failed"
  | "stopped"
  | "stale"
  /** Running, and a checkpoint() waits for a person to approve or reject (ODW extension). */
  | "waiting";

/** A checkpoint() waiting for a person's answer (ODW extension), as folded from its request. */
export interface PendingCheckpoint {
  checkpointId: number;
  title: string;
  /** What the person should look at: JSON-safe, at most 64 KiB (null when none was given). */
  payload: unknown;
  /** The payload was cut to fit its event: `payload` holds only its start, as text. Absent otherwise. */
  truncated?: boolean;
  /** The JSON Schema an approval's edited payload must match; absent when the checkpoint has none. */
  schema?: Record<string, unknown>;
  /** When it started waiting (epoch seconds). */
  since: number;
}

/**
 * Tallies over every node of the run's graph. exec() command steps count like
 * agents here — `agents` is the node total, so `running + done + failed +
 * stale === agents` holds and progress covers them — but they are not agent
 * dispatches: `status.dispatched`, `odw status` and the maxAgents backstop
 * count agents only.
 */
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
  /** settled (done+failed) / agents, in [0,1]; 0 when no agents seen yet. Commands included. */
  progress: number;
  lastActivityTs: number | null;
  /**
   * The run's tokens and cost so far (ODW extension): the sum of its settled
   * agents' usage — a field only some reported is the sum of theirs — with
   * `estimated` when some agent's output tokens are a chars/4 estimate. Null
   * before any agent settled with usage; absent for Claude Code runs.
   */
  usage?: Usage | null;
  /**
   * The oldest checkpoint() waiting for a person while the run is "waiting"
   * (ODW extension) — what the dashboard's "Needs you" strip shows; null
   * otherwise, and absent for Claude Code runs.
   */
  waiting?: WaitingCheckpoint | null;
  /**
   * What a "paused" run waits for when its agents wait for an adapter's
   * spent quota to reset (ODW extension: quotaWait) — `{ reason: "quota",
   * adapter, resumeAt }`, resumeAt in epoch seconds; null otherwise, and
   * absent for Claude Code runs.
   */
  pausedFor?: PausedFor | null;
  /**
   * The run is a shared bundle opened by `odw serve --open FILE.odwrun` (ODW
   * extension; see ./bundle): when it was bundled and by which odw. Absent otherwise.
   */
  bundle?: { bundledAt: number | null; odwVersion: string | null };
  /**
   * A run `odw eval` started (meta.origin "eval"; ODW extension): the eval's
   * name, the case, the adapter and the repeat. Absent for every other run.
   */
  eval?: EvalRunTag;
  /** A dry run (`odw run --dry`; meta.dry, ODW extension): every agent got a stub, no model was called. Absent otherwise. */
  dry?: true;
  /**
   * What changed under the workflow since its previous run (ODW extension;
   * see ../drift): the run compared with, and each CLI version or requested
   * model that differs. Absent when nothing did.
   */
  drift?: RunDrift;
}

export interface RunDetail extends RunSummary {
  script: string | null;
  /** The run's input as given — as served (`odw serve`), with its token shapes redacted (ODW extension). */
  args: unknown;
  /** Token shapes in `args` were replaced by `«redacted:<kind>»` before it was served (ODW extension). */
  argsRedacted?: boolean;
  agents: AgentView[];
  /** Phases in the order their phase_started fired, plus any declared-not-started. */
  phaseOrder: string[];
  hasResult: boolean;
  error: { error?: string; stack?: string } | null;
  /** Where the run was initiated from (meta.origin, e.g. "chat"); null for CLI runs. */
  origin: string | null;
  /** A resolver run of `odw apply --resolve` (origin "apply-resolve"; ODW extension): the run and agent it resolved. */
  applyResolve?: ResolveLink;
  /** The resolver runs `odw apply --resolve` started for this run's agents (ODW extension); absent when none. */
  resolvedBy?: ResolveLink[];
  /** Run-level adapter override recorded at launch (meta.adapter), if any. */
  adapter: string | null;
  /** The workflow identity recorded at create time (meta.workflowName). */
  workflowName: string | null;
  /**
   * checkpoint() calls waiting for an answer, oldest first (ODW extension):
   * what `POST /api/runs/:id/checkpoint` can approve or reject. Empty unless
   * the run is live (neither ended nor stale); absent for Claude Code runs.
   */
  pendingCheckpoints?: PendingCheckpoint[];
  /**
   * What ran (ODW extension; see ../provenance): each adapter CLI's version
   * as the run recorded it on the adapter's first dispatch (`version` null
   * when the CLI did not tell, with `error`), by adapter; odw's version and
   * the sha256 of the workflow source as launched (null for older runs).
   * Absent for Claude Code runs.
   */
  cliVersions?: Record<string, CliVersion>;
  odwVersion?: string | null;
  sourceHash?: string | null;
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
 *
 * exec() steps fold the same way into `kind: "command"` nodes: command_started
 * opens one, command_finished/failed settles the open one with the same
 * `commandId`.
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
 * node a finish/fail settled; `{}` for other events and stray finishes.
 */
export function applyAgentEvent(
  agents: AgentView[],
  ev: WorkflowEvent,
): { opened?: AgentView; settled?: AgentView } {
  if (ev.type === "command_started" || ev.type === "command_finished" || ev.type === "command_failed") {
    return applyCommandEvent(agents, ev);
  }
  if (ev.type === "log") {
    if (typeof ev.agentId !== "number" || typeof ev.adapter !== "string") return {};
    const target = agents.find((a) => a.state === "running" && a.agentId === ev.agentId);
    if (!target) return {};
    // A call out of quota waits for a reset (ODW extension: quotaWait) until
    // its log line says it goes on.
    if (ev.quotaWait === "start") {
      target.quotaWait = { adapter: ev.adapter, ...(typeof ev.resumeAt === "number" ? { resumeAt: ev.resumeAt } : {}) };
    } else if (ev.quotaWait === "end") {
      delete target.quotaWait;
    }
    // A fallback (ODW extension) moves a running agent to another adapter:
    // its log line names the adapter and every one the agent has left.
    const from = adapterNames(ev.fellBackFrom);
    if (from) {
      target.adapter = ev.adapter;
      target.fellBackFrom = from;
    }
    return {};
  }
  if (ev.type === "agent_started") {
    const opened: AgentView = {
      agentId: typeof ev.agentId === "number" ? ev.agentId : null,
      kind: "agent",
      label: String(ev.label ?? "agent"),
      phase: ev.phase != null ? String(ev.phase) : null,
      state: "running",
      adapter: ev.adapter != null ? String(ev.adapter) : null,
      attempts: null,
      error: null,
      startedAt: typeof ev.ts === "number" ? ev.ts : null,
      finishedAt: null,
      durationMs: null,
      cached: ev.cached === true,
      changes: null,
      branch: null,
    };
    if (isPermissionTier(ev.permissions)) opened.permissions = ev.permissions;
    if (ev.trust === "untrusted") opened.trust = "untrusted";
    const sandbox = agentSandbox(ev.sandbox);
    if (sandbox) opened.sandbox = sandbox;
    const limits = agentLimits(ev.limits);
    if (limits) opened.limits = limits;
    const scope = strings(ev.scope);
    if (scope) opened.scope = scope;
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
        (a) =>
          a.kind === "agent" && a.state === "running" && a.agentId === null && pairKey(a.label, a.phase) === k,
      );
    }
    if (!target) return {}; // a stray finish with no matching start — ignore
    delete target.quotaWait;
    target.finishedAt = typeof ev.ts === "number" ? ev.ts : null;
    if (target.startedAt !== null && target.finishedAt !== null) {
      target.durationMs = Math.max(0, Math.round((target.finishedAt - target.startedAt) * 1000));
    }
    const usage = readUsage(ev.usage);
    if (usage) target.usage = usage;
    // What an isolated agent changed, finished or failed (ODW extension).
    target.changes = agentChanges(ev.changes);
    target.branch = typeof ev.branch === "string" && ev.branch !== "" ? ev.branch : null;
    // The adapters it fell back from, finished or failed (ODW extension).
    const from = adapterNames(ev.fellBackFrom);
    if (from) target.fellBackFrom = from;
    // The MCP servers its CLI started it without, finished or failed (ODW extension).
    const mcp = mcpServers(ev.mcp);
    if (mcp) target.mcp = mcp;
    // What it changed outside its declared scope, finished or failed (ODW extension).
    const outOfScope = strings(ev.outOfScope);
    if (outOfScope) target.outOfScope = outOfScope;
    if (ev.type === "agent_failed") {
      target.state = "failed";
      target.error = ev.error != null ? String(ev.error) : null;
      if (typeof ev.reason === "string" && ev.reason !== "") target.failureReason = ev.reason;
      // One that fell back failed on the adapter its event names.
      if (from && typeof ev.adapter === "string") target.adapter = ev.adapter;
      const misses = strings(ev.misses);
      if (misses) target.misses = misses;
      // The limit a runaway ran into (ODW extension).
      const hit = limitHit(ev.limitHit);
      if (hit) target.limits = { ...target.limits, hit };
    } else {
      const denied = strings(ev.denied);
      if (denied) target.denied = denied;
      const orphaned = strings(ev.orphaned);
      if (orphaned) target.orphaned = orphaned;
      target.state = "done";
      target.adapter = ev.adapter != null ? String(ev.adapter) : null;
      target.attempts = typeof ev.attempts === "number" ? ev.attempts : null;
      target.cached = ev.cached === true;
    }
    return { settled: target };
  }
  return {};
}

/** The exec() half of {@link applyAgentEvent}: command_* events open and settle command nodes. */
function applyCommandEvent(
  agents: AgentView[],
  ev: WorkflowEvent,
): { opened?: AgentView; settled?: AgentView } {
  const commandId = typeof ev.commandId === "number" ? ev.commandId : null;
  if (ev.type === "command_started") {
    const opened: AgentView = {
      agentId: null,
      kind: "command",
      cached: false,
      label: String(ev.label ?? ev.command ?? "command"),
      phase: ev.phase != null ? String(ev.phase) : null,
      state: "running",
      adapter: null,
      attempts: null,
      error: null,
      startedAt: typeof ev.ts === "number" ? ev.ts : null,
      finishedAt: null,
      durationMs: null,
      commandId,
      exitCode: null,
    };
    if (typeof ev.forAgentId === "number") opened.forAgentId = ev.forAgentId;
    agents.push(opened);
    return { opened };
  }
  // The engine always sends commandId; without one, pair by label+phase as for legacy agents.
  const k = pairKey(ev.label, ev.phase);
  const target = agents.find(
    (a) =>
      a.kind === "command" &&
      a.state === "running" &&
      (commandId !== null ? a.commandId === commandId : pairKey(a.label, a.phase) === k),
  );
  if (!target) return {};
  target.finishedAt = typeof ev.ts === "number" ? ev.ts : null;
  // The command measured itself; the event timestamps are the fallback.
  if (typeof ev.durationMs === "number" && Number.isFinite(ev.durationMs)) {
    target.durationMs = Math.max(0, Math.round(ev.durationMs));
  } else if (target.startedAt !== null && target.finishedAt !== null) {
    target.durationMs = Math.max(0, Math.round((target.finishedAt - target.startedAt) * 1000));
  }
  target.exitCode = typeof ev.exitCode === "number" ? ev.exitCode : null;
  if (ev.type === "command_failed") {
    target.state = "failed";
    target.error = ev.error != null ? String(ev.error) : null;
  } else {
    target.state = "done";
  }
  return { settled: target };
}

/** An event's `fellBackFrom`, when it lists adapters (ODW extension); undefined otherwise. */
function adapterNames(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every((name) => typeof name === "string")) return undefined;
  return [...(raw as string[])];
}

/** An event's `mcp`, when it lists servers `{ name, status }` (ODW extension); undefined otherwise. */
function mcpServers(raw: unknown): Array<{ name: string; status: string }> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const servers = raw
    .filter((s): s is { name: string; status: string } => typeof s?.name === "string" && typeof s?.status === "string")
    .map(({ name, status }) => ({ name, status }));
  return servers.length > 0 ? servers : undefined;
}

/** An event's `sandbox`, when it names a container (ODW extension); undefined otherwise. */
function agentSandbox(raw: unknown): AgentSandbox | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const { kind, engine, image, network, allow } = raw as Record<string, unknown>;
  if (kind !== "container" || typeof image !== "string") return undefined;
  return {
    kind,
    engine: engine === "docker" || engine === "podman" ? engine : null,
    image,
    network: network === "none" ? "none" : network === "allowlist" ? "allowlist" : "default",
    ...(network === "allowlist" && Array.isArray(allow) ? { allow: allow.filter((h): h is string => typeof h === "string") } : {}),
  };
}

/** An event's `limits`, the numbers it sets (ODW extension); undefined when it sets none. */
function agentLimits(raw: unknown): AgentLimits | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const limits: AgentLimits = {};
  for (const name of LIMIT_NAMES) {
    const value = (raw as Record<string, unknown>)[name];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) limits[name] = value;
  }
  return Object.keys(limits).length > 0 ? limits : undefined;
}

/** An event's `limitHit`, when it names a limit (ODW extension); undefined otherwise. */
function limitHit(raw: unknown): LimitHit | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const { limit, max, value, evidence } = raw as Record<string, unknown>;
  if (!(LIMIT_NAMES as readonly unknown[]).includes(limit) || typeof evidence !== "string") return undefined;
  const number = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) ? n : 0);
  return { limit: limit as LimitHit["limit"], max: number(max), value: number(value), evidence };
}

/** An event's `changes`, when it is a diffstat; null otherwise. */
function agentChanges(raw: unknown): AgentChanges | null {
  if (raw === null || typeof raw !== "object") return null;
  const { files, insertions, deletions, truncated } = raw as Record<string, unknown>;
  const count = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0);
  if (count(files) === 0) return null;
  return { files: count(files), insertions: count(insertions), deletions: count(deletions), truncated: truncated === true };
}

/** Tally nodes — agents and commands alike — by state (shared by the ODW and Claude run sources). */
export function countAgents(agents: AgentView[]): RunCounts {
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
  return agents.map((a) => {
    const copy: AgentView = stale && a.state === "running" ? { ...a, state: "stale" } : { ...a };
    if (a.usage) copy.usage = { ...a.usage };
    if (a.fellBackFrom) copy.fellBackFrom = [...a.fellBackFrom];
    if (a.quotaWait) copy.quotaWait = { ...a.quotaWait };
    if (a.mcp) copy.mcp = a.mcp.map((server) => ({ ...server }));
    if (a.misses) copy.misses = [...a.misses];
    if (a.denied) copy.denied = [...a.denied];
    if (a.limits) copy.limits = { ...a.limits, ...(a.limits.hit ? { hit: { ...a.limits.hit } } : {}) };
    if (a.orphaned) copy.orphaned = [...a.orphaned];
    if (a.scope) copy.scope = [...a.scope];
    if (a.outOfScope) copy.outOfScope = [...a.outOfScope];
    return copy;
  });
}

/** An event's list of lines (`misses`, `denied`), when it has any. */
function strings(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const lines = raw.filter((line): line is string => typeof line === "string");
  return lines.length > 0 ? lines : undefined;
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
  /** checkpoint() calls requested and not resolved yet, by id; cleared when the run ends. */
  readonly checkpoints = new Map<number, PendingCheckpoint>();
  /** ts of the last event folded, or null for an empty stream. */
  lastActivityTs: number | null = null;
  /** The run's own terminal event (run_finished/failed/stopped) has been folded. */
  ended = false;
  /** What the settled agents spent, summed as they settle (see RunSummary.usage). */
  usage: Usage | undefined;
  /** Each adapter CLI's version, from the run's cli_version events (ODW extension). */
  readonly cliVersions: Record<string, CliVersion> = {};
  /** What drifted since the workflow's previous run, from the run's drift log lines (ODW extension). */
  drift: RunDrift | undefined;

  apply(events: WorkflowEvent[]): this {
    for (const ev of events) {
      const { settled } = applyAgentEvent(this.agents, ev);
      if (settled?.usage) this.usage = addUsage(this.usage, settled.usage);
      applyCheckpointEvent(this.checkpoints, ev);
      const cli = readCliVersion(ev);
      if (cli) this.cliVersions[cli.adapter] = cli.cli;
      const drifted = readDrift(ev);
      if (drifted) {
        const { since, ...change } = drifted;
        this.drift ??= { since, changes: [] };
        this.drift.changes.push(change);
      }
      if (ev.type === "run_finished" || ev.type === "run_failed" || ev.type === "run_stopped") {
        this.ended = true;
        this.checkpoints.clear(); // nobody waits on a run that ended
      }
      if (ev.type === "phase_started" && ev.phase != null) {
        const p = String(ev.phase);
        if (!this.startedPhases.includes(p)) this.startedPhases.push(p);
      }
    }
    if (events.length > 0) this.lastActivityTs = asNumber(events[events.length - 1]!.ts);
    return this;
  }
}

/** checkpoint_requested opens a pending checkpoint; checkpoint_resolved closes it. */
function applyCheckpointEvent(pending: Map<number, PendingCheckpoint>, ev: WorkflowEvent): void {
  if (typeof ev.checkpointId !== "number") return;
  if (ev.type === "checkpoint_requested") {
    const schema = ev.schema;
    pending.set(ev.checkpointId, {
      checkpointId: ev.checkpointId,
      title: String(ev.title ?? ""),
      payload: ev.payload ?? null,
      ...(ev.truncated === true ? { truncated: true } : {}),
      ...(schema !== null && typeof schema === "object" && !Array.isArray(schema) ? { schema: schema as Record<string, unknown> } : {}),
      since: asNumber(ev.ts) ?? 0,
    });
  } else if (ev.type === "checkpoint_resolved") {
    pending.delete(ev.checkpointId);
  }
}

/** The pending checkpoints of a fold, oldest first, as copies (folds are cached). */
export function pendingCheckpoints(fold: EventFold): PendingCheckpoint[] {
  return [...fold.checkpoints.values()].sort((a, b) => a.checkpointId - b.checkpointId).map((cp) => ({ ...cp }));
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
  const reconciled = reconcileState(rawState, pid);
  const { stale } = reconciled;
  // A live, running run that waits at a checkpoint() shows as "waiting"; every
  // other mapping (paused included) stands as reconciled.
  const state: RunDisplayState =
    reconciled.state === "running" && fold.checkpoints.size > 0 ? "waiting" : reconciled.state;
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
    usage: fold.usage ? { ...fold.usage } : null,
    waiting: state === "waiting" ? oldestWaiting(fold) : null,
    // Only a live paused run waits for a quota; a stale one's worker is gone.
    pausedFor: state === "paused" ? pausedForOf(status.pausedFor) : null,
    ...(meta.bundle ? { bundle: bundleOf(meta.bundle) } : {}),
    ...evalTagOf(meta),
    ...(meta.dry === true ? { dry: true as const } : {}),
    ...(fold.drift ? { drift: { since: fold.drift.since, changes: fold.drift.changes.map((c) => ({ ...c })) } } : {}),
  };
}

/** meta.bundle as a summary carries it: a shared bundle's when and by which odw. */
function bundleOf(value: unknown): { bundledAt: number | null; odwVersion: string | null } {
  const b = (value !== null && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return { bundledAt: asNumber(b.bundledAt), odwVersion: typeof b.odwVersion === "string" ? b.odwVersion : null };
}

/** `{ eval }` for a run `odw eval` started, as its meta.json names it; `{}` for any other. */
export function evalTagOf(meta: Record<string, unknown>): { eval?: EvalRunTag } {
  const tag = meta.eval as Partial<EvalRunTag> | null | undefined;
  if (meta.origin !== "eval" || !tag || typeof tag !== "object") return {};
  if (typeof tag.name !== "string" || typeof tag.case !== "string" || typeof tag.adapter !== "string") return {};
  return { eval: { name: tag.name, case: tag.case, adapter: tag.adapter, repeat: typeof tag.repeat === "number" ? tag.repeat : 1 } };
}

/** meta.json's links of `odw apply --resolve` — `applyResolve`, `resolvedBy` — the well-formed ones. */
function resolveLinksOf(meta: Record<string, unknown>): { applyResolve?: ResolveLink; resolvedBy?: ResolveLink[] } {
  const link = (value: unknown): ResolveLink | null => {
    const v = (value !== null && typeof value === "object" ? value : {}) as Record<string, unknown>;
    return typeof v.runId === "string" && typeof v.agentId === "number" ? { runId: v.runId, agentId: v.agentId } : null;
  };
  const of = link(meta.applyResolve);
  const by = Array.isArray(meta.resolvedBy) ? meta.resolvedBy.map(link).filter((l): l is ResolveLink => l !== null) : [];
  return { ...(of ? { applyResolve: of } : {}), ...(by.length > 0 ? { resolvedBy: by } : {}) };
}

/** The oldest checkpoint a fold has waiting, as status.json's `waiting` names it. */
function oldestWaiting(fold: EventFold): WaitingCheckpoint | null {
  let oldest: PendingCheckpoint | undefined;
  for (const cp of fold.checkpoints.values()) if (!oldest || cp.checkpointId < oldest.checkpointId) oldest = cp;
  return oldest ? { checkpointId: oldest.checkpointId, title: oldest.title, since: oldest.since } : null;
}

/** Reconcile liveness and build the full detail from cached or fresh facts. */
export function detailFrom(
  runId: string,
  facts: RunFacts,
  extra: { hasResult: boolean; error: { error?: string; stack?: string } | null },
): RunDetail {
  const summary = summaryFrom(runId, facts);
  const { meta, fold } = facts;
  // Only a live run can still be answered: a stale one's worker is gone.
  const live = !summary.stale && !TERMINAL_STATES.has(summary.rawState);
  return {
    ...summary,
    script: (meta.script as string) ?? null,
    args: meta.args ?? null,
    agents: copyAgents(fold.agents, summary.stale),
    phaseOrder: phaseOrderFrom(fold.startedPhases, summary.phases),
    hasResult: extra.hasResult,
    error: extra.error,
    origin: (meta.origin as string) ?? null,
    ...resolveLinksOf(meta),
    adapter: (meta.adapter as string) ?? null,
    workflowName: (meta.workflowName as string) ?? null,
    pendingCheckpoints: live ? pendingCheckpoints(fold) : [],
    cliVersions: Object.fromEntries(Object.entries(fold.cliVersions).map(([name, cli]) => [name, { ...cli }])),
    odwVersion: typeof meta.odwVersion === "string" ? meta.odwVersion : null,
    sourceHash: typeof meta.sourceHash === "string" ? meta.sourceHash : null,
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

function baseName(path: string | undefined): string {
  if (!path) return "";
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}
