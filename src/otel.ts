/**
 * A run as OpenTelemetry traces (an ODW extension): a pure mapper from what a
 * run directory keeps — its events, saved results and transcripts — to the
 * OTLP/JSON `resourceSpans` an OTLP/HTTP receiver takes at `/v1/traces`,
 * after the GenAI semantic conventions (status "Development";
 * https://github.com/open-telemetry/semantic-conventions-genai):
 *
 *   invoke_workflow <name>   the run (INTERNAL): gen_ai.operation.name
 *                            "invoke_workflow", gen_ai.workflow.name, and
 *                            odw.run.id, odw.workflow.name, odw.run.state and
 *                            the run's totals (odw.run.usage.*, odw.run.cost_usd:
 *                            odw keys, so a backend that sums gen_ai.usage.*
 *                            over a trace does not count them twice). Never
 *                            the run's args. A resumed run links to the run it
 *                            resumed.
 *   phase <title>            each phase that had work, parenting it
 *   invoke_agent <label>     each agent() (CLIENT: its CLI runs out of
 *                            process): gen_ai.operation.name "invoke_agent",
 *                            gen_ai.agent.name and .id ("<runId>/agents/<id>"),
 *                            gen_ai.provider.name (claude → anthropic, codex →
 *                            openai, gemini → gcp.gemini, kimi → moonshot_ai,
 *                            else the adapter's name), gen_ai.request.model and
 *                            gen_ai.response.model, gen_ai.usage.*,
 *                            odw.agent.cost_usd and odw.agent.attempts; a failed
 *                            one has status ERROR and error.type its failure
 *                            reason (rate_limit, quota, …), else its error's
 *                            class. Its retries, fallbacks and quota waits are
 *                            span events — moments within its one span, as the
 *                            run's events record them; links would need spans
 *                            of their own that the run never had.
 *   execute_tool <name>      each tool call its transcript shows:
 *                            gen_ai.tool.name, gen_ai.tool.call.id, and ERROR
 *                            with error.type "tool_error" when the tool failed
 *   exec <label>             each exec() step — an `expect` check under its agent
 *   checkpoint <title>       each checkpoint() wait
 *
 * Ids are derived, never random: the trace id is the first 16 bytes of
 * SHA-256("odw/run/<runId>"), each span id the first 8 bytes of
 * SHA-256("odw/run/<runId>/<what>") — "run", "agent/7", "tool/7/3", … — so
 * exporting a run twice yields the same ids, and a backend that keys on them
 * keeps one copy.
 *
 * Times come from the events (epoch seconds, to the millisecond); a span still
 * open when the run's record ends ends there. A tool call's come from its CLI
 * where it reports them (opencode, kilo); otherwise — Claude Code's stream-json
 * and codex's events carry none — the call is placed by where it and its
 * result sit in the transcript, over the agent's span, and marked
 * `odw.timing.estimated`.
 *
 * A successful span's status stays unset, as the conventions require; only
 * errors set it.
 *
 * Content — replies, tool input and output, error text, exec() command lines,
 * checkpoint payloads and notes, the run's result — is left out unless
 * `captureContent`. Then it is the text odw kept (already redacted, see
 * ./redact), passed through `redact` once more on its way out, each field cut
 * at {@link CONTENT_MAX_CHARS} characters with "…" marking the cut.
 */

import { createHash } from "node:crypto";

import { addUsage, type Usage } from "./adapters/usage.js";
import type { WorkflowEvent } from "./events.js";
import type { AgentResultRecord } from "./journal.js";
import { foldAgents, type AgentView } from "./runtime/runs-view.js";

/** Characters each captured content field keeps; past it, "…" marks the cut. */
export const CONTENT_MAX_CHARS = 4096;

/** Tool spans one agent gets at most; the rest are counted (`odw.agent.tool_spans_dropped`). */
export const MAX_TOOL_SPANS = 1000;

/** Span kinds and status codes, as OTLP/JSON numbers them. */
export const SPAN_KIND = { internal: 1, client: 3 } as const;
export const STATUS_ERROR = 2;

/** What a run directory holds, as the mapper reads it (see runtime/otel-export's readRunRecord). */
export interface RunRecord {
  runId: string;
  meta: Record<string, unknown>;
  status: Record<string, unknown>;
  events: WorkflowEvent[];
  /** error.json, when the run failed. */
  error?: Record<string, unknown> | null;
  /** result.json's value; read only to capture content. */
  result?: () => unknown;
  /** One agent's saved result (its reply); read only to capture content. */
  agentResult?: (agentId: number) => AgentResultRecord | null;
  /** One agent's transcript, a line each, or null when it kept none. */
  transcript?: (agentId: number) => Iterable<string> | null;
}

export interface TraceOptions {
  /** Export content too (see the module doc). */
  captureContent?: boolean;
  /** The resource's attributes: service.name and the rest. */
  resource?: Record<string, string>;
  /** Adapter name → its command's executable: a renamed `claude` is still Anthropic. */
  executables?: Record<string, string>;
  /** What captured content goes through on its way out. */
  redact?: (text: string) => string;
  /** odw's version: the instrumentation scope's. */
  version?: string;
}

