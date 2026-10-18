/**
 * The dialect conformance suite: Claude Code workflow-dialect cases with
 * their expected results, and the runner that checks this ODW against them.
 *
 * A suite is a directory (the repository's `conformance/`; its README.md is
 * the format's reference) holding `mock-agent.mjs` and `cases/NN-slug/`, each
 * case a plain workflow script `<slug>.js` (plus any child scripts it runs)
 * and an `expected.json`: the case's inputs (`args`, `budget`), its agents'
 * scripted replies (`mock`), and what must come out — the run's `state`, its
 * `result` or `error`, and optionally its `logs`, `phases` and `agents`.
 *
 * Each case runs as a real odw run (worker, scheduler, bridge) in a scratch
 * run store, with one adapter: the mock agent answering from the case's
 * table, so every result is exact. `claudeCode` says whether Claude Code's
 * docs settle the behaviour ("documented") or not ("unspecified"); this
 * runner checks both kinds — an unspecified case pins what ODW does.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { AGENT_FAILED, AGENT_FINISHED, AGENT_STARTED, LOG, PHASE_STARTED, type WorkflowEvent } from "../events.js";
import { RunStore } from "../runtime/run-store.js";
import { executeRun } from "../runtime/worker.js";
import { isSeaBinary } from "../sea.js";

/** Whether Claude Code's docs settle a case's behaviour. */
export type ClaudeCodeStatus = "documented" | "unspecified";
export const CLAUDE_CODE_STATUSES: readonly ClaudeCodeStatus[] = ["documented", "unspecified"];

/** One row of a case's mock table: the first whose `when` occurs in a prompt answers it. */
export interface MockEntry {
  when: string;
  reply?: unknown;
  fail?: true | { exit?: number; stderr?: string };
  delayMs?: number;
}

/** An agent the run must have started: only the keys given are compared. */
export interface AgentExpectation {
  label?: string;
  phase?: string | null;
  outcome?: "finished" | "failed";
}

export interface ConformanceCase {
  /** The case directory's name, e.g. `01-agent-text`. */
  name: string;
  number: number;
  dir: string;
  /** The case's workflow script: `<dir>/<slug>.js`. */
  script: string;
  title: string;
  claudeCode: ClaudeCodeStatus;
  sources: string[];
  notes: string | null;
  /** The workflow input; `hasArgs` false when the case gives none. */
  hasArgs: boolean;
  args: unknown;
  budget: number | null;
  mock: MockEntry[];
  state: "done" | "failed";
  /** The return value (`state: "done"` only). */
  result: unknown;
  /** A substring of the run's error (`state: "failed"` only), or null. */
  error: string | null;
  logs: string[] | null;
  phases: string[] | null;
  agents: AgentExpectation[] | null;
}

/** What one run of a case produced, in the terms expected.json speaks. */
export interface CaseOutcome {
  state: string;
  result: unknown;
  error: string | null;
  logs: string[];
  phases: string[];
  agents: Array<{ label: string | null; phase: string | null; outcome: "finished" | "failed" | "running" }>;
}

export interface CaseReport {
  case: string;
  number: number;
  title: string;
  claudeCode: ClaudeCodeStatus;
  passed: boolean;
  /** One line per expectation the run missed; empty when it passed. */
  failures: string[];
  state: string;
  durationMs: number;
}

/** A suite or case that does not follow the format: a usage error, nothing ran. */
export class ConformanceFormatError extends Error {}

const CASE_DIR = /^(\d+)-([a-z0-9][a-z0-9-]*)$/;
const CASE_KEYS = [
  "title",
  "claudeCode",
  "sources",
  "notes",
  "args",
  "budget",
  "mock",
  "state",
  "result",
  "error",
  "logs",
  "phases",
  "agents",
];
const MOCK_KEYS = ["when", "reply", "fail", "delayMs"];
const AGENT_KEYS = ["label", "phase", "outcome"];
/** The mock's adapter name: what an unlabelled agent shows as its label. */
const MOCK_ADAPTER = "mock";

/**
 * The suite this odw ships with: `conformance/` beside `src/` (or `dist/`) in
 * a checkout or an npm install. A SEA binary carries none — null.
 */
export function defaultSuiteDir(): string | null {
  if (isSeaBinary()) return null;
  try {
    const dir = resolve(fileURLToPath(new URL("../../conformance/", import.meta.url)));
    return existsSync(join(dir, "cases")) ? dir : null;
  } catch {
    return null;
  }
}

