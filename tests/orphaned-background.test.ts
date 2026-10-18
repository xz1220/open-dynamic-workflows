import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import { collectConfigWarnings, defaultConfig, loadConfig } from "../src/adapters/config.js";
import { AdapterOutputDecoder, decodeOutput } from "../src/adapters/output.js";
import type { Adapter, AdapterOutput, CliResult } from "../src/adapters/types.js";
import { Bridge } from "../src/bridge.js";
import { AdapterExecutionError, UnmetExpectationError } from "../src/errors.js";
import type { WorkflowEvent } from "../src/events.js";
import { Expectations, planChecks } from "../src/expect.js";
import { BEHAVIOUR_SETTINGS, runSetup } from "../src/provenance.js";
import { formatEvent } from "../src/runtime/live-view.js";
import { RunStore } from "../src/runtime/run-store.js";
import { detail } from "../src/runtime/runs-view.js";
import { executeRun } from "../src/runtime/worker.js";

// Orphaned background work (ODW extension): Claude Code's headless mode lets
// an agent start a background shell command or subagent, end its turn and
// exit — the work dies with the CLI, and the result says success
// (anthropics/claude-code#85129). ODW reads the task events in its stream-json
// (the adapter's `output.background` rules): work still open at the result
// event was orphaned. "warn" records and logs it, "fail" fails the agent with
// reason orphaned_background, and with `expect` it is a miss.

const EXPECT_AGENT = fileURLToPath(new URL("./fixtures/expect-agent.mjs", import.meta.url));

const CLAUDE = defaultConfig().adapters.claude!;
type Jsonl = Extract<AdapterOutput, { format: "jsonl" }>;
const CLAUDE_BACKGROUND = (CLAUDE.output as Jsonl).background!;

// --- Claude Code's stream-json, as `claude -p --output-format stream-json --verbose` prints it ----

const init = { type: "system", subtype: "init", cwd: "/repo", session_id: "s", tools: ["Bash", "Agent", "TaskOutput", "TaskStop"], mcp_servers: [] };

/** An assistant message with one tool call. */
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text: "On it." }, { type: "tool_use", id, name, input }] },
  session_id: "s",
});

/** The tool's immediate answer: a background call returns at once. */
const toolResult = (id: string, content: string) => ({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] },
  session_id: "s",
});

/** The Agent SDK's system task messages (Claude Code 2.1). */
const taskStarted = (taskId: string, fields: Record<string, unknown>) => ({ type: "system", subtype: "task_started", task_id: taskId, session_id: "s", ...fields });
const taskNotification = (taskId: string, status: string, toolUseId?: string) => ({
  type: "system",
  subtype: "task_notification",
  task_id: taskId,
  ...(toolUseId ? { tool_use_id: toolUseId } : {}),
  status,
  output_file: `/tmp/tasks/${taskId}.output`,
  summary: `Background command ${status}`,
  session_id: "s",
});
const taskUpdated = (taskId: string, status: string) => ({ type: "system", subtype: "task_updated", task_id: taskId, patch: { status }, session_id: "s" });

const result = (text = "All done: the server is up and the tests pass.") => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: text,
  session_id: "s",
  permission_denials: [],
  total_cost_usd: 0.01,
  usage: { input_tokens: 1, output_tokens: 2 },
});

/** A background `npm run dev`: the Bash call, its immediate answer, and the task it registered. */
const devServer = [
  toolUse("toolu_dev", "Bash", { command: "npm run dev", description: "Start the dev server", run_in_background: true }),
  toolResult("toolu_dev", "Command running in background with ID: bdev1. Output is being written to: /tmp/tasks/bdev1.output."),
  taskStarted("bdev1", { tool_use_id: "toolu_dev", description: "Start the dev server", task_type: "local_bash", is_backgrounded: true }),
];

/** A background subagent: Agent calls run in the background unless they say otherwise. */
const surveyAgent = [
  toolUse("toolu_survey", "Agent", { description: "Survey the parsers", prompt: "Read every parser…", subagent_type: "Explore" }),
  toolResult("toolu_survey", "Async agent launched successfully. agentId: a1b2"),
  taskStarted("a1b2", { tool_use_id: "toolu_survey", description: "Survey the parsers", task_type: "local_agent", subagent_type: "Explore", is_backgrounded: true }),
];

