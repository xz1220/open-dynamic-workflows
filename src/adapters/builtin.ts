/**
 * Built-in adapter templates and default run settings.
 *
 * These mirror the non-interactive invocation each coding-agent CLI supports,
 * so a fresh install can orchestrate common agents with no config file. Users
 * override or extend them in `odw.config.json`; user entries always win.
 *
 * The command templates are intentionally conservative. Sandboxing, model
 * selection and auth flags differ per environment, so the references doc
 * explains how to tune them rather than baking opinions in here.
 */

import type {
  AdapterFailures,
  ContainerSpec,
  AdapterFlags,
  AdapterOutput,
  BackgroundRules,
  DenialPolicy,
  PermissionArgs,
  PermissionTier,
  SchemaFlag,
  Settings,
  TrustLevel,
} from "./types.js";
import type { LimitSpec } from "../limits.js";

/** A built-in adapter spec — same shape as a config entry, minus its name. */
export interface RawAdapter {
  command: string[];
  stdin?: string;
  env?: Record<string, string>;
  timeout?: number;
  stallTimeout?: number;
  concurrency?: number;
  promptCache?: boolean;
  label?: string;
  flags?: AdapterFlags;
  output?: AdapterOutput;
  failures?: AdapterFailures;
  permissionArgs?: PermissionArgs;
  permissions?: PermissionTier;
  permissionDenials?: DenialPolicy;
  trust?: TrustLevel;
  untrustedArgs?: string[];
  untrustedNote?: string;
  sandbox?: ContainerSpec;
  agentLimits?: LimitSpec;
  egressHosts?: string[];
}

// `flags` only DECLARES which native flag carries a model — the router appends
// it (with a value) when a call sets `model`, and otherwise leaves the command
// untouched. Templates stay conservative: no `{model}` baked in, no value forced.
// Model ids do not cross CLIs (e.g. `claude-opus-4-8` is invalid to codex), so a
// model is honoured per-CLI, not normalised across them.

const KILO_OPENCODE_OUTPUT: AdapterOutput = {
  format: "jsonl",
  eventType: "text",
  textPath: ["part", "text"],
  select: "last",
};
// Claude Code's stream-json (https://code.claude.com/docs/en/headless): one
// event per message, ending in a `result` event with the reply, the session's
// usage and cost, and `is_error` when it failed — rate limits, spent quotas
// and logins arrive that way, often with exit 0. Given --json-schema, that
// event also carries the validated value as `structured_output` (the Agent
// SDK's result message, which is this event: `structured_output?: unknown`);
// a run that produced none has it absent or null, and its `result` text is
// read instead. Its `permission_denials` list the tool calls headless mode
// refused, under a reply that may claim success. The stream's first event,
// `{"type":"system","subtype":"init"}` (the Agent SDK's SDKSystemMessage),
// lists `mcp_servers: [{ name, status, source? }]`, status one of McpServerStatus's
// "connected" | "failed" | "needs-auth" | "pending" | "disabled" — an agent whose
// server failed runs on without its tools, and may still say it is done.
//
// Background work (ODW extension; `background`): a Bash call with
// `run_in_background: true` returns at once, and an Agent (formerly Task)
// subagent runs in the background unless its call sets `run_in_background:
// false` — so the tool call alone shows only some of it. What Claude Code's
// stream-json says of every task is the Agent SDK's system messages (checked
// against the 2.1.302 binary): `task_started { task_id, tool_use_id?,
// task_type, description, is_backgrounded? }`, `task_updated { task_id,
// patch: { status? } }` — "completed", "failed" or "killed" ends it — and
// `task_notification { task_id, tool_use_id?, status }`: the events Claude
// Code's own session runner counts a task open and done by, an
// `in_process_teammate` aside. A background tool call is counted too, for a
// CLI that registers no task for it, and the notification injected into the
// conversation as text (`<task-id>`, `<tool-use-id>`) ends one. Work still
// open at the `result` event died when `-p` exited (anthropics/claude-code#85129).
const CLAUDE_NOTIFICATION_IDS = "<(?:task-id|tool-use-id)>\\s*([^<\\s]+)\\s*</";
const CLAUDE_BACKGROUND: BackgroundRules = {
  started: [
    {
      event: "system",
      where: [{ path: ["subtype"], equals: "task_started" }, { path: ["task_type"], not: "in_process_teammate" }],
      ids: [["task_id"], ["tool_use_id"]],
      kind: [["subagent_type"], ["task_type"]],
      about: [["description"]],
    },
    {
      event: "assistant",
      each: ["message", "content"],
      where: [
        { path: ["type"], equals: "tool_use" },
        { path: ["name"], equals: ["Bash", "Agent", "Task"] },
        { path: ["input", "run_in_background"], equals: true },
      ],
      ids: [["id"]],
      kind: [["name"]],
      about: [["input", "description"], ["input", "command"]],
    },
  ],
  ended: [
    { event: "system", where: [{ path: ["subtype"], equals: "task_notification" }], ids: [["task_id"], ["tool_use_id"]] },
    {
      event: "system",
      where: [
        { path: ["subtype"], equals: "task_updated" },
        { path: ["patch", "status"], equals: ["completed", "failed", "killed"] },
      ],
      ids: [["task_id"]],
    },
    {
      event: "user",
      each: ["message", "content"],
      where: [{ path: ["type"], equals: "text" }],
      ids: [["text"]],
      pattern: CLAUDE_NOTIFICATION_IDS,
    },
    { event: "user", ids: [["message", "content"]], pattern: CLAUDE_NOTIFICATION_IDS },
  ],
};

