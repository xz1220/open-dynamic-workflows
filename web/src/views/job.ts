/** Job detail — header + phase stepper, then Graph (live DAG) · Timeline · Logs · Result. */
import { glyph, pill } from "../components/glyph";
import { renderJson } from "../components/json";
import { renderTimeline } from "../components/timeline";
import { renderDag } from "../dag";
import { icons } from "../icons";
import { t } from "../i18n";
import { store } from "../store";
import type { AgentView, RunDetail, WorkflowEvent } from "../types";
import { ACTIVE, TERMINAL, esc, fmtClock, fmtDurMs, fmtDurSec } from "../util";
import { EVT_CLASS, emptyArt } from "./activity";

export type JobTab = "graph" | "timeline" | "logs" | "result";

export interface JobViewState {
  tab: JobTab;
  selectedAi: number | null;
  zoom: number;
  logQuery: string;
  logTypes: Set<string>;
  follow: boolean;
  motion: boolean;
}

const LOG_GROUPS: Array<{ key: string; label: string; types: string[] }> = [
  { key: "agent", label: "agents", types: ["agent_started", "agent_finished", "agent_failed"] },
  { key: "phase", label: "phases", types: ["phase_started"] },
  { key: "log", label: "logs", types: ["log"] },
  { key: "run", label: "run", types: ["run_started", "run_finished", "run_failed", "run_stopped"] },
];

/** The phase the run is in: the last one that started. */
export function currentPhase(): string | null {
  let cur: string | null = null;
  for (const e of store.runEvents) if (e.type === "phase_started") cur = String(e.phase);
  return cur;
}

function stepper(run: RunDetail): string {
  const order = run.phaseOrder.length ? run.phaseOrder : run.phases.map((p) => p.title);
  if (!order.length) return `<div class="stepper"></div>`;
  const started = new Set(store.runEvents.filter((e) => e.type === "phase_started").map((e) => String(e.phase)));
  let cur = -1;
  order.forEach((p, i) => {
    if (started.has(p)) cur = i;
  });
  const terminal = TERMINAL.has(run.state);
  const doneAll = run.state === "done";
  return (
    `<div class="stepper">` +
    order
      .map((p, i) => {
        const state = doneAll || i < cur || (terminal && i <= cur) ? "done" : i === cur ? "on" : "";
        const link =
          i < order.length - 1
            ? `<i class="step-link ${i < cur || doneAll ? "done" : i === cur && !terminal ? "on" : ""}"></i>`
            : "";
        return (
          `<span class="step ${state}" data-key="st-${i}"><span class="ix">${String(i + 1).padStart(2, "0")}</span>` +
          `${state === "on" ? glyph(run.state === "running" ? "running" : run.state) : ""}${esc(p)}</span>${link}`
        );
      })
      .join("") +
    `</div>`
  );
}

function runHead(run: RunDetail, nowSec: number): string {
  const terminal = TERMINAL.has(run.state);
  const elapsed =
    run.createdAt != null ? fmtDurSec((terminal ? (run.updatedAt ?? run.createdAt) : nowSec) - run.createdAt) : "—";
  const stop =
    run.provider === "odw" && ACTIVE.has(run.state) && store.capabilities.writable
      ? `<button class="btn danger" data-stop="${esc(run.runId)}">${icons.stop}${t("Stop")}</button>`
      : "";
  const cc = run.provider === "claude" ? `<span class="tag cc">Claude Code · ${t("read-only")}</span>` : "";
  const c = run.counts;
  const stat = (v: string | number, k: string, cls = "") =>
    `<div class="rs ${cls}"><span class="v num">${v}</span><span class="k">${esc(k)}</span></div>`;
  const total = Math.max(1, c.agents);
  const w = (n: number) => `${((n / total) * 100).toFixed(2)}%`;
  return (
    `<header class="run-head">` +
    `<div style="min-width:0"><div class="eyebrow"><span>${t("Run")}</span><span class="mono" style="text-transform:none;letter-spacing:0">${esc(run.runId)}</span>${cc}</div>` +
    `<div class="title-row"><h1 class="display">${esc(run.name)}</h1>${pill(run.state)}</div>` +
    (run.description ? `<p class="lede">${esc(run.description)}</p>` : "") +
    `</div>` +
    `<div class="actions">${stop}` +
    `<button class="btn" data-copy="odw logs ${esc(run.runId)} --follow" data-tip="${esc(t("copy a follow command"))}">${icons.terminal}${t("Follow in terminal")}</button>` +
    `<button class="btn ghost" data-copy="${esc(run.runId)}">${icons.copy}${t("Copy id")}</button></div>` +
    `</header>` +
    `<div class="run-strip">${stepper(run)}<div class="runstats">` +
    stat(c.agents, t("agents")) +
    stat(c.running, t("running"), c.running ? "sig" : "") +
    stat(c.done, t("done")) +
    (c.failed ? stat(c.failed, t("failed"), "alarm") : "") +
    stat(elapsed, t("elapsed")) +
    `</div></div>` +
    `<div class="run-prog"><div class="prog">` +
    `<i class="p-done" style="width:${w(c.done)}"></i><i class="p-run" style="width:${w(c.running)}"></i>` +
    `<i class="p-fail" style="width:${w(c.failed)}"></i><i class="p-stale" style="width:${w(c.stale)}"></i></div></div>`
  );
}

