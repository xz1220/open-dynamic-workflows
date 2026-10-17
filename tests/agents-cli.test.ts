import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../src/cli.js";
import type { AgentResultRecord } from "../src/journal.js";
import { RunStore } from "../src/runtime/run-store.js";
import { displayWidth } from "../src/tty.js";

// `odw agents` and `odw result --agent` over a seeded run directory: the
// per-agent view works on a run that is still going.

async function cli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  (process.stdout as { write: unknown }).write = (s: unknown) => {
    if (Buffer.isBuffer(s)) return so(s);
    out.push(String(s));
    return true;
  };
  (process.stderr as { write: unknown }).write = (s: unknown) => {
    if (Buffer.isBuffer(s)) return se(s);
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

/** Color is up to the environment (FORCE_COLOR in CI): compare plain text. */
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/**
 * A live run (this process stands in for its worker) with one agent of every
 * kind: saved, replayed, running, failed, two sharing a label, finished but
 * never saved (an older run), and one with a very long reply.
 */
function seed(store: RunStore): string {
  const id = store.create({ script: "/demo/wf.js", args: null, source: "/demo" });
  store.updateStatus(id, { state: "running", pid: process.pid, name: "demo" });
  const emit = (type: string, agentId: number, label: string, extra: Record<string, unknown> = {}) =>
    appendFileSync(
      store.eventsPath(id),
      JSON.stringify({ ts: 100 + agentId, type, agentId, label, phase: "Work", adapter: "codex", ...extra }) + "\n",
    );
  const done = (agentId: number, label: string, value: unknown, extra: Partial<AgentResultRecord> = {}) => {
    emit("agent_started", agentId, label, extra.cached ? { cached: true, sourceRunId: extra.sourceRunId } : {});
    store.writeAgentResult(id, {
      agentId,
      key: `key-${agentId}`,
      label,
      phase: "Work",
      adapter: "codex",
      attempts: 1,
      startedAt: 100 + agentId,
      finishedAt: 102.5 + agentId,
      value,
      ...extra,
    });
    const marks = extra.cached ? { cached: true, sourceRunId: extra.sourceRunId } : {};
    emit("agent_finished", agentId, label, { ts: 102.5 + agentId, attempts: 1, saved: true, ...marks });
  };
  done(1, "scout", "line one\nline two \x1b[31mred\x1b[0m");
  done(2, "judge", { verdict: "pass", score: 0.9 }, { cached: true, sourceRunId: "run-0" });
  emit("agent_started", 3, "slow");
  emit("agent_started", 4, "broken");
  emit("agent_failed", 4, "broken", { error: "adapter 'codex' exited with code 1: boom" });
  done(5, "dup", "first dup");
  done(6, "dup", "second dup");
  emit("agent_started", 7, "legacy");
  emit("agent_finished", 7, "legacy", { attempts: 1 }); // finished, never saved
  done(8, "essay", "word ".repeat(2000));
  return id;
}

test("odw agents: a table of every agent with its state and a one-line preview", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-agents-cli-"));
  try {
    const store = new RunStore(root);
    const id = seed(store);
    const r = await cli(["agents", id, "--runs-root", root]);
    assert.equal(r.code, 0, r.err);
    const lines = plain(r.out).trimEnd().split("\n");
    assert.match(lines[0]!, /^ID\s+STATE\s+LABEL\s+PHASE\s+ADAPTER\s+TIME\s+VALUE$/);
    const row = (n: number) => lines.find((l) => l.trimStart().startsWith(`${n} `))!;
    assert.match(row(1), /^ 1\s+done\s+scout\s+Work\s+codex\s+2\.5s\s+line one line two red$/, "flattened, escapes stripped");
    assert.match(row(2), /^ 2\s+done (↺|\(r\))\s+judge\s+.*\{"verdict":"pass","score":0\.9\}$/);
    assert.match(row(3), /^ 3\s+running\s+slow\s+Work\s+codex\s+\S+$/, "a running agent has no value yet");
    assert.match(row(4), /^ 4\s+failed\s+broken\s+.*adapter 'codex' exited with code 1: boom$/);
    assert.match(row(7), /^ 7\s+done\s+legacy\s+.*\(not saved\)$/);
    assert.match(row(8), /essay .* word word \S*…$/, "a long value is cut to the line");
    for (const line of lines) assert.ok(displayWidth(line) <= 120, `fits 120 columns: ${line}`);
    assert.match(r.err, /replayed by odw resume/);
    assert.match(r.err, new RegExp(`full value: odw result ${id} --agent <id\\|label>`));

    const json = await cli(["agents", id, "--json", "--runs-root", root]);
    const rows = JSON.parse(json.out) as Array<Record<string, unknown>>;
    assert.deepEqual(
      rows.map((x) => [x.agentId, x.state, x.label, x.cached, x.saved]),
      [
        [1, "done", "scout", false, true],
        [2, "done", "judge", true, true],
        [3, "running", "slow", false, false],
        [4, "failed", "broken", false, false],
        [5, "done", "dup", false, true],
        [6, "done", "dup", false, true],
        [7, "done", "legacy", false, false],
        [8, "done", "essay", false, true],
      ],
    );
    assert.deepEqual(rows[1], {
      agentId: 2,
      state: "done",
      label: "judge",
      phase: "Work",
      adapter: "codex",
      startedAt: 102,
      finishedAt: 104.5,
      durationMs: 2500,
      cached: true,
      sourceRunId: "run-0",
      saved: true,
      error: null,
      preview: '{"verdict":"pass","score":0.9}',
    });
    assert.equal(rows[3]!.error, "adapter 'codex' exited with code 1: boom");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("odw result --agent prints one agent's value by id or label, mid-run", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-agents-cli-"));
  try {
    const store = new RunStore(root);
    const id = seed(store);
    const result = (ref: string) => cli(["result", id, "--agent", ref, "--runs-root", root]);

    let r = await result("judge");
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(JSON.parse(r.out), { verdict: "pass", score: 0.9 });
    r = await result("1");
    assert.equal(JSON.parse(r.out), "line one\nline two \x1b[31mred\x1b[0m");
    assert.doesNotMatch(r.out, /\x1b/, "JSON escapes the control characters");
    r = await result("6");
    assert.equal(JSON.parse(r.out), "second dup");

    // A label shared by several agents is ambiguous: name one by id.
    r = await result("dup");
    assert.equal(r.code, 1);
    assert.equal(r.out, "");
    assert.match(r.err, new RegExp(`label 'dup' matches 2 agents of run ${id}: 5 \\(done\\), 6 \\(done\\) — pick one: odw result ${id} --agent <id>`));

    r = await result("slow");
    assert.deepEqual([r.code, r.err], [1, "agent 3 (slow) is running: no result yet\n"]);
    r = await result("broken");
    assert.deepEqual([r.code, r.err], [1, "agent 4 (broken) failed: adapter 'codex' exited with code 1: boom\n"]);
    r = await result("legacy");
    assert.equal(r.code, 1);
    assert.match(r.err, /agent 7 \(legacy\) finished, but no result was saved for it/);
    r = await result("nobody");
    assert.deepEqual([r.code, r.err], [1, `run ${id} has no agent 'nobody' (see odw agents ${id})\n`]);

    // Without --agent, result still means the run's final value.
    r = await cli(["result", id, "--runs-root", root]);
    assert.deepEqual([r.code, r.err], [1, "run is still 'running'; not finished\n"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("odw agents: no agents yet, missing run id, unknown run", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-agents-cli-"));
  try {
    const store = new RunStore(root);
    const id = store.create({ script: "/demo/wf.js", args: null, source: "/demo" });
    let r = await cli(["agents", id, "--runs-root", root]);
    assert.deepEqual([r.code, r.out, r.err], [0, "", `run ${id} has no agents yet\n`]);
    r = await cli(["agents", id, "--json", "--runs-root", root]);
    assert.deepEqual([r.code, JSON.parse(r.out)], [0, []]);
    r = await cli(["agents"]);
    assert.deepEqual([r.code, r.err], [2, "odw agents: missing <run_id>\n"]);
    r = await cli(["agents", "no-such-run", "--runs-root", root]);
    assert.deepEqual([r.code, r.err], [1, "no such run: no-such-run\n"]);
    r = await cli(["result", "no-such-run", "--agent", "1", "--runs-root", root]);
    assert.deepEqual([r.code, r.err], [1, "no such run: no-such-run\n"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
