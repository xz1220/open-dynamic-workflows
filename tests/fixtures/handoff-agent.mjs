#!/usr/bin/env node
/**
 * Mock agent for the handoff tests: one that runs out of quota halfway, and
 * one that finishes what it finds.
 *
 *   handoff-agent.mjs quit     writes partial.txt in its working directory,
 *                              says what it did, then fails as a spent quota
 *                              (Claude Code's message, exit 1)
 *   handoff-agent.mjs finish   writes done.txt and replies with what it found:
 *                              `partial:<yes|no> brief:<yes|no>`
 *
 * Each writes the prompt it was given to `$HANDOFF_PROMPT_DIR/<mode>.txt`
 * when that is set. Used only by the test suite.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const mode = process.argv[2];
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  if (process.env.HANDOFF_PROMPT_DIR) writeFileSync(join(process.env.HANDOFF_PROMPT_DIR, `${mode}.txt`), input);
  if (mode === "quit") {
    writeFileSync("partial.txt", "half done\n");
    process.stdout.write("Plan: write partial.txt, then done.txt\nwrote partial.txt\n");
    process.stderr.write("You've hit your usage limit. Upgrade to Pro or try again in 3h 22m.\n");
    process.exitCode = 1;
    return;
  }
  const partial = existsSync("partial.txt") ? "yes" : "no";
  const brief = input.includes("## Handoff: you are continuing work another agent started") ? "yes" : "no";
  writeFileSync("done.txt", "done\n");
  process.stdout.write(`partial:${partial} brief:${brief}`);
});
