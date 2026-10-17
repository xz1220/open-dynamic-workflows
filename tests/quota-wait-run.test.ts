import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";

import { pausedText, type PausedFor } from "../src/quota-wait.js";
import { attachRun } from "../src/runtime/live-view.js";
import { RunStore, TERMINAL_STATES } from "../src/runtime/run-store.js";
import { detail, summarize } from "../src/runtime/runs-view.js";
import { startServer } from "../src/runtime/server.js";
import { executeRun } from "../src/runtime/worker.js";
import { cli } from "./checkpoint-project.js";
import { FakeTerm } from "./fake-term.js";

// Pause for a spent quota (ODW extension: quotaWait), end to end: the worker
// runs mock CLIs out of quota; status.json, the run views, odw status, odw list,
// odw run --wait, the live view and the API say until when; odw resume ends the
// wait at once and odw stop stops the run.

// What the CLIs print, as tests/failures.test.ts samples them.
const QUOTA = "You've hit your usage limit. Upgrade to Pro or try again in 3h 22m."; // resets in 12,120s
const NO_RESET = "Credit balance is too low"; // a spent quota that names no reset
const HOUR = 3600;

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition did not become true in time");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

// --- end to end: the worker, the run directory, mock CLIs -------------------------------------

/**
 * A mock CLI out of quota on its first `spentRuns` runs — saying when it
 * resets — that answers after. Each run appends a byte to `counter` (an
 * O_APPEND write): the file's length is the number of runs.
 */
function spentAgent(counter: string, spentRuns: number, message = QUOTA): string[] {
  const file = JSON.stringify(counter);
  return [
    execPath,
    "-e",
    `const fs = require('fs'); fs.appendFileSync(${file}, '.'); const n = fs.statSync(${file}).size - 1;` +
      `if (n < ${spentRuns}) { process.stderr.write(${JSON.stringify(message)}); process.exit(1); }` +
      `process.stdout.write('answered on run ' + (n + 1));`,
  ];
}

