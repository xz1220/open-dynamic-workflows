import { test } from "node:test";
import assert from "node:assert/strict";

import { defaultConfig, resolveAdapter } from "../src/adapters/config.js";
import type { CommandRunner } from "../src/adapters/runner.js";
import { Bridge } from "../src/bridge.js";
import { spentTokens, type RunContext } from "../src/context.js";
import { MemoryControl, NullControl } from "../src/control.js";
import { AdapterNotFound, BudgetExhausted, ConfigError, RunStopped, WorkflowScriptError } from "../src/errors.js";
import { AGENT_FAILED, AGENT_FINISHED, AGENT_STARTED, LOG, MemorySink } from "../src/events.js";
import { createPrimitives } from "../src/primitives.js";
import { Scheduler } from "../src/scheduler.js";
import { number, obj } from "../src/schema.js";

function fakeContext(
  run: (req: { prompt: string }) => Promise<unknown>,
  options: { concurrency?: number } = {},
): {
  ctx: RunContext;
  sink: MemorySink;
} {
  const sink = new MemorySink();
  const config = defaultConfig();
  config.settings.defaultAdapter = "claude";
  // Where a call starts is a real bridge's decision; the fake only runs it.
  const routing = new Bridge(config);
  const ctx: RunContext = {
    config,
    bridge: {
      run,
      adapterFor: (name?: string | null) => resolveAdapter(config, name),
      route: routing.route.bind(routing),
    } as unknown as Bridge,
    scheduler: new Scheduler({ concurrency: options.concurrency ?? 4, maxAgents: 1000 }),
    control: new NullControl(),
    sink,
    args: null,
    source: process.cwd(),
    budgetTotal: null,
    usage: { outputChars: 0, outputTokens: 0 },
    seq: { value: 0 },
    currentPhase: null,
    emit(ev) {
      sink.emit(ev);
    },
  };
  return { ctx, sink };
}

