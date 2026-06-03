import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startRun } from "../src/runtime/launcher.js";

// These assert the launcher WIRING: that startRun resolves a bare name against
// <source>/.odw/workflows (not process.cwd()), via the shared resolveWorkflow.
// The success case spawns a detached, unref'd worker that just fails fast under
// the test runner (no compiled worker.js); we only read meta.json, which
// store.create() writes synchronously before the spawn.

test("startRun resolves a bare name against <source>/.odw/workflows", () => {
  const tmp = mkdtempSync(join(tmpdir(), "odw-launch-"));
  try {
    const proj = join(tmp, "proj");
    const wfDir = join(proj, ".odw", "workflows");
    mkdirSync(wfDir, { recursive: true });
    const wf = join(wfDir, "smoke.js");
    writeFileSync(wf, "export const meta = { name: 'smoke', description: 'x' }\nreturn 1\n");

    const { runId, store } = startRun("smoke", { source: proj, runsRoot: join(tmp, "runs") });
    const meta = store.readMeta(runId);
    assert.equal(meta.script, wf, "name must resolve to the project workflows file");
    assert.equal(meta.source, proj);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("startRun surfaces the resolver's not-found error for an unknown name", () => {
  const tmp = mkdtempSync(join(tmpdir(), "odw-launch-"));
  try {
    const proj = join(tmp, "proj");
    mkdirSync(join(proj, ".odw", "workflows"), { recursive: true });
    assert.throws(
      () => startRun("definitely-not-a-workflow", { source: proj, runsRoot: join(tmp, "runs") }),
      /no workflow named 'definitely-not-a-workflow'/,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
