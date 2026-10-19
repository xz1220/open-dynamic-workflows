/**
 * `odw estimate` and `odw run --estimate` (an ODW extension): what a run of a
 * workflow is likely to cost and take, before it starts (L5).
 *
 * Built only from what earlier runs of the same workflow spent — the last
 * {@link ESTIMATE_RUNS} finished ("done") runs, a resumed run left out (its
 * replayed agents cost nothing), and so are dry runs (`odw run --dry`) and
 * `odw test`'s recorded runs, whose agents no model answered — their time and
 * their missing cost would crowd real runs out. A run whose agents reported
 * no cost still counts for time and tokens, and is left out of the cost
 * figures only (the notes say how many). Runs of the exact same source (meta.sourceHash)
 * are used when there are any, else runs of the same workflow name, and the
 * estimate says which. Without any it says so — "no estimate: no finished
 * runs of this workflow yet" — and never guesses.
 *
 * For the run as a whole, each phase and each adapter it gives the median and
 * 90th percentile, across those runs, of its wall time, cost and tokens and
 * of how many agents it started. A fan-out is as wide as the runs it is based
 * on had it (agents per phase): the estimate assumes similar args, and says so.
 *
 * The same history feeds the in-run forecast before a parallel() or pipeline()
 * (see ../forecast): {@link loadCostHistory}.
 *
 * The estimate is a wire contract (`odw estimate --json`, `GET /api/estimate`):
 *
 *   version    1
 *   workflow   the workflow's name
 *   sourceHash the source it was matched by (null when none was given)
 *   match      "sourceHash" | "name" | null (no history)
 *   runs       the run ids it is based on, newest first
 *   total      { wallMs, costUsd, inputTokens, outputTokens, agents }: each
 *              { p50, p90, n } (n: the runs that had a figure) or null; null
 *              without history
 *   phases     [{ phase, runs, ...the figures }]: wallMs from its first agent's
 *              start to its last's end; runs: how many had the phase
 *   adapters   [{ adapter, runs, ...the figures }]
 *   models     [{ model, runs, ...the figures }] — by the model that served
 *              each agent, as its CLI said (ODW extension; see
 *              ../served-model), "(not reported)" for the rest; absent when
 *              no agent's CLI said
 *   estimated  some output tokens are chars/4 estimates
 *   notes      how to read it, a sentence each
 */

import { readUsage, type Usage } from "../adapters/usage.js";
import { RUN_FAILED, RUN_FINISHED, RUN_STARTED, RUN_STOPPED } from "../events.js";
import { CostHistory, spread, type CostSample, type Spread } from "../forecast.js";
import { stableJson } from "../journal.js";
import { fmtDuration, fmtTokens, fmtUsd, padEndWidth, palette, sanitizeText, truncateToWidth, type TermCaps } from "../tty.js";
import type { RunStore } from "./run-store.js";
import { readFacts } from "./runs-view.js";

/** How many finished runs an estimate is built from, at most. */
export const ESTIMATE_RUNS = 20;

/** How many of a workflow's runs, newest first, are looked at for finished ones. */
const SCAN_RUNS = 500;

/** One agent of an earlier run, as the estimate reads it. */
export interface HistoryAgent {
  label: string;
  phase: string | null;
  adapter: string | null;
  /** The model its CLI said served it — the first it named (ODW extension); null or absent: not reported. */
  servedModel?: string | null;
  /** Epoch seconds. */
  startedAt: number | null;
  finishedAt: number | null;
  usage: Usage | null;
}

/** One finished run of the workflow, as the estimate reads it. */
export interface HistoryRun {
  runId: string;
  sourceHash: string | null;
  args: unknown;
  /** Epoch seconds: its run_started event, and its terminal one. */
  startedAt: number | null;
  endedAt: number | null;
  /** Its agents that ran (none replayed), in call order. */
  agents: HistoryAgent[];
}

/** The figures of a run, a phase or an adapter, across runs. */
export interface EstimateFigures {
  wallMs: Spread | null;
  costUsd: Spread | null;
  inputTokens: Spread | null;
  outputTokens: Spread | null;
  agents: Spread | null;
}

export interface PhaseEstimate extends EstimateFigures {
  /** null: agents started before any phase(). */
  phase: string | null;
  /** How many of the runs had agents in it. */
  runs: number;
}

