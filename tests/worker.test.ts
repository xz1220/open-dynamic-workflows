import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";

import { startRunFromSource, waitFor } from "../src/runtime/launcher.js";
import { RunStore, TERMINAL_STATES } from "../src/runtime/run-store.js";
import { executeRun } from "../src/runtime/worker.js";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "odw-wt-"));
  return { root, store: new RunStore(root) };
}

test("executeRun runs a no-agent workflow to done with a result", async () => {
  const { root, store } = setup();
  try {
    const script = join(root, "wf.js");
    writeFileSync(
      script,
      "export const meta = { name: 't', description: 'd' }\nlog('hi')\nreturn { ok: args.n + 1 }",
    );
    const id = store.create({ script, args: { n: 41 }, source: root });
    const state = await executeRun(store.runDir(id));
    assert.equal(state, "done");
    assert.equal(store.readStatus(id).state, "done");
    assert.deepEqual(store.readResult(id), { ok: 42 });
    assert.equal(store.readStatus(id).name, "t");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("executeRun captures a thrown workflow as failed", async () => {
  const { root, store } = setup();
  try {
    const script = join(root, "boom.js");
    writeFileSync(script, "export const meta = { name: 'b', description: 'd' }\nthrow new Error('kaboom')");
    const id = store.create({ script, args: null, source: root });
    const state = await executeRun(store.runDir(id));
    assert.equal(state, "failed");
    assert.match(String(store.readError(id)?.error), /kaboom/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("executeRun drives a real agent call through a mock adapter", async () => {
  const { root, store } = setup();
  try {
    const config = join(root, "odw.config.json");
    writeFileSync(
      config,
      JSON.stringify({
        defaultAdapter: "mock",
        workspaceMode: "inplace",
        adapters: {
          mock: {
            command: [
              execPath,
              "-e",
              "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write('echo:'+d))",
            ],
            stdin: "{prompt}",
          },
        },
      }),
    );
    const script = join(root, "agentwf.js");
    writeFileSync(
      script,
      "export const meta = { name: 'a', description: 'd' }\nconst r = await agent('PING')\nreturn r",
    );
    const id = store.create({ script, args: null, source: root, configPath: config });
    const state = await executeRun(store.runDir(id));
    assert.equal(state, "done");
    const r = String(store.readResult(id));
    assert.match(r, /echo:/);
    assert.match(r, /PING/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("executeRun logs a meta.name / filename divergence as an event", async () => {
  const { root, store } = setup();
  try {
    const script = join(root, "ai-news.js"); // stem 'ai-news' ≠ meta.name
    writeFileSync(script, "export const meta = { name: 'ai-news-v2', description: 'd' }\nreturn 1");
    const id = store.create({ script, args: null, source: root });
    await executeRun(store.runDir(id));
    const logs = store.readEvents(id).filter((e) => e.type === "log");
    assert.ok(
      logs.some((e) => /declares meta\.name 'ai-news-v2'/.test(String(e.message))),
      "divergence note should be emitted through the event stream",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an agent that fails before the script awaits it does not crash the worker", async () => {
  const { root, store } = setup();
  try {
    const config = join(root, "odw.config.json");
    writeFileSync(
      config,
      JSON.stringify({
        defaultAdapter: "mock",
        adapters: { mock: { command: [execPath, "-e", "setTimeout(() => process.stdout.write('ok'), 100)"] } },
      }),
    );
    const script = join(root, "wf.js");
    // The review's reproduction: the early call fails while `agent('b')` runs.
    writeFileSync(
      script,
      "export const meta = { name: 'wf', description: 'd' }\n" +
        "const early = agent('a', { adapter: 'bad' })\n" +
        "await agent('b')\n" +
        "try { await early } catch {}\n" +
        "return 'finished'\n",
    );
    const id = store.create({ script, args: null, source: root, configPath: config });
    const state = await executeRun(store.runDir(id));
    assert.ok(TERMINAL_STATES.has(state), `unexpected state ${state}`);
    assert.equal(store.readStatus(id).state, state, "the outcome is recorded, not stuck at running");
    assert.equal(store.readEvents(id).filter((e) => e.type === "agent_finished").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stray rejection or exception fails the run instead of killing the worker", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-crash-"));
  try {
    const cases: Array<[string, RegExp]> = [
      [
        "Promise.reject(new Error('stray'))\nawait new Promise((r) => setTimeout(r, 200))\nreturn 1",
        /crashed with an unhandled promise rejection: stray/,
      ],
      [
        "setTimeout(() => { throw new Error('timer boom') }, 0)\nawait new Promise((r) => setTimeout(r, 200))\nreturn 1",
        /crashed with an uncaught exception: timer boom/,
      ],
    ];
    for (const [body, expected] of cases) {
      // A real worker process: the guard is process-wide, and this test
      // process has listeners of its own.
      const { runId, store } = startRunFromSource(`export const meta = { name: 'crash', description: 'd' }\n${body}`, {
        runsRoot: root,
      });
      const status = await waitFor(store, runId, { timeoutMs: 20_000, pollIntervalMs: 50 });
      assert.equal(status.state, "failed", JSON.stringify(status));
      assert.equal(store.readStatus(runId).state, "failed", "the worker recorded it itself");
      assert.match(String(store.readError(runId)?.error), expected);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("executeRun stays quiet when meta.name matches the filename stem", async () => {
  const { root, store } = setup();
  try {
    const script = join(root, "match.js");
    writeFileSync(script, "export const meta = { name: 'match', description: 'd' }\nreturn 1");
    const id = store.create({ script, args: null, source: root });
    await executeRun(store.runDir(id));
    const logs = store.readEvents(id).filter((e) => e.type === "log");
    assert.equal(
      logs.some((e) => /declares meta\.name/.test(String(e.message))),
      false,
      "no divergence note when name === stem",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
