import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";

import { defaultConfig } from "../src/adapters/config.js";
import type { CliResult } from "../src/adapters/types.js";
import { Bridge } from "../src/bridge.js";
import { buildContext } from "../src/context.js";
import { AdapterExecutionError } from "../src/errors.js";
import { AGENT_FAILED, LOG, MemorySink } from "../src/events.js";
import { createPrimitives } from "../src/primitives.js";
import { formatEvent } from "../src/runtime/live-view.js";
import { RunStore } from "../src/runtime/run-store.js";
import { detail } from "../src/runtime/runs-view.js";
import { startServer } from "../src/runtime/server.js";
import { executeRun } from "../src/runtime/worker.js";

// Failure classes from the run's point of view: what agent() tells observers
// (LOG events, agent_failed's reason) and, end to end through the worker with
// mock CLIs, that a rate limit is ridden out, a stop cuts the wait short, and a
// spent quota fails its adapter's agents without failing the run.

function failing(stderr: string): CliResult {
  return { returncode: 1, stdout: "", stderr, timedOut: false, duration: 0.1 };
}

const ok = (stdout: string): CliResult => ({ returncode: 0, stdout, stderr: "", timedOut: false, duration: 0.1 });

/** A run context whose bridge runs `runner` and waits out its backoffs on a fake clock. */
function limitedContext(runner: () => Promise<CliResult>) {
  const config = defaultConfig();
  config.settings.defaultAdapter = "codex";
  const sink = new MemorySink();
  const ctx = buildContext(config, { sink });
  const slept: number[] = [];
  ctx.bridge = new Bridge(config, { runner, sleep: async (ms) => void slept.push(ms), random: () => 0 });
  return { primitives: createPrimitives(ctx), sink, slept };
}

test("agent() logs each rate-limit wait: who, on which adapter, how long, which retry", async () => {
  const replies = [
    ok("warm"),
    ok("warm"),
    failing("ERROR: exceeded retry limit, last status: 429 Too Many Requests"),
    failing("Rate limit reached for gpt-5. Please try again in 45s."),
    ok("found it"),
  ];
  const { primitives, sink, slept } = limitedContext(async () => replies.shift()!);
  await primitives.agent("warm up", { label: "a" });
  await primitives.agent("warm up", { label: "b" });
  assert.equal(await primitives.agent("look it up", { label: "search" }), "found it");
  // Only the retry lines: on a machine with spare CPUs the adaptive back-pressure
  // also logs that it lowered codex's cap (asserted in tests/throttle.test.ts).
  assert.deepEqual(
    sink
      .ofType(LOG)
      .filter((e) => /— retrying in/.test(String(e.message)))
      .map((e) => [e.message, e.agentId, e.label, e.retry]),
    [
      ["search:3 hit a rate limit on codex — retrying in 15s (1/3)", 3, "search", { reason: "rate_limit", n: 1, of: 3, waitSeconds: 15 }],
      ["search:3 hit a rate limit on codex — retrying in 45s (2/3)", 3, "search", { reason: "rate_limit", n: 2, of: 3, waitSeconds: 45 }],
    ],
  );
  assert.deepEqual(slept, [15_000, 45_000], "exponential first; then the 45s the CLI asked for");
  assert.equal(sink.ofType(AGENT_FAILED).length, 0);
});

test("agent_failed carries the failure class, and retryAfter when the CLI said", async () => {
  const replies = [
    failing("You've hit your usage limit. Upgrade to Pro or try again in 3h 22m."),
    failing("fatal: something else entirely"),
  ];
  const { primitives, sink } = limitedContext(async () => replies.shift()!);
  await assert.rejects(() => primitives.agent("one", { label: "q" }), AdapterExecutionError);
  await assert.rejects(() => primitives.agent("two", { label: "x" }), AdapterExecutionError);
  const [quota, other] = sink.ofType(AGENT_FAILED);
  assert.equal(quota!.reason, "quota");
  assert.equal(quota!.retryAfter, 12_120);
  assert.match(String(quota!.error), /ran out of usage quota — wait for the window to reset \(in 3h 22m\)/);
  assert.equal(other!.reason, "exit");
  assert.equal("retryAfter" in other!, false, "no retryAfter when the CLI did not say");
});

