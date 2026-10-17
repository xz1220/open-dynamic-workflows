import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OdwRunSource } from "../src/runtime/odw-run-source.js";
import { RunStore } from "../src/runtime/run-store.js";

// These tests deliberately reuse ONE source across a state change: the summary
// cache is per instance, and a fresh source per assertion would hide staleness
// bugs in it.

const tempRoot = () => mkdtempSync(join(tmpdir(), "odw-src-"));

/** A long-lived child process standing in for a detached worker. */
function fakeWorker(): ChildProcess {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
}

function killAndWait(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGKILL");
  });
}

function seedRunning(store: RunStore, pid: number): string {
  const id = store.create({ script: "/demo/wf.js", args: null, source: "/demo" });
  store.updateStatus(id, { state: "running", pid, name: "demo" });
  appendFileSync(store.eventsPath(id), JSON.stringify({ ts: 1, type: "agent_started", agentId: 1, label: "a" }) + "\n");
  return id;
}

test("a cached summary turns stale when its worker is killed (no file changes)", async () => {
  const root = tempRoot();
  const worker = fakeWorker();
  try {
    const store = new RunStore(root);
    const id = seedRunning(store, worker.pid!);
    const src = new OdwRunSource(store);

    const before = src.listSummaries().find((r) => r.runId === id)!;
    assert.equal(before.state, "running");
    assert.deepEqual(before.counts, { agents: 1, running: 1, done: 0, failed: 0, stale: 0 });

    await killAndWait(worker); // kill -9: the worker never writes its terminal state

    const after = src.listSummaries().find((r) => r.runId === id)!;
    assert.equal(after.state, "stale", "the list must agree with detail(), not a cached 'running'");
    assert.equal(after.stale, true);
    assert.deepEqual(after.counts, { agents: 1, running: 0, done: 0, failed: 0, stale: 1 });
    assert.equal(src.detail(id)!.state, "stale");
    assert.equal(src.detail(id)!.agents[0]!.state, "stale");
  } finally {
    worker.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("a cached summary picks up appended events and status changes", () => {
  const root = tempRoot();
  try {
    const store = new RunStore(root);
    const id = seedRunning(store, process.pid);
    const src = new OdwRunSource(store);
    assert.equal(src.listSummaries()[0]!.counts.running, 1);

    appendFileSync(store.eventsPath(id), JSON.stringify({ ts: 2, type: "agent_finished", agentId: 1, label: "a" }) + "\n");
    assert.deepEqual(src.listSummaries()[0]!.counts, { agents: 1, running: 0, done: 1, failed: 0, stale: 0 });

    store.updateStatus(id, { state: "done" });
    assert.equal(src.listSummaries()[0]!.state, "done");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cached facts never leak: mutating a returned detail does not corrupt the cache", () => {
  const root = tempRoot();
  try {
    const store = new RunStore(root);
    const id = seedRunning(store, process.pid);
    const src = new OdwRunSource(store);
    src.listSummaries();
    src.detail(id)!.agents[0]!.state = "failed";
    assert.equal(src.detail(id)!.agents[0]!.state, "running");
    assert.equal(src.listSummaries()[0]!.counts.running, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
