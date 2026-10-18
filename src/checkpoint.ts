/**
 * `checkpoint()`: pause a run until a person approves or rejects.
 *
 * An ODW extension — Claude Code's Workflow tool has no mid-run user input —
 * for the moment someone should look before the run goes on: approve a plan
 * before the expensive fan-out, or stop a run that went off the rails.
 *
 *   const { approved, note, payload } = await checkpoint('Run this plan?', { payload: plan })
 *
 * The question is recorded (`checkpoint_requested`) and the call waits,
 * durably: it lives in the run directory, not in a terminal, so it can be
 * answered from anywhere, for as long as it takes —
 *
 *   - `odw approve|reject <run> [--note TEXT] [--checkpoint N]`, and
 *     `odw approve <run> --payload JSON|@file` or `--edit` to approve an edit,
 *   - the dashboard (`POST /api/runs/:id/checkpoint`, `payload` with approve),
 *   - or the run's decision log itself (see runtime/file-control.ts).
 *
 * The answer resolves the call to `{ approved, note, by, payload, edited }`
 * and is recorded as `checkpoint_resolved`. A rejection is an answer, not an
 * error: the script decides what a "no" means.
 *
 * As with Claude Code's plan approval, the person may change what they
 * approve: an approval can carry an edited payload. `payload` is what was
 * approved — the edit, when there is one, else the checkpoint's own payload,
 * as given (undefined when it had none) — and `edited` is true only when the
 * edit differs from that payload as JSON: an unchanged edit is no edit. A
 * rejection, and a timeout, carry the checkpoint's own payload. The run takes
 * an edit only as JSON of at most 256 KiB that matches the checkpoint's
 * `schema`, when it has one ({@link checkEdit}); `odw approve` and the server
 * refuse any other before writing it, and one written to the decision log by
 * hand is dropped with a log line while the checkpoint waits on.
 *
 *   - **timeout** — seconds to wait; none by default. Then `onTimeout` decides:
 *     "approve" or "reject" resolve with `by: "timeout"`; "fail" (the default)
 *     throws a {@link CheckpointTimeout} — recoverable, like a failed agent.
 *   - **payload** — what the person should look at (a plan, a summary of the
 *     changes). Events carry it JSON-safe and cut to 64 KiB.
 *   - **schema** — a JSON Schema an edited payload must match, checked by
 *     ODW's validator (./schema), as an agent()'s reply is. Without one any
 *     JSON value is taken, on purpose: the payload is the script's own data,
 *     of any shape, and only the script knows what it will do with an edit —
 *     a rule ODW guessed (keep the original's type, say) would refuse fair
 *     edits, such as a list where the payload was null. A script that relies
 *     on the shape says so with a schema; one without treats an edit as input
 *     it did not produce.
 *
 * Waiting is not work: a checkpoint takes no concurrency slot, counts toward
 * neither maxAgents nor the budget, and is asked even while the run is paused.
 * It is still the run's pending work, and a stop — or any fatal error — ends
 * the wait, and the run, at once (see `Scheduler.runWait`). Calls inside
 * parallel() wait side by side, each with its own `checkpointId`; `odw
 * resume` never replays one: the new run asks again.
 */

import type { Settings } from "./adapters/types.js";
import type { RunContext } from "./context.js";
import { deciderText, STOPPED, type CheckpointDecision } from "./control.js";
import { DynamicWorkflowError, RunStopped, WorkflowScriptError } from "./errors.js";
import { CHECKPOINT_REQUESTED, CHECKPOINT_RESOLVED, LOG, event } from "./events.js";
import { auditSchema, checkedSubset, deepEqual, validate, type JsonSchema, type SchemaIssue } from "./schema.js";

export interface CheckpointOptions {
  /** What the person should look at; events carry it JSON-safe, cut to 64 KiB. */
  payload?: unknown;
  /** A JSON Schema an edited payload must match (ODW's validator); without one, any JSON value. */
  schema?: JsonSchema;
  /** Seconds to wait for an answer (default: no limit). */
  timeout?: number;
  /** What a timeout means: "approve", "reject", or "fail" (the default), which throws a CheckpointTimeout. */
  onTimeout?: "approve" | "reject" | "fail";
}

