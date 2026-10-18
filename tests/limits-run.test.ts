import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";

import { agentRowJson, agentRows, formatAgentTable } from "../src/runtime/agents-view.js";
import { runawayLines } from "../src/runtime/live-view.js";
import { RunStore } from "../src/runtime/run-store.js";
import { detail } from "../src/runtime/runs-view.js";
import { executeRun } from "../src/runtime/worker.js";
import type { WorkflowEvent } from "../src/events.js";

// Per-agent limits end to end (an ODW extension): worker → scheduler → bridge
// → the real runner, with mock CLIs that never stop on their own — the same
// tool call over and over, ever more tool calls, ever more spend — so only a
// limit can end them; and a text CLI whose spend is checked after its run.

const FIXTURE = join(import.meta.dirname, "fixtures", "runaway-agent.mjs");

function limitsRun(script: string, config: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "odw-limits-"));
  const dir = join(root, "agent");
  mkdirSync(dir);
  const agent = (mode: string) => [execPath, FIXTURE, mode, dir];
  const configPath = join(root, "odw.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      defaultAdapter: "loopy",
      ...config,
      adapters: {
        // Claude Code's stream-json, Codex's exec --json and opencode's events, as their built-ins read them.
        loopy: { command: agent("repeat"), output: { format: "jsonl", eventType: "result", textPath: ["result"], select: "last" } },
        busy: { command: agent("many"), output: { format: "jsonl", eventType: "item.completed", textPath: ["item", "text"], select: "last" } },
        spender: {
          command: agent("spend"),
          output: { format: "jsonl", eventType: "text", textPath: ["part", "text"], select: "last" },
          agentLimits: { costUsd: 0.05 },
        },
        chatty: { command: agent("text") },
        ...((config.adapters as object) ?? {}),
      },
    }),
  );
  const path = join(root, "wf.js");
  writeFileSync(path, `export const meta = { name: 'wf', description: 'd' }\n${script}`);
  const store = new RunStore(join(root, "runs"));
  const id = store.create({ script: path, args: null, source: root, configPath });
  const runs = () => (existsSync(join(dir, "runs")) ? readFileSync(join(dir, "runs"), "utf8").trim().split("\n").length : 0);
  const helperPid = () => Number(readFileSync(join(dir, "helper.pid"), "utf8"));
  return { root, store, id, runs, helperPid };
}

