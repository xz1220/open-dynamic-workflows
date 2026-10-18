import { test } from "node:test";
import assert from "node:assert/strict";

import {
  compareReplies,
  compareRuns,
  formatComparison,
  jsonDiff,
  unifiedDiff,
  type CompareRunInput,
  type RunAgent,
} from "../src/runtime/compare.js";
import { displayWidth } from "../src/tty.js";

// The pure comparer behind `odw compare` and GET /api/compare: two runs in,
// rows out — matched by label, then by resume key, then by order in the phase.

function agent(agentId: number, label: string, extra: Partial<RunAgent> = {}): RunAgent {
  return {
    agentId,
    label,
    phase: null,
    key: null,
    state: "done",
    adapter: "claude",
    model: null,
    attempts: 1,
    durationMs: 1000,
    usage: null,
    cached: false,
    error: null,
    failureReason: null,
    changes: null,
    ...extra,
  };
}

function run(runId: string, agents: RunAgent[], extra: Partial<CompareRunInput> = {}): CompareRunInput {
  return {
    runId,
    name: "wf",
    workflowName: "wf",
    state: "done",
    live: false,
    createdAt: 100,
    startedAt: 100,
    endedAt: 160,
    script: "/p/wf.js",
    inline: false,
    args: null,
    adapter: null,
    permissions: null,
    budgetTotal: null,
    odwVersion: "0.5.0",
    sourceHash: "a".repeat(64),
    resumedFrom: null,
    setup: { settings: { timeout: 1800, defaultAdapter: "claude" }, adapters: { claude: "c1", codex: "x1" } },
    cliVersions: {},
    agents,
    ...extra,
  };
}

const pairs = (cmp: ReturnType<typeof compareRuns>) =>
  cmp.agents.map((row) => [row.a?.agentId ?? null, row.b?.agentId ?? null, row.match]);

test("agents match by a label each run gives once, then by resume key, then by order in the phase", () => {
  const a = run("A", [
    agent(1, "plan", { phase: "Plan" }),
    agent(2, "claude", { phase: "Work", key: "k-same" }),
    agent(3, "claude", { phase: "Work", key: "k-edited" }),
    agent(4, "claude", { phase: "Work", key: "k-old" }),
    agent(5, "report", { phase: "Report" }),
  ]);
  const b = run("B", [
    // Same label, another position: still the plan agent.
    agent(1, "report", { phase: "Report" }),
    agent(2, "plan", { phase: "Plan" }),
    // Unchanged call, now dispatched later: its key finds it.
    agent(3, "claude", { phase: "Work", key: "k-new" }),
    agent(4, "claude", { phase: "Work", key: "k-same" }),
    agent(5, "claude", { phase: "Work", key: "k-other" }),
  ]);
  const cmp = compareRuns(a, b);
  assert.deepEqual(pairs(cmp), [
    [1, 2, "label"],
    [2, 4, "key"],
    // The edited calls pair up in order within their phase.
    [3, 3, "order"],
    [4, 5, "order"],
    [5, 1, "label"],
  ]);
  assert.deepEqual(cmp.agents.map((row) => row.phase), ["Plan", "Work", "Work", "Work", "Report"]);
});

test("order within the phase pairs the same label first and never crosses phases", () => {
  const a = run("A", [
    agent(1, "s", { phase: "P" }),
    agent(2, "t", { phase: "P" }),
    agent(3, "t", { phase: "P" }),
    agent(4, "w", { phase: "Q" }),
  ]);
  const b = run("B", [agent(1, "t", { phase: "P" }), agent(2, "t", { phase: "P" }), agent(3, "x", { phase: "R" })]);
  const cmp = compareRuns(a, b);
  assert.deepEqual(pairs(cmp), [
    [1, null, null],
    [2, 1, "order"],
    [3, 2, "order"],
    // B's new phase R comes after the phase before it in B, ahead of A's Q.
    [null, 3, null],
    [4, null, null],
  ]);
  assert.deepEqual(
    cmp.agents.map((row) => row.outcome),
    ["only-a", "unchanged", "unchanged", "only-b", "only-a"],
  );
});

test("only-in-A and only-in-B agents are rows of their own, B's new phases in place", () => {
  const a = run("A", [agent(1, "plan", { phase: "Plan" }), agent(2, "dropped", { phase: "Work" }), agent(3, "end", { phase: "End" })]);
  const b = run("B", [
    agent(1, "plan", { phase: "Plan" }),
    agent(2, "research", { phase: "Research" }),
    agent(3, "end", { phase: "End" }),
  ]);
  const cmp = compareRuns(a, b);
  assert.deepEqual(
    cmp.agents.map((row) => [row.label, row.phase, row.outcome, row.match]),
    [
      ["plan", "Plan", "unchanged", "label"],
      ["research", "Research", "only-b", null],
      ["dropped", "Work", "only-a", null],
      ["end", "End", "unchanged", "label"],
    ],
  );
  const only = cmp.agents[2]!;
  assert.equal(only.b, null);
  assert.equal(only.reply.status, "none");
  assert.deepEqual(only.delta, { durationMs: null, inputTokens: null, outputTokens: null, costUsd: null, attempts: null });
});

