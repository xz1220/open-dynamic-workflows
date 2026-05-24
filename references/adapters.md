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

## codex-plugin-cc

`openai/codex-plugin-cc` is a Claude Code plugin. It is useful when Claude Code is the host and Codex is the delegated reviewer or worker. Agent Swarm is host-neutral, so it does not invoke Claude slash commands directly. If you want to reuse that plugin path, wrap the relevant Claude Code command in a script and configure it as an agent.

## codex-mcp-server

`tuannvm/codex-mcp-server` exposes Codex CLI through MCP. Keep using that server from the host that already supports MCP. For Agent Swarm, configure a thin local command that calls your MCP client or existing wrapper; do not duplicate the server.

## claude-code-mcp

`steipete/claude-code-mcp` exposes Claude Code as a one-shot MCP server. Configure your MCP client or local wrapper as an Agent Swarm command when the current host cannot call Claude Code directly.