function tabs(run: RunDetail, tab: JobTab): string {
  const item = (key: JobTab, icon: string, label: string, n?: number) =>
    `<a class="tab${tab === key ? " on" : ""}" href="#/job/${encodeURIComponent(run.runId)}/${key}" data-tab="${key}" data-key="tab-${key}" role="tab" aria-selected="${tab === key}">${icon}${esc(label)}${n != null ? `<span class="n">${n}</span>` : ""}</a>`;
  return (
    `<nav class="tabs" role="tablist">` +
    item("graph", icons.graph, t("Graph"), run.agents.length) +
    item("timeline", icons.timeline, t("Timeline")) +
    item("logs", icons.logs, t("Logs"), store.runEvents.length) +
    item("result", icons.result, t("Result")) +
    `<i class="ink-bar"></i></nav>`
  );
}

function agentEvents(a: AgentView): WorkflowEvent[] {
  return store.runEvents.filter(
    (e) =>
      e.type.startsWith("agent_") &&
      (a.agentId != null && typeof e.agentId === "number" ? e.agentId === a.agentId : e.label === a.label),
  );
}

function drawer(run: RunDetail, ai: number, nowSec: number): string {
  const a = run.agents[ai];
  if (!a) return "";
  const dur =
    a.state === "running" && a.startedAt != null ? fmtDurSec(nowSec - a.startedAt) : fmtDurMs(a.durationMs);
  const status =
    a.state === "failed"
      ? `<div class="drawer-sec">${t("Error")}</div><div class="outbox err">${esc(a.error ?? t("(no message)"))}</div>`
      : a.state === "stale"
        ? `<div class="drawer-sec">${t("Status")}</div><div class="outbox">${run.provider === "claude" ? t("no recent signal") : t("worker lost contact")}</div>`
        : "";
  const rec = a.agentId != null ? store.agentResults.get(`${run.runId}:${a.agentId}`) : undefined;
  const output =
    rec && rec.value !== undefined
      ? `<div class="drawer-sec">${t("Output")}${rec.cached ? ` <span class="tag">${t("replayed")}</span>` : ""}` +
        `<button class="iconbtn sm" data-copy="${esc(typeof rec.value === "string" ? rec.value : JSON.stringify(rec.value, null, 2))}" aria-label="${esc(t("Copy"))}">${icons.copy}</button></div>` +
        `<div class="outbox json-out">${renderJson(rec.value)}</div>`
      : rec === null && (a.state === "done" || a.state === "failed")
        ? ""
        : a.state === "done" && a.agentId != null
          ? `<div class="drawer-sec">${t("Output")}</div><div class="outbox"><span class="skel" style="height:12px;width:70%"></span></div>`
          : "";
  const evs = agentEvents(a)
    .map(
      (e) =>
        `<div><span class="ts">${fmtClock(e.ts)}</span>${glyph(e.type === "agent_started" ? "running" : e.type === "agent_failed" ? "failed" : "done")}<span>${esc(e.type.replace("agent_", ""))}${e.attempts ? ` · ${t("attempt {n}", { n: Number(e.attempts) })}` : ""}</span></div>`,
    )
    .join("");
  return (
    `<aside class="drawer" data-key="drawer-${ai}">` +
    `<div class="drawer-head"><div class="row">${pill(a.state)}<span class="tag">${esc(a.adapter ?? "—")}</span>` +
    `<button class="iconbtn" data-close="1" aria-label="${esc(t("Close"))}">${icons.close}</button></div>` +
    `<h4>${esc(a.label)}</h4></div>` +
    `<div class="drawer-body">` +
    `<div class="kv">` +
    `<span class="k">${t("phase")}</span><span class="v">${esc(a.phase ?? "—")}</span>` +
    `<span class="k">${t("adapter")}</span><span class="v">${esc(a.adapter ?? "—")}</span>` +
    `<span class="k">${t("started")}</span><span class="v">${fmtClock(a.startedAt)}</span>` +
    `<span class="k">${t("finished")}</span><span class="v">${fmtClock(a.finishedAt)}</span>` +
    `<span class="k">${t("duration")}</span><span class="v">${dur}</span>` +
    `<span class="k">${t("attempts")}</span><span class="v">${a.attempts ?? "—"}</span>` +
    `</div>` +
    status +
    output +
    (evs ? `<div class="drawer-sec">${t("Events")}</div><div class="mini-events">${evs}</div>` : "") +
    `</div></aside>`
  );
}