// --- OTLP/JSON -----------------------------------------------------------------------

export interface OtlpAnyValue {
  stringValue?: string;
  boolValue?: boolean;
  /** int64: a decimal string, as OTLP/JSON encodes 64-bit integers. */
  intValue?: string;
  doubleValue?: number;
  arrayValue?: { values: OtlpAnyValue[] };
}

export interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  events?: Array<{ timeUnixNano: string; name: string; attributes: OtlpKeyValue[] }>;
  links?: Array<{ traceId: string; spanId: string; attributes: OtlpKeyValue[] }>;
  status?: { code: number; message?: string };
}

export interface OtlpTraces {
  resourceSpans: Array<{
    resource: { attributes: OtlpKeyValue[] };
    scopeSpans: Array<{ scope: { name: string; version?: string }; spans: OtlpSpan[] }>;
  }>;
}

/** The trace id of a run: the first 16 bytes of SHA-256("odw/run/<runId>"), as hex. */
export function traceIdOf(runId: string): string {
  return nonZero(createHash("sha256").update(`odw/run/${runId}`).digest("hex").slice(0, 32));
}

/** The id of the span that is `what` ("run", "agent/7", …) of a run: 8 bytes of SHA-256, as hex. */
export function spanIdOf(runId: string, what: string): string {
  return nonZero(createHash("sha256").update(`odw/run/${runId}/${what}`).digest("hex").slice(0, 16));
}

/** An all-zero id is invalid in OTLP; SHA-256 makes one vanishingly unlikely, but never send one. */
function nonZero(hex: string): string {
  return /^0+$/.test(hex) ? `${hex.slice(0, -1)}1` : hex;
}

/** Epoch seconds as OTLP's unix nanoseconds (a decimal string), to the microsecond. */
export function nanos(seconds: number): string {
  return (BigInt(Math.round(Math.max(0, seconds) * 1e6)) * 1000n).toString();
}

/** The conventions' well-known `gen_ai.provider.name` of the CLIs that have one. */
const PROVIDERS: Record<string, string> = {
  claude: "anthropic",
  codex: "openai",
  gemini: "gcp.gemini",
  kimi: "moonshot_ai",
};

/**
 * `gen_ai.provider.name` for an agent on `adapter`: the well-known value of
 * the CLI it runs (its command's executable, else its name), else the
 * adapter's name; "unknown" without one (a record from before adapters).
 */
export function providerName(adapter: string | null, executable?: string): string {
  const exe = executable?.split(/[\\/]/).pop()?.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
  if (exe && Object.hasOwn(PROVIDERS, exe)) return PROVIDERS[exe]!;
  if (adapter && Object.hasOwn(PROVIDERS, adapter)) return PROVIDERS[adapter]!;
  return adapter || "unknown";
}

/** Captured text, cut at `max` characters — never inside a redaction marker or a surrogate pair. */
export function clip(text: string, max = CONTENT_MAX_CHARS): string {
  if (text.length <= max) return text;
  let cut = max;
  const open = text.lastIndexOf("«redacted:", cut - 1);
  if (open !== -1 && text.indexOf("»", open) >= cut) cut = open;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut--;
  return `${text.slice(0, cut)}…`;
}

// --- attributes ----------------------------------------------------------------------

/** A span's attributes as they are built: only values that are there are added. */
class Attrs {
  readonly list: OtlpKeyValue[] = [];

  str(key: string, value: unknown): this {
    if (typeof value === "string" && value !== "") this.list.push({ key, value: { stringValue: value } });
    return this;
  }

  int(key: string, value: unknown): this {
    if (typeof value === "number" && Number.isFinite(value)) {
      this.list.push({ key, value: { intValue: String(Math.trunc(value)) } });
    }
    return this;
  }

  double(key: string, value: unknown): this {
    if (typeof value === "number" && Number.isFinite(value)) this.list.push({ key, value: { doubleValue: value } });
    return this;
  }

  bool(key: string, value: unknown): this {
    if (typeof value === "boolean") this.list.push({ key, value: { boolValue: value } });
    return this;
  }

  strings(key: string, values: readonly string[] | undefined): this {
    if (values && values.length > 0) {
      this.list.push({ key, value: { arrayValue: { values: values.map((v) => ({ stringValue: v })) } } });
    }
    return this;
  }
}

// --- transcripts ---------------------------------------------------------------------

/** One tool call a transcript shows. */
export interface ToolCall {
  /** The call's id, as the CLI gave it. */
  id?: string;
  name: string;
  input?: unknown;
  output?: string;
  /** Undefined: no result was seen (the CLI was killed, or the transcript cut). */
  isError?: boolean;
  exitCode?: number;
  /** Which line (of the non-blank ones, from 0) holds the call, and which its result. */
  callLine: number;
  resultLine?: number;
  /** When it ran (ms since the epoch), when its CLI said. */
  startMs?: number;
  endMs?: number;
  /** The call it ran inside: a Claude Code subagent's Task call. */
  parentId?: string;
}

