/** Small formatting + DOM helpers. */
import { t } from "./i18n";

const ESC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** HTML-escape a value for safe interpolation into innerHTML. */
export function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]!);
}

/**
 * Draw odw's `«redacted:<kind>»` markers in already-escaped HTML as ink bars
 * that name what was blanked (`esc` leaves « » alone).
 */
export function markRedactions(html: string): string {
  return html.replace(/«redacted:([^«»<>]{1,60})»/g, (_m, kind: string) => `<span class="redact" title="redacted">${kind}</span>`);
}

/** Join truthy class fragments. */
export function clsx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function nowSec(): number {
  return Date.now() / 1000;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Epoch-seconds → HH:MM:SS (local). */
export function fmtClock(tsSec: number | null | undefined): string {
  if (tsSec == null) return "—";
  const d = new Date(tsSec * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** A coarse duration like "1h04m" / "4m12s" / "0m51s" / "320ms". */
export function fmtDurSec(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return "—";
  if (sec < 1) return `${Math.round(sec * 1000)}ms`;
  if (sec >= 3600) {
    const h = Math.floor(sec / 3600);
    return `${h}h${pad(Math.floor((sec % 3600) / 60))}m`;
  }
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}m${pad(s)}s`;
}

export function fmtDurMs(ms: number | null | undefined): string {
  return ms == null ? "—" : fmtDurSec(ms / 1000);
}

/** Relative "ago" string from epoch seconds. */
export function fmtAgo(tsSec: number | null | undefined): string {
  if (tsSec == null) return "—";
  const d = nowSec() - tsSec;
  if (d < 45) return t("just now");
  if (d < 3600) return t("{n}m ago", { n: Math.round(d / 60) });
  if (d < 86400) return t("{n}h ago", { n: Math.round(d / 3600) });
  return t("{n}d ago", { n: Math.round(d / 86400) });
}

/** Run wall-clock: created→updated for terminal runs, created→now otherwise. */
export function runDurationSec(
  createdAt: number | null,
  updatedAt: number | null,
  terminal: boolean,
): number | null {
  if (createdAt == null) return null;
  const end = terminal ? (updatedAt ?? createdAt) : nowSec();
  return Math.max(0, end - createdAt);
}

/** Day bucket label for the history table. */
export function fmtDayGroup(tsSec: number | null): string {
  if (tsSec == null) return t("Earlier");
  const d = new Date(tsSec * 1000);
  const today = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(today) - startOf(d)) / 86400000);
  if (diffDays <= 0) return t("Today");
  if (diffDays === 1) return t("Yesterday");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Terminal run states (mirror of run-store.TERMINAL_STATES). */
export const TERMINAL = new Set(["done", "failed", "stopped"]);

/** States that should count as live/active in the shell. */
export const ACTIVE = new Set(["running", "paused", "pending", "waiting"]);

/**
 * Subsequence match for the command palette: every query character must appear
 * in order. Scores contiguous runs and word starts higher; null = no match.
 * Returns the matched indices so the caller can underline them.
 */
export function fuzzy(query: string, text: string): { score: number; hits: number[] } | null {
  const q = query.toLowerCase();
  const s = text.toLowerCase();
  if (!q) return { score: 0, hits: [] };
  const hits: number[] = [];
  let score = 0;
  let from = 0;
  for (const ch of q) {
    const i = s.indexOf(ch, from);
    if (i < 0) return null;
    const prev = hits[hits.length - 1];
    score += prev != null && i === prev + 1 ? 3 : 1;
    if (i === 0 || /[\s:/._-]/.test(s[i - 1]!)) score += 2;
    hits.push(i);
    from = i + 1;
  }
  return { score: score - s.length * 0.01, hits };
}

/** Escape `text`, wrapping the characters at `hits` in <mark>. */
export function markHits(text: string, hits: number[]): string {
  if (!hits.length) return esc(text);
  const set = new Set(hits);
  let out = "";
  for (let i = 0; i < text.length; i++) out += set.has(i) ? `<mark>${esc(text[i])}</mark>` : esc(text[i]);
  return out;
}

/** Compact token count: 812 · 12.4k · 3.1M. */
export function fmtTokens(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * The common cron shapes in words — "02:15 on weekdays", "every 15 minutes",
 * "hourly at :05" — or null for anything else (shown as the raw expression).
 */
export function cronWords(expr: string): string | null {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [min, hour, dom, mon, dow] = f as [string, string, string, string, string];
  const num = (s: string) => /^\d+$/.test(s);
  if (dom !== "*" || mon !== "*") return null;
  const every = /^\*\/(\d+)$/.exec(min);
  if (every && hour === "*" && dow === "*") return t("every {n} minutes", { n: Number(every[1]) });
  if (num(min) && hour === "*" && dow === "*") return t("hourly at :{m}", { m: min.padStart(2, "0") });
  if (!num(min) || !num(hour)) return null;
  const at = `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
  if (dow === "*") return t("{at} daily", { at });
  if (dow === "1-5") return t("{at} on weekdays", { at });
  if (dow === "0,6" || dow === "6,0") return t("{at} on weekends", { at });
  const days = dow.split(",");
  if (days.every((d) => /^[0-7]$/.test(d))) return t("{at} on {days}", { at, days: days.map((d) => t(DOW[Number(d) % 7]!)).join(", ") });
  return null;
}

/** "19:10" — the wall-clock minute of an epoch second. */
export function fmtHourMin(tsSec: number): string {
  const d = new Date(tsSec * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** A line count: exact with separators (1,204) below 100k, then compact (240k). */
export function fmtCount(n: number): string {
  return n < 100_000 ? n.toLocaleString("en-US") : fmtTokens(n);
}

/** Dollars with sensible precision for agent-sized spend. */
export function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n < 0.01 ? `$${n.toFixed(4)}` : n < 10 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`;
}

/** Clamp to [0, 1]. */
export function unit(n: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
}
