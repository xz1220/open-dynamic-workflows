/**
 * Live DAG renderer — derived from RunDetail (no explicit topology events).
 *
 * Lanes are the run's phases (phaseOrder); each phase's agents stack vertically
 * inside its lane (the fan-out read). Edges connect lane L's nodes to lane L+1's
 * — one source fanning to many (Plan→Search) or parallel rails (Search→Extract) —
 * colored by the downstream node's state, with a travelling flow-dot while it
 * runs. Faithful for the real workflows; explicit groupId/kind/index remain an
 * additive runtime follow-up (see docs/tasks/gui.md G2).
 */
import type { AgentView, RunDetail } from "./types";
import { esc, fmtDurSec } from "./util";

const PAD_X = 24;
const PAD_TOP = 52;
const LANE_W = 158;
const PITCH = 212;
const SLOT = 88;
const MAX_PER_LANE = 9;

function laneTitles(run: RunDetail): string[] {
  if (run.phaseOrder && run.phaseOrder.length) return run.phaseOrder;
  const seen: string[] = [];
  for (const a of run.agents) {
    const p = a.phase ?? "run";
    if (!seen.includes(p)) seen.push(p);
  }
  return seen.length ? seen : ["run"];
}

function subLine(a: AgentView): string {
  if (a.state === "running") {
    const t = a.startedAt != null ? `⏱ ${fmtDurSec(Date.now() / 1000 - a.startedAt)}` : "";
    return [a.adapter, t].filter(Boolean).join(" · ") || "running";
  }
  const dur = a.durationMs != null ? fmtDurSec(a.durationMs / 1000) : "";
  return [a.adapter, dur].filter(Boolean).join(" · ") || (a.adapter ?? "");
}

function node(a: AgentView, ai: number, x: number, y: number, sel: number | null): string {
  const glyph =
    a.state === "done"
      ? `<span class="gl" style="color:var(--done)">✓</span>`
      : a.state === "failed"
        ? `<span class="gl" style="color:var(--red)">✕</span>`
        : "";
  const body =
    a.state === "failed" && a.error
      ? `<div class="err">${esc(a.error.slice(0, 90))}</div>`
      : `<div class="sub">${esc(subLine(a))}</div>`;
  const selected = sel === ai ? " selected" : "";
  return (
    `<div class="node ${a.state}${selected}" data-ai="${ai}" ` +
    `style="left:${x}px;top:${y}px;width:${LANE_W}px;">` +
    `<div class="h">${esc(a.label)}</div>${body}<span class="dot"></span>${glyph}</div>`
  );
}

export function renderDag(run: RunDetail, selectedAi: number | null): { html: string } {
  const lanes = laneTitles(run);
  const cols: Array<Array<{ a: AgentView; ai: number }>> = lanes.map(() => []);
  run.agents.forEach((a, ai) => {
    const p = a.phase ?? "run";
    let li = lanes.indexOf(p);
    if (li < 0) li = 0;
    cols[li]!.push({ a, ai });
  });

  type Pos = { x: number; cy: number; state: string };
  const posByLane: Pos[][] = [];
  let maxRows = 1;
  cols.forEach((col, li) => {
    const x = PAD_X + li * PITCH;
    const shown = col.slice(0, MAX_PER_LANE);
    posByLane.push(shown.map((_c, i) => ({ x, cy: PAD_TOP + i * SLOT + 26, state: shown[i]!.a.state })));
    maxRows = Math.max(maxRows, shown.length + (col.length > MAX_PER_LANE ? 1 : 0) || 1);
  });

  const W = PAD_X + Math.max(0, lanes.length - 1) * PITCH + LANE_W + PAD_X;
  const H = PAD_TOP + maxRows * SLOT + 16;

  const edges: string[] = [];
  const dots: string[] = [];
  for (let li = 1; li < lanes.length; li++) {
    const prev = posByLane[li - 1]!;
    if (!prev.length) continue;
    posByLane[li]!.forEach((p, i) => {
      const src = prev[Math.min(i, prev.length - 1)]!;
      const x1 = src.x + LANE_W;
      const y1 = src.cy;
      const x2 = p.x;
      const y2 = p.cy;
      const mx = (x1 + x2) / 2;
      const d = `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`;
      const color = p.state === "failed" ? "#ef4444" : p.state === "done" ? "#7E8D84" : "#16C079";
      edges.push(`<path d="${d}" stroke="${color}" stroke-width="${p.state === "done" ? 1.6 : 2}" fill="none"/>`);
      if (p.state === "running") {
        dots.push(
          `<circle r="3.2" class="flowdot"><animateMotion dur="1.3s" repeatCount="indefinite" path="${d}"/></circle>`,
        );
      }
    });
  }

  const parts: string[] = [];
  parts.push(
    `<svg class="edges" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${edges.join("")}${dots.join("")}</svg>`,
  );
  lanes.forEach((title, li) => {
    const x = PAD_X + li * PITCH;
    parts.push(`<div class="watermark" style="left:${x - 4}px;">${esc(title)}</div>`);
    parts.push(
      `<div class="lanehead" style="left:${x}px;width:${LANE_W}px;"><span class="ix">${li + 1}/${lanes.length}</span> ${esc(title)} <span class="n">${cols[li]!.length}</span><span class="line" style="width:${LANE_W}px;"></span></div>`,
    );
    const shown = cols[li]!.slice(0, MAX_PER_LANE);
    shown.forEach((c, i) => parts.push(node(c.a, c.ai, x, PAD_TOP + i * SLOT, selectedAi)));
    if (cols[li]!.length > MAX_PER_LANE) {
      const extra = cols[li]!.length - MAX_PER_LANE;
      const y = PAD_TOP + shown.length * SLOT;
      parts.push(
        `<div class="groupcard" style="left:${x}px;top:${y}px;width:${LANE_W}px;"><b>+${extra}</b> more agents</div>`,
      );
    }
  });

  return { html: `<div class="dag" style="width:${W}px;height:${H}px;">${parts.join("")}</div>` };
}
