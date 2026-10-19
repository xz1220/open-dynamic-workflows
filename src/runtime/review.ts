/**
 * The review queue (ODW extension): every kept diff across runs that nobody
 * has dealt with yet, riskiest first — `odw review` and the dashboard's
 * Review page.
 *
 * An entry is one agent that kept a diff (agents/<agentId>.diff). Its risk
 * score is deterministic and comes only from what the run recorded: the size
 * of the change, the kinds of path it touches (read from the kept diff), how
 * its `expect` checks went, its scope, the background work it left, the
 * destructive git it ran, a deadline that cut it short, fallbacks and
 * handoffs, a resolver at apply, retries and cost. Every point is a
 * {@link RiskFactor} that says why, shown on the entry — never a bare number.
 * No model is asked anything.
 *
 *   points  0–2 low · 3–5 medium · 6+ high (a passed expect.command takes one off)
 *
 * What a person did about an entry is kept beside the run, append-only, in
 * `reviews.jsonl`: one line per mark — `{ ts, agentId, state, by, via, note? }`
 * with state `reviewed`, `dismissed`, `applied` or `open` (undo), `by` who
 * (see ../identity) and `via` the channel (`cli`, `dashboard`, `apply`). The
 * last mark of an agent stands. `odw apply` marks what it applied cleanly.
 *
 * Runs `odw eval` started and `odw apply --resolve`'s resolver runs are left
 * out: their diffs are not proposals to review.
 */

import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { AgentChanges } from "../changes.js";
import type { WorkflowEvent } from "../events.js";
import { clean, isWho } from "../identity.js";
import { diffFiles, type DiffFile } from "./changes-view.js";
import { SigCache, statSig } from "./fs-util.js";
import type { RunStore } from "./run-store.js";
import { detailFrom, readFacts, type AgentView } from "./runs-view.js";

/** The file of a run's marks, in its run directory. */
export const REVIEWS_FILE = "reviews.jsonl";
/** What a mark may say: the three that take an entry off the queue, and `open`, which puts it back. */
export const REVIEW_STATES = ["reviewed", "dismissed", "applied", "open"] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];
/** A mark's note: at most this many characters. */
export const REVIEW_NOTE_MAX = 2000;
/** A kept diff larger than this is not read for its paths (its diffstat still counts). */
const DIFF_READ_MAX = 8 * 1024 * 1024;

export type RiskLevel = "low" | "medium" | "high";

/** One reason an entry ranks where it does: its key, its points, and why, in words. */
export interface RiskFactor {
  key: string;
  points: number;
  why: string;
}

/** One mark of `reviews.jsonl`. */
export interface ReviewMark {
  ts: number;
  agentId: number;
  state: ReviewState;
  /** Who marked it (see ../identity); null when nobody could be named. */
  by: string | null;
  /** Where it was marked. */
  via: "cli" | "dashboard" | "apply";
  note?: string;
}

/** One agent's kept diff on the queue. */
export interface ReviewEntry {
  runId: string;
  /** The run's display name (its workflow). */
  run: string;
  runState: string;
  createdAt: number | null;
  agentId: number;
  label: string;
  phase: string | null;
  adapter: string | null;
  agentState: string;
  finishedAt: number | null;
  changes: AgentChanges;
  branch: string | null;
  /** The run's other repository it worked in (ODW extension; see ../repos); absent: the source. */
  repo?: string;
  /** The kinds of path it touches: tests, ci, deps, migrations, auth, binary. */
  categories: string[];
  score: number;
  risk: RiskLevel;
  /** Every reason for the score, largest first. */
  factors: RiskFactor[];
  /** The last mark, if any; an entry without one (or marked `open`) is on the queue. */
  review: ReviewMark | null;
}

// --- marks ------------------------------------------------------------------------------

export function isReviewState(value: unknown): value is ReviewState {
  return typeof value === "string" && (REVIEW_STATES as readonly string[]).includes(value);
}

