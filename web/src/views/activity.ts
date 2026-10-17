/** Activity — the machine's pulse: a headline, live counters, the ridgeline, the fleet and the event stream. */
import { glyph, pill } from "../components/glyph";
import { icons } from "../icons";
import { renderPulse } from "../components/pulse";
import { t, tn } from "../i18n";
import { store } from "../store";
import type { ActivityEvent, RunSummary } from "../types";
import { ACTIVE, esc, fmtAgo, fmtClock, fmtHourMin } from "../util";

export const EVT_CLASS: Record<string, string> = {
  run_started: "rstart",
  run_finished: "rfin",
  run_failed: "rfail",
  run_stopped: "rstop",
  phase_started: "phase",
  agent_started: "astart",
  agent_finished: "afin",
  agent_failed: "afail",
  command_started: "cstart",
  command_finished: "cfin",
  command_failed: "afail",
  log: "log",
};
// Machine event tokens — mirror events.jsonl; left untranslated by design.
export const EVT_LABEL: Record<string, string> = {
  run_started: "RUN START",
  run_finished: "RUN DONE",
  run_failed: "RUN FAILED",
  run_stopped: "RUN STOP",
  phase_started: "PHASE",
  agent_started: "AGENT ▸",
  agent_finished: "AGENT ✓",
  agent_failed: "AGENT ✕",
  command_started: "$ ▸",
  command_finished: "$ ✓",
  command_failed: "$ ✕",
  log: "LOG",
};

/** `$ npm test` · exit 1 · 4.2s — what a command step ran and how it ended. */
export function commandDetail(e: { type: string; label?: unknown; command?: unknown; exitCode?: unknown; durationMs?: unknown }): string {
  const what = String(e.label ?? e.command ?? "command");
  if (e.type === "command_started") return what;
  const code = typeof e.exitCode === "number" ? `exit ${e.exitCode}` : t("killed");
  const secs = typeof e.durationMs === "number" ? ` · ${(e.durationMs / 1000).toFixed(1)}s` : "";
  return `${what} · ${code}${secs}`;
}

function eventDetail(e: ActivityEvent): string {
  if (e.type === "phase_started") return e.phase != null ? String(e.phase) : "";
  if (e.type === "log") return e.message != null ? String(e.message) : "";
  if (e.type === "agent_failed") return [e.label, e.error].filter(Boolean).map(String).join(" · ");
  if (e.type.startsWith("command_")) return commandDetail(e);
  if (e.type.startsWith("agent_")) return e.label != null ? String(e.label) : "";
  return "";
}

/** The headline sentence adapts to what the fleet is doing right now. */
function headline(active: number, running: number, failedNow: number): { cls: string; html: string } {
  if (failedNow > 0 && running === 0) {
    return { cls: "alarm", html: t("Something <em>broke</em>.") };
  }
  if (running > 0) {
    return {
      cls: "",
      html: running === 1 ? t("One agent is <em>working</em>.") : t("{n} agents are <em>working</em>.", { n: running }),
    };
  }
  if (active > 0) return { cls: "", html: t("Runs are <em>in flight</em>.") };
  return { cls: "idle", html: t("The fleet is <em>at rest</em>.") };
}

function stat(v: number, k: string, href: string, cls = "", frac?: number): string {
  const bar = frac != null ? `<i class="bar" style="width:${Math.round(frac * 100)}%"></i>` : "";
  return `<a class="stat ${cls}" href="${href}" data-nav="${href}"><div class="v num">${v}</div><div class="k">${esc(k)}</div>${bar}</a>`;
}