/** Every case of the suite at `dir`, in number order, each validated. */
export function loadSuite(dir: string): ConformanceCase[] {
  const casesDir = join(dir, "cases");
  if (!isDir(casesDir)) throw new ConformanceFormatError(`no conformance suite at ${dir} (it has no cases/ directory)`);
  if (!existsSync(join(dir, "mock-agent.mjs"))) {
    throw new ConformanceFormatError(`no mock agent at ${join(dir, "mock-agent.mjs")}`);
  }
  const cases = readdirSync(casesDir)
    .filter((name) => isDir(join(casesDir, name)))
    .map((name) => loadCase(join(casesDir, name), name));
  const seen = new Map<number, string>();
  for (const c of cases) {
    const other = seen.get(c.number);
    if (other) throw new ConformanceFormatError(`cases ${other} and ${c.name} share the number ${c.number}`);
    seen.set(c.number, c.name);
  }
  return cases.sort((a, b) => a.number - b.number);
}

/** The case `--case` names: its number (`3`, `03`) or its directory name. */
export function selectCase(cases: ConformanceCase[], selector: string): ConformanceCase {
  const found = /^\d+$/.test(selector)
    ? cases.find((c) => c.number === Number(selector))
    : cases.find((c) => c.name === selector);
  if (!found) {
    throw new ConformanceFormatError(
      `no conformance case ${JSON.stringify(selector)} (cases ${cases[0]?.number ?? "?"}–${cases.at(-1)?.number ?? "?"})`,
    );
  }
  return found;
}

/** Read and validate one case directory. */
export function loadCase(dir: string, name: string): ConformanceCase {
  const m = CASE_DIR.exec(name);
  if (!m) throw new ConformanceFormatError(`case directory ${name}: name it NN-slug (digits, a dash, then a-z, 0-9 and -)`);
  const script = join(dir, `${m[2]}.js`);
  if (!existsSync(script)) throw new ConformanceFormatError(`case ${name}: no workflow script ${m[2]}.js`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8"));
  } catch (err) {
    throw new ConformanceFormatError(`case ${name}: cannot read expected.json: ${(err as Error).message}`);
  }
  const where = `case ${name}: expected.json`;
  const fail = (what: string): never => {
    throw new ConformanceFormatError(`${where}: ${what}`);
  };
  if (!isObject(raw)) return fail("must be an object");
  for (const key of Object.keys(raw)) if (!CASE_KEYS.includes(key)) fail(`unknown key "${key}"`);

  if (typeof raw.title !== "string" || raw.title.length === 0) fail("title must be a non-empty string");
  if (!CLAUDE_CODE_STATUSES.includes(raw.claudeCode as ClaudeCodeStatus)) {
    fail(`claudeCode must be "documented" or "unspecified"`);
  }
  if (!isStringList(raw.sources) || raw.sources.length === 0) fail("sources must be a non-empty list of strings");
  if (raw.notes !== undefined && typeof raw.notes !== "string") fail("notes must be a string");
  if (raw.claudeCode === "unspecified" && typeof raw.notes !== "string") {
    fail("an unspecified case says why in notes");
  }
  if (raw.budget !== undefined && !(Number.isInteger(raw.budget) && (raw.budget as number) > 0)) {
    fail("budget must be a positive integer (tokens)");
  }
  if (!Array.isArray(raw.mock)) fail("mock must be a list (it may be empty)");
  const mock = (raw.mock as unknown[]).map((entry, i) => mockEntry(entry, `${where}: mock[${i}]`));
  if (raw.state !== "done" && raw.state !== "failed") fail(`state must be "done" or "failed"`);
  if (raw.state === "done" && !("result" in raw)) fail(`a "done" case gives its result`);
  if (raw.state === "failed" && "result" in raw) fail(`a "failed" case has no result`);
  if (raw.error !== undefined && (raw.state !== "failed" || typeof raw.error !== "string")) {
    fail(`error is a string, for a "failed" case`);
  }
  for (const key of ["logs", "phases"] as const) {
    if (raw[key] !== undefined && !isStringList(raw[key])) fail(`${key} must be a list of strings`);
  }
  if (raw.agents !== undefined && !Array.isArray(raw.agents)) fail("agents must be a list");
  const agents = raw.agents === undefined ? null : (raw.agents as unknown[]).map((a, i) => agentExpectation(a, `${where}: agents[${i}]`));

  return {
    name,
    number: Number(m[1]),
    dir,
    script,
    title: raw.title as string,
    claudeCode: raw.claudeCode as ClaudeCodeStatus,
    sources: raw.sources as string[],
    notes: (raw.notes as string | undefined) ?? null,
    hasArgs: "args" in raw,
    args: raw.args ?? null,
    budget: (raw.budget as number | undefined) ?? null,
    mock,
    state: raw.state as "done" | "failed",
    result: raw.result,
    error: (raw.error as string | undefined) ?? null,
    logs: (raw.logs as string[] | undefined) ?? null,
    phases: (raw.phases as string[] | undefined) ?? null,
    agents,
  };
}

