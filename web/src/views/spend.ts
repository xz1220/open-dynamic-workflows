/**
 * Where a run's tokens and dollars went — the receipt that unfolds under the
 * run's header: a line per phase (in the order the workflow declared them),
 * the split by adapter, and the agents that spent most.
 *
 * Usage lands when an agent settles, so a running agent adds its share when it
 * finishes. The shares measure dollars when every agent that spent reported
 * them (Claude Code does), else tokens: Codex reports no prices, and a text
 * adapter only an estimate.
 */
import { glyph } from "../components/glyph";
import { icons } from "../icons";
import { t, tn } from "../i18n";
import type { AgentView, RunDetail } from "../types";
import { esc, fmtTokens, fmtUsd, unit } from "../util";

export interface SpendLine {
  /** The phase title or adapter name; "" holds the agents outside any phase (or with no adapter). */
  key: string;
  agents: number;
  running: number;
  tokens: number;
  /** Dollars, when at least one of its agents reported some. */
  costUsd: number | null;
  estimated: boolean;
}

export interface Spend {
  /** The declared phases in order — those not started yet with no agents — then any others. */
  phases: SpendLine[];
  /** Biggest first. */
  adapters: SpendLine[];
  /** The agents that spent most, biggest first. */
  top: Array<{ ai: number; a: AgentView; tokens: number; costUsd: number | null }>;
  tokens: number;
  costUsd: number | null;
  estimated: boolean;
  running: number;
  /** What the shares measure. */
  by: "cost" | "tokens";
}

const TOP = 5;

const isAgent = (a: AgentView): boolean => (a.kind ?? "agent") === "agent";
const tokensOf = (a: AgentView): number => (a.usage?.inputTokens ?? 0) + (a.usage?.outputTokens ?? 0);

/** An agent() call that reported what it spent (commands and checkpoints spend nothing). */
function reported(a: AgentView): boolean {
  const u = a.usage;
  return isAgent(a) && !!u && (u.inputTokens != null || u.outputTokens != null || u.costUsd != null);
}

const line = (key: string): SpendLine => ({ key, agents: 0, running: 0, tokens: 0, costUsd: null, estimated: false });

function add(l: SpendLine, a: AgentView): void {
  l.agents += 1;
  if (a.state === "running") l.running += 1;
  if (!reported(a)) return;
  l.tokens += tokensOf(a);
  if (a.usage!.costUsd != null) l.costUsd = (l.costUsd ?? 0) + a.usage!.costUsd;
  if (a.usage!.estimated) l.estimated = true;
}

/** The run's spend by phase, adapter and agent; null until an agent reports some. */
export function spendOf(run: RunDetail): Spend | null {
  const agents = run.agents.map((a, ai) => ({ a, ai })).filter(({ a }) => isAgent(a));
  const paying = agents.filter(({ a }) => reported(a));
  if (!paying.length) return null;
  const by = paying.every(({ a }) => a.usage!.costUsd != null) ? "cost" : "tokens";
  const metric = (l: { tokens: number; costUsd: number | null }): number => (by === "cost" ? (l.costUsd ?? 0) : l.tokens);

  const phases = new Map<string, SpendLine>();
  for (const p of run.phaseOrder.length ? run.phaseOrder : run.phases.map((ph) => ph.title)) phases.set(p, line(p));
  const adapters = new Map<string, SpendLine>();
  const total = line("");
  for (const { a } of agents) {
    const p = a.phase ?? "";
    if (!phases.has(p)) phases.set(p, line(p));
    add(phases.get(p)!, a);
    const ad = a.adapter ?? "";
    if (!adapters.has(ad)) adapters.set(ad, line(ad));
    add(adapters.get(ad)!, a);
    add(total, a);
  }
  // Agents outside every phase close the list, whatever order they came in.
  const outside = phases.get("");
  phases.delete("");
  const top = paying
    .map(({ a, ai }) => ({ ai, a, tokens: tokensOf(a), costUsd: a.usage!.costUsd ?? null }))
    .filter((x) => metric(x) > 0)
    .sort((x, y) => metric(y) - metric(x))
    .slice(0, TOP);
  return {
    phases: [...phases.values(), ...(outside ? [outside] : [])],
    adapters: [...adapters.values()].sort((x, y) => metric(y) - metric(x)),
    top,
    tokens: total.tokens,
    costUsd: total.costUsd,
    estimated: total.estimated,
    running: total.running,
    by,
  };
}

/** Adapter swatches: Claude in its provenance clay, the rest in inks. */
const SWATCH = ["var(--ink)", "var(--mute)", "var(--line-2)", "var(--faint)"];
function swatch(adapter: string, i: number): string {
  return adapter === "claude" ? "var(--clay)" : SWATCH[i % SWATCH.length]!;
}

