import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectConfigWarnings, defaultConfig, loadConfig } from "../src/adapters/config.js";
import type { CommandRunner } from "../src/adapters/runner.js";
import type { CliResult, Config, Settings } from "../src/adapters/types.js";
import { Bridge, type QuotaResume, type TranscriptSink } from "../src/bridge.js";
import { MemoryControl } from "../src/control.js";
import { AdapterExecutionError, ConfigError, RunStopped } from "../src/errors.js";
import {
  clockTime,
  pausedText,
  quotaPauseMessage,
  QuotaWaits,
  RESUME_JITTER_MS,
  type QuotaPause,
  type QuotaPauseChange,
} from "../src/quota-wait.js";
import { FileControl } from "../src/runtime/file-control.js";
import { Scheduler } from "../src/scheduler.js";

// Pause for a spent quota (ODW extension: quotaWait): a call whose chain is out
// of quota waits for the reset its CLI named — holding no slot — and starts
// over. In the config, the run's pauses, the control, the scheduler, the bridge
// and agent(), on a test clock with a fake CLI; the run end to end — the
// worker, what readers show, the hooks — is in quota-wait-run.test.ts.

const ok = (stdout: string): CliResult => ({ returncode: 0, stdout, stderr: "", timedOut: false, duration: 0.1 });
const failing = (stderr: string): CliResult => ({ returncode: 1, stdout: "", stderr, timedOut: false, duration: 0.1 });

// What the CLIs print, as tests/failures.test.ts samples them.
const QUOTA = "You've hit your usage limit. Upgrade to Pro or try again in 3h 22m."; // resets in 12,120s
const QUOTA_1H = "You've hit your usage limit. Upgrade to Pro or try again in 1h."; // resets in 3,600s
const NO_RESET = "Credit balance is too low"; // a spent quota that names no reset
const RESET_MS = 12_120_000;
const HOUR = 3600;

/** The test clock's start: 02:00 UTC — overnight, when quotas run out. */
const T0 = Date.UTC(2026, 9, 17, 2, 0);

/**
 * A clock whose sleeps last until the test moves it past them — or until the
 * sleep's signal aborts, as a sleep must. `requested` keeps every sleep asked for.
 */
function testClock(start = T0) {
  let now = start;
  const sleepers = new Set<{ until: number; wake: () => void }>();
  const requested: number[] = [];
  return {
    now: () => now,
    requested,
    sleep: (ms: number, signal?: AbortSignal) =>
      new Promise<void>((resolve) => {
        requested.push(ms);
        if (signal?.aborted) return resolve();
        const sleeper = {
          until: now + ms,
          wake: (): void => {
            sleepers.delete(sleeper);
            signal?.removeEventListener("abort", sleeper.wake);
            resolve();
          },
        };
        signal?.addEventListener("abort", sleeper.wake, { once: true });
        sleepers.add(sleeper);
      }),
    /** Move the clock on by `ms`, waking every sleep due by then. */
    advance(ms: number): void {
      now += ms;
      for (const sleeper of [...sleepers]) if (sleeper.until <= now) sleeper.wake();
    },
    get sleeping(): number {
      return sleepers.size;
    },
  };
}

/** Adapters of the user's own — `a`, `b`, `c` — with quotaWait on (6 hours at most). */
function quotaConfig(settings: Partial<Settings> = {}): Config {
  const config = defaultConfig();
  for (const name of ["a", "b", "c"]) config.adapters[name] = { name, command: [`${name}-cli`], stdin: "{prompt}" };
  config.settings.defaultAdapter = "a";
  config.settings.concurrency = 4;
  config.settings.quotaWait = { max: 6 * HOUR };
  Object.assign(config.settings, settings);
  return config;
}

/** A fake CLI: each adapter answers from its queue of replies — `<adapter> answered` once that is empty. */
function fakeCli(replies: Record<string, CliResult[]> = {}) {
  const calls: string[] = [];
  const runner: CommandRunner = async (command) => {
    const adapter = command[0]!.replace(/-cli$/, "");
    calls.push(adapter);
    return replies[adapter]?.shift() ?? ok(`${adapter} answered`);
  };
  return { runner, calls };
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition did not become true in time");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

const settle = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 20));

// --- config -------------------------------------------------------------------------------

