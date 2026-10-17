import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";

import { collectConfigWarnings, defaultConfig, loadConfig } from "../src/adapters/config.js";
import { AdapterOutputDecoder } from "../src/adapters/output.js";
import type { CommandRunner } from "../src/adapters/runner.js";
import type { StaggerFanOut } from "../src/adapters/types.js";
import { Bridge } from "../src/bridge.js";
import { buildContext } from "../src/context.js";
import { MemoryControl } from "../src/control.js";
import { ConfigError, RunStopped } from "../src/errors.js";
import { AGENT_FAILED, AGENT_FINISHED, AGENT_STARTED, LOG, MemorySink } from "../src/events.js";
import { ReplayJournal, resumeKey, type AgentResultRecord } from "../src/journal.js";
import { createPrimitives } from "../src/primitives.js";
import { RunStore } from "../src/runtime/run-store.js";
import { executeRun } from "../src/runtime/worker.js";
import { describeConcurrency, STAGGER_MIN_PREFIX, sharedPrefixLength } from "../src/throttle.js";

// Staggered fan-outs (ODW extension): in one parallel() or pipeline() call on a
// prompt-caching adapter (the built-in claude), agents whose prompts share a
// long prefix start one at a time — the rest once the first one's CLI has
// produced output, or after delayMs — so they read the prompt cache it wrote.

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

