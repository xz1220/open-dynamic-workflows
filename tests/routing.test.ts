import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";

import { collectConfigWarnings, defaultConfig, loadConfig } from "../src/adapters/config.js";
import type { CommandRunner } from "../src/adapters/runner.js";
import type { CliResult, Config, Settings } from "../src/adapters/types.js";
import type { Usage } from "../src/adapters/usage.js";
import { Bridge, type AdapterFallback } from "../src/bridge.js";
import { main } from "../src/cli.js";
import { buildContext, type BuildContextOptions } from "../src/context.js";
import { AdapterExecutionError, AdapterNotFound, AgentError, ConfigError, RunStopped, WorkflowScriptError } from "../src/errors.js";
import { AGENT_FAILED, AGENT_FINISHED, AGENT_STARTED, LOG, MemorySink } from "../src/events.js";
import { ReplayJournal, resumeKey, stableJson, type AgentResultRecord } from "../src/journal.js";
import { loadWorkflowScript, readWorkflowMeta } from "../src/loader.js";
import { createPrimitives } from "../src/primitives.js";
import { attachRun, formatEvent } from "../src/runtime/live-view.js";
import { RunStore } from "../src/runtime/run-store.js";
import { detailFrom, EventFold } from "../src/runtime/runs-view.js";
import { normalizeTranscript } from "../src/runtime/transcript-view.js";
import { executeRun } from "../src/runtime/worker.js";
import { Scheduler } from "../src/scheduler.js";
import { TranscriptRecorder } from "../src/transcript.js";
import { FakeTerm } from "./fake-term.js";

// Routing (ODW extensions): per-phase adapters and models, model tiers, and
// fallback chains with the run's quota breaker — in the config, in agent()
// over a fake CLI, in the scheduler, in what readers show, and end to end
// through the worker with mock CLIs, resume included.

const ok = (stdout: string): CliResult => ({ returncode: 0, stdout, stderr: "", timedOut: false, duration: 0.1 });
const failing = (stderr: string): CliResult => ({ returncode: 1, stdout: "", stderr, timedOut: false, duration: 0.1 });

// What the CLIs print, as tests/failures.test.ts samples them.
const QUOTA = "You've hit your usage limit. Upgrade to Pro or try again in 3h 22m.";
const AUTH = "Error: not logged in. Run `claude` to log in.";
const RATE = "ERROR: exceeded retry limit, last status: 429 Too Many Requests";

/** Adapters of the user's own — `a`, `b`, `c` — each with a model flag; with no permission flags, each runs "edit". */
function routingConfig(settings: Partial<Settings> = {}): Config {
  const config = defaultConfig();
  for (const name of ["a", "b", "c"]) {
    config.adapters[name] = { name, command: [`${name}-cli`], stdin: "{prompt}", flags: { model: ["--model"] } };
  }
  config.settings.defaultAdapter = "a";
  config.settings.concurrency = 4;
  Object.assign(config.settings, settings);
  return config;
}

interface Call {
  adapter: string;
  model: string | null;
  prompt: string;
  command: string[];
}

/**
 * A fake CLI: each adapter answers from its queue of replies — `<adapter>
 * answered` once that is empty — and every run is recorded with the model it
 * was given.
 */
function fakeCli(replies: Record<string, CliResult[]> = {}) {
  const calls: Call[] = [];
  const runner: CommandRunner = async (command, opts) => {
    const adapter = command[0]!.replace(/-cli$/, "");
    const at = command.indexOf("--model");
    calls.push({ adapter, model: at === -1 ? null : command[at + 1]!, prompt: String(opts?.stdin ?? ""), command });
    return replies[adapter]?.shift() ?? ok(`${adapter} answered`);
  };
  return { runner, calls };
}

