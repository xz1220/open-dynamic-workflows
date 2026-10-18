#!/usr/bin/env node
/**
 * Workflow-memory mock agent, for the memory tests.
 *
 * Reads the prompt from stdin. For each `KEEP: <text>` line of it, posts
 * <text> as a note to keep through its `$ODW_NOTES` shim (`sh "$ODW_NOTES"
 * --keep <text>`). Replies with a JSON object holding the prompt it got and
 * `done`: "DONE" once the prompt says an earlier attempt missed its
 * expectations (an `expect` retry), else "not yet". Used only by the test suite.
 */

import { execFileSync } from "node:child_process";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const shim = process.env.ODW_NOTES ?? null;
  for (const line of input.split("\n")) {
    const keep = /^KEEP: (.*)$/.exec(line);
    if (keep && shim) execFileSync("sh", [shim, "--keep", keep[1]]);
  }
  const retried = /did not meet these expectations/.test(input);
  process.stdout.write(JSON.stringify({ prompt: input, done: retried ? "DONE" : "not yet" }));
});
