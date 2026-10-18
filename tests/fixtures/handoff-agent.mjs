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
 *   handoff-agent.mjs flaky    as finish, but its first run writes flaky.txt
 *                              and is rate-limited (exit 1); the next one
 *                              replies `… flaky:<yes|no>` too
 *   handoff-agent.mjs json     as finish, but its first run writes json.txt
 *                              and replies with no JSON; the next one replies
 *                              `{"partial":…,"brief":…,"json":…}`
 *   handoff-agent.mjs secret   as quit, its output a secret ($HANDOFF_TOKEN)
 *                              followed by $HANDOFF_PAD characters
 *
 * Each writes the prompt it was given to `$HANDOFF_PROMPT_DIR/<mode>.txt`
 * when that is set (flaky and json: their last run's), and counts its runs in
 * `$HANDOFF_PROMPT_DIR/<mode>.runs`. Used only by the test suite.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const mode = process.argv[2];
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const dir = process.env.HANDOFF_PROMPT_DIR;
  if (dir) writeFileSync(join(dir, `${mode}.txt`), input);
  const counter = dir ? join(dir, `${mode}.runs`) : null;
  const runs = (counter && existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0) + 1;
  if (counter) writeFileSync(counter, String(runs));
  if (mode === "quit" || mode === "secret") {
    writeFileSync("partial.txt", "half done\n");
    if (mode === "secret") {
      // A secret, then $HANDOFF_PAD characters: a brief that cuts the output's end there cuts the secret in two.
      const pad = "y".repeat(Number(process.env.HANDOFF_PAD ?? 0));
      process.stdout.write(`${"x".repeat(5000)}\ntoken=${process.env.HANDOFF_TOKEN} ${pad}\nwrote partial.txt\n`);
    } else {
      process.stdout.write("Plan: write partial.txt, then done.txt\nwrote partial.txt\n");
    }
    process.stderr.write("You've hit your usage limit. Upgrade to Pro or try again in 3h 22m.\n");
    process.exitCode = 1;
    return;
  }
  if ((mode === "flaky" || mode === "json") && runs === 1) {
    writeFileSync(`${mode}.txt`, "first run\n");
    if (mode === "flaky") {
      process.stderr.write("Error: rate limit exceeded, try again shortly\n");
      process.exitCode = 1;
    } else {
      process.stdout.write("not json at all");
    }
    return;
  }
  const partial = existsSync("partial.txt") ? "yes" : "no";
  const brief = input.includes("## Handoff: you are continuing work another agent started") ? "yes" : "no";
  writeFileSync("done.txt", "done\n");
  const own = existsSync(`${mode}.txt`) ? "yes" : "no";
  if (mode === "json") process.stdout.write(JSON.stringify({ partial, brief, json: own }));
  else process.stdout.write(`partial:${partial} brief:${brief}${mode === "flaky" ? ` flaky:${own}` : ""}`);
});