/** What the mapper reads from one agent's transcript. */
export interface TranscriptFacts {
  tools: ToolCall[];
  /** Tool calls past {@link MAX_TOOL_SPANS}. */
  dropped: number;
  /** Non-blank lines: what an estimated position is a fraction of. */
  lines: number;
  /** CLI runs it records: 1, plus one per attempt line. */
  runs: number;
  /** The model its CLI was configured with (Claude Code's init event). */
  model?: string;
  /** The model that answered last (Claude Code's assistant messages). */
  responseModel?: string;
  /** The CLI's own session id (Claude Code's `session_id`). */
  conversationId?: string;
}

/** codex `exec --json` items that are tool calls. */
const CODEX_TOOLS = new Set(["command_execution", "file_change", "mcp_tool_call", "web_search", "collab_tool_call"]);

/**
 * The tool calls, models and session of a transcript (../transcript): Claude
 * Code's stream-json (tool_use blocks, their tool_result by tool_use_id, a
 * subagent's calls under its Task call), opencode's and kilo's `tool_use`
 * events (call and result at once, with their times), and codex's
 * `item.started` / `item.completed` tool items. Anything else is passed over.
 */
export function transcriptFacts(lines: Iterable<string>): TranscriptFacts {
  const facts: TranscriptFacts = { tools: [], dropped: 0, lines: 0, runs: 1 };
  const byId = new Map<string, ToolCall>();
  const add = (call: ToolCall): ToolCall | undefined => {
    if (facts.tools.length >= MAX_TOOL_SPANS) {
      facts.dropped++;
      return undefined;
    }
    facts.tools.push(call);
    if (call.id) byId.set(call.id, call);
    return call;
  };
  const settle = (call: ToolCall | undefined, line: number, output: string, isError: boolean, exitCode?: number): void => {
    if (!call || call.resultLine !== undefined) return;
    call.resultLine = line;
    call.output = output;
    call.isError = isError;
    const exit = exitCode ?? (isError ? /^(?:Error: )?Exit code (\d+)/.exec(output)?.[1] : undefined);
    if (exit !== undefined) call.exitCode = Number(exit);
  };
  for (const raw of lines) {
    const text = raw.trim();
    if (!text) continue;
    const at = facts.lines++;
    let ev: unknown;
    try {
      ev = JSON.parse(text);
    } catch {
      continue; // a CLI's stray notice
    }
    if (!isRecord(ev)) continue;
    if (typeof ev.type !== "string") {
      if (ev.kind === "attempt") facts.runs++; // ODW's own line: another CLI run
      continue;
    }
    switch (ev.type) {
      case "system":
        if (ev.subtype === "init") {
          if (typeof ev.model === "string" && ev.model) facts.model = ev.model;
          if (typeof ev.session_id === "string" && ev.session_id) facts.conversationId = ev.session_id;
        }
        break;
      case "assistant": {
        const message = isRecord(ev.message) ? ev.message : {};
        if (typeof message.model === "string" && message.model) facts.responseModel = message.model;
        const parentId = typeof ev.parent_tool_use_id === "string" ? ev.parent_tool_use_id : undefined;
        for (const block of Array.isArray(message.content) ? message.content : []) {
          if (!isRecord(block) || typeof block.type !== "string") continue;
          if (block.type === "tool_use" || block.type === "server_tool_use" || block.type === "mcp_tool_use") {
            add({
              ...(typeof block.id === "string" && block.id ? { id: block.id } : {}),
              name: typeof block.name === "string" && block.name ? block.name : "tool",
              input: block.input,
              callLine: at,
              ...(parentId ? { parentId } : {}),
            });
          } else if (block.type.endsWith("_tool_result")) {
            // A server tool's result (web search, …) comes in the assistant's own message.
            const failed = block.is_error === true || (isRecord(block.content) && String(block.content.type ?? "").endsWith("_error"));
            settle(byId.get(String(block.tool_use_id)), at, contentText(block.content), failed);
          }
        }
        break;
      }
      case "user": {
        const message = isRecord(ev.message) ? ev.message : {};
        for (const block of Array.isArray(message.content) ? message.content : []) {
          if (isRecord(block) && block.type === "tool_result") {
            settle(byId.get(String(block.tool_use_id)), at, contentText(block.content), block.is_error === true);
          }
        }
        break;
      }
      case "tool_use": {
        // opencode / kilo `run --format json`: a tool is reported once it is done, call and result together.
        const part = isRecord(ev.part) ? ev.part : {};
        const state = isRecord(part.state) ? part.state : {};
        const id = typeof part.callID === "string" ? part.callID : typeof part.id === "string" ? part.id : undefined;
        const call = add({
          ...(id ? { id } : {}),
          name: typeof part.tool === "string" && part.tool ? part.tool : "tool",
          input: state.input,
          callLine: at,
        });
        if (!call) break;
        const time = isRecord(state.time) ? state.time : {};
        if (typeof time.start === "number" && Number.isFinite(time.start)) call.startMs = time.start;
        if (typeof time.end === "number" && Number.isFinite(time.end)) call.endMs = time.end;
        if (state.status === "error") settle(call, at, errorText(state.error), true);
        else if (state.status === "completed") {
          const output = typeof state.output === "string" ? state.output : contentText(state.output);
          settle(call, at, output, false, exitOf(state.metadata));
        }
        break;
      }
      case "item.started":
      case "item.completed": {
        // codex `exec --json` (codex-rs/exec/src/exec_events.rs): no times, so placed by line.
        const item = isRecord(ev.item) ? ev.item : {};
        const kind = typeof item.type === "string" ? item.type : "";
        if (!CODEX_TOOLS.has(kind)) break;
        const id = typeof item.id === "string" && item.id ? item.id : undefined;
        let call = id ? byId.get(id) : undefined;
        if (!call) {
          call = add({ ...(id ? { id } : {}), name: codexToolName(item, kind), input: codexInput(item, kind), callLine: at });
        }
        if (!call || ev.type !== "item.completed") break;
        const exit = typeof item.exit_code === "number" ? item.exit_code : undefined;
        const failed = item.status === "failed" || item.status === "declined" || (exit !== undefined && exit !== 0);
        const output =
          typeof item.aggregated_output === "string"
            ? item.aggregated_output
            : isRecord(item.error)
              ? errorText(item.error)
              : isRecord(item.result)
                ? contentText(item.result.content)
                : "";
        settle(call, at, output, failed, exit);
        break;
      }
      case "result":
        if (typeof ev.session_id === "string" && ev.session_id) facts.conversationId = ev.session_id;
        break;
      default:
        break;
    }
  }
  return facts;
}

