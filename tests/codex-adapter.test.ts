import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import { collectConfigWarnings, defaultConfig, loadConfig } from "../src/adapters/config.js";
import { AdapterOutputDecoder, decodeOutput } from "../src/adapters/output.js";
import { replyFile, usesReplyFile } from "../src/adapters/reply-file.js";
import { runCommand, type CommandRunner } from "../src/adapters/runner.js";
import type { Adapter, Config, Settings } from "../src/adapters/types.js";
import { normalizeUsage } from "../src/adapters/usage.js";
import { Bridge } from "../src/bridge.js";
import { AdapterExecutionError } from "../src/errors.js";
import { RunStore } from "../src/runtime/run-store.js";
import { normalizeTranscript } from "../src/runtime/transcript-view.js";
import { executeRun } from "../src/runtime/worker.js";

// The built-in codex adapter on `codex exec --json` (codex-rs/exec/src/exec_events.rs):
// its reply from `--output-last-message` or the last agent_message, its usage
// from turn.completed, its failures from turn.failed and error events, its
// transcript's tool calls — against a fake codex (tests/fixtures/fake-codex.mjs),
// since codex is not installed where these run. And the generic pieces that
// carry it: `match`, `errorEvents` and `{reply_file}`.

const FAKE_CODEX = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));

/** Every temp dir this file made, removed once its tests are done. */
const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "odw-codex-"));
  made.push(dir);
  return dir;
}

/** The built-in codex adapter, its executable the fake: the rest — argv, output, flags, tiers — as shipped. */
function codexConfig(settings: Partial<Settings> = {}): Config {
  const config = defaultConfig();
  const builtin = config.adapters.codex!;
  config.adapters.codex = { ...builtin, command: [execPath, FAKE_CODEX, ...builtin.command.slice(1)] };
  config.settings.defaultAdapter = "codex";
  Object.assign(config.settings, settings);
  return config;
}

/** A bridge over the fake codex that runs it for real, and records its argv and backoff waits. */
function codexBridge(settings: Partial<Settings> = {}, config = codexConfig(settings)) {
  const spawned: string[][] = [];
  const slept: number[] = [];
  const runner: CommandRunner = (command, options) => {
    spawned.push(command);
    return runCommand(command, options);
  };
  const bridge = new Bridge(config, { source: tempDir(), runner, sleep: async (ms) => void slept.push(ms), random: () => 0 });
  return { bridge, spawned, slept };
}

const lines = (...events: unknown[]): string => events.map((event) => (typeof event === "string" ? event : JSON.stringify(event))).join("\n") + "\n";
const codex = () => defaultConfig().adapters.codex!;
const agentMessage = (text: string, id = "item_1") => ({ type: "item.completed", item: { id, type: "agent_message", text } });
const turnCompleted = (input: number, cached: number, output: number) => ({
  type: "turn.completed",
  usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0 },
});

// --- the declaration -----------------------------------------------------------------------

test("the built-in codex runs exec --json with its reply file, and declares how its events read", () => {
  const adapter = codex();
  assert.deepEqual(adapter.command, [
    "codex",
    "--search", // top-level: before exec
    "exec",
    "--json",
    "--output-last-message",
    "{reply_file}",
    "--skip-git-repo-check",
    "{permission_args}",
    "--cd",
    "{workspace}",
    "-",
  ]);
  assert.deepEqual(adapter.output, {
    format: "jsonl",
    eventType: "item.completed",
    match: { path: ["item", "type"], equals: "agent_message" },
    textPath: ["item", "text"],
    select: "last",
    usageEvent: "turn.completed",
    usagePath: ["usage"],
    errorEvents: { "turn.failed": ["error"], error: ["message"] },
  });
  assert.equal("costPath" in adapter.output!, false, "codex reports no dollars: none is invented");
  assert.equal(usesReplyFile(adapter), true);
  assert.equal(usesReplyFile(defaultConfig().adapters.claude!), false);
});

// --- match ---------------------------------------------------------------------------------