test("config: quotaWait is off unless set — { max } turns it on — and anything else is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-quota-config-"));
  const load = (raw: unknown): Settings["quotaWait"] => {
    const path = join(dir, "odw.config.json");
    writeFileSync(path, JSON.stringify(raw));
    return loadConfig(path, { quiet: true }).settings.quotaWait;
  };
  try {
    assert.equal(defaultConfig().settings.quotaWait, false);
    for (const raw of [{}, { quotaWait: false }, { quotaWait: null }]) assert.equal(load(raw), false, JSON.stringify(raw));
    assert.deepEqual(load({ quotaWait: { max: 21600 } }), { max: 21600 });
    assert.deepEqual(load({ quotaWait: { max: "3600" } }), { max: 3600 }, "a numeric string, like every number setting");
    const refused: Array<[unknown, RegExp]> = [
      [true, /^"quotaWait" must be false, or \{ "max": <seconds> \}: the longest a run waits for a spent quota to reset; got true$/],
      [{}, /^"quotaWait" must be false, or \{ "max": <seconds> \}/],
      [3600, /^"quotaWait" must be false/],
      [{ max: 0 }, /^"quotaWait\.max" must be a positive number of seconds; got 0$/],
      [{ max: -60 }, /^"quotaWait\.max" must be a positive number of seconds/],
      [{ max: "6h" }, /^"quotaWait\.max" must be a positive number of seconds; got "6h"$/],
    ];
    for (const [quotaWait, error] of refused) {
      assert.throws(() => load({ quotaWait }), (err: Error) => err instanceof ConfigError && error.test(err.message), JSON.stringify(quotaWait));
    }
    assert.deepEqual(collectConfigWarnings({ quotaWait: { max: 60 } }), [], "a known key");
    assert.deepEqual(collectConfigWarnings({ quotaWait: { max: 60, maxx: 1 } }), [
      'quotaWait: unknown field "maxx" is ignored — did you mean "max"?',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the coordinator ---------------------------------------------------------------------

test("QuotaWaits: the first call starts a pause, the rest join it; the first back ends it, each after its own jitter", async () => {
  const clock = testClock();
  const changes: QuotaPauseChange[] = [];
  const back: string[] = [];
  const jitters = [0.5, 0.25];
  const quota = new QuotaWaits({
    now: clock.now,
    sleep: clock.sleep,
    random: () => jitters.shift() ?? 0,
    onChange: (change) => changes.push(change),
    onBack: (adapter) => back.push(adapter),
  });
  assert.equal(quota.isOut("a"), false);
  quota.noteReset("a", 3600);
  assert.equal(quota.resetOf("a"), T0 + 3_600_000);
  assert.deepEqual([quota.isOut("a"), quota.isPaused("a")], [true, false], "out until its reset; paused once a call waits");
  quota.noteReset("a", 600);
  assert.equal(quota.resetOf("a"), T0 + 3_600_000, "the latest reset named holds");

  const first = quota.wait("a");
  const second = quota.wait("a");
  await until(() => clock.sleeping === 2);
  assert.deepEqual(changes, [{ pause: { adapter: "a", resumeAt: T0 / 1000 + 3600 }, change: "started" }]);
  assert.deepEqual(clock.requested, [3_600_000 + RESUME_JITTER_MS / 2, 3_600_000 + RESUME_JITTER_MS / 4]);
  // A later reset named meanwhile moves the pause.
  quota.noteReset("a", 7200);
  assert.deepEqual(changes[1], { pause: { adapter: "a", resumeAt: T0 / 1000 + 7200 }, change: "extended" });
  clock.advance(3_600_000 + RESUME_JITTER_MS);
  await settle();
  assert.equal(clock.sleeping, 2, "both sleep on, to the later reset");
  clock.advance(T0 + 7_200_000 + RESUME_JITTER_MS / 4 - clock.now());
  assert.equal(await second, "reset", "the one with less jitter comes back first, and ends the pause");
  assert.deepEqual(changes.map((c) => c.change), ["started", "extended", "reset"]);
  assert.deepEqual([quota.isPaused("a"), quota.isOut("a"), quota.resetOf("a"), back], [false, false, undefined, ["a"]]);
  assert.equal(clock.sleeping, 1, "the other still sleeps its own jitter");
  clock.advance(RESUME_JITTER_MS);
  assert.equal(await first, "reset");
  assert.equal(changes.length, 3, "one pause, ended once");
});

test("QuotaWaits: a resume ends every pause at once, without jitter; calls that leave with the run withdraw theirs", async () => {
  const clock = testClock();
  const changes: QuotaPauseChange[] = [];
  let resume!: () => void;
  let watching = 0;
  const quota = new QuotaWaits({
    now: clock.now,
    sleep: clock.sleep,
    random: () => 0.9,
    onChange: (change) => changes.push(change),
    watchResume: (onResume) => {
      resume = onResume;
      watching++;
      return () => void watching--;
    },
  });
  quota.noteReset("a", 3600);
  quota.noteReset("b", 7200);
  const onA = quota.wait("a");
  const onB = quota.wait("b");
  await until(() => clock.sleeping === 2);
  assert.equal(watching, 1, "one watch, while calls wait");
  resume();
  assert.deepEqual(await Promise.all([onA, onB]), ["resumed", "resumed"]);
  assert.equal(clock.now(), T0, "at once");
  assert.deepEqual(changes.map((c) => `${c.pause.adapter} ${c.change}`), ["a started", "b started", "a resumed", "b resumed"]);
  assert.equal(watching, 0);
  assert.deepEqual([quota.isOut("a"), quota.isOut("b")], [false, false], "both are back: their resets are forgotten");

  // A stop: the run's signal aborts with its reason, and the pause is withdrawn.
  quota.noteReset("a", 3600);
  const run = new AbortController();
  const waiting = quota.wait("a", run.signal);
  await until(() => clock.sleeping === 1);
  const reason = new RunStopped("run was stopped");
  run.abort(reason);
  await assert.rejects(waiting, (err) => err === reason);
  assert.deepEqual(changes.at(-1), { pause: { adapter: "a", resumeAt: T0 / 1000 + 3600 }, change: "withdrawn" });
  assert.equal(quota.isPaused("a"), false);
});

test("the pause in words: until when, for which adapter; the run's log line for each change", () => {
  const at = T0 / 1000 + 12_120;
  const time = clockTime(at, T0);
  assert.match(time, /^\d\d:\d\d$/, "the same day: the time alone");
  assert.equal(pausedText({ adapter: "codex", resumeAt: at }, T0), `paused until ${time} (codex quota)`);
  const later = new Date((at + 3 * 86_400) * 1000);
  assert.match(clockTime(at + 3 * 86_400, T0), new RegExp(`^[A-Z][a-z]{2} ${later.getDate()} \\d\\d:\\d\\d$`), "another day: with the date");

  const pause = { adapter: "codex", resumeAt: at };
  assert.equal(
    quotaPauseMessage({ pause, change: "started" }, T0),
    `quota pause: codex is out of usage quota until ${time} (in 3h 22m) — its agents wait, holding no slot, and go on then (quotaWait); odw resume goes on now`,
  );
  assert.equal(
    quotaPauseMessage({ pause, change: "extended" }, T0 + 60_000),
    `quota pause: codex is out of usage quota until ${time} (in 3h 21m), later than it said before`,
  );
  assert.equal(quotaPauseMessage({ pause, change: "reset" }, T0), "quota pause over: codex's quota reset — its agents go on");
  assert.equal(quotaPauseMessage({ pause, change: "resumed" }, T0), "quota pause over: the run was resumed — codex's agents go on now");
  assert.equal(quotaPauseMessage({ pause, change: "withdrawn" }, T0), null, "a run that ended under its pause says so itself");
});

// --- control ---------------------------------------------------------------------------

test("control: a resume asked for while the run watches is heard — one already in the control file is not", async () => {
  const memory = new MemoryControl();
  let heard = 0;
  const stop = memory.watchResume(() => heard++);
  memory.resume();
  stop();
  memory.resume();
  assert.equal(heard, 1);

  let request: { action: string | null; at: number | null } | null = { action: "resume", at: 1 }; // answered before
  const file = new FileControl({ readAction: () => request?.action ?? null, readRequest: () => request, watchIntervalMs: 5 });
  let resumed = 0;
  const unwatch = file.watchResume(() => resumed++);
  try {
    await settle();
    assert.equal(resumed, 0, "a resume already there is not a new one");
    request = { action: "pause", at: 2 };
    await settle();
    assert.equal(resumed, 0);
    request = { action: "resume", at: 3 };
    await until(() => resumed === 1);
    request = { action: "resume", at: 4 };
    await until(() => resumed === 2, 2000);
    request = null; // unreadable for a moment
    await settle();
    assert.equal(resumed, 2);
  } finally {
    unwatch();
  }
  request = { action: "resume", at: 5 };
  await settle();
  assert.equal(resumed, 2, "no longer watched");

  // Without the request whole, a change of action to "resume" is one.
  let action = "resume";
  const bare = new FileControl({ readAction: () => action, watchIntervalMs: 5 });
  let bareResumed = 0;
  const unwatchBare = bare.watchResume(() => bareResumed++);
  try {
    await settle();
    action = "pause";
    await settle();
    action = "resume";
    await until(() => bareResumed === 1);
  } finally {
    unwatchBare();
  }
});

// --- the scheduler --------------------------------------------------------------------------

test("AgentSlot.release lets another agent have both slots; moveTo takes a pair back, ahead of agents not started", async () => {
  const s = new Scheduler({ concurrency: 1, maxAgents: 10, adapterConcurrency: { a: 1 } });
  const order: string[] = [];
  const gates = new Map<string, () => void>();
  const hold = (name: string) => new Promise<void>((resolve) => gates.set(name, resolve));
  const x = s.runAgent(async (_signal, slot) => {
    order.push("x");
    slot.release();
    slot.release(); // a second time changes nothing
    await hold("x");
    await slot.moveTo("a");
    order.push("x again");
  }, { adapter: "a" });
  const y = s.runAgent(async () => {
    order.push("y");
    await hold("y");
  }, { adapter: "a" });
  await until(() => order.length === 2);
  assert.deepEqual(order, ["x", "y"], "y has the run's only slot, and a's, while x waits");
  const z = s.runAgent(async () => void order.push("z"), { adapter: "b" });
  gates.get("x")!();
  await settle();
  gates.get("y")!();
  await Promise.all([x, y, z]);
  assert.deepEqual(order, ["x", "y", "x again", "z"], "x takes the pair back before z, which had not started");
  assert.equal(s.dispatched, 3, "taking the slots back is no dispatch");
  assert.equal(await s.drain(100), true);
});

test("a stop reaches a request held at its gate: the stop watch is armed while it waits", async () => {
  let onStop!: () => void;
  let watching = 0;
  const s = new Scheduler({
    concurrency: 1,
    maxAgents: 10,
    watchStop: (stop) => {
      onStop = stop;
      watching++;
      return () => void watching--;
    },
  });
  let ran = false;
  const held = s.runAgent(
    async () => {
      ran = true;
    },
    { gate: (signal) => new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })) },
  );
  await until(() => watching === 1);
  onStop();
  await assert.rejects(held, RunStopped);
  assert.deepEqual([ran, watching, s.dispatched], [false, 0, 0]);
});

