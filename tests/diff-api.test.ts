import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RunStore } from "../src/runtime/run-store.js";
import { startServer } from "../src/runtime/server.js";

// GET /api/runs/:id/agents/:agentId/diff — what an isolated agent changed, as
// kept in the run directory (ODW extension) — and `changes`/`branch` on the
// folded agents the dashboard's Changes tab reads.

const DIFF = [
  "diff --git a/a.txt b/a.txt",
  "index 0000000000000000000000000000000000000001..0000000000000000000000000000000000000002 100644",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1 +1 @@",
  "-<b>old</b>",
  "+<script>new</script>",
  "",
].join("\n");

test("HTTP: an agent's kept diff is served as text; the run detail folds its changes and branch", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-diff-api-"));
  const store = new RunStore(root);
  const id = store.create({ script: "/demo/wf.js", args: null, source: "/demo" });
  store.updateStatus(id, { state: "done", name: "demo" });
  const changes = { files: 1, insertions: 1, deletions: 1, truncated: false };
  const branch = `odw/${id}/1-fix-auth`;
  const events = [
    { ts: 10, type: "agent_started", agentId: 1, label: "fix:auth", phase: null, adapter: "codex" },
    { ts: 12, type: "agent_finished", agentId: 1, label: "fix:auth", phase: null, adapter: "codex", attempts: 1, saved: true, changes, branch },
    { ts: 12, type: "agent_started", agentId: 2, label: "idle", phase: null, adapter: "codex" },
    { ts: 13, type: "agent_finished", agentId: 2, label: "idle", phase: null, adapter: "codex", attempts: 1 },
    { ts: 13, type: "agent_started", agentId: 3, label: "broke", phase: null, adapter: "codex" },
    { ts: 15, type: "agent_failed", agentId: 3, label: "broke", phase: null, error: "timed out", reason: "timeout", changes: { ...changes, truncated: true }, branch: null },
  ];
  for (const ev of events) appendFileSync(store.eventsPath(id), JSON.stringify(ev) + "\n");
  store.writeAgentResult(id, { agentId: 1, key: "k1", label: "fix:auth", phase: null, adapter: "codex", attempts: 1, startedAt: 10, finishedAt: 12, value: "done", changes, branch });
  writeFileSync(store.agentDiffPath(id, 1), DIFF);
  writeFileSync(store.agentDiffPath(id, 3), `${DIFF}# odw: diff truncated at 2.0 MB — 3 files not shown; keep: true keeps the full change on a branch\n`);

  const projects = join(root, "claude-projects");
  const sess = join(projects, "-tmp-proj", "sess1", "workflows");
  mkdirSync(sess, { recursive: true });
  writeFileSync(
    join(sess, "wf_abc.json"),
    JSON.stringify({ runId: "wf_abc", status: "completed", workflowName: "cc-job", startTime: 1780000000000, durationMs: 1000, workflowProgress: [] }),
  );
  const handle = await startServer({ store, port: 0, host: "127.0.0.1", claudeProjectsRoot: projects, claudeJobsScope: "all" });
  const get = (path: string, headers: Record<string, string> = {}) => fetch(`${handle.url}${path}`, { headers });
  try {
    const res = await get(`/api/runs/${id}/agents/1/diff`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff", "the agent's HTML is never rendered");
    assert.equal(await res.text(), DIFF);
    const etag = res.headers.get("etag");
    assert.ok(etag);
    assert.equal((await get(`/api/runs/${id}/agents/1/diff`, { "if-none-match": etag! })).status, 304);
    assert.match(await get(`/api/runs/${id}/agents/3/diff`).then((r) => r.text()), /\n# odw: diff truncated at 2\.0 MB/);

    const none = await get(`/api/runs/${id}/agents/2/diff`);
    assert.equal(none.status, 404);
    assert.deepEqual(await none.json(), { error: "agent 2 kept no diff" });
    assert.equal((await get(`/api/runs/${id}/agents/99/diff`)).status, 404);
    // The same agentId check as the other agent routes, before anything touches the disk.
    for (const bad of ["abc", "-1", "1.5", "%20", "99999999999999999999"]) {
      const r = await get(`/api/runs/${id}/agents/${bad}/diff`);
      assert.equal(r.status, 400, bad);
      assert.deepEqual(await r.json(), { error: "agentId must be a non-negative integer" });
    }
    assert.equal((await get(`/api/runs/${id}/agents/1%2Fdiff`)).status, 400);
    assert.equal((await get(`/api/runs/${id}/agents/1/diff/more`)).status, 404);
    assert.equal((await get(`/api/runs/${id}/agents/1/patch`)).status, 404);
    // And the same run-id check as every run route.
    assert.equal((await get("/api/runs/no-such-run/agents/1/diff")).status, 404);
    assert.equal((await get("/api/runs/..%2F..%2Fetc/agents/1/diff")).status, 404);
    assert.equal((await get("/api/runs/%ZZ/agents/1/diff")).status, 400);
    assert.equal((await get("/api/runs/cc-wf_abc/agents/1/diff")).status, 404, "Claude Code runs keep no diffs");
    const post = await fetch(`${handle.url}/api/runs/${id}/agents/1/diff`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(post.status, 404, "read-only");

    const detail = await get(`/api/runs/${id}`).then((r) => r.json());
    assert.deepEqual(
      detail.agents.map((a: { label: string; state: string; changes: unknown; branch: unknown }) => [a.label, a.state, a.changes, a.branch]),
      [
        ["fix:auth", "done", changes, branch],
        ["idle", "done", null, null],
        ["broke", "failed", { ...changes, truncated: true }, null],
      ],
    );
    const record = await get(`/api/runs/${id}/agents/1`).then((r) => r.json());
    assert.deepEqual([record.changes, record.branch], [changes, branch]);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});
