/**
 * What runs cost, day by day — the last fortnight as a row of columns, each
 * stacked by the workflows that spent most, today's lit. Dry runs called no
 * model and stay out. Measured in dollars when any run reported some, else in
 * tokens (Codex reports no prices).
 */
import { t } from "../i18n";
import type { RunSummary } from "../types";
import { esc, fmtTokens, fmtUsd } from "../util";

export const TREND_DAYS = 14;
const SHOWN_WORKFLOWS = 3;

export interface TrendDay {
  /** Local midnight, epoch seconds. */
  start: number;
  total: number;
  /** By workflow name; "" holds the rest. */
  parts: Map<string, number>;
  runs: number;
}

export interface Trend {
  by: "cost" | "tokens";
  days: TrendDay[];
  /** The workflows drawn on their own, biggest first. */
  top: string[];
  total: number;
  /** The fortnight before, for the change; null without runs then. */
  previous: number | null;
}

function dayStart(sec: number): number {
  const d = new Date(sec * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function tokensOf(r: RunSummary): number {
  const u = r.usage;
  return u ? (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheWriteTokens ?? 0) : 0;
}

/** The fortnight's spend, ending today; null when no run in it spent anything. */
export function spendTrend(runs: readonly RunSummary[], nowSec: number, days = TREND_DAYS): Trend | null {
  const counted = runs.filter((r) => !r.dry && r.createdAt != null && r.usage);
  const by = counted.some((r) => r.usage?.costUsd != null) ? "cost" : "tokens";
  const amount = (r: RunSummary) => (by === "cost" ? (r.usage?.costUsd ?? 0) : tokensOf(r));
  const today = dayStart(nowSec);
  const starts: number[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today * 1000);
    d.setDate(d.getDate() - i);
    starts.push(Math.floor(d.getTime() / 1000));
  }
  const first = starts[0];
  const before = new Date(first * 1000);
  before.setDate(before.getDate() - days);
  const prevStart = Math.floor(before.getTime() / 1000);

  const index = new Map(starts.map((s, i) => [s, i]));
  const out: TrendDay[] = starts.map((start) => ({ start, total: 0, parts: new Map(), runs: 0 }));
  const perWorkflow = new Map<string, number>();
  let previous = 0;
  let previousRuns = 0;
  for (const r of counted) {
    const a = amount(r);
    const created = r.createdAt!;
    if (created >= prevStart && created < first) {
      previous += a;
      previousRuns++;
      continue;
    }
    const i = index.get(dayStart(created));
    if (i === undefined) continue;
    const day = out[i];
    day.total += a;
    day.runs++;
    day.parts.set(r.name, (day.parts.get(r.name) ?? 0) + a);
    perWorkflow.set(r.name, (perWorkflow.get(r.name) ?? 0) + a);
  }
  const total = out.reduce((n, d) => n + d.total, 0);
  if (total <= 0) return null;
  const top = [...perWorkflow]
    .filter(([, n]) => n > 0)
    .sort((x, y) => y[1] - x[1])
    .slice(0, SHOWN_WORKFLOWS)
    .map(([name]) => name);
  for (const day of out) {
    let rest = 0;
    for (const [name, n] of day.parts) if (!top.includes(name)) rest += n;
    for (const name of [...day.parts.keys()]) if (!top.includes(name)) day.parts.delete(name);
    if (rest) day.parts.set("", rest);
  }
  return { by, days: out, top, total, previous: previousRuns ? previous : null };
}

/** The card for the Activity page; "" when nothing spent in the fortnight. */
export function renderTrend(runs: readonly RunSummary[], nowSec: number): string {
  const tr = spendTrend(runs, nowSec);
  if (!tr) return "";
  const fmt = (n: number) => (tr.by === "cost" ? fmtUsd(n) : fmtTokens(n));
  const max = Math.max(...tr.days.map((d) => d.total));
  const shares = [...tr.top, ""];
  const today = tr.days.length - 1;
  const cols = tr.days
    .map((d, i) => {
      const date = new Date(d.start * 1000);
      const label = `${date.getMonth() + 1}/${date.getDate()}`;
      const title = [`${label} · ${fmt(d.total)} · ${t("{n} runs", { n: d.runs })}`, ...shares.filter((w) => d.parts.get(w)).map((w) => `${w || t("others")}: ${fmt(d.parts.get(w)!)}`)].join("\n");
      const segs = shares
        .filter((w) => d.parts.get(w))
        .map((w) => `<i class="s${shares.indexOf(w)}" style="flex-grow:${(d.parts.get(w)! / (d.total || 1)).toFixed(4)}"></i>`)
        .join("");
      return (
        `<div class="tr-col${i === today ? " today" : ""}${d.total ? "" : " zero"}" style="--i:${i}" title="${esc(title)}" data-key="tr-${d.start}">` +
        `<div class="tr-bar" style="--h:${d.total ? Math.max(4, Math.round((d.total / max) * 100)) : 0}%">${segs}</div>` +
        `<span class="tr-day">${i === today ? esc(t("today")) : date.getDate()}</span></div>`
      );
    })
    .join("");
  const change =
    tr.previous && tr.previous > 0
      ? (() => {
          const pct = Math.round(((tr.total - tr.previous) / tr.previous) * 100);
          const cls = pct > 0 ? "up" : pct < 0 ? "down" : "";
          return `<span class="tr-change ${cls}" title="${esc(t("against the fortnight before: {n}", { n: fmt(tr.previous) }))}">${pct > 0 ? "↑" : pct < 0 ? "↓" : "="} ${Math.abs(pct)}%</span>`;
        })()
      : "";
  const legend = (tr.days.some((d) => d.parts.has("")) ? shares : tr.top)
    .map((w) => `<span class="tr-key"><i class="s${shares.indexOf(w)}"></i>${esc(w || t("others"))}</span>`)
    .join("");
  return (
    `<section class="card trend marked" data-key="trend">` +
    `<div class="pulse-head"><h3>${t("Spend")}</h3><span class="eyebrow">${esc(tr.by === "cost" ? t("dollars per day · last 14 days") : t("tokens per day · last 14 days"))}</span></div>` +
    `<div class="tr-body"><div class="tr-fig"><span class="v num">${fmt(tr.total)}</span>${change}<div class="tr-legend">${legend}</div></div>` +
    `<div class="tr-cols">${cols}</div></div>` +
    `</section>`
  );
}
