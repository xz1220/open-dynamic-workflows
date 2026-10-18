/**
 * Where a run's tokens and dollars went, for the terminal (ODW extension):
 * `odw status`'s "spend by phase" block — the dashboard's spend receipt
 * (web/src/views/spend.ts) in text — and the cost `odw list` shows per run.
 *
 * A line per phase, in the order the workflow declared them (those not started
 * yet with no agents), then the agents outside every phase: how many agents,
 * their tokens and dollars, and their share as a bar of Unicode blocks. As on
 * the receipt, the shares measure dollars when every agent that spent reported
 * them (Claude Code does), else tokens: Codex reports no prices, and a text
 * adapter only an estimate. Usage lands when an agent settles, so a running
 * agent adds its share when it finishes.
 *
 * Pure: the terminal's capabilities come in (see ../tty.ts), so the block is
 * plain text under NO_COLOR or in a pipe, and ASCII where Unicode is not.
 */

import { displayWidth, fmtTokens, fmtUsd, padEndWidth, palette, sanitizeText, truncateToWidth, type TermCaps } from "../tty.js";
import type { AgentView, RunDetail } from "./runs-view.js";

/** One phase's line; `key` "" holds the agents outside every phase. */
export interface PhaseSpend {
  key: string;
  agents: number;
  running: number;
  tokens: number;
  /** Dollars, when at least one of its agents reported some. */
  costUsd: number | null;
  estimated: boolean;
}

export interface SpendByPhase {
  /** The declared phases in order — those not started yet with no agents — then the agents outside every phase. */
  phases: PhaseSpend[];
  tokens: number;
  costUsd: number | null;
  estimated: boolean;
  running: number;
  /** What the shares measure. */
  by: "cost" | "tokens";
}

/** The widest a line of the block gets, in columns. */
export const SPEND_WIDTH = 100;

/** Cells of a full share bar. */
const BAR_CELLS = 20;

/** The widest a phase's name is shown. */
const NAME_WIDTH = 24;

const isAgent = (a: AgentView): boolean => (a.kind ?? "agent") === "agent";
const tokensOf = (a: AgentView): number => (a.usage?.inputTokens ?? 0) + (a.usage?.outputTokens ?? 0);

/** An agent() call that reported what it spent (commands spend nothing). */
function reported(a: AgentView): boolean {
  const u = a.usage;
  return isAgent(a) && !!u && (u.inputTokens !== undefined || u.outputTokens !== undefined || u.costUsd !== undefined);
}

const line = (key: string): PhaseSpend => ({ key, agents: 0, running: 0, tokens: 0, costUsd: null, estimated: false });

function add(l: PhaseSpend, a: AgentView): void {
  l.agents += 1;
  if (a.state === "running") l.running += 1;
  if (!reported(a)) return;
  l.tokens += tokensOf(a);
  if (a.usage!.costUsd !== undefined) l.costUsd = (l.costUsd ?? 0) + a.usage!.costUsd;
  if (a.usage!.estimated) l.estimated = true;
}

/** A run's spend by phase; null until one of its agents reported some. */
export function spendByPhase(run: Pick<RunDetail, "agents" | "phaseOrder" | "phases">): SpendByPhase | null {
  const agents = run.agents.filter(isAgent);
  const paying = agents.filter(reported);
  if (paying.length === 0) return null;
  const phases = new Map<string, PhaseSpend>();
  for (const p of run.phaseOrder.length ? run.phaseOrder : run.phases.map((ph) => ph.title)) phases.set(p, line(p));
  const total = line("");
  for (const a of agents) {
    const p = a.phase ?? "";
    if (!phases.has(p)) phases.set(p, line(p));
    add(phases.get(p)!, a);
    add(total, a);
  }
  // Agents outside every phase close the list, whatever order they came in.
  const outside = phases.get("");
  phases.delete("");
  return {
    phases: [...phases.values(), ...(outside ? [outside] : [])],
    tokens: total.tokens,
    costUsd: total.costUsd,
    estimated: total.estimated,
    running: total.running,
    by: paying.every((a) => a.usage!.costUsd !== undefined) ? "cost" : "tokens",
  };
}

