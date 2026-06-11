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
 *   GET  /api/adapters           [AdapterListing] — the Launch view's agent picker
 *   POST /api/generate           { task, adapter?, source? } → { runId } (generation run)
 *   POST /api/runs               { script | name, args?, adapter?, source? } → { runId }
 *   POST /api/workflows          { name, source, scope, projectDir? } → { path } (save)
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
 * Write-path security (launch.md §3.5): POST /api/runs accepts inline scripts —
 * an HTTP handle on "drive a local coding agent" — so the realistic threat is a
 * hostile web page reaching loopback through the user's browser, not the local
 * machine (local processes can already run code). Defenses:
 *   1. writeGuard on every POST: Content-Type must be application/json (kills
 *      CORS "simple requests") and, when an Origin header is present, it must be
 *      same-origin.
 *   2. Host-header allowlist on loopback binds (DNS-rebinding guard, all routes).
 *   3. Off-loopback binds (--host) refuse every write with 409 — the dashboard
 *      can be viewed remotely, the launch pad cannot; token auth is a future
 *      opt-in gate.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  listAdapters,
  loadConfig,
  resolveClaudeProjectsRoot,
  resolveWorkflowsRoot,
} from "../adapters/config.js";
import type { Config } from "../adapters/types.js";
import { DASHBOARD_HTML } from "../dashboard.generated.js";
import { loadWorkflowScript } from "../loader.js";
import { SKILL_MD } from "../skill.generated.js";
import { GENERATE_WORKFLOW_SOURCE, PATTERNS_DIGEST } from "../workflows/generate-workflow.js";
import { ClaudeRunSource } from "./claude-run-source.js";
import { startRun, startRunFromSource } from "./launcher.js";
import { OdwRunSource } from "./odw-run-source.js";
import type { RunSource } from "./run-source.js";
import { RunStore } from "./run-store.js";
import type { RunSummary } from "./runs-view.js";
import { listWorkflowSummaries, workflowDetail } from "./workflows-view.js";
import { isValidWorkflowName } from "../workflows/resolve.js";

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
/** Body cap for write endpoints; inline scripts are the largest legitimate payload. */
const MAX_BODY_BYTES = 512 * 1024;

const LOOPBACK_BINDS = new Set(["127.0.0.1", "localhost", "::1"]);
const LOOPBACK_HOST_NAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Whether the server was bound to a loopback address (the default). */
function isLoopbackBind(host: string): boolean {
  return LOOPBACK_BINDS.has(host);
}

/** The hostname part of a Host header, with any port stripped ([::1]:p safe). */
function hostHeaderName(header: string): string {
  const h = header.trim();
  if (h.startsWith("[")) return h.replace(/\]:\d+$/, "]"); // [::1]:4317 → [::1]
  return h.replace(/:\d+$/, "");
}

/**
 * The write-path gate shared by every POST (launch.md §3.5). Returns true when
 * the request may proceed; otherwise the response has been written.
 */
function writeGuard(req: IncomingMessage, res: ServerResponse, boundHost: string): boolean {
  if (!isLoopbackBind(boundHost)) {
    sendJson(res, 409, { error: "writes are loopback-only; token auth is a future opt-in" });
    return false;
  }
  // Compare the MIME *essence* (type/subtype before any ";" parameters), not a
  // substring: `text/plain; x=application/json` is a CORS "simple request" and
  // must NOT pass, while `application/json; charset=utf-8` must.
  const essence = String(req.headers["content-type"] ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  if (essence !== "application/json") {
    sendJson(res, 415, { error: "write requests require Content-Type: application/json" });
    return false;
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
      sendJson(res, 403, { error: "cross-origin write requests are rejected" });
      return false;
    }
  }
  return true;
}

/**
 * Read and JSON-parse a request body. Resolves `undefined` on invalid/empty
 * JSON OR when the body exceeds {@link MAX_BODY_BYTES} (the caller turns that
 * into a 400). Settling exactly once is guaranteed even on `destroy()`, whose
 * abort emits neither `end` nor `error` — a `close` listener catches it, so the
 * awaiting handler never hangs and the oversized buffer is dropped.
 */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolvePromise) => {
    let body = "";
    let settled = false;
    const settle = (value: Record<string, unknown> | undefined): void => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    req.on("data", (chunk) => {
      if (settled) return;
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        settle(undefined); // too large → caller responds 400; stop buffering
        req.destroy();
      }
    });
    req.on("error", () => settle(undefined));
    req.on("close", () => settle(undefined)); // covers destroy() with no error
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body || "{}") as unknown;
        settle(
          parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : undefined,
        );
      } catch {
        settle(undefined);
      }
    });
  });
}

