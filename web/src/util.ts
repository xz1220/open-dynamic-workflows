/** Small formatting + DOM helpers. No deps. */

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

/** A coarse duration like "4m12s" / "0m51s" / "320ms". */
export function fmtDurSec(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return "—";
  if (sec < 1) return `${Math.round(sec * 1000)}ms`;
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
  if (d < 45) return "just now";
  if (d < 3600) return `${Math.round(d / 60)}m ago`;
  if (d < 86400) return `${Math.round(d / 3600)}h ago`;
  return `${Math.round(d / 86400)}d ago`;
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
  if (tsSec == null) return "Earlier";
  const d = new Date(tsSec * 1000);
  const today = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(today) - startOf(d)) / 86400000);
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Terminal run states (mirror of run-store.TERMINAL_STATES). */
export const TERMINAL = new Set(["done", "failed", "stopped"]);
