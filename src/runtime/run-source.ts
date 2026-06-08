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
 * A source owns its own caching (ODW keys on status.json/events.jsonl; Claude on
 * the journal's mtime) because the freshness signal differs per provider. Every
 * method is read-only except `control`, and a read-only source advertises that
 * by returning a non-null {@link controlError} (the server then refuses control
 * with a 409 rather than silently no-op'ing).
 */

import type { WorkflowEvent } from "../events.js";
import type { RunDetail, RunSummary } from "./runs-view.js";

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
  /** Full detail for one run, or null if absent. */
  detail(runId: string): RunDetail | null;
  /** The run's event stream from `since` (an index), synthesized if the provider has no real one. */
  events(runId: string, since: number): WorkflowEvent[];
  /** The run's final result, if any. */
  result(runId: string): { has: boolean; value: unknown };
  /**
   * Null when this source can pause/resume/stop a run; otherwise a human reason
   * the server returns (409) for any control attempt. Claude runs are read-only.
   */
  readonly controlError: string | null;
  /** Apply a control action (pause|resume|stop). Only called when controlError is null. */
  control(runId: string, action: string): void;
}