/** A run of `body` started in-process, whose `spent` adapter is out of quota for 3h 22m on its first run. */
function quotaRun(body: string, extra: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "odw-quota-e2e-"));
  const counter = join(root, "spent-runs");
  const configPath = join(root, "odw.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      defaultAdapter: "spent",
      quotaWait: { max: 6 * HOUR },
      adapters: {
        spent: { command: spentAgent(counter, 1) },
        fine: { command: [execPath, "-e", "process.stdout.write('fine answer')"] },
      },
      ...extra,
    }),
  );
  const script = join(root, "nightly.js");
  writeFileSync(script, `export const meta = { name: 'nightly', description: 'd' }\n${body}`);
  const runsRoot = join(root, "runs");
  const store = new RunStore(runsRoot);
  const id = store.create({ script, args: null, source: root, configPath });
  const run = executeRun(store.runDir(id));
  return {
    root,
    counter,
    runsRoot,
    store,
    id,
    run,
    paused: () => store.readStatus(id).state === "paused",
    logs: () => store.readEvents(id).filter((e) => e.type === "log").map((e) => String(e.message)),
    /** Stop the run if a failed assertion left it waiting (a waiting run keeps the process busy), then remove it. */
    async cleanup(): Promise<void> {
      if (!TERMINAL_STATES.has(String(store.readStatus(id).state))) store.writeControl(id, "stop");
      await run.catch(() => {});
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("end to end: a run out of quota shows paused until its reset — odw status, odw list, the live view, the API — while other adapters work, and odw resume goes on now", async () => {
  const r = quotaRun(
    "const [a, b] = await parallel([\n" +
      "  () => agent('TASK:one', { label: 'one' }),\n" +
      "  () => agent('TASK:two', { adapter: 'fine', label: 'two' }),\n" +
      "])\nreturn { a, b }\n",
    { concurrency: 1 },
  );
  const handle = await startServer({ store: r.store, port: 0, host: "127.0.0.1", claudeProjectsRoot: join(r.root, "no-claude") });
  let attached: Promise<number> | undefined;
  try {
    await until(r.paused);
    const pausedFor = r.store.readStatus(r.id).pausedFor as PausedFor;
    assert.deepEqual([pausedFor.reason, pausedFor.adapter], ["quota", "spent"]);
    assert.ok(Math.abs(pausedFor.resumeAt - (Date.now() / 1000 + 12_120)) < 60, "its reset: in 3h 22m");
    const text = pausedText(pausedFor);
    assert.match(text, /^paused until (?:[A-Z][a-z]{2} \d{1,2} )?\d\d:\d\d \(spent quota\)$/);
    // The waiting agent holds no slot: the other adapter's agent runs on the run's one.
    await until(() => r.store.readEvents(r.id).some((e) => e.type === "agent_finished" && e.label === "two"));
    assert.equal(r.store.readStatus(r.id).state, "paused");

    // The run views and the API.
    const summary = summarize(r.store, r.id);
    assert.deepEqual([summary.state, summary.rawState, summary.pausedFor], ["paused", "paused", pausedFor]);
    assert.deepEqual(detail(r.store, r.id).pausedFor, pausedFor);
    const runs = (await fetch(`${handle.url}/api/runs`).then((res) => res.json())) as Array<{ runId: string; state: string; pausedFor: unknown }>;
    const listed = runs.find((run) => run.runId === r.id)!;
    assert.deepEqual([listed.state, listed.pausedFor], ["paused", pausedFor]);
    const api = (await fetch(`${handle.url}/api/runs/${r.id}`).then((res) => res.json())) as { state: string; pausedFor: unknown };
    assert.deepEqual([api.state, api.pausedFor], ["paused", pausedFor]);

    // odw status and odw list.
    const status = await cli(["status", r.id, "--runs-root", r.runsRoot]);
    assert.match(status.out, new RegExp(`^${r.id}  \\[paused\\]  nightly$`, "m"));
    assert.ok(status.out.includes(`\n  ${text} — its agents go on then; odw resume ${r.id} goes on now\n`), status.out);
    const list = await cli(["list", "--runs-root", r.runsRoot]);
    assert.ok(list.out.includes(`${r.id}  paused    nightly  ${text}\n`), list.out);

    // The live view's summary line.
    const term = new FakeTerm(220);
    attached = attachRun(r.store, r.id, {
      out: { isTTY: false, write: () => {} },
      err: term,
      live: true,
      pollMs: 20,
      signals: false,
      env: { TERM: "xterm", LANG: "en_US.UTF-8" },
    });
    await until(() => term.text().includes(text));

    // What the run's log says.
    assert.ok(r.logs().some((m) => m.startsWith("quota pause: spent is out of usage quota until ")), r.logs().join("\n"));
    assert.ok(r.logs().includes("one:1 waits for spent's quota to reset (quotaWait)"));

    // odw resume: the agent goes on now.
    const resumed = await cli(["resume", r.id, "--runs-root", r.runsRoot]);
    assert.deepEqual([resumed.code, resumed.err], [0, `resume requested for ${r.id} — it was ${text}; its agents go on now\n`]);
    assert.equal(await r.run, "done");
    assert.equal(await attached, 0);
    assert.deepEqual(r.store.readResult(r.id), { a: "answered on run 2", b: "fine answer" });
    assert.equal(readFileSync(r.counter, "utf8").length, 2, "out of quota once, then it answered after the resume");
    const after = r.store.readStatus(r.id);
    assert.deepEqual([after.state, after.pausedFor], ["done", null]);
    assert.equal(summarize(r.store, r.id).pausedFor, null);
    assert.ok(r.logs().includes("quota pause over: the run was resumed — spent's agents go on now"));
    assert.ok(r.logs().includes("one:1 goes on after the quota wait, on spent"));
    const transcript = readFileSync(r.store.agentTranscriptPaths(r.id, 1).transcript, "utf8");
    assert.ok(transcript.includes('{"kind":"attempt","n":2,"reason":"quota_wait","adapter":"spent"}'), transcript);
  } finally {
    await handle.close();
    await r.cleanup();
    await attached?.catch(() => {});
  }
});

test("end to end: odw stop while the run waits for a quota stops it at once, and nothing shows paused any more", async () => {
  const r = quotaRun("return await agent('TASK:one', { label: 'one' })\n");
  try {
    await until(r.paused);
    const stoppedAt = Date.now();
    assert.equal((await cli(["stop", r.id, "--runs-root", r.runsRoot])).code, 0);
    assert.equal(await r.run, "stopped");
    assert.ok(Date.now() - stoppedAt < 5000, `the stop took ${Date.now() - stoppedAt}ms`);
    const status = r.store.readStatus(r.id);
    assert.deepEqual([status.state, status.pausedFor], ["stopped", null]);
    assert.deepEqual([summarize(r.store, r.id).state, summarize(r.store, r.id).pausedFor], ["stopped", null]);
    const failed = r.store.readEvents(r.id).filter((e) => e.type === "agent_failed");
    assert.equal(failed.length, 1);
    assert.match(String(failed[0]!.error), /^RunStopped/);
    assert.equal(readFileSync(r.counter, "utf8").length, 1, "it never ran again");
    assert.ok(!r.logs().some((m) => m.startsWith("quota pause over")), "the run ended under its pause");
    assert.ok(!(await cli(["list", "--runs-root", r.runsRoot])).out.includes("paused until"));
  } finally {
    await r.cleanup();
  }
});

test("end to end: a quota that resets past quotaWait.max, or names no reset, fails its agent as before — the log says why", async () => {
  const far = quotaRun("return await agent('TASK:one', { label: 'one' })\n", { quotaWait: { max: HOUR } });
  try {
    assert.equal(await far.run, "failed");
    const failed = far.store.readEvents(far.id).find((e) => e.type === "agent_failed")!;
    assert.deepEqual([failed.reason, failed.retryAfter], ["quota", 12_120]);
    assert.ok(far.logs().includes("one:1: quotaWait: not waiting — spent's quota resets in 3h 22m, past quotaWait.max (1h), so the agent fails"));
    assert.equal(far.store.readStatus(far.id).pausedFor, undefined, "it never paused");
  } finally {
    await far.cleanup();
  }
  const unknown = quotaRun("return await agent('TASK:one', { label: 'one' })\n", {
    adapters: { spent: { command: [execPath, "-e", `process.stderr.write(${JSON.stringify(NO_RESET)}); process.exit(1)`] } },
  });
  try {
    assert.equal(await unknown.run, "failed");
    const failed = unknown.store.readEvents(unknown.id).find((e) => e.type === "agent_failed")!;
    assert.deepEqual([failed.reason, failed.retryAfter], ["quota", undefined]);
    assert.ok(unknown.logs().includes("one:1: quotaWait: not waiting — spent did not say when its quota resets, so the agent fails"));
  } finally {
    await unknown.cleanup();
  }
});

test("odw run --wait says until when a run is paused for a quota, once, and how to go on now", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-quota-wait-"));
  const store = new RunStore(join(root, "runs"));
  const configPath = join(root, "odw.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({ defaultAdapter: "spent", quotaWait: { max: 6 * HOUR }, adapters: { spent: { command: spentAgent(join(root, "runs-of-spent"), 1) } } }),
  );
  const script = join(root, "nightly.js");
  writeFileSync(script, "export const meta = { name: 'nightly', description: 'd' }\nreturn await agent('TASK:one')\n");
  let runId = "";
  try {
    const waiting = cli(["run", script, "--wait", "--timeout", "30", "--config", configPath, "--runs-root", store.root]);
    await until(() => {
      runId = store.listRunIds()[0] ?? "";
      return runId !== "" && store.readStatus(runId).state === "paused";
    }, 20_000);
    // Long enough for a few of --wait's polls to see the pause.
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    const pausedFor = store.readStatus(runId).pausedFor as PausedFor;
    assert.equal((await cli(["resume", runId, "--runs-root", store.root])).code, 0);
    const r = await waiting;
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out), "answered on run 2");
    const said = `${pausedText(pausedFor)} — odw resume ${runId} goes on now\n`;
    assert.equal(r.err.split(said).length, 2, `said once:\n${r.err}`);
  } finally {
    if (runId && !TERMINAL_STATES.has(String(store.readStatus(runId).state))) {
      store.writeControl(runId, "stop");
      await until(() => TERMINAL_STATES.has(String(store.readStatus(runId).state)), 15_000).catch(() => {});
    }
    rmSync(root, { recursive: true, force: true });
  }
});

