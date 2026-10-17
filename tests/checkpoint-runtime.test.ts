import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CheckpointRequest } from "../src/control.js";
import { RunStopped } from "../src/errors.js";
import type { WorkflowEvent } from "../src/events.js";
import { FileControl } from "../src/runtime/file-control.js";
import { startRunFromSource, waitFor } from "../src/runtime/launcher.js";
import { RunStore } from "../src/runtime/run-store.js";
import { detail, summarize } from "../src/runtime/runs-view.js";
import { META, callsOf, pendingIds, project, stopProcessRun, until } from "./checkpoint-project.js";

// checkpoint() through the run directory: answers arrive in the control file,
// status.json shows what waits, and the run views fold it into "waiting".

const POSIX_ONLY = { skip: process.platform === "win32" };
const ofType = (events: WorkflowEvent[], type: string) => events.filter((e) => e.type === type);

test("FileControl answers from the control file: each request once, stale ones skipped", async () => {
  let requests: CheckpointRequest[] = [{ action: "approve", at: 1 }]; // written before anything waited
  const unmatched: CheckpointRequest[] = [];
  const fc = new FileControl({
    readAction: () => null,
    readDecisions: () => requests,
    onUnmatchedDecision: (r) => unmatched.push(r),
    pollIntervalMs: 5,
  });
  const ask = (id: number) => fc.awaitDecision(id, new AbortController().signal);
  const one = ask(1);
  const two = ask(2);
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  requests = [
    ...requests,
    { action: "reject", checkpointId: 2, note: "no", by: "dashboard", at: 2 },
    { action: "approve", checkpointId: 7, by: "cli", at: 3 },
    { action: "approve", by: "cli", at: 4 }, // no id: the oldest waiting, #1
  ];
  assert.deepEqual(await two, { approved: false, note: "no", by: "dashboard" });
  assert.deepEqual(await one, { approved: true, note: null, by: "cli" });
  assert.deepEqual(unmatched, [{ action: "approve", checkpointId: 7, by: "cli", at: 3 }], "an answer for nothing is reported, not kept");

  // The next question starts fresh: nothing already in the file answers it.
  const three = ask(3);
  let answered = false;
  void three.then(() => (answered = true));
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  assert.equal(answered, false);
  requests = [...requests, { action: "approve", checkpointId: 3, by: "cli", at: 5 }];
  assert.equal((await three).approved, true);

  const controller = new AbortController();
  const four = fc.awaitDecision(4, controller.signal);
  const reason = new RunStopped("run was stopped");
  controller.abort(reason);
  await assert.rejects(four, (err) => err === reason);
});

