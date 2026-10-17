import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WorkflowEvent } from "../src/events.js";
import { activityView } from "../src/runtime/activity-view.js";
import { attachRun, formatEvent } from "../src/runtime/live-view.js";
import { RunStore } from "../src/runtime/run-store.js";
import type { RunSource } from "../src/runtime/run-source.js";
import { countAgents, detail, foldAgents, summarize, type RunSummary } from "../src/runtime/runs-view.js";
import { FakeTerm } from "./fake-term.js";

// exec(): a managed command step that launches no model (issue #31, ODW extension).

// --- read models: fold, counts, activity ----------------------------------------------

const cmd = (type: string, commandId: number, ts: number, extra: Record<string, unknown> = {}): WorkflowEvent => ({
  ts,
  type,
  commandId,
  label: "npm test",
  phase: "Test",
  command: "npm test",
  ...extra,
});

test("command events fold into kind: 'command' nodes, counted with the agents", () => {
  const nodes = foldAgents([
    { ts: 1, type: "phase_started", phase: "Test" },
    cmd("command_started", 1, 1),
    { ts: 1.5, type: "agent_started", agentId: 1, label: "fixer", phase: "Fix", adapter: "mock" },
    cmd("command_failed", 1, 3, { exitCode: 1, durationMs: 1987, error: "exited with code 1" }),
    { ts: 4, type: "agent_finished", agentId: 1, label: "fixer", phase: "Fix", adapter: "mock", attempts: 1 },
    cmd("command_started", 2, 5),
    cmd("command_finished", 2, 6, { exitCode: 0, durationMs: 1000 }),
    cmd("command_started", 3, 7, { label: "lint", command: "npm run lint" }),
  ]);
  assert.deepEqual(
    nodes.map((n) => [n.kind, n.label, n.state, n.exitCode]),
    [
      ["command", "npm test", "failed", 1],
      ["agent", "fixer", "done", undefined],
      ["command", "npm test", "done", 0],
      ["command", "lint", "running", null],
    ],
  );
  const [first, agent, second] = nodes as [(typeof nodes)[0], (typeof nodes)[0], (typeof nodes)[0]];
  assert.equal(first.durationMs, 1987, "the command's own measurement wins over the timestamps");
  assert.equal(first.error, "exited with code 1");
  assert.deepEqual([first.agentId, first.commandId, first.adapter, first.attempts], [null, 1, null, null]);
  assert.equal(second.error, null);
  assert.equal(agent.agentId, 1);
  assert.equal(agent.commandId, undefined, "agents carry no command fields");
  assert.deepEqual(countAgents(nodes), { agents: 4, running: 1, done: 2, failed: 1, stale: 0 });
});

test("legacy agent events never settle a command node with the same label", () => {
  const nodes = foldAgents([
    cmd("command_started", 1, 1, { label: "build" }),
    { ts: 2, type: "agent_started", label: "build", phase: "Test" },
    { ts: 3, type: "agent_finished", label: "build", phase: "Test", adapter: "x", attempts: 1 },
  ]);
  assert.deepEqual(
    nodes.map((n) => [n.kind, n.state]),
    [
      ["command", "running"],
      ["agent", "done"],
    ],
  );
});

