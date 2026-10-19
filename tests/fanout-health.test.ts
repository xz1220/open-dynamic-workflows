import { test } from "node:test";
import assert from "node:assert/strict";

import { defaultConfig } from "../src/adapters/config.js";
import { buildContext } from "../src/context.js";
import { AdapterExecutionError, WorkflowScriptError } from "../src/errors.js";
import { FANOUT_DONE, LOG, MemorySink, event } from "../src/events.js";
import { FanOutShortfall, requiredOk } from "../src/fanout.js";
import { createPrimitives } from "../src/primitives.js";
import { formatEvent } from "../src/runtime/live-view.js";
import { EventFold } from "../src/runtime/runs-view.js";

// Fan-out health (ODW extension; src/fanout.ts): every parallel() and
// pipeline() writes a fanout_done event with its ok / failed / null counts,
// logs once when most of it is null, and parallel()'s minOk turns a shortfall
// into an error. Without minOk, Claude Code's null semantics are unchanged.

function setup() {
  const config = defaultConfig();
  const sink = new MemorySink();
  const primitives = createPrimitives(buildContext(config, { sink }));
  return { sink, primitives };
}

const fail = (reason: "rate_limit" | "timeout") => () => {
  throw new AdapterExecutionError(`the CLI said ${reason}`, { reason });
};
const mostlyNullLogs = (sink: MemorySink) => sink.ofType(LOG).filter((e) => /most results are null/.test(String(e.message)));

test("parallel() writes fanout_done with ok, failed by reason, and null counts; results keep their nulls", async () => {
  const { sink, primitives } = setup();
  primitives.phase("Review");
  const results = await primitives.parallel([
    () => "a",
    () => undefined,
    () => null,
    fail("rate_limit"),
    fail("rate_limit"),
    () => {
      throw new TypeError("x is undefined");
    },
  ]);
  assert.deepEqual(results, ["a", undefined, null, null, null, null], "the dialect's nulls are unchanged");
  const [done, ...more] = sink.ofType(FANOUT_DONE);
  assert.equal(more.length, 0);
  assert.equal(done!.call, "parallel()");
  assert.equal(done!.phase, "Review");
  assert.deepEqual(
    { total: done!.total, ok: done!.ok, failed: done!.failed, null: done!.null, reasons: done!.reasons },
    { total: 6, ok: 2, failed: 3, null: 1, reasons: { rate_limit: 2, TypeError: 1 } },
  );
  assert.equal(done!.minOk, undefined, "no minOk, no minOk fields");
  const logs = mostlyNullLogs(sink);
  assert.equal(logs.length, 1, "4 of 6 null: one line");
  assert.equal(
    logs[0]!.message,
    "parallel() of 6 tasks: most results are null — 2 of 6 ok; 3 failed (rate_limit 2, TypeError 1); 1 returned null; " +
      "parallel(thunks, { minOk }) fails a fan-out like this instead of going on",
  );
});

test("no line when half or fewer are null, and none for an empty fan-out", async () => {
  const { sink, primitives } = setup();
  await primitives.parallel([() => 1, () => null]);
  await primitives.parallel([]);
  assert.deepEqual(mostlyNullLogs(sink), []);
  assert.equal(sink.ofType(FANOUT_DONE).length, 1, "an empty parallel() has nothing to count");
});

test("pipeline() counts its items: a stage that throws fails the item, a last stage returning null nulls it", async () => {
  const { sink, primitives } = setup();
  const out = await primitives.pipeline(
    [1, 2, 3],
    (v) => {
      if (v === 2) throw new AdapterExecutionError("slow", { reason: "timeout" });
      return v;
    },
    (v) => (v === 3 ? null : v),
  );
  assert.deepEqual(out, [1, null, null]);
  const [done] = sink.ofType(FANOUT_DONE);
  assert.deepEqual(
    { call: done!.call, total: done!.total, ok: done!.ok, failed: done!.failed, null: done!.null, reasons: done!.reasons },
    { call: "pipeline()", total: 3, ok: 1, failed: 1, null: 1, reasons: { timeout: 1 } },
  );
  const [line] = mostlyNullLogs(sink);
  assert.equal(line!.message, "pipeline() of 3 items: most results are null — 1 of 3 ok; 1 failed (timeout 1); 1 returned null");
});

