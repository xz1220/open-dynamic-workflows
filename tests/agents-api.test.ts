import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentResultRecord } from "../src/journal.js";
import { RunStore } from "../src/runtime/run-store.js";
import { startServer } from "../src/runtime/server.js";

// GET /api/runs/:id/agents and /api/runs/:id/agents/:agentId — the saved
// per-agent results the dashboard's agent drawer reads, mid-run included.

function record(agentId: number, fields: Partial<AgentResultRecord> = {}): AgentResultRecord {
  return {
    agentId,
    key: `key-${agentId}`,
    label: `agent-${agentId}`,
    phase: "Work",
    adapter: "codex",
    attempts: 1,
    startedAt: 10 + agentId,
    finishedAt: 12 + agentId,
    value: { n: agentId },
    ...fields,
  };
}

test("HTTP: a run's saved agent results, listed and one by one", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-agents-api-"));
  const store = new RunStore(root);
  const id = store.create({ script: "/demo/wf.js", args: null, source: "/demo" });
  store.updateStatus(id, { state: "running", pid: process.pid, name: "demo" });
  const events = [
    { ts: 11, type: "agent_started", agentId: 1, label: "agent-1", phase: "Work", adapter: "codex" },
    { ts: 13, type: "agent_finished", agentId: 1, label: "agent-1", phase: "Work", adapter: "codex", attempts: 1, saved: true },
    { ts: 13, type: "agent_started", agentId: 2, label: "agent-2", phase: "Work", adapter: "codex" }, // still running
    { ts: 13, type: "agent_started", agentId: 3, label: "agent-3", phase: "Work", adapter: "codex", cached: true, sourceRunId: "run-0" },
    { ts: 13, type: "agent_finished", agentId: 3, label: "agent-3", phase: "Work", adapter: "codex", attempts: 1, cached: true, sourceRunId: "run-0", saved: true },
  ];
  for (const ev of events) appendFileSync(store.eventsPath(id), JSON.stringify(ev) + "\n");
  store.writeAgentResult(id, record(1, { value: "the first reply" }));
  store.writeAgentResult(id, record(3, { cached: true, sourceRunId: "run-0" }));
  const empty = store.create({ script: "/demo/wf.js", args: null, source: "/demo" });

  // A fake ~/.claude/projects with one finished Claude Code run.
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
    // The list: who finished and when — values stay behind their own route.
    const list = await get(`/api/runs/${id}/agents`);
    assert.equal(list.status, 200);
    assert.deepEqual(await list.json(), [
      { agentId: 1, label: "agent-1", phase: "Work", adapter: "codex", cached: false, finishedAt: 13 },
      { agentId: 3, label: "agent-3", phase: "Work", adapter: "codex", cached: true, finishedAt: 15 },
    ]);
    assert.deepEqual(await get(`/api/runs/${empty}/agents`).then((r) => r.json()), []);

    // One record, whole; the running agent has none yet.
    assert.deepEqual(await get(`/api/runs/${id}/agents/1`).then((r) => r.json()), record(1, { value: "the first reply" }));
    const replayed = await get(`/api/runs/${id}/agents/3`).then((r) => r.json());
    assert.deepEqual([replayed.cached, replayed.sourceRunId], [true, "run-0"]);
    const running = await get(`/api/runs/${id}/agents/2`);
    assert.equal(running.status, 404);
    assert.deepEqual(await running.json(), { error: "no saved result for agent 2" });

    // The folded run detail marks the replayed agent too (the graph's ↺).
    const detail = await get(`/api/runs/${id}`).then((r) => r.json());
    assert.deepEqual(
      detail.agents.map((a: { agentId: number; cached: boolean }) => [a.agentId, a.cached]),
      [
        [1, false],
        [2, false],
        [3, true],
      ],
    );

    // agentId must be a non-negative integer before anything touches the disk.
    for (const bad of ["abc", "-1", "1.5", "1e3", "%20", "%ZZ", "99999999999999999999"]) {
      const res = await get(`/api/runs/${id}/agents/${bad}`);
      assert.equal(res.status, 400, bad);
      assert.deepEqual(await res.json(), { error: "agentId must be a non-negative integer" });
    }
    // The run id goes through the same RUN_ID check as every run route.
    assert.equal((await get("/api/runs/no-such-run/agents")).status, 404);
    assert.equal((await get("/api/runs/no-such-run/agents/1")).status, 404);
    assert.equal((await get("/api/runs/..%2F..%2Fetc/agents/1")).status, 404);
    assert.equal((await get("/api/runs/%ZZ/agents")).status, 400);
    assert.equal((await get(`/api/runs/${id}/agents/1/extra`)).status, 404);

    // Claude Code runs save no per-agent results.
    const cc = await get("/api/runs/cc-wf_abc/agents");
    assert.equal(cc.status, 404);
    assert.deepEqual(await cc.json(), { error: "agent results are saved for ODW runs only" });
    assert.equal((await get("/api/runs/cc-wf_abc/agents/1")).status, 404);

    // Like the other polled reads, an unchanged record answers 304.
    const first = await get(`/api/runs/${id}/agents/1`);
    const etag = first.headers.get("etag");
    assert.ok(etag);
    await first.arrayBuffer();
    assert.equal((await get(`/api/runs/${id}/agents/1`, { "if-none-match": etag! })).status, 304);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});
