#!/usr/bin/env node
/**
 * A fake `agy` (Google Antigravity CLI), for the agy adapter's tests (agy is
 * not installed where they run). It parses argv as agy's print mode does —
 * the flags of https://antigravity.google/docs/cli/headless ("Flag
 * reference"), plus --mode (https://antigravity.google/docs/cli/modes),
 * --disable-slash-commands (changelog 1.1.9) and --add-dir, in `--flag value`
 * or `--flag=value` spelling — and refuses what agy refuses: an unknown flag,
 * a stray argument, a flag with no value or one that swallows the next flag
 * (changelog 1.1.18), an unknown --output-format, --input-format, --mode or
 * --effort: `error: …` on stderr, exit 2 (print-mode usage errors, changelog
 * 1.3.3). A --json-schema that is not JSON, names no file, or whose root is
 * not "type": "object" fails at startup with exit 1 (changelog 1.2.14).
 * `--version` answers.
 *
 * The prompt is -p's value, else stdin (changelog 1.1.2: "a piped prompt").
 * It prints what `--output-format stream-json` prints (init, step_update,
 * result: the docs' "Streaming JSON"), `json`'s envelope, or `text`, for the
 * scenario the prompt names with `CASE:<name>`:
 *
 *   ok          a tool step, the reply in two text_delta fragments, a
 *               checkpoint, a result with usage (the token `odw doctor
 *               --smoke` asks for, when it asks); the default
 *   tools       run_command (passing), view_file, a failing grep_search
 *               (tool_info.error), a refused run_command (state ERROR), a
 *               step that starts two subagents, an error_message step, then a reply
 *   schema      the --json-schema's minimal valid value, as structured_output
 *               and serialized in response
 *   quota       "Individual quota reached … Resets in 2h39m52s." (#1018) as
 *               the result's error, an AGY_ERROR line on stderr; exit 3
 *   credits     "Your AI credits balance is too low to continue."; exit 3
 *   rate-limit  the first run: a per-minute 429 the CLI could not retry away,
 *               exit 3; later runs: a reply
 *   expired     "Authentication expired. Please log back in."; exit 3
 *   login       no sign-in: `error: authentication required` on stderr, no
 *               stdout; exit 1
 *   denied      a run_command headless could not ask approval for: status
 *               SUCCESS, an empty response, denied_actions, exit 0 (#794)
 *
 * With FAKE_AGY_TABLE naming a conformance mock table (conformance/README.md)
 * it answers from it instead: the first entry whose `when` occurs in the
 * prompt replies, or fails (the result's error and stderr say so, and it exits
 * with the entry's code), and reports no usage, as the suite's mock agent
 * reports none. `STATE:<path>` in the prompt names a file that counts its
 * runs. Used only by the test suite.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("1.4.0-fake\n");
  process.exit(0);
}

const usage = (message) => {
  process.stderr.write(`error: ${message}\n`);
  process.exit(2);
};
const fatal = (message) => {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
};

const VALUE_FLAGS = {
  "-p": "prompt",
  "--print": "prompt",
  "--prompt": "prompt",
  "--output-format": "outputFormat",
  "--input-format": "inputFormat",
  "--json-schema": "jsonSchema",
  "--model": "model",
  "--effort": "effort",
  "--agent": "agent",
  "--conversation": "conversation",
  "--print-timeout": "printTimeout",
  "--mode": "mode",
  "--add-dir": "addDir",
};
const BOOL_FLAGS = {
  "--dangerously-skip-permissions": "skipPermissions",
  "--sandbox": "sandbox",
  "--continue": "continue",
  "-c": "continue",
  "--disable-slash-commands": "disableSlashCommands",
};
const opts = { outputFormat: "text", inputFormat: "text" };
for (let at = 0; at < args.length; at++) {
  const arg = args[at];
  const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
  const flag = eq === -1 ? arg : arg.slice(0, eq);
  if (flag in BOOL_FLAGS) {
    if (eq !== -1) usage(`flag ${flag} takes no value`);
    opts[BOOL_FLAGS[flag]] = true;
  } else if (flag in VALUE_FLAGS) {
    const value = eq === -1 ? args[++at] : arg.slice(eq + 1);
    if (value === undefined || value === "") usage(`flag needs an argument: ${flag}`);
    // A valueless flag no longer swallows the next one (changelog 1.1.18).
    if (eq === -1 && value.startsWith("-")) usage(`flag needs an argument: ${flag} (got the flag ${value})`);
    opts[VALUE_FLAGS[flag]] = value;
  } else if (arg.startsWith("-")) {
    usage(`unknown flag: ${flag}`);
  } else {
    usage(`unexpected argument "${arg}"`);
  }
}
const oneOf = (name, value, allowed) => {
  if (value !== undefined && !allowed.includes(value)) usage(`invalid value "${value}" for ${name}: one of ${allowed.join(", ")}`);
};
oneOf("--output-format", opts.outputFormat, ["text", "json", "stream-json"]);
oneOf("--input-format", opts.inputFormat, ["text", "stream-json"]);
oneOf("--mode", opts.mode, ["default", "accept-edits", "plan", "auto"]);
oneOf("--effort", opts.effort, ["low", "medium", "high"]);
if (opts.printTimeout !== undefined && !/^(?:0|(?:\d+(?:\.\d+)?(?:ms|s|m|h))+)$/.test(opts.printTimeout)) {
  usage(`invalid duration "${opts.printTimeout}" for --print-timeout`);
}
if (opts.inputFormat === "stream-json") usage("this fake does not drive --input-format stream-json sessions");

let schema;
if (opts.jsonSchema !== undefined) {
  const raw = opts.jsonSchema.trimStart().startsWith("{")
    ? opts.jsonSchema
    : existsSync(opts.jsonSchema)
      ? readFileSync(opts.jsonSchema, "utf8")
      : fatal(`--json-schema: "${opts.jsonSchema}" is neither a JSON schema nor a schema file`);
  try {
    schema = JSON.parse(raw);
  } catch (err) {
    fatal(`--json-schema: invalid JSON: ${err.message}`);
  }
  if (typeof schema !== "object" || schema === null || schema.type !== "object") fatal('--json-schema: the schema root must be "type": "object"');
}

if (opts.prompt !== undefined) {
  // A prompt given with a flag: stdin is not read (changelog 1.1.1).
  run(opts.prompt);
} else {
  let prompt = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    prompt += chunk;
  });
  process.stdin.on("end", () => {
    if (!prompt.trim()) usage("no prompt: pass -p, or pipe one on stdin");
    run(prompt);
  });
}

// --- what it prints ---------------------------------------------------------------------

const CONVERSATION = "c3b66b04-872b-4fbe-a3a4-058a026ef20a";
let stepIndex = 0;
const stream = opts.outputFormat === "stream-json";
const emit = (event) => {
  if (stream) process.stdout.write(`${JSON.stringify(event)}\n`);
};
const step = (fields) => emit({ event: "step_update", step_update: { conversation_id: CONVERSATION, ...fields } });
const init = () => {
  const payload = { cwd: process.cwd(), tools: ["run_command", "view_file", "write_to_file", "grep_search"], permission_mode: opts.skipPermissions ? "always-proceed" : "request-review" };
  if (opts.model) payload.model = opts.model;
  if (schema) payload.json_schema = schema;
  emit({ event: "init", conversation_id: CONVERSATION, init: payload });
  step({ step_index: stepIndex++, state: "DONE", step_type: "user_input" });
};
// Answering from a conformance table, it reports no usage: the suite's cases
// are written against a mock that reports none (17-budget-estimate counts on it).
const usageOf = (input, cached, output, thinking) =>
  process.env.FAKE_AGY_TABLE
    ? undefined
    : { input_tokens: input, output_tokens: output, thinking_tokens: thinking, cache_read_tokens: cached, total_tokens: input + output };
const tool = (name, parameters, output, { error, state = "DONE" } = {}) => {
  const index = stepIndex++;
  step({ step_index: index, state: "ACTIVE", step_type: "tool", tool_name: name, tool_info: { name, parameters } });
  const info = { name, parameters };
  if (output !== undefined) info.output = output;
  if (error) info.error = error;
  step({ step_index: index, state, step_type: "tool", tool_name: name, duration_seconds: 0.07, tool_info: info });
};
const respond = (fragments, usage) => {
  const index = stepIndex++;
  fragments.forEach((text, i) => {
    const last = i === fragments.length - 1;
    step({ step_index: index, state: last ? "DONE" : "ACTIVE", step_type: "agent_response", text_delta: text, ...(last ? { duration_seconds: 1.2, usage } : {}) });
  });
};
/** The result, in the chosen format; then the exit. */
const finish = (result, code = 0, stderr = "") => {
  const envelope = { conversation_id: CONVERSATION, num_turns: 1, duration_seconds: 2.5, ...result };
  if (stream) emit({ event: "result", result: envelope });
  else if (opts.outputFormat === "json") process.stdout.write(`${JSON.stringify(envelope)}\n`);
  else if (envelope.response) process.stdout.write(envelope.response);
  if (stderr) process.stderr.write(stderr.endsWith("\n") ? stderr : `${stderr}\n`);
  process.exit(code);
};
const reply = (text, usage = usageOf(10302, 8113, 582, 551)) => {
  const halves = text.length > 1 ? [text.slice(0, Math.ceil(text.length / 2)), `${text.slice(Math.ceil(text.length / 2))}\n`] : [`${text}\n`];
  respond(halves, usage);
  step({ step_index: stepIndex++, state: "DONE", step_type: "checkpoint", duration_seconds: 0.53, usage: usageOf(116, 0, 7, 0) });
  const result = { status: "SUCCESS", response: `${text}\n`, usage: usageOf(10418, 8113, 589, 551) };
  let value;
  try {
    value = schema ? JSON.parse(text) : undefined;
  } catch {
    value = undefined;
  }
  if (schema && typeof value === "object" && value !== null && !Array.isArray(value)) {
    result.structured_output = value;
    result.json_schema = schema;
  }
  finish(result);
};
/** A turn that ends on a model API error (changelog 1.2.6, 1.2.10): the result's error, AGY_ERROR on stderr, exit 3. */
const apiError = (message, status, code, retryable) => {
  finish(
    { status: "ERROR", response: "", error: message, num_turns: 1, usage: usageOf(0, 0, 0, 0) },
    3,
    `AGY_ERROR: ${JSON.stringify({ short_error: message, status, error_code: code, code_kind: "http", retryable })}`,
  );
};

