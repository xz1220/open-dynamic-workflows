import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";

import { defaultConfig } from "../src/adapters/config.js";
import type { CommandRunner } from "../src/adapters/runner.js";
import type { CliResult } from "../src/adapters/types.js";
import { Bridge } from "../src/bridge.js";
import { main } from "../src/cli.js";
import { buildContext } from "../src/context.js";
import { AdapterExecutionError, BudgetExhausted } from "../src/errors.js";
import { AGENT_FAILED, AGENT_FINISHED, MemorySink } from "../src/events.js";
import { createPrimitives } from "../src/primitives.js";
import { attachRun } from "../src/runtime/live-view.js";
import { RunStore } from "../src/runtime/run-store.js";
import { detail, detailFrom, EventFold, summaryFrom } from "../src/runtime/runs-view.js";
import { startServer } from "../src/runtime/server.js";
import { executeRun } from "../src/runtime/worker.js";
import { number, obj } from "../src/schema.js";
import { FakeTerm } from "./fake-term.js";

// Real usage and cost per agent (ODW extension): what the CLI reports reaches
// agent_finished/agent_failed, the budget, the read model, `odw status`, the
// live view and /api/runs.

const ok = (stdout: string): CliResult => ({ returncode: 0, stdout, stderr: "", timedOut: false, duration: 0.1 });

/** What `claude --print --output-format stream-json --verbose` prints: an init event, then the result event. */
function streamJson(result: Record<string, unknown>): CliResult {
  const events = [
    { type: "system", subtype: "init", session_id: "s1", model: "claude-sonnet-4-5" },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 1,
      session_id: "s1",
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      ...result,
    },
  ];
  return ok(events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

/** A run context (built as a run builds it) whose bridge runs `runner`, on the built-in adapters. */
function usageContext(runner: CommandRunner, options: { budgetTotal?: number } = {}) {
  const config = defaultConfig();
  config.settings.defaultAdapter = "claude";
  const sink = new MemorySink();
  const ctx = buildContext(config, { sink, budgetTotal: options.budgetTotal ?? null });
  ctx.bridge = new Bridge(config, { runner, sleep: async () => {}, random: () => 0 });
  return { ctx, sink, primitives: createPrimitives(ctx) };
}

// --- agent events and the budget ---------------------------------------------------

test("agent_finished carries the usage its CLI reported, or an estimate marked as one", async () => {
  const { primitives, sink } = usageContext(async (command) =>
    command[0] === "claude"
      ? streamJson({
          result: "from claude",
          total_cost_usd: 0.25,
          usage: { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 40 },
        })
      : ok("x".repeat(400)),
  );
  assert.equal(await primitives.agent("one"), "from claude");
  assert.equal(await primitives.agent("two", { adapter: "codex" }), "x".repeat(400));
  const [claude, codex] = sink.ofType(AGENT_FINISHED);
  assert.deepEqual(claude!.usage, { inputTokens: 1000, outputTokens: 40, cacheReadTokens: 900, costUsd: 0.25 });
  assert.deepEqual(codex!.usage, { outputTokens: 100, estimated: true }, "a text CLI's reply: chars/4");
  assert.equal(primitives.budget.spent(), 40 + 100, "real output tokens where reported, the estimate elsewhere");
});

test("every attempt's usage adds up, and a failed agent still reports what it spent", async () => {
  const replies = [
    streamJson({ result: "not json", total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 30 } }),
    streamJson({ result: '{"n": 1}', total_cost_usd: 0.02, usage: { input_tokens: 20, output_tokens: 10 } }),
    streamJson({ is_error: true, result: "Credit balance is too low", total_cost_usd: 0.001, usage: { input_tokens: 5, output_tokens: 0 } }),
  ];
  const { primitives, sink } = usageContext(async () => replies.shift()!);
  assert.deepEqual(await primitives.agent("p", { schema: obj({ n: number() }) }), { n: 1 });
  await assert.rejects(() => primitives.agent("q"), AdapterExecutionError);
  assert.deepEqual(sink.ofType(AGENT_FINISHED)[0]!.usage, { inputTokens: 30, outputTokens: 40, costUsd: 0.03 }, "both schema attempts");
  const failed = sink.ofType(AGENT_FAILED)[0]!;
  assert.equal(failed.reason, "quota");
  assert.deepEqual(failed.usage, { inputTokens: 5, outputTokens: 0, costUsd: 0.001 });
  assert.equal(primitives.budget.spent(), 40);
});

