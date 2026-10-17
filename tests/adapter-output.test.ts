import { test } from "node:test";
import assert from "node:assert/strict";

import { AdapterOutputDecoder, decodeAdapterOutput } from "../src/adapters/output.js";
import type { Adapter } from "../src/adapters/types.js";
import { AdapterExecutionError } from "../src/errors.js";

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
});

test("JSONL output rejects malformed transport with its line number", () => {
  assert.throws(
    () => decodeAdapterOutput(jsonlAdapter, '{"type":"step_start"}\nnot-json'),
    (error: unknown) =>
      error instanceof AdapterExecutionError && /malformed JSONL/.test(error.message) && /line 2/.test(error.message),
  );
});

test("JSONL output rejects a successful process with no final text event", () => {
  assert.throws(
    () => decodeAdapterOutput(jsonlAdapter, JSON.stringify({ type: "step_finish", part: {} })),
    (error: unknown) => error instanceof AdapterExecutionError && /no 'text' event/.test(error.message),
  );
});

test("JSONL output rejects matching events whose configured path is not text", () => {
  assert.throws(
    () => decodeAdapterOutput(jsonlAdapter, JSON.stringify({ type: "text", part: { text: 42 } })),
    (error: unknown) => error instanceof AdapterExecutionError && /part\.text/.test(error.message),
  );
});

test("JSONL decoded incrementally matches the one-shot decode for any chunking", () => {
  const stdout = [
    JSON.stringify({ type: "step_start", part: { text: "ignored" } }),
    JSON.stringify({ type: "text", part: { text: "first — ünïcode" } }),
    "",
    JSON.stringify({ type: "text", part: { text: "  final response  " } }),
    JSON.stringify({ type: "step_finish", part: {} }),
  ].join("\r\n");
  const expected = decodeAdapterOutput(jsonlAdapter, stdout);
  assert.equal(expected, "final response");
  for (const size of [1, 2, 7, 64, stdout.length]) {
    const decoder = new AdapterOutputDecoder(jsonlAdapter);
    for (let at = 0; at < stdout.length; at += size) decoder.write(stdout.slice(at, at + size));
    assert.equal(decoder.finish(), expected, `chunk size ${size}`);
  }
});

test("JSONL incremental decode reports the line number of the first malformed line", () => {
  const decoder = new AdapterOutputDecoder(jsonlAdapter);
  for (const chunk of ['{"type":"step_start"}\n', "not-", "json\n", '{"type":"text","part":{"text":"late"}}\n']) {
    decoder.write(chunk);
  }
  assert.throws(
    () => decoder.finish(),
    (error: unknown) =>
      error instanceof AdapterExecutionError && /malformed JSONL/.test(error.message) && /line 2/.test(error.message),
  );
});

test("a JSONL line that outgrows the line limit flags an overflow instead of buffering forever", () => {
  const decoder = new AdapterOutputDecoder(jsonlAdapter, 16);
  decoder.write(JSON.stringify({ type: "text", part: { text: "a long complete line is fine" } }) + "\n");
  assert.equal(decoder.overflow, null, "complete lines are parsed, never buffered");
  decoder.write("x".repeat(10));
  assert.equal(decoder.overflow, null);
  decoder.write("x".repeat(10));
  assert.match(String(decoder.overflow), /stdout line 2 exceeds 16 characters/);
  assert.throws(() => decoder.finish(), AdapterExecutionError);
});

test("the text decoder accumulates and trims the whole reply", () => {
  const decoder = new AdapterOutputDecoder(textAdapter);
  assert.equal(decoder.received, false);
  decoder.write("  hello ");
  decoder.write("world \n");
  assert.equal(decoder.received, true);
  assert.equal(decoder.finish(), "hello world");
});