function codexToolName(item: Record<string, unknown>, kind: string): string {
  if (kind === "mcp_tool_call" && typeof item.server === "string" && typeof item.tool === "string") return `${item.server}.${item.tool}`;
  if (kind === "collab_tool_call" && typeof item.tool === "string") return item.tool;
  return kind;
}

function codexInput(item: Record<string, unknown>, kind: string): unknown {
  switch (kind) {
    case "command_execution":
      return item.command;
    case "file_change":
      return item.changes;
    case "mcp_tool_call":
      return item.arguments;
    case "web_search":
      return item.query;
    default:
      return item.prompt;
  }
}

/** The exit code opencode's shell tool records with a result. */
function exitOf(metadata: unknown): number | undefined {
  if (!isRecord(metadata)) return undefined;
  if (typeof metadata.exit === "number") return metadata.exit;
  return isRecord(metadata.metadata) && typeof metadata.metadata.exit === "number" ? metadata.metadata.exit : undefined;
}

/** A tool result's content as text: a string as is, text blocks joined, anything else as JSON. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === undefined || content === null) return "";
  if (!Array.isArray(content)) return JSON.stringify(content) ?? "";
  return content
    .map((block) => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : JSON.stringify(block)))
    .join("\n");
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  return JSON.stringify(error) ?? "";
}

// --- the trace -----------------------------------------------------------------------

/** A span being built: its key names it (and makes its id); times are epoch seconds. */
interface Draft {
  key: string;
  parent: string | null;
  name: string;
  kind: number;
  start: number;
  end: number;
  attrs: Attrs;
  events: Array<{ name: string; time: number; attrs: Attrs }>;
  links?: Array<{ traceId: string; spanId: string; attrs: Attrs }>;
  error?: { type: string; message?: string };
}

const TERMINAL = new Set(["done", "failed", "stopped"]);

