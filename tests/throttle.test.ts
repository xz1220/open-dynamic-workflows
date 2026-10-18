import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";

import { collectConfigWarnings, defaultConfig, loadConfig, resolveAdapterConcurrency } from "../src/adapters/config.js";
import type { CommandRunner } from "../src/adapters/runner.js";
import type { CliResult } from "../src/adapters/types.js";
import { Bridge } from "../src/bridge.js";
import { buildContext } from "../src/context.js";
import { MemoryControl } from "../src/control.js";
import { runDoctor } from "../src/doctor.js";
import { ConfigError, RunStopped } from "../src/errors.js";
import { LOG, MemorySink } from "../src/events.js";
import { main } from "../src/cli.js";
import { createPrimitives } from "../src/primitives.js";
import { waitFor } from "../src/runtime/launcher.js";
import { attachRun, bannerLines } from "../src/runtime/live-view.js";
import { RunStore } from "../src/runtime/run-store.js";
import { executeRun } from "../src/runtime/worker.js";
import { RESTORE_MS, Scheduler, type AdapterCapChange, type AgentSlot } from "../src/scheduler.js";
import { capChangeMessage, describeConcurrency } from "../src/throttle.js";
import { FakeTerm } from "./fake-term.js";

// Per-adapter concurrency and adaptive back-pressure (ODW extensions): an
// adapter's own cap inside the run-wide one, handed out fairly, lowered by
// rate limits and given back a slot per quiet minute — in the scheduler, in
// agent(), and end to end through the worker with mock CLIs.

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Agents that hold their slots until the test finishes them, recording the
 * order they started in and how many ran at once, per adapter and in all.
 */
function harness(s: Scheduler) {
  const started: string[] = [];
  const slots = new Map<string, AgentSlot>();
  const finishers = new Map<string, () => void>();
  const running = new Map<string, number>();
  const peaks = new Map<string, number>();
  let total = 0;
  let totalPeak = 0;
  const run = (adapter: string, name: string) =>
    s.runAgent(
      async (_signal, slot) => {
        started.push(name);
        slots.set(name, slot);
        running.set(adapter, (running.get(adapter) ?? 0) + 1);
        peaks.set(adapter, Math.max(peaks.get(adapter) ?? 0, running.get(adapter)!));
        totalPeak = Math.max(totalPeak, ++total);
        await new Promise<void>((resolve) => finishers.set(name, resolve));
        running.set(adapter, running.get(adapter)! - 1);
        total--;
        return name;
      },
      { adapter },
    );
  /** Let a started agent finish, and whoever its slots go to start. */
  const finish = async (name: string) => {
    finishers.get(name)!();
    await nextTurn();
  };
  return { run, finish, started, slots, peaks, totalPeak: () => totalPeak };
}

// --- per-adapter caps in the scheduler ----------------------------------------

test("an adapter's cap holds inside the run-wide cap, and other adapters use the rest", { timeout: 2000 }, async () => {
  const s = new Scheduler({ concurrency: 4, maxAgents: 1000, adapterConcurrency: { slow: 2 } });
  const h = harness(s);
  const slow = [1, 2, 3, 4, 5].map((i) => h.run("slow", `s${i}`));
  const fast = [1, 2, 3].map((i) => h.run("fast", `f${i}`));
  await nextTurn();
  assert.deepEqual(h.started, ["s1", "s2", "f1", "f2"], "slow fills its 2 slots; fast takes the run's other 2");
  for (const name of ["s1", "f1", "s2", "f2", "s3", "f3", "s4", "s5"]) await h.finish(name);
  assert.deepEqual(await Promise.all([...slow, ...fast]), ["s1", "s2", "s3", "s4", "s5", "f1", "f2", "f3"]);
  assert.equal(h.peaks.get("slow"), 2);
  assert.equal(h.totalPeak(), 4);
  assert.equal(s.dispatched, 8);
  assert.equal(s.adapterLimit("slow"), 2);
  assert.equal(s.adapterLimit("fast"), undefined, "an adapter without a cap is held by the run-wide cap alone");
});

