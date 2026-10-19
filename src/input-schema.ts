/**
 * `meta.input` (an ODW extension; Claude Code ignores it): the shape of a
 * workflow's `args`, as a JSON Schema in the subset `agent()`'s `schema` is
 * checked with (./schema — `type`, `enum`, `properties`, `required`,
 * `additionalProperties: false`, `items`, `minItems`; annotations such as
 * `description` and `default` are shown, never applied).
 *
 *   export const meta = {
 *     name: "triage",
 *     description: "…",
 *     input: {
 *       type: "object",
 *       properties: { repos: { type: "array", items: { type: "string" }, description: "owner/name" } },
 *       required: ["repos"],
 *     },
 *   };
 *
 * {@link inputSchemaProblems} is what the loader refuses in it: a keyword the
 * validator would not check is refused too, so a declared constraint is never
 * silently skipped. {@link checkInput} checks a run's args against it before
 * the run exists (`odw run`, `rerun`, `resume`, a schedule, a trigger): a
 * mismatch is an {@link InputSchemaError} naming each path — and an array or
 * object that arrived as a string of JSON is said to look encoded twice
 * (anthropics/claude-code#69206), never decoded behind the author's back.
 * {@link describeInput} is what `odw run <wf> --help` prints.
 */

import { ConfigError } from "./errors.js";
import { auditSchema, validate, type JsonSchema } from "./schema.js";

/** A run's args do not match its workflow's `meta.input`: refused before the run is created. */
export class InputSchemaError extends ConfigError {
  constructor(
    message: string,
    /** Each mismatch, one line: `$.repos: expected array, got string — …`. */
    readonly problems: string[],
  ) {
    super(message);
  }
}

/** What in a `meta.input` the loader refuses, one line each; empty: it is checked in full. */
export function inputSchemaProblems(schema: unknown): string[] {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return [`meta.input must be a JSON Schema object, like { type: "object", properties: { … } }`];
  }
  return auditSchema(schema).map((issue) =>
    issue.kind === "invalid"
      ? `meta.input ${issue.at}: ${issue.what}`
      : `meta.input ${issue.at}: ${issue.what} is not checked — meta.input takes the subset agent() schemas are checked with ` +
        `(type, enum, properties, required, additionalProperties: false, items, minItems); remove it or check it in the script`,
  );
}

/**
 * Check `args` against a workflow's `meta.input` (nothing to do without one);
 * throws an {@link InputSchemaError} listing every mismatch. `workflow`: how
 * the user named it, for the hint (`odw run <workflow> --help`).
 */
export function checkInput(input: JsonSchema | undefined, args: unknown, workflow: string): void {
  if (input === undefined) return;
  const problems = inputProblems(input, args);
  if (problems.length === 0) return;
  throw new InputSchemaError(
    `${workflow}: its args do not match its meta.input:\n` +
      problems.map((p) => `  ${p}`).join("\n") +
      `\n  odw run ${workflow} --help lists what it takes`,
    problems,
  );
}

/** Each way `args` misses `input`, one line, with the double-encoding hint where it applies; empty when it matches. */
export function inputProblems(input: JsonSchema, args: unknown): string[] {
  const value = args === undefined ? null : args;
  const encoded = new Map(doublyEncoded(value, input, "$").map((hit) => [hit.path, hit.kind]));
  return validate(value, input).map((problem) => {
    const path = problem.slice(0, problem.indexOf(": "));
    const kind = encoded.get(path);
    if (kind && problem.endsWith("got string")) {
      return `${problem} — it looks encoded twice: the string holds JSON (${kind === "array" ? "an array" : "an object"}); pass the ${kind} itself, not a string of it`;
    }
    if (path === "$" && value === null && problem.endsWith("got null")) return `${problem} (no --args given?)`;
    return problem;
  });
}

/** Where `value` holds a string of JSON whose schema wants the array or object that string encodes. */
function doublyEncoded(value: unknown, schema: JsonSchema, path: string): Array<{ path: string; kind: "array" | "object" }> {
  const type = schema.type;
  if (type !== "array" && type !== "object") return [];
  if (typeof value === "string") {
    const head = value.trimStart()[0];
    if (head !== "[" && head !== "{") return [];
    try {
      const inner: unknown = JSON.parse(value);
      const kind = Array.isArray(inner) ? "array" : inner !== null && typeof inner === "object" ? "object" : null;
      return kind === type ? [{ path, kind }] : [];
    } catch {
      return [];
    }
  }
  if (type === "array" && Array.isArray(value)) {
    const items = schema.items;
    if (!isSchema(items)) return [];
    return value.flatMap((el, i) => doublyEncoded(el, items, `${path}[${i}]`));
  }
  if (type === "object" && value !== null && typeof value === "object" && !Array.isArray(value)) {
    const properties = isSchema(schema.properties) ? (schema.properties as Record<string, unknown>) : {};
    return Object.entries(properties).flatMap(([key, sub]) =>
      isSchema(sub) && key in value ? doublyEncoded((value as Record<string, unknown>)[key], sub, `${path}.${key}`) : [],
    );
  }
  return [];
}

/**
 * `meta.input` as `odw run <wf> --help` prints it: one line per value, an
 * object's properties indented under it — its type, whether it is required,
 * its choices, default and description.
 */
export function describeInput(input: JsonSchema): string[] {
  const out: string[] = [];
  describeNode(input, "args", true, 0, out);
  return out;
}

function describeNode(schema: JsonSchema, name: string, required: boolean, depth: number, out: string[]): void {
  const parts = [`${"  ".repeat(depth)}${name}`, typeText(schema)];
  if (depth > 0 && required) parts.push("(required)");
  if (Array.isArray(schema.enum)) parts.push(`one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`);
  if (typeof schema.minItems === "number") parts.push(`at least ${schema.minItems}`);
  if (schema.default !== undefined) parts.push(`default ${JSON.stringify(schema.default)}`);
  const line = parts.join("  ");
  out.push(typeof schema.description === "string" && schema.description !== "" ? `${line}  — ${schema.description}` : line);
  const nested = schema.type === "array" && isSchema(schema.items) ? (schema.items as JsonSchema) : schema;
  if (nested.type !== "object" || !isSchema(nested.properties)) return;
  const requiredNames = Array.isArray(nested.required) ? (nested.required as string[]) : [];
  for (const [key, sub] of Object.entries(nested.properties as Record<string, unknown>)) {
    if (isSchema(sub)) describeNode(sub as JsonSchema, key, requiredNames.includes(key), depth + 1, out);
  }
  if (nested.additionalProperties === false) out.push(`${"  ".repeat(depth + 1)}(no other properties)`);
}

function typeText(schema: JsonSchema): string {
  if (schema.type === "array") {
    const items = isSchema(schema.items) ? (schema.items as JsonSchema) : null;
    return items && typeof items.type === "string" ? `array of ${items.type}` : "array";
  }
  return typeof schema.type === "string" ? schema.type : "any";
}

function isSchema(value: unknown): value is JsonSchema {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
