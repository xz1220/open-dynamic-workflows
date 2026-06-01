/**
 * Structured-output contract (L4-B) — STUB (M3).
 *
 * Heterogeneous agent CLIs cannot be *forced* to emit a tool call the way a
 * native API can, so reliability is built from three cooperating pieces, ported
 * from the reference implementation:
 *
 *   1. {@link describeSchema} turns a JSON Schema into an instruction appended
 *      to the prompt ("return only JSON shaped like this").
 *   2. {@link extractJson} pulls the most likely JSON value out of a free-text
 *      reply (fenced block, then a balanced span, then the whole reply).
 *   3. {@link validate} checks the parsed value against the schema, returning a
 *      list of human-readable problems (empty == valid).
 *
 * The bridge drives the retry loop around these. Workflow scripts pass a raw
 * JSON Schema object (the Claude Code convention), e.g. `{ type: 'object', ... }`.
 */

import { notImplemented } from "./errors.js";

export type JsonSchema = Record<string, unknown>;

export function describeSchema(_schema: JsonSchema): string {
  throw notImplemented("schema describe (M3)");
}

export function extractJson(_text: string): unknown {
  throw notImplemented("schema extract (M3)");
}

/** Return a list of validation problems; empty means the value is valid. */
export function validate(_value: unknown, _schema: JsonSchema, _path = "$"): string[] {
  throw notImplemented("schema validate (M3)");
}