/** A run's marks, in order; malformed lines are skipped. */
export function readReviews(runDir: string): ReviewMark[] {
  let text: string;
  try {
    text = readFileSync(join(runDir, REVIEWS_FILE), "utf8");
  } catch {
    return [];
  }
  const out: ReviewMark[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (raw === null || typeof raw !== "object") continue;
    const { ts, agentId, state, by, via, note } = raw;
    if (typeof ts !== "number" || !Number.isSafeInteger(agentId) || (agentId as number) < 0 || !isReviewState(state)) continue;
    out.push({
      ts,
      agentId: agentId as number,
      state,
      by: isWho(by) ? by : null,
      via: via === "dashboard" || via === "apply" ? via : "cli",
      ...(typeof note === "string" && note !== "" ? { note: note.slice(0, REVIEW_NOTE_MAX) } : {}),
    });
  }
  return out;
}

/** The last mark of each agent. */
export function latestMarks(marks: ReviewMark[]): Map<number, ReviewMark> {
  const out = new Map<number, ReviewMark>();
  for (const mark of marks) out.set(mark.agentId, mark);
  return out;
}

/** Append one mark to the run's `reviews.jsonl` (one write: a line is never interleaved with another's). */
export function appendReview(
  runDir: string,
  mark: { agentId: number; state: ReviewState; by: string | null; via: ReviewMark["via"]; note?: string | null },
  now = Date.now() / 1000,
): ReviewMark {
  const note = typeof mark.note === "string" ? mark.note.replace(/\r\n?/g, "\n").trim().slice(0, REVIEW_NOTE_MAX) : "";
  const record: ReviewMark = {
    ts: now,
    agentId: mark.agentId,
    state: mark.state,
    by: clean(mark.by),
    via: mark.via,
    ...(note !== "" ? { note } : {}),
  };
  appendFileSync(join(runDir, REVIEWS_FILE), JSON.stringify(record) + "\n", "utf8");
  return record;
}

// --- risk ---------------------------------------------------------------------------------

/** A path category: what it is called, its points, and which paths are in it. */
interface Category {
  key: string;
  points: number;
  what: string;
  test: (path: string) => boolean;
}

const base = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

const DEPENDENCY_FILES = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
  "go.mod",
  "go.sum",
  "Cargo.toml",
  "Cargo.lock",
  "Pipfile",
  "Pipfile.lock",
  "pyproject.toml",
  "poetry.lock",
  "uv.lock",
  "setup.py",
  "setup.cfg",
  "Gemfile",
  "Gemfile.lock",
  "composer.json",
  "composer.lock",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "gradle.lockfile",
  "mix.exs",
  "mix.lock",
  "pubspec.yaml",
  "pubspec.lock",
  "Podfile",
  "Podfile.lock",
  "packages.lock.json",
  "flake.lock",
]);

/** The kinds of path the score knows, in the order they are shown. */
export const PATH_CATEGORIES: readonly Category[] = [
  {
    key: "ci",
    points: 3,
    what: "touches CI",
    test: (p) =>
      /(^|\/)\.github\/workflows\//.test(p) ||
      /(^|\/)\.gitlab-ci\.ya?ml$/.test(p) ||
      /(^|\/)\.circleci\//.test(p) ||
      /(^|\/)\.buildkite\//.test(p) ||
      /(^|\/)(Jenkinsfile|azure-pipelines\.ya?ml|\.travis\.yml|bitbucket-pipelines\.yml)$/.test(p),
  },
  {
    key: "migrations",
    points: 3,
    what: "touches database migrations",
    test: (p) => /(^|\/)(migrations?|migrate|alembic)\//i.test(p) || /\.sql$/i.test(p),
  },
  {
    key: "auth",
    points: 3,
    what: "touches auth or security code",
    test: (p) =>
      /(^|[/._-])(auth|authn|authz|authentication|authorization|authorize|security|secrets?|credentials?|passwords?|passwd|crypto|oauth|jwt|sessions?|login|permissions?|acl|rbac|tokens?)([/._-]|$)/i.test(p) ||
      /^\.env(\.|$)/.test(base(p)),
  },
  {
    key: "deps",
    points: 2,
    what: "changes dependencies",
    test: (p) => DEPENDENCY_FILES.has(base(p)) || /^requirements[\w.-]*\.txt$/.test(base(p)) || /\.csproj$/.test(p),
  },
  {
    key: "tests",
    points: 1,
    what: "changes tests",
    test: (p) =>
      /(^|\/)(tests?|__tests__|specs?)\//.test(p) || /[._-](test|spec)\.[A-Za-z0-9]+$/.test(p) || /(^|\/)test_[^/]+\.py$/.test(p),
  },
];