const CLAUDE_OUTPUT: AdapterOutput = {
  format: "jsonl",
  eventType: "result",
  textPath: ["result"],
  select: "last",
  usagePath: ["usage"],
  costPath: ["total_cost_usd"],
  errorPath: ["is_error"],
  structuredPath: ["structured_output"],
  deniedPath: ["permission_denials"],
  mcpEvent: "system",
  mcpPath: ["mcp_servers"],
  background: CLAUDE_BACKGROUND,
};

// `codex exec --json` (https://developers.openai.com/codex/noninteractive, now
// https://learn.chatgpt.com/docs/non-interactive-mode; the event types are
// codex-rs/exec/src/exec_events.rs): JSONL events — thread.started,
// turn.started, item.started/updated/completed {item: {id, type, …}},
// turn.completed {usage}, turn.failed {error: {message}}, error {message}.
//
// The reply comes from two places, on purpose. `--output-last-message
// {reply_file}` is codex's own final message, written once the turn completed
// — empty when it had none — whatever shape its events take (it even
// recovers a message whose event was dropped under backpressure), so it wins.
// The last `item.completed` agent_message (`match`) is the reply when that
// file is missing — and when both are, a stream of events is no reply: the
// reply is empty (an empty_reply failure) and the run's log says what was
// missing (see output.ts). With --output-schema that message is the JSON.
//
// Usage: `turn.completed`'s, summed. Its input_tokens already counts the
// cached part (codex's own non_cached_input() is input_tokens -
// cached_input_tokens) and its output_tokens the reasoning part, so they are
// usage.ts's inputTokens and outputTokens as they are; cached_input_tokens is
// cacheReadTokens, cache_write_input_tokens cacheWriteTokens. Codex runs one
// turn per exec, so the sum is that turn's (codex reports its thread's total
// so far). No dollars: codex reports none, and ODW invents no prices.
//
// Failures: `turn.failed` and `error` are codex's own report, classified like
// any failure — but codex also prints an error it retries ("Reconnecting...
// 2/5") as an `error` event and goes on, so a later turn.completed clears it.
// Non-fatal `error` *items* are warnings, shown in the transcript only.
const CODEX_OUTPUT: AdapterOutput = {
  format: "jsonl",
  eventType: "item.completed",
  match: { path: ["item", "type"], equals: "agent_message" },
  textPath: ["item", "text"],
  select: "last",
  usageEvent: "turn.completed",
  usagePath: ["usage"],
  errorEvents: { "turn.failed": ["error"], error: ["message"] },
};

