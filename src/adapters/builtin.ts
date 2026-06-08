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

import type { AdapterFlags, Settings } from "./types.js";

/** A built-in adapter spec — same shape as a config entry, minus its name. */
export interface RawAdapter {
  command: string[];
  stdin?: string;
  env?: Record<string, string>;
  timeout?: number;
  label?: string;
  flags?: AdapterFlags;
}

// `flags` only DECLARES which native flag carries a model — the router appends
// it (with a value) when a call sets `model`, and otherwise leaves the command
// untouched. Templates stay conservative: no `{model}` baked in, no value forced.
// Model ids do not cross CLIs (e.g. `claude-opus-4-8` is invalid to codex), so a
// model is honoured per-CLI, not normalised across them.
export const BUILTIN_ADAPTERS: Record<string, RawAdapter> = {
  codex: {
    label: "Codex CLI",
    command: [
      "codex",
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
    command: ["claude", "--print", "--permission-mode", "acceptEdits", "--no-session-persistence"],
    stdin: "{prompt}",
    flags: { model: ["--model"] },
  },
  gemini: {
    label: "Gemini CLI",
    command: ["gemini", "--approval-mode", "auto_edit", "{prompt}"],
    flags: { model: ["--model"] },
  },
  qwen: {
    label: "Qwen Code",
    command: ["qwen", "--approval-mode", "auto-edit", "--output-format", "text", "{prompt}"],
    flags: { model: ["--model"] },
  },
  kimi: {
    // kimi's `--model` expects an alias pre-declared in its config.toml, so the
    // value is forwarded syntactically but may need that alias to resolve.
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
};

/** Defaults for run-wide settings; any config value overrides these. */
export const DEFAULT_SETTINGS: Settings = {
  defaultAdapter: null, // falls back to the sole adapter, or must be chosen
  concurrency: null, // null => auto (min(16, cpus - 2))
  maxAgents: 1000, // runaway guard on total dispatches per run
  workspaceMode: "copy", // "copy" (isolated) or "inplace"
  timeout: 1800, // per-agent CLI timeout, seconds
  schemaRetries: 2, // extra attempts when a schema fails to validate
  runsRoot: null, // null => ~/.odw/runs
  workflowsRoot: null, // null => ~/.odw/workflows
  claudeWorkflowsRoot: null, // null => ~/.claude/workflows, honoring CLAUDE_CONFIG_DIR
  claudeJobsScope: "all", // observe every project's Claude runs; "project" narrows to the served repo + worktrees
};
