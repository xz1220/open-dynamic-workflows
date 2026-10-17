/**
 * The Chat Host (L5): the dashboard's local chat sessions.
 *
 * A session is a transcript persisted by {@link ChatStore}. A plain turn
 * streams a reply from a local Codex process (`codex exec`, read-only
 * sandbox); a turn that asks for ODW/workflow work instead launches a real
 * inline ODW run (`chat-host-bridge`) and links it to the session. When a
 * linked run settles, its result is posted back into the transcript as a user
 * message and Codex continues from it.
 *
 * Routes (mounted by {@link ./server}, which applies the write guard first):
 *   GET    /api/chat/sessions                 [summary] (state folded from linked runs)
 *   POST   /api/chat/sessions                 { source? } → new session
 *   GET    /api/chat/sessions/:id             the session, linked runs hydrated
 *   DELETE /api/chat/sessions/:id             remove a session
 *   POST   /api/chat/sessions/:id/messages    { text, adapter?, source? } → updated session
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { listAdapters } from "../adapters/config.js";
import type { Config } from "../adapters/types.js";
import {
  ChatStore,
  sessionSummary,
  type ChatMessage,
  type ChatSessionRecord,
  type ChatSessionState,
  type ChatSessionSummary,
  type ChatToolCall,
} from "./chat-store.js";
import { decodeSegment, guarded, jsonBodyOrReply, logServeError, sendJson, writeGuard } from "./http-util.js";
import { startRunFromSource } from "./launcher.js";
import { sourceForRun, type RunSource } from "./run-source.js";
import { TERMINAL_STATES, type RunStore } from "./run-store.js";
import type { RunDisplayState } from "./runs-view.js";

export interface ChatTurnRequest {
  session: ChatSessionRecord;
  prompt: string;
  cwd: string;
}

export type ChatTurnRunner = (req: ChatTurnRequest, onChunk: (chunk: string) => void) => Promise<void>;

export interface ChatHostOptions {
  store: RunStore;
  sources: RunSource[];
  /** The serve cwd: a new session's default source. */
  cwd: string;
  config: Config;
  /** Forwarded to launched runs so a worker loads the same config the server validated against. */
  configPath: string | null;
  /** Test seam for the Codex-backed assistant stream. Defaults to `codex exec`. */
  runner?: ChatTurnRunner;
  /** Called whenever a session changes (the server pushes a `chat` SSE frame). */
  notify?: (sessionId: string) => void;
}

const CHAT_HOST_WORKFLOW_NAME = "chat-host-bridge";
const CHAT_HOST_WORKFLOW_SOURCE = `
export const meta = {
  name: "${CHAT_HOST_WORKFLOW_NAME}",
  description: "Run a local Chat Host task asynchronously and return its answer.",
  phases: [{ title: "Capture" }, { title: "Execute" }, { title: "Return" }],
}

phase("Capture")
log("Captured a local Chat Host turn.")
const task = typeof args?.prompt === "string" ? args.prompt.trim() : ""
if (!task) throw new Error("chat-host-bridge needs args.prompt")

phase("Execute")
const answer = await agent([
  "You are executing an asynchronous Open Dynamic Workflows task requested from the Chat Host UI.",
  "Complete the user's request as the primary deliverable.",
  "Return the final answer only. Do not describe internal ODW plumbing unless it is directly relevant.",
  "Prefer the user's language. Include concise source links or citations when the task depends on external facts.",
  "",
  "User request:",
  task,
].join("\\n"), { label: "chat-task" })

phase("Return")
return answer
`;