export interface AdapterEstimate extends EstimateFigures {
  adapter: string;
  runs: number;
}

/** The figures of the agents one model served, across runs (ODW extension; see ../served-model). */
export interface ModelEstimate extends EstimateFigures {
  /** The model their CLI said served them; "(not reported)" for agents whose CLI said none. */
  model: string;
  runs: number;
}

export interface WorkflowEstimate {
  version: 1;
  workflow: string;
  sourceHash: string | null;
  match: "sourceHash" | "name" | null;
  runs: string[];
  total: EstimateFigures | null;
  phases: PhaseEstimate[];
  adapters: AdapterEstimate[];
  /** By served model (ODW extension): absent when no agent's CLI named one. */
  models?: ModelEstimate[];
  estimated: boolean;
  notes: string[];
}

export interface EstimateOptions {
  workflow: string;
  /** The sha256 of the workflow's source as it would run now; null matches by name only. */
  sourceHash: string | null;
  /** The args it would run with, when known: the estimate says whether earlier runs had them. */
  args?: unknown;
  /** Runs to base it on, at most (default {@link ESTIMATE_RUNS}). */
  limit?: number;
}

/** The model group of agents whose CLI named no model (ODW extension). */
const NOT_REPORTED = "(not reported)";

/** What the estimate says without history. */
export const NO_HISTORY = "no estimate: no finished runs of this workflow yet";

/**
 * Which runs an estimate is based on: of `candidates` (finished, newest
 * first), the newest `limit` of the same source when any has it, else the
 * newest `limit` of them all — and how they were matched.
 */
export function selectRuns<T extends { sourceHash: string | null }>(
  candidates: readonly T[],
  sourceHash: string | null,
  limit = ESTIMATE_RUNS,
): { runs: T[]; match: "sourceHash" | "name" | null } {
  const same = sourceHash ? candidates.filter((c) => c.sourceHash === sourceHash) : [];
  if (same.length > 0) return { runs: same.slice(0, limit), match: "sourceHash" };
  if (candidates.length > 0) return { runs: candidates.slice(0, limit), match: "name" };
  return { runs: [], match: null };
}

/** The estimate from a workflow's finished runs (newest first): {@link selectRuns}, then the figures. Pure. */
export function estimateWorkflow(candidates: readonly HistoryRun[], opts: EstimateOptions): WorkflowEstimate {
  const { runs, match } = selectRuns(candidates, opts.sourceHash, opts.limit);
  return estimateFrom(runs, match, opts);
}

/** The estimate from the runs it is based on. Pure. */
export function estimateFrom(runs: readonly HistoryRun[], match: "sourceHash" | "name" | null, opts: EstimateOptions): WorkflowEstimate {
  const base = { version: 1 as const, workflow: opts.workflow, sourceHash: opts.sourceHash ?? null };
  if (runs.length === 0 || match === null) {
    return { ...base, match: null, runs: [], total: null, phases: [], adapters: [], estimated: false, notes: [NO_HISTORY] };
  }
  const total = figures(runs.map((run) => groupFigures(run.agents, wallOf(run))));
  const phases: PhaseEstimate[] = [];
  for (const phase of orderOf(runs, (a) => a.phase)) {
    const per = runs.map((run) => run.agents.filter((a) => a.phase === phase)).filter((agents) => agents.length > 0);
    phases.push({ phase, runs: per.length, ...figures(per.map((agents) => groupFigures(agents, spanOf(agents)))) });
  }
  const adapters: AdapterEstimate[] = [];
  for (const adapter of orderOf(runs, (a) => a.adapter ?? "(unknown)")) {
    const per = runs
      .map((run) => run.agents.filter((a) => (a.adapter ?? "(unknown)") === adapter))
      .filter((agents) => agents.length > 0);
    adapters.push({ adapter: adapter!, runs: per.length, ...figures(per.map((agents) => groupFigures(agents, spanOf(agents)))) });
  }
  // By the model that served them (ODW extension): spend on one model is not mixed with another's.
  const models: ModelEstimate[] = [];
  if (runs.some((run) => run.agents.some((a) => a.servedModel))) {
    const servedBy = (a: HistoryAgent): string => a.servedModel ?? NOT_REPORTED;
    for (const model of orderOf(runs, servedBy)) {
      const per = runs.map((run) => run.agents.filter((a) => servedBy(a) === model)).filter((agents) => agents.length > 0);
      models.push({ model, runs: per.length, ...figures(per.map((agents) => groupFigures(agents, spanOf(agents)))) });
    }
  }
  const estimated = runs.some((run) => run.agents.some((a) => a.usage?.estimated === true));
  return {
    ...base,
    match,
    runs: runs.map((r) => r.runId),
    total,
    phases,
    adapters,
    ...(models.length > 0 ? { models } : {}),
    estimated,
    notes: notesFor(runs, match, opts, estimated, total),
  };
}