// --- the bridge -----------------------------------------------------------------------------

test("bridge: a call whose chain is out of quota waits for the reset its CLI named, then starts over", async () => {
  const clock = testClock();
  const { runner, calls } = fakeCli({ a: [failing(QUOTA)] });
  const changes: QuotaPauseChange[] = [];
  const waits: QuotaPause[] = [];
  const resumes: QuotaResume[] = [];
  const runs: Array<[string | undefined, string | undefined]> = [];
  const transcript: TranscriptSink = { beginRun: (why, adapter) => void runs.push([why, adapter?.name]), stdout() {}, stderr() {}, endRun() {} };
  const bridge = new Bridge(quotaConfig(), {
    runner,
    sleep: clock.sleep,
    now: clock.now,
    random: () => 0,
    onQuotaPause: (change) => changes.push(change),
  });
  const run = bridge.run(
    { prompt: "x" },
    { onQuotaWait: (wait) => void waits.push(wait), onQuotaResume: (resume) => void resumes.push(resume), transcript },
  );
  await until(() => clock.sleeping === 1);
  const resumeAt = T0 / 1000 + 12_120;
  assert.deepEqual(waits, [{ adapter: "a", resumeAt }]);
  assert.deepEqual(changes, [{ pause: { adapter: "a", resumeAt }, change: "started" }]);
  assert.equal(bridge.route("a").start, -1, "the run passes over a while it waits");
  clock.advance(RESET_MS - 1);
  await settle();
  assert.equal(clock.sleeping, 1, "not a moment before its reset");
  clock.advance(1);
  const out = await run;
  assert.deepEqual([out.value, out.adapter, out.fellBackFrom], ["a answered", "a", undefined]);
  assert.deepEqual(calls, ["a", "a"]);
  assert.deepEqual(resumes, [{ adapter: "a", fellBackFrom: [] }]);
  assert.deepEqual(runs, [[undefined, "a"], ["quota_wait", "a"]], "its transcript says why it ran again");
  assert.deepEqual(changes.map((c) => c.change), ["started", "reset"]);
  assert.equal(bridge.route("a").start, 0, "and passes over it no more");
});

