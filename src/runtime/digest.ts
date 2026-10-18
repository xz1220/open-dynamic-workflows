/**
 * The cross-run digest (an ODW extension): what happened over a window of
 * runs — overnight, or since the last digest went out — in one report, so a
 * morning starts with one message instead of ten.
 *
 * Built only from what the runs recorded: their status, their folded events
 * (an agent's `expect` misses, `outOfScope` files, failure reasons, kept
 * diffstats, usage) and their pending checkpoints. Nothing a model wrote about
 * its own work is repeated — no reply, no result, no summary — so "the agent
 * says it is done" never stands in for evidence. Groups:
 *
 *   needsYou   checkpoints (and agents' questions) waiting now, whatever the
 *              window: with the commands that answer them
 *   failed     failed runs, and runs whose worker died (stale): the recorded
 *              error, the failure reasons of their agents, and `odw resume`
 *   unmet      done runs some of whose agents missed their `expect` checks,
 *              wrote outside their scope, or failed under a run that went on
 *   changes    done runs whose isolated agents kept a diff: its diffstat and
 *              the `odw apply --check` that previews it
 *   spend      dollars and tokens over the window's runs, and the most
 *              expensive one
 *
 * A run is in the window when its last write (status.updatedAt) is at or
 * after `since`. Dry runs (`odw run --dry`) are left out: no model ran.
 */

import { localMinute } from "../schedule/store.js";
import { fmtTokens, fmtUsd, palette, sanitizeText, type TermCaps } from "../tty.js";
import { checkpointCommands, shellArg } from "./live-view.js";
import { formatDuration } from "./notify.js";
import { TERMINAL_STATES, type RunStore } from "./run-store.js";
import { detail, type AgentView, type RunDetail } from "./runs-view.js";

/** A checkpoint waiting for a person. */
export interface DigestWaiting {
  runId: string;
  workflow: string;
  checkpointId: number;
  title: string;
  /** "question": an agent asked it (answer with --note); else the script's checkpoint(). */
  kind: "checkpoint" | "question";
  /** The agent that asked, for a question. */
  asker?: string;
  /** When it started waiting, Unix seconds. */
  since: number;
  approve: string;
  reject: string;
  /** Signed one-time links, minted only for `--notify` while an `odw serve --public-url` runs. */
  approveUrl?: string;
  rejectUrl?: string;
}

/** A failed (or stale) run. */
export interface DigestFailed {
  runId: string;
  workflow: string;
  state: "failed" | "stale";
  at: number | null;
  /** The error the run recorded, cut short; null when none was. */
  error: string | null;
  agents: { total: number; failed: number };
  /** Failure reason → how many of its agents failed so ("unknown" when no reason was recorded). */
  reasons: Record<string, number>;
  resume: string;
}

/** What one agent of a done run did not get right. */
export interface DigestMiss {
  agentId: number | null;
  label: string;
  /** Its failure reason, when it failed under a run that went on. */
  failed?: string;
  /** The `expect` checks it missed. */
  misses?: string[];
  /** The files it changed outside its declared scope. */
  outOfScope?: string[];
}

export interface DigestUnmet {
  runId: string;
  workflow: string;
  at: number | null;
  agents: DigestMiss[];
}

/** A done run's kept diffs. */
export interface DigestChanges {
  runId: string;
  workflow: string;
  at: number | null;
  agents: Array<{ agentId: number | null; label: string; files: number; insertions: number; deletions: number; branch: string | null }>;
  files: number;
  insertions: number;
  deletions: number;
  /** Previews the apply without changing anything. */
  check: string;
}

export interface DigestSpend {
  runs: number;
  /** Dollars, when some run reported any. */
  costUsd: number | null;
  tokens: number;
  estimated: boolean;
  /** The most expensive run: by dollars when any reported them, else by tokens. */
  top: { runId: string; workflow: string; costUsd: number | null; tokens: number } | null;
}

