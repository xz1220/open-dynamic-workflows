/**
 * The dashboard server (L5): a read-only window onto the run directory.
 *
 * `odw serve` starts a tiny node:http server (zero runtime deps — same promise
 * as the rest of the engine) that folds the run directory through
 * {@link ./runs-view} and serves it as JSON + an SSE live stream, plus the
 * embedded single-page dashboard. It owns no workflow state: every read goes to
 * the same {@link RunStore} the CLI uses, so a run started by `odw run` in any
 * project shows up here with no coupling between the two processes.
 *
 * Endpoints:
 *   GET  /                       the dashboard HTML
 *   GET  /api/runs               [RunSummary] (newest first)
 *   GET  /api/runs/:id           RunDetail
 *   GET  /api/runs/:id/events    raw events (optionally ?since=N for the tail)
 *   GET  /api/stream             text/event-stream; pushes the run list on change
 *   POST /api/runs/:id/control   { action: pause|resume|stop } → writeControl
 *
 * Security: binds 127.0.0.1 by default. The global runs root aggregates every
 * project's runs (prompts, results), so exposing it off-loopback is opt-in.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { statSync, watch, type FSWatcher } from "node:fs";

import { loadConfig } from "../adapters/config.js";
import type { Config } from "../adapters/types.js";
import { DASHBOARD_HTML } from "../dashboard.generated.js";
import { RunStore } from "./run-store.js";
import { detail, summarize, type RunSummary } from "./runs-view.js";
import { listWorkflowSummaries, workflowDetail } from "./workflows-view.js";

export interface ServeOptions {
  store: RunStore;
  port?: number;
  host?: string;
  /** Anchors the project-local `.odw/workflows` lookup for /api/workflows. */
  cwd?: string;
  /** Config whose `workflowsRoot` is the global managed dir. Defaults to loadConfig(null). */
  config?: Config;
}

export interface ServeHandle {
  url: string;
  port: number;
  host: string;
  close(): Promise<void>;
}

const DEFAULT_PORT = 4317;
const DEFAULT_HOST = "127.0.0.1";
const RUN_ID = /^[A-Za-z0-9._-]+$/;
const CONTROL_ACTIONS = new Set(["pause", "resume", "stop"]);

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

/** Start the dashboard server. Resolves once it is listening. */
export function startServer(options: ServeOptions): Promise<ServeHandle> {
  const { store } = options;
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const cwd = options.cwd ?? process.cwd();
  const config = options.config ?? loadConfig(null);
  const cache = new SummaryCache();
  const clients = new Set<ServerResponse>();

  const server = createServer((req, res) => handle(req, res, store, cache, clients, cwd, config));

  // Push the run list to every SSE client when the runs root changes, and on a
  // 1s tick as a floor (fs.watch recursion is platform-spotty; the tick keeps
  // liveness correct everywhere without hammering — folding is cache-gated).
  let watcher: FSWatcher | null = null;
  let lastSig = "";
  const broadcast = (force = false) => {
    if (clients.size === 0) return;
    const runs = cache.list(store);
    const sig = JSON.stringify(runs.map((r) => [r.runId, r.state, r.counts, r.progress]));
    if (!force && sig === lastSig) return;
    lastSig = sig;
    const frame = `event: runs\ndata: ${JSON.stringify(runs)}\n\n`;
    for (const c of clients) safeWrite(c, frame, clients);
  };
  const tick = setInterval(() => broadcast(false), 1000);
  tick.unref?.();
  try {
    watcher = watch(store.root, { recursive: true }, () => broadcast(false));
  } catch {
    watcher = null; // no recursive watch on this platform — the 1s tick covers us
  }

  return new Promise<ServeHandle>((resolve, reject) => {
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`port ${port} is already in use — try \`odw serve --port <n>\``));
      } else {
        reject(err);
      }
    });
    server.listen(port, host, () => {
      const addr = server.address();
      const boundPort = typeof addr === "object" && addr ? addr.port : port;
      const shown = host === "0.0.0.0" || host === "::" ? "localhost" : host;
      resolve({
        url: `http://${shown}:${boundPort}`,
        port: boundPort,
        host,
        close: () => closeServer(server, clients, tick, watcher),
      });
    });
  });
}

