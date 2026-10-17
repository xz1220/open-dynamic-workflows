/**
 * Read-model for the Activity view (L5): the dashboard's "machine pulse".
 *
 * Built server-side from the run sources' caches, so the client polls ONE
 * endpoint instead of fanning out to every recent run's events and every
 * active run's detail:
 *
 *   - events: a merged, newest-first tail of the newest runs' event streams,
 *     each event tagged with the run it came from;
 *   - fleet: how many agents are running right now, per adapter, across every
 *     active run (stale runs' agents are not running, so they do not count;
 *     neither do exec() command steps, which are not agents).
 */

import type { WorkflowEvent } from "../events.js";
import type { RunSource } from "./run-source.js";
import type { RunSummary } from "./runs-view.js";

/** One firehose row: the raw event plus where it came from. */
export interface ActivityEvent extends WorkflowEvent {
  runId: string;
  /** The run's display name (its workflow's name). */
  run: string;
  /** The adapter named by the event (agent events), else null. */
  adapter: string | null;
  provider: RunSummary["provider"];
}

export interface ActivityView {
  events: ActivityEvent[];
  /** adapter → agents running now. An agent with no recorded adapter counts under
   *  "claude" for a Claude Code run, else "unknown". */
  fleet: Record<string, number>;
}

export const ACTIVITY_DEFAULT_LIMIT = 40;
export const ACTIVITY_MAX_LIMIT = 200;
/** How many of the newest runs feed the event firehose. */
export const ACTIVITY_RECENT_RUNS = 12;

const ACTIVE_STATES = new Set(["pending", "running", "paused"]);

/** `?limit=` → [1, ACTIVITY_MAX_LIMIT]; junk or absent → the default. */
export function activityLimit(param: string | null): number {
  const n = param === null || param.trim() === "" ? NaN : Number(param);
  if (!Number.isFinite(n)) return ACTIVITY_DEFAULT_LIMIT;
  return Math.min(ACTIVITY_MAX_LIMIT, Math.max(1, Math.floor(n)));
}

/**
 * Aggregate the Activity view. `runs` is the merged run list, newest first
 * (what /api/runs serves); event tails come from each source's cached event
 * log and the fleet from the folded agents of active runs with agents running.
 */
export function activityView(sources: RunSource[], runs: RunSummary[], limit: number): ActivityView {
  const sourceOf = (runId: string) => sources.find((s) => s.owns(runId)) ?? null;

  const events: ActivityEvent[] = [];
  for (const run of runs.slice(0, ACTIVITY_RECENT_RUNS)) {
    const log = sourceOf(run.runId)?.eventLog(run.runId) ?? [];
    for (const ev of log.slice(-limit)) {
      events.push({
        ...ev,
        runId: run.runId,
        run: run.name,
        adapter: typeof ev.adapter === "string" ? ev.adapter : null,
        provider: run.provider,
      });
    }
  }
  events.sort((a, b) => tsOf(b) - tsOf(a));

  const fleet: Record<string, number> = {};
  for (const run of runs) {
    if (!ACTIVE_STATES.has(run.state) || run.counts.running === 0) continue;
    for (const agent of sourceOf(run.runId)?.detail(run.runId)?.agents ?? []) {
      if (agent.state !== "running" || agent.kind === "command") continue;
      const key = agent.adapter ?? (run.provider === "claude" ? "claude" : "unknown");
      fleet[key] = (fleet[key] ?? 0) + 1;
    }
  }
  return { events: events.slice(0, limit), fleet };
}

function tsOf(ev: WorkflowEvent): number {
  return typeof ev.ts === "number" && Number.isFinite(ev.ts) ? ev.ts : 0;
}
