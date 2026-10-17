/** Jobs — the run monitor: live run cards + a filterable, day-grouped history. */
import { pill } from "../components/glyph";
import { icons } from "../icons";
import { t, tn } from "../i18n";
import { activeRuns } from "../shell";
import { store } from "../store";
import type { RunSummary } from "../types";
import { ACTIVE, TERMINAL, esc, fmtAgo, fmtClock, fmtDayGroup, fmtDurSec, fmtUsd, runDurationSec } from "../util";
import { emptyArt } from "./activity";

export type JobsFilter = "all" | "active" | "done" | "failed";

export interface JobsState {
  filter: JobsFilter;
  query: string;
  /** History rows shown; long histories page in on demand instead of painting thousands of rows. */
  limit: number;
}

export const HISTORY_PAGE = 100;

function provTag(r: RunSummary): string {
  return r.provider === "claude" ? `<span class="tag cc" title="${t("Claude Code workflow — observed read-only")}">Claude Code</span>` : "";
}

/** Phase rail from summary data: phases before the progress point are done. */
function phaseDots(r: RunSummary): string {
  const n = r.phases.length;
  if (!n) return "";
  const cur = Math.min(n - 1, Math.floor(r.progress * n));
  return (
    `<div class="phase-dots">` +
    r.phases
      .map((p, i) => `<i class="${i < cur ? "done" : i === cur ? "on" : ""}" title="${esc(p.title)}"></i>`)
      .join("") +
    `</div>`
  );
}

function segProgress(r: RunSummary): string {
  const total = Math.max(1, r.counts.agents);
  const w = (n: number) => `${((n / total) * 100).toFixed(2)}%`;
  return (
    `<div class="prog thin">` +
    `<i class="p-done" style="width:${w(r.counts.done)}"></i>` +
    `<i class="p-run" style="width:${w(r.counts.running)}"></i>` +
    `<i class="p-fail" style="width:${w(r.counts.failed)}"></i>` +
    `<i class="p-stale" style="width:${w(r.counts.stale)}"></i></div>`
  );
}

function runCard(r: RunSummary, nowSec: number): string {
  const elapsed = r.createdAt != null ? fmtDurSec(nowSec - r.createdAt) : "—";
  const n = r.phases.length;
  const cur = n ? r.phases[Math.min(n - 1, Math.floor(r.progress * n))]!.title : null;
  return (
    `<article class="card runcard" data-run="${esc(r.runId)}" data-key="rc-${esc(r.runId)}" tabindex="0" role="link" aria-label="${esc(r.name)} · ${esc(t(r.state))}">` +
    `<div class="top"><div><div class="nm">${esc(r.name)}</div><div class="rid">${esc(r.runId)}</div></div>${pill(r.state)}</div>` +
    phaseDots(r) +
    (cur ? `<div class="cur">${t("phase")} <b>${esc(cur)}</b> · ${Math.round(r.progress * 100)}%</div>` : "") +
    segProgress(r) +
    `<div class="foot"><span>${t("{n} running", { n: r.counts.running })} · ${t("{n} done", { n: r.counts.done })}` +
    (r.counts.failed ? ` · <span class="alarm">${t("{n} failed", { n: r.counts.failed })}</span>` : "") +
    `</span>${provTag(r)}${r.usage?.costUsd != null ? `<span class="tag">${fmtUsd(r.usage.costUsd)}</span>` : ""}<span class="el">${elapsed}</span></div>` +
    `</article>`
  );
}

function matches(r: RunSummary, s: JobsState): boolean {
  if (s.filter === "active" && !ACTIVE.has(r.state)) return false;
  if (s.filter === "done" && r.state !== "done") return false;
  if (s.filter === "failed" && !(r.state === "failed" || r.state === "stopped" || r.state === "stale")) return false;
  const q = s.query.trim().toLowerCase();
  if (q && !r.name.toLowerCase().includes(q) && !r.runId.toLowerCase().includes(q)) return false;
  return true;
}

