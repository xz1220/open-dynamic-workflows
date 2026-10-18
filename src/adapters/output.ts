/**
 * Decode an adapter's stdout into the agent's reply — and, for the JSON
 * formats, what the run spent, whether the CLI itself reported a failure, the
 * value it validated against a schema it was handed natively, which tool
 * calls it refused the agent (Claude Code's `permission_denials`), the MCP
 * servers it started the agent with (Claude Code's init `mcp_servers`), and
 * the background work still running when it replied (`background`: Claude
 * Code's task events), which died when it exited.
 *
 * A structured decode that cannot find its text never fails the agent: the
 * raw stdout becomes the reply and {@link DecodedOutput.fallback} says why, for
 * the run's log. ODW cannot run every vendor's CLI in CI, so a CLI whose
 * output shape drifts from its adapter's declaration degrades to a text
 * adapter instead of breaking every run.
 *
 * A CLI may also write its final reply to a file of its own (`{reply_file}`,
 * an ODW extension; Codex's `--output-last-message`): that file is its own
 * word on the reply, independent of event shapes, so it wins over stdout. And
 * when the file is empty or was never written while stdout — a stream in its
 * declared format — had no reply either, the CLI did not answer: the reply is
 * empty (an `empty_reply` failure unless the call allows one) rather than a
 * dump of events nobody can use, and {@link DecodedOutput.note} says exactly
 * what was missing.
 */

import type { Adapter, AdapterOutput, BackgroundCondition, BackgroundRule, BackgroundRules, BackgroundScalar } from "./types.js";
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
  /**
   * The background work still running when the CLI gave its reply
   * (`background`; an ODW extension), one line each ("Bash (npm run dev)");
   * absent when there was none. The CLI exited with it, so it died unfinished:
   * the bridge records it, or fails the run (`orphanedBackground`, `expect`).
   */
  orphaned?: string[];
  /** Set when stdout did not match the declared format and `text` is the raw stdout: why, for the run's log. */
  fallback?: string;
  /**
   * Set when the reply is not where the adapter declares it in stdout, yet
   * not the raw stdout either — its reply file held it, or nothing did and
   * the reply is empty: what was missing, for the run's log.
   */
  note?: string;
  /**
   * The value the CLI validated against a schema it was handed natively — at
   * `structuredPath` in the latest text event — when it has one: absent, or
   * null (a run that produced none), leaves this unset.
   */
  structured?: unknown;
}

type JsonlOutput = Extract<AdapterOutput, { format: "jsonl" }>;
type JsonOutput = Extract<AdapterOutput, { format: "json" }>;

/**
 * What a CLI run wrote to its `{reply_file}` (an ODW extension), read once it
 * exited: its text, or null when it wrote none. Undefined: the adapter has no
 * reply file.
 */
export type ReplyFileText = string | null | undefined;

/**
 * JSONL events a CLI prints while it starts up, before its model has read the
 * prompt: Claude Code's `system` events (its `init`), Codex's `thread.started`
 * and `turn.started`, agy's `init`. Any other event means it is answering.
 */
const STARTUP_EVENTS: ReadonlySet<string> = new Set(["system", "thread.started", "turn.started", "init"]);

/** What stdout said about the reply, before a reply file has its say. */
type Verdict =
  | { kind: "error"; error: string }
  | { kind: "reply"; text: string; structured?: unknown }
  /** No reply: why; the raw stdout kept; whether stdout was in its declared format, only without the reply. */
  | { kind: "none"; why: string; raw: string; keptChars: number | null; formatted: boolean };

