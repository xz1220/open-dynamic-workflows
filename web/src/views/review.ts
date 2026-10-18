/**
 * Review (ODW extension) — every kept diff across runs that nobody dealt with
 * yet, riskiest first. An entry is a slip of paper: its score as a stack of
 * marks tinted from signal to alarm, the run and agent, the size of the
 * change, and under it each reason it ranks where it does ("+3 touches CI").
 * Nothing is scored by a model: the points come from what the run recorded.
 * Reviewed, dismissed or applied entries leave the queue (they show under
 * "All", with who marked them and how).
 */
import { icons } from "../icons";
import { t, tn } from "../i18n";
import { store } from "../store";
import type { ReviewEntry, ReviewFactor } from "../types";
import { esc, fmtAgo } from "../util";
import { emptyArt } from "./activity";

/** The marks of a score: one per point, at most 10, tinted by its level. */
function meter(e: ReviewEntry): string {
  const n = Math.min(10, e.score);
  const marks = Array.from({ length: 10 }, (_, i) => `<i class="${i < n ? "on" : ""}"></i>`).join("");
  return (
    `<div class="rq-meter ${e.risk}" aria-label="${esc(t("risk {n}", { n: e.score }))}">` +
    `<span class="rq-score num">${e.score}</span><span class="rq-level">${esc(t(e.risk))}</span>` +
    `<span class="rq-marks">${marks}</span></div>`
  );
}

function factor(f: ReviewFactor): string {
  const sign = f.points > 0 ? `+${f.points}` : String(f.points);
  return `<li class="${f.points < 0 ? "for" : ""}"><span class="pt num">${esc(sign)}</span><span class="why">${esc(f.why)}</span></li>`;
}

const MARKED: Record<string, string> = { reviewed: "reviewed", dismissed: "dismissed", applied: "applied" };

function entry(e: ReviewEntry, i: number, writable: boolean): string {
  const c = e.changes;
  const hash = `#/job/${encodeURIComponent(e.runId)}/changes`;
  const done = e.review && e.review.state !== "open" ? e.review : null;
  const marked = done
    ? `<span class="rq-mark ${esc(done.state)}">${esc(t(MARKED[done.state] ?? done.state))}${done.by ? ` · ${esc(done.by)}` : ""} · ${esc(fmtAgo(done.ts))}</span>`
    : "";
  const key = `${e.runId}/${e.agentId}`;
  const actions =
    (writable
      ? done
        ? `<button class="btn sm ghost" data-review-mark="${esc(key)}" data-state="open">${t("Back on the queue")}</button>`
        : `<button class="btn sm" data-review-mark="${esc(key)}" data-state="reviewed">${icons.result}${t("Mark reviewed")}</button>` +
          `<button class="btn sm ghost" data-review-mark="${esc(key)}" data-state="dismissed">${t("Dismiss")}</button>`
      : "") +
    `<button class="btn sm ghost" data-copy="odw apply ${esc(e.runId)} --agent ${e.agentId} --check" data-tip="${esc(t("copies a command that previews applying it"))}">${icons.terminal}${t("Copy apply")}</button>`;
  const cats = e.categories.map((k) => `<span class="tag">${esc(t(k))}</span>`).join("");
  return (
    `<article class="card rq-item ${e.risk}${done ? " dealt" : ""}" data-key="rq-${esc(key)}" style="--i:${Math.min(i, 12)}">` +
    meter(e) +
    `<div class="rq-body">` +
    `<div class="rq-head"><a class="rq-open" href="${hash}" data-review-open="${esc(key)}"><b>${esc(e.label)}</b><span class="dim"> · ${esc(e.run)}</span></a>${marked}</div>` +
    `<div class="rq-meta"><span class="mono">${esc(e.runId)} · ${t("agent {n}", { n: e.agentId })}</span>` +
    `<span class="rq-stat"><span class="add">+${c.insertions}</span> <span class="del">−${c.deletions}</span> · ${tn(c.files, "{n} file", "{n} files")}</span>` +
    (e.agentState === "failed" ? `<span class="tag warn">${t("failed")}</span>` : "") +
    cats +
    `<span class="dim">${esc(fmtAgo(e.finishedAt ?? e.createdAt))}</span></div>` +
    (e.factors.length
      ? `<ul class="rq-why" aria-label="${esc(t("why it ranks here"))}">${e.factors.map(factor).join("")}</ul>`
      : `<p class="rq-quiet dim">${t("Small, and nothing on record against it.")}</p>`) +
    `<div class="rq-actions">${actions}</div>` +
    `</div></article>`
  );
}

export function renderReview(): string {
  const q = store.review;
  if (!q) return `<div class="page review-page"><div class="empty"><div class="spinner"></div><p>${t("Loading the review queue…")}</p></div></div>`;
  const all = store.reviewAll;
  const head =
    `<header class="page-head"><div><div class="eyebrow">${t("Review")}</div>` +
    `<h1 class="display">${q.open ? t("What to look at <em>first</em>.") : t("Nothing <em>waits</em> for review.")}</h1>` +
    `<p class="lede">${t("Kept diffs across runs, riskiest first. The score adds up what the run recorded — size, paths, checks, scope — and each point says why.")}</p></div>` +
    `<div class="rq-tabs" role="tablist">` +
    `<button class="${all ? "" : "on"}" role="tab" aria-selected="${!all}" data-review-all="0">${t("To review")}<span class="num">${q.open}</span></button>` +
    `<button class="${all ? "on" : ""}" role="tab" aria-selected="${all}" data-review-all="1">${t("All")}<span class="num">${q.open + q.marked}</span></button>` +
    `</div></header>`;
  if (!q.entries.length) {
    return (
      `<div class="page review-page">${head}` +
      emptyArt(t("Nothing to review"), esc(t("Agents that run with isolation: \"worktree\" keep a diff of what they changed; each one shows here until it is reviewed, dismissed or applied."))) +
      `</div>`
    );
  }
  const writable = store.capabilities.writable;
  return `<div class="page review-page">${head}<div class="rq-list">${q.entries.map((e, i) => entry(e, i, writable)).join("")}</div></div>`;
}
