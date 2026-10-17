/**
 * Native structured output (an ODW extension): how one agent call's JSON
 * Schema reaches its CLI, decided before the CLI starts.
 *
 * Every schema is audited first (schema.ts `auditSchema`). A malformed one —
 * a typo, a keyword JSON Schema does not have — fails the call with an
 * AgentError. JSON Schema ODW's validator does not check (`oneOf`, `$ref`,
 * `const`, …) is never left silently unchecked, as `schemaKeywords` says:
 * `"warn"` (the default) — the call runs, ODW validates the part it checks
 * (`checkedSubset`), and the run logs once which keywords it does not check,
 * where, and who enforces them (the CLI when it got the schema natively,
 * otherwise nobody); `"strict"` — the call fails with an AgentError naming
 * each one.
 *
 * A CLI that validates schemas itself declares how it takes one
 * (`flags.schema`): ODW passes it the whole schema — inline as one argv
 * element, or as the path of a file written for the CLI run and removed after
 * it — and still validates every reply itself. The prompt describes the
 * schema only to a CLI that does not take it (`schemaPrompt: "always"`: to
 * every CLI). A CLI that takes only strict schemas (`flags.schema.strict`:
 * Codex sends `--output-schema` in OpenAI's strict mode) is handed one only
 * when it is strict; any other goes in the prompt, as on a CLI without native
 * support, and the run says so once.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { auditSchema, checkedSubset, isStrictSchema, type JsonSchema, type SchemaIssue } from "../schema.js";
import type { Adapter, SchemaFlag, Settings } from "./types.js";

/** How one call's schema reaches its CLI, as decided by {@link planSchema}. */
export interface SchemaPlan {
  /** How the CLI takes the schema natively; null when it goes in the prompt only. */
  native: SchemaFlag | null;
  /** What ODW validates each reply against: the schema, or — keywords left to the CLI — the part ODW checks. */
  check: JsonSchema;
  /** Whether the prompt describes the schema. */
  describe: boolean;
  /** Said once per run: the schema went in the prompt after all, or keywords are left to the CLI. */
  note?: string;
  /** Why the call cannot run: it fails before its CLI starts. */
  error?: string;
}

/** What a strict schema is, as an error or a note says it. */
const STRICT_RULES = 'an object at the root, and every object "additionalProperties": false with all its properties "required"';

/** How many issues an error or a note lists before "and N more". */
const LISTED_ISSUES = 8;

/**
 * Decide how `schema` reaches `adapter`'s CLI: refused (`error`), handed over
 * natively (`native`), or described in the prompt — and what ODW validates
 * the reply against either way.
 */
export function planSchema(
  adapter: Adapter,
  schema: unknown,
  settings: Pick<Settings, "schemaKeywords" | "schemaPrompt">,
): SchemaPlan {
  const refuse = (error: string): SchemaPlan => ({ native: null, check: {}, describe: false, error });
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return refuse(`agent() option schema must be a JSON Schema object; got ${kindOf(schema)}`);
  }
  const issues = auditSchema(schema);
  const invalid = issues.filter((issue) => issue.kind === "invalid");
  if (invalid.length > 0) {
    return refuse(`agent() schema is not JSON Schema ODW can check: ${listIssues(invalid)} — fix ${pronoun(invalid)}`);
  }
  const flag = adapter.flags?.schema;
  const unstrict = flag?.strict === true && !isStrictSchema(schema);
  const native = flag && !unstrict ? flag : null;
  const describe = !native || settings.schemaPrompt === "always";
  const unchecked = issues.filter((issue) => issue.kind === "unchecked");
  if (unchecked.length === 0) {
    const plan: SchemaPlan = { native, check: schema as JsonSchema, describe };
    if (unstrict) {
      plan.note =
        `adapter '${adapter.name}' takes only strict schemas natively (${STRICT_RULES}): ` +
        `this schema goes in the prompt, and ODW alone checks the reply`;
    }
    return plan;
  }
  if (settings.schemaKeywords === "strict") return refuse(uncheckedError(adapter, unchecked, flag, unstrict));
  // "warn": the call runs, ODW checks what it can, and the run says what it does not.
  return { native, check: checkedSubset(schema), describe, note: uncheckedNote(adapter, unchecked, flag, unstrict) };
}