test("a throttled adapter never holds up another: the oldest request whose adapter has room gets the run slot", { timeout: 2000 }, async () => {
  const s = new Scheduler({ concurrency: 2, maxAgents: 1000, adapterConcurrency: { a: 1 } });
  const h = harness(s);
  const all = [h.run("a", "a1"), h.run("a", "a2"), h.run("a", "a3"), h.run("b", "b1"), h.run("b", "b2")];
  await nextTurn();
  // a2 and a3 wait for a's one slot — holding no run slot while they do — so b1 starts.
  assert.deepEqual(h.started, ["a1", "b1"]);
  await h.finish("b1");
  assert.deepEqual(h.started, ["a1", "b1", "b2"], "b2 came after a2 and a3, but a has no room: b2 gets the run slot");
  await h.finish("a1");
  assert.deepEqual(h.started, ["a1", "b1", "b2", "a2"], "first come, first served on a");
  await h.finish("a2");
  assert.deepEqual(h.started, ["a1", "b1", "b2", "a2", "a3"]);
  await h.finish("b2");
  await h.finish("a3");
  assert.deepEqual(await Promise.all(all), ["a1", "a2", "a3", "b1", "b2"]);
  assert.equal(h.peaks.get("a"), 1);
});

test("with room on both adapters, the run slot goes first come, first served", { timeout: 2000 }, async () => {
  const s = new Scheduler({ concurrency: 2, maxAgents: 1000, adapterConcurrency: { a: 2 } });
  const h = harness(s);
  const all = [h.run("a", "a1"), h.run("a", "a2"), h.run("a", "a3"), h.run("b", "b1"), h.run("a", "a4")];
  await nextTurn();
  assert.deepEqual(h.started, ["a1", "a2"]);
  await h.finish("a1");
  await h.finish("a2");
  assert.deepEqual(h.started, ["a1", "a2", "a3", "b1"]);
  await h.finish("b1");
  await h.finish("a3");
  await h.finish("a4");
  assert.deepEqual(h.started, ["a1", "a2", "a3", "b1", "a4"]);
  await Promise.all(all);
});

test("no deadlock whichever cap is smaller: the run's, the adapter's, or neither", { timeout: 5000 }, async () => {
  for (const [run, cap] of [
    [2, 5],
    [5, 2],
    [1, 1],
    [3, 3],
  ] as const) {
    const s = new Scheduler({ concurrency: run, maxAgents: 1000, adapterConcurrency: { a: cap } });
    const active = new Map<string, number>();
    const peak = new Map<string, number>();
    let total = 0;
    let totalPeak = 0;
    const work = Array.from({ length: 12 }, (_, i) => {
      const adapter = i % 3 === 0 ? "b" : "a";
      return s.runAgent(
        async () => {
          active.set(adapter, (active.get(adapter) ?? 0) + 1);
          peak.set(adapter, Math.max(peak.get(adapter) ?? 0, active.get(adapter)!));
          totalPeak = Math.max(totalPeak, ++total);
          await delay(2);
          active.set(adapter, active.get(adapter)! - 1);
          total--;
          return i;
        },
        { adapter },
      );
    });
    assert.deepEqual(await Promise.all(work), Array.from({ length: 12 }, (_, i) => i), `run ${run}, adapter ${cap}`);
    assert.ok(peak.get("a")! <= Math.min(run, cap), `run ${run}, adapter ${cap}: a ran ${peak.get("a")} at once`);
    assert.ok(totalPeak <= run, `run ${run}, adapter ${cap}: ${totalPeak} ran at once`);
    assert.equal(s.adapterLimit("a"), Math.min(run, cap), "an adapter's cap is at most the run's");
    assert.equal(await s.drain(100), true);
  }
});

/** An agent body that runs until the run is aborted, then fails with the reason. */
const untilAborted = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));

