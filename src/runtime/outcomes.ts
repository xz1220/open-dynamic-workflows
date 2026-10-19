/**
 * Outcomes across runs (an ODW extension): what became of the work runs did,
 * over weeks — `odw outcomes` and the dashboard's Review page.
 *
 * Built only from what the runs recorded and what people marked: each run's
 * state and folded events (failure reasons, `expect` misses, out-of-scope
 * files, retries, handoffs and fallbacks, resolver runs, usage, the requested
 * and the served model), its kept diffs, and the review marks of
 * `reviews.jsonl` (see ./review) — `odw apply` marks what it applied. No model
 * judges anything, and nothing outside ODW is asked (a PR's merge state on
 * GitHub is not read: "applied" is ODW's own mark).
 *
 * A run counts in the window when it was created in it; marks are read as they
 * stand now, so a diff applied a week after its run counts for that run. Left
 * out: dry runs, runs still going (pending, running, paused, waiting), and the
 * runs `odw eval`, `odw test`, `odw conformance` and `odw apply --resolve`
 * started — their diffs are no proposals, their resolver's spend is not the
 * workflow's. Runs pulled with `odw pull` sit in the same runs root and count.
 *
 * Every row (the window's total, each week, each workflow, adapter and model)
 * has the same fields. A workflow row counts its runs; an adapter or model row
 * counts its agents, the runs they ran in, and a failed run only when one of
 * its own agents failed in it (with that agent's reason) — a script error is
 * the workflow's, not an adapter's. The model is the one its CLI said served
 * the agent (U3), else the one it asked for ("… (requested)"), else the CLI's
 * default.
 */

import { existsSync } from "node:fs";

import { fmtTokens, fmtUsd, palette, padEndWidth, sanitizeText, truncateToWidth, type TermCaps } from "../tty.js";
import { formatDuration } from "./notify.js";
import { agentEvidence, latestMarks, readReviews, type AgentEvidence } from "./review.js";
import type { RunStore } from "./run-store.js";
import { detailFrom, readFacts, type AgentView, type RunDetail } from "./runs-view.js";

/** One row of the report: a workflow, an adapter, a model, a week or the whole window. */
export interface OutcomeRow {
  key: string;
  runs: number;
  runsDone: number;
  /** Failed runs, and stale ones (their worker died without an end). */
  runsFailed: number;
  /** Failed runs by reason: the commonest reason of their failed agents, else `stale` or `script_error`. */
  runReasons: Record<string, number>;
  /** Runs `odw replay` started (one agent run again). */
  replays: number;
  agents: number;
  agentsFailed: number;
  /** Failed agents by reason (`unknown` when none was recorded). */
  agentReasons: Record<string, number>;
  /** Agents that kept a diff: what became of each, by its last review mark. */
  kept: number;
  applied: number;
  dismissed: number;
  /** Marked reviewed, not applied (yet). */
  reviewed: number;
  /** No mark, or put back on the queue (`open`). */
  left: number;
  /** applied / kept; null without a kept diff. */
  acceptRate: number | null;
  /** Retries logged (expect, rate_limit, stall, question), and how many agents needed one. */
  retries: number;
  retried: number;
  /** Agents that fell back to another adapter or were handed over. */
  handedOff: number;
  /** Kept diffs that conflicted at apply and needed `odw apply --resolve`. */
  resolved: number;
  /** Kept diffs that needed a retry, a fallback or a resolver; and that share of `kept`. */
  reworked: number;
  reworkRate: number | null;
  /** Agents that missed an `expect` check, changed an `untouched` file, or wrote outside their `scope`. */
  unmet: number;
  untouched: number;
  outOfScope: number;
  /** Dollars, when some agent reported any; tokens always. */
  costUsd: number | null;
  tokens: number;
  estimated: boolean;
  /** Everything the row spent per applied change; null without an applied change (or dollars). */
  costPerApplied: number | null;
  tokensPerApplied: number | null;
}

/** A week of the trend: from Monday 00:00 UTC. */
export interface OutcomeWeek extends OutcomeRow {
  /** Unix seconds. */
  start: number;
}

/** A change from the previous window large enough to call out. */
export interface OutcomeShift {
  metric: "acceptRate" | "failRate" | "reworkRate" | "costPerApplied";
  /** The previous window's value, and this one's. */
  before: number;
  after: number;
  /** "better" or "worse" for the people who read it. */
  direction: "better" | "worse";
}

