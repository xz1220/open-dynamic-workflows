import { test } from "node:test";
import assert from "node:assert/strict";

import {
  formatTranscriptEntry,
  normalizeTranscript,
  TranscriptNormalizer,
  type TranscriptEntry,
} from "../src/runtime/transcript-view.js";

// Agent transcripts, normalized for reading (ODW extension): samples written
// from the public docs — Claude Code's stream-json
// (https://code.claude.com/docs/en/headless and the Agent SDK's message
// types), and opencode's `run --format json` events (kilo is opencode's fork).

const jsonl = (...events: unknown[]): string => events.map((e) => JSON.stringify(e)).join("\n") + "\n";

/** Claude Code `--print --output-format stream-json --verbose`: a session that fixes a test. */
const CLAUDE = jsonl(
  {
    type: "system",
    subtype: "init",
    uuid: "u0",
    session_id: "s1",
    cwd: "/repo",
    tools: ["Bash", "Edit", "Read"],
    mcp_servers: [],
    model: "claude-sonnet-4-5",
    permissionMode: "acceptEdits",
    apiKeySource: "none",
    slash_commands: [],
    output_style: "default",
  },
  {
    type: "assistant",
    uuid: "u1",
    session_id: "s1",
    parent_tool_use_id: null,
    message: {
      id: "msg_01",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5",
      content: [
        { type: "thinking", thinking: "The tests will say what is wrong.", signature: "c2ln" },
        { type: "text", text: "I'll run the tests first." },
        { type: "tool_use", id: "toolu_01", name: "Bash", input: { command: "npm test", description: "Run the tests" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 3, output_tokens: 40 },
    },
  },
  {
    type: "user",
    uuid: "u2",
    session_id: "s1",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_01", content: "Exit code 1\n> odw@0.5.0 test\nnot ok 1 - adds\n", is_error: true },
      ],
    },
  },
  {
    type: "system",
    subtype: "api_retry",
    attempt: 1,
    max_retries: 10,
    retry_delay_ms: 2000,
    error_status: 429,
    error: "rate_limit",
    uuid: "u3",
    session_id: "s1",
  },
  {
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Fix" } },
    parent_tool_use_id: null,
    uuid: "u4",
    session_id: "s1",
  },
  {
    type: "assistant",
    uuid: "u5",
    session_id: "s1",
    parent_tool_use_id: null,
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_02", name: "Edit", input: { file_path: "src/add.ts", old_string: "a - b", new_string: "a + b" } }],
    },
  },
  {
    type: "user",
    uuid: "u6",
    session_id: "s1",
    parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_02", content: [{ type: "text", text: "The file src/add.ts has been updated." }] }] },
  },
  {
    type: "assistant",
    uuid: "u7",
    session_id: "s1",
    parent_tool_use_id: null,
    message: { role: "assistant", content: [{ type: "text", text: "Fixed: add() subtracted." }] },
  },
  {
    type: "result",
    subtype: "success",
    uuid: "u8",
    session_id: "s1",
    duration_ms: 2771,
    duration_api_ms: 2721,
    is_error: false,
    num_turns: 3,
    result: "Fixed: add() subtracted.",
    stop_reason: "end_turn",
    total_cost_usd: 0.0123,
    usage: { input_tokens: 4, output_tokens: 7 },
    modelUsage: {},
    permission_denials: [],
  },
);

test("claude stream-json: init, thinking, text, tool calls and their results, retries, the result", () => {
  assert.deepEqual(normalizeTranscript(CLAUDE), [
    { i: 0, kind: "raw", text: "model claude-sonnet-4-5 · 3 tools: Bash, Edit, Read" },
    { i: 1, kind: "text", text: "The tests will say what is wrong.", thinking: true },
    { i: 2, kind: "text", text: "I'll run the tests first." },
    { i: 3, kind: "tool_call", tool: "Bash", input: { command: "npm test", description: "Run the tests" }, text: "npm test" },
    {
      i: 4,
      kind: "tool_result",
      text: "exit 1, 3 lines",
      output: "Exit code 1\n> odw@0.5.0 test\nnot ok 1 - adds\n",
      isError: true,
      tool: "Bash",
    },
    { i: 5, kind: "error", text: "API request failed (rate_limit, HTTP 429) — retrying in 2.0s (attempt 1 of 10)" },
    // the stream_event (a partial message) makes no entry: the whole message follows
    {
      i: 6,
      kind: "tool_call",
      tool: "Edit",
      input: { file_path: "src/add.ts", old_string: "a - b", new_string: "a + b" },
      text: "src/add.ts",
    },
    { i: 7, kind: "tool_result", text: "1 line", output: "The file src/add.ts has been updated.", isError: false, tool: "Edit" },
    { i: 8, kind: "text", text: "Fixed: add() subtracted." },
    { i: 9, kind: "result", isError: false, text: "Fixed: add() subtracted.", turns: 3, costUsd: 0.0123 },
  ]);
});

