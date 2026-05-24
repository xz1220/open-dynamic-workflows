<div align="center">

# Agent Swarm

> 把同一个开发问题并发分发给多个 coding agent，收集原始输出，交给主 agent 综合判断。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![AgentSkills](https://img.shields.io/badge/AgentSkills-Standard-green)](https://agentskills.io)
[![Python](https://img.shields.io/badge/Python-3.9%2B-blue)](https://www.python.org/)

<br>

Codex、Claude Code、Gemini CLI 各有盲区？<br>
想让它们独立 plan、execute、review，但不想要自动投票？<br>
需要把所有原始意见摆到主 agent 面前再判断？

**用这个 skill 做并发分发 + 原始收集，不在 skill 内做共识、投票或自动落盘。**

[安装](#安装) · [使用](#使用) · [效果示例](#效果示例) · [配置](#配置) · [开发与校验](#开发与校验)

</div>

---

## 它能做什么

| 动作 | 说明 |
|------|------|
| **1. Plan** | 给一个问题描述，让多个 agent 独立产出方案或设计。 |
| **2. Execute** | 给一个明确任务，让多个 agent 在各自临时工作区独立尝试实现，并返回 stdout / stderr / diff。 |
| **3. Review** | 给一段产物、设计或 patch，让多个 agent 独立给 review 意见。 |

核心边界：这个 skill 只分发和收集，不做投票、不做多轮 debate、不自动改主工作区文件。

---

## 安装

### 让 Agent 自动安装

把这段话发给你正在使用的 Coding Agent：

```text
请安装这个 Agent Skill：https://github.com/xz1220/agent-swarm。

这个仓库本身就是 skill 根目录。请把它 clone 到当前 Agent 的 skills 目录并命名为 `agent-swarm`，确保安装后是 `agent-swarm/SKILL.md`。装完后运行 `python3 scripts/agent_swarm.py --help` 验证，并提醒我配置默认 agents。
```

### 手动安装

```bash
git clone https://github.com/xz1220/agent-swarm.git \
  "${CODEX_HOME:-$HOME/.codex}/skills/agent-swarm"
```

Claude Code：

```bash
mkdir -p "$HOME/.claude/skills"
git clone https://github.com/xz1220/agent-swarm.git \
  "$HOME/.claude/skills/agent-swarm"
```

可选安装 CLI：

```bash
cd /path/to/agent-swarm
python3 -m pip install -e .
```

安装 CLI 后，shell 入口是 `agent-swarm plan|execute|review`。包内也提供
`agent-swarm-plan`、`agent-swarm-execute`、`agent-swarm-review` 这几个可选
shell shortcut；它们不是 Agent Skill 名称。Agent Skill 只有 `$agent-swarm`。

---

## 使用

### Plan

```text
请使用 $agent-swarm plan：
为这个迁移任务设计方案：...
```

等价脚本命令：

```bash
python3 scripts/agent_swarm.py plan --task "为这个迁移任务设计方案：..."
```

### Execute

```text
请使用 $agent-swarm execute：
实现这个明确任务：...
```

脚本会给每个 agent 建一个临时工作区副本。agent 可以在副本里改文件，脚本只返回 diff，不会把改动写回你的主仓库。

```bash
python3 scripts/agent_swarm.py execute --task "实现这个明确任务：..."
```

### Review

```text
请使用 $agent-swarm review 这个 patch，重点看并发和错误处理：
path/to/changes.patch
```

```bash
python3 scripts/agent_swarm.py review \
  --artifact path/to/changes.patch \
  --task "重点看并发和错误处理"
```

单次覆盖 agents：

```bash
python3 scripts/agent_swarm.py plan --agents codex,claude --task "..."
```

如果你没有安装 Gemini CLI，把配置里的 `default_agents` 改成
`["codex", "claude"]`，或单次运行时传 `--agents codex,claude`。

---

## 效果示例

**没用 agent-swarm**：

```text
主 agent：我会给出一个方案，并自行判断风险。
```

**使用 agent-swarm**：

```text
# agent-swarm plan

## Agent: codex
原始方案...

## Agent: claude
原始方案...

## Agent: gemini
原始方案...
```

随后主 agent 再基于这些原始输出做综合判断。

---

## 配置

默认查找顺序：

1. `--config <path>`
2. `$AGENT_SWARM_CONFIG`
3. 当前目录 `agent-swarm.toml`
4. `~/.config/agent-swarm/config.toml`
5. 内置 `codex` / `claude` / `gemini` 适配示例

复制示例配置：

```bash
mkdir -p "$HOME/.config/agent-swarm"
cp config.example.toml "$HOME/.config/agent-swarm/config.toml"
```

配置文件里通过 `default_agents` 设置默认 agent；单次调用用 `--agents codex,claude` 覆盖。

底层不重造 harness。它只调用你配置好的本地命令，例如 `codex exec`、`claude --print`、`gemini`、`codex-mcp-server` 或 `claude-code-mcp` wrapper。更多例子见 [`references/adapters.md`](references/adapters.md)。

---

## 项目结构

```text
agent-swarm/
├── SKILL.md
├── README.md
├── config.example.toml
├── references/
│   └── adapters.md
├── scripts/
│   ├── agent_swarm.py
│   └── agent_swarm/
├── tests/
├── pyproject.toml
└── LICENSE
```

---

## 开发与校验

```bash
python3 scripts/agent_swarm.py --help
python3 -m pytest
python3 /path/to/skill-creator/scripts/quick_validate.py .
```

本仓库的测试使用 mock agent 命令验证并发收集、agent 覆盖和 Execute 临时工作区隔离，不依赖真实 Claude / Codex / Gemini 账号。

---

## License

MIT