const ODW_INTENT_RE = /\bodw\b|workflow|agent|fan[- ]?out|并行|工作流|智能体/i;
const NEGATED_ODW_RE = [
  /(?:不|别|不要|无需|不用|禁止).{0,12}(?:触发|启动|运行|创建|发起|调用)?\s*(?:odw|workflow|agent|fan[- ]?out|工作流|智能体)/i,
  /(?:不触发|不要触发|无需触发|不用触发|别触发)\s*(?:odw|workflow|agent|fan[- ]?out|工作流|智能体)/i,
  /(?:do not|don't|dont|without|avoid|skip|no need to|no)\s+(?:trigger|start|run|create|launch|call)?\s*(?:odw|workflow|agent|fan[- ]?out)/i,
  /(?:odw|workflow|agent|fan[- ]?out|工作流|智能体).{0,16}(?:不触发|不要|不用|无需|别|without|do not|don't|dont|avoid|skip)/i,
];

function wantsOdw(text: string): boolean {
  if (!ODW_INTENT_RE.test(text)) return false;
  return !NEGATED_ODW_RE.some((re) => re.test(text));
}

interface ChatRuntime {
  runner: ChatTurnRunner;
  activeSessions: Set<string>;
  serverStartedAt: number;
  notify(sessionId: string): void;
}

/** How often linked runs are checked for completion (also checked on chat reads). */
const SYNC_MS = 1000;
/**
 * Change notifications are coalesced per window: a streaming reply changes
 * its session every 80ms, and each `chat` SSE frame makes every client refetch
 * the session list and the open session.
 */
const NOTIFY_COALESCE_MS = 250;

export class ChatHost {
  readonly chat: ChatStore;
  private readonly runtime: ChatRuntime;
  /**
   * Linked runs that need no more checking: their completion was posted, they
   * predate this server (posting those is not our job), or they are gone.
   * Keeps the per-second sync from re-reading old runs forever.
   */
  private readonly settledRuns = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private readonly changed = new Set<string>();
  private notifyTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: ChatHostOptions) {
    this.chat = new ChatStore(opts.store.root, opts.cwd, {
      onError: (err) => logServeError("chat store write", err),
    });
    this.runtime = {
      runner: opts.runner ?? createDefaultChatRunner(),
      activeSessions: new Set(),
      serverStartedAt: Math.floor(Date.now() / 1000),
      notify: (sessionId) => this.notifySoon(sessionId),
    };
  }

  /** Start the background completion sync (independent of SSE clients). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => guarded("chat run sync", () => this.syncCompletedRuns()), SYNC_MS);
    this.timer.unref?.();
  }

  /** Stop the background work and persist any streaming text still in memory. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    this.timer = this.notifyTimer = null;
    this.changed.clear();
    guarded("chat store flush", () => this.chat.flush());
  }

  /** Queue a change notification; one per session per coalescing window. */
  private notifySoon(sessionId: string): void {
    this.changed.add(sessionId);
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      const ids = [...this.changed];
      this.changed.clear();
      for (const id of ids) guarded("chat notify", () => this.opts.notify?.(id));
    }, NOTIFY_COALESCE_MS);
    this.notifyTimer.unref?.();
  }

  /**
   * The session list: stored rows with the state folded from linked runs'
   * CACHED summaries (no per-session re-read, no tool hydration — the list
   * only ever shows a state and a count).
   */
  private sessionList(): ChatSessionSummary[] {
    const { sources } = this.opts;
    return this.chat.records().map((s) => ({
      ...sessionSummary(s),
      state: hasStreamingAssistant(s)
        ? "running"
        : chatStateFrom(
            s.linkedRuns.map((l) => sourceForRun(sources, l.runId)?.summary(l.runId)?.state ?? "stale"),
            s.state,
          ),
    }));
  }

  /** An on-demand sync before serving a read; its failure must not fail the read. */
  private syncBeforeRead(): void {
    guarded("chat run sync", () => this.syncCompletedRuns());
  }

  /**
   * Serve a `/api/chat/*` request. Resolves false when `path` is not a chat
   * route (the caller falls through to its own routes / 404).
   */
  async route(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    path: string,
    boundHost: string,
  ): Promise<boolean> {
    const { chat } = this;
    const { sources } = this.opts;
    if (method === "GET" && path === "/api/chat/sessions") {
      this.syncBeforeRead();
      sendJson(res, 200, this.sessionList());
      return true;
    }
    if (method === "POST" && path === "/api/chat/sessions") {
      if (!writeGuard(req, res, boundHost)) return true;
      await postChatSession(req, res, chat, sources, this.opts.cwd);
      return true;
    }
    const chatMatch = path.match(/^\/api\/chat\/sessions\/([^/]+)(\/messages)?$/);
    if (!chatMatch) return false;
    const sub = chatMatch[2];
    const read = method === "GET" && !sub;
    const write = (method === "DELETE" && !sub) || (method === "POST" && sub === "/messages");
    if (!read && !write) return false;
    // The write guard comes first, before the id is even looked at.
    if (write && !writeGuard(req, res, boundHost)) return true;
    const sessionId = decodeSegment(chatMatch[1]!);
    if (sessionId === null) {
      sendJson(res, 400, { error: "malformed URL escape in session id" });
      return true;
    }
    if (read) {
      this.syncBeforeRead();
      const session = chat.get(sessionId);
      if (!session) {
        sendJson(res, 404, { error: `no such chat session: ${sessionId}` });
        return true;
      }
      sendJson(res, 200, hydrateChatSession(session, sources));
    } else if (method === "DELETE") {
      await deleteChatSession(req, res, chat, sessionId);
    } else {
      await postChatMessage(req, res, chat, this.runtime, this.opts, sessionId);
    }
    return true;
  }

  /**
   * Post a completion message (and a Codex follow-up) for chat-linked runs
   * that settled. Cheap by construction: settled runs are remembered, and the
   * rest are checked through the sources' cached summaries (a couple of stats)
   * — the full detail/result is read only for a run that just finished.
   */
  syncCompletedRuns(): void {
    const { chat, runtime, settledRuns } = this;
    const { sources } = this.opts;
    for (const session of chat.records()) {
      if (hasStreamingAssistant(session) || runtime.activeSessions.has(session.id)) continue;
      for (const link of session.linkedRuns) {
        if (settledRuns.has(link.runId)) continue;
        if (hasRunResultMessage(session, link.runId)) {
          settledRuns.add(link.runId);
          continue;
        }
        const src = sourceForRun(sources, link.runId);
        const summary = src?.summary(link.runId) ?? null;
        if (!src || !summary || (summary.createdAt ?? 0) < runtime.serverStartedAt) {
          settledRuns.add(link.runId);
          continue;
        }
        if (!TERMINAL_STATES.has(summary.state)) continue;
        const detail = src.detail(link.runId);
        const result = src.result(link.runId);
        const value = result.has ? resultText(result.value) : undefined;
        const title = detail?.workflowName ?? summary.name ?? link.workflow;
        const text = [
          `ODW run ${link.runId} (${title}) finished with state "${summary.state}".`,
          value ? `Result:\n${value}` : "",
          detail?.error ? `Error:\n${resultText(detail.error)}` : "",
        ]
          .filter(Boolean)
          .join("\n\n");
        // Resolve the follow-up's working dir BEFORE posting: if it throws, nothing
        // is posted and the next sync retries the whole thing.
        const cwd = chatWorkingDir(session);
        chat.appendUserMessage(session.id, text, "chat.odw_result");
        settledRuns.add(link.runId);
        startChatCodexTurn(chat, session.id, runtime, cwd);
        break;
      }
    }
  }
}