test("bridge: off by default — a spent quota fails the call at once, as before", async () => {
  const clock = testClock();
  const { runner, calls } = fakeCli({ a: [failing(QUOTA), failing(QUOTA)] });
  const bridge = new Bridge(quotaConfig({ quotaWait: false }), { runner, sleep: clock.sleep, now: clock.now });
  for (let i = 0; i < 2; i++) {
    await assert.rejects(
      bridge.run({ prompt: "x" }),
      (err: Error) => err instanceof AdapterExecutionError && err.reason === "quota" && /^adapter 'a' ran out of usage quota/.test(err.message),
    );
  }
  assert.deepEqual([calls.length, clock.requested], [2, []], "each call tried a, and nothing waited");
});

test("bridge: a reset past quotaWait.max, or none named, fails the call as before — and the run says why, once each", async () => {
  const clock = testClock();
  const { runner, calls } = fakeCli({ a: [failing(QUOTA)], b: [failing(NO_RESET), failing(NO_RESET)] });
  const notes: string[] = [];
  const bridge = new Bridge(quotaConfig({ quotaWait: { max: HOUR } }), { runner, sleep: clock.sleep, now: clock.now });
  const onNote = (message: string): void => void notes.push(message);
  await assert.rejects(
    bridge.run({ prompt: "x", adapter: ["a"] }, { onNote }),
    (err: Error) => err instanceof AdapterExecutionError && err.retryAfter === 12_120 && /^adapter 'a' ran out of usage quota/.test(err.message),
  );
  // a is out until its reset: the next call on it fails at once, saying when it comes back.
  await assert.rejects(
    bridge.run({ prompt: "x", adapter: ["a"] }, { onNote }),
    (err: Error) =>
      err instanceof AdapterExecutionError &&
      err.reason === "quota" &&
      err.retryAfter === 12_120 &&
      /^adapter 'a' is out of usage quota \(quota resets: 'a' in 3h 22m\) — wait for the quota window to reset/.test(err.message),
  );
  for (let i = 0; i < 2; i++) {
    await assert.rejects(
      bridge.run({ prompt: "x", adapter: ["b"] }, { onNote }),
      (err: Error) => err instanceof AdapterExecutionError && err.reason === "quota" && err.retryAfter === undefined,
    );
  }
  assert.deepEqual(notes, [
    "quotaWait: not waiting — a's quota resets in 3h 22m, past quotaWait.max (1h), so the agent fails",
    "quotaWait: not waiting — b did not say when its quota resets, so the agent fails",
  ]);
  assert.deepEqual([calls, clock.requested], [["a", "b", "b"], []]);
});

