import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";

import { defaultConfig } from "../src/adapters/config.js";
import { buildContext } from "../src/context.js";
import { createPrimitives } from "../src/primitives.js";
import { startRun, startRunFromSource, waitFor } from "../src/runtime/launcher.js";
import { RunStore } from "../src/runtime/run-store.js";
import { executeRun } from "../src/runtime/worker.js";

// The three launch-layer engine seams (docs/tasks/launch.md §3.3):
//   (a) validate(source) — compile-check a candidate workflow from inside a workflow
//   (b) run-level adapter override — meta.adapter as the run's default agent() adapter
//   (c) startRunFromSource — inline source archived as workflow.js inside the run dir

function prims() {
  return createPrimitives(buildContext(defaultConfig()));
}

// --- (a) validate ------------------------------------------------------------

test("validate() compiles a good script and returns its meta", () => {
  const { validate } = prims();
  const report = validate(
    "export const meta = { name: 'gen', description: 'd', phases: [{ title: 'A' }] }\nreturn 1\n",
  );
  assert.equal(report.ok, true);
  assert.equal(report.meta?.name, "gen");
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.warnings, []);
});

test("validate() reports a missing meta as a compile error", () => {
  const { validate } = prims();
  const report = validate("return 1\n");
  assert.equal(report.ok, false);
  assert.match(report.errors[0]!, /export const meta/);
});

test("validate() reports a non-literal meta as a compile error", () => {
  const { validate } = prims();
  const report = validate("export const meta = makeMeta()\nreturn 1\n");
  assert.equal(report.ok, false);
  assert.ok(report.errors.length > 0);
});

test("validate() rejects stray top-level imports", () => {
  const { validate } = prims();
  const report = validate(
    "import fs from 'node:fs'\nexport const meta = { name: 'x', description: 'd' }\nreturn 1\n",
  );
  assert.equal(report.ok, false);
  assert.match(report.errors[0]!, /export\/import/);
});

test("validate() flags Claude-banned APIs as warnings, not errors", () => {
  const { validate } = prims();
  const report = validate(
    "export const meta = { name: 'x', description: 'd' }\nconst t = Date.now()\nconst r = Math.random()\nreturn new Date()\n",
  );
  assert.equal(report.ok, true, "ODW itself runs these — they are advisories");
  assert.equal(report.warnings.length, 3);
  assert.match(report.warnings.join(" "), /Date\.now/);
  assert.match(report.warnings.join(" "), /Math\.random/);
  assert.match(report.warnings.join(" "), /new Date/);
});

test("validate() does not flag banned APIs inside strings or comments", () => {
  const { validate } = prims();
  const report = validate(
    "export const meta = { name: 'x', description: 'd' }\n// Date.now() in a comment\nconst s = 'Math.random()'\nreturn s\n",
  );
  assert.equal(report.ok, true);
  assert.deepEqual(report.warnings, []);
});

test("validate() handles non-string input without throwing", () => {
  const { validate } = prims();
  const report = validate(42 as unknown as string);
  assert.equal(report.ok, false);
});

// --- (b) run-level adapter override -------------------------------------------

/** A config file with two distinguishable mock adapters. */
function writeTwoAdapterConfig(dir: string): string {
  const path = join(dir, "odw.config.json");
  const echo = (tag: string) => [
    execPath,
    "-e",
    `let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write('${tag}'))`,
  ];
  writeFileSync(
    path,
    JSON.stringify({
      defaultAdapter: "alpha",
      workspaceMode: "inplace",
      adapters: {
        alpha: { command: echo("from-alpha"), stdin: "{prompt}" },
        beta: { command: echo("from-beta"), stdin: "{prompt}" },
      },
    }),
  );
  return path;
}

