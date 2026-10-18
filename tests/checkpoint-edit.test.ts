import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";

import { defaultConfig } from "../src/adapters/config.js";
import { CHECKPOINT_EDIT_MAX_BYTES, CHECKPOINT_PAYLOAD_MAX_BYTES, checkEdit } from "../src/checkpoint.js";
import { buildContext } from "../src/context.js";
import { MemoryControl } from "../src/control.js";
import { WorkflowScriptError } from "../src/errors.js";
import { MemorySink, type WorkflowEvent } from "../src/events.js";
import { createPrimitives } from "../src/primitives.js";
import { formatEvent } from "../src/runtime/live-view.js";
import { pendingIds, project, until } from "./checkpoint-project.js";

// Approving a checkpoint() with an edited payload (ODW extension): the engine
// side — what the call resolves to, what the events record, and the checks the
// run makes on receipt. The CLI and the API have checkpoint-edit-cli and
// checkpoint-edit-server.

const ofType = (events: WorkflowEvent[], type: string) => events.filter((e) => e.type === type);
const logs = (events: WorkflowEvent[]) => ofType(events, "log").map((e) => String(e.message));

/** A run context over a MemoryControl. */
function harness(schemaKeywords: "warn" | "strict" = "warn") {
  const config = defaultConfig();
  config.settings.schemaKeywords = schemaKeywords;
  const control = new MemoryControl();
  const sink = new MemorySink();
  const prims = createPrimitives(buildContext(config, { control, sink }));
  return { control, sink, prims };
}

const PLAN = {
  type: "object",
  properties: { steps: { type: "array", items: { type: "string" }, minItems: 1 } },
  required: ["steps"],
};

test("an approval with an edit reaches the script, and checkpoint_resolved records it", async () => {
  const { prims, control, sink } = harness();
  const plan = { steps: ["a", "b"] };
  const asked = prims.checkpoint("Run it?", { payload: plan, schema: PLAN });
  await until(() => control.waiting().length === 1);
  const requested = ofType(sink.events, "checkpoint_requested")[0]!;
  assert.deepEqual(requested.schema, PLAN, "the event carries the schema the CLI and the API check edits against");
  assert.equal(control.decide({ action: "approve", payload: { steps: ["a"] }, note: "only a", by: "dashboard" }), true);
  assert.deepEqual(await asked, { approved: true, note: "only a", by: "dashboard", payload: { steps: ["a"] }, edited: true });
  const [resolved] = ofType(sink.events, "checkpoint_resolved").map(({ ts: _ts, ...rest }) => rest);
  assert.deepEqual(resolved, {
    type: "checkpoint_resolved",
    checkpointId: 1,
    approved: true,
    note: "only a",
    by: "dashboard",
    edited: true,
    payload: { steps: ["a"] },
  });
  assert.deepEqual(plan, { steps: ["a", "b"] }, "the script's own value is left alone");

  // A checkpoint without a payload can be approved with one.
  const bare = prims.checkpoint("Anything to add?");
  await until(() => control.waiting().length === 1);
  control.decide({ action: "approve", payload: ["x"] });
  assert.deepEqual(await bare, { approved: true, note: null, by: "cli", payload: ["x"], edited: true });
});

test("an unchanged edit gives edited: false and the payload as given", async () => {
  const { prims, control, sink } = harness();
  const plan = { steps: ["a", "b"], when: new Date(0) };
  const asked = prims.checkpoint("Run it?", { payload: plan });
  await until(() => control.waiting().length === 1);
  // The same JSON, keys in another order (and the Date as the event shows it).
  control.decide({ action: "approve", payload: { when: "1970-01-01T00:00:00.000Z", steps: ["a", "b"] } });
  const result = await asked;
  assert.equal(result.edited, false);
  assert.equal(result.payload, plan, "the script gets its own value back, not a copy");
  assert.equal(ofType(sink.events, "checkpoint_resolved")[0]!.edited, undefined, "nothing edited, nothing recorded");

  // null stands for "no payload" in the event: approving it unchanged is no edit.
  const none = prims.checkpoint("Go?");
  await until(() => control.waiting().length === 1);
  control.decide({ action: "approve", payload: null });
  assert.deepEqual(await none, { approved: true, note: null, by: "cli", payload: undefined, edited: false });
});

