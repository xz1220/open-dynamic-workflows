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

import type { AdapterFailures, AdapterFlags, AdapterOutput, DenialPolicy, PermissionArgs, PermissionTier, SchemaFlag, Settings } from "./types.js";

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
// refused, under a reply that may claim success.
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

// One headless posture, no verified other: Kimi's print mode decides every
// tool call itself and takes no plan or approval flag with a prompt
// (https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command);
// Oh My Pi runs headless with --approval-mode yolo; `kilo/opencode run`
// with --auto; Cursor's `agent --print` with --force.
const EDIT_ONLY = (...edit: string[]): PermissionArgs => ({ edit });

export const BUILTIN_ADAPTERS: Record<string, RawAdapter> = {
  codex: {
    label: "Codex CLI",
    command: [
      "codex",
      // top-level flag: `codex exec --search` is rejected, it must precede `exec`
      "--search",
      "exec",
      "--skip-git-repo-check",
      "{permission_args}",
      "--cd",
      "{workspace}",
      "-",
    ],
    stdin: "{prompt}",
    flags: { model: ["--model"], schema: CODEX_SCHEMA },
    permissionArgs: CODEX_PERMISSIONS,
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
    // Anthropic's API caches a prompt's prefix: a fan-out sharing one starts
    // staggered, so the rest read the cache the first agent wrote.
    promptCache: true,
  },
  gemini: {
    label: "Gemini CLI",
    command: ["gemini", "{permission_args}", "--prompt", "{prompt}"],
    flags: { model: ["--model"] },
    permissionArgs: GEMINI_PERMISSIONS,
  },
  qwen: {
    label: "Qwen Code",
    command: ["qwen", "{permission_args}", "--output-format", "text", "{prompt}"],
    flags: { model: ["--model"] },
    permissionArgs: QWEN_PERMISSIONS,
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
  },
  omp: {
    label: "Oh My Pi",
    command: ["omp", "--print", "--no-session", "{permission_args}", "--cwd", "{workspace}"],
    stdin: "{prompt}",
    flags: { model: ["--model"] },
    permissionArgs: EDIT_ONLY("--approval-mode", "yolo"),
  },
  kilo: {
    label: "Kilo Code",
    command: ["kilo", "run", "--format", "json", "{permission_args}", "--dir", "{workspace}"],
    stdin: "{prompt}",
    flags: { model: ["--model"] },
    output: KILO_OPENCODE_OUTPUT,
    permissionArgs: EDIT_ONLY("--auto"),
  },
  opencode: {
    label: "OpenCode",
    command: ["opencode", "run", "--format", "json", "{permission_args}", "--dir", "{workspace}"],
    stdin: "{prompt}",
    flags: { model: ["--model"] },
    output: KILO_OPENCODE_OUTPUT,
    permissionArgs: EDIT_ONLY("--auto"),
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
  maxTranscriptBytes: 5 * 1024 * 1024, // each agent's transcript; past it, one truncation line (0: none)
  permissions: "edit", // the tier every built-in ran with before tiers existed
  agentEnv: "inherit", // agent CLIs see ODW's whole environment
  agentEnvPass: [], // more variables a "minimal" agent environment passes through
  schemaKeywords: "warn", // what ODW's validator does not check is logged once per run, not refused
  schemaPrompt: "auto", // the prompt describes a schema only to a CLI that does not take it natively
  fallback: {}, // no fallback chains: a spent quota or a refused login fails the agent
  models: {}, // no model tiers: model: "@<tier>" names none
  quotaBreaker: 3, // quota failures in a row before the run's later agents skip an adapter
  expectRetries: 1, // reruns of an agent whose work missed its expect checks, told what it missed
  permissionDenials: "warn", // a reply whose CLI refused tool calls stands, recorded and logged ("fail": it fails)
};