/** How to read the estimate, a sentence each. */
function notesFor(
  runs: readonly HistoryRun[],
  match: "sourceHash" | "name",
  opts: EstimateOptions,
  estimated: boolean,
  total: EstimateFigures,
): string[] {
  const n = runs.length;
  const of = `${n} finished run${n === 1 ? "" : "s"}`;
  const notes = [
    match === "sourceHash"
      ? `based on the last ${of} of this exact source`
      : opts.sourceHash
        ? `no finished run of this exact source yet: based on the last ${of} of workflow ${opts.workflow}, whose source differed`
        : `based on the last ${of} of workflow ${opts.workflow}`,
    "it assumes similar args: fan-outs as wide as in those runs (agents per phase)",
  ];
  if (opts.args !== undefined) {
    const given = stableJson(opts.args ?? null);
    const same = runs.filter((r) => stableJson(r.args ?? null) === given).length;
    notes.push(
      same === 0
        ? "none of those runs had these args"
        : same === n
          ? "every one of those runs had these args"
          : `${same} of those ${n} runs had these args`,
    );
  }
  if (n < 3) notes.push(`only ${of}: the p90 is the worst of ${n === 1 ? "one" : "two"}`);
  if (!total.costUsd) notes.push("no agent of those runs reported a cost: tokens only");
  else if (total.costUsd.n < n) notes.push(`${n - total.costUsd.n} of those runs reported no cost: the cost is from the other ${total.costUsd.n}`);
  if (estimated) notes.push("some output tokens are estimates (chars/4 of replies whose CLI reported no usage)");
  return notes;
}

/** One group's figures in one run: its wall time, what its agents spent, how many there were. */
interface GroupFigures {
  wallMs: number | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  agents: number;
}

function groupFigures(agents: readonly HistoryAgent[], wallMs: number | null): GroupFigures {
  const sum = (key: "costUsd" | "inputTokens" | "outputTokens"): number | null => {
    const values = agents.map((a) => a.usage?.[key]).filter((v): v is number => typeof v === "number");
    if (values.length === 0) return null;
    const total = values.reduce((x, y) => x + y, 0);
    // Cents add up in binary floating point: keep dollars tidy, as addUsage does.
    return key === "costUsd" ? Math.round(total * 1e9) / 1e9 : total;
  };
  return { wallMs, costUsd: sum("costUsd"), inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), agents: agents.length };
}

function figures(groups: readonly GroupFigures[]): EstimateFigures {
  const of = (key: keyof GroupFigures) => spread(groups.map((g) => g[key]).filter((v): v is number => v !== null));
  return { wallMs: of("wallMs"), costUsd: of("costUsd"), inputTokens: of("inputTokens"), outputTokens: of("outputTokens"), agents: of("agents") };
}

/** A run's wall time in ms: from its start to its end. */
function wallOf(run: HistoryRun): number | null {
  return run.startedAt !== null && run.endedAt !== null ? Math.max(0, Math.round((run.endedAt - run.startedAt) * 1000)) : null;
}

/** Agents' wall time in ms: from the first one's start to the last one's end. */
function spanOf(agents: readonly HistoryAgent[]): number | null {
  const starts = agents.map((a) => a.startedAt).filter((v): v is number => v !== null);
  const ends = agents.map((a) => a.finishedAt).filter((v): v is number => v !== null);
  if (starts.length === 0 || ends.length === 0) return null;
  return Math.max(0, Math.round((Math.max(...ends) - Math.min(...starts)) * 1000));
}

