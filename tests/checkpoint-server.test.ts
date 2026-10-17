import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RunStore } from "../src/runtime/run-store.js";
import { startServer } from "../src/runtime/server.js";
import { pendingIds, project, until } from "./checkpoint-project.js";

// The dashboard's side of checkpoint(): GET /api/runs/:id lists what waits
// (pendingCheckpoints), POST /api/runs/:id/checkpoint answers it — behind the
// same write guard as every other write.

test("HTTP: GET exposes pendingCheckpoints; POST /checkpoint answers it (by: dashboard)", async () => {
  const p = project();
  const handle = await startServer({ store: p.store, port: 0, host: "127.0.0.1", claudeProjectsRoot: join(p.root, "no-claude") });
  try {
    const { id, run } = p.start("return await checkpoint('Merge the plan?', { payload: { steps: 3 } })\n");
    await until(() => pendingIds(p.store, id).length === 1);
    const det = await fetch(`${handle.url}/api/runs/${id}`).then((r) => r.json());
    assert.equal(det.state, "waiting");
    assert.equal(det.pendingCheckpoints.length, 1);
    assert.deepEqual(
      { ...det.pendingCheckpoints[0], since: 0 },
      { checkpointId: 1, title: "Merge the plan?", payload: { steps: 3 }, since: 0 },
    );
    assert.equal(typeof det.pendingCheckpoints[0].since, "number");
    const runs = await fetch(`${handle.url}/api/runs`).then((r) => r.json());
    assert.equal(runs[0].state, "waiting");
    // What the dashboard's "Needs you" strip reads off the run list.
    assert.deepEqual(runs[0].waiting, { checkpointId: 1, title: "Merge the plan?", since: det.pendingCheckpoints[0].since });

    // What the dashboard's approval card sends.
    const res = await fetch(`${handle.url}/api/runs/${id}/checkpoint`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: handle.url },
      body: JSON.stringify({ action: "approve", checkpointId: 1, note: "looks right" }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, runId: id, action: "approve", checkpointId: 1 });
    assert.equal(await run, "done");
    assert.deepEqual(p.store.readResult(id), { approved: true, note: "looks right", by: "dashboard" });
  } finally {
    await handle.close();
    await p.cleanup();
  }
});