export interface Digest {
  version: 1;
  /** The window, Unix seconds. */
  since: number;
  until: number;
  /** The window started at the last digest sent (`--since-last`). */
  sinceLast: boolean;
  workflow: string | null;
  runsRoot: string;
  /** The runs in the window by state, plus those waiting now. */
  counts: { runs: number; done: number; failed: number; stopped: number; running: number; waiting: number; stale: number };
  needsYou: DigestWaiting[];
  failed: DigestFailed[];
  unmet: DigestUnmet[];
  changes: DigestChanges[];
  spend: DigestSpend;
  /** Some string in it had a likely secret replaced (a notify payload only). */
  redacted?: true;
}

export interface DigestOptions {
  since: number;
  until: number;
  sinceLast?: boolean;
  workflow?: string | null;
  /** Appended to every printed command (e.g. `--runs-root DIR` for a runs root that is not the default). */
  flags?: string[];
}

/** The most of a recorded error a digest repeats. */
const ERROR_CHARS = 300;
/** The most `expect` misses or out-of-scope files listed per agent. */
const LIST_MAX = 5;

/** Collect the digest of `store` over a window. */
export function collectDigest(store: RunStore, options: DigestOptions): Digest {
  const workflow = options.workflow ?? null;
  const flags = options.flags ?? [];
  const cmd = (...words: string[]) => [...words, ...flags].map(shellArg).join(" ");
  const digest: Digest = {
    version: 1,
    since: options.since,
    until: options.until,
    sinceLast: options.sinceLast === true,
    workflow,
    runsRoot: store.root,
    counts: { runs: 0, done: 0, failed: 0, stopped: 0, running: 0, waiting: 0, stale: 0 },
    needsYou: [],
    failed: [],
    unmet: [],
    changes: [],
    spend: { runs: 0, costUsd: null, tokens: 0, estimated: false, top: null },
  };
  const refs = workflow ? store.listRunsForWorkflow(workflow) : store.listRuns();
  for (const { runId } of refs) {
    const status = store.readStatus(runId);
    const updatedAt = typeof status.updatedAt === "number" ? status.updatedAt : null;
    // A run that ended before the window is skipped without reading its events.
    if (TERMINAL_STATES.has(String(status.state)) && (updatedAt ?? 0) < options.since) continue;
    let run: RunDetail;
    try {
      run = detail(store, runId);
    } catch {
      continue; // a half-written run directory: nothing to report yet
    }
    if (run.dry) continue;
    const inWindow = (run.updatedAt ?? run.lastActivityTs ?? run.createdAt ?? 0) >= options.since;
    if (run.state === "waiting") {
      digest.counts.waiting += 1;
      for (const cp of run.pendingCheckpoints ?? []) {
        const { approve, reject } = checkpointCommands(runId, cp.checkpointId, flags);
        digest.needsYou.push({
          runId,
          workflow: run.name,
          checkpointId: cp.checkpointId,
          title: cp.title,
          kind: cp.question ? "question" : "checkpoint",
          ...(cp.question ? { asker: cp.question.label } : {}),
          since: cp.since,
          approve: cp.question ? `${approve} --note "<answer>"` : approve,
          reject,
        });
      }
    }
    if (!inWindow && run.state !== "waiting") continue;
    digest.counts.runs += 1;
    if (run.state === "running" || run.state === "pending" || run.state === "paused") digest.counts.running += 1;
    else if (run.state !== "waiting") digest.counts[run.state] += 1;
    addSpend(digest.spend, run);

    if (run.state === "failed" || run.state === "stale") {
      const agents = run.agents.filter(isAgent);
      const failed = agents.filter((a) => a.state === "failed" || a.state === "stale");
      const reasons: Record<string, number> = {};
      for (const a of failed) {
        const why = a.state === "stale" ? "stale" : (a.failureReason ?? "unknown");
        reasons[why] = (reasons[why] ?? 0) + 1;
      }
      const error = run.error?.error ?? (typeof status.error === "string" ? status.error : null);
      digest.failed.push({
        runId,
        workflow: run.name,
        state: run.state,
        at: run.updatedAt,
        error: error ? sanitizeText(error, ERROR_CHARS) : run.state === "stale" ? "its worker is gone (the run never recorded an end)" : null,
        agents: { total: agents.length, failed: failed.length },
        reasons,
        resume: cmd("odw", "resume", runId),
      });
      continue;
    }
    if (run.state !== "done") continue;

    const misses: DigestMiss[] = [];
    for (const a of run.agents.filter(isAgent)) {
      const miss: DigestMiss = { agentId: a.agentId, label: a.label };
      if (a.state === "failed") miss.failed = a.failureReason ?? "unknown";
      if (a.misses?.length) miss.misses = a.misses.slice(0, LIST_MAX).map((m) => sanitizeText(m, 200));
      if (a.outOfScope?.length) miss.outOfScope = a.outOfScope.slice(0, LIST_MAX).map((f) => sanitizeText(f, 200));
      if (miss.failed || miss.misses || miss.outOfScope) misses.push(miss);
    }
    if (misses.length) digest.unmet.push({ runId, workflow: run.name, at: run.updatedAt, agents: misses });

    const kept = run.agents.filter((a) => isAgent(a) && a.state === "done" && a.changes && a.changes.files > 0);
    if (kept.length) {
      const agents = kept.map((a) => ({
        agentId: a.agentId,
        label: a.label,
        files: a.changes!.files,
        insertions: a.changes!.insertions,
        deletions: a.changes!.deletions,
        branch: a.branch ?? null,
      }));
      digest.changes.push({
        runId,
        workflow: run.name,
        at: run.updatedAt,
        agents,
        files: agents.reduce((n, a) => n + a.files, 0),
        insertions: agents.reduce((n, a) => n + a.insertions, 0),
        deletions: agents.reduce((n, a) => n + a.deletions, 0),
        check: cmd("odw", "apply", runId, "--all", "--check"),
      });
    }
  }
  digest.needsYou.sort((a, b) => a.since - b.since);
  return digest;
}