test("bridge: a chain spent on quota waits for its first reset and starts over from its start, past adapters still out", async () => {
  const clock = testClock();
  const { runner, calls } = fakeCli({ a: [failing(QUOTA)], b: [failing(QUOTA_1H)] });
  const resumes: QuotaResume[] = [];
  const changes: QuotaPauseChange[] = [];
  const runs: Array<[string | undefined, string | undefined]> = [];
  const transcript: TranscriptSink = { beginRun: (why, adapter) => void runs.push([why, adapter?.name]), stdout() {}, stderr() {}, endRun() {} };
  const bridge = new Bridge(quotaConfig({ fallback: { a: ["b"] } }), {
    runner,
    sleep: clock.sleep,
    now: clock.now,
    random: () => 0,
    onQuotaPause: (change) => changes.push(change),
  });
  const run = bridge.run({ prompt: "x" }, { onQuotaResume: (resume) => void resumes.push(resume), transcript });
  await until(() => clock.sleeping === 1);
  assert.deepEqual(changes, [{ pause: { adapter: "b", resumeAt: T0 / 1000 + HOUR }, change: "started" }], "b resets first");
  clock.advance(HOUR * 1000);
  const out = await run;
  assert.deepEqual([out.value, out.adapter, out.fellBackFrom], ["b answered", "b", ["a"]]);
  assert.deepEqual(calls, ["a", "b", "b"], "a's quota is still out: the call starts over on b");
  assert.deepEqual(resumes, [{ adapter: "b", fellBackFrom: ["a"] }]);
  assert.deepEqual(runs, [[undefined, "a"], ["fallback", "b"], ["quota_wait", "b"]]);

  // Until a's reset, the run's calls start past it; then on it again.
  assert.equal(bridge.route("a").start, 1);
  assert.equal((await bridge.run({ prompt: "y" })).adapter, "b");
  clock.advance(RESET_MS);
  assert.equal(bridge.route("a").start, 0);
  assert.equal((await bridge.run({ prompt: "z" })).adapter, "a");
});

