/**
 * `odw compare` (an ODW extension): what changed between two runs (L5).
 *
 * People re-run a workflow after editing a prompt, switching adapter or model,
 * or upgrading a CLI, and want to know what changed: cost, time, which agents
 * failed, whether their replies differ. {@link compareRuns} is pure — two runs
 * in ({@link readCompareRun} reads one from its run directory), one
 * {@link RunComparison} out — and is what `odw compare --json` prints and
 * `GET /api/compare` serves; {@link formatComparison} is the CLI's table.
 *
 * Agents are matched across the runs, each at most once, in passes:
 *   1. by label: a label each run gives exactly one agent;
 *   2. by the call key `odw resume` replays by (journal.resumeKey — the same
 *      prompt and options are the same call), in call order;
 *   3. by order within the phase: agents with the same label first, then the
 *      rest by position.
 * An agent left over is in one run only (`only-a`, `only-b`). A run still
 * going is compared as it stands — its running agents have no reply yet —
 * and a note says so.
 *
 * The comparison is a wire contract; its keys are stable:
 *
 *   version   1 — it changes when a key changes meaning
 *   a, b      each run: runId, name, workflowName, state, live (still going),
 *             createdAt, odwVersion, sourceHash, resumedFrom
 *   notes     how to read it, a sentence each
 *   setup     [{ field, a, b }]: what the runs ran with that differs — source
 *             (sha256 of the workflow), script, args, odwVersion, budget,
 *             cliVersion.<adapter>, settings.<key> (the knobs that change
 *             behaviour), adapterDefinition.<adapter> (a fingerprint), adapter
 *             and permissions (runs without a recorded setup), adaptersUsed,
 *             modelsUsed
 *   totals    wallMs, inputTokens, outputTokens, costUsd, agents, done,
 *             failed: each { a, b, delta } (delta = b − a, null when either is
 *             unknown); estimated: { a, b } (some output tokens are chars/4)
 *   agents    a row per agent of either run, in A's phase and call order:
 *             match    "label" | "key" | "order"; null when one run has it
 *             outcome  "unchanged" | "newly-failed" | "fixed" | "only-a" | "only-b"
 *             label, phase
 *             a, b     the agent in each run, or null: agentId, label, phase,
 *                      state, adapter, model, attempts, durationMs, inputTokens,
 *                      outputTokens, costUsd, estimated, replayed,
 *                      failureReason, error, changes (its kept diff's files and
 *                      +/- lines, null when it kept none)
 *             delta    b − a of durationMs, inputTokens, outputTokens, costUsd, attempts
 *             reply    status "identical" | "differs" | "none" (a side has no
 *                      saved reply: it failed, runs, or predates saved
 *                      results); kind "text" | "json" | null; a text reply's
 *                      diff (unified-diff lines, at most 40, each cut to 200
 *                      characters) with added/removed over the whole reply; a
 *                      structured reply's paths ([{ path, op: changed | added |
 *                      removed, a, b }], at most 20, values as compact JSON cut
 *                      to 200 characters) with changed; truncated when cut
 */

import { addUsage, type Usage } from "../adapters/usage.js";
import type { AgentChanges } from "../changes.js";
import { AGENT_STARTED, RUN_FAILED, RUN_FINISHED, RUN_STARTED, RUN_STOPPED } from "../events.js";
import { stableJson, type AgentResultRecord } from "../journal.js";
import { cliVersionsOf, type CliVersion, type RunSetup } from "../provenance.js";
import {
  displayWidth,
  fmtDuration,
  fmtTokens,
  fmtUsd,
  padEndWidth,
  palette,
  sanitizeText,
  truncateToWidth,
  type Palette,
  type TermCaps,
} from "../tty.js";
import { colorDiff } from "./changes-view.js";
import { TERMINAL_STATES, type RunStore } from "./run-store.js";
import { detailFrom, readFacts, type AgentState } from "./runs-view.js";

// --- what goes in --------------------------------------------------------------

/** One agent of a run, as {@link compareRuns} reads it. */
export interface RunAgent {
  agentId: number | null;
  label: string;
  phase: string | null;
  /** Its call's resume key (journal.resumeKey): its agent_started event's, else its saved record's. */
  key: string | null;
  state: AgentState;
  adapter: string | null;
  /** The model it asked for, as its agent_started event says — a tier keeps its `@` name. */
  model: string | null;
  attempts: number | null;
  durationMs: number | null;
  usage: Usage | null;
  /** Replayed from an earlier run by `odw resume`: no CLI ran. */
  cached: boolean;
  error: string | null;
  failureReason: string | null;
  changes: AgentChanges | null;
  /** Its saved reply — the text, or the validated JSON value — when it has one. */
  reply?: { value: unknown };
}

/** A run as {@link compareRuns} reads it: what {@link readCompareRun} gathers from its directory. */
export interface CompareRunInput {
  runId: string;
  name: string;
  workflowName: string | null;
  state: string;
  /** Still going (pending, running, paused, waiting): compared as it stands. */
  live: boolean;
  createdAt: number | null;
  /** Epoch seconds: its run_started event (else its creation), and its end — or, still going, now. */
  startedAt: number | null;
  endedAt: number | null;
  script: string | null;
  /** Launched from inline source: its script lives in its own run directory. */
  inline: boolean;
  args: unknown;
  adapter: string | null;
  permissions: string | null;
  budgetTotal: number | null;
  odwVersion: string | null;
  sourceHash: string | null;
  resumedFrom: string | null;
  /** What it started with (its run_started event's `setup`); null for runs from before setups were recorded. */
  setup: RunSetup | null;
  cliVersions: Record<string, CliVersion>;
  /** Its agents (exec() steps aside), in call order. */
  agents: RunAgent[];
}

// --- what comes out ------------------------------------------------------------

export type AgentMatch = "label" | "key" | "order";
export type AgentOutcome = "unchanged" | "newly-failed" | "fixed" | "only-a" | "only-b";

export interface RunComparison {
  version: 1;
  a: CompareRunInfo;
  b: CompareRunInfo;
  notes: string[];
  setup: SetupChange[];
  totals: CompareTotals;
  agents: AgentComparison[];
}