const outcome = (value: unknown) => ({
  value,
  text: String(value),
  adapter: "claude",
  attempts: 1,
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitUntil(fn: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error("condition did not become true");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

test("agent returns the bridge outcome value and emits a finished event", async () => {
  const { ctx, sink } = fakeContext(async (req) => outcome(`R:${req.prompt}`));
  const p = createPrimitives(ctx);
  const r = await p.agent("hi");
  assert.equal(r, "R:hi");
  assert.equal(sink.ofType(AGENT_FINISHED).length, 1);
});

test("agent_started is emitted only after a scheduler slot is acquired", async () => {
  const first = deferred<ReturnType<typeof outcome>>();
  const second = deferred<ReturnType<typeof outcome>>();
  let calls = 0;
  const { ctx, sink } = fakeContext(
    async (req) => {
      calls++;
      return req.prompt === "first" ? first.promise : second.promise;
    },
    { concurrency: 1 },
  );
  const p = createPrimitives(ctx);
  const run = Promise.all([
    p.agent("first", { label: "first" }),
    p.agent("second", { label: "second" }),
  ]);

  await waitUntil(() => calls === 1);
  assert.equal(sink.ofType(AGENT_STARTED).length, 1);

  first.resolve(outcome("one"));
  await waitUntil(() => calls === 2);
  assert.equal(sink.ofType(AGENT_STARTED).length, 2);

  second.resolve(outcome("two"));
  assert.deepEqual(await run, ["one", "two"]);
});

test("an unknown adapter fails before dispatch: no slot, no dispatch, no phantom running agent", async () => {
  let ran = 0;
  const { ctx, sink } = fakeContext(async () => {
    ran++;
    return outcome("x");
  });
  const p = createPrimitives(ctx);
  await assert.rejects(() => p.agent("hi", { adapter: "nope" }), AdapterNotFound);
  assert.equal(ran, 0);
  assert.equal(ctx.scheduler.dispatched, 0, "the failed call consumed no dispatch");
  assert.equal(sink.ofType(AGENT_STARTED).length, 0);
});

test("a fatal error inside the slot still settles the started agent with agent_failed", async () => {
  const { ctx, sink } = fakeContext(async () => {
    throw new ConfigError("isolation needs a git repository");
  });
  const p = createPrimitives(ctx);
  await assert.rejects(() => p.agent("hi", { label: "iso" }), ConfigError);
  const [started] = sink.ofType(AGENT_STARTED);
  const failed = sink.ofType(AGENT_FAILED);
  assert.ok(started, "the agent did start");
  assert.equal(failed.length, 1, "a started agent must not be left running");
  assert.equal(failed[0]!.agentId, started.agentId);
  assert.match(String(failed[0]!.error), /git repository/);
});

test("agent_started names the resolved adapter", async () => {
  const { ctx, sink } = fakeContext(async () => outcome("x"));
  const p = createPrimitives(ctx);
  await p.agent("hi");
  await p.agent("hi", { adapter: "codex" });
  assert.deepEqual(
    sink.ofType(AGENT_STARTED).map((e) => e.adapter),
    ["claude", "codex"],
  );
});

/** A context with a real Bridge (fake runner) and a guarded Scheduler, as buildContext wires them. */
function bridgedContext(runner: CommandRunner, options: { budgetTotal?: number; control?: MemoryControl } = {}) {
  const config = defaultConfig();
  config.settings.defaultAdapter = "claude";
  config.settings.schemaRetries = 2;
  const sink = new MemorySink();
  const usage = { outputChars: 0, outputTokens: 0 };
  const control = options.control ?? new MemoryControl();
  const scheduler = new Scheduler({
    concurrency: 2,
    maxAgents: 100,
    checkpoint: (signal) => control.checkpoint(signal),
    budgetGuard: () => {
      if (options.budgetTotal !== undefined && spentTokens(usage) >= options.budgetTotal) {
        throw new BudgetExhausted("budget spent");
      }
    },
  });
  const ctx: RunContext = {
    config,
    bridge: new Bridge(config, { runner }),
    scheduler,
    control,
    sink,
    args: null,
    source: process.cwd(),
    budgetTotal: options.budgetTotal ?? null,
    usage,
    seq: { value: 0 },
    currentPhase: null,
    emit(ev) {
      sink.emit(ev);
    },
  };
  return { ctx, usage };
}

const cliOk = (stdout: string) => ({ returncode: 0, stdout, stderr: "", timedOut: false, duration: 0 });

test("a schema retry is refused once the budget is spent, and the failed attempt still counts", async () => {
  let calls = 0;
  const { ctx, usage } = bridgedContext(
    async () => {
      calls++;
      return cliOk("x".repeat(400)); // 100 estimated tokens, and no JSON at all
    },
    { budgetTotal: 50 },
  );
  const p = createPrimitives(ctx);
  await assert.rejects(() => p.agent("p", { schema: obj({ n: number() }) }), BudgetExhausted);
  assert.equal(calls, 1, "the retry would have overrun the budget");
  assert.equal(usage.outputChars, 400, "the rejected attempt's output is in the tally");
  assert.ok(ctx.scheduler.fatalError instanceof BudgetExhausted, "the budget ends the run");
});

test("every schema attempt's output counts toward usage, not just the one that validated", async () => {
  let calls = 0;
  const { ctx, usage } = bridgedContext(async () => cliOk(++calls < 3 ? "nope".repeat(10) : '{"n": 1}'));
  const p = createPrimitives(ctx);
  assert.deepEqual(await p.agent("p", { schema: obj({ n: number() }) }), { n: 1 });
  assert.equal(usage.outputChars, 40 + 40 + '{"n": 1}'.length);
});

test("a stop that lands during an attempt prevents the schema retry", async () => {
  const control = new MemoryControl();
  let calls = 0;
  // No watchStop wired here, so only the retry's own guard can notice the stop.
  const { ctx } = bridgedContext(
    async () => {
      calls++;
      control.stop();
      return cliOk("not json");
    },
    { control },
  );
  const p = createPrimitives(ctx);
  await assert.rejects(() => p.agent("p", { schema: obj({ n: number() }) }), RunStopped);
  assert.equal(calls, 1);
});

test("parallel is a barrier; a thrown thunk becomes null", async () => {
  const { ctx } = fakeContext(async () => outcome("x"));
  const p = createPrimitives(ctx);
  const out = await p.parallel([
    async () => "a",
    async () => {
      throw new Error("x");
    },
    () => "c",
  ]);
  assert.deepEqual(out, ["a", null, "c"]);
});

test("pipeline passes (prev, item, index) to each stage", async () => {
  const { ctx } = fakeContext(async () => outcome("x"));
  const p = createPrimitives(ctx);
  const out = await p.pipeline([10, 20], (prev, item, index) => ({ prev, item, index }));
  assert.deepEqual(out, [
    { prev: 10, item: 10, index: 0 },
    { prev: 20, item: 20, index: 1 },
  ]);
});

test("pipeline: a stage that throws drops that item to null", async () => {
  const { ctx } = fakeContext(async () => outcome("x"));
  const p = createPrimitives(ctx);
  const out = await p.pipeline([1, 2], (v) => {
    if (v === 1) throw new Error("boom");
    return (v as number) * 10;
  });
  assert.deepEqual(out, [null, 20]);
});

test("work started early and awaited later never surfaces as an unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const { ctx } = fakeContext(async (req) => {
      if (req.prompt === "a") throw new Error("cli failed");
      return outcome(req.prompt);
    });
    const p = createPrimitives(ctx);
    const early = p.agent("a");
    const earlyBatch = p.parallel("not thunks" as unknown as Array<() => string>);
    const earlyPipeline = p.pipeline([1], 2 as unknown as (v: unknown) => unknown);
    await p.agent("b");
    // Cross a macrotask boundary: Node reports unhandled rejections there.
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    await assert.rejects(early, /cli failed/);
    await assert.rejects(earlyBatch, WorkflowScriptError);
    await assert.rejects(earlyPipeline, WorkflowScriptError);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(unhandled, []);
});

