import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/adapters/config.js";
import { ConfigError } from "../src/errors.js";
import { argumentsHash, LimitWatch, mergeLimits, readLimits, type AgentLimits } from "../src/limits.js";
import { BEHAVIOUR_SETTINGS } from "../src/provenance.js";

// Per-agent limits (an ODW extension): the watch on its own, fed the events
// each CLI prints, and the config that sets them.

const lines = (...events: unknown[]): string => events.map((e) => JSON.stringify(e)).join("\n") + "\n";

const claudeTool = (id: string, name: string, input: unknown, message = `m-${id}`, outputTokens?: number) => ({
  type: "assistant",
  message: {
    id: message,
    content: [{ type: "tool_use", id, name, input }],
    ...(outputTokens !== undefined ? { usage: { input_tokens: 10, output_tokens: outputTokens } } : {}),
  },
});

/** A watch on one JSONL run under `limits`; how often it asked to stop. */
function watching(limits: AgentLimits, jsonl = true) {
  const watch = new LimitWatch();
  let stops = 0;
  watch.startRun(limits, jsonl, () => stops++);
  return { watch, stops: () => stops };
}

test("the same tool call with the same arguments n times in a row trips repeat, naming it", () => {
  const { watch, stops } = watching({ repeat: 3 });
  watch.stdout(lines(claudeTool("a", "Bash", { command: "npm test" }), claudeTool("b", "Bash", { command: "npm test" })));
  assert.equal(watch.hit, null);
  watch.stdout(lines(claudeTool("c", "Bash", { command: "npm test" })));
  assert.deepEqual(watch.hit, { limit: "repeat", max: 3, value: 3, evidence: "Bash `npm test` ×3 in a row" });
  assert.equal(stops(), 1, "stopped once, at once");
  watch.stdout(lines(claudeTool("d", "Bash", { command: "npm test" })));
  assert.equal(stops(), 1, "nothing more after the hit");
});

test("repeat counts calls in a row: an edit between test runs resets the streak", () => {
  const { watch } = watching({ repeat: 3 });
  for (let i = 0; i < 5; i++) {
    watch.stdout(lines(claudeTool(`t${i}`, "Bash", { command: "npm test" }), claudeTool(`e${i}`, "Edit", { file_path: "a.ts", old_string: `${i}` })));
  }
  assert.equal(watch.hit, null, "npm test 5 times in 10 calls is a healthy edit–test cycle");
  // Same tool, other arguments: not a repeat either.
  for (let i = 0; i < 5; i++) watch.stdout(lines(claudeTool(`r${i}`, "Read", { file_path: `f${i}.ts` })));
  assert.equal(watch.hit, null);
});

test("arguments hash alike whatever their key order; a block seen twice counts once", () => {
  assert.equal(argumentsHash({ a: 1, b: [1, { c: 2, d: 3 }] }), argumentsHash({ b: [1, { d: 3, c: 2 }], a: 1 }));
  assert.notEqual(argumentsHash({ a: 1 }), argumentsHash({ a: 2 }));
  const { watch } = watching({ repeat: 2 });
  const event = claudeTool("same", "Grep", { pattern: "x", path: "src" });
  watch.stdout(lines(event, event));
  assert.equal(watch.hit, null, "one tool_use id is one call");
  watch.stdout(lines(claudeTool("other", "Grep", { path: "src", pattern: "x" })));
  assert.equal(watch.hit?.evidence, "Grep `x` ×2 in a row");
});

test("toolCalls counts over the call's runs, and an event split across chunks is read whole", () => {
  const watch = new LimitWatch();
  let stops = 0;
  watch.startRun({ toolCalls: 3 }, true, () => stops++);
  const text = lines(claudeTool("1", "Read", { file_path: "a" }), claudeTool("2", "Read", { file_path: "b" }));
  watch.stdout(text.slice(0, 17));
  watch.stdout(text.slice(17));
  assert.equal(watch.settle(undefined), null);
  // A schema retry: a fresh run of the same call goes on counting.
  watch.startRun({ toolCalls: 3 }, true, () => stops++);
  watch.stdout(lines(claudeTool("3", "Read", { file_path: "c" })));
  assert.equal(watch.hit, null);
  watch.stdout(lines(claudeTool("4", "Read", { file_path: "d" })).trimEnd()); // no newline yet
  assert.equal(watch.hit, null);
  watch.endRun(); // the last line, unterminated, is read when the run ends
  assert.deepEqual(watch.hit, { limit: "toolCalls", max: 3, value: 4, evidence: "4 tool calls > 3" });
});