test("the third quota failure in a row on an adapter logs one warning", async () => {
  const { primitives, sink } = limitedContext(async () => failing("Credit balance is too low"));
  for (const label of ["a", "b", "c", "d"]) {
    await assert.rejects(() => primitives.agent(label, { label }), AdapterExecutionError);
  }
  const warnings = sink.ofType(LOG);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]!.adapter, "codex");
  assert.equal(warnings[0]!.reason, "quota");
  assert.match(String(warnings[0]!.message), /^warning: 3 agents in a row failed on adapter 'codex' \(usage quota\)/);
});

// --- end to end: the worker, the scheduler, the bridge, real mock CLIs ---------

/**
 * A mock CLI that prints `stderr` and exits 1 on its first `limitedRuns`
 * invocations, then answers. Each invocation appends one byte to `counter`
 * (an O_APPEND write, so concurrent agents never lose a count): the file's
 * length is the number of invocations.
 */
function limitedAgent(counter: string, limitedRuns: number, stderr: string): string[] {
  const file = JSON.stringify(counter);
  return [
    execPath,
    "-e",
    `const fs = require('fs'); fs.appendFileSync(${file}, '.'); const n = fs.statSync(${file}).size - 1;` +
      `if (n < ${limitedRuns}) { process.stderr.write(${JSON.stringify(stderr)}); process.exit(1); }` +
      `process.stdout.write('answered on run ' + (n + 1));`,
  ];
}

function setupRun(adapters: Record<string, unknown>, body: string, settings: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "odw-limits-"));
  const configPath = join(root, "odw.config.json");
  writeFileSync(configPath, JSON.stringify({ ...settings, adapters }));
  const script = join(root, "wf.js");
  writeFileSync(script, `export const meta = { name: 'wf', description: 'd' }\n${body}`);
  const store = new RunStore(join(root, "runs"));
  const id = store.create({ script, args: null, source: root, configPath });
  return { root, store, id };
}

