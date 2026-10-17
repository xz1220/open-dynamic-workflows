/**
 * The pulse — a ridgeline of recent event density, one line per run.
 *
 * An homage to the stacked-pulsar plot: every run is a horizontal trace whose
 * height at time t is how much that run was doing then (smoothed event
 * counts). Rows are painted back to front and each fills with the card colour,
 * so a busy run rises in front of the quieter ones behind it. Running traces
 * are drawn in signal green; failed ones in vermilion; a dashed "now" rule
 * sits at the right edge. Pure function of (runs, events, now) → SVG string.
 */
import { t } from "../i18n";
import type { ActivityEvent, RunSummary } from "../types";
import { ACTIVE, esc } from "../util";

const W = 1000;
const LEFT = 168;
const RIGHT = 26;
const TOP = 58;
const ROW = 30;
const AMP = 56;
const BINS = 84;

const SPANS = [2, 5, 10, 15, 30, 60, 180, 360, 720, 1440].map((m) => m * 60);

function spanLabel(sec: number): string {
  if (sec >= 3600) return `${+(sec / 3600).toFixed(2)}h`;
  if (sec < 60 || sec % 60) return `${Math.round(sec)}s`;
  return `${sec / 60}m`;
}

/** Deterministic per-run texture so idle traces hum instead of lying dead flat. */
function texture(seed: string, i: number): number {
  let h = 2166136261;
  for (let k = 0; k < seed.length; k++) h = Math.imul(h ^ seed.charCodeAt(k), 16777619);
  h = Math.imul(h ^ (i * 374761393), 668265263);
  return ((h >>> 0) % 1000) / 1000;
}

