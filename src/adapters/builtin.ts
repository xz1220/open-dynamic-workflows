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

import type { Settings } from "./types.js";

/** A built-in adapter spec — same shape as a config entry, minus its name. */
export interface RawAdapter {
  command: string[];
  stdin?: string;
  env?: Record<string, string>;
  timeout?: number;
  label?: string;
}

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
  },
  claude: {
    label: "Claude Code",
    command: ["claude", "--print", "--permission-mode", "acceptEdits", "--no-session-persistence"],
    stdin: "{prompt}",
  },
  gemini: {
    label: "Gemini CLI",
    command: ["gemini", "--approval-mode", "auto_edit", "{prompt}"],
  },
  qwen: {
    label: "Qwen Code",
    command: ["qwen", "--approval-mode", "auto-edit", "--output-format", "text", "{prompt}"],
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
};