const stream = (...events: unknown[]): string => [init, ...events].map((event) => JSON.stringify(event)).join("\n") + "\n";

function ok(stdout: string): CliResult {
  return { returncode: 0, stdout, stderr: "", timedOut: false, duration: 0.01 };
}

function config(settings: Record<string, unknown> = {}) {
  const cfg = defaultConfig();
  Object.assign(cfg.settings, { defaultAdapter: "claude", ...settings });
  return cfg;
}

// --- reading the stream ------------------------------------------------------------------------

test("a background Bash left running at the result is orphaned: one piece of work under its tool call and its task", () => {
  const out = decodeOutput(CLAUDE, stream(...devServer, result()));
  assert.equal(out.text, "All done: the server is up and the tests pass.");
  assert.deepEqual(out.orphaned, ["Bash (Start the dev server)"], "the tool call names it; the task it registered is the same work");
  // Its command stands in when the call has no description.
  const bare = toolUse("toolu_x", "Bash", { command: "sleep 600", run_in_background: true });
  assert.deepEqual(decodeOutput(CLAUDE, stream(bare, result())).orphaned, ["Bash (sleep 600)"], "a tool call alone counts, for a CLI that registers no task");
});

test("awaited background work is not orphaned: a task notification, a terminal task update, or the notification as text ends it", () => {
  const ends: Array<[string, unknown[]]> = [
    ["task_notification by task id", [taskNotification("bdev1", "completed")]],
    ["task_notification by tool use id", [{ ...taskNotification("other", "failed", "toolu_dev") }]],
    ["killed by TaskStop", [toolUse("toolu_stop", "TaskStop", { task_id: "bdev1" }), taskNotification("bdev1", "killed", "toolu_dev")]],
    ["task_updated completed", [taskUpdated("bdev1", "completed")]],
    ["task_updated failed", [taskUpdated("bdev1", "failed")]],
    [
      "the notification injected as a user message (text block)",
      [{ type: "user", message: { role: "user", content: [{ type: "text", text: "<task-notification>\n<task-id>bdev1</task-id>\n<status>completed</status>\n</task-notification>" }] } }],
    ],
    [
      "the notification injected as a user message (string content), by tool use id",
      [{ type: "user", message: { role: "user", content: "<task-notification><tool-use-id>toolu_dev</tool-use-id><status>completed</status></task-notification>" } }],
    ],
  ];
  for (const [how, events] of ends) {
    assert.equal(decodeOutput(CLAUDE, stream(...devServer, ...events, result())).orphaned, undefined, how);
  }
  // A running status does not end it, nor does reading its output so far.
  const progress = [taskUpdated("bdev1", "running"), toolUse("toolu_read", "TaskOutput", { task_id: "bdev1", block: false })];
  assert.deepEqual(decodeOutput(CLAUDE, stream(...devServer, ...progress, result())).orphaned, ["Bash (Start the dev server)"]);
  // Nor does a tool_result that only quotes an id (the background call's immediate answer).
  assert.deepEqual(decodeOutput(CLAUDE, stream(...devServer, toolResult("toolu_dev", "<task-id>"), result())).orphaned, ["Bash (Start the dev server)"]);
});

test("a background subagent — the Agent tool's default — left running is orphaned, named by its type and description", () => {
  const out = decodeOutput(CLAUDE, stream(...surveyAgent, result()));
  assert.deepEqual(out.orphaned, ["Explore (Survey the parsers)"], "no run_in_background on the call: the task event says it");
  // An explicit background Agent call, and a Task call from older versions.
  const explicit = toolUse("toolu_t", "Task", { description: "Write the changelog", prompt: "…", run_in_background: true });
  assert.deepEqual(decodeOutput(CLAUDE, stream(explicit, result())).orphaned, ["Task (Write the changelog)"]);
  // Two at once, in the order they started; one awaited leaves the other.
  const both = decodeOutput(CLAUDE, stream(...devServer, ...surveyAgent, result()));
  assert.deepEqual(both.orphaned, ["Bash (Start the dev server)", "Explore (Survey the parsers)"]);
  const one = decodeOutput(CLAUDE, stream(...devServer, ...surveyAgent, taskNotification("a1b2", "completed", "toolu_survey"), result()));
  assert.deepEqual(one.orphaned, ["Bash (Start the dev server)"]);
});