function createDefaultChatRunner(): ChatTurnRunner {
  return ({ prompt, cwd }, onChunk) =>
    new Promise<void>((resolvePromise, reject) => {
      const child = spawn(
        "codex",
        [
          "exec",
          "--skip-git-repo-check",
          "--ephemeral",
          "--sandbox",
          "read-only",
          "--cd",
          cwd,
          "--color",
          "never",
          "-",
        ],
        { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
      );
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => onChunk(stripAnsi(String(chunk))));
      child.stderr.on("data", (chunk) => {
        stderr += stripAnsi(String(chunk));
      });
      child.on("error", reject);
      child.on("close", (code, signal) => {
        if (code === 0) {
          resolvePromise();
          return;
        }
        const tail = stderr.trim().slice(-1600);
        reject(new Error(`codex exited with ${code ?? signal ?? "unknown"}${tail ? `: ${tail}` : ""}`));
      });
      child.stdin.end(prompt);
    });
}

function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function hasStreamingAssistant(session: ChatSessionRecord): boolean {
  return session.messages.some((m) => m.role === "assistant" && m.status === "streaming");
}

function existingDir(path: string): string | null {
  try {
    return statSync(path).isDirectory() ? path : null;
  } catch {
    return null;
  }
}

/**
 * Where a Codex turn runs: the session's source if it still exists, else the
 * scratch dir. Can throw (creating the scratch dir), so callers resolve it
 * BEFORE persisting anything for the turn.
 */
