import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import { collectConfigWarnings, defaultConfig, loadConfig } from "../src/adapters/config.js";
import { AdapterOutputDecoder, decodeOutput } from "../src/adapters/output.js";
import type { AdapterOutput, CliResult } from "../src/adapters/types.js";
import { Bridge, type ModelSubstitution } from "../src/bridge.js";
import { AdapterExecutionError } from "../src/errors.js";
import type { WorkflowEvent } from "../src/events.js";
import { BEHAVIOUR_SETTINGS, runSetup } from "../src/provenance.js";
import { agentRowJson, agentRows, formatAgentTable } from "../src/runtime/agents-view.js";
import { compareRuns, formatAgentComparison, formatComparison, type CompareRunInput, type RunAgent } from "../src/runtime/compare.js";
import { estimateWorkflow, formatEstimate, type HistoryRun } from "../src/runtime/estimate.js";
import { formatEvent } from "../src/runtime/live-view.js";
import { RunStore } from "../src/runtime/run-store.js";
import { detail } from "../src/runtime/runs-view.js";
import { executeRun } from "../src/runtime/worker.js";
import { isSubstituted, sameModel } from "../src/served-model.js";

// The model that served an agent (ODW extension): a call's `model` is only a
// request — an allowlist, a plan or a retired id can put the agent on another
// model, and the reply never says (anthropics/claude-code#102655, #73597).
// Where a CLI's events name the model (the adapter's `output.servedModel`
// rules; Claude Code's init event, assistant messages and result modelUsage),
// ODW records it beside the request; a mismatch is a model_substituted event,
// and under modelMismatch "fail" the agent fails with that reason. A CLI that
// names none is "not reported" — never guessed.

const EXPECT_AGENT = fileURLToPath(new URL("./fixtures/expect-agent.mjs", import.meta.url));
const CLAUDE = defaultConfig().adapters.claude!;
type Jsonl = Extract<AdapterOutput, { format: "jsonl" }>;

const init = (model?: string) => ({ type: "system", subtype: "init", cwd: "/repo", session_id: "s", tools: ["Read"], mcp_servers: [], ...(model ? { model } : {}) });
const said = (model: string, text = "On it.") => ({
  type: "assistant",
  message: { id: "msg", type: "message", role: "assistant", model, content: [{ type: "text", text }] },
  session_id: "s",
});
const result = (modelUsage?: Record<string, unknown>, text = "Done.") => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: text,
  session_id: "s",
  permission_denials: [],
  total_cost_usd: 0.01,
  usage: { input_tokens: 1, output_tokens: 2 },
  ...(modelUsage ? { modelUsage } : {}),
});
const lines = (...events: unknown[]): string => events.map((e) => JSON.stringify(e)).join("\n") + "\n";
const usage = { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01 };

function ok(stdout: string): CliResult {
  return { returncode: 0, stdout, stderr: "", timedOut: false, duration: 0.01 };
}

function config(settings: Record<string, unknown> = {}) {
  const cfg = defaultConfig();
  Object.assign(cfg.settings, { defaultAdapter: "claude", ...settings });
  return cfg;
}

// --- comparing ---------------------------------------------------------------------------------

