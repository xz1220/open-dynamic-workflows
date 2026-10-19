import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execPath } from "node:process";

import { DiskFull, isFatalError } from "../src/errors.js";
import { DISK_FULL, RESERVE_FILE, diskFullMessage, isDiskFullError } from "../src/runtime/disk-full.js";
import { scanWorktrees } from "../src/runtime/gc.js";
import { pidReused, processStartTime } from "../src/runtime/process-identity.js";
import { isRunActive, RunObserver } from "../src/runtime/run-liveness.js";
import { JsonlSink, RunStore } from "../src/runtime/run-store.js";
import { reconcileState, summarize } from "../src/runtime/runs-view.js";
import { executeRun } from "../src/runtime/worker.js";
import { acquireLock } from "../src/schedule/store.js";
import { OWNER_FILE } from "../src/workspace.js";

// Disk full and pid reuse (ODW extension; src/runtime/disk-full.ts,
// src/runtime/process-identity.ts): a run whose disk fills up stops its agents
// and fails with failureReason "disk_full"; a worker pid another process holds
// since — after a reboot, or with a different start time — is dead.

const DEV_FULL = existsSync("/dev/full"); // Linux: every write fails with ENOSPC
const READS_START = process.platform !== "win32";

function scratch(): { root: string; store: RunStore; script: string; cleanup: () => void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "odw-disk-pid-")));
  const script = join(root, "wf.js");
  writeFileSync(script, "export const meta = { name: 'w', description: 'd' }\nreturn 1");
  return { root, store: new RunStore(join(root, "runs")), script, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Status.json written as is — the worker's own fields, as a reboot or another host left them. */
function setStatus(store: RunStore, runId: string, status: Record<string, unknown>): void {
  writeFileSync(join(store.runDir(runId), "status.json"), JSON.stringify({ runId, ...status }));
}

test("processStartTime names this process the same way twice, and no process for a pid that is gone", { skip: !READS_START }, () => {
  const start = processStartTime(process.pid);
  assert.ok(start, "this process's start can be read here");
  assert.match(start!, /^(linux:[0-9a-f-]+:\d+|ps:.+)$/);
  assert.equal(processStartTime(process.pid), start);
  const gone = spawnSync(execPath, ["-e", ""]).pid!;
  assert.equal(processStartTime(gone), null);
  assert.equal(processStartTime(-1), null);
  if (process.platform === "linux") assert.match(start!, /^linux:/);
});

test("pidReused: another start, or a status last written before this boot; never when nothing tells", () => {
  const now = Date.now();
  const startOf = () => "ps:Mon Oct 19 10:00:00 2026";
  // The same process: not reused.
  assert.equal(pidReused({ pid: 42, pidStart: "ps:Mon Oct 19 10:00:00 2026" }, { startOf }), false);
  // Another process holds the pid.
  assert.equal(pidReused({ pid: 42, pidStart: "ps:Sun Oct 18 09:00:00 2026" }, { startOf }), true);
  // Nothing recorded (an older run), nothing readable, or read another way: the pid probe stands.
  assert.equal(pidReused({ pid: 42 }, { startOf }), false);
  assert.equal(pidReused({ pid: 42, pidStart: "ps:x" }, { startOf: () => null }), false);
  assert.equal(pidReused({ pid: 42, pidStart: "linux:b:1" }, { startOf }), false);
  // Written before this machine booted: no worker of it can be alive, whatever holds its pid.
  const booted = now - 3600_000;
  assert.equal(pidReused({ pid: 42, updatedAt: (booted - 120_000) / 1000 }, { bootedAt: booted, startOf }), true);
  assert.equal(pidReused({ pid: 42, updatedAt: (booted + 5_000) / 1000 }, { bootedAt: booted, startOf }), false);
  // Within the clock's slack of the boot: not taken for dead.
  assert.equal(pidReused({ pid: 42, updatedAt: (booted - 10_000) / 1000 }, { bootedAt: booted, startOf }), false);
});

test("a run whose worker pid another process holds is not active, and shows stale; its own process keeps it running", () => {
  const { store, script, cleanup } = scratch();
  try {
    const runId = store.create({ script, args: null, source: store.root });
    const alive = () => true;
    const now = Date.now() / 1000;
    setStatus(store, runId, { state: "running", pid: 4242, pidStart: "ps:A", updatedAt: now });
    assert.equal(isRunActive(store, runId, alive, { startOf: () => "ps:A" }), true);
    assert.equal(isRunActive(store, runId, alive, { startOf: () => "ps:B" }), false, "the pid now names another process");
    assert.deepEqual(reconcileState("running", 4242, { pidStart: "ps:A", updatedAt: now }, { startOf: () => "ps:B" }), { state: "stale", stale: true });
    assert.deepEqual(reconcileState("paused", process.pid, { pidStart: "ps:A", updatedAt: now }, { startOf: () => "ps:A" }), { state: "paused", stale: false });
    // Before this boot: dead on every platform, with or without a recorded start.
    setStatus(store, runId, { state: "running", pid: 4242, updatedAt: now - 7200 });
    assert.equal(isRunActive(store, runId, alive, { bootedAt: Date.now() - 3600_000 }), false);
    assert.equal(isRunActive(store, runId, alive, { bootedAt: Date.now() - 3 * 86_400_000 }), true);
    // The observer `odw wait` and `odw logs` use says the worker is gone.
    const observed = new RunObserver(store, runId, Date.now, alive, { bootedAt: Date.now() - 3600_000 }).read();
    assert.match(observed.error ?? "", /worker process \(pid 4242\) is gone/);
  } finally {
    cleanup();
  }
});

test("the worker records its start beside its pid, and a run list reads it against the live process", { skip: !READS_START }, async () => {
  const { root, store, cleanup } = scratch();
  try {
    const config = join(root, "odw.config.json");
    writeFileSync(config, JSON.stringify({ adapters: { mock: { command: [execPath, "-e", "process.stdout.write('ok')"], stdin: "{prompt}" } }, defaultAdapter: "mock" }));
    const wf = join(root, "one.js");
    writeFileSync(wf, "export const meta = { name: 'one', description: 'x' }\nreturn await agent('hi')\n");
    const runId = store.create({ script: wf, args: null, source: root, configPath: config });
    assert.equal(await executeRun(store.runDir(runId)), "done");
    const status = store.readStatus(runId);
    assert.equal(status.pid, process.pid);
    assert.equal(status.pidStart, processStartTime(process.pid));

    // As it would read mid-run — and with the pid another process's since.
    setStatus(store, runId, { ...status, state: "running", updatedAt: Date.now() / 1000 });
    assert.equal(summarize(store, runId).state, "running");
    assert.equal(isRunActive(store, runId), true);
    setStatus(store, runId, { ...status, state: "running", pidStart: `${status.pidStart}0`, updatedAt: Date.now() / 1000 });
    assert.equal(summarize(store, runId).state, "stale");
    assert.equal(isRunActive(store, runId), false);
  } finally {
    cleanup();
  }
});

test("a schedule lock held by a pid another process holds since is taken over", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "odw-disk-pid-lock-")));
  try {
    const path = join(dir, "s.lock");
    writeFileSync(path, JSON.stringify({ pid: 4242, pidStart: "ps:A", startedAt: new Date().toISOString() }) + "\n");
    const held = acquireLock(path, { isAlive: () => true, startOf: (pid) => (pid === 4242 ? "ps:A" : "ps:me") });
    assert.equal(held.acquired, false, "the holder is the process that took it");
    const taken = acquireLock(path, { isAlive: () => true, startOf: (pid) => (pid === 4242 ? "ps:B" : "ps:me") });
    assert.equal(taken.acquired, true, "the pid is another process's now");
    const written = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(written.pid, process.pid);
    assert.equal(written.pidStart, "ps:me");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("odw gc: a worktree whose owner pid now names another process is an orphan", { skip: !READS_START }, async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "odw-disk-pid-gc-")));
  try {
    const repo = join(base, "repo");
    mkdirSync(repo);
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    writeFileSync(join(repo, "a.txt"), "one\n");
    git("init", "-q");
    git("add", "-A");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--no-gpg-sign", "-m", "init");
    const tmpRoot = join(base, "tmp");
    mkdirSync(tmpRoot);
    const worktree = (pidStart: string): string => {
      const dir = mkdtempSync(join(tmpRoot, "odw-wt-"));
      writeFileSync(join(dir, OWNER_FILE), JSON.stringify({ pid: process.pid, pidStart, run: null, repo, at: Date.now() / 1000 }));
      git("worktree", "add", "-q", "--detach", join(dir, basename(repo)), "HEAD");
      return dir;
    };
    const mine = worktree(processStartTime(process.pid)!);
    const ghost = worktree(`${processStartTime(process.pid)}0`);
    const found = await scanWorktrees({ tmpRoot, store: new RunStore(join(base, "runs")) });
    const by = (dir: string) => found.find((f) => f.dir === dir)!;
    assert.equal(by(mine).orphan, false);
    assert.match(by(mine).why, /in use by process/);
    assert.equal(by(ghost).orphan, true);
    assert.match(by(ghost).why, /process \d+ is gone/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a full disk is ENOSPC or EDQUOT, also wrapped; DiskFull is fatal and says what to do", () => {
  assert.equal(isDiskFullError(Object.assign(new Error("x"), { code: "ENOSPC" })), true);
  assert.equal(isDiskFullError(Object.assign(new Error("x"), { code: "EDQUOT" })), true);
  assert.equal(isDiskFullError(new Error("crashed", { cause: Object.assign(new Error("x"), { code: "ENOSPC" }) })), true);
  assert.equal(isDiskFullError(Object.assign(new Error("x"), { code: "EACCES" })), false);
  assert.equal(isDiskFullError(null), false);
  assert.equal(isFatalError(new DiskFull("x")), true);
  const message = diskFullMessage("/runs/w/r1", { code: "EDQUOT" });
  assert.match(message, /disk quota is exhausted \(EDQUOT\): the run could not write to \/runs\/w\/r1/);
  assert.match(message, /odw gc/);
  assert.match(message, /odw resume/);
});

