/**
 * A run source (L5): one provider's read-only view onto its workflow runs.
 *
 * `odw serve` is an observatory, not an owner — it already treats the ODW run
 * directory as just-another-reader (see {@link ./runs-view}). This interface
 * generalizes that: each source folds its own on-disk artifacts into the SAME
 * {@link RunSummary}/{@link RunDetail} wire types, tagged with its `provider`,
 * and the server merges them behind the unchanged `/api/runs` surface. ODW's own
 * runs come from {@link ./odw-run-source}; Claude Code's from
 * {@link ./claude-run-source}.
 *
 * A source owns its own caching (ODW keys on status.json/events.jsonl and tails
 * the event log by byte cursor; Claude keys on its journal + transcript
 * signatures) because the freshness signal differs per provider. Liveness — a
 * worker pid, a Claude run's freshness window — changes no file, so it is never
 * cached: every read re-checks it. Every method is read-only except `control`
 * and `decide`, and a read-only source advertises that by returning a non-null
 * {@link controlError} (the server then refuses control with a 409 rather than
 * silently no-op'ing).
 */

import type { CheckpointRequest } from "../control.js";
import type { WorkflowEvent } from "../events.js";
import type { AgentResultRecord } from "../journal.js";
import type { RunDetail, RunSummary } from "./runs-view.js";

/** A run id (or Claude session dir name) is one safe path segment: `[A-Za-z0-9._-]`. */
export const RUN_ID_RE = /^[A-Za-z0-9._-]+$/;

export interface RunSource {
  /** Which engine this source reads. Stamped onto every summary/detail it emits. */
  readonly provider: "odw" | "claude";
  /**
   * True if `runId` belongs to this source — a cheap format/prefix test, NOT a
   * filesystem hit. ODW ids and Claude `cc-`-prefixed ids are disjoint, so at
   * most one source owns any id and the server can route without ambiguity.
   */
  owns(runId: string): boolean;
  /** Does this run actually exist on disk? Gates 404 vs serve. */
  exists(runId: string): boolean;
  /** Every run this source can see (internally cached); the server sorts the union. */
  listSummaries(): RunSummary[];
  /** One run's summary (same cache as the list, liveness re-checked), or null if absent. */
  summary(runId: string): RunSummary | null;
  /** Full detail for one run, or null if absent. */
  detail(runId: string): RunDetail | null;
  /** The run's event stream from `since` (an index), synthesized if the provider has no real one. */
  events(runId: string, since: number): WorkflowEvent[];
  /**
   * The run's whole event stream ([] if absent) — the source's cached copy,
   * so callers must treat it as read-only and slice what they keep.
   */
  eventLog(runId: string): readonly WorkflowEvent[];
  /** The run's final result, if any. */
  result(runId: string): { has: boolean; value: unknown };
  /**
   * The run's saved per-agent results, by agentId — readable while the run is
   * still going. Null when this provider saves none (Claude runs).
   */
  agentResults(runId: string): AgentResultRecord[] | null;
  /** One agent's saved result; null when it has none or the provider saves none. */
  agentResult(runId: string, agentId: number): AgentResultRecord | null;
  /**
   * The file holding what an isolated agent changed, as a unified diff (ODW
   * extension); null when it kept none, or the provider keeps none.
   */
  agentDiff(runId: string, agentId: number): string | null;
  /**
   * Null when this source can pause/resume/stop a run; otherwise a human reason
   * the server returns (409) for any control attempt. Claude runs are read-only.
   */
  readonly controlError: string | null;
  /** Apply a control action (pause|resume|stop). Only called when controlError is null. */
  control(runId: string, action: string): void;
  /** Answer a waiting checkpoint() (ODW extension). Only called when controlError is null. */
  decide(runId: string, request: CheckpointRequest): void;
}

/** Every source's summaries, merged and sorted newest-first (the unified run list). */
export function allSummaries(sources: RunSource[]): RunSummary[] {
  return sources.flatMap((s) => s.listSummaries()).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

/**
 * The source that owns + has this run, or null. Ids are disjoint, so at most one
 * matches; a malformed id is refused before any filesystem lookup.
 */
export function sourceForRun(sources: RunSource[], runId: string): RunSource | null {
  if (!RUN_ID_RE.test(runId)) return null;
  return sources.find((s) => s.owns(runId) && s.exists(runId)) ?? null;
}