/** A run's record as OTLP/JSON traces: one trace, one resource, one scope (see the module doc). */
export function runTrace(record: RunRecord, options: TraceOptions = {}): OtlpTraces {
  const { runId, meta, status, events } = record;
  const capture = options.captureContent === true;
  const redact = options.redact ?? ((text: string) => text);
  /** Captured text: redacted on its way out, and cut. */
  const content = (text: string): string => clip(redact(text));

  const times = events.map((ev) => ev.ts).filter((ts): ts is number => typeof ts === "number" && Number.isFinite(ts));
  const runStart = num(meta.createdAt) ?? times[0] ?? 0;
  const state = typeof status.state === "string" ? status.state : "pending";
  const lastSeen = Math.max(runStart, ...times);
  // A terminal run ended with its terminal write; anything else ends, for now, at its last event.
  const runEnd = Math.max(lastSeen, (TERMINAL.has(state) ? num(status.updatedAt) : null) ?? lastSeen);
  const workflow = workflowName(runId, meta, status);

  const drafts: Draft[] = [];
  const draft = (d: Omit<Draft, "events" | "attrs"> & { attrs?: Attrs }): Draft => {
    const made: Draft = { ...d, attrs: d.attrs ?? new Attrs(), events: [] };
    drafts.push(made);
    return made;
  };

  const root = draft({
    key: "run",
    parent: null,
    name: `invoke_workflow ${oneLine(workflow)}`,
    kind: SPAN_KIND.internal,
    start: runStart,
    end: runEnd,
    attrs: new Attrs()
      .str("gen_ai.operation.name", "invoke_workflow")
      .str("gen_ai.workflow.name", workflow)
      .str("odw.run.id", runId)
      .str("odw.workflow.name", workflow)
      .str("odw.run.state", state),
  });
  if (typeof meta.resumedFrom === "string" && meta.resumedFrom) {
    root.attrs.str("odw.run.resumed_from", meta.resumedFrom);
    root.links = [
      {
        traceId: traceIdOf(meta.resumedFrom),
        spanId: spanIdOf(meta.resumedFrom, "run"),
        attrs: new Attrs().str("odw.link", "resumed_from"),
      },
    ];
  }

  // --- what happened, folded as every run view folds it ---
  const nodes = foldAgents(events);
  const started = new Map<number, WorkflowEvent>();
  const commandLines = new Map<number, string>();
  const logs = new Map<number, WorkflowEvent[]>();
  const phaseEntries: Array<{ phase: string; ts: number }> = [];
  for (const ev of events) {
    if (ev.type === "agent_started" && typeof ev.agentId === "number" && !started.has(ev.agentId)) started.set(ev.agentId, ev);
    else if (ev.type === "command_started" && typeof ev.commandId === "number" && typeof ev.command === "string") {
      commandLines.set(ev.commandId, ev.command);
    } else if (ev.type === "log" && typeof ev.agentId === "number") {
      const list = logs.get(ev.agentId) ?? [];
      list.push(ev);
      logs.set(ev.agentId, list);
    } else if (ev.type === "phase_started" && typeof ev.phase === "string" && typeof ev.ts === "number") {
      phaseEntries.push({ phase: ev.phase, ts: ev.ts });
    }
  }
  const checkpoints = foldCheckpoints(events);

  // --- phases: each one that was entered or had work, around its work ---
  const phaseTitles: string[] = [];
  const notePhase = (title: unknown): void => {
    if (typeof title === "string" && title !== "" && !phaseTitles.includes(title)) phaseTitles.push(title);
  };
  for (const entry of phaseEntries) notePhase(entry.phase);
  for (const node of nodes) notePhase(node.phase);
  for (const cp of checkpoints) notePhase(cp.phase);
  const phaseKey = (title: string | null | undefined): string => (title ? `phase/${title}` : "run");
  const phases = new Map<string, Draft>();
  for (const title of phaseTitles) {
    const entries = phaseEntries.map((entry, i) => ({ ...entry, left: phaseEntries[i + 1]?.ts ?? runEnd })).filter((e) => e.phase === title);
    // From its first entry to when it was last left — or, never entered, around its work alone (below).
    phases.set(
      title,
      draft({
        key: phaseKey(title),
        parent: "run",
        name: `phase ${oneLine(title)}`,
        kind: SPAN_KIND.internal,
        start: entries[0]?.ts ?? Number.POSITIVE_INFINITY,
        end: entries.at(-1)?.left ?? Number.NEGATIVE_INFINITY,
        attrs: new Attrs().str("odw.phase.name", title),
      }),
    );
  }

  // --- agents, their tools, and exec() steps ---
  const agentKeys = new Map<number, string>();
  const agents = nodes.filter((node) => node.kind === "agent");
  for (const [index, node] of nodes.entries()) {
    if (node.kind !== "agent") continue;
    const span = agentSpan(node, index);
    if (node.agentId !== null) agentKeys.set(node.agentId, span.key);
  }
  for (const [index, node] of nodes.entries()) if (node.kind === "command") commandSpan(node, index);
  for (const cp of checkpoints) checkpointSpan(cp);
  const totals = agents.reduce<Usage | undefined>((sum, node) => (node.usage ? addUsage(sum, node.usage) : sum), undefined);
  const failedAgents = agents.filter((node) => node.state === "failed").length;

  function agentSpan(node: AgentView, index: number): Draft {
    const id = node.agentId;
    const key = `agent/${id ?? `n${index}`}`;
    const start = node.startedAt ?? runStart;
    const end = node.finishedAt ?? runEnd;
    const label = node.label || (id !== null ? `agent ${id}` : "agent");
    const begun = id !== null ? started.get(id) : undefined;
    const facts = !node.cached && id !== null ? readFacts(record, id) : undefined;
    const attrs = new Attrs()
      .str("gen_ai.operation.name", "invoke_agent")
      .str("gen_ai.provider.name", providerName(node.adapter, node.adapter ? options.executables?.[node.adapter] : undefined))
      .str("gen_ai.agent.name", label)
      .str("gen_ai.agent.id", id !== null ? `${runId}/agents/${id}` : undefined)
      .str("gen_ai.request.model", typeof begun?.model === "string" ? begun.model : facts?.model)
      .str("gen_ai.response.model", facts?.responseModel)
      .str("gen_ai.conversation.id", facts?.conversationId)
      .int("odw.agent.id", id ?? undefined)
      .str("odw.agent.state", node.state)
      .str("odw.adapter", node.adapter)
      .strings("odw.agent.fell_back_from", node.fellBackFrom)
      .str("odw.agent.permissions", node.permissions)
      .int("odw.agent.attempts", node.attempts ?? (facts && node.state !== "running" ? facts.runs : undefined));
    usageAttrs(attrs, node.usage, "gen_ai.usage");
    attrs.double("odw.agent.cost_usd", node.usage?.costUsd);
    if (node.usage?.estimated) attrs.bool("odw.usage.estimated", true);
    if (node.cached) attrs.bool("odw.agent.cached", true).str("odw.agent.source_run_id", begun?.sourceRunId);
    if (node.changes) {
      attrs.int("odw.agent.changes.files", node.changes.files).int("odw.agent.changes.insertions", node.changes.insertions);
      attrs.int("odw.agent.changes.deletions", node.changes.deletions);
    }
    if (facts?.dropped) attrs.int("odw.agent.tool_spans_dropped", facts.dropped);
    const span = draft({
      key,
      parent: phases.has(node.phase ?? "") ? phaseKey(node.phase) : "run",
      name: `invoke_agent ${oneLine(label)}`,
      kind: SPAN_KIND.client,
      start,
      end,
      attrs,
    });
    if (node.state === "failed") {
      span.error = {
        type: node.failureReason ?? errorClass(node.error) ?? "_OTHER",
        ...(capture && node.error ? { message: content(node.error) } : {}),
      };
    }
    if (capture && node.state === "done" && id !== null) {
      const saved = record.agentResult?.(id);
      if (saved && "value" in saved) {
        attrs.str("gen_ai.output.messages", outputMessages(content(valueText(saved.value))));
      }
    }
    for (const ev of id !== null ? (logs.get(id) ?? []) : []) {
      const moment = spanEvent(ev);
      if (moment && typeof ev.ts === "number") span.events.push({ ...moment, time: ev.ts });
    }
    if (facts) toolSpans(span, facts, id!, label);
    return span;
  }

  function toolSpans(agent: Draft, facts: TranscriptFacts, agentId: number, label: string): void {
    const span = Math.max(0, agent.end - agent.start);
    const at = (line: number): number => agent.start + (span * (line + 0.5)) / Math.max(1, facts.lines);
    const keys = new Map<string, string>();
    facts.tools.forEach((call, n) => {
      const key = `tool/${agentId}/${n}`;
      if (call.id) keys.set(call.id, key);
      const reported = call.startMs !== undefined;
      const start = reported ? within(call.startMs! / 1000, agent.start, agent.end) : at(call.callLine);
      const end = reported
        ? within((call.endMs ?? call.startMs!) / 1000, start, agent.end)
        : call.resultLine !== undefined
          ? at(call.resultLine)
          : agent.end;
      const attrs = new Attrs()
        .str("gen_ai.operation.name", "execute_tool")
        .str("gen_ai.tool.name", call.name)
        .str("gen_ai.tool.call.id", call.id)
        .str("gen_ai.agent.name", label)
        .int("process.exit.code", call.exitCode);
      if (!reported) attrs.bool("odw.timing.estimated", true);
      if (capture) {
        if (call.input !== undefined) attrs.str("gen_ai.tool.call.arguments", content(valueText(call.input)));
        if (call.isError === false && call.output) attrs.str("gen_ai.tool.call.result", content(call.output));
      }
      const tool = draft({
        key,
        parent: (call.parentId && keys.get(call.parentId)) || agent.key,
        name: `execute_tool ${oneLine(call.name)}`,
        kind: SPAN_KIND.internal,
        start,
        end,
        attrs,
      });
      if (call.isError) tool.error = { type: "tool_error", ...(capture && call.output ? { message: content(call.output) } : {}) };
    });
  }

  function commandSpan(node: AgentView, index: number): void {
    const id = node.commandId ?? null;
    const start = node.startedAt ?? runStart;
    const end = node.finishedAt ?? (node.durationMs !== null ? start + node.durationMs / 1000 : runEnd);
    const owner = node.forAgentId !== undefined ? agentKeys.get(node.forAgentId) : undefined;
    const attrs = new Attrs()
      .int("odw.command.id", id ?? undefined)
      .str("odw.command.label", node.label)
      .str("odw.command.state", node.state)
      .int("process.exit.code", node.exitCode ?? undefined)
      .int("odw.command.for_agent_id", node.forAgentId);
    if (capture && id !== null && commandLines.has(id)) attrs.str("process.command_line", content(commandLines.get(id)!));
    const span = draft({
      key: `command/${id ?? `n${index}`}`,
      parent: owner ?? (phases.has(node.phase ?? "") ? phaseKey(node.phase) : "run"),
      name: `exec ${oneLine(node.label)}`,
      kind: SPAN_KIND.internal,
      start,
      end: Math.max(start, end),
      attrs,
    });
    if (node.state === "failed") {
      span.error = { type: commandErrorType(node.error), ...(capture && node.error ? { message: content(node.error) } : {}) };
    }
  }

  function checkpointSpan(cp: CheckpointFold): void {
    const attrs = new Attrs().int("odw.checkpoint.id", cp.checkpointId).str("odw.checkpoint.title", cp.title);
    if (cp.resolved) attrs.bool("odw.checkpoint.approved", cp.approved).str("odw.checkpoint.by", cp.by);
    if (capture) {
      if (cp.payload !== undefined && cp.payload !== null) attrs.str("odw.checkpoint.payload", content(valueText(cp.payload)));
      if (cp.note) attrs.str("odw.checkpoint.note", content(cp.note));
    }
    const span = draft({
      key: `checkpoint/${cp.checkpointId}`,
      parent: phases.has(cp.phase ?? "") ? phaseKey(cp.phase) : "run",
      name: `checkpoint ${oneLine(cp.title)}`,
      kind: SPAN_KIND.internal,
      start: cp.start ?? runStart,
      end: cp.end ?? runEnd,
      attrs,
    });
    if (cp.error !== undefined) {
      // No answer in time ("timeout" with onTimeout "fail"), or the run ended first.
      span.error = { type: cp.by === "timeout" ? "timeout" : "cancelled", ...(capture && cp.error ? { message: content(cp.error) } : {}) };
    }
  }

  // --- the run's totals and outcome ---
  usageAttrs(root.attrs, totals, "odw.run.usage");
  root.attrs.double("odw.run.cost_usd", totals?.costUsd);
  if (totals?.estimated) root.attrs.bool("odw.usage.estimated", true);
  root.attrs.int("odw.run.agents", agents.length).int("odw.run.failed_agents", failedAgents);
  if (state === "failed") {
    const message = typeof record.error?.error === "string" ? record.error.error : undefined;
    const stack = typeof record.error?.stack === "string" ? record.error.stack : undefined;
    root.error = {
      type: errorClass(stack) ?? errorClass(message) ?? "_OTHER",
      ...(capture && message ? { message: content(message) } : {}),
    };
  }
  if (capture && state === "done" && record.result) {
    const value = record.result();
    if (value !== undefined) root.attrs.str("gen_ai.output.messages", outputMessages(content(valueText(value))));
  }

  // A phase spans its work; the run spans everything.
  const byKey = new Map([...phases.values()].map((p) => [p.key, p]));
  for (const d of drafts) {
    const phase = d.parent !== null ? byKey.get(d.parent) : undefined;
    if (phase) {
      phase.start = Math.min(phase.start, d.start);
      phase.end = Math.max(phase.end, d.end);
    }
  }
  root.end = Math.max(root.end, ...drafts.map((d) => d.end));
  root.start = Math.min(root.start, ...drafts.map((d) => d.start));

  const traceId = traceIdOf(runId);
  const spans = drafts.map((d) => toSpan(d, traceId, runId));
  const resource = new Attrs();
  for (const [key, value] of Object.entries({ "service.name": "odw", ...(options.resource ?? {}) })) {
    resource.list.push({ key, value: { stringValue: value } });
  }
  return {
    resourceSpans: [
      {
        resource: { attributes: resource.list },
        scopeSpans: [{ scope: { name: "odw", ...(options.version ? { version: options.version } : {}) }, spans }],
      },
    ],
  };
}

