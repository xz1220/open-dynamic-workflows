---
name: agent-swarm
description: Dispatch one Plan, Execute, or Review request to multiple independent coding agents such as Codex CLI, Claude Code, Gemini CLI, Qwen Code, Kimi CLI, or MCP-backed wrappers, then return their raw outputs to the main agent. Use when the user explicitly invokes $agent-swarm for multi-agent planning, implementation attempts, or review. Treat plan, execute, and review as actions, not separate skills.
license: MIT. See LICENSE for full terms.
---

# Agent Swarm

Use this skill only when the user manually invokes `$agent-swarm`. It dispatches one task to configured agent commands in parallel and collects raw outputs. The main agent decides what to do with the results.

This skill is not a voting system, debate loop, consensus engine, or autonomous file editor.

## Actions

| User prompt | Action | Script command |
| --- | --- | --- |
| `$agent-swarm plan` | Ask each agent for an independent plan or design. | `python3 scripts/agent_swarm.py plan --task "..."`
| `$agent-swarm execute` | Ask each agent to independently attempt a concrete implementation in an isolated workspace copy. | `python3 scripts/agent_swarm.py execute --task "..."`
| `$agent-swarm review` | Ask each agent to independently review an artifact, patch, design, or code. | `python3 scripts/agent_swarm.py review --artifact path --task "..."`

`$agent-swarm` is the only Agent Skill entry point. Do not treat plan, execute, or review as separate skills.

## Workflow

1. Locate the installed skill directory:
   - Prefer `$AGENT_SWARM_SKILL_DIR` when set.
   - Otherwise use the directory containing this `SKILL.md`.
2. Choose the action:
   - Plan: problem statement in `--task`.
   - Execute: explicit implementation task in `--task`.
   - Review: review focus in `--task` plus one or more `--artifact` files when available.
3. Load configuration:
   - Prefer `--config <path>`.
   - Then `$AGENT_SWARM_CONFIG`.
   - Then `./agent-swarm.toml`.
   - Then `~/.config/agent-swarm/config.toml`.
   - If no config exists, built-in `codex`, `claude`, `gemini`, `qwen`, and `kimi` command adapters are available.
4. Run the script from the skill directory:
   ```bash
   python3 scripts/agent_swarm.py plan --task "Design the migration."
   python3 scripts/agent_swarm.py execute --task "Implement the parser."
   python3 scripts/agent_swarm.py review --artifact changes.patch --task "Find correctness risks."
   ```
5. Paste the full script output back into the conversation before synthesizing. The script output is the collected evidence.

## Configuration

Users can set default agents in TOML:

```toml
default_agents = ["codex", "claude", "gemini", "qwen", "kimi"]

[agents.codex]
command = ["codex", "exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "--cd", "{workspace}", "-"]
stdin = "{prompt}"

[agents.claude]
command = ["claude", "--print", "--permission-mode", "acceptEdits", "--no-session-persistence"]
stdin = "{prompt}"

[agents.gemini]
command = ["gemini", "--approval-mode", "auto_edit", "{prompt}"]

[agents.qwen]
command = ["qwen", "--approval-mode", "auto-edit", "--output-format", "text", "{prompt}"]

[agents.kimi]
command = ["kimi", "--work-dir", "{workspace}", "--print", "--input-format", "text", "--output-format", "text"]
stdin = "{prompt}"
```

Single-call overrides:

```bash
python3 scripts/agent_swarm.py plan --agents codex,claude --task "..."
```

If Gemini, Qwen, or Kimi CLI is not installed, set `default_agents` to the
agents you have locally, or pass `--agents codex,claude`.

Read `config.example.toml` and `references/adapters.md` when adding MCP wrappers such as `codex-mcp-server` or `claude-code-mcp`.

## Invariants

- Keep agents independent. Do not show one agent another agent's draft.
- Do not run multi-round debate.
- Do not summarize, rank, vote, or merge inside the skill.
- Return raw stdout, stderr, status, and collected diffs for each agent.
- Execute runs in a temporary workspace copy by default. The caller's working tree is not modified by the script.
- The main agent may synthesize after raw outputs are visible in context.

## Output Rules

- Present the collected results under each agent's name.
- Preserve raw output blocks. If later synthesis is needed, place it after the raw blocks.
- Mention any failed, timed-out, or missing-agent command as a per-agent result rather than hiding it.
- Do not commit, push, or apply an agent's diff automatically.

## Resources

- `scripts/agent_swarm.py`: CLI entry point.
- `scripts/agent_swarm/`: implementation package.
- `config.example.toml`: default adapter examples.
- `references/adapters.md`: notes for Codex CLI, Claude Code, Gemini CLI, Qwen Code, Kimi CLI, and MCP-backed wrappers.