/** The distinct keys of the runs' agents: the newest run's in call order, then the others' as they come. */
function orderOf<K>(runs: readonly HistoryRun[], key: (a: HistoryAgent) => K): K[] {
  const seen: K[] = [];
  for (const run of runs) for (const a of run.agents) if (!seen.includes(key(a))) seen.push(key(a));
  return seen;
}

// --- reading the runs ----------------------------------------------------------

/** A finished run of the workflow before its events are read. */
interface Candidate {
  runId: string;
  sourceHash: string | null;
  args: unknown;
}

/** A run no model answered: `odw run --dry` (meta.dry), or a test case of `odw test` (origin "test"). */
export function isMockRun(meta: Record<string, unknown>): boolean {
  return meta.dry === true || meta.origin === "test";
}

/**
 * The finished runs of `workflow`, newest first — not resumed ones, nor dry
 * or test runs ({@link isMockRun}), nor `exclude` — read from its bucket of the runs root: enough of them that the
 * newest `limit` of `sourceHash` are there when they exist.
 */
function candidates(store: RunStore, workflow: string, sourceHash: string | null, limit: number, exclude?: string): Candidate[] {
  const out: Candidate[] = [];
  let same = 0;
  for (const ref of store.listRunsForWorkflow(workflow).slice(0, SCAN_RUNS)) {
    if (ref.runId === exclude) continue;
    let meta: Record<string, unknown>;
    let status: Record<string, unknown>;
    try {
      meta = store.readMeta(ref.runId);
      status = store.readStatus(ref.runId);
    } catch {
      continue;
    }
    const name = typeof meta.workflowName === "string" ? meta.workflowName : typeof status.name === "string" ? status.name : null;
    if (name !== workflow || status.state !== "done" || typeof meta.resumedFrom === "string") continue;
    // Its agents answered with stubs or scripted replies, no model called: nothing it spent or took says what a run costs.
    if (isMockRun(meta)) continue;
    const hash = typeof meta.sourceHash === "string" ? meta.sourceHash : null;
    out.push({ runId: ref.runId, sourceHash: hash, args: meta.args ?? null });
    if (sourceHash && hash === sourceHash && ++same >= limit) break;
  }
  return out;
}

/** A finished run's agents and its start and end, read from its events. */
function readHistoryRun(store: RunStore, c: Candidate): HistoryRun {
  const events = store.readEvents(c.runId);
  const { fold } = readFacts(store, c.runId, events);
  let startedAt: number | null = null;
  let endedAt: number | null = null;
  for (const ev of events) {
    if (ev.type === RUN_STARTED) startedAt ??= num(ev.ts);
    else if (ev.type === RUN_FINISHED || ev.type === RUN_FAILED || ev.type === RUN_STOPPED) endedAt = num(ev.ts);
  }
  const agents: HistoryAgent[] = fold.agents
    .filter((a) => a.kind === "agent" && !a.cached && (a.state === "done" || a.state === "failed"))
    .map((a) => ({
      label: a.label,
      phase: a.phase,
      adapter: a.adapter,
      servedModel: a.servedModel?.[0] ?? null,
      startedAt: a.startedAt,
      finishedAt: a.finishedAt,
      usage: readUsage(a.usage) ?? null,
    }));
  return { runId: c.runId, sourceHash: c.sourceHash, args: c.args, startedAt, endedAt, agents };
}

/** The runs an estimate of `workflow` is based on, read from the store, and how they were matched. */
export function readHistory(
  store: RunStore,
  opts: { workflow: string; sourceHash: string | null; limit?: number; exclude?: string },
): { runs: HistoryRun[]; match: "sourceHash" | "name" | null } {
  const limit = opts.limit ?? ESTIMATE_RUNS;
  const picked = selectRuns(candidates(store, opts.workflow, opts.sourceHash, limit, opts.exclude), opts.sourceHash, limit);
  const runs: HistoryRun[] = [];
  for (const c of picked.runs) {
    try {
      runs.push(readHistoryRun(store, c));
    } catch {
      // A run directory that cannot be read is left out, never fatal.
    }
  }
  return { runs, match: runs.length > 0 ? picked.match : null };
}

