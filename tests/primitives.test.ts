import { test } from "node:test";
import assert from "node:assert/strict";

import { defaultConfig } from "../src/adapters/config.js";
import type { Bridge } from "../src/bridge.js";
import type { RunContext } from "../src/context.js";
import { NullControl } from "../src/control.js";
import { AGENT_FINISHED, AGENT_STARTED, LOG, MemorySink } from "../src/events.js";
import { createPrimitives } from "../src/primitives.js";
import { Scheduler } from "../src/scheduler.js";

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
  const ctx: RunContext = {
    config,
    bridge: { run } as unknown as Bridge,
    scheduler: new Scheduler({ concurrency: options.concurrency ?? 4, maxAgents: 1000 }),
    control: new NullControl(),
    sink,
    args: null,
    source: process.cwd(),
    budgetTotal: null,
    usage: { outputChars: 0 },
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
  diff: "",
  cli: null,
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
    diff: "",
    cli: null,
    notes: ["note-A", "note-B"],
  }));
  const p = createPrimitives(ctx);
  await p.agent("hi");
  const messages = sink.ofType(LOG).map((e) => e.message);
  assert.ok(messages.includes("note-A"));
  assert.ok(messages.includes("note-B"));
});
