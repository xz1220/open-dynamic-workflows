import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultConfig, resolveAdapter } from "../src/adapters/config.js";
import type { Bridge } from "../src/bridge.js";
import type { RunContext } from "../src/context.js";
import { NullControl } from "../src/control.js";
import { RunStopped } from "../src/errors.js";
import { AGENT_FINISHED, AGENT_STARTED, LOG, MemorySink } from "../src/events.js";
import { ReplayJournal, resumeKey, stableJson, type AgentResultRecord } from "../src/journal.js";
import { createPrimitives } from "../src/primitives.js";
import { formatEvent } from "../src/runtime/live-view.js";
import { RunStore } from "../src/runtime/run-store.js";
import { foldAgents } from "../src/runtime/runs-view.js";
import { Scheduler } from "../src/scheduler.js";

// Issue #24: every completed agent() is saved as it lands, and `odw resume`
// replays the calls a run already completed. These cover the pieces in
// isolation; tests/resume.test.ts drives them end to end.

function fakeContext(
  run: (req: { prompt: string }, opts?: { onReply?: (text: string) => void }) => Promise<unknown>,
  options: {
    concurrency?: number;
    maxAgents?: number;
    save?: (rec: AgentResultRecord) => void;
    replay?: ReplayJournal;
  } = {},
): { ctx: RunContext; sink: MemorySink } {
  const sink = new MemorySink();
  const config = defaultConfig();
  config.settings.defaultAdapter = "claude";
  const ctx: RunContext = {
    config,
    bridge: { run, adapterFor: (name?: string | null) => resolveAdapter(config, name) } as unknown as Bridge,
    scheduler: new Scheduler({ concurrency: options.concurrency ?? 4, maxAgents: options.maxAgents ?? 1000 }),
    control: new NullControl(),
    sink,
    args: null,
    source: process.cwd(),
    budgetTotal: null,
    usage: { outputChars: 0 },
    seq: { value: 0 },
    currentPhase: null,
    saveAgentResult: options.save,
    replay: options.replay,
    emit(ev) {
      sink.emit(ev);
    },
  };
  return { ctx, sink };
}

const outcome = (value: unknown) => ({ value, text: String(value), adapter: "claude", attempts: 1 });

/** A saved record with sensible defaults. */
function rec(fields: Partial<AgentResultRecord> & { agentId: number; key: string }): AgentResultRecord {
  return {
    label: "agent",
    phase: null,
    adapter: "claude",
    attempts: 1,
    startedAt: 1,
    finishedAt: 2,
    value: null,
    ...fields,
  };
}

