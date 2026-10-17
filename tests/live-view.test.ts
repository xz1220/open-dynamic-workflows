import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { attachRun, formatEvent, resolveRunMode } from "../src/runtime/live-view.js";
import { RunStore } from "../src/runtime/run-store.js";
import { FakeTerm } from "./fake-term.js";

const ENV = { TERM: "xterm", LANG: "en_US.UTF-8" }; // color on (16), unicode on
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function freshStore(): RunStore {
  return new RunStore(mkdtempSync(join(tmpdir(), "odw-live-")));
}

function makeRun(store: RunStore, name = "demo"): string {
  const runId = store.create({
    script: "/tmp/never-read/wf.js",
    args: null,
    source: process.cwd(),
    workflowName: name,
  });
  store.updateStatus(runId, { state: "running", pid: process.pid, name });
  return runId;
}

function emit(store: RunStore, runId: string, ev: Record<string, unknown>): void {
  appendFileSync(store.eventsPath(runId), JSON.stringify(ev) + "\n");
}

class Collector {
  chunks: string[] = [];
  readonly isTTY = false;
  write(s: string): void {
    this.chunks.push(s);
  }
  text(): string {
    return this.chunks.join("");
  }
}

// --- mode resolution ---------------------------------------------------------------

test("resolveRunMode: bare interactive attaches; any capture detaches", () => {
  const env = {};
  const both = { stdoutTTY: true, stderrTTY: true };
  assert.deepEqual(resolveRunMode({}, both, env), { mode: "attach" });
  // RUN=$(odw run …): stdout captured, stderr still a terminal — must detach.
  assert.deepEqual(resolveRunMode({}, { stdoutTTY: false, stderrTTY: true }, env), {
    mode: "detach",
  });
  assert.deepEqual(resolveRunMode({}, { stdoutTTY: true, stderrTTY: false }, env), {
    mode: "detach",
  });
});

test("resolveRunMode: CI and ODW_DETACH force detach; explicit flags beat both", () => {
  const both = { stdoutTTY: true, stderrTTY: true };
  assert.deepEqual(resolveRunMode({}, both, { CI: "true" }), { mode: "detach" });
  assert.deepEqual(resolveRunMode({}, both, { ODW_DETACH: "1" }), { mode: "detach" });
  assert.deepEqual(resolveRunMode({}, both, { CI: "false" }), { mode: "attach" });
  assert.deepEqual(resolveRunMode({ fg: true }, both, { ODW_DETACH: "1" }), { mode: "attach" });
  assert.deepEqual(resolveRunMode({ wait: true }, both, { CI: "1" }), { mode: "wait" });
});

test("resolveRunMode: conflicting flags are a usage error", () => {
  const both = { stdoutTTY: true, stderrTTY: true };
  const r = resolveRunMode({ fg: true, detach: true }, both, {});
  assert.ok("usageError" in r && r.usageError.includes("--fg"));
  assert.ok("usageError" in resolveRunMode({ wait: true, detach: true }, both, {}));
});

// --- incremental event reader --------------------------------------------------------

test("readEventsSince advances only past complete lines and survives truncation", () => {
  const store = freshStore();
  const runId = makeRun(store);
  const path = store.eventsPath(runId);

  let cur = { offset: 0 };
  appendFileSync(path, JSON.stringify({ ts: 1, type: "run_started" }) + "\n");
  let r = store.readEventsSince(runId, cur);
  assert.equal(r.events.length, 1);
  cur = r.cursor;

  // A torn tail (no newline yet) is not consumed…
  appendFileSync(path, '{"ts":2,"type":"log","mess');
  r = store.readEventsSince(runId, cur);
  assert.equal(r.events.length, 0);
  assert.equal(r.cursor.offset, cur.offset);

  // …and is delivered whole once the writer finishes the line.
  appendFileSync(path, 'age":"hi"}\n' + JSON.stringify({ ts: 3, type: "log", message: "中文" }) + "\n");
  r = store.readEventsSince(runId, cur);
  assert.deepEqual(
    r.events.map((e) => e.ts),
    [2, 3],
  );
  cur = r.cursor;

  // A replaced/truncated file resets the cursor instead of hanging.
  writeFileSync(path, JSON.stringify({ ts: 9, type: "run_started" }) + "\n");
  r = store.readEventsSince(runId, cur);
  assert.deepEqual(
    r.events.map((e) => e.ts),
    [9],
  );
});

