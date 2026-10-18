#!/usr/bin/env node
/**
 * A fake `codex`, for the codex adapter's tests (codex is not installed where
 * they run). It takes the argv the built-in adapter passes — `--search` before
 * `exec`; `--json`, `--output-last-message <file>` (or `-o`),
 * `--skip-git-repo-check`, `--ephemeral`, `--sandbox <mode>`, `--cd <dir>`, `--model <id>`,
 * `--output-schema <file>` and `-` after it — and refuses, as clap does (exit
 * 2), an argv codex would refuse. `--version` answers.
 *
 * It reads its prompt on stdin and prints what `codex exec --json` prints
 * (codex-rs/exec/src/exec_events.rs; https://developers.openai.com/codex/noninteractive)
 * for the scenario the prompt names with `CASE:<name>`:
 *
 *   ok          two turns, each with its usage; the final message last (the
 *               token `odw doctor --smoke` asks for, when it asks); the default
 *   tools       command_execution (one passing, one failing), file_change,
 *               mcp_tool_call, web_search, todo_list, a warning `error` item
 *   schema      the --output-schema file's minimal valid value, as the message
 *   quota       an `error`, then `turn.failed`, both "Quota exceeded…"; exit 1
 *   login       `turn.failed` with codex's expired-login message; exit 1
 *   stream      a first message, then — once the file `GATE:<path>` names
 *               exists — the final one: what a live view sees in between
 *   rate-limit  the first run: a retried "Reconnecting…" `error`, then
 *               "exceeded retry limit, last status: 429 …" and exit 1 (no
 *               turn.failed); later runs: a retried error, then a reply
 *   noisy       unknown events and item types, malformed and stray lines, then a reply
 *   silent      a turn that completes with no agent message
 *   drift       the reply under an item type the adapter does not know
 *
 * Like codex, it writes the final message to the --output-last-message file
 * only when the turn completed — empty, with codex's warning on stderr, when
 * there was none. `STATE:<path>` in the prompt names a file that counts its
 * runs. It appends each file it was handed to `REPLY_LOG:<path>`, when named.
 * Used only by the test suite.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("codex-cli 0.0.0-fake\n");
  process.exit(0);
}

const usage = (message) => {
  process.stderr.write(`error: ${message}\n\nUsage: codex exec [OPTIONS] [PROMPT]\n`);
  process.exit(2);
};

// Top level: only --search may come before `exec`.
let at = 0;
let search = false;
for (; at < args.length && args[at] !== "exec"; at++) {
  if (args[at] === "--search") search = true;
  else usage(`unexpected argument '${args[at]}' found`);
}
if (args[at] !== "exec") usage("a subcommand is required");
const opts = { json: false, lastMessage: undefined, schema: undefined, model: undefined, sandbox: undefined, cd: undefined, stdin: false };
const takesValue = { "--output-last-message": "lastMessage", "-o": "lastMessage", "--output-schema": "schema", "--model": "model", "--sandbox": "sandbox", "--cd": "cd" };
for (at++; at < args.length; at++) {
  const arg = args[at];
  if (arg === "--json") opts.json = true;
  else if (arg === "--skip-git-repo-check" || arg === "--ephemeral") continue;
  else if (arg === "-") opts.stdin = true;
  else if (arg in takesValue) {
    const value = args[++at];
    if (value === undefined || value === "") usage(`a value is required for '${arg} <VALUE>' but none was supplied`);
    opts[takesValue[arg]] = value;
  } else usage(`unexpected argument '${arg}' found${arg === "--search" ? " (it is a top-level flag: put it before exec)" : ""}`);
}
if (!opts.stdin) usage("this fake reads its prompt from stdin: pass -");
void search;

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  const scenario = /CASE:(\S+)/.exec(prompt)?.[1] ?? "ok";
  const state = /STATE:(\S+)/.exec(prompt)?.[1];
  const replyLog = /REPLY_LOG:(\S+)/.exec(prompt)?.[1];
  if (replyLog && opts.lastMessage) appendFileSync(replyLog, `${opts.lastMessage}\n`);
  let run = 0;
  if (state) {
    run = existsSync(state) ? Number(readFileSync(state, "utf8")) || 0 : 0;
    writeFileSync(state, String(run + 1));
  }
  const scenarios = { ok, tools, schema, quota, login, stream, "rate-limit": rateLimit, noisy, silent, drift };
  const play = scenarios[scenario];
  if (!play) {
    process.stderr.write(`fake codex: no scenario '${scenario}'\n`);
    process.exit(3);
  }
  play(run);
});

// --- what it prints -------------------------------------------------------------------

let items = 0;
const nextId = () => `item_${items++}`;
const emit = (event) => {
  if (opts.json) process.stdout.write(`${JSON.stringify(event)}\n`);
};
const start = () => {
  emit({ type: "thread.started", thread_id: "0199a213-81c0-7800-8aa1-bbab2a035a53" });
  emit({ type: "turn.started" });
};
const message = (text) => emit({ type: "item.completed", item: { id: nextId(), type: "agent_message", text } });
const reasoning = (text) => emit({ type: "item.completed", item: { id: nextId(), type: "reasoning", text } });
const turnCompleted = (input, cached, output, reasoningTokens = 0) =>
  emit({
    type: "turn.completed",
    usage: {
      input_tokens: input,
      cached_input_tokens: cached,
      cache_write_input_tokens: 0,
      output_tokens: output,
      reasoning_output_tokens: reasoningTokens,
    },
  });
/** The turn completed: the final message goes to the reply file (empty, with codex's warning, when there is none). */
const finish = (final) => {
  if (!opts.json && final !== undefined) process.stdout.write(`${final}\n`);
  if (!opts.lastMessage) return;
  writeFileSync(opts.lastMessage, final ?? "");
  if (final === undefined) process.stderr.write(`Warning: no last agent message; wrote empty content to ${opts.lastMessage}\n`);
};
const command = (cmd, output, exitCode) => {
  const id = nextId();
  emit({ type: "item.started", item: { id, type: "command_execution", command: cmd, aggregated_output: "", exit_code: null, status: "in_progress" } });
  emit({
    type: "item.completed",
    item: { id, type: "command_execution", command: cmd, aggregated_output: output, exit_code: exitCode, status: exitCode === 0 ? "completed" : "failed" },
  });
};

