/**
 * Running one `odw test` case (an ODW extension; the file is ./definition):
 * a real odw run — worker, scheduler, bridge, run store — in-process, with
 * every agent answered by the case's scripted replies (./mock), then judged
 * against its `expect`.
 */

import { AGENT_STARTED, LOG, type WorkflowEvent } from "../events.js";
import { judgeRun, type CheckFailure } from "../eval/judge.js";
import { RunStore } from "../runtime/run-store.js";
import { executeRun } from "../runtime/worker.js";
import { sanitizeText } from "../tty.js";
import { globRegExp, type ReplyEntry, type TestCase } from "./definition.js";
import { dryAnswer, type MockAnswer, type MockCall, type MockResponder } from "./mock.js";

/** What a reply that misses every schema says (`schemaMiss`). */
export const SCHEMA_MISS_REPLY = "(odw test: a reply that misses the schema)";

/** How often a running case is looked at for its checkpoints and its timeout. */
const POLL_MS = 50;

/** A case's scripted replies, as a responder; `unscripted` collects each agent nothing scripted. */
export function scriptedResponder(c: Pick<TestCase, "replies" | "default">, unscripted: string[]): MockResponder {
  const compiled = c.replies.map((entry) => ({ entry, match: matcherOf(entry) }));
  const usedOnce = new Set<number>();
  const pinned = new Map<number, number>();
  const told = new Set<number | string>();
  return (call) => {
    let index: number | undefined;
    const own = call.agentId !== null ? pinned.get(call.agentId) : undefined;
    if (own !== undefined && compiled[own]!.match(call)) index = own;
    else {
      index = compiled.findIndex((e, i) => e.match(call) && !(e.entry.once && usedOnce.has(i)));
      if (index === -1) index = undefined;
      else if (compiled[index]!.entry.once) {
        usedOnce.add(index);
        if (call.agentId !== null) pinned.set(call.agentId, index);
      }
    }
    const entry = index !== undefined ? compiled[index]!.entry : c.default;
    if (!entry) {
      const where = [call.agentId !== null ? `agent #${call.agentId}` : null, call.phase ? `phase ${call.phase}` : null].filter(Boolean).join(", ");
      const who = `unscripted agent \`${call.label ?? call.adapter}\`${where ? ` (${where})` : ""}`;
      const key = call.agentId ?? `${call.label}\u0000${call.phase}`;
      if (!told.has(key)) {
        told.add(key);
        unscripted.push(who);
      }
      return { unscripted: `${who}: no reply entry matches it and the case has no default` };
    }
    return answerOf(entry, call);
  };
}

/** What `entry` answers `call` with. */
function answerOf(entry: ReplyEntry, call: MockCall): MockAnswer {
  const late = entry.delayMs !== undefined ? { delayMs: entry.delayMs } : {};
  if (entry.fail) return { fail: entry.fail, ...late };
  if (entry.empty) return { text: "", ...late };
  if (entry.schemaMiss !== undefined && call.attempt <= entry.schemaMiss) return { text: SCHEMA_MISS_REPLY, ...late };
  if (entry.dry) return { text: dryAnswer(call.schema), ...late };
  return { text: typeof entry.reply === "string" ? entry.reply : JSON.stringify(entry.reply ?? null), ...late };
}

function matcherOf(entry: ReplyEntry): (call: MockCall) => boolean {
  const label = entry.label !== undefined ? globRegExp(entry.label) : null;
  const phase = entry.phase !== undefined ? globRegExp(entry.phase) : null;
  const adapter = entry.adapter !== undefined ? globRegExp(entry.adapter) : null;
  const prompt = entry.prompt;
  return (call) =>
    (label === null || (call.label !== null && label.test(call.label))) &&
    (phase === null || (call.phase !== null && phase.test(call.phase))) &&
    (adapter === null || adapter.test(call.adapter)) &&
    (prompt === undefined || call.prompt.includes(prompt));
}

/** What one case's run came to, and what it missed. */
export interface CaseResult {
  name: string;
  passed: boolean;
  failures: CheckFailure[];
  runId: string;
  state: string;
  /** How many agents started. */
  agents: number;
  durationMs: number;
}

export interface RunCaseOptions {
  /** The workflow script (resolved). */
  script: string;
  /** The project directory: the run's source, where `{ command }` checks run. */
  cwd: string;
  configPath: string | null;
  /** The run store the case's run goes in. */
  runsRoot: string;
  /** The test file and workflow, for the run's meta. */
  file: string;
}

