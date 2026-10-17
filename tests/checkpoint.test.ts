import { test } from "node:test";
import assert from "node:assert/strict";

import { defaultConfig } from "../src/adapters/config.js";
import type { Bridge } from "../src/bridge.js";
import { CHECKPOINT_PAYLOAD_MAX_BYTES, CheckpointTimeout, eventPayload } from "../src/checkpoint.js";
import { buildContext, type RunContext } from "../src/context.js";
import { MemoryControl, NullControl } from "../src/control.js";
import { RunStopped, WorkflowScriptError } from "../src/errors.js";
import { MemorySink, type WorkflowEvent } from "../src/events.js";
import { loadWorkflowScript, scanDualCompat } from "../src/loader.js";
import { createPrimitives, type WorkflowGlobals } from "../src/primitives.js";

// checkpoint() (ODW extension): a run waits for a person to approve or reject.
// The engine side, over an in-process MemoryControl; the run directory, the
// CLI and the dashboard API have their own checkpoint-*.test.ts files.

const META = "export const meta = { name: 'gate', description: 'd' }\n";

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition did not become true in time");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

const ofType = (events: WorkflowEvent[], type: string) => events.filter((e) => e.type === type);

/** A run context over a MemoryControl, with a fake bridge whose agents answer when told. */
function harness(options: { concurrency?: number; maxAgents?: number; budgetTotal?: number } = {}) {
  const config = defaultConfig();
  config.settings.defaultAdapter = "claude";
  config.settings.concurrency = options.concurrency ?? 4;
  if (options.maxAgents !== undefined) config.settings.maxAgents = options.maxAgents;
  const control = new MemoryControl();
  const sink = new MemorySink();
  const ctx: RunContext = buildContext(config, { control, sink, budgetTotal: options.budgetTotal ?? null });
  const started: string[] = [];
  const replies = new Map<string, (value: string) => void>();
  const routing = ctx.bridge; // where a call starts is a real bridge's decision
  ctx.bridge = {
    adapterFor: () => ({ name: "claude" }),
    route: routing.route.bind(routing),
    run: (req: { prompt: string }) => {
      started.push(req.prompt);
      return new Promise((resolve) => replies.set(req.prompt, (value) => resolve({ value, adapter: "claude", attempts: 1 })));
    },
  } as unknown as Bridge;
  return { ctx, control, sink, prims: createPrimitives(ctx), started, reply: (prompt: string) => replies.get(prompt)!("ok") };
}

test("checkpoint() waits for an answer and resolves { approved, note, by }", async () => {
  const { prims, control, sink, ctx } = harness();
  prims.phase("Plan");
  const first = prims.checkpoint("Ship   it?\n", { payload: { steps: ["a", "b"] } });
  await until(() => control.waiting().length === 1);
  const [requested] = ofType(sink.events, "checkpoint_requested");
  assert.deepEqual(
    { ...requested, ts: 0 },
    { ts: 0, type: "checkpoint_requested", checkpointId: 1, title: "Ship it?", payload: { steps: ["a", "b"] }, phase: "Plan" },
    "one line of title, the payload, and the phase it was asked in",
  );
  assert.equal(control.decide({ action: "approve", note: "lgtm", by: "dashboard" }), true);
  assert.deepEqual(await first, { approved: true, note: "lgtm", by: "dashboard" });

  const second = prims.checkpoint("Again?");
  await until(() => control.waiting().length === 1);
  control.decide({ action: "reject", checkpointId: 2, note: "   " });
  assert.deepEqual(await second, { approved: false, note: null, by: "cli" }, "a rejection is an answer; a blank note is none");

  const resolved = ofType(sink.events, "checkpoint_resolved").map(({ ts: _ts, ...rest }) => rest);
  assert.deepEqual(resolved, [
    { type: "checkpoint_resolved", checkpointId: 1, approved: true, note: "lgtm", by: "dashboard" },
    { type: "checkpoint_resolved", checkpointId: 2, approved: false, note: null, by: "cli" },
  ]);
  assert.equal(ctx.scheduler.dispatched, 0);
});

test("waiting takes no agent slot, no dispatch and no budget, and is asked even while paused", async () => {
  // One slot, one dispatch allowed, a one-token budget: a checkpoint that took
  // any of them would starve or fail the agent below.
  const { prims, control, ctx, started, reply } = harness({ concurrency: 1, maxAgents: 1, budgetTotal: 1 });
  control.pause();
  const asked = prims.checkpoint("Go on?");
  await until(() => control.waiting().length === 1);
  control.resume();
  const work = prims.agent("work");
  await until(() => started.includes("work"));
  assert.deepEqual(control.waiting(), [1], "the checkpoint still waits while the agent runs");
  reply("work");
  assert.equal(await work, "ok");
  assert.equal(ctx.scheduler.dispatched, 1, "only the agent was dispatched");
  assert.equal(prims.budget.spent(), 0);
  control.decide({ action: "approve" });
  assert.equal((await asked).approved, true);
});