/** `odw estimate`'s and `GET /api/estimate`'s estimate, from the store. */
export function loadEstimate(store: RunStore, opts: EstimateOptions & { exclude?: string }): WorkflowEstimate {
  const { runs, match } = readHistory(store, opts);
  return estimateFrom(runs, match, opts);
}

/**
 * The source the newest run of `workflow` ran (its meta.sourceHash), what
 * `GET /api/estimate` matches by when asked for none; null when none says.
 */
export function latestSourceHash(store: RunStore, workflow: string): string | null {
  for (const ref of store.listRunsForWorkflow(workflow).slice(0, SCAN_RUNS)) {
    try {
      const meta = store.readMeta(ref.runId);
      if (meta.workflowName !== workflow && ref.workflowName !== workflow) continue;
      return typeof meta.sourceHash === "string" ? meta.sourceHash : null;
    } catch {
      continue;
    }
  }
  return null;
}

/** What a run's fan-out forecasts are made from (see ../forecast); null without history. */
export function costHistoryOf(runs: readonly HistoryRun[], match: "sourceHash" | "name" | null): CostHistory | null {
  if (match === null || runs.length === 0) return null;
  const samples: CostSample[] = [];
  for (const run of runs) {
    for (const a of run.agents) {
      samples.push({
        runId: run.runId,
        phase: a.phase,
        label: a.label,
        ...(a.usage?.costUsd !== undefined ? { costUsd: a.usage.costUsd } : {}),
        ...(a.usage?.outputTokens !== undefined ? { outputTokens: a.usage.outputTokens } : {}),
      });
    }
  }
  return new CostHistory(samples, match);
}

/** The history a running run's fan-out forecasts are made from: {@link readHistory}, then {@link costHistoryOf}. */
export function loadCostHistory(
  store: RunStore,
  opts: { workflow: string; sourceHash: string | null; exclude?: string },
): CostHistory | null {
  const { runs, match } = readHistory(store, opts);
  return costHistoryOf(runs, match);
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// --- the CLI's view ------------------------------------------------------------

/** `odw estimate`'s (and `odw run --estimate`'s) lines. */
export function formatEstimate(est: WorkflowEstimate, opts: { width: number; caps: TermCaps }): string[] {
  const p = palette(opts.caps);
  const name = sanitizeText(est.workflow, 80);
  if (!est.total) return [`${p.bold(name)}: ${NO_HISTORY}`];
  const lines = [`${p.bold(`estimate for ${name}`)} ${p.dim(`(${est.runs.length} run${est.runs.length === 1 ? "" : "s"}, matched by ${est.match === "sourceHash" ? "source" : "name"})`)}`];
  const head = ["", "agents", "time p50 / p90", "cost p50 / p90", "out tokens p50 / p90"];
  const rows: string[][] = [["total", ...cells(est.total)]];
  for (const ph of est.phases) rows.push([`phase ${ph.phase === null ? "(none)" : sanitizeText(ph.phase, 60)}`, ...cells(ph)]);
  for (const ad of est.adapters) rows.push([`adapter ${sanitizeText(ad.adapter, 60)}`, ...cells(ad)]);
  for (const m of est.models ?? []) rows.push([`model ${sanitizeText(m.model, 60)}`, ...cells(m)]);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  widths[0] = Math.min(widths[0]!, 32);
  const line = (r: string[]) => "  " + r.map((c, i) => padEndWidth(truncateToWidth(c, widths[i]!), widths[i]!)).join("  ").trimEnd();
  lines.push(p.dim(line(head)));
  for (const r of rows) lines.push(truncateToWidth(line(r), opts.width));
  for (const note of est.notes) lines.push(p.dim(truncateToWidth(`  · ${note}`, opts.width)));
  return lines;
}

function cells(f: EstimateFigures): string[] {
  const pair = (s: Spread | null, fmt: (n: number) => string) => (s ? `${fmt(s.p50)} / ${fmt(s.p90)}` : "-");
  const agents = f.agents ? (f.agents.p50 === f.agents.p90 ? String(f.agents.p50) : `${f.agents.p50}–${f.agents.p90}`) : "-";
  return [agents, pair(f.wallMs, fmtDuration), pair(f.costUsd, fmtUsd), pair(f.outputTokens, fmtTokens)];
}
