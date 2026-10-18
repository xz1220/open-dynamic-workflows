/**
 * The eval file (an ODW extension): what `odw eval` runs, and how it judges
 * each run — read and validated here, strictly, before any run starts.
 *
 *   {
 *     "name": "review",                 optional; else the file's name without .json
 *     "description": "…",               optional
 *     "workflow": "review",             a name or a path, resolved like `odw run`'s
 *     "adapters": ["claude", "codex"],  optional: each runs the whole case set as the
 *                                       run's default adapter (like `odw run --adapter`);
 *                                       absent: the config's default adapter
 *     "repeats": 3,                     runs of each case per adapter (default 1)
 *     "concurrency": 2,                 runs at once (default 1)
 *     "budget": 200000,                 optional: each run's --budget (tokens)
 *     "timeout": 600,                   optional: seconds a run may take; then it is stopped
 *                                       and fails
 *     "cases": [{ "name": "small-diff", "args": {…}, "checks": [ … ] }]
 *   }
 *
 * A check judges a run on its outcome, with no model involved; each is an
 * object with exactly one of these shapes:
 *
 *   { path, equals }        the result's value at `path` deep-equals `equals`
 *   { path, contains }      a string there contains the string; an array there has an
 *                           element deep-equal to it
 *   { path, matches, flags? }  a string there matches the regex (another value: its JSON)
 *   { path, exists }        `path` leads to a value (null counts) — or, false, it does not
 *   { command, timeout? }   exits 0, run through the shell in the project directory with
 *                           ODW_RESULT (a file holding the result as JSON) and ODW_RUN_ID
 *                           set; killed after `timeout` seconds (default 300)
 *   { state }               the run ended "done", "failed" or "stopped"
 *   { maxCostUsd }          the run cost at most that many dollars (unknown cost fails)
 *   { maxSeconds }          the run took at most that many seconds, start to end
 *
 * `path` is dot/bracket notation into the run's result: `verdict`,
 * `findings[0].file`, `["odd key"].x`, `items.2`; "" is the result itself.
 * A case without checks gets `[{ "state": "done" }]`; a case that lists
 * checks gets exactly those.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { ConfigError } from "../errors.js";
import { stableJson } from "../journal.js";

/** An eval's (and a stored report's) name, and a report id: what a run id may be, never dots only. */
export const EVAL_NAME_RE = /^[A-Za-z0-9._-]+$/;

export function isEvalName(name: unknown): name is string {
  return typeof name === "string" && name.length <= 128 && EVAL_NAME_RE.test(name) && !/^\.+$/.test(name);
}

export const RUN_END_STATES = ["done", "failed", "stopped"] as const;
export type RunEndState = (typeof RUN_END_STATES)[number];

export type EvalCheck =
  | { path: string; equals: unknown }
  | { path: string; contains: unknown }
  | { path: string; matches: string; flags?: string }
  | { path: string; exists: boolean }
  | { command: string; timeout?: number }
  | { state: RunEndState }
  | { maxCostUsd: number }
  | { maxSeconds: number };

export interface EvalCase {
  name: string;
  args: unknown;
  checks: EvalCheck[];
}

export interface EvalDefinition {
  name: string;
  description: string | null;
  workflow: string;
  cases: EvalCase[];
  /** null: the config's default adapter. */
  adapters: string[] | null;
  repeats: number;
  concurrency: number;
  /** Tokens, each run's --budget; null for none. */
  budget: number | null;
  /** Seconds a run may take; null for no limit. */
  timeout: number | null;
}

export const MAX_REPEATS = 1000;
export const MAX_CONCURRENCY = 64;
/** Seconds a `{ command }` check may run unless it says otherwise. */
export const COMMAND_TIMEOUT_SECONDS = 300;

const TOP_KEYS = ["name", "description", "workflow", "cases", "adapters", "repeats", "concurrency", "budget", "timeout"];
const CASE_KEYS = ["name", "args", "checks"];
/** Each check kind: the key that names it, and every key it may have. */
const CHECK_KINDS: Array<{ key: string; keys: string[] }> = [
  { key: "equals", keys: ["path", "equals"] },
  { key: "contains", keys: ["path", "contains"] },
  { key: "matches", keys: ["path", "matches", "flags"] },
  { key: "exists", keys: ["path", "exists"] },
  { key: "command", keys: ["command", "timeout"] },
  { key: "state", keys: ["state"] },
  { key: "maxCostUsd", keys: ["maxCostUsd"] },
  { key: "maxSeconds", keys: ["maxSeconds"] },
];