/** A run context, built as a run builds it, whose bridge runs the {@link fakeCli}. */
function routed(config: Config, replies: Record<string, CliResult[]> = {}, options: BuildContextOptions = {}) {
  const sink = new MemorySink();
  const ctx = buildContext(config, { sink, ...options });
  const { runner, calls } = fakeCli(replies);
  ctx.bridge = new Bridge(config, { runner, sleep: async () => {}, random: () => 0 });
  return { ctx, sink, calls };
}

const logs = (sink: MemorySink): string[] => sink.ofType(LOG).map((e) => String(e.message));

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition did not become true");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

// --- config -----------------------------------------------------------------------------

test("config: fallback, models and quotaBreaker load, default and validate; every adapter they name must exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-routing-config-"));
  const load = (raw: unknown): Config => {
    const path = join(dir, "odw.config.json");
    writeFileSync(path, JSON.stringify(raw));
    return loadConfig(path, { quiet: true });
  };
  try {
    for (const settings of [defaultConfig().settings, load({}).settings]) {
      assert.deepEqual([settings.fallback, settings.models, settings.quotaBreaker], [{}, {}, 3]);
    }
    const loaded = load({
      fallback: { codex: ["claude", "gemini"], $comment: "codex first" },
      models: { fast: { claude: "haiku", codex: "gpt-5-mini", "//": "per CLI" }, "deep.v2": { claude: "opus" } },
      quotaBreaker: 0,
    }).settings;
    assert.deepEqual(loaded.fallback, { codex: ["claude", "gemini"] });
    assert.deepEqual(loaded.models, { fast: { claude: "haiku", codex: "gpt-5-mini" }, "deep.v2": { claude: "opus" } });
    assert.equal(loaded.quotaBreaker, null, "0 never skips, like null");
    assert.equal(load({ quotaBreaker: null }).settings.quotaBreaker, null);
    assert.equal(load({ quotaBreaker: 5 }).settings.quotaBreaker, 5);
    const own = load({ adapters: { mine: { command: ["mine"] } }, fallback: { mine: ["codex"] } });
    assert.deepEqual(own.settings.fallback, { mine: ["codex"] }, "an adapter of the user's own can head a chain");
    const refused: Array<[unknown, RegExp]> = [
      [{ fallback: ["claude"] }, /^"fallback" must be an object/],
      [{ fallback: { codex: "claude" } }, /^"fallback\.codex" must be a list of adapter names; got "claude"$/],
      [{ fallback: { codex: ["claud"] } }, /^"fallback\.codex" names unknown adapter 'claud'; available: .*\bclaude\b/],
      [{ fallback: { codx: ["claude"] } }, /^"fallback\.codx" names unknown adapter 'codx'/],
      [{ models: { fast: "haiku" } }, /^"models\.fast" must be an object/],
      [{ models: { "fa st": { claude: "haiku" } } }, /^"models" tier names are letters, digits/],
      [{ models: { fast: { claude: "" } } }, /^"models\.fast\.claude" must be a model id/],
      [{ models: { fast: { claud: "haiku" } } }, /^"models\.fast" names unknown adapter 'claud'/],
      [{ quotaBreaker: -1 }, /^"quotaBreaker" must be a positive integer, or 0\/null to never skip an adapter/],
      [{ quotaBreaker: 1.5 }, /^"quotaBreaker" must be/],
    ];
    for (const [raw, error] of refused) {
      assert.throws(() => load(raw), (err: Error) => err instanceof ConfigError && error.test(err.message), JSON.stringify(raw));
    }
    assert.deepEqual(collectConfigWarnings({ fallback: {}, models: {}, quotaBreaker: 3 }), [], "known keys");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the example config lints clean, and its commented-out fallback and models blocks are valid once enabled", () => {
  const example = JSON.parse(readFileSync(join(process.cwd(), "odw.config.example.json"), "utf8"));
  assert.deepEqual(collectConfigWarnings(example), []);
  const { "//fallback": fallback, "//models": models, ...rest } = example;
  assert.ok(fallback && models, "the example shows both");
  const dir = mkdtempSync(join(tmpdir(), "odw-routing-example-"));
  try {
    const path = join(dir, "odw.config.json");
    writeFileSync(path, JSON.stringify({ ...rest, fallback, models }));
    const settings = loadConfig(path, { quiet: true }).settings;
    assert.ok(Object.keys(settings.fallback).length > 0);
    assert.ok(Object.keys(settings.models).length > 0);
    assert.equal(settings.quotaBreaker, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the scheduler ----------------------------------------------------------------------

test("AgentSlot.moveTo: both slots go back first, then the pair on the new adapter — ahead of the agents that have not started", async () => {
  const s = new Scheduler({ concurrency: 2, maxAgents: 1000, adapterConcurrency: { a: 1, b: 1 } });
  const order: string[] = [];
  const gates = new Map<string, () => void>();
  const hold = (name: string) => new Promise<void>((resolve) => gates.set(name, resolve));
  const y = s.runAgent(async () => {
    order.push("y@b");
    await hold("y");
  }, { adapter: "b" });
  await until(() => order.length === 1);
  const x = s.runAgent(async (_signal, slot) => {
    order.push("x@a");
    await slot.moveTo("b");
    order.push("x@b");
    await hold("x");
  }, { adapter: "a" });
  const z = s.runAgent(async () => {
    order.push("z@a");
    await hold("z");
  }, { adapter: "a" });
  await until(() => order.length === 3);
  assert.deepEqual(order, ["y@b", "x@a", "z@a"], "x let go of a's slot and its run slot: z has them while x waits for b");
  const w = s.runAgent(async () => {
    order.push("w@b");
    await hold("w");
  }, { adapter: "b" });
  gates.get("y")!();
  await y;
  await until(() => order.length === 4);
  assert.equal(order[3], "x@b", "x goes before w, which had not started");
  gates.get("x")!();
  await x;
  await until(() => order.length === 5);
  assert.equal(order[4], "w@b");
  gates.get("z")!();
  gates.get("w")!();
  await Promise.all([z, w]);
  assert.equal(s.dispatched, 4, "a move is no dispatch");
  assert.equal(await s.drain(100), true);
});

test("AgentSlot.moveTo: a stop while it waits ends the wait; the agent leaves holding no slot", async () => {
  const s = new Scheduler({ concurrency: 2, maxAgents: 1000, adapterConcurrency: { b: 1 } });
  let releaseY!: () => void;
  const y = s.runAgent(() => new Promise<void>((resolve) => (releaseY = resolve)), { adapter: "b" });
  let waiting = false;
  const x = s.runAgent(async (_signal, slot) => {
    waiting = true;
    await slot.moveTo("b");
    return "moved";
  }, { adapter: "a" });
  await until(() => waiting);
  s.abort(new RunStopped("run was stopped"));
  await assert.rejects(x, RunStopped);
  releaseY();
  await y;
  assert.equal(await s.drain(100), true, "nothing is left holding a slot or pending");
  // Moving where nothing limits either adapter keeps the slots: there is nothing to wait for.
  const free = new Scheduler({ concurrency: 1, maxAgents: 10 });
  assert.equal(await free.runAgent(async (_signal, slot) => (await slot.moveTo("b"), "stayed")), "stayed");
});

// --- transcripts ------------------------------------------------------------------------

test("a transcript marks a fallback with an attempt line naming the next adapter, and keeps its output as that adapter prints", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-routing-recorder-"));
  try {
    const ended: CliResult = { returncode: 0, stdout: "", stderr: "", timedOut: false, duration: 0 };
    const claude = { name: "claude", output: { format: "jsonl", eventType: "result", textPath: ["result"], select: "last" } } as const;
    const recorder = new TranscriptRecorder({ transcript: join(dir, "t.jsonl"), stderr: join(dir, "t.txt"), format: "jsonl", maxBytes: 1 << 20 });
    recorder.beginRun(undefined, claude);
    recorder.stdout('{"type":"result","result":"spent"}\n');
    recorder.endRun({ ...ended, returncode: 1 });
    recorder.beginRun("fallback", { name: "codex" });
    recorder.stdout("one\ntwo\n");
    recorder.endRun(ended);
    await recorder.close();
    const text = readFileSync(join(dir, "t.jsonl"), "utf8");
    assert.deepEqual(
      text
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line)),
      [
        { type: "result", result: "spent" },
        { kind: "attempt", n: 2, reason: "fallback", adapter: "codex" },
        { kind: "text", text: "one\n" },
        { kind: "text", text: "two\n" },
      ],
      "codex's output kept as text: its own format",
    );
    const attempt = normalizeTranscript(text).find((entry) => entry.kind === "attempt")!;
    assert.deepEqual([attempt.text, attempt.reason, attempt.adapter], ["attempt 2: fallback to codex", "fallback", "codex"]);

    // A call that left its adapter before any CLI ran there starts its transcript with the line.
    const moved = new TranscriptRecorder({ transcript: join(dir, "m.jsonl"), stderr: join(dir, "m.txt"), format: "jsonl", maxBytes: 1 << 20 });
    moved.beginRun("fallback", { name: "codex" });
    moved.stdout("done\n");
    moved.endRun(ended);
    await moved.close();
    assert.deepEqual(
      readFileSync(join(dir, "m.jsonl"), "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line)),
      [
        { kind: "attempt", n: 1, reason: "fallback", adapter: "codex" },
        { kind: "text", text: "done\n" },
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the bridge -------------------------------------------------------------------------

test("bridge: a spent quota moves the call down its chain, told through onFallback; a model tier resolves per adapter", async () => {
  const config = routingConfig({ fallback: { a: ["b"] }, models: { fast: { a: "a-mini", b: "b-flash" } } });
  const { runner, calls } = fakeCli({ a: [failing(QUOTA)] });
  const moves: AdapterFallback[] = [];
  const out = await new Bridge(config, { runner }).run({ prompt: "x", model: "@fast" }, { onFallback: (move) => void moves.push(move) });
  assert.deepEqual([out.value, out.adapter, out.fellBackFrom], ["b answered", "b", ["a"]]);
  assert.deepEqual(
    calls.map((c) => [c.adapter, c.model]),
    [
      ["a", "a-mini"],
      ["b", "b-flash"],
    ],
  );
  assert.deepEqual(moves, [{ from: "a", reason: "quota", to: "b", fellBackFrom: ["a"] }]);
  // With nowhere to go, the call fails with its adapter's own error.
  await assert.rejects(
    new Bridge(config, { runner: async () => failing(QUOTA) }).run({ prompt: "x", adapter: ["a"] }),
    (err: Error) => err instanceof AdapterExecutionError && err.reason === "quota" && /^adapter 'a' ran out of usage quota/.test(err.message),
  );
});

test("bridge: route() starts a call past the adapters the quota breaker took out; with none left, the call fails at once", async () => {
  const { runner, calls } = fakeCli({ a: [failing(QUOTA), failing(QUOTA)] });
  const bridge = new Bridge(routingConfig({ fallback: { a: ["b"] }, quotaBreaker: 2 }), { runner });
  assert.equal(bridge.route("a").start, 0);
  for (let i = 0; i < 2; i++) assert.equal((await bridge.run({ prompt: "x" })).adapter, "b");
  const route = bridge.route("a");
  assert.deepEqual([route.chain.map((adapter) => adapter.name), route.start], [["a", "b"], 1]);
  calls.length = 0;
  assert.equal((await bridge.run({ prompt: "x" })).adapter, "b");
  assert.deepEqual(calls.map((c) => c.adapter), ["b"], "a never ran");
  assert.equal(bridge.route(["a"]).start, -1);
  await assert.rejects(
    bridge.run({ prompt: "x", adapter: ["a"] }),
    (err: Error) => err instanceof AdapterExecutionError && err.reason === "quota" && /out of usage quota for the rest of this run/.test(err.message),
  );
  assert.deepEqual(calls.map((c) => c.adapter), ["b"]);
});