// Google Antigravity CLI (`agy`) print mode, `--output-format stream-json`
// (added in 1.1.8: https://antigravity.google/docs/changelog, "v1.1.8"; the
// shapes are https://antigravity.google/docs/cli/headless, "Streaming JSON"):
// NDJSON events named by an `event` key, not `type` — one `init`
// {cwd, tools, permission_mode}, `step_update`s {step_index, state:
// ACTIVE|DONE, step_type: user_input|agent_response|tool|checkpoint, text_delta?,
// usage?, tool_info?, subagent_info?}, and one `result` shaped like
// `--output-format json`'s envelope: {status, response, error?, num_turns,
// usage, structured_output?}. The reply is the result's `response`.
//
// Usage: the result's, the session's total (one turn per run here). Its
// fields are input_tokens, output_tokens (thinking_tokens are part of them),
// cache_read_tokens — counted apart from input_tokens, as the docs' second
// turn shows (input 278, cache_read 30214, total 282) — and total_tokens;
// usage.ts adds the cache back in. No dollars: agy reports none (it bills AI
// credits), and ODW invents no prices.
//
// Failures: `error` is "present only on failure" (the docs' envelope table),
// with `status` ERROR. Since 1.2.10 a run that ends on a model or API error
// also exits 3 and prints a structured `AGY_ERROR: {...}` line on stderr
// (changelog 1.2.6, 1.2.10; its fields: google-antigravity/antigravity-cli#778);
// a run that cannot start (an unknown --model, a bad --json-schema) prints
// `error: …` on stderr and exits 1, a usage error exits 2. Wording: failures.ts.
//
// Refusals: a tool call headless agy could not ask approval for is
// soft-denied — the run goes on, exits 0, and since 1.1.27 lists it in the
// result's `denied_actions` ({action, display_name}: changelog 1.1.27, and
// antigravity-cli#794 for the shape). A run that ends on one often has an
// empty response under status SUCCESS (#794): ODW fails that as empty_reply,
// with the refusal recorded.
//
// No `background`: agy's stream says when a subagent starts (`subagent_info`)
// but nothing documented says when one ends, and a backgrounded run_command
// shows no id a later event ends — rules for them would call every subagent
// orphaned. Headless agy waits for its background tasks itself, up to
// --print-timeout (changelog 1.1.28, 1.2.9); "terminating N background
// task(s) on exit" on stderr (antigravity-cli#1044) is what it says when it
// did not. And a subagent's own output never reaches the parent's stream
// (antigravity-cli#1077): the transcript shows that one started, and where
// its log is.
const AGY_OUTPUT: AdapterOutput = {
  format: "jsonl",
  eventKey: "event",
  eventType: "result",
  textPath: ["result", "response"],
  select: "last",
  usagePath: ["result", "usage"],
  errorPath: ["result", "error"],
  structuredPath: ["result", "structured_output"],
  deniedPath: ["result", "denied_actions"],
};

// Native structured output (ODW extension; see native-schema.ts). Claude Code
// 2.1.302 `--json-schema <schema>` takes the schema's JSON as its value and
// rejects an invalid one before the run starts ("Error: --json-schema is not
// a valid JSON Schema"); it treats `format` as an annotation.
const CLAUDE_SCHEMA: SchemaFlag = { args: ["--json-schema"], mode: "inline" };
// `codex exec --output-schema <file>` (https://developers.openai.com/codex/noninteractive)
// is an exec option declared `global = true` beside an optional PROMPT
// positional, so it parses after `-` as `--model` does. Codex sends the schema
// in OpenAI's strict mode, which refuses (HTTP 400, before the model runs) a
// schema whose objects are not all closed with every property required.
const CODEX_SCHEMA: SchemaFlag = { args: ["--output-schema"], mode: "file", strict: true };
// agy `--json-schema` takes "either an inline schema string or a path to a
// schema file"; with stream-json "the schema applies to the final result
// event", whose `structured_output` holds the parsed value (changelog 1.1.8;
// https://antigravity.google/docs/cli/headless, "Structured output with a
// schema"). Since 1.2.14 it refuses, at startup with exit 1, "any schema whose
// root is not "type": "object"" (changelog 1.2.14): any other goes in the prompt.
const AGY_SCHEMA: SchemaFlag = { args: ["--json-schema"], mode: "inline", objectRoot: true };

// Permission tiers (ODW extension). Each built-in's posture flags sit in
// `permissionArgs` and are spliced where its command has `{permission_args}`;
// `edit` is exactly what the command carried before tiers existed. Only
// mappings a CLI's own docs confirm for headless runs are filled in: a tier
// left out is refused (`read`) or run as `edit` with a log line (`full`).

