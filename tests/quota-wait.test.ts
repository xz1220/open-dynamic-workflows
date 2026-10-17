import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectConfigWarnings, defaultConfig, loadConfig } from "../src/adapters/config.js";
import type { Settings } from "../src/adapters/types.js";
import { ConfigError } from "../src/errors.js";

// Pause for a spent quota (ODW extension: quotaWait): a call whose chain is out
// of quota waits for the reset its CLI named — holding no slot — and starts
// over. In the config, the run's pauses, the control, the scheduler, the bridge
// and agent(), on a test clock with a fake CLI; the run end to end — the
// worker, what readers show, the hooks — is in quota-wait-run.test.ts.

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