function closeServer(
  server: Server,
  clients: Set<ServerResponse>,
  tick: NodeJS.Timeout,
  watcher: FSWatcher | null,
): Promise<void> {
  clearInterval(tick);
  watcher?.close();
  for (const c of clients) c.end();
  clients.clear();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

function handle(
  req: IncomingMessage,
  res: ServerResponse,
  store: RunStore,
  cache: SummaryCache,
  clients: Set<ServerResponse>,
  cwd: string,
  config: Config,
): void {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  try {
    if (method === "GET" && (path === "/" || path === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(DASHBOARD_HTML);
      return;
    }
    if (method === "GET" && path === "/api/runs") {
      sendJson(res, 200, cache.list(store));
      return;
    }
    if (method === "GET" && path === "/api/stream") {
      openStream(res, store, cache, clients);
      return;
    }
    if (method === "GET" && path === "/api/workflows") {
      sendJson(res, 200, listWorkflowSummaries(cwd, config, store));
      return;
    }
    const wfMatch = path.match(/^\/api\/workflows\/([^/]+)$/);
    if (method === "GET" && wfMatch) {
      const name = decodeURIComponent(wfMatch[1]!);
      // Optional ?provider= disambiguates a cross-provider name collision (so a
      // shadowed Claude workflow's source is reachable); ignored if not odw|claude.
      const p = url.searchParams.get("provider");
      const provider = p === "odw" || p === "claude" ? p : undefined;
      const det = workflowDetail(cwd, config, store, name, provider);
      if (!det) {
        sendJson(res, 404, { error: `no such workflow: ${name}` });
        return;
      }
      sendJson(res, 200, det);
      return;
    }

    const runMatch = path.match(/^\/api\/runs\/([^/]+)(\/events|\/control|\/result)?$/);
    if (runMatch) {
      const runId = decodeURIComponent(runMatch[1]!);
      const sub = runMatch[2];
      if (!RUN_ID.test(runId) || !store.exists(runId)) {
        sendJson(res, 404, { error: `no such run: ${runId}` });
        return;
      }
      if (method === "GET" && !sub) {
        sendJson(res, 200, detail(store, runId));
        return;
      }
      if (method === "GET" && sub === "/events") {
        const since = Number(url.searchParams.get("since") ?? "0") || 0;
        sendJson(res, 200, store.readEvents(runId).slice(Math.max(0, since)));
        return;
      }
      if (method === "GET" && sub === "/result") {
        if (!store.hasResult(runId)) {
          sendJson(res, 404, { error: "no result for this run" });
          return;
        }
        sendJson(res, 200, { value: store.readResult(runId) });
        return;
      }
      if (method === "POST" && sub === "/control") {
        controlRun(req, res, store, runId);
        return;
      }
    }

    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    sendJson(res, 500, { error: (err as Error).message ?? "internal error" });
  }
}

function openStream(
  res: ServerResponse,
  store: RunStore,
  cache: SummaryCache,
  clients: Set<ServerResponse>,
): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  clients.add(res);
  // Heartbeat so proxies/clients don't time the idle connection out.
  const beat = setInterval(() => safeWrite(res, ": ping\n\n", clients), 15000);
  beat.unref?.();
  const cleanup = () => {
    clearInterval(beat);
    clients.delete(res);
  };
  res.on("close", cleanup);
  res.on("error", cleanup); // a socket error must not become an uncaught throw
  safeWrite(res, ": connected\n\n", clients);
  safeWrite(res, `event: runs\ndata: ${JSON.stringify(cache.list(store))}\n\n`, clients);
}

/** Write to an SSE client; on failure drop it from the pool. Never throws. */
function safeWrite(res: ServerResponse, data: string, clients: Set<ServerResponse>): void {
  try {
    res.write(data);
  } catch {
    clients.delete(res);
    try {
      res.end();
    } catch {
      /* already torn down */
    }
  }
}

function controlRun(
  req: IncomingMessage,
  res: ServerResponse,
  store: RunStore,
  runId: string,
): void {
  // CSRF: this endpoint mutates a run and has no auth. Require a JSON content-type
  // and a same-origin (or absent) Origin so a cross-site page can't drive it with
  // a CORS "simple request" — matters when the user opts into an off-loopback bind.
  if (!String(req.headers["content-type"] ?? "").includes("application/json")) {
    sendJson(res, 415, { error: "control requires Content-Type: application/json" });
    return;
  }
  const origin = req.headers.origin;
  if (origin) {
    let sameOrigin = false;
    try {
      sameOrigin = new URL(origin).host === req.headers.host;
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin) {
      sendJson(res, 403, { error: "cross-origin control requests are rejected" });
      return;
    }
  }

  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 4096) req.destroy(); // control payloads are tiny
  });
  req.on("end", () => {
    let action: string | undefined;
    try {
      action = JSON.parse(body || "{}").action;
    } catch {
      action = undefined;
    }
    if (!action || !CONTROL_ACTIONS.has(action)) {
      sendJson(res, 400, { error: "action must be one of pause, resume, stop" });
      return;
    }
    // resume clears the control file by writing a benign "running" request; the
    // worker's FileControl treats any non-pause/stop action as "carry on".
    store.writeControl(runId, action === "resume" ? "running" : action);
    sendJson(res, 200, { ok: true, runId, action });
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}
