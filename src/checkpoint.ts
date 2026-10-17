/**
 * `checkpoint()`: pause a run until a person approves or rejects.
 *
 * An ODW extension — Claude Code's Workflow tool has no mid-run user input —
 * for the moment someone should look before the run goes on: approve a plan
 * before the expensive fan-out, or stop a run that went off the rails.
 *
 *   const { approved, note } = await checkpoint('Run this plan?', { payload: plan })
 *
 * The question is recorded (`checkpoint_requested`) and the call waits,
 * durably: it lives in the run directory, not in a terminal, so it can be
 * answered from anywhere, for as long as it takes —
 *
 *   - `odw approve|reject <run> [--note TEXT] [--checkpoint N]`,
 *   - the dashboard (`POST /api/runs/:id/checkpoint`),
 *   - or the run's control file itself (see runtime/file-control.ts).
 *
 * The answer resolves the call to `{ approved, note, by }` and is recorded as
 * `checkpoint_resolved`. A rejection is an answer, not an error: the script
 * decides what a "no" means.
 *
 *   - **timeout** — seconds to wait; none by default. Then `onTimeout` decides:
 *     "approve" or "reject" resolve with `by: "timeout"`; "fail" (the default)
 *     throws a {@link CheckpointTimeout} — recoverable, like a failed agent.
 *   - **payload** — what the person should look at (a plan, a summary of the
 *     changes). Events carry it JSON-safe and cut to 64 KiB.
 *
 * Waiting is not work: a checkpoint takes no concurrency slot, counts toward
 * neither maxAgents nor the budget, and is asked even while the run is paused.
 * It is still the run's pending work, and a stop — or any fatal error — ends
 * the wait, and the run, at once (see `Scheduler.runWait`). Calls inside
 * parallel() wait side by side, each with its own `checkpointId`; `odw
 * resume` never replays one: the new run asks again.
 */

import type { RunContext } from "./context.js";
import { STOPPED, type CheckpointDecision } from "./control.js";
import { DynamicWorkflowError, RunStopped, WorkflowScriptError } from "./errors.js";
import { CHECKPOINT_REQUESTED, CHECKPOINT_RESOLVED, LOG, event } from "./events.js";

export interface CheckpointOptions {
  /** What the person should look at; events carry it JSON-safe, cut to 64 KiB. */
  payload?: unknown;
  /** Seconds to wait for an answer (default: no limit). */
  timeout?: number;
  /** What a timeout means: "approve", "reject", or "fail" (the default), which throws a CheckpointTimeout. */
  onTimeout?: "approve" | "reject" | "fail";
}

export interface CheckpointResult {
  approved: boolean;
  /** The note given with the answer, or null. */
  note: string | null;
  /** Who answered: `odw approve|reject`, the dashboard, or the timeout. */
  by: "cli" | "dashboard" | "timeout";
}

/** A checkpoint waiting for an answer, as status.json's `waiting` shows it. */
export interface WaitingCheckpoint {
  checkpointId: number;
  title: string;
  /** When it started waiting (epoch seconds, the `checkpoint_requested` ts). */
  since: number;
}

/**
 * No answer came within the checkpoint's `timeout` and `onTimeout` is "fail".
 * Recoverable, like a failed agent: thrown after the `checkpoint_resolved`
 * event that records it.
 */
export class CheckpointTimeout extends DynamicWorkflowError {
  constructor(
    message: string,
    readonly checkpointId: number,
    readonly title: string,
  ) {
    super(message);
  }
}

export type CheckpointPrimitive = (title: string, opts?: CheckpointOptions) => Promise<CheckpointResult>;

/** Bytes of JSON a checkpoint's payload keeps in its event (and so in the dashboard). */
export const CHECKPOINT_PAYLOAD_MAX_BYTES = 64 * 1024;
/** Characters of a title kept for events, status.json and the dashboard. */
export const CHECKPOINT_TITLE_CHARS = 200;

const ON_TIMEOUT = ["approve", "reject", "fail"] as const;

/** setTimeout's ceiling (about 24.8 days): a longer timeout means none. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Build the checkpoint() primitive bound to one run's context. */
export function createCheckpoint(ctx: RunContext): CheckpointPrimitive {
  return async (title, opts = {}) => {
    const plan = planCheckpoint(title, opts);
    if (!ctx.control.awaitDecision && plan.timeoutMs === null) {
      throw misuse("this run has no way to ask anyone (no decision channel) — give the checkpoint a timeout");
    }
    // A stop asked for while no agent runs is noticed here, before anyone is asked.
    if (ctx.control.state() === STOPPED) throw new RunStopped("run was stopped");
    // Ids follow call order, on the run's own sequence (shared with a nested workflow()).
    const checkpointId = ++ctx.checkpointSeq.value;
    const phase = ctx.currentPhase;
    return ctx.scheduler.runWait((signal) => wait(ctx, { ...plan, checkpointId, phase }, signal));
  };
}

