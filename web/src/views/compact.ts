/**
 * Compact layout (U5; an ODW extension): the dashboard for a narrow IDE panel —
 * VS Code's Simple Browser, JetBrains' built-in browser — with no rail. `#/compact`
 * (or `?compact=1` on the page URL, or `?compact` after any route's hash) turns it
 * on; it stays on while you navigate, until a hash says `?compact=0`. Its home is a run list
 * with each run's live status; a run opens in the Job view, under a slim bar back.
 */
import { pill } from "../components/glyph";
import { t } from "../i18n";
import type { RunSummary } from "../types";
import { ACTIVE, esc, fmtAgo } from "../util";
import type { Route } from "../shell";

/** Recent ended runs the compact list shows under the live ones. */
const RECENT_SHOWN = 30;

/**
 * What the URL says about the compact layout: true (on), false (`compact=0`),
 * or null when it says nothing (keep what it was).
 */
export function compactFlag(search: string, hash: string): boolean | null {
  const [path = "", query = ""] = hash.replace(/^#\/?/, "").split("?");
  const fromHash = new URLSearchParams(query);
  const fromSearch = new URLSearchParams(search.replace(/^\?/, ""));
  const value = fromHash.has("compact") ? fromHash.get("compact") : fromSearch.has("compact") ? fromSearch.get("compact") : null;
  if (value !== null) return value !== "0" && value !== "false";
  return path.split("/")[0] === "compact" ? true : null;
}

function counts(r: RunSummary): string {
  const c = r.counts;
  const parts = [
    c.running ? t("{n} running", { n: c.running }) : "",
    c.done ? t("{n} done", { n: c.done }) : "",
    c.failed ? t("{n} failed", { n: c.failed }) : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

function row(r: RunSummary): string {
  const total = Math.max(1, r.counts.agents);
  const w = (n: number) => `${((n / total) * 100).toFixed(2)}%`;
  const cc = r.provider === "claude" ? `<span class="tag cc" title="${esc(t("Claude Code workflow — observed read-only"))}">CC</span>` : "";
  const meta = [counts(r), fmtAgo(r.lastActivityTs ?? r.updatedAt ?? r.createdAt)].filter(Boolean).join(" · ");
  return (
    `<a class="crow s-${esc(r.state)}" href="#/job/${encodeURIComponent(r.runId)}" data-run="${esc(r.runId)}" data-key="cr-${esc(r.runId)}">` +
    `<span class="crow-top">${pill(r.state)}<span class="nm">${esc(r.name)}</span>${cc}</span>` +
    `<span class="crow-meta mono faint">${esc(meta)}</span>` +
    `<span class="prog thin"><i class="p-done" style="width:${w(r.counts.done)}"></i><i class="p-run" style="width:${w(r.counts.running)}"></i>` +
    `<i class="p-fail" style="width:${w(r.counts.failed)}"></i><i class="p-stale" style="width:${w(r.counts.stale)}"></i></span>` +
    `</a>`
  );
}

/** The compact home: live runs first, then the most recent ended ones. */
export function renderCompactRuns(runs: RunSummary[]): string {
  const newest = (a: RunSummary, b: RunSummary) => (b.createdAt ?? 0) - (a.createdAt ?? 0);
  const live = runs.filter((r) => ACTIVE.has(r.state)).sort(newest);
  const recent = runs.filter((r) => !ACTIVE.has(r.state)).sort(newest).slice(0, RECENT_SHOWN);
  if (!live.length && !recent.length) return `<div class="compact-list"><p class="compact-empty faint">${t("No runs yet")}</p></div>`;
  const section = (label: string, list: RunSummary[]) =>
    list.length ? `<div class="compact-label"><span>${esc(label)}</span><span class="num">${list.length}</span></div>${list.map(row).join("")}` : "";
  return `<div class="compact-list">${section(t("Live now"), live)}${section(t("Recent"), recent)}</div>`;
}

/** The slim bar over a compact page: back to the run list from a run, the live chip, the way out. */
export function compactBar(route: Route, conn: string): string {
  const onList = route.view !== "job";
  const back = onList ? `<span class="here">${t("Runs")}</span>` : `<a class="compact-back" href="#/compact" data-nav="#/compact">← ${t("Runs")}</a>`;
  const label = conn === "live" ? t("Live") : conn === "reconnecting" ? t("Reconnecting…") : t("Connecting…");
  return (
    `<header class="compact-bar">${back}<span class="grow"></span>` +
    `<span class="conn ${esc(conn)}"><span class="d"></span>${esc(label)}</span>` +
    `<a class="compact-full faint" href="#/${onList ? "jobs" : `job/${encodeURIComponent(route.param ?? "")}`}?compact=0">${t("Full dashboard")}</a>` +
    `</header>`
  );
}
