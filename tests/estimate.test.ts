import { test } from "node:test";
import assert from "node:assert/strict";

import { collectConfigWarnings, loadConfig } from "../src/adapters/config.js";
import { ConfigError } from "../src/errors.js";
import { CostHistory, costGateTitle, labelPrefix, readCostGate, spread, type CostSample } from "../src/forecast.js";
import { BEHAVIOUR_SETTINGS } from "../src/provenance.js";
import { estimateWorkflow, formatEstimate, NO_HISTORY, selectRuns, type HistoryAgent, type HistoryRun } from "../src/runtime/estimate.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The estimate behind `odw estimate`, `odw run --estimate` and GET
// /api/estimate, and the forecast behind costGate: synthetic run histories in,
// p50/p90 out — per phase and adapter, matched by source first, then by name.

const H = "a".repeat(64);
const G = "b".repeat(64);

function agent(phase: string | null, adapter: string, start: number, end: number, costUsd?: number, label = "a"): HistoryAgent {
  return { label, phase, adapter, startedAt: start, finishedAt: end, usage: costUsd === undefined ? { outputTokens: 100 } : { costUsd, outputTokens: 100 } };
}

/** A run: one plan agent (claude, $0.10, 10s), then `width` workers (codex, $0.20 each, 20s side by side). */
function run(runId: string, sourceHash: string | null, width: number, extra: Partial<HistoryRun> = {}): HistoryRun {
  const agents = [agent("Plan", "claude", 1000, 1010, 0.1, "plan")];
  for (let i = 0; i < width; i++) agents.push(agent("Work", "codex", 1010, 1030, 0.2, `worker-${i}`));
  return { runId, sourceHash, args: { width }, startedAt: 1000, endedAt: 1000 + 30 + width, agents, ...extra };
}

// Newest first, as the store lists them: three of source H, two older ones of G.
const HISTORY = [run("r5", H, 2), run("r4", H, 4), run("r3", H, 6), run("r2", G, 10), run("r1", G, 12)];

test("spread is nearest-rank p50/p90; labelPrefix drops a trailing index", () => {
  assert.deepEqual(spread([10, 1, 9, 2, 8, 3, 7, 4, 6, 5]), { p50: 5, p90: 9, n: 10 });
  assert.deepEqual(spread([3]), { p50: 3, p90: 3, n: 1 });
  assert.deepEqual(spread([1, 2]), { p50: 1, p90: 2, n: 2 });
  assert.equal(spread([]), null);
  assert.equal(spread([NaN]), null);
  for (const label of ["review-3", "review 3", "review#12", "review:3", "review_3", "review"]) assert.equal(labelPrefix(label), "review", label);
  assert.equal(labelPrefix("42"), "42", "all index stays as it is");
});

test("runs of the exact source come first: p50/p90 of the run, each phase and each adapter", () => {
  const est = estimateWorkflow(HISTORY, { workflow: "wf", sourceHash: H });
  assert.equal(est.match, "sourceHash");
  assert.deepEqual(est.runs, ["r5", "r4", "r3"]);
  // Run costs $0.50, $0.90, $1.30; 3, 5 and 7 agents; 32s, 34s, 36s.
  assert.deepEqual(est.total!.costUsd, { p50: 0.9, p90: 1.3, n: 3 });
  assert.deepEqual(est.total!.agents, { p50: 5, p90: 7, n: 3 });
  assert.deepEqual(est.total!.wallMs, { p50: 34_000, p90: 36_000, n: 3 });
  assert.deepEqual(est.total!.outputTokens, { p50: 500, p90: 700, n: 3 });
  assert.equal(est.total!.inputTokens, null, "no run reported any");
  assert.deepEqual(
    est.phases.map((p) => [p.phase, p.runs, p.agents?.p50, p.agents?.p90, p.wallMs?.p50, p.costUsd?.p90]),
    [
      ["Plan", 3, 1, 1, 10_000, 0.1],
      ["Work", 3, 4, 6, 20_000, 1.2],
    ],
  );
  assert.deepEqual(est.adapters.map((a) => [a.adapter, a.runs, a.agents?.p50]), [["claude", 3, 1], ["codex", 3, 4]]);
  assert.match(est.notes[0]!, /last 3 finished runs of this exact source/);
  assert.match(est.notes[1]!, /assumes similar args/);
  assert.equal(est.estimated, false);
});

