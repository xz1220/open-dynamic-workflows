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
import { readNotes, type Note } from "../notes.js";
import type { Redactor } from "../redact.js";
import { SigCache, statSig } from "./fs-util.js";
import { detailFrom, EventFold, summaryFrom, type RunDetail, type RunFacts, type RunSummary } from "./runs-view.js";
import { pulledRunRefusal } from "./remote.js";
import type { RunSource } from "./run-source.js";
import { TERMINAL_STATES, type EventsCursor, type RunStore } from "./run-store.js";
import { TranscriptLog, transcriptPage, type TranscriptPage } from "./transcript-view.js";

/** Full event streams kept in memory: the runs being viewed / tailed, not every run. */
const EVENT_LOGS_KEPT = 64;
/** Agent transcripts kept in memory, normalized: the ones being viewed. */
const TRANSCRIPTS_KEPT = 16;
/**
 * A terminal run never changes again (the worker writes its last event before
 * the terminal status), so the run list trusts its cached facts for a while
 * instead of stat'ing two files per run per tick — with thousands of finished
 * runs those stats ARE the list's cost. Re-checked every ~30s (jittered, so the
 * re-checks spread out) in case something rewrites a finished run by hand;
 * detail() and summary() always re-check.
 *
 * A run's `args` are the user's data, and may hold a token: what a detail
 * serves of them has its token shapes redacted (an ODW extension; see
 * ../redact) and says so with `argsRedacted: true`. meta.json keeps them as
 * given — `odw rerun` and `odw resume` start the new run with the originals.
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
  /** The most recently read agent transcripts, read on as they grow (LRU). */
  private readonly transcripts = new SigCache<TranscriptLog>(TRANSCRIPTS_KEPT);
  private readonly now: () => number;
  private readonly redactor: Redactor | undefined;

  constructor(
    private readonly store: RunStore,
    opts: {
      /** Injectable clock for tests (ms). */
      now?: () => number;
      /** What redacts the `args` a detail serves (ODW extension); absent: they are served as given. */
      redactor?: Redactor;
    } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.redactor = opts.redactor;
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
    const detail = detailFrom(runId, this.facts(runId), {
      hasResult: this.store.hasResult(runId),
      error: this.store.readError(runId) as { error?: string; stack?: string } | null,
    });
    return this.redactor ? servedArgs(detail, this.redactor) : detail;
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
  notes(runId: string): Note[] {
    return readNotes(this.store.runDir(runId));
  }
  agentTranscript(runId: string, agentId: number, since: number): TranscriptPage | null {
    const path = this.store.agentTranscriptPaths(runId, agentId).transcript;
    // A replayed agent ran no CLI: it has no transcript, and the page says why.
    const replayed = this.facts(runId).fold.agents.some((a) => a.agentId === agentId && a.cached);
    // Stat BEFORE reading, as for the facts: a write racing the read is caught next time.
    const sig = statSig(path);
    if (sig === "-") return replayed ? transcriptPage([], since, false, true) : null;
    const log = this.transcripts.get(`${runId}\u0000${agentId}`, sig, (prev) => {
      const next = prev ?? new TranscriptLog(path);
      next.update();
      return next;
    });
    return log.page(since, replayed);
  }
  runControlError(runId: string): string | null {
    // A pulled run (ODW extension; see ./remote) goes on over there: its copy here is a snapshot.
    return pulledRunRefusal(this.store.readMeta(runId), runId, "approve|reject|pause|stop|resume");
  }
  control(runId: string, action: string): void {
    // Written as `odw resume` writes it: the worker's FileControl treats any
    // non-pause/stop action as "carry on", and a run paused for a spent quota
    // (quotaWait) hears "resume" as "go on now" — the dashboard's Resume now.
    this.store.writeControl(runId, action);
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

/** A detail as served: its `args` with their token shapes redacted, and marked, when they held any (ODW extension). */
export function servedArgs(detail: RunDetail, redactor: Redactor): RunDetail {
  const kept = redactor.shapes.record({ args: detail.args });
  return "redacted" in kept ? { ...detail, args: kept.args, argsRedacted: true } : detail;
}

function factsOf(e: RunEntry): RunFacts {
  return { status: e.status, meta: e.meta ?? {}, fold: e.fold };
}
