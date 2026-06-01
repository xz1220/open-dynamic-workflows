import { test } from "node:test";
import assert from "node:assert/strict";

import { defaultConfig } from "../src/adapters/config.js";
import { Bridge } from "../src/bridge.js";
import type { CliResult } from "../src/adapters/types.js";
import { SchemaValidationError } from "../src/errors.js";
import { number, obj } from "../src/schema.js";

function cfg() {
  const c = defaultConfig();
  c.settings.defaultAdapter = "claude";
  c.settings.workspaceMode = "inplace";
  return c;
}
const ok = (stdout: string): CliResult => ({ returncode: 0, stdout, stderr: "", timedOut: false, duration: 0 });

test("schema: dirty output is retried, then valid JSON is accepted", async () => {
  const c = cfg();
  c.settings.schemaRetries = 2;
  let n = 0;
  const bridge = new Bridge(c, {
    runner: async () => {
      n++;
      return ok(n === 1 ? "no json yet" : '{"x": 7}');
    },
  });
  const out = await bridge.run({ prompt: "p", schema: obj({ x: number() }) });
  assert.deepEqual(out.value, { x: 7 });
  assert.equal(out.attempts, 2);
});

test("schema: exhausting the retry budget throws SchemaValidationError", async () => {
  const c = cfg();
  c.settings.schemaRetries = 1;
  const bridge = new Bridge(c, { runner: async () => ok("never valid json") });
  await assert.rejects(
    () => bridge.run({ prompt: "p", schema: obj({ x: number() }) }),
    SchemaValidationError,
  );
});

test("schema: a fenced JSON reply is parsed and returned as an object", async () => {
  const bridge = new Bridge(cfg(), { runner: async () => ok('```json\n{"x": 1}\n```') });
  const out = await bridge.run({ prompt: "p", schema: obj({ x: number() }) });
  assert.deepEqual(out.value, { x: 1 });
});
