/**
 * Reading agent transcripts (L5; an ODW extension): the lines a
 * TranscriptRecorder (../transcript) kept, normalized into entries a person
 * can follow — what `odw logs --agent` prints and
 * `GET /api/runs/:id/agents/:agentId/transcript` serves.
 *
 * Each line becomes zero or more {@link TranscriptEntry}s, numbered from 0 in
 * order (`i`, what `?since=` counts). Normalizing is a pure function of the
 * lines; all it carries from one line to the next is the names of the tools
 * called so far, so that a result names its tool:
 *
 *   Claude Code stream-json  system init → raw (model and tools); assistant
 *                            text → text, thinking → text (`thinking`),
 *                            tool_use → tool_call {tool, input}; user
 *                            tool_result → tool_result {output, isError};
 *                            system api_retry and permission_denied → error;
 *                            result → result {isError, turns, costUsd};
 *                            stream_event (partial messages) → nothing
 *   kilo / opencode          text → text; reasoning → text (`thinking`);
 *                            tool_use → tool_call and tool_result; error →
 *                            error; step_start / step_finish → nothing
 *   Codex `exec --json`      thread.started → raw; turn.started → nothing;
 *                            items: agent_message → text, reasoning → text
 *                            (`thinking`), command_execution → tool_call
 *                            `shell` {command} then tool_result (ok: exit 0,
 *                            its output), file_change → tool_call `edit`
 *                            {paths}, mcp_tool_call → tool_call
 *                            `server.tool` then tool_result, web_search →
 *                            tool_call `web_search` {query}, todo_list → raw
 *                            (the list), error → error; turn.completed →
 *                            result; turn.failed → result (failed); error →
 *                            error
 *   ODW's own lines          {"kind":"text"} → text; attempt (with the
 *                            adapter a fallback moved to); truncated
 *   anything else            raw: the line itself
 *
 * Long fields — text, output, input — are clipped to 4 KB and the entry
 * marked `clipped: true`; `odw logs --raw` prints the lines as they were kept.
 * An entry whose fields hold a `«redacted:<kind>»` marker — a secret the
 * recorder kept out (an ODW extension; see ../redact) — is marked `redacted: true`.
 */

import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";

import { formatBytes } from "../changes.js";
import type { WorkflowEvent } from "../events.js";
import { hasMarker } from "../redact.js";
import { attemptLabel, fitField } from "../transcript.js";
import { fmtUsd, palette, sanitizeText, truncateToWidth, type TermCaps } from "../tty.js";
import type { AgentRow } from "./agents-view.js";
import { RunObserver } from "./run-liveness.js";
import type { RunStore } from "./run-store.js";

export type TranscriptKind = "text" | "tool_call" | "tool_result" | "error" | "attempt" | "result" | "raw" | "truncated";

/** One step of an agent's transcript, normalized for reading (a wire contract: web/src/types.ts mirrors it). */
export interface TranscriptEntry {
  /** Its place in the transcript, from 0: what `?since=` counts. */
  i: number;
  kind: TranscriptKind;
  /**
   * text: what the agent wrote; tool_call: what the call is about (the
   * command, the file, …); tool_result: its exit code and size ("exit 1, 12
   * lines"); the other kinds: what happened, in a sentence.
   */
  text?: string;
  /** tool_call, tool_result (and a refused permission): the tool. */
  tool?: string;
  /** tool_call: the tool's input — as JSON text, cut, when it is longer than 4 KB. */
  input?: unknown;
  /** tool_result: what the tool returned. */
  output?: string;
  /** tool_result, result: the tool, or the whole session, failed. */
  isError?: boolean;
  /** A field was cut at 4 KB. */
  clipped?: true;
  /** text: the agent's thinking (a thinking block, a reasoning event), not its reply. */
  thinking?: true;
  /** attempt: which CLI run of the call begins (2 = the first one more) and why: schema, stall, rate_limit, expect, fallback. */
  n?: number;
  reason?: string;
  /** attempt, for a fallback (an ODW extension): the adapter the call moved to. */
  adapter?: string;
  /** truncated: the bytes kept before the cut. */
  bytes?: number;
  /** result: the turns the session took and what it cost, as its CLI reported. */
  turns?: number;
  costUsd?: number;
  /** Secrets in it were kept out as `«redacted:<kind>»` (an ODW extension). */
  redacted?: true;
}