function ok() {
  // `odw doctor --smoke` asks for a token back.
  const final = /Reply with exactly (\S+) and nothing else/.exec(prompt)?.[1] ?? "final answer";
  start();
  reasoning("**Reading the task**\n\nThe answer needs two steps.");
  message("first answer");
  turnCompleted(1200, 1000, 80, 30);
  emit({ type: "turn.started" });
  message(final);
  turnCompleted(2400, 2000, 50, 10);
  finish(final);
}

function tools() {
  start();
  command("bash -lc 'npm test'", "ok 1 - adds\n", 0);
  command("bash -lc 'npm run lint'", "src/add.ts\n  1:1  error  Missing semicolon\n", 1);
  emit({
    type: "item.completed",
    item: { id: nextId(), type: "file_change", changes: [{ path: "src/add.ts", kind: "update" }, { path: "src/new.ts", kind: "add" }], status: "completed" },
  });
  const mcp = nextId();
  const call = { id: mcp, type: "mcp_tool_call", server: "github", tool: "create_issue", arguments: { title: "Lint fails" } };
  emit({ type: "item.started", item: { ...call, result: null, error: null, status: "in_progress" } });
  emit({
    type: "item.completed",
    item: { ...call, result: { content: [{ type: "text", text: "created issue #12" }], structured_content: null }, error: null, status: "completed" },
  });
  const search = nextId();
  emit({ type: "item.started", item: { id: search, type: "web_search", query: "", action: { type: "other" } } });
  emit({
    type: "item.completed",
    item: { id: search, type: "web_search", query: "eslint semi rule", action: { type: "search", query: "eslint semi rule" } },
  });
  const plan = nextId();
  emit({ type: "item.started", item: { id: plan, type: "todo_list", items: [{ text: "run the tests", completed: false }, { text: "fix lint", completed: false }] } });
  emit({ type: "item.updated", item: { id: plan, type: "todo_list", items: [{ text: "run the tests", completed: true }, { text: "fix lint", completed: false }] } });
  emit({ type: "item.completed", item: { id: nextId(), type: "error", message: "model rerouted: gpt-5.1-codex -> gpt-5.1 (HighRiskCyberActivity)" } });
  message("Tests pass; lint fails on a missing semicolon. Filed #12.");
  emit({ type: "item.completed", item: { id: plan, type: "todo_list", items: [{ text: "run the tests", completed: true }, { text: "fix lint", completed: false }] } });
  turnCompleted(5000, 4000, 300, 120);
  finish("Tests pass; lint fails on a missing semicolon. Filed #12.");
}