test("run summaries count command nodes; a dead worker leaves open commands stale", () => {
  const root = mkdtempSync(join(tmpdir(), "odw-exec-view-"));
  try {
    const store = new RunStore(root);
    const id = store.create({ script: "wf.js", args: null, source: root });
    store.updateStatus(id, { state: "running" }); // no pid: the worker is gone
    for (const ev of [
      cmd("command_started", 1, 1),
      cmd("command_finished", 1, 2, { exitCode: 0, durationMs: 900 }),
      cmd("command_started", 2, 3),
    ]) {
      appendFileSync(store.eventsPath(id), JSON.stringify(ev) + "\n");
    }
    const s = summarize(store, id);
    assert.equal(s.state, "stale");
    assert.deepEqual(s.counts, { agents: 2, running: 0, done: 1, failed: 0, stale: 1 });
    assert.equal(s.progress, 0.5);
    assert.deepEqual(
      detail(store, id).agents.map((a) => [a.kind, a.state, a.exitCode]),
      [
        ["command", "done", 0],
        ["command", "stale", null],
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the activity fleet counts running agents only, not running commands", () => {
  const nodes = foldAgents([
    { ts: 1, type: "agent_started", agentId: 1, label: "a", adapter: "codex" },
    cmd("command_started", 1, 1),
  ]);
  const run = { runId: "r1", name: "wf", state: "running", provider: "odw", counts: countAgents(nodes) } as RunSummary;
  const source = {
    owns: () => true,
    eventLog: () => [],
    detail: () => ({ agents: nodes }),
  } as unknown as RunSource;
  assert.deepEqual(activityView([source], [run], 10).fleet, { codex: 1 });
});

// --- CLI: odw logs and the live view -------------------------------------------------------

test("odw logs narrates command steps: what ran, then how it ended", () => {
  const line = (ev: WorkflowEvent) => formatEvent(ev).replace(/^\[[^\]]*\] /, "");
  assert.equal(line(cmd("command_started", 1, 1)), "command_started (Test) $ npm test");
  assert.equal(
    line(cmd("command_started", 2, 1, { label: "tests r2", command: "npm test -- --bail" })),
    "command_started (Test) tests r2 — $ npm test -- --bail",
  );
  assert.equal(
    line(cmd("command_finished", 1, 2, { exitCode: 0, durationMs: 3200 })),
    "command_finished (Test) $ npm test — exit 0 (3.2s)",
  );
  assert.equal(
    line(cmd("command_failed", 2, 2, { label: "tests r2", exitCode: null, durationMs: 600_000, error: "timed out after 600s" })),
    "command_failed  (Test) tests r2 — timed out after 600s (10:00)",
  );
  // A default label is the command clipped: shown once, in full.
  const long = "npm run test -- --reporter=dot --coverage --maxWorkers=2";
  assert.equal(
    line(cmd("command_started", 3, 1, { label: long.slice(0, 39) + "…", command: long })),
    `command_started (Test) $ ${long}`,
  );
});

test("attachRun (live): command steps settle with a $ prompt and their failure reason", async () => {
  const store = new RunStore(mkdtempSync(join(tmpdir(), "odw-exec-live-")));
  try {
    const runId = store.create({ script: "/tmp/never-read/wf.js", args: null, source: process.cwd(), workflowName: "loop" });
    store.updateStatus(runId, { state: "running", pid: process.pid, name: "loop" });
    for (const ev of [
      { ts: 100, type: "run_started", runId },
      { ts: 100, type: "phase_started", phase: "Test" },
      cmd("command_started", 1, 100),
      cmd("command_failed", 1, 102, { exitCode: 1, durationMs: 2000, error: "exited with code 1" }),
      { ts: 102, type: "agent_started", agentId: 1, label: "fixer", phase: "Test", adapter: "fake" },
      { ts: 110, type: "agent_finished", agentId: 1, label: "fixer", phase: "Test", adapter: "fake", attempts: 1 },
      cmd("command_started", 2, 110),
      cmd("command_finished", 2, 111, { exitCode: 0, durationMs: 1000 }),
      { ts: 111, type: "run_finished", runId },
    ]) {
      appendFileSync(store.eventsPath(runId), JSON.stringify(ev) + "\n");
    }
    store.writeResult(runId, { passed: true });
    store.updateStatus(runId, { state: "done" });

    const term = new FakeTerm(100);
    const out = { text: "", isTTY: false, write(s: string) { this.text += s; } };
    const env = { TERM: "xterm", LANG: "en_US.UTF-8" };
    assert.equal(await attachRun(store, runId, { out, err: term, live: true, pollMs: 10, signals: false, env }), 0);
    const screen = term.text();
    assert.match(screen, /✖ \$ npm test\s+2\.0s\n\s+exited with code 1/);
    assert.match(screen, /✔ fixer/);
    assert.match(screen, /✔ \$ npm test\s+1\.0s/);
    assert.match(screen, /✔ done\s+.*1 agents.*2 commands/);
    assert.deepEqual(JSON.parse(out.text), { passed: true });
  } finally {
    rmSync(store.root, { recursive: true, force: true });
  }
});
