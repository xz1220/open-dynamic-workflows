#!/usr/bin/env node
/**
 * The conformance suite's deterministic mock agent.
 *
 *   node mock-agent.mjs <table.json>      (the prompt on stdin, the reply on stdout)
 *
 * The table is a case's `mock` array (see README.md): entries are tried in
 * order, and the first whose `when` occurs in the prompt answers. `reply` is
 * printed as is when it is a string, else as JSON; `fail` exits non-zero
 * instead (`{ "exit": 1, "stderr": "…" }`, or `true` for exit 1). A prompt no
 * entry matches exits 3 naming it, so a case never passes on a reply nobody
 * wrote. `delayMs` holds the answer back that long, so a case can make
 * agents finish in an order other than the one they started in.
 *
 * A runtime may add to a prompt (a schema's description, corrective feedback
 * on a retry): `when` is a substring for that reason, and the same entry
 * answers every attempt of a call. Zero dependencies, no state.
 */

import { readFileSync } from "node:fs";

const table = JSON.parse(readFileSync(process.argv[2], "utf8"));

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  const entry = table.find((e) => typeof e.when === "string" && prompt.includes(e.when));
  if (!entry) {
    process.stderr.write(`mock-agent: no table entry matches the prompt: ${JSON.stringify(prompt.slice(0, 200))}\n`);
    process.exit(3);
  }
  setTimeout(() => answer(entry), Number.isInteger(entry.delayMs) && entry.delayMs > 0 ? entry.delayMs : 0);
});

function answer(entry) {
  if (entry.fail) {
    const fail = entry.fail === true ? {} : entry.fail;
    process.stderr.write(`${fail.stderr ?? "mock-agent: this entry fails"}\n`);
    process.exit(Number.isInteger(fail.exit) && fail.exit !== 0 ? fail.exit : 1);
  }
  process.stdout.write(typeof entry.reply === "string" ? entry.reply : JSON.stringify(entry.reply));
}