test("without a run of the exact source it falls back to the name, and says so", () => {
  const est = estimateWorkflow(HISTORY, { workflow: "wf", sourceHash: "c".repeat(64) });
  assert.equal(est.match, "name");
  assert.deepEqual(est.runs, ["r5", "r4", "r3", "r2", "r1"]);
  assert.match(est.notes[0]!, /no finished run of this exact source yet: based on the last 5 finished runs of workflow wf, whose source differed/);
  assert.equal(estimateWorkflow(HISTORY, { workflow: "wf", sourceHash: null }).match, "name", "no source given: by name");
  // At most `limit` runs, the newest.
  assert.deepEqual(estimateWorkflow(HISTORY, { workflow: "wf", sourceHash: null, limit: 2 }).runs, ["r5", "r4"]);
  assert.deepEqual(selectRuns(HISTORY, G, 20).runs.map((r) => r.runId), ["r2", "r1"]);
});

test("no history: no estimate, and no guess", () => {
  const est = estimateWorkflow([], { workflow: "wf", sourceHash: H });
  assert.deepEqual(est, {
    version: 1,
    workflow: "wf",
    sourceHash: H,
    match: null,
    runs: [],
    total: null,
    phases: [],
    adapters: [],
    estimated: false,
    notes: [NO_HISTORY],
  });
  assert.equal(NO_HISTORY, "no estimate: no finished runs of this workflow yet");
  assert.deepEqual(formatEstimate(est, { width: 100, caps: { color: false, truecolor: false, unicode: false } }), [
    "wf: no estimate: no finished runs of this workflow yet",
  ]);
});

test("the notes say whether the runs had these args, and what is missing", () => {
  const same = estimateWorkflow(HISTORY, { workflow: "wf", sourceHash: H, args: { width: 4 } });
  assert.ok(same.notes.includes("1 of those 3 runs had these args"), same.notes.join("\n"));
  const none = estimateWorkflow(HISTORY, { workflow: "wf", sourceHash: H, args: { width: 99 } });
  assert.ok(none.notes.includes("none of those runs had these args"));
  const one = estimateWorkflow([run("r9", H, 1)], { workflow: "wf", sourceHash: H });
  assert.ok(one.notes.some((n) => /only 1 finished run: the p90 is the worst of one/.test(n)));
  const free = estimateWorkflow([run("r9", H, 1, { agents: [agent("Work", "codex", 1, 2)] })], { workflow: "wf", sourceHash: H });
  assert.equal(free.total!.costUsd, null);
  assert.ok(free.notes.includes("no agent of those runs reported a cost: tokens only"));
  const guessed = estimateWorkflow([run("r9", H, 1, { agents: [{ ...agent(null, "x", 1, 2), usage: { outputTokens: 5, estimated: true } }] })], {
    workflow: "wf",
    sourceHash: H,
  });
  assert.equal(guessed.estimated, true);
  assert.equal(guessed.phases[0]!.phase, null);
});

test("the text view: a row for the run, each phase and each adapter, then the notes", () => {
  const lines = formatEstimate(estimateWorkflow(HISTORY, { workflow: "wf", sourceHash: H }), {
    width: 120,
    caps: { color: false, truecolor: false, unicode: false },
  });
  assert.equal(lines[0], "estimate for wf (3 runs, matched by source)");
  assert.match(lines[1]!, /agents\s+time p50 \/ p90\s+cost p50 \/ p90\s+out tokens p50 \/ p90/);
  assert.match(lines[2]!, /^ {2}total\s+5–7\s+34\.0s \/ 36\.0s\s+\$0\.900 \/ \$1\.300\s+500 \/ 700$/);
  assert.match(lines[3]!, /^ {2}phase Plan\s+1\s+10\.0s \/ 10\.0s/);
  assert.match(lines[4]!, /^ {2}phase Work\s+4–6\s+20\.0s/);
  assert.match(lines[5]!, /^ {2}adapter claude/);
  assert.match(lines[6]!, /^ {2}adapter codex/);
  assert.match(lines[7]!, /^ {2}· based on the last 3 finished runs/);
});