test("foreground work, teammates and finished subagents are not orphaned; the latest result decides", () => {
  const foreground = [
    toolUse("toolu_fg", "Agent", { description: "Check the types", prompt: "…", run_in_background: false }),
    taskStarted("afg", { tool_use_id: "toolu_fg", description: "Check the types", task_type: "local_agent", is_backgrounded: false, awaited: true }),
    taskNotification("afg", "completed", "toolu_fg"),
    toolResult("toolu_fg", "The types check."),
  ];
  assert.equal(decodeOutput(CLAUDE, stream(...foreground, result())).orphaned, undefined);
  const teammate = taskStarted("tm1", { description: "pair", task_type: "in_process_teammate" });
  assert.equal(decodeOutput(CLAUDE, stream(teammate, result())).orphaned, undefined, "Claude Code's own runner does not count teammates");
  // A CLI that goes on after a result (a follow-up turn once the task ended): the latest result decides.
  const followUp = stream(...devServer, result("Started it."), taskNotification("bdev1", "completed"), result("It finished."));
  assert.deepEqual([decodeOutput(CLAUDE, followUp).text, decodeOutput(CLAUDE, followUp).orphaned], ["It finished.", undefined]);
  // No result at all: nothing was given while it ran.
  assert.equal(decodeOutput(CLAUDE, stream(...devServer)).orphaned, undefined);
  // A late start of work that already ended does not reopen it.
  assert.equal(decodeOutput(CLAUDE, stream(...devServer, taskNotification("bdev1", "completed"), devServer[2], result())).orphaned, undefined);
});

test("the decoder reads the stream incrementally, in any chunking, as in one go", () => {
  const whole = stream(...devServer, ...surveyAgent, taskNotification("a1b2", "completed"), result());
  for (const size of [1, 7, 64]) {
    const decoder = new AdapterOutputDecoder(CLAUDE);
    for (let i = 0; i < whole.length; i += size) decoder.write(whole.slice(i, i + size));
    assert.deepEqual(decoder.finish().orphaned, ["Bash (Start the dev server)"], `chunks of ${size}`);
  }
});

test("any JSONL adapter can declare its own background rules; one that declares none reads none", () => {
  const { background: _b, ...plain } = CLAUDE.output as Jsonl;
  assert.equal(decodeOutput({ ...CLAUDE, output: plain }, stream(...devServer, result())).orphaned, undefined);
  // An agy-like CLI: `subagent.started` / `subagent.done` events, and a reply event.
  const agy: Adapter = {
    name: "agy",
    command: ["agy"],
    output: {
      format: "jsonl",
      eventType: "reply",
      textPath: ["text"],
      select: "last",
      background: {
        started: [{ event: "subagent.started", ids: [["id"]], kind: [["agent"]], about: [["goal"]] }],
        ended: [{ event: "subagent.done", ids: [["id"]] }],
      },
    },
  };
  const lines = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  const out = decodeOutput(agy, lines({ type: "subagent.started", id: 7, agent: "researcher", goal: "find the bug" }, { type: "reply", text: "Done." }));
  assert.deepEqual(out, { text: "Done.", orphaned: ["researcher (find the bug)"] }, "numeric ids count");
  assert.equal(decodeOutput(agy, lines({ type: "subagent.started", id: 7 }, { type: "subagent.done", id: 7 }, { type: "reply", text: "Done." })).orphaned, undefined);
  assert.deepEqual(decodeOutput(agy, lines({ type: "subagent.started", id: "x" }, { type: "reply", text: "Done." })).orphaned, ["background work"]);
});

// --- the bridge ------------------------------------------------------------------------------

