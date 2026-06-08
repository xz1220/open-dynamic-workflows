/**
 * The ODW run source: wraps the existing {@link RunStore} + {@link ./runs-view}
 * read-model behind the {@link RunSource} interface. This is the original
 * `odw serve` behavior, unchanged — including the {@link SummaryCache} that was
 * previously inlined in server.ts (it lives here now because its freshness
 * signal, status.json + events.jsonl, is ODW-specific).
 */

import { statSync } from "node:fs";

import type { WorkflowEvent } from "../events.js";
import { detail, summarize, type RunSummary } from "./runs-view.js";
import type { RunSource } from "./run-source.js";
import type { RunStore } from "./run-store.js";

/**
 * Summary cache keyed by the run's mutable artifacts. Folding events.jsonl on
 * every poll is O(events) per run; here we recompute a run's summary only when
 * its status.json or events.jsonl changed size/mtime, so steady-state polling of
 * many runs stays cheap.
 */
class SummaryCache {
  private readonly entries = new Map<string, { sig: string; value: RunSummary }>();

  list(store: RunStore): RunSummary[] {
    const live = new Set(store.listRuns().map((r) => r.runId));
    const out: RunSummary[] = [];
    for (const runId of live) {
      if (!store.exists(runId)) continue; // deleted between listRuns() and now
      const sig = this.signature(store, runId);
      const hit = this.entries.get(runId);
      if (hit && hit.sig === sig) {
        out.push(hit.value);
        continue;
      }
      const value = summarize(store, runId);
      this.entries.set(runId, { sig, value });
      out.push(value);
    }
    for (const key of this.entries.keys()) if (!live.has(key)) this.entries.delete(key);
    return out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }

  /** A cheap fingerprint of a run's mutable files; '' on the first miss. */
  private signature(store: RunStore, runId: string): string {
    const dir = store.runDir(runId);
    return [statSig(`${dir}/status.json`), statSig(`${dir}/events.jsonl`)].join("|");
  }
}

function statSig(path: string): string {
  try {
    const s = statSync(path);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return "-";
  }
}

export class OdwRunSource implements RunSource {
  readonly provider = "odw" as const;
  readonly controlError = null;
  private readonly cache = new SummaryCache();

  constructor(private readonly store: RunStore) {}

  /** A Claude run is `cc-`-prefixed; everything else is ODW's. */
  owns(runId: string): boolean {
    return !runId.startsWith("cc-");
  }
  exists(runId: string): boolean {
    return this.store.exists(runId);
  }
  listSummaries(): RunSummary[] {
    return this.cache.list(this.store);
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
}
