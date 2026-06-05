import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../src/cli.js";
import { startRun } from "../src/runtime/launcher.js";
import { RunStore } from "../src/runtime/run-store.js";

/** Run the CLI with stdout/stderr captured. */
async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  (process.stdout as { write: unknown }).write = (s: unknown) => {
    out.push(String(s));
    return true;
  };
  (process.stderr as { write: unknown }).write = (s: unknown) => {
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

const tempRoot = () => mkdtempSync(join(tmpdir(), "odw-cli-runs-"));

test("R3: list --workflow shows only that workflow's runs", async () => {
  const root = tempRoot();
  try {
    const store = new RunStore(root);
    const a1 = store.create({ script: "a.js", args: null, source: "/s", workflowName: "alpha" });
    const a2 = store.create({ script: "a.js", args: null, source: "/s", workflowName: "alpha" });
    const b1 = store.create({ script: "b.js", args: null, source: "/s", workflowName: "beta" });
    store.updateStatus(a1, { state: "done", name: "alpha" });
    store.updateStatus(a2, { state: "running", name: "alpha" });
    store.updateStatus(b1, { state: "done", name: "beta" });

    const r = await run(["list", "--workflow", "alpha", "--runs-root", root]);
    assert.equal(r.code, 0);
    assert.match(r.out, new RegExp(a1));
    assert.match(r.out, new RegExp(a2));
    assert.doesNotMatch(r.out, new RegExp(b1));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R3: list --workflow with an unknown name is a clean exit with a message", async () => {
  const root = tempRoot();
  try {
    const r = await run(["list", "--workflow", "ghost", "--runs-root", root]);
    assert.equal(r.code, 0);
    assert.match(r.err, /no runs found for workflow 'ghost'/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R3: logs --workflow prints the latest run's events for that workflow", async () => {
  const root = tempRoot();
  try {
    const store = new RunStore(root);
    const id = store.create({ script: "x.js", args: null, source: "/s", workflowName: "gamma" });
    appendFileSync(
      store.eventsPath(id),
      JSON.stringify({ ts: 1, type: "log", message: "hello-from-gamma" }) + "\n",
    );
    const r = await run(["logs", "--workflow", "gamma", "--runs-root", root]);
    assert.equal(r.code, 0);
    assert.match(r.out, /hello-from-gamma/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R3: logs --workflow with no runs returns non-zero", async () => {
  const root = tempRoot();
  try {
    const r = await run(["logs", "--workflow", "nope", "--runs-root", root]);
    assert.equal(r.code, 1);
    assert.match(r.err, /no runs found for workflow 'nope'/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R5: terminal exit codes (done→0, failed→1, stopped→1) — the mapping --wait uses", async () => {
  const root = tempRoot();
  try {
    const store = new RunStore(root);

    const done = store.create({ script: "d.js", args: null, source: "/s", workflowName: "d" });
    store.updateStatus(done, { state: "done" });
    store.writeResult(done, { ok: true });
    let r = await run(["result", done, "--runs-root", root]);
    assert.equal(r.code, 0);
    assert.match(r.out, /"ok": true/);

    const failed = store.create({ script: "f.js", args: null, source: "/s", workflowName: "f" });
    store.updateStatus(failed, { state: "failed" });
    store.writeError(failed, { error: "boom" });
    r = await run(["result", failed, "--runs-root", root]);
    assert.equal(r.code, 1);
    assert.match(r.err, /boom/);

    const stopped = store.create({ script: "s.js", args: null, source: "/s", workflowName: "s" });
    store.updateStatus(stopped, { state: "stopped" });
    r = await run(["result", stopped, "--runs-root", root]);
    assert.equal(r.code, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R7: rerun starts a fresh run with the same script + args", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "odw-rerun-"));
  try {
    const proj = join(tmp, "proj");
    const wfDir = join(proj, ".odw", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(
      join(wfDir, "demo.js"),
      "export const meta = { name: 'demo', description: 'd' }\nreturn 1\n",
    );
    const runsRoot = join(tmp, "runs");
    // Original run (its detached worker fails fast under the test runner; meta is
    // written synchronously, which is all rerun needs to clone the inputs).
    const { runId, store } = startRun("demo", { source: proj, runsRoot, args: { k: 7 } });

    const r = await run(["rerun", runId, "--runs-root", runsRoot]);
    assert.equal(r.code, 0);
    const newId = r.out.trim();
    assert.notEqual(newId, runId);
    assert.ok(store.exists(newId), "the rerun's new run is on disk");
    assert.deepEqual(store.readMeta(newId).args, { k: 7 }, "same args");
    assert.equal(store.readMeta(newId).script, store.readMeta(runId).script, "same script");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("R7: rerun of a missing run reports an error", async () => {
  const root = tempRoot();
  try {
    const r = await run(["rerun", "nope", "--runs-root", root]);
    assert.equal(r.code, 1);
    assert.match(r.err, /no such run/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