test("a served model is the requested one by alias, prefix, case, suffix and provider; any other is a substitution", () => {
  const same: Array<[string, string]> = [
    ["claude-opus-4-8", "claude-opus-4-8"],
    ["opus", "claude-opus-5-5"],
    ["Opus", "claude-opus-5-5-20261001"],
    ["sonnet[1m]", "claude-sonnet-4-5"],
    ["claude-sonnet-4-5", "claude-sonnet-4-5-20250929"],
    ["claude-opus-4-8", "us.anthropic.claude-opus-4-8-v1:0"],
    ["anthropic/claude-sonnet-4-5", "claude-sonnet-4-5"],
    ["best", "claude-opus-5-5"],
    ["opusplan", "claude-sonnet-4-5"],
    ["default", "claude-haiku-4-5"],
    ["gpt-5.6", "gpt-5.6"],
  ];
  for (const [requested, served] of same) assert.ok(sameModel(requested, served), `${requested} ~ ${served}`);
  const other: Array<[string, string]> = [
    ["opus", "claude-sonnet-4-5"],
    ["claude-opus-4-8", "claude-opus-4-7"],
    ["claude-opus-4-8", "fable-1"],
    ["sonnet", "claude-sonnets-4"],
    ["best", "claude-sonnet-4-5"],
    ["gpt-5.6", "gpt-5.5"],
  ];
  for (const [requested, served] of other) assert.ok(!sameModel(requested, served), `${requested} ≁ ${served}`);

  // A helper model beside the one asked for is no substitution; none of them being it is.
  assert.equal(isSubstituted("opus", ["claude-opus-5-5", "claude-haiku-4-5"]), false);
  assert.equal(isSubstituted("opus", ["claude-sonnet-4-5", "claude-haiku-4-5"]), true);
  // No request, or nothing reported: never a substitution.
  assert.equal(isSubstituted(undefined, ["claude-sonnet-4-5"]), false);
  assert.equal(isSubstituted("opus", undefined), false);
  assert.equal(isSubstituted("opus", []), false);
});

// --- reading the stream ------------------------------------------------------------------------

test("claude's stream names the served model: init, assistant messages (not <synthetic>) and modelUsage keys, in order, once each", () => {
  const out = decodeOutput(
    CLAUDE,
    lines(
      init("claude-opus-5-5"),
      said("claude-opus-5-5"),
      said("<synthetic>", "API Error: interrupted"),
      said("claude-opus-5-5"),
      result({ "claude-opus-5-5": usage, "claude-haiku-4-5": usage }),
    ),
  );
  assert.equal(out.text, "Done.");
  assert.deepEqual(out.servedModel, ["claude-opus-5-5", "claude-haiku-4-5"]);
  // A stream that names none — an older CLI, a test double — reports none.
  assert.equal(decodeOutput(CLAUDE, lines(init(), result())).servedModel, undefined);
  // Only what the stream says: the init model alone, when the session ends early.
  assert.deepEqual(decodeOutput(CLAUDE, lines(init("claude-sonnet-4-5"), result())).servedModel, ["claude-sonnet-4-5"]);

  // Incrementally, in any chunking, as in one go.
  const whole = lines(init("claude-sonnet-4-5"), said("claude-sonnet-4-5"), result({ "claude-sonnet-4-5": usage }));
  for (const size of [1, 7, 64]) {
    const decoder = new AdapterOutputDecoder(CLAUDE);
    for (let i = 0; i < whole.length; i += size) decoder.write(whole.slice(i, i + size));
    assert.deepEqual(decoder.finish().servedModel, ["claude-sonnet-4-5"], `chunks of ${size}`);
  }
});

