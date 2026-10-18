import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import type { WorkflowEvent } from "../src/events.js";
import { RunStore } from "../src/runtime/run-store.js";
import { foldAgents } from "../src/runtime/runs-view.js";
import { executeRun } from "../src/runtime/worker.js";

const mockAgent = fileURLToPath(new URL("./fixtures/mock-agent.mjs", import.meta.url));
const exampleDir = fileURLToPath(new URL("../examples/", import.meta.url));

/** A person's answer to the next checkpoint() a run asks (sent through its decision log, as `odw approve|reject` does). */
type Answer = { action: "approve" | "reject"; note?: string; payload?: unknown };

async function runExample(
  file: string,
  args: unknown,
  agentCommand: string[] = [execPath, mockAgent],
  answers: Answer[] = [],
): Promise<{ state: string; result: unknown; error: Record<string, unknown> | null; events: WorkflowEvent[] }> {
  const root = mkdtempSync(join(tmpdir(), "odw-ex-"));
  // isolation:"worktree" (used by ultra-mode's lanes) needs a committed repo.
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t",
    "commit", "-q", "--no-gpg-sign", "--allow-empty", "-m", "init"]);
  try {
    const config = join(root, "odw.config.json");
    writeFileSync(
      config,
      JSON.stringify({
        defaultAdapter: "mock",
        schemaRetries: 1,
        concurrency: 8,
        adapters: { mock: { command: agentCommand, stdin: "{prompt}" } },
      }),
    );
    const store = new RunStore(root);
    const id = store.create({
      script: join(exampleDir, file),
      args,
      source: root,
      configPath: config,
    });
    const run = executeRun(store.runDir(id));
    // A run left waiting for an answer the test never gives would wait forever: stop it.
    const guard = answers.length > 0 ? setTimeout(() => store.writeControl(id, "stop"), 30_000) : undefined;
    let ended = false;
    void run.finally(() => (ended = true));
    for (const [i, answer] of answers.entries()) {
      const asked = () => store.readEvents(id).some((e) => e.type === "checkpoint_requested" && e.checkpointId === i + 1);
      while (!asked() && !ended) await new Promise<void>((resolve) => setTimeout(resolve, 20));
      if (ended) break;
      store.requestCheckpointDecision(id, { ...answer, checkpointId: i + 1, by: "cli" });
    }
    const state = await run.finally(() => clearTimeout(guard));
    return { state, result: store.readResult(id), error: store.readError(id), events: store.readEvents(id) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("fan-out-reduce.js runs to a synthesized answer", async () => {
  const { state, result, error } = await runExample("fan-out-reduce.js", {
    question: "Design a cache.",
    drafts: 3,
  });
  assert.equal(state, "done", JSON.stringify(error));
  assert.equal(typeof result, "string");
});

test("adversarial-verify.js runs and returns confirmed findings", async () => {
  const { state, result, error } = await runExample("adversarial-verify.js", {
    target: "Review x",
    voters: 3,
  });
  assert.equal(state, "done", JSON.stringify(error));
  const r = result as { considered: number; confirmed: unknown[] };
  assert.ok(r.considered >= 1);
  assert.ok(Array.isArray(r.confirmed));
});

test("loop-until-dry.js runs bounded by maxRounds", async () => {
  const { state, result, error } = await runExample("loop-until-dry.js", {
    target: "find x",
    finders: 2,
    maxRounds: 2,
  });
  assert.equal(state, "done", JSON.stringify(error));
  const r = result as { rounds: number; discovered: unknown[] };
  assert.ok(r.rounds <= 2);
  assert.ok(Array.isArray(r.discovered));
});

// A suite that stays red until fixed.txt exists in the source dir, and a mock
// fixer CLI that writes it only when its prompt carries the suite's failure.
const SUITE =
  "if(!require('fs').existsSync('fixed.txt')){console.error('1 failing: add() returns NaN');process.exit(1)}" +
  "console.log('all green')";
const FIXER =
  "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{" +
  "if(d.includes('add() returns NaN'))require('fs').writeFileSync('fixed.txt','1');" +
  "process.stdout.write('patched add()')})";

test("test-fix-loop.js runs the tests with exec(), fixes with an agent, and re-runs until green", async () => {
  const { state, result, error, events } = await runExample(
    "test-fix-loop.js",
    { test: [execPath, "-e", SUITE], maxRounds: 3 },
    [execPath, "-e", FIXER],
  );
  assert.equal(state, "done", JSON.stringify(error));
  const r = result as { passed: boolean; rounds: number; history: Array<{ result: string; fix?: string }> };
  assert.equal(r.passed, true, "the fixer saw the failure, and the re-run tested its edit");
  assert.equal(r.rounds, 1, "one fix round, then green");
  assert.deepEqual(r.history.map((h) => h.result), ["exit 1", "exit 0"]);
  assert.equal(r.history[1]!.fix, "patched add()");
  assert.deepEqual(
    foldAgents(events).map((n) => [n.kind, n.label, n.state]),
    [
      ["command", "tests", "failed"],
      ["agent", "fix r1", "done"],
      ["command", "tests r1", "done"],
    ],
  );
});

test("test-fix-loop.js stops after maxRounds when the tests stay red", async () => {
  const { state, result, error, events } = await runExample("test-fix-loop.js", {
    test: [execPath, "-e", "console.error('still broken'); process.exit(1)"],
    maxRounds: 2,
  });
  assert.equal(state, "done", JSON.stringify(error));
  const r = result as { passed: boolean; rounds: number; history: unknown[] };
  assert.equal(r.passed, false);
  assert.equal(r.rounds, 2);
  assert.equal(r.history.length, 3, "the first run plus one per fix round");
  const nodes = foldAgents(events);
  assert.equal(nodes.filter((n) => n.kind === "command").length, 3);
  assert.equal(nodes.filter((n) => n.kind === "agent").length, 2);
});

// A fixer that says it fixed the bug the first time without touching a file —
// the silent failure `expect` exists for — and really fixes it once told what
// its previous attempt missed.
const CLAIMS_FIRST =
  "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{" +
  "if(d.includes('did not meet these expectations'))require('fs').writeFileSync('fixed.txt','1');" +
  "process.stdout.write('patched add()')})";

test("fix-until-green.js: expect catches a fix that never happened and hands the red suite back until it is green", async () => {
  const { state, result, error, events } = await runExample(
    "fix-until-green.js",
    { test: [execPath, "-e", SUITE], retries: 2 },
    [execPath, "-e", CLAIMS_FIRST],
  );
  assert.equal(state, "done", JSON.stringify(error));
  assert.deepEqual(result, { passed: true, fixed: true, summary: "patched add()" });
  assert.deepEqual(
    foldAgents(events).map((n) => [n.kind, n.label, n.state]),
    [
      ["command", "tests", "failed"],
      ["agent", "fixer", "done"],
      ["command", "fixer: expect", "failed"],
      ["command", "fixer: expect", "done"],
    ],
  );
  assert.equal(events.find((e) => e.type === "agent_finished")?.attempts, 2);
});

test("fix-until-green.js reports a suite that stays red with what the fixer missed, not its word", async () => {
  const { state, result, error, events } = await runExample("fix-until-green.js", {
    test: [execPath, "-e", "console.error('still broken'); process.exit(1)"],
    retries: 1,
  });
  assert.equal(state, "done", JSON.stringify(error));
  const r = result as { passed: boolean; reason: string; misses: string[] };
  assert.equal(r.passed, false);
  assert.equal(r.reason, "unmet_expectation");
  assert.equal(r.misses.length, 2);
  assert.equal(r.misses[0], "a file must change, and none did");
  assert.match(r.misses[1]!, /must exit 0, and it exited with code 1$/);
  const failed = events.find((e) => e.type === "agent_failed");
  assert.equal(failed?.reason, "unmet_expectation");
  assert.deepEqual(failed?.misses, r.misses);
});

test("fix-until-green.js starts no agent when the suite is already green", async () => {
  const { state, result, events } = await runExample("fix-until-green.js", { test: [execPath, "-e", ""] });
  assert.equal(state, "done");
  assert.deepEqual(result, { passed: true, fixed: false });
  assert.equal(events.filter((e) => e.type === "agent_started").length, 0);
});

test("routing.js classifies, routes, and grades", async () => {
  const { state, result, error } = await runExample("routing.js", {
    request: "Add dark mode to settings",
  });
  assert.equal(state, "done", JSON.stringify(error));
  const r = result as { category: string; output: string; grade: { verdict: string } };
  assert.equal(typeof r.category, "string");
  assert.equal(typeof r.output, "string");
  assert.equal(typeof r.grade.verdict, "string");
});

test("generate-and-filter.js generates, dedupes, and keeps survivors", async () => {
  const { state, result, error } = await runExample("generate-and-filter.js", {
    topic: "Cut build times",
    generators: 3,
  });
  assert.equal(state, "done", JSON.stringify(error));
  const r = result as { unique: number; generated: number; kept: unknown[] };
  assert.ok(r.generated >= 1);
  assert.ok(Array.isArray(r.kept));
  assert.ok(r.kept.length >= 1);
});

test("tournament.js runs a bracket to a single winner", async () => {
  const { state, result, error } = await runExample("tournament.js", {
    task: "Design a cache",
    approaches: ["simple", "scalable", "safe", "fast"],
  });
  assert.equal(state, "done", JSON.stringify(error));
  const r = result as { winner: { seed: number }; rounds: unknown[] };
  assert.ok(r.winner && typeof r.winner.seed === "number");
  assert.ok(Array.isArray(r.rounds) && r.rounds.length >= 1);
});

test("ultra-mode.js plans, fans out, reviews, and synthesizes", async () => {
  const { state, result, error } = await runExample("ultra-mode.js", {
    task: "Plan a safe refactor",
    intensity: "lite",
    lanes: 3,
    reviewers: 2,
  });
  assert.equal(state, "done", JSON.stringify(error));
  const r = result as {
    plan: { workstreams: unknown[] };
    lanes: unknown[];
    reviews: unknown[];
    final: { answer: string; actionPlan: unknown[] };
  };
  assert.ok(Array.isArray(r.plan.workstreams));
  assert.ok(Array.isArray(r.lanes) && r.lanes.length >= 1);
  assert.ok(Array.isArray(r.reviews) && r.reviews.length >= 1);
  assert.equal(typeof r.final.answer, "string");
  assert.ok(Array.isArray(r.final.actionPlan));
});

test("agent-daily-digest.js runs end-to-end (discover -> extract -> synthesize -> verify -> report)", async () => {
  const { state, result, error } = await runExample("agent-daily-digest.js", {
    date: "2026-06-04",
    maxSessions: 5,
    maxVerify: 3,
  });
  assert.equal(state, "done", JSON.stringify(error));
  const r = result as {
    date: string;
    scope: { agents: string[]; sessionCount: number };
    digest: { headline: string; sections: Record<string, unknown[]> };
    markdown: string;
    stats: { sessions: number; candidateItems: number };
  };
  assert.equal(typeof r.markdown, "string");
  assert.ok(r.markdown.length > 0, "rendered a non-empty digest");
  assert.ok(Array.isArray(r.digest.sections.progress), "digest has a progress section");
  assert.ok(Array.isArray(r.digest.sections.followups), "digest has a followups section");
  assert.ok(r.stats.sessions >= 1, "scanned at least one session");
});

test("deep-research-verified.js runs end-to-end, every schema within what ODW checks", async () => {
  const { state, result, error, events } = await runExample("deep-research-verified.js", "Is the sky blue?");
  assert.equal(state, "done", JSON.stringify(error));
  // A schema keyword ODW does not check would be logged (or, under "strict", refused): none is.
  assert.deepEqual(events.filter((e) => e.type === "agent_failed"), []);
  assert.deepEqual(events.filter((e) => e.type === "log" && /schema keywords ODW does not check/.test(String(e.message))), []);
  const r = result as { question: string; stats: { angles: number; sourcesFetched: number; claimsVerified: number } };
  assert.equal(r.question, "Is the sky blue?");
  assert.ok(r.stats.angles >= 3 && r.stats.sourcesFetched > 0 && r.stats.claimsVerified > 0, JSON.stringify(r.stats));
});

test("review-swarm.js maps, reviews per lens, verifies every finding and summarizes", async () => {
  const { state, result, error } = await runExample("review-swarm.js", { lenses: ["correctness", "security"] });
  assert.equal(state, "done", JSON.stringify(error));
  const r = result as { summary: unknown; confirmed: unknown[]; rejected: number; lenses: string[] };
  assert.equal(typeof r.summary, "string");
  assert.ok(Array.isArray(r.confirmed));
  assert.equal(typeof r.rejected, "number");
  assert.deepEqual(r.lenses, ["correctness", "security"]);
});

test("coordinated-refactor.js runs isolated lanes on the notes board, reviews them, and reconciles the clashing ones", async () => {
  const { state, result, error, events } = await runExample("coordinated-refactor.js", { tasks: ["rename parseX", "add --strict"] });
  assert.equal(state, "done", JSON.stringify(error));
  const r = result as { lanes: unknown[]; clashes: Array<{ lane: number }>; reconciled: Array<{ lane: number; summary: unknown }> };
  assert.equal(r.lanes.length, 2);
  // The mock reviewer names lane 1 (its schema's minimum): it runs again, under its own label.
  assert.deepEqual(r.reconciled.map((x) => x.lane), [1]);
  const labels = events.filter((e) => e.type === "agent_finished").map((e) => e.label);
  assert.deepEqual(labels.sort(), ["lane-1", "lane-1-reconciled", "lane-2", "reviewer"]);
  const phases = events.filter((e) => e.type === "phase_started").map((e) => e.phase);
  assert.deepEqual(phases, ["Change", "Review", "Reconcile"]);
});

// plan-approve-execute.js: a person answers its checkpoint() through the decision log.
const PLAN_TASK = { task: "Add rate limiting to the public API" };

test("plan-approve-execute.js executes the plan only once a person approves it", async () => {
  const { state, result, error, events } = await runExample("plan-approve-execute.js", PLAN_TASK, undefined, [
    { action: "approve", note: "go ahead" },
  ]);
  assert.equal(state, "done", JSON.stringify(error));
  const r = result as {
    approved: boolean;
    by: string;
    note: string;
    plan: { steps: unknown[] };
    steps: { total: number; done: number };
    report: string;
  };
  assert.equal(r.approved, true);
  assert.equal(r.by, "cli");
  assert.equal(r.note, "go ahead");
  assert.deepEqual(r.steps, { total: r.plan.steps.length, done: r.plan.steps.length });
  assert.equal(typeof r.report, "string");
  const asked = events.filter((e) => e.type === "checkpoint_requested");
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0]!.payload, r.plan, "the person saw the plan that ran");
  // Nothing executed before the approval.
  const answeredAt = events.findIndex((e) => e.type === "checkpoint_resolved");
  assert.ok(events.findIndex((e) => e.type === "agent_started" && String(e.label).startsWith("step")) > answeredAt);
});

