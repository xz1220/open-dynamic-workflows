/** Job detail — header + phase stepper, then Graph (live DAG) · Timeline · Logs · Result · Changes. */
import { withCheckpoints } from "../checkpoints";
import { deltaHtml, diffBar, filePath, pathHtml, statusMark } from "../components/diff";
import { glyph, pill } from "../components/glyph";
import { renderJson } from "../components/json";
import { renderTimeline } from "../components/timeline";
import { reasonLabel, renderDag } from "../dag";
import { icons } from "../icons";
import { getLang, t, tn } from "../i18n";
import { store } from "../store";
import type { AgentView, RunDetail, WorkflowEvent } from "../types";
import { ACTIVE, TERMINAL, esc, fmtClock, fmtDurMs, fmtDurSec, fmtTokens, fmtUsd, markRedactions } from "../util";
import { EVT_CLASS, commandDetail, emptyArt } from "./activity";

export type JobTab = "graph" | "timeline" | "logs" | "result" | "changes";

export interface JobViewState {
  /** Draft note for a checkpoint decision. */
  cpNote: string;
  tab: JobTab;
  selectedAi: number | null;
  /** The agent whose diff the Changes tab shows (index into run.agents). */
  reviewAi: number | null;
  /** The agent whose transcript sheet is open (index into run.agents). */
  transcriptAi?: number | null;
  zoom: number;
  logQuery: string;
  logTypes: Set<string>;
  /** How many of the newest matching events the Logs tab paints. */
  logLimit: number;
  follow: boolean;
  motion: boolean;
}

export const LOG_PAGE = 600;

const LOG_GROUPS: Array<{ key: string; label: string; types: string[] }> = [
  { key: "agent", label: "agents", types: ["agent_started", "agent_finished", "agent_failed"] },
  { key: "command", label: "commands", types: ["command_started", "command_finished", "command_failed"] },
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
  // An ended ODW run can be picked up again from the terminal: `odw resume`
  // replays every agent call that already finished (the dashboard starts nothing).
  const resumable = run.provider === "odw" && (run.state === "failed" || run.state === "stopped" || run.state === "stale");
  const resume = resumable
    ? `<button class="btn" data-copy="odw resume ${esc(run.runId)}" data-tip="${esc(t("copies a command that replays finished agents"))}">${icons.terminal}${t("Resume in terminal")}</button>`
    : "";
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
    `<div class="actions">${stop}${resume}` +
    `<button class="btn" data-copy="odw logs ${esc(run.runId)} --follow" data-tip="${esc(t("copy a follow command"))}">${icons.terminal}${t("Follow in terminal")}</button>` +
    `<button class="btn ghost" data-copy="${esc(run.runId)}">${icons.copy}${t("Copy id")}</button></div>` +
    `</header>` +
    `<div class="run-strip">${stepper(run)}<div class="runstats">` +
    stat(c.agents, t("agents")) +
    stat(c.running, t("running"), c.running ? "sig" : "") +
    stat(c.done, t("done")) +
    (c.failed ? stat(c.failed, t("failed"), "alarm") : "") +
    (run.usage && (run.usage.inputTokens != null || run.usage.outputTokens != null)
      ? stat(
          `${fmtTokens((run.usage.inputTokens ?? 0) + (run.usage.outputTokens ?? 0))}${run.usage.estimated ? "~" : ""}`,
          t("tokens"),
        )
      : "") +
    (run.usage?.costUsd != null ? stat(fmtUsd(run.usage.costUsd), t("cost")) : "") +
    changedStat(run, stat) +
    stat(elapsed, t("elapsed")) +
    `</div></div>` +
    `<div class="run-prog"><div class="prog">` +
    `<i class="p-done" style="width:${w(c.done)}"></i><i class="p-run" style="width:${w(c.running)}"></i>` +
    `<i class="p-fail" style="width:${w(c.failed)}"></i><i class="p-stale" style="width:${w(c.stale)}"></i></div></div>`
  );
}