function mockEntry(raw: unknown, where: string): MockEntry {
  if (!isObject(raw)) throw new ConformanceFormatError(`${where}: must be an object`);
  for (const key of Object.keys(raw)) {
    if (!MOCK_KEYS.includes(key)) throw new ConformanceFormatError(`${where}: unknown key "${key}"`);
  }
  if (typeof raw.when !== "string" || raw.when.length === 0) {
    throw new ConformanceFormatError(`${where}: when must be a non-empty string`);
  }
  if (("reply" in raw) === ("fail" in raw)) throw new ConformanceFormatError(`${where}: give exactly one of reply and fail`);
  if ("fail" in raw && raw.fail !== true) {
    const fail = raw.fail;
    const okFail =
      isObject(fail) &&
      Object.keys(fail).every((k) => k === "exit" || k === "stderr") &&
      (fail.exit === undefined || (Number.isInteger(fail.exit) && fail.exit !== 0)) &&
      (fail.stderr === undefined || typeof fail.stderr === "string");
    if (!okFail) throw new ConformanceFormatError(`${where}: fail is true or { exit?: non-zero integer, stderr?: string }`);
  }
  if (raw.delayMs !== undefined && !(Number.isInteger(raw.delayMs) && (raw.delayMs as number) >= 0)) {
    throw new ConformanceFormatError(`${where}: delayMs must be a non-negative integer`);
  }
  return raw as unknown as MockEntry;
}

function agentExpectation(raw: unknown, where: string): AgentExpectation {
  if (!isObject(raw)) throw new ConformanceFormatError(`${where}: must be an object`);
  for (const key of Object.keys(raw)) {
    if (!AGENT_KEYS.includes(key)) throw new ConformanceFormatError(`${where}: unknown key "${key}"`);
  }
  if (raw.label !== undefined && typeof raw.label !== "string") throw new ConformanceFormatError(`${where}: label must be a string`);
  if (raw.phase !== undefined && raw.phase !== null && typeof raw.phase !== "string") {
    throw new ConformanceFormatError(`${where}: phase must be a string or null`);
  }
  if (raw.outcome !== undefined && raw.outcome !== "finished" && raw.outcome !== "failed") {
    throw new ConformanceFormatError(`${where}: outcome must be "finished" or "failed"`);
  }
  return raw as AgentExpectation;
}

/**
 * The mock agent's command, without the table argument: this odw's own node
 * running the suite's mock-agent.mjs (`node` on PATH in a SEA binary, whose
 * executable runs only odw).
 */
export function mockCommand(suiteDir: string): string[] {
  return [isSeaBinary() ? "node" : execPath, resolve(suiteDir, "mock-agent.mjs")];
}

/** Run one case as a real odw run on the mock agent, in a scratch run store. */
export async function runCase(c: ConformanceCase, suiteDir: string): Promise<CaseOutcome> {
  const scratch = mkdtempSync(join(tmpdir(), "odw-conformance-"));
  try {
    const table = join(scratch, "mock.json");
    writeFileSync(table, JSON.stringify(c.mock));
    const configPath = join(scratch, "odw.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        defaultAdapter: MOCK_ADAPTER,
        // The mock has no --version to record.
        recordVersions: false,
        adapters: { [MOCK_ADAPTER]: { command: [...mockCommand(suiteDir), table], stdin: "{prompt}" } },
      }),
    );
    const store = new RunStore(join(scratch, "runs"));
    const runId = store.create({
      script: c.script,
      args: c.hasArgs ? c.args : null,
      // Agents run (and child scripts resolve) in the case's own directory.
      source: c.dir,
      configPath,
      budgetTotal: c.budget,
      origin: "conformance",
    });
    const state = await executeRun(store.runDir(runId));
    return outcomeOf(state, store.readEvents(runId), state === "done" ? store.readResult(runId) : null, store.readError(runId));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** A run's events, result and error, as expected.json speaks of them. */
