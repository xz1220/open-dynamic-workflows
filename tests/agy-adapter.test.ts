import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import { BUILTIN_ADAPTERS } from "../src/adapters/builtin.js";
import { collectConfigWarnings, defaultConfig, listAdapters, loadConfig } from "../src/adapters/config.js";
import { classifyFailure } from "../src/adapters/failures.js";
import { planSchema } from "../src/adapters/native-schema.js";
import { decodeOutput } from "../src/adapters/output.js";
import { planPermissions } from "../src/adapters/permissions.js";
import { runCommand, type CommandRunner } from "../src/adapters/runner.js";
import type { Config, Settings } from "../src/adapters/types.js";
import { normalizeUsage } from "../src/adapters/usage.js";
import { Bridge } from "../src/bridge.js";
import { judgeCase, loadSuite, outcomeOf } from "../src/conformance/suite.js";
import { runDoctor } from "../src/doctor.js";
import { AdapterExecutionError } from "../src/errors.js";
import { LimitWatch, type AgentLimits } from "../src/limits.js";
import { transcriptFacts } from "../src/otel.js";
import { RunStore } from "../src/runtime/run-store.js";
import { normalizeTranscript } from "../src/runtime/transcript-view.js";
import { executeRun } from "../src/runtime/worker.js";

// The built-in agy adapter (Google Antigravity CLI) on `--output-format
// stream-json` (https://antigravity.google/docs/cli/headless): its reply, usage,
// failures and refusals from the `result` event, its native --json-schema, its
// tiers, its transcript's tool steps — against a fake agy
// (tests/fixtures/fake-agy.mjs) that parses argv as agy does, since agy is not
// installed where these run. And the generic piece that carries it:
// `output.eventKey`, the key that names an event's type.

const FAKE_AGY = fileURLToPath(new URL("./fixtures/fake-agy.mjs", import.meta.url));

/** Every temp dir this file made, removed once its tests are done. */
const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "odw-agy-"));
  made.push(dir);
  return dir;
}

/** The built-in agy adapter, its executable the fake: the rest — argv, output, flags, tiers — as shipped. */
function agyConfig(settings: Partial<Settings> = {}): Config {
  const config = defaultConfig();
  const builtin = config.adapters.agy!;
  config.adapters.agy = { ...builtin, command: [execPath, FAKE_AGY, ...builtin.command.slice(1)] };
  config.settings.defaultAdapter = "agy";
  Object.assign(config.settings, settings);
  return config;
}

/** A bridge over the fake agy that runs it for real, and records its argv and backoff waits. */
function agyBridge(settings: Partial<Settings> = {}) {
  const spawned: string[][] = [];
  const slept: number[] = [];
  const runner: CommandRunner = (command, options) => {
    spawned.push(command);
    return runCommand(command, options);
  };
  const bridge = new Bridge(agyConfig(settings), { source: tempDir(), runner, sleep: async (ms) => void slept.push(ms), random: () => 0 });
  return { bridge, spawned, slept };
}

const agy = () => defaultConfig().adapters.agy!;
const lines = (...events: unknown[]): string => events.map((event) => (typeof event === "string" ? event : JSON.stringify(event))).join("\n") + "\n";
const result = (fields: Record<string, unknown>) => ({ event: "result", result: { conversation_id: "c", num_turns: 1, ...fields } });

/** The fake's own stdout for a prompt, run with the adapter's argv at the edit tier. */
async function fakeStdout(prompt: string): Promise<string> {
  const argv = agy().command.slice(1).flatMap((a) => (a === "{permission_args}" ? agy().permissionArgs!.edit : [a]));
  const out = await runCommand([execPath, FAKE_AGY, ...argv], { stdin: prompt, timeout: 30 });
  assert.equal(out.returncode, 0, out.stderr);
  return out.stdout;
}

// --- the declaration -----------------------------------------------------------------------