function toSpan(d: Draft, traceId: string, runId: string): OtlpSpan {
  const span: OtlpSpan = {
    traceId,
    spanId: spanIdOf(runId, d.key),
    ...(d.parent !== null ? { parentSpanId: spanIdOf(runId, d.parent) } : {}),
    name: d.name,
    kind: d.kind,
    startTimeUnixNano: nanos(d.start),
    endTimeUnixNano: nanos(Math.max(d.start, d.end)),
    attributes: d.error ? [...d.attrs.list, { key: "error.type", value: { stringValue: d.error.type } }] : d.attrs.list,
  };
  if (d.events.length > 0) {
    span.events = d.events.map((e) => ({ timeUnixNano: nanos(e.time), name: e.name, attributes: e.attrs.list }));
  }
  if (d.links?.length) span.links = d.links.map((l) => ({ traceId: l.traceId, spanId: l.spanId, attributes: l.attrs.list }));
  if (d.error) span.status = { code: STATUS_ERROR, ...(d.error.message ? { message: d.error.message } : {}) };
  return span;
}

/**
 * The span event an agent's log line is, if it is one: a retry (rate limit,
 * stall, missed `expect`), a fallback down its chain, or a wait for a spent
 * quota (ODW extensions) — each read from the line's structured fields.
 */
