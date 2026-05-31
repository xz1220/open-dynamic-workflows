"""Built-in adapter templates and default run settings.

These mirror the non-interactive invocation each coding-agent CLI supports, so
a fresh install can orchestrate common agents with no config file. Users
override or extend them in their own config; user entries always win.

The command templates are intentionally conservative. Sandboxing, model
selection and auth flags differ per environment, so the references doc explains
how to tune them rather than baking opinions in here.
"""

from __future__ import annotations

from typing import Any

# name -> raw adapter mapping (same shape the TOML config produces).
BUILTIN_ADAPTERS: dict[str, dict[str, Any]] = {
    "codex": {
        "label": "Codex CLI",
        "command": [
            "codex",
            "exec",
            "--skip-git-repo-check",
            "--sandbox",
            "workspace-write",
            "--cd",
            "{workspace}",
            "-",
        ],
        "stdin": "{prompt}",
    },
    "claude": {
        "label": "Claude Code",
        "command": [
            "claude",
            "--print",
            "--permission-mode",
            "acceptEdits",
            "--no-session-persistence",
        ],
        "stdin": "{prompt}",
    },
    "gemini": {
        "label": "Gemini CLI",
        "command": ["gemini", "--approval-mode", "auto_edit", "{prompt}"],
    },
    "qwen": {
        "label": "Qwen Code",
        "command": [
            "qwen",
            "--approval-mode",
            "auto-edit",
            "--output-format",
            "text",
            "{prompt}",
        ],
    },
    "kimi": {
        "label": "Kimi CLI",
        "command": [
            "kimi",
            "--work-dir",
            "{workspace}",
            "--print",
            "--input-format",
            "text",
            "--output-format",
            "text",
        ],
        "stdin": "{prompt}",
    },
}

# Defaults for run-wide settings; any config file value overrides these.
DEFAULT_SETTINGS: dict[str, Any] = {
    "default_adapter": None,  # falls back to the sole adapter, or must be chosen
    "concurrency": None,  # None -> auto (see Settings.resolved_concurrency)
    "max_agents": 1000,  # runaway guard on total dispatches per run
    "workspace_mode": "copy",  # "copy" (isolated) or "inplace"
    "timeout": 1800.0,  # per-agent CLI timeout, seconds
    "schema_retries": 2,  # extra attempts when a schema fails to validate
    "runs_root": None,  # None -> ~/.agentswarm/runs
}
