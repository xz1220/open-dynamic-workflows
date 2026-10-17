import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectConfigWarnings, defaultConfig, loadConfig } from "../src/adapters/config.js";
import type { Settings } from "../src/adapters/types.js";
import { ConfigError, RunStopped } from "../src/errors.js";
import { Scheduler } from "../src/scheduler.js";

// Pause for a spent quota (ODW extension: quotaWait): a call whose chain is out
// of quota waits for the reset its CLI named — holding no slot — and starts
// over. In the config, the run's pauses, the control, the scheduler, the bridge
// and agent(), on a test clock with a fake CLI; the run end to end — the
// worker, what readers show, the hooks — is in quota-wait-run.test.ts.

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition did not become true in time");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

const settle = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 20));

// --- config -------------------------------------------------------------------------------

test("config: quotaWait is off unless set — { max } turns it on — and anything else is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-quota-config-"));
  const load = (raw: unknown): Settings["quotaWait"] => {
    const path = join(dir, "odw.config.json");
    writeFileSync(path, JSON.stringify(raw));
    return loadConfig(path, { quiet: true }).settings.quotaWait;
  };
  try {
    assert.equal(defaultConfig().settings.quotaWait, false);
    for (const raw of [{}, { quotaWait: false }, { quotaWait: null }]) assert.equal(load(raw), false, JSON.stringify(raw));
    assert.deepEqual(load({ quotaWait: { max: 21600 } }), { max: 21600 });
    assert.deepEqual(load({ quotaWait: { max: "3600" } }), { max: 3600 }, "a numeric string, like every number setting");
    const refused: Array<[unknown, RegExp]> = [
      [true, /^"quotaWait" must be false, or \{ "max": <seconds> \}: the longest a run waits for a spent quota to reset; got true$/],
      [{}, /^"quotaWait" must be false, or \{ "max": <seconds> \}/],
      [3600, /^"quotaWait" must be false/],
      [{ max: 0 }, /^"quotaWait\.max" must be a positive number of seconds; got 0$/],
      [{ max: -60 }, /^"quotaWait\.max" must be a positive number of seconds/],
      [{ max: "6h" }, /^"quotaWait\.max" must be a positive number of seconds; got "6h"$/],
    ];
    for (const [quotaWait, error] of refused) {
      assert.throws(() => load({ quotaWait }), (err: Error) => err instanceof ConfigError && error.test(err.message), JSON.stringify(quotaWait));
    }
    assert.deepEqual(collectConfigWarnings({ quotaWait: { max: 60 } }), [], "a known key");
    assert.deepEqual(collectConfigWarnings({ quotaWait: { max: 60, maxx: 1 } }), [
      'quotaWait: unknown field "maxx" is ignored — did you mean "max"?',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the scheduler --------------------------------------------------------------------------

test("AgentSlot.release lets another agent have both slots; moveTo takes a pair back, ahead of agents not started", async () => {
  const s = new Scheduler({ concurrency: 1, maxAgents: 10, adapterConcurrency: { a: 1 } });
  const order: string[] = [];
  const gates = new Map<string, () => void>();
  const hold = (name: string) => new Promise<void>((resolve) => gates.set(name, resolve));
  const x = s.runAgent(async (_signal, slot) => {
    order.push("x");
    slot.release();
    slot.release(); // a second time changes nothing
    await hold("x");
    await slot.moveTo("a");
    order.push("x again");
  }, { adapter: "a" });
  const y = s.runAgent(async () => {
    order.push("y");
    await hold("y");
  }, { adapter: "a" });
  await until(() => order.length === 2);
  assert.deepEqual(order, ["x", "y"], "y has the run's only slot, and a's, while x waits");
  const z = s.runAgent(async () => void order.push("z"), { adapter: "b" });
  gates.get("x")!();
  await settle();
  gates.get("y")!();
  await Promise.all([x, y, z]);
  assert.deepEqual(order, ["x", "y", "x again", "z"], "x takes the pair back before z, which had not started");
  assert.equal(s.dispatched, 3, "taking the slots back is no dispatch");
  assert.equal(await s.drain(100), true);
});

test("a stop reaches a request held at its gate: the stop watch is armed while it waits", async () => {
  let onStop!: () => void;
  let watching = 0;
  const s = new Scheduler({
    concurrency: 1,
    maxAgents: 10,
    watchStop: (stop) => {
      onStop = stop;
      watching++;
      return () => void watching--;
    },
  });
  let ran = false;
  const held = s.runAgent(
    async () => {
      ran = true;
    },
    { gate: (signal) => new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })) },
  );
  await until(() => watching === 1);
  onStop();
  await assert.rejects(held, RunStopped);
  assert.deepEqual([ran, watching, s.dispatched], [false, 0, 0]);
});
