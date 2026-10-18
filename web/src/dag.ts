/**
 * Live DAG renderer — derived from RunDetail (no explicit topology events).
 *
 * Lanes are the run's phases (phaseOrder); each phase's agents stack inside its
 * lane, vertically centred against the tallest lane so a fan-out reads as a
 * fan and a reduce reads as a funnel. Edges join consecutive non-empty lanes:
 * one-to-many and many-to-one fan fully, equal lanes run as parallel rails,
 * anything else maps proportionally so every node stays connected. Edges are
 * plotted in (stroke-dash draw-in on first appearance) and carry a marching
 * signal + spark while their downstream agent runs. Every element is keyed, so
 * the morpher moves nodes instead of re-creating them and animations play
 * exactly once.
 */
import { glyph } from "./components/glyph";
import { t } from "./i18n";
import type { AgentView, RunDetail } from "./types";
import { esc, fmtDurSec, fmtHourMin, fmtTokens } from "./util";

export const NODE_W = 196;
const NODE_H = 58;
const PAD_X = 36;
const PAD_TOP = 70;
const PITCH = NODE_W + 92;
const SLOT = NODE_H + 18;
const MAX_PER_LANE = 12;

function laneTitles(run: RunDetail): string[] {
  if (run.phaseOrder && run.phaseOrder.length) {
    const titles = [...run.phaseOrder];
    for (const a of run.agents) if (a.phase && !titles.includes(a.phase)) titles.push(a.phase);
    return titles;
  }
  const seen: string[] = [];
  for (const a of run.agents) {
    const p = a.phase ?? t("run");
    if (!seen.includes(p)) seen.push(p);
  }
  return seen.length ? seen : [t("run")];
}

/**
 * The state a node is drawn in: a running agent waiting out a spent quota
 * (quotaWait) is waiting, not working — amber, like a checkpoint.
 */
export function shownState(a: AgentView): AgentView["state"] {
  return a.state === "running" && a.quotaWait ? "waiting" : a.state;
}

function subLine(a: AgentView, nowSec: number): string {
  if (a.kind === "checkpoint") {
    if (a.state === "waiting") {
      return [t("waiting for a person"), a.startedAt != null ? fmtDurSec(nowSec - a.startedAt) : ""].filter(Boolean).join(" · ");
    }
    if (a.decision) {
      const verdict = a.decision.approved ? (a.edited ? t("approved with edits") : t("approved")) : t("rejected");
      return [verdict, a.decision.by ? t(a.decision.by) : "", a.decision.note ? `“${a.decision.note}”` : ""].filter(Boolean).join(" · ");
    }
    return a.error ? a.error.split("\n")[0]!.slice(0, 80) : t("not answered");
  }
  if (a.kind === "command") {
    const dur =
      a.state === "running" && a.startedAt != null
        ? fmtDurSec(nowSec - a.startedAt)
        : a.durationMs != null
          ? fmtDurSec(a.durationMs / 1000)
          : "";
    const code = a.state === "running" ? t("running") : a.exitCode != null ? `exit ${a.exitCode}` : "";
    return [t("command"), code, dur].filter(Boolean).join(" · ");
  }
  if (a.state === "failed" && a.error) {
    const why = a.failureReason ? `${reasonLabel(a.failureReason)} · ` : "";
    return why + a.error.split("\n")[0]!.slice(0, 80);
  }
  // An agent that fell back shows the chain it walked: codex → claude.
  const via = a.fellBackFrom?.length && a.adapter ? `${a.fellBackFrom.join(" → ")} → ${a.adapter}` : a.adapter;
  if (a.state === "running" && a.quotaWait) {
    const w = a.quotaWait;
    return w.resumeAt != null
      ? t("waits for {adapter} quota · {t}", { adapter: w.adapter, t: fmtHourMin(w.resumeAt) })
      : t("waits for {adapter} quota", { adapter: w.adapter });
  }
  if (a.state === "running") {
    const elapsed = a.startedAt != null ? fmtDurSec(nowSec - a.startedAt) : "";
    return [via, elapsed].filter(Boolean).join(" · ") || t("running");
  }
  if (a.state === "stale") return [a.adapter, t("no signal")].filter(Boolean).join(" · ");
  const dur = a.durationMs != null ? fmtDurSec(a.durationMs / 1000) : "";
  const tries = a.attempts && a.attempts > 1 ? `×${a.attempts}` : "";
  return [via, dur, tries].filter(Boolean).join(" · ");
}

