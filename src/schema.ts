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
 *
 * {@link auditSchema} finds what in a schema that subset does not check, so a
 * call can say so — or be refused — before it starts rather than leave a
 * constraint silently unchecked; {@link checkedSubset} is the part it does
 * check, what a reply is validated against when it holds more (an ODW
 * extension, see adapters/native-schema.ts). A CLI that enforces the rest
 * natively hands back its own value, which {@link pickStructured} prefers.
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

/** What {@link pickJson} found in a reply. */
export interface JsonPick {
  /** The chosen value; `undefined` when nothing usable (see `problems`). */
  value: unknown;
  /** Empty when `value` satisfies the schema; otherwise what to tell the agent. */
  problems: string[];
}

/**
 * Choose the JSON value a free-text reply means, against a schema — without
 * guessing. Candidates come in tiers, from the most to the least deliberate:
 * the whole reply; ```json-tagged fenced blocks; other fenced blocks; every
 * top-level balanced `{...}` / `[...]` span. The first tier holding any value
 * that validates decides: exactly one distinct valid value is the answer, but
 * two or more (an answer next to an example, a draft next to the final) are
 * ambiguous — the caller asks for exactly one rather than silently keeping the
 * wrong one. When nothing validates, the parsed candidate with the fewest
 * problems is reported, so the retry feedback describes the closest attempt.
 */
export function pickJson(text: string, schema: JsonSchema): JsonPick {
  let closest: { value: unknown; problems: string[] } | undefined;
  for (const tier of candidateTiers(text)) {
    const valid = new Map<string, unknown>();
    for (const candidate of tier) {
      let value: unknown;
      try {
        value = JSON.parse(candidate);
      } catch {
        continue;
      }
      const problems = validate(value, schema);
      if (problems.length === 0) valid.set(JSON.stringify(value), value);
      else if (!closest || problems.length < closest.problems.length) closest = { value, problems };
    }
    if (valid.size === 1) return { value: [...valid.values()][0], problems: [] };
    if (valid.size > 1) {
      return {
        value: undefined,
        problems: [
          `the reply contains ${valid.size} different JSON values that each match the schema — reply with exactly one`,
        ],
      };
    }
  }
  return closest ?? { value: undefined, problems: ["no JSON value found in the reply"] };
}

/**
 * {@link pickJson} for a reply whose CLI also handed over the value itself
 * (natively validated structured output, e.g. Claude Code's
 * `structured_output`; `undefined` when it did not). That value is the most
 * deliberate candidate, so it comes first — a JSON string there is read like a
 * reply — and the reply text is searched only when it does not satisfy the
 * schema. With nothing valid, the problems are the handed-over value's.
 */
export function pickStructured(structured: unknown, text: string, schema: JsonSchema): JsonPick {
  if (structured === undefined) return pickJson(text, schema);
  const problems = validate(structured, schema);
  if (problems.length === 0) return { value: structured, problems };
  const inner = typeof structured === "string" ? pickJson(structured, schema) : undefined;
  if (inner && inner.problems.length === 0) return inner;
  const fromText = pickJson(text, schema);
  if (fromText.problems.length === 0) return fromText;
  return inner && inner.value !== undefined ? inner : { value: structured, problems };
}

/**
 * Best-effort recovery of a JSON value from a free-text agent reply. With a
 * `schema` this is {@link pickJson}'s choice (or its closest candidate when
 * none validates); without one, the most deliberate candidate that parses.
 * `undefined` means nothing parsed at all (or the valid values were ambiguous).
 */
export function extractJson(text: string, schema?: JsonSchema): unknown {
  if (schema) return pickJson(text, schema).value;
  for (const tier of candidateTiers(text)) {
    for (const candidate of tier) {
      try {
        return JSON.parse(candidate);
      } catch {
        /* next */
      }
    }
  }
  return undefined;
}

