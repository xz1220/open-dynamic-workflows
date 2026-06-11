/** Job detail — the live DAG (hero), plus Logs and Result tabs. Read-only. */
import { renderDag } from "../dag";
import { t } from "../i18n";
import { store } from "../store";
import type { AgentView, RunDetail, WorkflowEvent } from "../types";
import { ACTIVE, TERMINAL, esc, fmtClock, fmtDurMs } from "../util";
import { highlight } from "./workspace";

export type JobTab = "graph" | "logs" | "result";

const EVT_CLASS: Record<string, string> = {
  run_started: "rstart",
  run_finished: "rfin",
  run_failed: "rfail",
  run_stopped: "rstop",
  phase_started: "phase",
  agent_started: "astart",
  agent_finished: "afin",
  agent_failed: "afail",
  log: "log",
};

function stageHead(run: RunDetail, tab: JobTab): string {
  const order = run.phaseOrder.length ? run.phaseOrder : run.phases.map((p) => p.title);
  // The "current" phase is the last one that has started (last in order seen in events).
  const startedPhases = new Set(
    store.runEvents.filter((e) => e.type === "phase_started").map((e) => String(e.phase)),
  );
  let curIdx = -1;
  order.forEach((p, i) => {
    if (startedPhases.has(p)) curIdx = i;
  });
  const stepper = order
    .map((p, i) => {
      const cls = i < curIdx ? "done" : i === curIdx ? "on" : "";
      const arrow = i < order.length - 1 ? `<span class="ar">▸</span>` : "";
      return `<span class="pp ${cls}">${esc(p)}</span>${arrow}`;
    })
    .join("");

  const terminal = TERMINAL.has(run.state);
  const progClass = run.state === "failed" ? "failed" : run.state === "stopped" ? "stopped" : "";
  const pct = Math.round(run.progress * 100);
  const beat = run.state === "running" ? `<span class="heartbeat"></span>` : "";

  const subtabs =
    `<div class="subtabs">` +
    `<b class="${tab === "graph" ? "on" : ""}" data-tab="graph">${t("Graph")}</b>` +
    `<b class="${tab === "logs" ? "on" : ""}" data-tab="logs">${t("Logs")}</b>` +
    `<b class="${tab === "result" ? "on" : ""}" data-tab="result">${t("Result")}</b>` +
    `</div>`;

  return (
    `<div class="stagehead">` +
    `<div class="row1"><span class="rtitle">${esc(run.name)}</span>` +
    `<span class="badge ${run.state}"><span class="d"></span>${esc(t(run.state))}</span>` +
    `<div class="phasestepper">${stepper}</div>` +
    `<div style="margin-left:auto;">${subtabs}</div></div>` +
    `<div class="progressbar"><i class="${progClass}" style="width:${Math.max(pct, run.state === "failed" || run.state === "stopped" ? 100 : 0)}%"></i></div>` +
    `<div class="row3">` +
    (run.provider === "claude"
      ? `<span class="chip" title="${t("Claude Code workflow — observed read-only")}">Claude Code</span>`
      : "") +
    `<span class="chip"><b>${run.counts.agents}</b> ${t("agents")}</span>` +
    `<span class="chip"><span class="em">●</span><b>${run.counts.running}</b> ${t("running")}</span>` +
    `<span class="chip"><b>${run.counts.done}</b> ${t("done")}</span>` +
    (run.counts.failed ? `<span class="chip"><span class="rd">✕</span><b>${run.counts.failed}</b> ${t("failed")}</span>` : "") +
    (run.counts.stale ? `<span class="chip"><span class="am">●</span><b>${run.counts.stale}</b> ${t("stale")}</span>` : "") +
    `<span class="chip"><b>${order.length}</b> ${t("phases")}</span>` +
    (run.pid != null ? `<span class="chip">pid <b>${run.pid}</b></span>` : "") +
    beat +
    `<div class="readonly-actions">` +
    // D6: a run launched from the App must be stoppable from the App. ODW only —
    // the Claude provider stays read-only (the server refuses control anyway).
    (run.provider === "odw" && ACTIVE.has(run.state) && store.capabilities.writable
      ? `<span class="btn danger sm" data-stop="${esc(run.runId)}">${t("⏹ Stop")}</span>`
      : "") +
    `<span class="btn ghost sm" data-copy="${esc(run.runId)}">${t("⧉ Copy run id")}</span>` +
    // A Claude run has no ODW run directory to reveal — it lives under ~/.claude.
    (terminal || run.provider === "claude" ? "" : `<span class="btn secondary sm" data-reveal="1">${t("⊞ Open run dir")}</span>`) +
    `</div></div></div>`
  );
}