// --- planning -------------------------------------------------------------------

/** A validated checkpoint() call. */
interface Plan {
  title: string;
  payload: unknown;
  truncated: boolean;
  /** Seconds, as given (for messages); null: no timeout. */
  timeout: number | null;
  /** null: no timer at all. */
  timeoutMs: number | null;
  onTimeout: (typeof ON_TIMEOUT)[number];
}

/** Check checkpoint()'s arguments; a misuse is a (recoverable) WorkflowScriptError, before anything is asked. */
function planCheckpoint(title: unknown, opts: unknown): Plan {
  if (typeof title !== "string" || title.trim() === "") {
    throw misuse(`the title must be a non-empty string; got ${describeValue(title)}`);
  }
  if (opts === null || typeof opts !== "object" || Array.isArray(opts)) {
    throw misuse(`options must be an object; got ${describeValue(opts)}`);
  }
  const { payload, timeout, onTimeout = "fail" } = opts as CheckpointOptions;
  if (timeout !== undefined && (typeof timeout !== "number" || !(timeout > 0))) {
    throw misuse(`timeout must be a positive number of seconds; got ${describeValue(timeout)}`);
  }
  if (!(ON_TIMEOUT as readonly unknown[]).includes(onTimeout)) {
    throw misuse(`onTimeout must be "approve", "reject" or "fail"; got ${describeValue(onTimeout)}`);
  }
  const shown = eventPayload(payload);
  return {
    // One line: it heads the dashboard's card and the CLI's prompt.
    title: clip(title.replace(/\s+/g, " ").trim(), CHECKPOINT_TITLE_CHARS),
    payload: shown.payload,
    truncated: shown.truncated,
    timeout: timeout ?? null,
    timeoutMs: timeout !== undefined && timeout * 1000 <= MAX_TIMER_MS ? timeout * 1000 : null,
    onTimeout: onTimeout as Plan["onTimeout"],
  };
}

function misuse(message: string): WorkflowScriptError {
  return new WorkflowScriptError(`checkpoint(): ${message}`);
}

/** A short description of a misused argument, for error messages. */
function describeValue(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return "an array";
  if (typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

/** At most `max` characters (code points), ending in an ellipsis when cut. */
function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max - 1).join("") + "…";
}

// --- the payload ------------------------------------------------------------------

/**
 * The payload as the `checkpoint_requested` event carries it: JSON-safe — a
 * BigInt becomes its digits, a circular reference "[Circular]", and what JSON
 * drops (functions, undefined) is dropped — and at most 64 KiB of JSON. A
 * payload too large to keep whole keeps its start, as text (a string payload
 * stays readable as itself), and the event says `truncated`.
 */
export function eventPayload(value: unknown): { payload: unknown; truncated: boolean } {
  if (value === undefined) return { payload: null, truncated: false };
  let text: string;
  try {
    text = JSON.stringify(value, jsonSafe()) ?? "null";
  } catch (err) {
    // A toJSON() that throws must not cost the run its question.
    return { payload: `[the payload could not be serialized: ${errorMessage(err)}]`, truncated: false };
  }
  if (Buffer.byteLength(text, "utf8") <= CHECKPOINT_PAYLOAD_MAX_BYTES) {
    return { payload: JSON.parse(text) as unknown, truncated: false };
  }
  const source = typeof value === "string" ? value : text;
  return { payload: clipToJson(source, CHECKPOINT_PAYLOAD_MAX_BYTES), truncated: true };
}

/** A JSON.stringify replacer that never throws on a BigInt or a cycle. */
function jsonSafe(): (this: unknown, key: string, value: unknown) => unknown {
  const ancestors: unknown[] = [];
  return function (this: unknown, _key: string, value: unknown): unknown {
    if (typeof value === "bigint") return value.toString();
    if (typeof value !== "object" || value === null) return value;
    // `this` is the object holding `value`: unwind to it, so only a value's
    // own ancestors count as a cycle (a shared, repeated object does not).
    while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
    if (ancestors.includes(value)) return "[Circular]";
    ancestors.push(value);
    return value;
  };
}

