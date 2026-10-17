/** Jobs — the run monitor: live run cards + a filterable, day-grouped history. */
import { pill } from "../components/glyph";
import { icons } from "../icons";
import { t, tn } from "../i18n";
import { activeRuns } from "../shell";
import { store } from "../store";
import type { RunSummary, ScheduleView } from "../types";
import { ACTIVE, TERMINAL, cronWords, esc, fmtAgo, fmtClock, fmtDayGroup, fmtDurSec, fmtHourMin, fmtUsd, runDurationSec } from "../util";
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

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "in 3h 20m" — coarse, the way a person reads a countdown. */
function fmtUntil(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const text = d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m` : `${s}s`;
  return t("in {d}", { d: text });
}

/** One scheduled workflow: when it fires next (large), what it runs, and how its last run went. */
function scheduleCard(s: ScheduleView, nowSec: number): string {
  const next = s.nextRun ? Date.parse(s.nextRun) : NaN;
  let when = `<span class="clock">—</span><span class="day">${t("never")}</span>`;
  if (Number.isFinite(next)) {
    const at = new Date(next);
    const today = new Date(nowSec * 1000);
    const dayDiff = Math.round(
      (new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime() -
        new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) /
        86_400_000,
    );
    const day = dayDiff === 0 ? t("today") : dayDiff === 1 ? t("tomorrow") : t(DAY_NAMES[at.getDay()]!);
    const clock = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
    when = `<span class="clock num">${clock}</span><span class="day">${esc(day)} · ${esc(fmtUntil(next / 1000 - nowSec))}</span>`;
  }
  const words = cronWords(s.cron);
  const lastAt = s.lastRun ? Date.parse(s.lastRun.at) / 1000 : NaN;
  const last = s.lastRun
    ? `${pill(s.lastRun.state)}` +
      (s.lastRun.runId
        ? `<a class="rid" href="#/job/${encodeURIComponent(s.lastRun.runId)}">${esc(s.lastRun.runId)}</a>`
        : "") +
      (Number.isFinite(lastAt) ? `<span class="dim">${esc(fmtAgo(lastAt))}</span>` : "")
    : `<span class="dim">${t("never ran")}</span>`;
  const workflow = s.workflow.split(/[\\/]/).pop() ?? s.workflow;
  return (
    `<article class="card sched${s.installed === false ? " missing" : ""}" data-key="sc-${esc(s.name)}">` +
    `<div class="sched-when">${when}</div>` +
    `<div class="sched-main"><div class="nm"><span class="n" title="${esc(s.name)}">${esc(s.name)}</span><span class="tag">${esc(s.backend)}</span>` +
    `</div><div class="cron"><code>${esc(s.cron)}</code>${words ? `<span>${esc(words)}</span>` : ""}</div>` +
    `<div class="wf" title="${esc(s.workflow)}">${esc(workflow)}</div>` +
    (s.installed === false
      ? `<div class="miss">${t("Its {backend} entry is missing: odw schedule remove {name}, then add it again.", { backend: esc(s.backend), name: esc(s.name) })}</div>`
      : "") +
    `</div>` +
    `<div class="sched-last"><span class="k">${t("last run")}</span>${last}</div>` +
    `</article>`
  );
}

/** What `odw schedule` will start next, soonest first. */
function upcoming(nowSec: number, query: string): string {
  const q = query.trim().toLowerCase();
  const list = store.schedules
    .filter((s) => !q || s.name.toLowerCase().includes(q) || s.workflow.toLowerCase().includes(q))
    .sort((a, b) => (a.nextRun ? Date.parse(a.nextRun) : Infinity) - (b.nextRun ? Date.parse(b.nextRun) : Infinity));
  if (!list.length) return "";
  return (
    `<div class="section-title"><h2>${t("Upcoming")}</h2><span class="eyebrow">${tn(list.length, "{n} schedule", "{n} schedules")}</span></div>` +
    `<div class="sched-list">${list.map((s) => scheduleCard(s, nowSec)).join("")}</div>`
  );
}

function runCard(r: RunSummary, nowSec: number): string {
  const elapsed = r.createdAt != null ? fmtDurSec(nowSec - r.createdAt) : "—";
  const n = r.phases.length;
  const cur = n ? r.phases[Math.min(n - 1, Math.floor(r.progress * n))]!.title : null;
  return (
    `<article class="card runcard" data-run="${esc(r.runId)}" data-key="rc-${esc(r.runId)}" tabindex="0" role="link" aria-label="${esc(r.name)} · ${esc(t(r.state))}">` +
    `<div class="top"><div><div class="nm">${esc(r.name)}</div><div class="rid">${esc(r.runId)}</div></div>${pill(r.state, r.pausedFor ? t("paused until {t}", { t: fmtHourMin(r.pausedFor.resumeAt) }) : undefined)}</div>` +
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
    // Nothing has run yet — but what is scheduled to run is worth showing.
    return (
      `<div class="page jobs">` +
      upcoming(nowSec, "") +
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
    (state.filter === "all" ? upcoming(nowSec, state.query) : "") +
    `<div class="section-title"><h2>${t("History")}</h2><span class="eyebrow">${tn(ended.length, "{n} run", "{n} runs")}</span></div>` +
    history +
    `</div>`
  );
}
