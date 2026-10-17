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
  命令**。它还带着 `--search`，可以**原生搜索网页**。
- `claude` 以 `--permission-mode acceptEdits` 加 `--allowedTools WebSearch WebFetch`
  运行：**能编辑文件、能用网页工具，但不能执行命令**（要求它运行什么的 prompt 会卡住
  或被拒绝）。网页白名单很关键：headless 的 acceptEdits 否则会静默拒绝
  WebSearch/WebFetch，`examples/deep-research.js` 这类调研 workflow 会直接跑不通。要让 Claude 也能跑命令，用
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
| `timeout` | 每个 agent CLI 的超时（秒） |
| `stallTimeout` | **ODW 扩展。** agent 在 stdout 和 stderr 上都没有任何输出的最长秒数，超过即像超时一样被杀掉，并用同一个 prompt 重启；`null`（默认）= 关闭。所有内置适配器都默认关闭，因为有些 CLI（文本模式的 `claude --print`）在结束前什么都不输出——请只对会流式输出进度的适配器启用 |
| `stallRestarts` | 每次 `agent()` 调用在卡死后最多重启几次，用完后调用以 “stalled” 错误失败（默认 1） |
| `schemaRetries` | schema 校验失败时的额外重试次数 |
| `runsRoot` | run 的存放位置（默认 `~/.odw/runs`） |
| `workflowsRoot` | 按名字解析 workflow 的目录（默认 `~/.odw/workflows`） |
| `claudeWorkflowsRoot` | 读取 Claude Code 已保存 workflow 的目录（默认 `~/.claude/workflows`，遵循 `CLAUDE_CONFIG_DIR`） |
| `claudeJobsScope` | dashboard 显示哪些 Claude Code 运行：`"all"`（默认）或 `"project"` |
| `notify` | **ODW 扩展。** 运行结束时的 hook：`{ "command": [argv], "webhook": "https://…", "on": ["done", "failed", "stopped"] }`——见下文 |
| `worktreeSetup` | **ODW 扩展。** 在每个新建的隔离 worktree 里、`.worktreeinclude` 生效之后、agent 启动之前运行的命令：字符串交给平台 shell，数组作为不经 shell 的 argv。它在 agent 的工作区里运行，带着该 agent 的 `ODW_RUN_ID`、`ODW_AGENT_ID` 和 `ODW_PORT`；失败或超时会让这个 agent（而不是整个运行）失败，错误里引用它输出的结尾。`null`（默认）= 不运行 |
| `worktreeSetupTimeout` | worktree setup 被杀掉之前最多运行的秒数（默认 600） |
| `portRange` | **ODW 扩展。** `[first, last]`：每个正在运行的 agent 的 `ODW_PORT` 从这个范围分配（默认 `[41000, 41999]`）；请让它比 `concurrency` 更宽 |

### 适配器字段

| 字段 | 含义 |
| --- | --- |
| `command` | 参数向量；`{placeholder}` 占位符每次调用时展开（必填） |
| `stdin` | 喂给进程 stdin 的可选模板（如 `"{prompt}"`） |
| `env` | 叠加在进程环境之上的额外环境变量（ODW 自己的 `ODW_RUN_ID`、`ODW_AGENT_ID` 和 `ODW_PORT` 优先于它们） |
| `timeout` | 每次调用的超时（秒）（覆盖运行级的 `timeout`） |
| `stallTimeout` | 这个 CLI 的卡死超时（秒）（覆盖运行级的 `stallTimeout`；`0` 表示对该适配器关闭看门狗） |
| `label` | 进度显示用的友好名字 |
| `flags` | 能力声明，如 `{ "model": ["--model"] }`——承载每次调用 `model` 的原生旗标。不声明它，`agent(..., { model })` 对该适配器就不生效（日志里会出现一条路由说明） |

### 运行通知（`notify`）

每次运行在终态写入之后触发一次 hook，所以 hook 既不会拖延、也不会改变终态；失败或卡住的
hook 只会记录到该运行的 `worker.log`。

- `command`——一个**不经过** shell 执行的参数向量（30 秒后被杀），在运行的源目录里执行，
  环境变量里带有 `ODW_RUN_ID`、`ODW_RUN_STATE`、`ODW_WORKFLOW`、`ODW_RUN_DIR`、
  `ODW_RESULT_FILE`（仅当运行有结果时）、`ODW_DURATION_SEC`、`ODW_AGENTS` 和
  `ODW_FAILED_AGENTS`。
- `webhook`——一个 http(s) URL，接收一个 JSON POST（10 秒时限）：
  `{ runId, workflow, state, createdAt, finishedAt, durationSec,
  counts: { agents, done, failed }, error?, text, content }`。`text` 和 `content`
  是同一行摘要（“odw · deep-research finished in 4m12s · 12 agents, 1 failed”），
  所以 Slack 和 Discord 的 incoming webhook 能直接渲染。
- `on`——哪些终态会触发 hook（默认：全部三种）。

### 占位符

每次调用前在 `command` 和 `stdin` 里展开：

| 占位符 | 值 |
| --- | --- |
| `{prompt}` | 完整拼好的 prompt（独立性引导语 + 任务 + 任何 schema 指令） |
| `{prompt_file}` | 存放 prompt 的临时文件路径（仅在被引用时才写） |
| `{workspace}` | agent 运行所在的目录（隔离时是它的 git worktree） |
| `{source}` | 原始的工作树 |
| `{adapter}` / `{role}` | 适配器的名字 / 标签 |

只要一个 CLI 能读取 prompt（经 stdin 或一个参数）并把回复打印到 stdout，它就能接入。非零
退出、超时，或可执行文件缺失，都会表现为一次失败的 agent 调用。