const failedOf = (events: WorkflowEvent[]) => events.filter((e) => e.type === "agent_failed");
const startedOf = (events: WorkflowEvent[]) => events.filter((e) => e.type === "agent_started");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function goneSoon(pid: number): Promise<boolean> {
  const deadline = Date.now() + 3000;
  while (alive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  return !alive(pid);
}

test("an agent repeating the same tool call is killed at once, with everything it started, and fails runaway", async () => {
  const { root, store, id, runs, helperPid } = limitsRun(
    "return await agent('work', { label: 'fix', limits: { repeat: 3 } })",
    { transientRetries: 3, timeout: 60 },
  );
  try {
    const started = Date.now();
    assert.equal(await executeRun(store.runDir(id)), "failed");
    assert.ok(Date.now() - started < 10_000, "killed at the limit, long before the 60s timeout");
    assert.ok(await goneSoon(helperPid()), "the process it started is gone too");
    assert.equal(runs(), 1, "a runaway is not retried");

    const events = store.readEvents(id);
    assert.deepEqual(startedOf(events)[0]!.limits, { repeat: 3 }, "agent_started carries its limits");
    const failed = failedOf(events);
    assert.equal(failed.length, 1);
    assert.equal(failed[0]!.reason, "runaway");
    assert.deepEqual(failed[0]!.limitHit, { limit: "repeat", max: 3, value: 3, evidence: "Bash `npm test` ×3 in a row" });
    assert.match(String(failed[0]!.error), /RunawayError: adapter 'loopy' ran away — limits\.repeat=3: Bash `npm test` ×3 in a row/);

    // The transcript stops right there: nothing much past the third call was printed.
    const transcript = readFileSync(join(store.runDir(id), "agents", "1.transcript.jsonl"), "utf8");
    const calls = transcript.split("\n").filter((line) => line.includes('"tool_use"')).length;
    assert.ok(calls >= 3 && calls < 15, `kept ${calls} tool calls`);

    // odw status, odw agents and the dashboard's view say what it ran into.
    const run = detail(store, id);
    assert.deepEqual(run.agents[0]!.limits, { repeat: 3, hit: { limit: "repeat", max: 3, value: 3, evidence: "Bash `npm test` ×3 in a row" } });
    assert.equal(run.agents[0]!.failureReason, "runaway");
    assert.deepEqual(runawayLines(run.agents), ["runaway: 1 agent killed at a limit — fix:1 Bash `npm test` ×3 in a row (limits.repeat=3)"]);
    const rows = agentRows(store, id);
    assert.equal((agentRowJson(rows[0]!).limits as { hit: { limit: string } }).hit.limit, "repeat");
    const table = formatAgentTable(rows, { width: 160, caps: { color: false, unicode: true } as never });
    assert.match(table[1]!, /failed .* runaway: Bash `npm test` ×3 in a row \(limits\.repeat=3\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a call's own limits override the run's: too many tool calls, counted live from Codex events", async () => {
  const { root, store, id, helperPid } = limitsRun(
    "return await agent('work', { adapter: 'busy', limits: { toolCalls: 5, repeat: null } })",
    { agentLimits: { toolCalls: 1000, repeat: 2 } },
  );
  try {
    assert.equal(await executeRun(store.runDir(id)), "failed");
    assert.ok(await goneSoon(helperPid()));
    const events = store.readEvents(id);
    assert.deepEqual(startedOf(events)[0]!.limits, { toolCalls: 5 }, "the call's 5 over the run's 1000; its null lifts repeat");
    assert.deepEqual(failedOf(events)[0]!.limitHit, { limit: "toolCalls", max: 5, value: 6, evidence: "6 tool calls > 5" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an adapter's costUsd stops an agent whose reported spend crosses it mid-stream", async () => {
  const { root, store, id, helperPid } = limitsRun("return await agent('work', { adapter: 'spender' })");
  try {
    assert.equal(await executeRun(store.runDir(id)), "failed");
    assert.ok(await goneSoon(helperPid()));
    const failed = failedOf(store.readEvents(id))[0]!;
    assert.equal(failed.reason, "runaway");
    const hit = failed.limitHit as { limit: string; max: number; value: number; evidence: string };
    assert.deepEqual({ ...hit, value: Math.round(hit.value * 100) / 100 }, { limit: "costUsd", max: 0.05, value: 0.06, evidence: "$0.06 > $0.05" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a text CLI's output tokens are checked after its run, and the run says once that they cannot be live", async () => {
  const { root, store, id, runs } = limitsRun(
    [
      "const a = await agent('one', { adapter: 'chatty', limits: { outputTokens: 1000 } })",
      "let b = null",
      "try { b = await agent('two', { adapter: 'chatty', limits: { outputTokens: 50 } }) } catch (err) { b = String(err) }",
      "return { a: a.length, b }",
    ].join("\n"),
  );
  try {
    assert.equal(await executeRun(store.runDir(id)), "done");
    const result = store.readResult(id) as { a: number; b: string };
    assert.equal(result.a, 400, "under its limit, the reply stands");
    assert.match(result.b, /ran away — limits\.outputTokens=50: 100 output tokens > 50 \(estimated: chars\/4 of its reply\)/);
    assert.equal(runs(), 2);
    const events = store.readEvents(id);
    const notes = events.filter((e) => e.type === "log" && /prints no usage while it runs/.test(String(e.message)));
    assert.equal(notes.length, 1, "said once per run");
    assert.match(String(notes[0]!.message), /limits: adapter 'chatty' prints no usage while it runs — its agents' outputTokens and costUsd are checked only after each CLI run/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("under expect, a runaway is not a miss to run again: it fails at once", async () => {
  const { root, store, id, runs } = limitsRun(
    "return await agent('work', { limits: { repeat: 2 }, expect: { match: 'never' }, expectRetries: 2 })",
  );
  try {
    assert.equal(await executeRun(store.runDir(id)), "failed");
    assert.equal(runs(), 1);
    const failed = failedOf(store.readEvents(id))[0]!;
    assert.equal(failed.reason, "runaway");
    assert.equal(failed.misses, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a malformed limits option fails that call before anything runs", async () => {
  const { root, store, id, runs } = limitsRun(
    "try { await agent('work', { limits: { loops: 3 } }) } catch (err) { return String(err) }",
  );
  try {
    assert.equal(await executeRun(store.runDir(id)), "done");
    assert.match(String(store.readResult(id)), /AgentError: agent\(\): limits has no limit "loops"; use toolCalls, costUsd, outputTokens, seconds, repeat/);
    assert.equal(runs(), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
