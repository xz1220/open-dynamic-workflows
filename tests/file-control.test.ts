import { test } from "node:test";
import assert from "node:assert/strict";

import { RunStopped } from "../src/errors.js";
import { FileControl } from "../src/runtime/file-control.js";

test("checkpoint returns immediately when running", async () => {
  const fc = new FileControl({ readAction: () => null });
  await fc.checkpoint();
  assert.equal(fc.state(), "running");
});

test("checkpoint throws RunStopped on a stop request", async () => {
  const fc = new FileControl({ readAction: () => "stop" });
  await assert.rejects(() => fc.checkpoint(), RunStopped);
  assert.equal(fc.state(), "stopped");
});

test("checkpoint blocks while paused, then resumes when cleared", async () => {
  let action: string | null = "pause";
  const states: string[] = [];
  const fc = new FileControl({
    readAction: () => action,
    onState: (s) => states.push(s),
    pollIntervalMs: 5,
  });
  const pending = fc.checkpoint();
  setTimeout(() => {
    action = null;
  }, 25);
  await pending;
  assert.ok(states.includes("paused"), "should have reported paused");
  assert.equal(states[states.length - 1], "running");
});

test("watchStop polls while agents run and fires once when a stop arrives", async () => {
  let action: string | null = null;
  let reads = 0;
  const fc = new FileControl({
    readAction: () => {
      reads++;
      return action;
    },
    watchIntervalMs: 5,
  });
  let stops = 0;
  const unwatch = fc.watchStop(() => stops++);
  await new Promise<void>((r) => setTimeout(r, 30));
  assert.equal(stops, 0);
  assert.ok(reads > 1, "the control file is polled on an interval");
  action = "stop";
  await new Promise<void>((r) => setTimeout(r, 30));
  assert.equal(stops, 1, "fires exactly once");
  unwatch();

  const idle = new FileControl({ readAction: () => "stop", watchIntervalMs: 5 });
  let fired = false;
  idle.watchStop(() => (fired = true))(); // stop watching straight away
  await new Promise<void>((r) => setTimeout(r, 30));
  assert.equal(fired, false, "a disposed watcher no longer polls");
});

test("an aborted run ends a paused checkpoint with the abort reason", async () => {
  const fc = new FileControl({ readAction: () => "pause", pollIntervalMs: 10_000 });
  const controller = new AbortController();
  const pending = fc.checkpoint(controller.signal);
  const reason = new RunStopped("the workflow failed");
  setTimeout(() => controller.abort(reason), 10);
  await assert.rejects(pending, (err) => err === reason);
});