function detailPanel(a: AgentView, provider: RunDetail["provider"]): string {
  const errBlock =
    a.state === "failed"
      ? `<div class="dp-sec">${t("Error")}</div><div class="dp-out">${esc(a.error ?? t("(no message)"))}</div>`
      : "";
  const out =
    a.state === "running"
      ? `<div class="dp-sec">${t("Status")}</div><div class="dp-out">${t("running…")}<br>${t("started {t}", { t: fmtClock(a.startedAt) })}</div>`
      : a.state === "done"
        ? `<div class="dp-sec">${t("Outcome")}</div><div class="dp-out">${t("done in {d}", { d: fmtDurMs(a.durationMs) })}${a.attempts ? `<br>${t("attempts: {n}", { n: a.attempts })}` : ""}</div>`
        : a.state === "stale"
          ? `<div class="dp-sec">${t("Status")}</div><div class="dp-out">${provider === "claude" ? t("no recent signal") : t("worker lost contact")}<br>${t("started {t}", { t: fmtClock(a.startedAt) })}</div>`
        : errBlock;
  return (
    `<div class="detailpanel">` +
    `<span class="close" data-close="1">esc ✕</span>` +
    `<h4>${esc(a.label)}</h4>` +
    `<div style="margin-top:8px;"><span class="badge ${a.state}"><span class="d"></span>${esc(t(a.state))}</span></div>` +
    `<div class="dp-meta">` +
    `<span class="k">${t("adapter")}</span><span class="v">${esc(a.adapter ?? "—")}</span>` +
    `<span class="k">${t("phase")}</span><span class="v">${esc(a.phase ?? "—")}</span>` +
    `<span class="k">${t("started")}</span><span class="v">${fmtClock(a.startedAt)}</span>` +
    `<span class="k">${t("duration")}</span><span class="v">${a.state === "running" ? t("live") : fmtDurMs(a.durationMs)}</span>` +
    `</div>` +
    out +
    `<div class="dp-sec">${t("Read-only")}</div><div style="font-size:11.5px;color:var(--muted);">${t("Agents are never re-run from here. An ODW run can be stopped from the header; Claude Code runs stay read-only.")}</div>` +
    `</div>`
  );
}

function ticker(run: RunDetail): string {
  const lastLog = [...store.runEvents].reverse().find((e) => e.type === "log");
  const left = lastLog ? `▸ ${esc(String(lastLog.message ?? ""))}` : `▸ ${esc(run.description ?? run.name)}`;
  const right =
    run.lastActivityTs != null
      ? t("last activity {t}", { t: fmtClock(run.lastActivityTs) })
      : run.stale
        ? run.provider === "claude"
          ? t("⚠ no recent signal")
          : t("⚠ worker lost contact")
        : "";
  return `<div class="ticker"><span>${left}</span><span class="r">${right}</span></div>`;
}