/** Paths named in a reason: the first few, then how many more. */
function listed(paths: string[], max = 3): string {
  const shown = paths.slice(0, max).join(", ");
  return paths.length > max ? `${shown} and ${paths.length - max} more` : shown;
}

/** What a run's events say about one agent, beyond its folded view. */
export interface AgentEvidence {
  /** Retries logged for it, by reason (`expect`, `rate_limit`, `stall`, `question`). */
  retries: Record<string, number>;
  /** Its handoffs: from which adapter to which. */
  handoffs: Array<{ from: string; to: string }>;
  /** `odw apply --resolve` resolver runs for it, and how each ended. */
  resolves: string[];
  /** Its `expect.command` check: true passed, false failed, null none ran. */
  expectCommand: boolean | null;
}

/** The evidence of every agent of a run, from its events. */
export function agentEvidence(events: readonly WorkflowEvent[], agents: readonly AgentView[]): Map<number, AgentEvidence> {
  const out = new Map<number, AgentEvidence>();
  const of = (id: number): AgentEvidence => {
    let e = out.get(id);
    if (!e) out.set(id, (e = { retries: {}, handoffs: [], resolves: [], expectCommand: null }));
    return e;
  };
  for (const ev of events) {
    if (typeof ev.agentId !== "number") continue;
    if (ev.type === "log" && ev.retry !== null && typeof ev.retry === "object") {
      const reason = (ev.retry as { reason?: unknown }).reason;
      if (typeof reason === "string") of(ev.agentId).retries[reason] = (of(ev.agentId).retries[reason] ?? 0) + 1;
    } else if (ev.type === "handoff") {
      of(ev.agentId).handoffs.push({ from: String(ev.from ?? "?"), to: String(ev.to ?? "?") });
    } else if (ev.type === "apply_resolved") {
      of(ev.agentId).resolves.push(typeof ev.outcome === "string" ? ev.outcome : "unknown");
    }
  }
  // An expect.command check is an exec() step that belongs to its agent.
  for (const node of agents) {
    if (node.kind !== "command" || typeof node.forAgentId !== "number" || node.state === "running") continue;
    of(node.forAgentId).expectCommand = node.state === "done";
  }
  return out;
}

const UNTOUCHED_MISS = /^no file matching .+ may change, and /;

/**
 * The risk of one agent's kept diff: every factor with its points, the path
 * categories, the sum (never below 0) and its level. Pure: the same inputs
 * give the same score.
 */