/** A schema's minimal valid value: what a model constrained to it might say. */
function minimal(node) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node.enum)) return node.enum[0];
  const type = Array.isArray(node.type) ? node.type[0] : node.type;
  switch (type) {
    case "object": {
      const out = {};
      for (const name of node.required ?? []) out[name] = minimal(node.properties?.[name]);
      return out;
    }
    case "array":
      return [];
    case "string":
      return "x";
    case "integer":
    case "number":
      return node.minimum ?? 1;
    case "boolean":
      return true;
    default:
      return null;
  }
}

function run(prompt) {
  const state = /STATE:(\S+)/.exec(prompt)?.[1];
  let runs = 0;
  if (state) {
    runs = existsSync(state) ? Number(readFileSync(state, "utf8")) || 0 : 0;
    writeFileSync(state, String(runs + 1));
  }
  if (process.env.FAKE_AGY_TABLE) return fromTable(prompt);
  const scenario = /CASE:(\S+)/.exec(prompt)?.[1] ?? "ok";
  const scenarios = { ok, tools, schema: schemaReply, quota, credits, "rate-limit": rateLimit, expired, login, denied };
  const play = scenarios[scenario];
  if (!play) {
    process.stderr.write(`fake agy: no scenario '${scenario}'\n`);
    process.exit(4);
  }
  play(prompt, runs);
}

