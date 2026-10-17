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
import { attachRun, fallbackLines, formatEvent } from "../src/runtime/live-view.js";
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

// --- phase defaults ---------------------------------------------------------------------

test("phase defaults: a phase's adapter and model reach its agents that name neither; an agent()'s own option always wins", async () => {
  const { ctx, sink, calls } = routed(routingConfig());
  const p = createPrimitives(ctx, { phases: [{ title: "Search", adapter: "b", model: "m-search" }, { title: "Report" }] });
  p.phase("Search");
  await p.agent("one");
  await p.agent("two", { adapter: "c" });
  await p.agent("three", { model: "m-own" });
  p.phase("Report");
  await p.agent("four");
  p.phase("Synthesize", { adapter: "c", model: "m-strong" });
  await p.agent("five");
  // A call's own phase (inside parallel/pipeline) brings that phase's defaults.
  await p.agent("six", { phase: "Search" });
  assert.deepEqual(
    calls.map((c) => [c.adapter, c.model]),
    [
      ["b", "m-search"],
      ["c", "m-search"],
      ["b", "m-own"],
      ["a", null],
      ["c", "m-strong"],
      ["b", "m-search"],
    ],
  );
  assert.deepEqual(
    sink.ofType(AGENT_STARTED).map((e) => [e.label, e.adapter]),
    [
      ["b", "b"],
      ["c", "c"],
      ["b", "b"],
      ["a", "a"],
      ["c", "c"],
      ["b", "b"],
    ],
    "an agent is labelled with the adapter it asked for, else the one it runs on",
  );
});