// --- what readers show ----------------------------------------------------------------------

test("state folding: pausedFor shows for a live paused run only; odw status and odw list say until when", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-quota-fold-"));
  try {
    const store = new RunStore(root);
    const seed = (status: Record<string, unknown>): string => {
      const id = store.create({ script: "/demo/nightly.js", args: null, source: "/demo", workflowName: "nightly" });
      store.updateStatus(id, { name: "nightly", ...status });
      return id;
    };
    const pausedFor = { reason: "quota", adapter: "codex", resumeAt: Date.now() / 1000 + HOUR };
    const live = seed({ state: "paused", pid: process.pid, pausedFor });
    assert.deepEqual([summarize(store, live).state, summarize(store, live).pausedFor], ["paused", pausedFor]);
    assert.deepEqual(detail(store, live).pausedFor, pausedFor);
    const stale = seed({ state: "paused", pausedFor }); // its worker is gone: nothing goes on at the reset
    assert.deepEqual([summarize(store, stale).state, summarize(store, stale).pausedFor], ["stale", null]);
    const byHand = seed({ state: "paused", pid: process.pid }); // odw pause
    assert.deepEqual([summarize(store, byHand).state, summarize(store, byHand).pausedFor], ["paused", null]);
    const running = seed({ state: "running", pid: process.pid, pausedFor });
    assert.equal(summarize(store, running).pausedFor, null);
    const odd = seed({ state: "paused", pid: process.pid, pausedFor: { reason: "maintenance", adapter: "codex", resumeAt: 1 } });
    assert.equal(summarize(store, odd).pausedFor, null);

    const text = pausedText(pausedFor);
    const status = await cli(["status", live, "--runs-root", root]);
    assert.ok(status.out.includes(`\n  ${text} — its agents go on then; odw resume ${live} goes on now\n`), status.out);
    assert.ok(!(await cli(["status", byHand, "--runs-root", root])).out.includes("paused until"));
    const list = (await cli(["list", "--runs-root", root])).out.split("\n");
    assert.equal(list.find((line) => line.startsWith(live)), `${live}  paused    nightly  ${text}`);
    for (const id of [byHand, running, odd]) assert.ok(!list.find((line) => line.startsWith(id))!.includes("paused until"), id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SSE: the run list is pushed again when what a paused run waits for changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-quota-sse-"));
  const store = new RunStore(join(root, "runs"));
  const id = store.create({ script: "/demo/nightly.js", args: null, source: "/demo" });
  const first = { reason: "quota", adapter: "codex", resumeAt: 1_800_000_000 };
  store.updateStatus(id, { state: "paused", pid: process.pid, name: "nightly", pausedFor: first });
  appendFileSync(store.eventsPath(id), JSON.stringify({ ts: 1, type: "run_started", runId: id }) + "\n");
  const handle = await startServer({ store, port: 0, host: "127.0.0.1", claudeProjectsRoot: join(root, "no-claude") });
  const abort = new AbortController();
  try {
    const res = await fetch(`${handle.url}/api/stream`, { signal: abort.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    /** Read `runs` frames until one's pausedFor passes `done`. */
    const nextList = async (done: (pausedFor: PausedFor | null) => boolean): Promise<void> => {
      const deadline = setTimeout(() => abort.abort(), 8000);
      try {
        for (;;) {
          let cut: number;
          while ((cut = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, cut);
            buf = buf.slice(cut + 2);
            const data = /^event: runs\ndata: (.*)$/m.exec(frame)?.[1];
            if (data && done(JSON.parse(data)[0].pausedFor)) return;
          }
          const { value, done: ended } = await reader.read();
          if (ended) throw new Error("stream ended");
          buf += decoder.decode(value, { stream: true });
        }
      } finally {
        clearTimeout(deadline);
      }
    };
    await nextList((p) => p?.resumeAt === first.resumeAt);
    // Its CLI named a later reset: still "paused", same counts — but a new time shows.
    store.updateStatus(id, { pausedFor: { ...first, resumeAt: first.resumeAt + HOUR } });
    await nextList((p) => p?.resumeAt === first.resumeAt + HOUR);
  } finally {
    abort.abort();
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});