export interface CheckpointResult {
  approved: boolean;
  /** The note given with the answer, or null. */
  note: string | null;
  /** Who answered: `odw approve|reject`, the dashboard, a signed approve link (ODW extension), or the timeout. */
  by: "cli" | "dashboard" | "link" | "timeout";
  /**
   * What was approved: the person's edit when there is one (`edited`), else
   * the checkpoint's own payload, as given — undefined when it had none. A
   * rejection and a timeout carry the checkpoint's own.
   */
  payload: unknown;
  /** The approval came with an edited payload that differs from the checkpoint's own (as JSON). */
  edited: boolean;
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
/** Bytes of JSON an edited payload may have: `odw approve`, the server and the run refuse a bigger one. */
export const CHECKPOINT_EDIT_MAX_BYTES = 256 * 1024;
/** Characters of a title kept for events, status.json and the dashboard. */
export const CHECKPOINT_TITLE_CHARS = 200;

/** How many problems — a schema's, an edit's — a message lists before "and N more". */
const LISTED_PROBLEMS = 8;

const ON_TIMEOUT = ["approve", "reject", "fail"] as const;

/** setTimeout's ceiling (about 24.8 days): a longer timeout means none. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Build the checkpoint() primitive bound to one run's context. */
export function createCheckpoint(ctx: RunContext): CheckpointPrimitive {
  return async (title, opts = {}) => {
    const plan = planCheckpoint(title, opts, ctx.config.settings.schemaKeywords);
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
  /** The payload as given: what the call resolves to unless an edit replaces it. */
  original: unknown;
  /** The payload as its event carries it: JSON-safe, cut to 64 KiB. */
  payload: unknown;
  truncated: boolean;
  /** The payload's whole JSON-safe form, which an edit is compared with; null when it would not serialize. */
  json: { value: unknown } | null;
  /** The schema an edit must match, as JSON; null: none. */
  schema: JsonSchema | null;
  /** What the run says about keywords in `schema` ODW does not check; null when there are none. */
  schemaNote: string | null;
  /** Seconds, as given (for messages); null: no timeout. */
  timeout: number | null;
  /** null: no timer at all. */
  timeoutMs: number | null;
  onTimeout: (typeof ON_TIMEOUT)[number];
}

/** Check checkpoint()'s arguments; a misuse is a (recoverable) WorkflowScriptError, before anything is asked. */
function planCheckpoint(title: unknown, opts: unknown, schemaKeywords: Settings["schemaKeywords"]): Plan {
  if (typeof title !== "string" || title.trim() === "") {
    throw misuse(`the title must be a non-empty string; got ${describeValue(title)}`);
  }
  if (opts === null || typeof opts !== "object" || Array.isArray(opts)) {
    throw misuse(`options must be an object; got ${describeValue(opts)}`);
  }
  const { payload, schema, timeout, onTimeout = "fail" } = opts as CheckpointOptions;
  if (timeout !== undefined && (typeof timeout !== "number" || !(timeout > 0))) {
    throw misuse(`timeout must be a positive number of seconds; got ${describeValue(timeout)}`);
  }
  if (!(ON_TIMEOUT as readonly unknown[]).includes(onTimeout)) {
    throw misuse(`onTimeout must be "approve", "reject" or "fail"; got ${describeValue(onTimeout)}`);
  }
  const { json: schemaJson, note: schemaNote } = planSchema(schema, schemaKeywords);
  const json = payloadJson(payload);
  const shown = eventPayload(payload, json);
  return {
    // One line: it heads the dashboard's card and the CLI's prompt.
    title: clip(title.replace(/\s+/g, " ").trim(), CHECKPOINT_TITLE_CHARS),
    original: payload,
    payload: shown.payload,
    truncated: shown.truncated,
    json: "text" in json ? { value: JSON.parse(json.text) as unknown } : null,
    schema: schemaJson,
    schemaNote,
    timeout: timeout ?? null,
    timeoutMs: timeout !== undefined && timeout * 1000 <= MAX_TIMER_MS ? timeout * 1000 : null,
    onTimeout: onTimeout as Plan["onTimeout"],
  };
}

/**
 * Check a checkpoint's schema the way agent() checks one (adapters/native-schema):
 * it must be a JSON Schema object (null and undefined: none), and nothing in
 * it malformed. JSON Schema ODW's validator does not check is enforced by
 * nobody here — no CLI sees an edit — so under `schemaKeywords: "strict"` it
 * is a misuse, and otherwise the run says once which keywords go unchecked.
 */
function planSchema(
  schema: unknown,
  schemaKeywords: Settings["schemaKeywords"],
): { json: JsonSchema | null; note: string | null } {
  if (schema === undefined || schema === null) return { json: null, note: null };
  if (typeof schema !== "object" || Array.isArray(schema)) {
    throw misuse(`schema must be a JSON Schema object; got ${describeValue(schema)}`);
  }
  const issues = auditSchema(schema);
  const invalid = issues.filter((issue) => issue.kind === "invalid");
  if (invalid.length > 0) {
    throw misuse(`schema is not JSON Schema ODW can check: ${listIssues(invalid)} — fix ${invalid.length === 1 ? "it" : "them"}`);
  }
  const unchecked = issues.filter((issue) => issue.kind === "unchecked");
  if (unchecked.length > 0 && schemaKeywords === "strict") {
    throw misuse(
      `schema uses JSON Schema that ODW's validator does not check, and nothing else would ("schemaKeywords": "strict"): ` +
        `${listIssues(unchecked)} — remove ${unchecked.length === 1 ? "it" : "them"}, or set "schemaKeywords": "warn" to check the rest`,
    );
  }
  let json: JsonSchema;
  try {
    // What the event carries, and what `odw approve` and the server check an edit against.
    json = JSON.parse(JSON.stringify(schema)) as JsonSchema;
  } catch (err) {
    throw misuse(`schema must be JSON: ${errorMessage(err)}`);
  }
  const note =
    unchecked.length > 0
      ? `schema keywords ODW does not check, and nothing else will: ${listIssues(unchecked)} — an edited payload is ` +
        `checked against the rest; "schemaKeywords": "strict" refuses such schemas`
      : null;
  return { json, note };
}

/** `"oneOf" at #/properties/status; …`, the first few, then how many more. */
function listIssues(issues: SchemaIssue[]): string {
  return listProblems(issues.map((issue) => `${issue.what} at ${issue.at}`));
}

/** Problems joined with "; ", the first few, then how many more. */
function listProblems(problems: string[]): string {
  const more = problems.length - LISTED_PROBLEMS;
  return problems.slice(0, LISTED_PROBLEMS).join("; ") + (more > 0 ? `; and ${more} more` : "");
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
export function eventPayload(value: unknown, json = payloadJson(value)): { payload: unknown; truncated: boolean } {
  if (value === undefined) return { payload: null, truncated: false };
  // A toJSON() that throws must not cost the run its question.
  if ("error" in json) return { payload: `[the payload could not be serialized: ${json.error}]`, truncated: false };
  if (Buffer.byteLength(json.text, "utf8") <= CHECKPOINT_PAYLOAD_MAX_BYTES) {
    return { payload: JSON.parse(json.text) as unknown, truncated: false };
  }
  const source = typeof value === "string" ? value : json.text;
  return { payload: clipToJson(source, CHECKPOINT_PAYLOAD_MAX_BYTES), truncated: true };
}

/** A payload's whole JSON text, JSON-safe as {@link eventPayload} makes it ("null" for none), or why it would not serialize. */
function payloadJson(value: unknown): { text: string } | { error: string } {
  try {
    return { text: JSON.stringify(value, jsonSafe()) ?? "null" };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

/** An edited payload as {@link checkEdit} found it. */
export type CheckedEdit =
  | { ok: true; value: unknown }
  | {
      ok: false;
      /** Why, as a sentence about "the payload". */
      message: string;
      /** The validator's problems one by one — for any other reason, the message alone. */
      problems: string[];
      /** It is over {@link CHECKPOINT_EDIT_MAX_BYTES} (the server answers 413). */
      tooLarge: boolean;
    };

/**
 * Check an approval's edited payload, as `odw approve`, the server and the
 * run each do: it must be a JSON value of at most 256 KiB serialized
 * (compact), matching `schema` — the checkpoint's, as its event carries it —
 * when there is one, with ODW's validator (the part of the schema it checks;
 * see ./schema). Without a schema any JSON value goes (see the module notes
 * for why). `value` is the edit as JSON, a fresh copy. Never throws.
 */
export function checkEdit(payload: unknown, schema: unknown): CheckedEdit {
  const refuse = (message: string, problems = [message], tooLarge = false): CheckedEdit => ({
    ok: false,
    message,
    problems,
    tooLarge,
  });
  try {
    const text = JSON.stringify(payload);
    if (text === undefined) return refuse("the payload is not a JSON value");
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > CHECKPOINT_EDIT_MAX_BYTES) {
      return refuse(`the payload is ${bytes} bytes of JSON; the limit is ${CHECKPOINT_EDIT_MAX_BYTES} (256 KiB)`, undefined, true);
    }
    const value = JSON.parse(text) as unknown;
    if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return { ok: true, value };
    const problems = validate(value, checkedSubset(schema));
    if (problems.length === 0) return { ok: true, value };
    return refuse(`the payload does not match the checkpoint's schema: ${listProblems(problems)}`, problems);
  } catch (err) {
    // A BigInt or a cycle (an in-process answer), or JSON nested too deep to walk.
    return refuse(`the payload is not JSON: ${errorMessage(err)}`);
  }
}

/** Whether an edit is the payload it was made from, as JSON (a payload that would not serialize never is). */
function sameJson(edit: unknown, json: { value: unknown } | null): boolean {
  try {
    return json !== null && deepEqual(edit, json.value);
  } catch {
    return false; // nested too deep to compare: an edit, then
  }
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
  // An edit the run does not take — not JSON, too large, off the schema — is
  // refused: that answer is dropped, said in the run's log, and the
  // checkpoint goes on waiting (as for an answer to no checkpoint at all).
  const accept = (decision: CheckpointDecision): boolean => {
    if (decision.payload === undefined) return true;
    const checked = checkEdit(decision.payload, cp.schema);
    if (checked.ok) return true;
    const from = deciderText(decision.by);
    say(ctx, `ignored "approve" for checkpoint #${checkpointId} from ${from}: ${checked.message} — it still waits for an answer`);
    return false;
  };
  // Listen before anyone is told, so no answer can arrive too early to count.
  const answered: Promise<CheckpointDecision> = ctx.control.awaitDecision
    ? ctx.control.awaitDecision(checkpointId, asked.signal, accept)
    : untilAborted(asked.signal);
  answered.catch(() => {}); // a timeout ends the wait on purpose: never an unhandled rejection

  let waiting: WaitingCheckpoint | undefined;
  let timer: NodeJS.Timeout | undefined;
  const resolved = (fields: Record<string, unknown>): void =>
    ctx.emit(event(CHECKPOINT_RESOLVED, { checkpointId, ...fields }));
  try {
    if (cp.schemaNote) ctx.emit(event(LOG, { message: `checkpoint #${checkpointId}: ${cp.schemaNote}` }));
    const requested = event(CHECKPOINT_REQUESTED, {
      checkpointId,
      title,
      payload: cp.payload,
      ...(cp.truncated ? { truncated: true } : {}),
      ...(cp.schema ? { schema: cp.schema } : {}),
      phase: cp.phase,
    });
    ctx.emit(requested);
    waiting = { checkpointId, title, since: requested.ts };
    report(ctx, waiting, true);

    const timedOut = new Promise<"timeout">((resolve) => {
      if (cp.timeoutMs !== null) timer = setTimeout(() => resolve("timeout"), cp.timeoutMs);
    });
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
      const result = answerOf(cp, outcome);
      const { approved, note, by } = result;
      // An edit is on record — JSON-safe, cut to 64 KiB like the question's payload.
      resolved({ approved, note, by, ...(result.edited ? editedFields(result.payload) : {}) });
      return result;
    }
    if (cp.onTimeout === "fail") {
      const message = `checkpoint #${checkpointId} '${title}' got no answer within ${cp.timeout}s`;
      resolved({ approved: false, note: null, by: "timeout", error: message });
      throw new CheckpointTimeout(message, checkpointId, title);
    }
    const approved = cp.onTimeout === "approve";
    resolved({ approved, note: null, by: "timeout" });
    return { approved, note: null, by: "timeout", payload: cp.original, edited: false };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onRunAbort);
    // However the wait ended — a timeout, or an event that could not be
    // written — stop listening for an answer (a no-op once one arrived).
    asked.abort(new Error("the checkpoint is no longer waiting"));
    if (waiting) report(ctx, waiting, false);
  }
}

/**
 * What a person's answer resolves the call to: an approval with an edit the
 * checkpoint took carries the edit — `edited` when it differs from the
 * payload as JSON — and every other answer the payload as given.
 */
function answerOf(cp: Plan, decision: CheckpointDecision): CheckpointResult {
  const { approved, note, by } = decision;
  const edit = approved && decision.payload !== undefined ? checkEdit(decision.payload, cp.schema) : null;
  if (edit?.ok && !sameJson(edit.value, cp.json)) return { approved, note, by, payload: edit.value, edited: true };
  return { approved, note, by, payload: cp.original, edited: false };
}

/** The `checkpoint_resolved` fields of an approval with edits. */
function editedFields(payload: unknown): Record<string, unknown> {
  const shown = eventPayload(payload);
  return { edited: true, payload: shown.payload, ...(shown.truncated ? { truncated: true } : {}) };
}

/** A line in the run's log that must not fail its caller (a decision being weighed on a poll). */
function say(ctx: RunContext, message: string): void {
  try {
    ctx.emit(event(LOG, { message }));
  } catch {
    // The events file is unwritable for a moment: the answer is refused all the same.
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