test("match narrows the text events to those whose value at its path is equals; the latest of those wins", () => {
  const adapter: Adapter = {
    name: "kinds",
    command: ["k"],
    output: { format: "jsonl", eventType: "done", match: { path: ["what", "kind"], equals: "answer" }, textPath: ["text"], select: "last" },
  };
  const stream = lines(
    { type: "done", what: { kind: "answer" }, text: "first" },
    { type: "done", what: { kind: "answer" }, text: "second" },
    { type: "done", what: { kind: "note" }, text: "not the reply" },
    { type: "done", text: "no kind at all" },
  );
  assert.deepEqual(decodeOutput(adapter, stream), { text: "second" });
  // Incrementally, in any chunking, the same.
  for (const size of [1, 5, 64]) {
    const decoder = new AdapterOutputDecoder(adapter);
    for (let at = 0; at < stream.length; at += size) decoder.write(stream.slice(at, at + size));
    assert.deepEqual(decoder.finish(), { text: "second" }, `chunk size ${size}`);
  }
  // equals is compared exactly: a number or a boolean too, never a look-alike string.
  const flagged: Adapter = { ...adapter, output: { ...(adapter.output as object), match: { path: ["final"], equals: true } } as Adapter["output"] };
  assert.equal(decodeOutput(flagged, lines({ type: "done", final: "true", text: "a" }, { type: "done", final: true, text: "b" })).text, "b");
  // When none matches, the log names the match.
  const none = decodeOutput(adapter, lines({ type: "done", what: { kind: "note" }, text: "n" }));
  assert.match(String(none.fallback), /\(no 'done' event with what\.kind 'answer' was found\)/);
  const empty = decodeOutput(adapter, lines({ type: "done", what: { kind: "answer" } }));
  assert.match(String(empty.fallback), /its 'done' events with what\.kind 'answer' had no text at 'text'/);
});

// --- errorEvents -----------------------------------------------------------------------------

test("errorEvents: the latest failure event fails the run, unless a later usage event shows the CLI went on", () => {
  const adapter = codex();
  const start = [{ type: "thread.started", thread_id: "t" }, { type: "turn.started" }];
  // turn.failed is codex's word that the turn failed: its error's message is the failure.
  assert.deepEqual(decodeOutput(adapter, lines(...start, { type: "turn.failed", error: { message: "Quota exceeded. Check your plan and billing details." } })), {
    text: "Quota exceeded. Check your plan and billing details.",
    error: "Quota exceeded. Check your plan and billing details.",
  });
  // An error event that ends the stream fails it, whatever came before.
  const fatal = decodeOutput(adapter, lines(...start, agentMessage("working on it"), { type: "error", message: "exceeded retry limit, last status: 429 Too Many Requests" }));
  assert.equal(fatal.error, "exceeded retry limit, last status: 429 Too Many Requests");
  // An error codex retried, then a completed turn: no failure.
  const recovered = decodeOutput(
    adapter,
    lines(...start, { type: "error", message: "Reconnecting... 1/5 (stream disconnected before completion)" }, agentMessage("done"), turnCompleted(10, 0, 2)),
  );
  assert.deepEqual(recovered, { text: "done", usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 } });
  // The latest decides: an error after a completed turn stands; a failure event with no message is quoted.
  assert.equal(decodeOutput(adapter, lines(turnCompleted(1, 0, 1), { type: "error", message: "late" })).error, "late");
  assert.match(String(decodeOutput(adapter, lines({ type: "turn.failed" })).error), /^\{"type":"turn\.failed"\}$/);
  assert.match(String(decodeOutput(adapter, lines({ type: "turn.failed", error: { message: "" } })).error), /^\{"type":"turn\.failed","error":\{"message":""\}\}$/);
  // A warning surfaced as an `error` item is not a failure; neither is an event type that only looks like one.
  assert.deepEqual(
    decodeOutput(adapter, lines({ type: "item.completed", item: { id: "i", type: "error", message: "model rerouted" } }, { type: "constructor" }, agentMessage("fine"))),
    { text: "fine" },
  );
});

// --- the reply file ----------------------------------------------------------------------------