test("a stop releases requests waiting for an adapter slot, and they never start", { timeout: 2000 }, async () => {
  const control = new MemoryControl();
  const s = new Scheduler({
    concurrency: 4,
    maxAgents: 1000,
    adapterConcurrency: { a: 1 },
    checkpoint: (signal) => control.checkpoint(signal),
    watchStop: (onStop) => control.watchStop(onStop),
  });
  const first = s.runAgent(untilAborted, { adapter: "a" });
  let queuedStarted = false;
  const queued = s.runAgent(async () => void (queuedStarted = true), { adapter: "a" });
  await nextTurn();
  control.stop();
  for (const outcome of await Promise.allSettled([first, queued])) {
    assert.equal(outcome.status, "rejected");
    if (outcome.status === "rejected") assert.ok(outcome.reason instanceof RunStopped);
  }
  assert.equal(queuedStarted, false);
  assert.equal(s.dispatched, 1);
  assert.equal(await s.drain(100), true);
});

test("an agent that gets its adapter slot while the run is paused waits at the checkpoint, holding it", { timeout: 2000 }, async () => {
  const control = new MemoryControl();
  const s = new Scheduler({ concurrency: 4, maxAgents: 1000, adapterConcurrency: { a: 1 }, checkpoint: (signal) => control.checkpoint(signal) });
  const h = harness(s);
  const first = h.run("a", "a1");
  const second = h.run("a", "a2");
  await nextTurn();
  control.pause();
  await h.finish("a1");
  await nextTurn();
  assert.deepEqual(h.started, ["a1"], "a2 has the slots but is paused");
  control.resume();
  await nextTurn();
  assert.deepEqual(h.started, ["a1", "a2"]);
  await h.finish("a2");
  assert.deepEqual(await Promise.all([first, second]), ["a1", "a2"]);
});

test("a NaN adapter cap fails loudly, like the run-wide one", () => {
  assert.throws(() => new Scheduler({ concurrency: 2, maxAgents: 10, adapterConcurrency: { a: NaN } }), ConfigError);
});

// --- adaptive back-pressure: an injectable clock ---------------------------------

test("adaptive: a rate limit halves the cap once per wave, and each quiet minute gives a slot back", { timeout: 2000 }, async () => {
  let clock = 1_000_000;
  const changes: AdapterCapChange[] = [];
  const s = new Scheduler({
    concurrency: 8,
    maxAgents: 1000,
    adapterConcurrency: { codex: 4 },
    adaptive: true,
    now: () => clock,
    onAdapterCap: (change) => changes.push(change),
  });
  const h = harness(s);
  const work = ["w1", "w2", "w3", "w4"].map((name) => h.run("codex", name));
  await nextTurn();
  assert.deepEqual(h.started, ["w1", "w2", "w3", "w4"]);

  // The fan-out hit the limit together: one cut, not one per agent.
  h.slots.get("w1")!.rateLimited();
  h.slots.get("w2")!.rateLimited();
  h.slots.get("w3")!.rateLimited();
  assert.deepEqual(
    changes.map((c) => [c.reason, c.previous, c.limit]),
    [["rate_limit", 4, 2]],
  );
  assert.equal(s.adapterLimit("codex"), 2);

  work.push(...["n1", "n2", "n3"].map((name) => h.run("codex", name)));
  await nextTurn();
  await h.finish("w1");
  await h.finish("w2");
  assert.deepEqual(h.started.slice(4), [], "4 were running, the cap is 2: nobody new until fewer than 2 run");
  await h.finish("w3");
  assert.deepEqual(h.started.slice(4), ["n1"]);
  await h.finish("w4");
  assert.deepEqual(h.started.slice(4), ["n1", "n2"]);

  // An agent dispatched under the lowered cap that hits the limit again cuts again.
  h.slots.get("n1")!.rateLimited();
  assert.equal(s.adapterLimit("codex"), 1);
  assert.deepEqual(changes.at(-1), { adapter: "codex", limit: 1, previous: 2, max: 4, reason: "rate_limit", quietMs: 0 });

  // n2 was dispatched before that cut: its rate limit only starts the quiet minute over.
  clock += 30_000;
  h.slots.get("n2")!.rateLimited();
  assert.equal(changes.length, 2);
  clock += 40_000; // 70s after the cut, 40s after the latest rate limit
  assert.equal(s.adapterLimit("codex"), 1);
  clock += 20_000; // a full minute without a rate limit
  assert.equal(s.adapterLimit("codex"), 2);
  assert.deepEqual(changes.at(-1), { adapter: "codex", limit: 2, previous: 1, max: 4, reason: "restored", quietMs: 60_000 });
  assert.equal(capChangeMessage(changes.at(-1)!), null, "a slot given back on the way is not logged");

  // n3 still waits: n1 and n2 run, and the cap is 2.
  assert.deepEqual(h.started.slice(4), ["n1", "n2"]);
  await h.finish("n1");
  assert.deepEqual(h.started.slice(4), ["n1", "n2", "n3"]);

  clock += 2 * RESTORE_MS;
  assert.equal(s.adapterLimit("codex"), 4, "one slot per minute, never above its own cap");
  assert.deepEqual(changes.at(-1), { adapter: "codex", limit: 4, previous: 2, max: 4, reason: "restored", quietMs: 180_000 });
  assert.equal(
    capChangeMessage(changes.at(-1)!),
    "adaptive concurrency: no rate limit on codex for 3m — back to 4 of its agents at once",
  );
  clock += 10 * RESTORE_MS;
  assert.equal(s.adapterLimit("codex"), 4);
  assert.equal(changes.length, 4);

  await h.finish("n2");
  await h.finish("n3");
  await Promise.all(work);
  assert.equal(
    capChangeMessage(changes[0]!),
    "adaptive concurrency: codex hit a rate limit — at most 2 of its agents at once now (was 4); " +
      "one slot comes back for each minute without another",
  );
});

