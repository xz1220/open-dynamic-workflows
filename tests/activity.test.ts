import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { activityLimit } from "../src/runtime/activity-view.js";
import { encodeProjectDir } from "../src/runtime/claude-run-source.js";
import { RunStore } from "../src/runtime/run-store.js";
import { startServer } from "../src/runtime/server.js";

const line = (ev: Record<string, unknown>) => JSON.stringify(ev) + "\n";

/** A run with a controlled createdAt (newest-first order) and the given events. */
function seed(
  store: RunStore,
  i: number,
  status: Record<string, unknown>,
  events: Array<Record<string, unknown>>,
): string {
  const id = store.create({ script: `/wf/wf-${i}.js`, args: null, source: "/src" });
  const meta = store.readMeta(id);
  writeFileSync(join(store.runDir(id), "meta.json"), JSON.stringify({ ...meta, createdAt: 1_000_000 + i }));
  store.updateStatus(id, { name: `wf-${i}`, ...status });
  for (const ev of events) appendFileSync(store.eventsPath(id), line(ev));
  return id;
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise<void>((r) => child.on("exit", () => r()));
  return child.pid!;
}

test("GET /api/activity: merged newest-first event tails + per-adapter fleet of running agents", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-activity-"));
  const store = new RunStore(join(root, "runs"));
  // 12 old finished runs, one log line each (ts 100+i); only the newest 12 runs feed the firehose.
  for (let i = 0; i < 12; i++) seed(store, i, { state: "done" }, [{ ts: 100 + i, type: "log", message: `m${i}` }]);
  // A stale run (its worker is gone): its open agent is not "running" any more.
  const staleId = seed(store, 12, { state: "running", pid: await deadPid() }, [
    { ts: 200, type: "agent_started", agentId: 1, label: "ghost", adapter: "codex" },
  ]);
  // The newest ODW run, alive: two codex agents running, a gemini one finished, one with no adapter.
  const liveId = seed(store, 13, { state: "running", pid: process.pid }, [
    { ts: 300, type: "phase_started", phase: "Work" },
    { ts: 301, type: "agent_started", agentId: 1, label: "a", adapter: "codex" },
    { ts: 302, type: "agent_started", agentId: 2, label: "b", adapter: "codex" },
    { ts: 303, type: "agent_started", agentId: 3, label: "c", adapter: "gemini" },
    { ts: 304, type: "agent_finished", agentId: 3, label: "c", adapter: "gemini", attempts: 1 },
    { ts: 305, type: "agent_started", agentId: 4, label: "d" },
  ]);
  // A live Claude Code run with two agents running (no adapter recorded → "claude").
  const projects = join(root, "claude-projects");
  const live = join(projects, encodeProjectDir("/p"), "sess", "subagents", "workflows", "wf_live");
  mkdirSync(live, { recursive: true });
  writeFileSync(
    join(live, "journal.jsonl"),
    line({ type: "started", key: "k1", agentId: "x1" }) + line({ type: "started", key: "k2", agentId: "x2" }),
  );

  const handle = await startServer({ store, port: 0, host: "127.0.0.1", claudeProjectsRoot: projects, claudeJobsScope: "all" });
  try {
    const res = await fetch(`${handle.url}/api/activity`);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get("etag"), "polled: carries an ETag");
    const view = await res.json();

    assert.deepEqual(view.fleet, { codex: 2, unknown: 1, claude: 2 });

    const events: Array<Record<string, any>> = view.events;
    assert.ok(events.length <= 40);
    for (let i = 1; i < events.length; i++) assert.ok(events[i - 1]!.ts >= events[i]!.ts, "newest first");
    // Tagged with their run …
    const started = events.find((e) => e.runId === liveId && e.label === "a")!;
    assert.deepEqual(
      { type: started.type, run: started.run, adapter: started.adapter, provider: started.provider, agentId: started.agentId },
      { type: "agent_started", run: "wf-13", adapter: "codex", provider: "odw", agentId: 1 },
    );
    assert.equal(events.find((e) => e.type === "phase_started")!.adapter, null);
    assert.ok(events.some((e) => e.provider === "claude" && e.runId === "cc-wf_live"));
    assert.ok(events.some((e) => e.runId === staleId));
    // … and only the 12 newest runs feed it (Claude + 2 ODW + 9 finished): m0..m2 are out.
    const messages = new Set(events.filter((e) => e.type === "log").map((e) => e.message));
    for (const m of ["m0", "m1", "m2"]) assert.ok(!messages.has(m), `${m} comes from a run outside the newest 12`);
    for (const m of ["m3", "m11"]) assert.ok(messages.has(m), `${m} is in`);

    const three = await fetch(`${handle.url}/api/activity?limit=3`).then((r) => r.json());
    assert.deepEqual(three.events, events.slice(0, 3));
    assert.deepEqual(three.fleet, view.fleet);
    const capped = await fetch(`${handle.url}/api/activity?limit=100000`).then((r) => r.json());
    assert.ok(capped.events.length <= 200);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("activityLimit: default 40, clamped to 1..200, junk → default", () => {
  assert.equal(activityLimit(null), 40);
  assert.equal(activityLimit(""), 40);
  assert.equal(activityLimit("abc"), 40);
  assert.equal(activityLimit("0"), 1);
  assert.equal(activityLimit("-5"), 1);
  assert.equal(activityLimit("7.9"), 7);
  assert.equal(activityLimit("100000"), 200);
});
