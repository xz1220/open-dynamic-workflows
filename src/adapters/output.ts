/**
 * Decode an adapter's stdout into the agent's reply — and, for the JSON
 * formats, what the run spent, whether the CLI itself reported a failure, the
 * value it validated against a schema it was handed natively, which tool
 * calls it refused the agent (Claude Code's `permission_denials`), and the MCP
 * servers it started the agent with (Claude Code's init `mcp_servers`).
 *
 * A structured decode that cannot find its text never fails the agent: the
 * raw stdout becomes the reply and {@link DecodedOutput.fallback} says why, for
 * the run's log. ODW cannot run every vendor's CLI in CI, so a CLI whose
 * output shape drifts from its adapter's declaration degrades to a text
 * adapter instead of breaking every run.
 */

import type { Adapter, AdapterOutput } from "./types.js";
import { addUsage, normalizeUsage, type Usage } from "./usage.js";

/**
 * Longest JSONL line a decoder buffers while waiting for its newline. Bounds
 * the decoder's memory the way the runner's stdout cap bounds a text reply.
 */
export const MAX_JSONL_LINE_CHARS = 32 * 1024 * 1024;

/**
 * How much of a JSONL stream is kept for the fallback reply — its end — until
 * a text event turns up (after which none is).
 */
export const MAX_FALLBACK_CHARS = 1024 * 1024;

/**
 * An MCP server a CLI started the agent with, and how it stood (Claude Code's
 * init event: "connected", "failed", "needs-auth", "pending" or "disabled").
 */
export interface McpServer {
  name: string;
  status: string;
}

/** The status of an MCP server whose tools the agent has. */
export const MCP_CONNECTED = "connected";

/**
 * The statuses of an MCP server that could not start, whose tools the agent
 * went without: what Claude Code's docs say to check for. "pending" is not one
 * — a server still connecting in the background, or one with a cached tool
 * list it connects on first use — nor "disabled", which the user chose.
 */
export const MCP_UNAVAILABLE: readonly string[] = ["failed", "needs-auth"];

/** What one CLI run's stdout decodes to. */
export interface DecodedOutput {
  /** The reply: the declared text, or — when the decode found none — the raw stdout. */
  text: string;
  /** What the CLI reported spending (`usagePath`, `costPath`), normalized; absent when it reported nothing. */
  usage?: Usage;
  /** The CLI's own report that the run failed (`errorPath`): its message. */
  error?: string;
  /**
   * The tool calls the CLI refused the agent (`deniedPath`), one line each
   * ("Bash (npm test)"); absent when it refused none. A reply that claims
   * success with some may rest on work the agent could not do: the bridge
   * records them, or fails the run (`permissionDenials`, `expect`).
   */
  denied?: string[];
  /**
   * Every MCP server the CLI said it started the agent with (`mcpPath`),
   * connected or not; absent when it said nothing about them.
   */
  mcp?: McpServer[];
  /** Set when stdout did not match the declared format and `text` is the raw stdout: why, for the run's log. */
  fallback?: string;
  /**
   * The value the CLI validated against a schema it was handed natively — at
   * `structuredPath` in the latest text event — when it has one: absent, or
   * null (a run that produced none), leaves this unset.
   */
  structured?: unknown;
}

type JsonlOutput = Extract<AdapterOutput, { format: "jsonl" }>;
type JsonOutput = Extract<AdapterOutput, { format: "json" }>;

/** Decode a CLI run's whole stdout at once (see {@link AdapterOutputDecoder}). */
export function decodeOutput(adapter: Adapter, stdout: string): DecodedOutput {
  const decoder = new AdapterOutputDecoder(adapter);
  decoder.write(stdout);
  return decoder.finish();
}

/** The reply alone: trimmed text, or the selected text of a JSON format (else its raw stdout). */
export function decodeAdapterOutput(adapter: Adapter, stdout: string): string {
  return decodeOutput(adapter, stdout).text;
}

/**
 * The incremental form of {@link decodeOutput}: `write` stdout as it arrives,
 * then `finish`. A JSONL decoder parses each line as soon as it is complete
 * and keeps only what selection and usage need — the latest matching text, a
 * running usage total, the unterminated tail, and (for the fallback) the end
 * of the stream until a text event turns up — so a verbose agent session
 * costs memory proportional to its longest line, not to its transcript. Lines
 * that are not JSON (a CLI's stray notice) are skipped. A text decoder
 * accumulates the reply; a JSON decoder, the document.
 */