function chatWorkingDir(session: ChatSessionRecord): string {
  return existingDir(session.source) ?? scratchSourceDir();
}

function formatTranscriptMessage(message: ChatMessage): string | null {
  if (message.kind === "chat.ready") return null;
  if (message.role === "tool") {
    const tool = message.tool;
    if (!tool) return `Tool: ${message.text}`;
    const result = tool.result ? `\nTool result:\n${tool.result}` : "";
    return `Tool ${tool.name} (${tool.status}) ${tool.workflow} ${tool.runId}: ${message.text}${result}`;
  }
  const who = message.role === "user" ? "User" : "Assistant";
  if (!message.text.trim() && message.status === "streaming") return null;
  return `${who}: ${message.text}`;
}

function buildCodexChatPrompt(session: ChatSessionRecord, assistantMessageId: string): string {
  const transcript = session.messages
    .filter((m) => m.id !== assistantMessageId)
    .map(formatTranscriptMessage)
    .filter((m): m is string => m !== null)
    .slice(-24)
    .join("\n\n");
  return [
    "You are Codex replying inside the Open Dynamic Workflows Chat Host UI.",
    "Answer the latest user message directly and naturally. Prefer the user's language.",
    "This is a hosted conversation; use the transcript for context.",
    "When the transcript contains an ODW run completion user message, continue from that result.",
    "Do not modify files unless the user explicitly asks for code changes in this chat.",
    "",
    "Conversation transcript:",
    transcript || "(empty)",
    "",
    "Return only the next assistant message.",
  ].join("\n");
}

/** Stream a Codex reply into the session; `cwd` comes from {@link chatWorkingDir}. */
function startChatCodexTurn(
  chat: ChatStore,
  sessionId: string,
  runtime: ChatRuntime,
  cwd: string,
): ChatSessionRecord | null {
  const current = chat.get(sessionId);
  if (!current || hasStreamingAssistant(current) || runtime.activeSessions.has(sessionId)) return current;
  const withPlaceholder = chat.appendAssistantMessage(sessionId, "", undefined, "streaming");
  runtime.notify(sessionId);
  const placeholder = withPlaceholder.messages[withPlaceholder.messages.length - 1]!;
  const prompt = buildCodexChatPrompt(withPlaceholder, placeholder.id);
  let text = "";
  let flushTimer: NodeJS.Timeout | null = null;
  // These run from timers and promise callbacks: a store write failing (disk
  // full, EACCES) is logged, never allowed to crash the server.
  const update = (patch: { text: string; status?: "done" | "failed" }) =>
    guarded("chat message update", () => {
      chat.updateMessage(sessionId, placeholder.id, patch);
    });
  const flush = () => {
    flushTimer = null;
    update({ text });
    runtime.notify(sessionId);
  };
  const queueFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, 80);
    flushTimer.unref?.();
  };

  const cancelFlush = () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
  };

  runtime.activeSessions.add(sessionId);
  void Promise.resolve()
    .then(() =>
      runtime.runner({ session: withPlaceholder, prompt, cwd }, (chunk) => {
        if (!chunk) return;
        text += chunk;
        queueFlush();
      }),
    )
    .then(
      () => {
        cancelFlush();
        update({ text: text.trimEnd() || "Codex finished without producing text.", status: "done" });
      },
      (err) => {
        cancelFlush();
        const existing = text.trimEnd();
        const errorText = `Codex stream failed: ${(err as Error)?.message ?? String(err)}`;
        update({ text: existing ? `${existing}\n\n${errorText}` : errorText, status: "failed" });
      },
    )
    .finally(() => {
      runtime.activeSessions.delete(sessionId);
      runtime.notify(sessionId);
    })
    .catch((err) => logServeError("chat turn", err)); // nothing may escape as an unhandled rejection
  return chat.get(sessionId);
}