/** GET /api/runs/:id/agents/:agentId/transcript?since=<i> */
export interface TranscriptPage {
  /** The entries from `since` on, at most {@link TRANSCRIPT_PAGE_ENTRIES}. */
  entries: TranscriptEntry[];
  /** The `since` of the next page: one past the last entry here. */
  next: number;
  /** More entries are on disk already: ask for `next` at once. */
  more: boolean;
  /** The transcript reached maxTranscriptBytes: the agent's later output was not kept. */
  truncated: boolean;
  /** The agent was replayed by odw resume: no CLI ran, so it has no transcript (no entries). */
  replayed: boolean;
}

/** Entries one page of the transcript API holds at most. */
export const TRANSCRIPT_PAGE_ENTRIES = 1000;

type Draft = Omit<TranscriptEntry, "i">;

/** Tool calls whose ids are remembered, so their results name the tool: the latest ones. */
const TOOL_IDS_KEPT = 4096;

// --- normalizing ----------------------------------------------------------------

/**
 * Normalizes a transcript line by line — the incremental form of
 * {@link normalizeTranscript}, for a reader following one as it grows.
 */
export class TranscriptNormalizer {
  private count = 0;
  private readonly tools = new Map<string, string>();
  /** The transcript was cut at maxTranscriptBytes (its truncation line went by). */
  truncated = false;

  /** The entries one line makes: none for a blank line, or an event shown otherwise. */
  line(line: string): TranscriptEntry[] {
    return normalizeLine(line, this.tools).map((draft) => {
      if (draft.kind === "truncated") this.truncated = true;
      return finish(this.count++, draft);
    });
  }
}

/** A whole transcript (its file's text), normalized. */
export function normalizeTranscript(text: string): TranscriptEntry[] {
  const normalizer = new TranscriptNormalizer();
  return text.split("\n").flatMap((line) => normalizer.line(line));
}

/** What one line says, as entries without their place. `tools` (tool id → name) is read and added to. */
function normalizeLine(line: string, tools: Map<string, string>): Draft[] {
  const text = line.trim();
  if (!text) return [];
  let event: unknown;
  try {
    event = JSON.parse(text);
  } catch {
    return [{ kind: "raw", text }]; // a CLI's stray notice
  }
  if (!isRecord(event)) return [{ kind: "raw", text }];
  if (typeof event.type !== "string") return odwLine(event, text);
  switch (event.type) {
    // Claude Code stream-json (https://code.claude.com/docs/en/headless)
    case "system":
      return claudeSystem(event, text);
    case "assistant":
      return claudeAssistant(event, tools);
    case "user":
      return claudeUser(event, tools);
    case "result":
      return [claudeResult(event)];
    case "stream_event":
      return []; // a partial message: the whole one follows
    // kilo / opencode `run --format json`
    case "text":
    case "reasoning":
      return opencodeText(event);
    case "tool_use":
      return opencodeTool(event, tools);
    case "step_start":
    case "step_finish":
      return [];
    // Codex `exec --json` (codex-rs/exec/src/exec_events.rs)
    case "thread.started":
      return [{ kind: "raw", text: typeof event.thread_id === "string" ? `thread ${event.thread_id} started` : "thread started" }];
    case "turn.started":
      return [];
    case "turn.completed":
      return [{ kind: "result", isError: false }];
    case "turn.failed":
      return [{ kind: "result", isError: true, text: errorMessage(event.error) ?? "turn failed" }];
    case "item.started":
    case "item.updated":
    case "item.completed":
      return codexItem(event.type, event.item, tools, text);
    case "error":
      // opencode's { error: {…} }; Codex's { message }.
      return [{ kind: "error", text: errorMessage(event.error) ?? errorMessage(event) ?? text }];
    default:
      return [{ kind: "raw", text }];
  }
}

/** ODW's own lines: the text of a non-JSONL adapter, a further CLI run, the cut. */
function odwLine(line: Record<string, unknown>, text: string): Draft[] {
  switch (line.kind) {
    case "text":
      return typeof line.text === "string" && line.text !== "" ? [{ kind: "text", text: line.text }] : [];
    case "attempt": {
      const n = typeof line.n === "number" ? line.n : undefined;
      const reason = typeof line.reason === "string" ? line.reason : undefined;
      const adapter = typeof line.adapter === "string" ? line.adapter : undefined;
      const draft: Draft = { kind: "attempt", text: `attempt ${n ?? "?"}: ${attemptLabel(reason, adapter)}` };
      if (n !== undefined) draft.n = n;
      if (reason !== undefined) draft.reason = reason;
      if (adapter !== undefined) draft.adapter = adapter;
      return [draft];
    }
    case "truncated": {
      const bytes = typeof line.bytes === "number" ? line.bytes : undefined;
      const at = bytes !== undefined ? ` at ${formatBytes(bytes)}` : "";
      const draft: Draft = {
        kind: "truncated",
        text: `transcript cut${at} (maxTranscriptBytes): the rest of the agent's output was not kept`,
      };
      if (bytes !== undefined) draft.bytes = bytes;
      return [draft];
    }
    default:
      return [{ kind: "raw", text }];
  }
}