test("minOk: too few ok results throw a FanOutShortfall with the counts; enough resolve as before", async () => {
  const { sink, primitives } = setup();
  const thunks = [() => 1, () => 2, fail("rate_limit"), () => null];
  await assert.rejects(primitives.parallel(thunks, { minOk: 3 }), (err: unknown) => {
    assert.ok(err instanceof FanOutShortfall);
    assert.equal(err.message, "parallel() of 4 tasks: 2 of 4 ok; 1 failed (rate_limit 1); 1 returned null — minOk 3 needs 3 ok");
    assert.equal(err.required, 3);
    assert.deepEqual({ ok: err.counts.ok, failed: err.counts.failed, null: err.counts.null }, { ok: 2, failed: 1, null: 1 });
    return true;
  });
  const shortfall = sink.ofType(FANOUT_DONE).at(-1)!;
  assert.deepEqual({ minOk: shortfall.minOk, required: shortfall.required, belowMinOk: shortfall.belowMinOk }, { minOk: 3, required: 3, belowMinOk: true });
  assert.deepEqual(mostlyNullLogs(sink), [], "the error says it: no second line");

  assert.deepEqual(await primitives.parallel(thunks, { minOk: 2 }), [1, 2, null, null]);
  assert.equal(sink.ofType(FANOUT_DONE).at(-1)!.belowMinOk, false);
  assert.deepEqual(await primitives.parallel(thunks, { minOk: 0.5 }), [1, 2, null, null], "half of 4 is 2");
  await assert.rejects(primitives.parallel(thunks, { minOk: 0.51 }), FanOutShortfall, "51% of 4 rounds up to 3");
  await assert.rejects(primitives.parallel(thunks, { minOk: "all" }), /minOk "all" needs 4 ok/);
  assert.deepEqual(await primitives.parallel(thunks, { minOk: 0 }), [1, 2, null, null]);
  assert.deepEqual(await primitives.parallel([() => 1], { minOk: "all" }), [1]);
});

test("minOk must be a whole number, a fraction or \"all\"; a shortfall inside an outer parallel() is its null slot", async () => {
  const { primitives } = setup();
  for (const bad of [-1, 1.5, "most", null, Number.NaN]) {
    await assert.rejects(primitives.parallel([() => 1], { minOk: bad as never }), (err: unknown) => {
      assert.ok(err instanceof WorkflowScriptError);
      assert.match(err.message, /parallel\(\): minOk must be a whole number of results \(3\), a fraction of them \(0\.8\) or "all"/);
      return true;
    });
  }
  await assert.rejects(primitives.parallel([() => 1], { mnOk: 1 } as never), /has no option "mnOk"; use notes, costGate or minOk/);
  const outer = await primitives.parallel([() => primitives.parallel([() => null], { minOk: 1 }), () => "kept"]);
  assert.deepEqual(outer, [null, "kept"], "recoverable: the outer fan-out goes on");
  assert.equal(requiredOk(0.8, 10), 8);
  assert.equal(requiredOk(0.8, 3), 3);
  assert.equal(requiredOk(5, 3), 5);
});

test("odw logs prints a fanout_done line; a run's detail lists its fan-outs", () => {
  const ev = event(FANOUT_DONE, { call: "parallel()", phase: "Review", total: 10, ok: 3, failed: 6, null: 1, reasons: { timeout: 2, rate_limit: 4 }, minOk: 0.8, required: 8, belowMinOk: true });
  assert.match(
    formatEvent(ev),
    /fanout_done +\[?.*parallel\(\) of 10 tasks: 3 of 10 ok; 6 failed \(rate_limit 4, timeout 2\); 1 returned null — below minOk \(8 needed\)$/,
  );
  const fold = new EventFold().apply([ev, event(FANOUT_DONE, { call: "pipeline()", total: 2, ok: 2, failed: 0, null: 0, reasons: {} }), event(FANOUT_DONE, { total: "x" })]);
  assert.deepEqual(
    fold.fanOuts.map(({ at: _at, ...f }) => f),
    [
      { call: "parallel()", phase: "Review", total: 10, ok: 3, failed: 6, null: 1, reasons: { timeout: 2, rate_limit: 4 }, required: 8, belowMinOk: true },
      { call: "pipeline()", phase: null, total: 2, ok: 2, failed: 0, null: 0, reasons: {} },
    ],
    "a malformed event is skipped",
  );
});
