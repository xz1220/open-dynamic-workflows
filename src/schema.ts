/**
 * Structured-output contract (L4-B): describe, extract, validate.
 *
 * Heterogeneous agent CLIs cannot be *forced* to emit a tool call the way a
 * native API can, so reliability is built from three cooperating pieces:
 *
 *   1. {@link describeSchema} turns a schema into an instruction appended to the
 *      prompt ("return only JSON shaped like this").
 *   2. {@link extractJson} pulls the most likely JSON value out of a free-text
 *      reply (the whole reply, fenced blocks, then balanced spans), preferring
 *      the first candidate that actually satisfies the schema.
 *   3. {@link validate} checks the parsed value against the schema, returning a
 *      list of human-readable problems (empty == valid).
 *
 * The bridge drives the retry loop around these. The schema language is a small,
 * dependency-free subset of JSON Schema; workflow scripts usually write the
 * objects by hand (the Claude dialect), but the constructors below are offered
 * as optional sugar.
 */

export type JsonSchema = Record<string, unknown>;

// --- author-facing constructors (optional sugar) -----------------------------

export function obj(properties: Record<string, JsonSchema>, required?: string[]): JsonSchema {
  return { type: "object", properties, required: required ?? Object.keys(properties) };
}

export function array(items: JsonSchema, minItems?: number): JsonSchema {
  return minItems === undefined ? { type: "array", items } : { type: "array", items, minItems };
}

export const string = (): JsonSchema => ({ type: "string" });
export const number = (): JsonSchema => ({ type: "number" });
export const integer = (): JsonSchema => ({ type: "integer" });
export const boolean = (): JsonSchema => ({ type: "boolean" });
export const enumOf = (...values: unknown[]): JsonSchema => ({ enum: values });

// --- prompt side -------------------------------------------------------------

/** Instruction text telling an agent to reply with matching JSON only. */
export function describeSchema(schema: JsonSchema): string {
  const pretty = JSON.stringify(schema, null, 2);
  return (
    "Respond with a single JSON value and nothing else — no prose, no code " +
    "fence, no explanation. It must conform to this JSON Schema:\n" +
    pretty
  );
}

// --- extraction --------------------------------------------------------------

/**
 * Best-effort recovery of a JSON value from a free-text agent reply.
 *
 * Candidates are tried from the most to the least deliberate: the whole reply,
 * then fenced blocks (```json-tagged before untagged, later before earlier —
 * an example tends to precede the answer), then every top-level balanced
 * `{...}` / `[...]` span (later first). With a `schema`, the first candidate
 * that parses AND validates wins, so an inline `{config}` mention or an
 * example block cannot mask the real answer; when none validates, the first
 * that parses is returned so the caller can report what is wrong with it.
 * Without a schema the first candidate that parses wins. `undefined` means
 * nothing parsed at all.
 */
export function extractJson(text: string, schema?: JsonSchema): unknown {
  let fallback: { value: unknown } | undefined;
  for (const candidate of candidates(text)) {
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!schema || validate(value, schema).length === 0) return value;
    fallback ??= { value };
  }
  return fallback?.value;
}

function* candidates(text: string): Generator<string> {
  const stripped = text.trim();
  yield stripped;
  const fences = [...fencedBlocks(stripped)].reverse();
  for (const fence of fences) if (fence.json) yield fence.body;
  for (const fence of fences) if (!fence.json) yield fence.body;
  yield* [...balancedSpans(stripped)].reverse();
}

/** Each ``` fenced block in order, flagged when its info string names JSON. */
function* fencedBlocks(text: string): Generator<{ body: string; json: boolean }> {
  let from = 0;
  for (;;) {
    const fence = text.indexOf("```", from);
    if (fence === -1) return;
    const newline = text.indexOf("\n", fence + 3);
    if (newline === -1) return;
    const json = text.slice(fence + 3, newline).trim().toLowerCase().startsWith("json");
    const close = text.indexOf("```", newline + 1);
    if (close === -1) {
      yield { body: text.slice(newline + 1), json };
      return;
    }
    yield { body: text.slice(newline + 1, close), json };
    from = close + 3;
  }
}

/**
 * An opener that never closes costs a scan to the end of the text; give up
 * after this many so a pathological reply stays cheap. Closed spans are
 * disjoint, so scanning them is linear overall.
 */
const MAX_UNCLOSED_OPENERS = 8;