function ticker(run: RunDetail): string {
  const lastLog = [...store.runEvents].reverse().find((e) => e.type === "log");
  const msg = lastLog
    ? `<b>▸</b> ${esc(String(lastLog.message ?? ""))}`
    : `<b>▸</b> ${esc(run.description ?? run.name)}`;
  const right =
    run.lastActivityTs != null
      ? t("last activity {t}", { t: fmtClock(run.lastActivityTs) })
      : run.stale
        ? run.provider === "claude"
          ? t("⚠ no recent signal")
          : t("⚠ worker lost contact")
        : "";
  return `<div class="ticker"><span class="msg">${msg}</span><span class="r">${right}</span></div>`;
}

function graphTab(run: RunDetail, s: JobViewState, nowSec: number): string {
  if (run.agents.length === 0) {
    const terminal = TERMINAL.has(run.state);
    const planned = (run.phaseOrder.length ? run.phaseOrder : run.phases.map((p) => p.title))
      .map((p, i) => `<span class="op"><i></i>${String(i + 1).padStart(2, "0")} ${esc(p)}</span>`)
      .join("");
    return (
      `<div class="graph-wrap">` +
      emptyArt(
        terminal ? t("No agent calls in this run") : t("Waiting for the first agent…"),
        terminal ? t("This run only recorded phases and a result.") : t("Declared phases:"),
        `<div class="ol-ops" style="justify-content:center">${planned}</div>`,
      ) +
      ticker(run) +
      `</div>`
    );
  }
  const dag = renderDag(run, s.selectedAi, {
    nowSec,
    zoom: s.zoom,
    motion: s.motion,
    currentPhase: TERMINAL.has(run.state) ? null : currentPhase(),
  });
  const legend =
    `<div class="legend">` +
    ["running", "done", "failed", "stale"].map((st) => `<span>${glyph(st)}${esc(t(st))}</span>`).join("") +
    `</div>`;
  const tools =
    `<div class="canvas-tools">` +
    `<button class="iconbtn" data-zoom="in" aria-label="${esc(t("Zoom in"))}">${icons.zoomIn}</button>` +
    `<span class="zoom">${Math.round(s.zoom * 100)}%</span>` +
    `<button class="iconbtn" data-zoom="out" aria-label="${esc(t("Zoom out"))}">${icons.zoomOut}</button>` +
    `<button class="iconbtn" data-zoom="fit" aria-label="${esc(t("Fit to screen"))}">${icons.fit}</button>` +
    `</div>`;
  const panel = s.selectedAi != null ? drawer(run, s.selectedAi, nowSec) : "";
  return (
    `<div class="graph-wrap"><div class="canvas" data-canvas data-key="canvas">${dag.html}</div>` +
    legend +
    tools +
    panel +
    ticker(run) +
    `</div>`
  );
}

