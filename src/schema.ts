/**
 * Structured-output contract (L4-B): describe, extract, validate.
 *
 * Heterogeneous agent CLIs cannot be *forced* to emit a tool call the way a
 * native API can, so reliability is built from three cooperating pieces:
 *
 *   1. {@link describeSchema} turns a schema into an instruction appended to the
 *      prompt ("return only JSON shaped like this").
 *   2. {@link extractJson} pulls the most likely JSON value out of a free-text
 *      reply (fenced block, then a balanced span, then the whole reply).
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

/** Best-effort recovery of a JSON value from a free-text agent reply. */
export function extractJson(text: string): unknown {
  for (const candidate of candidates(text)) {
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }
  return undefined;
}

function* candidates(text: string): Generator<string> {
  const stripped = text.trim();
  // Try every fenced block (not just the first) so an inline ``` in prose
  // ahead of the real answer doesn't mask it.
  yield* fencedBlocks(stripped);
  const span = balancedSpan(stripped);
  if (span !== null) yield span;
  yield stripped;
}

/** Contents of each ```json (or bare ```) fenced block, in order. */
function* fencedBlocks(text: string): Generator<string> {
  let from = 0;
  for (;;) {
    const fence = text.indexOf("```", from);
    if (fence === -1) return;
    const after = text.slice(fence + 3);
    const newline = after.indexOf("\n");
    if (newline === -1) return;
    const body = after.slice(newline + 1);
    const close = body.indexOf("```");
    if (close === -1) {
      yield body;
      return;
    }
    yield body.slice(0, close);
    from = fence + 3 + newline + 1 + close + 3;
  }
}

/** The first balanced {...} or [...] span, ignoring braces inside strings. */
function balancedSpan(text: string): string | null {
  const start = firstOf(text, "{[");
  if (start === -1) return null;
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
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function firstOf(text: string, chars: string): number {
  const positions = [...chars].map((c) => text.indexOf(c)).filter((p) => p !== -1);
  return positions.length ? Math.min(...positions) : -1;
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