test("a reply file with text is the reply; with none, a stream of events without a reply is an empty reply, said in a note", () => {
  const adapter = codex();
  const silent = lines({ type: "thread.started", thread_id: "t" }, { type: "turn.started" }, turnCompleted(40, 0, 3));
  // The file is the CLI's own word: it wins over the stream, which still gives the usage.
  assert.deepEqual(decodeOutput(adapter, lines(agentMessage("from the stream"), turnCompleted(5, 1, 1)), "from the file\n"), {
    text: "from the file",
    usage: { inputTokens: 5, outputTokens: 1, cacheReadTokens: 1 },
  });
  // A stream whose agent_message is missing (drift), and a file that has it: the file, and a note.
  const drifted = decodeOutput(adapter, silent, "the reply");
  assert.equal(drifted.text, "the reply");
  assert.equal(drifted.fallback, undefined);
  assert.equal(
    drifted.note,
    "adapter 'codex': stdout did not match its 'jsonl' output format (no 'item.completed' event with item.type 'agent_message' was found); its reply file holds the reply",
  );
  // Neither: the reply is empty — not a dump of events — and the note says exactly what was missing.
  const empty = decodeOutput(adapter, silent, "");
  assert.deepEqual([empty.text, empty.fallback, empty.usage], ["", undefined, { inputTokens: 40, outputTokens: 3, cacheReadTokens: 0 }]);
  assert.equal(
    empty.note,
    "adapter 'codex': stdout did not match its 'jsonl' output format (no 'item.completed' event with item.type 'agent_message' was found), and its reply file was empty; the reply is empty",
  );
  assert.match(String(decodeOutput(adapter, silent, null).note), /, and it wrote no reply file; the reply is empty$/);
  // stdout that is not events at all (a CLI that printed text) is still the reply as it stands.
  const plain = decodeOutput(adapter, "The answer is 42.\n", null);
  assert.equal(plain.text, "The answer is 42.");
  assert.match(String(plain.fallback), /\(stdout is not JSONL: line 1: .*; and it wrote no reply file\); its raw stdout is the reply$/);
  // Nor are JSON lines that are not events: the JSON reply a CLI printed as text.
  assert.equal(decodeOutput(adapter, '{"verdict":"pass"}\n', null).text, '{"verdict":"pass"}');
  // Without a reply file, as before: the raw stdout, with the fallback note.
  assert.equal(decodeOutput(adapter, silent).text, silent.trim());
  // The CLI's own failure report decides, whatever the file says.
  assert.equal(decodeOutput(adapter, lines({ type: "turn.failed", error: { message: "boom" } }), "stale").error, "boom");
  // A text adapter with a reply file: the file, else its stdout.
  const text: Adapter = { name: "t", command: ["t", "--out", "{reply_file}"] };
  assert.deepEqual(decodeOutput(text, "chatter\n", "the answer"), { text: "the answer" });
  assert.deepEqual(decodeOutput(text, "the answer\n", null), { text: "the answer" });
});

test("replyFile: a fresh path in a private directory; read once written, null when not; cleanup removes it", async () => {
  const a = await replyFile();
  const b = await replyFile();
  assert.notEqual(dirname(a.path), dirname(b.path));
  assert.match(a.path, /odw-reply-[^/\\]+[/\\]reply\.txt$/);
  assert.equal(existsSync(a.path), false, "the file is the CLI's to create");
  assert.deepEqual(await a.read(), { text: null });
  writeFileSync(a.path, "the reply\n");
  assert.deepEqual(await a.read(), { text: "the reply\n" });
  await a.cleanup();
  await b.cleanup();
  assert.equal(existsSync(dirname(a.path)), false);
  assert.equal(existsSync(dirname(b.path)), false);
  await a.cleanup(); // never throws
  // A reply past the cap: its head, and a note.
  const big = await replyFile(4);
  writeFileSync(big.path, "0123456789");
  assert.deepEqual(await big.read(), { text: "0123", note: "its reply file holds 10 bytes: the first 4 are the reply" });
  await big.cleanup();
});

// --- usage -----------------------------------------------------------------------------------

test("codex usage maps as documented: input counts its cached part, output its reasoning; no cost", () => {
  // The docs' own sample turn.completed.
  assert.deepEqual(normalizeUsage({ input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122, reasoning_output_tokens: 0 }), {
    inputTokens: 24763,
    outputTokens: 122,
    cacheReadTokens: 24448,
  });
  // cache_write_input_tokens (newer codex) is part of input_tokens too, as codex's own test parses it.
  assert.deepEqual(
    normalizeUsage({ input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 60, output_tokens: 10, reasoning_output_tokens: 5 }),
    { inputTokens: 100, outputTokens: 10, cacheReadTokens: 40, cacheWriteTokens: 60 },
  );
  // Every turn.completed adds up; the reply's own events carry none.
  const decoded = decodeOutput(codex(), lines(turnCompleted(1200, 1000, 80), agentMessage("a"), turnCompleted(2400, 2000, 50)));
  assert.deepEqual(decoded.usage, { inputTokens: 3600, outputTokens: 130, cacheReadTokens: 3000 });
  assert.equal(decoded.usage?.costUsd, undefined);
});

