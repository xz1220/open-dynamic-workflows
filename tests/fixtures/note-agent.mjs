#!/usr/bin/env node
/**
 * Notes-board mock agent, for the notes tests.
 *
 * Reads the prompt from stdin. For each `NOTE: <text>` line of it, posts
 * <text> through its `$ODW_NOTES` shim (`sh "$ODW_NOTES" <text>`); with a
 * `WRITE: <path> <text>` line, writes <text> to <path> in its working
 * directory (an isolated agent's change). Then replies with a JSON object:
 * the prompt it got, its ODW_NOTES, and what `"$ODW_NOTES"` alone printed.
 * Used only by the test suite.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const shim = process.env.ODW_NOTES ?? null;
  for (const line of input.split("\n")) {
    const write = /^WRITE: (\S+) (.*)$/.exec(line);
    if (write) {
      mkdirSync(dirname(write[1]), { recursive: true });
      writeFileSync(write[1], write[2].replace(/\\n/g, "\n"));
    }
    const note = /^NOTE: (.*)$/.exec(line);
    if (note && shim) execFileSync("sh", [shim, note[1]]);
  }
  const board = shim ? execFileSync("sh", [shim], { encoding: "utf8" }) : null;
  process.stdout.write(JSON.stringify({ prompt: input, notes: shim, board }));
});
