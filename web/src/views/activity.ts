/** Activity — the machine's pulse: a headline, live counters, the ridgeline, the fleet and the event stream. */
import { pill } from "../components/glyph";
import { renderPulse } from "../components/pulse";
import { t } from "../i18n";
import { store } from "../store";
import type { ActivityEvent } from "../types";
import { ACTIVE, esc, fmtClock } from "../util";

export const EVT_CLASS: Record<string, string> = {
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
  log: "LOG",
};

function eventDetail(e: ActivityEvent): string {
  if (e.type === "phase_started") return e.phase != null ? String(e.phase) : "";
  if (e.type === "log") return e.message != null ? String(e.message) : "";
  if (e.type === "agent_failed") return [e.label, e.error].filter(Boolean).map(String).join(" · ");
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
      ? t("{r} runs in flight{via}.", {
          r: active.length,
          via: adapters.length ? ` · ${adapters.join(", ")}` : "",
        })
      : runs.length
        ? t("Nothing is running. {n} runs on record.", { n: runs.length })
        : t("No runs yet — have your agent start one with odw run.");

  const pulse = renderPulse(runs, store.activity, nowSec);
  const pulseCard = pulse.rows
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
        ? Array.from({ length: Math.min(n, 24) }, (_, i) => `<i data-key="fd-${name}-${i}"></i>`).join("")
        : `<i class="idle"></i>`;
      return (
        `<div class="fleetrow${n ? "" : " zero"}" data-key="fl-${esc(name)}"><span class="nm">${esc(name)}</span>` +
        `<span class="dots">${dots}</span><span class="ct">${n}</span></div>`
      );
    })
    .join("");

  const rows = store.activity.slice(0, 60);
  const stream = rows.length
    ? rows
        .map((e) => {
          const cls = EVT_CLASS[e.type] ?? "log";
          const label = EVT_LABEL[e.type] ?? e.type.toUpperCase();
          const detail = eventDetail(e);
          return (
            `<div class="evrow" data-run="${esc(e.runId)}" data-key="ev-${esc(e.runId)}-${e.ts}-${esc(e.type)}-${esc(String(e.label ?? e.phase ?? ""))}">` +
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
    pulseCard +
    `<div class="act-grid">` +
    `<section class="card fleet" data-key="fleet"><div class="card-head" style="padding:16px 0 8px"><h3>${t("Fleet")}</h3><span class="eyebrow">${t("agents running · by adapter")}</span></div>${fleetRows}</section>` +
    `<section class="card stream" data-key="stream"><div class="card-head"><h3>${t("Live event stream")}</h3><span class="eyebrow">${t("all runs · events.jsonl")}</span></div><div class="stream-list">${stream}</div></section>` +
    `</div></div>`
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