export class AdapterOutputDecoder {
  /** Whether any stdout has been written. */
  received = false;
  /**
   * Whether the stream shows more than the CLI starting up: any output, or —
   * for JSONL — an event other than a `system` one (Claude Code prints its
   * `init` before the model has read the prompt). What a staggered fan-out
   * waits for (an ODW extension; see ../throttle.ts).
   */
  answering = false;
  /**
   * Set when a line outgrows `maxLineChars`: the stream can no longer be
   * decoded, so whoever feeds it may as well stop the process.
   */
  overflow: string | null = null;

  private readonly output: AdapterOutput;
  /** Text format: the reply so far; JSON format: the document so far. */
  private text = "";
  private partial = "";
  private lines = 0;
  /** JSON events parsed (of any type). */
  private events = 0;
  /** Events of the text type seen. */
  private matching = 0;
  /** The latest non-empty text of a matching event. */
  private last: string | undefined;
  /** Some matching event had a string at `textPath`, empty or not: the decode worked. */
  private found = false;
  /** What the latest matching event reported at `errorPath`, when it reported a failure. */
  private error: string | undefined;
  /** What the latest matching event had at `structuredPath` (null: nothing). */
  private structured: unknown;
  /** What the latest matching event listed at `deniedPath`, when it listed any. */
  private denied: string[] | undefined;
  /** The latest list of MCP servers (`mcpPath`), from any event that had one. */
  private mcp: McpServer[] | undefined;
  private usage: Usage | undefined;
  /** The first line that was not JSON, for the fallback note. */
  private badLine: string | undefined;
  /** The end of the raw stream, kept for the fallback until a text event turns up. */
  private raw = "";
  private rawDropped = 0;
  private result: DecodedOutput | undefined;

  constructor(
    private readonly adapter: Adapter,
    private readonly maxLineChars = MAX_JSONL_LINE_CHARS,
  ) {
    this.output = adapter.output ?? { format: "text" };
  }

  write(chunk: string): void {
    if (!chunk) return;
    this.received = true;
    if (this.output.format !== "jsonl") {
      this.answering = true;
      this.text += chunk;
      return;
    }
    // After an overflow the stream cannot be decoded; stop retaining anything.
    if (this.overflow) return;
    this.keepRaw(chunk);
    let from = 0;
    for (let newline = chunk.indexOf("\n"); newline !== -1; newline = chunk.indexOf("\n", from)) {
      const line = this.partial + chunk.slice(from, newline);
      this.partial = "";
      this.consume(line);
      from = newline + 1;
    }
    this.partial += chunk.slice(from);
    if (this.partial.length > this.maxLineChars) {
      this.overflow = `adapter '${this.adapter.name}' stdout line ${this.lines + 1} exceeds ${this.maxLineChars} characters`;
      this.partial = "";
    }
  }

  /** The decoded run. Never throws: a stream that does not match its format falls back to the raw stdout. */
  finish(): DecodedOutput {
    if (!this.result) {
      const decoded = this.decode();
      this.result = this.mcp ? { ...decoded, mcp: this.mcp } : decoded;
    }
    return this.result;
  }

  private decode(): DecodedOutput {
    const output = this.output;
    if (output.format === "text") return { text: this.text.trim() };
    if (output.format === "json") return this.decodeJson(output);
    if (!this.overflow && this.partial) {
      const tail = this.partial;
      this.partial = "";
      this.consume(tail);
    }
    const usage = this.usage;
    const denied = this.denied;
    if (this.error !== undefined) return withUsage({ text: this.error, error: this.error }, usage, denied);
    if (this.found) return withUsage(withStructured({ text: this.last ?? "" }, this.structured), usage, denied);
    const why = this.overflow
      ? this.overflow
      : this.matching > 0
        ? `its '${output.eventType}' events had no text at '${output.textPath.join(".")}'`
        : this.events === 0 && this.badLine
          ? `stdout is not JSONL: ${this.badLine}`
          : this.events === 0
            ? "it printed nothing on stdout"
            : `no '${output.eventType}' event was found`;
    const kept = this.raw.length > MAX_FALLBACK_CHARS ? this.raw.slice(-MAX_FALLBACK_CHARS) : this.raw;
    const dropped = this.rawDropped + (this.raw.length - kept.length);
    return withUsage(this.fallback(kept, why, dropped > 0 ? kept.length : null), usage, denied);
  }

