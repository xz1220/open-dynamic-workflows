import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaudeRunSource, encodeProjectDir } from "../src/runtime/claude-run-source.js";

const CWD = "/Users/test/myrepo";
const OTHER = "/Users/test/otherrepo";

/** Build a fake ~/.claude/projects tree: one terminal + one live run under CWD,
 *  plus one terminal run under an unrelated project. Returns the projects root. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "cc-projects-"));
  const sess = join(root, encodeProjectDir(CWD), "5fe06326-session");
  mkdirSync(join(sess, "workflows", "scripts"), { recursive: true });
  mkdirSync(join(sess, "subagents", "workflows", "wf_live1"), { recursive: true });

  // --- terminal journal ---
  writeFileSync(
    join(sess, "workflows", "wf_term1.json"),
    JSON.stringify({
      runId: "wf_term1",
      timestamp: "2026-06-01T10:00:00.000Z",
      status: "completed",
      workflowName: "my-terminal-wf",
      startTime: 1780000000000, // epoch MS
      durationMs: 120000,
      script: "export const meta = { name: 'my-terminal-wf' }",
      args: JSON.stringify({ n: 2 }),
      result: { final: { ok: true } },
      logs: ["hello", { message: "world" }],
      workflowProgress: [
        { type: "workflow_phase", index: 1, title: "Map" },
        { type: "workflow_phase", index: 2, title: "Reduce" },
        { type: "workflow_agent", index: 1, label: "a1", phaseTitle: "Map", agentId: "x1", model: "claude-opus-4-8", state: "done", startedAt: 1780000001000, attempt: 1, durationMs: 5000 },
        { type: "workflow_agent", index: 2, label: "a2", phaseTitle: "Reduce", agentId: "x2", model: "claude-sonnet-4-6", state: "done", startedAt: 1780000010000, attempt: 1, durationMs: 8000 },
      ],
    }),
  );

  // --- live run: 3 started, 1 result (by key) -> running=2, done=1; no terminal sibling ---
  writeFileSync(join(sess, "workflows", "scripts", "my-live-wf-wf_live1.js"), "export const meta = { name: 'my-live-wf' }");
  const journal =
    [
      { type: "started", key: "v2:k1", agentId: "a1" },
      { type: "started", key: "v2:k2", agentId: "a2" },
      { type: "started", key: "v2:k3", agentId: "a3" },
      { type: "result", key: "v2:k1", agentId: "a1", result: "{}" },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n";
  writeFileSync(join(sess, "subagents", "workflows", "wf_live1", "journal.jsonl"), journal);
  writeFileSync(join(sess, "subagents", "workflows", "wf_live1", "agent-a2.jsonl"), "{}\n");

  // --- an unrelated project's terminal run (for scope tests) ---
  const other = join(root, encodeProjectDir(OTHER), "other-session", "workflows");
  mkdirSync(other, { recursive: true });
  writeFileSync(
    join(other, "wf_other.json"),
    JSON.stringify({ runId: "wf_other", status: "completed", workflowName: "other-wf", startTime: 1780000500000, durationMs: 1000, workflowProgress: [] }),
  );
  return root;
}

test("encodeProjectDir replaces every non-alnum/dash char with a dash", () => {
  assert.equal(encodeProjectDir("/Users/test/myrepo"), "-Users-test-myrepo");
  // a worktree under .claude collapses /.claude -> --claude
  assert.equal(
    encodeProjectDir("/Users/test/myrepo/.claude/worktrees/feat"),
    "-Users-test-myrepo--claude-worktrees-feat",
  );
});

test("folds a terminal Claude journal into a RunSummary/RunDetail (units, ids, counts)", () => {
  const root = fixture();
  try {
    const src = new ClaudeRunSource({ projectsRoot: root, cwd: CWD, scope: "all" });
    const summaries = src.listSummaries();
    const term = summaries.find((r) => r.runId === "cc-wf_term1");
    assert.ok(term, "terminal run present");
    assert.equal(term!.provider, "claude");
    assert.equal(term!.state, "done");
    assert.equal(term!.name, "my-terminal-wf");
    // startTime 1780000000000 ms -> 1780000000 s ; +120000ms duration -> +120s
    assert.equal(term!.createdAt, 1780000000);
    assert.equal(term!.updatedAt, 1780000120);
    assert.deepEqual(term!.counts, { agents: 2, running: 0, done: 2, failed: 0, stale: 0 });
    assert.equal(term!.progress, 1);

    const det = src.detail("cc-wf_term1")!;
    assert.ok(det);
    assert.deepEqual(det.args, { n: 2 }); // JSON-string args parsed
    assert.match(det.script ?? "", /meta/);
    assert.equal(det.hasResult, true);
    assert.deepEqual(det.phaseOrder, ["Map", "Reduce"]);
    const a1 = det.agents[0]!;
    assert.equal(a1.label, "a1");
    assert.equal(a1.phase, "Map");
    assert.equal(a1.adapter, "claude-opus-4-8");
    assert.equal(a1.attempts, 1);
    assert.equal(a1.durationMs, 5000); // durationMs is the ONE field kept as ms (1:1)
    assert.equal(a1.startedAt, 1780000001); // startedAt ms -> s
    assert.equal(a1.finishedAt, 1780000006); // startedAt + durationMs/1000

    // synthesized events drive the Logs tab + phase stepper + DAG
    const evs = src.events("cc-wf_term1", 0);
    const types = evs.map((e) => e.type);
    assert.ok(types.includes("phase_started"));
    assert.ok(types.includes("agent_started"));
    assert.ok(types.includes("agent_finished"));
    assert.ok(types.includes("run_finished"));
    assert.equal(evs.filter((e) => e.type === "log").length, 2); // string + {message}

    const result = src.result("cc-wf_term1");
    assert.equal(result.has, true);
    assert.deepEqual(result.value, { ok: true }); // result.final unwrapped
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detects a RUNNING live workflow (no terminal sibling): running=started-not-finished, by last-line-per-key", () => {
  const root = fixture();
  try {
    const src = new ClaudeRunSource({ projectsRoot: root, cwd: CWD, scope: "all", now: () => Date.now() });
    const live = src.listSummaries().find((r) => r.runId === "cc-wf_live1");
    assert.ok(live, "live run present");
    assert.equal(live!.state, "running");
    assert.equal(live!.name, "my-live-wf"); // derived from scripts/<name>-wf_live1.js
    assert.deepEqual(live!.counts, { agents: 3, running: 2, done: 1, failed: 0, stale: 0 });
    assert.ok((live!.createdAt ?? 0) > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a live run with no fresh signal folds to STALE, never 'failed'", () => {
  const root = fixture();
  try {
    // now() 10 minutes in the future > the 90s freshness window
    const src = new ClaudeRunSource({ projectsRoot: root, cwd: CWD, scope: "all", now: () => Date.now() + 600_000 });
    const live = src.listSummaries().find((r) => r.runId === "cc-wf_live1");
    assert.ok(live);
    assert.equal(live!.state, "stale");
    assert.equal(live!.stale, true);
    assert.deepEqual(live!.counts, { agents: 3, running: 0, done: 1, failed: 0, stale: 2 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one source instance: a cached live run turns stale once the freshness window passes", () => {
  const root = fixture();
  try {
    let nowMs = Date.now();
    const src = new ClaudeRunSource({ projectsRoot: root, cwd: CWD, scope: "all", now: () => nowMs });
    const live = () => src.listSummaries().find((r) => r.runId === "cc-wf_live1")!;
    assert.equal(live().state, "running");

    nowMs += 600_000; // no file changes at all — only the clock moves
    assert.equal(live().state, "stale", "a cached 'running' must not outlive the freshness window");
    assert.deepEqual(live().counts, { agents: 3, running: 0, done: 1, failed: 0, stale: 2 });
    assert.equal(src.detail("cc-wf_live1")!.state, "stale", "list and detail agree");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one source instance: a write to ANY running agent's transcript revives a stale live run", () => {
  const root = fixture();
  try {
    const live1 = join(root, encodeProjectDir(CWD), "5fe06326-session", "subagents", "workflows", "wf_live1");
    // Sizes chosen so the old "newest signature wins" lexicographic compare
    // ("950:…" > "1200:…") would have ignored every change to the transcript.
    writeFileSync(join(live1, "journal.jsonl"), readFileSync(join(live1, "journal.jsonl"), "utf8").padEnd(950, " "));
    writeFileSync(join(live1, "agent-a2.jsonl"), "x".repeat(1200));
    const old = Date.now() / 1000 - 600;
    for (const f of ["journal.jsonl", "agent-a2.jsonl"]) utimesSync(join(live1, f), old, old);

    const src = new ClaudeRunSource({ projectsRoot: root, cwd: CWD, scope: "all" });
    const live = () => src.listSummaries().find((r) => r.runId === "cc-wf_live1")!;
    assert.equal(live().state, "stale");

    appendFileSync(join(live1, "agent-a2.jsonl"), "{}\n"); // agent a2 is still working
    assert.equal(live().state, "running");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review: a journal's agentId is a transcript's name only in its shape — never a path out of the run directory", () => {
  const root = fixture();
  try {
    const live1 = join(root, encodeProjectDir(CWD), "5fe06326-session", "subagents", "workflows", "wf_live1");
    // An id that walks up: agent-x/../../outside.jsonl is a file beside the run directory, kept fresh by someone else.
    writeFileSync(join(live1, "journal.jsonl"), JSON.stringify({ type: "started", key: "v2:k9", agentId: "x/../../outside" }) + "\n");
    writeFileSync(join(live1, "..", "outside.jsonl"), "{}\n");
    const old = Date.now() / 1000 - 600;
    for (const f of ["journal.jsonl", "agent-a2.jsonl"]) utimesSync(join(live1, f), old, old);
    const src = new ClaudeRunSource({ projectsRoot: root, cwd: CWD, scope: "all" });
    assert.equal(src.listSummaries().find((r) => r.runId === "cc-wf_live1")!.state, "stale", "the file outside is never stat'ed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Counts full discovery walks (every project + session dir). */
