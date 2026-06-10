import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";

import { RunStore } from "../src/runtime/run-store.js";
import { executeRun } from "../src/runtime/worker.js";

// Nested workflow() — Claude Code parity, one level deep. The child shares the
// parent's scheduler (concurrency + agent counter), budget tally, and event
// sink; its phases appear as `▸ <name> · <phase>` lanes.

function setup() {
  const root = mkdtempSync(join(tmpdir(), "odw-nest-"));
  const wfDir = join(root, ".odw", "workflows");
  mkdirSync(wfDir, { recursive: true });
  return { root, wfDir, store: new RunStore(join(root, "runs")) };
}

function mockConfig(root: string, extra: Record<string, unknown> = {}): string {
  const path = join(root, "odw.config.json");
  writeFileSync(
    path,
    JSON.stringify({
      defaultAdapter: "mock",
      workspaceMode: "inplace",
      adapters: {
        mock: {
          command: [
            execPath,
            "-e",
            "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write('reply:'+d.length))",
          ],
          stdin: "{prompt}",
        },
      },
      ...extra,
    }),
  );
  return path;
}

test("workflow('name') runs a child from <source>/.odw/workflows and returns its result", async () => {
  const { root, wfDir, store } = setup();
  try {
    writeFileSync(
      join(wfDir, "child.js"),
      "export const meta = { name: 'child', description: 'd', phases: [{ title: 'Work' }] }\n" +
        "phase('Work')\nreturn { doubled: args.n * 2 }\n",
    );
    const parent = join(root, "parent.js");
    writeFileSync(
      parent,
      "export const meta = { name: 'parent', description: 'd' }\n" +
        "const r = await workflow('child', { n: 4 })\nreturn r.doubled\n",
    );
    const id = store.create({ script: parent, args: null, source: root });
    const state = await executeRun(store.runDir(id));
    assert.equal(state, "done");
    assert.equal(store.readResult(id), 8);
    // Child phases are namespaced lanes in the parent's event stream.
    const phases = store.readEvents(id).filter((e) => e.type === "phase_started");
    assert.ok(phases.some((e) => e.phase === "▸ child · Work"), `got: ${JSON.stringify(phases)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow({ scriptPath }) resolves relative to the run's source", async () => {
  const { root, store } = setup();
  try {
    writeFileSync(
      join(root, "sub.js"),
      "export const meta = { name: 'sub', description: 'd' }\nreturn 'from-sub'\n",
    );
    const parent = join(root, "parent.js");
    writeFileSync(
      parent,
      "export const meta = { name: 'parent', description: 'd' }\n" +
        "return await workflow({ scriptPath: './sub.js' })\n",
    );
    const id = store.create({ script: parent, args: null, source: root });
    assert.equal(await executeRun(store.runDir(id)), "done");
    assert.equal(store.readResult(id), "from-sub");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow() inside a child throws — nesting is one level", async () => {
  const { root, wfDir, store } = setup();
  try {
    writeFileSync(
      join(wfDir, "grandchild.js"),
      "export const meta = { name: 'grandchild', description: 'd' }\nreturn 1\n",
    );
    writeFileSync(
      join(wfDir, "child.js"),
      "export const meta = { name: 'child', description: 'd' }\nreturn await workflow('grandchild')\n",
    );
    const parent = join(root, "parent.js");
    writeFileSync(
      parent,
      "export const meta = { name: 'parent', description: 'd' }\nreturn await workflow('child')\n",
    );
    const id = store.create({ script: parent, args: null, source: root });
    assert.equal(await executeRun(store.runDir(id)), "failed");
    assert.match(String(store.readError(id)?.error), /one level/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workflow() with an unknown name fails the run with the resolver's error", async () => {
  const { root, store } = setup();
  try {
    const parent = join(root, "parent.js");
    writeFileSync(
      parent,
      "export const meta = { name: 'parent', description: 'd' }\nreturn await workflow('ghost')\n",
    );
    const id = store.create({ script: parent, args: null, source: root });
    assert.equal(await executeRun(store.runDir(id)), "failed");
    assert.match(String(store.readError(id)?.error), /no workflow named 'ghost'/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a child's agent dispatches count against the parent's maxAgents cap", async () => {
  const { root, wfDir, store } = setup();
  try {
    const configPath = mockConfig(root, { maxAgents: 2 });
    writeFileSync(
      join(wfDir, "fanout.js"),
      "export const meta = { name: 'fanout', description: 'd' }\n" +
        "return await parallel([() => agent('a'), () => agent('b')])\n",
    );
    const parent = join(root, "parent.js");
    writeFileSync(
      parent,
      "export const meta = { name: 'parent', description: 'd' }\n" +
        "await agent('first')\n" + // 1 of 2
        "return await workflow('fanout')\n", // child needs 2 more → cap exceeded
    );
    const id = store.create({ script: parent, args: null, source: root, configPath });
    assert.equal(await executeRun(store.runDir(id)), "failed");
    assert.match(String(store.readError(id)?.error), /cap of 2 agent dispatches/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- budget accounting ---------------------------------------------------------

test("budget.spent() grows with agent output and remaining() shrinks", async () => {
  const { root, store } = setup();
  try {
    const configPath = mockConfig(root);
    const wf = join(root, "wf.js");
    writeFileSync(
      wf,
      "export const meta = { name: 'wf', description: 'd' }\n" +
        "const before = budget.spent()\n" +
        "await agent('hello')\n" +
        "return { before, after: budget.spent(), remaining: budget.remaining(), total: budget.total }\n",
    );
    const id = store.create({ script: wf, args: null, source: root, configPath, budgetTotal: 1000 });
    assert.equal(await executeRun(store.runDir(id)), "done");
    const r = store.readResult(id) as { before: number; after: number; remaining: number; total: number };
    assert.equal(r.before, 0);
    assert.ok(r.after > 0, "spent() reflects the agent's reply");
    assert.equal(r.total, 1000);
    assert.equal(r.remaining, 1000 - r.after);
    // The terminal status records the tally for observers.
    assert.ok((store.readStatus(id).spentTokens as number) > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the budget ceiling aborts the run before the next dispatch", async () => {
  const { root, store } = setup();
  try {
    const configPath = mockConfig(root);
    const wf = join(root, "wf.js");
    // The mock reply is long enough that one call exceeds a 1-token budget.
    writeFileSync(
      wf,
      "export const meta = { name: 'wf', description: 'd' }\n" +
        "await agent('one')\n" +
        "await agent('two')\n" + // must never dispatch
        "return 'unreachable'\n",
    );
    const id = store.create({ script: wf, args: null, source: root, configPath, budgetTotal: 1 });
    assert.equal(await executeRun(store.runDir(id)), "failed");
    assert.match(String(store.readError(id)?.error), /budget ceiling/);
    const started = store.readEvents(id).filter((e) => e.type === "agent_started");
    assert.equal(started.length, 1, "the second agent never starts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