test("readEventsSince: a REPLACED file that outgrew the old offset is re-read from 0", () => {
  const store = freshStore();
  const runId = makeRun(store);
  const path = store.eventsPath(runId);

  appendFileSync(path, JSON.stringify({ ts: 1, type: "run_started" }) + "\n");
  let cur = store.readEventsSince(runId, { offset: 0 }).cursor;

  // Replace the file with MORE bytes than the old offset. The filesystem may
  // immediately reuse its inode; either way we must read from the beginning.
  rmSync(path);
  const lines = [
    JSON.stringify({ ts: 10, type: "run_started" }),
    JSON.stringify({ ts: 11, type: "log", message: "padding so the new file is longer" }),
  ];
  writeFileSync(path, lines.join("\n") + "\n");
  const r = store.readEventsSince(runId, cur);
  assert.deepEqual(
    r.events.map((e) => e.ts),
    [10, 11],
  );
});

test("readEventsSince detects replacement even when its inode is reused", () => {
  const store = freshStore();
  try {
    const runId = makeRun(store);
    const path = store.eventsPath(runId);
    writeFileSync(path, JSON.stringify({ ts: 1, type: "run_started" }) + "\n");
    const cursor = store.readEventsSince(runId, { offset: 0 }).cursor;
    rmSync(path);
    writeFileSync(path, [
      JSON.stringify({ ts: 10, type: "run_started" }),
      JSON.stringify({ ts: 11, type: "log", message: "replacement longer than the old offset" }),
    ].join("\n") + "\n");
    // Force the inode comparison to pass independently of the host filesystem.
    const reused = { ...cursor, ino: statSync(path).ino };
    const read = store.readEventsSince(runId, reused);
    assert.deepEqual(read.events.map((ev) => ev.ts), [10, 11]);
    assert.deepEqual(store.readEventsSince(runId, read.cursor).events, []);
  } finally {
    rmSync(store.root, { recursive: true, force: true });
  }
});

test("readEventsSince checks the consumed boundary for same-size rewrites with a shared prefix", () => {
  const store = freshStore();
  try {
    const runId = makeRun(store);
    const path = store.eventsPath(runId);
    const prefix = JSON.stringify({ ts: 1, type: "log", message: "common-prefix".repeat(100) }) + "\n";
    const before = prefix + JSON.stringify({ ts: 2, type: "log", message: "old".repeat(100) }) + "\n";
    const after = prefix + JSON.stringify({ ts: 3, type: "log", message: "new".repeat(100) }) + "\n";
    assert.equal(Buffer.byteLength(before), Buffer.byteLength(after));
    writeFileSync(path, before);
    const cursor = store.readEventsSince(runId, { offset: 0 }).cursor;
    writeFileSync(path, after); // O_TRUNC retains the inode.
    assert.equal(statSync(path).ino, cursor.ino);
    const read = store.readEventsSince(runId, cursor);
    assert.deepEqual(read.events.map((ev) => ev.ts), [1, 3]);
    assert.deepEqual(store.readEventsSince(runId, read.cursor).events, []);
    appendFileSync(path, JSON.stringify({ ts: 4, type: "log", message: "append" }) + "\n");
    assert.deepEqual(store.readEventsSince(runId, read.cursor).events.map((ev) => ev.ts), [4]);
  } finally {
    rmSync(store.root, { recursive: true, force: true });
  }
});