test("plan-approve-execute.js runs the plan as the person edited it", async () => {
  const edited = { summary: "Only the gateway.", steps: [{ title: "gateway", instructions: "Rate-limit the gateway only." }] };
  const { state, result, error, events } = await runExample("plan-approve-execute.js", PLAN_TASK, undefined, [
    { action: "approve", payload: edited },
  ]);
  assert.equal(state, "done", JSON.stringify(error));
  const r = result as { edited: boolean; plan: unknown; steps: { total: number } };
  assert.equal(r.edited, true);
  assert.deepEqual(r.plan, edited);
  assert.equal(r.steps.total, 1);
  assert.deepEqual(
    foldAgents(events).filter((n) => n.phase === "Execute").map((n) => n.label),
    ["step 1"],
    "only the edited plan's step ran",
  );
});

test("plan-approve-execute.js re-plans after a rejection with a note, and stops on a bare rejection", async () => {
  const replanned = await runExample("plan-approve-execute.js", PLAN_TASK, undefined, [
    { action: "reject", note: "leave the admin routes alone" },
    { action: "approve" },
  ]);
  assert.equal(replanned.state, "done", JSON.stringify(replanned.error));
  assert.equal((replanned.result as { approved: boolean }).approved, true);
  assert.deepEqual(
    foldAgents(replanned.events)
      .filter((n) => n.phase === "Plan")
      .map((n) => n.label),
    ["plan 1", "plan 2"],
  );
  assert.equal(replanned.events.filter((e) => e.type === "checkpoint_requested").length, 2);

  const rejected = await runExample("plan-approve-execute.js", PLAN_TASK, undefined, [{ action: "reject" }]);
  assert.equal(rejected.state, "done", JSON.stringify(rejected.error));
  const r = rejected.result as { approved: boolean; by: string; note: string | null };
  assert.deepEqual([r.approved, r.by, r.note], [false, "cli", null]);
  assert.equal(foldAgents(rejected.events).some((n) => n.phase === "Execute"), false, "nothing ran");
});

test("plan-approve-execute.js treats silence as a rejection once its timeout passes", async () => {
  const { state, result, error } = await runExample("plan-approve-execute.js", { ...PLAN_TASK, timeout: 0.05 });
  assert.equal(state, "done", JSON.stringify(error));
  const r = result as { approved: boolean; by: string };
  assert.deepEqual([r.approved, r.by], [false, "timeout"]);
});
