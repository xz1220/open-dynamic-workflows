# Adapter Notes

Agent Swarm delegates to existing local harnesses. It does not call LLM APIs directly and does not reimplement MCP bridges.

## Command Placeholders

Every configured command may use these placeholders:

| Placeholder | Meaning |
| --- | --- |
| `{prompt}` | Full generated prompt for this agent and action. |
| `{prompt_file}` | Path to a temporary file containing the prompt. |
| `{workspace}` | Isolated workspace path for this agent. |
| `{source}` | Original source workspace path. |
| `{action}` | `plan`, `execute`, or `review`. |
| `{agent}` | Agent key from the config. |

Use `stdin = "{prompt}"` when the harness supports prompt input on stdin.

## Codex CLI

Codex CLI supports non-interactive execution with `codex exec`. A safe default is:

```toml
[agents.codex]
command = ["codex", "exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "--cd", "{workspace}", "-"]
stdin = "{prompt}"
```

The workspace is already a temporary copy, so `workspace-write` is acceptable for Execute. If you only want read-only Plan or Review adapters, create a second config entry with `--sandbox read-only`.

## Claude Code

Claude Code supports non-interactive output with `claude --print`:

```toml
[agents.claude]
command = ["claude", "--print", "--permission-mode", "acceptEdits", "--no-session-persistence"]
stdin = "{prompt}"
```

For heavily locked-down use, configure `--tools ""` or a stricter `--permission-mode`. For MCP-based Claude delegation, prefer an existing wrapper such as `steipete/claude-code-mcp` and point a custom command at that wrapper.

## Gemini CLI

Gemini CLI supports one-shot prompts:

```toml
[agents.gemini]
command = ["gemini", "--approval-mode", "auto_edit", "{prompt}"]
```

If your Gemini setup requires sandboxing or extension controls, add those flags in this command list.

## Qwen Code

Qwen Code supports non-interactive prompts through a positional prompt or `-p/--prompt`.
The built-in adapter uses the positional form:

```toml
[agents.qwen]
command = ["qwen", "--approval-mode", "auto-edit", "--output-format", "text", "{prompt}"]
```

The agent runs with the temporary workspace as its current working directory. If your
Qwen setup needs a specific model or auth type, add flags such as `--model` or
`--auth-type` to the command list.

## Kimi CLI

Kimi CLI supports print mode for non-interactive runs. Use stdin for the generated
prompt so large tasks do not need to fit in one shell argument:

```toml
[agents.kimi]
command = ["kimi", "--work-dir", "{workspace}", "--print", "--input-format", "text", "--output-format", "text"]
stdin = "{prompt}"
```

`--print` currently implies automatic approval in Kimi CLI. Agent Swarm still runs
each agent in a temporary workspace copy by default and collects the resulting diff.

## codex-plugin-cc

`openai/codex-plugin-cc` is a Claude Code plugin. It is useful when Claude Code is the host and Codex is the delegated reviewer or worker. Agent Swarm is host-neutral, so it does not invoke Claude slash commands directly. If you want to reuse that plugin path, wrap the relevant Claude Code command in a script and configure it as an agent.

## codex-mcp-server

`tuannvm/codex-mcp-server` exposes Codex CLI through MCP. Keep using that server from the host that already supports MCP. For Agent Swarm, configure a thin local command that calls your MCP client or existing wrapper; do not duplicate the server.

## claude-code-mcp

`steipete/claude-code-mcp` exposes Claude Code as a one-shot MCP server. Configure your MCP client or local wrapper as an Agent Swarm command when the current host cannot call Claude Code directly.