function claudeSystem(event: Record<string, unknown>, text: string): Draft[] {
  switch (event.subtype) {
    case "init": {
      const tools = strings(event.tools);
      const said = [
        typeof event.model === "string" && event.model ? `model ${event.model}` : null,
        tools.length > 0 ? `${tools.length} tools: ${tools.join(", ")}` : null,
      ].filter((part) => part !== null);
      return [{ kind: "raw", text: said.length > 0 ? said.join(" · ") : "session started" }];
    }
    case "api_retry": {
      const what = [
        typeof event.error === "string" && event.error ? event.error : null,
        typeof event.error_status === "number" ? `HTTP ${event.error_status}` : null,
      ].filter((part) => part !== null);
      const delay = typeof event.retry_delay_ms === "number" ? ` in ${(event.retry_delay_ms / 1000).toFixed(1)}s` : "";
      const attempt =
        typeof event.attempt === "number"
          ? ` (attempt ${event.attempt}${typeof event.max_retries === "number" ? ` of ${event.max_retries}` : ""})`
          : "";
      return [{ kind: "error", text: `API request failed${what.length ? ` (${what.join(", ")})` : ""} — retrying${delay}${attempt}` }];
    }
    case "permission_denied": {
      const draft: Draft = {
        kind: "error",
        text: typeof event.message === "string" && event.message ? event.message : "permission denied",
      };
      if (typeof event.tool_name === "string") draft.tool = event.tool_name;
      return [draft];
    }
    case "compact_boundary": {
      const meta = isRecord(event.compact_metadata) ? event.compact_metadata : {};
      const before = typeof meta.pre_tokens === "number" ? `; ${meta.pre_tokens} tokens before` : "";
      return [{ kind: "raw", text: `context compacted (${typeof meta.trigger === "string" ? meta.trigger : "auto"}${before})` }];
    }
    case "informational":
      return typeof event.content === "string" && event.content ? [{ kind: "raw", text: event.content }] : [];
    default:
      return [{ kind: "raw", text }];
  }
}

function claudeAssistant(event: Record<string, unknown>, tools: Map<string, string>): Draft[] {
  const message = isRecord(event.message) ? event.message : {};
  const content = Array.isArray(message.content)
    ? message.content
    : typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : [];
  // The message reports an API error (rate_limit, authentication_failed, …): its text is that error.
  const failed = typeof event.error === "string" && event.error !== "";
  const out: Draft[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    switch (block.type) {
      case "text":
        if (typeof block.text === "string" && block.text.trim()) out.push({ kind: failed ? "error" : "text", text: block.text });
        break;
      case "thinking":
        if (typeof block.thinking === "string" && block.thinking.trim()) out.push({ kind: "text", text: block.thinking, thinking: true });
        break;
      case "redacted_thinking":
        break;
      case "tool_use":
      case "server_tool_use":
      case "mcp_tool_use":
        out.push(toolCall(block.id, block.name, block.input, tools));
        break;
      default:
        // A server tool's result (web search, …) comes in the assistant's own message.
        if (typeof block.type === "string" && block.type.endsWith("_tool_result")) {
          const error = isRecord(block.content) && String(block.content.type ?? "").endsWith("_error");
          out.push(toolResult(toolName(tools, block.tool_use_id), contentText(block.content), block.is_error === true || error));
        } else {
          out.push({ kind: "raw", text: compact(block) });
        }
    }
  }
  if (failed && !out.some((draft) => draft.kind === "error")) out.push({ kind: "error", text: `API error: ${String(event.error)}` });
  return out;
}