function graphTab(run: RunDetail, selectedAi: number | null): string {
  if (run.agents.length === 0) {
    const planned = (run.phaseOrder.length ? run.phaseOrder : run.phases.map((p) => p.title))
      .map((p, i) => `<span class="ppill"><span class="ix">${i + 1}</span>${esc(p)}</span>`)
      .join(`<span class="ar" style="color:var(--faint)"> → </span>`);
    return (
      `<div class="dagarea"><div class="empty">` +
      `<div class="gh">${t("Waiting for the first agent…")}</div>` +
      `<div>${t("Declared phases:")}</div><div class="phasepills">${planned || "—"}</div>` +
      `</div>${ticker(run)}</div>`
    );
  }
  const { html } = renderDag(run, selectedAi);
  const panel = selectedAi != null && run.agents[selectedAi] ? detailPanel(run.agents[selectedAi]!, run.provider) : "";
  return `<div class="dagarea">${html}${panel}${ticker(run)}</div>`;
}

function logRow(e: WorkflowEvent): string {
  const cls = EVT_CLASS[e.type] ?? "log";
  const label =
    e.type === "phase_started"
      ? "PHASE"
      : e.type === "log"
        ? "LOG"
        : e.type.replace(/^(agent|run)_/, "").toUpperCase();
  let msg = "";
  if (e.type === "phase_started") msg = `<b>${esc(String(e.phase ?? ""))}</b>`;
  else if (e.type === "log") msg = esc(String(e.message ?? ""));
  else if (e.type === "agent_failed") msg = `<b>${esc(String(e.label ?? ""))}</b> <span class="er">${esc(String(e.error ?? ""))}</span>`;
  else if (e.type.startsWith("agent_")) msg = `<b>${esc(String(e.label ?? ""))}</b>${e.adapter ? ` · ${esc(String(e.adapter))}` : ""}`;
  else msg = esc(e.type);
  return (
    `<div class="logrow"><span class="ts">${fmtClock(e.ts)}</span>` +
    `<span><span class="evt ${cls}">${label}</span></span>` +
    `<span class="msg">${msg}</span></div>`
  );
}

function logsTab(): string {
  const rows = store.runEvents.length
    ? store.runEvents.map(logRow).join("")
    : `<div style="color:var(--muted);padding:14px;">${t("No events yet.")}</div>`;
  return `<div class="logwrap">${rows}</div>`;
}

/** Mutable Save-to-Workspace form state (survives the poller's re-renders). */
export const saveForm = { name: "", scope: "global" as "global" | "project", busy: false, error: "", savedPath: "" };

/** The generation-run result payload, when this run is the built-in generator. */
function generationResult(run: RunDetail): { script: string; meta?: { name?: string; phases?: Array<{ title: string }> } } | null {
  if (run.workflowName !== "generate-workflow" || !store.resultLoaded) return null;
  const r = store.result as { script?: unknown; meta?: { name?: string; phases?: Array<{ title: string }> } } | undefined;
  return r && typeof r.script === "string" ? { script: r.script, meta: r.meta } : null;
}

/** D3: the generation run's Result tab is a preview + confirm gate, not raw JSON. */
function previewTab(run: RunDetail, gen: { script: string; meta?: { name?: string; phases?: Array<{ title: string }> } }): string {
  const phases = gen.meta?.phases ?? [];
  const pills = phases.length
    ? phases
        .map((p, i) => `<span class="ppill"><span class="ix">${i + 1}</span>${esc(p.title)}</span>`)
        .join(`<span class="ar"> → </span>`)
    : `<span style="color:var(--muted)">${t("no declared phases")}</span>`;
  const adapter = run.adapter ? store.adapters?.find((a) => a.name === run.adapter) : null;
  const perm = adapter
    ? `<div class="lf-perm"><span class="k">${t("agent permissions")}</span><span class="v">${esc(adapter.name)} — ${esc(adapter.permissionNote)}</span></div>`
    : "";
  return (
    `<div class="resultwrap"><div class="resultcard wide">` +
    `<h4>${esc(gen.meta?.name ?? "workflow")}.js · ${t("generated — review before running")}</h4>` +
    `<div class="phasepills" style="margin:10px 0 14px;">${pills}</div>` +
    `<div class="srcview">${highlight(gen.script)}</div>` +
    perm +
    (store.capabilities.writable
      ? `<div class="lf-actions" style="margin-top:16px;">` +
        `<span class="btn primary" data-run-generated="1">${t("▶ Run workflow")}</span>` +
        `<span class="btn secondary" data-regenerate="1">${t("↻ Regenerate")}</span>` +
        `</div>`
      : `<div class="lf-hint" style="margin-top:14px;">${t("This dashboard is read-only (served off-loopback). Run it from the local app or CLI.")}</div>`) +
    `</div></div>`
  );
}