test("readEventsSince fingerprints stay bounded and do not consume torn UTF-8 appends", () => {
  const store = freshStore();
  try {
    const runId = makeRun(store);
    const path = store.eventsPath(runId);
    writeFileSync(path, JSON.stringify({ ts: 1, type: "log", message: "large".repeat(100_000) }) + "\n");
    const cursor = store.readEventsSince(runId, { offset: 0 }).cursor;
    assert.ok(Buffer.from(cursor.prefix!, "base64").length <= 128);
    assert.ok(Buffer.from(cursor.boundary!, "base64").length <= 128);
    const line = Buffer.from(JSON.stringify({ ts: 2, type: "log", message: "中文" }) + "\n");
    const split = line.indexOf(Buffer.from("中")) + 1;
    appendFileSync(path, line.subarray(0, split));
    const torn = store.readEventsSince(runId, cursor);
    assert.deepEqual(torn.events, []);
    assert.equal(torn.cursor.offset, cursor.offset);
    appendFileSync(path, line.subarray(split));
    const complete = store.readEventsSince(runId, torn.cursor);
    assert.equal(complete.events.length, 1);
    assert.equal(complete.events[0]!.message, "中文");
    assert.deepEqual(store.readEventsSince(runId, complete.cursor).events, []);
  } finally {
    rmSync(store.root, { recursive: true, force: true });
  }
});

// --- live attach: happy path ----------------------------------------------------------

test("attachRun (live): scrollback narrates phases/agents and pairing uses agentId", async () => {
  const store = freshStore();
  const runId = makeRun(store, "fg-demo");
  const term = new FakeTerm(100);
  const out = new Collector();

  emit(store, runId, { ts: 100, type: "run_started", runId });
  emit(store, runId, { ts: 100, type: "phase_started", phase: "Gather" });
  emit(store, runId, { ts: 100, type: "log", message: "fanning out" });
  emit(store, runId, { ts: 100, type: "agent_started", agentId: 1, label: "search", phase: "Gather", adapter: "fake" });
  emit(store, runId, { ts: 101, type: "agent_started", agentId: 2, label: "search", phase: "Gather", adapter: "fake" });

  const done = attachRun(store, runId, {
    out,
    err: term,
    live: true,
    pollMs: 10,
    signals: false,
    env: ENV,
  });

  await sleep(50);
  // agent 2 finishes FIRST. Legacy label-pairing would misattribute this to
  // agent 1 (the older node); agentId pairing must credit agent 2 (0.5s).
  emit(store, runId, { ts: 101.5, type: "agent_finished", agentId: 2, label: "search", phase: "Gather", adapter: "fake", attempts: 1 });
  emit(store, runId, { ts: 104, type: "agent_finished", agentId: 1, label: "search", phase: "Gather", adapter: "fake", attempts: 2 });
  emit(store, runId, { ts: 104, type: "phase_started", phase: "Reduce" });
  emit(store, runId, { ts: 104, type: "agent_started", agentId: 3, label: "reduce", phase: "Reduce", adapter: "fake" });
  await sleep(40);
  emit(store, runId, { ts: 105, type: "agent_finished", agentId: 3, label: "reduce", phase: "Reduce", adapter: "fake", attempts: 1 });
  emit(store, runId, { ts: 105, type: "run_finished", runId });
  store.writeResult(runId, { answer: 42 });
  store.updateStatus(runId, { state: "done", spentTokens: 12 });

  assert.equal(await done, 0);
  const screen = term.text();

  assert.match(screen, /◆ fg-demo/);
  assert.match(screen, new RegExp(runId));
  assert.match(screen, /Gather ─+/);
  assert.match(screen, /· fanning out/);
  assert.match(screen, /Reduce ─+/);
  // agentId pairing: the first settled line carries agent 2's 0.5s, not 3.5s.
  const settleOrder = screen.match(/✔ search.*\n.*✔ search.*/s);
  assert.ok(settleOrder, "both search agents settle in the scrollback");
  assert.match(screen, /✔ search\s+.*0\.5s/);
  assert.match(screen, /✔ search\s+.*4\.0s.*2 tries/);
  assert.match(screen, /✔ reduce/);
  assert.match(screen, /✔ done\s+.*3 agents.*~12 tok/);
  // the active block is gone from the final screen; cursor restored
  assert.doesNotMatch(screen, /running/);
  assert.equal(term.hiddenCursor, false);
  // stdout carries exactly the result JSON
  assert.deepEqual(JSON.parse(out.text()), { answer: 42 });
});