export function renderActivity(nowSec: number): string {
  const runs = store.runs;
  const active = runs.filter((r) => ACTIVE.has(r.state));
  const running = active.reduce((n, r) => n + r.counts.running, 0);
  const totalAgents = runs.reduce((n, r) => n + r.counts.agents, 0);
  const done = runs.reduce((n, r) => n + r.counts.done, 0);
  const failed = runs.reduce((n, r) => n + r.counts.failed, 0);
  const failedRecently = runs.filter((r) => r.state === "failed" && (r.updatedAt ?? 0) > nowSec - 3600).length;
  const head = headline(active.length, running, failedRecently);
  const adapters = [...new Set(Object.keys(store.fleet))].filter((a) => a !== "—");

  const lede =
    active.length > 0
      ? tn(active.length, "{n} run in flight{via}.", "{n} runs in flight{via}.", {
          via: adapters.length ? ` · ${adapters.join(", ")}` : "",
        })
      : runs.length
        ? tn(runs.length, "Nothing is running. {n} run on record.", "Nothing is running. {n} runs on record.")
        : t("No runs yet — have your agent start one with odw run.");

  const pulse = renderPulse(runs, store.activity, nowSec);
  const pulseCard = store.runsLoaded && runs.length === 0
    ? gettingStarted()
    : pulse.rows
    ? `<section class="card pulse marked" data-key="pulse">` +
      `<div class="pulse-head"><h3>${t("Pulse")}</h3><span class="eyebrow">${t("events per run · last {s}", { s: pulse.span })}</span></div>` +
      pulse.svg +
      `</section>`
    : `<section class="card pulse marked" data-key="pulse">${emptyArt(t("Quiet so far"), t("Every run you start draws a line here."))}</section>`;

  // Fleet: known adapters stay listed at zero so it reads as a roster.
  const roster = ["claude", "codex", "gemini", "qwen", "kimi"];
  for (const a of Object.keys(store.fleet)) if (!roster.includes(a) && a !== "—") roster.push(a);
  const fleetRows = roster
    .map((name) => {
      const n = store.fleet[name] ?? 0;
      const dots = n
        ? Array.from({ length: Math.min(n, 24) }, (_, i) => `<i data-key="fd-${esc(name)}-${i}"></i>`).join("")
        : `<i class="idle"></i>`;
      return (
        `<div class="fleetrow${n ? "" : " zero"}" data-key="fl-${esc(name)}"><span class="nm">${esc(name)}</span>` +
        `<span class="dots">${dots}</span><span class="ct">${n}</span></div>`
      );
    })
    .join("");

  const rows = store.activity.slice(0, 60);
  const seen = new Map<string, number>();
  const stream = rows.length
    ? rows
        .map((e) => {
          const base = `ev-${e.runId}-${e.ts}-${e.type}-${String(e.label ?? e.phase ?? "")}`;
          const dup = seen.get(base) ?? 0;
          seen.set(base, dup + 1);
          const cls = EVT_CLASS[e.type] ?? "log";
          const label = EVT_LABEL[e.type] ?? e.type.toUpperCase();
          const detail = eventDetail(e);
          return (
            `<div class="evrow" data-run="${esc(e.runId)}" data-key="${esc(dup ? `${base}~${dup}` : base)}">` +
            `<span class="ts">${fmtClock(e.ts)}</span>` +
            `<span><span class="evt ${cls}">${label}</span></span>` +
            `<span class="where"><b>${esc(e.run)}</b>${detail ? " · " + esc(detail) : ""}</span>` +
            `<span class="adp">${esc(e.adapter ?? "")}</span></div>`
          );
        })
        .join("")
    : `<div class="empty" style="min-height:160px"><p>${t("No recent events.")}</p></div>`;

  return (
    `<div class="page activity">` +
    `<section class="hero ${head.cls}">` +
    `<div><div class="eyebrow">${pill(active.length ? "running" : "idle", active.length ? t("live") : t("idle"))}<span>${t("Activity")}</span></div>` +
    `<h1 class="display">${head.html}</h1><p class="lede">${esc(lede)}</p></div>` +
    `<div class="stats">` +
    stat(active.length, t("runs in flight"), "#/jobs/live", "sig") +
    stat(running, t("agents running"), "#/jobs/live", "sig") +
    stat(done, t("agents done"), "#/jobs/done", "", totalAgents ? done / totalAgents : 0) +
    stat(failed, t("agents failed"), "#/jobs/failed", failed ? "alarm" : "", totalAgents ? failed / totalAgents : 0) +
    `</div></section>` +
    needsYou(nowSec) +
    pulseCard +
    `<div class="act-grid">` +
    `<section class="card fleet" data-key="fleet"><div class="card-head" style="padding:16px 0 8px"><h3>${t("Fleet")}</h3><span class="eyebrow">${t("agents running · by adapter")}</span></div>${fleetRows}</section>` +
    `<section class="card stream" data-key="stream"><div class="card-head"><h3>${t("Live event stream")}</h3><span class="eyebrow">${t("all runs · events.jsonl")}</span></div><div class="stream-list">${stream}</div></section>` +
    `</div></div>`
  );
}

/**
 * What a person has to act on: checkpoints waiting for a decision first, then
 * the last day's failed or stranded ODW runs, each with the command that picks
 * it up again. Nothing to do, nothing drawn.
 */
