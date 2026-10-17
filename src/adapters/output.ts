/**
 * Decode an adapter's stdout into the agent's reply — and, for the JSON
 * formats, what the run spent and whether the CLI itself reported a failure.
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

/** What one CLI run's stdout decodes to. */
export interface DecodedOutput {
  /** The reply: the declared text, or — when the decode found none — the raw stdout. */
  text: string;
  /** What the CLI reported spending (`usagePath`, `costPath`), normalized; absent when it reported nothing. */
  usage?: Usage;
  /** The CLI's own report that the run failed (`errorPath`): its message. */
  error?: string;
  /** Set when stdout did not match the declared format and `text` is the raw stdout: why, for the run's log. */
  fallback?: string;
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
    this.result ??= this.decode();
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
    if (this.error !== undefined) return withUsage({ text: this.error, error: this.error }, usage);
    if (this.found) return withUsage({ text: this.last ?? "" }, usage);
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
    return withUsage(this.fallback(kept, why, dropped > 0 ? kept.length : null), usage);
  }

  private decodeJson(output: JsonOutput): DecodedOutput {
    const raw = this.text.trim();
    const parsed = parseDocument(raw);
    if (!parsed.ok) return this.fallback(raw, raw ? `stdout is not one JSON document: ${parsed.reason}` : "it printed nothing on stdout");
    const doc = parsed.value;
    const usage =
      output.usagePath || output.costPath
        ? normalizeUsage(output.usagePath && walk(doc, output.usagePath), output.costPath && walk(doc, output.costPath))
        : undefined;
    const value = walk(doc, output.textPath);
    const text = typeof value === "string" ? value.trim() : undefined;
    const error = output.errorPath ? reportedError(doc, output.errorPath, text) : undefined;
    if (error !== undefined) return withUsage({ text: error, error }, usage);
    if (text !== undefined) return withUsage({ text }, usage);
    return withUsage(this.fallback(raw, `it has no text at '${output.textPath.join(".")}'`), usage);
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
    if (event.type === (output.usageEvent ?? output.eventType) && (output.usagePath || output.costPath)) {
      const usage = normalizeUsage(output.usagePath && walk(event, output.usagePath), output.costPath && walk(event, output.costPath));
      this.usage = addUsage(this.usage, usage);
    }
    if (event.type !== output.eventType) return;
    this.matching++;

    const value = walk(event, output.textPath);
    const text = typeof value === "string" ? value.trim() : undefined;
    if (text !== undefined) {
      this.found = true;
      this.raw = ""; // the fallback is no longer needed
      if (text) this.last = text;
    }
    // The latest text event decides whether the CLI reported a failure.
    this.error = output.errorPath ? reportedError(event, output.errorPath, text) : undefined;
  }
}

function withUsage(decoded: DecodedOutput, usage: Usage | undefined): DecodedOutput {
  return usage ? { ...decoded, usage } : decoded;
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