function spanEvent(ev: WorkflowEvent): { name: string; attrs: Attrs } | null {
  if (isRecord(ev.retry) && typeof ev.retry.reason === "string") {
    return {
      name: "odw.retry",
      attrs: new Attrs()
        .str("odw.retry.reason", ev.retry.reason)
        .int("odw.retry.attempt", ev.retry.n)
        .int("odw.retry.max", ev.retry.of)
        .double("odw.retry.wait_seconds", ev.retry.waitSeconds),
    };
  }
  if (ev.quotaWait === "start") {
    return { name: "odw.quota_wait", attrs: new Attrs().str("odw.adapter", ev.adapter).double("odw.quota.resume_at", ev.resumeAt) };
  }
  if (ev.quotaWait === "end") return { name: "odw.quota_resume", attrs: new Attrs().str("odw.adapter", ev.adapter) };
  const from = Array.isArray(ev.fellBackFrom) ? ev.fellBackFrom.filter((name): name is string => typeof name === "string") : [];
  if (from.length > 0 && typeof ev.adapter === "string" && typeof ev.reason === "string") {
    return {
      name: "odw.fallback",
      attrs: new Attrs().str("odw.fallback.from", from.at(-1)).str("odw.fallback.to", ev.adapter).str("odw.fallback.reason", ev.reason),
    };
  }
  return null;
}