// Claude Code 2.1.302 (`claude --help`; https://code.claude.com/docs/en/headless,
// https://code.claude.com/docs/en/permission-modes, https://code.claude.com/docs/en/cli-reference).
// read: dontAsk denies every call that would prompt; --tools leaves only the
// read-only built-ins, so there is no Edit, Write or Bash to allow (an allow
// rule in a settings file cannot bring one back); the web tools stay,
// allowlisted; --strict-mcp-config without --mcp-config starts no MCP server.
// edit: acceptEdits, plus the web allowlist headless acceptEdits needs (it
// silently DENIES WebSearch/WebFetch otherwise, which breaks research
// workflows such as examples/deep-research.js).
// full: bypassPermissions — no prompts and no checks (refused as root/sudo).
const CLAUDE_PERMISSIONS: PermissionArgs = {
  read: [
    "--permission-mode",
    "dontAsk",
    "--tools",
    "Read,Glob,Grep,WebSearch,WebFetch",
    "--allowedTools",
    "WebSearch",
    "WebFetch",
    "--strict-mcp-config",
  ],
  edit: ["--permission-mode", "acceptEdits", "--allowedTools", "WebSearch", "WebFetch"],
  full: ["--permission-mode", "bypassPermissions"],
};

// codex exec's sandbox (https://developers.openai.com/codex/noninteractive,
// https://developers.openai.com/codex/concepts/sandboxing): read-only — it
// "can inspect files, but it can't edit files or run commands without
// approval", and exec asks nobody; workspace-write — edits and commands inside
// the workspace; danger-full-access — no filesystem or network boundary. No
// sandbox mode approves an MCP tool call that asks for approval
// (openai/codex#24135): see "Permissions" in the README.
const CODEX_PERMISSIONS: PermissionArgs = {
  read: ["--sandbox", "read-only"],
  edit: ["--sandbox", "workspace-write"],
  full: ["--sandbox", "danger-full-access"],
};

// Gemini CLI (https://geminicli.com/docs/cli/cli-reference): its policy engine
// (https://geminicli.com/docs/reference/policy-engine) asks before write and
// shell tools in `default` mode, and headless "this is treated as deny";
// read-only tools are allowed. yolo approves every tool.
const GEMINI_PERMISSIONS: PermissionArgs = {
  read: ["--approval-mode", "default"],
  edit: ["--approval-mode", "auto_edit"],
  full: ["--approval-mode", "yolo"],
};

// Qwen Code (https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/):
// headless `--approval-mode yolo` auto-approves every tool call. Its docs do
// not say what `default` does headless when a tool needs approval, so it has
// no "read" here.
const QWEN_PERMISSIONS: PermissionArgs = {
  edit: ["--approval-mode", "auto-edit"],
  full: ["--approval-mode", "yolo"],
};

// agy (https://antigravity.google/docs/cli/headless, "Permissions in headless
// mode"; https://antigravity.google/docs/cli/modes; https://antigravity.google/docs/permissions):
// headless, a tool that needs an approval it cannot get is soft-denied;
// reading and writing files in the workspace is allowed, while shell
// commands, web and MCP tools default to Ask — so are denied — unless the
// user's own permissions.allow rules in ~/.gemini/antigravity-cli/settings.json
// (or its "toolPermission" preset) allow them. `--mode` pins the execution
// mode over the user's agentMode setting (honoured headless since 1.1.12:
// changelog); accept-edits approves file edits and creations, while
// permission rules still govern shell commands. --dangerously-skip-permissions
// "approves all tool calls, including file writes and command execution". No
// read tier: no documented flag keeps headless agy from writing the workspace
// (plan mode only prefixes the prompt with /plan, and headless proceeds past
// its plan review: changelog 1.1.28).
const AGY_PERMISSIONS: PermissionArgs = {
  edit: ["--mode", "accept-edits"],
  full: ["--mode", "accept-edits", "--dangerously-skip-permissions"],
};

// One headless posture, no verified other: Kimi's print mode decides every
// tool call itself and takes no plan or approval flag with a prompt
// (https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command);
// Oh My Pi runs headless with --approval-mode yolo; `kilo/opencode run`
// with --auto; Cursor's `agent --print` with --force.
const EDIT_ONLY = (...edit: string[]): PermissionArgs => ({ edit });