export interface Outcomes {
  version: 1;
  /** The window, Unix seconds. */
  since: number;
  until: number;
  workflow: string | null;
  runsRoot: string;
  total: OutcomeRow;
  /** The window as long before this one; null when it held no run. */
  previous: OutcomeRow | null;
  /** What moved notably against `previous`. */
  shifts: OutcomeShift[];
  /** Oldest first; weeks without a run are kept, so the trend has no gaps. */
  weeks: OutcomeWeek[];
  /** Most runs (or agents) first. */
  workflows: OutcomeRow[];
  adapters: OutcomeRow[];
  models: OutcomeRow[];
}

export interface OutcomesOptions {
  since: number;
  until: number;
  workflow?: string | null;
}

const WEEK = 7 * 86_400;
/** Monday 1970-01-05 00:00 UTC. */
const MONDAY = 4 * 86_400;
/** Origins whose runs are no workflow's own work. */
const SKIPPED_ORIGINS = new Set(["eval", "test", "conformance", "apply-resolve"]);
const SETTLED = new Set(["done", "failed", "stopped", "stale"]);
const UNTOUCHED_MISS = /^no file matching .+ may change, and /;

/** The Monday 00:00 UTC on or before `ts`. */
export function weekStart(ts: number): number {
  return Math.floor((ts - MONDAY) / WEEK) * WEEK + MONDAY;
}

export function emptyRow(key: string): OutcomeRow {
  return {
    key,
    runs: 0,
    runsDone: 0,
    runsFailed: 0,
    runReasons: {},
    replays: 0,
    agents: 0,
    agentsFailed: 0,
    agentReasons: {},
    kept: 0,
    applied: 0,
    dismissed: 0,
    reviewed: 0,
    left: 0,
    acceptRate: null,
    retries: 0,
    retried: 0,
    handedOff: 0,
    resolved: 0,
    reworked: 0,
    reworkRate: null,
    unmet: 0,
    untouched: 0,
    outOfScope: 0,
    costUsd: null,
    tokens: 0,
    estimated: false,
    costPerApplied: null,
    tokensPerApplied: null,
  };
}

/** One agent's facts, as the rows count them. */
interface AgentFacts {
  adapter: string;
  model: string;
  failed: string | null;
  /** Its last review mark, when it kept a diff; "left" when it kept one nobody dealt with. */
  kept: "applied" | "dismissed" | "reviewed" | "left" | null;
  retries: number;
  handedOff: boolean;
  resolved: boolean;
  unmet: boolean;
  untouched: boolean;
  outOfScope: boolean;
  costUsd: number | null;
  tokens: number;
  estimated: boolean;
}

/** One settled run's facts. */
interface RunFacts {
  workflow: string;
  createdAt: number;
  state: "done" | "failed" | "stopped" | "stale";
  /** Why it failed (failed and stale runs only). */
  reason: string | null;
  replay: boolean;
  agents: AgentFacts[];
}

/** The model a row of models files an agent under. */
export function modelKey(a: AgentView): string {
  if (a.servedModel?.length) return [...new Set(a.servedModel)].sort().join(" + ");
  if (a.model) return `${a.model} (requested)`;
  return "(CLI default)";
}

function agentFacts(store: RunStore, runId: string, a: AgentView, ev: AgentEvidence | undefined, marks: Map<number, { state: string }>): AgentFacts {
  const keptDiff = a.agentId !== null && !!a.changes && existsSync(store.agentDiffPath(runId, a.agentId));
  let kept: AgentFacts["kept"] = null;
  if (keptDiff) {
    const mark = marks.get(a.agentId!)?.state;
    kept = mark === "applied" || mark === "dismissed" || mark === "reviewed" ? mark : "left";
  }
  const misses = a.misses ?? [];
  const u = a.usage;
  return {
    adapter: a.adapter ?? "unknown",
    model: modelKey(a),
    failed: a.state === "failed" || a.state === "stale" ? (a.state === "stale" ? "stale" : (a.failureReason ?? "unknown")) : null,
    kept,
    retries: Object.values(ev?.retries ?? {}).reduce((n, c) => n + c, 0),
    handedOff: !!a.fellBackFrom?.length || !!ev?.handoffs.length,
    resolved: !!ev?.resolves.length,
    unmet: misses.some((m) => !UNTOUCHED_MISS.test(m)),
    untouched: misses.some((m) => UNTOUCHED_MISS.test(m)),
    outOfScope: !!a.outOfScope?.length,
    costUsd: typeof u?.costUsd === "number" ? u.costUsd : null,
    tokens: (u?.inputTokens ?? 0) + (u?.outputTokens ?? 0),
    estimated: u?.estimated === true,
  };
}