class CountingSource extends ClaudeRunSource {
  walks = 0;
  protected override discover() {
    this.walks++;
    return super.discover();
  }
}

test("run lookups use the location index instead of rescanning every project", () => {
  const root = fixture();
  try {
    const src = new CountingSource({ projectsRoot: root, cwd: CWD, scope: "all" });
    src.listSummaries();
    assert.equal(src.walks, 1);

    // What the server does per request: exists() (routing) then detail/events/result.
    assert.equal(src.exists("cc-wf_term1"), true);
    assert.equal(src.detail("cc-wf_term1")!.name, "my-terminal-wf");
    assert.ok(src.events("cc-wf_term1", 0).length > 0);
    assert.equal(src.result("cc-wf_term1").has, true);
    assert.equal(src.summary("cc-wf_live1")!.state, "running");
    assert.equal(src.walks, 1, "indexed lookups never walk the projects tree");

    // A live run that finished since the walk is re-validated to its terminal journal.
    const sess = join(root, encodeProjectDir(CWD), "5fe06326-session");
    writeFileSync(
      join(sess, "workflows", "wf_live1.json"),
      JSON.stringify({ runId: "wf_live1", status: "completed", workflowName: "my-live-wf", startTime: 1780000000000, durationMs: 1, workflowProgress: [] }),
    );
    assert.equal(src.detail("cc-wf_live1")!.state, "done");
    assert.equal(src.walks, 1);

    // A miss (new or unknown run) falls back to one walk, which refreshes the index.
    mkdirSync(join(sess, "subagents", "workflows", "wf_new"), { recursive: true });
    assert.equal(src.exists("cc-wf_new"), true);
    assert.equal(src.walks, 2);
    assert.equal(src.detail("cc-wf_new")!.provider, "claude");
    assert.equal(src.walks, 2);
    assert.equal(src.detail("cc-wf_missing"), null);
    assert.equal(src.walks, 3);

    // A deleted run is not served from the index.
    rmSync(join(sess, "workflows", "wf_term1.json"));
    assert.equal(src.exists("cc-wf_term1"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a cached terminal detail is not corrupted by a caller mutating it", () => {
  const root = fixture();
  try {
    const src = new ClaudeRunSource({ projectsRoot: root, cwd: CWD, scope: "all" });
    src.detail("cc-wf_term1")!.agents[0]!.label = "mutated";
    assert.equal(src.detail("cc-wf_term1")!.agents[0]!.label, "a1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scope: 'project' sees only the served repo; 'all' sees every project", () => {
  const root = fixture();
  try {
    const all = new ClaudeRunSource({ projectsRoot: root, cwd: CWD, scope: "all" }).listSummaries();
    const proj = new ClaudeRunSource({ projectsRoot: root, cwd: CWD, scope: "project" }).listSummaries();
    assert.equal(all.length, 3); // term1 + live1 + other
    assert.ok(all.some((r) => r.runId === "cc-wf_other"));
    assert.equal(proj.length, 2); // term1 + live1 only
    assert.ok(!proj.some((r) => r.runId === "cc-wf_other"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude runs are read-only: owns() cc- ids, controlError is set, missing root is empty", () => {
  const src = new ClaudeRunSource({ projectsRoot: join(tmpdir(), "does-not-exist-xyz"), cwd: CWD });
  assert.equal(src.owns("cc-wf_x"), true);
  assert.equal(src.owns("20260101-120000-abcdef"), false); // an ODW id
  assert.ok(src.controlError && src.controlError.length > 0);
  assert.deepEqual(src.listSummaries(), []); // missing projects root -> no jobs, no throw
  assert.equal(src.detail("cc-wf_x"), null);
});