  private decodeJson(output: JsonOutput): DecodedOutput {
    const raw = this.text.trim();
    const parsed = parseDocument(raw);
    if (!parsed.ok) return this.fallback(raw, raw ? `stdout is not one JSON document: ${parsed.reason}` : "it printed nothing on stdout");
    const doc = parsed.value;
    this.mcp = output.mcpPath ? mcpServers(doc, output.mcpPath) : undefined;
    const usage =
      output.usagePath || output.costPath
        ? normalizeUsage(output.usagePath && walk(doc, output.usagePath), output.costPath && walk(doc, output.costPath))
        : undefined;
    const value = walk(doc, output.textPath);
    const text = typeof value === "string" ? value.trim() : undefined;
    const error = output.errorPath ? reportedError(doc, output.errorPath, text) : undefined;
    const structured = output.structuredPath ? walk(doc, output.structuredPath) : undefined;
    const denied = output.deniedPath ? deniedCalls(doc, output.deniedPath) : undefined;
    if (error !== undefined) return withUsage({ text: error, error }, usage, denied);
    if (text !== undefined || isPresent(structured)) {
      return withUsage(withStructured({ text: text ?? "" }, structured), usage, denied);
    }
    return withUsage(this.fallback(raw, `it has no text at '${output.textPath.join(".")}'`), usage, denied);
  }

  private fallback(raw: string, why: string, keptChars: number | null = null): DecodedOutput {
    const what = keptChars === null ? "its raw stdout" : `the last ${keptChars} characters of its raw stdout`;
    return {
      text: raw.trim(),
      fallback:
        `adapter '${this.adapter.name}': stdout did not match its '${this.output.format}' output format ` +
        `(${why}); ${what} is the reply`,
    };
  }

  /** Keep the end of the stream for the fallback, until a text event makes it unnecessary. */
  private keepRaw(chunk: string): void {
    if (this.found) return;
    this.raw += chunk;
    // Trim lazily (at twice the limit) so a stream of small chunks stays linear.
    if (this.raw.length > MAX_FALLBACK_CHARS * 2) {
      const excess = this.raw.length - MAX_FALLBACK_CHARS;
      this.rawDropped += excess;
      this.raw = this.raw.slice(excess);
    }
  }

  private consume(raw: string): void {
    const output = this.output as JsonlOutput;
    this.lines++;
    const line = raw.trim(); // also drops the \r of a CRLF line ending
    if (!line) return;

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch (error) {
      this.badLine ??= `line ${this.lines}: ${(error as Error).message}`;
      return;
    }
    this.events++;
    if (!isRecord(event)) return;
    if (event.type !== "system") this.answering = true;
    if (event.type === (output.usageEvent ?? output.eventType) && (output.usagePath || output.costPath)) {
      const usage = normalizeUsage(output.usagePath && walk(event, output.usagePath), output.costPath && walk(event, output.costPath));
      this.usage = addUsage(this.usage, usage);
    }
    // The MCP servers the CLI started with (Claude Code's `system` init event): the latest list decides.
    if (output.mcpPath && (output.mcpEvent === undefined || event.type === output.mcpEvent)) {
      const servers = mcpServers(event, output.mcpPath);
      if (servers) this.mcp = servers;
    }
    if (event.type !== output.eventType) return;
    this.matching++;

    const value = walk(event, output.textPath);
    const text = typeof value === "string" ? value.trim() : undefined;
    // The latest text event decides whether the CLI reported a failure, what
    // value it validated natively, and what it refused.
    this.structured = output.structuredPath ? walk(event, output.structuredPath) : undefined;
    if (text !== undefined || isPresent(this.structured)) {
      this.found = true;
      this.raw = ""; // the fallback is no longer needed
      if (text) this.last = text;
    }
    this.error = output.errorPath ? reportedError(event, output.errorPath, text) : undefined;
    this.denied = output.deniedPath ? deniedCalls(event, output.deniedPath) : undefined;
  }
}

function withUsage(decoded: DecodedOutput, usage: Usage | undefined, denied?: string[]): DecodedOutput {
  const out = usage ? { ...decoded, usage } : decoded;
  return denied ? { ...out, denied } : out;
}

/** `decoded` with the CLI's natively validated value, when it has one. */
function withStructured(decoded: DecodedOutput, structured: unknown): DecodedOutput {
  return isPresent(structured) ? { ...decoded, structured } : decoded;
}

/** A value at `structuredPath`: anything but absent, or null (a run that produced none). */
function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/**
 * The value at `path`: object keys, and whole numbers into arrays (negative
 * ones count from the end); undefined when any step is missing.
 */