test("a run directory holds a reserve from its creation", () => {
  const { store, script, cleanup } = scratch();
  try {
    const runId = store.create({ script, args: null, source: store.root });
    assert.equal(readFileSync(join(store.runDir(runId), RESERVE_FILE)).length, 64 * 1024);
  } finally {
    cleanup();
  }
});

test("JsonlSink: an append that finds the disk full is told, not thrown, once someone listens", { skip: !DEV_FULL }, () => {
  const sink = new JsonlSink("/dev/full");
  assert.throws(() => sink.emit({ type: "log", ts: 0, message: "x" }), (err: NodeJS.ErrnoException) => err.code === "ENOSPC");
  const seen: unknown[] = [];
  sink.onDiskFull = (err) => seen.push(err);
  let emitted = 0;
  sink.onEmit = () => emitted++;
  sink.emit({ type: "log", ts: 0, message: "x" });
  assert.equal(seen.length, 1);
  assert.equal((seen[0] as NodeJS.ErrnoException).code, "ENOSPC");
  assert.equal(emitted, 0, "an event not written is not passed on");
});

/** An agent CLI: "fill" makes the run's events.jsonl a full disk, then answers; "slow" never answers. */
const AGENT =
  "const fs=require('fs'),path=require('path');let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{" +
  "if(d.includes('slow')){setInterval(()=>{},1000);return}" +
  "const runs=path.join(process.cwd(),'runs');" +
  "for(const b of fs.readdirSync(runs))for(const r of fs.readdirSync(path.join(runs,b))){" +
  "const e=path.join(runs,b,r,'events.jsonl');fs.rmSync(e,{force:true});fs.symlinkSync('/dev/full',e)}" +
  "process.stdout.write('filled')})";