function ok(prompt) {
  // `odw doctor --smoke` asks for a token back.
  const final = /Reply with exactly (\S+) and nothing else/.exec(prompt)?.[1] ?? "final answer";
  init();
  tool("view_file", { AbsolutePath: `${process.cwd()}/README.md` }, "# readme\n");
  reply(final);
}

function tools() {
  init();
  tool("run_command", { CommandLine: "echo hello_headless_demo" }, "hello_headless_demo\r\n");
  tool("view_file", { AbsolutePath: "/work/src/index.ts" }, "export {}\n");
  tool("grep_search", { Query: "TODO" }, undefined, { error: { type: "INVALID_ARGUMENT", message: "no such directory: /nope" } });
  tool("run_command", { CommandLine: "rm -rf build" }, undefined, {
    state: "ERROR",
    error: { type: "PERMISSION_DENIED", message: 'permission check failed for command "rm -rf build": user denied permission to run command' },
  });
  const index = stepIndex++;
  const subagents = [
    { type_name: "reviewer", role: "code review", conversation_id: "9ec58bfd-0001", log_uri: "file:///tmp/agy/9ec58bfd-0001.log", workspace_uris: ["file:///work"] },
    { type_name: "browser", role: "verify the page", conversation_id: "9ec58bfd-0002", log_uri: "file:///tmp/agy/9ec58bfd-0002.log", workspace_uris: [] },
  ];
  step({ step_index: index, state: "ACTIVE", step_type: "tool", tool_name: "invoke_subagent", subagent_info: { subagents } });
  step({ step_index: index, state: "DONE", step_type: "tool", tool_name: "invoke_subagent", subagent_info: { subagents }, tool_info: { name: "invoke_subagent", parameters: { Count: 2 }, output: "2 subagents finished" } });
  step({ step_index: stepIndex++, state: "DONE", step_type: "error_message", text_delta: "Malformed function call: retrying" });
  reply("all done");
}