test("a reply is identical, a text diff, or a JSON-path diff for structured replies", () => {
  const text = (value: unknown) => ({ value });
  assert.deepEqual(compareReplies(text("same"), text("same")), { status: "identical", kind: null, truncated: false });
  assert.deepEqual(compareReplies(text({ a: 1, b: [1] }), text({ b: [1], a: 1 })).status, "identical", "key order is no difference");
  assert.equal(compareReplies(undefined, text("x")).status, "none");

  const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
  const edited = [...lines];
  edited[10] = "line ten";
  edited.splice(20, 0, "inserted");
  const diff = compareReplies(text(lines.join("\n")), text(edited.join("\n")));
  assert.equal(diff.status, "differs");
  assert.equal(diff.kind, "text");
  assert.deepEqual([diff.added, diff.removed, diff.truncated], [2, 1, false]);
  assert.deepEqual(diff.diff, [
    "@@ -8,7 +8,7 @@",
    " line 7",
    " line 8",
    " line 9",
    "-line 10",
    "+line ten",
    " line 11",
    " line 12",
    " line 13",
    "@@ -18,6 +18,7 @@",
    " line 17",
    " line 18",
    " line 19",
    "+inserted",
    " line 20",
    " line 21",
    " line 22",
  ]);

  const structured = compareReplies(
    text({ verdict: "pass", score: 0.9, items: [{ id: 1 }, { id: 2 }], "odd key": true }),
    text({ verdict: "fail", score: 0.9, items: [{ id: 1 }, { id: 3 }, { id: 4 }], extra: null }),
  );
  assert.equal(structured.kind, "json");
  assert.equal(structured.changed, 5);
  assert.deepEqual(structured.paths, [
    { path: "$.verdict", op: "changed", a: '"pass"', b: '"fail"' },
    { path: "$.items[1].id", op: "changed", a: "2", b: "3" },
    { path: "$.items[2]", op: "added", b: '{"id":4}' },
    { path: '$["odd key"]', op: "removed", a: "true" },
    { path: "$.extra", op: "added", b: "null" },
  ]);
  // A text reply against a structured one differs at the root.
  assert.deepEqual(compareReplies(text("x"), text({ x: 1 })).paths, [{ path: "$", op: "changed", a: '"x"', b: '{"x":1}' }]);
});

test("reply diffs are bounded, and say so; unbounded they are whole", () => {
  const a = Array.from({ length: 200 }, (_, i) => `a${i}`).join("\n");
  const b = Array.from({ length: 200 }, (_, i) => `b${i}`).join("\n");
  const short = unifiedDiff(a, b, { maxLines: 40, lineChars: 200 });
  assert.equal(short.lines.length, 40);
  assert.equal(short.truncated, true);
  assert.deepEqual([short.added, short.removed], [200, 200], "the counts cover the whole diff");
  const whole = unifiedDiff(a, b);
  assert.equal(whole.lines.length, 401);
  assert.equal(whole.truncated, false);
  assert.equal(unifiedDiff("x".repeat(500), "y", { lineChars: 200 }).lines[1], `-${"x".repeat(199)}…`);

  const big = jsonDiff({ list: Array.from({ length: 50 }, (_, i) => i) }, { list: [] }, { maxPaths: 20, valueChars: 200 });
  assert.deepEqual([big.paths.length, big.total, big.truncated], [20, 50, true]);
  const long = jsonDiff({ s: "x".repeat(500) }, { s: "y" }, { valueChars: 10 });
  assert.equal(long.paths[0]!.a, `"${"x".repeat(9)}…`);

  // A huge, wholly different middle stays bounded in time: one replacement block.
  const many = (p: string) => Array.from({ length: 3000 }, (_, i) => `${p}${i}`).join("\n");
  const block = unifiedDiff(many("x"), many("y"), { maxLines: 5 });
  assert.deepEqual([block.added, block.removed], [3000, 3000]);
});

