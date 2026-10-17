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
 *   GET  /api/runs/:id/events    raw events; ?since=N (event index) skips the first N,
 *                                ?tail=M keeps only the last M; header x-total-count
 *                                is the run's event count (the next ?since=)
 *
 * The polled GETs (/api/runs, /api/runs/:id, …/events, …/result) carry an ETag
 * and answer If-None-Match with 304.
 *   GET  /api/stream             text/event-stream; pushes the run list on change
 *   POST /api/runs/:id/control   { action: pause|resume|stop } → writeControl
 *
 * Security: binds 127.0.0.1 by default. The run list aggregates every project's
 * runs (prompts, results) — both ODW's own runs root AND, with the default
 * `claudeJobsScope: "all"`, Claude Code's `~/.claude/projects` across every repo
 * — so exposing it off-loopback is opt-in. The Claude side is strictly read-only
 * (control is refused) and surfaces a run's metadata + author `log()` lines +
 * final result, NOT raw agent transcripts; narrow it with `claudeJobsScope:
 * "project"` to the served repo + its worktrees.
 *
 * Write-path security: POST routes can drive local state, so the realistic
 * threat is a hostile web page reaching loopback through the user's browser,
 * not the local machine (local processes can already run code). Defenses:
 *   1. writeGuard on every POST: Content-Type must be application/json (kills
 *      CORS "simple requests") and, when an Origin header is present, it must be
 *      same-origin.
 *   2. Host-header allowlist on loopback binds (DNS-rebinding guard, all routes).
 *   3. Off-loopback binds (--host) refuse every write with 409.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

import {
  listAdapters,
  loadConfig,
  resolveClaudeProjectsRoot,
  resolveClaudeWorkflowsRoot,
  resolveWorkflowsRoot,
} from "../adapters/config.js";
import type { Config } from "../adapters/types.js";
import { DASHBOARD_HTML } from "../dashboard.generated.js";
import type { WorkflowEvent } from "../events.js";
import { ChatHost, type ChatTurnRunner } from "./chat-host.js";
import { ClaudeRunSource } from "./claude-run-source.js";
import {
  guarded,
  isAllowedHost,
  isLoopbackBind,
  jsonBodyOrReply,
  logServeError,
  openStream,
  safeWrite,
  sendJson,
  sendJsonCached,
  writeGuard,
} from "./http-util.js";
import { OdwRunSource } from "./odw-run-source.js";
import { allSummaries, sourceForRun, type RunSource } from "./run-source.js";
import { RunStore } from "./run-store.js";
import { listWorkflowSummaries, workflowDetail } from "./workflows-view.js";

export type { ChatTurnRequest, ChatTurnRunner } from "./chat-host.js";

export interface ServeOptions {
  store: RunStore;
  port?: number;
  host?: string;
  /** Anchors the project-local `.odw/workflows` lookup for /api/workflows. */
  cwd?: string;
  /** Config whose `workflowsRoot` is the global managed dir. Defaults to loadConfig(null). */
  config?: Config;
  /** Path of the config file behind `config`, forwarded to launched runs so a
   *  worker loads the SAME adapters/settings the server validated against. */
  configPath?: string | null;
  /** Root of Claude Code's per-project run store. Defaults to `~/.claude/projects`. */
  claudeProjectsRoot?: string | null;
  /** Which Claude runs to surface: "all" projects (default) or just the served repo + worktrees. */
  claudeJobsScope?: "all" | "project";
  /** Test seam for Chat Host's Codex-backed assistant stream. Defaults to `codex exec`. */
  chatRunner?: ChatTurnRunner;
}

export interface ServeHandle {
  url: string;
  port: number;
  host: string;
  close(): Promise<void>;
}

const DEFAULT_PORT = 4317;
const DEFAULT_HOST = "127.0.0.1";
const CONTROL_ACTIONS = new Set(["pause", "resume", "stop"]);
/** Liveness floor for the SSE run list (and the fallback when fs.watch is unavailable). */
const TICK_MS = 1000;
/** Watch events within this window are folded into one run-list refresh. */
const WATCH_COALESCE_MS = 150;
/** The chat store's file (and its temp files), relative to the watched runs root. */
const CHAT_FILE_RE = /^_chat[\\/]sessions\.json/;