test("the bridge: warn keeps the reply and reports the work; fail fails with reason orphaned_background; a CLI's own error comes first", async () => {
  const left = stream(...devServer, result());
  const warned = await new Bridge(config(), { runner: async () => ok(left) }).run({ prompt: "x" });
  assert.equal(warned.value, "All done: the server is up and the tests pass.");
  assert.deepEqual(warned.orphaned, ["Bash (Start the dev server)"]);
  const fine = await new Bridge(config(), { runner: async () => ok(stream(...devServer, taskNotification("bdev1", "completed"), result())) }).run({ prompt: "x" });
  assert.equal(fine.orphaned, undefined);

  let runs = 0;
  await assert.rejects(
    new Bridge(config({ orphanedBackground: "fail" }), { runner: async () => (runs++, ok(left)) }).run({ prompt: "x" }),
    (err: unknown) =>
      err instanceof AdapterExecutionError &&
      !(err instanceof UnmetExpectationError) &&
      err.reason === "orphaned_background" &&
      err.message ===
        "adapter 'claude' ended its turn with background work still running, which died when its CLI exited — have the agent wait " +
          "for that work before it replies, or run it in the foreground: left running: Bash (Start the dev server)",
  );
  assert.equal(runs, 1, "not retried");
  const loggedOut = new Bridge(config({ orphanedBackground: "fail" }), {
    runner: async () => ok(stream(...devServer, { ...result("Not logged in · Please run /login"), is_error: true })),
  });
  await assert.rejects(loggedOut.run({ prompt: "x" }), (err: unknown) => err instanceof AdapterExecutionError && err.reason === "auth");
});

