import { test } from "node:test";
import assert from "node:assert/strict";

import { Scheduler } from "../src/scheduler.js";
import { AgentLimitExceeded, BudgetExhausted, RunStopped } from "../src/errors.js";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test("the concurrency cap is never exceeded", async () => {
  const s = new Scheduler({ concurrency: 2, maxAgents: 1000 });
  let active = 0;
  let peak = 0;
  const task = () =>
    s.runAgent(async () => {
      active++;
      peak = Math.max(peak, active);
      await delay(15);
      active--;
      return 1;
    });
  await Promise.all([task(), task(), task(), task(), task()]);
  assert.equal(peak, 2, `peak concurrency was ${peak}`);
  assert.equal(s.dispatched, 5);
});

test("the total-agent backstop aborts after the cap", async () => {
  const s = new Scheduler({ concurrency: 4, maxAgents: 2 });
  await s.runAgent(async () => 1);
  await s.runAgent(async () => 1);
  await assert.rejects(() => s.runAgent(async () => 1), AgentLimitExceeded);
});

test("gather preserves input order; a recoverable failure becomes null", async () => {
  const s = new Scheduler({ concurrency: 4, maxAgents: 1000 });
  const out = await s.gather([
    async () => 1,
    async () => {
      throw new Error("recoverable");
    },
    async () => 3,
  ]);
  assert.deepEqual(out, [1, null, 3]);
});

test("gather re-throws a fatal error (stop / backstop)", async () => {
  const s = new Scheduler({ concurrency: 4, maxAgents: 1000 });
  await assert.rejects(
    () =>
      s.gather([
        async () => 1,
        async () => {
          throw new RunStopped("stop");
        },
      ]),
    RunStopped,
  );
});

test("the checkpoint runs before each dispatch", async () => {
  let calls = 0;
  const s = new Scheduler({
    concurrency: 2,
    maxAgents: 1000,
    checkpoint: () => {
      calls++;
    },
  });
  await Promise.all([s.runAgent(async () => 1), s.runAgent(async () => 1)]);
  assert.equal(calls, 2);
});

test("T6: a budgetGuard that throws aborts dispatch with a fatal error", async () => {
  const s = new Scheduler({
    concurrency: 2,
    maxAgents: 1000,
    budgetGuard: () => {
      // a non-stub `spent() >= total` would throw exactly like this
      throw new BudgetExhausted("over budget");
    },
  });
  await assert.rejects(() => s.runAgent(async () => "x"), BudgetExhausted);
  assert.equal(s.dispatched, 0, "a spent-out run dispatches nothing");
  // and it is fatal, so it re-throws through gather (aborts the batch) — the
  // thunks must go through runAgent, where the guard lives.
  await assert.rejects(
    () => s.gather([() => s.runAgent(async () => "a"), () => s.runAgent(async () => "b")]),
    BudgetExhausted,
  );
});

test("T6: the budget guard runs before the runaway backstop", async () => {
  // maxAgents would also reject, but the budget guard must win and abort first.
  const s = new Scheduler({
    concurrency: 1,
    maxAgents: 0,
    budgetGuard: () => {
      throw new BudgetExhausted("over budget");
    },
  });
  await assert.rejects(() => s.runAgent(async () => 1), BudgetExhausted);
});

test("T6: a non-throwing budget guard (v1 stub spent=0) leaves dispatch unchanged", async () => {
  let calls = 0;
  const s = new Scheduler({
    concurrency: 2,
    maxAgents: 1000,
    budgetGuard: () => {
      calls++; // spent() === 0 < total → never throws
    },
  });
  const r = await s.runAgent(async () => 42);
  assert.equal(r, 42);
  assert.equal(calls, 1);
  assert.equal(s.dispatched, 1);
});
