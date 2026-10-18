/**
 * Timeline — a Gantt view of one run: every agent as a bar from its start to
 * its finish (or to now while it runs), grouped under its phase. Answers the
 * question the DAG can't: *where did the time go?*
 */
import { t } from "../i18n";
import type { AgentView, RunDetail } from "../types";
import { TERMINAL, esc, fmtDurSec } from "../util";
import { shownState } from "../dag";
import { glyph } from "./glyph";

const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400];
/** Bars painted per phase; the rest are summarized so a 1,000-agent run stays light. */
const MAX_ROWS_PER_PHASE = 80;

function tickLabel(sec: number): string {
  if (sec === 0) return "0";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(sec % 3600 ? 1 : 0)}h`;
}

export function renderTimeline(run: RunDetail, selectedAi: number | null, nowSec: number): string {
  const started = run.agents.filter((a) => a.startedAt != null);
  if (started.length === 0) {
    return `<div class="empty"><h3>${t("Nothing on the clock yet")}</h3><p>${t("Bars appear as agents start.")}</p></div>`;
  }
  const terminal = TERMINAL.has(run.state);
  const t0 = Math.min(run.createdAt ?? Infinity, ...started.map((a) => a.startedAt!));
  const ends = run.agents.map((a) =>
    a.finishedAt ?? (a.startedAt != null && a.durationMs != null ? a.startedAt + a.durationMs / 1000 : null),
  );
  const lastEnd = Math.max(t0 + 1, ...ends.filter((e): e is number => e != null), terminal ? (run.updatedAt ?? 0) : nowSec);
  const span = Math.max(1, lastEnd - t0);
  const step = STEPS.find((s) => span / s <= 7) ?? STEPS[STEPS.length - 1]!;
  const pct = (sec: number) => `${((sec / span) * 100).toFixed(3)}%`;

  const ticks: string[] = [];
  const grid: string[] = [];
  for (let s = 0; s <= span; s += step) {
    ticks.push(`<span style="left:${pct(s)}">${tickLabel(s)}</span>`);
    grid.push(`<i class="tl-grid" style="left:${pct(s)}"></i>`);
  }
  const gridHtml = grid.join("");

  const order = run.phaseOrder.length ? run.phaseOrder : [...new Set(run.agents.map((a) => a.phase ?? t("run")))];
  const groups = new Map<string, Array<{ a: AgentView; ai: number }>>();
  for (const p of order) groups.set(p, []);
  run.agents.forEach((a, ai) => {
    const p = a.phase ?? t("run");
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p)!.push({ a, ai });
  });

  const body: string[] = [];
  let pi = 0;
  for (const [phase, items] of groups) {
    pi++;
    if (items.length === 0) continue;
    const starts = items.filter((x) => x.a.startedAt != null).map((x) => x.a.startedAt! - t0);
    const stops = items.map((x) => {
      const e = ends[x.ai];
      return e != null ? e - t0 : x.a.state === "running" || x.a.state === "waiting" ? lastEnd - t0 : null;
    });
    const pStart = starts.length ? Math.min(...starts) : 0;
    const pEnd = Math.max(pStart, ...stops.filter((s): s is number => s != null));
    body.push(
      `<div class="tl-phase" data-key="tlp-${esc(phase)}"><div class="nm"><span class="ix">${String(pi).padStart(2, "0")}</span>${esc(phase)}</div>` +
        `<div class="span"><i style="left:${pct(pStart)};width:${pct(pEnd - pStart)}"></i></div></div>`,
    );
    const overflow = items.length - MAX_ROWS_PER_PHASE;
    for (const { a, ai } of items.slice(0, MAX_ROWS_PER_PHASE)) {
      const sel = selectedAi === ai ? " selected" : "";
      let bar = "";
      if (a.startedAt != null) {
        const s = a.startedAt - t0;
        const e = (ends[ai] ?? (a.state === "running" || a.state === "waiting" ? lastEnd : a.startedAt)) - t0;
        const dur = a.durationMs != null ? a.durationMs / 1000 : e - s;
        bar =
          `<i class="tl-bar ${esc(shownState(a))}" style="left:${pct(s)};width:${pct(Math.max(e - s, 0))}"></i>` +
          (e / span > 0.86
            ? `<span class="tl-dur in" style="right:calc(100% - ${pct(s)})">${fmtDurSec(dur)}</span>`
            : `<span class="tl-dur" style="left:${pct(Math.max(e, s))}">${fmtDurSec(dur)}</span>`);
      }
      body.push(
        `<div class="tl-row${sel}" data-ai="${ai}" data-key="tlr-${ai}" tabindex="0" role="button">` +
          `<div class="nm">${glyph(shownState(a))}<span>${esc(a.label)}</span></div>` +
          `<div class="tl-track">${gridHtml}${bar}</div></div>`,
      );
    }
    if (overflow > 0) {
      body.push(
        `<div class="tl-row" data-key="tlo-${esc(phase)}"><div class="nm dim">${t("+{n} more agents in this phase", { n: overflow })}</div><div class="tl-track">${gridHtml}</div></div>`,
      );
    }
  }
  const now = terminal ? "" : `<i class="tl-now" style="left:${pct(nowSec - t0)}"></i>`;
  return (
    `<div class="tl">` +
    `<div class="tl-axis"><div></div><div class="tl-ticks">${ticks.join("")}</div></div>` +
    `<div style="position:relative">${body.join("")}` +
    (now ? `<div style="position:absolute;left:220px;right:0;top:0;bottom:0;pointer-events:none">${now}</div>` : "") +
    `</div></div>`
  );
}
