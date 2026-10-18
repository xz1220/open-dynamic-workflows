import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectConfigWarnings, defaultConfig, loadConfig } from "../src/adapters/config.js";
import {
  AdapterOutputDecoder,
  MAX_FALLBACK_CHARS,
  decodeAdapterOutput,
  decodeOutput,
} from "../src/adapters/output.js";
import type { Adapter } from "../src/adapters/types.js";
import { addUsage, normalizeUsage, readUsage } from "../src/adapters/usage.js";

const textAdapter: Adapter = { name: "text", command: ["agent"] };
const jsonlAdapter: Adapter = {
  name: "jsonl",
  command: ["agent"],
  output: {
    format: "jsonl",
    eventType: "text",
    textPath: ["part", "text"],
    select: "last",
  },
};

test("plain-text output is trimmed", () => {
  assert.equal(decodeAdapterOutput(textAdapter, "  final answer\r\n"), "final answer");
  assert.deepEqual(decodeOutput(textAdapter, "  final answer\r\n"), { text: "final answer" });
});

test("JSONL output selects the last non-empty completed text event", () => {
  const stdout = [
    JSON.stringify({ type: "step_start", part: { text: "ignored" } }),
    JSON.stringify({ type: "text", part: { text: "first response" } }),
    JSON.stringify({ type: "tool_use", part: { text: "tool output" } }),
    JSON.stringify({ type: "text", part: { text: "  final response  " } }),
    "",
  ].join("\r\n");
  assert.equal(decodeAdapterOutput(jsonlAdapter, stdout), "final response");
  assert.deepEqual(decodeOutput(jsonlAdapter, stdout), { text: "final response" }, "no usage declared, none reported");
});

test("a JSONL line that is not JSON is skipped: a CLI's stray notice does not lose the reply", () => {
  const stdout = ['{"type":"step_start"}', "Debugger attached.", '{"type":"text","part":{"text":"late"}}'].join("\n");
  assert.deepEqual(decodeOutput(jsonlAdapter, stdout), { text: "late" });
});

