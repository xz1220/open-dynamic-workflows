/**
 * Judging one `odw eval` run (an ODW extension): its outcome against its
 * case's checks (see ./definition), with no model involved. Every check is
 * judged — a run that misses three of them lists all three — and a run the
 * eval's `timeout` stopped fails besides.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCommand } from "../adapters/runner.js";
import { cliOk } from "../adapters/types.js";
import { stableJson } from "../journal.js";
import { sanitizeText } from "../tty.js";
import { COMMAND_TIMEOUT_SECONDS, describe, lookupPath, parsePath, type EvalCheck } from "./definition.js";

/** What a run came to, as its checks see it. */
export interface RunOutcome {
  runId: string;
  /** done, failed, stopped — or stale, when its worker died. */
  state: string;
  /** Its return value; null unless it finished done. */
  result: unknown;
  /** Why it failed, when it did. */
  error: string | null;
  /** Start to end (its run_started event to its end), in milliseconds; null when unknown. */
  wallMs: number | null;
  /** What its agents cost, as their CLIs reported it; null when none did. */
  costUsd: number | null;
  /** Stopped by the eval's `timeout` (in seconds). */
  timedOut: number | null;
}

/** A check a run missed: the check, in one line, and what was found instead. */
export interface CheckFailure {
  check: string;
  message: string;
}

export interface JudgeContext {
  /** Where `{ command }` checks run: the project directory. */
  cwd: string;
  /** Extra environment for `{ command }` checks (ODW_EVAL_CASE, ODW_EVAL_ADAPTER). */
  env?: Record<string, string>;
  /** Fires on Ctrl-C: a command check still running is killed, and fails. */
  signal?: AbortSignal;
}

/** Every check `outcome` misses (empty: it passed). */
export async function judgeRun(checks: EvalCheck[], outcome: RunOutcome, ctx: JudgeContext): Promise<CheckFailure[]> {
  const failures: CheckFailure[] = [];
  if (outcome.timedOut !== null) {
    failures.push({ check: "timeout", message: `still going after ${outcome.timedOut}s, the eval's timeout: stopped` });
  }
  for (const check of checks) {
    const message = await judgeOne(check, outcome, ctx);
    if (message !== null) failures.push({ check: describeCheck(check), message });
  }
  return failures;
}

/** Null when `check` holds for `outcome`; else what was found instead. */
async function judgeOne(check: EvalCheck, outcome: RunOutcome, ctx: JudgeContext): Promise<string | null> {
  if ("state" in check) {
    if (outcome.state === check.state) return null;
    const why = outcome.error ? `: ${sanitizeText(outcome.error, 200)}` : "";
    return `the run ended ${outcome.state}${why}`;
  }
  if ("maxCostUsd" in check) {
    if (outcome.costUsd === null) return "its cost is unknown: no agent's CLI reported one";
    return outcome.costUsd <= check.maxCostUsd ? null : `it cost $${round(outcome.costUsd)}`;
  }
  if ("maxSeconds" in check) {
    if (outcome.wallMs === null) return "its wall time is unknown";
    return outcome.wallMs <= check.maxSeconds * 1000 ? null : `it took ${round(outcome.wallMs / 1000)}s`;
  }
  if ("command" in check) return runCheckCommand(check, outcome, ctx);

  const at = lookupPath(outcome.result, parsePath(check.path));
  const where = check.path === "" ? "the result" : check.path;
  if ("exists" in check) {
    if (at.found === check.exists) return null;
    return check.exists ? `${where} is not in the result${noResult(outcome)}` : `${where} is there: ${describe(at.found ? at.value : undefined)}`;
  }
  if (!at.found) return `${where} is not in the result${noResult(outcome)}`;
  const value = at.value;
  if ("equals" in check) {
    return stableJson(value) === stableJson(check.equals) ? null : `${where} is ${describe(value)}`;
  }
  if ("contains" in check) {
    if (typeof value === "string") {
      if (typeof check.contains !== "string") return `${where} is a string; contains needs a string to look for`;
      return value.includes(check.contains) ? null : `${where} is ${describe(value)}`;
    }
    if (Array.isArray(value)) {
      const wanted = stableJson(check.contains);
      return value.some((item) => stableJson(item) === wanted) ? null : `${where} has no such element: ${describe(value)}`;
    }
    return `${where} is ${describe(value)}: neither a string nor an array`;
  }
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  return new RegExp(check.matches, check.flags ?? "").test(text) ? null : `${where} is ${describe(value)}`;
}

/** Why a run has no result to look into: it did not finish done. */
function noResult(outcome: RunOutcome): string {
  return outcome.state === "done" ? "" : ` (the run ended ${outcome.state}, with no result)`;
}

/** Lines of a failed command's output a failure quotes. */
const COMMAND_TAIL_LINES = 5;

/**
 * Run a `{ command }` check through the shell in the project directory, with
 * ODW_RESULT naming a file that holds the run's result as JSON (`null` for a
 * run that did not finish done) and ODW_RUN_ID the run. Null when it exits 0.
 */
async function runCheckCommand(check: { command: string; timeout?: number }, outcome: RunOutcome, ctx: JudgeContext): Promise<string | null> {
  const dir = mkdtempSync(join(tmpdir(), "odw-eval-"));
  try {
    const resultFile = join(dir, "result.json");
    writeFileSync(resultFile, JSON.stringify(outcome.result ?? null, null, 2) + "\n");
    let output = "";
    const keep = (chunk: string): void => {
      output = (output + chunk).slice(-8000);
    };
    const timeout = check.timeout ?? COMMAND_TIMEOUT_SECONDS;
    const result = await runCommand([check.command], {
      shell: true,
      cwd: ctx.cwd,
      env: { ...(process.env as Record<string, string>), ...ctx.env, ODW_RESULT: resultFile, ODW_RUN_ID: outcome.runId },
      timeout,
      signal: ctx.signal,
      onStdout: keep,
      onStderr: keep,
    });
    if (cliOk(result) && !ctx.signal?.aborted) return null;
    const why = ctx.signal?.aborted
      ? "was interrupted"
      : result.timedOut
        ? `timed out after ${timeout}s`
        : `exited with code ${result.returncode}`;
    const text = output.trim() !== "" ? output : result.stderr;
    const tail = text.replace(/\s+$/, "").split("\n").slice(-COMMAND_TAIL_LINES).map((line) => sanitizeText(line, 200)).join(" | ");
    return tail ? `${why}: ${tail}` : why;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A check in one line, as reports and failures name it. */
export function describeCheck(check: EvalCheck): string {
  if ("state" in check) return `state ${check.state}`;
  if ("maxCostUsd" in check) return `maxCostUsd ${check.maxCostUsd}`;
  if ("maxSeconds" in check) return `maxSeconds ${check.maxSeconds}`;
  if ("command" in check) return `command ${describe(check.command)}`;
  const path = check.path === "" ? "(result)" : check.path;
  if ("equals" in check) return `${path} equals ${describe(check.equals)}`;
  if ("contains" in check) return `${path} contains ${describe(check.contains)}`;
  if ("exists" in check) return `${path} ${check.exists ? "exists" : "does not exist"}`;
  return `${path} matches /${check.matches}/${check.flags ?? ""}`;
}

function round(n: number): string {
  return String(Math.round(n * 10000) / 10000);
}