export interface CompareRunInfo {
  runId: string;
  name: string;
  workflowName: string | null;
  state: string;
  live: boolean;
  createdAt: number | null;
  odwVersion: string | null;
  sourceHash: string | null;
  resumedFrom: string | null;
}

/** Something the two runs ran with that differs: `field` (see the module comment), as each recorded it (null: unknown). */
export interface SetupChange {
  field: string;
  a: unknown;
  b: unknown;
}

/** One figure of both runs, and B − A (null when either is unknown). */
export interface Metric {
  a: number | null;
  b: number | null;
  delta: number | null;
}

export interface CompareTotals {
  wallMs: Metric;
  inputTokens: Metric;
  outputTokens: Metric;
  costUsd: Metric;
  agents: Metric;
  done: Metric;
  failed: Metric;
  estimated: { a: boolean; b: boolean };
}

/** One agent of one run, as a row shows it. */
export interface AgentFacts {
  agentId: number | null;
  label: string;
  phase: string | null;
  state: AgentState;
  adapter: string | null;
  model: string | null;
  attempts: number | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  estimated: boolean;
  replayed: boolean;
  failureReason: string | null;
  error: string | null;
  changes: { files: number; insertions: number; deletions: number; truncated: boolean } | null;
}

export interface AgentComparison {
  match: AgentMatch | null;
  outcome: AgentOutcome;
  label: string;
  phase: string | null;
  a: AgentFacts | null;
  b: AgentFacts | null;
  delta: {
    durationMs: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    costUsd: number | null;
    attempts: number | null;
  };
  reply: ReplyComparison;
}

export interface ReplyComparison {
  status: "identical" | "differs" | "none";
  kind: "text" | "json" | null;
  diff?: string[];
  added?: number;
  removed?: number;
  paths?: JsonChange[];
  changed?: number;
  truncated: boolean;
}

/** A JSON path where two structured replies differ; `a`/`b` are the values there as compact JSON. */
export interface JsonChange {
  path: string;
  op: "changed" | "added" | "removed";
  a?: string;
  b?: string;
}

/** How much of a reply's diff a comparison carries; `odw compare --agent` lifts both. */
export interface DiffLimits {
  /** Unified-diff lines of a text reply (default 40). */
  diffLines?: number;
  /** JSON paths of a structured reply (default 20). */
  jsonPaths?: number;
  /** Characters of a diff line, and of a JSON value (default 200). */
  chars?: number;
}

const DIFF_LINES = 40;
const JSON_PATHS = 20;
const DIFF_CHARS = 200;

// --- reading a run -------------------------------------------------------------

/**
 * A run as {@link compareRuns} reads it: its meta, status and events (one read
 * of each), and its saved agent results. `nowMs` ends a run still going.
 */
export function readCompareRun(store: RunStore, runId: string, nowMs = Date.now()): CompareRunInput {
  const events = store.readEvents(runId);
  const facts = readFacts(store, runId, events);
  const run = detailFrom(runId, facts, { hasResult: false, error: null });
  const meta = facts.meta;
  const live = !TERMINAL_STATES.has(run.rawState) && !run.stale;

  // What the events say beyond the fold: each call's key and model, the setup, the run's start and end.
  const started = new Map<number, { key: string | null; model: string | null }>();
  let startedAt: number | null = null;
  let endedAt: number | null = null;
  let setup: RunSetup | null = null;
  for (const ev of events) {
    if (ev.type === AGENT_STARTED && typeof ev.agentId === "number") {
      started.set(ev.agentId, { key: str(ev.key), model: str(ev.model) });
    } else if (ev.type === RUN_STARTED) {
      startedAt ??= num(ev.ts);
      setup ??= readSetup(ev.setup);
    } else if (ev.type === RUN_FINISHED || ev.type === RUN_FAILED || ev.type === RUN_STOPPED) {
      endedAt = num(ev.ts);
    }
  }
  startedAt ??= num(meta.createdAt);
  endedAt ??= live ? nowMs / 1000 : (run.lastActivityTs ?? run.updatedAt);

  const records = new Map<number, AgentResultRecord>();
  for (const rec of store.listAgentResults(runId)) records.set(rec.agentId, rec);
  const agents: RunAgent[] = [];
  for (const a of run.agents) {
    if (a.kind !== "agent") continue;
    const record = a.agentId !== null ? records.get(a.agentId) : undefined;
    if (a.agentId !== null) records.delete(a.agentId);
    const ev = a.agentId !== null ? started.get(a.agentId) : undefined;
    agents.push({
      agentId: a.agentId,
      label: a.label,
      phase: a.phase,
      key: ev?.key ?? str(record?.key),
      // The record is written just before agent_finished: it already means done.
      state: record ? "done" : a.state,
      adapter: a.adapter ?? record?.adapter ?? null,
      model: ev?.model ?? null,
      attempts: a.attempts ?? record?.attempts ?? null,
      durationMs: a.durationMs ?? durationOf(record),
      usage: a.usage ?? null,
      cached: a.cached || record?.cached === true,
      error: a.error,
      failureReason: a.failureReason ?? null,
      changes: a.changes ?? record?.changes ?? null,
      ...(record ? { reply: { value: record.value } } : {}),
    });
  }
  // A saved result whose events were lost (a truncated log) still counts.
  for (const rec of records.values()) {
    agents.push({
      agentId: rec.agentId,
      label: rec.label,
      phase: rec.phase,
      key: str(rec.key),
      state: "done",
      adapter: rec.adapter,
      model: null,
      attempts: rec.attempts,
      durationMs: durationOf(rec),
      usage: null,
      cached: rec.cached === true,
      error: null,
      failureReason: null,
      changes: rec.changes ?? null,
      reply: { value: rec.value },
    });
  }
  agents.sort((x, y) => (x.agentId ?? Infinity) - (y.agentId ?? Infinity));

  return {
    runId,
    name: run.name,
    workflowName: str(meta.workflowName),
    state: run.state,
    live,
    createdAt: num(meta.createdAt),
    startedAt,
    endedAt,
    script: str(meta.script),
    inline: meta.inline === true,
    args: meta.args ?? null,
    adapter: str(meta.adapter),
    permissions: str(meta.permissions),
    budgetTotal: num(meta.budgetTotal),
    odwVersion: str(meta.odwVersion),
    sourceHash: str(meta.sourceHash),
    resumedFrom: str(meta.resumedFrom),
    setup,
    cliVersions: cliVersionsOf(events),
    agents,
  };
}