export function outcomeOf(
  state: string,
  events: WorkflowEvent[],
  result: unknown,
  error: Record<string, unknown> | null,
): CaseOutcome {
  const agents = new Map<unknown, CaseOutcome["agents"][number]>();
  for (const ev of events) {
    if (ev.type === AGENT_STARTED) {
      agents.set(ev.agentId, {
        label: typeof ev.label === "string" ? ev.label : null,
        phase: typeof ev.phase === "string" ? ev.phase : null,
        outcome: "running",
      });
    } else if (ev.type === AGENT_FINISHED || ev.type === AGENT_FAILED) {
      const agent = agents.get(ev.agentId);
      if (agent) agent.outcome = ev.type === AGENT_FINISHED ? "finished" : "failed";
    }
  }
  return {
    state,
    result,
    error: typeof error?.error === "string" ? error.error : null,
    logs: events.filter((e) => e.type === LOG).map((e) => String(e.message)),
    phases: events.filter((e) => e.type === PHASE_STARTED).map((e) => String(e.phase)),
    agents: [...agents.values()],
  };
}

/** Each expectation of the case the outcome misses, one line apiece; [] when it conforms. */
export function judgeCase(c: ConformanceCase, out: CaseOutcome): string[] {
  const failures: string[] = [];
  if (out.state !== c.state) {
    failures.push(`state: expected ${c.state}, got ${out.state}${out.error ? ` (${clip(out.error)})` : ""}`);
  }
  if (c.state === "done" && out.state === "done" && !isDeepStrictEqual(out.result, c.result)) {
    failures.push(`result: expected ${clip(JSON.stringify(c.result))}, got ${clip(JSON.stringify(out.result))}`);
  }
  if (c.error !== null && out.state === "failed" && !(out.error ?? "").includes(c.error)) {
    failures.push(`error: expected it to contain ${JSON.stringify(c.error)}, got ${clip(JSON.stringify(out.error))}`);
  }
  if (c.logs && !isSubsequence(c.logs, out.logs)) {
    failures.push(`logs: expected ${clip(JSON.stringify(c.logs))} in this order, got ${clip(JSON.stringify(out.logs))}`);
  }
  if (c.phases && !isSubsequence(c.phases, out.phases)) {
    failures.push(`phases: expected ${clip(JSON.stringify(c.phases))} in this order, got ${clip(JSON.stringify(out.phases))}`);
  }
  if (c.agents && !agentsMatch(c.agents, out.agents)) {
    failures.push(`agents: expected ${clip(JSON.stringify(c.agents))}, got ${clip(JSON.stringify(out.agents))}`);
  }
  return failures;
}

/** Run and judge one case. */
export async function checkCase(c: ConformanceCase, suiteDir: string): Promise<CaseReport> {
  const started = Date.now();
  const out = await runCase(c, suiteDir);
  const failures = judgeCase(c, out);
  return {
    case: c.name,
    number: c.number,
    title: c.title,
    claudeCode: c.claudeCode,
    passed: failures.length === 0,
    failures,
    state: out.state,
    durationMs: Date.now() - started,
  };
}

/** `expected` appears in `actual` in this order; other entries may come between. */
function isSubsequence(expected: string[], actual: string[]): boolean {
  let at = 0;
  for (const line of actual) if (at < expected.length && line === expected[at]) at++;
  return at === expected.length;
}

/**
 * Exactly the agents listed ran — as many, each matching one entry on the
 * keys that entry gives — in any order (concurrent agents start in no
 * documented order). A small backtracking match: an entry that gives fewer
 * keys must not take the agent a more specific one needs.
 */
function agentsMatch(expected: AgentExpectation[], actual: CaseOutcome["agents"]): boolean {
  if (expected.length !== actual.length) return false;
  const used = new Array<boolean>(actual.length).fill(false);
  const fits = (want: AgentExpectation, got: CaseOutcome["agents"][number]): boolean =>
    (want.label === undefined || want.label === got.label) &&
    (want.phase === undefined || want.phase === got.phase) &&
    (want.outcome === undefined || want.outcome === got.outcome);
  const place = (i: number): boolean => {
    if (i === expected.length) return true;
    for (let j = 0; j < actual.length; j++) {
      if (used[j] || !fits(expected[i]!, actual[j]!)) continue;
      used[j] = true;
      if (place(i + 1)) return true;
      used[j] = false;
    }
    return false;
  };
  return place(0);
}

function clip(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