/** Candidate texts grouped from the most to the least deliberate. */
function candidateTiers(text: string): string[][] {
  const stripped = text.trim();
  const fences = [...fencedBlocks(stripped)];
  return [
    [stripped],
    fences.filter((f) => f.json).map((f) => f.body),
    fences.filter((f) => !f.json).map((f) => f.body),
    [...balancedSpans(stripped)],
  ];
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

// --- what the validator checks -----------------------------------------------

/** Something in a schema {@link validate} would not check, as {@link auditSchema} reports it. */
export interface SchemaIssue {
  /** Where: a JSON Pointer into the schema (`#/properties/status`; `#` is the root). */
  at: string;
  /** What, in a few words: `"oneOf"`, `a type union ["string","null"]`, `unknown keyword "requird"`. */
  what: string;
  /**
   * `"unchecked"`: JSON Schema the validator does not check — a CLI that
   * validates the schema itself may. `"invalid"`: nothing would check it — a
   * malformed keyword, or a key JSON Schema does not have (a typo).
   */
  kind: "unchecked" | "invalid";
}

/**
 * The keywords {@link validate} checks, and the explicit `type` each needs
 * (`null`: none): object and array keywords are checked only under theirs.
 */
const CHECKED_KEYWORDS: Record<string, "object" | "array" | null> = {
  type: null,
  enum: null,
  properties: "object",
  required: "object",
  additionalProperties: "object",
  items: "array",
  minItems: "array",
};

/**
 * Keywords that describe or organize a schema but constrain no value: nothing
 * needs to check them. `format` is one — an annotation by default since JSON
 * Schema 2019-09, and Claude Code accepts it without enforcing it.
 */
const ANNOTATION_KEYWORDS = new Set([
  "format",
  "$schema",
  "$id",
  "$anchor",
  "$dynamicAnchor",
  "$recursiveAnchor",
  "$vocabulary",
  "$comment",
  "$defs",
  "definitions",
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
]);

/** JSON Schema keywords {@link validate} does not check: only a CLI that validates the schema natively enforces them. */
const UNCHECKED_KEYWORDS = new Set([
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "$ref",
  "$dynamicRef",
  "$recursiveRef",
  "const",
  "multipleOf",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "pattern",
  "contentEncoding",
  "contentMediaType",
  "contentSchema",
  "prefixItems",
  "additionalItems",
  "unevaluatedItems",
  "contains",
  "minContains",
  "maxContains",
  "maxItems",
  "uniqueItems",
  "patternProperties",
  "propertyNames",
  "unevaluatedProperties",
  "minProperties",
  "maxProperties",
  "dependentRequired",
  "dependentSchemas",
  "dependencies",
]);

/** Where keywords hold subschemas: one, a list, or a map of them (`items` may also be a list: a tuple). */
const SUBSCHEMAS: Record<string, "one" | "list" | "map"> = {
  properties: "map",
  patternProperties: "map",
  dependentSchemas: "map",
  dependencies: "map",
  $defs: "map",
  definitions: "map",
  allOf: "list",
  anyOf: "list",
  oneOf: "list",
  prefixItems: "list",
  items: "one",
  additionalProperties: "one",
  additionalItems: "one",
  unevaluatedItems: "one",
  unevaluatedProperties: "one",
  contains: "one",
  propertyNames: "one",
  contentSchema: "one",
  not: "one",
  if: "one",
  then: "one",
  else: "one",
};

/**
 * Everything in a schema that {@link validate} would not check (empty: it
 * checks it all). A keyword outside the documented subset — `oneOf`, `$ref`,
 * `const`, `pattern`, `maxItems`, a type union, an object keyword with no
 * `type: "object"` — is `unchecked`: a CLI that validates the schema itself
 * may enforce it. A malformed keyword, or a key that is no JSON Schema keyword
 * at all, is `invalid`. Annotations (`description`, `title`, `default`,
 * `format`, …) constrain nothing and pass.
 */
export function auditSchema(schema: unknown): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  auditNode(schema, "#", issues, false);
  return issues;
}

/**
 * Audit one schema node and what it holds. `quiet`: the node sits inside
 * something already reported unchecked (a `oneOf` branch, a tuple, `$defs`) —
 * removing that removes it, so only what is invalid in it is reported.
 */