// Untrusted repositories (ODW extension; see trust.ts). Each CLI reads
// instructions and settings from the repository it works in; an untrusted run
// adds its documented way of ignoring them after the tier's flags. Only flags
// a CLI's own docs or `--help` confirm are mapped (flags found only in source
// code are not); what a CLI cannot keep out is its `untrustedNote`, said once
// per run.

// Claude Code 2.1.302 `claude --help`: `--safe-mode` "Start[s] with all
// customizations (CLAUDE.md, skills, installed plugins, hooks, MCP servers,
// custom commands and agents, output styles, workflows, …) disabled … Auth,
// model selection, built-in tools and plugins, and permissions work normally."
// (`--bare` skips the same and more, but takes API-key auth only: subscription
// logins could not use it.)
const CLAUDE_UNTRUSTED = ["--safe-mode"];

// Qwen Code (https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/headless.md):
// `--safe-mode` "Disable[s] all customizations — context files, hooks,
// extensions, skills, MCP servers, custom subagents …, permission rules,
// settings-sourced approval mode overrides …; the CLI flags `--yolo` and
// `--approval-mode` still take effect", headless included (`qwen -p … --safe-mode`).
const QWEN_UNTRUSTED = ["--safe-mode"];

// Oh My Pi (https://github.com/can1357/oh-my-pi/blob/main/docs/cli-reference.md):
// `--no-extensions`, `--no-skills`, `--no-rules`. Its README: "Opening a
// repository loads its project inputs by design"; nothing documented turns
// off its context files (AGENTS.md, CLAUDE.md), project hooks or MCP config.
const OMP_UNTRUSTED = ["--no-extensions", "--no-skills", "--no-rules"];

// The CLIs with no documented way, and what still reaches their agents:
//   codex — AGENTS.md (and AGENTS.override.md) from the git root down
//     (https://learn.chatgpt.com/docs/agent-configuration/agents-md), with no
//     flag to skip it; its project `.codex/` config, hooks and rules load only
//     for a project the user trusted ("Untrusted projects skip project-scoped
//     `.codex/` layers", https://learn.chatgpt.com/docs/config-file/config-reference);
//   gemini — GEMINI.md, `.gemini/settings.json` (MCP servers, hooks) and
//     `.gemini/commands`; its untrusted-folder mode exits when headless
//     (https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/trusted-folders.md);
//   kimi — AGENTS.md and the project's skill directories (`--skills-dir` is
//     documented both as overriding and as adding to them);
//   kilo, opencode — AGENTS.md (or CLAUDE.md), the project's opencode.json /
//     kilo.json and `.opencode/` / `.kilo/` agents, commands and plugins
//     (https://opencode.ai/docs/config/, https://kilo.ai/docs/cli); the
//     switches that skip them exist only in source;
//   cursor — `.cursor/rules`, AGENTS.md and CLAUDE.md, mcp.json and hooks
//     (https://cursor.com/docs/cli/using); headless it runs only on a workspace
//     it trusts (`--trust`, https://cursor.com/docs/cli/reference/parameters);
//   agy — AGENTS.md or GEMINI.md in every directory up to the workspace root,
//     `.agents/rules/`, `.agents/skills/`, `.agents/agents/` and
//     `.agents/mcp_config.json` (https://antigravity.google/docs/rules,
//     https://antigravity.google/docs/cli/gcli-migration); neither its CLI
//     reference nor its headless flags have a switch that skips them.
const UNTRUSTED_NOTES = {
  codex:
    "codex has no documented way to ignore the repository's AGENTS.md — its instructions still reach the agent " +
    "(its .codex/ config, hooks and rules load only if you trusted the project in your own Codex config)",
  gemini:
    "gemini has no documented way to ignore the repository's GEMINI.md and .gemini/settings.json when headless — " +
    "its instructions, MCP servers and hooks still reach the agent",
  kimi: "kimi has no documented way to ignore the repository's AGENTS.md and skills — they still reach the agent",
  omp:
    "omp keeps the repository's extensions, skills and rules out (--no-extensions --no-skills --no-rules), but has no " +
    "documented way to ignore its AGENTS.md, CLAUDE.md, hooks or MCP config — they still reach the agent",
  kilo:
    "kilo has no documented way to ignore the repository's AGENTS.md, kilo.json and .kilo/ agents, commands and " +
    "plugins — they still reach the agent",
  opencode:
    "opencode has no documented way to ignore the repository's AGENTS.md, opencode.json and .opencode/ agents, " +
    "commands and plugins — they still reach the agent",
  cursor:
    "cursor has no documented way to ignore the repository's .cursor/rules, AGENTS.md, CLAUDE.md, mcp.json and " +
    "hooks — headless it runs only on a workspace it trusts, and they still reach the agent",
  agy:
    "agy has no documented way to ignore the repository's AGENTS.md, GEMINI.md and .agents/ rules, skills, agents " +
    "and MCP servers — they still reach the agent",
} as const;