/** Start the dashboard server. Resolves once it is listening. */
export function startServer(options: ServeOptions): Promise<ServeHandle> {
  const { store } = options;
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const cwd = options.cwd ?? process.cwd();
  const config = options.config ?? loadConfig(null);
  const configPath = options.configPath ?? null;
  const sources: RunSource[] = [
    new OdwRunSource(store),
    // Default scope "all": the observatory aggregates every project's Claude runs,
    // mirroring how the global runs root already aggregates ODW runs. The scope can
    // be narrowed to the served repo + its worktrees via claudeJobsScope.
    new ClaudeRunSource({
      projectsRoot: options.claudeProjectsRoot ?? resolveClaudeProjectsRoot(),
      cwd,
      scope: options.claudeJobsScope ?? config.settings.claudeJobsScope,
    }),
  ];
  const clients = new Set<ServerResponse>();
  const chatHost = new ChatHost({
    store,
    sources,
    cwd,
    config,
    configPath,
    runner: options.chatRunner,
    notify: (sessionId) => broadcastChat(clients, sessionId),
  });

  const server = createServer((req, res) => {
    handle(req, res, { sources, store, chatHost, clients, cwd, config, configPath, boundHost: host }).catch((err) => {
      try {
        sendJson(res, 500, { error: (err as Error).message ?? "internal error" });
      } catch {
        /* response already gone */
      }
    });
  });

  // Push the run list to every SSE client when the runs root changes, and on a
  // 1s tick as a floor (fs.watch recursion is platform-spotty, and liveness —
  // a dead worker pid, a Claude run going quiet — changes no file at all).
  // A busy run appends events many times a second, so watch events only
  // schedule a refresh: everything within WATCH_COALESCE_MS lands as one list
  // computation, not one per append. Every callback is guarded: these run
  // outside any request, where a throw would take the whole server down.
  let lastSig = "";
  const pushRuns = () => {
    if (clients.size === 0) return;
    const runs = allSummaries(sources);
    const sig = JSON.stringify(runs.map((r) => [r.runId, r.state, r.counts, r.progress]));
    if (sig === lastSig) return;
    lastSig = sig;
    const frame = `event: runs\ndata: ${JSON.stringify(runs)}\n\n`;
    for (const c of clients) safeWrite(c, frame, clients);
  };
  const tick = setInterval(() => guarded("run list refresh", pushRuns), TICK_MS);
  tick.unref?.();
  let pending: NodeJS.Timeout | null = null;
  const onRunsChanged = (_event: string, filename: string | Buffer | null) => {
    // The chat store lives under the runs root but never changes the run list.
    if (filename && CHAT_FILE_RE.test(String(filename))) return;
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      guarded("run list refresh", pushRuns);
    }, WATCH_COALESCE_MS);
    pending.unref?.();
  };
  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(store.root, { recursive: true }, onRunsChanged);
    // An unhandled 'error' event (the root deleted, EPERM) would crash the
    // process; drop the watcher instead — the tick still covers us.
    watcher.on("error", (err) => {
      logServeError("runs watcher stopped", err);
      watcher?.close();
      watcher = null;
    });
  } catch {
    watcher = null; // no recursive watch on this platform — the 1s tick covers us
  }
  chatHost.start();

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
        close: () => {
          clearInterval(tick);
          if (pending) clearTimeout(pending);
          watcher?.close();
          chatHost.stop();
          return closeServer(server, clients);
        },
      });
    });
  });
}