/** Why a schema with keywords ODW does not check cannot run under "strict", and what would let it. */
function uncheckedError(adapter: Adapter, unchecked: SchemaIssue[], flag: SchemaFlag | undefined, unstrict: boolean): string {
  const it = pronoun(unchecked);
  const remove = `remove ${it} (a "description" can still ask the agent for ${it})`;
  let how: string;
  if (!flag) {
    how =
      `adapter '${adapter.name}' does not validate schemas itself, so nothing would enforce ${it}: ${remove}, ` +
      `or run this agent on an adapter that does (one with "flags.schema", like the built-in claude) and set "schemaKeywords": "warn"`;
  } else if (unstrict) {
    how =
      `adapter '${adapter.name}' validates only strict schemas itself (${STRICT_RULES}), and this one is not: ` +
      `${remove}, or make the schema strict and set "schemaKeywords": "warn"`;
  } else {
    how = `${remove}, or set "schemaKeywords": "warn" to leave ${it} to adapter '${adapter.name}', which validates the schema itself`;
  }
  return (
    `agent() schema uses JSON Schema that ODW's validator does not check ("schemaKeywords": "strict"): ` +
    `${listIssues(unchecked)} — ${how}`
  );
}

/**
 * What the run logs, once, about keywords ODW does not check in a call it lets
 * run: who enforces them — the CLI when it got the schema natively, otherwise
 * nobody — and how to make them count.
 */
function uncheckedNote(adapter: Adapter, unchecked: SchemaIssue[], flag: SchemaFlag | undefined, unstrict: boolean): string {
  const listed = listIssues(unchecked);
  if (flag && !unstrict) {
    return (
      `schema keywords ODW does not check are left to adapter '${adapter.name}', which validates the schema itself: ` +
      `${listed} — ODW checks the rest; "schemaKeywords": "strict" refuses such calls`
    );
  }
  const why = flag
    ? `adapter '${adapter.name}' validates only strict schemas itself (${STRICT_RULES}), and this one is not`
    : `adapter '${adapter.name}' does not validate schemas itself`;
  // An adapter that validates schemas is handed this one whole.
  const count = flag
    ? `make the schema strict so adapter '${adapter.name}' takes it natively`
    : `run the agent on an adapter that validates schemas itself (one with "flags.schema", like the built-in claude)`;
  return (
    `schema keywords ODW does not check, and nothing else will (${why}): ${listed} — ODW checks the rest; ` +
    `to make them count, ${count}, or set "schemaKeywords": "strict" to refuse such calls`
  );
}

/** The argv that hands a CLI its schema, and what removes what was written for it. */
export interface NativeSchemaArgs {
  args: string[];
  cleanup(): Promise<void>;
}

/**
 * The argv for a schema a CLI takes natively: `flag.args`, then the schema's
 * JSON (`inline`) or the path of a file holding it (`file`) — at `file` when
 * given (the run directory's `agents/<agentId>.schema.json`), else in a fresh
 * temp directory. `cleanup` removes what was written.
 */
export async function nativeSchemaArgs(flag: SchemaFlag, schema: JsonSchema, file?: string): Promise<NativeSchemaArgs> {
  if (flag.mode === "inline") return { args: [...flag.args, JSON.stringify(schema)], cleanup: async () => {} };
  const dir = file ? null : await mkdtemp(join(tmpdir(), "odw-schema-"));
  const path = file ? resolve(file) : join(dir!, "schema.json");
  const cleanup = (): Promise<void> => rm(dir ?? path, { recursive: true, force: true });
  try {
    if (!dir) await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(schema, null, 2)}\n`, "utf8");
  } catch (err) {
    await cleanup();
    throw err;
  }
  return { args: [...flag.args, path], cleanup };
}

/** `"oneOf" at #/properties/status; …`, the first few, then how many more. */
function listIssues(issues: SchemaIssue[]): string {
  const listed = issues.slice(0, LISTED_ISSUES).map((issue) => `${issue.what} at ${issue.at}`);
  const more = issues.length - listed.length;
  return listed.join("; ") + (more > 0 ? `; and ${more} more` : "");
}

const pronoun = (issues: SchemaIssue[]): string => (issues.length === 1 ? "it" : "them");

/** The kind of a value, for an error that names what it got. */
function kindOf(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return "a list";
  return `a ${typeof value}`;
}