export function scoreAgent(
  agent: AgentView,
  changes: AgentChanges,
  files: DiffFile[] | null,
  evidence: AgentEvidence | undefined,
): { score: number; risk: RiskLevel; factors: RiskFactor[]; categories: string[] } {
  const factors: RiskFactor[] = [];
  const add = (key: string, points: number, why: string): void => {
    factors.push({ key, points, why });
  };

  const lines = changes.insertions + changes.deletions;
  if (lines >= 1000) add("lines", 3, `a large change: ${lines} lines`);
  else if (lines >= 300) add("lines", 2, `a sizeable change: ${lines} lines`);
  else if (lines >= 50) add("lines", 1, `${lines} lines changed`);
  if (changes.files >= 20) add("files", 2, `${changes.files} files changed`);
  else if (changes.files >= 6) add("files", 1, `${changes.files} files changed`);

  const categories: string[] = [];
  if (files) {
    const paths = (f: DiffFile): string[] => [...new Set([f.newPath, f.oldPath].filter((p): p is string => p !== null))];
    for (const cat of PATH_CATEGORIES) {
      const hit = files.filter((f) => paths(f).some(cat.test));
      if (hit.length === 0) continue;
      categories.push(cat.key);
      const names = hit.map((f) => f.newPath ?? f.oldPath!);
      add(cat.key, cat.points, `${cat.what}: ${listed(names)}`);
      if (cat.key === "tests") {
        const gone = hit.filter((f) => f.status === "deleted").map((f) => f.oldPath!);
        if (gone.length > 0) add("tests-deleted", 2, `deletes tests: ${listed(gone)}`);
      }
    }
    const binary = files.filter((f) => f.binary).map((f) => f.newPath ?? f.oldPath!);
    if (binary.length > 0) {
      categories.push("binary");
      add("binary", 2, `binary files: ${listed(binary)}`);
    }
  }

  if (changes.truncated) add("truncated", 2, "its diff was cut at maxDiffBytes: odw apply cannot apply it (its branch can)");
  if (agent.partial) add("deadline", 3, "the run's --deadline killed it: its change is what it had then");

  // How its own checks went.
  const misses = agent.misses ?? [];
  const untouched = misses.filter((m) => UNTOUCHED_MISS.test(m));
  const others = misses.filter((m) => !UNTOUCHED_MISS.test(m));
  if (untouched.length > 0) add("untouched", 4, `changed files it must not: ${untouched.join("; ")}`);
  if (others.length > 0) add("expect", 4, `missed its expect: ${others.join("; ")}`);
  if (agent.state === "failed" && agent.failureReason !== "unmet_expectation" && agent.failureReason !== "out_of_scope") {
    add("failed", 3, `it failed${agent.failureReason ? ` (${agent.failureReason})` : ""}: the change is unfinished work`);
  }
  const expectRetries = evidence?.retries.expect ?? 0;
  if (expectRetries > 0) add("expect-retry", 1, `met its expect only after ${expectRetries} ${expectRetries === 1 ? "retry" : "retries"}`);
  if (agent.outOfScope?.length) add("scope", 3, `changed ${agent.outOfScope.length} file(s) outside its scope: ${listed(agent.outOfScope)}`);
  if (agent.orphaned?.length || agent.failureReason === "orphaned_background") {
    add("orphaned", 2, `left background work running${agent.orphaned?.length ? `: ${listed(agent.orphaned, 2)}` : ""}`);
  }
  if (agent.destructiveGit?.length) {
    add("destructive-git", 3, `ran destructive git: ${listed([...new Set(agent.destructiveGit.map((d) => d.what))])}`);
  }

  // How it got there.
  if (agent.fellBackFrom?.length || evidence?.handoffs.length) {
    const handed = evidence?.handoffs.length ? ` (handed over: ${evidence.handoffs.map((h) => `${h.from} → ${h.to}`).join(", ")})` : "";
    add("fallback", 1, `fell back from ${agent.fellBackFrom?.join(", ") ?? evidence!.handoffs[0]!.from}${handed}`);
  }
  if (evidence?.resolves.length) add("resolve", 1, `conflicted at apply: a resolver ran (${evidence.resolves.join(", ")})`);
  const other = Object.entries(evidence?.retries ?? {}).filter(([reason]) => reason !== "expect");
  const retried = other.reduce((n, [, count]) => n + count, 0);
  if (retried > 0) add("retries", 1, `retried ${retried} time(s): ${other.map(([reason, n]) => `${reason} ×${n}`).join(", ")}`);
  const cost = agent.usage?.costUsd;
  if (typeof cost === "number" && cost >= 5) add("cost", 2, `cost $${cost.toFixed(2)}`);
  else if (typeof cost === "number" && cost >= 1) add("cost", 1, `cost $${cost.toFixed(2)}`);

  // Evidence for it: its own command check passed.
  if (evidence?.expectCommand === true && agent.state === "done") add("checked", -1, "its expect.command check passed");

  const score = Math.max(0, factors.reduce((n, f) => n + f.points, 0));
  // Largest first; ties keep the order above.
  factors.sort((a, b) => b.points - a.points);
  return { score, risk: riskLevel(score), factors, categories };
}

export function riskLevel(score: number): RiskLevel {
  return score >= 6 ? "high" : score >= 3 ? "medium" : "low";
}

// --- the queue -------------------------------------------------------------------------------

/** A run's entries before marks: what its events and kept diffs say. */
interface RunEntries {
  createdAt: number | null;
  /** Left out (an eval's or a resolver's run). */
  skip: boolean;
  entries: Array<Omit<ReviewEntry, "review">>;
}

