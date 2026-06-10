import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";

import { RunStore } from "../src/runtime/run-store.js";
import { executeRun } from "../src/runtime/worker.js";

// Goal: multiple DIFFERENT agents composing one dynamic workflow, end to end
// through the real worker/scheduler/bridge — the cross-CLI duel pattern
// (examples/codex-claude-loop.js) with deterministic mock CLIs:
//   - 'impl' (the implementer) returns a solution tagged with its round
//   - 'rev'  (the reviewer) FAILs round 1 and PASSes from round 2
// The loop feeds the reviewer's verdict back into the next implementation.

function duelConfig(dir: string): string {
  const path = join(dir, "odw.config.json");
  const impl =
    "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{" +
    "const m=d.match(/ROUND (\\d+)/);" +
    "process.stdout.write('SOLUTION-r'+(m?m[1]:'?'))})";
  const rev =
    "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{" +
    "const pass=!d.includes('SOLUTION-r1');" +
    "process.stdout.write(JSON.stringify({pass,reason:pass?'looks correct':'r1 always has the precision bug'}))})";
  writeFileSync(
    path,
    JSON.stringify({
      workspaceMode: "inplace",
      adapters: {
        impl: { command: [execPath, "-e", impl], stdin: "{prompt}" },
        rev: { command: [execPath, "-e", rev], stdin: "{prompt}" },
      },
    }),
  );
  return path;
}

const DUEL_WORKFLOW = `export const meta = {
  name: 'duel',
  description: 'impl writes, rev judges; a FAIL becomes the next round instruction.',
  phases: [{ title: 'Implement' }, { title: 'Review' }],
}
const VERDICT = { type: 'object', required: ['pass'], properties: { pass: { type: 'boolean' }, reason: { type: 'string' } } }
let feedback = ''
for (let round = 1; round <= 3; round++) {
  phase('Implement')
  const solution = await agent('ROUND ' + round + ': implement the task. ' + feedback, { adapter: 'impl', label: 'impl-r' + round })
  phase('Review')
  const verdict = await agent('Review this strictly: ' + solution, { adapter: 'rev', schema: VERDICT, label: 'rev-r' + round })
  log('round ' + round + ': ' + (verdict.pass ? 'PASS' : 'FAIL — ' + verdict.reason))
  if (verdict.pass) return { passed: true, rounds: round, solution }
  feedback = 'The previous attempt failed review: ' + verdict.reason
}
return { passed: false, rounds: 3 }
`;

test("two distinct adapters drive a converging duel workflow end to end", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-duel-"));
  try {
    const configPath = duelConfig(root);
    const script = join(root, "duel.js");
    writeFileSync(script, DUEL_WORKFLOW);
    const store = new RunStore(join(root, "runs"));
    const id = store.create({ script, args: null, source: root, configPath });
    const state = await executeRun(store.runDir(id));
    assert.equal(state, "done");

    const result = store.readResult(id) as { passed: boolean; rounds: number; solution: string };
    assert.equal(result.passed, true);
    assert.equal(result.rounds, 2, "round 1 FAILs, round 2 PASSes");
    assert.equal(result.solution, "SOLUTION-r2");

    // Both CLIs really ran, attributed to their own adapters in the event stream.
    const finished = store.readEvents(id).filter((e) => e.type === "agent_finished");
    const byAdapter = new Map<string, number>();
    for (const e of finished) byAdapter.set(String(e.adapter), (byAdapter.get(String(e.adapter)) ?? 0) + 1);
    assert.equal(byAdapter.get("impl"), 2);
    assert.equal(byAdapter.get("rev"), 2);

    // The phase lanes alternate as declared.
    const phases = store
      .readEvents(id)
      .filter((e) => e.type === "phase_started")
      .map((e) => e.phase);
    assert.deepEqual(phases, ["Implement", "Review", "Implement", "Review"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a generated workflow can immediately drive multiple adapters (generate → run chain)", async () => {
  // The launch-layer chain with the engine only: a generation result (script
  // text) goes straight into startRun-style execution with per-role adapters.
  const root = mkdtempSync(join(tmpdir(), "odw-duel-"));
  try {
    const configPath = duelConfig(root);
    const wfDir = join(root, ".odw", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(join(wfDir, "duel.js"), DUEL_WORKFLOW);
    // Nested composition across adapters: a parent workflow delegates to the
    // duel by name and post-processes its result.
    const parent = join(root, "parent.js");
    writeFileSync(
      parent,
      "export const meta = { name: 'parent', description: 'd' }\n" +
        "const out = await workflow('duel')\n" +
        "return { verdict: out.passed ? 'shipped in ' + out.rounds + ' rounds' : 'blocked' }\n",
    );
    const store = new RunStore(join(root, "runs"));
    const id = store.create({ script: parent, args: null, source: root, configPath });
    assert.equal(await executeRun(store.runDir(id)), "done");
    assert.deepEqual(store.readResult(id), { verdict: "shipped in 2 rounds" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