/** A transcript's facts, or undefined when the agent kept none (or it cannot be read). */
function readFacts(record: RunRecord, agentId: number): TranscriptFacts | undefined {
  try {
    const lines = record.transcript?.(agentId);
    return lines ? transcriptFacts(lines) : undefined;
  } catch {
    return undefined;
  }
}

/** Usage counts as `<prefix>.input_tokens`, `.output_tokens`, `.cache_read.input_tokens`, `.cache_write.input_tokens`. */
function usageAttrs(attrs: Attrs, usage: Usage | undefined, prefix: string): void {
  if (!usage) return;
  attrs.int(`${prefix}.input_tokens`, usage.inputTokens).int(`${prefix}.output_tokens`, usage.outputTokens);
  // The conventions record cache counts when available and non-zero.
  if (usage.cacheReadTokens) attrs.int(`${prefix}.cache_read.input_tokens`, usage.cacheReadTokens);
  if (usage.cacheWriteTokens) attrs.int(`${prefix}.cache_write.input_tokens`, usage.cacheWriteTokens);
}

/** gen_ai.output.messages, as a JSON string (structured span attributes are not yet widely read). */
function outputMessages(text: string): string {
  return JSON.stringify([{ role: "assistant", parts: [{ type: "text", content: text }] }]);
}

/** A value as text: a string as it is, anything else as JSON. */
function valueText(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
}

/** The class an error message or stack begins with ("BudgetExhausted: …"), or undefined. */
function errorClass(text: string | null | undefined): string | undefined {
  const name = text ? /^([A-Za-z_$][\w$]{0,63})(?::|\n|$)/.exec(text)?.[1] : undefined;
  return name && /[A-Z]/.test(name[0]!) ? name : undefined;
}

/** error.type of a failed exec() step, from what its command_failed event says. */
function commandErrorType(error: string | null): string {
  if (!error) return "_OTHER";
  if (error.startsWith("exited with code")) return "exit";
  if (error.startsWith("timed out")) return "timeout";
  if (error.startsWith("killed by signal")) return "signal";
  if (error.startsWith("failed to launch")) return "launch";
  if (error.startsWith("aborted")) return "aborted";
  return "_OTHER";
}

/** A checkpoint() as its events tell it. */
interface CheckpointFold {
  checkpointId: number;
  title: string;
  phase: string | null;
  payload: unknown;
  start: number | null;
  end: number | null;
  resolved: boolean;
  approved?: boolean;
  by?: string;
  note?: string;
  error?: string;
}

function foldCheckpoints(events: WorkflowEvent[]): CheckpointFold[] {
  const out = new Map<number, CheckpointFold>();
  for (const ev of events) {
    if (typeof ev.checkpointId !== "number") continue;
    if (ev.type === "checkpoint_requested" && !out.has(ev.checkpointId)) {
      out.set(ev.checkpointId, {
        checkpointId: ev.checkpointId,
        title: String(ev.title ?? ""),
        phase: typeof ev.phase === "string" ? ev.phase : null,
        payload: ev.payload,
        start: num(ev.ts),
        end: null,
        resolved: false,
      });
    } else if (ev.type === "checkpoint_resolved") {
      const cp = out.get(ev.checkpointId);
      if (!cp || cp.resolved) continue;
      cp.resolved = true;
      cp.end = num(ev.ts);
      if (typeof ev.approved === "boolean") cp.approved = ev.approved;
      if (typeof ev.by === "string") cp.by = ev.by;
      if (typeof ev.note === "string") cp.note = ev.note;
      if (typeof ev.error === "string") cp.error = ev.error;
    }
  }
  return [...out.values()];
}

/** The run's workflow as the run views name it: its meta.name, else what it was started as. */
function workflowName(runId: string, meta: Record<string, unknown>, status: Record<string, unknown>): string {
  return (
    (typeof status.name === "string" && status.name) ||
    (typeof meta.workflowName === "string" && meta.workflowName) ||
    (typeof meta.script === "string" && (meta.script.split(/[\\/]/).pop() ?? "").replace(/\.[^.]*$/, "")) ||
    runId
  );
}

/** A name for a span: one line, at most 120 characters. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat;
}

function within(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high));
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