function schema() {
  if (!opts.schema) {
    process.stderr.write("fake codex: CASE:schema needs --output-schema\n");
    process.exit(3);
  }
  const value = JSON.stringify(generate(JSON.parse(readFileSync(opts.schema, "utf8"))));
  start();
  message(value);
  turnCompleted(900, 0, 20);
  finish(value);
}

function quota() {
  start();
  const said = "Quota exceeded. Check your plan and billing details.";
  emit({ type: "error", message: said });
  emit({ type: "turn.failed", error: { message: said } });
  process.exitCode = 1;
}

function login() {
  start();
  const said = "Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.";
  emit({ type: "turn.failed", error: { message: said } });
  process.exitCode = 1;
}

function stream() {
  const gate = /GATE:(\S+)/.exec(prompt)?.[1];
  start();
  message("thinking it over");
  const deadline = Date.now() + 10_000;
  const wait = () => {
    if (gate && !existsSync(gate) && Date.now() < deadline) {
      setTimeout(wait, 20);
      return;
    }
    message("the streamed answer");
    turnCompleted(800, 600, 25);
    finish("the streamed answer");
  };
  wait();
}

function rateLimit(run) {
  start();
  emit({ type: "error", message: "Reconnecting... 1/5 (stream disconnected before completion: rate limit exceeded: Rate limit reached for gpt-5.1)" });
  if (run === 0) {
    emit({ type: "error", message: "exceeded retry limit, last status: 429 Too Many Requests, request id: req_fake" });
    process.exitCode = 1;
    return;
  }
  message("answered after the limit");
  turnCompleted(700, 0, 12);
  finish("answered after the limit");
}

function noisy() {
  if (opts.json) {
    process.stdout.write("codex: a notice that is not JSON\n");
    process.stdout.write(`${JSON.stringify({ type: "session.heartbeat", n: 1 })}\n`);
    process.stdout.write('{"type":"item.completed","item":{"id":\n');
    process.stdout.write("[1,2,3]\n");
    process.stdout.write(`${JSON.stringify({ item: { type: "agent_message", text: "an event without a type" } })}\n`);
  }
  start();
  emit({ type: "item.completed", item: { id: nextId(), type: "hologram", shape: "cube" } });
  emit({ type: "item.completed", item: "not an object" });
  message("survived the noise");
  turnCompleted(300, 0, 7);
  finish("survived the noise");
}

function silent() {
  start();
  command("bash -lc 'touch done.txt'", "", 0);
  turnCompleted(400, 0, 9);
  finish(undefined);
}

function drift() {
  start();
  emit({ type: "item.completed", item: { id: nextId(), type: "assistant_message", content: [{ text: "the drifted reply" }] } });
  turnCompleted(500, 100, 11);
  finish("the drifted reply");
}

/** A minimal instance of a schema: the first of each choice, every property, the fewest items. */
function generate(schema) {
  if (schema === null || typeof schema !== "object") return null;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  switch (Array.isArray(schema.type) ? schema.type[0] : schema.type) {
    case "object":
      return Object.fromEntries(Object.entries(schema.properties || {}).map(([key, sub]) => [key, generate(sub)]));
    case "array":
      return Array.from({ length: schema.minItems || 1 }, () => generate(schema.items || { type: "string" }));
    case "number":
      return 0.5;
    case "integer":
      return 1;
    case "boolean":
      return true;
    default:
      return "fake";
  }
}