test("a rejection ignores any payload; a timeout carries the original", async () => {
  const { prims, control, sink } = harness();
  const plan = { steps: ["a"] };
  const asked = prims.checkpoint("Run it?", { payload: plan, schema: PLAN });
  await until(() => control.waiting().length === 1);
  // Even one that would not match the schema: a rejection never takes an edit.
  assert.equal(control.decide({ action: "reject", payload: { steps: [] }, note: "no" }), true);
  const rejected = await asked;
  assert.deepEqual(rejected, { approved: false, note: "no", by: "cli", payload: plan, edited: false });
  assert.equal(rejected.payload, plan);
  assert.equal(ofType(sink.events, "checkpoint_resolved")[0]!.payload, undefined);

  const approved = await prims.checkpoint("Fine?", { payload: plan, timeout: 0.02, onTimeout: "approve" });
  assert.deepEqual(approved, { approved: true, note: null, by: "timeout", payload: plan, edited: false });
  assert.equal(approved.payload, plan);
  const silent = await prims.checkpoint("Fine?", { payload: "draft", timeout: 0.02, onTimeout: "reject" });
  assert.deepEqual(silent, { approved: false, note: null, by: "timeout", payload: "draft", edited: false });
});

test("the run refuses an edit off the schema, too large or not JSON: logged, and the checkpoint waits on", async () => {
  const { prims, control, sink } = harness();
  const asked = prims.checkpoint("Run it?", { payload: { steps: ["a"] }, schema: PLAN });
  await until(() => control.waiting().length === 1);

  assert.equal(control.decide({ action: "approve", payload: { steps: [] }, by: "dashboard" }), false);
  assert.equal(control.decide({ action: "approve", payload: "x".repeat(CHECKPOINT_EDIT_MAX_BYTES) }), false);
  assert.equal(control.decide({ action: "approve", payload: { n: 10n } }), false, "an in-process answer that is not JSON");
  assert.deepEqual(control.waiting(), [1], "still waiting");
  assert.deepEqual(logs(sink.events), [
    `ignored "approve" for checkpoint #1 from the dashboard: the payload does not match the checkpoint's schema: ` +
      `$.steps: expected at least 1 items, got 0 — it still waits for an answer`,
    `ignored "approve" for checkpoint #1 from the cli: the payload is ${CHECKPOINT_EDIT_MAX_BYTES + 2} bytes of JSON; ` +
      `the limit is ${CHECKPOINT_EDIT_MAX_BYTES} (256 KiB) — it still waits for an answer`,
    `ignored "approve" for checkpoint #1 from the cli: the payload is not JSON: Do not know how to serialize a BigInt — it still waits for an answer`,
  ]);

  assert.equal(control.decide({ action: "approve", payload: { steps: ["a", "c"] } }), true);
  assert.deepEqual((await asked).payload, { steps: ["a", "c"] });
});

test("an edit over 64 KiB is cut in its event, whole in the script", async () => {
  const { prims, control, sink } = harness();
  const asked = prims.checkpoint("Long?", { payload: "short" });
  await until(() => control.waiting().length === 1);
  const long = "é".repeat(60_000); // 120 KB of UTF-8: under the edit cap, over the event's
  control.decide({ action: "approve", payload: long });
  assert.equal((await asked).payload, long);
  const resolved = ofType(sink.events, "checkpoint_resolved")[0]!;
  assert.equal(resolved.edited, true);
  assert.equal(resolved.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(resolved.payload)) <= CHECKPOINT_PAYLOAD_MAX_BYTES);
});

