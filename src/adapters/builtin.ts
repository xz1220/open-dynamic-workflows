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

import type { AdapterFailures, AdapterFlags, AdapterOutput, Settings } from "./types.js";

/** A built-in adapter spec — same shape as a config entry, minus its name. */
export interface RawAdapter {
  command: string[];
  stdin?: string;
  env?: Record<string, string>;
  timeout?: number;
  stallTimeout?: number;
  label?: string;
  flags?: AdapterFlags;
  output?: AdapterOutput;
  failures?: AdapterFailures;
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
// and logins arrive that way, often with exit 0.
const CLAUDE_OUTPUT: AdapterOutput = {
  format: "jsonl",
  eventType: "result",
  textPath: ["result"],
  select: "last",
  usagePath: ["usage"],
  costPath: ["total_cost_usd"],
  errorPath: ["is_error"],
};
export const BUILTIN_ADAPTERS: Record<string, RawAdapter> = {
  codex: {
    label: "Codex CLI",
    command: [
      "codex",
      // top-level flag: `codex exec --search` is rejected, it must precede `exec`
      "--search",
      "exec",
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write",
      "--cd",
      "{workspace}",
      "-",
    ],
    stdin: "{prompt}",
    flags: { model: ["--model"] },
  },
  claude: {
    label: "Claude Code",
    // headless acceptEdits silently DENIES WebSearch/WebFetch unless allowlisted,
    // which breaks research workflows (e.g. examples/deep-research.js).
    // stream-json (print mode needs --verbose for it) prints an event per turn,
    // so stdout is not silent until the end, and reports usage and cost.
    command: [
      "claude",
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "WebSearch",
      "WebFetch",
      "--no-session-persistence",
    ],
    stdin: "{prompt}",
    flags: { model: ["--model"] },
    output: CLAUDE_OUTPUT,
  },
  gemini: {
    label: "Gemini CLI",
    command: ["gemini", "--approval-mode", "auto_edit", "--prompt", "{prompt}"],
    flags: { model: ["--model"] },
  },
  qwen: {
    label: "Qwen Code",
    command: ["qwen", "--approval-mode", "auto-edit", "--output-format", "text", "{prompt}"],
    flags: { model: ["--model"] },
  },
  kimi: {
    label: "Kimi CLI",
    command: [
      "kimi",
      "--work-dir",
      "{workspace}",
      "--print",
      "--input-format",
      "text",
      "--output-format",
      "text",
    ],
    stdin: "{prompt}",
    flags: { model: ["--model"] },
  },
  omp: {
    label: "Oh My Pi",
    command: ["omp", "--print", "--no-session", "--approval-mode", "yolo", "--cwd", "{workspace}"],
    stdin: "{prompt}",
    flags: { model: ["--model"] },
  },
  kilo: {
    label: "Kilo Code",
    command: ["kilo", "run", "--format", "json", "--auto", "--dir", "{workspace}"],
    stdin: "{prompt}",
    flags: { model: ["--model"] },
    output: KILO_OPENCODE_OUTPUT,
  },
  opencode: {
    label: "OpenCode",
    command: ["opencode", "run", "--format", "json", "--auto", "--dir", "{workspace}"],
    stdin: "{prompt}",
    flags: { model: ["--model"] },
    output: KILO_OPENCODE_OUTPUT,
  },
  cursor: {
    label: "Cursor Agent CLI",
    command: [
      "agent",
      "--print",
      "--force",
      "--trust",
      "--output-format",
      "text",
      "--workspace",
      "{workspace}",
    ],
    stdin: "{prompt}",
    flags: { model: ["--model"] },
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
  maxDiffBytes: 2 * 1024 * 1024, // an isolated agent's kept diff; past it, the head and a note
  keepBranches: false, // keep: true per agent still commits its change to a branch
  maxTranscriptBytes: 5 * 1024 * 1024, // each agent's transcript; past it, one truncation line (0: none)
};