test("meta.adapter overrides the config default for agent() calls", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-seam-"));
  try {
    const configPath = writeTwoAdapterConfig(root);
    const script = join(root, "wf.js");
    writeFileSync(
      script,
      "export const meta = { name: 'wf', description: 'd' }\nreturn await agent('hi')\n",
    );
    const store = new RunStore(join(root, "runs"));
    const id = store.create({ script, args: null, source: root, configPath, adapter: "beta" });
    const state = await executeRun(store.runDir(id));
    assert.equal(state, "done");
    assert.equal(store.readResult(id), "from-beta");
    // The event stream records the effective default adapter, not the config one.
    const started = store.readEvents(id).filter((e) => e.type === "agent_started");
    assert.equal(started[0]!.adapter, "beta");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit agent(p, { adapter }) still beats the run-level override", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-seam-"));
  try {
    const configPath = writeTwoAdapterConfig(root);
    const script = join(root, "wf.js");
    writeFileSync(
      script,
      "export const meta = { name: 'wf', description: 'd' }\nreturn await agent('hi', { adapter: 'alpha' })\n",
    );
    const store = new RunStore(join(root, "runs"));
    const id = store.create({ script, args: null, source: root, configPath, adapter: "beta" });
    await executeRun(store.runDir(id));
    assert.equal(store.readResult(id), "from-alpha");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startRun fails fast on an unknown --adapter name", () => {
  const root = mkdtempSync(join(tmpdir(), "odw-seam-"));
  try {
    const script = join(root, "wf.js");
    writeFileSync(script, "export const meta = { name: 'wf', description: 'd' }\nreturn 1\n");
    assert.throws(
      () => startRun(script, { source: root, runsRoot: join(root, "runs"), adapter: "nope" }),
      /unknown adapter 'nope'/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- (c) startRunFromSource ----------------------------------------------------

test("startRunFromSource archives the script in the run dir and runs it", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-seam-"));
  try {
    const source = "export const meta = { name: 'inline-wf', description: 'd' }\nreturn args.n * 2\n";
    const { runId, store } = startRunFromSource(source, {
      source: root,
      runsRoot: join(root, "runs"),
      args: { n: 21 },
      origin: "launch",
    });
    const meta = store.readMeta(runId);
    const archived = join(store.runDir(runId), "workflow.js");
    assert.equal(meta.script, archived, "meta.script points inside the run dir");
    assert.equal(readFileSync(archived, "utf8"), source, "source archived verbatim");
    assert.equal(meta.origin, "launch");
    assert.equal(meta.workflowName, "inline-wf");
    const status = await waitFor(store, runId, { timeoutMs: 10000 });
    assert.equal(status.state, "done");
    assert.equal(store.readResult(runId), 42);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startRunFromSource rejects a bad script before any worker spawns", () => {
  const root = mkdtempSync(join(tmpdir(), "odw-seam-"));
  try {
    assert.throws(
      () => startRunFromSource("return 1\n", { source: root, runsRoot: join(root, "runs") }),
      /export const meta/,
    );
    assert.equal(existsSync(join(root, "runs")), false, "no run directory is left behind");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startRunFromSource with allowInvalid records the failure as a run", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-seam-"));
  try {
    const { runId, store } = startRunFromSource("return 1\n", {
      source: root,
      runsRoot: join(root, "runs"),
      allowInvalid: true,
    });
    const status = await waitFor(store, runId, { timeoutMs: 10000 });
    assert.equal(status.state, "failed");
    assert.match(String(store.readError(runId)?.error), /export const meta/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rerun semantics: an inline run's archived script is independently runnable", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-seam-"));
  try {
    const { runId, store } = startRunFromSource(
      "export const meta = { name: 'inline-wf', description: 'd' }\nreturn 7\n",
      { source: root, runsRoot: join(root, "runs") },
    );
    await waitFor(store, runId, { timeoutMs: 10000 });
    const script = store.readMeta(runId).script as string;
    const { runId: again } = startRun(script, { source: root, runsRoot: join(root, "runs") });
    const status = await waitFor(store, again, { timeoutMs: 10000 });
    assert.equal(status.state, "done");
    assert.equal(store.readResult(again), 7);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