/** Run one case and judge it. */
export async function runTestCase(c: TestCase, options: RunCaseOptions): Promise<CaseResult> {
  const started = Date.now();
  const store = new RunStore(options.runsRoot);
  const runId = store.create({
    script: options.script,
    args: c.args,
    source: options.cwd,
    configPath: options.configPath,
    origin: "test",
  });
  const unscripted: string[] = [];
  const responder = scriptedResponder(c, unscripted);
  // Its checkpoints answered as the case says, and a run past its timeout stopped.
  let timedOut = false;
  const answered = new Set<number>();
  const watch = setInterval(() => {
    const status = store.readStatus(runId);
    const waiting = status.waiting as { checkpointId?: unknown } | null | undefined;
    if (c.checkpoints && waiting && typeof waiting.checkpointId === "number" && !answered.has(waiting.checkpointId)) {
      answered.add(waiting.checkpointId);
      store.requestCheckpointDecision(runId, { action: c.checkpoints, checkpointId: waiting.checkpointId, note: "odw test" });
    }
    if (!timedOut && Date.now() - started > c.timeout * 1000) {
      timedOut = true;
      store.writeControl(runId, "stop");
    }
  }, POLL_MS);
  let state: string;
  try {
    state = await executeRun(store.runDir(runId), { mock: responder });
  } finally {
    clearInterval(watch);
  }
  const events = store.readEvents(runId);
  const failures = await judgeCase(c, store, runId, state, events, { cwd: options.cwd, wallMs: Date.now() - started });
  if (timedOut) failures.unshift({ check: "timeout", message: `still going after ${c.timeout}s, the case's timeout: stopped` });
  for (const who of unscripted) failures.push({ check: "replies", message: who });
  return {
    name: c.name,
    passed: failures.length === 0,
    failures,
    runId,
    state,
    agents: events.filter((e) => e.type === AGENT_STARTED).length,
    durationMs: Date.now() - started,
  };
}

/** Every expectation of `c` the run missed. */
export async function judgeCase(
  c: TestCase,
  store: RunStore,
  runId: string,
  state: string,
  events: WorkflowEvent[],
  ctx: { cwd: string; wallMs: number },
): Promise<CheckFailure[]> {
  const failures: CheckFailure[] = [];
  const errorText = state === "done" ? null : (store.readError(runId)?.error as string | undefined) ?? null;
  const expect = c.expect;
  if (state !== expect.state) {
    failures.push({ check: `state ${expect.state}`, message: `the run ended ${state}${errorText ? `: ${sanitizeText(errorText, 200)}` : ""}` });
  }
  if (expect.error !== null && !(errorText ?? "").includes(expect.error)) {
    failures.push({ check: `error contains ${JSON.stringify(expect.error)}`, message: errorText ? `the error is ${JSON.stringify(sanitizeText(errorText, 200))}` : "the run has no error" });
  }
  if (expect.checks.length > 0) {
    failures.push(
      ...(await judgeRun(expect.checks, {
        runId,
        state,
        result: state === "done" ? store.readResult(runId) : null,
        error: errorText,
        wallMs: ctx.wallMs,
        // Nothing was spent: no model was called.
        costUsd: 0,
        timedOut: null,
      }, { cwd: ctx.cwd, env: { ODW_TEST_CASE: c.name } })),
    );
  }
  const labels = events.filter((e) => e.type === AGENT_STARTED).map((e) => (typeof e.label === "string" ? e.label : ""));
  if (expect.agents?.count !== undefined && labels.length !== expect.agents.count) {
    failures.push({ check: `agents count ${expect.agents.count}`, message: `${labels.length} agent${labels.length === 1 ? "" : "s"} started` });
  }
  if (expect.agents?.labels !== undefined) {
    const want = [...expect.agents.labels].sort();
    const got = [...labels].sort();
    if (JSON.stringify(want) !== JSON.stringify(got)) {
      failures.push({ check: `agents labels ${clip(JSON.stringify(want))}`, message: `the agents were ${clip(JSON.stringify(got))}` });
    }
  }
  if (expect.logs !== null) {
    const lines = events.filter((e) => e.type === LOG).map((e) => String(e.message ?? ""));
    let at = 0;
    for (const line of lines) if (at < expect.logs.length && line.includes(expect.logs[at]!)) at++;
    if (at < expect.logs.length) {
      failures.push({ check: `logs ${clip(JSON.stringify(expect.logs))}`, message: `no log line (in order) contains ${JSON.stringify(expect.logs[at])}` });
    }
  }
  return failures;
}

function clip(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