// --- configuration ----------------------------------------------------------------------------

function loadRaw(raw: Record<string, unknown>): Config {
  const dir = tempDir();
  const path = join(dir, "odw.config.json");
  writeFileSync(path, JSON.stringify(raw));
  return loadConfig(path, { quiet: true });
}

test("match and errorEvents load on a jsonl output, and a malformed one fails the load naming what is wrong", () => {
  const base = { format: "jsonl", eventType: "item.completed", textPath: ["item", "text"], select: "last" };
  const { adapters } = loadRaw({
    adapters: {
      mine: {
        command: ["m"],
        output: { ...base, match: { path: ["item", "type"], equals: "agent_message" }, usageEvent: "turn.completed", errorEvents: { "turn.failed": ["error"], $comment: "x" } },
      },
    },
  });
  assert.deepEqual(adapters.mine!.output, {
    ...base,
    match: { path: ["item", "type"], equals: "agent_message" },
    usageEvent: "turn.completed",
    errorEvents: { "turn.failed": ["error"] },
  });
  for (const [extra, message] of [
    [{ match: "agent_message" }, /'output\.match' must be \{ "path": \[\.\.\.\], "equals": <a string, number or boolean> \}/],
    [{ match: { path: ["item", "type"] } }, /'output\.match' must be/],
    [{ match: { path: [], equals: "x" } }, /'output\.match\.path' must be a non-empty array of strings/],
    [{ errorEvents: ["error"] }, /'output\.errorEvents' must be an object: event type → path to its message/],
    [{ errorEvents: { error: "message" } }, /'output\.errorEvents\.error' must be a non-empty array of strings/],
    [{ errorEvents: { "item.completed": ["error"] } }, /'output\.errorEvents' cannot name 'item\.completed', its text or usage event/],
    [{ usageEvent: "turn.completed", errorEvents: { "turn.completed": ["error"] } }, /cannot name 'turn\.completed'/],
  ] as const) {
    assert.throws(() => loadRaw({ adapters: { bad: { command: ["b"], output: { ...base, ...extra } } } }), message, JSON.stringify(extra));
  }
  assert.deepEqual(
    collectConfigWarnings({ adapters: { typo: { command: ["t"], output: { ...base, match: { path: ["t"], equal: "x" }, errorEvent: {} } } } }),
    [
      'adapter "typo" output: unknown field "errorEvent" is ignored — did you mean "errorEvents"?',
      'adapter "typo" output.match: unknown field "equal" is ignored — did you mean "equals"?',
    ],
  );
});

// --- the fake codex, through the bridge --------------------------------------------------------

test("a codex run over two turns: the reply is its final message, and both turns' usage adds up", async () => {
  const { bridge, spawned } = codexBridge();
  const replied: unknown[] = [];
  const out = await bridge.run({ prompt: "CASE:ok" }, { onReply: (text, usage) => replied.push([text, usage]) });
  assert.equal(out.text, "final answer");
  const usage = { inputTokens: 3600, outputTokens: 130, cacheReadTokens: 3000, cacheWriteTokens: 0 };
  assert.deepEqual(replied, [["final answer", usage]]);
  // The argv the fake accepted is the built-in's, its reply-file path a fresh temp path.
  const argv = spawned[0]!.slice(2);
  assert.deepEqual(argv.slice(0, 4), ["--search", "exec", "--json", "--output-last-message"]);
  assert.match(argv[4]!, /odw-reply-[^/\\]+[/\\]reply\.txt$/);
  assert.deepEqual(argv.slice(5), ["--skip-git-repo-check", "--sandbox", "workspace-write", "--cd", argv.at(-2)!, "-"]);
});

