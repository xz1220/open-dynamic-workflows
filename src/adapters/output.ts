/** Decode an adapter's stdout into the final assistant response. */

import { AdapterExecutionError } from "../errors.js";
import type { Adapter, AdapterOutput } from "./types.js";

/**
 * Longest JSONL line a decoder buffers while waiting for its newline. Bounds
 * the decoder's memory the way the runner's stdout cap bounds a text reply.
 */
export const MAX_JSONL_LINE_CHARS = 32 * 1024 * 1024;

/**
 * Plain-text adapters return stdout directly. JSONL adapters select the last
 * non-empty text from their declared event shape.
 */
export function decodeAdapterOutput(adapter: Adapter, stdout: string): string {
  const decoder = new AdapterOutputDecoder(adapter);
  decoder.write(stdout);
  return decoder.finish();
}

/**
 * The incremental form of {@link decodeAdapterOutput}: `write` stdout as it
 * arrives, then `finish` for the final response. A JSONL decoder parses each
 * line as soon as it is complete and keeps only the latest matching text and
 * the unterminated tail, so a verbose agent session costs memory proportional
 * to its longest line rather than to its whole event transcript. A text
 * decoder accumulates the reply.
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
  private text = "";
  private partial = "";
  private lines = 0;
  private last: string | undefined;
  private matchingEvents = 0;
  private error: AdapterExecutionError | undefined;

  constructor(
    private readonly adapter: Adapter,
    private readonly maxLineChars = MAX_JSONL_LINE_CHARS,
  ) {
    this.output = adapter.output ?? { format: "text" };
  }

  write(chunk: string): void {
    if (!chunk) return;
    this.received = true;
    if (this.output.format === "text") {
      this.text += chunk;
      return;
    }
    // After the first bad line the decode is lost; stop retaining anything.
    if (this.error) return;
    let from = 0;
    for (let newline = chunk.indexOf("\n"); newline !== -1; newline = chunk.indexOf("\n", from)) {
      const line = this.partial + chunk.slice(from, newline);
      this.partial = "";
      this.consume(line);
      if (this.error) return;
      from = newline + 1;
    }
    this.partial += chunk.slice(from);
    if (this.partial.length > this.maxLineChars) {
      this.overflow = `adapter '${this.adapter.name}' stdout line ${this.lines + 1} exceeds ${this.maxLineChars} characters`;
      this.error = new AdapterExecutionError(this.overflow);
      this.partial = "";
    }
  }

  /** The final response; throws {@link AdapterExecutionError} when there is none. */
  finish(): string {
    const output = this.output;
    if (output.format === "text") return this.text.trim();
    if (!this.error && this.partial) {
      const tail = this.partial;
      this.partial = "";
      this.consume(tail);
    }
    if (this.error) throw this.error;
    if (this.last !== undefined) return this.last;
    const detail = this.matchingEvents
      ? `matching '${output.eventType}' events did not contain text at '${output.textPath.join(".")}'`
      : `no '${output.eventType}' event was found`;
    throw new AdapterExecutionError(`adapter '${this.adapter.name}' produced no final response: ${detail}`);
  }

  private consume(raw: string): void {
    const output = this.output;
    if (output.format !== "jsonl") return;
    this.lines++;
    const line = raw.trim(); // also drops the \r of a CRLF line ending
    if (!line) return;

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch (error) {
      this.error = new AdapterExecutionError(
        `adapter '${this.adapter.name}' emitted malformed JSONL on stdout line ${this.lines}: ${(error as Error).message}`,
      );
      return;
    }
    if (typeof event !== "object" || event === null || Array.isArray(event)) return;
    const eventRecord = event as Record<string, unknown>;
    if (eventRecord.type !== output.eventType) return;
    this.matchingEvents++;

    let value: unknown = eventRecord;
    for (const segment of output.textPath) {
      if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        !Object.prototype.hasOwnProperty.call(value, segment)
      ) {
        value = undefined;
        break;
      }
      value = (value as Record<string, unknown>)[segment];
    }
    if (typeof value !== "string") return;
    const text = value.trim();
    if (text) this.last = text;
  }
}