test("adaptive: an adapter without a cap of its own starts from the run-wide one, and never drops below 1", { timeout: 2000 }, async () => {
  const changes: AdapterCapChange[] = [];
  const s = new Scheduler({ concurrency: 6, maxAgents: 1000, adaptive: true, onAdapterCap: (change) => changes.push(change) });
  assert.equal(s.adapterLimit("gemini"), 6);
  const h = harness(s);
  const work = [h.run("gemini", "g1")];
  await nextTurn();
  h.slots.get("g1")!.rateLimited();
  assert.equal(s.adapterLimit("gemini"), 3);
  await h.finish("g1");
  for (const name of ["g2", "g3"]) {
    work.push(h.run("gemini", name));
    await nextTurn();
    h.slots.get(name)!.rateLimited();
    await h.finish(name);
  }
  assert.equal(s.adapterLimit("gemini"), 1);
  work.push(h.run("gemini", "g4"));
  await nextTurn();
  h.slots.get("g4")!.rateLimited();
  await h.finish("g4");
  assert.equal(s.adapterLimit("gemini"), 1, "never below 1");
  assert.deepEqual(
    changes.map((c) => [c.previous, c.limit]),
    [
      [6, 3],
      [3, 1],
    ],
    "at 1 a rate limit changes nothing, so nothing is said",
  );
  await Promise.all(work);
});

test("adaptive off: a rate limit leaves every cap as configured", { timeout: 2000 }, async () => {
  const changes: AdapterCapChange[] = [];
  const s = new Scheduler({
    concurrency: 8,
    maxAgents: 1000,
    adapterConcurrency: { codex: 4 },
    onAdapterCap: (change) => changes.push(change),
  });
  const h = harness(s);
  const work = h.run("codex", "c1");
  await nextTurn();
  h.slots.get("c1")!.rateLimited();
  assert.equal(s.adapterLimit("codex"), 4);
  assert.equal(s.adapterLimit("other"), undefined, "nor does an adapter without a cap get a lane");
  assert.deepEqual(changes, []);
  await h.finish("c1");
  await work;
});

// --- agent(): rate limits reach the scheduler ------------------------------------

const failing = (stderr: string): CliResult => ({ returncode: 1, stdout: "", stderr, timedOut: false, duration: 0.1 });
const ok = (stdout: string): CliResult => ({ returncode: 0, stdout, stderr: "", timedOut: false, duration: 0.1 });

