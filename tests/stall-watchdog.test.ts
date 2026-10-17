import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";

import { RunStore } from "../src/runtime/run-store.js";
import { executeRun } from "../src/runtime/worker.js";

// The stall watchdog end to end: worker → scheduler → bridge → the real runner,
// with a mock CLI that hangs without a word on its first `silentRuns`
// invocations (counted in a file) and answers on the next one.

function flakyAgent(counter: string, silentRuns: number): string[] {
  const file = JSON.stringify(counter);
  return [
    execPath,
    "-e",
    `const fs = require('fs'); const n = fs.existsSync(${file}) ? Number(fs.readFileSync(${file}, 'utf8')) : 0;` +
      `fs.writeFileSync(${file}, String(n + 1));` +
      `if (n < ${silentRuns}) setTimeout(() => {}, 30000); else process.stdout.write('answered on run ' + (n + 1));`,
  ];
}

function stallRun(silentRuns: number) {
  const root = mkdtempSync(join(tmpdir(), "odw-stall-"));
  const counter = join(root, "invocations");
  const configPath = join(root, "odw.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      defaultAdapter: "flaky",
      // stallRestarts is left at its default (1).
      adapters: { flaky: { command: flakyAgent(counter, silentRuns), stallTimeout: 1 } },
    }),
  );
  const script = join(root, "wf.js");
  writeFileSync(
    script,
    "export const meta = { name: 'wf', description: 'd' }\nreturn await agent('work', { label: 'search' })",
  );
  const store = new RunStore(join(root, "runs"));
  const id = store.create({ script, args: null, source: root, configPath });
  const invocations = () => Number(readFileSync(counter, "utf8"));
  return { root, store, id, invocations };
}

test("a CLI that goes quiet is killed and restarted, and the run says so", async () => {
  const { root, store, id, invocations } = stallRun(1);
  try {
    assert.equal(await executeRun(store.runDir(id)), "done");
    assert.equal(store.readResult(id), "answered on run 2");
    assert.equal(invocations(), 2);
    const events = store.readEvents(id);
    const restarts = events.filter((e) => e.type === "log" && /went quiet/.test(String(e.message)));
    assert.equal(restarts.length, 1);
    assert.equal(restarts[0]!.message, "search:1 went quiet for 1s — restarting (1/1)");
    assert.equal(restarts[0]!.agentId, 1);
    assert.equal(events.filter((e) => e.type === "agent_finished").length, 1, "still one agent, not two");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an agent that stalls past its restarts fails with a stall error", async () => {
  const { root, store, id, invocations } = stallRun(5);
  try {
    assert.equal(await executeRun(store.runDir(id)), "failed");
    assert.equal(invocations(), 2, "one run plus stallRestarts (1) restart");
    const error = String(store.readError(id)?.error);
    assert.match(error, /adapter 'flaky' stalled — no output for 1s, and again after 1 restart/);
    const failed = store.readEvents(id).filter((e) => e.type === "agent_failed");
    assert.equal(failed.length, 1);
    assert.match(String(failed[0]!.error), /AdapterExecutionError: adapter 'flaky' stalled/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