test("--output-schema still works: the final message is the JSON, from the reply file", async () => {
  const STRICT = {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "score"],
    properties: { verdict: { enum: ["pass", "fail"] }, score: { type: "integer" } },
  };
  const { bridge, spawned } = codexBridge();
  const out = await bridge.run({ prompt: "CASE:schema", schema: STRICT });
  assert.deepEqual([out.value, out.attempts], [{ verdict: "pass", score: 1 }, 1]);
  assert.equal(spawned[0]!.at(-2), "--output-schema", "after `-`, as before");
});

test("a turn.failed quota is a quota failure: classified from codex's own words, not retried, its message the error", async () => {
  const dir = tempDir();
  const state = join(dir, "runs");
  const { bridge, slept } = codexBridge();
  await assert.rejects(
    () => bridge.run({ prompt: `CASE:quota STATE:${state}` }),
    (err: unknown) =>
      err instanceof AdapterExecutionError &&
      err.reason === "quota" &&
      err.message ===
        "adapter 'codex' ran out of usage quota — wait for the window to reset and resume the run, " +
          "or switch adapter with --adapter <name>: Quota exceeded. Check your plan and billing details.",
  );
  assert.equal(readFileSync(state, "utf8"), "1", "it ran once: a quota fails fast");
  assert.deepEqual(slept, []);
});

test("a rate-limit error event is ridden out: retried after the backoff, and an error codex retried itself is no failure", async () => {
  const state = join(tempDir(), "runs");
  const { bridge, slept } = codexBridge();
  const waits: number[] = [];
  const out = await bridge.run({ prompt: `CASE:rate-limit STATE:${state}` }, { onRateLimit: (retry) => waits.push(retry.retry) });
  // The second run printed a "Reconnecting..." error too, then completed its turn.
  assert.equal(out.text, "answered after the limit");
  assert.deepEqual(waits, [1]);
  assert.deepEqual(slept, [15_000]);
  assert.equal(readFileSync(state, "utf8"), "2");
});

test("unknown events, unknown item types and malformed lines are passed over", async () => {
  const { bridge } = codexBridge();
  const notes: string[] = [];
  const replied: unknown[] = [];
  const out = await bridge.run({ prompt: "CASE:noisy" }, { onNote: (note) => notes.push(note), onReply: (_text, usage) => replied.push(usage) });
  assert.equal(out.text, "survived the noise");
  assert.deepEqual(replied, [{ inputTokens: 300, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 }]);
  assert.deepEqual(notes, []);
});

test("a turn with no agent message is an empty reply, failed as such, and the log says what was missing", async () => {
  const { bridge } = codexBridge();
  const notes: string[] = [];
  await assert.rejects(
    () => bridge.run({ prompt: "CASE:silent" }, { onNote: (note) => notes.push(note) }),
    (err: unknown) =>
      err instanceof AdapterExecutionError &&
      err.reason === "empty_reply" &&
      /^adapter 'codex' replied with nothing — it did not answer .*: Warning: no last agent message; wrote empty content to .*reply\.txt$/.test(err.message),
  );
  assert.deepEqual(notes, [
    "adapter 'codex': stdout did not match its 'jsonl' output format (no 'item.completed' event with item.type 'agent_message' was found), " +
      "and its reply file was empty; the reply is empty",
  ]);
  // A call that accepts an empty reply gets one — not a dump of events — and the turn's usage still counts.
  const replied: unknown[] = [];
  const out = await bridge.run({ prompt: "CASE:silent", allowEmpty: true }, { onReply: (text, usage) => replied.push([text, usage]) });
  assert.equal(out.text, "");
  assert.deepEqual(replied, [["", { inputTokens: 400, outputTokens: 9, cacheReadTokens: 0, cacheWriteTokens: 0 }]]);
});

test("events that drifted from the declared shape degrade loudly: the reply file still has the reply, and the log says so", async () => {
  const { bridge } = codexBridge();
  const notes: string[] = [];
  const out = await bridge.run({ prompt: "CASE:drift" }, { onNote: (note) => notes.push(note) });
  assert.equal(out.text, "the drifted reply");
  assert.deepEqual(notes, [
    "adapter 'codex': stdout did not match its 'jsonl' output format (no 'item.completed' event with item.type 'agent_message' was found); " +
      "its reply file holds the reply",
  ]);
});