async function waitUntil(fn: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error("condition did not become true");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

// --- the run store -------------------------------------------------------------

test("run store: agent results round-trip, list in agentId order, ignore strays", () => {
  const root = mkdtempSync(join(tmpdir(), "odw-agents-"));
  try {
    const store = new RunStore(root);
    const id = store.create({ script: "/x/wf.js", args: null, source: "/s" });
    assert.deepEqual(store.listAgentResults(id), [], "no agents/ directory yet");
    assert.equal(store.readAgentResult(id, 1), null);

    for (const agentId of [10, 2, 1]) {
      store.writeAgentResult(id, rec({ agentId, key: `k${agentId}`, value: { n: agentId } }));
    }
    const dir = join(store.runDir(id), "agents");
    writeFileSync(join(dir, "notes.txt"), "not a record");
    writeFileSync(join(dir, "11.json"), "[1, 2]"); // parses, but is no record
    writeFileSync(join(dir, "12.json"), "{ torn"); // does not parse
    mkdirSync(join(dir, "13.json")); // not a file

    // Numeric order (2 before 10), strays skipped, no temp files left behind.
    assert.deepEqual(store.listAgentResults(id).map((r) => r.agentId), [1, 2, 10]);
    assert.deepEqual(store.readAgentResult(id, 10)?.value, { n: 10 });
    assert.equal(store.readAgentResult(id, 11), null);
    assert.equal(store.readAgentResult(id, 3), null);
    assert.equal(readdirSync(dir).some((f) => f.endsWith(".tmp")), false);

    // An undefined value is saved as null, so the record always carries one.
    store.writeAgentResult(id, rec({ agentId: 4, key: "k4", value: undefined }));
    assert.equal(store.readAgentResult(id, 4)?.value, null);

    // The id names a file: nothing but a non-negative integer gets near the disk.
    for (const bad of [-1, 1.5, Number.NaN]) {
      assert.throws(() => store.writeAgentResult(id, rec({ agentId: bad, key: "x" })), /invalid agentId/);
      assert.equal(store.readAgentResult(id, bad), null);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run store: meta records the run a resume replays", () => {
  const root = mkdtempSync(join(tmpdir(), "odw-agents-"));
  try {
    const store = new RunStore(root);
    const source = store.create({ script: "/x/wf.js", args: null, source: "/s" });
    const resumed = store.create({
      script: "/x/wf.js",
      args: null,
      source: "/s",
      resumedFrom: { runId: source, dir: store.runDir(source) },
    });
    assert.equal(store.readMeta(resumed).resumedFrom, source);
    assert.equal(store.readMeta(resumed).resumedFromDir, store.runDir(source));
    assert.equal(store.readMeta(source).resumedFrom, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- the resume key and the replay journal -----------------------------------------

test("resumeKey: stable JSON of prompt + options; phase and unset options do not count", () => {
  const schema = { type: "object", properties: { a: { type: "string" }, b: { type: "number" } } };
  const base = resumeKey("p", { schema });
  assert.match(base, /^[0-9a-f]{64}$/, "a sha256 hex digest");
  // Key order inside the schema does not matter; neither do phase or an undefined option.
  const reordered = { properties: { b: { type: "number" }, a: { type: "string" } }, type: "object" };
  assert.equal(resumeKey("p", { schema: reordered }), base);
  assert.equal(resumeKey("p", { schema, phase: "Elsewhere", label: undefined }), base);
  // Every input that decides what the call produces changes it.
  const variants = [
    resumeKey("p2", { schema }),
    resumeKey("p", { schema: { ...schema, required: ["a"] } }),
    resumeKey("p", { schema, adapter: "codex" }),
    resumeKey("p", { schema, model: "gpt-5" }),
    resumeKey("p", { schema, agentType: "reviewer" }),
    resumeKey("p", { schema, isolation: "worktree" }),
    resumeKey("p", { schema, label: "voter-1" }),
  ];
  assert.equal(new Set([base, ...variants]).size, variants.length + 1);
  assert.equal(stableJson({ b: [{ d: 1, c: 2 }], a: null }), '{"a":null,"b":[{"c":2,"d":1}]}');
  const circular: Record<string, unknown> = { type: "object" };
  circular.self = circular;
  assert.throws(() => resumeKey("p", { schema: circular }), TypeError);
});

test("ReplayJournal: one FIFO per key, in agentId order; unusable records are skipped", () => {
  const journal = new ReplayJournal("run-a", [
    rec({ agentId: 5, key: "vote", value: "third" }),
    rec({ agentId: 1, key: "vote", value: "first" }),
    rec({ agentId: 2, key: "other", value: "o" }),
    rec({ agentId: 3, key: "vote", value: "second" }),
    { agentId: 4, label: "no key", value: "x" } as unknown as AgentResultRecord,
  ]);
  assert.equal(journal.sourceRunId, "run-a");
  assert.equal(journal.size, 4);
  assert.deepEqual([1, 2, 3, 4].map(() => journal.take("vote")?.value), ["first", "second", "third", undefined]);
  assert.equal(journal.take("missing"), undefined);
  assert.equal(journal.size, 1, "only 'other' is left");
});

// --- the engine ------------------------------------------------------------------

test("agent() saves its record before agent_finished, which then says saved: true", async () => {
  const saved: AgentResultRecord[] = [];
  let finishedBeforeSave = -1;
  const { ctx, sink } = fakeContext(async (req) => outcome(`R:${req.prompt}`), {
    save: (r) => {
      finishedBeforeSave = sink.ofType(AGENT_FINISHED).length;
      saved.push(r);
    },
  });
  const p = createPrimitives(ctx);
  p.phase("Draft");
  assert.equal(await p.agent("hi", { label: "greeter", model: "m1" }), "R:hi");

  assert.equal(finishedBeforeSave, 0, "the result is on disk before anyone hears it finished");
  const [started] = sink.ofType(AGENT_STARTED);
  const [finished] = sink.ofType(AGENT_FINISHED);
  assert.deepEqual(saved, [
    {
      agentId: 1,
      key: resumeKey("hi", { label: "greeter", model: "m1" }),
      label: "greeter",
      phase: "Draft",
      adapter: "claude",
      attempts: 1,
      startedAt: started!.ts,
      finishedAt: finished!.ts,
      value: "R:hi",
    },
  ]);
  assert.equal(finished!.saved, true);
  assert.equal("value" in finished!, false, "events reference results; they never carry them");
});

test("a failed save is logged and never fails the agent", async () => {
  const { ctx, sink } = fakeContext(async () => outcome("ok"), {
    save: () => {
      throw new Error("ENOSPC: disk full");
    },
  });
  assert.equal(await createPrimitives(ctx).agent("x", { label: "lbl" }), "ok");
  const [finished] = sink.ofType(AGENT_FINISHED);
  assert.equal(finished!.saved, undefined);
  const logged = sink.ofType(LOG).find((e) => /could not save the result of agent 1: ENOSPC/.test(String(e.message)));
  assert.ok(logged, "the failure is visible in the event stream");
  assert.equal(logged!.label, "lbl");

  // Without a store (an in-process run) nothing is saved and nothing is claimed.
  const bare = fakeContext(async () => outcome("ok"));
  await createPrimitives(bare.ctx).agent("x");
  assert.equal(bare.sink.ofType(AGENT_FINISHED)[0]!.saved, undefined);
});

test("a replayed call returns a copy of the saved value and runs nothing", async () => {
  const calls: string[] = [];
  const saved: AgentResultRecord[] = [];
  const schema = { type: "object", properties: { n: { type: "number" } } };
  const journal = new ReplayJournal("run-a", [
    rec({ agentId: 7, key: resumeKey("p", { schema, label: "L" }), label: "L", adapter: "codex", attempts: 2, value: { n: 1 } }),
  ]);
  const { ctx, sink } = fakeContext(
    async (req) => {
      calls.push(req.prompt);
      return outcome("fresh");
    },
    { save: (r) => saved.push(r), replay: journal },
  );
  const p = createPrimitives(ctx);

  const value = (await p.agent("p", { schema, label: "L", phase: "Again" })) as { n: number };
  assert.deepEqual(value, { n: 1 });
  assert.deepEqual(calls, [], "the adapter never ran");

  const [started] = sink.ofType(AGENT_STARTED);
  const [finished] = sink.ofType(AGENT_FINISHED);
  assert.deepEqual(
    { cached: started!.cached, sourceRunId: started!.sourceRunId, adapter: started!.adapter },
    { cached: true, sourceRunId: "run-a", adapter: "codex" },
  );
  assert.deepEqual(
    { cached: finished!.cached, sourceRunId: finished!.sourceRunId, saved: finished!.saved, attempts: finished!.attempts },
    { cached: true, sourceRunId: "run-a", saved: true, attempts: 2 },
  );
  // The new run gets its own record (its own id and phase), marked, so resumes chain.
  assert.equal(saved.length, 1);
  assert.deepEqual(
    { agentId: saved[0]!.agentId, phase: saved[0]!.phase, cached: saved[0]!.cached, sourceRunId: saved[0]!.sourceRunId },
    { agentId: 1, phase: "Again", cached: true, sourceRunId: "run-a" },
  );
  assert.equal(saved[0]!.key, resumeKey("p", { schema, label: "L" }));
  // A deep copy: the script may mutate what it got without touching the record.
  value.n = 99;
  assert.deepEqual(saved[0]!.value, { n: 1 });

  // The key's queue is spent: the same call again runs for real.
  assert.equal(await p.agent("p", { schema, label: "L" }), "fresh");
  assert.deepEqual(calls, ["p"]);
});

test("a replay of a replayed record keeps pointing at the run that produced it", async () => {
  const saved: AgentResultRecord[] = [];
  const journal = new ReplayJournal("run-b", [
    rec({ agentId: 1, key: resumeKey("a", {}), value: "A", cached: true, sourceRunId: "run-a" }),
    rec({ agentId: 2, key: resumeKey("b", {}), value: "B" }),
  ]);
  const { ctx } = fakeContext(async () => outcome("x"), { save: (r) => saved.push(r), replay: journal });
  const p = createPrimitives(ctx);
  assert.equal(await p.agent("a"), "A");
  assert.equal(await p.agent("b"), "B");
  assert.deepEqual(saved.map((r) => r.sourceRunId), ["run-a", "run-b"]);
});

test("replays take no scheduler slot, no dispatch and no budget", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const journal = new ReplayJournal("src", [
    rec({ agentId: 1, key: resumeKey("a", {}), value: "A" }),
    rec({ agentId: 2, key: resumeKey("b", {}), value: "B" }),
  ]);
  const { ctx, sink } = fakeContext(
    async (_req, opts) => {
      await gate;
      opts?.onReply?.("x".repeat(400)); // what the real bridge reports per reply
      return outcome("x".repeat(400));
    },
    { concurrency: 1, maxAgents: 1, replay: journal },
  );
  const p = createPrimitives(ctx);
  const busy = p.agent("holds the only slot");
  await waitUntil(() => ctx.scheduler.dispatched === 1);

  // The only slot is taken and the dispatch cap (1) is reached, yet both return at once.
  assert.equal(await p.agent("a"), "A");
  assert.equal(await p.agent("b"), "B");
  assert.equal(ctx.scheduler.dispatched, 1, "a replay is not a dispatch");
  assert.equal(ctx.usage.outputChars, 0, "a replay adds nothing to the budget tally");
  assert.equal(sink.ofType(AGENT_FINISHED).length, 2);

  release();
  await busy;
  assert.equal(ctx.usage.outputChars, 400);
});

test("once the run has ended, a replayable call fails with the run's reason", async () => {
  const journal = new ReplayJournal("src", [rec({ agentId: 1, key: resumeKey("a", {}), value: "A" })]);
  const { ctx, sink } = fakeContext(async () => outcome("x"), { replay: journal });
  ctx.scheduler.abort(new RunStopped("run was stopped"));
  await assert.rejects(createPrimitives(ctx).agent("a"), RunStopped);
  assert.equal(sink.ofType(AGENT_STARTED).length, 0);
});

// --- observers ---------------------------------------------------------------------

test("the fold marks replayed agents cached; logs say where they came from", () => {
  const [fresh, replayed] = foldAgents([
    { ts: 1, type: "agent_started", agentId: 1, label: "a", phase: null, adapter: "mock" },
    { ts: 2, type: "agent_finished", agentId: 1, label: "a", phase: null, adapter: "mock", attempts: 1, saved: true },
    { ts: 3, type: "agent_started", agentId: 2, label: "b", phase: null, adapter: "mock", cached: true, sourceRunId: "r0" },
    {
      ts: 3,
      type: "agent_finished",
      agentId: 2,
      label: "b",
      phase: null,
      adapter: "mock",
      attempts: 1,
      cached: true,
      sourceRunId: "r0",
      saved: true,
    },
  ]);
  assert.equal(fresh!.cached, false);
  assert.equal(replayed!.cached, true);
  assert.equal(replayed!.state, "done");
  assert.match(
    formatEvent({ ts: 3, type: "agent_finished", label: "b", cached: true, sourceRunId: "r0" }),
    /agent_finished\s+b \(replayed from r0\)$/,
  );
});