/** A run_started event's `setup`, when it is one (untrusted JSON). */
function readSetup(raw: unknown): RunSetup | null {
  if (!isRecord(raw) || !isRecord(raw.settings) || !isRecord(raw.adapters)) return null;
  const adapters: Record<string, string> = {};
  for (const [name, print] of Object.entries(raw.adapters)) if (typeof print === "string") adapters[name] = print;
  return { settings: { ...raw.settings }, adapters };
}

function durationOf(rec: AgentResultRecord | undefined): number | null {
  if (!rec || typeof rec.startedAt !== "number" || typeof rec.finishedAt !== "number") return null;
  return Math.max(0, Math.round((rec.finishedAt - rec.startedAt) * 1000));
}

// --- comparing -----------------------------------------------------------------

/** What changed from run `a` to run `b` (see the module comment). Pure. */
export function compareRuns(a: CompareRunInput, b: CompareRunInput, limits: DiffLimits = {}): RunComparison {
  const rows = pairAgents(a.agents, b.agents).map((pair) => agentRow(pair, limits));
  const order = mergePhases(phasesOf(a.agents), phasesOf(b.agents));
  const index = (phase: string | null): number => order.indexOf(phase);
  const ids = new Map<AgentComparison, number>(rows.map((row, i) => [row, i]));
  rows.sort(
    (x, y) =>
      index(x.phase) - index(y.phase) ||
      Number(x.a === null) - Number(y.a === null) ||
      (x.a ? idOf(x.a) - idOf(y.a!) : idOf(x.b!) - idOf(y.b!)) ||
      ids.get(x)! - ids.get(y)!,
  );
  return {
    version: 1,
    a: runInfo(a),
    b: runInfo(b),
    notes: notesOf(a, b),
    setup: setupChanges(a, b),
    totals: totalsOf(a, b),
    agents: rows,
  };
}

function idOf(agent: AgentFacts): number {
  return agent.agentId ?? Number.MAX_SAFE_INTEGER;
}

function runInfo(run: CompareRunInput): CompareRunInfo {
  return {
    runId: run.runId,
    name: run.name,
    workflowName: run.workflowName,
    state: run.state,
    live: run.live,
    createdAt: run.createdAt,
    odwVersion: run.odwVersion,
    sourceHash: run.sourceHash,
    resumedFrom: run.resumedFrom,
  };
}

function notesOf(a: CompareRunInput, b: CompareRunInput): string[] {
  const notes: string[] = [];
  if (a.runId === b.runId) notes.push("A and B are the same run");
  for (const [side, run] of [["A", a], ["B", b]] as const) {
    if (run.live) {
      notes.push(`run ${side} is still ${run.state} — compared as it stands: its running agents have no reply yet`);
    } else if (run.state === "stale") {
      notes.push(`run ${side} is stale (its worker is gone) — compared as it stands`);
    }
    if (!run.setup) notes.push(`run ${side} recorded no setup (a run from before odw 0.5): its settings are not compared`);
  }
  if (a.workflowName && b.workflowName && a.workflowName !== b.workflowName) {
    notes.push(`the runs are of different workflows: ${a.workflowName} and ${b.workflowName}`);
  }
  return notes;
}

/** Pairs of A's and B's agents (see the module comment), then the agents one run has. */
function pairAgents(as: RunAgent[], bs: RunAgent[]): Array<{ a: RunAgent | null; b: RunAgent | null; match: AgentMatch | null }> {
  const pairs: Array<{ a: RunAgent | null; b: RunAgent | null; match: AgentMatch | null }> = [];
  const freeA = new Set(as);
  const freeB = new Set(bs);
  const pair = (a: RunAgent, b: RunAgent, match: AgentMatch): void => {
    freeA.delete(a);
    freeB.delete(b);
    pairs.push({ a, b, match });
  };
  // 1. A label each run gives exactly one agent.
  const onceA = uniqueLabels(as);
  const onceB = uniqueLabels(bs);
  for (const [label, a] of onceA) {
    const b = onceB.get(label);
    if (b) pair(a, b, "label");
  }
  // 2. The same call: its resume key, in call order.
  const byKey = new Map<string, RunAgent[]>();
  for (const b of bs) {
    if (!freeB.has(b) || !b.key) continue;
    const queue = byKey.get(b.key);
    if (queue) queue.push(b);
    else byKey.set(b.key, [b]);
  }
  for (const a of as) {
    if (!freeA.has(a) || !a.key) continue;
    const b = byKey.get(a.key)?.shift();
    if (b) pair(a, b, "key");
  }
  // 3. Order within the phase: the same label first, then by position.
  for (const phase of mergePhases(phasesOf(as), phasesOf(bs))) {
    const restA = as.filter((a) => freeA.has(a) && a.phase === phase);
    const restB = bs.filter((b) => freeB.has(b) && b.phase === phase);
    for (const a of restA) {
      const b = restB.find((x) => freeB.has(x) && x.label === a.label);
      if (b) pair(a, b, "order");
    }
    const leftA = restA.filter((a) => freeA.has(a));
    const leftB = restB.filter((b) => freeB.has(b));
    for (let i = 0; i < Math.min(leftA.length, leftB.length); i++) pair(leftA[i]!, leftB[i]!, "order");
  }
  for (const a of as) if (freeA.has(a)) pairs.push({ a, b: null, match: null });
  for (const b of bs) if (freeB.has(b)) pairs.push({ a: null, b, match: null });
  return pairs;
}

function uniqueLabels(agents: RunAgent[]): Map<string, RunAgent> {
  const seen = new Map<string, RunAgent | null>();
  for (const agent of agents) seen.set(agent.label, seen.has(agent.label) ? null : agent);
  const once = new Map<string, RunAgent>();
  for (const [label, agent] of seen) if (agent) once.set(label, agent);
  return once;
}

