#!/usr/bin/env node
/**
 * A runaway mock agent, for the per-agent limits tests (an ODW extension).
 *
 *   node runaway-agent.mjs <mode> <dir>
 *
 * Appends a line to `<dir>/runs` per invocation, starts a helper process (in
 * its process group, as a CLI's shell or test runner would be) whose pid goes
 * to `<dir>/helper.pid`, then prints, every 20 ms and never stopping:
 *
 *   repeat  Claude Code stream-json: the same Bash `npm test` tool_use
 *   many    Codex `exec --json`: a command_execution item, a new command each time
 *   spend   opencode `run --format json`: a step_finish costing $0.01 each
 *
 * `text` prints a 400-character reply and exits. Only a kill ends the others.
 * Used only by the test suite.
 */

import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [mode, dir] = process.argv.slice(2);
appendFileSync(join(dir, "runs"), `${mode}\n`);
process.stdin.resume();
process.stdin.on("data", () => {});

if (mode === "text") {
  process.stdout.write("x".repeat(400));
  process.exit(0);
}

const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(join(dir, "helper.pid"), String(helper.pid));

const out = (event) => process.stdout.write(JSON.stringify(event) + "\n");
if (mode === "repeat") out({ type: "system", subtype: "init", model: "mock", tools: ["Bash"] });
let n = 0;
setInterval(() => {
  n++;
  if (mode === "repeat") {
    out({
      type: "assistant",
      message: { id: `msg_${n}`, content: [{ type: "tool_use", id: `toolu_${n}`, name: "Bash", input: { command: "npm test" } }] },
    });
  } else if (mode === "many") {
    out({ type: "item.started", item: { id: `item_${n}`, type: "command_execution", command: `cat file${n}.txt`, status: "in_progress" } });
  } else if (mode === "spend") {
    out({ type: "step_finish", part: { type: "step-finish", tokens: { input: 100, output: 10, reasoning: 0 }, cost: 0.01 } });
  }
}, 20);