test("claude stream-json: failures — an error result, an API error message, a refused permission, the unknown", () => {
  const entries = normalizeTranscript(
    jsonl(
      // An assistant message reporting an API error carries the error's text.
      {
        type: "assistant",
        uuid: "a",
        session_id: "s",
        parent_tool_use_id: null,
        error: "rate_limit",
        message: { role: "assistant", content: [{ type: "text", text: "API Error: Rate limit reached" }] },
      },
      { type: "assistant", uuid: "b", session_id: "s", parent_tool_use_id: null, error: "authentication_failed", message: { content: [] } },
      {
        type: "system",
        subtype: "permission_denied",
        tool_name: "WebFetch",
        tool_use_id: "toolu_9",
        message: "Permission to use WebFetch has been denied.",
        uuid: "c",
        session_id: "s",
      },
      { type: "system", subtype: "compact_boundary", uuid: "d", session_id: "s", compact_metadata: { trigger: "auto", pre_tokens: 150000 } },
      { type: "rate_limit_event", uuid: "e", session_id: "s" },
      { type: "user", uuid: "f", session_id: "s", parent_tool_use_id: "toolu_7", message: { role: "user", content: "Review the diff." } },
      // A result for a tool call this transcript never showed: no tool name to give it.
      { type: "user", uuid: "g", session_id: "s", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "toolu_x", content: "" }] } },
      {
        type: "result",
        subtype: "error_max_turns",
        uuid: "h",
        session_id: "s",
        duration_ms: 10,
        duration_api_ms: 9,
        is_error: true,
        num_turns: 30,
        stop_reason: null,
        total_cost_usd: 1.5,
        usage: {},
        modelUsage: {},
        permission_denials: [{ tool_name: "WebFetch", tool_use_id: "toolu_9", tool_input: {} }],
        errors: ["Reached maximum number of turns (30)"],
      },
      { type: "result", subtype: "error_during_execution", is_error: true, errors: [] },
    ) + "Debugger attached.\n\n",
  );
  assert.deepEqual(entries, [
    { i: 0, kind: "error", text: "API Error: Rate limit reached" },
    { i: 1, kind: "error", text: "API error: authentication_failed" },
    { i: 2, kind: "error", text: "Permission to use WebFetch has been denied.", tool: "WebFetch" },
    { i: 3, kind: "raw", text: "context compacted (auto; 150000 tokens before)" },
    { i: 4, kind: "raw", text: '{"type":"rate_limit_event","uuid":"e","session_id":"s"}' },
    { i: 5, kind: "raw", text: "Review the diff." },
    { i: 6, kind: "tool_result", text: "no output", output: "", isError: false },
    { i: 7, kind: "result", isError: true, text: "Reached maximum number of turns (30)", turns: 30, costUsd: 1.5 },
    { i: 8, kind: "result", isError: true, text: "error_during_execution" },
    // A line that is not JSON — a CLI's stray notice — is shown as it is.
    { i: 9, kind: "raw", text: "Debugger attached." },
  ]);
});