test("the control file keeps checkpoint answers and the run-level action side by side", () => {
  const root = mkdtempSync(join(tmpdir(), "odw-cp-store-"));
  try {
    const store = new RunStore(root);
    const id = store.create({ script: join(root, "wf.js"), args: null, source: root });
    store.requestCheckpointDecision(id, { action: "approve", checkpointId: 1, note: "go", by: "cli" });
    store.writeControl(id, "pause");
    store.requestCheckpointDecision(id, { action: "reject", by: "dashboard" });
    assert.equal(store.readControl(id), "pause", "an answer keeps the pause");
    const requests = store.readCheckpointRequests(id);
    assert.deepEqual(
      requests.map(({ at: _at, ...r }) => r),
      [
        { action: "approve", checkpointId: 1, note: "go", by: "cli" },
        { action: "reject", by: "dashboard" },
      ],
      "a pause keeps the answers",
    );
    assert.ok(requests.every((r) => typeof r.at === "number"));
    // Hand-edited garbage is left out.
    const control = JSON.parse(readFileSync(store.controlPath(id), "utf8"));
    control.checkpoints.push({ action: "maybe" }, { action: "approve", checkpointId: 0 }, "approve", null);
    writeFileSync(store.controlPath(id), JSON.stringify(control));
    assert.equal(store.readCheckpointRequests(id).length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worker: the run shows 'waiting' while a checkpoint waits, and goes on once it is answered", async () => {
  const p = project();
  try {
    const { id, run } = p.start(
      "const a = await agent('TASK:plan')\n" +
        "const first = await checkpoint('Ship it?', { payload: { plan: a } })\n" +
        "const second = await checkpoint('Really?')\n" +
        "return { first, second }\n",
    );
    await until(() => pendingIds(p.store, id).length === 1);
    assert.equal(summarize(p.store, id).state, "waiting");
    assert.equal(summarize(p.store, id).rawState, "running", "status.json keeps its own state");
    const status = p.store.readStatus(id);
    assert.deepEqual(Object.keys(status.waiting as object).sort(), ["checkpointId", "since", "title"]);
    assert.equal((status.waiting as { title: string }).title, "Ship it?");
    assert.deepEqual(detail(p.store, id).pendingCheckpoints, [
      { checkpointId: 1, title: "Ship it?", payload: { plan: "done:plan" }, since: (status.waiting as { since: number }).since },
    ]);

    // Answered through the control file, as `odw approve` and the dashboard do.
    p.store.requestCheckpointDecision(id, { action: "approve", checkpointId: 1, note: "go", by: "cli" });
    await until(() => pendingIds(p.store, id).join() === "2");
    assert.equal(summarize(p.store, id).state, "waiting");
    assert.equal((p.store.readStatus(id).waiting as { checkpointId: number }).checkpointId, 2);
    // A hand-written answer without an id goes to the oldest waiting.
    p.store.requestCheckpointDecision(id, { action: "reject" });
    assert.equal(await run, "done");
    assert.deepEqual(p.store.readResult(id), {
      first: { approved: true, note: "go", by: "cli" },
      second: { approved: false, note: null, by: "cli" },
    });
    assert.equal(p.store.readStatus(id).waiting, null);
    assert.equal(summarize(p.store, id).state, "done");
    assert.deepEqual(detail(p.store, id).pendingCheckpoints, []);
  } finally {
    await p.cleanup();
  }
});

test("worker: a stop while waiting ends the run stopped, with the question withdrawn", async () => {
  const p = project();
  try {
    const { id, run } = p.start("await checkpoint('Hold?')\nreturn 'unreachable'\n");
    await until(() => pendingIds(p.store, id).length === 1);
    const stoppedAt = Date.now();
    p.store.writeControl(id, "stop");
    assert.equal(await run, "stopped");
    assert.ok(Date.now() - stoppedAt < 5000, `the stop took ${Date.now() - stoppedAt}ms`);
    assert.equal(p.store.readStatus(id).state, "stopped");
    assert.equal(p.store.readStatus(id).waiting, null);
    const types = p.store.readEvents(id).map((e) => e.type);
    assert.ok(types.indexOf("checkpoint_resolved") < types.indexOf("run_stopped"), types.join(","));
    const resolved = ofType(p.store.readEvents(id), "checkpoint_resolved")[0]!;
    assert.match(String(resolved.error), /run was stopped/);
    assert.equal(summarize(p.store, id).state, "stopped");
  } finally {
    await p.cleanup();
  }
});

test("worker: an answer for a checkpoint that is not waiting is logged and changes nothing", async () => {
  const p = project();
  try {
    const { id, run } = p.start("return await checkpoint('Only one?')\n");
    await until(() => pendingIds(p.store, id).length === 1);
    p.store.requestCheckpointDecision(id, { action: "approve", checkpointId: 5, by: "dashboard" });
    const ignored = () =>
      ofType(p.store.readEvents(id), "log").filter((e) => /^ignored "approve" for checkpoint #5/.test(String(e.message)));
    await until(() => ignored().length > 0);
    assert.equal(
      ignored()[0]!.message,
      'ignored "approve" for checkpoint #5 from the dashboard: no such checkpoint is waiting for an answer',
    );
    assert.deepEqual(pendingIds(p.store, id), [1]);
    p.store.requestCheckpointDecision(id, { action: "approve", checkpointId: 1, by: "cli" });
    assert.equal(await run, "done");
  } finally {
    await p.cleanup();
  }
});

test("state folding: 'waiting' only for a live running run; paused and stale keep their mapping", () => {
  const root = mkdtempSync(join(tmpdir(), "odw-cp-fold-"));
  try {
    const store = new RunStore(root);
    const seed = (state: string, pid: number | null, events: Array<Record<string, unknown>>) => {
      const id = store.create({ script: "/demo/wf.js", args: null, source: "/demo" });
      store.updateStatus(id, { state, ...(pid ? { pid } : {}) });
      for (const ev of events) appendFileSync(store.eventsPath(id), JSON.stringify(ev) + "\n");
      return id;
    };
    const asked = { ts: 10, type: "checkpoint_requested", checkpointId: 1, title: "Go?", payload: { a: 1 }, phase: null };
    const answered = { ts: 11, type: "checkpoint_resolved", checkpointId: 1, approved: true, note: null, by: "cli" };

    const waiting = seed("running", process.pid, [{ ts: 9, type: "run_started" }, asked]);
    assert.equal(summarize(store, waiting).state, "waiting");
    assert.deepEqual(detail(store, waiting).pendingCheckpoints, [{ checkpointId: 1, title: "Go?", payload: { a: 1 }, since: 10 }]);

    const cleared = seed("running", process.pid, [asked, answered]);
    assert.equal(summarize(store, cleared).state, "running");
    assert.deepEqual(detail(store, cleared).pendingCheckpoints, []);

    const paused = seed("paused", process.pid, [asked]);
    assert.equal(summarize(store, paused).state, "paused", "a paused run reads paused");
    assert.equal(detail(store, paused).pendingCheckpoints!.length, 1, "…and its question can still be answered");

    const stale = seed("running", null, [asked]);
    assert.equal(summarize(store, stale).state, "stale");
    assert.deepEqual(detail(store, stale).pendingCheckpoints, [], "nobody is left to hear an answer");

    const ended = seed("stopped", null, [asked, { ts: 12, type: "run_stopped" }]);
    assert.equal(summarize(store, ended).state, "stopped");
    assert.deepEqual(detail(store, ended).pendingCheckpoints, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a worker process whose only work is a waiting checkpoint stays alive until it is answered", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-cp-proc-"));
  const { runId, store } = startRunFromSource(META + "return await checkpoint('Proceed?', { payload: 'plan' })\n", {
    runsRoot: root,
  });
  try {
    await until(() => pendingIds(store, runId).length === 1, 20_000);
    // Long enough for an idle Node process to have exited on its own.
    await new Promise<void>((resolve) => setTimeout(resolve, 600));
    assert.equal(summarize(store, runId).state, "waiting", "the worker is still there to hear the answer");
    store.requestCheckpointDecision(runId, { action: "approve", checkpointId: 1, note: "ship it", by: "cli" });
    const status = await waitFor(store, runId, { timeoutMs: 20_000, pollIntervalMs: 50 });
    assert.equal(status.state, "done", JSON.stringify(status));
    assert.deepEqual(store.readResult(runId), { approved: true, note: "ship it", by: "cli" });
  } finally {
    await stopProcessRun(store, runId);
    rmSync(root, { recursive: true, force: true });
  }
});

test("SIGTERM to a worker waiting at a checkpoint stops the run", POSIX_ONLY, async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-cp-sig-"));
  const { runId, store } = startRunFromSource(META + "await checkpoint('Wait for me?')\nreturn 1\n", { runsRoot: root });
  try {
    await until(() => pendingIds(store, runId).length === 1, 20_000);
    process.kill(store.readStatus(runId).pid as number, "SIGTERM");
    const status = await waitFor(store, runId, { timeoutMs: 20_000, pollIntervalMs: 50 });
    assert.equal(status.state, "stopped");
    assert.equal(store.readStatus(runId).waiting, null);
  } finally {
    await stopProcessRun(store, runId);
    rmSync(root, { recursive: true, force: true });
  }
});

test("odw resume replays finished agents but asks every checkpoint again", async () => {
  const p = project();
  try {
    const body =
      "const plan = await agent('TASK:plan', { label: 'plan' })\n" +
      "const ok = await checkpoint('Run the plan?', { payload: plan })\n" +
      "if (!ok.approved) return 'rejected'\n" +
      "return await agent('TASK:work', { label: 'work' })\n";
    const first = p.start(body);
    await until(() => pendingIds(p.store, first.id).length === 1);
    p.store.requestCheckpointDecision(first.id, { action: "approve", checkpointId: 1, by: "cli" });
    assert.equal(await first.run, "done");
    assert.deepEqual(callsOf(p), ["plan", "work"]);

    const again = p.start(body, { resumedFrom: { runId: first.id, dir: p.store.runDir(first.id) } });
    await until(() => pendingIds(p.store, again.id).length === 1);
    assert.equal(summarize(p.store, again.id).state, "waiting", "the replayed run waits for a person again");
    assert.equal(ofType(p.store.readEvents(again.id), "agent_finished")[0]!.cached, true, "the plan was replayed");
    p.store.requestCheckpointDecision(again.id, { action: "reject", checkpointId: 1, note: "changed my mind", by: "cli" });
    assert.equal(await again.run, "done");
    assert.equal(p.store.readResult(again.id), "rejected", "the new answer counts, not the old one");
    assert.deepEqual(callsOf(p), ["plan", "work"], "no agent ran again");
  } finally {
    await p.cleanup();
  }
});