function chatStateFrom(states: RunDisplayState[], fallback: ChatSessionState): ChatSessionState {
  if (states.some((s) => s === "pending" || s === "running" || s === "paused" || s === "stale")) return "running";
  if (states.length > 0 && states.every((s) => s === "done" || s === "failed" || s === "stopped")) return "done";
  return fallback;
}

function toolStatus(state: RunDisplayState | undefined): ChatToolCall["status"] {
  if (state === "failed" || state === "stopped") return "failed";
  if (state === "stale") return "stale";
  if (state === "done") return "done";
  return "running";
}

function displayProgress(state: RunDisplayState | undefined, progress: number | undefined): number {
  const p = typeof progress === "number" && Number.isFinite(progress) ? Math.min(Math.max(progress, 0), 1) : 0;
  if (state === "done" || state === "failed" || state === "stopped") return Math.max(p, 1);
  return p;
}

function eventLabel(ev: Record<string, unknown>): string {
  if (typeof ev.label === "string") return ev.label;
  if (typeof ev.phase === "string") return ev.phase;
  if (typeof ev.message === "string") return ev.message;
  return String(ev.type ?? "event");
}

function resultText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function hasRunResultMessage(session: ChatSessionRecord, runId: string): boolean {
  return session.messages.some((m) => m.kind === "chat.odw_result" && m.text.includes(runId));
}

function hydrateTool(tool: ChatToolCall, sources: RunSource[]): ChatToolCall {
  const src = sourceForRun(sources, tool.runId);
  if (!src) return tool;
  const detail = src.detail(tool.runId);
  if (!detail) return tool;
  // The cached log is shared and read-only: scan it from the end, copy only the tail.
  const log = src.eventLog(tool.runId);
  let lastPhase: string | null = null;
  for (let i = log.length - 1; i >= 0 && lastPhase === null; i--) {
    const phase = log[i]!.phase;
    if (typeof phase === "string") lastPhase = phase;
  }
  const result = src.result(tool.runId);
  return {
    ...tool,
    status: toolStatus(detail.state),
    workflow: detail.workflowName ?? detail.name ?? tool.workflow,
    progress: displayProgress(detail.state, detail.progress),
    phase: lastPhase ?? detail.phaseOrder[detail.phaseOrder.length - 1] ?? detail.state,
    events: log.slice(-8).map((ev) => ({
      type: ev.type,
      label: eventLabel(ev),
      ts: ev.ts,
    })),
    ...(result.has ? { result: resultText(result.value) } : {}),
  };
}

function hydrateChatSession(session: ChatSessionRecord, sources: RunSource[]): Record<string, unknown> {
  const linkedRuns = session.linkedRuns.map((link) => {
    const src = sourceForRun(sources, link.runId);
    const detail = src?.detail(link.runId) ?? null;
    return {
      runId: link.runId,
      workflow: detail?.workflowName ?? detail?.name ?? link.workflow,
      state: detail?.state ?? "stale",
      progress: displayProgress(detail?.state, detail?.progress),
    };
  });
  const messages = session.messages.map((message): ChatMessage => {
    if (!message.tool) return message;
    return { ...message, tool: hydrateTool(message.tool, sources) };
  });
  const messageStreaming = messages.some((m) => m.role === "assistant" && m.status === "streaming");
  return {
    ...session,
    state: messageStreaming
      ? "running"
      : chatStateFrom(
          linkedRuns.map((r) => r.state as RunDisplayState),
          session.state,
        ),
    linkedRuns,
    messages,
  };
}

