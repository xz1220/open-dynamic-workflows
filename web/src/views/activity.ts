/** Activity — the machine pulse: per-adapter fleet load + a live event firehose. */
import { store } from "../store";
import type { RunDetail } from "../types";
import { esc, fmtClock } from "../util";

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
const EVT_LABEL: Record<string, string> = {
  run_started: "RUN_STARTED",
  run_finished: "RUN_FINISHED",
  run_failed: "RUN_FAILED",
  run_stopped: "RUN_STOPPED",
  phase_started: "PHASE",
  agent_started: "AGENT_STARTED",
  agent_finished: "FINISHED",
  agent_failed: "FAILED",
  log: "LOG",
};

/** Count running agents per adapter across all active runs. */
function fleet(details: RunDetail[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const d of details) {
    for (const a of d.agents) {
      if (a.state !== "running") continue;
      const key = a.adapter ?? "—";
      m.set(key, (m.get(key) ?? 0) + 1);
    }
  }
  return m;
}

function eventDetail(e: { type: string; phase?: unknown; message?: unknown; label?: unknown; error?: unknown }): string {
  if (e.type === "phase_started") return e.phase != null ? `${e.phase}` : "";
  if (e.type === "log") return e.message != null ? String(e.message) : "";
  if (e.type === "agent_failed") return [e.label, e.error].filter(Boolean).map(String).join(" · ");
  if (e.type.startsWith("agent_")) return e.label != null ? String(e.label) : "";
  return "";
}

export function renderActivity(): string {
  const runs = store.runs;
  const activeCount = runs.filter((r) => ["running", "paused", "pending"].includes(r.state)).length;
  const runningAgents = runs.reduce((n, r) => n + r.counts.running, 0);
  const doneAgents = runs.reduce((n, r) => n + r.counts.done, 0);
  const failedAgents = runs.reduce((n, r) => n + r.counts.failed, 0);

  const fl = fleet(store.activeDetails);
  // Show known adapters even at zero so the fleet reads as a roster.
  const roster = ["claude", "codex", "gemini", "qwen", "kimi"];
  for (const a of fl.keys()) if (!roster.includes(a) && a !== "—") roster.push(a);
  const maxLoad = Math.max(4, ...[...fl.values()]);
  const fleetRows = roster
    .map((name) => {
      const n = fl.get(name) ?? 0;
      const pct = n === 0 ? 6 : Math.round((n / maxLoad) * 100);
      return (
        `<div class="fleetrow"><span class="nm">${esc(name)}</span>` +
        `<span class="track"><i class="${n === 0 ? "idle" : ""}" style="width:${pct}%"></i></span>` +
        `<span class="ct">${n} running</span></div>`
      );
    })
    .join("");

  const rows =
    store.activity.length === 0
      ? `<div class="evrow"><span></span><span class="evt log">idle</span><span class="where">No recent events — start a run with <b>odw run &lt;name&gt;</b></span><span></span></div>`
      : store.activity
          .map((e) => {
            const cls = EVT_CLASS[e.type] ?? "log";
            const label = EVT_LABEL[e.type] ?? e.type.toUpperCase();
            return (
              `<div class="evrow">` +
              `<span class="ts">${fmtClock(e.ts)}</span>` +
              `<span><span class="evt ${cls}">${label}</span></span>` +
              `<span class="where"><b>${esc(e._run)}</b>${eventDetail(e) ? " · " + esc(eventDetail(e)) : ""}</span>` +
              `<span class="adp">${esc(e._adapter ?? "—")}</span>` +
              `</div>`
            );
          })
          .join("");

  return (
    `<div class="act-top">` +
    `<div class="counters">` +
    `<div class="counter green"><div class="v">${activeCount}</div><div class="k">runs active</div></div>` +
    `<div class="counter green"><div class="v">${runningAgents}</div><div class="k">agents running</div></div>` +
    `<div class="counter"><div class="v">${doneAgents}</div><div class="k">agents done</div></div>` +
    `<div class="counter red"><div class="v">${failedAgents}</div><div class="k">agents failed</div></div>` +
    `</div>` +
    `<div class="fleet"><h5>Fleet — agents running, by adapter</h5>${fleetRows}</div>` +
    `</div>` +
    `<div class="firehose">` +
    `<div class="fh-head"><span class="t">Live event stream</span><span class="sub">all runs · events.jsonl</span>` +
    `<span class="legend"><span class="evt astart">AGENT_STARTED</span><span class="evt afin">FINISHED</span><span class="evt afail">FAILED</span><span class="evt phase">PHASE</span><span class="evt log">LOG</span></span></div>` +
    rows +
    `</div>`
  );
}