test("the budget ceiling counts reported output tokens, not chars/4 of a long reply", async () => {
  const long = "word ".repeat(2000); // 10,000 characters: 2,500 tokens, were they estimated
  const replies = [1, 2, 3].map(() => streamJson({ result: long, usage: { output_tokens: 30 } }));
  const { primitives, ctx } = usageContext(async () => replies.shift()!, { budgetTotal: 50 });
  await primitives.agent("a"); // 30 spent: under the ceiling
  await primitives.agent("b"); // still allowed to start; 60 spent
  await assert.rejects(() => primitives.agent("c"), BudgetExhausted);
  assert.equal(replies.length, 1, "the third agent never ran");
  assert.equal(primitives.budget.spent(), 60);
  assert.match(String(ctx.scheduler.fatalError), /budget ceiling of 50 output tokens \(spent 60\)/);
});

test("a run whose CLI reports no output tokens falls back to chars/4 for that run alone", async () => {
  const replies = [
    streamJson({ result: "x".repeat(40), total_cost_usd: 0.5, usage: {} }), // cost, but no token counts
    streamJson({ result: "y", usage: { output_tokens: 7 } }),
  ];
  const { primitives, sink } = usageContext(async () => replies.shift()!);
  await primitives.agent("a");
  await primitives.agent("b");
  const [a, b] = sink.ofType(AGENT_FINISHED);
  assert.deepEqual(a!.usage, { outputTokens: 10, costUsd: 0.5, estimated: true });
  assert.deepEqual(b!.usage, { outputTokens: 7, costUsd: 0 });
  assert.equal(primitives.budget.spent(), 17);
});

// --- the read model ------------------------------------------------------------------

const RUN_EVENTS = [
  { ts: 1, type: "run_started", runId: "r1" },
  { ts: 1, type: "agent_started", agentId: 1, label: "a", phase: null, adapter: "claude" },
  { ts: 1, type: "agent_started", agentId: 2, label: "b", phase: null, adapter: "codex" },
  { ts: 1, type: "agent_started", agentId: 3, label: "c", phase: null, adapter: "claude" },
  { ts: 1, type: "agent_started", agentId: 4, label: "d", phase: null, adapter: "claude", cached: true },
  {
    ts: 2,
    type: "agent_finished",
    agentId: 1,
    label: "a",
    phase: null,
    adapter: "claude",
    attempts: 1,
    usage: { inputTokens: 1000, outputTokens: 40, cacheReadTokens: 900, costUsd: 0.25 },
  },
  { ts: 3, type: "agent_finished", agentId: 2, label: "b", phase: null, adapter: "codex", attempts: 1, usage: { outputTokens: 100, estimated: true } },
  {
    ts: 4,
    type: "agent_failed",
    agentId: 3,
    label: "c",
    phase: null,
    error: "AdapterExecutionError: adapter 'claude' ran out of usage quota",
    reason: "quota",
    usage: { inputTokens: 5, outputTokens: 0, costUsd: 0.001 },
  },
  // A replayed result (odw resume) spent nothing in this run.
  { ts: 5, type: "agent_finished", agentId: 4, label: "d", phase: null, adapter: "claude", attempts: 1, cached: true },
  { ts: 6, type: "run_finished", runId: "r1" },
];

const TOTAL = { inputTokens: 1005, outputTokens: 140, cacheReadTokens: 900, costUsd: 0.251, estimated: true };

test("the read model gives each agent its usage and the run a total, estimated when any agent's is", () => {
  const fold = new EventFold().apply(RUN_EVENTS);
  const facts = { status: { state: "done" }, meta: {}, fold };
  const summary = summaryFrom("r1", facts);
  assert.deepEqual(summary.usage, TOTAL);
  const run = detailFrom("r1", facts, { hasResult: false, error: null });
  assert.deepEqual(run.usage, TOTAL);
  assert.deepEqual(
    run.agents.map((a) => a.usage),
    [
      { inputTokens: 1000, outputTokens: 40, cacheReadTokens: 900, costUsd: 0.25 },
      { outputTokens: 100, estimated: true },
      { inputTokens: 5, outputTokens: 0, costUsd: 0.001 },
      undefined,
    ],
  );

  // Folds are cached: what a reader gets is a copy.
  summary.usage!.costUsd = 99;
  run.agents[0]!.usage!.costUsd = 99;
  assert.equal(summaryFrom("r1", facts).usage!.costUsd, 0.251);
  assert.equal(detailFrom("r1", facts, { hasResult: false, error: null }).agents[0]!.usage!.costUsd, 0.25);

  // Events from before usage was recorded: no total, nothing invented.
  const legacy = RUN_EVENTS.map(({ usage: _usage, ...rest }: Record<string, unknown>) => rest) as typeof RUN_EVENTS;
  assert.equal(summaryFrom("r0", { status: { state: "done" }, meta: {}, fold: new EventFold().apply(legacy) }).usage, null);
  // A malformed usage field is no usage.
  const junk = new EventFold().apply([
    RUN_EVENTS[1]!,
    { ...RUN_EVENTS[5]!, usage: { inputTokens: "1000", outputTokens: -1 } },
  ]);
  assert.equal(junk.agents[0]!.usage, undefined);
  assert.equal(junk.usage, undefined);
});