/** A failed run's reason: its failed agents' commonest (ties by name), else stale or a script error. */
function runReason(run: RunDetail, agents: AgentFacts[]): string {
  const counts: Record<string, number> = {};
  for (const a of agents) if (a.failed) counts[a.failed] = (counts[a.failed] ?? 0) + 1;
  const top = Object.entries(counts).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0];
  if (top) return top[0];
  return run.state === "stale" ? "stale" : "script_error";
}

/** A settled run's facts; null when it is left out. */
function readRun(store: RunStore, runId: string): RunFacts | null {
  const meta = store.readMeta(runId);
  if (SKIPPED_ORIGINS.has(String(meta.origin)) || meta.dry === true) return null;
  let run: RunDetail;
  let events;
  try {
    events = store.readEvents(runId);
    run = detailFrom(runId, readFacts(store, runId, events), { hasResult: false, error: null });
  } catch {
    return null; // a half-written run directory
  }
  if (run.dry || !SETTLED.has(run.state)) return null;
  const evidence = agentEvidence(events, run.agents);
  const marks = latestMarks(readReviews(store.runDir(runId)));
  const agents = run.agents
    .filter((a) => (a.kind ?? "agent") === "agent" && !a.cached)
    .map((a) => agentFacts(store, runId, a, a.agentId === null ? undefined : evidence.get(a.agentId), marks));
  const state = run.state as RunFacts["state"];
  return {
    workflow: run.workflowName ?? run.name,
    createdAt: run.createdAt ?? 0,
    state,
    reason: state === "failed" || state === "stale" ? runReason(run, agents) : null,
    replay: meta.origin === "replay",
    agents,
  };
}

/** Count one agent into a row. */
function addAgent(row: OutcomeRow, a: AgentFacts): void {
  row.agents += 1;
  if (a.failed) {
    row.agentsFailed += 1;
    row.agentReasons[a.failed] = (row.agentReasons[a.failed] ?? 0) + 1;
  }
  if (a.kept) {
    row.kept += 1;
    row[a.kept] += 1;
    if (a.retries > 0 || a.handedOff || a.resolved) row.reworked += 1;
    if (a.resolved) row.resolved += 1;
  }
  row.retries += a.retries;
  if (a.retries > 0) row.retried += 1;
  if (a.handedOff) row.handedOff += 1;
  if (a.unmet) row.unmet += 1;
  if (a.untouched) row.untouched += 1;
  if (a.outOfScope) row.outOfScope += 1;
  if (a.costUsd !== null) row.costUsd = (row.costUsd ?? 0) + a.costUsd;
  row.tokens += a.tokens;
  if (a.estimated) row.estimated = true;
}

/** Count one run into a row: the run itself (its failure with `reason`), and `agents` of it. */
function addRun(row: OutcomeRow, run: RunFacts, agents: AgentFacts[], reason: string | null): void {
  row.runs += 1;
  if (run.state === "done") row.runsDone += 1;
  if (reason) {
    row.runsFailed += 1;
    row.runReasons[reason] = (row.runReasons[reason] ?? 0) + 1;
  }
  if (run.replay) row.replays += 1;
  for (const a of agents) addAgent(row, a);
}

/** Fill in a row's rates once everything is counted. */
function finish<T extends OutcomeRow>(row: T): T {
  row.acceptRate = row.kept ? row.applied / row.kept : null;
  row.reworkRate = row.kept ? row.reworked / row.kept : null;
  row.costPerApplied = row.applied && row.costUsd !== null ? row.costUsd / row.applied : null;
  row.tokensPerApplied = row.applied ? row.tokens / row.applied : null;
  return row;
}

/** Group a window's runs by what `keyOf` files each agent under. */
function byAgentKey(runs: RunFacts[], keyOf: (a: AgentFacts) => string): OutcomeRow[] {
  const rows = new Map<string, OutcomeRow>();
  for (const run of runs) {
    const groups = new Map<string, AgentFacts[]>();
    for (const a of run.agents) groups.set(keyOf(a), [...(groups.get(keyOf(a)) ?? []), a]);
    for (const [key, agents] of groups) {
      let row = rows.get(key);
      if (!row) rows.set(key, (row = emptyRow(key)));
      // A failed run is this group's only when one of its own agents failed in it.
      const own = agents.find((a) => a.failed)?.failed ?? null;
      addRun(row, run, agents, run.reason ? own : null);
    }
  }
  return [...rows.values()].map(finish).sort((x, y) => y.agents - x.agents || x.key.localeCompare(y.key));
}

