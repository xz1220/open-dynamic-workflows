/**
 * `odw outcomes` (ODW extension): what became of the work runs did, across
 * runs and weeks, from their recorded evidence and the review marks. Runs are
 * written straight into a RunStore (meta, status, events, kept diffs); no
 * model runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { main } from "../src/cli.js";
import { collectOutcomes, formatOutcomes, modelKey, outcomesMarkdown, shiftsOf, emptyRow, weekStart } from "../src/runtime/outcomes.js";
import { appendReview } from "../src/runtime/review.js";
import { RunStore } from "../src/runtime/run-store.js";
import { startServer } from "../src/runtime/server.js";
import { capture } from "./schedule-fixture.js";

const DAY = 86_400;
/** Wednesday 2026-10-14 12:00 UTC. */
const UNTIL = Date.UTC(2026, 9, 14, 12) / 1000;
const SINCE = UNTIL - 14 * DAY;

/** What an agent replied: an outcomes report never repeats it. */
const CLAIM = "ALL DONE, every test passes, trust me";

interface Box {
  root: string;
  runsRoot: string;
  store: RunStore;
  script: string;
  cleanup(): void;
}

function scratch(): Box {
  const root = mkdtempSync(join(tmpdir(), "odw-outcomes-"));
  const runsRoot = join(root, "runs");
  const store = new RunStore(runsRoot);
  const script = join(root, "wf.js");
  writeFileSync(script, "export const meta = { name: 'w', description: 'd' }\nreturn 1");
  return { root, runsRoot, store, script, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const DIFF = "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n";
const CHANGES = { files: 1, insertions: 1, deletions: 1, truncated: false };

/** A run of `workflow`, created `createdAt`, settled in `state`, with `events`; `kept` agent ids get a diff on disk. */
function fakeRun(
  box: Box,
  workflow: string,
  state: string,
  createdAt: number,
  events: Array<Record<string, unknown>>,
  extra: { kept?: number[]; meta?: Record<string, unknown>; status?: Record<string, unknown>; dry?: boolean } = {},
): string {
  const runId = box.store.create({ script: box.script, args: null, source: box.root, workflowName: workflow, dry: extra.dry ?? null });
  const dir = box.store.runDir(runId);
  const meta = box.store.readMeta(runId);
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ ...meta, createdAt, ...extra.meta }));
  writeFileSync(join(dir, "status.json"), JSON.stringify({ runId, name: workflow, state, updatedAt: createdAt + 600, ...extra.status }));
  for (const ev of events) appendFileSync(box.store.eventsPath(runId), JSON.stringify({ ts: createdAt + 60, ...ev }) + "\n");
  for (const id of extra.kept ?? []) {
    const file = box.store.agentDiffPath(runId, id);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, DIFF);
  }
  if (state === "done") box.store.writeResult(runId, { reply: CLAIM });
  return runId;
}

const started = (agentId: number, label: string, adapter: string, model?: string) => ({ type: "agent_started", agentId, label, adapter, ...(model ? { model } : {}) });
const finished = (agentId: number, label: string, adapter: string, more: Record<string, unknown> = {}) => ({ type: "agent_finished", agentId, label, adapter, result: CLAIM, ...more });
const usage = (costUsd: number, tokens: number) => ({ inputTokens: tokens / 2, outputTokens: tokens / 2, costUsd });