test("failed vs done: newly failed, fixed, and the facts of each side", () => {
  const a = run("A", [
    agent(1, "breaks", { reply: { value: "ok" } }),
    agent(2, "heals", { state: "failed", error: "adapter 'codex' timed out", failureReason: "timeout", adapter: "codex" }),
    agent(3, "both", { state: "failed", error: "x" }),
  ]);
  const b = run("B", [
    agent(1, "breaks", { state: "failed", error: "boom", failureReason: "exit", attempts: 2 }),
    agent(2, "heals", { reply: { value: "fixed" }, adapter: "claude", model: "opus" }),
    agent(3, "both", { state: "failed", error: "y" }),
  ]);
  const cmp = compareRuns(a, b);
  assert.deepEqual(cmp.agents.map((row) => row.outcome), ["newly-failed", "fixed", "unchanged"]);
  const [breaks, heals] = cmp.agents;
  assert.equal(breaks!.reply.status, "none");
  assert.deepEqual([breaks!.b!.state, breaks!.b!.failureReason, breaks!.b!.error, breaks!.delta.attempts], ["failed", "exit", "boom", 1]);
  assert.deepEqual([heals!.a!.adapter, heals!.b!.adapter, heals!.b!.model], ["codex", "claude", "opus"]);
  assert.deepEqual(cmp.totals.failed, { a: 2, b: 2, delta: 0 });
  assert.deepEqual(cmp.totals.done, { a: 1, b: 1, delta: 0 });
});

test("run totals: wall time, tokens, cost and agents, with B − A", () => {
  const a = run(
    "A",
    [
      agent(1, "x", { usage: { inputTokens: 1000, outputTokens: 100, costUsd: 0.1 }, durationMs: 4000 }),
      agent(2, "y", { usage: { inputTokens: 500, outputTokens: 50, costUsd: 0.05 } }),
    ],
    { startedAt: 100, endedAt: 220 },
  );
  const b = run(
    "B",
    [
      agent(1, "x", { usage: { inputTokens: 800, outputTokens: 120, costUsd: 0.07 }, durationMs: 2500 }),
      agent(2, "y", { usage: { outputTokens: 40, estimated: true }, state: "failed" }),
      agent(3, "z", { usage: { outputTokens: 10, estimated: true } }),
    ],
    { startedAt: 300, endedAt: 390 },
  );
  const cmp = compareRuns(a, b);
  const t = cmp.totals;
  assert.deepEqual(t.wallMs, { a: 120_000, b: 90_000, delta: -30_000 });
  assert.deepEqual(t.inputTokens, { a: 1500, b: 800, delta: -700 });
  assert.deepEqual(t.outputTokens, { a: 150, b: 170, delta: 20 });
  assert.deepEqual(t.costUsd, { a: 0.15, b: 0.07, delta: -0.08 });
  assert.deepEqual(t.agents, { a: 2, b: 3, delta: 1 });
  assert.deepEqual(t.failed, { a: 0, b: 1, delta: 1 });
  assert.deepEqual(t.estimated, { a: false, b: true });
  assert.deepEqual(cmp.agents[0]!.delta, { durationMs: -1500, inputTokens: -200, outputTokens: 20, costUsd: -0.03, attempts: 0 });
  // A run without usage has unknown tokens, and no delta.
  const none = compareRuns(run("A", [agent(1, "x")]), b).totals;
  assert.deepEqual(none.inputTokens, { a: null, b: 800, delta: null });
});

test("setup differences: source, args, versions, adapters and models, behaviour knobs", () => {
  const a = run("A", [agent(1, "x", { adapter: "codex", model: "@fast" })], {
    args: { topic: "x" },
    budgetTotal: 1000,
    cliVersions: { codex: { command: "codex", version: "codex-cli 0.40.0" }, claude: { command: "claude", version: "2.1.0" } },
  });
  const b = run("B", [agent(1, "x", { adapter: "claude", model: "opus" })], {
    sourceHash: "b".repeat(64),
    args: { topic: "y" },
    odwVersion: "0.5.1",
    cliVersions: { codex: { command: "codex", version: "codex-cli 0.46.0" }, claude: { command: "claude", version: "2.1.0" } },
    setup: { settings: { timeout: 600, defaultAdapter: "claude", models: { fast: { claude: "haiku" } } }, adapters: { claude: "c2", codex: "x1" } },
  });
  const cmp = compareRuns(a, b);
  assert.deepEqual(cmp.setup, [
    { field: "source", a: "a".repeat(64), b: "b".repeat(64) },
    { field: "args", a: { topic: "x" }, b: { topic: "y" } },
    { field: "odwVersion", a: "0.5.0", b: "0.5.1" },
    { field: "budget", a: 1000, b: null },
    { field: "cliVersion.codex", a: "codex-cli 0.40.0", b: "codex-cli 0.46.0" },
    { field: "settings.timeout", a: 1800, b: 600 },
    { field: "settings.models", a: null, b: { fast: { claude: "haiku" } } },
    { field: "adapterDefinition.claude", a: "c1", b: "c2" },
    { field: "adaptersUsed", a: ["codex"], b: ["claude"] },
    { field: "modelsUsed", a: ["@fast"], b: ["opus"] },
  ]);
  assert.deepEqual(compareRuns(a, a).setup, [], "a run against itself differs in nothing");
  assert.ok(compareRuns(a, a).notes.includes("A and B are the same run"));

  // Runs from before setups were recorded: their --adapter and --permissions, and a note.
  const old = run("O", [agent(1, "x", { adapter: "codex", model: "@fast" })], {
    setup: null,
    odwVersion: null,
    sourceHash: null,
    adapter: "codex",
    args: { topic: "x" },
    budgetTotal: 1000,
  });
  const vsOld = compareRuns(old, a);
  assert.deepEqual(vsOld.setup, [{ field: "adapter", a: "codex", b: null }]);
  assert.ok(vsOld.notes.some((note) => /run A recorded no setup/.test(note)));
  // Inline runs keep their script in their own run directory: that path is no difference.
  const inline = compareRuns(run("I", [], { inline: true, script: "/runs/I/workflow.js" }), run("J", [], { inline: true, script: "/runs/J/workflow.js" }));
  assert.deepEqual(inline.setup, []);
});