// --- live attach: failure -------------------------------------------------------------

test("attachRun (live): a failed run paints the error and exits 1", async () => {
  const store = freshStore();
  const runId = makeRun(store, "boom");
  const term = new FakeTerm(100);
  const out = new Collector();

  emit(store, runId, { ts: 10, type: "run_started", runId });
  emit(store, runId, { ts: 10, type: "agent_started", agentId: 1, label: "job", adapter: "fake" });

  const done = attachRun(store, runId, {
    out,
    err: term,
    live: true,
    pollMs: 10,
    signals: false,
    env: ENV,
  });
  await sleep(40);
  emit(store, runId, { ts: 11, type: "agent_failed", agentId: 1, label: "job", error: "exploded badly" });
  emit(store, runId, { ts: 11, type: "run_failed", runId });
  store.writeError(runId, { error: "exploded badly" });
  store.updateStatus(runId, { state: "failed" });

  assert.equal(await done, 1);
  const screen = term.text();
  assert.match(screen, /✖ job/);
  assert.match(screen, /exploded badly/);
  assert.match(screen, /✖ failed/);
  assert.equal(out.text(), ""); // no result JSON on stdout for a failed run
});

test("attachRun (live): a failed agent says why it failed; a plain exit adds nothing", async () => {
  const store = freshStore();
  const runId = makeRun(store, "limits");
  const term = new FakeTerm(120);
  const out = new Collector();

  emit(store, runId, { ts: 10, type: "run_started", runId });
  emit(store, runId, { ts: 10, type: "agent_started", agentId: 1, label: "search", adapter: "codex" });
  emit(store, runId, { ts: 10, type: "agent_started", agentId: 2, label: "write", adapter: "codex" });
  const done = attachRun(store, runId, { out, err: term, live: true, pollMs: 10, signals: false, env: ENV });
  await sleep(40);
  emit(store, runId, {
    ts: 12,
    type: "agent_failed",
    agentId: 1,
    label: "search",
    reason: "quota",
    retryAfter: 600,
    error: "AdapterExecutionError: adapter 'codex' ran out of usage quota",
  });
  emit(store, runId, {
    ts: 13,
    type: "agent_failed",
    agentId: 2,
    label: "write",
    reason: "exit",
    error: "AdapterExecutionError: adapter 'codex' exited with code 1: boom",
  });
  emit(store, runId, { ts: 13, type: "run_failed", runId });
  store.updateStatus(runId, { state: "failed" });

  assert.equal(await done, 1);
  const screen = term.text();
  assert.match(screen, /✖ search\s+codex · out of quota · 2\.0s/);
  assert.match(screen, /ran out of usage quota/);
  assert.match(screen, /✖ write\s+codex · 3\.0s/, "exit is the error line's job");
});