export interface ReviewQueueOptions {
  /** Only runs created at or after this (epoch seconds); null for every run. */
  since?: number | null;
  /** Include entries already marked reviewed, dismissed or applied. */
  all?: boolean;
}

/** The whole queue: `entries` riskiest first (then newest run, then agent id); `marked` how many were left out as dealt with. */
export interface ReviewQueue {
  entries: ReviewEntry[];
  open: number;
  marked: number;
}

/**
 * Reads the queue from a runs root. Each run's entries are cached by its
 * events.jsonl (a kept diff is written before its agent's event), so a
 * long-lived reader — the dashboard — reads a run's diffs again only when it
 * changed; marks are read on every call.
 */
export class ReviewReader {
  private readonly runs = new SigCache<RunEntries>();

  constructor(private readonly store: RunStore) {}

  queue(opts: ReviewQueueOptions = {}): ReviewQueue {
    const ids = this.store.listRunIds();
    this.runs.retain(new Set(ids));
    const out: ReviewEntry[] = [];
    let open = 0;
    let marked = 0;
    for (const runId of ids) {
      const run = this.runEntries(runId);
      if (run.skip || run.entries.length === 0) continue;
      if (opts.since != null && (run.createdAt ?? 0) < opts.since) continue;
      const marks = latestMarks(readReviews(this.store.runDir(runId)));
      for (const entry of run.entries) {
        const review = marks.get(entry.agentId) ?? null;
        const dealt = review !== null && review.state !== "open";
        if (dealt) marked++;
        else open++;
        if (dealt && !opts.all) continue;
        out.push({ ...entry, review });
      }
    }
    out.sort((a, b) => b.score - a.score || (b.createdAt ?? 0) - (a.createdAt ?? 0) || (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0) || a.agentId - b.agentId);
    return { entries: out, open, marked };
  }

  /** One run's entries, from cache while its events.jsonl is unchanged. */
  private runEntries(runId: string): RunEntries {
    const sig = statSig(this.store.eventsPath(runId));
    return this.runs.get(runId, sig, () => readRunEntries(this.store, runId));
  }
}

/** The entries of one run: its agents that kept a diff, scored. */
export function readRunEntries(store: RunStore, runId: string): RunEntries {
  const meta = store.readMeta(runId);
  const createdAt = typeof meta.createdAt === "number" ? meta.createdAt : null;
  if (meta.origin === "eval" || meta.origin === "apply-resolve") return { createdAt, skip: true, entries: [] };
  const events = store.readEvents(runId);
  const det = detailFrom(runId, readFacts(store, runId, events), { hasResult: false, error: null });
  const candidates = det.agents.filter((a) => a.kind === "agent" && a.agentId !== null && a.changes && a.state !== "running");
  if (candidates.length === 0) return { createdAt, skip: false, entries: [] };
  const evidence = agentEvidence(events, det.agents);
  const entries: RunEntries["entries"] = [];
  for (const agent of candidates) {
    const file = store.agentDiffPath(runId, agent.agentId!);
    if (!existsSync(file)) continue;
    const scored = scoreAgent(agent, agent.changes!, readDiffFiles(file), evidence.get(agent.agentId!));
    entries.push({
      runId,
      run: det.name,
      runState: det.state,
      createdAt,
      agentId: agent.agentId!,
      label: agent.label,
      phase: agent.phase,
      adapter: agent.adapter,
      agentState: agent.state,
      finishedAt: agent.finishedAt,
      changes: { ...agent.changes! },
      branch: agent.branch ?? null,
      ...(agent.repo ? { repo: agent.repo.name } : {}),
      ...scored,
    });
  }
  return { createdAt, skip: false, entries };
}

/** The files of a kept diff; null when it is too large to read for its paths. */
function readDiffFiles(file: string): DiffFile[] | null {
  try {
    if (statSync(file).size > DIFF_READ_MAX) return null;
    return diffFiles(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** The run's agent ids that kept a diff a mark may name. */
export function markable(store: RunStore, runId: string, agentId: number): boolean {
  return existsSync(store.agentDiffPath(runId, agentId));
}