/** A run's phases in the order its agents first ran in them (null: no phase). */
function phasesOf(agents: RunAgent[]): Array<string | null> {
  const order: Array<string | null> = [];
  for (const agent of agents) if (!order.includes(agent.phase)) order.push(agent.phase);
  return order;
}

/** A's phase order, with each phase only B has after the B phase before it. */
function mergePhases(a: Array<string | null>, b: Array<string | null>): Array<string | null> {
  const order = [...a];
  let at = -1;
  for (const phase of b) {
    const i = order.indexOf(phase);
    if (i >= 0) at = i;
    else order.splice(++at, 0, phase);
  }
  return order;
}

function agentRow(pair: { a: RunAgent | null; b: RunAgent | null; match: AgentMatch | null }, limits: DiffLimits): AgentComparison {
  const a = pair.a ? factsOf(pair.a) : null;
  const b = pair.b ? factsOf(pair.b) : null;
  const outcome: AgentOutcome = !a
    ? "only-b"
    : !b
      ? "only-a"
      : b.state === "failed" && a.state !== "failed"
        ? "newly-failed"
        : a.state === "failed" && b.state === "done"
          ? "fixed"
          : "unchanged";
  const delta = (pick: (x: AgentFacts) => number | null): number | null => difference(a ? pick(a) : null, b ? pick(b) : null);
  const shown = (a ?? b)!;
  return {
    match: pair.match,
    outcome,
    label: shown.label,
    phase: shown.phase,
    a,
    b,
    delta: {
      durationMs: delta((x) => x.durationMs),
      inputTokens: delta((x) => x.inputTokens),
      outputTokens: delta((x) => x.outputTokens),
      costUsd: delta((x) => x.costUsd),
      attempts: delta((x) => x.attempts),
    },
    reply: compareReplies(pair.a?.reply, pair.b?.reply, limits),
  };
}

function factsOf(agent: RunAgent): AgentFacts {
  const changes = agent.changes;
  return {
    agentId: agent.agentId,
    label: agent.label,
    phase: agent.phase,
    state: agent.state,
    adapter: agent.adapter,
    model: agent.model,
    attempts: agent.attempts,
    durationMs: agent.durationMs,
    inputTokens: agent.usage?.inputTokens ?? null,
    outputTokens: agent.usage?.outputTokens ?? null,
    costUsd: agent.usage?.costUsd ?? null,
    estimated: agent.usage?.estimated === true,
    replayed: agent.cached,
    failureReason: agent.failureReason,
    error: agent.error,
    changes: changes
      ? { files: changes.files, insertions: changes.insertions, deletions: changes.deletions, truncated: changes.truncated === true }
      : null,
  };
}

/** B − A, when both are known; dollars kept tidy as addUsage keeps them. */
function difference(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  return Math.round((b - a) * 1e9) / 1e9;
}

/** How two saved replies compare: identical, or a bounded diff (text, or JSON paths for structured replies). */
export function compareReplies(
  a: { value: unknown } | undefined,
  b: { value: unknown } | undefined,
  limits: DiffLimits = {},
): ReplyComparison {
  if (!a || !b) return { status: "none", kind: null, truncated: false };
  const chars = limits.chars ?? DIFF_CHARS;
  if (typeof a.value === "string" && typeof b.value === "string") {
    if (a.value === b.value) return { status: "identical", kind: null, truncated: false };
    const diff = unifiedDiff(a.value, b.value, { maxLines: limits.diffLines ?? DIFF_LINES, lineChars: chars });
    return { status: "differs", kind: "text", diff: diff.lines, added: diff.added, removed: diff.removed, truncated: diff.truncated };
  }
  if (stableJson(a.value) === stableJson(b.value)) return { status: "identical", kind: null, truncated: false };
  const diff = jsonDiff(a.value, b.value, { maxPaths: limits.jsonPaths ?? JSON_PATHS, valueChars: chars });
  return { status: "differs", kind: "json", paths: diff.paths, changed: diff.total, truncated: diff.truncated };
}

function totalsOf(a: CompareRunInput, b: CompareRunInput): CompareTotals {
  const ta = runTotals(a);
  const tb = runTotals(b);
  const metric = (key: keyof Omit<ReturnType<typeof runTotals>, "estimated">): Metric => ({
    a: ta[key],
    b: tb[key],
    delta: difference(ta[key], tb[key]),
  });
  return {
    wallMs: metric("wallMs"),
    inputTokens: metric("inputTokens"),
    outputTokens: metric("outputTokens"),
    costUsd: metric("costUsd"),
    agents: metric("agents"),
    done: metric("done"),
    failed: metric("failed"),
    estimated: { a: ta.estimated, b: tb.estimated },
  };
}

function runTotals(run: CompareRunInput) {
  let usage: Usage | undefined;
  for (const agent of run.agents) usage = addUsage(usage, agent.usage ?? undefined);
  const wall = run.startedAt !== null && run.endedAt !== null ? Math.max(0, Math.round((run.endedAt - run.startedAt) * 1000)) : null;
  return {
    wallMs: wall,
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    costUsd: usage?.costUsd ?? null,
    agents: run.agents.length,
    done: run.agents.filter((x) => x.state === "done").length,
    failed: run.agents.filter((x) => x.state === "failed").length,
    estimated: usage?.estimated === true,
  };
}

