/**
 * The workflow test file (an ODW extension): what `odw test` runs — a
 * workflow, and cases that each give it an input, script every agent's reply
 * and say what must come out. Read and validated here, strictly, before
 * anything runs. It lives at `.odw/tests/<workflow>.json` by default.
 *
 *   {
 *     "workflow": "review-swarm",        optional: a name or a path, resolved like `odw run`'s;
 *                                        absent: the file's name without .json
 *     "description": "…",                optional
 *     "default": { "dry": true },        optional: the reply of an agent no entry scripts
 *     "cases": [{
 *       "name": "one real finding",
 *       "args": { … },                   the workflow's input (absent: none)
 *       "replies": [ … ],                reply entries, below
 *       "default": { "reply": "ok" },    optional: this case's own default
 *       "expect": { … },                 what must come out, below (absent: { "state": "done" })
 *       "checkpoints": "approve",        optional: answer every checkpoint() so ("approve" | "reject");
 *                                        absent: a checkpoint waits, and the case runs into its timeout
 *       "timeout": 60                    optional: seconds the run may take (default 120); then it is stopped
 *     }]
 *   }
 *
 * A reply entry scripts the agents it matches — every matcher it gives must
 * hold, and the first entry that matches answers:
 *
 *   label    a glob (`*`, `?`) on the agent's label: "verify:*"
 *   phase    a glob on the agent's phase (an agent with none matches no phase)
 *   prompt   a substring of the agent's prompt
 *   adapter  a glob on the adapter it runs on (after a fallback: the next one)
 *
 * and answers with exactly one of:
 *
 *   reply    the reply: a string as is, any other value as its JSON (a schema call's value)
 *   fail     the CLI fails: "rate_limit" | "quota" | "auth" | "model_unavailable" | "permission" | "timeout" |
 *            "stalled" | "not_found" | "exit", read by ODW's failure classes as a real one
 *   empty    true: an empty reply (an `empty_reply` failure, unless the call allows one)
 *   dry      true: what `odw run --dry` answers — a schema's smallest valid value, else "(dry run)"
 *
 * modified by any of:
 *
 *   schemaMiss  N: the first N attempts reply with something no schema accepts, then the
 *               reply — to exercise schema retries (reply and dry only)
 *   delayMs     answer that many milliseconds late
 *   once        true: the entry answers one agent (all its attempts), then is used up —
 *               agents sharing a label get their replies in turn
 *
 * An agent no entry matches, with no `default`, fails its CLI — and the case:
 * "unscripted agent `label`". `default` is an entry without matchers.
 *
 * `expect`:
 *
 *   state    "done" (the default) | "failed" | "stopped": how the run must end
 *   error    a substring of the run's error (it failed)
 *   checks   checks in `odw eval`'s vocabulary (see ../eval/definition): { path, equals },
 *            { path, contains }, { path, matches }, { path, exists }, { command }, { state },
 *            { maxCostUsd } (a test costs $0), { maxSeconds }
 *   agents   { count, labels }: how many agents started; exactly these labels, any order
 *   logs     substrings of log() lines that must appear, in this order (others may come between)
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { ConfigError } from "../errors.js";
import { describe, isEvalName, parseCheck, RUN_END_STATES, type EvalCheck, type RunEndState } from "../eval/definition.js";
import { FAIL_KINDS, type FailKind } from "./mock.js";

/** One scripted reply: its matchers (none for a default), what it answers, and how. */
export interface ReplyEntry {
  label?: string;
  phase?: string;
  prompt?: string;
  adapter?: string;
  reply?: unknown;
  fail?: FailKind;
  empty?: true;
  dry?: true;
  schemaMiss?: number;
  delayMs?: number;
  once?: true;
}

export interface TestExpect {
  state: RunEndState;
  error: string | null;
  checks: EvalCheck[];
  agents: { count?: number; labels?: string[] } | null;
  logs: string[] | null;
}

export interface TestCase {
  name: string;
  /** Absent args are null, as `odw run` without --args gives. */
  args: unknown;
  replies: ReplyEntry[];
  /** The case's default, else the file's; null: unscripted agents fail. */
  default: ReplyEntry | null;
  expect: TestExpect;
  checkpoints: "approve" | "reject" | null;
  /** Seconds. */
  timeout: number;
}

export interface TestFile {
  file: string;
  workflow: string;
  description: string | null;
  cases: TestCase[];
}

/** Seconds a case's run may take unless it says otherwise. */
export const DEFAULT_CASE_TIMEOUT = 120;

const TOP_KEYS = ["workflow", "description", "default", "cases"];
const CASE_KEYS = ["name", "args", "replies", "default", "expect", "checkpoints", "timeout"];
const MATCHERS = ["label", "phase", "prompt", "adapter"] as const;
const KINDS = ["reply", "fail", "empty", "dry"] as const;
const MODIFIERS = ["schemaMiss", "delayMs", "once"] as const;
const EXPECT_KEYS = ["state", "error", "checks", "agents", "logs"];

type Fail = (where: string, message: string) => never;