function schemaReply() {
  init();
  reply(schema ? JSON.stringify(minimal(schema)) : "no schema was given");
}

function quota() {
  init();
  apiError(
    "API error (attempt 1): RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h39m52s.",
    "RESOURCE_EXHAUSTED",
    429,
    true,
  );
}

function credits() {
  init();
  apiError("Your AI credits balance is too low to continue.", "RESOURCE_EXHAUSTED", 429, false);
}

function rateLimit(prompt, runs) {
  if (runs > 0) return ok(prompt);
  init();
  apiError("API error (attempt 3): RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).", "RESOURCE_EXHAUSTED", 429, true);
}

function expired() {
  init();
  apiError("Authentication expired. Please log back in.", "UNAUTHENTICATED", 401, false);
}

function login() {
  process.stderr.write("error: authentication required\n");
  process.exit(1);
}

function denied() {
  init();
  tool("run_command", { CommandLine: 'python -c "print(9*9)"' }, undefined, {
    state: "ERROR",
    error: { type: "PERMISSION_DENIED", message: 'permission check failed for command "python -c \\"print(9*9)\\"": user denied permission to run command' },
  });
  finish(
    { status: "SUCCESS", response: "", usage: usageOf(14103, 0, 395, 338), denied_actions: [{ action: "command", display_name: "RunCommand" }] },
    0,
    'no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.',
  );
}

function fromTable(prompt) {
  const table = JSON.parse(readFileSync(process.env.FAKE_AGY_TABLE, "utf8"));
  const entry = table.find((e) => typeof e.when === "string" && prompt.includes(e.when));
  if (!entry) {
    process.stderr.write(`fake agy: no table entry matches the prompt: ${JSON.stringify(prompt.slice(0, 200))}\n`);
    process.exit(4);
  }
  const answer = () => {
    init();
    if (entry.fail) {
      const fail = entry.fail === true ? {} : entry.fail;
      const message = fail.stderr ?? "fake agy: this entry fails";
      finish({ status: "ERROR", response: "", error: message, usage: usageOf(0, 0, 0, 0) }, Number.isInteger(fail.exit) && fail.exit !== 0 ? fail.exit : 1, `error: ${message}`);
    }
    reply(typeof entry.reply === "string" ? entry.reply : JSON.stringify(entry.reply));
  };
  setTimeout(answer, Number.isInteger(entry.delayMs) && entry.delayMs > 0 ? entry.delayMs : 0);
}