test("parallel() rejects non-function elements with a fix-it message", async () => {
  const { ctx } = fakeContext(async () => outcome("x"));
  const p = createPrimitives(ctx);
  await assert.rejects(
    () => p.parallel([() => "ok", "oops" as unknown as () => string]),
    (err: Error) =>
      err instanceof WorkflowScriptError && /element 1 is a string/.test(err.message) && /\(\) => agent\(\.\.\.\)/.test(err.message),
  );
  const started = Promise.resolve("already running");
  await assert.rejects(
    () => p.parallel([started as unknown as () => Promise<string>]),
    (err: Error) => err instanceof WorkflowScriptError && /a promise/.test(err.message),
  );
  await assert.rejects(() => p.parallel("nope" as unknown as Array<() => string>), WorkflowScriptError);
});

test("pipeline() rejects non-array items and non-function stages", async () => {
  const { ctx } = fakeContext(async () => outcome("x"));
  const p = createPrimitives(ctx);
  await assert.rejects(
    () => p.pipeline([1], (v) => v, 42 as unknown as (v: unknown) => unknown),
    (err: Error) => err instanceof WorkflowScriptError && /stage 1 is a number/.test(err.message),
  );
  await assert.rejects(() => p.pipeline({ length: 1 } as unknown as unknown[], (v) => v), WorkflowScriptError);
});

test("a script bug swallowed into a null slot is surfaced as a log event", async () => {
  const { ctx, sink } = fakeContext(async () => outcome("x"));
  const p = createPrimitives(ctx);
  const out = await p.pipeline(
    [1, 2],
    (v) => v,
    (v) => {
      if (v === 2) (undefined as unknown as { field: number }).field;
      return v;
    },
  );
  assert.deepEqual(out, [1, null]);
  const messages = sink.ofType(LOG).map((e) => String(e.message));
  assert.ok(
    messages.some((m) => /pipeline\(\) item 1 at stage 1 failed/.test(m) && /TypeError/.test(m)),
    `expected a log for the swallowed TypeError, got ${JSON.stringify(messages)}`,
  );

  await p.parallel([() => "a", () => Promise.reject(new RangeError("bad thunk"))]);
  assert.ok(sink.ofType(LOG).some((e) => /parallel\(\) thunk 1 failed.*RangeError: bad thunk/.test(String(e.message))));
});

test("an agent failure inside parallel is reported once (agent_failed), not logged again", async () => {
  const { ctx, sink } = fakeContext(async () => {
    throw new Error("cli failed");
  });
  const p = createPrimitives(ctx);
  assert.deepEqual(await p.parallel([() => p.agent("x")]), [null]);
  assert.equal(sink.ofType(AGENT_FAILED).length, 1);
  assert.equal(sink.ofType(LOG).filter((e) => /failed and its result is null/.test(String(e.message))).length, 0);
});

test("agent failures inside parallel isolate to null", async () => {
  const { ctx } = fakeContext(async (req) => {
    if (req.prompt === "bad") throw new Error("cli failed");
    return outcome(`ok:${req.prompt}`);
  });
  const p = createPrimitives(ctx);
  const out = await p.parallel([() => p.agent("good"), () => p.agent("bad")]);
  assert.deepEqual(out, ["ok:good", null]);
});

test("nested fan-out (pipeline stage spawning parallel) does not deadlock", async () => {
  const { ctx } = fakeContext(async (req) => outcome(req.prompt));
  const p = createPrimitives(ctx);
  const out = await p.pipeline([["a", "b"], ["c"]], (group) =>
    p.parallel((group as string[]).map((g) => () => p.agent(g))),
  );
  assert.deepEqual(out, [["a", "b"], ["c"]]);
});

test("T1: agent forwards model/agentType/isolation and never treats agentType as an adapter", async () => {
  let captured: Record<string, unknown> = {};
  const { ctx } = fakeContext(async (req) => {
    captured = req as Record<string, unknown>;
    return outcome("r");
  });
  const p = createPrimitives(ctx);
  await p.agent("hi", { model: "m", agentType: "persona", isolation: "worktree" });
  assert.equal(captured.model, "m");
  assert.equal(captured.agentType, "persona");
  assert.equal(captured.isolation, "worktree");
  // The mis-mapping is gone: agentType must NOT leak into adapter selection.
  assert.equal(captured.adapter, undefined);
});

test("T5: routing notes on the outcome are emitted as LOG events", async () => {
  const { ctx, sink } = fakeContext(async () => ({
    value: "v",
    text: "v",
    adapter: "claude",
    attempts: 1,
    notes: ["note-A", "note-B"],
  }));
  const p = createPrimitives(ctx);
  await p.agent("hi");
  const messages = sink.ofType(LOG).map((e) => e.message);
  assert.ok(messages.includes("note-A"));
  assert.ok(messages.includes("note-B"));
});