function tabs(run: RunDetail, tab: JobTab): string {
  const changed = changedAgents(run);
  const item = (key: JobTab, icon: string, label: string, n?: number) =>
    `<a class="tab${tab === key ? " on" : ""}" href="#/job/${encodeURIComponent(run.runId)}/${key}" data-tab="${key}" data-key="tab-${key}" role="tab" aria-selected="${tab === key}">${icon}${esc(label)}${n != null ? `<span class="n">${n}</span>` : ""}</a>`;
  return (
    `<nav class="tabs" role="tablist">` +
    item("graph", icons.graph, t("Graph"), run.agents.length) +
    item("timeline", icons.timeline, t("Timeline")) +
    item("logs", icons.logs, t("Logs"), store.runEvents.length) +
    item("result", icons.result, t("Result")) +
    (changed.length || tab === "changes" ? item("changes", icons.diff, t("Changes"), changed.length) : "") +
    `<i class="ink-bar"></i></nav>`
  );
}

function agentEvents(a: AgentView): WorkflowEvent[] {
  if (a.kind === "checkpoint") return store.runEvents.filter((e) => e.type.startsWith("checkpoint_") && e.checkpointId === a.checkpointId);
  if (a.kind === "command") {
    return store.runEvents.filter(
      (e) => e.type.startsWith("command_") && (a.commandId != null ? e.commandId === a.commandId : e.label === a.label),
    );
  }
  return store.runEvents.filter(
    (e) =>
      e.type.startsWith("agent_") &&
      (a.agentId != null && typeof e.agentId === "number" ? e.agentId === a.agentId : e.label === a.label),
  );
}

/** What each permission tier lets an agent do (ODW extension). */
const PERM_HINT: Record<string, string> = {
  read: "reads and searches; no edits, no commands",
  edit: "edits files in its workspace",
  full: "no approval checks at all",
};

/** When a rate limit or spent quota lifts, as the CLI said (`retryAfter` on its agent_failed event). */
function resetNote(a: AgentView, nowSec: number): string {
  const failed = agentEvents(a).filter((e) => e.type === "agent_failed").pop();
  if (!failed || typeof failed.retryAfter !== "number") return "";
  const at = failed.ts + failed.retryAfter;
  const text = at <= nowSec ? t("lifted at {t}", { t: fmtClock(at) }) : t("lifts in {d} · {t}", { d: fmtDurSec(at - nowSec), t: fmtClock(at) });
  return ` <span class="dim">${esc(text)}</span>`;
}

/** The drawer of a checkpoint() gate: what was asked, what the person saw, and the answer. */
function checkpointDrawer(run: RunDetail, a: AgentView, ai: number, nowSec: number): string {
  const waited = a.startedAt != null ? fmtDurSec((a.finishedAt ?? nowSec) - a.startedAt) : "—";
  const d = a.decision;
  const answer = d
    ? `<div class="drawer-sec">${t("Answer")}</div><div class="outbox${d.approved ? "" : " err"}">${esc(d.approved ? t("approved") : t("rejected"))}` +
      `${d.by ? ` · ${esc(t(d.by))}` : ""}${d.note ? `\n“${esc(d.note)}”` : ""}</div>`
    : a.state === "waiting"
      ? `<div class="drawer-sec">${t("Answer")}</div><div class="outbox">${t("Waiting — answer it in the card above the tabs, or with {cmd}", { cmd: `odw approve ${esc(run.runId)} --checkpoint ${a.checkpointId}` })}</div>`
      : a.error
        ? `<div class="drawer-sec">${t("Error")}</div><div class="outbox err">${esc(a.error)}</div>`
        : "";
  const payload =
    a.payload !== undefined && a.payload !== null
      ? `<div class="drawer-sec">${t("Payload")}</div><div class="outbox json-out">${renderJson(a.payload)}</div>`
      : "";
  return (
    `<aside class="drawer" data-key="drawer-${ai}">` +
    `<div class="drawer-head"><div class="row">${pill(a.state, d ? (d.approved ? t("approved") : t("rejected")) : a.state === "stopped" ? t("not answered") : undefined)}<span class="tag">${t("checkpoint")} #${a.checkpointId}</span>` +
    `<button class="iconbtn" data-close="1" aria-label="${esc(t("Close"))}">${icons.close}</button></div>` +
    `<h4>${esc(a.label)}</h4></div>` +
    `<div class="drawer-body"><div class="kv">` +
    `<span class="k">${t("phase")}</span><span class="v">${esc(a.phase ?? "—")}</span>` +
    `<span class="k">${t("asked")}</span><span class="v">${fmtClock(a.startedAt)}</span>` +
    `<span class="k">${t("waited")}</span><span class="v">${waited}</span>` +
    `</div>${answer}${payload}</div></aside>`
  );
}

