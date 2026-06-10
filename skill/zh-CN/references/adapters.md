# 适配器与配置

<sub>[English](../../references/adapters.md) · 简体中文</sub>

**适配器**是 `odw` 调用某个 coding-agent CLI 的方式。`odw` 绝不直接调用模型 API——它只是
shell 出去执行一个本地命令，通过 stdin 或一个参数把拼好的 prompt 传进去，再从 stdout 读
回复。

## 内置适配器

五个开箱即用、无需配置文件：`codex`、`claude`、`gemini`、`qwen`、`kimi`。它们用各自 CLI
的非交互模式。

### 权限：每个内置适配器能做什么

命令模板刻意保守，而且内置适配器之间**权限并不相同**：

- `codex` 以 `--sandbox workspace-write` 运行：开箱即可在其工作区内**编辑文件并执行
  命令**。
- `claude` 以 `--permission-mode acceptEdits` 运行：**能编辑文件但不能执行命令**
  （要求它运行什么的 prompt 会卡住或被拒绝）。要让 Claude 也能跑命令，用
  `--dangerously-skip-permissions` 覆盖该适配器——它**没有任何沙箱**，所以只能对着一个
  用完即弃的 `--source` 目录这么干，绝不要指向你的真实仓库：

```json
{
  "adapters": {
    "claude": {
      "command": ["claude", "--print", "--dangerously-skip-permissions", "--no-session-persistence"],
      "stdin": "{prompt}"
    }
  }
}
```

一种实用的最小权限分工：让 `claude` 写代码（acceptEdits）、让 `codex` 运行/验证
（workspace-write 沙箱）——见 `examples/codex-claude-loop.js`。

## 配置文件

要改默认、调参，或加自己的 CLI，写一个 `odw.config.json`。它按优先级从高到低被发现：

1. 显式的 `--config <path>`
2. `$ODW_CONFIG`
3. `./odw.config.json`
4. `~/.config/odw/config.json`

用户文件会合并覆盖在内置之上，所以你只需写你要改的部分。

```json
{
  "defaultAdapter": "claude",
  "concurrency": 8,
  "maxAgents": 1000,
  "workspaceMode": "copy",
  "timeout": 1800,
  "schemaRetries": 2,
  "runsRoot": "~/.odw/runs",

  "adapters": {
    "my_wrapper": {
      "label": "My custom CLI",
      "command": ["my-agent", "--cwd", "{workspace}", "--prompt-file", "{prompt_file}"],
      "env": { "MY_FLAG": "1" },
      "timeout": 600,
      "flags": { "model": ["--model"] }
    }
  }
}
```

所有设置项都是**顶层键**——不要嵌套在 `"settings"` 包装层下。odw 会对未知或放错位置
的键在 stderr 上给出警告（附 did-you-mean 提示），而不是静默忽略。

### 设置项

| 键 | 含义 |
| --- | --- |
| `defaultAdapter` | 一次调用没指名适配器时用的适配器。未设置时：用唯一配置的那个，或——全新安装下——用 PATH 上唯一真实存在的那个 CLI |
| `concurrency` | 同时运行的 agent CLI 上限；省略则自动（`min(16, cpus-2)`） |
| `maxAgents` | 单次运行总派发量的硬上限（防失控兜底） |
| `workspaceMode` | `"copy"`（隔离工作树 + diff；安全的默认值）或 `"inplace"`（agent 直接在真实目录里工作——没有隔离、没有 diff；只在想要就地修改时使用） |
| `timeout` | 每个 agent CLI 的超时（秒） |
| `schemaRetries` | schema 校验失败时的额外重试次数 |
| `runsRoot` | run 的存放位置（默认 `~/.odw/runs`） |
| `workflowsRoot` | 按名字解析 workflow 的目录（默认 `~/.odw/workflows`） |
| `claudeWorkflowsRoot` | 读取 Claude Code 已保存 workflow 的目录（默认 `~/.claude/workflows`，遵循 `CLAUDE_CONFIG_DIR`） |
| `claudeJobsScope` | dashboard 显示哪些 Claude Code 运行：`"all"`（默认）或 `"project"` |

### 适配器字段

| 字段 | 含义 |
| --- | --- |
| `command` | 参数向量；`{placeholder}` 占位符每次调用时展开（必填） |
| `stdin` | 喂给进程 stdin 的可选模板（如 `"{prompt}"`） |
| `env` | 叠加在进程环境之上的额外环境变量 |
| `timeout` | 每次调用的超时（秒）（覆盖运行级的 `timeout`） |
| `label` | 进度显示用的友好名字 |
| `flags` | 能力声明，如 `{ "model": ["--model"] }`——承载每次调用 `model` 的原生旗标。不声明它，`agent(..., { model })` 对该适配器就不生效（日志里会出现一条路由说明） |

### 占位符

每次调用前在 `command` 和 `stdin` 里展开：

| 占位符 | 值 |
| --- | --- |
| `{prompt}` | 完整拼好的 prompt（独立性引导语 + 任务 + 任何 schema 指令） |
| `{prompt_file}` | 存放 prompt 的临时文件路径（仅在被引用时才写） |
| `{workspace}` | agent 运行所在的目录（`copy` 模式下是一个隔离副本） |
| `{source}` | 原始的工作树 |
| `{adapter}` / `{role}` | 适配器的名字 / 标签 |

只要一个 CLI 能读取 prompt（经 stdin 或一个参数）并把回复打印到 stdout，它就能接入。非零
退出、超时，或可执行文件缺失，都会表现为一次失败的 agent 调用。
