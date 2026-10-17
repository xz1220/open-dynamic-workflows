import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import { RunStore } from "../src/runtime/run-store.js";
import { startServer } from "../src/runtime/server.js";
import { normalizeTranscript, type TranscriptPage } from "../src/runtime/transcript-view.js";
import { executeRun } from "../src/runtime/worker.js";

const MOCK_AGENT = fileURLToPath(new URL("./fixtures/mock-agent.mjs", import.meta.url));

// GET /api/runs/:id/agents/:agentId/transcript?since=<i> (ODW extension): an
// agent's transcript, normalized, a page at a time.

const jsonl = (...events: unknown[]): string => events.map((e) => JSON.stringify(e)).join("\n") + "\n";

const write = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

test("HTTP: an agent's transcript is served normalized, from `since` on, a page at a time", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-transcript-api-"));
  const store = new RunStore(join(root, "runs"));
  const id = store.create({ script: "/demo/wf.js", args: null, source: "/demo" });
  store.updateStatus(id, { state: "running", pid: process.pid, name: "demo" });
  const events = [
    { ts: 1, type: "agent_started", agentId: 1, label: "fixer", phase: null, adapter: "claude" },
    { ts: 2, type: "agent_started", agentId: 2, label: "again", phase: null, adapter: "claude", cached: true, sourceRunId: "r0" },
    { ts: 2, type: "agent_finished", agentId: 2, label: "again", phase: null, adapter: "claude", attempts: 1, cached: true, sourceRunId: "r0" },
    { ts: 3, type: "agent_started", agentId: 3, label: "chatty", phase: null, adapter: "gemini" },
    { ts: 4, type: "agent_finished", agentId: 3, label: "chatty", phase: null, adapter: "gemini", attempts: 1 },
    { ts: 4, type: "agent_started", agentId: 4, label: "queued", phase: null, adapter: "gemini" },
  ];
  for (const ev of events) appendFileSync(store.eventsPath(id), JSON.stringify(ev) + "\n");
  const fixer = store.agentTranscriptPaths(id, 1).transcript;
  const first = jsonl(
    { type: "system", subtype: "init", model: "m", tools: ["Bash"] },
    { type: "assistant", message: { content: [{ type: "text", text: "<b>hi</b>" }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "a\nb" }] } },
  );
  write(fixer, first);
  const chatty = store.agentTranscriptPaths(id, 3).transcript;
  write(
    chatty,
    Array.from({ length: 1500 }, (_, n) => JSON.stringify({ kind: "text", text: `line ${n}\n` })).join("\n") + "\n" + JSON.stringify({ kind: "truncated", bytes: 49000 }) + "\n",
  );

  const projects = join(root, "claude-projects");
  const sess = join(projects, "-tmp-proj", "sess1", "workflows");
  mkdirSync(sess, { recursive: true });
  writeFileSync(
    join(sess, "wf_abc.json"),
    JSON.stringify({ runId: "wf_abc", status: "completed", workflowName: "cc-job", startTime: 1780000000000, durationMs: 1000, workflowProgress: [] }),
  );
  const handle = await startServer({ store, port: 0, host: "127.0.0.1", claudeProjectsRoot: projects, claudeJobsScope: "all" });
  const get = (path: string, headers: Record<string, string> = {}) => fetch(`${handle.url}${path}`, { headers });
  const page = async (path: string): Promise<TranscriptPage> => {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    return (await res.json()) as TranscriptPage;
  };
  const base = `/api/runs/${id}/agents`;
  try {
    const all = await page(`${base}/1/transcript`);
    assert.deepEqual(all, { entries: normalizeTranscript(first), next: 4, more: false, truncated: false, replayed: false });
    assert.deepEqual(
      all.entries.map((e) => [e.i, e.kind]),
      [
        [0, "raw"],
        [1, "text"],
        [2, "tool_call"],
        [3, "tool_result"],
      ],
    );
    // A poller gets a 304 while nothing changed.
    const res = await get(`${base}/1/transcript?since=4`);
    const etag = res.headers.get("etag");
    assert.ok(etag);
    assert.equal(res.headers.get("cache-control"), "no-cache");
    assert.equal((await get(`${base}/1/transcript?since=4`, { "if-none-match": etag! })).status, 304);

    // The transcript grows: ?since=next brings only what is new, numbered on.
    appendFileSync(fixer, jsonl({ kind: "attempt", n: 2, reason: "stall" }) + '{"type":"result","is_error":false,"num_turns":1,"res');
    const grown = await page(`${base}/1/transcript?since=4`);
    assert.deepEqual(grown.entries, [{ i: 4, kind: "attempt", text: "attempt 2: stall restart", n: 2, reason: "stall" }]);
    assert.equal(grown.next, 5);
    appendFileSync(fixer, 'ult":"done"}\n');
    assert.deepEqual((await page(`${base}/1/transcript?since=5`)).entries, [
      { i: 5, kind: "result", isError: false, text: "done", turns: 1 },
    ]);
    assert.equal((await get(`${base}/1/transcript?since=4`, { "if-none-match": etag! })).status, 200, "a changed page is a 200");
    assert.deepEqual(
      (await page(`${base}/1/transcript?since=2`)).entries.map((e) => e.i),
      [2, 3, 4, 5],
    );
    // `since` is lenient, as for events: junk or negative is 0; past the end, nothing.
    assert.equal((await page(`${base}/1/transcript?since=abc`)).entries.length, 6);
    assert.equal((await page(`${base}/1/transcript?since=-3`)).next, 6);
    assert.deepEqual(await page(`${base}/1/transcript?since=99`), { entries: [], next: 99, more: false, truncated: false, replayed: false });

    // A long transcript comes a page at a time, and says it was cut.
    const one = await page(`${base}/3/transcript`);
    assert.deepEqual([one.entries.length, one.next, one.more, one.truncated], [1000, 1000, true, true]);
    assert.deepEqual(one.entries[999], { i: 999, kind: "text", text: "line 999\n" });
    const two = await page(`${base}/3/transcript?since=${one.next}`);
    assert.deepEqual([two.entries.length, two.next, two.more, two.truncated], [501, 1501, false, true]);
    assert.equal(two.entries[500]!.kind, "truncated");

    // A replayed agent ran no CLI: no transcript, and the page says why.
    assert.deepEqual(await page(`${base}/2/transcript`), { entries: [], next: 0, more: false, truncated: false, replayed: true });
    // An agent with none (not started yet, a run from before transcripts) is a 404.
    const none = await get(`${base}/4/transcript`);
    assert.equal(none.status, 404);
    assert.deepEqual(await none.json(), { error: "agent 4 has no transcript" });
    assert.equal((await get(`${base}/99/transcript`)).status, 404);

    // The same agentId check as the other agent routes, before anything touches the disk.
    for (const bad of ["abc", "-1", "1.5", "%20", "99999999999999999999"]) {
      const r = await get(`${base}/${bad}/transcript`);
      assert.equal(r.status, 400, bad);
      assert.deepEqual(await r.json(), { error: "agentId must be a non-negative integer" });
    }
    assert.equal((await get(`${base}/1%2Ftranscript`)).status, 400);
    assert.equal((await get(`${base}/1/transcript/more`)).status, 404);
    // And the same run-id check as every run route.
    assert.equal((await get("/api/runs/no-such-run/agents/1/transcript")).status, 404);
    assert.equal((await get("/api/runs/..%2F..%2Fetc/agents/1/transcript")).status, 404);
    assert.equal((await get("/api/runs/%ZZ/agents/1/transcript")).status, 400);
    assert.equal((await get("/api/runs/cc-wf_abc/agents/1/transcript")).status, 404, "Claude Code runs keep no ODW transcripts");
    const post = await fetch(`${handle.url}${base}/1/transcript`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(post.status, 404, "read-only");
    // The diff route beside it is unchanged.
    assert.equal((await get(`${base}/1/diff`)).status, 404);
    assert.equal(readFileSync(fixer, "utf8").startsWith(first), true, "reading never writes");
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("end to end: the API serves a real run's transcript, and says an agent odw resume replayed has none", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-transcript-api-e2e-"));
  const configPath = join(root, "odw.config.json");
  writeFileSync(configPath, JSON.stringify({ defaultAdapter: "plain", adapters: { plain: { command: [execPath, MOCK_AGENT], stdin: "{prompt}" } } }));
  const script = join(root, "wf.js");
  writeFileSync(script, "export const meta = { name: 'wf', description: 'd' }\nreturn await agent('say hi', { label: 'greeter' })\n");
  const store = new RunStore(join(root, "runs"));
  const first = store.create({ script, args: null, source: root, configPath });
  assert.equal(await executeRun(store.runDir(first)), "done");
  const resumed = store.create({ script, args: null, source: root, configPath, resumedFrom: { runId: first, dir: store.runDir(first) } });
  assert.equal(await executeRun(store.runDir(resumed)), "done");
  const handle = await startServer({ store, port: 0, host: "127.0.0.1", claudeProjectsRoot: join(root, "no-claude") });
  try {
    const get = async (runId: string): Promise<unknown> => {
      const res = await fetch(`${handle.url}/api/runs/${runId}/agents/1/transcript`);
      assert.equal(res.status, 200);
      return res.json();
    };
    assert.deepEqual(await get(first), {
      entries: [{ i: 0, kind: "text", text: "mock reply" }],
      next: 1,
      more: false,
      truncated: false,
      replayed: false,
    });
    assert.deepEqual(await get(resumed), { entries: [], next: 0, more: false, truncated: false, replayed: true });
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});