/** Every source's summaries, merged and sorted newest-first (the unified run list). */
function allSummaries(sources: RunSource[]): RunSummary[] {
  return sources.flatMap((s) => s.listSummaries()).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

/** The source that owns + has this run, or null. Ids are disjoint, so at most one matches. */
function sourceForRun(sources: RunSource[], runId: string): RunSource | null {
  return sources.find((s) => s.owns(runId) && s.exists(runId)) ?? null;
}

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

  const server = createServer((req, res) => {
    handle(req, res, { sources, store, clients, cwd, config, configPath, boundHost: host }).catch((err) => {
      try {
        sendJson(res, 500, { error: (err as Error).message ?? "internal error" });
      } catch {
        /* response already gone */
      }
    });
  });

  // Push the run list to every SSE client when the runs root changes, and on a
  // 1s tick as a floor (fs.watch recursion is platform-spotty; the tick keeps
  // liveness correct everywhere without hammering — folding is cache-gated).
  let watcher: FSWatcher | null = null;
  let lastSig = "";
  const broadcast = (force = false) => {
    if (clients.size === 0) return;
    const runs = allSummaries(sources);
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

interface HandleContext {
  sources: RunSource[];
  store: RunStore;
  clients: Set<ServerResponse>;
  cwd: string;
  config: Config;
  configPath: string | null;
  /** The address the server was bound to (drives the write/Host policy). */
  boundHost: string;
}

async function handle(req: IncomingMessage, res: ServerResponse, ctx: HandleContext): Promise<void> {
  const { sources, store, clients, cwd, config, configPath, boundHost } = ctx;
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  try {
    // DNS-rebinding guard: on a loopback bind, a browser reaching this server
    // through a hostile DNS name carries that name in Host — refuse it outright
    // (reads too: the run list is sensitive). Off-loopback binds are explicit
    // opt-ins to remote reads, so the allowlist does not apply there.
    if (isLoopbackBind(boundHost)) {
      const header = req.headers.host;
      if (header && !LOOPBACK_HOST_NAMES.has(hostHeaderName(header))) {
        sendJson(res, 403, { error: `unexpected Host '${header}' — refusing (DNS rebinding guard)` });
        return;
      }
    }

    if (method === "GET" && (path === "/" || path === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(DASHBOARD_HTML);
      return;
    }
    if (method === "GET" && path === "/api/runs") {
      sendJson(res, 200, allSummaries(sources));
      return;
    }
    if (method === "GET" && path === "/api/stream") {
      openStream(res, sources, clients);
      return;
    }
    if (method === "GET" && path === "/api/adapters") {
      sendJson(res, 200, listAdapters(config));
      return;
    }
    if (method === "GET" && path === "/api/capabilities") {
      // The SPA hides write affordances (Launch form, Run/Save/Stop) when writes
      // are refused, so a remotely-viewed off-loopback dashboard shows no dead
      // buttons. Mirrors the writeGuard's loopback-only rule exactly.
      sendJson(res, 200, { writable: isLoopbackBind(boundHost) });
      return;
    }
    if (method === "POST" && path === "/api/generate") {
      if (!writeGuard(req, res, boundHost)) return;
      await postGenerate(req, res, store, config, configPath, cwd);
      return;
    }
    if (method === "POST" && path === "/api/runs") {
      if (!writeGuard(req, res, boundHost)) return;
      await postRuns(req, res, store, config, configPath, cwd);
      return;
    }
    if (method === "POST" && path === "/api/workflows") {
      if (!writeGuard(req, res, boundHost)) return;
      await postWorkflows(req, res, store, config, cwd);
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
      // Writes are gated before any run lookup: an off-loopback bind refuses
      // outright (no run-existence oracle), and CSRF posture comes first.
      if (method === "POST" && sub === "/control" && !writeGuard(req, res, boundHost)) return;
      // Route to the source that owns this id (ODW's RunStore, or Claude Code's).
      const src = RUN_ID.test(runId) ? sourceForRun(sources, runId) : null;
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
        sendJson(res, 200, det);
        return;
      }
      if (method === "GET" && sub === "/events") {
        const since = Number(url.searchParams.get("since") ?? "0") || 0;
        sendJson(res, 200, src.events(runId, since));
        return;
      }
      if (method === "GET" && sub === "/result") {
        const { has, value } = src.result(runId);
        if (!has) {
          sendJson(res, 404, { error: "no result for this run" });
          return;
        }
        sendJson(res, 200, { value });
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

// --- write endpoints (launch.md §3.1) ------------------------------------------

/**
 * A stable, empty, copy-safe scratch directory used when a GUI launch names no
 * source. The serve process's cwd is NOT a safe default: when the desktop app
 * spawns the sidecar, that cwd is `/`, and copy-mode workspace isolation cannot
 * copy `/` into its own temp subdirectory (ERR_FS_CP_EINVAL). An empty scratch
 * dir copies instantly and lets generic workflows (those that don't read the
 * user's files) run; a workflow that must see project files needs an explicit
 * source, which is the correct requirement.
 */
function scratchSourceDir(): string {
  const dir = join(tmpdir(), "odw-launch-scratch");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Shared adapter/source validation for the two launch endpoints. */
function checkLaunchInputs(
  res: ServerResponse,
  config: Config,
  body: Record<string, unknown>,
): { adapter: string | null; source: string } | null {
  const adapter = typeof body.adapter === "string" && body.adapter ? body.adapter : null;
  if (adapter) {
    const known = listAdapters(config).find((a) => a.name === adapter);
    if (!known) {
      sendJson(res, 400, {
        error: `unknown adapter '${adapter}'; available: ${Object.keys(config.adapters).sort().join(", ")}`,
      });
      return null;
    }
    // A configured-but-not-installed adapter would spawn-ENOENT at the first
    // dispatch — fail here with an actionable message instead of a dead run.
    if (!known.installed) {
      sendJson(res, 400, {
        error: `adapter '${adapter}' is configured but its CLI was not found on PATH`,
      });
      return null;
    }
  }
  // An explicit source must exist; an empty one falls back to the scratch dir
  // (NOT the serve cwd, which is `/` under the desktop app).
  if (typeof body.source === "string" && body.source) {
    let isDir = false;
    try {
      isDir = statSync(body.source).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      sendJson(res, 400, { error: `source directory does not exist: ${body.source}` });
      return null;
    }
    return { adapter, source: body.source };
  }
  return { adapter, source: scratchSourceDir() };
}

/** POST /api/generate — start a generation run of the built-in generate-workflow. */
async function postGenerate(
  req: IncomingMessage,
  res: ServerResponse,
  store: RunStore,
  config: Config,
  configPath: string | null,
  cwd: string,
): Promise<void> {
  const body = await readJsonBody(req);
  if (!body) {
    sendJson(res, 400, { error: "body must be a JSON object" });
    return;
  }
  const task = typeof body.task === "string" ? body.task.trim() : "";
  if (!task) {
    sendJson(res, 400, { error: "task must be a non-empty string" });
    return;
  }
  const checked = checkLaunchInputs(res, config, body);
  if (!checked) return;
  const { runId } = startRunFromSource(GENERATE_WORKFLOW_SOURCE, {
    args: { task, dialectDoc: SKILL_MD, patternsDigest: PATTERNS_DIGEST },
    adapter: checked.adapter,
    source: checked.source,
    runsRoot: store.root,
    configPath,
    origin: "launch",
  });
  sendJson(res, 200, { runId });
}

/** POST /api/runs — start a run from inline source or a managed-directory name. */
async function postRuns(
  req: IncomingMessage,
  res: ServerResponse,
  store: RunStore,
  config: Config,
  configPath: string | null,
  cwd: string,
): Promise<void> {
  const body = await readJsonBody(req);
  if (!body) {
    sendJson(res, 400, { error: "body must be a JSON object" });
    return;
  }
  const script = typeof body.script === "string" && body.script ? body.script : null;
  const name = typeof body.name === "string" && body.name ? body.name : null;
  if ((script === null) === (name === null)) {
    sendJson(res, 400, { error: "provide exactly one of 'script' (inline source) or 'name'" });
    return;
  }
  const checked = checkLaunchInputs(res, config, body);
  if (!checked) return;
  // Never hand a known-bad script to a worker: compile first, 400 with the error.
  if (script) {
    try {
      loadWorkflowScript(script, "workflow.js");
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message });
      return;
    }
  }
  try {
    const common = {
      args: body.args,
      adapter: checked.adapter,
      source: checked.source,
      runsRoot: store.root,
      configPath,
      origin: "launch",
    };
    const { runId } = script
      ? startRunFromSource(script, common)
      : startRun(name!, common);
    sendJson(res, 200, { runId });
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    sendJson(res, /no workflow named/.test(message) ? 404 : 400, { error: message });
  }
}

/** POST /api/workflows — save a script into a managed directory (D4: collect). */
async function postWorkflows(
  req: IncomingMessage,
  res: ServerResponse,
  store: RunStore,
  config: Config,
  cwd: string,
): Promise<void> {
  const body = await readJsonBody(req);
  if (!body) {
    sendJson(res, 400, { error: "body must be a JSON object" });
    return;
  }
  // Accept a user-typed filename ("review.js") as the name "review": the run-by-
  // name resolver keys on the stem, so saving the extension would create
  // "review.js.js" that `odw run review` could never find.
  const rawName = typeof body.name === "string" ? body.name.trim() : "";
  const name = rawName.replace(/\.(?:js|mjs|cjs)$/i, "");
  if (!isValidWorkflowName(name)) {
    sendJson(res, 400, { error: "name must use only letters, digits, '.', '_' or '-'" });
    return;
  }
  // The script content comes inline ('source') or from an existing run's
  // archived script ('fromRun') — the Save-to-Workspace path, where the browser
  // has the run id but not the file content.
  let source = typeof body.source === "string" ? body.source : "";
  if (!source && typeof body.fromRun === "string" && body.fromRun) {
    const runId = body.fromRun;
    if (!RUN_ID.test(runId) || !store.exists(runId)) {
      sendJson(res, 404, { error: `no such run: ${runId}` });
      return;
    }
    const script = store.readMeta(runId).script as string | undefined;
    try {
      source = script ? readFileSync(script, "utf8") : "";
    } catch {
      source = "";
    }
    if (!source) {
      sendJson(res, 400, { error: "the run has no readable script to save" });
      return;
    }
  }
  try {
    loadWorkflowScript(source, `${name}.js`);
  } catch (err) {
    sendJson(res, 400, { error: (err as Error).message });
    return;
  }
  const scope = body.scope === "project" ? "project" : "global";
  let projectDir = cwd;
  if (scope === "project" && typeof body.projectDir === "string" && body.projectDir) {
    try {
      if (!statSync(body.projectDir).isDirectory()) throw new Error("not a directory");
    } catch {
      sendJson(res, 400, { error: `projectDir does not exist: ${body.projectDir}` });
      return;
    }
    projectDir = body.projectDir;
  }
  const dir =
    scope === "project"
      ? join(projectDir, ".odw", "workflows")
      : resolveWorkflowsRoot(config.settings.workflowsRoot);
  const target = join(dir, `${name}.js`);
  if (existsSync(target)) {
    sendJson(res, 409, { error: `a workflow named '${name}' already exists at ${target}` });
    return;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(target, source, "utf8");
  sendJson(res, 200, { path: target });
}

function openStream(
  res: ServerResponse,
  sources: RunSource[],
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
  safeWrite(res, `event: runs\ndata: ${JSON.stringify(allSummaries(sources))}\n\n`, clients);
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

async function controlRun(
  req: IncomingMessage,
  res: ServerResponse,
  src: RunSource,
  runId: string,
): Promise<void> {
  // CSRF posture (Content-Type + same-origin) is enforced by writeGuard upstream.
  const body = await readJsonBody(req);
  const action = body && typeof body.action === "string" ? body.action : undefined;
  if (!action || !CONTROL_ACTIONS.has(action)) {
    sendJson(res, 400, { error: "action must be one of pause, resume, stop" });
    return;
  }
  // The source applies the action (ODW maps resume→"running" for FileControl).
  src.control(runId, action);
  sendJson(res, 200, { ok: true, runId, action });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}
