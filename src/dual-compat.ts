/**
 * Dual-compat audit: prove a workflow's `meta` is a pure literal.
 *
 * The Claude Code Workflow tool extracts `meta` WITHOUT running the body, so it
 * accepts only a pure literal — no variables, calls, spreads, arithmetic, or
 * template interpolation. odw's loader enforces the same rule (it parses meta,
 * never evaluates it), and this audit reports through that very parser, so "the
 * audit passes" and "odw loads the meta" can never disagree. What the audit adds
 * is a report instead of an exception — found / pure / why not / meta.name — for
 * CI checks such as the meta.name ↔ filename-stem rule.
 *
 * Like the loader, it locates the declaration in a masked copy of the source, so
 * an `export const meta =` inside a comment or a string is never the one read.
 * It is a CI/test check only, not a user command or a runtime interception.
 */

import { MetaLiteralError, readMetaLiteral } from "./loader.js";

/** The result of auditing one workflow's meta. */
export interface MetaCheck {
  /** A `export const meta =` declaration was located. */
  found: boolean;
  /** The meta literal is pure (Claude-Code-portable). */
  pure: boolean;
  /** Why it is not found / not pure; null when pure. */
  reason: string | null;
  /** meta.name when the literal parsed, else null. */
  name: string | null;
}

/** Audit the `meta` literal in a workflow's source. Never executes anything. */
export function checkMeta(source: string): MetaCheck {
  let meta: Record<string, unknown> | null;
  try {
    meta = readMetaLiteral(source);
  } catch (err) {
    if (err instanceof MetaLiteralError) {
      return { found: true, pure: false, reason: err.message, name: null };
    }
    throw err;
  }
  if (meta === null) {
    return { found: false, pure: false, reason: "no `export const meta =` declaration", name: null };
  }
  return { found: true, pure: true, reason: null, name: typeof meta.name === "string" ? meta.name : null };
}

/** The filename stem (basename without extension) used by run-by-name. */
export function workflowStem(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  return base.replace(/\.[^.]*$/, "");
}
