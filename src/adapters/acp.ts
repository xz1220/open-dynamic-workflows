/**
 * ACP adapters (L1; an ODW extension): a coding agent that speaks the Agent
 * Client Protocol (https://agentclientprotocol.com) — JSON-RPC 2.0, one
 * message per line, over its stdin and stdout — driven by a minimal client
 * with no dependency.
 *
 * An adapter with `"protocol": "acp"` starts its `command` (the agent's
 * documented ACP mode, `gemini --experimental-acp` say) as any adapter's CLI —
 * same process group, timeout, stall watchdog, sandbox — but keeps its stdin
 * open (see runner.ts `duplex`) and, for each CLI run of an agent call:
 *
 *   initialize       protocol version 1; no client capability declared — no
 *                    `fs`, no `terminal`, no elicitation: the agent reads and
 *                    writes files itself, and a request for any of them is
 *                    answered "method not found"
 *   session/new      `cwd` the agent's workspace, no MCP servers of ODW's
 *   session/prompt   the agent's prompt, one text block; the turn ends with
 *                    its response's `stopReason`
 *   session/update   read as it streams: message and thought chunks, tool
 *                    calls and their updates, plans, `usage_update`
 *   session/request_permission  answered at once by the agent's permission
 *                    tier (see {@link permits}) — never asked of a person
 *   session/cancel   sent when the run is stopped, times out or stalls,
 *                    just before its process is killed
 *
 * What the session said is not kept as the raw JSON-RPC traffic: it is turned
 * into ODW's own `acp.*` JSONL events, which go where any JSONL CLI's stdout
 * goes — the transcript, the live limits, the handoff log — and are decoded by
 * {@link ACP_OUTPUT} like any other: the reply, its usage, the tool calls the
 * tier refused (`permissionDenials`), a failure the agent reported.
 *
 *   {"type":"acp.initialized","protocolVersion":1,"agentInfo":{…},"agentCapabilities":{…}}
 *   {"type":"acp.session","sessionId":"…"}
 *   {"type":"acp.message","text":"…"}          message chunks, joined
 *   {"type":"acp.thought","text":"…"}          thought chunks, joined
 *   {"type":"acp.tool_call","toolCallId":"…","title":"…","kind":"edit","status":"pending","rawInput":{…}}
 *   {"type":"acp.tool_result","toolCallId":"…","title":"…","kind":"edit","status":"completed","output":"…"}
 *   {"type":"acp.plan","entries":[…]}
 *   {"type":"acp.usage","used":N,"size":N,"cost":{"amount":N,"currency":"USD"}}
 *   {"type":"acp.permission","toolCallId":"…","title":"…","kind":"execute","decision":"rejected","option":"reject_once","tier":"edit"}
 *   {"type":"acp.error","message":"…","code":N}
 *   {"type":"acp.result","stopReason":"end_turn","text":"…","usage":{…},"costUsd":N,"error":"…","denied":[…]}
 *
 * Usage: `usage_update`'s cumulative `cost` when it is in US dollars (the
 * stable Session Usage feature carries no token counts); token counts only
 * where the prompt response carries a `usage` object (a draft of the
 * protocol at the time of writing — read if present, never required).
 */

import type { AdapterOutput, CliResult, PermissionTier } from "./types.js";
import { TAIL_CHARS, type CommandRunner, type ProcessIO, type RunCommandOptions } from "./runner.js";

/** The ACP major version this client speaks. */
export const ACP_PROTOCOL_VERSION = 1;

/** The adapter `protocol` value of an ACP agent. */
export const ACP_PROTOCOL = "acp";

/** How an ACP adapter's (translated) output is decoded: ODW's own `acp.*` events. */
export const ACP_OUTPUT: AdapterOutput = {
  format: "jsonl",
  eventType: "acp.result",
  textPath: ["text"],
  select: "last",
  usagePath: ["usage"],
  costPath: ["costUsd"],
  errorPath: ["error"],
  deniedPath: ["denied"],
  errorEvents: { "acp.error": ["message"] },
};

