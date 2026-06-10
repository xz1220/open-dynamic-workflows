/** Jobs — the run monitor: an active strip + a date-grouped history table. */
import { t } from "../i18n";
import { activeRuns } from "../shell";
import { store } from "../store";
import type { RunSummary } from "../types";
import { TERMINAL, esc, fmtClock, fmtDayGroup, fmtDurSec, runDurationSec } from "../util";

function spark(seed: string, paused: boolean): string {
  // Deterministic little bar silhouette from the runId, so it's stable per run.
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const bars: string[] = [];
  for (let i = 0; i < 6; i++) {
    h = (h * 1103515245 + 12345) >>> 0;
    const ht = 6 + (h % 18);
    const on = h % 3 === 0;
    bars.push(`<i class="${on ? (paused ? "am" : "a") : ""}" style="height:${ht}px"></i>`);
  }
  return bars.join("");
}

/** A small "Claude Code" tag for runs ODW only observes (its own runs stay unbadged). */
function provBadge(r: RunSummary): string {
  return r.provider === "claude"
    ? ` <span class="srcbadge" title="${t("Claude Code workflow — observed read-only")}">Claude Code</span>`
    : "";
}

function runCard(r: RunSummary): string {
  const paused = r.state === "paused";
  return (
    `<div class="runcard ${paused ? "" : "run"}" data-run="${esc(r.runId)}">` +
    `<div class="top"><span><span class="nm">${esc(r.name)}</span>${provBadge(r)}<div class="wf">${esc(r.runId)}</div></span>` +
    `<span class="badge ${r.state}"><span class="d"></span>${esc(t(r.state))}</span></div>` +
    `<div class="spark">${spark(r.runId, paused)}</div>` +
    `<div class="strip"><i style="width:${Math.round(r.progress * 100)}%"></i></div>` +
    `<div class="meta">${t("{n} running", { n: r.counts.running })} · ${t("{n} done", { n: r.counts.done })}${r.counts.failed ? ` · ${t("{n} failed", { n: r.counts.failed })}` : ""}</div>` +
    `</div>`
  );
}

function historyRow(r: RunSummary): string {
  const dur = fmtDurSec(runDurationSec(r.createdAt, r.updatedAt, TERMINAL.has(r.state)));
  const adapter = r.counts.agents ? "" : ""; // adapter lives per-agent; column shown from detail
  void adapter;
  return (
    `<tr class="run" data-run="${esc(r.runId)}">` +
    `<td style="font-weight:600;">${esc(r.name)}${provBadge(r)}</td>` +
    `<td class="mono">${esc(r.runId)}</td>` +
    `<td><span class="badge ${r.state}"><span class="d"></span>${esc(t(r.state))}</span></td>` +
    `<td class="mono">${fmtClock(r.createdAt)}</td>` +
    `<td class="mono">${dur}</td>` +
    `<td class="mono">${r.counts.agents}</td>` +
    `</tr>`
  );
}

export function renderJobs(): string {
  const active = activeRuns();
  const ended = store.runs.filter((r) => TERMINAL.has(r.state) || r.state === "stale");

  const strip = active.length
    ? `<div class="activestrip"><div class="lbl">${t("Active now")}</div><div class="runcards">${active.map(runCard).join("")}</div></div>`
    : "";

  // Group history rows by day.
  let lastDay = "";
  const histRows: string[] = [];
  for (const r of ended) {
    const day = fmtDayGroup(r.createdAt);
    if (day !== lastDay) {
      histRows.push(`<tr class="daterow"><td colspan="6">${esc(day)}</td></tr>`);
      lastDay = day;
    }
    histRows.push(historyRow(r));
  }

  const body =
    store.runs.length === 0
      ? `<div class="empty"><div class="gh">${t("No runs yet")}</div><div>${t("Launch a task here, or have your agent start one with the CLI.")}</div><span class="btn primary" data-nav="#/launch">${t("⚡ Open Launch")}</span><div class="codehint">odw run &lt;name&gt;</div></div>`
      : strip +
        `<div class="histwrap"><table class="histtable">` +
        `<thead><tr><th>${t("workflow")}</th><th>${t("run id")}</th><th>${t("status")}</th><th>${t("started")}</th><th>${t("duration")}</th><th>${t("agents")}</th></tr></thead>` +
        `<tbody>${histRows.join("") || `<tr><td colspan="6" style="color:var(--muted);padding:18px 14px;">${t("No finished runs yet.")}</td></tr>`}</tbody></table></div>`;

  return `<div class="jobs">${body}</div>`;
}