test("with expect, orphaned work is a miss: retried with the work named, then an orphaned_background failure with its misses", async () => {
  const plan = planChecks({ expect: { match: "done" } }).expect!;
  const checks = () => new Expectations(plan, 1, { exec: async () => assert.fail("no command to run") });
  // Under "fail" too: with expect it is a miss, handed back to the agent first.
  const prompts: string[] = [];
  const retried = await new Bridge(config({ orphanedBackground: "fail" }), {
    runner: async (_command, options) => {
      prompts.push(options?.stdin ?? "");
      return ok(prompts.length === 1 ? stream(...devServer, result("done")) : stream(...devServer, taskNotification("bdev1", "completed"), result("done")));
    },
  }).run({ prompt: "start the server and check it" }, { expect: checks() });
  assert.equal(retried.attempts, 2);
  assert.equal(retried.orphaned, undefined, "the value rests on the run that waited");
  assert.match(
    prompts[1]!,
    /^- no background work may still be running at the reply, and 1 was: Bash \(Start the dev server\)\. Background work dies when your reply ends the session: wait for every background command and subagent to finish/m,
  );

  await assert.rejects(
    new Bridge(config(), { runner: async () => ok(stream(...surveyAgent, result("not yet"))) }).run({ prompt: "x" }, { expect: checks() }),
    (err: unknown) =>
      err instanceof UnmetExpectationError &&
      err.reason === "orphaned_background" &&
      err.misses.length === 2 &&
      err.misses[0] === "no background work may still be running at the reply, and 1 was: Explore (Survey the parsers)" &&
      err.misses[1] === "the reply must match /done/, and it does not" &&
      /left running: Explore \(Survey the parsers\) — and its work did not meet: the reply must match \/done\/, and it does not$/.test(err.message),
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

/** One agent() call labelled `serve`, whose scripted CLI speaks stream-json with the built-in claude's output declaration. */
async function runAgent(root: string, plan: unknown[], opts: Record<string, unknown> = {}, settings: Record<string, unknown> = {}): Promise<Flow> {
  const log = join(root, "calls.jsonl");
  const configPath = join(root, "odw.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      defaultAdapter: "claude",
      ...settings,
      adapters: { claude: { command: [execPath, EXPECT_AGENT, log, "--claude"], stdin: "{prompt}", output: CLAUDE.output } },
    }),
  );
  const script = join(root, "wf.js");
  writeFileSync(
    script,
    "export const meta = { name: 'wf', description: 'd' }\n" +
      "try { return { value: await agent('Start the server. PLAN: ' + JSON.stringify(args.plan), args.opts) } }\n" +
      "catch (err) { return { error: String(err) } }\n",
  );
  const store = new RunStore(join(root, "runs"));
  const id = store.create({ script, args: { plan, opts: { label: "serve", ...opts } }, source: root, configPath });
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
const orphanLogs = (events: WorkflowEvent[]) => ofType(events, "log").filter((e) => Array.isArray(e.orphaned));
const tempRoot = () => mkdtempSync(join(tmpdir(), "odw-orphans-"));

test("warn: the reply stands, the work is kept on the agent's event, record and view, and logged once", async () => {
  const root = tempRoot();
  try {
    const flow = await runAgent(root, [{ reply: "Server is up.", stream: devServer }]);
    assert.deepEqual(flow.result, { value: "Server is up." });
    const finished = ofType(flow.events, "agent_finished")[0]!;
    assert.deepEqual(finished.orphaned, ["Bash (Start the dev server)"]);
    assert.deepEqual(flow.store.readAgentResult(flow.id, 1)?.orphaned, ["Bash (Start the dev server)"]);
    assert.deepEqual(detail(flow.store, flow.id).agents[0]!.orphaned, ["Bash (Start the dev server)"]);
    const logs = orphanLogs(flow.events);
    assert.equal(logs.length, 1);
    assert.equal(
      logs[0]!.message,
      "serve:1: claude ended its turn with 1 background task still running — Bash (Start the dev server); it died when the CLI " +
        'exited, so its reply may rest on work that never finished (orphanedBackground: "fail" fails such an agent)',
    );
    assert.match(formatEvent(finished), /serve — left running: Bash \(Start the dev server\)$/);

    // Work it waited for leaves nothing to record or say.
    const awaited = await runAgent(tempRootIn(root), [{ reply: "Server is up.", stream: [...devServer, taskNotification("bdev1", "completed")] }]);
    assert.equal(ofType(awaited.events, "agent_finished")[0]!.orphaned, undefined);
    assert.equal(orphanLogs(awaited.events).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A fresh directory under `root`, for a second run. */
function tempRootIn(root: string): string {
  return mkdtempSync(join(root, "again-"));
}

test("orphanedBackground \"fail\": the agent fails with reason orphaned_background, at once, shown as such", async () => {
  const root = tempRoot();
  try {
    const flow = await runAgent(root, [{ reply: "Server is up.", stream: devServer }], {}, { orphanedBackground: "fail" });
    assert.match(String(flow.result.error), /^AdapterExecutionError: adapter 'claude' ended its turn with background work still running.*: left running: Bash \(Start the dev server\)$/);
    const failed = ofType(flow.events, "agent_failed")[0]!;
    assert.equal(failed.reason, "orphaned_background");
    assert.equal(detail(flow.store, flow.id).agents[0]!.failureReason, "orphaned_background");
    assert.equal(flow.calls, 1, "not retried");
    assert.match(formatEvent(failed), /serve — \[orphaned_background\] AdapterExecutionError: /);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("with expect: the orphan is handed back once, and an agent that waits the second time passes", async () => {
  const root = tempRoot();
  const root2 = tempRoot();
  try {
    const waits = [
      { reply: "Server is up.", stream: devServer },
      { reply: "Server is up.", stream: [...devServer, taskNotification("bdev1", "completed")] },
    ];
    const flow = await runAgent(root, waits, { expect: { match: "up" } });
    assert.deepEqual(flow.result, { value: "Server is up." });
    assert.equal(flow.calls, 2);
    assert.equal(ofType(flow.events, "agent_finished")[0]!.orphaned, undefined);
    assert.equal(ofType(flow.events, "log").filter((e) => Array.isArray(e.misses)).length, 1, "the retry is logged");

    const never = await runAgent(root2, [{ reply: "Server is up.", stream: surveyAgent }], { expect: { match: "up" } });
    const failed = ofType(never.events, "agent_failed")[0]!;
    assert.equal(failed.reason, "orphaned_background");
    assert.deepEqual(failed.misses, ["no background work may still be running at the reply, and 1 was: Explore (Survey the parsers)"]);
    assert.equal(never.calls, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(root2, { recursive: true, force: true });
  }
});

// --- config ------------------------------------------------------------------------------------

test("orphanedBackground and output.background load, default, validate, and are recorded in the run's setup", () => {
  const dir = tempRoot();
  try {
    const load = (raw: Record<string, unknown>) => {
      const path = join(dir, "odw.config.json");
      writeFileSync(path, JSON.stringify(raw));
      return loadConfig(path, { quiet: true });
    };
    assert.equal(defaultConfig().settings.orphanedBackground, "warn");
    assert.equal(load({ orphanedBackground: "fail" }).settings.orphanedBackground, "fail");
    assert.equal(load({ orphanedBackground: null }).settings.orphanedBackground, "warn");
    assert.throws(() => load({ orphanedBackground: "error" }), /"orphanedBackground" must be "warn" or "fail"; got "error"/);
    assert.deepEqual(collectConfigWarnings({ orphanedBackground: "fail" }), []);
    assert.ok((BEHAVIOUR_SETTINGS as readonly string[]).includes("orphanedBackground"));
    assert.equal(runSetup(load({ orphanedBackground: "fail" })).settings.orphanedBackground, "fail");

    // The built-in declaration round-trips through config, and the example spells it out.
    const output = { format: "jsonl", eventType: "result", textPath: ["result"], select: "last", background: CLAUDE_BACKGROUND };
    assert.deepEqual(load({ adapters: { mine: { command: ["x"], output } } }).adapters.mine!.output, output);
    assert.deepEqual(collectConfigWarnings({ adapters: { mine: { command: ["x"], output } } }), []);
    assert.deepEqual(loadConfig(join(process.cwd(), "odw.config.example.json"), { quiet: true }).adapters.claude!.output, CLAUDE.output);

    const bad = (background: unknown) => () => load({ adapters: { mine: { command: ["x"], output: { ...output, background } } } });
    const rule = { event: "e", ids: [["id"]] };
    assert.throws(bad("yes"), /adapter 'mine' 'output\.background' must be an object/);
    assert.throws(bad({ started: [rule] }), /'output\.background'\.ended must be a non-empty array of rules/);
    assert.throws(bad({ started: [rule], ended: [rule], stopped: [] }), /unknown key 'stopped'/);
    assert.throws(bad({ started: [{ ids: [["id"]] }], ended: [rule] }), /background\.started\[0\]'\.event must be a non-empty string/);
    assert.throws(bad({ started: [{ event: "e", ids: [] }], ended: [rule] }), /\.ids must be a non-empty array of paths/);
    assert.throws(bad({ started: [{ event: "e", ids: ["id"] }], ended: [rule] }), /'output\.background\.started\[0\]\.ids\[0\]' must be a non-empty array of strings/);
    assert.throws(bad({ started: [rule], ended: [{ ...rule, about: [["x"]] }] }), /ends work: 'kind' and 'about' describe work as it starts/);
    assert.throws(bad({ started: [{ ...rule, where: [{ path: ["a"] }] }], ended: [rule] }), /needs "equals" or "not"/);
    assert.throws(bad({ started: [{ ...rule, where: [{ path: ["a"], equals: {} }] }], ended: [rule] }), /\.equals must be a string, number, boolean or null/);
    assert.throws(bad({ started: [{ ...rule, wher: [] }], ended: [rule] }), /unknown key 'wher'/);
    assert.throws(bad({ started: [rule], ended: [{ ...rule, pattern: "(" }] }), /\.pattern is not a valid regular expression/);
    assert.throws(bad({ started: [rule], ended: [{ ...rule, pattern: "id-\\d+" }] }), /\.pattern needs a capture group/);
    // One JSON document has no stream of events to read it from: warned about, like any misplaced field.
    const json = { format: "json", textPath: ["t"], background: CLAUDE_BACKGROUND };
    assert.equal(collectConfigWarnings({ adapters: { mine: { command: ["x"], output: json } } }).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