async function waitUntil(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

test("a CLI rate-limited twice and then answering finishes the run, every wait logged", async () => {
  const root0 = mkdtempSync(join(tmpdir(), "odw-limits-counter-"));
  const counter = join(root0, "invocations");
  const { root, store, id } = setupRun(
    { flaky: { command: limitedAgent(counter, 2, "Error: 429 Too Many Requests. Please retry after 0.05s\n") } },
    "return await agent('work', { label: 'search' })",
    { defaultAdapter: "flaky" },
  );
  try {
    const started = Date.now();
    assert.equal(await executeRun(store.runDir(id)), "done");
    assert.ok(Date.now() - started < 15_000, "the waits honored the CLI's 0.05s retry-after");
    assert.equal(store.readResult(id), "answered on run 3");
    assert.equal(readFileSync(counter, "utf8").length, 3, "two rate-limited runs, then the answer");
    const events = store.readEvents(id);
    assert.deepEqual(
      events.filter((e) => e.type === "log" && /— retrying in/.test(String(e.message))).map((e) => e.message),
      [
        "search:1 hit a rate limit on flaky — retrying in 0.1s (1/3)",
        "search:1 hit a rate limit on flaky — retrying in 0.1s (2/3)",
      ],
    );
    assert.equal(events.filter((e) => e.type === "agent_started").length, 1, "still one agent, not three");
    assert.equal(events.filter((e) => e.type === "agent_finished").length, 1);
    assert.equal(events.filter((e) => e.type === "agent_failed").length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(root0, { recursive: true, force: true });
  }
});

test("a stop during a rate-limit backoff ends the run promptly", async () => {
  const root0 = mkdtempSync(join(tmpdir(), "odw-limits-counter-"));
  const counter = join(root0, "invocations");
  const { root, store, id } = setupRun(
    { busy: { command: limitedAgent(counter, 99, "429 Too Many Requests; retry after 120s\n") } },
    "return await agent('work', { label: 'search' })",
    { defaultAdapter: "busy" },
  );
  try {
    const run = executeRun(store.runDir(id));
    const waiting = () => store.readEvents(id).some((e) => e.type === "log" && /retrying in 2m/.test(String(e.message)));
    assert.ok(await waitUntil(waiting, 10_000), "the agent should be waiting out the rate limit");
    const stopped = Date.now();
    store.writeControl(id, "stop");
    assert.equal(await run, "stopped");
    assert.ok(Date.now() - stopped < 5000, `the stop cut the 2-minute wait short (${Date.now() - stopped}ms)`);
    assert.equal(readFileSync(counter, "utf8").length, 1, "no retry after the stop");
    const [failed] = store.readEvents(id).filter((e) => e.type === "agent_failed");
    assert.match(String(failed!.error), /RunStopped/);
    assert.equal(failed!.reason, undefined, "a stop is not a CLI failure class");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(root0, { recursive: true, force: true });
  }
});

test("a spent quota fails that adapter's agents, not the run; observers see why", async () => {
  const root0 = mkdtempSync(join(tmpdir(), "odw-limits-counter-"));
  const counter = join(root0, "invocations");
  const { root, store, id } = setupRun(
    {
      out: { command: limitedAgent(counter, 99, "You've hit your usage limit. Upgrade to Pro or try again in 3h 22m.\n") },
      fine: { command: [execPath, "-e", "process.stdout.write('fine answer')"] },
    },
    "return await parallel([1, 2, 3].map((n) => () => agent('task ' + n, { adapter: 'out', label: 'q' + n }))" +
      ".concat([() => agent('task 4', { adapter: 'fine', label: 'ok' })]))",
    { concurrency: 2 },
  );
  const handle = await startServer({ store, port: 0, host: "127.0.0.1", claudeProjectsRoot: join(root, "no-claude") });
  try {
    assert.equal(await executeRun(store.runDir(id)), "done", "other adapters may be fine: the run goes on");
    assert.deepEqual(store.readResult(id), [null, null, null, "fine answer"]);
    assert.equal(readFileSync(counter, "utf8").length, 3, "a spent quota is never retried");

    const events = store.readEvents(id);
    const failed = events.filter((e) => e.type === "agent_failed");
    assert.equal(failed.length, 3);
    for (const e of failed) {
      assert.equal(e.reason, "quota");
      assert.equal(e.retryAfter, 12_120);
      assert.match(formatEvent(e), /— \[quota, retry after 3h 22m\] AdapterExecutionError: adapter 'out' ran out of usage quota/);
    }
    const warnings = events.filter((e) => e.type === "log" && /^warning:/.test(String(e.message)));
    assert.equal(warnings.length, 1, "one clear warning, not one per agent");
    assert.match(String(warnings[0]!.message), /3 agents in a row failed on adapter 'out' \(usage quota\)/);

    const folded = detail(store, id).agents;
    assert.deepEqual(
      folded.map((a) => [a.label, a.state, a.failureReason]).sort(),
      [
        ["ok", "done", undefined],
        ["q1", "failed", "quota"],
        ["q2", "failed", "quota"],
        ["q3", "failed", "quota"],
      ],
    );
    const api = await fetch(`${handle.url}/api/runs/${id}`).then((r) => r.json());
    assert.deepEqual(
      api.agents.map((a: { label: string; failureReason?: string }) => [a.label, a.failureReason ?? null]).sort(),
      [
        ["ok", null],
        ["q1", "quota"],
        ["q2", "quota"],
        ["q3", "quota"],
      ],
    );
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(root0, { recursive: true, force: true });
  }
});