function auditNode(node: unknown, at: string, issues: SchemaIssue[], quiet: boolean): void {
  const unchecked = (what: string): void => void (quiet || issues.push({ at, what, kind: "unchecked" }));
  const invalid = (what: string): void => void issues.push({ at, what, kind: "invalid" });
  if (typeof node === "boolean") return unchecked(`a boolean schema (${node})`);
  if (!isRecord(node)) return invalid(`a schema that is ${kindOf(node)}, not an object`);
  const type = typeof node.type === "string" ? node.type : undefined;
  const union = Array.isArray(node.type);
  for (const [key, value] of Object.entries(node)) {
    // A key set to undefined (`minItems: cond ? 2 : undefined`) is absent: JSON drops it.
    if (value === undefined) continue;
    let nested = quiet;
    if (key === "type") {
      auditType(value, unchecked, invalid);
    } else if (Object.hasOwn(CHECKED_KEYWORDS, key)) {
      const shape = checkedShape(key, value);
      const needs = CHECKED_KEYWORDS[key];
      if (shape) invalid(`"${key}" that is not ${shape}`);
      else if (key === "additionalProperties" && isRecord(value)) {
        unchecked(`a schema-valued "additionalProperties"`);
        nested = true;
      } else if (key === "items" && Array.isArray(value)) {
        unchecked(`"items" as a list (a tuple)`);
        nested = true;
      } else if (needs && type === undefined && !union && !(key === "additionalProperties" && value === true)) {
        // Checked only under its own explicit type; under another single type
        // it applies to no value anyway, and a type union is reported itself.
        unchecked(`"${key}" without "type": "${needs}"`);
      }
    } else if (UNCHECKED_KEYWORDS.has(key)) {
      unchecked(`"${key}"`);
      nested = true;
    } else if (ANNOTATION_KEYWORDS.has(key)) {
      nested = true; // `$defs`: reached only through a `$ref`, itself unchecked
    } else {
      const guess = nearestWord(key, [...Object.keys(CHECKED_KEYWORDS), ...ANNOTATION_KEYWORDS, ...UNCHECKED_KEYWORDS]);
      invalid(`unknown keyword "${key}"${guess ? ` (did you mean "${guess}"?)` : ""}`);
      continue; // what an unknown key holds is no schema
    }
    for (const [where, sub] of subschemasOf(key, value)) auditNode(sub, `${at}/${where}`, issues, nested);
  }
}

/** Type names from other languages, for a did-you-mean the edit distance would miss. */
const TYPE_ALIASES: Record<string, string> = {
  int: "integer",
  float: "number",
  double: "number",
  bool: "boolean",
  str: "string",
  dict: "object",
  map: "object",
  list: "array",
};

function auditType(value: unknown, unchecked: (what: string) => void, invalid: (what: string) => void): void {
  const known = Object.keys(CHECKERS);
  if (typeof value === "string") {
    if (known.includes(value)) return;
    const alias = value.toLowerCase();
    const guess = Object.hasOwn(TYPE_ALIASES, alias) ? TYPE_ALIASES[alias] : nearestWord(value, known);
    return invalid(`unknown type "${value}"${guess ? ` (did you mean "${guess}"?)` : ""}`);
  }
  if (Array.isArray(value) && value.length > 0 && value.every((t) => typeof t === "string" && known.includes(t))) {
    return unchecked(`a type union ${JSON.stringify(value)}`);
  }
  invalid(`"type" that is not one of ${known.join(", ")} (or a list of them)`);
}

/** What a checked keyword's value should be, when it is not that; null when it is. */
function checkedShape(key: string, value: unknown): string | null {
  switch (key) {
    case "enum":
      return Array.isArray(value) ? null : "a list";
    case "properties":
      return isRecord(value) ? null : "an object of schemas";
    case "required":
      return Array.isArray(value) && value.every((name) => typeof name === "string") ? null : "a list of property names";
    case "additionalProperties":
      return typeof value === "boolean" || isRecord(value) ? null : "true, false or a schema";
    case "items":
      return typeof value === "boolean" || isRecord(value) || Array.isArray(value) ? null : "a schema or a list of schemas";
    case "minItems":
      return typeof value === "number" && Number.isInteger(value) && value >= 0 ? null : "a whole number of 0 or more";
    default:
      return null;
  }
}