/** JSON-RPC: the method does not exist (or is not offered: an undeclared client capability). */
const METHOD_NOT_FOUND = -32601;
/** ACP: the agent needs the client to authenticate first. */
const AUTH_REQUIRED = -32000;

/** The longest JSON-RPC message read; past it the run is refused as an overrun. */
const MAX_MESSAGE_CHARS = 32 * 1024 * 1024;
/** Characters of a tool's output kept in its `acp.tool_result` event. */
const MAX_TOOL_OUTPUT_CHARS = 64 * 1024;

/** Tool kinds (ACP `ToolKind`) a `read` agent may be allowed: looking, never changing or running. */
const READ_KINDS: ReadonlySet<string> = new Set(["read", "search", "think", "fetch"]);
/** Tool kinds an `edit` agent may be allowed: those, and changing files. Running commands, switching modes and the rest are `full`'s. */
const EDIT_KINDS: ReadonlySet<string> = new Set([...READ_KINDS, "edit", "delete", "move"]);
/** Kinds that surely change something: one that ran without asking, beyond the tier, is reported (`unasked`). */
const WRITE_KINDS: ReadonlySet<string> = new Set(["edit", "delete", "move", "execute"]);

/**
 * Whether an agent at `tier` is allowed a tool call of ACP kind `kind` (ODW
 * extension): `read` — read, search, think, fetch (not fetch when
 * `noWebTools`: untrusted input, see ../untrusted-input); `edit` — those and
 * edit, delete, move; `full` — anything. A kind ODW does not know, `other`,
 * `execute` and `switch_mode` are `full`'s alone.
 */
export function permits(tier: PermissionTier, kind: string, noWebTools = false): boolean {
  if (tier === "full") return true;
  if (noWebTools && kind === "fetch") return false;
  return (tier === "edit" ? EDIT_KINDS : READ_KINDS).has(kind);
}

/** One permission answer (or a tool beyond the tier that ran without asking): what `acp_permission` events record. */
export interface AcpPermission {
  toolCallId: string;
  /** The tool call's title, as the agent gave it. */
  title: string;
  /** Its ACP kind ("other" when the agent named none). */
  kind: string;
  /** `allowed`/`rejected`: how ODW answered; `unasked`: it ran beyond the tier without asking. */
  decision: "allowed" | "rejected" | "unasked";
  /** The option ODW selected (its kind: allow_once, reject_once, …); absent when none fit and the request was cancelled. */
  option?: string;
  tier: PermissionTier;
}

/** One line for an `acp_permission` event: who, what, and how it was answered. */
export function acpPermissionNote(who: string, permission: AcpPermission & { adapter?: string }): string {
  const what = `${permission.title} [${permission.kind}]`;
  const on = permission.adapter ? ` on ${permission.adapter}` : "";
  if (permission.decision === "unasked") {
    return `${who}${on} ran ${what} without asking for permission — beyond its "${permission.tier}" tier, ODW could not refuse it`;
  }
  return `${who}${on} asked to run ${what}: ${permission.decision} by its "${permission.tier}" tier`;
}

/** What an ACP run needs beyond its command (see {@link acpRunner}). */
export interface AcpRunSpec {
  prompt: string;
  /** The agent's workspace: session/new's `cwd`. */
  cwd: string;
  /** The agent's permission tier: how its permission requests are answered. */
  tier: PermissionTier;
  /** Untrusted input, read-only: no `fetch` either. */
  noWebTools?: boolean;
  /** Told each permission answer, as it is given. */
  onPermission?: (permission: AcpPermission) => void;
}

/** What `initialize` told of the agent (`odw doctor`'s handshake). */
export interface AcpAgentInfo {
  protocolVersion: number | null;
  agentInfo: { name?: string; title?: string; version?: string } | null;
  agentCapabilities: Record<string, unknown>;
  authMethods: string[];
}

