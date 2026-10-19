import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";

import { runCommand } from "../src/adapters/runner.js";
import {
  checkHostSuspend,
  onHostSuspend,
  setSuspendClocks,
  SUSPEND_THRESHOLD_MS,
  SUSPEND_TICK_MS,
  type HostSuspension,
} from "../src/adapters/suspend.js";
import { formatEvent } from "../src/runtime/live-view.js";
import { RunStore } from "../src/runtime/run-store.js";
import { executeRun } from "../src/runtime/worker.js";

// A host that slept (ODW extension): the wall clock jumps past the monotonic
// one, or a tick comes far later than due; every listener — each running
// agent's stall watchdog, the worker's log — hears of it once.

/** Clocks a test moves by hand. */
function fakeClocks() {
  const c = { wall: 1_000_000, mono: 5_000 };
  return { c, clocks: { wall: () => c.wall, mono: () => c.mono } };
}

test("a wall-clock jump past the monotonic clock is a sleep, told once to every listener", () => {
  const { c, clocks } = fakeClocks();
  setSuspendClocks(clocks);
  const heard: HostSuspension[][] = [[], []];
  const offs = heard.map((list) => onHostSuspend((s) => list.push(s)));
  try {
    // An ordinary tick: both clocks moved alike.
    c.wall += SUSPEND_TICK_MS;
    c.mono += SUSPEND_TICK_MS;
    assert.equal(checkHostSuspend(), false);
    // Drift below the threshold (NTP, a slow tick) is no sleep.
    c.wall += SUSPEND_THRESHOLD_MS - 1;
    assert.equal(checkHostSuspend(), false);
    // Linux and macOS: the monotonic clock stood still for the hour the lid was closed.
    c.wall += 3600_000 + 2_000;
    c.mono += 2_000;
    assert.equal(checkHostSuspend(), true);
    for (const list of heard) assert.deepEqual(list, [{ sleptSeconds: 3600, at: c.wall }]);
    // Told once: the next look sees nothing new.
    c.wall += 1_000;
    c.mono += 1_000;
    assert.equal(checkHostSuspend(), false);
    assert.equal(heard[0]!.length, 1);
  } finally {
    for (const off of offs) off();
    setSuspendClocks(null);
  }
});

test("a tick far later than due on both clocks — the event loop suspended — is a sleep too; one listener gone hears nothing", () => {
  const { c, clocks } = fakeClocks();
  setSuspendClocks(clocks);
  const heard: number[] = [];
  const gone: number[] = [];
  const off = onHostSuspend((s) => heard.push(s.sleptSeconds));
  const offGone = onHostSuspend((s) => gone.push(s.sleptSeconds));
  offGone();
  try {
    // Windows' monotonic clock counts through a sleep; a stopped worker (SIGSTOP) sees both run.
    c.wall += 600_000;
    c.mono += 600_000;
    assert.equal(checkHostSuspend(), true);
    assert.deepEqual(heard, [600]);
    assert.deepEqual(gone, []);
  } finally {
    off();
    setSuspendClocks(null);
  }
  // Nobody listening: nothing is watched.
  assert.equal(checkHostSuspend(), false);
});

test("a listener that throws does not keep the others from hearing of the sleep", () => {
  const { c, clocks } = fakeClocks();
  setSuspendClocks(clocks);
  const heard: number[] = [];
  const offs = [
    onHostSuspend(() => {
      throw new Error("boom");
    }),
    onHostSuspend((s) => heard.push(s.sleptSeconds)),
  ];
  try {
    c.wall += 120_000;
    assert.equal(checkHostSuspend(), true);
    assert.deepEqual(heard, [120]);
  } finally {
    for (const off of offs) off();
    setSuspendClocks(null);
  }
});

test("the stall watchdog does not kill an agent the moment the host wakes: its silence starts over", async () => {
  const { c, clocks } = fakeClocks();
  setSuspendClocks(clocks);
  try {
    // Silent for 1.6s, then a clean exit — past the 1s stall timeout, which a
    // sleep 0.4s in restarts: the watchdog's check at 1s sees the wake first.
    const quiet = [execPath, "-e", "setTimeout(() => process.stdout.write('woke'), 1600)"];
    const running = runCommand(quiet, { stallTimeout: 1, timeout: 20 });
    await new Promise((r) => setTimeout(r, 400));
    c.wall += 3600_000; // the lid was closed for an hour
    const r = await running;
    assert.equal(r.stalled, false, r.stderr);
    assert.equal(r.returncode, 0);
    assert.equal(r.stdout, "woke");

    // No sleep: the same silence is a stall.
    const stalled = await runCommand(quiet, { stallTimeout: 1, timeout: 20 });
    assert.equal(stalled.stalled, true);
  } finally {
    setSuspendClocks(null);
  }
});

test("a run says once that the host slept, in its events and the live view, and goes on", { skip: process.platform === "win32" ? "fake CLIs are shell scripts" : false }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "odw-host-suspend-")));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath ?? ""}`;
  const { c, clocks } = fakeClocks();
  setSuspendClocks(clocks);
  try {
    // The agent waits until the test has put the host to sleep and back.
    const woke = join(root, "woke");
    writeFileSync(
      join(bin, "sleepycli"),
      `#!/bin/sh\ncat > /dev/null\ni=0; while [ ! -f '${woke}' ] && [ $i -lt 250 ]; do sleep 0.02; i=$((i+1)); done\necho rested\n`,
    );
    chmodSync(join(bin, "sleepycli"), 0o755);
    const configPath = join(root, "odw.config.json");
    writeFileSync(configPath, JSON.stringify({ adapters: { sleepy: { command: ["sleepycli"], stdin: "{prompt}" } }, recordVersions: false }));
    const script = join(root, "wf.js");
    writeFileSync(script, "export const meta = { name: 'wf', description: 'd' }\nreturn await agent('x', { adapter: 'sleepy' })\n");
    const store = new RunStore(join(root, "runs"));
    const id = store.create({ script, args: null, source: root, configPath });
    const running = executeRun(store.runDir(id));
    for (let i = 0; i < 500 && !store.readEvents(id).some((e) => e.type === "agent_started"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    c.wall += 3600_000;
    assert.equal(checkHostSuspend(), true);
    assert.equal(checkHostSuspend(), false, "one sleep, one event");
    writeFileSync(woke, "");
    assert.equal(await running, "done");
    assert.equal(store.readResult(id), "rested");
    const slept = store.readEvents(id).filter((e) => e.type === "host_suspended");
    assert.equal(slept.length, 1);
    assert.equal(slept[0]!.sleptSeconds, 3600);
    assert.match(String(slept[0]!.message), /^the host was asleep for about 1h — every agent's stall timer starts over/);
    assert.match(formatEvent(slept[0]!), /host_suspended\s+the host was asleep for about 1h/);
  } finally {
    setSuspendClocks(null);
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  }
});
