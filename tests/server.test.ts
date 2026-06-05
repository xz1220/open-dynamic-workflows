import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/adapters/config.js";
import { RunStore } from "../src/runtime/run-store.js";
import {
  foldAgents,
  isProcessAlive,
  reconcileState,
  summarize,
  detail,
  listSummaries,
} from "../src/runtime/runs-view.js";
import { startServer } from "../src/runtime/server.js";

const tempRoot = () => mkdtempSync(join(tmpdir(), "odw-serve-"));

/** Write a run directory: meta + status + a JSONL event stream. */
function seedRun(
  store: RunStore,
  fields: { name?: string; state?: string; pid?: number; phases?: { title: string }[] },
  events: Array<Record<string, unknown>>,
): string {
  const id = store.create({ script: "/demo/wf.js", args: { q: "hi" }, source: "/demo" });
  store.updateStatus(id, {
    state: fields.state ?? "running",
    name: fields.name ?? "demo",
    description: "a demo run",
    phases: fields.phases ?? [{ title: "Research" }],
    ...(fields.pid ? { pid: fields.pid } : {}),
  });
  for (const ev of events) appendFileSync(store.eventsPath(id), JSON.stringify(ev) + "\n");
  return id;
}

const A = (type: string, label: string, phase: string, ts: number, extra = {}) => ({
  ts,
  type,
  label,
  phase,
  ...extra,
});

test("foldAgents: opens a node per start, settles by label+phase, computes duration", () => {
  const agents = foldAgents([
    { ts: 100, type: "phase_started", phase: "Research" },
    A("agent_started", "alpha", "Research", 100),
    A("agent_started", "beta", "Research", 100.5),
    A("agent_finished", "alpha", "Research", 102.5, { adapter: "mock", attempts: 1 }),
    A("agent_failed", "beta", "Research", 101.5, { error: "boom" }),
  ]);
  assert.equal(agents.length, 2);
  const alpha = agents.find((a) => a.label === "alpha")!;
  const beta = agents.find((a) => a.label === "beta")!;
  assert.equal(alpha.state, "done");
  assert.equal(alpha.adapter, "mock");
  assert.equal(alpha.durationMs, 2500);
  assert.equal(beta.state, "failed");
  assert.equal(beta.error, "boom");
  assert.equal(beta.durationMs, 1000);
});

test("foldAgents: repeated label across rounds stays distinct (loop-until-dry honesty)", () => {
  const agents = foldAgents([
    A("agent_started", "finder", "Find", 1),
    A("agent_finished", "finder", "Find", 2),
    A("agent_started", "finder", "Find", 3), // a second round, same label
  ]);
  assert.equal(agents.length, 2);
  assert.equal(agents[0]!.state, "done");
  assert.equal(agents[1]!.state, "running");
});

test("reconcileState: terminal trusted; live pid stays running; dead pid → stale", async () => {
  assert.deepEqual(reconcileState("done", 999999), { state: "done", stale: false });
  // the test process itself is alive
  assert.deepEqual(reconcileState("running", process.pid), { state: "running", stale: false });

  // spawn a process, let it exit, then its pid is provably gone
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const deadPid = child.pid!;
  await new Promise<void>((r) => child.on("exit", () => r()));
  assert.equal(isProcessAlive(deadPid), false);
  assert.deepEqual(reconcileState("running", deadPid), { state: "stale", stale: true });

  // unknown pid (pending, pre-fork) is not stale
  assert.deepEqual(reconcileState("pending", null), { state: "pending", stale: false });
});