/** Catmull-Rom through the points, as cubic Béziers. */
function spline(pts: Array<[number, number]>): string {
  if (pts.length < 2) return "";
  let d = `M${pts[0]![0].toFixed(1)} ${pts[0]![1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}

export interface PulseModel {
  svg: string;
  span: string;
  rows: number;
}

export function renderPulse(runs: RunSummary[], events: ActivityEvent[], nowSec: number): PulseModel {
  // Active runs first, then the most recently touched — at most nine traces.
  const touched = (r: RunSummary) => r.lastActivityTs ?? r.updatedAt ?? r.createdAt ?? 0;
  const ordered = [...runs].sort(
    (a, b) => Number(ACTIVE.has(b.state)) - Number(ACTIVE.has(a.state)) || touched(b) - touched(a),
  );
  if (ordered.length === 0) return { svg: "", span: "", rows: 0 };
  // The window frames what is happening now: while runs are live it spans
  // just their lifetimes (so their peaks get the width), otherwise it widens
  // until the most recent runs' history fits.
  const live = ordered.filter((r) => ACTIVE.has(r.state));
  const framing = live.length ? live : ordered.slice(0, 4);
  const oldest = Math.min(...framing.map((r) => r.createdAt ?? touched(r)));
  const need = Math.max(0, nowSec - oldest) * 1.08;
  const span = SPANS.find((s) => s >= need) ?? SPANS[SPANS.length - 1]!;
  const inWindow = ordered.filter((r) => ACTIVE.has(r.state) || touched(r) >= nowSec - span);
  const picked = (inWindow.length >= 4 ? inWindow : ordered.slice(0, Math.max(4, inWindow.length))).slice(0, 9);
  const t0 = nowSec - span;
  const binW = span / BINS;
  const x = (i: number) => LEFT + (i / (BINS - 1)) * (W - LEFT - RIGHT);

  // Smoothed density per run.
  const byRun = new Map<string, number[]>();
  for (const r of picked) byRun.set(r.runId, new Array(BINS).fill(0));
  for (const e of events) {
    const bins = byRun.get(e.runId);
    if (!bins || e.ts < t0) continue;
    const i = Math.min(BINS - 1, Math.floor((e.ts - t0) / binW));
    bins[i]! += e.type === "agent_started" || e.type === "agent_finished" || e.type === "agent_failed" ? 1.6 : 1;
  }
  const kernel = [0.06, 0.12, 0.2, 0.24, 0.2, 0.12, 0.06];
  let peak = 0;
  const smooth = new Map<string, number[]>();
  for (const [id, bins] of byRun) {
    const out = bins.map((_, i) =>
      kernel.reduce((s, k, j) => s + k * (bins[i + j - 3] ?? 0), 0),
    );
    peak = Math.max(peak, ...out);
    smooth.set(id, out);
  }
  peak = Math.max(peak, 0.8);

  const H = TOP + picked.length * ROW + 34;
  const rows: string[] = [];
  picked.forEach((r, ri) => {
    const base = TOP + ri * ROW;
    const dens = smooth.get(r.runId)!;
    const live = ACTIVE.has(r.state);
    const pts: Array<[number, number]> = dens.map((v, i) => {
      const hum = (texture(r.runId, i) - 0.5) * (live ? 2.2 : 1.1);
      // Taper both ends so traces settle onto their baseline like the original plot.
      const edge = Math.min(1, i / 6, (BINS - 1 - i) / 3);
      const h = Math.sqrt(v / peak) * AMP * edge;
      return [x(i), base - h + hum * edge];
    });
    const curve = spline(pts);
    const fill = `${curve} L${x(BINS - 1).toFixed(1)} ${base + 6} L${x(0).toFixed(1)} ${base + 6} Z`;
    const cls = r.state === "pending" ? "running" : r.state;
    const name = r.name.length > 20 ? `${r.name.slice(0, 19)}…` : r.name;
    rows.push(
      `<g class="pulsar-row" data-key="pr-${esc(r.runId)}" data-run="${esc(r.runId)}">` +
        `<path class="ridge-fill" d="${fill}" fill="var(--card)" stroke="none"/>` +
        `<path class="ridge ${esc(cls)}" d="${curve}" fill="none"/>` +
        `<text class="lab ${esc(cls)}" x="${LEFT - 18}" y="${base + 3}" text-anchor="end">${esc(name)}</text>` +
        `</g>`,
    );
  });

  const ticks: string[] = [];
  for (let k = 0; k <= 4; k++) {
    const xi = LEFT + (k / 4) * (W - LEFT - RIGHT);
    const ago = span - (k / 4) * span;
    const label = k === 4 ? t("now") : `−${spanLabel(ago)}`;
    ticks.push(`<text class="axis" x="${xi.toFixed(1)}" y="${H - 8}" text-anchor="middle">${label}</text>`);
  }
  const anyLive = picked.some((r) => ACTIVE.has(r.state));
  const nowX = W - RIGHT;
  const scan = anyLive
    ? `<g clip-path="url(#plot)"><rect class="scan" x="${LEFT}" y="${TOP - AMP}" width="90" height="${picked.length * ROW + AMP}">` +
      `<animate attributeName="x" from="${LEFT - 90}" to="${nowX}" dur="6s" repeatCount="indefinite"/></rect></g>`
    : "";
  const svg =
    `<svg class="pulsar" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t("Event density per run"))}">` +
    `<defs><linearGradient id="scan" x1="0" x2="1"><stop offset="0" stop-color="var(--sig)" stop-opacity="0"/>` +
    `<stop offset=".8" stop-color="var(--sig)" stop-opacity=".08"/><stop offset="1" stop-color="var(--sig)" stop-opacity="0"/></linearGradient>` +
    `<clipPath id="plot"><rect x="${LEFT}" y="0" width="${nowX - LEFT}" height="${H}"/></clipPath></defs>` +
    rows.join("") +
    scan +
    `<line class="now" x1="${nowX}" x2="${nowX}" y1="${TOP - AMP + 6}" y2="${H - 26}"/>` +
    ticks.join("") +
    `</svg>`;
  return { svg, span: spanLabel(span), rows: picked.length };
}