test("the built-in agy runs print mode on stream-json with the prompt on stdin, and declares how its events read", () => {
  const adapter = agy();
  assert.equal(adapter.label, "Antigravity CLI");
  assert.deepEqual(adapter.command, [
    "agy",
    "--output-format",
    "stream-json",
    "--input-format",
    "text",
    "--disable-slash-commands",
    "--print-timeout",
    "24h",
    "{permission_args}",
  ]);
  assert.equal(adapter.stdin, "{prompt}");
  assert.deepEqual(adapter.flags, { model: ["--model"], schema: { args: ["--json-schema"], mode: "inline", objectRoot: true } });
  assert.deepEqual(adapter.output, {
    format: "jsonl",
    eventKey: "event",
    eventType: "result",
    textPath: ["result", "response"],
    select: "last",
    usagePath: ["result", "usage"],
    errorPath: ["result", "error"],
    structuredPath: ["result", "structured_output"],
    deniedPath: ["result", "denied_actions"],
  });
  assert.equal("costPath" in adapter.output!, false, "agy reports no dollars: none is invented");
  assert.equal("background" in adapter.output!, false, "agy's stream says when a subagent starts, never when it ends");
  // Tiers: no documented read-only headless mode; edit pins accept-edits; full skips every prompt.
  assert.deepEqual(adapter.permissionArgs, {
    edit: ["--mode", "accept-edits"],
    full: ["--mode", "accept-edits", "--dangerously-skip-permissions"],
  });
  assert.match(String(planPermissions(adapter, "read").error), /^agy cannot run read-only \(adapter 'agy' declares no "read" permissionArgs\)/);
  assert.deepEqual(planPermissions(adapter, "full").args, ["--mode", "accept-edits", "--dangerously-skip-permissions"]);
  // Untrusted: no documented way to keep the repository out — said, not pretended.
  assert.equal(adapter.untrustedArgs, undefined);
  assert.match(String(adapter.untrustedNote), /^agy has no documented way to ignore the repository's AGENTS\.md, GEMINI\.md and \.agents\//);
  // What the doctor and the banner say of it.
  const row = (config: Config) => listAdapters(config).find((a) => a.name === "agy")!;
  const config = defaultConfig();
  assert.deepEqual(row(config).tiers, ["edit", "full"]);
  assert.equal(row(config).permissionNote, "mode: accept-edits");
  config.settings.permissions = "full";
  assert.equal(row(config).permissionNote, "mode: accept-edits · full autonomy (permission prompts skipped)");
  config.settings.permissions = "read";
  assert.equal(row(config).permissionNote, 'refused at permissions "read" (no read mode)');
  assert.deepEqual(BUILTIN_ADAPTERS.agy!.command, adapter.command);
});

// --- eventKey ---------------------------------------------------------------------------------

test("eventKey: events are typed by that key — the text, usage, error and denied paths read under it", () => {
  const adapter = agy();
  const stream = lines(
    { event: "init", conversation_id: "c", init: { cwd: "/w", tools: [], permission_mode: "request-review" } },
    { event: "step_update", step_update: { conversation_id: "c", step_index: 2, state: "DONE", step_type: "agent_response", text_delta: "hi\n" } },
    // A `type` key is no event type here: agy's events name theirs by `event`.
    { type: "result", result: { response: "not agy's" } },
    result({ status: "SUCCESS", response: "the answer\n", usage: { input_tokens: 278, output_tokens: 4, thinking_tokens: 0, cache_read_tokens: 30214, total_tokens: 282 } }),
  );
  assert.deepEqual(decodeOutput(adapter, stream), {
    text: "the answer",
    usage: { inputTokens: 30492, outputTokens: 4, cacheReadTokens: 30214 },
  });
  // The CLI's failure: status ERROR with an error message.
  assert.deepEqual(decodeOutput(adapter, lines(result({ status: "ERROR", response: "", error: "invalid model selection" }))), {
    text: "invalid model selection",
    error: "invalid model selection",
  });
  // Refused tool calls, as agy lists them.
  const denied = decodeOutput(adapter, lines(result({ status: "SUCCESS", response: "", denied_actions: [{ action: "command", display_name: "RunCommand" }] })));
  assert.deepEqual(denied.denied, ["RunCommand"]);
  // Read by `type` instead, the same stream's text event is the stray one.
  const typed = { ...adapter, output: { ...(adapter.output as object), eventKey: undefined } } as typeof adapter;
  assert.equal(decodeOutput(typed, stream).text, "not agy's");
  // And with no event of that type, it falls back to the raw stdout, saying so.
  assert.match(String(decodeOutput(typed, lines(result({ status: "SUCCESS", response: "x" }))).fallback), /no 'result' event was found/);
});

test("eventKey loads on a jsonl output, and a malformed one fails the load", () => {
  const dir = tempDir();
  const load = (output: Record<string, unknown>) => {
    const path = join(dir, "odw.config.json");
    writeFileSync(path, JSON.stringify({ adapters: { mine: { command: ["m"], output } } }));
    return loadConfig(path, { quiet: true });
  };
  const base = { format: "jsonl", eventType: "result", textPath: ["result", "response"], select: "last" };
  assert.deepEqual(load({ ...base, eventKey: "event" }).adapters.mine!.output, { ...base, eventKey: "event" });
  assert.throws(() => load({ ...base, eventKey: "" }), /'output\.eventKey' must be a non-empty string/);
  assert.throws(() => load({ ...base, eventKey: ["event"] }), /'output\.eventKey' must be a non-empty string/);
  assert.deepEqual(collectConfigWarnings({ adapters: { mine: { command: ["m"], output: { ...base, eventKey: "event" } } } }), []);
});

test("agy usage maps as documented: cache_read_tokens counted apart from input_tokens, thinking inside output; no cost", () => {
  // The docs' second turn: 278 input tokens, 30214 read from the cache, total_tokens = input + output.
  assert.deepEqual(normalizeUsage({ input_tokens: 278, output_tokens: 4, thinking_tokens: 0, cache_read_tokens: 30214, total_tokens: 282 }), {
    inputTokens: 30492,
    outputTokens: 4,
    cacheReadTokens: 30214,
  });
});

// --- native schema -------------------------------------------------------------------------------

test("objectRoot: an object-rooted schema goes to agy natively; any other goes in the prompt, and the run says so once", () => {
  const settings = { schemaKeywords: "warn", schemaPrompt: "auto" } as const;
  const object = { type: "object", properties: { n: { type: "integer" } }, required: ["n"] };
  const plan = planSchema(agy(), object, settings);
  assert.deepEqual([plan.native, plan.describe, plan.note], [{ args: ["--json-schema"], mode: "inline", objectRoot: true }, false, undefined]);
  const list = planSchema(agy(), { type: "array", items: { type: "string" } }, settings);
  assert.deepEqual([list.native, list.describe], [null, true]);
  assert.equal(
    list.note,
    `adapter 'agy' takes only object-rooted schemas natively ("type": "object" at the root): this schema goes in the prompt, and ODW alone checks the reply`,
  );
  // The flag loads from a config, and only as a boolean.
  const dir = tempDir();
  const path = join(dir, "odw.config.json");
  writeFileSync(path, JSON.stringify({ adapters: { mine: { command: ["m"], flags: { schema: { args: ["--s"], mode: "inline", objectRoot: "yes" } } } } }));
  assert.throws(() => loadConfig(path, { quiet: true }), /'flags\.schema\.objectRoot' must be true or false/);
});

// --- the fake agy, through the bridge ----------------------------------------------------------

test("an agy run: its reply is the result's response, its usage the result's — and the argv is one agy accepts", async () => {
  const { bridge, spawned } = agyBridge();
  const replied: unknown[] = [];
  const out = await bridge.run({ prompt: "Reply with exactly AGY_OK and nothing else" }, { onReply: (text, usage) => replied.push([text, usage]) });
  assert.equal(out.text, "AGY_OK");
  assert.deepEqual(replied, [["AGY_OK", { inputTokens: 18531, outputTokens: 589, cacheReadTokens: 8113 }]]);
  // The fake parses argv as agy does: these are the built-in's flags, the edit tier's after them.
  assert.deepEqual(spawned[0]!.slice(2), [
    "--output-format",
    "stream-json",
    "--input-format",
    "text",
    "--disable-slash-commands",
    "--print-timeout",
    "24h",
    "--mode",
    "accept-edits",
  ]);
  // A model goes after them; full adds its flag.
  const full = agyBridge({ permissions: "full" });
  await full.bridge.run({ prompt: "p", model: "gemini-3.8-flash-high" });
  assert.deepEqual(full.spawned[0]!.slice(-5), ["--mode", "accept-edits", "--dangerously-skip-permissions", "--model", "gemini-3.8-flash-high"]);
  // read is refused before anything spawns.
  const read = agyBridge({ permissions: "read" });
  await assert.rejects(() => read.bridge.run({ prompt: "p" }), /no "read" mode|read/);
  assert.deepEqual(read.spawned, []);
});

test("a schema reply: agy validates it natively (--json-schema inline), and its structured_output is the value", async () => {
  const VERDICT = {
    type: "object",
    properties: { verdict: { type: "string", enum: ["pass", "fail"] }, score: { type: "integer" } },
    required: ["verdict", "score"],
  };
  const { bridge, spawned } = agyBridge();
  const out = await bridge.run({ prompt: "CASE:schema", schema: VERDICT });
  assert.deepEqual([out.value, out.attempts], [{ verdict: "pass", score: 1 }, 1]);
  assert.deepEqual(spawned[0]!.slice(-2), ["--json-schema", JSON.stringify(VERDICT)]);
  // A schema agy would refuse at startup (its root not an object) never reaches it.
  await assert.rejects(() => bridge.run({ prompt: "CASE:schema", schema: { type: "array", items: { type: "string" } } }));
  assert.equal(spawned.at(-1)!.includes("--json-schema"), false);
});

test("a spent quota is a quota failure from agy's own words, with its reset; not retried", async () => {
  const state = join(tempDir(), "runs");
  const { bridge, slept } = agyBridge();
  await assert.rejects(
    () => bridge.run({ prompt: `CASE:quota STATE:${state}` }),
    (err: unknown) =>
      err instanceof AdapterExecutionError &&
      err.reason === "quota" &&
      err.message.startsWith("adapter 'agy' ran out of usage quota — wait for the window to reset (in 2h 39m) and resume the run") &&
      err.message.endsWith("Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h39m52s."),
  );
  assert.equal(readFileSync(state, "utf8"), "1", "it ran once: a quota fails fast");
  assert.deepEqual(slept, []);
  // AI credits run out the same way.
  await assert.rejects(
    () => agyBridge().bridge.run({ prompt: "CASE:credits" }),
    (err: unknown) => err instanceof AdapterExecutionError && err.reason === "quota" && /AI credits balance is too low/.test(err.message),
  );
});

test("a rate limit is ridden out: retried after the backoff, then the reply", async () => {
  const state = join(tempDir(), "runs");
  const { bridge, slept } = agyBridge();
  const out = await bridge.run({ prompt: `CASE:rate-limit STATE:${state}` });
  assert.equal(out.text, "final answer");
  assert.deepEqual(slept, [15_000]);
  assert.equal(readFileSync(state, "utf8"), "2");
});

test("a login agy does not have is an auth failure: not signed in at all, or signed out mid-run", async () => {
  for (const scenario of ["login", "expired"]) {
    await assert.rejects(
      () => agyBridge().bridge.run({ prompt: `CASE:${scenario}` }),
      (err: unknown) => err instanceof AdapterExecutionError && err.reason === "auth" && /^adapter 'agy' could not authenticate — log in to /.test(err.message),
      scenario,
    );
  }
});

test("a refused tool call that left no answer: an empty reply, with the refusal recorded", async () => {
  const { bridge } = agyBridge();
  await assert.rejects(
    () => bridge.run({ prompt: "CASE:denied" }),
    (err: unknown) => err instanceof AdapterExecutionError && err.reason === "empty_reply",
  );
  // A call that accepts an empty reply gets one, and what agy refused.
  const out = await bridge.run({ prompt: "CASE:denied", allowEmpty: true });
  assert.equal(out.text, "");
  assert.deepEqual(out.denied, ["RunCommand"]);
});

// --- failure wording -----------------------------------------------------------------------------

test("agy's failure wording classifies: quota, credits, rate limit, login", () => {
  const classify = (stdout: string, stderr = "") => classifyFailure({ returncode: 3, stdout, stderr, timedOut: false, duration: 1 }, { now: 0 });
  // google-antigravity/antigravity-cli#1018 (the result's error, 1.2.2).
  assert.deepEqual(
    classify("API error (attempt 3): RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h39m52s."),
    { reason: "quota", retryAfter: 9592 },
  );
  // #1018's comment: the AGY_ERROR line on stderr (1.2.14).
  assert.deepEqual(
    classify(
      "",
      'AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): Individual quota reached. ... Resets in 1h1m35s.","status":"RESOURCE_EXHAUSTED","error_code":429,"code_kind":"http","retryable":true}',
    ),
    { reason: "quota", retryAfter: 3695 },
  );
  // #789: the TUI's notice.
  assert.equal(classify("⚠ Individual quota reached. Please upgrade your subscription to increase your limits.\nResets in 143h57m55s.").reason, "quota");
  // Changelog 1.2.15.
  assert.equal(classify("Your AI credits balance is too low to continue.").reason, "quota");
  // A per-minute 429 agy could not retry away (composed: #1018's prefix, #1019's RESOURCE_EXHAUSTED message).
  assert.deepEqual(classify("API error (attempt 3): RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota)."), { reason: "rate_limit" });
  // https://antigravity.google/docs/cli/headless: "exits with an authentication required error".
  assert.equal(classify("", "error: authentication required").reason, "auth");
  // Changelog 1.3.3; #944; https://antigravity.google/docs/cli/troubleshooting.
  assert.equal(classify("Authentication expired. Please log back in.").reason, "auth");
  assert.equal(classify("", "Waiting for authentication (timeout 60s)...\nError: authentication timed out").reason, "auth");
  assert.equal(classify("", "Error: failed to retrieve token: secret keyring is locked").reason, "auth");
});

// --- transcripts --------------------------------------------------------------------------------

test("agy steps read as the transcript's entries: text joined from its fragments, tool calls and results, subagents, errors", async () => {
  const stdout = await fakeStdout("CASE:tools");
  const entries = normalizeTranscript(stdout).map(({ i: _i, ...entry }) => entry);
  assert.deepEqual(entries, [
    { kind: "raw", text: "permission mode request-review · 4 tools: run_command, view_file, write_to_file, grep_search" },
    { kind: "tool_call", tool: "run_command", input: { CommandLine: "echo hello_headless_demo" }, text: "echo hello_headless_demo" },
    { kind: "tool_result", tool: "run_command", text: "1 line", output: "hello_headless_demo\r\n", isError: false },
    { kind: "tool_call", tool: "view_file", input: { AbsolutePath: "/work/src/index.ts" }, text: "/work/src/index.ts" },
    { kind: "tool_result", tool: "view_file", text: "1 line", output: "export {}\n", isError: false },
    { kind: "tool_call", tool: "grep_search", input: { Query: "TODO" }, text: '{"Query":"TODO"}' },
    { kind: "tool_result", tool: "grep_search", text: "1 line", output: "no such directory: /nope", isError: true },
    { kind: "tool_call", tool: "run_command", input: { CommandLine: "rm -rf build" }, text: "rm -rf build" },
    {
      kind: "tool_result",
      tool: "run_command",
      text: "1 line",
      output: 'permission check failed for command "rm -rf build": user denied permission to run command',
      isError: true,
    },
    { kind: "raw", text: "subagent started (reviewer, code review) · log file:///tmp/agy/9ec58bfd-0001.log — its output is not in this stream" },
    { kind: "raw", text: "subagent started (browser, verify the page) · log file:///tmp/agy/9ec58bfd-0002.log — its output is not in this stream" },
    { kind: "tool_call", tool: "invoke_subagent" },
    { kind: "tool_result", tool: "invoke_subagent", text: "1 line", output: "2 subagents finished", isError: false },
    { kind: "error", text: "Malformed function call: retrying" },
    { kind: "text", text: "all done\n" },
    { kind: "result", isError: false, text: "all done\n", turns: 1 },
  ]);
  // A failed run's result says why.
  assert.deepEqual(
    normalizeTranscript(lines(result({ status: "ERROR", response: "", error: "Authentication expired. Please log back in." }))).map(({ i: _i, ...e }) => e),
    [{ kind: "result", isError: true, text: "Authentication expired. Please log back in.", turns: 1 }],
  );
  // The OpenTelemetry export reads the same tool steps.
  const facts = transcriptFacts(stdout.split("\n"));
  assert.deepEqual(
    facts.tools.map((t) => [t.name, t.isError]),
    [
      ["run_command", false],
      ["view_file", false],
      ["grep_search", true],
      ["run_command", true],
      ["invoke_subagent", false],
    ],
  );
  assert.equal(facts.conversationId, "c3b66b04-872b-4fbe-a3a4-058a026ef20a");
});

test("agentLimits read agy's stream live: its tool steps count, once each", async () => {
  const stdout = await fakeStdout("CASE:tools");
  let stops = 0;
  const watch = (limits: AgentLimits): LimitWatch => {
    const w = new LimitWatch();
    w.startRun(limits, true, () => stops++);
    w.stdout(stdout);
    return w;
  };
  // Five tool steps, each ACTIVE then DONE: five calls.
  assert.equal(watch({ toolCalls: 5 }).hit, null);
  assert.equal(watch({ toolCalls: 4 }).hit?.evidence, "5 tool calls > 4");
  assert.equal(stops, 1);
  // Each step's usage as it ends (582 + 7), then the result's total (589).
  assert.equal(watch({ outputTokens: 589 }).hit, null);
  assert.equal(watch({ outputTokens: 588 }).hit?.limit, "outputTokens");
});

test("end to end through the worker: an agy agent reports its tokens, and its transcript shows its tool steps", async () => {
  const root = tempDir();
  const example = JSON.parse(readFileSync(join(process.cwd(), "odw.config.example.json"), "utf8"));
  const entry = example.adapters.agy;
  const configPath = join(root, "odw.config.json");
  writeFileSync(configPath, JSON.stringify({ defaultAdapter: "agy", recordVersions: false, adapters: { agy: { ...entry, command: [execPath, FAKE_AGY, ...entry.command.slice(1)] } } }));
  const script = join(root, "tools.js");
  writeFileSync(script, "export const meta = { name: 'tools', description: 'd' }\nreturn await agent('CASE:tools', { label: 'fixer' })\n");
  const store = new RunStore(join(root, "runs"));
  const id = store.create({ script, args: null, source: root, configPath });
  assert.equal(await executeRun(store.runDir(id)), "done", JSON.stringify(store.readError(id)));
  assert.equal(store.readResult(id), "all done");
  const finished = store.readEvents(id).find((e) => e.type === "agent_finished")!;
  assert.deepEqual(finished.usage, { inputTokens: 18531, outputTokens: 589, cacheReadTokens: 8113 }, "real tokens, no estimate, no cost");
  const entries = normalizeTranscript(readFileSync(store.agentTranscriptPaths(id, 1).transcript, "utf8"));
  assert.deepEqual(
    entries.filter((e) => e.kind === "tool_call").map((e) => e.tool),
    ["run_command", "view_file", "grep_search", "run_command", "invoke_subagent"],
  );
});

// --- doctor --------------------------------------------------------------------------------------

test("doctor: agy's posture and tiers, and --smoke answers headless through its stream-json — or says why not", async () => {
  const dir = tempDir();
  const path = join(dir, "odw.config.json");
  const example = JSON.parse(readFileSync(join(process.cwd(), "odw.config.example.json"), "utf8"));
  const entry = example.adapters.agy;
  const as = (prompt: string) => ({ ...entry, command: [execPath, FAKE_AGY, ...entry.command.slice(1)], stdin: `${prompt} {prompt}` });
  writeFileSync(path, JSON.stringify({ runsRoot: join(dir, "runs"), defaultAdapter: "agy", adapters: { agy: as("CASE:ok"), spent: as("CASE:quota") } }));
  const config = loadConfig(path, { quiet: true });
  const report = await runDoctor({ config, configPath: path, cwd: dir, smoke: ["agy", "spent"] });
  const byId = (id: string) => report.checks.find((c) => c.id === id)!;
  assert.equal(byId("adapter:agy").status, "ok");
  assert.match(byId("adapter:agy").detail, /mode: accept-edits · tiers: edit, full · untrusted: /);
  assert.equal(byId("smoke:agy").status, "ok", byId("smoke:agy").detail);
  assert.match(byId("smoke:agy").detail, /answered headless/);
  const spent = byId("smoke:spent");
  assert.equal(spent.status, "fail");
  assert.match(spent.detail, /^adapter 'spent' ran out of usage quota — wait for the window to reset \(in 2h 39m\)/, "agy's own reset time");
});

// --- the conformance suite, on agy -----------------------------------------------------------------

test("the dialect conformance suite passes with every agent on the built-in agy adapter (its executable the fake)", async () => {
  const suiteDir = fileURLToPath(new URL("../conformance/", import.meta.url));
  const cases = loadSuite(suiteDir);
  assert.equal(cases.length, readdirSync(join(suiteDir, "cases")).length);
  const failing: string[] = [];
  for (const c of cases) {
    const scratch = tempDir();
    const table = join(scratch, "mock.json");
    writeFileSync(table, JSON.stringify(c.mock));
    const configPath = join(scratch, "odw.config.json");
    const builtin = BUILTIN_ADAPTERS.agy!;
    writeFileSync(
      configPath,
      JSON.stringify({
        defaultAdapter: "agy",
        recordVersions: false,
        adapters: { agy: { ...builtin, command: [execPath, FAKE_AGY, ...builtin.command.slice(1)], env: { FAKE_AGY_TABLE: table } } },
      }),
    );
    const store = new RunStore(join(scratch, "runs"));
    const runId = store.create({ script: c.script, args: c.hasArgs ? c.args : null, source: c.dir, configPath, budgetTotal: c.budget, origin: "conformance" });
    const state = await executeRun(store.runDir(runId));
    const outcome = outcomeOf(state, store.readEvents(runId), state === "done" ? store.readResult(runId) : null, store.readError(runId));
    const misses = judgeCase(c, outcome);
    if (misses.length > 0) failing.push(`${c.name}: ${misses.join("; ")}`);
  }
  assert.deepEqual(failing, []);
});
