/**
 * The ODW run source: wraps the existing {@link RunStore} + {@link ./runs-view}
 * read-model behind the {@link RunSource} interface. This is the original
 * `odw serve` behavior — including the summary cache that was previously
 * inlined in server.ts (it lives here now because its freshness signal,
 * status.json + events.jsonl, is ODW-specific).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { CheckpointRequest } from "../control.js";
import type { WorkflowEvent } from "../events.js";
import type { AgentResultRecord } from "../journal.js";
import { SigCache, statSig } from "./fs-util.js";
import { detailFrom, EventFold, summaryFrom, type RunDetail, type RunFacts, type RunSummary } from "./runs-view.js";
import type { RunSource } from "./run-source.js";
import { TERMINAL_STATES, type EventsCursor, type RunStore } from "./run-store.js";

/** Full event streams kept in memory: the runs being viewed / tailed, not every run. */
const EVENT_LOGS_KEPT = 64;
/**
 * A terminal run never changes again (the worker writes its last event before
 * the terminal status), so the run list trusts its cached facts for a while
 * instead of stat'ing two files per run per tick — with thousands of finished
 * runs those stats ARE the list's cost. Re-checked every ~30s (jittered, so the
 * re-checks spread out) in case something rewrites a finished run by hand;
 * detail() and summary() always re-check.
 */
const TERMINAL_RECHECK_MS = 30_000;

/** One run's cached view of its files; liveness is NOT cached (see summaryFrom). */
interface RunEntry {
  statusSig: string;
  status: Record<string, unknown>;
  /** meta.json is immutable once written: read once. */
  meta: Record<string, unknown> | null;
  eventsSig: string;
  /** Byte cursor into events.jsonl: only appended bytes are read and folded. */
  cursor: EventsCursor;
  fold: EventFold;
  /** Epoch ms until which the run list trusts a terminal run without a stat (0: always check). */
  trustUntil: number;
}

/** A run's full event stream, read incrementally through the byte cursor. */
interface EventLog {
  cursor: EventsCursor;
  events: WorkflowEvent[];
}

export class OdwRunSource implements RunSource {
  readonly provider = "odw" as const;
  readonly controlError = null;
  /** Per-run facts for every listed run; small (folded agents, not events). */
  private readonly runs = new Map<string, RunEntry>();
  /** Whole event streams for the most recently read runs (LRU). */
  private readonly logs = new SigCache<EventLog>(EVENT_LOGS_KEPT);
  private readonly now: () => number;

  constructor(
    private readonly store: RunStore,
    opts: { /** Injectable clock for tests (ms). */ now?: () => number } = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  /** A Claude run is `cc-`-prefixed; everything else is ODW's. */
  owns(runId: string): boolean {
    return !runId.startsWith("cc-");
  }
  exists(runId: string): boolean {
    return this.store.exists(runId);
  }
  listSummaries(): RunSummary[] {
    // Ids only (no meta.json reads): the walk itself proved each run exists, and
    // a run deleted mid-list just drops out of the next one.
    const ids = this.store.listRunIds();
    const now = this.now();
    const out = ids.map((runId) => summaryFrom(runId, this.facts(runId, now)));
    const live = new Set(ids);
    for (const runId of this.runs.keys()) if (!live.has(runId)) this.runs.delete(runId);
    return out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }
  summary(runId: string): RunSummary | null {
    return this.store.exists(runId) ? summaryFrom(runId, this.facts(runId)) : null;
  }
  detail(runId: string): RunDetail | null {
    if (!this.store.exists(runId)) return null;
    return detailFrom(runId, this.facts(runId), {
      hasResult: this.store.hasResult(runId),
      error: this.store.readError(runId) as { error?: string; stack?: string } | null,
    });
  }
  events(runId: string, since: number): WorkflowEvent[] {
    return this.eventLog(runId).slice(Math.max(0, since));
  }
  eventLog(runId: string): readonly WorkflowEvent[] {
    const sig = statSig(this.store.eventsPath(runId));
    return this.logs.get(runId, sig, (prev) => {
      const log = prev ?? { cursor: { offset: 0 }, events: [] };
      const read = this.store.readEventsSince(runId, log.cursor);
      if (read.reset) log.events = [];
      for (const ev of read.events) log.events.push(ev);
      log.cursor = read.cursor;
      return log;
    }).events;
  }
  result(runId: string): { has: boolean; value: unknown } {
    const has = this.store.hasResult(runId);
    return { has, value: has ? this.store.readResult(runId) : undefined };
  }
  agentResults(runId: string): AgentResultRecord[] {
    return this.store.listAgentResults(runId);
  }
  agentResult(runId: string, agentId: number): AgentResultRecord | null {
    return this.store.readAgentResult(runId, agentId);
  }
  agentDiff(runId: string, agentId: number): string | null {
    const path = this.store.agentDiffPath(runId, agentId);
    return existsSync(path) ? path : null;
  }
  control(runId: string, action: string): void {
    // resume clears the control file by writing a benign "running" request; the
    // worker's FileControl treats any non-pause/stop action as "carry on".
    this.store.writeControl(runId, action === "resume" ? "running" : action);
  }
  decide(runId: string, request: CheckpointRequest): void {
    this.store.requestCheckpointDecision(runId, request);
  }

  /**
   * The run's facts, refreshed from whatever changed on disk: status.json is
   * re-read when its signature moved, events.jsonl is read only past the byte
   * cursor and folded onto the cached agents. `listedAt` (the run list's clock)
   * lets a recently checked terminal run skip the stats entirely.
   */
  private facts(runId: string, listedAt?: number): RunFacts {
    let e = this.runs.get(runId);
    if (e && listedAt !== undefined && listedAt < e.trustUntil) return factsOf(e);
    if (!e) {
      e = {
        statusSig: "",
        status: {},
        meta: null,
        eventsSig: "",
        cursor: { offset: 0 },
        fold: new EventFold(),
        trustUntil: 0,
      };
      this.runs.set(runId, e);
    }
    // Stat BEFORE reading: a write racing the read then shows up as a changed
    // signature next time instead of being masked by a too-new one.
    const dir = this.store.runDir(runId);
    const statusSig = statSig(join(dir, "status.json"));
    if (statusSig !== e.statusSig) {
      e.status = this.store.readStatus(runId);
      e.statusSig = statusSig;
    }
    if (e.meta === null) {
      const meta = this.store.readMeta(runId);
      if (Object.keys(meta).length > 0) e.meta = meta;
    }
    const eventsSig = statSig(join(dir, "events.jsonl"));
    if (eventsSig !== e.eventsSig) {
      const read = this.store.readEventsSince(runId, e.cursor);
      if (read.reset) e.fold = new EventFold();
      e.fold.apply(read.events);
      e.cursor = read.cursor;
      e.eventsSig = eventsSig;
    }
    // Trust a finished run's files only once its terminal event is folded:
    // a stop records "stopped" before the aborted agents' failure events land,
    // and caching that half-written picture would show them running for a while.
    e.trustUntil =
      TERMINAL_STATES.has(String(e.status.state)) && e.fold.ended
        ? this.now() + TERMINAL_RECHECK_MS * (0.5 + Math.random())
        : 0;
    return factsOf(e);
  }
}

function factsOf(e: RunEntry): RunFacts {
  return { status: e.status, meta: e.meta ?? {}, fold: e.fold };
}