/** The longest start of `text` (plus an ellipsis) whose JSON string fits in `maxBytes`. */
function clipToJson(text: string, maxBytes: number): string {
  let keep = maxBytes;
  for (;;) {
    const cut = clipUtf8(text, keep) + "…";
    const size = Buffer.byteLength(JSON.stringify(cut), "utf8");
    if (size <= maxBytes || keep <= 0) return cut;
    // Quotes and escapes cost more than the bytes they stand for: shrink in proportion.
    keep = Math.floor((keep * maxBytes) / size) - 16;
  }
}

/** The longest start of `text` that is at most `maxBytes` of UTF-8, never splitting a character. */
function clipUtf8(text: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    // A lone surrogate encodes as U+FFFD: three bytes, like the rest of the BMP above 0x7FF.
    const size = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += ch.length;
  }
  return text.slice(0, end);
}

// --- waiting ------------------------------------------------------------------------

/**
 * Ask, then wait for an answer, the timeout, or the end of the run — whichever
 * comes first. Every `checkpoint_requested` gets exactly one
 * `checkpoint_resolved`: with the answer, with the timeout's verdict, or with
 * an `error` (and `by: null`) when the run ended first.
 */
async function wait(
  ctx: RunContext,
  cp: Plan & { checkpointId: number; phase: string | null },
  signal: AbortSignal,
): Promise<CheckpointResult> {
  const { checkpointId, title } = cp;
  // The wait ends on an answer, on its own timeout, or when the run is aborted.
  const asked = new AbortController();
  const onRunAbort = (): void => asked.abort(signal.reason);
  signal.addEventListener("abort", onRunAbort, { once: true });
  // Listen before anyone is told, so no answer can arrive too early to count.
  const answered: Promise<CheckpointDecision> = ctx.control.awaitDecision
    ? ctx.control.awaitDecision(checkpointId, asked.signal)
    : untilAborted(asked.signal);
  answered.catch(() => {}); // a timeout ends the wait on purpose: never an unhandled rejection

  const requested = event(CHECKPOINT_REQUESTED, {
    checkpointId,
    title,
    payload: cp.payload,
    ...(cp.truncated ? { truncated: true } : {}),
    phase: cp.phase,
  });
  ctx.emit(requested);
  const waiting: WaitingCheckpoint = { checkpointId, title, since: requested.ts };
  report(ctx, waiting, true);

  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    if (cp.timeoutMs !== null) timer = setTimeout(() => resolve("timeout"), cp.timeoutMs);
  });
  const resolved = (fields: Record<string, unknown>): void =>
    ctx.emit(event(CHECKPOINT_RESOLVED, { checkpointId, ...fields }));
  try {
    let outcome: CheckpointDecision | "timeout";
    try {
      outcome = await Promise.race([answered, timedOut]);
    } catch (err) {
      // The run ended first (a stop, a fatal error): the question is withdrawn.
      const reason = signal.aborted ? abortReason(signal) : err;
      resolved({ approved: false, note: null, by: null, error: errorMessage(reason) });
      throw reason;
    }
    if (outcome !== "timeout") {
      const result: CheckpointResult = { approved: outcome.approved, note: outcome.note, by: outcome.by };
      resolved({ ...result });
      return result;
    }
    asked.abort(new Error("timed out")); // stop listening for an answer
    if (cp.onTimeout === "fail") {
      const message = `checkpoint #${checkpointId} '${title}' got no answer within ${cp.timeout}s`;
      resolved({ approved: false, note: null, by: "timeout", error: message });
      throw new CheckpointTimeout(message, checkpointId, title);
    }
    const result: CheckpointResult = { approved: cp.onTimeout === "approve", note: null, by: "timeout" };
    resolved({ ...result });
    return result;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onRunAbort);
    report(ctx, waiting, false);
  }
}

/** Tell the worker a checkpoint started or stopped waiting; its failure only costs a log line. */
function report(ctx: RunContext, cp: WaitingCheckpoint, waiting: boolean): void {
  if (!ctx.onCheckpoint) return;
  try {
    ctx.onCheckpoint(cp, waiting);
  } catch (err) {
    ctx.emit(
      event(LOG, { message: `could not record checkpoint #${cp.checkpointId} as ${waiting ? "waiting" : "answered"}: ${errorMessage(err)}` }),
    );
  }
}

/** A wait nobody can answer: it only ends when `signal` aborts. */
function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/** The run's fatal error behind an aborted signal (the bridge's convention). */
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new RunStopped("run was stopped");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
