import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";

import { loadWorkflowScript } from "../src/loader.js";
import { RunStore } from "../src/runtime/run-store.js";
import { executeRun } from "../src/runtime/worker.js";
import { GENERATE_WORKFLOW_SOURCE, PATTERNS_DIGEST } from "../src/workflows/generate-workflow.js";
import { SKILL_MD } from "../src/skill.generated.js";

// The built-in generate-workflow (launch.md §3.2): Generate → Validate → Repair,
// ≤3 attempts, driven end-to-end through the real worker with mock adapters.
// The mock distinguishes the authoring call from a repair call by the repair
// prompt's marker text, so convergence needs no cross-call state.

const GOOD_SCRIPT =
  "export const meta = { name: 'task-wf', description: 'does the task', phases: [{ title: 'Work' }] }\n" +
  "phase('Work')\n" +
  "return await agent('do the thing')\n";

// Compiles? No — meta is not a literal. Also uses Date.now() for good measure.
const BAD_SCRIPT = "export const meta = buildMeta()\nconst t = Date.now()\nreturn t\n";

// A dual-compat-violating script: compiles, but warns (Math.random).
const WARN_SCRIPT =
  "export const meta = { name: 'task-wf', description: 'd' }\nreturn Math.random()\n";

/** A mock CLI that replies with a JSON script payload chosen by prompt content. */
function mockAuthorConfig(
  dir: string,
  opts: { authored: string; repaired: string },
): string {
  const path = join(dir, "odw.config.json");
  // The CLI reads the prompt on stdin and picks its reply: repair prompts carry
  // the "failed validation" marker, authoring prompts do not.
  const js =
    "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{" +
    "const repaired=d.includes('failed validation');" +
    `const payload=repaired?${JSON.stringify(JSON.stringify({ script: opts.repaired }))}:${JSON.stringify(JSON.stringify({ script: opts.authored }))};` +
    "process.stdout.write(payload)})";
  writeFileSync(
    path,
    JSON.stringify({
      defaultAdapter: "mock",
      workspaceMode: "inplace",
      adapters: { mock: { command: [execPath, "-e", js], stdin: "{prompt}" } },
    }),
  );
  return path;
}

function startGeneration(root: string, configPath: string, task = "summarize the repo") {
  const store = new RunStore(join(root, "runs"));
  const id = store.create({
    script: "",
    inlineSource: GENERATE_WORKFLOW_SOURCE,
    args: { task, dialectDoc: SKILL_MD, patternsDigest: PATTERNS_DIGEST },
    source: root,
    configPath,
    workflowName: "generate-workflow",
  });
  return { store, id };
}

test("the generate-workflow source itself compiles in the dialect", () => {
  const loaded = loadWorkflowScript(GENERATE_WORKFLOW_SOURCE, "generate-workflow.js");
  assert.equal(loaded.meta.name, "generate-workflow");
  assert.deepEqual(
    loaded.meta.phases?.map((p) => p.title),
    ["Generate", "Validate", "Repair"],
  );
});

test("a valid first draft passes in one attempt", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-gen-"));
  try {
    const configPath = mockAuthorConfig(root, { authored: GOOD_SCRIPT, repaired: GOOD_SCRIPT });
    const { store, id } = startGeneration(root, configPath);
    assert.equal(await executeRun(store.runDir(id)), "done");
    const r = store.readResult(id) as { script: string; meta: { name: string }; attempts: number };
    assert.equal(r.attempts, 1);
    assert.equal(r.meta.name, "task-wf");
    // The produced script is itself loadable — the whole point.
    assert.equal(loadWorkflowScript(r.script, "out.js").meta.name, "task-wf");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a bad first draft converges through the Repair phase", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-gen-"));
  try {
    const configPath = mockAuthorConfig(root, { authored: BAD_SCRIPT, repaired: GOOD_SCRIPT });
    const { store, id } = startGeneration(root, configPath);
    assert.equal(await executeRun(store.runDir(id)), "done");
    const r = store.readResult(id) as { script: string; attempts: number };
    assert.equal(r.attempts, 2, "one failed validation, then the repaired draft passes");
    const phases = store.readEvents(id).filter((e) => e.type === "phase_started").map((e) => e.phase);
    assert.ok(phases.includes("Repair"), `Repair phase ran: ${phases.join(",")}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dual-compat warnings (Math.random) also trigger repair", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-gen-"));
  try {
    const configPath = mockAuthorConfig(root, { authored: WARN_SCRIPT, repaired: GOOD_SCRIPT });
    const { store, id } = startGeneration(root, configPath);
    assert.equal(await executeRun(store.runDir(id)), "done");
    const r = store.readResult(id) as { attempts: number };
    assert.equal(r.attempts, 2);
    const logs = store.readEvents(id).filter((e) => e.type === "log").map((e) => String(e.message));
    assert.ok(logs.some((m) => /Math\.random/.test(m)), "the warning is surfaced in the run log");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("three bad drafts fail the run with the last validation errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-gen-"));
  try {
    const configPath = mockAuthorConfig(root, { authored: BAD_SCRIPT, repaired: BAD_SCRIPT });
    const { store, id } = startGeneration(root, configPath);
    assert.equal(await executeRun(store.runDir(id)), "failed");
    const err = String(store.readError(id)?.error);
    assert.match(err, /3 attempts/);
    assert.match(err, /meta/i);
    // Exactly 3 agent calls: author + 2 repairs (the 3rd validate fails terminally).
    const started = store.readEvents(id).filter((e) => e.type === "agent_started");
    assert.equal(started.length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing task fails fast without dispatching any agent", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-gen-"));
  try {
    const configPath = mockAuthorConfig(root, { authored: GOOD_SCRIPT, repaired: GOOD_SCRIPT });
    const store = new RunStore(join(root, "runs"));
    const id = store.create({
      script: "",
      inlineSource: GENERATE_WORKFLOW_SOURCE,
      args: { dialectDoc: SKILL_MD, patternsDigest: PATTERNS_DIGEST },
      source: root,
      configPath,
      workflowName: "generate-workflow",
    });
    assert.equal(await executeRun(store.runDir(id)), "failed");
    assert.match(String(store.readError(id)?.error), /args\.task/);
    assert.equal(store.readEvents(id).filter((e) => e.type === "agent_started").length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