const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

/** A share in [0,1] as a bar `cells` wide: Unicode blocks to the eighth (`#` without Unicode); a share above 0 shows. */
export function shareBar(share: number, cells: number, unicode: boolean): string {
  const s = Math.min(Math.max(Number.isFinite(share) ? share : 0, 0), 1);
  if (!unicode) return "#".repeat(s > 0 ? Math.max(1, Math.round(s * cells)) : 0);
  const eighths = s > 0 ? Math.max(1, Math.round(s * cells * 8)) : 0;
  return "█".repeat(Math.floor(eighths / 8)) + EIGHTHS[eighths % 8]!;
}

const pct = (s: number): string => (s > 0 && s < 0.01 ? "<1%" : `${Math.round(s * 100)}%`);

/**
 * The "spend by phase" block of `odw status`: a header, a line per phase,
 * and notes; none until an agent reported what it spent. Every line fits
 * `width` columns.
 */
export function spendLines(run: Pick<RunDetail, "agents" | "phaseOrder" | "phases">, caps: TermCaps, width = SPEND_WIDTH): string[] {
  const sp = spendByPhase(run);
  if (!sp) return [];
  const p = palette(caps);
  const metric = (l: { tokens: number; costUsd: number | null }): number => (sp.by === "cost" ? (l.costUsd ?? 0) : l.tokens);
  const whole = metric(sp);
  const share = (l: PhaseSpend): number => (whole > 0 ? metric(l) / whole : 0);
  const hasCost = sp.costUsd !== null;
  const none = caps.unicode ? "—" : "-";
  const rows = sp.phases.map((l, i) => ({
    l,
    ix: l.key ? String(i + 1).padStart(2, "0") : caps.unicode ? "··" : "--",
    name: l.key ? sanitizeText(l.key, NAME_WIDTH) : "outside phases",
    agents: l.agents ? `${l.agents} agent${l.agents === 1 ? "" : "s"}` : "not started",
    tokens: l.agents ? `${fmtTokens(l.tokens)}${l.estimated ? "~" : ""}` : none,
    cost: l.costUsd !== null ? fmtUsd(l.costUsd) : none,
    pct: l.agents ? pct(share(l)) : "",
  }));
  const w = (pick: (r: (typeof rows)[number]) => string): number => Math.max(...rows.map((r) => [...pick(r)].length));
  const nameW = Math.min(NAME_WIDTH, Math.max(...rows.map((r) => displayWidth(r.name))));
  const [agentsW, tokensW, costW, pctW] = [w((r) => r.agents), w((r) => r.tokens), w((r) => r.cost), w((r) => r.pct)];
  const lines = [`  spend by phase (share of ${sp.by === "cost" ? "cost" : "tokens"}):`];
  for (const r of rows) {
    const cells = [
      `    ${r.ix}`,
      padEndWidth(truncateToWidth(r.name, nameW), nameW),
      r.agents.padEnd(agentsW),
      r.tokens.padStart(tokensW),
      ...(hasCost ? [r.cost.padStart(costW)] : []),
      r.pct.padStart(pctW),
    ].join("  ");
    const bar = r.l.agents ? shareBar(share(r.l), BAR_CELLS, caps.unicode) : "";
    const text = `${cells}${bar ? `  ${(r.l.running ? p.run : p.accent)(bar)}` : ""}`;
    lines.push(r.l.agents ? text : p.dim(text.trimEnd()));
  }
  const notes = [
    sp.running ? "running agents add theirs when they finish" : "",
    sp.by === "tokens" && hasCost ? "not every agent reported dollars, so shares are of tokens" : "",
    sp.estimated ? "~ partly estimated: a CLI that reports no count is measured as characters / 4" : "",
  ].filter(Boolean);
  for (const note of notes) lines.push(p.dim(`    ${note}`));
  return lines.map((l) => truncateToWidth(l, width));
}