function needsYou(nowSec: number): string {
  const waiting = store.runs.filter((r) => r.state === "waiting");
  const quota = store.runs.filter((r) => r.pausedFor);
  const allBroken = store.runs.filter(
    (r) => r.provider === "odw" && (r.state === "failed" || r.state === "stale") && (r.updatedAt ?? 0) > nowSec - 86_400,
  );
  const broken = allBroken.slice(0, 3);
  if (!waiting.length && !quota.length && !broken.length) return "";
  const href = (r: RunSummary) => `#/job/${encodeURIComponent(r.runId)}`;
  const ticket = (r: RunSummary, kind: string, what: string, action: string) =>
    `<div class="ticket ${kind}" data-key="nt-${esc(r.runId)}">` +
    `<a class="tk-main" href="${href(r)}">${glyph(kind)}<span class="tk-text"><b>${esc(r.name)}</b><span title="${what}">${what}</span></span></a>` +
    `<div class="tk-side"><span class="tk-when">${esc(fmtAgo(r.waiting?.since ?? r.updatedAt))}</span>${action}</div></div>`;
  const resume = (r: RunSummary) =>
    `<button class="btn sm" data-copy="odw resume ${esc(r.runId)}" data-tip="${esc(t("copies a command that replays finished agents"))}">${icons.terminal}${t("Copy resume")}</button>`;
  const tickets = [
    ...waiting.map((r) =>
      ticket(
        r,
        "waiting",
        r.waiting?.title ? t("asks: {q}", { q: esc(r.waiting.title) }) : t("is waiting for your decision"),
        `<a class="btn sm primary" href="${href(r)}">${t("Review")}</a>`,
      ),
    ),
    ...quota.map((r) =>
      ticket(
        r,
        "paused",
        t("{adapter} is out of quota — resumes at {t}", { adapter: esc(r.pausedFor!.adapter), t: fmtHourMin(r.pausedFor!.resumeAt) }),
        store.capabilities.writable ? `<button class="btn sm" data-resume-run="${esc(r.runId)}">${t("Resume now")}</button>` : "",
      ),
    ),
    ...broken.map((r) =>
      ticket(
        r,
        r.state,
        r.state === "stale"
          ? t("lost its worker")
          : r.counts.failed
            ? t("failed · {n} of {m} agents failed", { n: r.counts.failed, m: r.counts.agents })
            : t("failed"),
        resume(r),
      ),
    ),
  ];
  return (
    `<section class="needs" data-key="needs" aria-label="${esc(t("Needs you"))}">` +
    `<div class="needs-head"><h3>${t("Needs you")}</h3><span class="n">${waiting.length + quota.length + allBroken.length}</span>` +
    `<span class="eyebrow">${t("decisions and runs to pick up")}</span></div>` +
    `<div class="tickets">${tickets.join("")}</div>` +
    (allBroken.length > broken.length
      ? `<a class="needs-more" href="#/jobs/failed" data-key="needs-more">${t("+{n} more failed in the last day", { n: allBroken.length - broken.length })} →</a>`
      : "") +
    `</section>`
  );
}

/** First run: three steps from a fresh install to a live graph on this page. */
function gettingStarted(): string {
  const step = (n: string, title: string, cmd: string, note: string) =>
    `<li class="gs-step"><span class="ix">${n}</span><div><h4>${esc(title)}</h4>` +
    `<span class="cmd" title="${esc(cmd)}"><span class="p">$</span><span class="t">${esc(cmd)}</span><button class="iconbtn" data-copy="${esc(cmd)}" aria-label="${esc(t("Copy"))}">${icons.copy}</button></span>` +
    `<p class="dim">${esc(note)}</p></div></li>`;
  return (
    `<section class="card pulse marked gs" data-key="pulse">` +
    `<div class="pulse-head"><h3>${t("Get started")}</h3><span class="eyebrow">${t("three steps to a live graph")}</span></div>` +
    `<ol class="gs-steps">` +
    step("01", t("Check the setup"), "odw doctor --smoke", t("Runtime, config and every adapter — plus one real prompt to the default.")) +
    step("02", t("Run an example"), "odw run examples/fan-out-reduce.js --args '{\"question\":\"Design a rate limiter\"}'", t("Four drafts in parallel, then a synthesis. Watch it draw here.")) +
    step("03", t("Hand it to your agent"), "odw run <name> --wait", t("With the ODW skill installed, your coding agent writes and runs workflows for you.")) +
    `</ol></section>`
  );
}

/** A small line-drawing used by empty states: a DAG being plotted. */
export function emptyArt(title: string, body: string, extra = ""): string {
  return (
    `<div class="empty">` +
    `<svg class="art" viewBox="0 0 160 90" aria-hidden="true">` +
    `<path d="M20 45 C55 45 55 18 90 18 M20 45 C55 45 55 72 90 72 M90 18 C115 18 115 45 140 45 M90 72 C115 72 115 45 140 45"/>` +
    `<path class="lit" pathLength="1" d="M20 45 C55 45 55 18 90 18 C115 18 115 45 140 45"/>` +
    `<circle class="dot" cx="20" cy="45" r="5"/><circle class="dot" cx="90" cy="18" r="4.5"/><circle class="dot" cx="90" cy="72" r="4.5"/><circle class="dot sig" cx="140" cy="45" r="5"/></svg>` +
    `<h3>${esc(title)}</h3><p>${body}</p>${extra}</div>`
  );
}