/** Read and validate a test file; every problem is a ConfigError naming the file and where in it. */
export function loadTestFile(file: string): TestFile {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    throw new ConfigError(`test file ${file}: ${e.code === "ENOENT" ? "no such file" : e.message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`test file ${file}: not valid JSON: ${(err as Error).message}`);
  }
  return parseTestFile(raw, file);
}

/** Validate a test file's parsed JSON. */
export function parseTestFile(raw: unknown, file: string): TestFile {
  const fail: Fail = (where, message) => {
    throw new ConfigError(`test file ${file}: ${where ? `${where}: ` : ""}${message}`);
  };
  if (!isRecord(raw)) fail("", `must be a JSON object { workflow?, cases }; got ${describe(raw)}`);
  const top = raw as Record<string, unknown>;
  unknownKeys(top, TOP_KEYS, "", fail);
  let workflow = basename(file).replace(/\.json$/i, "");
  if (top.workflow !== undefined) {
    if (typeof top.workflow !== "string" || top.workflow.trim() === "") fail("workflow", `must name the workflow (a name or a path); got ${describe(top.workflow)}`);
    workflow = top.workflow as string;
  } else if (!isEvalName(workflow)) {
    fail("", `its file name cannot name the workflow: add a "workflow"`);
  }
  if (top.description !== undefined && typeof top.description !== "string") fail("description", `must be a string; got ${describe(top.description)}`);
  const fileDefault = top.default === undefined ? null : parseEntry(top.default, "default", fail, true);
  if (!Array.isArray(top.cases) || top.cases.length === 0) fail("cases", `must be a non-empty array of { name, args?, replies?, expect? }; got ${describe(top.cases)}`);
  const seen = new Set<string>();
  const cases = (top.cases as unknown[]).map((c, i) => {
    const at = `cases[${i}]`;
    if (!isRecord(c)) fail(at, `must be an object { name, args?, replies?, expect? }; got ${describe(c)}`);
    const one = c as Record<string, unknown>;
    unknownKeys(one, CASE_KEYS, at, fail);
    if (typeof one.name !== "string" || one.name.trim() === "" || one.name.length > 100 || /[\u0000-\u001f\u007f]/.test(one.name)) {
      fail(`${at}.name`, `must be a non-empty string of at most 100 characters, without control characters; got ${describe(one.name)}`);
    }
    const name = one.name as string;
    if (seen.has(name)) fail(`${at}.name`, `'${name}' names two cases; each case needs its own name`);
    seen.add(name);
    let replies: ReplyEntry[] = [];
    if (one.replies !== undefined) {
      if (!Array.isArray(one.replies)) fail(`${at}.replies`, `must be an array of reply entries; got ${describe(one.replies)}`);
      replies = (one.replies as unknown[]).map((entry, j) => parseEntry(entry, `${at}.replies[${j}]`, fail, false));
    }
    const caseDefault = one.default === undefined ? fileDefault : parseEntry(one.default, `${at}.default`, fail, true);
    let checkpoints: "approve" | "reject" | null = null;
    if (one.checkpoints !== undefined) {
      if (one.checkpoints !== "approve" && one.checkpoints !== "reject") fail(`${at}.checkpoints`, `must be "approve" or "reject"; got ${describe(one.checkpoints)}`);
      checkpoints = one.checkpoints as "approve" | "reject";
    }
    let timeout = DEFAULT_CASE_TIMEOUT;
    if (one.timeout !== undefined) {
      if (typeof one.timeout !== "number" || !Number.isFinite(one.timeout) || one.timeout <= 0) fail(`${at}.timeout`, `must be a positive number of seconds; got ${describe(one.timeout)}`);
      timeout = one.timeout as number;
    }
    return {
      name,
      args: one.args === undefined ? null : one.args,
      replies,
      default: caseDefault,
      expect: parseExpect(one.expect, `${at}.expect`, fail),
      checkpoints,
      timeout,
    };
  });
  return { file, workflow, description: (top.description as string | undefined) ?? null, cases };
}

/** One reply entry; a default (`bare`) gives no matcher. */
function parseEntry(raw: unknown, at: string, fail: Fail, bare: boolean): ReplyEntry {
  if (!isRecord(raw)) fail(at, `must be an object such as { "label": "review:*", "reply": … }; got ${describe(raw)}`);
  const entry = raw as Record<string, unknown>;
  unknownKeys(entry, bare ? [...KINDS, ...MODIFIERS] : [...MATCHERS, ...KINDS, ...MODIFIERS], at, fail);
  const out: ReplyEntry = {};
  for (const key of MATCHERS) {
    if (entry[key] === undefined) continue;
    if (typeof entry[key] !== "string" || entry[key] === "") fail(`${at}.${key}`, `must be a non-empty string; got ${describe(entry[key])}`);
    out[key] = entry[key] as string;
  }
  if (!bare && MATCHERS.every((key) => out[key] === undefined)) {
    fail(at, `names no agent: give it a label, phase, prompt or adapter to match (or make it the "default")`);
  }
  const kinds = KINDS.filter((key) => entry[key] !== undefined);
  if (kinds.length !== 1) {
    fail(at, kinds.length === 0 ? `says no reply: give it one of reply, fail, empty, dry` : `gives ${kinds.join(" and ")}: an entry answers one way`);
  }
  switch (kinds[0]) {
    case "reply":
      out.reply = entry.reply;
      break;
    case "fail":
      if (!(FAIL_KINDS as readonly unknown[]).includes(entry.fail)) fail(`${at}.fail`, `must be one of ${FAIL_KINDS.join(", ")}; got ${describe(entry.fail)}`);
      out.fail = entry.fail as FailKind;
      break;
    case "empty":
      if (entry.empty !== true) fail(`${at}.empty`, `must be true; got ${describe(entry.empty)}`);
      out.empty = true;
      break;
    default:
      if (entry.dry !== true) fail(`${at}.dry`, `must be true; got ${describe(entry.dry)}`);
      out.dry = true;
  }
  if (entry.schemaMiss !== undefined) {
    if (!(Number.isInteger(entry.schemaMiss) && (entry.schemaMiss as number) >= 1)) fail(`${at}.schemaMiss`, `must be a whole number of attempts, 1 or more; got ${describe(entry.schemaMiss)}`);
    if (out.reply === undefined && !out.dry) fail(`${at}.schemaMiss`, `goes with reply or dry: the reply that comes after the misses`);
    out.schemaMiss = entry.schemaMiss as number;
  }
  if (entry.delayMs !== undefined) {
    if (!(Number.isInteger(entry.delayMs) && (entry.delayMs as number) >= 0)) fail(`${at}.delayMs`, `must be a whole number of milliseconds; got ${describe(entry.delayMs)}`);
    out.delayMs = entry.delayMs as number;
  }
  if (entry.once !== undefined) {
    if (entry.once !== true) fail(`${at}.once`, `must be true (leave it out for an entry that answers every agent it matches); got ${describe(entry.once)}`);
    if (bare) fail(`${at}.once`, `a default answers every unscripted agent`);
    out.once = true;
  }
  return out;
}

function parseExpect(raw: unknown, at: string, fail: Fail): TestExpect {
  const out: TestExpect = { state: "done", error: null, checks: [], agents: null, logs: null };
  if (raw === undefined) return out;
  if (!isRecord(raw)) fail(at, `must be an object { state?, error?, checks?, agents?, logs? }; got ${describe(raw)}`);
  const expect = raw as Record<string, unknown>;
  unknownKeys(expect, EXPECT_KEYS, at, fail);
  if (expect.state !== undefined) {
    if (!(RUN_END_STATES as readonly unknown[]).includes(expect.state)) fail(`${at}.state`, `must be "done", "failed" or "stopped"; got ${describe(expect.state)}`);
    out.state = expect.state as RunEndState;
  }
  if (expect.error !== undefined) {
    if (typeof expect.error !== "string" || expect.error === "") fail(`${at}.error`, `must be a substring of the run's error; got ${describe(expect.error)}`);
    out.error = expect.error as string;
  }
  if (expect.checks !== undefined) {
    if (!Array.isArray(expect.checks)) fail(`${at}.checks`, `must be an array of checks; got ${describe(expect.checks)}`);
    out.checks = (expect.checks as unknown[]).map((check, i) => parseCheck(check, `${at}.checks[${i}]`, fail));
  }
  if (expect.agents !== undefined) {
    const agents = expect.agents;
    if (!isRecord(agents)) fail(`${at}.agents`, `must be an object { count?, labels? }; got ${describe(agents)}`);
    const a = agents as Record<string, unknown>;
    unknownKeys(a, ["count", "labels"], `${at}.agents`, fail);
    out.agents = {};
    if (a.count !== undefined) {
      if (!(Number.isInteger(a.count) && (a.count as number) >= 0)) fail(`${at}.agents.count`, `must be a whole number; got ${describe(a.count)}`);
      out.agents.count = a.count as number;
    }
    if (a.labels !== undefined) {
      if (!Array.isArray(a.labels) || !a.labels.every((l) => typeof l === "string")) fail(`${at}.agents.labels`, `must be an array of labels; got ${describe(a.labels)}`);
      out.agents.labels = a.labels as string[];
    }
  }
  if (expect.logs !== undefined) {
    if (!Array.isArray(expect.logs) || !expect.logs.every((l) => typeof l === "string")) fail(`${at}.logs`, `must be an array of strings; got ${describe(expect.logs)}`);
    out.logs = expect.logs as string[];
  }
  return out;
}

/** A glob (`*` any run of characters, `?` one) as a whole-string regular expression. */
export function globRegExp(glob: string): RegExp {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[\\s\\S]*").replace(/\?/g, "[\\s\\S]");
  return new RegExp(`^${body}$`);
}

function unknownKeys(obj: Record<string, unknown>, allowed: readonly string[], at: string, fail: Fail): void {
  const extra = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (extra.length > 0) fail(at, `unknown key${extra.length > 1 ? "s" : ""} ${extra.map((k) => `'${k}'`).join(", ")} (allowed: ${allowed.join(", ")})`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
