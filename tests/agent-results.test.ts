import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultConfig, resolveAdapter } from "../src/adapters/config.js";
import type { Bridge } from "../src/bridge.js";
import type { RunContext } from "../src/context.js";
import { NullControl } from "../src/control.js";
import { AGENT_FINISHED, AGENT_STARTED, LOG, MemorySink } from "../src/events.js";
import { resumeKey, stableJson, type AgentResultRecord } from "../src/journal.js";
import { createPrimitives } from "../src/primitives.js";
import { RunStore } from "../src/runtime/run-store.js";
import { Scheduler } from "../src/scheduler.js";

// Issue #24: every completed agent() is saved as it lands. These cover the
// pieces in isolation; the agents CLI and API tests read the saved results.

function fakeContext(
  run: (req: { prompt: string }, opts?: { onReply?: (text: string) => void }) => Promise<unknown>,
  options: {
    concurrency?: number;
    maxAgents?: number;
    save?: (rec: AgentResultRecord) => void;
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

// --- the resume key ------------------------------------------------------------------

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