/**
 * Read and validate an eval file. `name` falls back to the file's name
 * without `.json`. Every problem is a ConfigError naming the file and where
 * in it (`cases[1].checks[0]: …`).
 */
export function loadEvalFile(file: string): EvalDefinition {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    throw new ConfigError(`eval file ${file}: ${e.code === "ENOENT" ? "no such file" : e.message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`eval file ${file}: not valid JSON: ${(err as Error).message}`);
  }
  return parseEvalDefinition(raw, file, basename(file).replace(/\.json$/i, ""));
}

/** Validate an eval definition (parsed JSON); `fallbackName` names it when it has no `name`. */
export function parseEvalDefinition(raw: unknown, file: string, fallbackName: string): EvalDefinition {
  const fail = (where: string, message: string): never => {
    throw new ConfigError(`eval file ${file}: ${where ? `${where}: ` : ""}${message}`);
  };
  if (!isRecord(raw)) fail("", `must be a JSON object; got ${describe(raw)}`);
  const top = raw as Record<string, unknown>;
  unknownKeys(top, TOP_KEYS, "", fail);

  let name = fallbackName;
  if (top.name !== undefined) {
    if (!isEvalName(top.name)) fail("name", `must be up to 128 letters, digits, '.', '_' or '-' (not dots only); got ${describe(top.name)}`);
    name = top.name as string;
  } else if (!isEvalName(name)) {
    fail("", `its file name '${name}' cannot name the eval (letters, digits, '.', '_', '-'): add a "name"`);
  }
  const description = optional(top.description, (v) => typeof v === "string", "description", "a string", fail) as string | undefined;
  if (typeof top.workflow !== "string" || top.workflow.trim() === "") {
    fail("workflow", `must name the workflow to run (a name or a path, as for odw run); got ${describe(top.workflow)}`);
  }

  let adapters: string[] | null = null;
  if (top.adapters !== undefined) adapters = parseAdapterList(top.adapters, (m) => fail("adapters", m));

  const repeats = optionalInt(top.repeats, 1, MAX_REPEATS, "repeats", fail) ?? 1;
  const concurrency = optionalInt(top.concurrency, 1, MAX_CONCURRENCY, "concurrency", fail) ?? 1;
  const budget = optional(top.budget, isPositive, "budget", "a positive number of tokens", fail) as number | undefined;
  const timeout = optional(top.timeout, isPositive, "timeout", "a positive number of seconds", fail) as number | undefined;

  if (!Array.isArray(top.cases) || top.cases.length === 0) {
    fail("cases", `must be a non-empty array of { name, args?, checks? }; got ${describe(top.cases)}`);
  }
  const seen = new Set<string>();
  const cases = (top.cases as unknown[]).map((c, i) => {
    const at = `cases[${i}]`;
    if (!isRecord(c)) fail(at, `must be an object { name, args?, checks? }; got ${describe(c)}`);
    const one = c as Record<string, unknown>;
    unknownKeys(one, CASE_KEYS, at, fail);
    if (typeof one.name !== "string" || one.name.trim() === "" || one.name.length > 100 || /[\u0000-\u001f\u007f]/.test(one.name)) {
      fail(`${at}.name`, `must be a non-empty string of at most 100 characters, without control characters; got ${describe(one.name)}`);
    }
    const caseName = one.name as string;
    if (seen.has(caseName)) fail(`${at}.name`, `'${caseName}' names two cases; each case needs its own name`);
    seen.add(caseName);
    let checks: EvalCheck[] = [{ state: "done" }];
    if (one.checks !== undefined) {
      if (!Array.isArray(one.checks) || one.checks.length === 0) {
        fail(`${at}.checks`, `must be a non-empty array of checks (leave it out for the default, { "state": "done" }); got ${describe(one.checks)}`);
      }
      checks = (one.checks as unknown[]).map((check, j) => parseCheck(check, `${at}.checks[${j}]`, fail));
    }
    return { name: caseName, args: one.args === undefined ? null : one.args, checks };
  });

  return {
    name,
    description: description ?? null,
    workflow: top.workflow as string,
    cases,
    adapters,
    repeats,
    concurrency,
    budget: budget ?? null,
    timeout: timeout ?? null,
  };
}

/** An adapter list (the file's `adapters`, or `--adapter a,b` split): non-empty, unique names. */
export function parseAdapterList(raw: unknown, fail: (message: string) => never): string[] {
  if (!Array.isArray(raw) || raw.length === 0) fail(`must be a non-empty array of adapter names; got ${describe(raw)}`);
  const list = raw as unknown[];
  for (const name of list) {
    if (typeof name !== "string" || name.trim() === "") fail(`must hold adapter names (non-empty strings); got ${describe(name)}`);
  }
  const names = list as string[];
  const twice = names.find((name, i) => names.indexOf(name) !== i);
  if (twice !== undefined) fail(`names '${twice}' twice`);
  return names;
}

function parseCheck(raw: unknown, at: string, fail: (where: string, message: string) => never): EvalCheck {
  const kinds = CHECK_KINDS.map((k) => k.key).join(", ");
  if (!isRecord(raw)) fail(at, `must be a check object (one of ${kinds}); got ${describe(raw)}`);
  const check = raw as Record<string, unknown>;
  const named = CHECK_KINDS.filter((k) => k.key in check);
  if (named.length !== 1) {
    fail(at, named.length === 0
      ? `names no check: give it one of ${kinds}`
      : `names ${named.map((k) => k.key).join(" and ")}: a check is one of them — split it into ${named.length} checks`);
  }
  const kind = named[0]!;
  unknownKeys(check, kind.keys, at, fail);
  if (kind.keys.includes("path")) {
    if (typeof check.path !== "string") fail(`${at}.path`, `must be a dot/bracket path into the result ("" for the whole result); got ${describe(check.path)}`);
    try {
      parsePath(check.path as string);
    } catch (err) {
      fail(`${at}.path`, (err as Error).message);
    }
  }
  switch (kind.key) {
    case "equals":
      return { path: check.path as string, equals: check.equals };
    case "contains":
      return { path: check.path as string, contains: check.contains };
    case "matches": {
      if (typeof check.matches !== "string") fail(`${at}.matches`, `must be a regular expression, as a string; got ${describe(check.matches)}`);
      if (check.flags !== undefined && (typeof check.flags !== "string" || !/^[imsu]*$/.test(check.flags))) {
        fail(`${at}.flags`, `must be regex flags out of i, m, s, u; got ${describe(check.flags)}`);
      }
      try {
        new RegExp(check.matches as string, (check.flags as string | undefined) ?? "");
      } catch (err) {
        fail(`${at}.matches`, `is not a valid regular expression: ${(err as Error).message}`);
      }
      return { path: check.path as string, matches: check.matches as string, ...(check.flags !== undefined ? { flags: check.flags as string } : {}) };
    }
    case "exists":
      if (typeof check.exists !== "boolean") fail(`${at}.exists`, `must be true or false; got ${describe(check.exists)}`);
      return { path: check.path as string, exists: check.exists as boolean };
    case "command": {
      if (typeof check.command !== "string" || check.command.trim() === "") {
        fail(`${at}.command`, `must be a shell command (a non-empty string); got ${describe(check.command)}`);
      }
      const timeout = optional(check.timeout, isPositive, `${at}.timeout`, "a positive number of seconds", fail) as number | undefined;
      return { command: check.command as string, ...(timeout !== undefined ? { timeout } : {}) };
    }
    case "state":
      if (!(RUN_END_STATES as readonly unknown[]).includes(check.state)) {
        fail(`${at}.state`, `must be "done", "failed" or "stopped"; got ${describe(check.state)}`);
      }
      return { state: check.state as RunEndState };
    case "maxCostUsd":
      if (!isNonNegative(check.maxCostUsd)) fail(`${at}.maxCostUsd`, `must be a non-negative number of dollars; got ${describe(check.maxCostUsd)}`);
      return { maxCostUsd: check.maxCostUsd as number };
    default:
      if (!isPositive(check.maxSeconds)) fail(`${at}.maxSeconds`, `must be a positive number of seconds; got ${describe(check.maxSeconds)}`);
      return { maxSeconds: check.maxSeconds as number };
  }
}

/**
 * The definition's fingerprint: the sha256 of its canonical JSON (keys
 * sorted) — the same eval, however its file is laid out, hashes the same.
 */
export function evalHash(def: EvalDefinition): string {
  return createHash("sha256").update(stableJson(def), "utf8").digest("hex");
}

// --- paths -----------------------------------------------------------------------

export type PathSegment = string | number;

/**
 * Parse a dot/bracket path: `a.b`, `a[0]`, `a["x.y"]`, `a['x']`, `[1].b`;
 * "" is no segment at all (the value itself). Throws on anything else.
 */
export function parsePath(path: string): PathSegment[] {
  const out: PathSegment[] = [];
  let i = 0;
  const bad = (why: string): never => {
    throw new Error(`invalid path ${JSON.stringify(path)}: ${why} at character ${i + 1}`);
  };
  while (i < path.length) {
    const ch = path[i]!;
    if (ch === "[") {
      const close = path[i + 1] === '"' || path[i + 1] === "'" ? quotedEnd(path, i + 1) : path.indexOf("]", i);
      if (close === -1) bad("an unclosed '['");
      const inner = path.slice(i + 1, close);
      if (/^\d+$/.test(inner)) out.push(Number(inner));
      else if (inner.startsWith('"')) {
        try {
          out.push(JSON.parse(inner) as string);
        } catch {
          bad("a malformed quoted key");
        }
      } else if (inner.startsWith("'") && inner.endsWith("'") && inner.length >= 2) out.push(inner.slice(1, -1));
      else bad("'[…]' takes an index or a quoted key");
      i = close + 1;
      if (i < path.length && path[i] !== "." && path[i] !== "[") bad("expected '.' or '[' after ']'");
      if (path[i] === ".") {
        i++;
        if (i >= path.length) bad("a path cannot end with '.'");
      }
      continue;
    }
    let end = i;
    while (end < path.length && path[end] !== "." && path[end] !== "[") end++;
    if (end === i) bad("an empty key");
    out.push(path.slice(i, end));
    i = end;
    if (path[i] === ".") {
      i++;
      if (i >= path.length) bad("a path cannot end with '.'");
    }
  }
  return out;
}

/** Where the quoted key starting at `open` ends: the index of its closing `]`, or -1. */
function quotedEnd(path: string, open: number): number {
  const quote = path[open]!;
  for (let j = open + 1; j < path.length; j++) {
    if (path[j] === "\\" && quote === '"') {
      j++;
      continue;
    }
    if (path[j] === quote) return path[j + 1] === "]" ? j + 1 : -1;
  }
  return -1;
}

/** The value at `segments` in `value`: own keys of objects, indexes (or digit keys) of arrays. */
export function lookupPath(value: unknown, segments: PathSegment[]): { found: true; value: unknown } | { found: false } {
  let at = value;
  for (const segment of segments) {
    if (Array.isArray(at)) {
      const index = typeof segment === "number" ? segment : /^\d+$/.test(segment) ? Number(segment) : NaN;
      if (!(index >= 0 && index < at.length)) return { found: false };
      at = at[index];
    } else if (isRecord(at) && typeof segment === "string" && Object.prototype.hasOwnProperty.call(at, segment)) {
      at = at[segment];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: at };
}

// --- helpers ---------------------------------------------------------------------

function unknownKeys(obj: Record<string, unknown>, allowed: string[], at: string, fail: (where: string, message: string) => never): void {
  const extra = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (extra.length > 0) {
    fail(at, `unknown key${extra.length > 1 ? "s" : ""} ${extra.map((k) => `'${k}'`).join(", ")} (allowed: ${allowed.join(", ")})`);
  }
}

function optional(
  value: unknown,
  ok: (v: unknown) => boolean,
  where: string,
  what: string,
  fail: (where: string, message: string) => never,
): unknown {
  if (value === undefined) return undefined;
  if (!ok(value)) fail(where, `must be ${what}; got ${describe(value)}`);
  return value;
}

function optionalInt(value: unknown, min: number, max: number, where: string, fail: (where: string, message: string) => never): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    fail(where, `must be a whole number from ${min} to ${max}; got ${describe(value)}`);
  }
  return value as number;
}

function isPositive(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function isNonNegative(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** A value as an error message quotes it: its JSON, cut short. */
export function describe(v: unknown): string {
  if (v === undefined) return "nothing";
  const text = JSON.stringify(v) ?? String(v);
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}