/** opencode `run --format json` (kilo prints the same): each event carries type, timestamp, sessionID. */
const OPENCODE = jsonl(
  { type: "step_start", timestamp: 1, sessionID: "ses_1", part: { id: "prt_1", sessionID: "ses_1", messageID: "msg_1", type: "step-start" } },
  { type: "reasoning", timestamp: 2, sessionID: "ses_1", part: { id: "prt_2", type: "reasoning", text: "Check the failing test." } },
  {
    type: "tool_use",
    timestamp: 3,
    sessionID: "ses_1",
    part: {
      id: "prt_3",
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "tool",
      callID: "call_1",
      tool: "bash",
      state: {
        status: "completed",
        input: { command: "npm test", description: "Runs the tests" },
        output: "ok 1 - adds\nok 2 - subtracts\n",
        title: "npm test",
        metadata: { exit: 0, description: "Runs the tests" },
        time: { start: 3, end: 4 },
      },
    },
  },
  {
    type: "tool_use",
    timestamp: 5,
    sessionID: "ses_1",
    part: {
      id: "prt_4",
      type: "tool",
      callID: "call_2",
      tool: "read",
      state: { status: "error", input: { filePath: "/repo/missing.ts" }, error: "File not found: /repo/missing.ts", time: { start: 5, end: 5 } },
    },
  },
  { type: "text", timestamp: 6, sessionID: "ses_1", part: { id: "prt_5", type: "text", text: "All tests pass.", time: { start: 6, end: 6 } } },
  {
    type: "step_finish",
    timestamp: 7,
    sessionID: "ses_1",
    part: { id: "prt_6", type: "step-finish", reason: "stop", cost: 0.001, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } },
  },
  { type: "error", timestamp: 8, sessionID: "ses_1", error: { name: "ProviderAuthError", data: { message: "Invalid API key" } } },
  { type: "error", timestamp: 9, sessionID: "ses_1", error: { type: "unknown", message: "Session interrupted: aborted" } },
);

test("kilo / opencode events: reasoning, tools (call and result in one event), text and errors", () => {
  assert.deepEqual(normalizeTranscript(OPENCODE), [
    { i: 0, kind: "text", text: "Check the failing test.", thinking: true },
    { i: 1, kind: "tool_call", tool: "bash", input: { command: "npm test", description: "Runs the tests" }, text: "npm test" },
    { i: 2, kind: "tool_result", text: "exit 0, 2 lines", output: "ok 1 - adds\nok 2 - subtracts\n", isError: false, tool: "bash" },
    { i: 3, kind: "tool_call", tool: "read", input: { filePath: "/repo/missing.ts" }, text: "/repo/missing.ts" },
    { i: 4, kind: "tool_result", text: "1 line", output: "File not found: /repo/missing.ts", isError: true, tool: "read" },
    { i: 5, kind: "text", text: "All tests pass." },
    { i: 6, kind: "error", text: "Invalid API key" },
    { i: 7, kind: "error", text: "Session interrupted: aborted" },
  ]);
});

test("ODW's own lines: a text adapter's output, further CLI runs, the cut", () => {
  const text = jsonl(
    { kind: "text", text: "Plan:\n" },
    { kind: "text", text: "  1. read\n" },
    { kind: "text", text: "" },
    { kind: "attempt", n: 2, reason: "schema" },
    { kind: "text", text: '{"ok":true}' },
    { kind: "attempt", n: 3, reason: "stall" },
    { kind: "attempt", n: 4, reason: "rate_limit" },
    { kind: "truncated", bytes: 5 * 1024 * 1024 },
    { kind: "mystery" },
  );
  assert.deepEqual(normalizeTranscript(text), [
    { i: 0, kind: "text", text: "Plan:\n" },
    { i: 1, kind: "text", text: "  1. read\n" },
    { i: 2, kind: "attempt", text: "attempt 2: schema retry", n: 2, reason: "schema" },
    { i: 3, kind: "text", text: '{"ok":true}' },
    { i: 4, kind: "attempt", text: "attempt 3: stall restart", n: 3, reason: "stall" },
    { i: 5, kind: "attempt", text: "attempt 4: rate-limit retry", n: 4, reason: "rate_limit" },
    {
      i: 6,
      kind: "truncated",
      text: "transcript cut at 5.0 MB (maxTranscriptBytes): the rest of the agent's output was not kept",
      bytes: 5 * 1024 * 1024,
    },
    { i: 7, kind: "raw", text: '{"kind":"mystery"}' },
  ]);
});

test("long fields are clipped to 4 KB, never inside a character, and marked", () => {
  const long = "x".repeat(5000);
  const cjk = "字".repeat(2000); // 3 bytes each: 1365 fit in 4096
  const emoji = "a" + "😀".repeat(1500); // 4 bytes each, two code units: a pair is never split
  const entries = normalizeTranscript(
    jsonl(
      { type: "assistant", message: { content: [{ type: "text", text: long }] } },
      { kind: "text", text: cjk },
      { kind: "text", text: emoji },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "big.txt", content: long } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: `${long}\nmore` }] } },
    ),
  );
  assert.equal(entries[0]!.text, "x".repeat(4096));
  assert.equal(entries[0]!.clipped, true);
  assert.equal(entries[1]!.text, "字".repeat(1365));
  assert.equal(entries[1]!.clipped, true);
  assert.equal(entries[2]!.text, "a" + "😀".repeat(1023), "4 + 1023 * 4 = 4093 bytes; the next pair does not fit");
  // An input too long to keep becomes its JSON text, cut; the summary still names the file.
  const call = entries[3]!;
  assert.equal(call.text, "big.txt");
  assert.equal(typeof call.input, "string");
  assert.equal(call.input, JSON.stringify({ file_path: "big.txt", content: long }).slice(0, 4096));
  assert.equal(call.clipped, true);
  // A result's size is counted on the whole output, before the cut.
  const result = entries[4]!;
  assert.deepEqual([result.tool, result.text, result.output!.length, result.clipped], ["Write", "2 lines", 4096, true]);
  // Short fields are left alone, and unmarked.
  assert.equal(normalizeTranscript(jsonl({ kind: "text", text: "short" }))[0]!.clipped, undefined);
});