export function renderJobs(state: JobsState, nowSec: number): string {
  const runs = store.runs;
  if (runs.length === 0) {
    return (
      `<div class="page">` +
      emptyArt(
        store.runsLoaded ? t("No runs yet") : t("Loading runs…"),
        t("Have your agent start one with the CLI."),
        `<div class="cmd"><span class="p">$</span>odw run &lt;name&gt;</div>`,
      ) +
      `</div>`
    );
  }
  const active = activeRuns();
  const shown = runs.filter((r) => matches(r, state));
  const ended = shown.filter((r) => !ACTIVE.has(r.state));
  const counts = {
    all: runs.length,
    active: active.length,
    done: runs.filter((r) => r.state === "done").length,
    failed: runs.filter((r) => r.state === "failed" || r.state === "stopped" || r.state === "stale").length,
  };
  const chip = (f: JobsFilter, label: string) =>
    `<button class="chip${state.filter === f ? " on" : ""}" data-jobs-filter="${f}">${esc(label)}<span class="n">${counts[f]}</span></button>`;

  const liveCards = shown.filter((r) => ACTIVE.has(r.state));
  const cards = liveCards.length
    ? `<div class="section-title"><h2>${t("In flight")}</h2><span class="eyebrow">${t("{n} live", { n: liveCards.length })}</span></div>` +
      `<div class="runcards">${liveCards.map((r) => runCard(r, nowSec)).join("")}</div>`
    : "";

  // Stale runs never ended, so their "duration" would flatten every other bar.
  const longest = Math.max(
    1,
    ...ended.filter((r) => TERMINAL.has(r.state)).map((r) => runDurationSec(r.createdAt, r.updatedAt, true) ?? 0),
  );
  let lastDay = "";
  const rows: string[] = [];
  for (const r of ended.slice(0, state.limit)) {
    const day = fmtDayGroup(r.createdAt);
    if (day !== lastDay) {
      rows.push(`<tr class="day" data-key="d-${esc(day)}"><td colspan="5">${esc(day)}</td></tr>`);
      lastDay = day;
    }
    const dur = runDurationSec(r.createdAt, r.updatedAt, TERMINAL.has(r.state));
    rows.push(
      `<tr class="run" data-run="${esc(r.runId)}" data-key="h-${esc(r.runId)}" tabindex="0" role="link">` +
        `<td><div class="wf">${esc(r.name)} ${provTag(r)}</div><div class="rid">${esc(r.runId)}</div></td>` +
        `<td>${pill(r.state)}</td>` +
        `<td class="when">${fmtClock(r.createdAt)}<span>${fmtAgo(r.createdAt)}</span></td>` +
        `<td><div class="dur"><i style="width:${Math.max(3, Math.round(Math.sqrt(Math.min(1, (dur ?? 0) / longest)) * 90))}px"></i>${fmtDurSec(dur)}</div></td>` +
        `<td class="agents">${r.counts.agents}${r.counts.failed ? ` · <span class="f">${r.counts.failed} ✕</span>` : ""}` +
        `${r.usage?.costUsd != null ? ` · <span class="usd">${fmtUsd(r.usage.costUsd)}</span>` : ""}</td>` +
        `</tr>`,
    );
  }
  const rest = ended.length - Math.min(ended.length, state.limit);
  const more = rest
    ? `<div class="more-row"><button class="btn" data-jobs-more>${t("Show {n} more", { n: Math.min(rest, HISTORY_PAGE * 2) })}</button><span class="dim">${t("{n} older runs", { n: rest })}</span></div>`
    : "";
  const history = ended.length
    ? `<table class="htable"><thead><tr><th>${t("workflow")}</th><th>${t("status")}</th><th>${t("started")}</th><th>${t("duration")}</th><th>${t("agents")}</th></tr></thead><tbody>${rows.join("")}</tbody></table>${more}`
    : `<div class="empty" style="min-height:140px"><p>${state.query || state.filter !== "all" ? t("No runs match.") : t("No finished runs yet.")}</p></div>`;

  return (
    `<div class="page jobs">` +
    `<header class="page-head"><div><div class="eyebrow">${t("Jobs")}</div><h1 class="display">${t("Every <em>run</em>, live and past.")}</h1></div>` +
    `<div class="jobs-tools">` +
    `<div class="chips">${chip("all", t("All"))}${chip("active", t("Live"))}${chip("done", t("Done"))}${chip("failed", t("Failed"))}</div>` +
    `<label class="field">${icons.search}<input id="jobs-q" placeholder="${esc(t("Filter by name or run id"))}" value="${esc(state.query)}" autocomplete="off"/></label>` +
    `</div></header>` +
    cards +
    `<div class="section-title"><h2>${t("History")}</h2><span class="eyebrow">${tn(ended.length, "{n} run", "{n} runs")}</span></div>` +
    history +
    `</div>`
  );
}