// The hosts each CLI needs from inside a container sandbox with an egress
// allowlist (`network: { allow: "adapter" }`; ODW extension, see ./egress) —
// its model API and its login, from its docs; not its optional telemetry,
// updates or plugin downloads, which an allowlist then refuses (and logs).
// - Claude Code (https://code.claude.com/docs/en/network-config, "Network
//   access requirements"): api.anthropic.com (the API, feature flags and
//   event logging), claude.ai (a claude.ai login) and platform.claude.com (a
//   Console login, and every login's token exchange and refresh). Its
//   Datadog telemetry is left out: set DISABLE_TELEMETRY (or
//   CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC) to quiet the denials.
// - Codex (https://developers.openai.com/codex/auth): api.openai.com (an API
//   key), chatgpt.com (a ChatGPT login's backend) and auth.openai.com (its
//   token refresh).
// - Gemini CLI (https://geminicli.com/docs/get-started/authentication):
//   generativelanguage.googleapis.com (a Gemini API key),
//   cloudcode-pa.googleapis.com (a Google login, Code Assist) and
//   oauth2.googleapis.com (its token refresh). Vertex AI's regional hosts
//   are the user's to list.
// - Antigravity CLI: a Google login like Gemini CLI's —
//   cloudcode-pa.googleapis.com and oauth2.googleapis.com.
export const EGRESS_HOSTS: Record<string, string[]> = {
  claude: ["api.anthropic.com", "claude.ai", "platform.claude.com"],
  codex: ["api.openai.com", "chatgpt.com", "auth.openai.com"],
  gemini: ["generativelanguage.googleapis.com", "cloudcode-pa.googleapis.com", "oauth2.googleapis.com"],
  agy: ["cloudcode-pa.googleapis.com", "oauth2.googleapis.com"],
};