/** D4: a launch-originated run's result offers one-click save to the Workspace. */
function saveBlock(run: RunDetail): string {
  if (run.origin !== "launch" || run.workflowName === "generate-workflow") return "";
  if (run.state !== "done" || !store.capabilities.writable) return "";
  if (saveForm.savedPath) {
    return `<div class="savebar saved">✓ ${t("saved to {path}", { path: esc(saveForm.savedPath) })} — <span data-nav="#/workspace" style="cursor:pointer;text-decoration:underline;">${t("open Workspace")}</span></div>`;
  }
  const name = saveForm.name || run.workflowName || "";
  const err = saveForm.error ? `<div class="lf-error">✕ ${esc(saveForm.error)}</div>` : "";
  return (
    `<div class="savebar">` +
    `<span class="lbl">${t("Keep this workflow?")}</span>` +
    `<input id="save-name" class="lf-input sm" value="${esc(name)}" placeholder="${t("workflow name")}">` +
    `<select id="save-scope" class="lf-select sm">` +
    `<option value="global"${saveForm.scope === "global" ? " selected" : ""}>${esc(t("global (~/.odw/workflows)"))}</option>` +
    `<option value="project"${saveForm.scope === "project" ? " selected" : ""}>${esc(t("project (<source>/.odw/workflows)"))}</option>` +
    `</select>` +
    `<span class="btn secondary sm${saveForm.busy ? " disabled" : ""}" data-save="1">${saveForm.busy ? t("Saving…") : t("☆ Save to Workspace")}</span>` +
    err +
    `</div>`
  );
}

function resultTab(run: RunDetail): string {
  const gen = generationResult(run);
  if (gen && run.state === "done") return previewTab(run, gen);
  if (run.error) {
    return (
      `<div class="resultwrap"><div class="resultcard">` +
      `<h4>error.json</h4><pre style="color:var(--red-deep)">${esc(run.error.error ?? "")}\n\n${esc(run.error.stack ?? "")}</pre>` +
      `</div></div>`
    );
  }
  if (!run.hasResult) {
    return `<div class="resultwrap"><div class="empty"><div class="gh">${t("No result yet")}</div><div>${t("A result is written when the run finishes successfully.")}</div></div></div>`;
  }
  if (!store.resultLoaded) {
    return `<div class="resultwrap"><div class="empty"><div class="spinner"></div><div>${t("Loading result…")}</div></div></div>`;
  }
  const pretty =
    typeof store.result === "string" ? store.result : JSON.stringify(store.result, null, 2);
  return `<div class="resultwrap"><div class="resultcard"><h4>result.json</h4><pre>${esc(pretty)}</pre></div>${saveBlock(run)}</div>`;
}

export function renderJob(tab: JobTab, selectedAi: number | null): string {
  const run = store.run;
  if (!run) {
    return `<div class="job"><div class="empty"><div class="spinner"></div><div>${t("Loading run…")}</div></div></div>`;
  }
  const head = stageHead(run, tab);
  const body = tab === "graph" ? graphTab(run, selectedAi) : tab === "logs" ? logsTab() : resultTab(run);
  return `<div class="job">${head}${body}</div>`;
}
