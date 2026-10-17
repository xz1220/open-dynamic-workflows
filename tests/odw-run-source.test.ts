import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

/** A RunStore that records how events.jsonl is read. */
class CountingStore extends RunStore {
  fullReads = 0;
  sinceOffsets: number[] = [];
  runDirCalls = new Map<string, number>();
  override readEvents(runId: string) {
    this.fullReads++;
    return super.readEvents(runId);
  }
  override readEventsSince(runId: string, cursor: { offset: number }) {
    this.sinceOffsets.push(cursor.offset);
    return super.readEventsSince(runId, cursor);
  }
  override runDir(runId: string) {
    this.runDirCalls.set(runId, (this.runDirCalls.get(runId) ?? 0) + 1);
    return super.runDir(runId);
  }
}

const ev = (ts: number, type: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ts, type, ...extra }) + "\n";

test("events are read incrementally: only appended bytes, never the whole file again", () => {
  const root = tempRoot();
  try {
    const store = new CountingStore(root);
    const id = seedRunning(store, process.pid);
    const src = new OdwRunSource(store);
    assert.equal(src.events(id, 0).length, 1);
    src.listSummaries();
    src.detail(id);

    appendFileSync(store.eventsPath(id), ev(2, "phase_started", { phase: "P" }) + ev(3, "log", { message: "m" }));
    assert.deepEqual(src.events(id, 1).map((e) => e.type), ["phase_started", "log"], "?since= is an event index");
    assert.equal(src.eventLog(id).length, 3);
    assert.deepEqual(src.detail(id)!.phaseOrder, ["P"]);
    assert.equal(src.listSummaries()[0]!.lastActivityTs, 3);

    assert.equal(store.fullReads, 0, "the source never re-reads a whole events.jsonl");
    assert.ok(store.sinceOffsets.some((o) => o > 0), "later reads resume from the byte cursor");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a torn final line is left for the next read, then folded exactly once", () => {
  const root = tempRoot();
  try {
    const store = new RunStore(root);
    const id = seedRunning(store, process.pid);
    const src = new OdwRunSource(store);
    const line = ev(2, "agent_finished", { agentId: 1, label: "a" });
    appendFileSync(store.eventsPath(id), line.slice(0, 10)); // mid-append
    assert.equal(src.eventLog(id).length, 1);
    assert.equal(src.listSummaries()[0]!.counts.running, 1);
    appendFileSync(store.eventsPath(id), line.slice(10));
    assert.equal(src.eventLog(id).length, 2);
    assert.deepEqual(src.listSummaries()[0]!.counts, { agents: 1, running: 0, done: 1, failed: 0, stale: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rewritten events.jsonl replaces the cached stream and fold", () => {
  const root = tempRoot();
  try {
    const store = new RunStore(root);
    const id = seedRunning(store, process.pid);
    const src = new OdwRunSource(store);
    appendFileSync(store.eventsPath(id), ev(2, "log", { message: "a" }) + ev(3, "log", { message: "b" }));
    assert.equal(src.eventLog(id).length, 3);
    assert.equal(src.listSummaries()[0]!.counts.agents, 1);
    writeFileSync(store.eventsPath(id), ev(9, "log", { message: "z" }));
    assert.deepEqual(src.eventLog(id).map((e) => e.message), ["z"]);
    assert.equal(src.listSummaries()[0]!.counts.agents, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("finished runs are not re-stat'ed on every list, but are re-checked after a while", () => {
  const root = tempRoot();
  try {
    const store = new CountingStore(root);
    const id = store.create({ script: "/demo/wf.js", args: null, source: "/demo" });
    appendFileSync(store.eventsPath(id), ev(1, "run_started") + ev(2, "run_finished"));
    store.updateStatus(id, { state: "done", name: "demo" });
    let nowMs = 1_000_000;
    const src = new OdwRunSource(store, { now: () => nowMs });
    assert.equal(src.listSummaries()[0]!.state, "done");
    const before = store.runDirCalls.get(id) ?? 0;
    src.listSummaries();
    src.listSummaries();
    assert.equal(store.runDirCalls.get(id) ?? 0, before, "a trusted terminal run costs no file access");

    store.updateStatus(id, { state: "failed" }); // something rewrote a finished run by hand
    assert.equal(src.detail(id)!.state, "failed", "detail always re-checks");
    nowMs += 60_000;
    assert.equal(src.listSummaries()[0]!.state, "failed", "the list catches up once the trust window passes");
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

test("a stop's status lands before its agents settle: the list is not cached until the run's end event", () => {
  const root = tempRoot();
  try {
    const store = new RunStore(root);
    const id = store.create({ script: "/demo/wf.js", args: null, source: "/demo" });
    appendFileSync(store.eventsPath(id), ev(1, "run_started") + ev(2, "agent_started", { agentId: 1, label: "a" }));
    store.updateStatus(id, { state: "running", pid: process.pid, name: "demo" });
    let nowMs = 1_000_000;
    const src = new OdwRunSource(store, { now: () => nowMs });
    assert.equal(src.listSummaries()[0]!.counts.running, 1);
    // The worker records "stopped" at its checkpoint first …
    store.updateStatus(id, { state: "stopped" });
    assert.equal(src.listSummaries()[0]!.state, "stopped");
    // … and only then do the aborted agents' failures and the run's end event land.
    nowMs += 100;
    appendFileSync(store.eventsPath(id), ev(3, "agent_failed", { agentId: 1, label: "a", error: "stopped" }) + ev(4, "run_stopped"));
    const s = src.listSummaries()[0]!;
    assert.equal(s.counts.running, 0, "the list shows the agents settled at once, not after a trust window");
    assert.equal(s.counts.failed, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