/** Human words for the engine's failure classes. */
export function reasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    rate_limit: t("rate limit"),
    quota: t("quota"),
    auth: t("login needed"),
    timeout: t("timed out"),
    stalled: t("stalled"),
    not_found: t("CLI not found"),
    permission: t("permission denied"),
    exit: t("exit"),
    empty_reply: t("empty reply"),
    unmet_expectation: t("unmet expectation"),
    mcp_unavailable: t("MCP unavailable"),
    runaway: t("runaway"),
  };
  return labels[reason] ?? reason.replace(/_/g, " ");
}

export interface DagLayout {
  html: string;
  width: number;
  height: number;
}

export function renderDag(
  run: RunDetail,
  selectedAi: number | null,
  opts: { nowSec: number; zoom: number; motion: boolean; currentPhase: string | null },
): DagLayout {
  const lanes = laneTitles(run);
  const cols: Array<Array<{ a: AgentView; ai: number }>> = lanes.map(() => []);
  run.agents.forEach((a, ai) => {
    let li = lanes.indexOf(a.phase ?? t("run"));
    if (li < 0) li = 0;
    cols[li]!.push({ a, ai });
  });

  const rowsOf = (n: number) => Math.min(n, MAX_PER_LANE) + (n > MAX_PER_LANE ? 1 : 0);
  const maxRows = Math.max(1, ...cols.map((c) => rowsOf(c.length)));
  const W = PAD_X * 2 + (lanes.length - 1) * PITCH + NODE_W;
  const H = PAD_TOP + maxRows * SLOT + 24;

  type Pos = { ai: number; x: number; y: number; state: string };
  const pos: Pos[][] = cols.map((col, li) => {
    const shown = col.slice(0, MAX_PER_LANE);
    const offset = ((maxRows - rowsOf(col.length)) * SLOT) / 2;
    return shown.map((c, i) => ({ ai: c.ai, x: PAD_X + li * PITCH, y: PAD_TOP + offset + i * SLOT, state: shownState(c.a) }));
  });

  // --- edges between consecutive non-empty lanes ---
  const edges: string[] = [];
  const flows: string[] = [];
  const filled = pos.map((p, li) => ({ p, li })).filter((x) => x.p.length > 0);
  for (let k = 1; k < filled.length; k++) {
    const prev = filled[k - 1]!.p;
    const next = filled[k]!.p;
    const pairs = new Set<string>();
    const P = prev.length;
    const N = next.length;
    if (P === 1 || N === 1) {
      for (let i = 0; i < P; i++) for (let j = 0; j < N; j++) pairs.add(`${i}:${j}`);
    } else if (P === N) {
      for (let i = 0; i < P; i++) pairs.add(`${i}:${i}`);
    } else {
      const used = new Set<number>();
      for (let j = 0; j < N; j++) {
        const i = Math.round((j * (P - 1)) / (N - 1));
        pairs.add(`${i}:${j}`);
        used.add(i);
      }
      for (let i = 0; i < P; i++) if (!used.has(i)) pairs.add(`${i}:${Math.round((i * (N - 1)) / (P - 1))}`);
    }
    for (const pair of pairs) {
      const [i, j] = pair.split(":").map(Number) as [number, number];
      const s = prev[i]!;
      const d = next[j]!;
      const x1 = s.x + NODE_W;
      const y1 = s.y + NODE_H / 2;
      const x2 = d.x;
      const y2 = d.y + NODE_H / 2;
      const mx = (x1 + x2) / 2;
      const path = `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`;
      const key = `e-${s.ai}-${d.ai}`;
      edges.push(`<path class="edge ${esc(d.state)}" data-key="${key}" d="${path}" pathLength="1"/>`);
      if (d.state === "running" || d.state === "waiting") {
        flows.push(`<path class="flow${d.state === "waiting" ? " wait" : ""}" data-key="f-${key}" d="${path}" pathLength="1"/>`);
        if (opts.motion && d.state === "running") {
          flows.push(
            `<circle class="spark" data-key="s-${key}" r="3"><animateMotion dur="1.6s" repeatCount="indefinite" path="${path}"/></circle>`,
          );
        }
      }
    }
  }

  // --- lane headers, rules, nodes ---
  const parts: string[] = [];
  parts.push(
    `<svg class="edges" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${edges.join("")}${flows.join("")}</svg>`,
  );
  lanes.forEach((title, li) => {
    const x = PAD_X + li * PITCH;
    const on = title === opts.currentPhase ? " on" : "";
    parts.push(
      `<div class="lanehead${on}" data-key="lh-${li}" style="left:${x}px;width:${NODE_W}px">` +
        `<span class="ix">${String(li + 1).padStart(2, "0")}</span><span class="t">${esc(title)}</span>` +
        `<span class="n">${cols[li]!.length}</span></div>`,
    );
    if (li > 0) parts.push(`<i class="lanerule" data-key="lr-${li}" style="left:${x - (PITCH - NODE_W) / 2}px"></i>`);
    for (const p of pos[li]!) {
      const a = run.agents[p.ai]!;
      const sel = selectedAi === p.ai ? " selected" : "";
      const dim = selectedAi != null && selectedAi !== p.ai ? " dim" : "";
      parts.push(
        `<div class="node ${esc(p.state)}${a.kind === "command" ? " cmd" : a.kind === "checkpoint" ? " cp" : a.quotaWait && a.state === "running" ? " qwait" : ""}${sel}${dim}" data-ai="${p.ai}" data-key="n-${p.ai}" tabindex="0" role="button" aria-pressed="${selectedAi === p.ai}" ` +
          `style="left:${p.x}px;top:${p.y}px;width:${NODE_W}px" title="${esc(a.label)}">` +
          `<div class="h">${glyph(p.state)}<span class="lbl">${a.kind === "command" ? `<span class="prompt">$</span> ` : ""}${esc(a.label)}</span>${a.changes?.files ? `<span class="ndelta" title="${esc(t("lines changed"))}"><b class="ins">+${fmtTokens(a.changes.insertions)}</b><b class="del">−${fmtTokens(a.changes.deletions)}</b></span>` : ""}${a.denied?.length ? `<span class="ndeny" title="${esc(t("{n} tool calls refused", { n: a.denied.length }))}">⚠${a.denied.length}</span>` : ""}${a.cached ? `<span class="cached" title="${esc(t("replayed from an earlier run"))}">↺</span>` : ""}</div>` +
          `<div class="sub">${esc(subLine(a, opts.nowSec))}</div></div>`,
      );
    }
    const extra = cols[li]!.length - MAX_PER_LANE;
    if (extra > 0) {
      const offset = ((maxRows - rowsOf(cols[li]!.length)) * SLOT) / 2;
      parts.push(
        `<div class="groupcard" data-key="g-${li}" style="left:${x}px;top:${PAD_TOP + offset + MAX_PER_LANE * SLOT}px;width:${NODE_W}px">` +
          `<span><b>+${extra}</b> ${t("more agents")}</span></div>`,
      );
    }
  });

  const z = opts.zoom;
  return {
    html:
      `<div class="dag-sizer" style="width:${Math.ceil(W * z)}px;height:${Math.ceil(H * z)}px;margin:0 auto">` +
      `<div class="dag" style="width:${W}px;height:${H}px;transform:scale(${z})">${parts.join("")}</div></div>`,
    width: W,
    height: H,
  };
}