function closeServer(server: Server, clients: Set<ServerResponse>): Promise<void> {
  for (const c of clients) c.end();
  clients.clear();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

interface HandleContext {
  sources: RunSource[];
  store: RunStore;
  chatHost: ChatHost;
  clients: Set<ServerResponse>;
  cwd: string;
  config: Config;
  configPath: string | null;
  /** The address the server was bound to (drives the write/Host policy). */
  boundHost: string;
}

async function handle(req: IncomingMessage, res: ServerResponse, ctx: HandleContext): Promise<void> {
  const { sources, store, chatHost, clients, cwd, config, configPath, boundHost } = ctx;
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  try {
    // DNS-rebinding guard: on a loopback bind, a browser reaching this server
    // through a hostile DNS name carries that name in Host — refuse it outright
    // (reads too: the run list is sensitive). Off-loopback binds are explicit
    // opt-ins to remote reads, so the allowlist does not apply there.
    if (!isAllowedHost(boundHost, req.headers.host)) {
      sendJson(res, 403, { error: `unexpected Host '${req.headers.host}' — refusing (DNS rebinding guard)` });
      return;
    }

    if (method === "GET" && (path === "/" || path === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(DASHBOARD_HTML);
      return;
    }
    if (method === "GET" && path === "/api/runs") {
      sendJsonCached(req, res, allSummaries(sources));
      return;
    }
    if (method === "GET" && path === "/api/stream") {
      openStream(res, clients, `event: runs\ndata: ${JSON.stringify(allSummaries(sources))}\n\n`);
      return;
    }
    if (method === "GET" && path === "/api/capabilities") {
      // The SPA hides local write affordances when writes are refused, so a
      // remotely-viewed off-loopback dashboard shows no dead buttons. Mirrors
      // the writeGuard's loopback-only rule exactly.
      sendJson(res, 200, { writable: isLoopbackBind(boundHost) });
      return;
    }
    if (method === "GET" && path === "/api/settings") {
      sendJson(res, 200, settingsView(store, config, cwd, configPath, boundHost));
      return;
    }
    if (path.startsWith("/api/chat/") && (await chatHost.route(req, res, method, path, boundHost))) return;
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
      // Writes are gated before any run lookup: an off-loopback bind refuses
      // outright (no run-existence oracle), and CSRF posture comes first.
      if (method === "POST" && sub === "/control" && !writeGuard(req, res, boundHost)) return;
      // Route to the source that owns this id (ODW's RunStore, or Claude Code's).
      const src = sourceForRun(sources, runId);
      if (!src) {
        sendJson(res, 404, { error: `no such run: ${runId}` });
        return;
      }
      if (method === "GET" && !sub) {
        const det = src.detail(runId);
        if (!det) {
          sendJson(res, 404, { error: `no such run: ${runId}` });
          return;
        }
        sendJsonCached(req, res, det);
        return;
      }
      if (method === "GET" && sub === "/events") {
        const log = src.eventLog(runId);
        const events = eventsWindow(log, url.searchParams);
        if (!events) {
          sendJson(res, 400, { error: "tail must be a non-negative integer" });
          return;
        }
        // The total is the `since` to pass next time to get only newer events.
        sendJsonCached(req, res, events, { "x-total-count": String(log.length) });
        return;
      }
      if (method === "GET" && sub === "/result") {
        const { has, value } = src.result(runId);
        if (!has) {
          sendJson(res, 404, { error: "no result for this run" });
          return;
        }
        sendJsonCached(req, res, { value });
        return;
      }
      if (method === "POST" && sub === "/control") {
        // A read-only source (Claude) refuses control with a 409 before any work.
        if (src.controlError) {
          sendJson(res, 409, { error: src.controlError });
          return;
        }
        await controlRun(req, res, src, runId);
        return;
      }
    }

    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    sendJson(res, 500, { error: (err as Error).message ?? "internal error" });
  }
}

// --- settings + run control ------------------------------------------------

function settingsView(
  store: RunStore,
  config: Config,
  cwd: string,
  configPath: string | null,
  boundHost: string,
): Record<string, unknown> {
  return {
    cwd,
    configPath,
    runsRoot: store.root,
    writable: isLoopbackBind(boundHost),
    claudeJobsScope: config.settings.claudeJobsScope,
    adapters: listAdapters(config).map((a) => ({
      ...a,
      command: config.adapters[a.name]?.command.join(" ") ?? "",
    })),
    workflowRoots: [
      { provider: "odw", scope: "project", label: ".odw/workflows", path: join(cwd, ".odw", "workflows") },
      { provider: "claude", scope: "project", label: ".claude/workflows", path: join(cwd, ".claude", "workflows") },
      {
        provider: "odw",
        scope: "global",
        label: "~/.odw/workflows",
        path: resolveWorkflowsRoot(config.settings.workflowsRoot),
      },
      {
        provider: "claude",
        scope: "global",
        label: "~/.claude/workflows",
        path: resolveClaudeWorkflowsRoot(config.settings.claudeWorkflowsRoot),
      },
    ],
  };
}

async function controlRun(
  req: IncomingMessage,
  res: ServerResponse,
  src: RunSource,
  runId: string,
): Promise<void> {
  // CSRF posture (Content-Type + same-origin) is enforced by writeGuard upstream.
  const body = await jsonBodyOrReply(req, res);
  if (!body) return;
  const action = typeof body.action === "string" ? body.action : undefined;
  if (!action || !CONTROL_ACTIONS.has(action)) {
    sendJson(res, 400, { error: "action must be one of pause, resume, stop" });
    return;
  }
  // The source applies the action (ODW maps resume→"running" for FileControl).
  src.control(runId, action);
  sendJson(res, 200, { ok: true, runId, action });
}

/**
 * `?since=N&tail=M` over a run's event log: events from index N (lenient, as
 * it always was: junk or negative means 0), then only the last M. Null when
 * `tail` is present but not a non-negative integer.
 */
function eventsWindow(log: readonly WorkflowEvent[], params: URLSearchParams): WorkflowEvent[] | null {
  const since = Math.max(0, Math.floor(Number(params.get("since") ?? "0") || 0));
  const events = log.slice(since);
  const tailParam = params.get("tail");
  if (tailParam === null) return events;
  const tail = Number(tailParam);
  if (tailParam.trim() === "" || !Number.isInteger(tail) || tail < 0) return null;
  return tail === 0 ? [] : events.slice(-tail);
}

function broadcastChat(clients: Set<ServerResponse>, sessionId: string): void {
  if (clients.size === 0) return;
  const frame = `event: chat\ndata: ${JSON.stringify({ sessionId })}\n\n`;
  for (const c of clients) safeWrite(c, frame, clients);
}