function setupChanges(a: CompareRunInput, b: CompareRunInput): SetupChange[] {
  const out: SetupChange[] = [];
  const add = (field: string, va: unknown, vb: unknown): void => {
    if (stableJson(va ?? null) !== stableJson(vb ?? null)) out.push({ field, a: va ?? null, b: vb ?? null });
  };
  // The workflow as launched, and — for runs of a file — which file.
  if (a.sourceHash && b.sourceHash) add("source", a.sourceHash, b.sourceHash);
  if (!a.inline && !b.inline) add("script", a.script, b.script);
  add("args", a.args, b.args);
  if (a.odwVersion && b.odwVersion) add("odwVersion", a.odwVersion, b.odwVersion);
  add("budget", a.budgetTotal, b.budgetTotal);
  // CLI versions, of the adapters both runs recorded one for.
  for (const adapter of Object.keys(a.cliVersions).sort()) {
    const vb = b.cliVersions[adapter];
    if (vb) add(`cliVersion.${adapter}`, a.cliVersions[adapter]!.version, vb.version);
  }
  const usedA = adaptersUsed(a);
  const usedB = adaptersUsed(b);
  if (a.setup && b.setup) {
    const keys = [...Object.keys(a.setup.settings), ...Object.keys(b.setup.settings)];
    for (const key of [...new Set(keys)]) add(`settings.${key}`, a.setup.settings[key], b.setup.settings[key]);
    // The definitions of the adapters either run's agents used.
    for (const name of [...new Set([...usedA, ...usedB])].sort()) {
      const fa = a.setup.adapters[name];
      const fb = b.setup.adapters[name];
      if (fa && fb) add(`adapterDefinition.${name}`, fa, fb);
    }
  } else {
    // What a run recorded before setups were: its --adapter and --permissions.
    add("adapter", a.adapter, b.adapter);
    add("permissions", a.permissions, b.permissions);
  }
  add("adaptersUsed", usedA, usedB);
  add("modelsUsed", modelsUsed(a), modelsUsed(b));
  return out;
}

function adaptersUsed(run: CompareRunInput): string[] {
  return [...new Set(run.agents.flatMap((x) => (x.adapter && !x.cached ? [x.adapter] : [])))].sort();
}

function modelsUsed(run: CompareRunInput): string[] {
  return [...new Set(run.agents.flatMap((x) => (x.model && !x.cached ? [x.model] : [])))].sort();
}

// --- diffs ---------------------------------------------------------------------

/** Line pairs past the common head and tail a text diff is minimal for; past them the middle is one replacement. */
const DIFF_CELLS = 2_000_000;

export interface TextDiff {
  /** Hunks: `@@ -l,n +l,n @@` headers, then ` `, `-` and `+` lines. */
  lines: string[];
  /** Lines added and removed over the whole diff, shown or not. */
  added: number;
  removed: number;
  /** Cut at `maxLines`. */
  truncated: boolean;
}

/**
 * A unified diff of two texts, line by line: hunks of the lines that differ
 * with `context` lines around them, at most `maxLines` lines in all, each cut
 * to `lineChars` characters.
 */