test("formatEvent: a failed agent's reason, and when to retry, lead its error", () => {
  const failed = (fields: Record<string, unknown>) =>
    formatEvent({ ts: 0, type: "agent_failed", agentId: 3, label: "search", phase: "Search", ...fields });
  assert.match(
    failed({ reason: "rate_limit", error: "AdapterExecutionError: adapter 'codex' hit a rate limit" }),
    /agent_failed\s+\(Search\) search — \[rate_limit\] AdapterExecutionError: adapter 'codex' hit a rate limit$/,
  );
  assert.match(
    failed({ reason: "quota", retryAfter: 12_120, error: "AdapterExecutionError: out of quota" }),
    / search — \[quota, retry after 3h 22m\] AdapterExecutionError: out of quota$/,
  );
  assert.match(failed({ error: "RunStopped: run was stopped" }), / search — RunStopped: run was stopped$/, "no reason, no tag");
  assert.match(
    failed({ reason: "\x1b]0;pwn\x07auth", error: "x" }),
    / search — \[auth\] x$/,
    "a reason is event text: sanitized like the rest",
  );
});

test("attachRun: a run_finished event with a stuck status still settles as done", async () => {
  const store = freshStore();
  const runId = makeRun(store, "stuck");
  const term = new FakeTerm(100);
  const out = new Collector();

  emit(store, runId, { ts: 1, type: "run_started", runId });
  emit(store, runId, { ts: 2, type: "run_finished", runId });
  store.writeResult(runId, "late");
  // status.state stays "running" forever — the worker died between writes.

  const code = await attachRun(store, runId, {
    out,
    err: term,
    live: true,
    pollMs: 20,
    signals: false,
    env: ENV,
  });
  assert.equal(code, 0);
  assert.match(term.text(), /status never settled/);
  assert.equal(JSON.parse(out.text()), "late");
});

test("attachRun: workflow-controlled run names are sanitized before the header", async () => {
  const store = freshStore();
  const runId = makeRun(store, "evil\x1b]0;pwned\x07name");
  const term = new FakeTerm(100);
  emit(store, runId, { ts: 1, type: "run_finished", runId });
  store.writeResult(runId, null);
  store.updateStatus(runId, { state: "done" });
  await attachRun(store, runId, {
    out: new Collector(),
    err: term,
    live: true,
    pollMs: 10,
    signals: false,
    env: ENV,
  });
  assert.doesNotMatch(term.raw, /\x1b\]0;/); // the OSC never reaches the terminal
  assert.match(term.text(), /evilname/);
});

