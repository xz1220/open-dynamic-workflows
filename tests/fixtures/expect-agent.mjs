#!/usr/bin/env node
/**
 * Scripted mock agent, for the `expect` tests.
 *
 * Reads the prompt from stdin and carries out, in its working directory, one
 * step of the plan — the JSON array on the line after the prompt's `PLAN:`
 * marker. Step n runs on the n-th invocation, counted in the log named by
 * argv[2] (the last step repeats). A step:
 *
 *   { "write": { "<path>": "<text>" },   create or overwrite files
 *     "remove": ["<path>"],              delete files
 *     "commit": "<message>",             then commit everything (git add -A)
 *     "reply": "<text>",                 what to print (default "done"; "" prints nothing)
 *     "denied": [ … ],                   with --claude: the result event's permission_denials
 *     "mcp": [ { name, status } ],       with --claude: the init event's mcp_servers
 *     "stream": [ { … } ],               with --claude: events printed between init and result
 *     "exit": 3 }                        exit with this code
 *
 * With `--claude` after the log path, it prints Claude Code's stream-json
 * instead of plain text: an init event, the step's `stream` events (a
 * background task starting, say), then a `result` event whose `result` is the
 * reply and whose `permission_denials` are the step's `denied`.
 *
 * Each invocation appends one JSON line to the log — its number, the adapter
 * that ran it (its EXPECT_AGENT_ADAPTER variable), its working directory, the
 * `expect` feedback its prompt carried (from the feedback's first line on),
 * whether it was a schema retry, and the answers to its earlier questions it
 * was told (`answered`) — so a test can tell what the agent was
 * told, and where. Used only by the test suite.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const log = process.argv[2];
const claude = process.argv[3] === "--claude";
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const n = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0;
  const at = input.indexOf("PLAN:");
  const plan = at === -1 ? [{}] : JSON.parse(input.slice(at + "PLAN:".length).trim().split("\n")[0]);
  const step = plan[Math.min(n, plan.length - 1)] ?? {};
  const feedback = input.indexOf("Your previous attempt at this task did not meet");
  appendFileSync(
    log,
    JSON.stringify({
      n,
      adapter: process.env.EXPECT_AGENT_ADAPTER ?? null,
      cwd: process.cwd(),
      feedback: feedback === -1 ? null : input.slice(feedback),
      schemaRetry: input.includes("did not satisfy the required schema"),
      // What it was told of the questions it asked earlier (ODW extension: questions).
      answered: input.includes("Earlier in this task you stopped to ask") ? input.slice(input.indexOf("Earlier in this task you stopped to ask")) : null,
    }) + "\n",
  );
  for (const [path, text] of Object.entries(step.write ?? {})) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  for (const path of step.remove ?? []) rmSync(path, { force: true, recursive: true });
  if (step.commit) {
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    execFileSync("git", ["add", "-A"], { env });
    execFileSync("git", ["commit", "-q", "--no-gpg-sign", "-m", step.commit], { env });
  }
  const reply = step.reply ?? "done";
  if (claude) {
    const result = { type: "result", subtype: "success", is_error: false, result: reply, permission_denials: step.denied ?? [] };
    const init = { type: "system", subtype: "init", ...(step.mcp ? { mcp_servers: step.mcp } : {}) };
    const events = [init, ...(step.stream ?? []), result];
    process.stdout.write(events.map((event) => `${JSON.stringify(event)}\n`).join(""));
  } else {
    process.stdout.write(reply);
  }
  if (step.exit) process.exitCode = step.exit;
});