/** Decode a CLI run's whole stdout at once (see {@link AdapterOutputDecoder}), with what it wrote to its reply file. */
export function decodeOutput(adapter: Adapter, stdout: string, reply?: ReplyFileText): DecodedOutput {
  const decoder = new AdapterOutputDecoder(adapter);
  decoder.write(stdout);
  return decoder.finish(reply);
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
 * that are not JSON (a CLI's stray notice), and events of types it does not
 * declare, are skipped. A text decoder accumulates the reply; a JSON decoder,
 * the document.
 */
export class AdapterOutputDecoder {
  /** Whether any stdout has been written. */
  received = false;
  /**
   * Whether the stream shows more than the CLI starting up: any output, or —
   * for JSONL — an event other than a start-up one (Claude Code's `system`
   * init, Codex's `thread.started` and `turn.started`, printed before the
   * model has read the prompt). What a staggered fan-out waits for (an ODW
   * extension; see ../throttle.ts).
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
  /** Of those, objects with a string type (at `eventKey`): the stream is one of events. */
  private typed = 0;
  /** Events of the text type seen. */
  private matching = 0;
  /** The latest non-empty text of a matching event. */
  private last: string | undefined;
  /** Some matching event had a string at `textPath`, empty or not: the decode worked. */
  private found = false;
  /** What the latest matching event reported at `errorPath`, when it reported a failure. */
  private error: string | undefined;
  /** What the latest of the `errorEvents` reported, until a usage event shows the CLI went on. */
  private failure: string | undefined;
  /** What the latest matching event had at `structuredPath` (null: nothing). */
  private structured: unknown;
  /** What the latest matching event listed at `deniedPath`, when it listed any. */
  private denied: string[] | undefined;
  /** The latest list of MCP servers (`mcpPath`), from any event that had one. */
  private mcp: McpServer[] | undefined;
  /** The background work the stream shows started and not ended (`background`), when the adapter declares it. */
  private readonly background: BackgroundTracker | undefined;
  /** The background work still open at the latest matching text event, when there was any. */
  private orphaned: string[] | undefined;
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
    this.background = this.output.format === "jsonl" && this.output.background ? new BackgroundTracker(this.output.background) : undefined;
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

  /**
   * JSONL: the latest non-empty text of a matching event so far (Codex's
   * latest agent_message) — what a live view shows while the CLI answers.
   * The reply itself is {@link finish}'s, which a reply file may still overrule.
   */
  get latest(): string | undefined {
    return this.last;
  }

  /**
   * The decoded run. Never throws: a stream that does not match its format
   * falls back to the raw stdout. `reply` is what the CLI wrote to its
   * `{reply_file}` (see {@link ReplyFileText}); the first call decides.
   */
  finish(reply?: ReplyFileText): DecodedOutput {
    if (!this.result) {
      const decoded = this.decode(reply);
      const withMcp = this.mcp ? { ...decoded, mcp: this.mcp } : decoded;
      this.result = this.orphaned ? { ...withMcp, orphaned: this.orphaned } : withMcp;
    }
    return this.result;
  }

  private decode(reply: ReplyFileText): DecodedOutput {
    const output = this.output;
    if (output.format === "text") return this.resolve({ kind: "reply", text: this.text.trim() }, reply);
    if (output.format === "json") {
      const { verdict, usage, denied } = this.decodeJson(output);
      return withUsage(this.resolve(verdict, reply), usage, denied);
    }
    return withUsage(this.resolve(this.decodeJsonl(output), reply), this.usage, this.denied);
  }

  private decodeJsonl(output: JsonlOutput): Verdict {
    if (!this.overflow && this.partial) {
      const tail = this.partial;
      this.partial = "";
      this.consume(tail);
    }
    // The CLI's own failure report: a failure event it did not go on from, else its latest text event's.
    const error = this.failure ?? this.error;
    if (error !== undefined) return { kind: "error", error };
    if (this.found) return { kind: "reply", text: this.last ?? "", structured: this.structured };
    const why = this.overflow
      ? this.overflow
      : this.matching > 0
        ? `its ${textEvents(output, true)} had no text at '${output.textPath.join(".")}'`
        : this.events === 0 && this.badLine
          ? `stdout is not JSONL: ${this.badLine}`
          : this.events === 0
            ? "it printed nothing on stdout"
            : `no ${textEvents(output)} was found`;
    const kept = this.raw.length > MAX_FALLBACK_CHARS ? this.raw.slice(-MAX_FALLBACK_CHARS) : this.raw;
    const dropped = this.rawDropped + (this.raw.length - kept.length);
    // Events came, of the declared kind, only without the reply: stdout was in its format.
    const formatted = !this.overflow && (this.matching > 0 || this.typed > 0);
    return { kind: "none", why, raw: kept, keptChars: dropped > 0 ? kept.length : null, formatted };
  }

  private decodeJson(output: JsonOutput): { verdict: Verdict; usage?: Usage; denied?: string[] } {
    const raw = this.text.trim();
    const parsed = parseDocument(raw);
    if (!parsed.ok) {
      const why = raw ? `stdout is not one JSON document: ${parsed.reason}` : "it printed nothing on stdout";
      return { verdict: { kind: "none", why, raw, keptChars: null, formatted: false } };
    }
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
    if (error !== undefined) return { verdict: { kind: "error", error }, usage, denied };
    if (text !== undefined || isPresent(structured)) return { verdict: { kind: "reply", text: text ?? "", structured }, usage, denied };
    const why = `it has no text at '${output.textPath.join(".")}'`;
    return { verdict: { kind: "none", why, raw, keptChars: null, formatted: true }, usage, denied };
  }

  /**
   * The reply, from what stdout said and what the CLI wrote to its reply file
   * (see the module doc): the CLI's failure report decides; else a reply file
   * with text is the reply; else stdout's reply; else — stdout in its format
   * but without a reply, and a reply file empty or never written — nothing;
   * else the raw stdout.
   */
  private resolve(verdict: Verdict, reply: ReplyFileText): DecodedOutput {
    if (verdict.kind === "error") return { text: verdict.error, error: verdict.error };
    const file = typeof reply === "string" ? reply.trim() : "";
    if (verdict.kind === "reply") return withStructured({ text: file || verdict.text }, verdict.structured);
    const mismatch = `adapter '${this.adapter.name}': stdout did not match its '${this.output.format}' output format (${verdict.why}`;
    if (file) return { text: file, note: `${mismatch}); its reply file holds the reply` };
    if (reply === undefined) return this.fallback(verdict.raw, verdict.why, verdict.keptChars);
    const unwritten = reply === null ? "it wrote no reply file" : "its reply file was empty";
    // A dump of events is no reply: both places the CLI could have put one are empty.
    if (verdict.formatted) return { text: "", note: `${mismatch}), and ${unwritten}; the reply is empty` };
    return this.fallback(verdict.raw, `${verdict.why}; and ${unwritten}`, verdict.keptChars);
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
    const named = event[output.eventKey ?? "type"];
    const type = typeof named === "string" ? named : undefined;
    if (type !== undefined) this.typed++;
    if (type === undefined || !STARTUP_EVENTS.has(type)) this.answering = true;
    if (type === (output.usageEvent ?? output.eventType)) {
      if (output.usagePath || output.costPath) {
        const usage = normalizeUsage(output.usagePath && walk(event, output.usagePath), output.costPath && walk(event, output.costPath));
        this.usage = addUsage(this.usage, usage);
      }
      // A turn completed after the CLI reported an error: it recovered and went on.
      this.failure = undefined;
    }
    // The MCP servers the CLI started with (Claude Code's `system` init event): the latest list decides.
    if (output.mcpPath && (output.mcpEvent === undefined || type === output.mcpEvent)) {
      const servers = mcpServers(event, output.mcpPath);
      if (servers) this.mcp = servers;
    }
    // Background work started and ended (ODW extension): what is open at the reply was orphaned.
    if (this.background && type !== undefined) this.background.see(type, event);
    const failurePath = type !== undefined && output.errorEvents && hasOwn(output.errorEvents, type) ? output.errorEvents[type] : undefined;
    if (failurePath) {
      this.failure = reportedError(event, failurePath, undefined) ?? quoted(event);
      return;
    }
    if (type !== output.eventType) return;
    if (output.match && walk(event, output.match.path) !== output.match.equals) return;
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
    // So does the background work still running as it was given.
    this.orphaned = this.background?.running();
  }
}

/** Pieces of open background work a tracker keeps, at most; past it, more are counted, not kept. */
const MAX_OPEN_BACKGROUND = 1000;

/** Ids of ended background work a tracker remembers, at most (a late start of it does not reopen it). */
const MAX_ENDED_BACKGROUND = 10_000;

/** One piece of background work: every id it goes by, and what it is. */
interface BackgroundWork {
  ids: Set<string>;
  label: string;
}

/**
 * The background work a JSONL stream shows (`background`; an ODW extension):
 * what each event starts and ends, by id — work is one piece under any of its
 * ids, so a tool call and the task it registered are one, and either id ends
 * it. Bounded: at most {@link MAX_OPEN_BACKGROUND} open pieces are kept.
 */
class BackgroundTracker {
  private readonly byId = new Map<string, BackgroundWork>();
  /** Open work, in the order it started. */
  private readonly open = new Set<BackgroundWork>();
  private readonly ended = new Set<string>();
  /** Starts past the cap: counted, not kept. */
  private dropped = 0;
  private readonly patterns = new Map<BackgroundRule, RegExp>();

  constructor(private readonly rules: BackgroundRules) {
    for (const rule of [...rules.started, ...rules.ended]) {
      if (rule.pattern !== undefined) this.patterns.set(rule, new RegExp(rule.pattern, "g"));
    }
  }

  see(type: string, event: Record<string, unknown>): void {
    for (const rule of this.rules.started) {
      if (rule.event !== type) continue;
      for (const item of ruleItems(event, rule)) {
        if (!meets(item, rule.where)) continue;
        const ids = this.idsOf(item, rule);
        if (ids.length > 0) this.start(ids, workLabel(item, rule));
      }
    }
    for (const rule of this.rules.ended) {
      if (rule.event !== type) continue;
      for (const item of ruleItems(event, rule)) {
        if (meets(item, rule.where)) this.end(this.idsOf(item, rule));
      }
    }
  }

  /** The work open now, one line each; undefined when there is none. */
  running(): string[] | undefined {
    if (this.open.size === 0 && this.dropped === 0) return undefined;
    const lines = [...this.open].map((work) => work.label);
    if (this.dropped > 0) lines.push(`and ${this.dropped} more`);
    return lines;
  }

  private start(ids: string[], label: string): void {
    if (ids.some((id) => this.ended.has(id))) return;
    const known = [...new Set(ids.map((id) => this.byId.get(id)).filter((w): w is BackgroundWork => w !== undefined))];
    let work = known[0];
    if (!work) {
      if (this.open.size >= MAX_OPEN_BACKGROUND) {
        this.dropped++;
        return;
      }
      work = { ids: new Set(), label };
      this.open.add(work);
    }
    // Two pieces an id ties together are one: the first keeps its label.
    for (const other of known.slice(1)) {
      for (const id of other.ids) this.add(work, id);
      this.open.delete(other);
    }
    for (const id of ids) this.add(work, id);
  }

  private add(work: BackgroundWork, id: string): void {
    work.ids.add(id);
    this.byId.set(id, work);
  }

  private end(ids: string[]): void {
    for (const id of ids) {
      const work = this.byId.get(id);
      if (work) {
        this.open.delete(work);
        for (const own of work.ids) {
          this.byId.delete(own);
          this.remember(own);
        }
      }
      this.remember(id);
    }
  }

  private remember(id: string): void {
    this.ended.add(id);
    if (this.ended.size > MAX_ENDED_BACKGROUND) this.ended.delete(this.ended.values().next().value!);
  }

  /** The ids a rule reads from an event (or item): its values at `ids`, or what `pattern` finds in them. */
  private idsOf(item: unknown, rule: BackgroundRule): string[] {
    const pattern = this.patterns.get(rule);
    const ids: string[] = [];
    for (const path of rule.ids) {
      const value = walk(item, path);
      if (pattern) {
        if (typeof value !== "string") continue;
        for (const match of value.matchAll(pattern)) if (match[1]) ids.push(match[1]);
      } else if (typeof value === "string" ? value !== "" : typeof value === "number" && Number.isFinite(value)) {
        ids.push(String(value));
      }
    }
    return ids;
  }
}

/** What a background rule looks at in an event: the event, or each item of the array at its `each`. */
function ruleItems(event: Record<string, unknown>, rule: BackgroundRule): unknown[] {
  if (!rule.each) return [event];
  const items = walk(event, rule.each);
  return Array.isArray(items) ? items : [];
}

/** Whether an event (or item) meets every condition. */
function meets(item: unknown, where: readonly BackgroundCondition[] | undefined): boolean {
  for (const condition of where ?? []) {
    const value = walk(item, condition.path);
    const among = (wanted: BackgroundScalar | BackgroundScalar[]): boolean =>
      (Array.isArray(wanted) ? wanted : [wanted]).some((v) => v === value);
    if (condition.equals !== undefined && !among(condition.equals)) return false;
    if (condition.not !== undefined && among(condition.not)) return false;
  }
  return true;
}

/** One line for a piece of background work: its kind and what it does — "Bash (npm run dev)". */
function workLabel(item: unknown, rule: BackgroundRule): string {
  const first = (paths: string[][] | undefined): string | undefined =>
    (paths ?? []).map((path) => walk(item, path)).find((v): v is string => typeof v === "string" && v.trim() !== "");
  const kind = first(rule.kind);
  const about = first(rule.about);
  if (kind && about) return clipLine(`${kind} (${about.trim()})`);
  return clipLine(kind ?? about ?? "background work");
}

/** The text events, as the log names them: `'result' event(s)`, `'item.completed' event(s) with item.type 'agent_message'`. */
function textEvents(output: JsonlOutput, plural = false): string {
  const events = `'${output.eventType}' event${plural ? "s" : ""}`;
  if (!output.match) return events;
  const { path, equals } = output.match;
  return `${events} with ${path.join(".")} ${typeof equals === "string" ? `'${equals}'` : String(equals)}`;
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
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
  return quoted(holder);
}

/** An event quoted as a failure's message: its JSON, cut at {@link ERROR_EXCERPT_CHARS}. */
function quoted(holder: unknown): string {
  const json = JSON.stringify(holder) ?? String(holder);
  return json.length > ERROR_EXCERPT_CHARS ? `${json.slice(0, ERROR_EXCERPT_CHARS)}…` : json;
}

/** Characters of one refused call's description. */
const DENIAL_CHARS = 160;

/**
 * The tool calls a CLI refused, listed at `path` — one line each — or
 * undefined when it lists none. An entry is a string, or an object naming the
 * tool (Claude Code's `{ tool_name, tool_use_id, tool_input }`, agy's
 * `{ action, display_name }`) and, from its input, what the call was about:
 * `Bash (npm test)`, `WebFetch (https://…)`.
 */
function deniedCalls(holder: unknown, path: readonly string[]): string[] | undefined {
  const list = walk(holder, path);
  if (!Array.isArray(list) || list.length === 0) return undefined;
  return list.map((entry) => {
    if (typeof entry === "string") return clipLine(entry);
    if (!isRecord(entry)) return clipLine(JSON.stringify(entry) ?? String(entry));
    // agy's denied_actions name the action and the tool: { action: "command", display_name: "RunCommand" }.
    const tool = [entry.tool_name, entry.name, entry.tool, entry.display_name, entry.action].find(
      (v): v is string => typeof v === "string" && v !== "",
    );
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
