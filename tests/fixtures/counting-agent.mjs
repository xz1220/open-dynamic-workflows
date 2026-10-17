#!/usr/bin/env node
/**
 * Counting mock agent, for the persistence and resume tests.
 *
 * Reads the prompt from stdin and appends its `TASK:<name>` token to the calls
 * log named by argv[2] — one line per invocation, so a test can count how often
 * the adapter really ran. A task whose name starts with `block` holds its lane:
 * it waits until `<log>.release` exists (or a minute passes), so a test can
 * keep one agent busy while the rest of the run moves on. Replies
 * `done:<name>`, or `{"task":"<name>"}` when the bridge appended a JSON Schema.
 * Used only by the test suite.
 */

import { appendFileSync, existsSync } from "node:fs";

const log = process.argv[2];
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const task = /TASK:(\S+)/.exec(input)?.[1] ?? "?";
  appendFileSync(log, task + "\n");
  const reply = () => process.stdout.write(input.includes("JSON Schema:") ? JSON.stringify({ task }) : `done:${task}`);
  if (!task.startsWith("block")) return reply();
  const deadline = Date.now() + 60_000;
  const timer = setInterval(() => {
    if (!existsSync(`${log}.release`) && Date.now() < deadline) return;
    clearInterval(timer);
    reply();
  }, 25);
});