/** The previous window against this one: what moved enough to say so. */
export function shiftsOf(before: OutcomeRow | null, after: OutcomeRow): OutcomeShift[] {
  if (!before) return [];
  const out: OutcomeShift[] = [];
  // A rate moves notably by 15 points or more, over at least 5 of what it is a share of on both sides.
  const rate = (metric: OutcomeShift["metric"], b: number | null, a: number | null, nb: number, na: number, higherIsBetter: boolean) => {
    if (b === null || a === null || nb < 5 || na < 5 || Math.abs(a - b) < 0.15) return;
    out.push({ metric, before: b, after: a, direction: a > b === higherIsBetter ? "better" : "worse" });
  };
  rate("acceptRate", before.acceptRate, after.acceptRate, before.kept, after.kept, true);
  const fail = (r: OutcomeRow) => (r.runs ? r.runsFailed / r.runs : null);
  rate("failRate", fail(before), fail(after), before.runs, after.runs, false);
  rate("reworkRate", before.reworkRate, after.reworkRate, before.kept, after.kept, false);
  // Cost per applied change moves notably by half again (or a third less), over 3 applied changes on both sides.
  const b = before.costPerApplied;
  const a = after.costPerApplied;
  if (b !== null && a !== null && b > 0 && before.applied >= 3 && after.applied >= 3 && (a / b >= 1.5 || a / b <= 2 / 3)) {
    out.push({ metric: "costPerApplied", before: b, after: a, direction: a < b ? "better" : "worse" });
  }
  return out;
}

/** Collect the outcomes of `store`'s runs created in a window, and the window as long before it. */
export function collectOutcomes(store: RunStore, options: OutcomesOptions): Outcomes {
  const workflow = options.workflow ?? null;
  const { since, until } = options;
  const prevSince = since - (until - since);
  const refs = workflow ? store.listRunsForWorkflow(workflow) : store.listRuns();
  const runs: RunFacts[] = [];
  const earlier: RunFacts[] = [];
  for (const { runId } of refs) {
    const createdAt = store.readMeta(runId).createdAt;
    if (typeof createdAt !== "number" || createdAt < prevSince || createdAt >= until) continue;
    const run = readRun(store, runId);
    if (!run || (workflow !== null && run.workflow !== workflow)) continue;
    (run.createdAt >= since ? runs : earlier).push(run);
  }

  const total = emptyRow("total");
  for (const run of runs) addRun(total, run, run.agents, run.reason);
  finish(total);
  let previous: OutcomeRow | null = null;
  if (earlier.length) {
    previous = emptyRow("previous");
    for (const run of earlier) addRun(previous, run, run.agents, run.reason);
    finish(previous);
  }

  const weeks: OutcomeWeek[] = [];
  for (let start = weekStart(since); start < until; start += WEEK) weeks.push({ ...emptyRow(new Date(start * 1000).toISOString().slice(0, 10)), start });
  for (const run of runs) {
    const week = weeks.find((w) => run.createdAt >= w.start && run.createdAt < w.start + WEEK);
    if (week) addRun(week, run, run.agents, run.reason);
  }
  weeks.forEach(finish);

  const workflows = new Map<string, OutcomeRow>();
  for (const run of runs) {
    let row = workflows.get(run.workflow);
    if (!row) workflows.set(run.workflow, (row = emptyRow(run.workflow)));
    addRun(row, run, run.agents, run.reason);
  }

  return {
    version: 1,
    since,
    until,
    workflow,
    runsRoot: store.root,
    total,
    previous,
    shifts: shiftsOf(previous, total),
    weeks,
    workflows: [...workflows.values()].map(finish).sort((x, y) => y.runs - x.runs || x.key.localeCompare(y.key)),
    adapters: byAgentKey(runs, (a) => a.adapter),
    models: byAgentKey(runs, (a) => a.model),
  };
}

// --- text ---------------------------------------------------------------------------------

