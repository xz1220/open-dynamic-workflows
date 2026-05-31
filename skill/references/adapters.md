# Adapter reference

An **adapter** describes how to invoke one coding-agent CLI. agent-swarm shells
out to local commands; it never calls model APIs directly. Five adapters ship as
built-ins, so a fresh install can orchestrate them with no config.

## Configuration

Provide a TOML file via `--config`, or place one at `./agentswarm.toml` or
`~/.config/agentswarm/config.toml` (or point `$AGENTSWARM_CONFIG` at it). The
built-ins are always present; your file is merged on top and your entries win.

```toml
default_adapter = "claude"
concurrency = 8          # max agent CLIs at once (omit for auto)
max_agents = 1000        # hard cap on total dispatches per run
workspace_mode = "copy"  # "copy" (isolated + diff) or "inplace"
timeout = 1800           # per-agent CLI timeout, seconds
schema_retries = 2       # extra attempts when a schema fails to validate

[adapters.codex]
command = ["codex", "exec", "--cd", "{workspace}", "-"]
stdin = "{prompt}"
```

## Command placeholders

Each adapter `command` (and the optional `stdin` template) may use these tokens,
expanded per call:

| Placeholder | Meaning |
| --- | --- |
| `{prompt}` | The full composed prompt for this call. |
| `{prompt_file}` | Path to a temp file holding the prompt (created only if referenced). |
| `{workspace}` | The isolated working directory for this call. |
| `{source}` | The original source tree the workspace was copied from. |
| `{adapter}` | The adapter's config key. |
| `{role}` | The adapter's label (or its name). |

Use `stdin = "{prompt}"` when the CLI reads its prompt from stdin; otherwise pass
`{prompt}` as a command argument.

Per-adapter `timeout`, `label`, and `env` are also supported:

```toml
[adapters.codex]
command = ["codex", "exec", "--cd", "{workspace}", "-"]
stdin = "{prompt}"
timeout = 1200
label = "Codex CLI"
[adapters.codex.env]
CODEX_PROFILE = "fast"
```

## Built-in adapters

| Key | CLI | Prompt via |
| --- | --- | --- |
| `codex` | Codex CLI (`codex exec`) | stdin |
| `claude` | Claude Code (`claude --print`) | stdin |
| `gemini` | Gemini CLI | argument |
| `qwen` | Qwen Code | argument |
| `kimi` | Kimi CLI (`kimi --print`) | stdin |

These are conservative defaults. Sandbox level, model, and auth flags vary by
environment — copy the relevant entry into your config and adjust. The full set
is in `config.example.toml` at the repo root.

## Custom adapters and MCP wrappers

Any command works as long as it accepts a prompt and prints a reply. To reuse an
MCP-backed bridge, wrap it in a small local command and point an adapter at it:

```toml
[adapters.my_wrapper]
command = ["my-agent-wrapper", "--cwd", "{workspace}", "--prompt-file", "{prompt_file}"]
```

Select an adapter per call with `agent(prompt, adapter="my_wrapper")`, or make it
the default with `default_adapter = "my_wrapper"`.