test("a run still going is compared as it stands, with a note; so is a stale one", () => {
  const a = run("A", [agent(1, "x", { reply: { value: "v" } })]);
  const b = run("B", [agent(1, "x", { state: "running", durationMs: null })], { state: "running", live: true });
  const cmp = compareRuns(a, b);
  assert.equal(cmp.b.live, true);
  assert.deepEqual(cmp.notes, ["run B is still running — compared as it stands: its running agents have no reply yet"]);
  assert.equal(cmp.agents[0]!.reply.status, "none");
  assert.equal(cmp.agents[0]!.outcome, "unchanged");
  const stale = compareRuns(run("S", [], { state: "stale" }), a);
  assert.deepEqual(stale.notes, ["run A is stale (its worker is gone) — compared as it stands"]);
});

test("the comparison's keys are the documented, stable ones", () => {
  const cmp = compareRuns(run("A", [agent(1, "x", { reply: { value: "1" } })]), run("B", [agent(1, "x", { reply: { value: "2" } })]));
  assert.deepEqual(Object.keys(cmp), ["version", "a", "b", "notes", "setup", "totals", "agents"]);
  assert.equal(cmp.version, 1);
  assert.deepEqual(Object.keys(cmp.a), ["runId", "name", "workflowName", "state", "live", "createdAt", "odwVersion", "sourceHash", "resumedFrom"]);
  assert.deepEqual(Object.keys(cmp.totals), ["wallMs", "inputTokens", "outputTokens", "costUsd", "agents", "done", "failed", "estimated"]);
  const row = cmp.agents[0]!;
  assert.deepEqual(Object.keys(row), ["match", "outcome", "label", "phase", "a", "b", "delta", "reply"]);
  assert.deepEqual(Object.keys(row.a!), [
    "agentId",
    "label",
    "phase",
    "state",
    "adapter",
    "model",
    "attempts",
    "durationMs",
    "inputTokens",
    "outputTokens",
    "costUsd",
    "estimated",
    "replayed",
    "failureReason",
    "error",
    "changes",
  ]);
  assert.deepEqual(Object.keys(row.reply), ["status", "kind", "diff", "added", "removed", "truncated"]);
});

test("the human table fits its width with long labels, models and kept diffs", () => {
  const long = "a-very-long-agent-label-that-goes-on-and-on-and-on";
  const many = (side: "a" | "b") =>
    Array.from({ length: 6 }, (_, i) =>
      agent(i + 1, `${long}-${i}`, {
        phase: `phase ${i % 2} with a long title that also goes on and on`,
        adapter: side === "a" ? "codex" : "claude",
        model: side === "a" ? "@fast" : "claude-sonnet-4-5-20250929",
        usage: { outputTokens: 1000 * (i + 1), costUsd: side === "a" ? 0.01 : 0.03 },
        changes: { files: 3, insertions: 120 * i, deletions: 7, truncated: false },
        reply: { value: side === "a" ? "x\ny" : "x\nz" },
      }),
    );
  const cmp = compareRuns(run("A", many("a")), run("B", many("b"), { args: { prompt: "y".repeat(300) } }));
  for (const width of [100, 60]) {
    const lines = formatComparison(cmp, { width, caps: { color: true, truecolor: false, unicode: true } });
    for (const line of lines) assert.ok(displayWidth(line) <= width, `fits ${width} (${displayWidth(line)}): ${line}`);
    if (width === 100) assert.ok(lines.some((line) => line.includes("CHANGES")), "kept diffs get their column");
    assert.ok(lines.some((line) => line.includes("\x1b[31m")), "more cost is red");
  }
});