async function postChatSession(
  req: IncomingMessage,
  res: ServerResponse,
  chat: ChatStore,
  sources: RunSource[],
  cwd: string,
): Promise<void> {
  const body = await jsonBodyOrReply(req, res);
  if (!body) return;
  const source = typeof body.source === "string" && body.source.trim() ? body.source.trim() : cwd;
  const session = chat.create(source);
  sendJson(res, 200, hydrateChatSession(session, sources));
}

async function deleteChatSession(
  req: IncomingMessage,
  res: ServerResponse,
  chat: ChatStore,
  sessionId: string,
): Promise<void> {
  const body = await jsonBodyOrReply(req, res);
  if (!body) return;
  if (!chat.delete(sessionId)) {
    sendJson(res, 404, { error: `no such chat session: ${sessionId}` });
    return;
  }
  sendJson(res, 200, { ok: true });
}

async function postChatMessage(
  req: IncomingMessage,
  res: ServerResponse,
  chat: ChatStore,
  chatRuntime: ChatRuntime,
  opts: ChatHostOptions,
  sessionId: string,
): Promise<void> {
  const { sources, store, config, configPath } = opts;
  const body = await jsonBodyOrReply(req, res);
  if (!body) return;
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    sendJson(res, 400, { error: "text must be a non-empty string" });
    return;
  }
  const existing = chat.get(sessionId);
  if (!existing) {
    sendJson(res, 404, { error: `no such chat session: ${sessionId}` });
    return;
  }
  if (hasStreamingAssistant(existing) || chatRuntime.activeSessions.has(sessionId)) {
    sendJson(res, 409, { error: "Codex is still responding in this chat session" });
    return;
  }
  // Everything that can refuse the turn (a 400 for a bad adapter/source, a
  // failing launch or scratch dir) runs BEFORE the user message is persisted:
  // a refused turn must leave no orphan message for a retry to duplicate.
  if (wantsOdw(text)) {
    const launchBody = {
      adapter: typeof body.adapter === "string" ? body.adapter : undefined,
      source: typeof body.source === "string" && body.source ? body.source : existing.source,
    };
    const checked = checkChatRunInputs(res, config, launchBody);
    if (!checked) return;
    const { runId } = startRunFromSource(CHAT_HOST_WORKFLOW_SOURCE, {
      args: { prompt: text, sessionId },
      adapter: checked.adapter,
      source: checked.source,
      runsRoot: store.root,
      configPath,
      origin: "chat",
    });
    chat.appendUserMessage(sessionId, text);
    chat.appendToolRun(sessionId, runId, CHAT_HOST_WORKFLOW_NAME);
  } else {
    const cwd = chatWorkingDir(existing);
    chat.appendUserMessage(sessionId, text);
    startChatCodexTurn(chat, sessionId, chatRuntime, cwd);
  }
  const updated = chat.get(sessionId);
  if (!updated) {
    sendJson(res, 404, { error: `no such chat session: ${sessionId}` });
    return;
  }
  sendJson(res, 200, hydrateChatSession(updated, sources));
}

/**
 * A stable, empty, copy-safe scratch directory used when a Chat-triggered ODW
 * turn has no project source. The serve process's cwd is NOT a safe default:
 * in the desktop app it can be `/`, and copy-mode isolation cannot copy `/`
 * into its own temp subdirectory.
 */
function scratchSourceDir(): string {
  const dir = join(tmpdir(), "odw-chat-scratch");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Validate adapter/source values before the Chat Host starts an ODW run. */
function checkChatRunInputs(
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
