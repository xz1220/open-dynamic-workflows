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
export const ACTIVE = new Set(["running", "paused", "pending"]);

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

/** Clamp to [0, 1]. */
export function unit(n: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
}