test("bridge: a call that cannot start waits for the first reset of its chain before it is dispatched (awaitQuota)", async () => {
  const clock = testClock();
  const { runner } = fakeCli({ a: [failing(QUOTA)] });
  const bridge = new Bridge(quotaConfig(), { runner, sleep: clock.sleep, now: clock.now, random: () => 0 });
  assert.equal(await bridge.awaitQuota(bridge.route("a")), false, "one that can start does not wait");
  const first = bridge.run({ prompt: "x" });
  await until(() => clock.sleeping === 1);
  const route = bridge.route("a");
  assert.equal(route.start, -1);
  const waited = bridge.awaitQuota(route);
  await until(() => clock.sleeping === 2);
  clock.advance(RESET_MS);
  assert.equal(await waited, true);
  assert.equal(bridge.route("a").start, 0, "routed again, it starts on a");
  assert.equal((await first).value, "a answered");
  // With no reset named, nothing waits: the call fails at once once dispatched.
  const unknown = new Bridge(quotaConfig({ quotaBreaker: 1 }), { runner: fakeCli({ a: [failing(NO_RESET)] }).runner });
  await assert.rejects(unknown.run({ prompt: "x" }));
  assert.equal(await unknown.awaitQuota(unknown.route("a")), false);
});

test("bridge: a resume ends the wait at once and the quota breaker forgets the adapter; a stop ends it with the run", async () => {
  const clock = testClock();
  // A CLI whose runs answer when the test says, in the order it says.
  const held: Array<(result: CliResult) => void> = [];
  const runner: CommandRunner = () => new Promise<CliResult>((resolve) => held.push(resolve));
  let resume!: () => void;
  let watching = 0;
  const changes: QuotaPauseChange[] = [];
  const warnings: string[] = [];
  const bridge = new Bridge(quotaConfig({ quotaBreaker: 1 }), {
    runner,
    sleep: clock.sleep,
    now: clock.now,
    random: () => 0.9,
    onQuotaPause: (change) => changes.push(change),
    watchResume: (onResume) => {
      resume = onResume;
      watching++;
      return () => void watching--;
    },
  });
  // Two calls on a at once: the first finds its quota spent with no reset named
  // (the breaker trips: quotaBreaker 1), the second learns when it resets.
  const onAdapterWarning = ({ message }: { message: string }): void => void warnings.push(message);
  const first = bridge.run({ prompt: "1" }, { onAdapterWarning });
  const second = bridge.run({ prompt: "2" }, { onAdapterWarning });
  await until(() => held.length === 2);
  held[0]!(failing(NO_RESET));
  await assert.rejects(first, /^AdapterExecutionError: adapter 'a' ran out of usage quota/);
  assert.equal(warnings.length, 1);
  assert.match(
    warnings[0]!,
    /the run's later agents skip it: each starts on the next adapter of its fallback chain, or without one waits for its quota to reset \(quotaWait\) — or fails at once when its CLI did not say when\./,
  );
  assert.equal(bridge.route("a").start, -1, "the breaker took a out");
  held[1]!(failing(QUOTA));
  await until(() => clock.sleeping === 1);
  assert.equal(watching, 1);
  resume();
  await until(() => held.length === 3);
  held[2]!(ok("a answered"));
  assert.equal((await second).value, "a answered");
  assert.equal(clock.now(), T0, "at once: no reset, no jitter");
  assert.deepEqual(changes.map((c) => c.change), ["started", "resumed"]);
  assert.equal(bridge.route("a").start, 0, "the breaker forgot a at the resume");
  assert.equal(watching, 0);

  // A stop while it waits ends the call with the run's reason.
  const stopping = new Bridge(quotaConfig(), { runner: fakeCli({ a: [failing(QUOTA)] }).runner, sleep: clock.sleep, now: clock.now, random: () => 0 });
  const run = new AbortController();
  const waiting = stopping.run({ prompt: "x" }, { signal: run.signal });
  await until(() => clock.sleeping === 1);
  const reason = new RunStopped("run was stopped");
  run.abort(reason);
  await assert.rejects(waiting, (err) => err === reason);
});