function walk(value: unknown, path: readonly string[]): unknown {
  let at = value;
  for (const segment of path) {
    if (Array.isArray(at)) {
      if (!/^-?\d+$/.test(segment)) return undefined;
      const index = Number(segment);
      at = at[index < 0 ? at.length + index : index];
    } else if (isRecord(at) && Object.prototype.hasOwnProperty.call(at, segment)) {
      at = at[segment];
    } else {
      return undefined;
    }
  }
  return at;
}

/** Characters of an event quoted as the message of a failure it reports without one. */
const ERROR_EXCERPT_CHARS = 500;

/**
 * The failure a CLI reported at `errorPath`, as a message — or undefined when
 * it reported none. `true` (Claude Code's `is_error`) takes the event's text
 * as the message; a string is the message; an object, its `message`. When
 * none of those says anything, the event itself is quoted.
 */
function reportedError(
  holder: unknown,
  path: readonly string[],
  text: string | undefined,
): string | undefined {
  const flag = walk(holder, path);
  if (flag === undefined || flag === null || flag === false || flag === 0 || flag === "") return undefined;
  if (typeof flag === "string" && flag.trim()) return flag.trim();
  if (isRecord(flag) && typeof flag.message === "string" && flag.message.trim()) return flag.message.trim();
  if (text) return text;
  const quoted = JSON.stringify(holder) ?? String(holder);
  return quoted.length > ERROR_EXCERPT_CHARS ? `${quoted.slice(0, ERROR_EXCERPT_CHARS)}…` : quoted;
}

/** Characters of one refused call's description. */
const DENIAL_CHARS = 160;

/**
 * The tool calls a CLI refused, listed at `path` — one line each — or
 * undefined when it lists none. An entry is a string, or an object naming the
 * tool (Claude Code's `{ tool_name, tool_use_id, tool_input }`) and, from its
 * input, what the call was about: `Bash (npm test)`, `WebFetch (https://…)`.
 */
function deniedCalls(holder: unknown, path: readonly string[]): string[] | undefined {
  const list = walk(holder, path);
  if (!Array.isArray(list) || list.length === 0) return undefined;
  return list.map((entry) => {
    if (typeof entry === "string") return clipLine(entry);
    if (!isRecord(entry)) return clipLine(JSON.stringify(entry) ?? String(entry));
    const tool = [entry.tool_name, entry.name, entry.tool].find((v): v is string => typeof v === "string" && v !== "");
    const input = isRecord(entry.tool_input) ? entry.tool_input : isRecord(entry.input) ? entry.input : {};
    const about = [input.command, input.file_path, input.path, input.url, input.pattern, input.query].find(
      (v): v is string => typeof v === "string" && v.trim() !== "",
    );
    if (!tool) return clipLine(JSON.stringify(entry));
    return clipLine(about ? `${tool} (${about.trim()})` : tool);
  });
}

/**
 * The MCP servers listed at `path` — `{ name, status }` each, as Claude Code's
 * init event lists them — or undefined when there is no list there. An entry
 * without a name is left out; one without a status reads "unknown".
 */
function mcpServers(holder: unknown, path: readonly string[]): McpServer[] | undefined {
  const list = walk(holder, path);
  if (!Array.isArray(list)) return undefined;
  const servers: McpServer[] = [];
  for (const entry of list) {
    if (!isRecord(entry) || typeof entry.name !== "string" || entry.name.trim() === "") continue;
    const status = typeof entry.status === "string" && entry.status.trim() !== "" ? entry.status : "unknown";
    servers.push({ name: clipLine(entry.name), status: clipLine(status) });
  }
  return servers;
}

/** The servers of `servers` that were not connected: what an agent's record keeps. */
export function notConnected(servers: readonly McpServer[] | undefined): McpServer[] {
  return (servers ?? []).filter((server) => server.status !== MCP_CONNECTED);
}

/** One line of at most {@link DENIAL_CHARS} characters. */
function clipLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > DENIAL_CHARS ? `${line.slice(0, DENIAL_CHARS - 1)}…` : line;
}

/**
 * Parse stdout as one JSON document. A CLI may print a notice before it, so a
 * document that starts on a later line (its first `{` or `[` line) is tried too.
 */
function parseDocument(raw: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (error) {
    const start = raw.search(/\n[ \t]*[{[]/);
    if (start !== -1) {
      try {
        return { ok: true, value: JSON.parse(raw.slice(start + 1)) };
      } catch {
        // fall through: report the first error, about the stdout as a whole
      }
    }
    return { ok: false, reason: (error as Error).message };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