function claudeUser(event: Record<string, unknown>, tools: Map<string, string>): Draft[] {
  const message = isRecord(event.message) ? event.message : {};
  // Not a tool's result: what the agent was told (a subagent's prompt, a command's expansion).
  if (typeof message.content === "string") return message.content.trim() ? [{ kind: "raw", text: message.content }] : [];
  if (!Array.isArray(message.content)) return [{ kind: "raw", text: compact(event) }];
  const out: Draft[] = [];
  for (const block of message.content) {
    if (!isRecord(block)) continue;
    if (block.type === "tool_result") {
      out.push(toolResult(toolName(tools, block.tool_use_id), contentText(block.content), block.is_error === true));
    } else if (block.type === "text") {
      if (typeof block.text === "string" && block.text.trim()) out.push({ kind: "raw", text: block.text });
    } else {
      out.push({ kind: "raw", text: compact(block) });
    }
  }
  return out;
}

function claudeResult(event: Record<string, unknown>): Draft {
  const errors = strings(event.errors);
  const text =
    typeof event.result === "string" && event.result.trim()
      ? event.result
      : errors.length > 0
        ? errors.join("\n")
        : typeof event.subtype === "string"
          ? event.subtype
          : "";
  const draft: Draft = { kind: "result", isError: event.is_error === true };
  if (text) draft.text = text;
  if (typeof event.num_turns === "number") draft.turns = event.num_turns;
  if (typeof event.total_cost_usd === "number") draft.costUsd = event.total_cost_usd;
  return draft;
}

function opencodeText(event: Record<string, unknown>): Draft[] {
  const part = isRecord(event.part) ? event.part : {};
  if (typeof part.text !== "string" || !part.text.trim()) return [];
  return [event.type === "reasoning" ? { kind: "text", text: part.text, thinking: true } : { kind: "text", text: part.text }];
}

/** opencode reports a tool once it is done, call and result together: two entries. */
function opencodeTool(event: Record<string, unknown>, tools: Map<string, string>): Draft[] {
  const part = isRecord(event.part) ? event.part : {};
  const state = isRecord(part.state) ? part.state : {};
  const call = toolCall(part.callID ?? part.id, part.tool, state.input, tools);
  if (state.status === "error") return [call, toolResult(call.tool, errorMessage(state.error) ?? "", true)];
  if (state.status !== "completed") return [call];
  const output = typeof state.output === "string" ? state.output : contentText(state.output);
  return [call, toolResult(call.tool, output, false, exitStatus(state.metadata))];
}

/**
 * A Codex item event (`item.started`, `item.updated`, `item.completed`). A
 * tool's call shows when its item starts — or with its result, when its start
 * never came (a file change has none) — and its result when it completes;
 * what the agent wrote and thought shows once it is complete. An item of a
 * type this does not know stays a raw line.
 */
function codexItem(phase: string, raw: unknown, tools: Map<string, string>, line: string): Draft[] {
  if (!isRecord(raw)) return [{ kind: "raw", text: line }];
  const item = raw;
  const id = typeof item.id === "string" && item.id ? item.id : undefined;
  const done = phase === "item.completed";
  const called = id !== undefined && tools.has(id);
  /** Its call, unless its start showed it already. */
  const call = (name: string, input: unknown, about?: string): Draft[] => {
    if (called) return [];
    const draft = toolCall(id, name, input, tools);
    if (about) draft.text = about;
    return [draft];
  };
  /** A completed item's entries; its id is let go (a retry's items count from 0 again). */
  const completed = (drafts: Draft[]): Draft[] => {
    if (id !== undefined) tools.delete(id);
    return drafts;
  };
  const words = (value: unknown): string => (typeof value === "string" ? value : "");
  switch (item.type) {
    case "agent_message":
    case "reasoning": {
      const text = words(item.text);
      if (!done || !text.trim()) return [];
      return [item.type === "reasoning" ? { kind: "text", text, thinking: true } : { kind: "text", text }];
    }
    case "command_execution": {
      const input = { command: words(item.command) };
      if (!done) return phase === "item.started" ? call("shell", input) : [];
      const exit = typeof item.exit_code === "number" ? item.exit_code : undefined;
      const declined = item.status === "declined";
      const failed = declined || item.status === "failed" || (exit !== undefined && exit !== 0);
      const result = toolResult("shell", words(item.aggregated_output), failed, exit);
      if (declined) result.text = "declined";
      return completed([...call("shell", input), result]);
    }
    case "file_change": {
      const changes = Array.isArray(item.changes) ? item.changes.filter(isRecord) : [];
      const paths = changes.map((change) => [words(change.kind), words(change.path)].filter(Boolean).join(" ")).join(", ");
      if (!done) return phase === "item.started" ? call("edit", item.changes, paths) : [];
      const failed = item.status === "failed";
      return completed([...call("edit", item.changes, paths), ...(failed ? [toolResult("edit", "the patch was not applied", true)] : [])]);
    }
    case "mcp_tool_call": {
      const name = [words(item.server), words(item.tool)].filter(Boolean).join(".") || "mcp";
      if (!done) return phase === "item.started" ? call(name, item.arguments) : [];
      const result = isRecord(item.result) ? item.result : {};
      const error = errorMessage(item.error);
      const failed = item.status === "failed" || error !== undefined;
      const output = error ?? contentText(result.content ?? result.structured_content);
      return completed([...call(name, item.arguments), toolResult(name, output, failed)]);
    }
    case "web_search": {
      const action = isRecord(item.action) ? item.action : {};
      const about = [item.query, action.query, action.url, action.pattern].find((v): v is string => typeof v === "string" && v.trim() !== "");
      // A search may start before its query is known: it shows once it has one.
      if (!done) return phase === "item.started" && about ? call("web_search", { query: item.query, action: item.action }, about) : [];
      return completed(call("web_search", { query: item.query, action: item.action }, about));
    }
    case "todo_list": {
      const steps = (Array.isArray(item.items) ? item.items.filter(isRecord) : []).map(
        (step) => `${step.completed === true ? "[x]" : "[ ]"} ${words(step.text)}`,
      );
      return [{ kind: "raw", text: steps.length > 0 ? `to-do: ${steps.join(" · ")}` : "to-do list" }];
    }
    case "error":
      // A warning codex surfaced as an item: the run goes on.
      return done ? [{ kind: "error", text: words(item.message) || line }] : [];
    default:
      return [{ kind: "raw", text: line }];
  }
}

