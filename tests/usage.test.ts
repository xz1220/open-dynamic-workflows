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

/** Run the CLI with stdout/stderr captured. */
async function cli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  (process.stdout as { write: unknown }).write = (s: unknown) => {
    out.push(String(s));
    return true;
  };
  (process.stderr as { write: unknown }).write = (s: unknown) => {
    err.push(String(s));
    return true;
  };
  try {
    const code = await main(argv);
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
  }
}

function storedRun(events: Array<Record<string, unknown>>) {
  const root = mkdtempSync(join(tmpdir(), "odw-usage-"));
  const store = new RunStore(root);
  const id = store.create({ script: "/tmp/never-read/wf.js", args: null, source: root, workflowName: "spend" });
  store.updateStatus(id, { state: "done", name: "spend" });
  for (const ev of events) appendFileSync(store.eventsPath(id), JSON.stringify(ev) + "\n");
  return { root, store, id };
}

test("odw status prints what the run spent — tokens in, cache, out, cost — and says what is estimated", async () => {
  const mixed = storedRun(RUN_EVENTS);
  const estimatedOnly = storedRun(RUN_EVENTS.slice(0, 5).concat([RUN_EVENTS[6]!]));
  const legacy = storedRun(RUN_EVENTS.map(({ usage: _usage, ...rest }: Record<string, unknown>) => rest));
  try {
    const r = await cli(["status", mixed.id, "--runs-root", mixed.root]);
    assert.equal(r.code, 0);
    assert.match(
      r.out,
      /^ {2}usage: 1\.0k tokens in \(900 cache read\) · ~140 out · \$0\.251 \(estimated in part: 1 of 3 agents reported no output tokens\)$/m,
    );
    const e = await cli(["status", estimatedOnly.id, "--runs-root", estimatedOnly.root]);
    assert.match(e.out, /^ {2}usage: ~100 tokens out \(estimated: chars\/4 of the replies — the adapter reports no usage\)$/m);
    const l = await cli(["status", legacy.id, "--runs-root", legacy.root]);
    assert.equal(l.code, 0);
    assert.doesNotMatch(l.out, /usage:/, "an older run says nothing it does not know");
  } finally {
    for (const run of [mixed, estimatedOnly, legacy]) rmSync(run.root, { recursive: true, force: true });
  }
});

// --- the live view -------------------------------------------------------------------