test("Codex items: each tool once, however many events show it; turn usage counts", () => {
  const { watch } = watching({ toolCalls: 2, outputTokens: 500 });
  const cmd = (id: string, command: string) => ({ type: "item.started", item: { id, type: "command_execution", command, status: "in_progress" } });
  const done = (id: string, command: string) => ({ type: "item.completed", item: { id, type: "command_execution", command, exit_code: 0 } });
  watch.stdout(lines(cmd("item_0", "ls"), done("item_0", "ls"), { type: "item.completed", item: { id: "item_1", type: "file_change", changes: [{ path: "a", kind: "update" }] } }));
  assert.equal(watch.hit, null, "two calls: started and completed are one");
  watch.stdout(lines({ type: "turn.completed", usage: { input_tokens: 900, output_tokens: 501 } }));
  assert.equal(watch.hit?.limit, "outputTokens");
  assert.equal(watch.hit?.evidence, "501 output tokens > 500");
});

test("kilo/opencode: tool_use events count, and step_finish brings tokens and dollars as they go", () => {
  const { watch, stops } = watching({ costUsd: 0.05 });
  const tool = (id: string) => ({ type: "tool_use", part: { callID: id, tool: "bash", state: { status: "completed", input: { command: "ls" } } } });
  const step = (cost: number) => ({ type: "step_finish", part: { tokens: { input: 100, output: 20, reasoning: 5 }, cost } });
  watch.stdout(lines(tool("c1"), step(0.02), tool("c2"), step(0.02)));
  assert.equal(watch.hit, null);
  watch.stdout(lines(step(0.02)));
  assert.equal(watch.hit?.limit, "costUsd");
  assert.equal(watch.hit?.evidence, "$0.06 > $0.05");
  assert.equal(stops(), 1);
});

test("Claude: a message's usage counts once over its blocks, live", () => {
  const { watch } = watching({ outputTokens: 1000 });
  // Two blocks of one message, each with the message's usage so far.
  watch.stdout(lines(claudeTool("a", "Read", { file_path: "a" }, "msg1", 300), claudeTool("b", "Read", { file_path: "b" }, "msg1", 400)));
  watch.stdout(lines(claudeTool("c", "Read", { file_path: "c" }, "msg2", 500)));
  assert.equal(watch.hit, null, "400 + 500, not 300 + 400 + 500");
  watch.stdout(lines(claudeTool("d", "Read", { file_path: "d" }, "msg3", 200)));
  assert.equal(watch.hit?.evidence, "1,100 output tokens > 1,000");
});

test("Claude's cost comes with its result event: costUsd trips then, before the CLI exits", () => {
  const { watch } = watching({ costUsd: 1 });
  watch.stdout(lines(claudeTool("a", "Read", { file_path: "a" }, "m", 10)));
  assert.equal(watch.hit, null);
  watch.stdout(lines({ type: "result", subtype: "success", result: "done", total_cost_usd: 1.25, usage: { output_tokens: 99 } }));
  assert.deepEqual(watch.hit, { limit: "costUsd", max: 1, value: 1.25, evidence: "$1.25 > $1.00" });
});

test("a text CLI's spend is checked after the run, on what it reported or chars/4 of its reply", () => {
  const { watch, stops } = watching({ outputTokens: 100 }, false);
  watch.stdout(JSON.stringify(claudeTool("a", "Bash", { command: "x" })) + "\n"); // text: never parsed
  assert.equal(watch.settle(undefined, 80), null);
  watch.startRun({ outputTokens: 100 }, false, () => {});
  const hit = watch.settle(undefined, 30);
  assert.equal(hit?.limit, "outputTokens");
  assert.equal(hit?.evidence, "110 output tokens > 100 (estimated: chars/4 of its reply)");
  assert.equal(stops(), 0, "nothing was running to stop");
  const reported = new LimitWatch();
  reported.startRun({ costUsd: 0.5 }, false, () => {});
  assert.equal(reported.settle({ outputTokens: 10, costUsd: 0.75 })?.evidence, "$0.75 > $0.50");
});