function toolCall(id: unknown, name: unknown, input: unknown, tools: Map<string, string>): Draft {
  const tool = typeof name === "string" && name ? name : "tool";
  if (typeof id === "string" && id) {
    tools.delete(id);
    tools.set(id, tool);
    if (tools.size > TOOL_IDS_KEPT) tools.delete(tools.keys().next().value!);
  }
  const draft: Draft = { kind: "tool_call", tool };
  if (input !== undefined) draft.input = input;
  const about = toolSummary(input);
  if (about) draft.text = about;
  return draft;
}

function toolResult(tool: string | undefined, output: string, isError: boolean, exit?: number): Draft {
  const code = exit ?? (isError ? exitCodeOf(output) : undefined);
  const lines = countLines(output);
  const size = lines === 0 ? "no output" : `${lines} line${lines === 1 ? "" : "s"}`;
  const draft: Draft = { kind: "tool_result", text: code !== undefined ? `exit ${code}, ${size}` : size, output, isError };
  if (tool) draft.tool = tool;
  return draft;
}

function toolName(tools: Map<string, string>, id: unknown): string | undefined {
  return typeof id === "string" ? tools.get(id) : undefined;
}

/** The input fields that say what a call is about, in the order they are looked for. */
const SUMMARY_FIELDS = [
  "command",
  "file_path",
  "filePath",
  "notebook_path",
  "pattern",
  "path",
  "url",
  "query",
  "description",
  "prompt",
  "skill",
];

/** What a tool call is about: its command, file, pattern, URL, … — else its input as JSON. */
function toolSummary(input: unknown): string | undefined {
  if (typeof input === "string") return input || undefined;
  if (!isRecord(input)) return input === undefined || input === null ? undefined : compact(input);
  for (const field of SUMMARY_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) return value;
  }
  const json = compact(input);
  return json === "{}" ? undefined : json;
}

/** The exit code a failed shell call states (Claude Code's Bash: "Exit code 1"). */
function exitCodeOf(output: string): number | undefined {
  const match = /^(?:Error: )?Exit code (\d+)/.exec(output);
  return match ? Number(match[1]) : undefined;
}

/** The exit code opencode's shell tool records with a result. */
function exitStatus(metadata: unknown): number | undefined {
  if (!isRecord(metadata)) return undefined;
  if (typeof metadata.exit === "number") return metadata.exit;
  return isRecord(metadata.metadata) && typeof metadata.metadata.exit === "number" ? metadata.metadata.exit : undefined;
}

