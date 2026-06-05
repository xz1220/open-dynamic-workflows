import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonlSink, RunStore } from "../src/runtime/run-store.js";

const tempRoot = () => mkdtempSync(join(tmpdir(), "odw-runs-"));

test("create writes meta + status; reads round-trip", () => {
  const root = tempRoot();
  try {
    const store = new RunStore(root);
    const id = store.create({ script: "/x/wf.js", args: { n: 1 }, source: "/src" });
    assert.ok(store.exists(id));
    assert.equal(store.readMeta(id).script, "/x/wf.js");
    assert.deepEqual(store.readMeta(id).args, { n: 1 });
    assert.equal(store.readStatus(id).state, "pending");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("updateStatus merges; result/control round-trip; listRuns", () => {
  const root = tempRoot();
  try {
    const store = new RunStore(root);
    const id = store.create({ script: "wf.js", args: null, source: "/src" });
    store.updateStatus(id, { state: "running", dispatched: 2 });
    assert.equal(store.readStatus(id).state, "running");
    assert.equal(store.readStatus(id).dispatched, 2);
    store.writeResult(id, { ok: true });
    assert.deepEqual(store.readResult(id), { ok: true });
    store.writeControl(id, "stop");
    assert.equal(store.readControl(id), "stop");
    // listRuns now returns {runId, workflowName}; this run had no name → bucket stem.
    assert.deepEqual(store.listRuns(), [{ runId: id, workflowName: "wf" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R1: create buckets a run under runs/<slug(workflowName)>/<runId> and records the name", () => {
  const root = tempRoot();
  try {
    const store = new RunStore(root);
    const id = store.create({
      script: "/x/deep.js",
      args: null,
      source: "/s",
      workflowName: "Deep Research", // contains a space → slugified for the bucket
    });
    assert.ok(existsSync(join(root, "Deep-Research", id, "meta.json")), "bucketed by slug");
    assert.equal(store.readMeta(id).workflowName, "Deep Research", "true name kept in meta");
    assert.equal(store.readStatus(id).state, "pending", "a pending run already knows its bucket");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R1/R2: a fresh store locates a bucketed run by id across buckets (no memo)", () => {
  const root = tempRoot();
  try {
    const id = new RunStore(root).create({
      script: "x.js",
      args: { n: 1 },
      source: "/s",
      workflowName: "alpha",
    });
    const fresh = new RunStore(root); // cold cache: must scan buckets
    assert.ok(fresh.exists(id));
    assert.deepEqual(fresh.readMeta(id).args, { n: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R2: listRuns walks two levels, newest first, and tolerates a legacy flat run", () => {
  const root = tempRoot();
  try {
    const store = new RunStore(root);
    const bucketed = store.create({ script: "a.js", args: null, source: "/s", workflowName: "alpha" });
    // A pre-bucket flat run: <root>/<legacyId>/meta.json (older timestamp prefix).
    const legacyId = "20200101-000000-aaaaaa";
    mkdirSync(join(root, legacyId), { recursive: true });
    writeFileSync(join(root, legacyId, "meta.json"), JSON.stringify({ runId: legacyId, script: "old.js" }));

    const refs = new RunStore(root).listRuns();
    const ids = refs.map((r) => r.runId);
    assert.ok(ids.includes(bucketed), "bucketed run listed");
    assert.ok(ids.includes(legacyId), "legacy flat run listed");
    assert.ok(ids.indexOf(bucketed) < ids.indexOf(legacyId), "newest (2026) before oldest (2020)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R3: listRunsForWorkflow reads only that workflow's bucket", () => {
  const root = tempRoot();
  try {
    const store = new RunStore(root);
    const a = store.create({ script: "a.js", args: null, source: "/s", workflowName: "alpha" });
    store.create({ script: "b.js", args: null, source: "/s", workflowName: "beta" });
    const refs = store.listRunsForWorkflow("alpha");
    assert.equal(refs.length, 1);
    assert.equal(refs[0]!.runId, a);
    assert.equal(refs[0]!.workflowName, "alpha");
    assert.deepEqual(store.listRunsForWorkflow("nonexistent"), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("JsonlSink appends and readEvents parses each line", () => {
  const root = tempRoot();
  try {
    const store = new RunStore(root);
    const id = store.create({ script: "wf.js", args: null, source: "/src" });
    const sink = new JsonlSink(store.eventsPath(id));
    sink.emit({ ts: 1, type: "log", message: "a" });
    sink.emit({ ts: 2, type: "log", message: "b" });
    const events = store.readEvents(id);
    assert.equal(events.length, 2);
    assert.equal(events[1]!.message, "b");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