test("SSE: the run list is pushed again when the checkpoint a waiting run shows changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-cp-sse-"));
  const store = new RunStore(join(root, "runs"));
  const id = store.create({ script: "/demo/wf.js", args: null, source: "/demo" });
  store.updateStatus(id, { state: "running", pid: process.pid, name: "demo" });
  const emit = (ev: Record<string, unknown>) => appendFileSync(store.eventsPath(id), JSON.stringify(ev) + "\n");
  emit({ ts: 1, type: "checkpoint_requested", checkpointId: 1, title: "First?", payload: null });
  emit({ ts: 2, type: "checkpoint_requested", checkpointId: 2, title: "Second?", payload: null });
  const handle = await startServer({ store, port: 0, host: "127.0.0.1", claudeProjectsRoot: join(root, "no-claude") });
  const abort = new AbortController();
  try {
    const res = await fetch(`${handle.url}/api/stream`, { signal: abort.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    /** The `waiting` of each `runs` frame, until one passes `done`. */
    const nextList = async (done: (waiting: { checkpointId: number } | null) => boolean) => {
      const deadline = setTimeout(() => abort.abort(), 8000);
      try {
        for (;;) {
          let cut: number;
          while ((cut = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, cut);
            buf = buf.slice(cut + 2);
            const data = /^event: runs\ndata: (.*)$/m.exec(frame)?.[1];
            if (data && done(JSON.parse(data)[0].waiting)) return;
          }
          const { value, done: ended } = await reader.read();
          if (ended) throw new Error("stream ended");
          buf += decoder.decode(value, { stream: true });
        }
      } finally {
        clearTimeout(deadline);
      }
    };
    await nextList((w) => w?.checkpointId === 1);
    // #1 is answered: still "waiting", same counts and progress — but a new question shows.
    emit({ ts: 3, type: "checkpoint_resolved", checkpointId: 1, approved: true, note: null, by: "cli" });
    await nextList((w) => w?.checkpointId === 2);
  } finally {
    abort.abort();
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP: /checkpoint refuses what it cannot answer (409), bad bodies (400), and keeps the write guard", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-cp-http-"));
  const store = new RunStore(join(root, "runs"));
  const seed = (state: string, events: Array<Record<string, unknown>>) => {
    const id = store.create({ script: "/demo/wf.js", args: null, source: "/demo" });
    store.updateStatus(id, { state, pid: process.pid, name: "demo" });
    for (const ev of events) appendFileSync(store.eventsPath(id), JSON.stringify(ev) + "\n");
    return id;
  };
  const waiting = seed("running", [{ ts: 1, type: "checkpoint_requested", checkpointId: 1, title: "Go?", payload: null }]);
  const idle = seed("running", []);
  const done = seed("done", [{ ts: 1, type: "run_finished" }]);
  // A Claude Code run: read-only.
  const projects = join(root, "claude-projects");
  const sess = join(projects, "-tmp-proj", "sess1", "workflows");
  mkdirSync(sess, { recursive: true });
  writeFileSync(
    join(sess, "wf_abc.json"),
    JSON.stringify({ runId: "wf_abc", status: "completed", workflowName: "cc-job", startTime: 1780000000000, durationMs: 1, workflowProgress: [] }),
  );
  try {
    const handle = await startServer({ store, port: 0, host: "127.0.0.1", claudeProjectsRoot: projects, claudeJobsScope: "all" });
    const post = (id: string, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) =>
      fetch(`${handle.url}/api/runs/${id}/checkpoint`, { method: "POST", headers, body: JSON.stringify(body) });
    const expect = async (res: Response, status: number, error: RegExp) => {
      assert.equal(res.status, status);
      assert.match(String((await res.json()).error), error);
    };
    try {
      await expect(await post(idle, { action: "approve" }), 409, /no checkpoint is waiting for an answer/);
      await expect(await post(done, { action: "reject" }), 409, /no checkpoint is waiting/);
      await expect(await post(waiting, { action: "approve", checkpointId: 2 }), 409, /checkpoint #2 is not waiting .*\(waiting: #1\)/);
      await expect(await post("cc-wf_abc", { action: "approve" }), 409, /read-only/);
      await expect(await post("no-such-run", { action: "approve" }), 404, /no such run/);
      await expect(await post(waiting, { action: "maybe" }), 400, /action must be one of approve, reject/);
      await expect(await post(waiting, { action: "approve", checkpointId: "1" }), 400, /checkpointId must be a positive integer/);
      await expect(await post(waiting, { action: "approve", checkpointId: 0 }), 400, /checkpointId/);
      await expect(await post(waiting, { action: "approve", note: 5 }), 400, /note must be a string/);
      await expect(await post(waiting, { action: "approve", note: "x".repeat(4001) }), 400, /note must be at most 4000/);
      // The write guard: a CORS "simple request", and a cross-origin page.
      assert.equal((await post(waiting, { action: "approve" }, { "content-type": "text/plain" })).status, 415);
      assert.equal(
        (await post(waiting, { action: "approve" }, { "content-type": "application/json", origin: "http://evil.example" }))
          .status,
        403,
      );
      assert.deepEqual(store.readCheckpointRequests(waiting), [], "no refused request wrote anything");

      // A good one, without an id: the oldest waiting, named explicitly in the file.
      const ok = await post(waiting, { action: "reject", note: "" });
      assert.equal(ok.status, 200);
      assert.deepEqual(await ok.json(), { ok: true, runId: waiting, action: "reject", checkpointId: 1 });
      assert.deepEqual(
        store.readCheckpointRequests(waiting).map(({ at: _at, ...r }) => r),
        [{ action: "reject", checkpointId: 1, by: "dashboard" }],
      );
    } finally {
      await handle.close();
    }

    // Off-loopback binds refuse every write.
    const remote = await startServer({ store, port: 0, host: "0.0.0.0", claudeProjectsRoot: join(root, "no-claude") });
    try {
      const res = await fetch(`http://127.0.0.1:${remote.port}/api/runs/${waiting}/checkpoint`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      });
      assert.equal(res.status, 409);
      assert.match(String((await res.json()).error), /loopback-only/);
      assert.equal(store.readCheckpointRequests(waiting).length, 1);
    } finally {
      await remote.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