export const BUILTIN_ADAPTERS: Record<string, RawAdapter> = {
  codex: {
    label: "Codex CLI",
    command: [
      "codex",
      // top-level flag: `codex exec --search` is rejected, it must precede `exec`
      "--search",
      "exec",
      // exec options: events on stdout, and the final message in a file of
      // its own. The long spelling: older releases do not know `-o`.
      "--json",
      "--output-last-message",
      "{reply_file}",
      "--skip-git-repo-check",
      "{permission_args}",
      "--cd",
      "{workspace}",
      "-",
    ],
    stdin: "{prompt}",
    flags: { model: ["--model"], schema: CODEX_SCHEMA },
    output: CODEX_OUTPUT,
    permissionArgs: CODEX_PERMISSIONS,
    untrustedNote: UNTRUSTED_NOTES.codex,
    egressHosts: EGRESS_HOSTS.codex,
  },
  claude: {
    label: "Claude Code",
    // stream-json (print mode needs --verbose for it) prints an event per turn,
    // so stdout is not silent until the end, and reports usage and cost.
    command: [
      "claude",
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "{permission_args}",
      "--no-session-persistence",
    ],
    stdin: "{prompt}",
    flags: { model: ["--model"], schema: CLAUDE_SCHEMA },
    output: CLAUDE_OUTPUT,
    permissionArgs: CLAUDE_PERMISSIONS,
    untrustedArgs: CLAUDE_UNTRUSTED,
    // Anthropic's API caches a prompt's prefix: a fan-out sharing one starts
    // staggered, so the rest read the cache the first agent wrote.
    promptCache: true,
    egressHosts: EGRESS_HOSTS.claude,
  },
  gemini: {
    label: "Gemini CLI",
    command: ["gemini", "{permission_args}", "--prompt", "{prompt}"],
    flags: { model: ["--model"] },
    permissionArgs: GEMINI_PERMISSIONS,
    untrustedNote: UNTRUSTED_NOTES.gemini,
    egressHosts: EGRESS_HOSTS.gemini,
  },
  qwen: {
    label: "Qwen Code",
    command: ["qwen", "{permission_args}", "--output-format", "text", "{prompt}"],
    flags: { model: ["--model"] },
    permissionArgs: QWEN_PERMISSIONS,
    untrustedArgs: QWEN_UNTRUSTED,
  },
  kimi: {
    label: "Kimi CLI",
    command: [
      "kimi",
      "--work-dir",
      "{workspace}",
      "--print",
      "{permission_args}",
      "--input-format",
      "text",
      "--output-format",
      "text",
    ],
    stdin: "{prompt}",
    flags: { model: ["--model"] },
    permissionArgs: EDIT_ONLY(),
    untrustedNote: UNTRUSTED_NOTES.kimi,
  },
  omp: {
    label: "Oh My Pi",
    command: ["omp", "--print", "--no-session", "{permission_args}", "--cwd", "{workspace}"],
    stdin: "{prompt}",
    flags: { model: ["--model"] },
    permissionArgs: EDIT_ONLY("--approval-mode", "yolo"),
    untrustedArgs: OMP_UNTRUSTED,
    untrustedNote: UNTRUSTED_NOTES.omp,
  },
  kilo: {
    label: "Kilo Code",
    command: ["kilo", "run", "--format", "json", "{permission_args}", "--dir", "{workspace}"],
    stdin: "{prompt}",
    flags: { model: ["--model"] },
    output: KILO_OPENCODE_OUTPUT,
    permissionArgs: EDIT_ONLY("--auto"),
    untrustedNote: UNTRUSTED_NOTES.kilo,
  },
  opencode: {
    label: "OpenCode",
    command: ["opencode", "run", "--format", "json", "{permission_args}", "--dir", "{workspace}"],
    stdin: "{prompt}",
    flags: { model: ["--model"] },
    output: KILO_OPENCODE_OUTPUT,
    permissionArgs: EDIT_ONLY("--auto"),
    untrustedNote: UNTRUSTED_NOTES.opencode,
  },
  cursor: {
    label: "Cursor Agent CLI",
    command: [
      "agent",
      "--print",
      "{permission_args}",
      "--trust",
      "--output-format",
      "text",
      "--workspace",
      "{workspace}",
    ],
    stdin: "{prompt}",
    flags: { model: ["--model"] },
    permissionArgs: EDIT_ONLY("--force"),
    untrustedNote: UNTRUSTED_NOTES.cursor,
  },
  agy: {
    label: "Antigravity CLI",
    // The prompt goes on stdin: `--input-format text` (the default) "reads
    // prompts on stdin" (https://antigravity.google/docs/cli/headless, "Flag
    // reference"), and agy runs headless when stdin is a pipe, without -p
    // (changelog 1.1.2: "stdin is consumed by a piped prompt";
    // google-antigravity/antigravity-cli#1018 runs it so). Not -p: it takes
    // the next argument as its value, and argv caps one argument's length.
    // --disable-slash-commands (changelog 1.1.9) keeps a prompt that starts
    // with "/" from running a skill. --print-timeout: the docs still give it
    // a 5m default — 1.2.6 made it unlimited, and before that a run that hit
    // it returned partial output as a success (1.1.28) — so it is set past
    // any agent timeout ODW allows by default ("24h", as #1077 runs it).
    command: [
      "agy",
      "--output-format",
      "stream-json",
      "--input-format",
      "text",
      "--disable-slash-commands",
      "--print-timeout",
      "24h",
      "{permission_args}",
    ],
    stdin: "{prompt}",
    flags: { model: ["--model"], schema: AGY_SCHEMA },
    output: AGY_OUTPUT,
    permissionArgs: AGY_PERMISSIONS,
    untrustedNote: UNTRUSTED_NOTES.agy,
    egressHosts: EGRESS_HOSTS.agy,
  },
};

