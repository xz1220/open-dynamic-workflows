import { test } from "node:test";
import assert from "node:assert/strict";

import { defaultConfig } from "../src/adapters/config.js";
import { Bridge } from "../src/bridge.js";
import type { CliResult } from "../src/adapters/types.js";
import { BudgetExhausted, SchemaValidationError } from "../src/errors.js";
import { number, obj } from "../src/schema.js";

function cfg() {
  const c = defaultConfig();
  c.settings.defaultAdapter = "claude";
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

test("schema: a retry quotes the previous reply and its problems, and asks for a reformat", async () => {
  const prompts: string[] = [];
  const bridge = new Bridge(cfg(), {
    runner: async (_command, options) => {
      prompts.push(options?.stdin ?? "");
      return ok(prompts.length === 1 ? 'Here you go: {"x": "seven"}' : '{"x": 7}');
    },
  });
  const out = await bridge.run({ prompt: "p", schema: obj({ x: number() }) });
  assert.deepEqual(out.value, { x: 7 });
  const retry = prompts[1]!;
  assert.match(retry, /Here you go: \{"x": "seven"\}/, "the failed reply is quoted back");
  assert.match(retry, /\$\.x: expected number, got string/);
  assert.match(retry, /Reformat only: do not redo the work/);
});

test("schema: a long previous reply is quoted as head and tail", async () => {
  const prompts: string[] = [];
  const long = "A".repeat(3000) + "MIDDLE" + "B".repeat(3000);
  const bridge = new Bridge(cfg(), {
    runner: async (_command, options) => {
      prompts.push(options?.stdin ?? "");
      return ok(prompts.length === 1 ? long : '{"x": 1}');
    },
  });
  await bridge.run({ prompt: "p", schema: obj({ x: number() }) });
  const retry = prompts[1]!;
  assert.match(retry, /A{2000}\n\[… 2006 characters omitted …\]\nB{2000}/);
  assert.doesNotMatch(retry, /MIDDLE/);
  assert.ok(retry.length < prompts[0]!.length + 5000, "the retry prompt stays bounded");
});

test("schema: every attempt's reply is reported and each retry passes the guards first", async () => {
  const c = cfg();
  c.settings.schemaRetries = 2;
  const replies: string[] = [];
  let rechecks = 0;
  let calls = 0;
  const bridge = new Bridge(c, {
    runner: async () => ok(`not json ${++calls}`),
  });
  await assert.rejects(
    () =>
      bridge.run(
        { prompt: "p", schema: obj({ x: number() }) },
        { onReply: (text) => replies.push(text), beforeRetry: () => void rechecks++ },
      ),
    SchemaValidationError,
  );
  assert.deepEqual(replies, ["not json 1", "not json 2", "not json 3"]);
  assert.equal(rechecks, 2, "one guard check before each of the two retries");

  calls = 0;
  const refused = new BudgetExhausted("over budget");
  await assert.rejects(
    () =>
      bridge.run(
        { prompt: "p", schema: obj({ x: number() }) },
        {
          beforeRetry: () => {
            throw refused;
          },
        },
      ),
    (err) => err === refused,
  );
  assert.equal(calls, 1, "a refused retry starts no CLI");
});

test("schema validation and retries use decoded JSONL final text", async () => {
  const c = defaultConfig();
  c.settings.defaultAdapter = "opencode";
  c.settings.schemaRetries = 1;
  let attempts = 0;
  const bridge = new Bridge(c, {
    runner: async () => {
      attempts++;
      const text = attempts === 1 ? "not json" : "{\"x\": 9}";
      return ok(JSON.stringify({ type: "text", part: { type: "text", text } }));
    },
  });

  const out = await bridge.run({ prompt: "p", schema: obj({ x: number() }) });
  assert.deepEqual(out.value, { x: 9 });
  assert.equal(out.attempts, 2);
});
