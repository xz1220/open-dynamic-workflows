import { test } from "node:test";
import assert from "node:assert/strict";

import { defaultConfig } from "../src/adapters/config.js";
import { Bridge } from "../src/bridge.js";
import type { CliResult } from "../src/adapters/types.js";
import { AdapterExecutionError } from "../src/errors.js";

function ok(stdout: string): CliResult {
  return { returncode: 0, stdout, stderr: "", timedOut: false, duration: 0.01 };
}

function inplaceConfig() {
  const cfg = defaultConfig();
  cfg.settings.defaultAdapter = "claude";
  cfg.settings.workspaceMode = "inplace";
  return cfg;
}

test("a no-schema agent call returns trimmed reply text", async () => {
  const bridge = new Bridge(inplaceConfig(), { runner: async () => ok("  the answer  ") });
  const out = await bridge.run({ prompt: "hi" });
  assert.equal(out.value, "the answer");
  assert.equal(out.text, "the answer");
  assert.equal(out.adapter, "claude");
  assert.equal(out.attempts, 1);
});

test("the prompt is wrapped with the independence preamble", async () => {
  let stdin = "";
  const bridge = new Bridge(inplaceConfig(), {
    runner: async (_command, options) => {
      stdin = options?.stdin ?? "";
      return ok("ok");
    },
  });
  await bridge.run({ prompt: "do the thing" });
  assert.match(stdin, /automated multi-agent workflow/);
  assert.match(stdin, /do the thing/);
});

test("a failing CLI surfaces as AdapterExecutionError", async () => {
  const bridge = new Bridge(inplaceConfig(), {
    runner: async () => ({ returncode: 1, stdout: "", stderr: "boom", timedOut: false, duration: 0 }),
  });
  await assert.rejects(() => bridge.run({ prompt: "x" }), AdapterExecutionError);
});

test("the chosen adapter can be overridden per call", async () => {
  const bridge = new Bridge(inplaceConfig(), { runner: async () => ok("hi") });
  const out = await bridge.run({ prompt: "x", adapter: "codex" });
  assert.equal(out.adapter, "codex");
});