function drawer(run: RunDetail, ai: number, nowSec: number): string {
  const a = run.agents[ai];
  if (!a) return "";
  if (a.kind === "checkpoint") return checkpointDrawer(run, a, ai, nowSec);
  const dur =
    a.state === "running" && a.startedAt != null ? fmtDurSec(nowSec - a.startedAt) : fmtDurMs(a.durationMs);
  const status =
    a.state === "failed"
      ? `<div class="drawer-sec">${t("Error")}</div><div class="outbox err">${markRedactions(esc(a.error ?? t("(no message)")))}</div>`
      : a.state === "stale"
        ? `<div class="drawer-sec">${t("Status")}</div><div class="outbox">${run.provider === "claude" ? t("no recent signal") : t("worker lost contact")}</div>`
        : "";
  const rec = a.agentId != null ? store.agentResults.get(`${run.runId}:${a.agentId}`) : undefined;
  const output =
    rec && rec.value !== undefined
      ? `<div class="drawer-sec">${t("Output")}${rec.cached ? ` <span class="tag">${t("replayed")}</span>` : ""}${rec.redacted ? ` <span class="tag warn" title="${esc(t("secrets in it were replaced before it was saved"))}">${t("redacted")}</span>` : ""}` +
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
        `<div><span class="ts">${fmtClock(e.ts)}</span>${glyph(/_started$/.test(e.type) ? "running" : /_failed$/.test(e.type) ? "failed" : "done")}` +
        `<span>${esc(e.type.replace(/^(agent|command)_/, ""))}${e.attempts ? ` · ${t("attempt {n}", { n: Number(e.attempts) })}` : ""}${typeof e.exitCode === "number" ? ` · exit ${e.exitCode}` : ""}</span></div>`,
    )
    .join("");
  return (
    `<aside class="drawer" data-key="drawer-${ai}">` +
    `<div class="drawer-head"><div class="row">${pill(a.state)}<span class="tag">${esc(a.kind === "command" ? t("command") : (a.adapter ?? "—"))}</span>` +
    `<button class="iconbtn" data-close="1" aria-label="${esc(t("Close"))}">${icons.close}</button></div>` +
    `<h4>${esc(a.label)}</h4></div>` +
    `<div class="drawer-body">` +
    `<div class="kv">` +
    `<span class="k">${t("phase")}</span><span class="v">${esc(a.phase ?? "—")}</span>` +
    (a.kind === "command"
      ? ""
      : `<span class="k">${t("adapter")}</span><span class="v">${esc(a.adapter ?? "—")}` +
        (a.fellBackFrom?.length
          ? ` <span class="tag warn" title="${esc(t("its earlier adapters ran out of quota or refused the login"))}">${esc(t("after {chain}", { chain: a.fellBackFrom.join(" → ") }))}</span>`
          : "") +
        `</span>`) +
    `<span class="k">${t("started")}</span><span class="v">${fmtClock(a.startedAt)}</span>` +
    `<span class="k">${t("finished")}</span><span class="v">${fmtClock(a.finishedAt)}</span>` +
    `<span class="k">${t("duration")}</span><span class="v">${dur}</span>` +
    (a.kind === "command" && a.forAgentId != null
      ? `<span class="k">${t("checks")}</span><span class="v">${t("agent #{n}'s work", { n: a.forAgentId })}</span>`
      : "") +
    (a.kind === "command"
      ? `<span class="k">${t("exit code")}</span><span class="v">${a.exitCode ?? "—"}</span>`
      : `<span class="k">${t("attempts")}</span><span class="v">${a.attempts ?? "—"}</span>`) +
    (a.permissions
      ? `<span class="k">${t("permissions")}</span><span class="v"><span class="tag perm-${esc(a.permissions)}" title="${esc(t(PERM_HINT[a.permissions] ?? ""))}">${esc(t(a.permissions))}</span></span>`
      : "") +
    (a.failureReason ? `<span class="k">${t("reason")}</span><span class="v"><span class="tag ${/rate_limit|quota|stalled|timeout/.test(a.failureReason) ? "warn" : ""}">${esc(reasonLabel(a.failureReason))}</span>${resetNote(a, nowSec)}</span>` : "") +
    (a.usage && (a.usage.inputTokens != null || a.usage.outputTokens != null)
      ? `<span class="k">${t("tokens")}</span><span class="v">${fmtTokens(a.usage.inputTokens)} ${t("in")} · ${fmtTokens(a.usage.outputTokens)} ${t("out")}</span>`
      : "") +
    (a.usage?.costUsd != null ? `<span class="k">${t("cost")}</span><span class="v">${fmtUsd(a.usage.costUsd)}</span>` : "") +
    `</div>` +
    (a.kind !== "command" && a.agentId != null && !a.cached && run.provider === "odw"
      ? `<button class="btn sm tx-open" data-transcript="${ai}">${icons.logs}${t("Transcript")}</button>`
      : "") +
    status +
    (a.misses?.length
      ? `<div class="drawer-sec">${t("Missed")}</div><ul class="misses">${a.misses.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>`
      : "") +
    (a.denied?.length
      ? `<div class="drawer-sec">${t("Refused tool calls")}</div><ul class="denied">${a.denied.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>` +
        `<p class="dnote">${t("Its reply may rest on work it could not do — raise its tier with --permissions, or allowlist the tool.")}</p>`
      : "") +
    changesSection(run, a, ai, rec?.branch) +
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
  const panel =
    (s.selectedAi != null ? drawer(run, s.selectedAi, nowSec) : "") +
    (s.transcriptAi != null ? transcriptSheet(run, s.transcriptAi) : "");
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
    e.type === "phase_started"
      ? "PHASE"
      : e.type === "log"
        ? "LOG"
        : e.type.startsWith("command_")
          ? `$ ${e.type.replace("command_", "").toUpperCase()}`
          : e.type.replace(/^(agent|run)_/, "").toUpperCase();
  let msg = "";
  if (e.type === "phase_started") msg = `<b>${esc(String(e.phase ?? ""))}</b>`;
  else if (e.type === "log") msg = esc(String(e.message ?? ""));
  else if (e.type === "agent_failed")
    msg = `<b>${esc(String(e.label ?? ""))}</b> <span class="er">${esc(String(e.error ?? ""))}</span>`;
  else if (e.type.startsWith("command_"))
    msg = `<b>${esc(commandDetail(e))}</b>${e.type === "command_failed" && e.error ? ` <span class="er">${esc(String(e.error))}</span>` : ""}`;
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
  const matching: number[] = [];
  store.runEvents.forEach((e, i) => {
    const known = LOG_GROUPS.some((g) => g.types.includes(e.type));
    if (known && !allowed.has(e.type)) return;
    if (q && !JSON.stringify(e).toLowerCase().includes(q)) return;
    matching.push(i);
  });
  // A long run's log is painted from the newest end; older events page in on demand.
  const hidden = Math.max(0, matching.length - s.logLimit);
  const rows = matching.slice(hidden).map((i) => logRow(store.runEvents[i]!, i));
  if (hidden) {
    rows.unshift(
      `<div class="more-row" data-key="lg-more"><button class="btn sm" data-logs-more>${t("Show {n} earlier events", { n: Math.min(hidden, LOG_PAGE) })}</button><span class="dim">${t("{n} older events hidden", { n: hidden })}</span></div>`,
    );
  }
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

/** checkpoint() calls waiting for a person: what is asked, the payload, and the decision. */
function checkpoints(run: RunDetail, s: JobViewState): string {
  const pending = run.pendingCheckpoints ?? [];
  if (!pending.length) return "";
  const canDecide = run.provider === "odw" && store.capabilities.writable;
  return pending
    .map((cp, i) => {
      const payload = cp.payload !== undefined && cp.payload !== null ? `<div class="cp-payload">${renderJson(cp.payload)}</div>` : "";
      const actions = canDecide
        ? `<div class="cp-actions">` +
          (i === 0
            ? `<input id="cp-note" class="cp-note" placeholder="${esc(t("Add a note for the workflow (optional)"))}" value="${esc(s.cpNote)}" autocomplete="off"/>`
            : "") +
          `<button class="btn primary" data-cp="approve" data-cp-id="${cp.checkpointId}">${t("Approve")}</button>` +
          `<button class="btn danger" data-cp="reject" data-cp-id="${cp.checkpointId}">${t("Reject")}</button></div>`
        : `<p class="dim" style="margin:10px 0 0">${t("Resolve it with {cmd}", { cmd: `<code>odw approve ${esc(run.runId)}</code>` })}</p>`;
      return (
        `<section class="card checkpoint marked" data-key="cp-${cp.checkpointId}">` +
        `<div class="cp-head">${glyph("waiting")}<span class="eyebrow">${t("Checkpoint")} · ${t("waiting since {t}", { t: fmtClock(cp.since) })}</span></div>` +
        `<h3 class="cp-title">${esc(cp.title)}</h3>${payload}${actions}</section>`
      );
    })
    .join("");
}

// --- transcript: what one agent's CLI did, turn by turn ---

/** The transcript sheet over the graph: header, then a frozen host main.ts fills and appends to. */
function transcriptSheet(run: RunDetail, ai: number): string {
  const a = run.agents[ai];
  if (!a || a.agentId == null) return "";
  const key = `${run.runId}:${a.agentId}`;
  const tx = store.transcripts.get(key);
  const live = a.state === "running";
  const status = !tx
    ? t("Loading transcript…")
    : tx.missing
      ? t("No transcript kept for this agent.")
      : tx.replayed
        ? t("Replayed from an earlier run — no CLI ran, so there is no transcript.")
        : `${tn(tx.entries.length + tx.dropped, "{n} entry", "{n} entries")}${live ? ` · ${t("following")}` : ""}`;
  const version = `${key}|${getLang()}|${tx ? (tx.missing ? "missing" : tx.replayed ? "replayed" : "ok") : "loading"}|${tx?.dropped ?? 0}`;
  return (
    `<aside class="sheet" data-key="tx-sheet" role="dialog" aria-label="${esc(t("Transcript"))}">` +
    `<div class="sheet-head">${glyph(a.state)}<div class="sheet-title"><span class="eyebrow">${t("Transcript")} · ${t("agent")} #${a.agentId}${a.adapter ? ` · ${esc(a.adapter)}` : ""}</span>` +
    `<h4>${esc(a.label)}</h4></div>` +
    `<button class="btn sm ghost" data-copy="odw logs ${esc(run.runId)} --agent ${a.agentId}${live ? " --follow" : ""}" data-tip="${esc(t("copy the same view for a terminal"))}">${icons.terminal}${t("In terminal")}</button>` +
    `<button class="iconbtn" data-close-sheet="1" aria-label="${esc(t("Close"))}">${icons.close}</button></div>` +
    `<div class="sheet-status${live ? " live" : ""}">${esc(status)}${tx?.dropped ? ` · ${esc(t("{n} earlier entries not shown", { n: tx.dropped }))}` : ""}${tx?.truncated ? ` · ${esc(t("cut at maxTranscriptBytes"))}` : ""}</div>` +
    `<div class="sheet-body" data-sheet-body><div class="tx-host" data-key="txh-${esc(key)}" data-morph="skip" data-v="${esc(version)}" data-tx="${esc(key)}"></div>` +
    (live ? `<div class="tx-wait" data-key="txw" aria-label="${esc(t("working"))}"><i></i><i></i><i></i></div>` : "") +
    `</div>` +
    `</aside>`
  );
}

// --- changes: what worktree agents changed, to review and apply ---

/** Agents that left a diff, in call order. */
export function changedAgents(run: RunDetail): Array<{ a: AgentView; ai: number }> {
  const out: Array<{ a: AgentView; ai: number }> = [];
  run.agents.forEach((a, ai) => {
    if (a.agentId != null && a.changes && a.changes.files > 0) out.push({ a, ai });
  });
  return out;
}

/** The agent the Changes tab shows: the chosen one, else the first with changes. */
export function reviewTarget(run: RunDetail, reviewAi: number | null): { a: AgentView; ai: number } | null {
  const changed = changedAgents(run);
  return changed.find((c) => c.ai === reviewAi) ?? changed[0] ?? null;
}

function changedStat(run: RunDetail, stat: (v: string, k: string) => string): string {
  let ins = 0;
  let del = 0;
  for (const { a } of changedAgents(run)) {
    ins += a.changes!.insertions;
    del += a.changes!.deletions;
  }
  if (!ins && !del) return "";
  return stat(`<b class="ins">+${fmtTokens(ins)}</b><b class="del">−${fmtTokens(del)}</b>`, t("lines changed"));
}

const applyCmd = (run: RunDetail, a: AgentView) => `odw apply ${run.runId} --agent ${a.agentId}`;

/** The drawer's summary of an agent's changes, with the way to review and apply them. */
function changesSection(run: RunDetail, a: AgentView, ai: number, recordBranch: string | null | undefined): string {
  const c = a.changes;
  if (!c || !c.files || a.agentId == null) return "";
  const parsed = store.agentDiffs.get(`${run.runId}:${a.agentId}`);
  const SHOWN = 8;
  const files = parsed
    ? parsed.files
        .slice(0, SHOWN)
        .map((f) => `<div class="chg-file">${statusMark(f)}${pathHtml(filePath(f))}${f.binary ? "" : deltaHtml(f.insertions, f.deletions)}</div>`)
        .join("") +
      (parsed.files.length > SHOWN ? `<div class="chg-more">${t("+{n} more files", { n: parsed.files.length - SHOWN })}</div>` : "")
    : parsed === undefined
      ? `<div class="chg-file"><span class="skel" style="height:12px;width:64%"></span></div>`
      : "";
  const branch = a.branch ?? recordBranch;
  return (
    `<div class="drawer-sec">${t("Changes")}<button class="iconbtn sm" data-copy="${esc(applyCmd(run, a))}" aria-label="${esc(t("Copy apply command"))}" data-tip="${esc(t("copies odw apply for this agent"))}">${icons.copy}</button></div>` +
    `<div class="chg">` +
    `<div class="chg-sum">${deltaHtml(c.insertions, c.deletions)}<span class="chg-files">${tn(c.files, "{n} file", "{n} files")}</span>${diffBar(c.insertions, c.deletions)}</div>` +
    files +
    (c.truncated ? `<p class="dnote">${t("The stored diff was cut at the size cap.")}</p>` : "") +
    (branch ? `<div class="chg-branch">${icons.branch}<code>${esc(branch)}</code></div>` : "") +
    `<button class="btn sm chg-go" data-review="${ai}">${icons.diff}${t("Review changes")}</button>` +
    `</div>`
  );
}

function changesTab(run: RunDetail, s: JobViewState): string {
  const changed = changedAgents(run);
  const target = reviewTarget(run, s.reviewAi);
  if (!target) {
    return (
      `<div class="review-empty">` +
      emptyArt(
        t("No changes recorded"),
        t("Agents that run with isolation: \"worktree\" keep a diff of what they changed, to review here and apply with odw apply. Agents that work in place edit your files directly — review those with git diff."),
      ) +
      `</div>`
    );
  }
  let ins = 0;
  let del = 0;
  for (const { a } of changed) {
    ins += a.changes!.insertions;
    del += a.changes!.deletions;
  }
  const list = changed
    .map(
      ({ a, ai }) =>
        `<button class="rv-item${ai === target.ai ? " on" : ""}" data-review="${ai}" data-key="rv-${ai}" aria-pressed="${ai === target.ai}">` +
        `<span class="rv-top">${glyph(a.state)}<span class="lbl">${esc(a.label)}</span>${diffBar(a.changes!.insertions, a.changes!.deletions)}</span>` +
        `<span class="rv-sub"><span>${esc([a.phase, a.adapter].filter(Boolean).join(" · "))}</span>${deltaHtml(a.changes!.insertions, a.changes!.deletions)}</span>` +
        `</button>`,
    )
    .join("");
  const a = target.a;
  const c = a.changes!;
  const key = `${run.runId}:${a.agentId}`;
  const parsed = store.agentDiffs.get(key);
  const rec = store.agentResults.get(key);
  const branch = a.branch ?? rec?.branch;
  // The diff is painted into this host once per version (main.ts), not on every tick.
  const version = `${key}|${parsed === undefined ? "loading" : parsed === null ? "none" : "ready"}|${getLang()}`;
  const head =
    `<header class="rv-head">` +
    `<div class="rv-title"><span class="eyebrow">${t("Agent")} #${a.agentId}${a.phase ? ` · ${esc(a.phase)}` : ""}${a.adapter ? ` · ${esc(a.adapter)}` : ""}</span>` +
    `<h3>${esc(a.label)}</h3>` +
    `<div class="rv-stat">${deltaHtml(c.insertions, c.deletions)}<span>${tn(c.files, "{n} file", "{n} files")}</span>${diffBar(c.insertions, c.deletions)}` +
    (c.truncated ? `<span class="tag warn">${t("truncated")}</span>` : "") +
    `</div></div>` +
    `<div class="rv-actions">` +
    `<button class="btn primary" data-copy="${esc(applyCmd(run, a))}" data-tip="${esc(t("applies this diff to your working tree"))}">${icons.terminal}${t("Copy apply command")}</button>` +
    (branch
      ? `<button class="btn ghost" data-copy="git switch ${esc(branch)}" data-tip="${esc(t("copy a checkout command"))}">${icons.branch}<span class="mono">${esc(branch)}</span></button>`
      : "") +
    `</div></header>`;
  return (
    `<div class="review">` +
    `<aside class="rv-list" aria-label="${esc(t("Agents with changes"))}">` +
    `<div class="rv-total"><span class="v num">${changed.length}</span><span class="k">${tn(changed.length, "agent changed files", "agents changed files")}</span>${deltaHtml(ins, del)}</div>` +
    list +
    `</aside>` +
    `<section class="rv-main" data-key="rvm-${esc(key)}">${head}` +
    `<div class="diff-host" data-key="dh-${esc(key)}" data-morph="skip" data-v="${esc(version)}" data-diff="${esc(key)}" data-full="${esc(`odw diff ${run.runId} --agent ${a.agentId}`)}"></div>` +
    `</section></div>`
  );
}

export function renderJob(s: JobViewState, nowSec: number): string {
  // checkpoint() gates join the graph, the timeline and the drawer as nodes.
  const run = store.run ? withCheckpoints(store.run, store.runEvents) : null;
  if (!run) {
    return `<div class="job"><div class="empty"><div class="spinner"></div><p>${t("Loading run…")}</p></div></div>`;
  }
  const body =
    s.tab === "graph"
      ? graphTab(run, s, nowSec)
      : s.tab === "timeline"
        ? renderTimeline(run, s.selectedAi, nowSec) +
          (s.selectedAi != null ? drawer(run, s.selectedAi, nowSec) : "") +
          (s.transcriptAi != null ? transcriptSheet(run, s.transcriptAi) : "")
        : s.tab === "logs"
          ? logsTab(s)
          : s.tab === "changes"
            ? changesTab(run, s)
            : resultTab(run);
  return (
    `<div class="job" data-key="job-${esc(run.runId)}">${runHead(run, nowSec)}${checkpoints(run, s)}${tabs(run, s.tab)}` +
    `<section class="tab-body" data-tabbody="${s.tab}" data-key="tb-${s.tab}">${body}</section></div>`
  );
}