test("stdout that is not JSONL at all is the reply as it stands, with a note naming the first bad line", () => {
  const decoded = decodeOutput(jsonlAdapter, "The answer is 42.\nSecond line.\n");
  assert.equal(decoded.text, "The answer is 42.\nSecond line.");
  assert.match(String(decoded.fallback), /^adapter 'jsonl': stdout did not match its 'jsonl' output format \(stdout is not JSONL: line 1: /);
  assert.match(String(decoded.fallback), /; its raw stdout is the reply$/);
  assert.equal(decoded.error, undefined, "a format mismatch is not a failed agent");
});

test("JSONL with no text event, or none with text at the path, falls back to the raw stdout and says which", () => {
  const noEvent = JSON.stringify({ type: "step_finish", part: {} });
  const decoded = decodeOutput(jsonlAdapter, noEvent);
  assert.equal(decoded.text, noEvent);
  assert.match(String(decoded.fallback), /\(no 'text' event was found\)/);

  const notText = JSON.stringify({ type: "text", part: { text: 42 } });
  assert.match(String(decodeOutput(jsonlAdapter, notText).fallback), /its 'text' events had no text at 'part\.text'/);
  assert.match(String(decodeOutput(jsonlAdapter, "").fallback), /it printed nothing on stdout/);
  assert.equal(decodeOutput(jsonlAdapter, "").text, "");
});

test("a text event whose text is empty is an empty reply, not a format mismatch", () => {
  assert.deepEqual(decodeOutput(jsonlAdapter, JSON.stringify({ type: "text", part: { text: "  " } })), { text: "" });
});

test("JSONL decoded incrementally matches the one-shot decode for any chunking", () => {
  const stdout = [
    JSON.stringify({ type: "step_start", part: { text: "ignored" } }),
    JSON.stringify({ type: "text", part: { text: "first — ünïcode" } }),
    "",
    JSON.stringify({ type: "text", part: { text: "  final response  " } }),
    JSON.stringify({ type: "step_finish", part: {} }),
  ].join("\r\n");
  const expected = decodeOutput(jsonlAdapter, stdout);
  assert.deepEqual(expected, { text: "final response" });
  for (const size of [1, 2, 7, 64, stdout.length]) {
    const decoder = new AdapterOutputDecoder(jsonlAdapter);
    for (let at = 0; at < stdout.length; at += size) decoder.write(stdout.slice(at, at + size));
    assert.deepEqual(decoder.finish(), expected, `chunk size ${size}`);
  }
});

test("an incremental decode names the first line that was not JSON when nothing matched", () => {
  const decoder = new AdapterOutputDecoder(jsonlAdapter);
  for (const chunk of ["not-", "json\n", "{bad\n"]) decoder.write(chunk);
  const decoded = decoder.finish();
  assert.match(String(decoded.fallback), /stdout is not JSONL: line 1: /);
  assert.equal(decoded.text, "not-json\n{bad");
  assert.equal(decoder.finish(), decoded, "finish is idempotent");
});

test("a JSONL line that outgrows the line limit flags an overflow instead of buffering forever", () => {
  const decoder = new AdapterOutputDecoder(jsonlAdapter, 16);
  decoder.write(JSON.stringify({ type: "step", part: { text: "a long complete line is fine" } }) + "\n");
  assert.equal(decoder.overflow, null, "complete lines are parsed, never buffered");
  decoder.write("x".repeat(10));
  assert.equal(decoder.overflow, null);
  decoder.write("x".repeat(10));
  assert.match(String(decoder.overflow), /stdout line 2 exceeds 16 characters/);
  // The caller kills the process; decoding what came never throws.
  assert.match(String(decoder.finish().fallback), /stdout line 2 exceeds 16 characters/);
});

test("the fallback keeps only the end of a long stream, and says so", () => {
  const decoder = new AdapterOutputDecoder(jsonlAdapter);
  const line = JSON.stringify({ type: "progress", part: { note: "x".repeat(1000) } }) + "\n";
  const lines = Math.ceil((3 * MAX_FALLBACK_CHARS) / line.length);
  for (let i = 0; i < lines; i++) decoder.write(line);
  const decoded = decoder.finish();
  assert.ok(decoded.text.length <= MAX_FALLBACK_CHARS, `kept ${decoded.text.length} characters`);
  assert.match(String(decoded.fallback), new RegExp(`the last ${MAX_FALLBACK_CHARS} characters of its raw stdout is the reply`));
});

test("the text decoder accumulates and trims the whole reply", () => {
  const decoder = new AdapterOutputDecoder(textAdapter);
  assert.equal(decoder.received, false);
  decoder.write("  hello ");
  decoder.write("world \n");
  assert.equal(decoder.received, true);
  assert.equal(decoder.finish().text, "hello world");
});

// --- usage, cost and the CLI's own error ----------------------------------------

test("JSONL usage adds up over every usage event, which may differ from the text event", () => {
  const adapter: Adapter = {
    name: "turns",
    command: ["agent"],
    output: {
      format: "jsonl",
      eventType: "message",
      textPath: ["text"],
      select: "last",
      usageEvent: "turn.completed",
      usagePath: ["usage"],
      costPath: ["cost", "usd"],
    },
  };
  const stdout = [
    { type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 }, cost: { usd: 0.01 } },
    { type: "message", text: "partial" },
    { type: "turn.completed", usage: { input_tokens: 2000, cached_input_tokens: 1500, output_tokens: 70 }, cost: { usd: 0.02 } },
    { type: "message", text: "done" },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");
  assert.deepEqual(decodeOutput(adapter, stdout), {
    text: "done",
    // OpenAI-style input already includes its cached part.
    usage: { inputTokens: 3000, outputTokens: 120, cacheReadTokens: 2300, costUsd: 0.03 },
  });
});

test("a JSONL text event's errorPath reports the run's own failure; the latest text event decides", () => {
  const adapter: Adapter = {
    name: "flagged",
    command: ["agent"],
    output: { format: "jsonl", eventType: "result", textPath: ["result"], select: "last", errorPath: ["is_error"] },
  };
  const line = (fields: Record<string, unknown>) => JSON.stringify({ type: "result", ...fields });
  assert.deepEqual(decodeOutput(adapter, line({ is_error: true, result: "API Error: Rate limit reached" })), {
    text: "API Error: Rate limit reached",
    error: "API Error: Rate limit reached",
  });
  assert.deepEqual(decodeOutput(adapter, [line({ is_error: true, result: "busy" }), line({ is_error: false, result: "fine" })].join("\n")), {
    text: "fine",
  });
  // A flag with no text quotes the event, so the message still says something.
  assert.match(String(decodeOutput(adapter, line({ subtype: "error_max_turns", is_error: true })).error), /"subtype":"error_max_turns"/);
});

test("a decode that falls back still keeps the usage it found", () => {
  const adapter: Adapter = {
    name: "renamed",
    command: ["agent"],
    output: { format: "jsonl", eventType: "result", textPath: ["result"], select: "last", usagePath: ["usage"] },
  };
  const stdout = JSON.stringify({ type: "result", output: "renamed field", usage: { output_tokens: 12 } });
  const decoded = decodeOutput(adapter, stdout);
  assert.equal(decoded.text, stdout);
  assert.deepEqual(decoded.usage, { outputTokens: 12 });
  assert.match(String(decoded.fallback), /its 'result' events had no text at 'result'/);
});

const jsonAdapter = (output: Partial<Extract<Adapter["output"], { format: "json" }>> = {}): Adapter => ({
  name: "doc",
  command: ["agent"],
  output: { format: "json", textPath: ["response"], usagePath: ["stats", "usage"], costPath: ["stats", "cost"], errorPath: ["error"], ...output },
});

test("the json format reads text, usage and cost from one document", () => {
  const doc = { response: "  42  ", stats: { usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 100 } }, cost: 0.002 } };
  assert.deepEqual(decodeOutput(jsonAdapter(), JSON.stringify(doc, null, 2)), {
    text: "42",
    usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 100, costUsd: 0.002 },
  });
  // A notice printed before the document does not hide it.
  assert.equal(decodeOutput(jsonAdapter(), `Loaded cached credentials.\n${JSON.stringify(doc, null, 2)}`).text, "42");
  // Whole numbers index arrays; negative ones count from the end.
  const messages = [{ type: "system" }, { type: "result", result: "last one" }];
  assert.equal(decodeOutput(jsonAdapter({ textPath: ["-1", "result"] }), JSON.stringify(messages)).text, "last one");
  assert.equal(decodeOutput(jsonAdapter({ textPath: ["1", "result"] }), JSON.stringify(messages)).text, "last one");
});

