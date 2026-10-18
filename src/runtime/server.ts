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
 *   GET  /                          the dashboard HTML
 *   GET  /api/runs                  [RunSummary], newest first (ODW + Claude Code runs); a run
 *                                   waiting at a checkpoint() names the oldest one as `waiting`
 *   GET  /api/runs/:id              RunDetail
 *   GET  /api/runs/:id/events       raw events (synthesized for Claude runs):
 *                                     ?since=N  skip the first N (N is an event index)
 *                                     ?tail=M   only the last M, after since (400 unless an integer ≥ 0)
 *                                     header x-total-count: the run's event count, i.e. the next ?since=
 *   GET  /api/runs/:id/result       { value } of a finished run; 404 when there is none
 *   GET  /api/runs/:id/agents       [{ agentId, label, phase, adapter, cached, finishedAt }]: the
 *                                   agents whose results are saved so far, by agentId (ODW runs;
 *                                   Claude runs → 404)
 *   GET  /api/runs/:id/agents/:agentId   one completed agent's saved record (the AgentResultRecord
 *                                   in ../journal: value, adapter, attempts, timestamps, cached,
 *                                   sourceRunId), readable while the run is still going; 404 when
 *                                   it has none (still running, failed, a Claude run); 400 unless
 *                                   :agentId is a non-negative integer
 *   GET  /api/runs/:id/agents/:agentId/diff   what an isolated agent changed, as the unified diff
 *                                   kept in the run directory (ODW extension): text/plain; 404 when
 *                                   it kept none (no change, not isolated, a Claude run); the same
 *                                   :agentId check. RunDetail.agents[] carry `changes` and `branch`
 *   GET  /api/runs/:id/agents/:agentId/transcript?since=<i>   what the agent's CLI printed (ODW
 *                                   extension), normalized: { entries, next, more, truncated,
 *                                   replayed } — the entries from index `since` (lenient, as for
 *                                   events), at most 1000; ask again with ?since=next while `more`.
 *                                   An agent replayed by odw resume has none: entries [], replayed
 *                                   true. 404 when it has none (not started, a run from before
 *                                   transcripts or with maxTranscriptBytes 0, a Claude run); the
 *                                   same :agentId check
 *   GET  /api/runs/:id/notes        the run's notes board (ODW extension; see ../notes): [Note] in
 *                                   order — { noteId, ts, by: { agentId, label }, text, kind:
 *                                   note|interface, truncated?, redacted? } — [] when it has none;
 *                                   404 for Claude runs
 *   POST /api/runs/:id/control      { action: pause|resume|stop } (ODW runs; Claude runs → 409)
 *   POST /api/runs/:id/checkpoint   { action: approve|reject, checkpointId?, note?, payload? } answers a
 *                                   waiting checkpoint() (ODW extension) — the one named, else the
 *                                   oldest; → { ok, runId, action, checkpointId }. 409 when that
 *                                   checkpoint (or any) is not waiting, and for Claude runs; 400
 *                                   on a bad body. RunDetail.pendingCheckpoints lists what waits.
 *                                   With approve, `payload` approves an edit of the checkpoint's
 *                                   payload: 413 past 256 KiB of JSON, 400 (with `problems`) off
 *                                   the checkpoint's schema; that route takes bodies to 512 KiB.
 *   GET  /api/activity?limit=N      the Activity view (below)
 *   GET  /api/stream                text/event-stream: `runs` frames (the run list, on change);
 *                                   `?delta=1` → one `runs` frame, then `runs-delta` frames
 *                                   and `chat` frames ({ sessionId }, coalesced per 250ms)
 *   GET  /api/workflows             [WorkflowSummary] from the managed workflow dirs
 *   GET  /api/workflows/:name       WorkflowDetail (?provider=odw|claude picks a shadowed name;
 *                                   a plugin's workflow is `<plugin>:<name>`, provider claude-plugin:<plugin>)
 *   GET  /api/capabilities          { writable, decide }: whether this bind accepts writes, and checkpoint decisions
 *   GET  /api/settings              runtime config summary (adapters, roots, Claude scope, notify)
 *   GET  /api/schedules             [schedule]: `odw schedule list --json`, read only (ODW extension)
 *   GET  /api/compare?a=<run>&b=<run>   RunComparison (./compare): what changed between two ODW
 *                                   runs, as `odw compare --json` prints it (ODW extension); 400
 *                                   unless both are run ids, 404 when either is no ODW run
 *   GET  /api/estimate?workflow=<name>[&sourceHash=<sha256>]   WorkflowEstimate (./estimate): what
 *                                   a run of it is likely to cost and take, from its earlier finished
 *                                   runs, as `odw estimate --json` prints it (ODW extension); matched by
 *                                   `sourceHash`, else the newest run's, then by name; 400 for a bad
 *                                   name or hash
 *   GET  /api/evals                 [EvalReportSummary], newest first: the `odw eval` reports kept
 *                                   under <runsRoot>/_evals/<name>/<id>.json (ODW extension; read only)
 *   GET  /api/evals/:name/:id       one EvalReport (../eval/report), case args token-shape redacted;
 *                                   400 unless name and id are run-id-like, 404 when there is none
 *   *    /api/chat/sessions[/:id[/messages]]   the Chat Host (see ./chat-host)
 *   POST /api/triggers/:name        start the run a signed trigger in the config names (ODW
 *                                   extension; see ./trigger-route): 202 { runId }, 401 on a bad
 *                                   signature, 404 for a name the config lacks. Off loopback too.
 *
 * GET /api/activity?limit=N (default 40, clamped to 1..200; junk → 40) →
 *   { events: Array<WorkflowEvent & { runId, run, adapter, provider }>,
 *     fleet: Record<adapter, runningCount> }
 * `events` merges the last N events of each of the 12 newest runs, newest first
 * by ts, cut to N: `run` is the run's display name, `adapter` the event's adapter
 * (agent events) or null, `provider` "odw" | "claude". `fleet` counts the agents
 * running right now per adapter across active runs (an agent with no recorded
 * adapter counts as "claude" in a Claude Code run, else "unknown").
 *
 * The polled GETs (/api/runs, /api/runs/:id, …/events, …/result, …/agents[/:agentId],
 * …/agents/:agentId/transcript, /api/activity) carry an ETag (with cache-control: no-cache) and answer
 * If-None-Match with 304.
 * Request bodies are capped at 128 KiB (413 past it; 512 KiB for /checkpoint); a malformed %-escape in a
 * path id is a 400.
 *
 * Security: binds 127.0.0.1 by default. The run list aggregates every project's
 * runs (prompts, results) — both ODW's own runs root AND, with the default
 * `claudeJobsScope: "all"`, Claude Code's `~/.claude/projects` across every repo
 * — so exposing it off-loopback is opt-in. The Claude side is strictly read-only
 * (control is refused) and surfaces a run's metadata + author `log()` lines +
 * final result, NOT raw agent transcripts; narrow it with `claudeJobsScope:
 * "project"` to the served repo + its worktrees.
 *
 * What it serves of ODW's runs had its likely secrets redacted when it was
 * written (ODW extension; see ../redact); a run's `args` — and a schedule's —
 * are redacted as they are served (token shapes: they are the user's data),
 * since the run directory keeps them as given for `odw rerun`.
 *
 * Write-path security: POST routes can drive local state, so the realistic
 * threat is a hostile web page reaching loopback through the user's browser,
 * not the local machine (local processes can already run code). Defenses:
 *   1. writeGuard on every POST: Content-Type must be application/json (kills
 *      CORS "simple requests") and, when an Origin header is present, it must be
 *      same-origin.
 *   2. Host-header allowlist on loopback binds (DNS-rebinding guard, all routes).
 *   3. Off-loopback binds (--host) refuse every write with 409 — with a token too
 *      — but for the two narrow decision paths below.
 *
 * Remote checkpoint decisions (ODW extension), the only writes off loopback:
 *   - `--public-url URL`: GET/POST /approve/<token> answers a signed one-time
 *     approve link (see ./approve-route, ./approve-links); the link is its own
 *     credential, so the token gate does not apply there. On a loopback bind
 *     the Host guard also lets the public URL's host through, for that route only.
 *   - `--token-scope approve` (with `--token`): POST /api/runs/:id/checkpoint
 *     passes off loopback too, behind the token and jsonPostGuard;
 *     /api/capabilities says `decide: true`. Control, chat and launches stay refused.
 *
 * Signed triggers (ODW extension; see ./trigger-route): POST /api/triggers/<name>
 * answers a webhook whose signature checks out against the trigger's secret —
 * the signature is its credential, so the Host guard, the token gate and the
 * loopback-only rule do not apply there; only names in the config's
 * `triggers` exist, and each starts only its own workflow, untrusted by default.
 *
 * Remote read-only access (ODW extension; see ./serve-auth): with `token` set
 * (`odw serve --token`), every /api request and the SSE stream need it — a
 * Bearer header, a `?token=` (which sets an HttpOnly SameSite=Strict cookie),
 * or that cookie; 401 without, 429 for an address that sent too many wrong
 * ones. The HTML shell loads without it and shows a "needs a token" screen.
 *
 * A shared bundle (ODW extension; see ./bundle): with `bundle` set, the store
 * is the bundle unpacked into a temp runs root and the server shows that run
 * alone — no Claude Code runs, workflows, schedules or local settings — and
 * refuses every write (409), on loopback too.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";

import {
  listAdapters,
  loadConfig,
  resolveClaudeProjectsRoot,
  resolveClaudeWorkflowsRoot,
  resolveWorkflowsRoot,
  RUN_END_STATES,
} from "../adapters/config.js";
import { commandAt, runTier } from "../adapters/permissions.js";
import type { Config } from "../adapters/types.js";
import { CHECKPOINT_EDIT_MAX_BYTES, checkEdit } from "../checkpoint.js";
import { CHECKPOINT_NOTE_MAX, isCheckpointId } from "../control.js";
import { DASHBOARD_HTML } from "../dashboard.generated.js";
import { redactorFor, type Redactor } from "../redact.js";
import type { WorkflowEvent } from "../events.js";
import type { AgentResultRecord } from "../journal.js";
import { activityLimit, activityView } from "./activity-view.js";
import { ChatHost, type ChatTurnRunner } from "./chat-host.js";
import { ClaudeRunSource } from "./claude-run-source.js";
import { compareRuns, readCompareRun } from "./compare.js";
import { latestSourceHash, loadEstimate } from "./estimate.js";
import { isEvalName } from "../eval/definition.js";
import { listReports, readStoredReport } from "../eval/report.js";
import {
  decodeSegment,
  isAllowedHost,
  isLoopbackBind,
  jsonBodyOrReply,
  jsonPostGuard,
  sendFileCached,
  sendJson,
  sendJsonCached,
  writeGuard,
  logServeError,
} from "./http-util.js";
import { listSchedules, scheduleJson } from "../schedule/command.js";
import type { WorkflowProvider } from "../workflows/resolve.js";
import { webhookOrigin } from "./notify.js";
import { OdwRunSource } from "./odw-run-source.js";
import { RunFeed } from "./run-feed.js";
import { allSummaries, RUN_ID_RE, sourceForRun, type RunSource } from "./run-source.js";
import { RunStore } from "./run-store.js";
import type { BundleInfo } from "./bundle.js";
import { FailureLimiter, TokenGate, type TokenGateOptions } from "./serve-auth.js";
import { announceServe, ensureApproveSecret, parsePublicUrl, withdrawServe } from "./approve-links.js";
import { approveLinksOff, approveRoute, type ApproveRouteContext } from "./approve-route.js";
import { listWorkflowSummaries, workflowDetail } from "./workflows-view.js";
import { TriggerRoute, type TriggerRouteOptions } from "./trigger-route.js";

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
  /** Require this token on every /api request (ODW extension: `odw serve --token`; see ./serve-auth). */
  token?: string | null;
  /** The wrong-token rate limit (tests). */
  authLimit?: TokenGateOptions;
  /** Show a shared bundle, read-only (ODW extension: `odw serve --open FILE.odwrun`): `store` is it unpacked. */
  bundle?: BundleInfo | null;
  /**
   * Answer signed approve links at this base URL (ODW extension: `odw serve
   * --public-url`; see ./approve-links): the server keeps the runs root's
   * link secret and announces itself there, so workers mint links for it.
   */
  publicUrl?: string | null;
  /** Replace the runs root's link secret first: every link minted before stops working (`--rotate-approve-secret`). */
  rotateApproveSecret?: boolean;
  /** What a token lets a remote client do (ODW extension: `--token-scope`): "read" (default), or "approve" — answer checkpoints too. */
  tokenScope?: "read" | "approve";
  /** The bad-link rate limit (tests). */
  approveLimit?: TokenGateOptions;
  /** Seams of the signed-trigger route (tests): how it starts runs, sees them end, reads secrets and the clock. */
  triggerSeams?: Pick<TriggerRouteOptions, "start" | "isActive" | "env" | "now" | "failureLimit" | "log">;
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

/** Start the dashboard server. Resolves once it is listening. */
export function startServer(options: ServeOptions): Promise<ServeHandle> {
  const { store } = options;
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const cwd = options.cwd ?? process.cwd();
  const config = options.config ?? loadConfig(null);
  const configPath = options.configPath ?? null;
  const bundle = options.bundle ?? null;
  // What the server serves of runs' args and keeps of chat sessions has its likely secrets redacted (ODW extension).
  const redactor = redactorFor(config);
  const sources: RunSource[] = [
    new OdwRunSource(store, { redactor }),
    // Default scope "all": the observatory aggregates every project's Claude runs,
    // mirroring how the global runs root already aggregates ODW runs. The scope can
    // be narrowed to the served repo + its worktrees via claudeJobsScope.
    // A shared bundle shows its one run and nothing of this machine's.
    ...(bundle
      ? []
      : [
          new ClaudeRunSource({
            projectsRoot: options.claudeProjectsRoot ?? resolveClaudeProjectsRoot(),
            cwd,
            scope: options.claudeJobsScope ?? config.settings.claudeJobsScope,
          }),
        ]),
  ];
  // The live feed: SSE clients + the run-list push loop (see ./run-feed).
  const feed = new RunFeed(store.root, sources);
  const chatHost = new ChatHost({
    store,
    sources,
    cwd,
    config,
    configPath,
    runner: options.chatRunner,
    notify: (sessionId) => feed.broadcast("chat", { sessionId }),
    redactor,
  });

  // Approve links (ODW extension): the one remote write, a decision on the checkpoint a link names.
  if (options.tokenScope === "approve" && !options.token) throw new Error("--token-scope approve needs --token");
  let approve: ApproveRouteContext | null = null;
  if (options.publicUrl && !bundle) {
    const publicUrl = parsePublicUrl(options.publicUrl);
    if (!publicUrl) throw new Error(`--public-url must be a root http(s) URL (https://host[:port]) with no credentials, path, query or fragment`);
    approve = {
      secret: ensureApproveSecret(store.root, { rotate: options.rotateApproveSecret === true }),
      publicUrl,
      source: sources[0]!,
      runDir: (runId) => store.runDir(runId),
      limiter: new FailureLimiter("bad approve links", options.approveLimit),
    };
  } else if (options.rotateApproveSecret && !bundle) {
    ensureApproveSecret(store.root, { rotate: true });
  }
  // Signed triggers (ODW extension): only when the config names some, and never for a shared bundle.
  const triggers =
    !bundle && Object.keys(config.settings.triggers).length > 0
      ? new TriggerRoute({ triggers: config.settings.triggers, store, cwd, configPath, ...options.triggerSeams })
      : null;
  const ctx: HandleContext = {
    sources, store, chatHost, feed, cwd, config, configPath, boundHost: host, redactor, bundle, gate: null,
    approve, remoteDecide: options.tokenScope === "approve" && !bundle, triggers,
  };
  const server = createServer((req, res) => {
    handle(req, res, ctx).catch((err) => {
      try {
        sendJson(res, 500, { error: (err as Error).message ?? "internal error" });
      } catch {
        /* response already gone */
      }
    });
  });

  feed.start();
  chatHost.start();
  const stopBackground = () => {
    feed.stop();
    chatHost.stop();
  };

  return new Promise<ServeHandle>((resolve, reject) => {
    const onListenError = (err: NodeJS.ErrnoException) => {
      stopBackground(); // a server that never listened must not leave its watcher behind
      if (err.code === "EADDRINUSE") {
        reject(new Error(`port ${port} is already in use — try \`odw serve --port <n>\``));
      } else {
        reject(err);
      }
    };
    server.once("error", onListenError);
    server.listen(port, host, () => {
      // Once listening, an error (EMFILE on accept, …) is logged, not fatal:
      // the listen-failure handler must not tear the live feed down.
      server.off("error", onListenError);
      server.on("error", (err) => logServeError("server error", err));
      const addr = server.address();
      const boundPort = typeof addr === "object" && addr ? addr.port : port;
      // The cookie is named by port: cookies ignore ports, and two servers on a host must keep apart.
      if (options.token) ctx.gate = new TokenGate(options.token, `odw_token_${boundPort}`, options.authLimit);
      // Workers mint links only while a server that answers them says so.
      if (approve) announceServe(store.root, approve.publicUrl);
      const shown = host === "0.0.0.0" || host === "::" ? "localhost" : host;
      resolve({
        url: `http://${shown}:${boundPort}`,
        port: boundPort,
        host,
        close: () => {
          if (approve) withdrawServe(store.root);
          stopBackground(); // also ends the SSE streams, so server.close() can finish
          return new Promise<void>((done) => server.close(() => done()));
        },
      });
    });
  });
}

interface HandleContext {
  sources: RunSource[];
  store: RunStore;
  chatHost: ChatHost;
  feed: RunFeed;
  cwd: string;
  config: Config;
  configPath: string | null;
  /** The address the server was bound to (drives the write/Host policy). */
  boundHost: string;
  /** What redacts the args it serves (ODW extension). */
  redactor: Redactor;
  /** The shared bundle shown, read-only (ODW extension); null for the runs root. */
  bundle: BundleInfo | null;
  /** The token check (ODW extension: `--token`); null when reads are open. */
  gate: TokenGate | null;
  /** The approve-link route (ODW extension: `--public-url`); null when links are off. */
  approve: ApproveRouteContext | null;
  /** `--token-scope approve` (ODW extension): a token holder may answer checkpoints off loopback too. */
  remoteDecide: boolean;
  /** The signed-trigger route (ODW extension); null when the config has no triggers. */
  triggers: TriggerRoute | null;
}

async function handle(req: IncomingMessage, res: ServerResponse, ctx: HandleContext): Promise<void> {
  const { sources, store, chatHost, feed, cwd, config, configPath, boundHost, redactor, bundle, gate } = ctx;
  const method = req.method ?? "GET";

  try {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      sendJson(res, 400, { error: "malformed request URL" });
      return;
    }
    const path = url.pathname;

    // Signed triggers (ODW extension; see ./trigger-route): the signature is the
    // credential — a webhook comes through a tunnel's Host and carries no token.
    const triggerMatch = /^\/api\/triggers\/([^/]+)$/.exec(path);
    if (triggerMatch) {
      if (bundle) sendJson(res, 409, { error: "this dashboard shows a shared bundle: it starts no runs" });
      else if (!ctx.triggers) sendJson(res, 404, { error: "no such trigger" });
      else await ctx.triggers.handle(req, res, triggerMatch[1]!);
      return;
    }

    // DNS-rebinding guard: on a loopback bind, a browser reaching this server
    // through a hostile DNS name carries that name in Host — refuse it outright
    // (reads too: the run list is sensitive). Off-loopback binds are explicit
    // opt-ins to remote reads, so the allowlist does not apply there.
    // An approve link also arrives through the --public-url's host (a tunnel to a loopback bind).
    const approvePath = path === "/approve" || path.startsWith("/approve/");
    const publicHost = approvePath && ctx.approve && req.headers.host ? new URL(ctx.approve.publicUrl).host === req.headers.host : false;
    if (!isAllowedHost(boundHost, req.headers.host) && !publicHost) {
      sendJson(res, 403, { error: `unexpected Host '${req.headers.host}' — refusing (DNS rebinding guard)` });
      return;
    }

    // Signed approve links (ODW extension; see ./approve-route): the link is the credential, not the token.
    if (approvePath) {
      if (ctx.approve && !bundle) await approveRoute(req, res, path, ctx.approve);
      else approveLinksOff(res);
      return;
    }

    if (method === "GET" && (path === "/" || path === "/index.html")) {
      // The shell needs no token (without one it shows a "needs a token" screen);
      // a right ?token= on it sets the cookie all the same.
      const auth = gate && url.searchParams.has("token") ? gate.check(req, url) : null;
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        ...(auth?.ok && auth.setCookie ? { "set-cookie": auth.setCookie } : {}),
      });
      res.end(DASHBOARD_HTML);
      return;
    }
    if (path === "/api" || path.startsWith("/api/")) {
      // --token (ODW extension): every API read and the stream need it.
      if (gate) {
        const auth = gate.check(req, url);
        if (!auth.ok) {
          const headers: Record<string, string> = auth.retryAfter ? { "retry-after": String(auth.retryAfter) } : {};
          sendJson(res, auth.status, { error: auth.error, auth: "token" }, headers);
          return;
        }
        if (auth.setCookie) res.setHeader("set-cookie", auth.setCookie);
      }
      // A shared bundle is read-only, on loopback too.
      if (bundle && method !== "GET" && method !== "HEAD") {
        sendJson(res, 409, { error: "this dashboard shows a shared bundle: it is read-only" });
        return;
      }
    }
    if (method === "GET" && path === "/api/runs") {
      sendJsonCached(req, res, allSummaries(sources));
      return;
    }
    if (method === "GET" && path === "/api/activity") {
      const view = activityView(sources, allSummaries(sources), activityLimit(url.searchParams.get("limit")));
      sendJsonCached(req, res, view);
      return;
    }
    if (method === "GET" && path === "/api/stream") {
      feed.open(res, { delta: url.searchParams.get("delta") === "1" });
      return;
    }
    if (method === "GET" && path === "/api/capabilities") {
      // The SPA hides local write affordances when writes are refused, so a
      // remotely-viewed off-loopback dashboard shows no dead buttons. Mirrors
      // the writeGuard's loopback-only rule exactly.
      // `auth`: whether reads need a token; `bundle`: the shared bundle shown (ODW extensions).
      // `decide`: whether checkpoints can be answered here — `--token-scope approve` off loopback too.
      const writable = isLoopbackBind(boundHost) && !bundle;
      sendJson(res, 200, { writable, auth: gate ? "token" : "none", bundle, decide: writable || (ctx.remoteDecide && gate !== null) });
      return;
    }
    if (method === "GET" && path === "/api/settings") {
      sendJson(res, 200, bundle ? bundleSettingsView(bundle, config) : settingsView(store, config, cwd, configPath, boundHost));
      return;
    }
    if (method === "GET" && path === "/api/compare") {
      compareView(req, res, store, url.searchParams, redactor);
      return;
    }
    if (method === "GET" && path === "/api/estimate") {
      estimateView(req, res, store, url.searchParams);
      return;
    }
    if (method === "GET" && path === "/api/schedules") {
      // A schedule's args are the user's data, kept as given for its runs: served with token shapes redacted.
      sendJson(res, 200, bundle ? [] : listSchedules().map((row) => redactor.shapes.record(scheduleJson(row))));
      return;
    }
    if (method === "GET" && (path === "/api/evals" || path.startsWith("/api/evals/"))) {
      evalsView(req, res, store, path, redactor);
      return;
    }
    if (path.startsWith("/api/chat/") && (await chatHost.route(req, res, method, path, boundHost))) return;
    if (method === "GET" && path === "/api/workflows") {
      sendJson(res, 200, bundle ? [] : listWorkflowSummaries(cwd, config, store));
      return;
    }
    const wfMatch = path.match(/^\/api\/workflows\/([^/]+)$/);
    if (method === "GET" && wfMatch && !bundle) {
      const name = decodeSegment(wfMatch[1]!);
      if (name === null) {
        sendJson(res, 400, { error: "malformed URL escape in workflow name" });
        return;
      }
      // Optional ?provider= disambiguates a cross-provider name collision (so a
      // shadowed Claude workflow's source is reachable); ignored if not odw|claude
      // or claude-plugin:<plugin> (a Claude Code plugin's workflows, ODW extension).
      const p = url.searchParams.get("provider");
      const provider = p === "odw" || p === "claude" || (p !== null && /^claude-plugin:[A-Za-z0-9._-]+$/.test(p)) ? (p as WorkflowProvider) : undefined;
      const det = workflowDetail(cwd, config, store, name, provider);
      if (!det) {
        sendJson(res, 404, { error: `no such workflow: ${name}` });
        return;
      }
      sendJson(res, 200, det);
      return;
    }

    const runMatch = path.match(
      /^\/api\/runs\/([^/]+)(\/events|\/control|\/checkpoint|\/result|\/notes|\/agents(?:\/[^/]+(?:\/diff|\/transcript)?)?)?$/,
    );
    if (runMatch) {
      const sub = runMatch[2];
      // Writes are gated before any run lookup: an off-loopback bind refuses
      // outright (no run-existence oracle), and CSRF posture comes first.
      const write = sub === "/control" || sub === "/checkpoint";
      // --token-scope approve (ODW extension): a checkpoint decision — only that — passes off loopback, CSRF checks kept.
      const remoteDecision = sub === "/checkpoint" && ctx.remoteDecide && gate !== null;
      if (method === "POST" && write && !(remoteDecision ? jsonPostGuard(req, res) : writeGuard(req, res, boundHost))) return;
      const runId = decodeSegment(runMatch[1]!);
      if (runId === null) {
        sendJson(res, 400, { error: "malformed URL escape in run id" });
        return;
      }
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
      // The run's notes board (ODW extension): ODW runs only; [] when it has none.
      if (method === "GET" && sub === "/notes") {
        const notes = src.notes?.(runId) ?? null;
        if (!notes) {
          sendJson(res, 404, { error: "notes boards are kept for ODW runs only" });
          return;
        }
        sendJsonCached(req, res, notes);
        return;
      }
      // Saved per-agent results: ODW saves each one as it lands; Claude runs have none.
      if (method === "GET" && sub === "/agents") {
        const records = src.agentResults(runId);
        if (!records) {
          sendJson(res, 404, { error: "agent results are saved for ODW runs only" });
          return;
        }
        sendJsonCached(req, res, records.map(agentListing));
        return;
      }
      if (method === "GET" && sub?.startsWith("/agents/")) {
        const rest = sub.slice("/agents/".length);
        const artifact = /\/(diff|transcript)$/.exec(rest)?.[1];
        const wantsDiff = artifact === "diff";
        // The id names a file: only a non-negative integer may reach the store.
        const raw = decodeSegment(artifact ? rest.slice(0, -(artifact.length + 1)) : rest);
        const agentId = raw !== null && /^\d+$/.test(raw) ? Number(raw) : NaN;
        if (!Number.isSafeInteger(agentId)) {
          sendJson(res, 400, { error: "agentId must be a non-negative integer" });
          return;
        }
        if (artifact === "transcript") {
          // What the agent's CLI printed (ODW extension), normalized, a page from entry `since` on.
          const page = src.agentTranscript(runId, agentId, sinceParam(url.searchParams));
          if (!page) {
            sendJson(res, 404, { error: `agent ${agentId} has no transcript` });
            return;
          }
          sendJsonCached(req, res, page);
          return;
        }
        if (wantsDiff) {
          // What an isolated agent changed (ODW extension), as kept: diffs can be megabytes.
          const file = src.agentDiff(runId, agentId);
          if (!file || !sendFileCached(req, res, file, "text/plain; charset=utf-8")) {
            sendJson(res, 404, { error: `agent ${agentId} kept no diff` });
          }
          return;
        }
        const rec = src.agentResult(runId, agentId);
        if (!rec) {
          sendJson(res, 404, { error: `no saved result for agent ${agentId}` });
          return;
        }
        sendJsonCached(req, res, rec);
        return;
      }
      if (method === "POST" && sub === "/control") {
        // A read-only source (Claude) refuses control with a 409 before any work.
        const refused = src.controlError ?? src.runControlError?.(runId) ?? null;
        if (refused) {
          sendJson(res, 409, { error: refused });
          return;
        }
        await controlRun(req, res, src, runId);
        return;
      }
      if (method === "POST" && sub === "/checkpoint") {
        // Claude runs are read-only, and have no checkpoint() to answer anyway.
        const refused = src.controlError ?? src.runControlError?.(runId) ?? null;
        if (refused) {
          sendJson(res, 409, { error: refused });
          return;
        }
        await decideCheckpoint(req, res, src, runId);
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
    adapters: listAdapters(config).map((a) => {
      // The argv it runs with at the configured permission tier (ODW extension).
      const adapter = config.adapters[a.name];
      return { ...a, command: adapter ? commandAt(adapter, runTier(config)).join(" ") : "" };
    }),
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
    // Whether hooks are set, not what they are: a command's arguments and a
    // webhook's path/query routinely carry tokens. The webhook shows as scheme + host.
    notify: {
      command: config.settings.notify?.command != null,
      webhook: config.settings.notify?.webhook ? webhookOrigin(config.settings.notify.webhook) : null,
      on: config.settings.notify?.on ?? [...RUN_END_STATES],
    },
  };
}

/** Settings as a shared bundle shows them: nothing of this machine's — its paths, adapters, hooks. */
function bundleSettingsView(bundle: BundleInfo, config: Config): Record<string, unknown> {
  return {
    cwd: "",
    configPath: null,
    runsRoot: "",
    writable: false,
    bundle,
    claudeJobsScope: config.settings.claudeJobsScope,
    adapters: [],
    workflowRoots: [],
    notify: { command: false, webhook: null, on: [] },
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
 * The checkpoint route's body cap: an edited payload may be 256 KiB of
 * compact JSON, and a client's own formatting, escapes and the note need room.
 */
const CHECKPOINT_BODY_MAX_BYTES = 2 * CHECKPOINT_EDIT_MAX_BYTES;

/**
 * Answer a waiting checkpoint() (ODW extension): `{ action: approve|reject,
 * checkpointId?, note?, payload? }`. The answer is checked against what the
 * run waits for now — and always sent for an explicit id — so it can never
 * land on a question asked after the person decided. `payload`, with
 * approve only, is an edit of the checkpoint's payload: refused (413) over
 * 256 KiB of JSON, and (400, with the validator's `problems`) when it does not
 * match the checkpoint's schema — the run checks it again on receipt.
 */
async function decideCheckpoint(
  req: IncomingMessage,
  res: ServerResponse,
  src: RunSource,
  runId: string,
): Promise<void> {
  // CSRF posture (Content-Type + same-origin) is enforced by writeGuard upstream.
  // The body may hold an edited payload of up to 256 KiB, with room around it.
  const body = await jsonBodyOrReply(req, res, CHECKPOINT_BODY_MAX_BYTES);
  if (!body) return;
  const { action, note } = body;
  const checkpointId = body.checkpointId ?? undefined;
  // An approval's edited payload: present (null included) means sent.
  const edited = Object.hasOwn(body, "payload");
  if (action !== "approve" && action !== "reject") {
    sendJson(res, 400, { error: "action must be one of approve, reject" });
    return;
  }
  if (checkpointId !== undefined && !isCheckpointId(checkpointId)) {
    sendJson(res, 400, { error: "checkpointId must be a positive integer" });
    return;
  }
  if (note !== undefined && note !== null && typeof note !== "string") {
    sendJson(res, 400, { error: "note must be a string" });
    return;
  }
  if (typeof note === "string" && note.length > CHECKPOINT_NOTE_MAX) {
    sendJson(res, 400, { error: `note must be at most ${CHECKPOINT_NOTE_MAX} characters` });
    return;
  }
  if (edited && action !== "approve") {
    sendJson(res, 400, { error: "payload goes with action approve only — a rejection keeps the checkpoint's payload" });
    return;
  }
  if (edited) {
    const sized = checkEdit(body.payload, null);
    if (!sized.ok) {
      sendJson(res, sized.tooLarge ? 413 : 400, { error: sized.message });
      return;
    }
  }
  const pending = src.detail(runId)?.pendingCheckpoints ?? [];
  const target = checkpointId === undefined ? pending[0] : pending.find((cp) => cp.checkpointId === checkpointId);
  if (!target) {
    const which = checkpointId === undefined ? "no checkpoint is" : `checkpoint #${checkpointId} is not`;
    const open = pending.length ? ` (waiting: ${pending.map((cp) => `#${cp.checkpointId}`).join(", ")})` : "";
    sendJson(res, 409, { error: `${which} waiting for an answer in run ${runId}${open}` });
    return;
  }
  // The same check the run makes on receipt, so it never sees an edit it would refuse.
  const checked = edited ? checkEdit(body.payload, target.schema ?? null) : null;
  if (checked && !checked.ok) {
    sendJson(res, 400, { error: checked.message, problems: checked.problems });
    return;
  }
  src.decide(runId, {
    action,
    checkpointId: target.checkpointId,
    ...(typeof note === "string" && note.trim() !== "" ? { note } : {}),
    ...(checked?.ok ? { payload: checked.value } : {}),
    by: "dashboard",
  });
  sendJson(res, 200, { ok: true, runId, action, checkpointId: target.checkpointId });
}

/**
 * `GET /api/compare?a=<run>&b=<run>` (ODW extension): what changed between
 * two ODW runs — the RunComparison `odw compare --json` prints. Read only.
 * Each id must be a run id (RUN_ID_RE; a dot-only one is no run) — else 400
 * — and name an ODW run — else 404.
 */
function compareView(req: IncomingMessage, res: ServerResponse, store: RunStore, params: URLSearchParams, redactor: Redactor): void {
  const ids = [params.get("a"), params.get("b")];
  for (const id of ids) {
    if (id === null || !RUN_ID_RE.test(id) || /^\.+$/.test(id)) {
      sendJson(res, 400, { error: "a and b must each be a run id: /api/compare?a=<run>&b=<run>" });
      return;
    }
  }
  for (const id of ids as string[]) {
    if (id.startsWith("cc-") || !store.exists(id)) {
      sendJson(res, 404, { error: id.startsWith("cc-") ? `odw compare covers ODW runs only: ${id}` : `no such run: ${id}` });
      return;
    }
  }
  const [a, b] = ids as [string, string];
  // Args are served as /api/runs/:id serves them: token shapes redacted (meta.json keeps them whole).
  const served = (id: string) => {
    const run = readCompareRun(store, id);
    return { ...run, args: (redactor.shapes.record({ args: run.args }) as { args: unknown }).args };
  };
  sendJsonCached(req, res, compareRuns(served(a), served(b)));
}

/**
 * `GET /api/estimate?workflow=<name>[&sourceHash=<sha256>]` (ODW extension):
 * the WorkflowEstimate `odw estimate --json` prints, from the workflow's
 * earlier finished runs. Read only. The name only ever picks a bucket through
 * the store's own slug (no path of it is joined as given); a name that is
 * empty, over 200 characters or has control characters is a 400, and so is a
 * `sourceHash` that is no sha256. Without one, the newest run's is matched.
 */
function estimateView(req: IncomingMessage, res: ServerResponse, store: RunStore, params: URLSearchParams): void {
  const workflow = params.get("workflow");
  if (workflow === null || workflow.trim() === "" || workflow.length > 200 || /[\u0000-\u001f\u007f]/.test(workflow)) {
    sendJson(res, 400, { error: "workflow must be a workflow's name: /api/estimate?workflow=<name>" });
    return;
  }
  const hash = params.get("sourceHash");
  if (hash !== null && !/^[0-9a-f]{64}$/.test(hash)) {
    sendJson(res, 400, { error: "sourceHash must be a sha256, 64 lowercase hex characters" });
    return;
  }
  sendJsonCached(req, res, loadEstimate(store, { workflow, sourceHash: hash ?? latestSourceHash(store, workflow) }));
}

/**
 * `GET /api/evals` and `GET /api/evals/:name/:id` (ODW extension): the
 * reports `odw eval` kept under the runs root, read only. Name and id are
 * checked as run ids are (and never dots only) before they come near a path.
 */
function evalsView(req: IncomingMessage, res: ServerResponse, store: RunStore, path: string, redactor: Redactor): void {
  if (path === "/api/evals") {
    sendJsonCached(req, res, listReports(store.root));
    return;
  }
  const match = /^\/api\/evals\/([^/]+)\/([^/]+)$/.exec(path);
  const name = match ? decodeSegment(match[1]!) : null;
  const id = match ? decodeSegment(match[2]!) : null;
  if (!isEvalName(name) || !isEvalName(id)) {
    sendJson(res, 400, { error: "expected /api/evals/<name>/<id>, each letters, digits, '.', '_' or '-'" });
    return;
  }
  const report = readStoredReport(store.root, name, id);
  if (!report) {
    sendJson(res, 404, { error: `no eval report ${name}/${id}` });
    return;
  }
  // Case args are the user's data, as run args are: served with token shapes redacted.
  sendJsonCached(req, res, redactor.shapes.record(report));
}

/** A saved agent result as listed: which agent and when — the value stays behind its own route. */
function agentListing(rec: AgentResultRecord): Record<string, unknown> {
  return {
    agentId: rec.agentId,
    label: rec.label,
    phase: rec.phase ?? null,
    adapter: rec.adapter ?? null,
    cached: rec.cached === true,
    finishedAt: rec.finishedAt ?? null,
  };
}

/** `?since=N` as an index: junk or negative means 0, as it always has for events. */
function sinceParam(params: URLSearchParams): number {
  const since = Math.floor(Number(params.get("since") ?? "0") || 0);
  return Math.min(Math.max(0, since), Number.MAX_SAFE_INTEGER);
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