/** A run context on codex (cap 4 of 8) whose bridge runs `runner` and waits out backoffs at once. */
function codexContext(runner: CommandRunner, settings: { transientRetries?: number; adaptiveConcurrency?: boolean } = {}) {
  const config = defaultConfig();
  config.settings.defaultAdapter = "codex";
  config.settings.concurrency = 8;
  config.settings.transientRetries = settings.transientRetries ?? 3;
  config.settings.adaptiveConcurrency = settings.adaptiveConcurrency ?? true;
  config.adapters.codex = { ...config.adapters.codex!, concurrency: 4 };
  const sink = new MemorySink();
  const ctx = buildContext(config, { sink });
  ctx.bridge = new Bridge(config, { runner, sleep: async () => {}, random: () => 0 });
  const cuts = () => sink.ofType(LOG).filter((e) => /^adaptive concurrency/.test(String(e.message)));
  return { ctx, primitives: createPrimitives(ctx), sink, cuts };
}

test("agent(): a fan-out that hits a 429 together halves its adapter's cap, and the log says so once", async () => {
  let calls = 0;
  const limited = new Set<string>();
  // Every agent's first CLI run is rate-limited; its retry answers.
  const { ctx, primitives, sink, cuts } = codexContext(async (_command, options) => {
    calls++;
    const prompt = options?.stdin ?? "";
    const first = !limited.has(prompt);
    limited.add(prompt);
    await nextTurn();
    return first ? failing("Error: 429 Too Many Requests") : ok("done");
  });
  const results = await primitives.parallel([0, 1, 2, 3].map((i) => () => primitives.agent(`task ${i}`, { label: `t${i}` })));
  assert.deepEqual(results, ["done", "done", "done", "done"], "each rate-limited agent was retried");
  assert.equal(calls, 8);
  assert.deepEqual(
    cuts().map((e) => [e.message, e.adapter, e.concurrency]),
    [
      [
        "adaptive concurrency: codex hit a rate limit — at most 2 of its agents at once now (was 4); " +
          "one slot comes back for each minute without another",
        "codex",
        2,
      ],
    ],
  );
  assert.equal(sink.ofType(LOG).filter((e) => /retrying in/.test(String(e.message))).length, 4, "every retry is still logged");
  assert.equal(ctx.scheduler.adapterLimit("codex"), 2);
});

test("agent(): a rate limit with no retries left lowers the cap too; adaptiveConcurrency: false leaves it", async () => {
  const limited = codexContext(async () => failing("429 Too Many Requests"), { transientRetries: 0 });
  assert.deepEqual(
    await limited.primitives.parallel([0, 1].map((i) => () => limited.primitives.agent(`task ${i}`))),
    [null, null],
  );
  assert.equal(limited.cuts().length, 1);
  assert.equal(limited.ctx.scheduler.adapterLimit("codex"), 2);

  const fixed = codexContext(async () => failing("429 Too Many Requests"), { transientRetries: 1, adaptiveConcurrency: false });
  assert.deepEqual(await fixed.primitives.parallel([() => fixed.primitives.agent("task")]), [null]);
  assert.deepEqual(fixed.cuts(), []);
  assert.equal(fixed.ctx.scheduler.adapterLimit("codex"), 4);
});

// --- config, doctor, the start banner --------------------------------------------