/** A window's length: whole weeks or days as `4w`, `30d`, else hours and minutes. */
export function spanText(seconds: number): string {
  if (seconds >= WEEK && seconds % WEEK === 0) return `${seconds / WEEK}w`;
  if (seconds >= 86_400 && seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  return formatDuration(seconds);
}

const pct = (r: number | null): string => (r === null ? "—" : `${Math.round(r * 100)}%`);

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function reasonsText(reasons: Record<string, number>): string {
  return Object.entries(reasons)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([why, n]) => `${why} ${n}`)
    .join(", ");
}

const SHIFT_WORDS: Record<OutcomeShift["metric"], string> = {
  acceptRate: "applied share of kept diffs",
  failRate: "failed share of runs",
  reworkRate: "reworked share of kept diffs",
  costPerApplied: "cost per applied change",
};

export function shiftText(s: OutcomeShift): string {
  const v = (n: number) => (s.metric === "costPerApplied" ? fmtUsd(n) : pct(n));
  return `${SHIFT_WORDS[s.metric]} ${v(s.before)} → ${v(s.after)} (${s.direction})`;
}

/** Cost per applied change, as a cell: dollars, else tokens, else "—". */
function perApplied(r: OutcomeRow): string {
  if (r.costPerApplied !== null) return fmtUsd(r.costPerApplied);
  if (r.tokensPerApplied !== null) return `${fmtTokens(r.tokensPerApplied)} tok`;
  return "—";
}

const COLUMNS = ["runs", "failed", "kept", "applied", "dismissed", "left", "reworked", "per applied"];

function tableLines(rows: OutcomeRow[], width: number, counting: "runs" | "agents"): string[] {
  const head = [padEndWidth("", width), ...[counting, ...COLUMNS.slice(1)].map((c) => c.padStart(Math.max(9, c.length)))].join(" ");
  const out = [head];
  for (const r of rows) {
    const failed = counting === "runs" ? `${r.runsFailed}/${r.runs}` : `${r.agentsFailed}/${r.agents}`;
    const cells = [
      String(counting === "runs" ? r.runs : r.agents),
      failed,
      String(r.kept),
      r.kept ? `${r.applied} ${pct(r.acceptRate)}` : "0",
      String(r.dismissed),
      String(r.left),
      r.kept ? `${r.reworked} ${pct(r.reworkRate)}` : "0",
      perApplied(r),
    ];
    out.push([padEndWidth(truncateToWidth(sanitizeText(r.key, 80), width), width), ...cells.map((c, i) => c.padStart(Math.max(9, COLUMNS[i]!.length)))].join(" "));
  }
  return out;
}

/** The report for a terminal: the window's totals, what moved, the weekly trend, then a table per grouping. */
export function formatOutcomes(o: Outcomes, caps: TermCaps = { color: false, truecolor: false, unicode: false }): string {
  const p = palette(caps);
  const t = o.total;
  const out: string[] = [];
  out.push(`${p.bold("odw outcomes")}${o.workflow ? ` ${sanitizeText(o.workflow, 80)}` : ""} · last ${spanText(o.until - o.since)} · ${plural(t.runs, "run")}`);
  if (t.runs === 0) {
    out.push("", "No settled run was created in this window.");
    return out.join("\n");
  }
  out.push(
    "",
    `Runs        ${t.runsDone} done · ${t.runsFailed} failed${t.runsFailed ? ` (${reasonsText(t.runReasons)})` : ""}${t.replays ? ` · ${plural(t.replays, "replay")}` : ""}`,
    `Agents      ${t.agents} · ${t.agentsFailed} failed${t.agentsFailed ? ` (${reasonsText(t.agentReasons)})` : ""} · ${t.retries} ${t.retries === 1 ? "retry" : "retries"} over ${plural(t.retried, "agent")}${t.handedOff ? ` · ${t.handedOff} fell back` : ""}`,
    `Kept diffs  ${t.kept} · ${t.applied} applied (${pct(t.acceptRate)}) · ${t.dismissed} dismissed · ${t.reviewed} reviewed · ${t.left} left`,
    `Rework      ${t.reworked} of the kept needed a retry, fallback or resolver (${pct(t.reworkRate)})${t.resolved ? ` · ${t.resolved} resolved at apply` : ""}`,
    `Checks      ${t.unmet} missed expect · ${t.untouched} changed untouched files · ${t.outOfScope} wrote outside scope`,
    `Spend       ${t.costUsd !== null ? `${fmtUsd(t.costUsd)} · ` : ""}${fmtTokens(t.tokens)}${t.estimated ? "~" : ""} tokens · per applied change: ${perApplied(t)}`,
  );
  if (o.previous) {
    out.push("", p.bold("Against the window before"));
    if (o.shifts.length === 0) out.push(p.dim(`  nothing moved notably (previous: ${plural(o.previous.runs, "run")}, ${pct(o.previous.acceptRate)} applied)`));
    for (const s of o.shifts) out.push(`  ${s.direction === "better" ? p.ok("+") : p.err("-")} ${shiftText(s)}`);
  }
  out.push("", p.bold("By week (UTC, from Monday)"));
  for (const w of o.weeks) {
    if (w.runs === 0) {
      out.push(p.dim(`  ${w.key}  no runs`));
      continue;
    }
    out.push(
      `  ${w.key}  ${plural(w.runs, "run")} · ${w.runsFailed} failed · ${w.kept} kept · ${w.applied} applied (${pct(w.acceptRate)}) · ${w.dismissed} dismissed · ${w.left} left · per applied ${perApplied(w)}`,
    );
  }
  const width = (rows: OutcomeRow[]) => Math.min(32, Math.max(8, ...rows.map((r) => Math.min(80, r.key.length))));
  out.push("", p.bold("By workflow"), ...tableLines(o.workflows, width(o.workflows), "runs").map((l) => `  ${l}`));
  out.push("", p.bold("By adapter"), ...tableLines(o.adapters, width(o.adapters), "agents").map((l) => `  ${l}`));
  out.push("", p.bold("By model"), ...tableLines(o.models, width(o.models), "agents").map((l) => `  ${l}`));
  out.push("", p.dim('"applied" is the review mark odw apply (or odw review mark) leaves; no model judged anything.'));
  return out.join("\n");
}