test("readEvents tolerates a torn final line (no per-line throw)", () => {
  const root = tempRoot();
  try {
    const store = new RunStore(root);
    const id = store.create({ script: "wf.js", args: null, source: "/s" });
    appendFileSync(store.eventsPath(id), JSON.stringify({ ts: 1, type: "log", message: "ok" }) + "\n");
    appendFileSync(store.eventsPath(id), '{"ts":2,"type":"agent_started","lab'); // partial write
    const events = store.readEvents(id);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, "log");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("summarize/detail derive counts, progress, and phase order from events", () => {
  const root = tempRoot();
  try {
    const store = new RunStore(root);
    const id = seedRun(
      store,
      { name: "deep-research", state: "running", pid: process.pid, phases: [{ title: "Research" }, { title: "Verify" }] },
      [
        { ts: 1, type: "phase_started", phase: "Research" },
        A("agent_started", "a", "Research", 1),
        A("agent_started", "b", "Research", 1),
        A("agent_finished", "a", "Research", 2, { adapter: "mock", attempts: 1 }),
        { ts: 3, type: "phase_started", phase: "Verify" },
        A("agent_started", "v", "Verify", 3),
      ],
    );

    const s = summarize(store, id);
    assert.equal(s.state, "running");
    assert.equal(s.counts.agents, 3);
    assert.equal(s.counts.running, 2);
    assert.equal(s.counts.done, 1);
    assert.equal(s.progress, 1 / 3);

    const d = detail(store, id);
    assert.deepEqual(d.phaseOrder, ["Research", "Verify"]);
    assert.equal(d.agents.length, 3);
    assert.equal(d.args && (d.args as { q: string }).q, "hi");

    // listSummaries returns everything, newest-first
    assert.equal(listSummaries(store).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP: serves dashboard, run list, detail, control, and 404s", async () => {
  const root = tempRoot();
  const store = new RunStore(root);
  const id = seedRun(store, { name: "demo", state: "running", pid: process.pid }, [
    A("agent_started", "alpha", "Research", 1),
    A("agent_finished", "alpha", "Research", 2, { adapter: "mock", attempts: 1 }),
  ]);
  const handle = await startServer({ store, port: 0, host: "127.0.0.1" });
  try {
    const html = await fetch(`${handle.url}/`).then((r) => r.text());
    assert.match(html, /Open Dynamic Workflows/);

    const runs = await fetch(`${handle.url}/api/runs`).then((r) => r.json());
    assert.equal(runs.length, 1);
    assert.equal(runs[0].runId, id);
    assert.equal(runs[0].counts.done, 1);

    const one = await fetch(`${handle.url}/api/runs/${id}`).then((r) => r.json());
    assert.equal(one.agents.length, 1);
    assert.equal(one.agents[0].label, "alpha");

    const missing = await fetch(`${handle.url}/api/runs/does-not-exist`);
    assert.equal(missing.status, 404);

    const events = await fetch(`${handle.url}/api/runs/${id}/events`).then((r) => r.json());
    assert.equal(events.length, 2);

    const ctl = await fetch(`${handle.url}/api/runs/${id}/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "stop" }),
    });
    assert.equal(ctl.status, 200);
    assert.equal(store.readControl(id), "stop");

    const badCtl = await fetch(`${handle.url}/api/runs/${id}/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "explode" }),
    });
    assert.equal(badCtl.status, 400);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP: control endpoint rejects non-JSON and cross-origin (CSRF guard)", async () => {
  const root = tempRoot();
  const store = new RunStore(root);
  const id = seedRun(store, { name: "demo", state: "running", pid: process.pid }, [
    A("agent_started", "alpha", "Research", 1),
  ]);
  const handle = await startServer({ store, port: 0, host: "127.0.0.1" });
  try {
    // A cross-site "simple request" uses text/plain to skip preflight — reject it.
    const textPlain = await fetch(`${handle.url}/api/runs/${id}/control`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ action: "stop" }),
    });
    assert.equal(textPlain.status, 415);

    // A cross-origin POST (Origin host != bind host) is rejected.
    const crossOrigin = await fetch(`${handle.url}/api/runs/${id}/control`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify({ action: "stop" }),
    });
    assert.equal(crossOrigin.status, 403);

    // Neither attempt should have written a control file.
    assert.equal(store.readControl(id), null);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP: /api/workflows lists managed-dir workflows + detail with source", async () => {
  const root = tempRoot(); // runs root
  const proj = tempRoot(); // a project cwd with .odw/workflows
  mkdirSync(join(proj, ".odw", "workflows"), { recursive: true });
  writeFileSync(
    join(proj, ".odw", "workflows", "echo.js"),
    [
      "export const meta = {",
      "  name: 'echo',",
      "  description: 'Echo the input back.',",
      "  phases: [{ title: 'Echo' }],",
      "}",
      "",
      "phase('Echo')",
      "return await agent('echo: ' + args.q)",
      "",
    ].join("\n"),
  );
  const store = new RunStore(root);
  const handle = await startServer({
    store,
    port: 0,
    host: "127.0.0.1",
    cwd: proj,
    config: loadConfig(null),
  });
  try {
    const list = await fetch(`${handle.url}/api/workflows`).then((r) => r.json());
    const echo = (list as Array<{ name: string }>).find((w) => w.name === "echo") as
      | Record<string, unknown>
      | undefined;
    assert.ok(echo, "echo workflow is listed");
    assert.equal(echo!.origin, "project");
    assert.equal(echo!.description, "Echo the input back.");
    assert.deepEqual(echo!.phases, [{ title: "Echo" }]);
    assert.equal(echo!.runCount, 0);

    const det = await fetch(`${handle.url}/api/workflows/echo`).then((r) => r.json());
    assert.equal(det.name, "echo");
    assert.match(det.source, /export const meta/);
    assert.deepEqual(det.runs, []);

    const missing = await fetch(`${handle.url}/api/workflows/nope`);
    assert.equal(missing.status, 404);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});