test("a fan-out's forecast: its width × the median agent of its label prefix in its phase, else of the phase", () => {
  const samples: CostSample[] = [
    { runId: "r1", phase: "Work", label: "review-1", costUsd: 0.1, outputTokens: 10 },
    { runId: "r1", phase: "Work", label: "review-2", costUsd: 0.3, outputTokens: 30 },
    { runId: "r2", phase: "Work", label: "review-1", costUsd: 0.2, outputTokens: 20 },
    { runId: "r2", phase: "Work", label: "fix", costUsd: 2 },
    { runId: "r2", phase: "Plan", label: "plan", outputTokens: 99 },
  ];
  const history = new CostHistory(samples, "sourceHash");
  assert.equal(history.runs, 2);
  const byLabel = history.forecast("agent()", 1, 1, "Work", "review-9")!;
  assert.deepEqual(
    { basis: byLabel.basis, label: byLabel.label, per: byLabel.perAgentUsd, usd: byLabel.usd, p90: byLabel.p90Usd, runs: byLabel.runs },
    { basis: "label", label: "review", per: { p50: 0.2, p90: 0.3, n: 3 }, usd: 0.2, p90: 0.3, runs: 2 },
  );
  assert.deepEqual(byLabel.perAgentOutputTokens, { p50: 20, p90: 30, n: 3 });
  const byPhase = history.forecast("parallel()", 10, 10, "Work")!;
  assert.equal(byPhase.basis, "phase");
  assert.equal(byPhase.label, null);
  assert.deepEqual(byPhase.perAgentUsd, { p50: 0.2, p90: 2, n: 4 });
  assert.equal(byPhase.usd, 2);
  assert.equal(byPhase.p90Usd, 20);
  assert.equal(costGateTitle(byPhase), "This fan-out is forecast to cost ~$2.000 (p90 $20.00) — go?");
  assert.equal(history.forecast("parallel()", 3, 3, "Work", "unknown")!.basis, "phase", "an unknown label: the phase");
  assert.equal(history.forecast("parallel()", 3, 3, "Plan"), null, "no cost in the phase: no forecast");
  assert.equal(history.forecast("parallel()", 3, 3, "Elsewhere"), null);
});

test("costGate: { usd } in the config and on calls; a setting that changes behaviour", () => {
  const fail = (m: string) => new ConfigError(m);
  assert.deepEqual(readCostGate({ usd: 2.5 }, "x", fail), { usd: 2.5 });
  assert.equal(readCostGate(null, "x", fail), null);
  for (const bad of [5, "5", [], { usd: 0 }, { usd: -1 }, { usd: "1" }, {}, { usd: 1, max: 2 }]) {
    assert.throws(() => readCostGate(bad, '"costGate"', fail), /"costGate" must be \{ usd: <dollars> \}/, JSON.stringify(bad));
  }
  const dir = mkdtempSync(join(tmpdir(), "odw-gate-cfg-"));
  try {
    const load = (raw: unknown) => {
      const path = join(dir, "odw.config.json");
      writeFileSync(path, JSON.stringify(raw));
      return loadConfig(path, { quiet: true });
    };
    assert.equal(load({}).settings.costGate, null);
    assert.deepEqual(load({ costGate: { usd: 3 } }).settings.costGate, { usd: 3 });
    assert.equal(load({ costGate: null }).settings.costGate, null);
    assert.throws(() => load({ costGate: { usd: 0 } }), /"costGate" must be/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(collectConfigWarnings({ costGate: { usd: 1 } }), []);
  assert.ok((BEHAVIOUR_SETTINGS as readonly string[]).includes("costGate"));
});