test("timeouts: approve and reject answer by timeout; fail throws a recoverable CheckpointTimeout", async () => {
  const { prims, sink } = harness();
  assert.deepEqual(await prims.checkpoint("A?", { timeout: 0.02, onTimeout: "approve" }), {
    approved: true,
    note: null,
    by: "timeout",
  });
  assert.deepEqual(await prims.checkpoint("B?", { timeout: 0.02, onTimeout: "reject" }), {
    approved: false,
    note: null,
    by: "timeout",
  });
  await assert.rejects(prims.checkpoint("C?", { timeout: 0.02 }), (err) => {
    assert.ok(err instanceof CheckpointTimeout);
    assert.equal(err.checkpointId, 3);
    assert.match(err.message, /checkpoint #3 'C\?' got no answer within 0\.02s/);
    return true;
  });
  const failed = ofType(sink.events, "checkpoint_resolved").find((e) => e.checkpointId === 3)!;
  assert.equal(failed.by, "timeout");
  assert.equal(failed.approved, false);
  assert.match(String(failed.error), /no answer within/);

  // Recoverable: inside parallel() it is a null slot, reported once (by its event).
  const results = await prims.parallel([() => prims.checkpoint("D?", { timeout: 0.02 }), () => "other"]);
  assert.deepEqual(results, [null, "other"]);
  assert.equal(ofType(sink.events, "log").length, 0, "no second report of the timeout");
});

test("misuse throws a WorkflowScriptError before anything is asked", async () => {
  const { prims, sink } = harness();
  const cases: Array<[unknown, unknown, RegExp]> = [
    ["", undefined, /title must be a non-empty string; got ""/],
    [42, undefined, /title must be a non-empty string; got 42/],
    ["ok?", "fast", /options must be an object; got "fast"/],
    ["ok?", { timeout: 0 }, /timeout must be a positive number of seconds; got 0/],
    ["ok?", { timeout: "60" }, /timeout must be a positive number of seconds; got "60"/],
    ["ok?", { timeout: 5, onTimeout: "maybe" }, /onTimeout must be "approve", "reject" or "fail"; got "maybe"/],
  ];
  for (const [title, opts, message] of cases) {
    const call = (prims.checkpoint as (t: unknown, o?: unknown) => Promise<unknown>)(title, opts);
    await assert.rejects(call, (err) => err instanceof WorkflowScriptError && message.test(err.message), String(message));
  }
  assert.equal(sink.events.length, 0);
});

test("a stop while waiting withdraws the question and ends the run's work with RunStopped", async () => {
  const { prims, control, sink, ctx } = harness();
  const pending = prims.checkpoint("Hold on?");
  await until(() => control.waiting().length === 1);
  control.stop();
  await assert.rejects(pending, RunStopped);
  assert.ok(ctx.scheduler.fatalError instanceof RunStopped, "the stop is the run's outcome");
  const [resolved] = ofType(sink.events, "checkpoint_resolved");
  assert.equal(resolved!.by, null);
  assert.match(String(resolved!.error), /run was stopped/);

  // A stop asked for before the question is noticed at once: nothing is asked.
  const stopped = harness();
  stopped.control.stop();
  await assert.rejects(stopped.prims.checkpoint("Too late?"), RunStopped);
  assert.equal(ofType(stopped.sink.events, "checkpoint_requested").length, 0);
});

test("parallel checkpoints wait side by side; an answer without an id goes to the oldest", async () => {
  const { prims, control } = harness();
  const both = prims.parallel([() => prims.checkpoint("first?"), () => prims.checkpoint("second?")]);
  await until(() => control.waiting().length === 2);
  assert.deepEqual(control.waiting(), [1, 2]);
  control.decide({ action: "reject", checkpointId: 2, note: "not this one" });
  await until(() => control.waiting().length === 1);
  control.decide({ action: "approve" });
  assert.deepEqual(await both, [
    { approved: true, note: null, by: "cli" },
    { approved: false, note: "not this one", by: "cli" },
  ]);
  assert.equal(control.decide({ action: "approve" }), false, "nothing waits any more");
});

test("a checkpoint whose question cannot be recorded stops listening for an answer", async () => {
  const control = new MemoryControl();
  const sink = {
    emit(ev: WorkflowEvent): void {
      if (ev.type === "checkpoint_requested") throw new Error("ENOSPC: no space left on device");
    },
  };
  const prims = createPrimitives(buildContext(defaultConfig(), { control, sink }));
  await assert.rejects(prims.checkpoint("Go?"), /ENOSPC/);
  assert.deepEqual(control.waiting(), [], "no answer channel left open (it would keep a worker polling)");
});

test("without a decision channel a checkpoint needs a timeout", async () => {
  const ctx = buildContext(defaultConfig(), { control: new NullControl() });
  const prims = createPrimitives(ctx);
  await assert.rejects(prims.checkpoint("Anyone?"), /no way to ask anyone .* give the checkpoint a timeout/);
  assert.deepEqual(await prims.checkpoint("Anyone?", { timeout: 0.01, onTimeout: "approve" }), {
    approved: true,
    note: null,
    by: "timeout",
  });
});

test("the payload is JSON-safe and cut to 64 KiB", () => {
  const cyclic: Record<string, unknown> = { name: "loop" };
  cyclic.self = cyclic;
  const shared = { n: 1 };
  assert.deepEqual(eventPayload(undefined), { payload: null, truncated: false });
  assert.deepEqual(eventPayload({ big: 10n, fn: () => 1, cyclic, twice: [shared, shared], when: new Date(0) }), {
    payload: {
      big: "10",
      cyclic: { name: "loop", self: "[Circular]" },
      twice: [{ n: 1 }, { n: 1 }],
      when: "1970-01-01T00:00:00.000Z",
    },
    truncated: false,
  });
  const throwing = {
    toJSON: () => {
      throw new Error("nope");
    },
  };
  assert.deepEqual(eventPayload(throwing), { payload: "[the payload could not be serialized: nope]", truncated: false });

  const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), "utf8");
  // A big string stays a string: its start, whole characters only.
  const text = "é".repeat(50_000) + "😀".repeat(10_000);
  const cut = eventPayload(text);
  assert.equal(cut.truncated, true);
  assert.equal(typeof cut.payload, "string");
  assert.ok(bytes(cut.payload) <= CHECKPOINT_PAYLOAD_MAX_BYTES, `${bytes(cut.payload)} bytes`);
  assert.ok((cut.payload as string).startsWith("éééé"));
  assert.ok((cut.payload as string).endsWith("…"));
  assert.doesNotMatch(cut.payload as string, /�/);
  // A big object keeps the start of its JSON, as text; escapes count too.
  const big = eventPayload({ rows: Array.from({ length: 5000 }, (_, i) => ({ i, line: "\u0001\"quoted\"" })) });
  assert.equal(big.truncated, true);
  assert.match(big.payload as string, /^\{"rows":\[\{"i":0,/);
  assert.ok(bytes(big.payload) <= CHECKPOINT_PAYLOAD_MAX_BYTES);
});

test("checkpoint is injected unless the script binds the name itself; validate() flags it as ODW-only", async () => {
  const seen: string[] = [];
  const globals = {
    agent: async () => "",
    parallel: async () => [],
    pipeline: async () => [],
    phase: () => {},
    log: () => {},
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
    workflow: async () => null,
    validate: () => ({ ok: true, errors: [], warnings: [] }),
    exec: async () => ({}),
    checkpoint: async (title: string) => {
      seen.push(title);
      return { approved: true, note: null, by: "cli" };
    },
  } as unknown as WorkflowGlobals;
  const run = (body: string, args: unknown = null) => loadWorkflowScript(META + body, "wf.js").run(globals, args);
  assert.deepEqual(await run("return (await checkpoint('Go?')).approved"), true);
  assert.deepEqual(seen, ["Go?"]);
  // "checkpoint" is a common name: a nested binding of it leaves the global in place.
  assert.equal(
    await run(
      "const r = await checkpoint('Nested?')\n" +
        "for (const checkpoint of [1, 2]) log(checkpoint)\n" +
        "function helper() { let checkpoint = 1; return checkpoint }\n" +
        "return r.approved && helper() === 1",
    ),
    true,
  );
  assert.deepEqual(seen, ["Go?", "Nested?"]);
  // The script's own top-level binding wins, whatever its kind.
  assert.equal(await run("function checkpoint(t) { return 'fn:' + t }\nreturn checkpoint('x')"), "fn:x");
  assert.equal(await run("const checkpoint = (t) => 'own:' + t\nreturn checkpoint('x')"), "own:x");
  // A destructured binding the declaration pattern cannot see still wins (no duplicate-declaration error).
  assert.equal(await run("const { checkpoint } = args\nreturn checkpoint", { checkpoint: "epoch-3" }), "epoch-3");
  assert.equal(await run("const [exec] = ['mine']\nreturn exec"), "mine");
  assert.throws(() => loadWorkflowScript(META + "const { checkpoint } = args\nreturn (", "wf.js"), /failed to compile/);

  const flagged = (body: string) => scanDualCompat(META + body).filter((w) => /checkpoint\(\)/.test(w));
  assert.equal(flagged("await checkpoint('Go?')").length, 1);
  assert.equal(flagged("log(`${(await checkpoint('Go?')).note}`)").length, 1);
  for (const portable of [
    "trainer.checkpoint('x')",
    "// await checkpoint('x')",
    "log('checkpoint(x)')",
    "function checkpoint() {}\ncheckpoint()",
  ]) {
    assert.deepEqual(flagged(portable), [], portable);
  }
  const report = createPrimitives(buildContext(defaultConfig())).validate(META + "return await checkpoint('Go?')");
  assert.equal(report.ok, true, "a warning, not an error: odw runs it");
  assert.match(report.warnings.join("\n"), /checkpoint\(\) is an ODW extension, not portable to Claude Code/);
});
