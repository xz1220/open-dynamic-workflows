import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AGENT_STARTED, event } from "../src/events.js";
import { main } from "../src/cli.js";
import { JsonlSink, RunStore } from "../src/runtime/run-store.js";

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  (process.stdout as { write: unknown }).write = (s: unknown) => {
    out.push(String(s));
    return true;
  };
  (process.stderr as { write: unknown }).write = (s: unknown) => {
    err.push(String(s));
    return true;
  };
  try {
    const code = await main(argv);
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
  }
}

test("list / status / result / stop wire to the run directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-cli-"));
  try {
    const store = new RunStore(root);
    const id = store.create({ script: "/x/wf.js", args: null, source: "/s" });
    store.updateStatus(id, { state: "done", name: "demo" });
    store.writeResult(id, { answer: 42 });

    let r = await run(["list", "--runs-root", root]);
    assert.equal(r.code, 0);
    assert.match(r.out, new RegExp(id));

    r = await run(["status", id, "--runs-root", root]);
    assert.equal(r.code, 0);
    assert.match(r.out, /done/);
    assert.match(r.out, /demo/);

    r = await run(["result", id, "--runs-root", root]);
    assert.equal(r.code, 0);
    assert.match(r.out, /42/);

    r = await run(["stop", id, "--runs-root", root]);
    assert.equal(r.code, 0);
    assert.equal(store.readControl(id), "stop");

    r = await run(["status", "missing-run", "--runs-root", root]);
    assert.equal(r.code, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("list with no runs is a clean exit", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-cli-"));
  try {
    const r = await run(["list", "--runs-root", root]);
    assert.equal(r.code, 0);
    assert.match(r.err, /no runs found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("status derives live dispatched count from agent events", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-cli-"));
  try {
    const store = new RunStore(root);
    const id = store.create({ script: "/x/slow-control.js", args: null, source: "/s" });
    store.updateStatus(id, { state: "paused", name: "slow-control", dispatched: 0 });
    const sink = new JsonlSink(store.eventsPath(id));
    sink.emit(event(AGENT_STARTED, { label: "first-agent", adapter: "mock" }));

    const r = await run(["status", id, "--runs-root", root]);
    assert.equal(r.code, 0);
    assert.match(r.out, /paused/);
    assert.match(r.out, /dispatched: 1 agent\(s\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