export function unifiedDiff(
  a: string,
  b: string,
  opts: { maxLines?: number; lineChars?: number; context?: number } = {},
): TextDiff {
  const maxLines = opts.maxLines ?? Infinity;
  const lineChars = opts.lineChars ?? Infinity;
  const context = opts.context ?? 3;
  const ops = editScript(a.split("\n"), b.split("\n"));
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.op === "+") added++;
    else if (op.op === "-") removed++;
  }
  // Hunks: runs of changes, with their context, merged when the context overlaps.
  const hunks: Array<[number, number]> = [];
  ops.forEach((op, i) => {
    if (op.op === " ") return;
    const start = Math.max(0, i - context);
    const end = Math.min(ops.length, i + context + 1);
    const last = hunks[hunks.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else hunks.push([start, end]);
  });
  const lines: string[] = [];
  let truncated = false;
  const push = (line: string): boolean => {
    if (lines.length >= maxLines) {
      truncated = true;
      return false;
    }
    lines.push(line.length > lineChars ? `${line.slice(0, lineChars)}…` : line);
    return true;
  };
  outer: for (const [start, end] of hunks) {
    const slice = ops.slice(start, end);
    const aCount = slice.filter((op) => op.op !== "+").length;
    const bCount = slice.filter((op) => op.op !== "-").length;
    const first = ops[start]!;
    const aStart = aCount === 0 ? first.ai : first.ai + 1;
    const bStart = bCount === 0 ? first.bi : first.bi + 1;
    if (!push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`)) break;
    for (const op of slice) if (!push(`${op.op}${op.line}`)) break outer;
  }
  return { lines, added, removed, truncated };
}

/** One line of an edit script; `ai`/`bi`: how many lines of a and b come before it. */
interface EditOp {
  op: " " | "-" | "+";
  line: string;
  ai: number;
  bi: number;
}

/** The lines of `a` and `b` as kept, removed and added: minimal past the common head and tail, up to DIFF_CELLS. */
function editScript(a: string[], b: string[]): EditOp[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const ops: EditOp[] = [];
  let ai = 0;
  let bi = 0;
  const keep = (line: string): void => {
    ops.push({ op: " ", line, ai, bi });
    ai++;
    bi++;
  };
  const drop = (line: string): void => {
    ops.push({ op: "-", line, ai, bi });
    ai++;
  };
  const take = (line: string): void => {
    ops.push({ op: "+", line, ai, bi });
    bi++;
  };
  for (let i = 0; i < head; i++) keep(a[i]!);
  const ma = a.slice(head, a.length - tail);
  const mb = b.slice(head, b.length - tail);
  const n = ma.length;
  const m = mb.length;
  if (n > 0 && m > 0 && (n + 1) * (m + 1) <= DIFF_CELLS) {
    // Longest common subsequence of the middles, from their ends.
    const width = m + 1;
    const lcs = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * width + j] =
          ma[i] === mb[j] ? lcs[(i + 1) * width + j + 1]! + 1 : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (ma[i] === mb[j]) {
        keep(ma[i++]!);
        j++;
      } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) drop(ma[i++]!);
      else take(mb[j++]!);
    }
    while (i < n) drop(ma[i++]!);
    while (j < m) take(mb[j++]!);
  } else {
    for (const line of ma) drop(line);
    for (const line of mb) take(line);
  }
  for (let i = a.length - tail; i < a.length; i++) keep(a[i]!);
  return ops;
}

/**
 * Where two JSON values differ, path by path (`$.findings[2].severity`):
 * objects key by key (A's order, then keys only B has), arrays index by
 * index. At most `maxPaths` are kept; `total` counts them all.
 */
export function jsonDiff(
  a: unknown,
  b: unknown,
  opts: { maxPaths?: number; valueChars?: number } = {},
): { paths: JsonChange[]; total: number; truncated: boolean } {
  const maxPaths = opts.maxPaths ?? Infinity;
  const valueChars = opts.valueChars ?? Infinity;
  const paths: JsonChange[] = [];
  let total = 0;
  const show = (value: unknown): string => {
    const text = JSON.stringify(value) ?? "null";
    return text.length > valueChars ? `${text.slice(0, valueChars)}…` : text;
  };
  const add = (change: JsonChange): void => {
    total++;
    if (paths.length < maxPaths) paths.push(change);
  };
  const walk = (x: unknown, y: unknown, path: string): void => {
    if (isRecord(x) && isRecord(y)) {
      const keys = [...Object.keys(x), ...Object.keys(y).filter((key) => !hasOwn(x, key))];
      for (const key of keys) {
        const at = path + keyPath(key);
        if (!hasOwn(x, key)) add({ path: at, op: "added", b: show(y[key]) });
        else if (!hasOwn(y, key)) add({ path: at, op: "removed", a: show(x[key]) });
        else walk(x[key], y[key], at);
      }
      return;
    }
    if (Array.isArray(x) && Array.isArray(y)) {
      for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const at = `${path}[${i}]`;
        if (i >= x.length) add({ path: at, op: "added", b: show(y[i]) });
        else if (i >= y.length) add({ path: at, op: "removed", a: show(x[i]) });
        else walk(x[i], y[i], at);
      }
      return;
    }
    if (x === y || stableJson(x) === stableJson(y)) return;
    add({ path, op: "changed", a: show(x), b: show(y) });
  };
  walk(a, b, "$");
  return { paths, total, truncated: total > paths.length };
}

function keyPath(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

// --- the CLI's table -----------------------------------------------------------

/** Changes within this share of A's figure are noise: not coloured. */
const NOISE = 0.05;

/**
 * `odw compare`'s human view: the two runs, notes, setup differences, run
 * totals with B − A, and a row per agent under its phase, fitted to `width`
 * columns. Deltas are red when B is worse (more time, tokens or cost; newly
 * failed) and green when better — when `caps` has colour.
 */
export function formatComparison(cmp: RunComparison, opts: { width: number; caps: TermCaps }): string[] {
  const p = palette(opts.caps);
  const width = opts.width;
  const out: string[] = [];
  const fit = (line: string): string => truncateToWidth(line.trimEnd(), width);
  for (const [side, run] of [["A", cmp.a], ["B", cmp.b]] as const) {
    const when = run.createdAt !== null ? `  ${p.dim(new Date(run.createdAt * 1000).toLocaleString())}` : "";
    out.push(fit(`${p.bold(side)}  ${run.runId}  ${tintState(p, run.state, padEndWidth(run.state, 8))}  ${sanitizeText(run.name, 40)}${when}`));
  }
  for (const note of cmp.notes) out.push(fit(p.run(`note: ${sanitizeText(note, width)}`)));

  // What they ran with.
  out.push("", p.bold("SETUP"));
  if (cmp.setup.length === 0) out.push(fit(p.dim("  nothing recorded differs")));
  const labels = cmp.setup.map((change) => setupLabel(change.field));
  const labelWidth = Math.min(22, Math.max(0, ...labels.map((label) => displayWidth(label))));
  const valueWidth = Math.max(8, Math.floor((width - 2 - labelWidth - 2 - 3) / 2));
  cmp.setup.forEach((change, i) => {
    const show = (value: unknown): string => sanitizeText(setupValue(change.field, value), valueWidth);
    out.push(fit(`  ${padEndWidth(sanitizeText(labels[i], labelWidth), labelWidth)}  ${show(change.a)} → ${show(change.b)}`));
  });

  // The run as a whole.
  const t = cmp.totals;
  const tilde = (estimated: boolean): string => (estimated ? "~" : "");
  const runRows: Array<[string, string, string, string]> = [
    ["time", maybe(t.wallMs.a, fmtDuration), maybe(t.wallMs.b, fmtDuration), signed(t.wallMs.delta, fmtDuration)],
    ["tokens in", maybe(t.inputTokens.a, fmtTokens), maybe(t.inputTokens.b, fmtTokens), signed(t.inputTokens.delta, fmtTokens)],
    [
      "tokens out",
      tilde(t.estimated.a) + maybe(t.outputTokens.a, fmtTokens),
      tilde(t.estimated.b) + maybe(t.outputTokens.b, fmtTokens),
      signed(t.outputTokens.delta, fmtTokens),
    ],
    ["cost", maybe(t.costUsd.a, fmtUsd), maybe(t.costUsd.b, fmtUsd), signed(t.costUsd.delta, fmtUsd)],
    ["agents", String(t.agents.a), String(t.agents.b), signed(t.agents.delta, String)],
    ["done", String(t.done.a), String(t.done.b), signed(t.done.delta, String)],
    ["failed", String(t.failed.a), String(t.failed.b), signed(t.failed.delta, String)],
  ];
  const tones = [
    tone(t.wallMs, true),
    tone(t.inputTokens, true),
    tone(t.outputTokens, true),
    tone(t.costUsd, true),
    "same" as const,
    tone(t.done, false, 0),
    tone(t.failed, true, 0),
  ];
  const cw = [12, ...[1, 2, 3].map((c) => Math.max(...runRows.map((row) => row[c]!.length), 1))];
  out.push("", fit(p.bold(`${"RUN".padEnd(cw[0]!)}${"A".padStart(cw[1]!)}  ${"B".padStart(cw[2]!)}  ${"Δ".padStart(cw[3]!)}`)));
  runRows.forEach((row, i) => {
    const delta = paint(p, tones[i]!, row[3].padStart(cw[3]!));
    out.push(fit(`  ${row[0].padEnd(cw[0]! - 2)}${row[1].padStart(cw[1]!)}  ${row[2].padStart(cw[2]!)}  ${delta}`));
  });

  // Each agent.
  out.push("");
  if (cmp.agents.length === 0) {
    out.push(p.bold("AGENTS"), p.dim("  no agents in either run"));
    return out;
  }
  out.push(...agentTable(cmp.agents, p, opts));
  return out;
}

type Tone = "worse" | "better" | "same";

/** Whether B's figure is worse or better than A's: more is worse when `moreIsWorse`; past `noise` of A's figure only. */
function tone(metric: Metric, moreIsWorse: boolean, noise = NOISE): Tone {
  if (metric.a === null || metric.b === null || metric.delta === null || metric.delta === 0) return "same";
  if (Math.abs(metric.delta) <= Math.abs(metric.a) * noise) return "same";
  return metric.delta > 0 === moreIsWorse ? "worse" : "better";
}

function paint(p: Palette, t: Tone, text: string): string {
  return t === "worse" ? p.err(text) : t === "better" ? p.ok(text) : text;
}

function tintState(p: Palette, state: string, text: string): string {
  return state === "done" ? p.ok(text) : state === "failed" ? p.err(text) : state === "stale" || state === "stopped" ? p.dim(text) : p.run(text);
}

function maybe(value: number | null, format: (n: number) => string): string {
  return value === null ? "-" : format(value);
}

/** `+2.1s`, `-$0.056`, `+1`; `0` unchanged (or too little to show); `-` unknown. */
function signed(value: number | null, format: (n: number) => string): string {
  if (value === null) return "-";
  const shown = format(Math.abs(value));
  if (value === 0 || shown === format(0)) return "0";
  return `${value > 0 ? "+" : "-"}${shown}`;
}

const SETUP_LABELS: Record<string, string> = {
  source: "source",
  script: "script",
  args: "args",
  odwVersion: "odw",
  budget: "budget",
  adapter: "--adapter",
  permissions: "--permissions",
  adaptersUsed: "adapters used",
  modelsUsed: "models used",
};

function setupLabel(field: string): string {
  if (SETUP_LABELS[field]) return SETUP_LABELS[field];
  const [kind, ...rest] = field.split(".");
  const name = rest.join(".");
  if (kind === "cliVersion") return `${name} CLI`;
  if (kind === "adapterDefinition") return `${name} adapter`;
  if (kind === "settings") return name;
  return field;
}

function setupValue(field: string, value: unknown): string {
  if (field === "source" && typeof value === "string") return value.slice(0, 12);
  if (field.startsWith("cliVersion.") && value === null) return "unknown";
  if (field.startsWith("adapterDefinition.") && typeof value === "string") return `definition ${value}`;
  if ((field === "adaptersUsed" || field === "modelsUsed") && Array.isArray(value)) {
    return value.length > 0 ? value.join(", ") : field === "modelsUsed" ? "CLI defaults" : "none";
  }
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? "null";
}

/** The AGENTS table: LABEL (under its phase), STATE, ADAPTER, TIME, SPEND, REPLY — and CHANGES when any agent kept a diff. */
function agentTable(rows: AgentComparison[], p: Palette, opts: { width: number; caps: TermCaps }): string[] {
  const replayed = opts.caps.unicode ? "↺" : "(r)";
  const arrow = opts.caps.unicode ? "→" : "->";
  const withChanges = rows.some((row) => row.a?.changes || row.b?.changes);
  const header = ["AGENTS", "STATE", "ADAPTER", "TIME", "SPEND", "REPLY", ...(withChanges ? ["CHANGES"] : [])];
  const cells = rows.map((row) => {
    const after = (row.b ?? row.a)!;
    const state =
      row.outcome === "only-a"
        ? "only in A"
        : row.outcome === "only-b"
          ? "only in B"
          : row.a!.state === row.b!.state
            ? `${row.b!.state}${row.b!.replayed ? ` ${replayed}` : ""}`
            : `${row.a!.state}${arrow}${row.b!.state}`;
    const route = (x: AgentFacts): string => `${x.adapter ?? "-"}${x.model ? `/${x.model}` : ""}`;
    const adapter = row.a && row.b && route(row.a) !== route(row.b) ? `${route(row.a)}${arrow}${route(row.b)}` : route(after);
    const time = `${maybe(after.durationMs, fmtDuration)}${row.a && row.b ? ` ${signed(row.delta.durationMs, fmtDuration)}` : ""}`;
    const spendCost = row.a?.costUsd != null || row.b?.costUsd != null;
    const spend = spendCost
      ? `${maybe(after.costUsd, fmtUsd)}${row.a && row.b ? ` ${signed(row.delta.costUsd, fmtUsd)}` : ""}`
      : after.outputTokens !== null
        ? `${fmtTokens(after.outputTokens)} tok${row.a && row.b ? ` ${signed(row.delta.outputTokens, fmtTokens)}` : ""}`
        : "-";
    const reply =
      row.reply.status === "identical"
        ? "identical"
        : row.reply.status === "none"
          ? "-"
          : row.reply.kind === "text"
            ? `differs +${row.reply.added} -${row.reply.removed}`
            : `differs: ${row.reply.changed} path${row.reply.changed === 1 ? "" : "s"}`;
    const kept = (x: AgentFacts | null): string => (x?.changes ? `+${x.changes.insertions} -${x.changes.deletions}` : "-");
    const changes =
      row.a && row.b && kept(row.a) !== kept(row.b) ? `${kept(row.a)}${arrow}${kept(row.b)}` : kept(after);
    const tones: Tone[] = [
      "same",
      row.outcome === "newly-failed" ? "worse" : row.outcome === "fixed" ? "better" : "same",
      "same",
      row.a && row.b ? tone({ a: row.a.durationMs, b: row.b.durationMs, delta: row.delta.durationMs }, true) : "same",
      row.a && row.b
        ? spendCost
          ? tone({ a: row.a.costUsd, b: row.b.costUsd, delta: row.delta.costUsd }, true)
          : tone({ a: row.a.outputTokens, b: row.b.outputTokens, delta: row.delta.outputTokens }, true)
        : "same",
      "same",
      "same",
    ];
    return {
      text: [`  ${sanitizeText(row.label, 60)}`, state, sanitizeText(adapter, 40), time, spend, reply, ...(withChanges ? [changes] : [])],
      tones,
      dim: row.outcome === "only-a" || row.outcome === "only-b",
      quiet: row.reply.status !== "differs",
    };
  });
  // Natural widths, then the label and adapter columns give way until the table fits.
  const widths = header.map((h, i) => Math.max(displayWidth(h), ...cells.map((c) => displayWidth(c.text[i]!))));
  widths[0] = Math.min(widths[0]!, 30);
  widths[2] = Math.min(widths[2]!, 22);
  const total = (): number => widths.reduce((sum, w) => sum + w, 0) + 2 * (widths.length - 1);
  for (const [col, min] of [[0, 12], [2, 10], [0, 8]] as const) {
    const excess = total() - opts.width;
    if (excess > 0) widths[col] = Math.max(min, widths[col]! - excess);
  }
  const line = (texts: string[], tones?: Tone[], dim = false, quiet = false): string => {
    const padded = texts.map((s, i) => {
      // The last column is not padded: a styled cell would keep its spaces past trimEnd.
      const cut = truncateToWidth(s, widths[i]!);
      const cell = i === texts.length - 1 ? cut : padEndWidth(cut, widths[i]!);
      if (i === 5 && quiet && !dim) return p.dim(cell);
      return dim ? p.dim(cell) : paint(p, tones?.[i] ?? "same", cell);
    });
    return truncateToWidth(padded.join("  ").trimEnd(), opts.width);
  };
  const out = [line(header).replace(/^AGENTS/, p.bold("AGENTS"))];
  const phases = new Set(rows.map((row) => row.phase));
  const headed = phases.size > 1 || !phases.has(null);
  let current: string | null | undefined;
  rows.forEach((row, i) => {
    if (headed && row.phase !== current) {
      current = row.phase;
      out.push(truncateToWidth(` ${p.bold(sanitizeText(row.phase ?? "(no phase)", opts.width - 2))}`, opts.width));
    }
    const cell = cells[i]!;
    out.push(line(cell.text, cell.tones, cell.dim, cell.quiet));
  });
  return out;
}

/** The agents `ref` names: by id — A's agent with it, else B's — or by either run's label. */
export function findComparedAgents(rows: AgentComparison[], ref: string): AgentComparison[] {
  if (/^\d+$/.test(ref)) {
    const id = Number(ref);
    const inA = rows.filter((row) => row.a?.agentId === id);
    if (inA.length > 0) return inA;
    const inB = rows.filter((row) => row.b?.agentId === id);
    if (inB.length > 0) return inB;
  }
  return rows.filter((row) => row.a?.label === ref || row.b?.label === ref);
}

/**
 * `odw compare --agent`'s human view: one agent in each run, then its whole
 * reply diff — a unified diff of a text reply (coloured on a terminal), or
 * every JSON path a structured reply differs at.
 */
export function formatAgentComparison(
  row: AgentComparison,
  cmp: RunComparison,
  opts: { width: number; caps: TermCaps },
): string[] {
  const p = palette(opts.caps);
  const out: string[] = [];
  const how = row.match ? `matched by ${row.match}` : row.outcome === "only-a" ? "only in A" : "only in B";
  out.push(truncateToWidth(`${p.bold("agent")} ${sanitizeText(row.label, 60)}  ${p.dim(`(${how})`)}`, opts.width));
  for (const [side, run, agent] of [["A", cmp.a, row.a], ["B", cmp.b, row.b]] as const) {
    if (!agent) {
      out.push(truncateToWidth(`  ${side}  ${p.dim(`not in ${run.runId}`)}`, opts.width));
      continue;
    }
    const facts = [
      `#${agent.agentId ?? "-"}`,
      tintState(p, agent.state, `${agent.state}${agent.replayed ? " (replayed)" : ""}`),
      `${agent.adapter ?? "-"}${agent.model ? `/${agent.model}` : ""}`,
      maybe(agent.durationMs, fmtDuration),
      agent.costUsd !== null ? fmtUsd(agent.costUsd) : agent.outputTokens !== null ? `${fmtTokens(agent.outputTokens)} tok` : "-",
      agent.attempts !== null ? `${agent.attempts} attempt${agent.attempts === 1 ? "" : "s"}` : "",
    ].filter(Boolean);
    out.push(truncateToWidth(`  ${side}  ${facts.join("  ")}`, opts.width));
    if (agent.state === "failed") {
      const reason = agent.failureReason ? `[${sanitizeText(agent.failureReason, 40)}] ` : "";
      out.push(truncateToWidth(`      ${p.err(`${reason}${sanitizeText(agent.error ?? "failed", opts.width)}`)}`, opts.width));
    }
  }
  const reply = row.reply;
  if (reply.status === "none") {
    out.push("", p.dim("reply: none to compare — a side has no saved reply (failed, still running, or not in that run)"));
    return out;
  }
  if (reply.status === "identical") {
    out.push("", p.ok("reply: identical"));
    return out;
  }
  if (reply.kind === "text") {
    out.push("", `reply: differs (+${reply.added} -${reply.removed} lines)`);
    const head = [`--- A ${cmp.a.runId} #${row.a?.agentId ?? "-"}`, `+++ B ${cmp.b.runId} #${row.b?.agentId ?? "-"}`];
    const body = [...head, ...(reply.diff ?? []).map(safeLine)];
    out.push(...colorDiff(body.join("\n"), opts.caps).split("\n"));
    if (reply.truncated) out.push(p.dim("… (cut)"));
    return out;
  }
  out.push("", `reply: differs at ${reply.changed} JSON path${reply.changed === 1 ? "" : "s"}`);
  for (const change of reply.paths ?? []) {
    const path = sanitizeText(change.path, 200);
    if (change.op === "added") out.push(`  ${path}  ${p.ok(`added ${safeLine(change.b ?? "")}`)}`);
    else if (change.op === "removed") out.push(`  ${path}  ${p.err(`removed ${safeLine(change.a ?? "")}`)}`);
    else out.push(`  ${path}  ${p.err(safeLine(change.a ?? ""))} → ${p.ok(safeLine(change.b ?? ""))}`);
  }
  if (reply.truncated) out.push(p.dim("… (cut)"));
  return out;
}

/** A line of agent output made safe for a terminal, keeping its indentation. */
function safeLine(line: string): string {
  const lead = /^[ \t]*/.exec(line)![0].replace(/\t/g, "  ");
  return lead + sanitizeText(line, Number.MAX_SAFE_INTEGER);
}

// --- helpers -------------------------------------------------------------------

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}