/**
 * A runner for an ACP adapter's CLI runs: `base` (the bridge's runner) spawns
 * the agent with its stdin held open, and the session is driven over it; the
 * caller's `onStdout`/`observeStdout` see the `acp.*` events instead of the
 * protocol, and so does the result's `stdout`. The turn ending is a clean
 * exit (its process is closed, then killed if it lingers); a process that
 * exits before it ends adds an `acp.error` saying so.
 */
export function acpRunner(base: CommandRunner, spec: AcpRunSpec): CommandRunner {
  return async (command, options: RunCommandOptions = {}) => {
    const client = new AcpClient("prompt", spec);
    return runClient(base, client, command, options);
  };
}

/**
 * Start an ACP agent, ask `initialize` alone and stop it (`odw doctor`'s
 * handshake; no session, no prompt, nothing spent): what it said of itself,
 * or why it said nothing usable.
 */
export async function acpHandshake(
  base: CommandRunner,
  command: string[],
  options: { cwd: string; env?: Record<string, string>; timeout: number },
): Promise<{ info: AcpAgentInfo | null; error: string | null; result: CliResult }> {
  const client = new AcpClient("handshake", { prompt: "", cwd: options.cwd, tier: "read" });
  const result = await runClient(base, client, command, { cwd: options.cwd, env: options.env, timeout: options.timeout });
  if (client.info && !client.failure) return { info: client.info, error: null, result };
  const why =
    client.failure ??
    (result.timedOut
      ? `no answer to initialize within ${options.timeout}s`
      : `exited ${result.returncode} before answering initialize${tailLine(result.stderr)}`);
  return { info: client.info, error: why, result };
}

async function runClient(
  base: CommandRunner,
  client: AcpClient,
  command: string[],
  options: RunCommandOptions,
): Promise<CliResult> {
  const { onStdout, observeStdout } = options;
  let kept = "";
  let terminateRun: ((reason: string) => void) | null = null;
  client.emit = (line) => {
    observeStdout?.(line);
    if (onStdout) onStdout(line, (reason) => terminateRun?.(reason));
    kept += line;
    if (kept.length > TAIL_CHARS * 2) kept = kept.slice(-TAIL_CHARS);
  };
  const result = await base(command, {
    ...options,
    // The prompt goes in session/prompt; the agent's stdin is the protocol's.
    stdin: undefined,
    observeStdout: undefined,
    onStdout: (chunk, terminate) => {
      terminateRun = terminate;
      client.feed(chunk, terminate);
    },
    duplex: (io) => client.start(io),
    onTerminate: () => {
      client.cancel();
      options.onTerminate?.();
    },
  });
  // An agent that exits mid-turn, or answered nothing: said in its own words, for the failure's reason.
  client.ended(result);
  const stdout = kept.length > TAIL_CHARS ? kept.slice(-TAIL_CHARS) : kept;
  // The turn ended (its reply is in): the process closing after it is not a failure.
  const returncode = client.done && !result.timedOut && !result.stalled && result.returncode !== -1 ? 0 : result.returncode;
  return { ...result, stdout, returncode };
}

/** The last non-empty line of `text`, as ": <line>" — or "". */
function tailLine(text: string): string {
  const line = text.trim().split("\n").pop()?.trim() ?? "";
  return line ? `: ${line.slice(0, 200)}` : "";
}

type Json = Record<string, unknown>;

/** The client side of one ACP session (or of a handshake alone). */
class AcpClient {
  /** Where `acp.*` events go, one JSON line each (set by runClient). */
  emit: (line: string) => void = () => {};
  /** What initialize said. */
  info: AcpAgentInfo | null = null;
  /** The turn ended (or, for a handshake, initialize was answered): the process may go. */
  done = false;
  /** Why the session failed, in the client's words (also an `acp.error` event). */
  failure: string | null = null;