const isAgent = (a: AgentView): boolean => (a.kind ?? "agent") === "agent";

function addSpend(spend: DigestSpend, run: RunDetail): void {
  const u = run.usage;
  if (!u) return;
  spend.runs += 1;
  const tokens = (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
  spend.tokens += tokens;
  if (u.estimated) spend.estimated = true;
  if (u.costUsd !== undefined) spend.costUsd = (spend.costUsd ?? 0) + u.costUsd;
  const cost = u.costUsd ?? null;
  const top = spend.top;
  const more =
    !top ||
    (cost !== null && (top.costUsd === null || cost > top.costUsd)) ||
    (cost === null && top.costUsd === null && tokens > top.tokens);
  if (more) spend.top = { runId: run.runId, workflow: run.name, costUsd: cost, tokens };
}

/** Is there anything to act on: a waiting checkpoint, a failure, a miss or a change to look at? */
export function digestIsQuiet(d: Digest): boolean {
  return d.needsYou.length + d.failed.length + d.unmet.length + d.changes.length === 0;
}

/** How the window reads: "last 12h", "since the last digest (…)". */
export function windowText(d: Digest): string {
  const span = formatDuration(d.until - d.since);
  return d.sinceLast ? `since the last digest, ${localMinute(new Date(d.since * 1000))} (${span})` : `last ${span}`;
}

/**
 * The one-line summary, e.g. "odw digest · last 12h · 2 need you · 1 failed
 * · 1 missed checks · 3 with changes · $4.210 over 14 runs".
 */
export function digestLine(d: Digest): string {
  const parts = [`odw digest${d.workflow ? ` (${d.workflow})` : ""}`, windowText(d)];
  if (d.needsYou.length) parts.push(`${d.needsYou.length} need${d.needsYou.length === 1 ? "s" : ""} you`);
  if (d.failed.length) parts.push(`${d.failed.length} failed`);
  if (d.unmet.length) parts.push(`${d.unmet.length} missed checks`);
  if (d.changes.length) parts.push(`${d.changes.length} with changes`);
  if (digestIsQuiet(d)) parts.push("nothing needs you");
  parts.push(`${d.spend.costUsd !== null ? `${fmtUsd(d.spend.costUsd)} over ` : ""}${plural(d.counts.runs, "run")}`);
  return parts.join(" · ");
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

const when = (ts: number | null): string => (ts === null ? "?" : localMinute(new Date(ts * 1000)));

function reasonsText(reasons: Record<string, number>): string {
  return Object.entries(reasons)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([why, n]) => `${why} ${n}`)
    .join(", ");
}

function missLines(m: DigestMiss): string[] {
  const who = `agent ${m.agentId ?? "?"} "${sanitizeText(m.label, 80)}"`;
  const lines: string[] = [];
  // A miss already says why an agent that failed for its expect checks failed.
  if (m.failed && !(m.failed === "unmet_expectation" && m.misses?.length)) lines.push(`${who} failed: ${m.failed}`);
  for (const miss of m.misses ?? []) lines.push(`${who} missed: ${miss}`);
  if (m.outOfScope?.length) lines.push(`${who} wrote outside its scope: ${m.outOfScope.join(", ")}`);
  return lines;
}

function spendText(s: DigestSpend): string {
  if (s.runs === 0) return "no run reported usage";
  const money = s.costUsd !== null ? `${fmtUsd(s.costUsd)} · ` : "";
  const top = s.top
    ? ` · most: ${sanitizeText(s.top.workflow, 80)} ${s.top.runId} ${s.top.costUsd !== null ? fmtUsd(s.top.costUsd) : `${fmtTokens(s.top.tokens)} tokens`}`
    : "";
  return `${money}${fmtTokens(s.tokens)}${s.estimated ? "~" : ""} tokens (${plural(s.runs, "run")} reported usage)${top}`;
}

/** The digest for a terminal: a heading per group that has anything, and the commands that act on it. */
export function formatDigest(d: Digest, caps: TermCaps = { color: false, truecolor: false, unicode: false }): string {
  const p = palette(caps);
  const safe = (s: string, n = 120) => sanitizeText(s, n);
  const out: string[] = [];
  out.push(`${p.bold("odw digest")}${d.workflow ? ` ${safe(d.workflow, 80)}` : ""} · ${windowText(d)} · ${plural(d.counts.runs, "run")}`);
  const tally = (["done", "failed", "stopped", "running", "waiting", "stale"] as const).filter((k) => d.counts[k] > 0).map((k) => `${d.counts[k]} ${k}`);
  if (tally.length) out.push(p.dim(tally.join(" · ")));
  if (d.needsYou.length) {
    out.push("", p.bold(`Needs you (${d.needsYou.length})`));
    for (const w of d.needsYou) {
      const what = w.kind === "question" ? `${safe(w.asker ?? "an agent", 60)} asks: ${safe(w.title)}` : safe(w.title);
      out.push(`  ${p.run("?")} ${safe(w.workflow, 60)}  ${w.runId}  #${w.checkpointId} ${what}  ${p.dim(`since ${when(w.since)}`)}`);
      out.push(p.dim(`      ${w.approve}`), p.dim(`      ${w.reject}`));
    }
  }
  if (d.failed.length) {
    out.push("", p.bold(`Failed (${d.failed.length})`));
    for (const f of d.failed) {
      const agents = f.agents.failed ? ` · ${f.agents.failed}/${plural(f.agents.total, "agent")} did not finish (${reasonsText(f.reasons)})` : "";
      out.push(`  ${p.err(caps.unicode ? "✗" : "x")} ${safe(f.workflow, 60)}  ${f.runId}  ${f.state} ${when(f.at)}${agents}`);
      if (f.error) out.push(`      ${p.err(safe(f.error, 300))}`);
      out.push(p.dim(`      ${f.resume}`));
    }
  }
  if (d.unmet.length) {
    out.push("", p.bold(`Done, but checks were not met (${d.unmet.length})`));
    for (const u of d.unmet) {
      out.push(`  ${p.run("!")} ${safe(u.workflow, 60)}  ${u.runId}  done ${when(u.at)}`);
      for (const m of u.agents) for (const line of missLines(m)) out.push(`      ${safe(line, 300)}`);
    }
  }
  if (d.changes.length) {
    out.push("", p.bold(`Done, with changes to review (${d.changes.length})`));
    for (const c of d.changes) {
      out.push(`  ${p.accent(caps.unicode ? "±" : "*")} ${safe(c.workflow, 60)}  ${c.runId}  ${plural(c.agents.length, "agent")} · ${plural(c.files, "file")} +${c.insertions} -${c.deletions}`);
      out.push(p.dim(`      ${c.check}`));
    }
  }
  if (digestIsQuiet(d)) out.push("", "Nothing needs you: no checkpoint waits, nothing failed, no check was missed, no change waits.");
  out.push("", `${p.bold("Spend")}  ${spendText(d.spend)}`);
  return out.join("\n");
}

/** Markdown for code: backticks inside are dropped (a span cannot hold them reliably). */
const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;
/** Markdown text: no line breaks, the characters that would start formatting escaped. */
const md = (s: string, n = 200) => sanitizeText(s, n).replace(/([\\`*_[\]<>|#~])/g, "\\$1");

/** The digest as markdown: what the webhook's `markdown` (and `text`) carry, and `--markdown` prints. */
export function digestMarkdown(d: Digest): string {
  const out: string[] = [];
  out.push(`### odw digest${d.workflow ? ` · ${md(d.workflow, 80)}` : ""} · ${windowText(d)} · ${plural(d.counts.runs, "run")}`);
  if (d.needsYou.length) {
    out.push("", `**Needs you (${d.needsYou.length})**`);
    for (const w of d.needsYou) {
      const what = w.kind === "question" ? `${md(w.asker ?? "an agent", 60)} asks: ${md(w.title)}` : md(w.title);
      const links = w.approveUrl && w.rejectUrl ? ` · [approve](${w.approveUrl}) · [reject](${w.rejectUrl})` : "";
      out.push(`- ${md(w.workflow, 60)} ${code(w.runId)} #${w.checkpointId}: ${what} (since ${when(w.since)}) · ${code(w.approve)}${links}`);
    }
  }
  if (d.failed.length) {
    out.push("", `**Failed (${d.failed.length})**`);
    for (const f of d.failed) {
      const agents = f.agents.failed ? ` · ${f.agents.failed}/${plural(f.agents.total, "agent")} did not finish (${reasonsText(f.reasons)})` : "";
      out.push(`- ${md(f.workflow, 60)} ${code(f.runId)} ${f.state} ${when(f.at)}${agents}${f.error ? ` · ${md(f.error, 300)}` : ""} · ${code(f.resume)}`);
    }
  }
  if (d.unmet.length) {
    out.push("", `**Done, but checks were not met (${d.unmet.length})**`);
    for (const u of d.unmet) {
      out.push(`- ${md(u.workflow, 60)} ${code(u.runId)} done ${when(u.at)}`);
      for (const m of u.agents) for (const line of missLines(m)) out.push(`  - ${md(line, 300)}`);
    }
  }
  if (d.changes.length) {
    out.push("", `**Done, with changes to review (${d.changes.length})**`);
    for (const c of d.changes) {
      out.push(`- ${md(c.workflow, 60)} ${code(c.runId)} ${plural(c.agents.length, "agent")} · ${plural(c.files, "file")} +${c.insertions} −${c.deletions} · ${code(c.check)}`);
    }
  }
  if (digestIsQuiet(d)) out.push("", "Nothing needs you.");
  out.push("", `**Spend** ${md(spendText(d.spend), 400)}`);
  return out.join("\n");
}