/** Runs across two weeks and the window before, and some that must stay out. */
function seed(box: Box) {
  // This week (from Monday 2026-10-12): three kept diffs — applied after a retry, dismissed, left — and a failure.
  const fixer = fakeRun(box, "fixer", "done", UNTIL - 1 * DAY, [
    started(0, "fix", "claude", "opus"),
    { type: "log", agentId: 0, message: "retrying", retry: { reason: "expect", n: 1, of: 2 } },
    finished(0, "fix", "claude", { changes: CHANGES, servedModel: ["claude-opus-5-5"], usage: usage(2, 4000) }),
    started(1, "tidy", "codex", "gpt-5"),
    finished(1, "tidy", "codex", { changes: CHANGES, usage: usage(1, 2000) }),
    started(2, "docs", "codex", "gpt-5"),
    finished(2, "docs", "codex", { changes: CHANGES, outOfScope: ["README.md"], usage: usage(1, 2000) }),
    started(3, "scan", "codex"),
    finished(3, "scan", "codex", { changes: null, usage: usage(0, 1000) }),
  ], { kept: [0, 1, 2] });
  appendReview(box.store.runDir(fixer), { agentId: 0, state: "reviewed", by: "dan", via: "cli" });
  appendReview(box.store.runDir(fixer), { agentId: 0, state: "applied", by: "dan", via: "apply" });
  appendReview(box.store.runDir(fixer), { agentId: 1, state: "dismissed", by: "dan", via: "dashboard", note: "wrong file" });
  appendReview(box.store.runDir(fixer), { agentId: 2, state: "applied", by: "dan", via: "cli" });
  appendReview(box.store.runDir(fixer), { agentId: 2, state: "open", by: "dan", via: "cli" });
  const timeout = fakeRun(box, "fixer", "failed", UNTIL - 2 * DAY, [
    started(0, "fix", "claude", "opus"),
    { type: "agent_failed", agentId: 0, label: "fix", adapter: "claude", error: "timed out", reason: "timeout", usage: usage(0.5, 1000) },
    started(1, "lint", "codex"),
    finished(1, "lint", "codex", { usage: usage(0.25, 500) }),
  ]);
  // Last week: a docs run that fell back and conflicted at apply; a script error; a replay.
  const docs = fakeRun(box, "docs", "done", UNTIL - 8 * DAY, [
    started(0, "writer", "codex"),
    { type: "handoff", agentId: 0, from: "codex", to: "claude" },
    { type: "apply_resolved", agentId: 0, outcome: "resolved" },
    finished(0, "writer", "claude", { changes: CHANGES, usage: usage(1, 1000) }),
    started(1, "guard", "claude"),
    { type: "agent_failed", agentId: 1, label: "guard", adapter: "claude", error: "unmet", reason: "unmet_expectation", misses: ["no file matching src/** may change, and src/a.ts did", "command `npm test` exited 1"] },
  ], { kept: [0] });
  appendReview(box.store.runDir(docs), { agentId: 0, state: "applied", by: null, via: "apply" });
  const crashed = fakeRun(box, "docs", "failed", UNTIL - 9 * DAY, []);
  const replay = fakeRun(box, "docs", "stopped", UNTIL - 9 * DAY, [started(0, "writer", "claude"), finished(0, "writer", "claude", {})], { meta: { origin: "replay" } });
  // A run whose worker died without an end: stale.
  const stale = fakeRun(box, "sweep", "running", UNTIL - 3 * DAY, [started(0, "a", "codex")], { status: { pid: 2 ** 22 + 12345 } });
  // The window before: one applied diff, cheaper.
  const before = fakeRun(box, "fixer", "done", SINCE - 3 * DAY, [started(0, "fix", "claude"), finished(0, "fix", "claude", { changes: CHANGES, usage: usage(0.5, 500) })], { kept: [0] });
  appendReview(box.store.runDir(before), { agentId: 0, state: "applied", by: null, via: "apply" });
  // Left out: too old, dry, an eval's, a resolver's, a test's, and one still running.
  fakeRun(box, "fixer", "done", SINCE - 20 * DAY, [started(0, "fix", "claude"), finished(0, "fix", "claude", { changes: CHANGES })], { kept: [0] });
  fakeRun(box, "fixer", "failed", UNTIL - DAY, [], { dry: true });
  fakeRun(box, "fixer", "failed", UNTIL - DAY, [], { meta: { origin: "eval" } });
  fakeRun(box, "fixer", "done", UNTIL - DAY, [started(0, "resolve", "claude"), finished(0, "resolve", "claude", { usage: usage(9, 9000) })], { meta: { origin: "apply-resolve" } });
  fakeRun(box, "fixer", "done", UNTIL - DAY, [], { meta: { origin: "test" } });
  fakeRun(box, "fixer", "running", UNTIL - DAY, [started(0, "fix", "claude")], { status: { pid: process.pid } });
  return { fixer, timeout, docs, crashed, replay, stale, before };
}