/** Defaults for run-wide settings; any config value overrides these. */
export const DEFAULT_SETTINGS: Settings = {
  defaultAdapter: null, // falls back to the sole adapter, or must be chosen
  concurrency: null, // null => auto (min(16, cpus - 2))
  maxAgents: 1000, // runaway guard on total dispatches per run
  timeout: 1800, // per-agent CLI timeout, seconds
  // Stall watchdog off: text-mode CLIs (gemini, qwen, …) print nothing until done.
  stallTimeout: null,
  stallRestarts: 1, // restarts of a stalled agent before its call fails
  transientRetries: 3, // retries of a rate-limited agent, with backoff
  maxBackoff: 300, // longest single backoff wait, seconds
  schemaRetries: 2, // extra attempts when a schema fails to validate
  runsRoot: null, // null => ~/.odw/runs
  workflowsRoot: null, // null => ~/.odw/workflows
  claudeWorkflowsRoot: null, // null => ~/.claude/workflows, honoring CLAUDE_CONFIG_DIR
  claudeJobsScope: "all", // observe every project's Claude runs; "project" narrows to the served repo + worktrees
  notify: null, // no run-completion hooks
  worktreeSetup: null, // nothing runs in a new isolated worktree but the agent
  worktreeSetupTimeout: 600, // seconds
  portRange: [41000, 41999], // ODW_PORT, unique among a run's running agents
  fanOutWarn: 25, // log a warning when one parallel()/pipeline() call fans out wider
  adaptiveConcurrency: true, // a rate limit halves its adapter's cap; a quiet minute gives a slot back
  staggerFanOut: { first: 1, delayMs: 2500 }, // on adapters that declare promptCache
  maxDiffBytes: 2 * 1024 * 1024, // an isolated agent's kept diff; past it, the head and a note
  keepBranches: false, // keep: true per agent still commits its change to a branch
  applyVerify: null, // odw apply runs no command after an apply (--verify still does)
  maxTranscriptBytes: 5 * 1024 * 1024, // each agent's transcript; past it, one truncation line (0: none)
  recordVersions: true, // each adapter CLI's --version, once per run, for odw compare (false: no probe)
  driftEval: false, // a run whose CLIs or models drifted only suggests its workflow's eval (true: starts it once the run ends)
  notes: false, // no notes board: agents run as written (true: every agent gets one; see src/notes.ts)
  permissions: "edit", // the tier every built-in ran with before tiers existed
  trust: "trusted", // agents read the repository's own instructions and settings (untrusted: each CLI's way of ignoring them)
  agentEnv: "inherit", // agent CLIs see ODW's whole environment
  agentEnvPass: [], // more variables a "minimal" agent environment passes through
  schemaKeywords: "warn", // what ODW's validator does not check is logged once per run, not refused
  schemaPrompt: "auto", // the prompt describes a schema only to a CLI that does not take it natively
  fallback: {}, // no fallback chains: a spent quota or a refused login fails the agent
  handoff: false, // a fallback starts the work over ("fallback": { "handoff": true } hands it over)
  models: {}, // no model tiers: model: "@<tier>" names none
  quotaBreaker: 3, // quota failures in a row before the run's later agents skip an adapter
  expectRetries: 1, // reruns of an agent whose work missed its expect checks, told what it missed
  permissionDenials: "warn", // a reply whose CLI refused tool calls stands, recorded and logged ("fail": it fails)
  mcpFailures: "warn", // an agent whose MCP server did not start keeps its reply, recorded and logged ("fail": it fails)
  orphanedBackground: "warn", // an agent that ended its turn with background work running keeps its reply, recorded and logged ("fail": it fails)
  scopePolicy: "warn", // an agent that wrote outside its declared scope keeps its reply, recorded and logged ("fail": it fails)
  redact: { env: true, patterns: true, extra: [] }, // likely secrets out of what odw keeps and serves (false: none)
  quotaWait: false, // an agent whose chain is out of quota fails; { max: <s> } waits for the reset instead
  otel: false, // no trace is sent; { endpoint?, headers?, captureContent? } posts each run's at its end
  sandbox: "none", // agent CLIs run on this machine; { kind: "container", image, … } runs each in a container
  agentLimits: {}, // no per-agent limits; { toolCalls, costUsd, outputTokens, seconds, repeat } kills a runaway agent
  approveLinks: { ttl: 86_400 }, // a checkpoint's approve/reject links (odw serve --public-url) are valid 24h
  triggers: {}, // no inbound triggers: odw serve starts no run from a webhook
  costGate: null, // no fan-out waits for a go; { usd } asks before one forecast to cost more
};
