/**
 * The live feed behind `GET /api/stream` (L5): the SSE client pool, and the
 * loop that pushes the merged run list to it whenever the list changes.
 *
 * The list is recomputed when the runs root changes and on a 1s tick as a
 * floor (fs.watch recursion is platform-spotty, and liveness — a dead worker
 * pid, a Claude run going quiet — changes no file at all). A busy run appends
 * events many times a second, so watch events only schedule a refresh:
 * everything within {@link WATCH_COALESCE_MS} lands as one list computation,
 * not one per append. A frame is pushed only when a run's state, counts or
 * progress changed. Every callback is guarded: they run outside any request,
 * where a throw would take the whole server down.
 */

import { watch, type FSWatcher } from "node:fs";
import type { ServerResponse } from "node:http";

import { guarded, logServeError, openStream, safeWrite } from "./http-util.js";
import { allSummaries, type RunSource } from "./run-source.js";

/** Liveness floor for the run list (and the fallback when fs.watch is unavailable). */
const TICK_MS = 1000;
/** Watch events within this window are folded into one run-list refresh. */
const WATCH_COALESCE_MS = 150;
/** The chat store's file (and its temp files), relative to the watched runs root. */
const CHAT_FILE_RE = /^_chat[\\/]sessions\.json/;

export class RunFeed {
  private readonly clients = new Set<ServerResponse>();
  private lastSig = "";
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
    for (const c of this.clients) c.end();
    this.clients.clear();
  }

  /** Serve `GET /api/stream`: register the client and send it the current list. */
  open(res: ServerResponse): void {
    openStream(res, this.clients, frame("runs", allSummaries(this.sources)));
  }

  /** Push one event to every client (e.g. `chat` change notifications). */
  broadcast(event: string, data: unknown): void {
    if (this.clients.size === 0) return;
    const f = frame(event, data);
    for (const c of this.clients) safeWrite(c, f, this.clients);
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
    if (this.clients.size === 0) return;
    const runs = allSummaries(this.sources);
    const sig = JSON.stringify(runs.map((r) => [r.runId, r.state, r.counts, r.progress]));
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    this.broadcast("runs", runs);
  }
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