async function waitUntil(check: () => boolean, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

test("the live view's summary line shows output tokens and the running cost; a settled agent its own cost", async () => {
  const { root, store, id } = storedRun(RUN_EVENTS.slice(0, 3).concat([RUN_EVENTS[5]!]));
  store.updateStatus(id, { state: "running", pid: process.pid });
  const term = new FakeTerm(120);
  const out = { chunks: [] as string[], isTTY: false, write(s: string) { this.chunks.push(s); } };
  try {
    const done = attachRun(store, id, {
      out,
      err: term,
      live: true,
      pollMs: 10,
      signals: false,
      env: { TERM: "xterm", LANG: "en_US.UTF-8" },
    });
    assert.ok(await waitUntil(() => /1 running · 1 done · 40 tok · \$0\.250/.test(term.raw)), "the footer shows the spend so far");
    assert.match(term.text(), /✔ a\s+.*claude.*\$0\.250/, "the settled agent's line carries its cost");
    appendFileSync(store.eventsPath(id), JSON.stringify(RUN_EVENTS[6]) + "\n" + JSON.stringify(RUN_EVENTS[9]) + "\n");
    store.writeResult(id, "ok");
    store.updateStatus(id, { state: "done" });
    assert.equal(await done, 0);
    assert.match(term.text(), /✔ done\s+2 agents · ~140 tok · \$0\.250 · /);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- end to end: the worker, a stream-json CLI, the server ------------------------------

/**
 * A mock Claude Code printing stream-json: an init event, an assistant turn,
 * then a result with usage and cost. Its first run on "task 2" is an exit-0
 * `is_error` rate limit, as Claude Code prints one.
 */
function mockClaude(dir: string): string[] {
  const marker = JSON.stringify(join(dir, "limited-once"));
  return [
    execPath,
    "-e",
    `const fs = require('fs'); let prompt = '';
process.stdin.on('data', (c) => (prompt += c)).on('end', () => {
  const emit = (e) => process.stdout.write(JSON.stringify(e) + '\\n');
  emit({ type: 'system', subtype: 'init', session_id: 's', model: 'mock' });
  const task = (prompt.match(/task (\\d+)/) || [])[1];
  if (task === '2') {
    try {
      fs.writeFileSync(${marker}, '', { flag: 'wx' });
      emit({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: Rate limit reached. Please retry after 0.05s', total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } });
      return;
    } catch {}
  }
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }], usage: { input_tokens: 10, output_tokens: 5 } } });
  emit({ type: 'result', subtype: 'success', is_error: false, result: 'answer ' + task, total_cost_usd: 0.01, usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 0, output_tokens: 20 } });
});`,
  ];
}

test("end to end: a stream-json CLI's usage and cost reach the events, status, odw status and /api/runs", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-usage-e2e-"));
  const configPath = join(root, "odw.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      defaultAdapter: "mockclaude",
      fanOutWarn: 2,
      adapters: {
        mockclaude: { command: mockClaude(root), stdin: "{prompt}", output: defaultConfig().adapters.claude!.output },
        plain: { command: [execPath, "-e", "process.stdout.write('x'.repeat(40))"] },
      },
    }),
  );
  const script = join(root, "wf.js");
  writeFileSync(
    script,
    "export const meta = { name: 'spend', description: 'd' }\n" +
      "const answers = await parallel([1, 2, 3].map((n) => () => agent('task ' + n, { label: 'c' + n })))\n" +
      "const summary = await agent('summarize', { adapter: 'plain', label: 'sum' })\n" +
      "return { answers, summary, spent: budget.spent() }\n",
  );
  const store = new RunStore(join(root, "runs"));
  const id = store.create({ script, args: null, source: root, configPath });
  const handle = await startServer({ store, port: 0, host: "127.0.0.1", claudeProjectsRoot: join(root, "no-claude") });
  try {
    assert.equal(await executeRun(store.runDir(id)), "done");
    const each = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 90, cacheWriteTokens: 0, costUsd: 0.01 };
    assert.deepEqual(store.readResult(id), {
      answers: ["answer 1", "answer 2", "answer 3"],
      summary: "x".repeat(40),
      spent: 3 * 20 + 10,
    });

    const events = store.readEvents(id);
    const finished = new Map(events.filter((e) => e.type === "agent_finished").map((e) => [e.label, e.usage]));
    assert.deepEqual(finished.get("c1"), each);
    assert.deepEqual(finished.get("c2"), each, "the rate-limited run spent nothing on top");
    assert.deepEqual(finished.get("sum"), { outputTokens: 10, estimated: true });
    const logs = events.filter((e) => e.type === "log").map((e) => String(e.message));
    assert.ok(logs.some((m) => /^c2:2 hit a rate limit on mockclaude — retrying in /.test(m)), "the is_error result was ridden out");
    assert.ok(logs.some((m) => /^large fan-out: parallel\(\) starts 3 tasks \(over fanOutWarn: 2\)/.test(m)));
    assert.equal(store.readStatus(id).spentTokens, 70, "status.json's tally counts real tokens");

    const total = { inputTokens: 300, outputTokens: 70, cacheReadTokens: 270, cacheWriteTokens: 0, costUsd: 0.03, estimated: true };
    assert.deepEqual(detail(store, id).usage, total);
    const status = await cli(["status", id, "--runs-root", join(root, "runs")]);
    assert.match(status.out, /usage: 300 tokens in \(270 cache read\) · ~70 out · \$0\.030 \(estimated in part: 1 of 4 agents/);

    const list = (await fetch(`${handle.url}/api/runs`).then((r) => r.json())) as Array<{ runId: string; usage: unknown }>;
    assert.deepEqual(list.find((r) => r.runId === id)?.usage, total);
    const api = (await fetch(`${handle.url}/api/runs/${id}`).then((r) => r.json())) as {
      usage: unknown;
      agents: Array<{ label: string; usage?: unknown }>;
    };
    assert.deepEqual(api.usage, total);
    assert.deepEqual(api.agents.find((a) => a.label === "c3")?.usage, each);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});