test("the json format's errorPath takes a flag, a message or an error object", () => {
  const adapter = jsonAdapter();
  assert.equal(decodeOutput(adapter, JSON.stringify({ error: { type: "ApiError", message: "Quota exceeded for quota metric" } })).error, "Quota exceeded for quota metric");
  assert.equal(decodeOutput(adapter, JSON.stringify({ error: "not logged in" })).error, "not logged in");
  const flagged = jsonAdapter({ errorPath: ["is_error"] });
  assert.equal(decodeOutput(flagged, JSON.stringify({ is_error: true, response: "API Error: 529 overloaded" })).error, "API Error: 529 overloaded");
  for (const ok of [{ error: null }, { error: false }, { error: "" }, {}]) {
    assert.equal(decodeOutput(adapter, JSON.stringify({ response: "fine", ...ok })).error, undefined, JSON.stringify(ok));
  }
});

test("a json document that does not parse, or lacks its text, falls back to the raw stdout", () => {
  const broken = decodeOutput(jsonAdapter(), "plain words, not JSON");
  assert.equal(broken.text, "plain words, not JSON");
  assert.match(String(broken.fallback), /^adapter 'doc': stdout did not match its 'json' output format \(stdout is not one JSON document: /);
  const missing = decodeOutput(jsonAdapter(), JSON.stringify({ answer: "elsewhere" }));
  assert.match(String(missing.fallback), /it has no text at 'response'/);
  assert.equal(missing.text, JSON.stringify({ answer: "elsewhere" }));
});

// --- normalization -------------------------------------------------------------

test("usage is normalized across the CLIs' field names; garbage is ignored", () => {
  // Anthropic (Claude Code's result.usage): the cache is apart from input_tokens.
  assert.deepEqual(normalizeUsage({ input_tokens: 4, cache_creation_input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 7 }, 0.5), {
    inputTokens: 114,
    outputTokens: 7,
    cacheReadTokens: 100,
    cacheWriteTokens: 10,
    costUsd: 0.5,
  });
  // Claude Code's modelUsage spelling, same accounting.
  assert.deepEqual(normalizeUsage({ inputTokens: 4, cacheReadInputTokens: 6, outputTokens: 1, costUSD: 0.25 }), {
    inputTokens: 10,
    outputTokens: 1,
    cacheReadTokens: 6,
    costUsd: 0.25,
  });
  // Codex / OpenAI: cached tokens are part of the input already.
  assert.deepEqual(normalizeUsage({ input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122 }), {
    inputTokens: 24763,
    outputTokens: 122,
    cacheReadTokens: 24448,
  });
  assert.deepEqual(normalizeUsage({ input_tokens: 50, input_tokens_details: { cached_tokens: 20 }, output_tokens: 5 }), {
    inputTokens: 50,
    outputTokens: 5,
    cacheReadTokens: 20,
  });
  // ODW's own shape, as a wrapper might print it; costPath wins over a cost inside.
  assert.deepEqual(normalizeUsage({ inputTokens: 9, outputTokens: 3, cacheReadTokens: 5, cacheWriteTokens: 1, costUsd: 9 }, 0.1), {
    inputTokens: 9,
    outputTokens: 3,
    cacheReadTokens: 5,
    cacheWriteTokens: 1,
    costUsd: 0.1,
  });
  assert.deepEqual(normalizeUsage(undefined, 0.02), { costUsd: 0.02 });
  for (const junk of [undefined, null, "12", 12, [], { input_tokens: "12", output_tokens: -1, total_cost_usd: Number.NaN }]) {
    assert.equal(normalizeUsage(junk, "0.1"), undefined, JSON.stringify(junk));
  }
});

test("usage adds up field by field, keeping what nobody reported absent", () => {
  assert.deepEqual(addUsage({ inputTokens: 10, costUsd: 0.1 }, { outputTokens: 5, costUsd: 0.2 }), {
    inputTokens: 10,
    outputTokens: 5,
    costUsd: 0.3, // not 0.30000000000000004
  });
  assert.deepEqual(addUsage({ outputTokens: 1 }, { outputTokens: 2, estimated: true }), { outputTokens: 3, estimated: true });
  assert.deepEqual(addUsage(undefined, { outputTokens: 2 }), { outputTokens: 2 });
  assert.equal(addUsage(undefined, undefined), undefined);
  // What an event carries is read back strictly.
  assert.deepEqual(readUsage({ outputTokens: 5, costUsd: 0.1, estimated: true, extra: 1 }), { outputTokens: 5, costUsd: 0.1, estimated: true });
  assert.deepEqual(readUsage({ outputTokens: 5, estimated: "yes" }), { outputTokens: 5 });
  assert.equal(readUsage({ estimated: true }), undefined);
  assert.equal(readUsage("5 tokens"), undefined);
});

// --- configuration -------------------------------------------------------------

/** Load a config file holding `raw`. */
function loadRaw(raw: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "odw-output-cfg-"));
  try {
    const path = join(dir, "odw.config.json");
    writeFileSync(path, JSON.stringify(raw));
    return loadConfig(path, { quiet: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("adapters declare usage, cost and error paths on jsonl, and the one-document json format", () => {
  const { adapters } = loadRaw({
    adapters: {
      streamed: {
        command: ["s"],
        output: {
          format: "jsonl",
          eventType: "message",
          textPath: ["text"],
          select: "last",
          usageEvent: "turn.completed",
          usagePath: ["usage"],
          costPath: ["cost", "usd"],
          errorPath: ["error"],
        },
      },
      document: { command: ["d"], output: { format: "json", textPath: ["response"], usagePath: ["stats"], errorPath: ["error"] } },
    },
  });
  assert.deepEqual(adapters.streamed!.output, {
    format: "jsonl",
    eventType: "message",
    textPath: ["text"],
    select: "last",
    usageEvent: "turn.completed",
    usagePath: ["usage"],
    costPath: ["cost", "usd"],
    errorPath: ["error"],
  });
  assert.deepEqual(adapters.document!.output, { format: "json", textPath: ["response"], usagePath: ["stats"], errorPath: ["error"] });

  for (const [output, message] of [
    [{ format: "xml" }, /'output\.format' must be 'text', 'jsonl' or 'json'/],
    [{ format: "json" }, /'output\.textPath' must be a non-empty array of strings/],
    [{ format: "json", textPath: ["r"], usagePath: "usage" }, /'output\.usagePath' must be a non-empty array of strings/],
    [{ format: "json", textPath: ["r"], costPath: [] }, /'output\.costPath' must be a non-empty array of strings/],
    [{ format: "jsonl", eventType: "e", textPath: ["t"], select: "last", usageEvent: " " }, /'output\.usageEvent' must be a non-empty string/],
    [{ format: "jsonl", eventType: "e", textPath: ["t"], select: "last", errorPath: [""] }, /'output\.errorPath' must be a non-empty array/],
  ] as const) {
    assert.throws(() => loadRaw({ adapters: { bad: { command: ["b"], output } } }), message, JSON.stringify(output));
  }
});

test("a misspelled or misplaced output field is warned about, not silently ignored", () => {
  const warnings = collectConfigWarnings({
    adapters: {
      typo: { command: ["t"], output: { format: "jsonl", eventType: "e", textPath: ["t"], select: "last", usagepath: ["usage"] } },
      misplaced: { command: ["m"], output: { format: "json", textPath: ["t"], eventType: "result" } },
    },
  });
  assert.deepEqual(warnings, [
    'adapter "typo" output: unknown field "usagepath" is ignored — did you mean "usagePath"?',
    'adapter "misplaced" output: unknown field "eventType" is ignored',
  ]);
});

// --- Claude Code's stream-json (the built-in claude adapter) ----------------------

/** Claude Code `--print --output-format stream-json --verbose`, as https://code.claude.com/docs/en/headless shows it. */
const claudeStream = (result: Record<string, unknown>): string =>
  [
    { type: "system", subtype: "init", cwd: "/repo", session_id: "8f1c…", tools: ["Read", "Edit", "WebSearch"], model: "claude-sonnet-4-5", permissionMode: "acceptEdits" },
    {
      type: "assistant",
      message: {
        id: "msg_01",
        type: "message",
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_01", name: "Read", input: { file_path: "README.md" } }],
        usage: { input_tokens: 3, cache_creation_input_tokens: 5133, cache_read_input_tokens: 12737, output_tokens: 2 },
      },
      parent_tool_use_id: null,
      session_id: "8f1c…",
    },
    {
      type: "user",
      message: { role: "user", content: [{ tool_use_id: "toolu_01", type: "tool_result", content: "# odw\nAPI Error: Rate limit reached (a line in the README)" }] },
      parent_tool_use_id: null,
      session_id: "8f1c…",
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 2771,
      duration_api_ms: 2721,
      num_turns: 2,
      session_id: "8f1c…",
      total_cost_usd: 0.0387,
      usage: {
        input_tokens: 4,
        cache_creation_input_tokens: 5133,
        cache_read_input_tokens: 12737,
        output_tokens: 7,
        server_tool_use: { web_search_requests: 0 },
        service_tier: "standard",
      },
      permission_denials: [],
      ...result,
    },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n") + "\n";

test("the built-in claude adapter streams stream-json and decodes its result event", () => {
  const claude = defaultConfig().adapters.claude!;
  assert.deepEqual(claude.command.slice(0, 5), ["claude", "--print", "--output-format", "stream-json", "--verbose"]);
  assert.deepEqual(claude.output, {
    format: "jsonl",
    eventType: "result",
    textPath: ["result"],
    select: "last",
    usagePath: ["usage"],
    costPath: ["total_cost_usd"],
    errorPath: ["is_error"],
    structuredPath: ["structured_output"],
    deniedPath: ["permission_denials"],
    mcpEvent: "system",
    mcpPath: ["mcp_servers"],
  });
  assert.deepEqual(decodeOutput(claude, claudeStream({ result: "The README says hello." })), {
    text: "The README says hello.",
    usage: {
      // Anthropic's input_tokens leaves the cache out: normalized input is all of it.
      inputTokens: 4 + 5133 + 12737,
      outputTokens: 7,
      cacheReadTokens: 12737,
      cacheWriteTokens: 5133,
      costUsd: 0.0387,
    },
  });
});

test("claude's is_error result is the run's own failure report, with its result text as the message", () => {
  const claude = defaultConfig().adapters.claude!;
  const decoded = decodeOutput(claude, claudeStream({ is_error: true, result: "API Error: Rate limit reached", total_cost_usd: 0 }));
  assert.equal(decoded.error, "API Error: Rate limit reached");
  assert.equal(decoded.usage?.costUsd, 0);

  // An error subtype with no result text quotes the event instead.
  const turns = decodeOutput(claude, claudeStream({ subtype: "error_max_turns", is_error: true, result: undefined }));
  assert.match(String(turns.error), /^\{"type":"result","subtype":"error_max_turns","is_error":true/);
});

// --- natively validated values (`structuredPath`, ODW extension) -------------------

test("claude's result event hands over its --json-schema value as structured_output, beside its text", () => {
  const claude = defaultConfig().adapters.claude!;
  const value = { verdict: "pass", issues: [] };
  const decoded = decodeOutput(claude, claudeStream({ result: "Reviewed: it looks right.", structured_output: value }));
  assert.equal(decoded.text, "Reviewed: it looks right.");
  assert.deepEqual(decoded.structured, value);
  assert.equal(decoded.usage?.costUsd, 0.0387, "usage and cost still come along");

  // Claude Code sets the result text to the value's JSON when the final turn has no text.
  const bare = decodeOutput(claude, claudeStream({ result: JSON.stringify(value), structured_output: value }));
  assert.deepEqual([bare.text, bare.structured], [JSON.stringify(value), value]);

  // A run that produced none reports it absent or null: the result text is all there is.
  for (const none of [{}, { structured_output: null }]) {
    const plain = decodeOutput(claude, claudeStream({ result: '{"verdict": "fail"}', ...none }));
    assert.equal("structured" in plain, false, JSON.stringify(none));
    assert.equal(plain.text, '{"verdict": "fail"}');
  }

  // Falsy values are values: only absent and null mean none.
  for (const falsy of [false, 0, "", []]) {
    assert.deepEqual(decodeOutput(claude, claudeStream({ result: "", structured_output: falsy })).structured, falsy);
  }

  // A failed run's error wins; error_max_structured_output_retries has no result text.
  const exhausted = decodeOutput(
    claude,
    claudeStream({ subtype: "error_max_structured_output_retries", is_error: true, result: undefined, errors: ["no valid output"] }),
  );
  assert.match(String(exhausted.error), /"subtype":"error_max_structured_output_retries"/);
  assert.equal("structured" in exhausted, false);
});

test("the latest text event decides the structured value, incrementally as in one go", () => {
  const adapter: Adapter = {
    name: "s",
    command: ["s"],
    output: { format: "jsonl", eventType: "done", textPath: ["text"], select: "last", structuredPath: ["data", "value"] },
  };
  const stream =
    [
      { type: "done", text: "draft", data: { value: { n: 1 } } },
      { type: "done", text: "final", data: { value: { n: 2 } } },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n") + "\n";
  assert.deepEqual(decodeOutput(adapter, stream), { text: "final", structured: { n: 2 } });
  const decoder = new AdapterOutputDecoder(adapter);
  for (let i = 0; i < stream.length; i += 7) decoder.write(stream.slice(i, i + 7));
  assert.deepEqual(decoder.finish(), { text: "final", structured: { n: 2 } });

  // A later event without one clears it; an event with a value but no text is no fallback.
  const cleared = stream + JSON.stringify({ type: "done", text: "again" }) + "\n";
  assert.deepEqual(decodeOutput(adapter, cleared), { text: "again" });
  const valueOnly = JSON.stringify({ type: "done", data: { value: [1, 2] } }) + "\n";
  assert.deepEqual(decodeOutput(adapter, valueOnly), { text: "", structured: [1, 2] });
});

test("the json format reads a structured value from its document, and config validates the path", () => {
  const adapter: Adapter = {
    name: "doc",
    command: ["d"],
    output: { format: "json", textPath: ["result"], structuredPath: ["structured_output"], errorPath: ["is_error"] },
  };
  assert.deepEqual(decodeOutput(adapter, JSON.stringify({ result: "ok", structured_output: { a: 1 } })), {
    text: "ok",
    structured: { a: 1 },
  });
  assert.deepEqual(decodeOutput(adapter, JSON.stringify({ structured_output: { a: 1 } })), { text: "", structured: { a: 1 } });
  assert.deepEqual(decodeOutput(adapter, JSON.stringify({ result: "ok", structured_output: null })), { text: "ok" });
  assert.equal(decodeOutput(adapter, JSON.stringify({ result: "boom", is_error: true, structured_output: { a: 1 } })).error, "boom");

  const { adapters } = loadRaw({
    adapters: {
      doc: { command: ["d"], output: { format: "json", textPath: ["r"], structuredPath: ["s"] } },
      lines: { command: ["l"], output: { format: "jsonl", eventType: "e", textPath: ["t"], select: "last", structuredPath: ["s", "0"] } },
    },
  });
  assert.deepEqual(adapters.doc!.output, { format: "json", textPath: ["r"], structuredPath: ["s"] });
  assert.deepEqual(adapters.lines!.output, { format: "jsonl", eventType: "e", textPath: ["t"], select: "last", structuredPath: ["s", "0"] });
  assert.throws(
    () => loadRaw({ adapters: { bad: { command: ["b"], output: { format: "json", textPath: ["r"], structuredPath: "s" } } } }),
    /'output\.structuredPath' must be a non-empty array of strings/,
  );
  assert.deepEqual(
    collectConfigWarnings({ adapters: { typo: { command: ["t"], output: { format: "json", textPath: ["r"], structurePath: ["s"] } } } }),
    ['adapter "typo" output: unknown field "structurePath" is ignored — did you mean "structuredPath"?'],
  );
});