/** A tool result's content as text: a string as is, text blocks joined, an image named, anything else as JSON. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === undefined || content === null) return "";
  if (!Array.isArray(content)) return compact(content);
  return content
    .map((block) =>
      isRecord(block) && block.type === "text" && typeof block.text === "string"
        ? block.text
        : isRecord(block) && block.type === "image"
          ? "[image]"
          : compact(block),
    )
    .join("\n");
}

/** An error as its message: a string, an error object's `message` (or its `data.message`), its name. */
function errorMessage(error: unknown): string | undefined {
  if (typeof error === "string") return error || undefined;
  if (!isRecord(error)) return undefined;
  if (typeof error.message === "string" && error.message) return error.message;
  if (isRecord(error.data) && typeof error.data.message === "string" && error.data.message) return error.data.message;
  return typeof error.name === "string" && error.name ? error.name : compact(error);
}

/** Number an entry and clip its long fields at 4 KB, saying so — and that a secret was kept out of it. */
function finish(i: number, draft: Draft): TranscriptEntry {
  const entry: TranscriptEntry = { i, ...draft };
  const input = entry.input === undefined || typeof entry.input === "string" ? entry.input : compact(entry.input);
  if ([entry.text, entry.output, input].some((field) => field !== undefined && hasMarker(field))) entry.redacted = true;
  let clipped = false;
  const cut = (text: string): string => {
    const n = fitField(text);
    if (n >= text.length) return text;
    clipped = true;
    return text.slice(0, n);
  };
  if (entry.text !== undefined) entry.text = cut(entry.text);
  if (entry.output !== undefined) entry.output = cut(entry.output);
  if (typeof entry.input === "string") {
    entry.input = cut(entry.input);
  } else if (input !== undefined && fitField(input) < input.length) {
    entry.input = cut(input);
  }
  if (clipped) entry.clipped = true;
  return entry;
}