test("seconds: a run is stopped once the call has run that long, and a later run at once", async () => {
  const watch = new LimitWatch();
  let stopped = false;
  watch.startRun({ seconds: 0.05 }, false, () => (stopped = true));
  const deadline = Date.now() + 2000;
  while (!stopped && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(stopped, "the timer stopped the run");
  assert.equal(watch.hit?.limit, "seconds");
  assert.match(watch.hit!.evidence, /^running \d+s > 0\.05s$/);
  let again = false;
  watch.startRun({ seconds: 0.05 }, false, () => (again = true));
  assert.ok(again, "a further run of a call past its limit is stopped before it starts");
});

test("limits are read strictly, and layered key by key — null lifts one", () => {
  const fail = (m: string) => new ConfigError(m);
  assert.deepEqual(readLimits({ toolCalls: 40, costUsd: 2.5, outputTokens: 10000, seconds: 600, repeat: 5 }, "x", fail), {
    toolCalls: 40,
    costUsd: 2.5,
    outputTokens: 10000,
    seconds: 600,
    repeat: 5,
  });
  assert.throws(() => readLimits({ toolcalls: 3 }, "agentLimits", fail), /agentLimits has no limit "toolcalls"; use toolCalls, costUsd/);
  assert.throws(() => readLimits({ repeat: 1 }, "agentLimits", fail), /agentLimits\.repeat must be a whole number, 2 or more/);
  assert.throws(() => readLimits({ toolCalls: 2.5 }, "x", fail), /x\.toolCalls must be a whole number/);
  assert.throws(() => readLimits({ costUsd: 0 }, "x", fail), /x\.costUsd must be a positive number of dollars/);
  assert.throws(() => readLimits({ seconds: "60" }, "x", fail), /x\.seconds must be a positive number/);
  assert.throws(() => readLimits([], "x", fail), /x must be an object of limits/);
  assert.deepEqual(mergeLimits({ toolCalls: 40, repeat: 5 }, { repeat: 3 }, { toolCalls: null, seconds: 60 }), { repeat: 3, seconds: 60 });
  assert.deepEqual(mergeLimits(undefined, {}, undefined), {});
});

test("agentLimits in the config: run-wide, per adapter, validated, and part of a run's recorded setup", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-limits-cfg-"));
  try {
    const p = join(dir, "odw.config.json");
    writeFileSync(
      p,
      JSON.stringify({ agentLimits: { toolCalls: 100, repeat: 4 }, adapters: { codex: { agentLimits: { repeat: null, seconds: 900 } } } }),
    );
    const config = loadConfig(p, { quiet: true });
    assert.deepEqual(config.settings.agentLimits, { toolCalls: 100, repeat: 4 });
    assert.deepEqual(config.adapters.codex!.agentLimits, { repeat: null, seconds: 900 });
    assert.equal(config.adapters.codex!.command[0], "codex", "the built-in keeps its command");
    assert.ok((BEHAVIOUR_SETTINGS as readonly string[]).includes("agentLimits"));

    writeFileSync(p, JSON.stringify({ agentLimits: { loops: 3 } }));
    assert.throws(() => loadConfig(p, { quiet: true }), /"agentLimits" has no limit "loops"/);
    writeFileSync(p, JSON.stringify({ adapters: { claude: { agentLimits: { costUsd: -1 } } } }));
    assert.throws(() => loadConfig(p, { quiet: true }), /adapter 'claude' 'agentLimits'\.costUsd must be a positive number of dollars/);
    writeFileSync(p, JSON.stringify({}));
    assert.deepEqual(loadConfig(p, { quiet: true }).settings.agentLimits, {}, "none by default");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