test("a run whose disk fills up stops its agents and fails with failureReason disk_full", { skip: !DEV_FULL, timeout: 60_000 }, async () => {
  const { root, store, cleanup } = scratch();
  try {
    const config = join(root, "odw.config.json");
    writeFileSync(config, JSON.stringify({ adapters: { mock: { command: [execPath, "-e", AGENT], stdin: "{prompt}" } }, defaultAdapter: "mock" }));
    const wf = join(root, "fill.js");
    writeFileSync(
      wf,
      "export const meta = { name: 'fill', description: 'x' }\n" +
        "return await parallel([() => agent('fill the disk', { label: 'fill' }), () => agent('slow: never answer', { label: 'slow' })])\n",
    );
    const runId = store.create({ script: wf, args: null, source: root, configPath: config });
    const dir = store.runDir(runId);
    assert.ok(existsSync(join(dir, RESERVE_FILE)));

    // It ends — the slow agent killed, not waited for — and says why.
    assert.equal(await executeRun(dir), "failed");
    const status = store.readStatus(runId);
    assert.equal(status.state, "failed");
    assert.equal(status.failureReason, DISK_FULL);
    const error = store.readError(runId) as { error: string; failureReason: string };
    assert.equal(error.failureReason, DISK_FULL);
    assert.match(error.error, /the disk is full \(ENOSPC\): the run could not write to .* and was stopped/);
    assert.equal(existsSync(join(dir, RESERVE_FILE)), false, "the reserve made room for it");
    // The slow agent's result was never saved: it was stopped, not finished.
    const saved = readdirSync(join(dir, "agents")).filter((f) => /^\d+\.json$/.test(f));
    assert.ok(saved.length <= 1);

    // events.jsonl is /dev/full: read the run as a list does without it.
    unlinkSync(join(dir, "events.jsonl"));
    const listed = summarize(store, runId);
    assert.equal(listed.state, "failed");
    assert.equal(listed.failureReason, "disk_full");
  } finally {
    cleanup();
  }
});

test("a run that ends normally gives its reserve back, with no failure reason", async () => {
  const { root, store, cleanup } = scratch();
  try {
    const config = join(root, "odw.config.json");
    writeFileSync(config, JSON.stringify({ adapters: { mock: { command: [execPath, "-e", "process.stdout.write('ok')"], stdin: "{prompt}" } }, defaultAdapter: "mock" }));
    const wf = join(root, "one.js");
    writeFileSync(wf, "export const meta = { name: 'one', description: 'x' }\nreturn await agent('hi')\n");
    const runId = store.create({ script: wf, args: null, source: root, configPath: config });
    assert.equal(await executeRun(store.runDir(runId)), "done");
    assert.equal(existsSync(join(store.runDir(runId), RESERVE_FILE)), false);
    assert.equal(store.readStatus(runId).failureReason, undefined);
    assert.equal(summarize(store, runId).failureReason, undefined);
  } finally {
    cleanup();
  }
});