function countLines(text: string): number {
  if (!text) return 0;
  let lines = 0;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) lines++;
  return text.endsWith("\n") ? lines : lines + 1;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function compact(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// --- reading ------------------------------------------------------------------------

/** Bytes read from a transcript at a time. */
const READ_BLOCK = 1024 * 1024;

/**
 * Follows a file of lines as it grows: each read hands over the complete lines
 * appended since the last one (a line still being written waits for the next),
 * starting over when the file was replaced (another inode, or shorter).
 */
export class LineTail {
  private offset = 0;
  private ino: number | undefined;

  constructor(readonly path: string) {}

  /** Hand each new complete line to `onLine`, after `onReset` when the file was replaced. False: no such file. */
  read(onLine: (line: string) => void, onReset?: () => void): boolean {
    let fd: number;
    try {
      fd = openSync(this.path, "r");
    } catch {
      return false;
    }
    try {
      const { size, ino } = fstatSync(fd);
      if ((this.ino !== undefined && ino !== this.ino) || size < this.offset) {
        this.offset = 0;
        onReset?.();
      }
      this.ino = ino;
      const block = Buffer.alloc(Math.min(READ_BLOCK, size - this.offset));
      let pending: Buffer[] = []; // the start of a line longer than the block
      for (let pos = this.offset; pos < size; ) {
        const got = readSync(fd, block, 0, Math.min(block.length, size - pos), pos);
        if (got <= 0) break;
        const view = block.subarray(0, got);
        let start = 0;
        for (let nl = view.indexOf(0x0a); nl !== -1; nl = view.indexOf(0x0a, start)) {
          const piece = view.subarray(start, nl);
          const line = pending.length > 0 ? Buffer.concat([...pending, piece]) : piece;
          pending = [];
          start = nl + 1;
          this.offset = pos + start;
          onLine(line.toString("utf8"));
        }
        if (start < got) pending.push(Buffer.from(view.subarray(start))); // a copy: the block is reused
        pos += got;
      }
      return true;
    } finally {
      closeSync(fd);
    }
  }
}

/** A transcript read so far, normalized — read on from where it stopped as the file grows. */
export class TranscriptLog {
  readonly entries: TranscriptEntry[] = [];
  private normalizer = new TranscriptNormalizer();
  private readonly tail: LineTail;

  constructor(path: string) {
    this.tail = new LineTail(path);
  }

  get truncated(): boolean {
    return this.normalizer.truncated;
  }

  /** Read what was added since; false when there is no transcript file. */
  update(): boolean {
    return this.tail.read(
      (line) => {
        for (const entry of this.normalizer.line(line)) this.entries.push(entry);
      },
      () => {
        this.entries.length = 0;
        this.normalizer = new TranscriptNormalizer();
      },
    );
  }

  page(since: number, replayed: boolean): TranscriptPage {
    return transcriptPage(this.entries, since, this.truncated, replayed);
  }
}

/** One page of a transcript's entries, from `since` on. */
export function transcriptPage(
  entries: readonly TranscriptEntry[],
  since: number,
  truncated: boolean,
  replayed: boolean,
): TranscriptPage {
  const page = entries.slice(since, since + TRANSCRIPT_PAGE_ENTRIES);
  const next = since + page.length;
  return { entries: page, next, more: next < entries.length, truncated, replayed };
}

// --- printing (odw logs --agent) ------------------------------------------------------------

/** Lines of an agent's stderr `odw logs --agent` shows: the last ones. */
const STDERR_LINES_SHOWN = 20;

export interface TranscriptPrintOptions {
  caps: TermCaps;
  /** Columns a one-line entry is cut to. */
  width: number;
}

/** The marks entries are printed with: Unicode, else ASCII. */
function marks(caps: TermCaps) {
  return caps.unicode
    ? { call: "▸", ok: "✓", fail: "✗", done: "■", rule: "──", dot: "·", cut: "…" }
    : { call: ">", ok: "ok", fail: "x", done: "#", rule: "--", dot: "-", cut: "..." };
}

/**
 * The lines `odw logs --agent` prints for one entry: what the agent wrote as
 * it wrote it, each tool call (`▸ Bash  npm test`) and result (`✓ Bash result
 * (312 lines)`; a failed one with its first line), errors, further CLI runs
 * and how the session ended. Everything an agent printed is sanitized.
 */
export function formatTranscriptEntry(entry: TranscriptEntry, opts: TranscriptPrintOptions): string[] {
  const p = palette(opts.caps);
  const m = marks(opts.caps);
  const width = Math.max(20, opts.width);
  const one = (line: string): string => truncateToWidth(line, width);
  const tool = sanitizeText(entry.tool ?? "tool", 60);
  switch (entry.kind) {
    case "text": {
      const lines = textLines(entry.text ?? "");
      if (entry.thinking) {
        lines[0] = `thinking: ${lines[0] ?? ""}`;
        for (let i = 0; i < lines.length; i++) lines[i] = p.dim(lines[i]!);
      }
      if (entry.clipped) lines.push(p.dim(`${m.cut} (cut at 4 KB: --raw prints it whole)`));
      return lines;
    }
    case "tool_call":
      return [one(`${p.run(m.call)} ${p.bold(tool)}  ${sanitizeText(entry.text ?? "", width)}`)];
    case "tool_result": {
      if (!entry.isError) return [one(`${p.ok(m.ok)} ${tool} result (${entry.text ?? ""})`)];
      const why = firstLine(entry.output);
      return [one(`${p.err(m.fail)} ${tool} error (${entry.text ?? ""})${why ? `: ${sanitizeText(why, width)}` : ""}`)];
    }
    case "error":
      return [one(`${p.err(m.fail)} ${entry.tool ? `${tool}: ` : ""}${sanitizeText(entry.text ?? "error", width)}`)];
    case "attempt":
      return [one(p.run(`${m.rule} ${sanitizeText(entry.text ?? "attempt", width)} ${m.rule}`))];
    case "result": {
      const stats = [
        entry.turns !== undefined ? `${entry.turns} turn${entry.turns === 1 ? "" : "s"}` : null,
        entry.costUsd !== undefined ? fmtUsd(entry.costUsd) : null,
      ].filter((part) => part !== null);
      const after = stats.length > 0 ? ` ${m.dot} ${stats.join(` ${m.dot} `)}` : "";
      if (!entry.isError) return [one(`${p.ok(m.done)} done${after}`)];
      return [one(`${p.err(m.fail)} failed: ${sanitizeText(firstLine(entry.text) ?? "", width)}${after}`)];
    }
    case "truncated":
      return [one(p.run(`${m.cut} ${sanitizeText(entry.text ?? "", width)}`))];
    default:
      return [one(p.dim(`${m.dot} ${sanitizeText(entry.text ?? "", width)}`))];
  }
}

/** Text as printable lines: each sanitized, its indentation kept. */
function textLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => {
    const indent = /^[ \t]*/.exec(line)![0].replace(/\t/g, "  ");
    return indent + sanitizeText(line, 4096);
  });
}

/** The first line that says something — past a shell's "Exit code N", which the summary has. */
function firstLine(text: string | undefined): string | undefined {
  for (const line of (text ?? "").split("\n")) {
    if (line.trim() && !/^(?:Error: )?Exit code \d+\s*$/.test(line)) return line;
  }
  return undefined;
}

