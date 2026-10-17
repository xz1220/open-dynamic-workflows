/**
 * Agent transcripts (an ODW extension): what each agent's CLI printed, kept
 * with its run as it runs — so "what did agent #7 actually do?" has an answer,
 * not just its final reply.
 *
 * A {@link TranscriptRecorder} keeps one agent call's output in the run
 * directory, beside its result record:
 *
 *   agents/<agentId>.transcript.jsonl   its stdout: a JSONL adapter's events one
 *                                       per line, as received (Claude Code's
 *                                       stream-json, kilo's and opencode's
 *                                       events); any other adapter's output as
 *                                       {"kind":"text","text":…} lines, one per
 *                                       line it printed (newline included; a
 *                                       longer line in 4 KB pieces)
 *   agents/<agentId>.stderr.txt         the end of its stderr (the last 64 KB)
 *
 * Every further CLI run of the call — a schema retry, a stall restart, a
 * rate-limit retry, a retry of work that missed its `expect` checks — goes on
 * in the same files, after an
 * {"kind":"attempt","n":2,"reason":"schema"|"stall"|"rate_limit"|"expect"} line; a
 * call that falls back to another adapter (an ODW extension) goes on after
 * {"kind":"attempt","n":2,"reason":"fallback","adapter":"<next>"}, its output
 * kept as that adapter prints it from there on — and one that waited for a
 * spent quota to reset (quotaWait, an ODW extension) after
 * {"kind":"attempt","n":2,"reason":"quota_wait","adapter":"<its adapter>"}. Past
 * `maxTranscriptBytes` nothing more is kept but one
 * {"kind":"truncated","bytes":N} line, N being the bytes kept. ODW's own lines
 * carry a `kind` and no `type`, so they never pass for an adapter's events.
 *
 * With a redactor (an ODW extension; see ./redact), likely secrets are kept as
 * `«redacted:<kind>»`: a JSONL adapter's event that had any is written anew,
 * marked `"redacted":true`; text is redacted as it streams, a secret split
 * across two chunks included, and a text line that had any is marked the same;
 * the stderr file is redacted each time it is written, its kept end starting
 * at a line (a secret is never kept cut in half).
 *
 * The output arrives on the runner's hot path, so keeping it never waits:
 * whole lines are queued in memory (never more than `maxTranscriptBytes` of
 * them) and appended by one asynchronous writer, and the stderr file is
 * rewritten at most once a second. {@link TranscriptRecorder.close} waits for
 * both, so a transcript is complete before its agent's terminal event. Reading
 * one back, normalized for people, is runtime/transcript-view.ts.
 */