test("attachRun: TERM=dumb never enters the live renderer (no cursor CSI at all)", async () => {
  const store = freshStore();
  const runId = makeRun(store, "dumb");
  const term = new FakeTerm(80);
  emit(store, runId, { ts: 1, type: "run_finished", runId });
  store.writeResult(runId, 1);
  store.updateStatus(runId, { state: "done" });
  const code = await attachRun(store, runId, {
    out: new Collector(),
    err: term,
    pollMs: 10,
    signals: false,
    env: { TERM: "dumb" },
  });
  assert.equal(code, 0);
  assert.doesNotMatch(term.raw, /\x1b\[\?25l/);
  assert.doesNotMatch(term.raw, /\x1b\[0J/);
});

test("attachRun: a Windows console without TERM still gets the live renderer", async () => {
  const store = freshStore();
  const runId = makeRun(store, "win");
  const term = new FakeTerm(80);
  emit(store, runId, { ts: 1, type: "run_finished", runId });
  store.writeResult(runId, 1);
  store.updateStatus(runId, { state: "done" });
  const code = await attachRun(store, runId, {
    out: new Collector(),
    err: term,
    pollMs: 10,
    signals: false,
    env: {},
    platform: "win32",
  });
  assert.equal(code, 0);
  assert.match(term.raw, /\x1b\[\?25l/); // the live view hid the cursor while drawing
  assert.equal(term.hiddenCursor, false); // …and restored it on exit
});

test("attachRun: no TERM on POSIX stays on the plain line stream", async () => {
  const store = freshStore();
  const runId = makeRun(store, "posix");
  const term = new FakeTerm(80);
  emit(store, runId, { ts: 1, type: "run_finished", runId });
  store.writeResult(runId, 1);
  store.updateStatus(runId, { state: "done" });
  await attachRun(store, runId, { out: new Collector(), err: term, pollMs: 10, signals: false, env: {}, platform: "linux" });
  assert.doesNotMatch(term.raw, /\x1b\[\?25l/);
});

// --- timeout & detach -------------------------------------------------------------------

test("attachRun: --timeout exits 124 and says the run continues", async () => {
  const store = freshStore();
  const runId = makeRun(store);
  const term = new FakeTerm(100);
  const code = await attachRun(store, runId, {
    out: new Collector(),
    err: term,
    live: true,
    pollMs: 10,
    timeoutMs: 80,
    signals: false,
    env: ENV,
  });
  assert.equal(code, 124);
  assert.match(term.text(), /timed out after 0s — run continues \(odw attach/);
  assert.equal(term.hiddenCursor, false);
});

test("attachRun: SIGINT detaches with 130 and the run is untouched", async () => {
  const store = freshStore();
  const runId = makeRun(store);
  const term = new FakeTerm(100);
  const done = attachRun(store, runId, {
    out: new Collector(),
    err: term,
    live: true,
    pollMs: 10,
    signals: true,
    env: ENV,
  });
  await sleep(30);
  (process as unknown as { emit(e: string): boolean }).emit("SIGINT");
  assert.equal(await done, 130);
  assert.match(term.text(), /detached — run continues in the background/);
  assert.equal(String(store.readStatus(runId).state), "running");
  assert.equal(term.hiddenCursor, false);
});

// --- line mode (non-TTY --fg) --------------------------------------------------------------

test("attachRun (line mode): plain sanitized lines, result on stdout, zero ANSI", async () => {
  const store = freshStore();
  const runId = makeRun(store, "plain");
  const err = new Collector();
  const out = new Collector();

  emit(store, runId, { ts: 1, type: "run_started", runId });
  emit(store, runId, { ts: 1, type: "agent_started", agentId: 1, label: "evil\x1b]0;pwn\x07label", adapter: "fake" });

  const done = attachRun(store, runId, { out, err, live: false, pollMs: 10, signals: false, env: {} });
  await sleep(30);
  emit(store, runId, { ts: 2, type: "agent_finished", agentId: 1, label: "evil\x1b]0;pwn\x07label", adapter: "fake", attempts: 1 });
  emit(store, runId, { ts: 2, type: "run_finished", runId });
  store.writeResult(runId, "ok");
  store.updateStatus(runId, { state: "done" });

  assert.equal(await done, 0);
  const logs = err.text();
  assert.match(logs, /agent_started/);
  assert.match(logs, /evillabel/); // OSC payload stripped, text kept
  assert.doesNotMatch(logs, /\x1b/);
  assert.equal(JSON.parse(out.text()), "ok");
});

// --- vanished run ----------------------------------------------------------------------------

test("attachRun: a deleted run directory exits 1 instead of spinning forever", async () => {
  const store = freshStore();
  const runId = makeRun(store);
  rmSync(store.runDir(runId), { recursive: true, force: true });
  const term = new FakeTerm(80);
  const code = await attachRun(store, runId, {
    out: new Collector(),
    err: term,
    live: true,
    pollMs: 10,
    signals: false,
    env: ENV,
  });
  assert.equal(code, 1);
  assert.match(term.text(), /unreadable/);
});

test("attachRun: a dead worker fails before the timeout and restores the cursor", async () => {
  const store = freshStore();
  try {
    const runId = makeRun(store);
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    assert.equal(dead.status, 0);
    store.updateStatus(runId, { pid: dead.pid });
    const term = new FakeTerm(80);
    const code = await attachRun(store, runId, {
      out: new Collector(), err: term, live: true, signals: false, env: ENV, timeoutMs: 0,
    });
    assert.equal(code, 1);
    assert.match(term.text(), /worker process .* is gone/);
    assert.doesNotMatch(term.text(), /run continues/);
    assert.ok(term.raw.endsWith("\x1b[?25h"));
  } finally {
    rmSync(store.root, { recursive: true, force: true });
  }
});