  private io: ProcessIO | null = null;
  private partial = "";
  private nextId = 1;
  private readonly pending = new Map<number, (message: Json) => void>();
  private sessionId: string | null = null;
  private cancelled = false;
  /** Message text since the last tool call, the last non-empty message text, and the chunks being joined. */
  private replyText = "";
  private lastText = "";
  private message: { id: unknown; text: string } | null = null;
  private thought = "";
  /** What each tool call has said of itself so far, and which asked. */
  private readonly tools = new Map<string, { title: string; kind: string }>();
  private readonly asked = new Set<string>();
  private readonly unasked = new Set<string>();
  private readonly denied: Array<{ tool_name: string; tool_use_id: string; tool_input?: unknown }> = [];
  private costUsd: number | undefined;

  constructor(
    private readonly mode: "prompt" | "handshake",
    private readonly spec: AcpRunSpec,
  ) {}

  start(io: ProcessIO): void {
    this.io = io;
    this.request(
      "initialize",
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        // No fs, no terminal, no elicitation: the agent does its own reading and writing.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "odw", title: "Open Dynamic Workflows", version: "1" },
      },
      (message) => this.initialized(message),
    );
  }

  /** The run is being killed: a turn in flight is cancelled first. */
  cancel(): void {
    if (this.done || this.cancelled || this.sessionId === null) return;
    this.cancelled = true;
    this.notify("session/cancel", { sessionId: this.sessionId });
  }

  /** Stdout from the agent: JSON-RPC messages, a line each. */
  feed(chunk: string, terminate: (reason: string) => void): void {
    let from = 0;
    for (let nl = chunk.indexOf("\n"); nl !== -1; nl = chunk.indexOf("\n", from)) {
      const line = this.partial + chunk.slice(from, nl);
      this.partial = "";
      from = nl + 1;
      this.line(line);
    }
    this.partial += chunk.slice(from);
    if (this.partial.length > MAX_MESSAGE_CHARS) {
      this.partial = "";
      terminate(`an ACP message exceeded ${MAX_MESSAGE_CHARS} characters`);
    }
  }

  /** The process is gone: a last unterminated message is read, and a turn left unfinished said so. */
  ended(result: CliResult): void {
    if (this.partial.trim()) this.line(this.partial);
    this.partial = "";
    if (this.done || this.failure || this.mode === "handshake") return;
    if (result.timedOut || result.stalled || result.returncode === -1) {
      this.flushText();
      return; // the runner's own note says why
    }
    this.fail(
      this.info === null
        ? `the ACP agent exited (${result.returncode}) without answering initialize${tailLine(result.stderr)}`
        : `the ACP agent exited (${result.returncode}) before its prompt turn ended${tailLine(result.stderr)}`,
    );
  }

  // --- the wire ---------------------------------------------------------------------

  private write(message: Json): void {
    this.io?.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  }

  private request(method: string, params: Json, then: (message: Json) => void): void {
    const id = this.nextId++;
    this.pending.set(id, then);
    this.write({ id, method, params });
  }

  private notify(method: string, params: Json): void {
    this.write({ method, params });
  }

  private out(event: Json): void {
    this.emit(JSON.stringify(event) + "\n");
  }

  private line(text: string): void {
    const trimmed = text.trim();
    if (!trimmed.startsWith("{")) return; // not a protocol message: ignored
    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!isRecord(message)) return;
    const method = typeof message.method === "string" ? message.method : undefined;
    const hasId = typeof message.id === "number" || typeof message.id === "string";
    if (method !== undefined && hasId) return this.answer(message.id as number | string, method, message.params);
    if (method !== undefined) {
      if (method === "session/update") this.update(message.params);
      return;
    }
    if (typeof message.id === "number") {
      const then = this.pending.get(message.id);
      if (!then) return;
      this.pending.delete(message.id);
      then(message);
    }
  }

  /** The agent's request of the client: a permission is answered by the tier; nothing else is offered. */
  private answer(id: number | string, method: string, params: unknown): void {
    if (method === "session/request_permission" && isRecord(params)) {
      this.write({ id, result: { outcome: this.decide(params) } });
      return;
    }
    this.write({ id, error: { code: METHOD_NOT_FOUND, message: `odw offers no "${method}": it declares no such client capability` } });
  }

  // --- the session ------------------------------------------------------------------

  private initialized(message: Json): void {
    const error = rpcError(message);
    if (error) return this.fail(`initialize failed: ${error.text}`, error.code);
    const result = isRecord(message.result) ? message.result : {};
    const version = typeof result.protocolVersion === "number" ? result.protocolVersion : null;
    const agent = isRecord(result.agentInfo) ? result.agentInfo : null;
    this.info = {
      protocolVersion: version,
      agentInfo: agent
        ? {
            ...(typeof agent.name === "string" ? { name: agent.name } : {}),
            ...(typeof agent.title === "string" ? { title: agent.title } : {}),
            ...(typeof agent.version === "string" ? { version: agent.version } : {}),
          }
        : null,
      agentCapabilities: isRecord(result.agentCapabilities) ? result.agentCapabilities : {},
      authMethods: Array.isArray(result.authMethods)
        ? result.authMethods.flatMap((m) => (isRecord(m) && typeof m.id === "string" ? [m.id] : []))
        : [],
    };
    this.out({ type: "acp.initialized", ...this.info });
    if (version !== ACP_PROTOCOL_VERSION) {
      return this.fail(`the ACP agent speaks protocol version ${version ?? "(none)"}; odw speaks ${ACP_PROTOCOL_VERSION}`);
    }
    if (this.mode === "handshake") return this.finish();
    this.request("session/new", { cwd: this.spec.cwd, mcpServers: [] }, (reply) => this.opened(reply));
  }

  private opened(message: Json): void {
    const error = rpcError(message);
    if (error) return this.fail(`session/new failed: ${error.text}`, error.code);
    const result = isRecord(message.result) ? message.result : {};
    if (typeof result.sessionId !== "string" || !result.sessionId) return this.fail("session/new answered no sessionId");
    this.sessionId = result.sessionId;
    this.out({ type: "acp.session", sessionId: this.sessionId });
    this.request(
      "session/prompt",
      { sessionId: this.sessionId, prompt: [{ type: "text", text: this.spec.prompt }] },
      (reply) => this.prompted(reply),
    );
  }

  private prompted(message: Json): void {
    this.flushText();
    const error = rpcError(message);
    if (error) return this.fail(`session/prompt failed: ${error.text}`, error.code);
    const result = isRecord(message.result) ? message.result : {};
    const stopReason = typeof result.stopReason === "string" ? result.stopReason : "end_turn";
    const event: Json = { type: "acp.result", stopReason, text: this.replyText.trim() ? this.replyText : this.lastText };
    const usage = turnUsage(result.usage);
    if (usage) event.usage = usage;
    if (this.costUsd !== undefined) event.costUsd = this.costUsd;
    // A turn that ended for any reason but its own end is the agent's failure, in its words.
    if (stopReason !== "end_turn") event.error = `the ACP agent stopped: ${stopReason}`;
    if (this.denied.length > 0) event.denied = this.denied;
    this.out(event);
    this.finish();
  }

  private finish(): void {
    this.done = true;
    this.io?.close();
  }

  private fail(message: string, code?: number): void {
    this.flushText();
    const words = code === AUTH_REQUIRED ? `${message} (authentication required: log in to the agent first)` : message;
    this.failure = words;
    this.out({ type: "acp.error", message: words, ...(code !== undefined ? { code } : {}) });
    this.io?.close();
  }

  private update(params: unknown): void {
    if (!isRecord(params) || !isRecord(params.update)) return;
    if (this.sessionId !== null && params.sessionId !== this.sessionId) return;
    const update = params.update;
    const kind = update.sessionUpdate;
    if (kind === "agent_message_chunk") {
      this.flushThought();
      const text = chunkText(update.content);
      if (this.message && this.message.id !== (update.messageId ?? this.message.id)) this.flushMessage();
      this.message ??= { id: update.messageId, text: "" };
      this.message.text += text;
      return;
    }
    if (kind === "agent_thought_chunk") {
      this.flushMessage();
      this.thought += chunkText(update.content);
      return;
    }
    this.flushText();
    switch (kind) {
      case "tool_call":
      case "tool_call_update":
        return this.tool(update, kind === "tool_call");
      case "plan":
        if (Array.isArray(update.entries)) this.out({ type: "acp.plan", entries: update.entries });
        return;
      case "usage_update": {
        const cost = isRecord(update.cost) ? update.cost : null;
        if (cost && cost.currency === "USD" && typeof cost.amount === "number" && Number.isFinite(cost.amount) && cost.amount >= 0) {
          this.costUsd = cost.amount; // the session's, so far: the latest wins
        }
        this.out({ type: "acp.usage", used: update.used, size: update.size, ...(cost ? { cost } : {}) });
        return;
      }
      default:
        return; // commands, modes, config options, session info, notices: nothing ODW keeps
    }
  }

  private tool(update: Json, first: boolean): void {
    const id = typeof update.toolCallId === "string" ? update.toolCallId : "";
    const known = this.tools.get(id);
    const title = typeof update.title === "string" && update.title ? update.title : (known?.title ?? "tool");
    const kind = typeof update.kind === "string" && update.kind ? update.kind : (known?.kind ?? "other");
    if (id) this.tools.set(id, { title, kind });
    const status = typeof update.status === "string" ? update.status : undefined;
    // The reply is what the agent says after its last tool call.
    if (first) this.replyText = "";
    if (first) {
      this.out({ type: "acp.tool_call", toolCallId: id, title, kind, ...(status ? { status } : {}), ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : {}) });
    } else if (status === "completed" || status === "failed") {
      const output = toolOutput(update.content, update.rawOutput);
      this.out({ type: "acp.tool_result", toolCallId: id, title, kind, status, output });
    }
    // A tool that surely changes something, beyond the tier, ran without asking: said, never let pass silently.
    if (
      id &&
      (status === "in_progress" || status === "completed") &&
      WRITE_KINDS.has(kind) &&
      !permits(this.spec.tier, kind, this.spec.noWebTools) &&
      !this.asked.has(id) &&
      !this.unasked.has(id)
    ) {
      this.unasked.add(id);
      this.permission({ toolCallId: id, title, kind, decision: "unasked", tier: this.spec.tier });
    }
  }

  /** Answer a permission request by the tier: the narrowest option that says so. */
  private decide(params: Json): Json {
    this.flushText();
    const call = isRecord(params.toolCall) ? params.toolCall : {};
    const id = typeof call.toolCallId === "string" ? call.toolCallId : "";
    const known = this.tools.get(id);
    const title = typeof call.title === "string" && call.title ? call.title : (known?.title ?? "tool");
    const kind = typeof call.kind === "string" && call.kind ? call.kind : (known?.kind ?? "other");
    if (id) {
      this.asked.add(id);
      this.tools.set(id, { title, kind });
    }
    const options = Array.isArray(params.options) ? params.options.filter(isRecord) : [];
    const pick = (...kinds: string[]): Json | undefined => {
      for (const k of kinds) {
        const option = options.find((o) => o.kind === k && (typeof o.optionId === "string" || typeof o.optionId === "number"));
        if (option) return option;
      }
      return undefined;
    };
    const allowed = !this.done && !this.cancelled && permits(this.spec.tier, kind, this.spec.noWebTools);
    // Once, never always: what ODW allows is this call's, not a rule the agent remembers.
    const option = allowed ? pick("allow_once", "allow_always") : pick("reject_once", "reject_always");
    const decision = allowed && option ? "allowed" : "rejected";
    if (decision === "rejected") {
      const input = call.rawInput !== undefined ? call.rawInput : undefined;
      this.denied.push({ tool_name: `${title} [${kind}]`, tool_use_id: id, ...(input !== undefined ? { tool_input: input } : {}) });
    }
    this.permission({
      toolCallId: id,
      title,
      kind,
      decision,
      ...(option ? { option: String(option.kind) } : {}),
      tier: this.spec.tier,
    });
    // No option to reject with (or the turn is over): the request is cancelled, which allows nothing.
    return option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" };
  }

  private permission(permission: AcpPermission): void {
    this.out({ type: "acp.permission", ...permission });
    try {
      this.spec.onPermission?.(permission);
    } catch {
      // the run's record of it failing never changes the answer
    }
  }

  private flushText(): void {
    this.flushMessage();
    this.flushThought();
  }

  private flushMessage(): void {
    const message = this.message;
    this.message = null;
    if (!message || !message.text) return;
    this.replyText += message.text;
    if (message.text.trim()) this.lastText = message.text;
    this.out({ type: "acp.message", text: message.text });
  }

  private flushThought(): void {
    const text = this.thought;
    this.thought = "";
    if (text) this.out({ type: "acp.thought", text });
  }
}