test("line by line, the normalizer numbers entries exactly as the whole transcript does", () => {
  const all = normalizeTranscript(CLAUDE + OPENCODE);
  const normalizer = new TranscriptNormalizer();
  const byLine = (CLAUDE + OPENCODE).split("\n").flatMap((line) => normalizer.line(line));
  assert.deepEqual(byLine, all);
  assert.deepEqual(
    all.map((e) => e.i),
    all.map((_, i) => i),
  );
  assert.equal(normalizer.truncated, false);
  normalizer.line(JSON.stringify({ kind: "truncated", bytes: 10 }));
  assert.equal(normalizer.truncated, true);
});

test("odw logs --agent reads an entry as a line: calls, results, errors, retries and the end", () => {
  const caps = { color: false, truecolor: false, unicode: true };
  const show = (entry: Omit<TranscriptEntry, "i">, width = 100): string[] => formatTranscriptEntry({ i: 0, ...entry }, { caps, width });
  assert.deepEqual(show({ kind: "tool_call", tool: "Bash", text: "npm test" }), ["▸ Bash  npm test"]);
  assert.deepEqual(show({ kind: "tool_result", tool: "Bash", text: "312 lines", output: "…", isError: false }), ["✓ Bash result (312 lines)"]);
  assert.deepEqual(
    show({ kind: "tool_result", tool: "Bash", text: "exit 1, 3 lines", output: "Exit code 1\n\nnpm ERR! missing script: lint\n", isError: true }),
    ["✗ Bash error (exit 1, 3 lines): npm ERR! missing script: lint"],
  );
  assert.deepEqual(show({ kind: "text", text: "Plan:\n  1. read\n\tdone\n" }), ["Plan:", "  1. read", "  done"]);
  assert.deepEqual(show({ kind: "text", text: "hm", thinking: true }), ["thinking: hm"]);
  assert.deepEqual(show({ kind: "text", text: "x", clipped: true }), ["x", "… (cut at 4 KB: --raw prints it whole)"]);
  assert.deepEqual(show({ kind: "attempt", text: "attempt 2: schema retry", n: 2, reason: "schema" }), ["── attempt 2: schema retry ──"]);
  assert.deepEqual(show({ kind: "result", isError: false, text: "ok", turns: 3, costUsd: 0.0123 }), ["■ done · 3 turns · $0.012"]);
  assert.deepEqual(show({ kind: "result", isError: true, text: "Reached maximum number of turns (30)", turns: 30 }), [
    "✗ failed: Reached maximum number of turns (30) · 30 turns",
  ]);
  assert.deepEqual(show({ kind: "error", tool: "WebFetch", text: "Permission to use WebFetch has been denied." }), [
    "✗ WebFetch: Permission to use WebFetch has been denied.",
  ]);
  assert.deepEqual(show({ kind: "raw", text: "model m · 1 tools: Bash" }), ["· model m · 1 tools: Bash"]);
  // An agent's own escape sequences never reach the terminal, and a line fits the width.
  assert.deepEqual(show({ kind: "tool_call", tool: "Bash", text: "echo \u001b]0;pwned\u0007hi\nthere" }), ["▸ Bash  echo hi there"]);
  assert.equal(show({ kind: "tool_call", tool: "Bash", text: "y".repeat(200) }, 30)[0], `▸ Bash  ${"y".repeat(21)}…`);
  // Without Unicode, plain marks.
  assert.deepEqual(formatTranscriptEntry({ i: 0, kind: "tool_call", tool: "Bash", text: "ls" }, { caps: { ...caps, unicode: false }, width: 80 }), [
    "> Bash  ls",
  ]);
});