/** The receipt itself, while `open` and once the run has spent something. */
export function spendReceipt(run: RunDetail, open: boolean): string {
  if (!open) return "";
  const sp = spendOf(run);
  if (!sp) return "";
  const metric = (l: { tokens: number; costUsd: number | null }): number => (sp.by === "cost" ? (l.costUsd ?? 0) : l.tokens);
  const whole = metric(sp);
  const share = (l: { tokens: number; costUsd: number | null }): number => (whole > 0 ? unit(metric(l) / whole) : 0);
  const pct = (s: number): string => (s > 0 && s < 0.01 ? "<1%" : `${Math.round(s * 100)}%`);
  const hasCost = sp.costUsd != null;
  const tilde = (est: boolean): string => (est ? `<span class="est" title="${esc(t("partly estimated"))}">~</span>` : "");

  const lines = sp.phases
    .map((l, i) => {
      const s = share(l);
      return (
        `<li class="rc-line${l.agents ? "" : " idle"}${l.running ? " live" : ""}" data-key="rc-${esc(l.key)}" style="--i:${i};--share:${s.toFixed(4)}">` +
        `<span class="ix">${l.key ? String(i + 1).padStart(2, "0") : "··"}</span>` +
        `<span class="nm"><span class="t">${l.key ? esc(l.key) : t("outside phases")}</span>${l.running ? glyph("running") : ""}<i class="lead"></i></span>` +
        `<span class="n">${l.agents ? tn(l.agents, "{n} agent", "{n} agents") : t("not started")}</span>` +
        `<span class="tk num">${l.agents ? `${fmtTokens(l.tokens)}${tilde(l.estimated)}` : "—"}</span>` +
        (hasCost ? `<span class="usd num${l.costUsd == null ? " nil" : ""}">${l.costUsd != null ? fmtUsd(l.costUsd) : "—"}</span>` : "") +
        `<span class="pc num">${l.agents ? pct(s) : ""}</span>` +
        `<span class="bar"><i></i></span>` +
        `</li>`
      );
    })
    .join("");

  const split =
    sp.adapters.length > 1
      ? `<div class="rc-sec">${t("by adapter")}</div>` +
        `<div class="rc-split" role="img" aria-label="${esc(sp.adapters.map((l) => `${l.key || "—"} ${pct(share(l))}`).join(", "))}">` +
        sp.adapters.map((l, i) => `<i style="--w:${(share(l) * 100).toFixed(2)}%;--c:${swatch(l.key, i)}" data-key="rs-${esc(l.key)}"></i>`).join("") +
        `</div><div class="rc-legend">` +
        sp.adapters
          .map(
            (l, i) =>
              `<span><i style="--c:${swatch(l.key, i)}"></i>${esc(l.key || "—")} <b class="num">${pct(share(l))}</b>` +
              `<span class="dim">${sp.by === "cost" ? fmtUsd(l.costUsd) : fmtTokens(l.tokens)}</span></span>`,
          )
          .join("") +
        `</div>`
      : "";

  const best = sp.top[0] ? metric(sp.top[0]) : 0;
  const top = sp.top.length
    ? `<div class="rc-sec">${t("Top spenders")}</div><div class="rc-top">` +
      sp.top
        .map(
          (x, i) =>
            `<button class="rc-agent" data-spend-ai="${x.ai}" data-key="rt-${x.ai}" style="--i:${i};--share:${(best > 0 ? metric(x) / best : 0).toFixed(4)}">` +
            `${glyph(x.a.state)}<span class="lbl">${esc(x.a.label)}</span>` +
            `<span class="sub">${esc([x.a.phase, x.a.adapter].filter(Boolean).join(" · "))}</span>` +
            `<span class="amt num">${sp.by === "cost" ? fmtUsd(x.costUsd) : fmtTokens(x.tokens)}</span>` +
            `<span class="bar"><i></i></span></button>`,
        )
        .join("") +
      `</div>`
    : "";

  const notes = [
    sp.running ? t("Running agents add theirs when they finish.") : "",
    sp.by === "tokens" && hasCost ? t("Not every agent reported dollars, so shares are of tokens.") : "",
    sp.estimated ? t("~ partly estimated: a CLI that reports no count is measured as characters ÷ 4.") : "",
  ].filter(Boolean);

  return (
    `<section class="receipt" data-key="receipt" aria-label="${esc(t("Spend"))}">` +
    `<header class="rc-head">` +
    `<div class="rc-title"><span class="eyebrow">${icons.receipt}${t("Spend")}</span><h3>${t("Where this run spent")}</h3></div>` +
    `<div class="rc-total">` +
    (hasCost ? `<div class="rs"><span class="v num">${fmtUsd(sp.costUsd)}</span><span class="k">${t("cost")}</span></div>` : "") +
    `<div class="rs"><span class="v num">${fmtTokens(sp.tokens)}${sp.estimated ? "~" : ""}</span><span class="k">${t("tokens")}</span></div>` +
    `</div>` +
    `<button class="iconbtn" data-spend aria-label="${esc(t("Close"))}">${icons.close}</button>` +
    `</header>` +
    `<div class="rc-body${top ? " two" : ""}"><div class="rc-col">` +
    `<div class="rc-sec">${t("by phase")}<span class="dim">${sp.by === "cost" ? t("share of cost") : t("share of tokens")}</span></div>` +
    `<ol class="rc-lines${hasCost ? " with-usd" : ""}">${lines}</ol>` +
    split +
    `</div>${top ? `<div class="rc-col">${top}</div>` : ""}</div>` +
    (notes.length ? `<p class="rc-note">${notes.map((n) => esc(n)).join("<br/>")}</p>` : "") +
    `</section>`
  );
}
