import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { attachRun, formatEvent } from "../src/runtime/live-view.js";
import { RunStore } from "../src/runtime/run-store.js";
import { FakeTerm } from "./fake-term.js";
import { META, cli, pendingIds, project, stopProcessRun, until } from "./checkpoint-project.js";

// checkpoint() in the terminal: `odw approve|reject`, and the places that say
// what a run waits for and the exact commands that answer it — `odw status`,
// `odw list`, `odw run --wait`, `odw resume` and the live view.

test("odw approve|reject answer a waiting checkpoint; odw status and list show it with the commands", async () => {
  const p = project();
  try {
    const { id, run } = p.start(
      "const [a, b] = await parallel([\n" +
        "  () => checkpoint('Deploy to staging?', { payload: { hosts: ['web-1', 'web-2'] } }),\n" +
        "  () => checkpoint('Email users?', { payload: 'line 1\\nline 2' }),\n" +
        "])\n" +
        "return { a, b }\n",
    );
    await until(() => pendingIds(p.store, id).length === 2);
    const flags = ["--runs-root", p.runsRoot];

    let r = await cli(["status", id, ...flags]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, new RegExp(`^${id}  \\[waiting\\]  gate`));
    assert.match(r.out, /checkpoint #1: Deploy to staging\?\n    payload:\n      \{\n        "hosts": \[\n          "web-1",/);
    assert.match(r.out, /checkpoint #2: Email users\?\n    payload:\n      line 1\n      line 2\n/);
    assert.ok(r.out.includes(`approve: odw approve ${id} --checkpoint 1 --runs-root ${p.runsRoot}\n`), r.out);
    assert.ok(r.out.includes(`reject:  odw reject ${id} --checkpoint 2 --runs-root ${p.runsRoot}\n`), r.out);
    r = await cli(["list", ...flags]);
    assert.match(r.out, new RegExp(`${id}  waiting   gate`));
    r = await cli(["resume", id, ...flags]);
    assert.equal(r.code, 1, "a waiting run goes on when it is answered, not resumed");
    assert.match(r.err, new RegExp(`waits for a decision at checkpoint #1: odw approve\\|reject ${id}`));

    // Usage mistakes are caught before anything is written.
    assert.equal((await cli(["approve", ...flags])).code, 2);
    r = await cli(["approve", id, "--checkpoint", "two", ...flags]);
    assert.equal(r.code, 2);
    assert.match(r.err, /--checkpoint must be a checkpoint number/);
    r = await cli(["approve", id, "--checkpoint", "9", ...flags]);
    assert.equal(r.code, 1);
    assert.match(r.err, /checkpoint #9 of run .* is not waiting for a decision; waiting: #1 "Deploy to staging\?", #2 "Email users\?"/);
    assert.equal((await cli(["approve", "no-such-run", ...flags])).code, 1);
    assert.equal(p.store.readCheckpointRequests(id).length, 0);

    r = await cli(["reject", id, "--checkpoint", "2", "--note", "not yet", ...flags]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, new RegExp(`reject requested for checkpoint #2 "Email users\\?" of ${id}`));
    r = await cli(["approve", id, ...flags]); // no --checkpoint: the oldest waiting
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /approve requested for checkpoint #1 "Deploy to staging\?"/);

    assert.equal(await run, "done");
    assert.deepEqual(p.store.readResult(id), {
      a: { approved: true, note: null, by: "cli" },
      b: { approved: false, note: "not yet", by: "cli" },
    });
    r = await cli(["approve", id, ...flags]);
    assert.equal(r.code, 1);
    assert.match(r.err, /has no checkpoint waiting for a decision \(it is done\)/);
    r = await cli(["status", id, ...flags]);
    assert.match(r.out, /\[done\]/);
    assert.doesNotMatch(r.out, /odw approve/);
  } finally {
    await p.cleanup();
  }
});

test("odw run --wait says which checkpoint holds the run, and how to answer it", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-cp-wait-"));
  const store = new RunStore(join(root, "runs"));
  const script = join(root, "gate.js");
  writeFileSync(script, META + "return await checkpoint('Proceed?')\n");
  let runId = "";
  try {
    const waiting = cli(["run", script, "--wait", "--timeout", "30", "--runs-root", store.root]);
    await until(() => {
      runId = store.listRunIds()[0] ?? "";
      return runId !== "" && pendingIds(store, runId).length === 1;
    }, 20_000);
    // Long enough for a few of --wait's polls to see the checkpoint.
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    const r0 = await cli(["approve", runId, "--runs-root", store.root]);
    assert.equal(r0.code, 0, r0.err);
    const r = await waiting;
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(JSON.parse(r.out), { approved: true, note: null, by: "cli" });
    const hint =
      `waiting for a decision — checkpoint #1: Proceed?\n` +
      `  approve: odw approve ${runId} --checkpoint 1 --runs-root ${store.root}\n` +
      `  reject:  odw reject ${runId} --checkpoint 1 --runs-root ${store.root}\n`;
    assert.equal(r.err.split(hint).length, 2, `said once:\n${r.err}`);
  } finally {
    if (runId) await stopProcessRun(store, runId);
    rmSync(root, { recursive: true, force: true });
  }
});

test("the live view shows a waiting checkpoint with the exact commands, and its answer", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-cp-live-"));
  try {
    const store = new RunStore(root);
    const runId = store.create({ script: "/tmp/never-read/wf.js", args: null, source: process.cwd(), workflowName: "gate" });
    store.updateStatus(runId, { state: "running", pid: process.pid, name: "gate" });
    const emit = (ev: Record<string, unknown>) => appendFileSync(store.eventsPath(runId), JSON.stringify(ev) + "\n");
    emit({ ts: 1, type: "run_started", runId });
    emit({ ts: 2, type: "checkpoint_requested", checkpointId: 1, title: "Ship\x1b]0;x\x07 it?", payload: { a: 1 }, phase: null });
    const term = new FakeTerm(160);
    const out = {
      chunks: [] as string[],
      write(s: string) {
        this.chunks.push(s);
      },
    };
    const done = attachRun(store, runId, {
      out,
      err: term,
      live: true,
      pollMs: 10,
      signals: false,
      env: { TERM: "xterm", LANG: "en_US.UTF-8" },
      commandFlags: ["--runs-root", "/runs dir"],
    });
    await until(() => term.text().includes("1 waiting for a decision"));
    let screen = term.text();
    assert.match(screen, /◇ Ship it\?\s+checkpoint #1 · waiting for a decision/);
    assert.ok(screen.includes(`approve: odw approve ${runId} --checkpoint 1 --runs-root '/runs dir'`), screen);
    assert.ok(screen.includes(`reject:  odw reject ${runId} --checkpoint 1 --runs-root '/runs dir'`), screen);
    emit({ ts: 3, type: "checkpoint_resolved", checkpointId: 1, approved: true, note: "lgtm", by: "cli" });
    emit({ ts: 4, type: "run_finished", runId });
    store.writeResult(runId, "ok");
    store.updateStatus(runId, { state: "done" });
    assert.equal(await done, 0);
    screen = term.text();
    assert.match(screen, /✔ Ship it\?\s+approved · by cli · "lgtm"/);
    assert.doesNotMatch(screen, /1 waiting for a decision/, "the active block is gone");
    assert.equal(term.hiddenCursor, false);

    // The plain line stream (and odw logs) say the same.
    assert.match(
      formatEvent({ ts: 2, type: "checkpoint_requested", checkpointId: 1, title: "Ship it?", truncated: true }),
      /checkpoint_requested #1 Ship it\? \(payload truncated\)$/,
    );
    assert.match(
      formatEvent({ ts: 3, type: "checkpoint_resolved", checkpointId: 1, approved: false, note: "why", by: "dashboard" }),
      /#1 rejected by dashboard — why$/,
    );
    assert.match(
      formatEvent({ ts: 3, type: "checkpoint_resolved", checkpointId: 2, approved: false, by: null, error: "run was stopped" }),
      /#2 not answered: run was stopped$/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the plain attach stream prints the commands under a checkpoint request", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-cp-line-"));
  try {
    const store = new RunStore(root);
    const runId = store.create({ script: "/tmp/never-read/wf.js", args: null, source: process.cwd() });
    store.updateStatus(runId, { state: "running", pid: process.pid });
    const emit = (ev: Record<string, unknown>) => appendFileSync(store.eventsPath(runId), JSON.stringify(ev) + "\n");
    emit({ ts: 1, type: "checkpoint_requested", checkpointId: 3, title: "Go?", payload: null });
    const collector = () => ({
      chunks: [] as string[],
      isTTY: false,
      write(s: string) {
        this.chunks.push(s);
      },
    });
    const err = collector();
    const done = attachRun(store, runId, { out: collector(), err, live: false, pollMs: 10, signals: false, env: {} });
    await until(() => err.chunks.join("").includes("reject:"));
    emit({ ts: 2, type: "checkpoint_resolved", checkpointId: 3, approved: true, note: null, by: "timeout" });
    emit({ ts: 3, type: "run_finished", runId });
    store.writeResult(runId, 1);
    store.updateStatus(runId, { state: "done" });
    assert.equal(await done, 0);
    const text = err.chunks.join("");
    assert.ok(
      text.includes(`\n  approve: odw approve ${runId} --checkpoint 3\n  reject:  odw reject ${runId} --checkpoint 3\n`),
      text,
    );
    assert.match(text, /checkpoint_resolved #3 approved by timeout/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