/** The subschemas a keyword holds, each with its JSON Pointer step(s) from the schema holding it. */
function subschemasOf(key: string, value: unknown): Array<[string, unknown]> {
  if (!Object.hasOwn(SUBSCHEMAS, key)) return [];
  const shape = SUBSCHEMAS[key];
  const step = escapePointer(key);
  if (shape === "map") {
    if (!isRecord(value)) return [];
    // `dependencies` may map a property to a list of names: only its schemas are schemas.
    return Object.entries(value)
      .filter(([, sub]) => key !== "dependencies" || !Array.isArray(sub))
      .map(([name, sub]) => [`${step}/${escapePointer(name)}`, sub]);
  }
  if (Array.isArray(value)) return shape === "list" || key === "items" ? value.map((sub, i) => [`${step}/${i}`, sub]) : [];
  // A boolean `additionalProperties` (true, or the checked false) is no subschema.
  if (shape === "one" && (isRecord(value) || (typeof value === "boolean" && key !== "additionalProperties"))) {
    return [[step, value]];
  }
  return [];
}

/**
 * The part of a schema {@link validate} checks: every keyword it does not
 * check dropped, as are a type union and the object/array keywords it would
 * govern, and a boolean subschema becomes `{}`. What ODW validates a reply
 * against when the CLI enforces the whole schema natively.
 */
export function checkedSubset(schema: unknown): JsonSchema {
  if (!isRecord(schema)) return {};
  const out: JsonSchema = {};
  if (typeof schema.type === "string") out.type = schema.type;
  if (Array.isArray(schema.enum)) out.enum = schema.enum;
  if (out.type === "object") {
    if (isRecord(schema.properties)) {
      out.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, sub]) => [key, checkedSubset(sub)]));
    }
    if (Array.isArray(schema.required)) out.required = schema.required;
    if (schema.additionalProperties === false) out.additionalProperties = false;
  }
  if (out.type === "array") {
    if (isRecord(schema.items)) out.items = checkedSubset(schema.items);
    if (typeof schema.minItems === "number") out.minItems = schema.minItems;
  }
  return out;
}

/**
 * Whether a schema is one OpenAI's strict structured outputs accept, as Codex
 * sends its `--output-schema`: an object at the root, and every object closed
 * (`"additionalProperties": false`) with every one of its properties in
 * `required`. Which other keywords strict mode allows is for the CLI to say.
 */
export function isStrictSchema(schema: unknown): boolean {
  return isRecord(schema) && schema.type === "object" && strictNode(schema);
}

function strictNode(node: unknown): boolean {
  if (!isRecord(node)) return true;
  const types = Array.isArray(node.type) ? node.type : [node.type];
  if (types.includes("object") || "properties" in node) {
    const names = isRecord(node.properties) ? Object.keys(node.properties) : [];
    const required = Array.isArray(node.required) ? node.required : [];
    if (node.additionalProperties !== false || !names.every((name) => required.includes(name))) return false;
  }
  return Object.entries(node).every(([key, value]) => subschemasOf(key, value).every(([, sub]) => strictNode(sub)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The kind of a JSON value, for a message: "a string", "a list", "null". */
function kindOf(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return "a list";
  return `a ${typeof value}`;
}

/** One step of a JSON Pointer: `~` and `/` escaped (RFC 6901). */
function escapePointer(step: string): string {
  return step.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** The closest of `words` within an edit distance of 2 (case-insensitive), for a did-you-mean; null when none is. */
function nearestWord(word: string, words: Iterable<string>): string | null {
  const lower = word.toLowerCase();
  let best: string | null = null;
  let bestDistance = 3;
  for (const candidate of words) {
    const distance = editDistance(lower, candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length]!;
}