/** Every top-level balanced {...} or [...] span, in order. */
function* balancedSpans(text: string): Generator<string> {
  const opener = /[{[]/g;
  let unclosed = 0;
  for (let match = opener.exec(text); match; match = opener.exec(text)) {
    const end = matchingClose(text, match.index);
    if (end === -1) {
      if (++unclosed >= MAX_UNCLOSED_OPENERS) return;
      continue; // resume right after this opener
    }
    yield text.slice(match.index, end + 1);
    opener.lastIndex = end + 1; // spans nested inside this one are not top-level
  }
}

/** Index of the bracket closing the one at `start`, ignoring brackets in strings; -1 if none. */
function matchingClose(text: string, start: number): number {
  const open = text[start]!;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// --- validation --------------------------------------------------------------

type Checker = (value: unknown, schema: JsonSchema, path: string) => string[];

/** Return a list of validation problems; empty means the value is valid. */
export function validate(value: unknown, schema: JsonSchema, path = "$"): string[] {
  const errors: string[] = [];
  // `enum` and `type` are independent JSON-Schema constraints; check both.
  if ("enum" in schema) {
    const choices = schema.enum as unknown[];
    if (!choices.some((choice) => deepEqual(choice, value))) {
      errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(choices)}`);
    }
  }
  const expected = schema.type;
  if (expected !== undefined) {
    const checker = CHECKERS[expected as string];
    if (!checker) errors.push(`${path}: unknown schema type ${JSON.stringify(expected)}`);
    else errors.push(...checker(value, schema, path));
  }
  return errors;
}

/** Structural equality over the JSON value space (for `enum` membership). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  const ak = Object.keys(a as Record<string, unknown>);
  const bk = Object.keys(b as Record<string, unknown>);
  if (ak.length !== bk.length) return false;
  return ak.every(
    (k) =>
      Object.prototype.hasOwnProperty.call(b, k) &&
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

const checkObject: Checker = (value, schema, path) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [`${path}: expected object, got ${typeName(value)}`];
  }
  const record = value as Record<string, unknown>;
  const properties = (schema.properties as Record<string, JsonSchema>) ?? {};
  const errors: string[] = [];
  for (const key of (schema.required as string[]) ?? []) {
    if (!(key in record)) errors.push(`${path}.${key}: required property is missing`);
  }
  for (const [key, sub] of Object.entries(properties)) {
    if (key in record) errors.push(...validate(record[key], sub, `${path}.${key}`));
  }
  if (schema.additionalProperties === false) {
    const extra = Object.keys(record).filter((k) => !(k in properties)).sort();
    if (extra.length) errors.push(`${path}: unexpected properties ${JSON.stringify(extra)}`);
  }
  return errors;
};

const checkArray: Checker = (value, schema, path) => {
  if (!Array.isArray(value)) return [`${path}: expected array, got ${typeName(value)}`];
  const errors: string[] = [];
  const minItems = schema.minItems as number | undefined;
  if (minItems !== undefined && value.length < minItems) {
    errors.push(`${path}: expected at least ${minItems} items, got ${value.length}`);
  }
  const items = schema.items as JsonSchema | undefined;
  if (items) value.forEach((el, i) => errors.push(...validate(el, items, `${path}[${i}]`)));
  return errors;
};

const checkString: Checker = (value, _s, path) =>
  typeof value === "string" ? [] : [`${path}: expected string, got ${typeName(value)}`];
const checkInteger: Checker = (value, _s, path) =>
  typeof value === "number" && Number.isInteger(value) ? [] : [`${path}: expected integer, got ${typeName(value)}`];
const checkNumber: Checker = (value, _s, path) =>
  typeof value === "number" && Number.isFinite(value) ? [] : [`${path}: expected number, got ${typeName(value)}`];
const checkBoolean: Checker = (value, _s, path) =>
  typeof value === "boolean" ? [] : [`${path}: expected boolean, got ${typeName(value)}`];
const checkNull: Checker = (value, _s, path) =>
  value === null ? [] : [`${path}: expected null, got ${typeName(value)}`];

const CHECKERS: Record<string, Checker> = {
  object: checkObject,
  array: checkArray,
  string: checkString,
  integer: checkInteger,
  number: checkNumber,
  boolean: checkBoolean,
  null: checkNull,
};

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const t = typeof value;
  if (t === "number") return Number.isInteger(value as number) ? "integer" : "number";
  if (t === "object") return "object";
  return t; // string | boolean | etc.
}