/** A JSON-RPC error response, as text and code; null for a result. */
function rpcError(message: Json): { text: string; code?: number } | null {
  if (!("error" in message) || message.error === undefined || message.error === null) return null;
  const error = isRecord(message.error) ? message.error : {};
  const code = typeof error.code === "number" ? error.code : undefined;
  const text = typeof error.message === "string" && error.message ? error.message : JSON.stringify(message.error);
  const data = isRecord(error.data) && typeof error.data.message === "string" ? ` — ${error.data.message}` : "";
  return { text: `${text}${data}${code !== undefined ? ` (code ${code})` : ""}`, ...(code !== undefined ? { code } : {}) };
}

/** A content block's text: a text block's, else nothing (images, audio, resources are not a reply). */
function chunkText(content: unknown): string {
  return isRecord(content) && content.type === "text" && typeof content.text === "string" ? content.text : "";
}

/** What a finished tool call produced, as text: its content blocks, a diff's path, else its raw output. */
function toolOutput(content: unknown, raw: unknown): string {
  const parts: string[] = [];
  for (const item of Array.isArray(content) ? content : []) {
    if (!isRecord(item)) continue;
    if (item.type === "content") {
      const text = chunkText(item.content);
      if (text) parts.push(text);
    } else if (item.type === "diff" && typeof item.path === "string") {
      parts.push(`diff ${item.path}`);
    } else if (item.type === "terminal" && typeof item.terminalId === "string") {
      parts.push(`terminal ${item.terminalId}`);
    }
  }
  let text = parts.join("\n");
  if (!text && raw !== undefined && raw !== null) text = typeof raw === "string" ? raw : (JSON.stringify(raw) ?? "");
  return text.length > MAX_TOOL_OUTPUT_CHARS ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n[… cut at ${MAX_TOOL_OUTPUT_CHARS} characters]` : text;
}

/**
 * A prompt response's `usage` (a draft of the protocol: camelCase per turn,
 * or snake_case) in ODW's own field names; undefined without one.
 */
function turnUsage(raw: unknown): Json | undefined {
  if (!isRecord(raw)) return undefined;
  const pick = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const value = raw[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
    }
    return undefined;
  };
  const usage: Json = {};
  const set = (key: string, value: number | undefined): void => {
    if (value !== undefined) usage[key] = value;
  };
  set("inputTokens", pick("inputTokens", "input_tokens"));
  set("outputTokens", pick("outputTokens", "output_tokens"));
  set("cacheReadTokens", pick("cachedReadTokens", "cached_read_tokens"));
  set("cacheWriteTokens", pick("cachedWriteTokens", "cached_write_tokens"));
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