test("outcomes: kept diffs by their last mark, failures by reason, rework and cost per applied change, by week, workflow, adapter and model", () => {
  const box = scratch();
  try {
    seed(box);
    const o = collectOutcomes(box.store, { since: SINCE, until: UNTIL });
    const t = o.total;
    assert.equal(t.runs, 6, "fixer ×2, docs ×3, sweep");
    assert.equal(t.runsDone, 2);
    assert.equal(t.runsFailed, 3);
    assert.deepEqual(t.runReasons, { timeout: 1, script_error: 1, stale: 1 });
    assert.equal(t.replays, 1);
    assert.equal(t.agents, 10);
    assert.deepEqual(t.agentReasons, { timeout: 1, stale: 1, unmet_expectation: 1 });
    // The last mark stands: applied (after reviewed), dismissed, open again (left), and docs' applied.
    assert.deepEqual([t.kept, t.applied, t.dismissed, t.reviewed, t.left], [4, 2, 1, 0, 1]);
    assert.equal(t.acceptRate, 0.5);
    assert.deepEqual([t.retries, t.retried, t.handedOff, t.resolved, t.reworked], [1, 1, 1, 1, 2]);
    assert.equal(t.reworkRate, 0.5);
    assert.deepEqual([t.unmet, t.untouched, t.outOfScope], [1, 1, 1]);
    assert.equal(t.costUsd, 5.75);
    assert.equal(t.costPerApplied, 2.875, "everything spent, over what was applied");

    // Weeks from Monday, oldest first: docs and the stale sweep, then fixer.
    assert.deepEqual(o.weeks.map((w) => [w.key, w.runs, w.applied]), [["2026-09-28", 0, 0], ["2026-10-05", 4, 1], ["2026-10-12", 2, 1]]);
    assert.equal(o.weeks[0]!.start, weekStart(SINCE));

    const wf = Object.fromEntries(o.workflows.map((r) => [r.key, r]));
    assert.deepEqual(Object.keys(wf), ["docs", "fixer", "sweep"]);
    assert.deepEqual([wf.fixer!.runs, wf.fixer!.runsFailed, wf.fixer!.kept, wf.fixer!.applied, wf.fixer!.costPerApplied], [2, 1, 3, 1, 4.75]);
    assert.deepEqual([wf.docs!.runs, wf.docs!.runsFailed, wf.docs!.applied, wf.docs!.replays], [3, 1, 1, 1]);

    // An adapter is blamed for a failed run only when its own agent failed there.
    const ad = Object.fromEntries(o.adapters.map((r) => [r.key, r]));
    assert.deepEqual([ad.codex!.agents, ad.codex!.runs, ad.codex!.runsFailed, ad.codex!.kept, ad.codex!.applied, ad.codex!.dismissed], [5, 3, 1, 2, 0, 1]);
    assert.deepEqual(ad.codex!.runReasons, { stale: 1 });
    assert.deepEqual([ad.claude!.agents, ad.claude!.runsFailed, ad.claude!.applied], [5, 1, 2]);
    assert.deepEqual(ad.claude!.runReasons, { timeout: 1 });

    // The served model when the CLI said, else the requested one, else the default.
    assert.deepEqual(o.models.map((r) => r.key).sort(), ["(CLI default)", "claude-opus-5-5", "gpt-5 (requested)", "opus (requested)"]);
    assert.equal(o.models.find((r) => r.key === "claude-opus-5-5")!.applied, 1);

    // The window before held one applied run: too few to call anything out.
    assert.equal(o.previous!.runs, 1);
    assert.equal(o.previous!.applied, 1);
    assert.deepEqual(o.shifts, []);

    const text = formatOutcomes(o);
    for (const s of ["odw outcomes · last 2w", "4 · 2 applied (50%) · 1 dismissed · 0 reviewed · 1 left", "timeout 1", "By week", "2026-10-12", "By workflow", "By adapter", "By model", "claude-opus-5-5", "per applied change: $2.875"]) {
      assert.ok(text.includes(s), `text has ${s}`);
    }
    const md = outcomesMarkdown(o);
    assert.match(md, /^### odw outcomes · last 2w/);
    assert.match(md, /\| fixer \| 2 \| 1 \| 3 \| 1 \(33%\) \| 1 \| 1 \| 1 \| \$4\.750 \|/);
    const all = [JSON.stringify(o), text, md].join("\n");
    assert.ok(!all.includes(CLAIM), "an agent's own claims are never repeated");
    assert.ok(!all.includes("wrong file"), "nor a mark's note");
  } finally {
    box.cleanup();
  }
});

test("outcomes: --workflow narrows to one workflow; an empty window says so", () => {
  const box = scratch();
  try {
    seed(box);
    const o = collectOutcomes(box.store, { since: SINCE, until: UNTIL, workflow: "docs" });
    assert.equal(o.workflow, "docs");
    assert.deepEqual(o.workflows.map((r) => r.key), ["docs"]);
    assert.equal(o.total.runs, 3);
    assert.equal(o.previous, null);
    const empty = collectOutcomes(box.store, { since: UNTIL - 3600, until: UNTIL });
    assert.equal(empty.total.runs, 0);
    assert.match(formatOutcomes(empty), /No settled run was created in this window\./);
    assert.match(outcomesMarkdown(empty), /No settled run/);
  } finally {
    box.cleanup();
  }
});

test("outcomes: a notable move against the window before is called out, better or worse", () => {
  const row = (over: Partial<ReturnType<typeof emptyRow>>) => ({ ...emptyRow("x"), ...over });
  const before = row({ runs: 10, runsFailed: 1, kept: 10, applied: 8, acceptRate: 0.8, reworked: 1, reworkRate: 0.1, costPerApplied: 1 });
  const after = row({ runs: 10, runsFailed: 5, kept: 10, applied: 4, acceptRate: 0.4, reworked: 1, reworkRate: 0.1, costPerApplied: 2 });
  assert.deepEqual(shiftsOf(before, after), [
    { metric: "acceptRate", before: 0.8, after: 0.4, direction: "worse" },
    { metric: "failRate", before: 0.1, after: 0.5, direction: "worse" },
    { metric: "costPerApplied", before: 1, after: 2, direction: "worse" },
  ]);
  assert.deepEqual(shiftsOf(after, before).map((s) => s.direction), ["better", "better", "better"]);
  // Too few to compare: nothing.
  assert.deepEqual(shiftsOf(row({ runs: 2, kept: 2, applied: 2, acceptRate: 1 }), row({ runs: 2, kept: 2, applied: 0, acceptRate: 0 })), []);
  assert.deepEqual(shiftsOf(null, after), []);
});

test("outcomes: weeks start on Monday 00:00 UTC; an agent's model is the served one, else the requested", () => {
  assert.equal(new Date(weekStart(UNTIL) * 1000).toISOString(), "2026-10-12T00:00:00.000Z");
  assert.equal(weekStart(Date.UTC(2026, 9, 12) / 1000), Date.UTC(2026, 9, 12) / 1000);
  assert.equal(new Date(weekStart(Date.UTC(2026, 9, 11, 23, 59) / 1000) * 1000).toISOString(), "2026-10-05T00:00:00.000Z");
  const a = { agentId: 0, kind: "agent", label: "a", phase: null, state: "done", adapter: "claude", attempts: 1, error: null, startedAt: 0, finishedAt: 1, durationMs: 1, cached: false } as const;
  assert.equal(modelKey({ ...a, model: "opus", servedModel: ["b", "a", "a"] }), "a + b");
  assert.equal(modelKey({ ...a, model: "opus" }), "opus (requested)");
  assert.equal(modelKey(a), "(CLI default)");
});

test("odw outcomes: usage errors exit 2; --json and --markdown print the report", async () => {
  const box = scratch();
  try {
    seed(box);
    const rr = ["--runs-root", box.runsRoot];
    for (const args of [["--json", "--markdown"], ["--since", "soon"], ["extra"], ["--workflow", " "]]) {
      const r = await capture(() => main(["outcomes", ...args, ...rr]));
      assert.equal(r.code, 2, args.join(" "));
    }
    const json = await capture(() => main(["outcomes", "--json", "--since", "400w", ...rr]));
    assert.equal(json.code, 0, json.err);
    const o = JSON.parse(json.out);
    assert.equal(o.version, 1);
    assert.equal(o.total.runs, 8, "every settled run of the last 400 weeks");
    const md = await capture(() => main(["outcomes", "--markdown", "--workflow", "docs", "--since", "400w", ...rr]));
    assert.equal(md.code, 0);
    assert.match(md.out, /^### odw outcomes · docs · last /);
    const text = await capture(() => main(["outcomes", ...rr]));
    assert.equal(text.code, 0);
    assert.match(text.out, /^odw outcomes · last 30d/);
  } finally {
    box.cleanup();
  }
});

test("HTTP: GET /api/outcomes serves the report without the runs root's path; a bad since or name is a 400", async () => {
  const box = scratch();
  const handle = await startServer({ store: box.store, port: 0, host: "127.0.0.1", claudeProjectsRoot: join(box.root, "no-claude") });
  try {
    seed(box);
    const res = await fetch(`${handle.url}/api/outcomes?since=400w`);
    assert.equal(res.status, 200);
    const o = await res.json();
    assert.equal(o.version, 1);
    assert.equal(o.total.runs, 8);
    assert.equal(o.runsRoot, undefined, "the runs root's path stays on this machine");
    const docs = await fetch(`${handle.url}/api/outcomes?since=400w&workflow=docs`).then((r) => r.json());
    assert.deepEqual(docs.workflows.map((r: { key: string }) => r.key), ["docs"]);
    const outside = await fetch(`${handle.url}/api/outcomes?since=400w&workflow=${encodeURIComponent("../../etc")}`).then((r) => r.json());
    assert.equal(outside.total.runs, 0, "a name only ever picks a bucket by its slug");
    for (const q of ["since=soon", "since=", "workflow=", `workflow=${encodeURIComponent("a\nb")}`]) {
      assert.equal((await fetch(`${handle.url}/api/outcomes?${q}`)).status, 400, q);
    }
  } finally {
    await handle.close();
    box.cleanup();
  }
});