test("phase(title, opts) replaces its meta.phases defaults; phase(title) keeps them; a nested workflow's phases have their own", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-routing-phases-"));
  try {
    writeFileSync(
      join(dir, "child.js"),
      "export const meta = { name: 'child', description: 'd', phases: [{ title: 'Inner', adapter: 'c', model: 'm-inner' }] }\n" +
        "phase('Inner')\nreturn await agent('inside')\n",
    );
    const { ctx, sink, calls } = routed(routingConfig(), {}, { source: dir });
    const p = createPrimitives(ctx, { phases: [{ title: "Search", adapter: "b", model: "m-search" }] });
    p.phase("Search", { model: "m-other" });
    await p.agent("replaced");
    p.phase("Search", {});
    await p.agent("cleared");
    p.phase("Search");
    await p.agent("kept");
    assert.equal(await p.workflow({ scriptPath: "child.js" }), "c answered");
    // The parent's phases are its own: back in Search, the child's defaults do not apply.
    p.phase("Search");
    await p.agent("after");
    assert.deepEqual(
      calls.map((c) => [c.adapter, c.model]),
      [
        ["a", "m-other"],
        ["a", null],
        ["a", null],
        ["c", "m-inner"],
        ["a", null],
      ],
    );
    assert.equal(sink.ofType(AGENT_STARTED)[3]!.phase, "▸ child · Inner");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("phase defaults are checked: bad phase() options throw, a bad meta.phases entry fails the load, a string phase is a title", async () => {
  const { ctx } = routed(routingConfig());
  const p = createPrimitives(ctx);
  const scriptError = (pattern: RegExp) => (err: Error) => err instanceof WorkflowScriptError && pattern.test(err.message);
  assert.throws(() => p.phase("X", { adaptor: "b" } as never), scriptError(/^phase\("X"\) options takes adapter and model only; got "adaptor"$/));
  assert.throws(() => p.phase("X", { adapter: [] }), scriptError(/adapter must be an adapter name or a non-empty list of them; got \[\]$/));
  assert.throws(() => p.phase("X", { model: 7 } as never), scriptError(/model must be a model id or a tier such as "@fast"; got 7$/));
  assert.throws(() => p.phase("X", "b" as never), scriptError(/must be an object/));

  const bad = "export const meta = { name: 'x', description: 'd', phases: [{ title: 'A' }, { title: 'B', adapter: 42 }] }\nreturn 1";
  assert.throws(() => loadWorkflowScript(bad, "bad.js"), scriptError(/^workflow bad\.js: meta\.phases\[1\]\.adapter must be an adapter name/));
  const report = p.validate(bad);
  assert.equal(report.ok, false);
  assert.match(report.errors[0]!, /meta\.phases\[1\]\.adapter/);
  assert.deepEqual(
    readWorkflowMeta(bad, "bad.js").phases?.map((phase) => phase.title),
    ["A", "B"],
    "a listing reads the titles only: a bad default does not hide the workflow",
  );

  const strings =
    "export const meta = { name: 'x', description: 'd', phases: ['Plan', { title: 'Build', adapter: ['b', 'a'], model: '@fast' }] }\nreturn 1";
  assert.deepEqual(loadWorkflowScript(strings, "s.js").meta.phases, [
    { title: "Plan" },
    { title: "Build", adapter: ["b", "a"], model: "@fast" },
  ]);

  // An adapter a phase names that does not exist fails like any unknown adapter: the run's config is wrong.
  const unknown = routed(routingConfig());
  const q = createPrimitives(unknown.ctx);
  q.phase("X", { adapter: "nope" });
  await assert.rejects(q.agent("x"), AdapterNotFound);
});

test("a phase's string entry stays a title everywhere a run shows its phases", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-routing-titles-"));
  try {
    mkdirSync(join(root, "runs"));
    const configPath = join(root, "odw.config.json");
    writeFileSync(configPath, JSON.stringify({ defaultAdapter: "echo", adapters: { echo: { command: [execPath, "-e", "process.stdout.write('ok')"] } } }));
    const script = join(root, "titles.js");
    writeFileSync(script, "export const meta = { name: 'titles', description: 'd', phases: ['Plan', { title: 'Build' }] }\nphase('Plan')\nreturn await agent('go')\n");
    const store = new RunStore(join(root, "runs"));
    const id = store.create({ script, args: null, source: root, configPath });
    assert.equal(await executeRun(store.runDir(id)), "done");
    assert.deepEqual(store.readStatus(id).phases, [{ title: "Plan" }, { title: "Build" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- resume keys ------------------------------------------------------------------------

test("resume keys: a phase default changes no call's key, so a resume replays what finished however its phases route now", async () => {
  const saved: AgentResultRecord[] = [];
  const first = routed(routingConfig(), {}, { saveAgentResult: (rec) => void saved.push(rec) });
  const p1 = createPrimitives(first.ctx, { phases: [{ title: "Search", adapter: "b", model: "m-1" }] });
  p1.phase("Search");
  assert.equal(await p1.agent("find it", { label: "finder" }), "b answered");
  assert.equal(saved[0]!.key, resumeKey("find it", { label: "finder" }), "the call's own options");
  assert.notEqual(saved[0]!.key, resumeKey("find it", { label: "finder", adapter: "b", model: "m-1" }));

  const second = routed(routingConfig(), {}, { replay: new ReplayJournal("run-1", saved) });
  const p2 = createPrimitives(second.ctx, { phases: [{ title: "Search", adapter: "c", model: "m-2" }] });
  p2.phase("Search");
  assert.equal(await p2.agent("find it", { label: "finder" }), "b answered");
  assert.deepEqual(second.calls, [], "replayed: no CLI ran");
  const [finished] = second.sink.ofType(AGENT_FINISHED);
  assert.deepEqual([finished!.cached, finished!.adapter], [true, "b"]);
});

test("resume keys: an adapter list keys stably, in its order; a replayed fallback keeps its path and walks no chain", async () => {
  const chain = resumeKey("p", { adapter: ["codex", "claude"] });
  assert.equal(chain, resumeKey("p", { adapter: ["codex", "claude"] }));
  assert.notEqual(chain, resumeKey("p", { adapter: ["claude", "codex"] }), "another order is another preference");
  assert.notEqual(chain, resumeKey("p", { adapter: "codex" }));
  assert.equal(stableJson({ adapter: ["codex", "claude"] }), '{"adapter":["codex","claude"]}');

  const saved: AgentResultRecord[] = [];
  const first = routed(routingConfig(), { a: [failing(QUOTA)] }, { saveAgentResult: (rec) => void saved.push(rec) });
  assert.equal(await createPrimitives(first.ctx).agent("p", { adapter: ["a", "b"] }), "b answered");
  assert.deepEqual([saved[0]!.key, saved[0]!.adapter, saved[0]!.fellBackFrom], [resumeKey("p", { adapter: ["a", "b"] }), "b", ["a"]]);

  // The resume runs nothing — not even the adapter that ran out of quota.
  const second = routed(routingConfig(), { a: [failing(QUOTA)] }, { replay: new ReplayJournal("run-1", saved) });
  assert.equal(await createPrimitives(second.ctx).agent("p", { adapter: ["a", "b"] }), "b answered");
  assert.deepEqual(second.calls, []);
  assert.deepEqual(second.sink.ofType(LOG), []);
  const [finished] = second.sink.ofType(AGENT_FINISHED);
  assert.deepEqual([finished!.label, finished!.adapter, finished!.fellBackFrom, finished!.cached], ["a", "b", ["a"], true]);
});

// --- fallback chains in agent() ---------------------------------------------------------

test("a spent quota or a refused login moves the call down its chain — a fresh prompt, the same options — logged, the producer recorded", async () => {
  const saved: AgentResultRecord[] = [];
  const { ctx, sink, calls } = routed(
    routingConfig({ fallback: { a: ["b", "c"] } }),
    { a: [failing(QUOTA)], b: [failing(AUTH)] },
    { saveAgentResult: (rec) => void saved.push(rec) },
  );
  assert.equal(await createPrimitives(ctx).agent("find the bug", { label: "search", model: "m" }), "c answered");
  assert.deepEqual(
    calls.map((c) => [c.adapter, c.model]),
    [
      ["a", "m"],
      ["b", "m"],
      ["c", "m"],
    ],
  );
  assert.equal(new Set(calls.map((c) => c.prompt)).size, 1, "every adapter gets the same, fresh prompt");
  assert.deepEqual(logs(sink), ["search:1 → b after a quota", "search:1 → c after b auth"]);
  const [hop, next] = sink.ofType(LOG);
  assert.deepEqual([hop!.agentId, hop!.adapter, hop!.fellBackFrom, hop!.reason], [1, "b", ["a"], "quota"]);
  assert.deepEqual([next!.adapter, next!.fellBackFrom, next!.reason], ["c", ["a", "b"], "auth"]);
  assert.equal(sink.ofType(AGENT_STARTED)[0]!.adapter, "a");
  const [finished] = sink.ofType(AGENT_FINISHED);
  assert.deepEqual([finished!.adapter, finished!.fellBackFrom, finished!.attempts], ["c", ["a", "b"], 1]);
  assert.deepEqual([saved[0]!.adapter, saved[0]!.fellBackFrom], ["c", ["a", "b"]]);
});

test("only a spent quota or a refused login falls back: a rate limit is ridden out in place, any other failure is the call's", async () => {
  const chain = { fallback: { a: ["b"] } };
  {
    const { ctx, calls } = routed(routingConfig(chain), { a: [failing(RATE), ok("a, after waiting")] });
    assert.equal(await createPrimitives(ctx).agent("x"), "a, after waiting");
    assert.deepEqual(calls.map((c) => c.adapter), ["a", "a"]);
  }
  {
    const { ctx, calls } = routed(routingConfig({ ...chain, transientRetries: 0 }), { a: [failing(RATE)] });
    await assert.rejects(createPrimitives(ctx).agent("x"), (err: Error) => err instanceof AdapterExecutionError && err.reason === "rate_limit");
    assert.deepEqual(calls.map((c) => c.adapter), ["a"], "out of rate-limit retries: still not moved");
  }
  {
    const { ctx, calls } = routed(routingConfig(chain), { a: [failing("fatal: something else entirely")] });
    await assert.rejects(createPrimitives(ctx).agent("x"), (err: Error) => err instanceof AdapterExecutionError && err.reason === "exit");
    assert.deepEqual(calls.map((c) => c.adapter), ["a"]);
  }
  // At the chain's end, the last adapter's error is the call's; agent_failed says where it was.
  const { ctx, sink, calls } = routed(routingConfig(chain), { a: [failing(QUOTA)], b: [failing(QUOTA)] });
  await assert.rejects(
    createPrimitives(ctx).agent("x", { label: "x" }),
    (err: Error) => err instanceof AdapterExecutionError && err.reason === "quota" && /^adapter 'b' ran out of usage quota/.test(err.message),
  );
  assert.deepEqual(calls.map((c) => c.adapter), ["a", "b"]);
  const [failed] = sink.ofType(AGENT_FAILED);
  assert.deepEqual([failed!.adapter, failed!.fellBackFrom, failed!.reason], ["b", ["a"], "quota"]);
});

test("an agent()'s own adapter list is its whole chain, in place of the fallback setting; a malformed list is a config error", async () => {
  const config = () => routingConfig({ fallback: { a: ["b"] } });
  const { ctx, calls } = routed(config(), { a: [failing(QUOTA)] });
  assert.equal(await createPrimitives(ctx).agent("x", { adapter: ["a", "c"] }), "c answered");
  assert.deepEqual(calls.map((c) => c.adapter), ["a", "c"]);

  const twice = routed(config(), { a: [failing(QUOTA)] });
  assert.equal(await createPrimitives(twice.ctx).agent("x", { adapter: ["a", "a", "b"] }), "b answered");
  assert.deepEqual(twice.calls.map((c) => c.adapter), ["a", "b"], "an adapter listed twice runs once");

  await assert.rejects(createPrimitives(routed(config()).ctx).agent("x", { adapter: [] }), (err: Error) =>
    err instanceof ConfigError && /adapter must be an adapter name or a non-empty list of them; got \[\]/.test(err.message),
  );
  await assert.rejects(createPrimitives(routed(config()).ctx).agent("x", { adapter: ["a", "nope"] }), AdapterNotFound);
});

test("a fallback runs the call's permission tier: one that cannot is skipped with a log line, and none is ever run at another", async () => {
  // stream-json, as the built-in claude adapter reads it.
  const claudeReply = (result: string) => ok(JSON.stringify({ type: "result", subtype: "success", is_error: false, result }) + "\n");
  const config = defaultConfig();
  config.settings.defaultAdapter = "codex";
  const saved: AgentResultRecord[] = [];
  const read = routed(config, { codex: [failing(QUOTA)], claude: [claudeReply("read it")] }, { saveAgentResult: (rec) => void saved.push(rec) });
  const review = createPrimitives(read.ctx).agent("review it", { adapter: ["codex", "qwen", "claude"], permissions: "read", label: "review" });
  assert.equal(await review, "read it");
  assert.deepEqual(read.calls.map((c) => c.adapter), ["codex", "claude"], "qwen has no read-only mode: never run");
  assert.ok(read.calls[1]!.command.includes("dontAsk"), "claude runs read-only");
  assert.deepEqual(logs(read.sink), [
    `review:1: skipped fallback 'qwen': it cannot run this agent's permissions "read" — a fallback never runs at another tier`,
    "review:1 → claude after codex quota",
  ]);
  assert.equal(saved[0]!.permissions, "read");

  // A run at "full" whose first adapter has no full mode runs "edit": its fallback runs "edit" too, never "full".
  const full = defaultConfig();
  full.settings.permissions = "full";
  const edit = routed(full, { kimi: [failing(QUOTA)], claude: [claudeReply("edited")] });
  assert.equal(await createPrimitives(edit.ctx).agent("fix it", { adapter: ["kimi", "claude"] }), "edited");
  assert.deepEqual(edit.calls.map((c) => c.adapter), ["kimi", "claude"]);
  assert.ok(edit.calls[1]!.command.includes("acceptEdits"));
  assert.ok(!edit.calls[1]!.command.includes("bypassPermissions"), "not escalated to full");
  assert.equal(edit.sink.ofType(AGENT_STARTED)[0]!.permissions, "edit");
});

test("a fallback's transcript goes on after an attempt line naming the next adapter, kept as it prints; the failed run's usage counts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-routing-transcript-"));
  try {
    const config = routingConfig({ fallback: { claude: ["b"] } });
    config.settings.defaultAdapter = "claude";
    const reset = Math.floor(Date.now() / 1000) + 3 * 3600;
    const spent = ok(
      [
        { type: "system", subtype: "init", session_id: "s1", model: "claude-sonnet-4-5" },
        {
          type: "result",
          subtype: "success",
          is_error: true,
          result: `Claude AI usage limit reached|${reset}`,
          usage: { input_tokens: 120, output_tokens: 7 },
          total_cost_usd: 0.002,
        },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
    );
    const paths = (agentId: number) => ({ transcript: join(dir, `${agentId}.transcript.jsonl`), stderr: join(dir, `${agentId}.stderr.txt`) });
    const { ctx, sink } = routed(config, { claude: [spent], b: [ok("line one\nline two\n")] }, { agentTranscriptPaths: paths });
    assert.equal(await createPrimitives(ctx).agent("x", { label: "x" }), "line one\nline two");

    const text = readFileSync(paths(1).transcript, "utf8");
    const lines = text.trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(lines.map((line) => line.type ?? line.kind), ["system", "result", "attempt", "text", "text"]);
    assert.deepEqual(lines[2], { kind: "attempt", n: 2, reason: "fallback", adapter: "b" });
    assert.deepEqual(lines[3], { kind: "text", text: "line one\n" }, "b's output kept as text: its own format");
    const attempt = normalizeTranscript(text).find((entry) => entry.kind === "attempt")!;
    assert.deepEqual([attempt.text, attempt.reason, attempt.adapter], ["attempt 2: fallback to b", "fallback", "b"]);

    const usage = sink.ofType(AGENT_FINISHED)[0]!.usage as Usage;
    assert.deepEqual([usage.inputTokens, usage.costUsd], [120, 0.002], "what the spent quota's run reported still counts");
    assert.equal(ctx.usage.outputTokens, 7, "toward the run's budget too");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a fallback takes a slot on its new adapter — the old one's let go first — and waits for it like a dispatch", async () => {
  const config = routingConfig({ fallback: { a: ["b"] } });
  config.adapters.a!.concurrency = 1;
  config.adapters.b!.concurrency = 1;
  const sink = new MemorySink();
  const ctx = buildContext(config, { sink });
  const order: string[] = [];
  let releaseY!: () => void;
  const yHolds = new Promise<void>((resolve) => (releaseY = resolve));
  ctx.bridge = new Bridge(config, {
    runner: async (command, opts) => {
      const adapter = command[0]!.replace(/-cli$/, "");
      const who = /\bTASK-(\w)\b/.exec(String(opts?.stdin))?.[1] ?? "?";
      order.push(`${who}@${adapter}`);
      if (who === "Y") await yHolds;
      return who === "X" && adapter === "a" ? failing(QUOTA) : ok(`${who} on ${adapter}`);
    },
  });
  const p = createPrimitives(ctx);
  const y = p.agent("TASK-Y", { adapter: "b" });
  await until(() => order.includes("Y@b"));
  const x = p.agent("TASK-X"); // on a; falls back to b, whose one slot Y holds
  const z = p.agent("TASK-Z"); // on a: it starts once X has let go of a's slot
  await until(() => order.includes("Z@a"));
  assert.deepEqual(order, ["Y@b", "X@a", "Z@a"], "X waits for b holding nothing on a");
  assert.equal(await z, "Z on a");
  releaseY();
  assert.equal(await y, "Y on b");
  assert.equal(await x, "X on b");
  assert.deepEqual(order, ["Y@b", "X@a", "Z@a", "X@b"]);
  assert.equal(ctx.scheduler.dispatched, 3, "a fallback is no new dispatch");
  assert.ok(logs(sink).includes("a:2 → b after a quota"));
});

// --- the quota breaker ------------------------------------------------------------------

test("the quota breaker: three quota failures in a row take an adapter out of the run with one log line; later calls start past it", async () => {
  const { ctx, sink, calls } = routed(routingConfig({ fallback: { a: ["b"] } }), { a: [failing(QUOTA), failing(QUOTA), failing(QUOTA)] });
  const p = createPrimitives(ctx);
  for (const label of ["one", "two", "three"]) assert.equal(await p.agent(label, { label }), "b answered");
  const tripped = sink.ofType(LOG).filter((e) => e.tripped === true);
  assert.equal(tripped.length, 1);
  assert.equal(tripped[0]!.adapter, "a");
  assert.match(
    String(tripped[0]!.message),
    /^warning: 3 agents in a row failed on adapter 'a' \(usage quota\) — the run's later agents skip it: each starts on the next adapter of its fallback chain, or fails at once without one\./,
  );
  assert.equal(logs(sink).filter((m) => /will likely fail too/.test(m)).length, 0, "one warning, not two");

  calls.length = 0;
  assert.equal(await p.agent("four", { label: "four" }), "b answered");
  assert.deepEqual(calls.map((c) => c.adapter), ["b"], "a runs no more");
  assert.equal(sink.ofType(AGENT_STARTED).at(-1)!.adapter, "b", "the agent starts on b: its slot and events say so");
  assert.equal(sink.ofType(AGENT_FINISHED).at(-1)!.fellBackFrom, undefined, "it never ran on a");

  // With nowhere else to go, a call fails at once, its CLI never started.
  await assert.rejects(
    p.agent("five", { adapter: ["a"] }),
    (err: Error) =>
      err instanceof AdapterExecutionError &&
      err.reason === "quota" &&
      /^adapter 'a' is out of usage quota for the rest of this run \(the quota breaker skips it\) — wait/.test(err.message),
  );
  assert.deepEqual(calls.map((c) => c.adapter), ["b"]);
  assert.equal(sink.ofType(AGENT_FAILED).at(-1)!.reason, "quota");

  // A fallback passes over an adapter the breaker took out, silently: its warning said so once.
  const hop = routed(routingConfig(), { b: [failing(QUOTA), failing(QUOTA), failing(QUOTA)], a: [failing(QUOTA)] });
  const q = createPrimitives(hop.ctx);
  for (let i = 0; i < 3; i++) await assert.rejects(q.agent(`b ${i}`, { adapter: ["b"] }));
  assert.equal(await q.agent("x", { adapter: ["a", "b", "c"], label: "x" }), "c answered");
  assert.deepEqual(hop.calls.map((c) => c.adapter), ["b", "b", "b", "a", "c"]);
  assert.equal(logs(hop.sink).at(-1), "x:4 → c after a quota");
});

test("an agent whose adapter the breaker took out while it waited for a slot moves on at once, without running it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-routing-waited-"));
  try {
    const paths = (agentId: number) => ({ transcript: join(dir, `${agentId}.transcript.jsonl`), stderr: join(dir, `${agentId}.stderr.txt`) });
    const config = routingConfig({ concurrency: 1, quotaBreaker: 1, fallback: { a: ["b"] } });
    const { ctx, sink, calls } = routed(config, { a: [failing(QUOTA)] }, { agentTranscriptPaths: paths });
    const p = createPrimitives(ctx);
    // Both are routed to a at once; the second waits for the only slot while the first trips the breaker.
    assert.deepEqual(await p.parallel([() => p.agent("one", { label: "one" }), () => p.agent("two", { label: "two" })]), [
      "b answered",
      "b answered",
    ]);
    assert.deepEqual(calls.map((c) => c.adapter), ["a", "b", "b"], "a ran once: for the first agent only");
    assert.deepEqual(
      sink.ofType(AGENT_STARTED).map((e) => [e.label, e.adapter]),
      [
        ["one", "a"],
        ["two", "a"],
      ],
    );
    assert.ok(logs(sink).includes("two:2 → b after a quota"));
    const two = sink.ofType(AGENT_FINISHED).find((e) => e.label === "two")!;
    assert.deepEqual([two.adapter, two.fellBackFrom], ["b", ["a"]]);
    const first = JSON.parse(readFileSync(paths(2).transcript, "utf8").split("\n")[0]!);
    assert.deepEqual(first, { kind: "attempt", n: 1, reason: "fallback", adapter: "b" }, "its transcript says why it starts on b");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("quotaBreaker: a success on the adapter starts its count over; null never skips one", async () => {
  {
    const { ctx, sink, calls } = routed(routingConfig({ quotaBreaker: 2 }), {
      a: [failing(QUOTA), ok("fine"), failing(QUOTA), failing(QUOTA)],
    });
    const p = createPrimitives(ctx);
    await assert.rejects(p.agent("1"));
    assert.equal(await p.agent("2"), "fine");
    await assert.rejects(p.agent("3"));
    assert.equal(sink.ofType(LOG).filter((e) => e.tripped === true).length, 0, "quota, success, quota: no two in a row");
    await assert.rejects(p.agent("4"));
    assert.equal(sink.ofType(LOG).filter((e) => e.tripped === true).length, 1);
    await assert.rejects(p.agent("5"), /out of usage quota for the rest of this run/);
    assert.equal(calls.length, 4, "the fifth never started a CLI");
  }
  const { ctx, calls } = routed(routingConfig({ quotaBreaker: null }), { a: Array.from({ length: 5 }, () => failing(QUOTA)) });
  const p = createPrimitives(ctx);
  for (let i = 0; i < 5; i++) await assert.rejects(p.agent(String(i)));
  assert.equal(calls.length, 5, "every call still tries its adapter");
});

// --- model tiers ------------------------------------------------------------------------

test("model tiers: '@fast' is the model the adapter a call runs on has for it — after a fallback, the next one's", async () => {
  const config = routingConfig({
    fallback: { a: ["b", "c"] },
    models: { fast: { a: "a-mini", b: "b-flash" }, strong: { a: "a-max" } },
  });
  const { ctx, sink, calls } = routed(config, { a: [failing(QUOTA)], b: [failing(QUOTA)] });
  const p = createPrimitives(ctx);
  assert.equal(await p.agent("x", { model: "@fast", label: "x" }), "c answered");
  assert.deepEqual(
    calls.map((c) => [c.adapter, c.model]),
    [
      ["a", "a-mini"],
      ["b", "b-flash"],
      ["c", null],
    ],
  );
  assert.ok(logs(sink).includes("model tier '@fast' has no model for adapter 'c' — the CLI's own default model is used"));

  calls.length = 0;
  p.phase("Deep", { model: "@strong" });
  await p.agent("y");
  await p.agent("z", { model: "@cf/meta/llama-3" });
  assert.deepEqual(
    calls.map((c) => [c.adapter, c.model]),
    [
      ["a", "a-max"],
      ["a", "@cf/meta/llama-3"],
    ],
    "a tier as a phase default; a model id that only starts with '@' is a model id",
  );
});

test("an unknown model tier fails the agent before its CLI starts, naming the tiers there are", async () => {
  const { ctx, sink, calls } = routed(routingConfig({ models: { fast: { a: "a-mini" }, strong: { a: "a-max" } } }));
  await assert.rejects(
    createPrimitives(ctx).agent("x", { model: "@fsat" }),
    (err: Error) => err instanceof AgentError && err.message === "agent() model '@fsat' names no model tier: the tiers are @fast, @strong",
  );
  assert.deepEqual(calls, []);
  assert.equal(sink.ofType(AGENT_FAILED).length, 1);
  assert.equal(ctx.scheduler.fatalError, undefined, "one agent's mistake, not the run's");
  await assert.rejects(createPrimitives(routed(routingConfig()).ctx).agent("x", { model: "@fast" }), /none is configured \(set "models" in the config\)/);
});

// --- what readers show ------------------------------------------------------------------

test("readers follow a fallback: the running agent moves with its log line, and settled agents keep the adapters they left", () => {
  const events = [
    { ts: 1, type: "run_started", runId: "r" },
    { ts: 1, type: "agent_started", agentId: 1, label: "search", phase: null, adapter: "codex" },
    { ts: 2, type: "log", message: "search:1 → claude after codex quota", agentId: 1, label: "search", adapter: "claude", fellBackFrom: ["codex"], reason: "quota" },
  ];
  const fold = new EventFold().apply(events);
  assert.deepEqual([fold.agents[0]!.state, fold.agents[0]!.adapter, fold.agents[0]!.fellBackFrom], ["running", "claude", ["codex"]]);
  fold.apply([
    { ts: 3, type: "agent_finished", agentId: 1, label: "search", adapter: "claude", fellBackFrom: ["codex"], attempts: 1 },
    { ts: 4, type: "agent_started", agentId: 2, label: "write", adapter: "codex" },
    { ts: 5, type: "agent_failed", agentId: 2, label: "write", error: "AdapterExecutionError: …", reason: "quota", adapter: "gemini", fellBackFrom: ["codex", "claude"] },
    { ts: 6, type: "agent_started", agentId: 3, label: "plain", adapter: "codex" },
    // Other lines that name an agent and an adapter move nothing.
    { ts: 7, type: "log", message: "warning: …", agentId: 3, adapter: "claude", reason: "quota", tripped: true },
    { ts: 8, type: "agent_failed", agentId: 3, label: "plain", error: "boom", reason: "exit" },
  ]);
  assert.deepEqual(
    fold.agents.map((a) => [a.state, a.adapter, a.fellBackFrom]),
    [
      ["done", "claude", ["codex"]],
      ["failed", "gemini", ["codex", "claude"]],
      ["failed", "codex", undefined],
    ],
  );
  const facts = { status: { state: "running", pid: process.pid }, meta: {}, fold };
  const copy = detailFrom("r", facts, { hasResult: false, error: null });
  copy.agents[0]!.fellBackFrom!.push("x");
  assert.deepEqual(fold.agents[0]!.fellBackFrom, ["codex"], "a reader's copy is its own");

  assert.match(
    formatEvent({ ts: 3, type: "agent_finished", label: "search", adapter: "claude", fellBackFrom: ["codex"] }),
    /agent_finished\s+search \(codex → claude\)$/,
  );
  const agents = detailFrom("r", facts, { hasResult: false, error: null }).agents;
  assert.deepEqual(fallbackLines(agents, [{ ts: 7, type: "log", message: "warning: …", adapter: "claude", tripped: true }]), [
    "fell back: 2 agents — search:1 codex → claude, write:2 codex → claude → gemini",
    "quota breaker: claude out of usage quota — the run's later agents skip it",
  ]);
  assert.deepEqual(fallbackLines([], []), [], "nothing to say about a run without either");
});

test("the live view shows where a running agent moved, and a settled one's path", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-routing-live-"));
  try {
    const store = new RunStore(root);
    const id = store.create({ script: "/tmp/never-read/wf.js", args: null, source: root, workflowName: "routes" });
    store.updateStatus(id, { state: "running", pid: process.pid, name: "routes" });
    const emit = (ev: Record<string, unknown>) => appendFileSync(store.eventsPath(id), JSON.stringify(ev) + "\n");
    const term = new FakeTerm(120);
    const out = { isTTY: false, write: (_chunk: string) => {} };
    emit({ ts: 10, type: "run_started", runId: id });
    emit({ ts: 10, type: "agent_started", agentId: 1, label: "search", adapter: "codex" });
    const done = attachRun(store, id, { out, err: term, live: true, pollMs: 10, signals: false, env: { TERM: "xterm", LANG: "en_US.UTF-8" } });
    emit({ ts: 11, type: "log", message: "search:1 → claude after codex quota", agentId: 1, label: "search", adapter: "claude", fellBackFrom: ["codex"] });
    // Still running: only its line in the active block can say so yet.
    await until(() => /search\s+codex → claude/.test(term.text()));
    emit({ ts: 12, type: "agent_finished", agentId: 1, label: "search", adapter: "claude", fellBackFrom: ["codex"], attempts: 1 });
    emit({ ts: 12, type: "run_failed", runId: id, error: "done here" });
    store.updateStatus(id, { state: "failed" });
    assert.equal(await done, 1);
    assert.match(term.text(), /✔ search\s+codex → claude · 2\.0s/);
    assert.match(term.text(), /search:1 → claude after codex quota/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- end to end -------------------------------------------------------------------------

/** Run the CLI with stdout/stderr captured. */
async function cli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  (process.stdout as { write: unknown }).write = (s: unknown) => (out.push(String(s)), true);
  (process.stderr as { write: unknown }).write = (s: unknown) => (err.push(String(s)), true);
  try {
    const code = await main(argv);
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
  }
}

const WORKFLOW = `export const meta = {
  name: 'routes',
  description: 'search on a CLI whose quota is spent, then report',
  phases: [{ title: 'Search', adapter: 'spent', model: '@fast' }, 'Report'],
}
phase('Search')
const found = await agent('find it', { label: 'search' })
phase('Report')
const report = await agent('write it up: ' + found, { label: 'report' })
return { found, report }
`;

test("end to end: a phase routes its agents, a spent quota falls back with the next CLI's tier model, and odw resume walks no chain", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-routing-e2e-"));
  try {
    const counter = join(root, "spent-runs");
    // `spent` counts its runs and is always out of quota; `good` answers with the model it was given.
    const spent = `require('fs').appendFileSync(${JSON.stringify(counter)}, '.'); process.stderr.write(${JSON.stringify(QUOTA)}); process.exit(1)`;
    const good =
      "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const a=process.argv;const i=a.indexOf('--model');" +
      "process.stdout.write('good:'+(i===-1?'default':a[i+1]))})";
    const configPath = join(root, "odw.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        defaultAdapter: "good",
        adapters: {
          spent: { command: [execPath, "-e", spent, "--"], stdin: "{prompt}", flags: { model: ["--model"] } },
          good: { command: [execPath, "-e", good, "--"], stdin: "{prompt}", flags: { model: ["--model"] } },
        },
        fallback: { spent: ["good"] },
        models: { fast: { spent: "s-mini", good: "g-mini" } },
      }),
    );
    const script = join(root, "routes.js");
    writeFileSync(script, WORKFLOW);
    const store = new RunStore(join(root, "runs"));
    const id = store.create({ script, args: null, source: root, configPath });
    assert.equal(await executeRun(store.runDir(id)), "done");
    assert.deepEqual(store.readResult(id), { found: "good:g-mini", report: "good:default" });
    assert.equal(readFileSync(counter, "utf8").length, 1, "spent ran once");

    const events = store.readEvents(id);
    assert.ok(events.some((e) => e.type === "log" && e.message === "search:1 → good after spent quota"));
    const search = events.find((e) => e.type === "agent_finished" && e.label === "search")!;
    assert.deepEqual([search.adapter, search.fellBackFrom], ["good", ["spent"]]);
    const record = store.listAgentResults(id).find((rec) => rec.label === "search")!;
    assert.deepEqual([record.adapter, record.fellBackFrom], ["good", ["spent"]]);
    const transcript = readFileSync(store.agentTranscriptPaths(id, 1).transcript, "utf8");
    assert.ok(transcript.includes('{"kind":"attempt","n":2,"reason":"fallback","adapter":"good"}'));
    const status = await cli(["status", id, "--runs-root", join(root, "runs")]);
    assert.match(status.out, /^ {2}fell back: 1 agent — search:1 spent → good$/m);

    // Resumed: both calls replay — spent never runs again, and the record keeps its path.
    const resumed = store.create({ script, args: null, source: root, configPath, resumedFrom: { runId: id, dir: store.runDir(id) } });
    assert.equal(await executeRun(store.runDir(resumed)), "done");
    assert.deepEqual(store.readResult(resumed), { found: "good:g-mini", report: "good:default" });
    assert.equal(readFileSync(counter, "utf8").length, 1, "no chain was walked again");
    const replayed = store.readEvents(resumed).filter((e) => e.type === "agent_finished");
    assert.deepEqual(
      replayed.map((e) => [e.label, e.cached, e.adapter, e.fellBackFrom]),
      [
        ["search", true, "good", ["spent"]],
        ["report", true, "good", undefined],
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