import { mkdir, open, rename, writeFile, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

import type { Adapter, CliResult } from "./adapters/types.js";
import { hasMarker, type RedactStream, type Redactor } from "./redact.js";

/**
 * Why a call ran a CLI once more: its reply failed the schema, the CLI
 * stalled, it was rate-limited, or — ODW extensions — its work missed its
 * `expect` checks, the call fell back to the next adapter of its chain, or it
 * starts over after waiting for a spent quota to reset (quotaWait).
 */
export type AttemptReason = "schema" | "stall" | "rate_limit" | "expect" | "fallback" | "quota_wait";

/** Where one agent's transcript is kept: its stdout, and the end of its stderr. */
export interface TranscriptPaths {
  transcript: string;
  stderr: string;
}

/**
 * Bytes of UTF-8 one `{"kind":"text"}` line holds — and one field of a
 * normalized entry (runtime/transcript-view.ts), past which it is clipped.
 */
export const TRANSCRIPT_FIELD_BYTES = 4096;

/** Characters of stderr kept: its last 64 KB, as the runner keeps of a failed run. */
export const STDERR_TAIL_CHARS = 64 * 1024;

/** How often, at most, a running agent's stderr file is rewritten. */
const STDERR_FLUSH_MS = 1000;

/** How a further CLI run reads, by why it ran — and, for a fallback, the adapter it moved to. */
export function attemptLabel(reason: string | undefined, adapter?: string): string {
  switch (reason) {
    case "schema":
      return "schema retry";
    case "stall":
      return "stall restart";
    case "rate_limit":
      return "rate-limit retry";
    case "expect":
      return "expectation retry";
    case "fallback":
      return adapter ? `fallback to ${adapter}` : "fallback";
    case "quota_wait":
      return adapter ? `after the quota wait, on ${adapter}` : "after the quota wait";
    default:
      return "retry";
  }
}

/** How a transcript keeps what an adapter's CLI prints: a JSONL adapter's events as they come, anything else as text. */
export function transcriptFormat(adapter: Pick<Adapter, "output">): "jsonl" | "text" {
  return adapter.output?.format === "jsonl" ? "jsonl" : "text";
}

const encoder = new TextEncoder();
const scratch = new Uint8Array(TRANSCRIPT_FIELD_BYTES);

/**
 * How many UTF-16 code units of `text`, from `from` on, fit in
 * {@link TRANSCRIPT_FIELD_BYTES} of UTF-8 without cutting a character.
 */
export function fitField(text: string, from = 0): number {
  const rest = text.length - from;
  // No code unit takes more than 3 bytes (a surrogate pair takes 4 for two).
  if (rest * 3 <= TRANSCRIPT_FIELD_BYTES) return rest;
  const window = text.slice(from, from + TRANSCRIPT_FIELD_BYTES);
  let read = encoder.encodeInto(window, scratch).read;
  // A pair the window cut in two goes whole into the next piece.
  const last = window.charCodeAt(read - 1);
  if (read < rest && last >= 0xd800 && last <= 0xdbff) read--;
  return read;
}

export interface TranscriptRecorderOptions extends TranscriptPaths {
  /** "jsonl": the CLI prints events, a line each, kept as received; "text": anything else, kept as text lines. */
  format: "jsonl" | "text";
  /** `maxTranscriptBytes`: the bytes kept; past them, one truncation line. */
  maxBytes: number;
  /** Receives what the run should log: a transcript that could not be written. */
  onNote?: (message: string) => void;
  /** Keeps likely secrets out of both files (an ODW extension; see ./redact). */
  redactor?: Redactor;
}

/**
 * Keeps one agent call's transcript (see the module doc). The bridge reports
 * each CLI run's start ({@link beginRun}), what it prints ({@link stdout},
 * {@link stderr}) and its end ({@link endRun}); the call's owner
 * {@link close}s it once the call settles.
 */
export class TranscriptRecorder {
  /** Whole lines accepted and not written yet. */
  private queue: string[] = [];
  /** Bytes accepted so far, written or queued. */
  private size = 0;
  /** The cap was reached: the truncation line is out, nothing more is kept. */
  private cut = false;
  /** The line being received, until its newline arrives. */
  private partial = "";
  /** CLI runs started. */
  private runs = 0;
  /** This CLI run printed on stdout as it went (else the result's stdout is what it printed). */
  private heard = false;
  /** How this CLI run's stdout is kept: the format of the adapter it runs on (a fallback may change it). */
  private format: "jsonl" | "text";
  /** This CLI run's text output, redacted as it streams (see ./redact). */
  private redacting: RedactStream | null = null;
  private file: FileHandle | null = null;
  private writing: Promise<void> | null = null;
  private broken = false;
  private closed = false;
  /** The end of the stderr of the CLI runs that ended; the running one's, and its attempt line. */
  private stderrBefore = "";
  private stderrNow = "";
  private stderrHead = "";
  private stderrTimer: NodeJS.Timeout | undefined;
  private stderrWriting: Promise<void> | null = null;
  private stderrAgain = false;
  private stderrBroken = false;

  constructor(private readonly opts: TranscriptRecorderOptions) {
    this.format = opts.format;
    // The transcript is there from the agent's start — before its CLI prints a
    // byte, or when it fails before its CLI could start.
    this.kick();
  }

  /**
   * A CLI run of the call starts: the first one, or one more for `reason`.
   * `adapter` is the one it runs on: after a fallback (an ODW extension) its
   * line names it, and its output is kept as that adapter prints it.
   */
  beginRun(reason?: AttemptReason, adapter?: Pick<Adapter, "name" | "output">): void {
    if (this.closed) return;
    this.flushPartial(); // a run whose end never came (its runner threw) still ends its line
    if (adapter) this.format = transcriptFormat(adapter);
    this.runs++;
    this.heard = false;
    this.stderrNow = "";
    // The first run needs no line — unless it is a fallback's: the call left its
    // adapter before any CLI ran there (the quota breaker took it out) — or it
    // follows a wait for a spent quota.
    if (this.runs === 1 && reason === undefined) return;
    const moved = (reason === "fallback" || reason === "quota_wait") && adapter ? { adapter: adapter.name } : {};
    this.accept(JSON.stringify({ kind: "attempt", n: this.runs, reason, ...moved }) + "\n");
    this.stderrHead = `--- attempt ${this.runs}: ${attemptLabel(reason, adapter?.name)} ---\n`;
  }

  /** What the CLI printed on stdout, as it arrives. Never waits. */
  stdout(chunk: string): void {
    if (this.closed || !chunk) return;
    this.heard = true;
    if (this.cut) return;
    // Text is redacted as it streams: what can be kept now comes back (see ./redact).
    if (this.format === "text" && this.opts.redactor?.active) {
      this.redacting ??= this.opts.redactor.stream();
      this.take(this.redacting.write(chunk));
    } else {
      this.take(chunk);
    }
  }

  /** What the CLI printed, ready to keep: whole lines go, the rest waits for its newline. */
  private take(chunk: string): void {
    if (!chunk) return;
    let from = 0;
    for (let nl = chunk.indexOf("\n"); nl !== -1 && !this.cut; nl = chunk.indexOf("\n", from)) {
      const line = this.partial + chunk.slice(from, nl + 1);
      this.partial = "";
      from = nl + 1;
      this.line(line);
    }
    if (this.cut) return;
    this.partial += chunk.slice(from);
    if (this.format === "text") {
      // A long line is kept in pieces as it arrives, never held whole.
      let at = 0;
      while ((this.partial.length - at) * 3 > TRANSCRIPT_FIELD_BYTES && !this.cut) {
        const n = fitField(this.partial, at);
        if (n >= this.partial.length - at) break;
        this.textPiece(this.partial.slice(at, at + n));
        at += n;
      }
      if (at > 0) this.partial = this.partial.slice(at);
    } else if (this.partial.length >= this.opts.maxBytes - this.size) {
      // An event that can no longer fit ends the transcript now, rather than being held in memory.
      this.truncate();
    }
  }

  /** What the CLI printed on stderr, as it arrives: its end is kept, the file rewritten at most once a second. */
  stderr(chunk: string): void {
    if (this.closed || !chunk) return;
    this.stderrNow += chunk;
    // Trim lazily, at twice the limit, so a stream of small chunks stays linear.
    if (this.stderrNow.length > 2 * STDERR_TAIL_CHARS) this.stderrNow = this.tail(this.stderrNow);
    this.writeStderrSoon(STDERR_FLUSH_MS);
  }

  /**
   * The CLI run ended: its last, unterminated line is kept, and the end of its
   * stderr as the runner reports it — with the runner's own notes (a kill, an
   * output overrun, a CLI that could not start).
   */
  endRun(cli: CliResult): void {
    if (this.closed) return;
    // A runner that does not stream (a test's) hands the whole stdout over at the end.
    if (!this.heard && cli.stdout) this.stdout(cli.stdout);
    this.flushPartial();
    if (cli.stderr.trim()) {
      // The runner keeps the end of stderr too: one it cut may start inside a secret.
      const kept = this.opts.redactor?.active && cli.stderr.length >= STDERR_TAIL_CHARS ? fromLineStart(cli.stderr) : cli.stderr;
      const stderr = kept.endsWith("\n") ? kept : `${kept}\n`;
      this.stderrBefore = this.tail(this.stderrBefore + this.stderrHead + stderr);
    }
    this.stderrNow = "";
    this.stderrHead = "";
    this.writeStderrSoon(0);
  }

  /**
   * The call settled: what is queued and the stderr tail are written, and the
   * file is let go. Resolves once the transcript is complete. Never throws.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.flushPartial();
    this.closed = true;
    if (this.stderrTimer) this.writeStderrSoon(0);
    while (this.writing) await this.writing;
    while (this.stderrWriting) await this.stderrWriting;
    const file = this.file;
    this.file = null;
    await file?.close().catch(() => {});
  }

  // --- stdout ---------------------------------------------------------------------

  /** One whole line of stdout, its newline included (the last one of a run may have none). */
  private line(text: string): void {
    if (this.format === "jsonl") {
      // An event, as received — its secrets redacted; a blank line carries none.
      if (text.trim() === "") return;
      const line = this.opts.redactor ? this.opts.redactor.jsonLine(text) : text;
      this.accept(line.endsWith("\n") ? line : `${line}\n`);
      return;
    }
    for (let at = 0; at < text.length && !this.cut; ) {
      const n = fitField(text, at);
      this.textPiece(text.slice(at, at + n));
      at += n;
    }
  }

  private textPiece(text: string): void {
    const redacted = this.opts.redactor?.active && hasMarker(text);
    this.accept(JSON.stringify(redacted ? { kind: "text", text, redacted: true } : { kind: "text", text }) + "\n");
  }

  /** The line the CLI left unterminated: kept as it is, before anything else is. */
  private flushPartial(): void {
    // What the redacting stream still holds goes first: the run is over, nothing more completes it.
    const held = this.redacting?.end() ?? "";
    this.redacting = null;
    if (held && !this.cut) this.take(held);
    const rest = this.partial;
    this.partial = "";
    if (rest && !this.cut) this.line(rest);
  }

  /** Queue one whole line — unless it would pass the cap, which ends the transcript instead. */
  private accept(line: string): void {
    if (this.cut || this.broken) return;
    const bytes = Buffer.byteLength(line);
    if (this.size + bytes > this.opts.maxBytes) return this.truncate();
    this.size += bytes;
    this.queue.push(line);
    this.kick();
  }

  /** The cap is reached: one last line says so, and nothing more is kept. */
  private truncate(): void {
    this.cut = true;
    this.partial = "";
    this.queue.push(JSON.stringify({ kind: "truncated", bytes: this.size }) + "\n");
    this.kick();
  }

  /** Start the writer, unless it is running (it takes what is queued meanwhile) or the file failed. */
  private kick(): void {
    if (this.writing || this.broken) return;
    this.writing = this.drain().then(() => {
      this.writing = null;
      if (this.queue.length > 0) this.kick();
    });
  }

  private async drain(): Promise<void> {
    try {
      if (!this.file) {
        await mkdir(dirname(this.opts.transcript), { recursive: true });
        this.file = await open(this.opts.transcript, "a");
      }
      while (this.queue.length > 0) {
        const text = this.queue.join("");
        this.queue = [];
        await this.file.appendFile(text, "utf8");
      }
    } catch (err) {
      this.broken = true;
      this.queue = [];
      this.opts.onNote?.(`could not keep its transcript: ${errorText(err)}`);
    }
  }

  // --- stderr -----------------------------------------------------------------------

  private stderrText(): string {
    const running = this.stderrNow ? this.stderrHead + this.stderrNow : "";
    const text = this.tail(this.stderrBefore + running);
    return this.opts.redactor ? this.opts.redactor.text(text) : text;
  }

  /**
   * The end of `text` that is kept: its last 64 KB — from the start of a line,
   * with a redactor, so no secret is kept cut in half.
   */
  private tail(text: string): string {
    if (text.length <= STDERR_TAIL_CHARS) return text;
    const end = text.slice(-STDERR_TAIL_CHARS);
    return this.opts.redactor?.active ? fromLineStart(end) : end;
  }

  /** Rewrite the stderr file after `delayMs` (one write is due at a time), or at once. */
  private writeStderrSoon(delayMs: number): void {
    if (delayMs === 0) {
      clearTimeout(this.stderrTimer);
      this.stderrTimer = undefined;
      this.writeStderr();
      return;
    }
    this.stderrTimer ??= setTimeout(() => {
      this.stderrTimer = undefined;
      this.writeStderr();
    }, delayMs).unref();
  }

  private writeStderr(): void {
    if (this.stderrBroken) return;
    if (this.stderrWriting) {
      this.stderrAgain = true; // the write in flight goes again when it is done
      return;
    }
    this.stderrWriting = this.saveStderr().then(() => {
      this.stderrWriting = null;
      if (!this.stderrAgain) return;
      this.stderrAgain = false;
      this.writeStderr();
    });
  }

  /** Replace the stderr file with the current tail, atomically; no stderr, no file. */
  private async saveStderr(): Promise<void> {
    const text = this.stderrText();
    if (!text) return;
    const path = this.opts.stderr;
    const tmp = `${path}.tmp`;
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(tmp, text, "utf8");
      await rename(tmp, path);
    } catch (err) {
      this.stderrBroken = true;
      this.opts.onNote?.(`could not keep the end of its stderr: ${errorText(err)}`);
    }
  }
}

/** Text whose start was cut off, from its next line on — else past its next space; as it is without either. */
function fromLineStart(text: string): string {
  const nl = text.indexOf("\n");
  if (nl !== -1 && nl < text.length - 1) return text.slice(nl + 1);
  const space = text.search(/\s/);
  return space !== -1 && space < text.length - 1 ? text.slice(space + 1) : text;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