test("every CLI run gets its own reply file, and none is left once it ran — answered, failed or retried", async () => {
  const dir = tempDir();
  const log = join(dir, "reply-files");
  const { bridge } = codexBridge();
  await bridge.run({ prompt: `CASE:ok REPLY_LOG:${log}` });
  await assert.rejects(() => bridge.run({ prompt: `CASE:quota REPLY_LOG:${log}` }), AdapterExecutionError);
  await bridge.run({ prompt: `CASE:rate-limit STATE:${join(dir, "n")} REPLY_LOG:${log}` });
  const paths = readFileSync(log, "utf8").trim().split("\n");
  assert.equal(paths.length, 4);
  assert.equal(new Set(paths).size, 4, "a fresh path for every run");
  for (const path of paths) {
    assert.equal(existsSync(path), false, path);
    assert.equal(existsSync(dirname(path)), false, `${dirname(path)} is removed with it`);
  }
});

test("a codex quota moves the call down its fallback chain, and counts toward the quota breaker", async () => {
  const config = codexConfig({ fallback: { codex: ["mine"] }, quotaBreaker: 2 });
  config.adapters.mine = { name: "mine", command: [execPath, "-e", "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('mine answered'))"], stdin: "{prompt}" };
  const { bridge } = codexBridge({}, config);
  const warnings: string[] = [];
  for (let i = 0; i < 2; i++) {
    const out = await bridge.run({ prompt: "CASE:quota" }, { onAdapterWarning: (w) => warnings.push(w.message) });
    assert.deepEqual([out.text, out.adapter, out.fellBackFrom], ["mine answered", "mine", ["codex"]]);
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /^warning: 2 agents in a row failed on adapter 'codex' \(usage quota\) — the run's later agents skip it/);
});

// --- transcripts --------------------------------------------------------------------------------

test("codex items read as the transcript's entries: text, thinking, tool calls and their results, errors", () => {
  const transcript = lines(
    { type: "thread.started", thread_id: "th_1" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "**Planning**" } },
    { type: "item.started", item: { id: "item_1", type: "command_execution", command: "bash -lc ls", aggregated_output: "", exit_code: null, status: "in_progress" } },
    { type: "item.completed", item: { id: "item_1", type: "command_execution", command: "bash -lc ls", aggregated_output: "a\nb\n", exit_code: 0, status: "completed" } },
    // A command the sandbox declined, its start never seen: the call and its result together.
    { type: "item.completed", item: { id: "item_2", type: "command_execution", command: "rm -rf /", aggregated_output: "", exit_code: null, status: "declined" } },
    { type: "item.completed", item: { id: "item_3", type: "file_change", changes: [{ path: "a.ts", kind: "update" }], status: "failed" } },
    { type: "item.started", item: { id: "item_4", type: "mcp_tool_call", server: "docs", tool: "search", arguments: { query: "x" }, status: "in_progress" } },
    { type: "item.completed", item: { id: "item_4", type: "mcp_tool_call", server: "docs", tool: "search", arguments: { query: "x" }, result: null, error: { message: "server gone" }, status: "failed" } },
    { type: "item.started", item: { id: "item_5", type: "web_search", query: "", action: { type: "other" } } },
    { type: "item.completed", item: { id: "item_5", type: "web_search", query: "", action: { type: "open_page", url: "https://example.com/a" } } },
    { type: "item.completed", item: { id: "item_6", type: "collab_tool_call", tool: "spawn_agent" } },
    { type: "item.completed", item: { id: "item_7", type: "agent_message", text: "Listed it." } },
    { type: "error", message: "Reconnecting... 1/5" },
    { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
    { type: "turn.failed", error: { message: "Quota exceeded." } },
  );
  const entries = normalizeTranscript(transcript).map(({ i: _i, ...entry }) => entry);
  assert.deepEqual(entries, [
    { kind: "raw", text: "thread th_1 started" },
    { kind: "text", text: "**Planning**", thinking: true },
    { kind: "tool_call", tool: "shell", input: { command: "bash -lc ls" }, text: "bash -lc ls" },
    { kind: "tool_result", tool: "shell", text: "exit 0, 2 lines", output: "a\nb\n", isError: false },
    { kind: "tool_call", tool: "shell", input: { command: "rm -rf /" }, text: "rm -rf /" },
    { kind: "tool_result", tool: "shell", text: "declined", output: "", isError: true },
    { kind: "tool_call", tool: "edit", input: [{ path: "a.ts", kind: "update" }], text: "update a.ts" },
    { kind: "tool_result", tool: "edit", text: "1 line", output: "the patch was not applied", isError: true },
    { kind: "tool_call", tool: "docs.search", input: { query: "x" }, text: "x" },
    { kind: "tool_result", tool: "docs.search", text: "1 line", output: "server gone", isError: true },
    { kind: "tool_call", tool: "web_search", input: { query: "", action: { type: "open_page", url: "https://example.com/a" } }, text: "https://example.com/a" },
    { kind: "raw", text: JSON.stringify({ type: "item.completed", item: { id: "item_6", type: "collab_tool_call", tool: "spawn_agent" } }) },
    { kind: "text", text: "Listed it." },
    { kind: "error", text: "Reconnecting... 1/5" },
    { kind: "result", isError: false },
    { kind: "result", isError: true, text: "Quota exceeded." },
  ]);
});

test("end to end through the worker: a codex agent reports its tokens, and its transcript shows its tool calls", async () => {
  const root = tempDir();
  // The full entry a config gives codex when it replaces the built-in's command (README, odw.config.example.json).
  const example = JSON.parse(readFileSync(join(process.cwd(), "odw.config.example.json"), "utf8"));
  const entry = example.adapters.codex;
  const configPath = join(root, "odw.config.json");
  writeFileSync(configPath, JSON.stringify({ defaultAdapter: "codex", adapters: { codex: { ...entry, command: [execPath, FAKE_CODEX, ...entry.command.slice(1)] } } }));
  const script = join(root, "tools.js");
  writeFileSync(script, "export const meta = { name: 'tools', description: 'd' }\nreturn await agent('CASE:tools', { label: 'fixer' })\n");
  const store = new RunStore(join(root, "runs"));
  const id = store.create({ script, args: null, source: root, configPath });
  assert.equal(await executeRun(store.runDir(id)), "done", JSON.stringify(store.readError(id)));
  assert.equal(store.readResult(id), "Tests pass; lint fails on a missing semicolon. Filed #12.");
  const finished = store.readEvents(id).find((e) => e.type === "agent_finished")!;
  assert.deepEqual(finished.usage, { inputTokens: 5000, outputTokens: 300, cacheReadTokens: 4000, cacheWriteTokens: 0 }, "real tokens, no estimate, no cost");

  const entries = normalizeTranscript(readFileSync(store.agentTranscriptPaths(id, 1).transcript, "utf8"));
  const calls = entries.filter((e) => e.kind === "tool_call").map((e) => [e.tool, e.text]);
  assert.deepEqual(calls, [
    ["shell", "bash -lc 'npm test'"],
    ["shell", "bash -lc 'npm run lint'"],
    ["edit", "update src/add.ts, add src/new.ts"],
    ["github.create_issue", '{"title":"Lint fails"}'],
    ["web_search", "eslint semi rule"],
  ]);
  const results = entries.filter((e) => e.kind === "tool_result").map((e) => [e.tool, e.text, e.isError]);
  assert.deepEqual(results, [
    ["shell", "exit 0, 1 line", false],
    ["shell", "exit 1, 2 lines", true],
    ["github.create_issue", "1 line", false],
  ]);
  assert.deepEqual(
    entries.filter((e) => e.kind === "raw").map((e) => e.text),
    [
      "thread 0199a213-81c0-7800-8aa1-bbab2a035a53 started",
      "to-do: [ ] run the tests · [ ] fix lint",
      "to-do: [x] run the tests · [ ] fix lint",
      "to-do: [x] run the tests · [ ] fix lint",
    ],
  );
  assert.deepEqual(entries.filter((e) => e.kind === "error").map((e) => e.text), ["model rerouted: gpt-5.1-codex -> gpt-5.1 (HighRiskCyberActivity)"]);
  // The reply, then the to-do list codex completes with the turn, then the turn's end.
  assert.deepEqual(
    entries.slice(-3).map(({ kind, text }) => [kind, text]),
    [
      ["text", "Tests pass; lint fails on a missing semicolon. Filed #12."],
      ["raw", "to-do: [x] run the tests · [ ] fix lint"],
      ["result", undefined],
    ],
  );
});
