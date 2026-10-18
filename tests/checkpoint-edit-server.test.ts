import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CHECKPOINT_EDIT_MAX_BYTES } from "../src/checkpoint.js";
import { MAX_BODY_BYTES } from "../src/runtime/http-util.js";
import { RunStore } from "../src/runtime/run-store.js";
import { startServer } from "../src/runtime/server.js";
import { localLauncher } from "../src/identity.js";
import { pendingIds, project, until } from "./checkpoint-project.js";

// Who answers from a dashboard with no token: the user who runs odw serve (ODW extension).
const LOCAL = localLauncher() ? { who: localLauncher()! } : {};

// POST /api/runs/:id/checkpoint with `payload` (ODW extension): the dashboard
// approves a checkpoint() with an edited payload — checked as the run checks
// it, size-capped, behind the same write guard as every other write.

const PLAN = {
  type: "object",
  properties: { steps: { type: "array", items: { type: "string" }, minItems: 1 } },
  required: ["steps"],
};

test("HTTP: an approval with a payload reaches the run; the decision log carries it", async () => {
  const p = project();
  const handle = await startServer({ store: p.store, port: 0, host: "127.0.0.1", claudeProjectsRoot: join(p.root, "no-claude") });
  try {
    const { id, run } = p.start(`return await checkpoint('Merge?', { payload: { steps: ['a'] }, schema: ${JSON.stringify(PLAN)} })\n`);
    await until(() => pendingIds(p.store, id).length === 1);
    const det = await fetch(`${handle.url}/api/runs/${id}`).then((r) => r.json());
    assert.deepEqual(det.pendingCheckpoints[0].schema, PLAN, "what an editor can check against");
    // Bigger than any other write may be: the route takes an edit of up to 256 KiB.
    const steps = ["a", "x".repeat(MAX_BODY_BYTES)];
    const res = await fetch(`${handle.url}/api/runs/${id}/checkpoint`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: handle.url },
      body: JSON.stringify({ action: "approve", checkpointId: 1, payload: { steps } }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(await res.json(), { ok: true, runId: id, action: "approve", checkpointId: 1 });
    const [line] = p.store.readCheckpointRequests(id);
    assert.deepEqual(line!.payload, { steps });
    assert.equal(await run, "done");
    const result = p.store.readResult(id) as { payload: { steps: string[] }; edited: boolean; by: string };
    assert.deepEqual([result.edited, result.by, result.payload.steps.length], [true, "dashboard", 2]);
  } finally {
    await handle.close();
    await p.cleanup();
  }
});

test("HTTP: a payload is checked — reject-only, the size cap, the schema — and the write guard holds", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-cp-edit-http-"));
  const store = new RunStore(join(root, "runs"));
  const id = store.create({ script: "/demo/wf.js", args: null, source: "/demo" });
  store.updateStatus(id, { state: "running", pid: process.pid, name: "demo" });
  appendFileSync(
    store.eventsPath(id),
    JSON.stringify({ ts: 1, type: "checkpoint_requested", checkpointId: 1, title: "Go?", payload: { steps: ["a"] }, schema: PLAN }) + "\n",
  );
  const handle = await startServer({ store, port: 0, host: "127.0.0.1", claudeProjectsRoot: join(root, "no-claude") });
  const post = (body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) =>
    fetch(`${handle.url}/api/runs/${id}/checkpoint`, { method: "POST", headers, body: JSON.stringify(body) });
  try {
    let res = await post({ action: "reject", payload: { steps: ["b"] } });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /payload goes with action approve only/);

    res = await post({ action: "approve", payload: "x".repeat(CHECKPOINT_EDIT_MAX_BYTES) });
    assert.equal(res.status, 413);
    assert.match((await res.json()).error, /the payload is 262146 bytes of JSON; the limit is 262144 \(256 KiB\)/);

    res = await post({ action: "approve", payload: { steps: [1] } });
    assert.equal(res.status, 400);
    const refused = await res.json();
    assert.match(refused.error, /the payload does not match the checkpoint's schema: \$\.steps\[0\]: expected string, got integer/);
    assert.deepEqual(refused.problems, ["$.steps[0]: expected string, got integer"]);

    // A body past the route's own cap is still refused whole.
    res = await post({ action: "approve", payload: "x".repeat(2 * CHECKPOINT_EDIT_MAX_BYTES) });
    assert.equal(res.status, 413);
    assert.match((await res.json()).error, /request body exceeds 524288 bytes/);

    // The write guard: a CORS "simple request", and a cross-origin page.
    assert.equal((await post({ action: "approve", payload: { steps: ["b"] } }, { "content-type": "text/plain" })).status, 415);
    res = await post({ action: "approve", payload: { steps: ["b"] } }, { "content-type": "application/json", origin: "http://evil.example" });
    assert.equal(res.status, 403);
    assert.deepEqual(store.readCheckpointRequests(id), [], "no refused request wrote anything");

    // null is a JSON value like any other: sent as the edit (the schema here refuses it).
    res = await post({ action: "approve", payload: null });
    assert.equal(res.status, 400);
    res = await post({ action: "approve", payload: { steps: ["b"] } });
    assert.equal(res.status, 200);
    assert.deepEqual(
      store.readCheckpointRequests(id).map(({ at: _at, ...r }) => r),
      [{ action: "approve", checkpointId: 1, payload: { steps: ["b"] }, by: "dashboard", ...LOCAL }],
    );
  } finally {
    await handle.close();
  }

  // Off-loopback binds refuse every write, an edit included.
  const remote = await startServer({ store, port: 0, host: "0.0.0.0", claudeProjectsRoot: join(root, "no-claude") });
  try {
    const res = await fetch(`http://127.0.0.1:${remote.port}/api/runs/${id}/checkpoint`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "approve", payload: { steps: ["c"] } }),
    });
    assert.equal(res.status, 409);
    assert.equal(store.readCheckpointRequests(id).length, 1);
  } finally {
    await remote.close();
    rmSync(root, { recursive: true, force: true });
  }
});