async function waitUntil(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition did not become true in time");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

/** A shared preamble well past the stagger threshold, as a fan-out's prompts often start. */
const PREFIX = "You are reviewing one file of a large repository against the team's guidelines. ".repeat(20);
const task = (i: number) => `${PREFIX}\nFile to review: src/module-${i}.ts`;

/** One CLI run of the fake claude: the test decides when it speaks and how it ends. */
interface FakeRun {
  prompt: string;
  /** Print the model's first event (past the start-up `system` event). */
  speak(): void;
  /** Speak if it has not, print the result and exit. */
  finish(): void;
  /** Exit 1 without another word. */
  fail(): void;
}

/**
 * A fake Claude Code on stream-json: each run prints its start-up `system`
 * event at once, then waits for the test. A stop kills it like a real CLI.
 */
function fakeClaude() {
  const runs: FakeRun[] = [];
  const runner: CommandRunner = async (_command, options = {}) => {
    const emit = (event: object) => options.onStdout?.(JSON.stringify(event) + "\n", () => {});
    emit({ type: "system", subtype: "init", session_id: "s" });
    let speak!: () => void;
    let end!: (ok: boolean) => void;
    const spoken = new Promise<void>((resolve) => (speak = resolve));
    const ended = new Promise<boolean>((resolve) => (end = resolve));
    const prompt = options.stdin ?? "";
    runs.push({ prompt, speak, finish: () => (speak(), end(true)), fail: () => end(false) });
    const aborted = new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
    const ok = await Promise.race([spoken.then(() => true), ended, aborted.then(() => false)]);
    if (options.signal?.aborted) return { returncode: -1, stdout: "", stderr: "[aborted]", timedOut: false, duration: 0 };
    if (!ok) return { returncode: 1, stdout: "", stderr: "boom", timedOut: false, duration: 0.1 };
    emit({ type: "assistant", message: { content: [{ type: "text", text: "reading" }] } });
    await Promise.race([ended, aborted]);
    if (options.signal?.aborted) return { returncode: -1, stdout: "", stderr: "[aborted]", timedOut: false, duration: 0 };
    const reply = `reviewed ${/module-(\d+)/.exec(prompt)?.[1] ?? "?"}`;
    emit({ type: "result", subtype: "success", is_error: false, result: reply, usage: { input_tokens: 10, output_tokens: 2 } });
    return { returncode: 0, stdout: "", stderr: "", timedOut: false, duration: 0.1 };
  };
  return { runner, runs };
}

/** A run context on the built-in claude adapter, its CLI faked, with `stagger` as the setting. */
function claudeContext(stagger: StaggerFanOut | null = { first: 1, delayMs: 60_000 }) {
  const config = defaultConfig();
  config.settings.defaultAdapter = "claude";
  config.settings.concurrency = 8; // not the auto cap: a 2-CPU machine's is 1
  config.settings.staggerFanOut = stagger;
  const sink = new MemorySink();
  const control = new MemoryControl();
  const ctx = buildContext(config, { sink, control });
  const { runner, runs } = fakeClaude();
  ctx.bridge = new Bridge(config, { runner });
  const staggerLogs = () => sink.ofType(LOG).filter((e) => /^staggered fan-out/.test(String(e.message)));
  return { ctx, primitives: createPrimitives(ctx), sink, control, runs, staggerLogs };
}

/** Let every queued microtask (and the next macrotask) run: a released agent reaches its start. */
async function settle(): Promise<void> {
  await nextTurn();
  await nextTurn();
}

test("a staggered fan-out starts the first agent alone, and the rest once its CLI produces output", async () => {
  const { primitives, sink, runs, staggerLogs } = claudeContext();
  const fanOut = primitives.parallel([0, 1, 2, 3].map((i) => () => primitives.agent(task(i), { label: `r${i}` })));
  await waitUntil(() => runs.length === 1);
  await settle();
  assert.equal(sink.ofType(AGENT_STARTED).length, 1, "the rest wait — the CLI's start-up event is not output");
  assert.equal(runs.length, 1);

  runs[0]!.speak();
  await waitUntil(() => runs.length === 4);
  for (const run of runs) run.finish();
  assert.deepEqual(await fanOut, ["reviewed 0", "reviewed 1", "reviewed 2", "reviewed 3"]);

  const lines = staggerLogs();
  assert.equal(lines.length, 1, "one line per staggered fan-out");
  assert.match(
    String(lines[0]!.message),
    new RegExp(
      `^staggered fan-out: 3 claude agents sharing a ${sharedPrefixLength(task(0), task(1))}-character prompt prefix waited ` +
        "[\\d.]+s while the first warmed the prompt cache, until it produced output$",
    ),
  );
  assert.equal(lines[0]!.adapter, "claude");
  assert.equal(lines[0]!.staggered, 3);
});

test("the rest go after delayMs when the first agent has produced no output by then", async () => {
  const { primitives, runs, staggerLogs } = claudeContext({ first: 1, delayMs: 50 });
  const fanOut = primitives.parallel([0, 1, 2].map((i) => () => primitives.agent(task(i))));
  await waitUntil(() => runs.length === 3);
  for (const run of runs) run.finish();
  assert.deepEqual(await fanOut, ["reviewed 0", "reviewed 1", "reviewed 2"]);
  const lines = staggerLogs();
  assert.equal(lines.length, 1);
  assert.match(String(lines[0]!.message), /^staggered fan-out: 2 claude agents .* until staggerFanOut\.delayMs \(50ms\) ran out$/);
});

test("the rest go when the first agent ends without a word — a failure too — and pipeline() staggers as well", async () => {
  const { primitives, runs, staggerLogs } = claudeContext();
  const fanOut = primitives.pipeline([0, 1, 2], (_previous, item) => primitives.agent(task(item as number)));
  await waitUntil(() => runs.length === 1);
  runs[0]!.fail();
  await waitUntil(() => runs.length === 3);
  runs[1]!.finish();
  runs[2]!.finish();
  assert.deepEqual(await fanOut, [null, "reviewed 1", "reviewed 2"], "a failed leader is that item's null, nothing more");
  const lines = staggerLogs();
  assert.equal(lines.length, 1);
  assert.match(String(lines[0]!.message), /^staggered fan-out: 2 claude agents .* until it finished$/);
});

test("first: 2 starts two agents at once before the rest wait", async () => {
  const { primitives, sink, runs } = claudeContext({ first: 2, delayMs: 60_000 });
  const fanOut = primitives.parallel([0, 1, 2, 3, 4].map((i) => () => primitives.agent(task(i))));
  await waitUntil(() => runs.length === 2);
  await settle();
  assert.equal(sink.ofType(AGENT_STARTED).length, 2);
  runs[1]!.speak();
  await waitUntil(() => runs.length === 5);
  for (const run of runs) run.finish();
  assert.equal((await fanOut).length, 5);
});

test("no stagger for prompts that share less than the threshold, for a lone agent, or for another model", async () => {
  const { primitives, runs, staggerLogs } = claudeContext();
  // Long prompts, but they part ways before STAGGER_MIN_PREFIX characters.
  const short = (i: number) => `${"x".repeat(STAGGER_MIN_PREFIX - 24)} part ${i} ${"y".repeat(2000)}`;
  assert.ok(sharedPrefixLength(short(1), short(2)) < STAGGER_MIN_PREFIX);
  const different = primitives.parallel([0, 1, 2].map((i) => () => primitives.agent(short(i))));
  await waitUntil(() => runs.length === 3);
  for (const run of runs) run.finish();
  await different;

  // One agent alone in its fan-out never waits.
  const lone = primitives.parallel([() => primitives.agent(task(7))]);
  await waitUntil(() => runs.length === 4);
  runs[3]!.finish();
  assert.deepEqual(await lone, ["reviewed 7"]);

  // The same prompt on different models (or personas) goes to different caches.
  const models = primitives.parallel([
    () => primitives.agent(task(8), { model: "opus" }),
    () => primitives.agent(task(8), { model: "haiku" }),
    () => primitives.agent(task(8), { agentType: "security reviewer" }),
  ]);
  await waitUntil(() => runs.length === 7);
  for (const run of runs.slice(4)) run.finish();
  await models;

  // And a long prompt outside any parallel() or pipeline() is just an agent.
  const single = primitives.agent(task(9));
  await waitUntil(() => runs.length === 8);
  runs[7]!.finish();
  await single;
  assert.deepEqual(staggerLogs(), []);
});

test("no stagger on an adapter that does not declare promptCache, or with staggerFanOut off", async () => {
  const off = claudeContext(null);
  const fanOut = off.primitives.parallel([0, 1, 2].map((i) => () => off.primitives.agent(task(i))));
  await waitUntil(() => off.runs.length === 3);
  for (const run of off.runs) run.finish();
  await fanOut;
  assert.deepEqual(off.staggerLogs(), []);

  const plain = claudeContext();
  plain.ctx.config.adapters.claude = { ...plain.ctx.config.adapters.claude!, promptCache: false };
  const uncached = plain.primitives.parallel([0, 1, 2].map((i) => () => plain.primitives.agent(task(i))));
  await waitUntil(() => plain.runs.length === 3);
  for (const run of plain.runs) run.finish();
  await uncached;
  assert.deepEqual(plain.staggerLogs(), []);
});

test("replayed agents never wait for a live one", async () => {
  const { ctx, primitives, sink, runs, staggerLogs } = claudeContext();
  const saved = (i: number): AgentResultRecord => ({
    agentId: i + 1,
    key: resumeKey(task(i), { label: `r${i}` }),
    label: `r${i}`,
    phase: null,
    adapter: "claude",
    attempts: 1,
    startedAt: 1,
    finishedAt: 2,
    value: `saved ${i}`,
  });
  ctx.replay = new ReplayJournal("earlier-run", [saved(1), saved(2), saved(3)]);
  const fanOut = primitives.parallel([0, 1, 2, 3].map((i) => () => primitives.agent(task(i), { label: `r${i}` })));
  await waitUntil(() => sink.ofType(AGENT_FINISHED).filter((e) => e.cached === true).length === 3);
  assert.equal(runs.length, 1, "only the live agent runs a CLI — and it has said nothing yet");
  runs[0]!.finish();
  assert.deepEqual(await fanOut, ["reviewed 0", "saved 1", "saved 2", "saved 3"]);
  assert.deepEqual(staggerLogs(), []);
});

test("a stop during the stagger ends it at once: the held agents never start", { timeout: 5000 }, async () => {
  const { ctx, primitives, sink, control, runs, staggerLogs } = claudeContext();
  const fanOut = primitives.parallel([0, 1, 2, 3].map((i) => () => primitives.agent(task(i))));
  await waitUntil(() => runs.length === 1);
  control.stop();
  await assert.rejects(fanOut, RunStopped);
  assert.equal(runs.length, 1);
  assert.equal(sink.ofType(AGENT_STARTED).length, 1);
  assert.equal(sink.ofType(AGENT_FAILED).length, 1, "the leader was stopped; the held agents never started");
  assert.deepEqual(staggerLogs(), [], "nothing is said about a wave a stop ended");
  assert.equal(await ctx.scheduler.drain(1000), true, "nothing is left waiting");
});

test("a held agent is the run's pending work: the run is not idle when its leader ends", { timeout: 5000 }, async () => {
  const { ctx, primitives, runs } = claudeContext();
  const fanOut = primitives.parallel([0, 1].map((i) => () => primitives.agent(task(i))));
  await waitUntil(() => runs.length === 1);
  let idle = false;
  const drained = ctx.scheduler.drain().then(() => (idle = true));
  runs[0]!.fail(); // released only as the leader settles, after it gave up its slot
  await waitUntil(() => runs.length === 2);
  await settle();
  assert.equal(idle, false, "the held agent went on to run: the run was never idle");
  runs[1]!.finish();
  await drained;
  assert.deepEqual(await fanOut, [null, "reviewed 1"]);
});

// --- config, and what odw doctor says -----------------------------------------------

/** Load a config file holding `raw`. */
function loadRaw(raw: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "odw-stagger-config-"));
  try {
    const path = join(dir, "odw.config.json");
    writeFileSync(path, JSON.stringify(raw));
    return loadConfig(path, { quiet: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("config: an adapter's promptCache and the staggerFanOut setting — defaults and validation", () => {
  const defaults = defaultConfig();
  assert.deepEqual(defaults.settings.staggerFanOut, { first: 1, delayMs: 2500 });
  assert.deepEqual(
    Object.keys(defaults.adapters).filter((name) => defaults.adapters[name]!.promptCache),
    ["claude"],
    "only the built-in claude declares a prompt cache",
  );

  const loaded = loadRaw({
    staggerFanOut: { delayMs: 800 },
    adapters: { mine: { command: ["mine"], promptCache: true }, unset: { command: ["unset"], promptCache: null } },
  });
  assert.equal(loaded.adapters.mine!.promptCache, true);
  assert.equal(loaded.adapters.unset!.promptCache, undefined);
  assert.equal(loaded.adapters.claude!.promptCache, true, "built-ins keep theirs");
  assert.deepEqual(loaded.settings.staggerFanOut, { first: 1, delayMs: 800 }, "a field left out keeps its default");
  assert.equal(loadRaw({ staggerFanOut: false }).settings.staggerFanOut, null);
  assert.equal(loadRaw({ staggerFanOut: null }).settings.staggerFanOut, null);
  assert.deepEqual(loadRaw({ staggerFanOut: true }).settings.staggerFanOut, { first: 1, delayMs: 2500 });
  assert.deepEqual(loadRaw({ staggerFanOut: { first: 3, delayMs: 100 } }).settings.staggerFanOut, { first: 3, delayMs: 100 });

  for (const [raw, message] of [
    [{ adapters: { x: { command: ["x"], promptCache: "yes" } } }, /adapter 'x' 'promptCache' must be true or false; got "yes"/],
    [{ staggerFanOut: 2500 }, /"staggerFanOut" must be \{ "first": n, "delayMs": ms \}, or false to turn it off; got 2500/],
    [{ staggerFanOut: { first: 0 } }, /"staggerFanOut.first" must be a positive integer; got 0/],
    [{ staggerFanOut: { delayMs: 0 } }, /"staggerFanOut.delayMs" must be a positive number of milliseconds; got 0/],
  ] as const) {
    assert.throws(() => loadRaw(raw), (err: unknown) => err instanceof ConfigError && message.test(err.message), JSON.stringify(raw));
  }

  assert.deepEqual(
    collectConfigWarnings({ staggerFanOut: { first: 1, delayMs: 2500 }, adapters: { mine: { command: ["mine"], promptCache: true } } }),
    [],
  );
  assert.deepEqual(collectConfigWarnings({ staggerFanOut: { first: 1, delay: 100 } }), [
    'staggerFanOut: unknown field "delay" is ignored — did you mean "delayMs"?',
  ]);
});

test("odw doctor's concurrency line says which adapters' fan-outs start staggered, and how", () => {
  const config = defaultConfig();
  config.settings.concurrency = 4;
  const details = () => describeConcurrency(config, { details: true });
  assert.equal(
    details(),
    "4 agents at once · a rate limit halves its adapter's cap · fan-outs on claude staggered: 1 first, the rest after its output or 2.5s",
  );
  config.settings.staggerFanOut = { first: 2, delayMs: 500 };
  assert.match(details(), / · fan-outs on claude staggered: 2 first, the rest after its output or 0\.5s$/);
  config.adapters.claude = { ...config.adapters.claude!, promptCache: false };
  assert.match(details(), / · no adapter declares promptCache, so no fan-out is staggered$/);
  config.settings.staggerFanOut = null;
  assert.match(details(), / · staggered fan-outs off$/);
});

test("the decoder tells a CLI starting up from one answering", () => {
  const claude = defaultConfig().adapters.claude!;
  const decoder = new AdapterOutputDecoder(claude);
  decoder.write('{"type":"system","subtype":"init"}\n{"type":"sys');
  assert.equal(decoder.answering, false, "start-up events are not output");
  decoder.write('tem","subtype":"status"}\nnot json\n');
  assert.equal(decoder.answering, false, "nor is a stray notice");
  decoder.write('{"type":"assistant","message":{}}\n');
  assert.equal(decoder.answering, true);

  const text = new AdapterOutputDecoder(defaultConfig().adapters.codex!);
  assert.equal(text.answering, false);
  text.write("anything");
  assert.equal(text.answering, true, "for text output, any output is the answer");
});

test("the bridge says once per CLI run that it started answering", async () => {
  const config = defaultConfig();
  const { runner, runs } = fakeClaude();
  const bridge = new Bridge(config, { runner });
  let told = 0;
  const call = bridge.run({ prompt: "hello", adapter: "claude" }, { onOutput: () => told++ });
  await waitUntil(() => runs.length === 1);
  await settle();
  assert.equal(told, 0, "not for the start-up event");
  runs[0]!.finish();
  assert.equal((await call).text, "reviewed ?");
  assert.equal(told, 1, "once, though more events followed");
});

// --- end to end: the worker, a stream-json mock CLI ----------------------------------

test("end to end: a fan-out on a promptCache adapter waits for the first CLI's output, then runs", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-stagger-e2e-"));
  try {
    // A stream-json CLI: its init event at once, its first turn 300ms later, then its result.
    const mock =
      "let p='';process.stdin.on('data',(c)=>(p+=c)).on('end',()=>{" +
      "const emit=(e)=>process.stdout.write(JSON.stringify(e)+'\\n');" +
      "emit({type:'system',subtype:'init'});" +
      "setTimeout(()=>{emit({type:'assistant',message:{content:[]}});" +
      "setTimeout(()=>emit({type:'result',is_error:false,result:'done '+(/module-(\\d+)/.exec(p)||[])[1]}),100)},300)})";
    const configPath = join(root, "odw.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        defaultAdapter: "cached",
        concurrency: 4,
        staggerFanOut: { first: 1, delayMs: 60_000 },
        adapters: {
          cached: { command: [execPath, "-e", mock], stdin: "{prompt}", output: defaultConfig().adapters.claude!.output, promptCache: true },
        },
      }),
    );
    const script = join(root, "fan.js");
    writeFileSync(
      script,
      "export const meta = { name: 'fan', description: 'd' }\n" +
        `const prefix = ${JSON.stringify(PREFIX)}\n` +
        "return await parallel([0, 1, 2].map((i) => () => agent(prefix + '\\nFile to review: src/module-' + i + '.ts')))\n",
    );
    const store = new RunStore(join(root, "runs"));
    const id = store.create({ script, args: null, source: root, configPath });
    assert.equal(await executeRun(store.runDir(id)), "done");
    assert.deepEqual(store.readResult(id), ["done 0", "done 1", "done 2"]);

    const events = store.readEvents(id);
    const lines = events.filter((e) => e.type === "log" && /^staggered fan-out/.test(String(e.message)));
    assert.equal(lines.length, 1);
    assert.match(String(lines[0]!.message), /^staggered fan-out: 2 cached agents .* until it produced output$/);
    const starts = events.filter((e) => e.type === "agent_started").map((e) => e.ts as number);
    assert.equal(starts.length, 3);
    assert.ok(starts[1]! - starts[0]! >= 0.25, `the second agent started ${starts[1]! - starts[0]!}s after the first, once it answered`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