test("only adapters that declare servedModel rules report one: codex and agy name no model; any JSONL adapter may declare its own", () => {
  const cfg = defaultConfig();
  for (const name of ["codex", "agy"]) assert.equal((cfg.adapters[name]!.output as Jsonl).servedModel, undefined, name);
  const codex = lines(
    { type: "thread.started", thread_id: "t" },
    { type: "item.completed", item: { id: "i", type: "agent_message", text: "Done." } },
    { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
  );
  assert.equal(decodeOutput(cfg.adapters.codex!, codex).servedModel, undefined);

  const mine = {
    ...CLAUDE,
    name: "mine",
    output: {
      format: "jsonl",
      eventKey: "event",
      eventType: "done",
      textPath: ["text"],
      select: "last",
      servedModel: [{ event: "start", path: ["models"] }, { event: "done", path: ["model"] }],
    } as AdapterOutput,
  };
  const out = decodeOutput(mine, lines({ event: "start", models: ["m-1", "", 7, "m-2"] }, { event: "done", model: " m-3 ", text: "ok" }));
  assert.deepEqual(out.servedModel, ["m-1", "m-2", "m-3"], "strings of an array count; blanks and others do not");
});

// --- config ------------------------------------------------------------------------------------

test("modelMismatch and output.servedModel load, default, validate, and are recorded in the run's setup", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-served-"));
  try {
    const load = (raw: Record<string, unknown>) => {
      const path = join(dir, "odw.config.json");
      writeFileSync(path, JSON.stringify(raw));
      return loadConfig(path, { quiet: true });
    };
    assert.equal(defaultConfig().settings.modelMismatch, "warn");
    assert.equal(load({ modelMismatch: "fail" }).settings.modelMismatch, "fail");
    assert.equal(load({ modelMismatch: null }).settings.modelMismatch, "warn");
    assert.throws(() => load({ modelMismatch: "error" }), /"modelMismatch" must be "warn" or "fail"; got "error"/);
    assert.deepEqual(collectConfigWarnings({ modelMismatch: "fail" }), []);
    assert.ok((BEHAVIOUR_SETTINGS as readonly string[]).includes("modelMismatch"));
    assert.equal(runSetup(load({ modelMismatch: "fail" })).settings.modelMismatch, "fail");

    // The built-in declaration round-trips through config, and the example spells it out.
    const servedModel = (CLAUDE.output as Jsonl).servedModel!;
    const output = { format: "jsonl", eventType: "result", textPath: ["result"], select: "last", servedModel };
    assert.deepEqual(load({ adapters: { mine: { command: ["x"], output } } }).adapters.mine!.output, output);
    assert.deepEqual(collectConfigWarnings({ adapters: { mine: { command: ["x"], output } } }), []);
    assert.deepEqual(loadConfig(join(process.cwd(), "odw.config.example.json"), { quiet: true }).adapters.claude!.output, CLAUDE.output);

    const bad = (rules: unknown) => () => load({ adapters: { mine: { command: ["x"], output: { ...output, servedModel: rules } } } });
    assert.throws(bad([]), /adapter 'mine' 'output\.servedModel' must be a non-empty array of rules/);
    assert.throws(bad(["model"]), /'output\.servedModel\[0\]' must be an object/);
    assert.throws(bad([{ path: ["model"] }]), /servedModel\[0\]'\.event must be a non-empty string/);
    assert.throws(bad([{ event: "e" }]), /'output\.servedModel\[0\]\.path' must be a non-empty array of strings/);
    assert.throws(bad([{ event: "e", path: ["m"], keys: "yes" }]), /\.keys must be true or false/);
    assert.throws(bad([{ event: "e", path: ["m"], wher: [] }]), /unknown key 'wher'/);
    assert.throws(bad([{ event: "e", path: ["m"], where: [{ path: ["a"] }] }]), /needs "equals" or "not"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the bridge --------------------------------------------------------------------------------

test("the bridge: the served model goes with the outcome; another one than asked for is told, then kept (warn) or fails (fail)", async () => {
  const swapped = lines(init("claude-sonnet-4-5"), said("claude-sonnet-4-5"), result({ "claude-sonnet-4-5": usage }));
  const told: ModelSubstitution[] = [];
  const warned = await new Bridge(config(), { runner: async () => ok(swapped) }).run(
    { prompt: "x", model: "opus" },
    { onModelSubstituted: (s) => told.push(s) },
  );
  assert.equal(warned.value, "Done.");
  assert.deepEqual(warned.servedModel, ["claude-sonnet-4-5"]);
  assert.deepEqual(told, [{ adapter: "claude", requested: "opus", served: ["claude-sonnet-4-5"] }]);

  // Served as asked — an alias, a dated id — or asked for nothing: recorded, never a substitution.
  for (const model of ["sonnet", "claude-sonnet-4-5", undefined]) {
    const quiet: ModelSubstitution[] = [];
    const out = await new Bridge(config({ modelMismatch: "fail" }), { runner: async () => ok(swapped) }).run(
      { prompt: "x", ...(model ? { model } : {}) },
      { onModelSubstituted: (s) => quiet.push(s) },
    );
    assert.deepEqual(out.servedModel, ["claude-sonnet-4-5"], String(model));
    assert.deepEqual(quiet, [], String(model));
  }

  // A tier is compared as the id the CLI was asked for.
  const tiered = config({ models: { deep: { claude: "claude-opus-5-5" } } });
  const viaTier: ModelSubstitution[] = [];
  await new Bridge(tiered, { runner: async () => ok(swapped) }).run({ prompt: "x", model: "@deep" }, { onModelSubstituted: (s) => viaTier.push(s) });
  assert.deepEqual(viaTier, [{ adapter: "claude", requested: "claude-opus-5-5", served: ["claude-sonnet-4-5"] }]);

  // fail: reason model_substituted, not retried, not a fallback; the models are its evidence.
  let runs = 0;
  const failedTold: ModelSubstitution[] = [];
  await assert.rejects(
    new Bridge(config({ modelMismatch: "fail" }), { runner: async () => (runs++, ok(swapped)) }).run(
      { prompt: "x", model: "opus", adapter: ["claude", "codex"] },
      { onModelSubstituted: (s) => failedTold.push(s) },
    ),
    (err: unknown) =>
      err instanceof AdapterExecutionError &&
      err.reason === "model_substituted" &&
      err.message ===
        "adapter 'claude' was served by another model than the one it was asked for (modelMismatch: \"fail\") — check that the " +
          "account may use the model (an allowlist, a plan), or ask for the one that served it: served by: claude-sonnet-4-5",
  );
  assert.equal(runs, 1, "not retried, nor fallen back");
  assert.equal(failedTold.length, 1, "told before it fails");

  // The CLI's own failure report comes first.
  const loggedOut = lines(init("claude-sonnet-4-5"), { ...result(undefined, "Not logged in · Please run /login"), is_error: true });
  await assert.rejects(
    new Bridge(config({ modelMismatch: "fail" }), { runner: async () => ok(loggedOut) }).run({ prompt: "x", model: "opus" }),
    (err: unknown) => err instanceof AdapterExecutionError && err.reason === "auth",
  );
});

// --- the whole stack ---------------------------------------------------------------------------

interface Flow {
  id: string;
  state: string;
  store: RunStore;
  result: Record<string, unknown>;
  events: WorkflowEvent[];
  calls: number;
}

/** One agent() call labelled `review` on a scripted CLI that speaks the built-in claude's stream-json, `--model` and all. */
async function runAgent(root: string, plan: unknown[], opts: Record<string, unknown> = {}, settings: Record<string, unknown> = {}): Promise<Flow> {
  const log = join(root, "calls.jsonl");
  const configPath = join(root, "odw.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      defaultAdapter: "claude",
      ...settings,
      adapters: { claude: { command: [execPath, EXPECT_AGENT, log, "--claude"], stdin: "{prompt}", flags: { model: ["--model"] }, output: CLAUDE.output } },
    }),
  );
  const script = join(root, "wf.js");
  writeFileSync(
    script,
    "export const meta = { name: 'wf', description: 'd' }\n" +
      "try { return { value: await agent('Review it. PLAN: ' + JSON.stringify(args.plan), args.opts) } }\n" +
      "catch (err) { return { error: String(err) } }\n",
  );
  const store = new RunStore(join(root, "runs"));
  const id = store.create({ script, args: { plan, opts: { label: "review", ...opts } }, source: root, configPath });
  const state = await executeRun(store.runDir(id));
  return {
    id,
    state,
    store,
    result: (store.readResult(id) ?? {}) as Record<string, unknown>,
    events: store.readEvents(id),
    calls: existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0,
  };
}

const ofType = (events: WorkflowEvent[], type: string) => events.filter((e) => e.type === type);
const onSonnet = [said("claude-sonnet-4-5", "Looking.")];

test("warn: the reply stands; the served model is on the agent's event, record, view and odw agents, and the substitution is said once", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-served-"));
  try {
    const flow = await runAgent(root, [{ reply: "Looks good.", stream: onSonnet }], { model: "opus" });
    assert.deepEqual(flow.result, { value: "Looks good." });
    const finished = ofType(flow.events, "agent_finished")[0]!;
    assert.deepEqual(finished.servedModel, ["claude-sonnet-4-5"]);
    assert.deepEqual(flow.store.readAgentResult(flow.id, 1)?.servedModel, ["claude-sonnet-4-5"]);
    const swaps = ofType(flow.events, "model_substituted");
    assert.equal(swaps.length, 1);
    assert.deepEqual(
      { ...swaps[0], ts: 0 },
      {
        ts: 0,
        type: "model_substituted",
        message:
          "review:1: asked claude for model 'opus' but it was served by claude-sonnet-4-5 — its reply is kept; " +
          'modelMismatch: "fail" fails such an agent',
        agentId: 1,
        label: "review",
        phase: null,
        adapter: "claude",
        requested: "opus",
        served: ["claude-sonnet-4-5"],
        policy: "warn",
      },
    );
    assert.match(formatEvent(swaps[0]!), /model_substituted.*asked claude for model 'opus' but it was served by claude-sonnet-4-5/);
    assert.match(formatEvent(finished), /review — served by claude-sonnet-4-5$/);

    const view = detail(flow.store, flow.id).agents[0]!;
    assert.equal(view.model, "opus");
    assert.deepEqual(view.servedModel, ["claude-sonnet-4-5"]);
    assert.deepEqual(view.substituted, { requested: "opus", served: ["claude-sonnet-4-5"] });

    const rows = agentRows(flow.store, flow.id);
    assert.deepEqual(
      [rows[0]!.model, rows[0]!.servedModel, agentRowJson(rows[0]!).substituted],
      ["opus", ["claude-sonnet-4-5"], { requested: "opus", served: ["claude-sonnet-4-5"] }],
    );
    const table = formatAgentTable(rows, { width: 160, caps: { color: false, truecolor: false, unicode: true } }).join("\n");
    assert.match(table, /\[served by claude-sonnet-4-5, asked opus\] Looks good\./);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("served as asked, or not reported: recorded (or not), nothing said", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-served-"));
  const root2 = mkdtempSync(join(tmpdir(), "odw-served-"));
  try {
    const asked = await runAgent(root, [{ reply: "Looks good.", stream: onSonnet }], { model: "sonnet" });
    assert.deepEqual(ofType(asked.events, "agent_finished")[0]!.servedModel, ["claude-sonnet-4-5"]);
    assert.equal(ofType(asked.events, "model_substituted").length, 0);
    assert.equal(detail(asked.store, asked.id).agents[0]!.substituted, undefined);

    // The scripted CLI's init names no model and nothing else does: not reported, never guessed.
    const silent = await runAgent(root2, [{ reply: "Looks good." }], { model: "opus" }, { modelMismatch: "fail" });
    assert.deepEqual(silent.result, { value: "Looks good." });
    assert.equal(ofType(silent.events, "agent_finished")[0]!.servedModel, undefined);
    assert.equal(silent.store.readAgentResult(silent.id, 1)?.servedModel, undefined);
    assert.equal(detail(silent.store, silent.id).agents[0]!.servedModel, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(root2, { recursive: true, force: true });
  }
});

test("modelMismatch \"fail\": the agent fails with reason model_substituted, at once, shown as such", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-served-"));
  try {
    const flow = await runAgent(root, [{ reply: "Looks good.", stream: onSonnet }], { model: "opus" }, { modelMismatch: "fail" });
    assert.match(String(flow.result.error), /^AdapterExecutionError: adapter 'claude' was served by another model .*: served by: claude-sonnet-4-5$/);
    const failed = ofType(flow.events, "agent_failed")[0]!;
    assert.equal(failed.reason, "model_substituted");
    assert.equal(ofType(flow.events, "model_substituted")[0]!.policy, "fail");
    const view = detail(flow.store, flow.id).agents[0]!;
    assert.equal(view.failureReason, "model_substituted");
    assert.deepEqual(view.substituted, { requested: "opus", served: ["claude-sonnet-4-5"] });
    assert.equal(flow.calls, 1, "not retried");
    assert.match(formatEvent(failed), /review — \[model_substituted\] AdapterExecutionError: /);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- compare and estimate ----------------------------------------------------------------------

function compareAgent(extra: Partial<RunAgent>): RunAgent {
  return {
    agentId: 1,
    label: "review",
    phase: null,
    key: null,
    state: "done",
    adapter: "claude",
    model: "opus",
    attempts: 1,
    durationMs: 1000,
    usage: null,
    cached: false,
    error: null,
    failureReason: null,
    changes: null,
    ...extra,
  };
}

function compareRun(runId: string, agents: RunAgent[]): CompareRunInput {
  return {
    runId,
    name: "wf",
    workflowName: "wf",
    state: "done",
    live: false,
    createdAt: 100,
    startedAt: 100,
    endedAt: 160,
    script: "/p/wf.js",
    inline: false,
    args: null,
    adapter: null,
    permissions: null,
    budgetTotal: null,
    odwVersion: "0.5.0",
    sourceHash: "a".repeat(64),
    resumedFrom: null,
    setup: { settings: {}, adapters: { claude: "c1" } },
    cliVersions: {},
    agents,
  };
}

test("odw compare sets the served models side by side, and flags the agent another model served", () => {
  const a = compareRun("A", [compareAgent({ servedModel: ["claude-opus-5-5"] })]);
  const b = compareRun("B", [compareAgent({ servedModel: ["claude-sonnet-4-5"], substituted: true })]);
  const cmp = compareRuns(a, b);
  assert.deepEqual(cmp.setup, [{ field: "modelsServed", a: ["claude-opus-5-5"], b: ["claude-sonnet-4-5"] }]);
  assert.deepEqual([cmp.agents[0]!.a!.servedModel, cmp.agents[0]!.a!.substituted], [["claude-opus-5-5"], false]);
  assert.deepEqual([cmp.agents[0]!.b!.servedModel, cmp.agents[0]!.b!.substituted], [["claude-sonnet-4-5"], true]);
  const table = formatComparison(cmp, { width: 200, caps: { color: false, truecolor: false, unicode: true } }).join("\n");
  assert.match(table, /models served\s+claude-opus-5-5 → claude-sonnet-4-5/);
  assert.match(table, /claude\/opus→claude\/op/, "the route column differs: B was served by another model");
  const one = formatAgentComparison(cmp.agents[0]!, cmp, { width: 200, caps: { color: false, truecolor: false, unicode: true } }).join("\n");
  assert.match(one, /A {2}#1 {2}done {2}claude\/opus {2}served by claude-opus-5-5/);
  assert.match(one, /B {2}#1 {2}done {2}claude\/opus {2}served by claude-sonnet-4-5/);
  // Not reported on one side: said so, not left blank.
  const unknown = compareRuns(compareRun("C", [compareAgent({})]), b);
  assert.deepEqual(unknown.setup, [{ field: "modelsServed", a: [], b: ["claude-sonnet-4-5"] }]);
  assert.equal(unknown.agents[0]!.a!.servedModel, null);
  assert.match(formatComparison(unknown, { width: 200, caps: { color: false, truecolor: false, unicode: true } }).join("\n"), /models served\s+not reported → claude-sonnet-4-5/);
});

test("odw estimate groups history by the model that served each agent, so one model's spend is not mixed with another's", () => {
  const H = "a".repeat(64);
  const run = (runId: string, served: Array<string | null>): HistoryRun => ({
    runId,
    sourceHash: H,
    args: null,
    startedAt: 1000,
    endedAt: 1010,
    agents: served.map((model, i) => ({
      label: `a-${i}`,
      phase: null,
      adapter: "claude",
      servedModel: model,
      startedAt: 1000,
      finishedAt: 1010,
      usage: { costUsd: model === "claude-opus-5-5" ? 1 : 0.2, outputTokens: 10 },
    })),
  });
  const est = estimateWorkflow([run("r2", ["claude-opus-5-5", "claude-sonnet-4-5"]), run("r1", ["claude-opus-5-5", null])], { workflow: "wf", sourceHash: H });
  assert.deepEqual(
    est.models!.map((m) => [m.model, m.runs, m.costUsd?.p50]),
    [
      ["claude-opus-5-5", 2, 1],
      ["claude-sonnet-4-5", 1, 0.2],
      ["(not reported)", 1, 0.2],
    ],
  );
  assert.match(formatEstimate(est, { width: 120, caps: { color: false, truecolor: false, unicode: true } }).join("\n"), /model claude-sonnet-4-5/);
  // No agent's CLI named a model: no model grouping at all.
  assert.equal(estimateWorkflow([run("r0", [null])], { workflow: "wf", sourceHash: H }).models, undefined);
});