test("a schema is checked before anything is asked; keywords ODW does not check are said, or refused under strict", async () => {
  const { prims, sink } = harness();
  const cases: Array<[unknown, RegExp]> = [
    ["object", /schema must be a JSON Schema object; got "object"/],
    [[PLAN], /schema must be a JSON Schema object; got an array/],
    [{ type: "object", requird: ["a"] }, /schema is not JSON Schema ODW can check: unknown keyword "requird" \(did you mean "required"\?\) at #/],
  ];
  for (const [schema, message] of cases) {
    await assert.rejects(prims.checkpoint("Go?", { schema } as never), (err) => err instanceof WorkflowScriptError && message.test(err.message));
  }
  assert.equal(sink.events.length, 0);

  const loose = { type: "object", properties: { n: { type: "number", minimum: 1 } } };
  await prims.checkpoint("Go?", { schema: loose, timeout: 0.01, onTimeout: "approve" });
  assert.match(logs(sink.events)[0]!, /^checkpoint #1: schema keywords ODW does not check, and nothing else will: "minimum" at #\/properties\/n/);
  const strict = harness("strict");
  await assert.rejects(strict.prims.checkpoint("Go?", { schema: loose }), /"schemaKeywords": "strict"\): "minimum" at #\/properties\/n — remove it/);
  // null means none, as for agent().
  await harness().prims.checkpoint("Go?", { schema: null as never, timeout: 0.01, onTimeout: "approve" });
});

test("checkEdit: any JSON value without a schema; the validator's problems with one", () => {
  for (const value of [null, 0, "", [], {}, { deep: [{ a: 1 }] }]) assert.deepEqual(checkEdit(value, null), { ok: true, value });
  const refused = checkEdit({ steps: "a" }, { ...PLAN, properties: { ...PLAN.properties, title: { type: "string" } }, required: ["steps", "title"] });
  assert.equal(refused.ok, false);
  assert.deepEqual(!refused.ok && refused.problems, ["$.title: required property is missing", "$.steps: expected array, got string"]);
  const big = checkEdit("x".repeat(CHECKPOINT_EDIT_MAX_BYTES), null);
  assert.equal(!big.ok && big.tooLarge, true);
  assert.equal(checkEdit(undefined, null).ok, false);
});

test("worker: an edit written to the decision log is checked on receipt; a good one runs", async () => {
  const p = project();
  try {
    const { id, run } = p.start(
      `const PLAN = ${JSON.stringify(PLAN)}\n` +
        "const r = await checkpoint('Run it?', { payload: { steps: ['a', 'b'] }, schema: PLAN })\n" +
        "return { steps: r.payload.steps, edited: r.edited }\n",
    );
    await until(() => pendingIds(p.store, id).length === 1);
    // Written by hand, skipping the CLI's check.
    p.store.requestCheckpointDecision(id, { action: "approve", checkpointId: 1, payload: { steps: "a" }, by: "cli" });
    const ignored = () => logs(p.store.readEvents(id)).filter((m) => m.startsWith('ignored "approve" for checkpoint #1'));
    await until(() => ignored().length === 1);
    assert.match(ignored()[0]!, /the payload does not match the checkpoint's schema: \$\.steps: expected array, got string — it still waits/);
    assert.deepEqual(pendingIds(p.store, id), [1]);
    p.store.requestCheckpointDecision(id, { action: "approve", checkpointId: 1, payload: { steps: ["b"] }, by: "cli" });
    assert.equal(await run, "done");
    assert.deepEqual(p.store.readResult(id), { steps: ["b"], edited: true });
    const resolved = ofType(p.store.readEvents(id), "checkpoint_resolved")[0]!;
    assert.deepEqual([resolved.edited, resolved.payload], [true, { steps: ["b"] }]);
    assert.equal(p.store.readStatus(id).waiting, null);
  } finally {
    await p.cleanup();
  }
});

test("odw logs and the attach stream say 'approved with edits'", () => {
  assert.match(
    formatEvent({ ts: 3, type: "checkpoint_resolved", checkpointId: 1, approved: true, note: "trimmed", by: "dashboard", edited: true, payload: [1] }),
    /checkpoint_resolved #1 approved with edits by dashboard — trimmed$/,
  );
  assert.match(formatEvent({ ts: 3, type: "checkpoint_resolved", checkpointId: 1, approved: true, note: null, by: "cli" }), /#1 approved by cli$/);
});

test("worker: two answers that differ only by their payload are two answers", async () => {
  const p = project();
  try {
    const { id, run } = p.start("return await parallel([() => checkpoint('A?'), () => checkpoint('B?')])\n");
    await until(() => pendingIds(p.store, id).length === 2);
    // No ids, the same `at`: each goes to the oldest still waiting.
    const line = (payload: unknown) => JSON.stringify({ action: "approve", payload, by: "cli", at: 1 }) + "\n";
    appendFileSync(p.store.decisionsPath(id), line(1) + line(2));
    assert.equal(await run, "done");
    assert.deepEqual(
      (p.store.readResult(id) as Array<{ payload: unknown }>).map((r) => r.payload),
      [1, 2],
    );
  } finally {
    await p.cleanup();
  }
});