/** Where `odw logs --agent` writes. */
export interface Writer {
  write(text: string): unknown;
}

export interface AgentLogsOptions extends TranscriptPrintOptions {
  /** Print the transcript's lines as kept instead of readable entries. */
  raw: boolean;
  /** Keep printing what it adds until the agent settles. */
  follow: boolean;
  out: Writer;
  err: Writer;
  /** How long a follower waits between reads (ms). */
  pollMs?: number;
}

/**
 * `odw logs <run> --agent <id|label> [--raw] [--follow]` (ODW extension):
 * print one agent's transcript — readable, then the end of its stderr; or with
 * `--raw` the lines as kept — and with `--follow` go on printing what it adds
 * until the agent settles. Exit 0; following an agent that failed, or whose
 * run ended without it settling, exits 1.
 */
export async function printAgentLogs(
  store: RunStore,
  runId: string,
  row: AgentRow & { agentId: number },
  opts: AgentLogsOptions,
): Promise<number> {
  const who = `agent ${row.agentId} (${sanitizeText(row.label, 80)})`;
  if (row.cached) {
    const from = row.record?.sourceRunId;
    const there = from ? ` — the run that ran it: odw logs ${from} --agent ${JSON.stringify(row.label)}` : "";
    opts.err.write(`${who} was replayed by odw resume: no CLI ran, so it has no transcript${there}\n`);
    return 0;
  }
  const paths = store.agentTranscriptPaths(runId, row.agentId);
  const tail = new LineTail(paths.transcript);
  let normalizer = new TranscriptNormalizer();
  let shown = 0;
  const read = (): boolean =>
    tail.read(
      (line) => {
        if (opts.raw) {
          if (!line.trim()) return;
          opts.out.write(`${line}\n`);
          shown++;
          return;
        }
        for (const entry of normalizer.line(line)) {
          for (const text of formatTranscriptEntry(entry, opts)) opts.out.write(`${text}\n`);
          shown++;
        }
      },
      () => {
        normalizer = new TranscriptNormalizer();
        opts.err.write(`odw logs: the transcript of ${who} was replaced; printing it again\n`);
      },
    );

  let found = read();
  let code = 0;
  if (opts.follow) {
    const observer = new RunObserver(store, runId);
    for (;;) {
      // The transcript is complete before the agent's terminal event: read it after seeing one.
      const seen = observer.read();
      const settled = seen.events.find(
        (ev: WorkflowEvent) => (ev.type === "agent_finished" || ev.type === "agent_failed") && ev.agentId === row.agentId,
      );
      found = read() || found;
      if (settled) {
        code = settled.type === "agent_finished" ? 0 : 1;
        break;
      }
      if (seen.terminal || seen.error) {
        opts.err.write(`odw logs: ${seen.error ?? `run ${runId} ended`} before ${who} settled\n`);
        code = 1;
        break;
      }
      await new Promise((done) => setTimeout(done, opts.pollMs ?? 300));
    }
  }
  if (!found) {
    const why =
      row.state === "running" && !opts.follow
        ? "it has printed nothing yet (--follow waits for it)"
        : "this run kept none (it predates agent transcripts, or maxTranscriptBytes is 0)";
    opts.err.write(`${who} has no transcript: ${why}\n`);
  } else if (shown === 0) {
    // One that failed before its CLI printed anything (a worktree setup that failed, say) says why.
    const why = row.state === "failed" && row.error ? `; it failed: ${sanitizeText(row.error, 300)}` : "";
    opts.err.write(`${who} printed nothing on stdout${row.state === "running" ? " yet" : ""}${why}\n`);
  }
  if (!opts.raw) printStderrTail(paths.stderr, opts);
  return code;
}

/** The end of an agent's stderr, after its transcript: the last lines, and where the rest is. */
function printStderrTail(path: string, opts: AgentLogsOptions): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return; // it printed nothing on stderr
  }
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return;
  const p = palette(opts.caps);
  const m = marks(opts.caps);
  const shown = lines.slice(-STDERR_LINES_SHOWN);
  const which = lines.length > shown.length ? `last ${shown.length} of ${lines.length} lines; all: ${path}` : path;
  // Never cut: the path is what gets copied.
  opts.out.write(`${p.dim(`${m.rule} stderr (${which}) ${m.rule}`)}\n`);
  for (const line of textLines(shown.join("\n"))) opts.out.write(`${truncateToWidth(line, Math.max(20, opts.width))}\n`);
}
