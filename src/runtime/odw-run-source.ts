/**
 * The ODW run source: wraps the existing {@link RunStore} + {@link ./runs-view}
 * read-model behind the {@link RunSource} interface. This is the original
 * `odw serve` behavior — including the facts cache that was previously inlined
 * in server.ts (it lives here now because its freshness signal, status.json +
 * events.jsonl, is ODW-specific).
 */

import { join } from "node:path";

import type { WorkflowEvent } from "../events.js";
import { SigCache, statSig } from "./fs-util.js";
import { detail, readFacts, summaryFrom, type RunFacts, type RunSummary } from "./runs-view.js";
import type { RunSource } from "./run-source.js";
import type { RunStore } from "./run-store.js";

export class OdwRunSource implements RunSource {
  readonly provider = "odw" as const;
  readonly controlError = null;
  /**
   * Run facts keyed by the run's mutable artifacts. Folding events.jsonl on
   * every poll is O(events) per run; here a run's facts are re-read only when
   * its status.json or events.jsonl changed, so steady-state polling of many
   * runs stays cheap. Liveness is NOT cached: summaryFrom re-probes the worker
   * pid on every read, so a killed worker turns its run stale without any file
   * changing.
   */
  private readonly facts = new SigCache<RunFacts>();

  constructor(private readonly store: RunStore) {}

  /** A Claude run is `cc-`-prefixed; everything else is ODW's. */
  owns(runId: string): boolean {
    return !runId.startsWith("cc-");
  }
  exists(runId: string): boolean {
    return this.store.exists(runId);
  }
  listSummaries(): RunSummary[] {
    const live = new Set(this.store.listRuns().map((r) => r.runId));
    const out: RunSummary[] = [];
    for (const runId of live) {
      if (!this.store.exists(runId)) continue; // deleted between listRuns() and now
      out.push(summaryFrom(runId, this.cachedFacts(runId)));
    }
    this.facts.retain(live);
    return out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }
  detail(runId: string) {
    return this.store.exists(runId) ? detail(this.store, runId) : null;
  }
  events(runId: string, since: number): WorkflowEvent[] {
    return this.store.readEvents(runId).slice(Math.max(0, since));
  }
  result(runId: string): { has: boolean; value: unknown } {
    const has = this.store.hasResult(runId);
    return { has, value: has ? this.store.readResult(runId) : undefined };
  }
  control(runId: string, action: string): void {
    // resume clears the control file by writing a benign "running" request; the
    // worker's FileControl treats any non-pause/stop action as "carry on".
    this.store.writeControl(runId, action === "resume" ? "running" : action);
  }

  private cachedFacts(runId: string): RunFacts {
    const dir = this.store.runDir(runId);
    const sig = `${statSig(join(dir, "status.json"))}|${statSig(join(dir, "events.jsonl"))}`;
    return this.facts.get(runId, sig, () => readFacts(this.store, runId));
  }
}