function logRow(e: WorkflowEvent, i: number): string {
  const cls = EVT_CLASS[e.type] ?? "log";
  const label =
    e.type === "phase_started" ? "PHASE" : e.type === "log" ? "LOG" : e.type.replace(/^(agent|run)_/, "").toUpperCase();
  let msg = "";
  if (e.type === "phase_started") msg = `<b>${esc(String(e.phase ?? ""))}</b>`;
  else if (e.type === "log") msg = esc(String(e.message ?? ""));
  else if (e.type === "agent_failed")
    msg = `<b>${esc(String(e.label ?? ""))}</b> <span class="er">${esc(String(e.error ?? ""))}</span>`;
  else if (e.type.startsWith("agent_"))
    msg = `<b>${esc(String(e.label ?? ""))}</b>${e.adapter ? ` · ${esc(String(e.adapter))}` : ""}${e.attempts && Number(e.attempts) > 1 ? ` · ×${esc(String(e.attempts))}` : ""}`;
  else msg = esc(e.type.replace(/_/g, " "));
  return (
    `<div class="logrow" data-key="lg-${i}"><span class="ts">${fmtClock(e.ts)}</span>` +
    `<span><span class="evt ${cls}">${label}</span></span><span class="msg">${msg}</span></div>`
  );
}

function logsTab(s: JobViewState): string {
  const q = s.logQuery.trim().toLowerCase();
  const allowed = new Set(LOG_GROUPS.filter((g) => s.logTypes.has(g.key)).flatMap((g) => g.types));
  const rows: string[] = [];
  store.runEvents.forEach((e, i) => {
    const known = LOG_GROUPS.some((g) => g.types.includes(e.type));
    if (known && !allowed.has(e.type)) return;
    if (q && !JSON.stringify(e).toLowerCase().includes(q)) return;
    rows.push(logRow(e, i));
  });
  const chips = LOG_GROUPS.map(
    (g) =>
      `<button class="chip tog${s.logTypes.has(g.key) ? " on" : ""}" data-logtype="${g.key}">${esc(t(g.label))}</button>`,
  ).join("");
  return (
    `<div class="logbar"><div class="chips">${chips}</div>` +
    `<button class="chip${s.follow ? " on" : ""}" data-follow>${icons.follow}${t("Follow")}</button>` +
    `<label class="field">${icons.search}<input id="log-q" placeholder="${esc(t("Filter events"))}" value="${esc(s.logQuery)}" autocomplete="off"/></label></div>` +
    `<div class="loglist" data-loglist>${rows.join("") || `<div class="empty" style="min-height:160px"><p>${store.runEvents.length ? t("No events match.") : t("No events yet.")}</p></div>`}</div>`
  );
}

function resultTab(run: RunDetail): string {
  if (run.error) {
    return (
      `<div class="result"><div class="card result-card errcard">` +
      `<div class="result-head">${glyph("failed")}<h4>error.json</h4>` +
      `<button class="btn sm ghost" data-copy="${esc(`${run.error.error ?? ""}\n${run.error.stack ?? ""}`)}">${icons.copy}${t("Copy")}</button></div>` +
      `<pre>${esc(run.error.error ?? "")}${run.error.stack ? `\n\n${esc(run.error.stack)}` : ""}</pre></div></div>`
    );
  }
  if (!run.hasResult) {
    return (
      `<div class="result">` +
      emptyArt(
        TERMINAL.has(run.state) ? t("No result recorded") : t("No result yet"),
        t("A result is written when the run finishes successfully."),
      ) +
      `</div>`
    );
  }
  if (!store.resultLoaded) {
    return `<div class="result"><div class="empty"><div class="spinner"></div><p>${t("Loading result…")}</p></div></div>`;
  }
  const raw = typeof store.result === "string" ? store.result : JSON.stringify(store.result, null, 2);
  return (
    `<div class="result"><div class="card result-card">` +
    `<div class="result-head">${glyph("done")}<h4>result.json</h4>` +
    `<button class="btn sm" data-copy="${esc(raw ?? "")}">${icons.copy}${t("Copy")}</button></div>` +
    renderJson(store.result) +
    `</div></div>`
  );
}

export function renderJob(s: JobViewState, nowSec: number): string {
  const run = store.run;
  if (!run) {
    return `<div class="job"><div class="empty"><div class="spinner"></div><p>${t("Loading run…")}</p></div></div>`;
  }
  const body =
    s.tab === "graph"
      ? graphTab(run, s, nowSec)
      : s.tab === "timeline"
        ? renderTimeline(run, s.selectedAi, nowSec) + (s.selectedAi != null ? drawer(run, s.selectedAi, nowSec) : "")
        : s.tab === "logs"
          ? logsTab(s)
          : resultTab(run);
  return (
    `<div class="job" data-key="job-${esc(run.runId)}">${runHead(run, nowSec)}${tabs(run, s.tab)}` +
    `<section class="tab-body" data-tabbody="${s.tab}" data-key="tb-${s.tab}">${body}</section></div>`
  );
}
