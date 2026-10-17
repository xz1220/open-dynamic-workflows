import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectConfigWarnings, defaultConfig, loadConfig } from "../src/adapters/config.js";
import { buildContext } from "../src/context.js";
import { LOG, MemorySink } from "../src/events.js";
import { createPrimitives } from "../src/primitives.js";

// The large fan-out warning (ODW extension): one parallel() or pipeline() call
// wider than `fanOutWarn` logs one warning with the count, and never blocks.

test("a parallel() or pipeline() wider than fanOutWarn logs one warning with the count, and still runs", async () => {
  const config = defaultConfig();
  const sink = new MemorySink();
  const ctx = buildContext(config, { sink });
  const primitives = createPrimitives(ctx);
  const thunks = (n: number) => Array.from({ length: n }, (_, i) => () => i);
  assert.equal(config.settings.fanOutWarn, 25);
  assert.equal((await primitives.parallel(thunks(25))).length, 25);
  assert.deepEqual(sink.ofType(LOG), [], "25 is not more than 25");
  assert.equal((await primitives.parallel(thunks(26))).length, 26, "a warning never blocks");
  await primitives.pipeline(
    Array.from({ length: 30 }, (_, i) => i),
    (v) => v,
    (v) => v,
  );
  const logs = sink.ofType(LOG);
  assert.deepEqual(
    logs.map((e) => e.fanOut),
    [26, 30],
  );
  assert.equal(
    logs[0]!.message,
    "large fan-out: parallel() starts 26 tasks (over fanOutWarn: 25) — each agent spends tokens; " +
      "odw status shows what the run has spent, odw run --budget caps it",
  );
  assert.match(String(logs[1]!.message), /^large fan-out: pipeline\(\) starts 30 items through 2 stages \(over fanOutWarn: 25\)/);

  config.settings.fanOutWarn = null;
  await primitives.parallel(thunks(100));
  config.settings.fanOutWarn = 3;
  await primitives.parallel(thunks(4));
  assert.deepEqual(
    sink.ofType(LOG).map((e) => e.fanOut),
    [26, 30, 4],
    "null turns it off; any limit can be set",
  );
});

/** Load a config file holding `raw`. */
function loadRaw(raw: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "odw-fan-out-"));
  try {
    const path = join(dir, "odw.config.json");
    writeFileSync(path, JSON.stringify(raw));
    return loadConfig(path, { quiet: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("fanOutWarn defaults to 25; 0 or null turns it off; anything else must be a whole number", () => {
  assert.equal(loadRaw({}).settings.fanOutWarn, 25);
  assert.equal(loadRaw({ fanOutWarn: 40 }).settings.fanOutWarn, 40);
  assert.equal(loadRaw({ fanOutWarn: 0 }).settings.fanOutWarn, null);
  assert.equal(loadRaw({ fanOutWarn: null }).settings.fanOutWarn, null);
  for (const bad of [-1, 2.5, "lots"]) {
    assert.throws(() => loadRaw({ fanOutWarn: bad }), /"fanOutWarn" must be a positive integer, or 0\/null to never warn/);
  }
  assert.deepEqual(collectConfigWarnings({ fanOutWarn: 10 }), []);
});