/** Markdown text: no line breaks, the characters that would start formatting escaped. */
const md = (s: string, n = 200) => sanitizeText(s, n).replace(/([\\`*_[\]<>|#~])/g, "\\$1");

function mdTable(rows: OutcomeRow[], counting: "runs" | "agents"): string[] {
  const out = [`| | ${counting} | failed | kept | applied | dismissed | left | reworked | per applied |`, "|---|---:|---:|---:|---:|---:|---:|---:|---:|"];
  for (const r of rows) {
    const n = counting === "runs" ? r.runs : r.agents;
    const failed = counting === "runs" ? r.runsFailed : r.agentsFailed;
    out.push(`| ${md(r.key, 80)} | ${n} | ${failed} | ${r.kept} | ${r.applied} (${pct(r.acceptRate)}) | ${r.dismissed} | ${r.left} | ${r.reworked} | ${perApplied(r)} |`);
  }
  return out;
}

/** The report as markdown (`--markdown`). */
export function outcomesMarkdown(o: Outcomes): string {
  const t = o.total;
  const out: string[] = [`### odw outcomes${o.workflow ? ` · ${md(o.workflow, 80)}` : ""} · last ${spanText(o.until - o.since)} · ${plural(t.runs, "run")}`];
  if (t.runs === 0) return [...out, "", "No settled run was created in this window."].join("\n");
  out.push(
    "",
    `- **Runs** ${t.runsDone} done · ${t.runsFailed} failed${t.runsFailed ? ` (${md(reasonsText(t.runReasons))})` : ""}`,
    `- **Kept diffs** ${t.kept} · ${t.applied} applied (${pct(t.acceptRate)}) · ${t.dismissed} dismissed · ${t.reviewed} reviewed · ${t.left} left`,
    `- **Rework** ${t.reworked} (${pct(t.reworkRate)}) · ${t.retries} retries · ${t.handedOff} fell back · ${t.resolved} resolved at apply`,
    `- **Spend** ${t.costUsd !== null ? `${fmtUsd(t.costUsd)} · ` : ""}${fmtTokens(t.tokens)} tokens · per applied change ${perApplied(t)}`,
  );
  for (const s of o.shifts) out.push(`- **${s.direction === "better" ? "Better" : "Worse"}:** ${md(shiftText(s))}`);
  out.push("", "**By week**", "", ...mdTable(o.weeks, "runs"));
  out.push("", "**By workflow**", "", ...mdTable(o.workflows, "runs"));
  out.push("", "**By adapter**", "", ...mdTable(o.adapters, "agents"));
  out.push("", "**By model**", "", ...mdTable(o.models, "agents"));
  return out.join("\n");
}