/** Load a config file holding `raw`. */
function loadRaw(raw: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "odw-throttle-config-"));
  try {
    const path = join(dir, "odw.config.json");
    writeFileSync(path, JSON.stringify(raw));
    return loadConfig(path, { quiet: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("config: adapter concurrency and adaptiveConcurrency — defaults and validation", () => {
  const defaults = defaultConfig();
  assert.equal(defaults.settings.adaptiveConcurrency, true);
  assert.ok(Object.values(defaults.adapters).every((a) => a.concurrency === undefined), "no built-in has a cap of its own");

  const loaded = loadRaw({
    concurrency: 6,
    adaptiveConcurrency: false,
    adapters: {
      mine: { command: ["mine"], concurrency: 3 },
      wide: { command: ["wide"], concurrency: "20" },
      unset: { command: ["unset"], concurrency: null },
    },
  });
  assert.equal(loaded.adapters.mine!.concurrency, 3);
  assert.equal(loaded.adapters.unset!.concurrency, undefined);
  assert.deepEqual(resolveAdapterConcurrency(loaded), { mine: 3, wide: 6 }, "at most the run-wide cap");
  assert.equal(loaded.settings.adaptiveConcurrency, false);
  assert.equal(loadRaw({ adaptiveConcurrency: null }).settings.adaptiveConcurrency, true);

  for (const [raw, message] of [
    [{ adapters: { x: { command: ["x"], concurrency: 0 } } }, /adapter 'x' 'concurrency' must be a positive integer; got 0/],
    [{ adapters: { x: { command: ["x"], concurrency: 1.5 } } }, /adapter 'x' 'concurrency' must be a positive integer/],
    [{ adapters: { x: { command: ["x"], concurrency: "auto" } } }, /adapter 'x' 'concurrency' must be a positive integer/],
    [{ adaptiveConcurrency: "on" }, /"adaptiveConcurrency" must be true or false/],
  ] as const) {
    assert.throws(() => loadRaw(raw), (err: unknown) => err instanceof ConfigError && message.test(err.message), JSON.stringify(raw));
  }

  assert.deepEqual(
    collectConfigWarnings({ adaptiveConcurrency: true, adapters: { mine: { command: ["mine"], concurrency: 2 } } }),
    [],
  );
  assert.deepEqual(collectConfigWarnings({ adapters: { mine: { command: ["mine"], concurency: 2 } } }), [
    'adapter "mine": unknown field "concurency" is ignored — did you mean "concurrency"?',
  ]);
});

test("describeConcurrency: the run's caps in a line, and with details whether rate limits move them", () => {
  const config = defaultConfig();
  config.settings.concurrency = 4;
  assert.equal(describeConcurrency(config), "4 agents at once");
  config.adapters.codex = { ...config.adapters.codex!, concurrency: 2 };
  config.adapters.gemini = { ...config.adapters.gemini!, concurrency: 9 };
  assert.equal(describeConcurrency(config), "4 agents at once · per adapter: codex 2, gemini 4");
  assert.match(
    describeConcurrency(config, { details: true }),
    /^4 agents at once · per adapter: codex 2, gemini 4 · a rate limit halves its adapter's cap( · |$)/,
  );
  config.settings.adaptiveConcurrency = false;
  config.settings.concurrency = 1;
  assert.match(
    describeConcurrency(config, { details: true }),
    /^1 agent at once · per adapter: codex 1, gemini 1 · adaptive back-pressure off( · |$)/,
  );
  config.settings.concurrency = null;
  assert.match(describeConcurrency(config), /^\d+ agents? at once \(auto\) · per adapter: /);
});

test("odw doctor shows the caps a run gets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-throttle-doctor-"));
  try {
    const path = join(dir, "odw.config.json");
    writeFileSync(
      path,
      JSON.stringify({
        runsRoot: join(dir, "runs"),
        concurrency: 6,
        adapters: { only: { command: ["definitely-not-installed-odw-cli"], concurrency: 2 } },
      }),
    );
    const report = await runDoctor({ config: loadConfig(path, { quiet: true }), configPath: path, cwd: dir, smoke: [] });
    const check = report.checks.find((c) => c.id === "concurrency")!;
    assert.equal(check.status, "ok");
    assert.equal(check.title, "Concurrency");
    assert.match(check.detail, /^6 agents at once · per adapter: only 2 · a rate limit halves its adapter's cap( · |$)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the start banner -------------------------------------------------------------

/** Run the CLI with stdout/stderr captured (node:test's own buffer writes pass through). */
async function cli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  (process.stdout as { write: unknown }).write = (s: unknown) => {
    if (Buffer.isBuffer(s)) return so(s);
    out.push(String(s));
    return true;
  };
  (process.stderr as { write: unknown }).write = (s: unknown) => {
    if (Buffer.isBuffer(s)) return se(s);
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

test("odw run's start banner states the run's caps under its permissions line, waiting or detached", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-throttle-banner-"));
  try {
    const configPath = join(root, "odw.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        concurrency: 3,
        defaultAdapter: "quick",
        adapters: { quick: { command: [execPath, "-e", "process.stdout.write('ok')"], concurrency: 2 } },
      }),
    );
    const script = join(root, "banner.js");
    writeFileSync(script, "export const meta = { name: 'banner', description: 'd' }\nreturn await agent('hello')\n");
    const runsRoot = join(root, "runs");
    const flags = ["--config", configPath, "--runs-root", runsRoot, "--source", root];
    const caps = "concurrency: 3 agents at once · per adapter: quick 2\n";

    let r = await cli(["run", script, "--wait", ...flags]);
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out), "ok");
    assert.match(r.err, /^running \S+ \.\.\.\npermissions: [^\n]+\ntrust: trusted\nconcurrency: 3 agents at once · per adapter: quick 2\n/);

    r = await cli(["run", script, "-d", ...flags]);
    assert.equal(r.code, 0, r.err);
    const id = r.out.trim();
    assert.ok(r.err.startsWith(`started run ${id} (use 'odw status ${id}')\npermissions: `), r.err);
    assert.ok(r.err.endsWith(`\n${caps}`), r.err);
    assert.equal((await waitFor(new RunStore(runsRoot), id, { timeoutMs: 15_000, pollIntervalMs: 20 })).state, "done");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a start banner of several lines shows each: under the live view's header, first in the line stream", async () => {
  assert.deepEqual(bannerLines(undefined), []);
  assert.deepEqual(bannerLines("one\n\n\u001b[31mtwo\u001b[0m\n"), ["one", "two"], "each line sanitized, blank ones dropped");
  const store = new RunStore(mkdtempSync(join(tmpdir(), "odw-throttle-live-")));
  try {
    const banner = "permissions: edit — quick edit\nconcurrency: 3 agents at once · per adapter: quick 2";
    for (const live of [true, false]) {
      const runId = store.create({ script: "/x/wf.js", args: null, source: process.cwd(), workflowName: "demo" });
      store.updateStatus(runId, { state: "done", pid: process.pid, name: "demo" });
      store.writeResult(runId, "ok");
      const err = live ? new FakeTerm(200) : { chunks: [] as string[], isTTY: false, write(s: string) { this.chunks.push(s); } };
      const out = { write: () => {} };
      assert.equal(await attachRun(store, runId, { out, err, live, signals: false, env: { TERM: "xterm" }, banner }), 0);
      if (err instanceof FakeTerm) {
        assert.match(
          err.lines.join("\n"),
          /\^C detaches.*\n {2}permissions: edit — quick edit\n {2}concurrency: 3 agents at once · per adapter: quick 2\n/,
        );
      } else {
        assert.deepEqual(err.chunks.slice(0, 2), ["permissions: edit — quick edit\n", "concurrency: 3 agents at once · per adapter: quick 2\n"]);
      }
    }
  } finally {
    rmSync(store.root, { recursive: true, force: true });
  }
});

// --- end to end: the worker, mock CLIs that record how many run at once ----------

/**
 * A mock CLI that appends `+<name>` to `log` when it starts and `-<name>` just
 * before it answers (O_APPEND writes: concurrent agents never lose a line),
 * so the log replays how many ran at once. It answers `ms` after `meet` of
 * its kind have started (or 5s), so the first `meet` surely overlap — however
 * slowly a loaded machine starts processes — when the caps let them.
 */
function trackingAgent(log: string, name: string, ms: number, meet = 0): string[] {
  const file = JSON.stringify(log);
  return [
    execPath,
    "-e",
    `const fs = require('fs'); fs.appendFileSync(${file}, '+${name}\\n');` +
      `const started = () => fs.readFileSync(${file}, 'utf8').split('\\n').filter((l) => l === '+${name}').length;` +
      `const deadline = Date.now() + 5000;` +
      `const answer = () => setTimeout(() => { fs.appendFileSync(${file}, '-${name}\\n'); process.stdout.write('${name} done'); }, ${ms});` +
      `const wait = () => (started() >= ${meet} || Date.now() > deadline ? answer() : setTimeout(wait, 10));` +
      `wait();`,
  ];
}

/** The most `+name` lines open at once in a tracking log, per name and in all. */
function peaks(log: string): { byName: Map<string, number>; total: number; order: string[] } {
  const open = new Map<string, number>();
  const byName = new Map<string, number>();
  const order: string[] = [];
  let total = 0;
  let peak = 0;
  for (const line of readFileSync(log, "utf8").split("\n").filter(Boolean)) {
    const name = line.slice(1);
    const delta = line[0] === "+" ? 1 : -1;
    if (delta > 0) order.push(name);
    open.set(name, (open.get(name) ?? 0) + delta);
    byName.set(name, Math.max(byName.get(name) ?? 0, open.get(name)!));
    total += delta;
    peak = Math.max(peak, total);
  }
  return { byName, total: peak, order };
}

test("end to end: an adapter's cap holds across a fan-out, and other adapters run beside it", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-throttle-e2e-"));
  try {
    const log = join(root, "running.log");
    const configPath = join(root, "odw.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        concurrency: 4,
        adapters: {
          // The first two slow agents wait for each other: slow surely reaches its cap.
          slow: { command: trackingAgent(log, "slow", 150, 2), concurrency: 2 },
          fast: { command: trackingAgent(log, "fast", 150) },
        },
      }),
    );
    const script = join(root, "caps.js");
    writeFileSync(
      script,
      "export const meta = { name: 'caps', description: 'd' }\n" +
        "const slow = [1, 2, 3, 4, 5, 6].map((i) => () => agent('slow ' + i, { adapter: 'slow', label: 's' + i }))\n" +
        "const fast = [1, 2, 3].map((i) => () => agent('fast ' + i, { adapter: 'fast', label: 'f' + i }))\n" +
        "return await parallel([...slow, ...fast])\n",
    );
    const store = new RunStore(join(root, "runs"));
    const id = store.create({ script, args: null, source: root, configPath });
    assert.equal(await executeRun(store.runDir(id)), "done");
    assert.deepEqual(store.readResult(id), [...Array(6).fill("slow done"), ...Array(3).fill("fast done")]);

    const { byName, total, order } = peaks(log);
    assert.equal(byName.get("slow"), 2, "never more than slow's 2 at once — and it reached them");
    assert.ok(total <= 4, `the run-wide cap holds: ${total} at once`);
    const thirdSlow = order.findIndex((name, i) => name === "slow" && order.slice(0, i + 1).filter((n) => n === "slow").length === 3);
    assert.ok(order.indexOf("fast") < thirdSlow, `fast did not wait behind slow's queue: ${order.join(" ")}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A mock CLI that prints `stderr` and exits 1 on its first `limitedRuns`
 * invocations (counted in `counter`, one O_APPEND byte each), then answers.
 */
function limitedAgent(counter: string, limitedRuns: number, stderr: string): string[] {
  const file = JSON.stringify(counter);
  return [
    execPath,
    "-e",
    `const fs = require('fs'); fs.appendFileSync(${file}, '.'); const n = fs.statSync(${file}).size - 1;` +
      `if (n < ${limitedRuns}) { setTimeout(() => { process.stderr.write(${JSON.stringify(stderr)}); process.exit(1); }, 100); }` +
      `else process.stdout.write('answered on run ' + (n + 1));`,
  ];
}

test("end to end: a fan-out rate-limited together halves its adapter's cap once, and the run goes on", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-throttle-429-"));
  try {
    const configPath = join(root, "odw.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        concurrency: 8,
        defaultAdapter: "flaky",
        adapters: {
          flaky: { command: limitedAgent(join(root, "calls"), 4, "Error: 429 Too Many Requests. Please retry after 0.05s\n"), concurrency: 4 },
        },
      }),
    );
    const script = join(root, "limited.js");
    writeFileSync(
      script,
      "export const meta = { name: 'limited', description: 'd' }\n" +
        "return await parallel([1, 2, 3, 4].map((i) => () => agent('task ' + i, { label: 't' + i })))\n",
    );
    const store = new RunStore(join(root, "runs"));
    const id = store.create({ script, args: null, source: root, configPath });
    assert.equal(await executeRun(store.runDir(id)), "done");
    assert.equal((store.readResult(id) as string[]).length, 4);
    const messages = store
      .readEvents(id)
      .filter((e) => e.type === "log")
      .map((e) => String(e.message));
    assert.deepEqual(
      messages.filter((m) => m.startsWith("adaptive concurrency")),
      [
        "adaptive concurrency: flaky hit a rate limit — at most 2 of its agents at once now (was 4); " +
          "one slot comes back for each minute without another",
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
