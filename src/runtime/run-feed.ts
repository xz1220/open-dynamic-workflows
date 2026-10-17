/**
 * The live feed behind `GET /api/stream` (L5): the SSE client pool, and the
 * loop that pushes the merged run list to it whenever the list changes.
 *
 * The list is recomputed when the runs root changes and on a 1s tick as a
 * floor (fs.watch recursion is platform-spotty, and liveness — a dead worker
 * pid, a Claude run going quiet — changes no file at all). A busy run appends
 * events many times a second, so watch events only schedule a refresh:
 * everything within {@link WATCH_COALESCE_MS} lands as one list computation,
 * not one per append. A frame is pushed only when some run's state, counts,
 * progress or last activity changed. Every callback is guarded: they run
 * outside any request, where a throw would take the whole server down.
 *
 * Clients that open `/api/stream?delta=1` get the full list once and then only
 * `runs-delta` frames — `{ upsert: RunSummary[], remove: runId[] }` — instead
 * of the whole list on every change, which matters once a runs root holds
 * thousands of runs (a full frame is ~500 bytes per run). Deltas are
 * idempotent, so every delta client can share one baseline; when most of the
 * list changed at once a full `runs` frame is sent instead.
 */

import { watch, type FSWatcher } from "node:fs";
import type { ServerResponse } from "node:http";

import { guarded, logServeError, openStream, safeWrite } from "./http-util.js";
import { allSummaries, type RunSource } from "./run-source.js";
import type { RunSummary } from "./runs-view.js";

/** Liveness floor for the run list (and the fallback when fs.watch is unavailable). */
const TICK_MS = 1000;
/** Watch events within this window are folded into one run-list refresh. */
const WATCH_COALESCE_MS = 150;
/** The chat store's file (and its temp files), relative to the watched runs root. */
const CHAT_FILE_RE = /^_chat[\\/]sessions\.json/;

export class RunFeed {
  private readonly clients = new Set<ServerResponse>();
  /** Clients that asked for `runs-delta` frames after their first full list. */
  private readonly deltaClients = new Set<ServerResponse>();
  /** runId → change signature of the list the delta clients were last sent. */
  private last = new Map<string, string>();
  /** The coarser signature full-list clients are pushed on (state, counts, progress). */
  private lastFullSig = "";
  private tick: NodeJS.Timeout | null = null;
  private pending: NodeJS.Timeout | null = null;
  private watcher: FSWatcher | null = null;

  constructor(
    private readonly runsRoot: string,
    private readonly sources: RunSource[],
  ) {}

  start(): void {
    this.tick = setInterval(() => guarded("run list refresh", () => this.push()), TICK_MS);
    this.tick.unref?.();
    try {
      const watcher = watch(this.runsRoot, { recursive: true }, (_event, filename) => this.changed(filename));
      // An unhandled 'error' event (the root deleted, EPERM) would crash the
      // process; drop the watcher instead — the tick still covers us.
      watcher.on("error", (err) => {
        logServeError("runs watcher stopped", err);
        watcher.close();
        if (this.watcher === watcher) this.watcher = null;
      });
      this.watcher = watcher;
    } catch {
      this.watcher = null; // no recursive watch on this platform — the tick covers us
    }
  }

  /** Stop refreshing and end every client stream. */
  stop(): void {
    if (this.tick) clearInterval(this.tick);
    if (this.pending) clearTimeout(this.pending);
    this.tick = this.pending = null;
    this.watcher?.close();
    this.watcher = null;
    for (const c of [...this.clients, ...this.deltaClients]) c.end();
    this.clients.clear();
    this.deltaClients.clear();
  }

  /**
   * Serve `GET /api/stream`: register the client and send it the current list.
   * `delta` clients then receive `runs-delta` frames instead of full lists.
   */
  open(res: ServerResponse, opts: { delta?: boolean } = {}): void {
    // Bring everyone already connected up to date first, so the baseline the
    // deltas are computed against is exactly the list this client receives —
    // otherwise a change undone (or a run removed) before the next push would
    // never reach it.
    guarded("run list refresh", () => this.push());
    const runs = allSummaries(this.sources);
    this.last = signatures(runs);
    this.lastFullSig = fullSignature(runs);
    openStream(res, opts.delta ? this.deltaClients : this.clients, frame("runs", runs));
  }

  /** Push one event to every client (e.g. `chat` change notifications). */
  broadcast(event: string, data: unknown): void {
    const f = frame(event, data);
    for (const c of this.clients) safeWrite(c, f, this.clients);
    for (const c of this.deltaClients) safeWrite(c, f, this.deltaClients);
  }

  private changed(filename: string | Buffer | null): void {
    // The chat store lives under the runs root but never changes the run list.
    if (filename && CHAT_FILE_RE.test(String(filename))) return;
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      guarded("run list refresh", () => this.push());
    }, WATCH_COALESCE_MS);
    this.pending.unref?.();
  }

  private push(): void {
    if (this.clients.size === 0 && this.deltaClients.size === 0) return;
    const runs = allSummaries(this.sources);
    // Full-list clients keep the original contract: a new list only when a
    // run's state, counts or progress moved — never per event at 1MB a frame.
    const fullSig = fullSignature(runs);
    if (this.clients.size && fullSig !== this.lastFullSig) {
      const f = frame("runs", runs);
      for (const c of this.clients) safeWrite(c, f, this.clients);
    }
    this.lastFullSig = fullSig;
    const next = signatures(runs);
    const upsert = runs.filter((r) => this.last.get(r.runId) !== next.get(r.runId));
    const remove = [...this.last.keys()].filter((id) => !next.has(id));
    if (upsert.length === 0 && remove.length === 0) return;
    this.last = next;
    if (this.deltaClients.size) {
      const f =
        upsert.length + remove.length > runs.length / 2 ? frame("runs", runs) : frame("runs-delta", { upsert, remove });
      for (const c of this.deltaClients) safeWrite(c, f, this.deltaClients);
    }
  }
}

function fullSignature(runs: RunSummary[]): string {
  // The checkpoint a waiting run shows changes without its state moving.
  return JSON.stringify(runs.map((r) => [r.runId, r.state, r.counts, r.progress, r.waiting?.checkpointId ?? null]));
}

/** What a delta client needs re-sent when it changes: state, counts, progress, activity. */
function signatures(runs: RunSummary[]): Map<string, string> {
  return new Map(
    runs.map((r) => [r.runId, JSON.stringify([r.state, r.stale, r.counts, r.progress, r.lastActivityTs])]),
  );
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
