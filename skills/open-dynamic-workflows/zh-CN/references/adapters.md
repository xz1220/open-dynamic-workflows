# 适配器与配置

<sub>[English](../../references/adapters.md) · 简体中文</sub>

**适配器**是 `odw` 调用某个 coding-agent CLI 的方式。`odw` 绝不直接调用模型 API——它只是
shell 出去执行一个本地命令，通过 stdin 或一个参数把拼好的 prompt 传进去，再从 stdout 读
回复。

## 内置适配器

五个开箱即用、无需配置文件：`codex`、`claude`、`gemini`、`qwen`、`kimi`。它们用各自 CLI
的非交互模式。

### 权限：每个内置适配器能做什么

命令模板刻意保守，而且内置适配器之间**权限并不相同**。每个 agent 都在一个**权限档位**下
运行（ODW 扩展）：`read`、`edit`（默认）或 `full`——运行的档位来自配置里的
`"permissions"` 或 `odw run|rerun|resume --permissions <档位>`，适配器自己的
`"permissions"` 和 `agent()` 调用的 `permissions` 只能降低它。在默认的 `edit` 档位下：

- `codex` 以 `--sandbox workspace-write` 运行：开箱即可在其工作区内**编辑文件并执行
  命令**。它还带着 `--search`，可以**原生搜索网页**。
- `claude` 以 `--permission-mode acceptEdits` 加 `--allowedTools WebSearch WebFetch`
  运行：**能编辑文件、能用网页工具，但不能执行命令**（要求它运行什么的 prompt 会卡住
  或被拒绝）。网页白名单很关键：headless 的 acceptEdits 否则会静默拒绝
  WebSearch/WebFetch，`examples/deep-research.js` 这类调研 workflow 会直接跑不通。要让 Claude 也能跑命令，
  以 `full` 档位运行（`--permissions full`：`--permission-mode bypassPermissions`）——它
  **没有任何沙箱**，所以只能对着一个用完即弃的 `--source` 目录这么干，绝不要指向你的真实仓库。

档位的参数替换适配器命令中 `{permission_args}` 那一项（来自它的 `permissionArgs`）。只有
CLI 官方文档确认在无头模式下成立的映射才会填上：

| 适配器 | `read` | `edit`（默认） | `full` |
| --- | --- | --- | --- |
| `claude` | `--permission-mode dontAsk --tools Read,Glob,Grep,WebSearch,WebFetch --allowedTools WebSearch WebFetch --strict-mcp-config` | `--permission-mode acceptEdits --allowedTools WebSearch WebFetch` | `--permission-mode bypassPermissions` |
| `codex` | `--sandbox read-only` | `--sandbox workspace-write` | `--sandbox danger-full-access` |
| `gemini` | `--approval-mode default` | `--approval-mode auto_edit` | `--approval-mode yolo` |
| `qwen` | 拒绝 | `--approval-mode auto-edit` | `--approval-mode yolo` |
| `kimi` | 拒绝 | print 模式本身（无参数） | 按 `edit` 运行 |
| `omp` | 拒绝 | `--approval-mode yolo` | 按 `edit` 运行 |
| `kilo`、`opencode` | 拒绝 | `--auto` | 按 `edit` 运行 |
| `cursor` | 拒绝 | `--force` | 按 `edit` 运行 |

- 请求高于运行（或其适配器）所允许档位的 agent 会在启动前失败，报错同时写明两个档位。
- **拒绝**：对没有 read 参数的 CLI 请求 `read`，agent 会在启动前失败，并说明哪个适配器可以、
  以及如何解除只读。
- **按 `edit` 运行**：对没有 full 参数的 CLI 请求 `full`，会用它的 `edit` 参数运行；每次运行
  对每个适配器只记一条日志。对 `kimi`、`omp`、`kilo`、`opencode` 和 `cursor` 来说，`edit`
  在无头模式下本来就会批准所有工具调用。
- 没有 `permissionArgs` 的适配器（你自己的 CLI）按配置的命令原样运行，视为 `edit`；在其他
  档位下，运行会记一条日志，说明 ODW 无法强制执行。
- `codex` 在任何档位下都无法批准需要审批的 MCP 工具调用：请在 `~/.codex/config.toml` 里
  预先批准该工具（`[mcp_servers.<server>.tools.<tool>] approval_mode = "approve"`）——见
  README 的"权限档位"一节。

每次 `odw run` 都会打印各已安装适配器将以哪个档位运行；每个 `agent_started` 事件都带有该
agent 的 `permissions`；`odw doctor` 会列出每个适配器支持的档位。

```json
{
  "permissions": "read",
  "adapters": {
    "codex": { "permissions": "read" },
    "my_wrapper": {
      "command": ["my-agent", "{permission_args}", "--cwd", "{workspace}"],
      "permissionArgs": { "read": ["--read-only"], "edit": [], "full": ["--yolo"] }
    }
  }
}
```

不写 `command` 的条目只修改同名内置适配器中它写出的字段（如上面的
`"codex": { "permissions": "read" }`）。写了 `command` 的条目会整体替换内置适配器——对
`claude` 来说，请像 `odw.config.example.json` 那样保留 stream-json 旗标、`output` 块和它的
`permissionArgs`。

内置的 `claude` 以 Claude Code 的 `--output-format stream-json --verbose` 运行：每一轮
输出一个事件，最后是一个 `result` 事件，带着回复、这次运行的用量和花费，失败时还带
`is_error`。

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
| `stallTimeout` | **ODW 扩展。** agent 在 stdout 和 stderr 上都没有任何输出的最长秒数，超过即像超时一样被杀掉，并用同一个 prompt 重启；`null`（默认）= 关闭。所有内置适配器都默认关闭，因为有些 CLI（文本模式的 `gemini`、`qwen`、`kimi`）在结束前什么都不输出——请只对会流式输出进度的适配器启用：`claude`（stream-json，每一轮一个事件）、`kilo`、`opencode`，并把值设得高于最长的单次工具调用 |
| `stallRestarts` | 每次 `agent()` 调用在卡死后最多重启几次，用完后调用以 “stalled” 错误失败（默认 1） |
| `transientRetries` | **ODW 扩展。** CLI 撞上限流（429/529、overloaded）后，每次 `agent()` 调用最多重试几次；每次重试前按指数退避等待，并遵从 CLI 打印的 retry-after（默认 3；`0` = 从不重试）。额度用尽和登录失败从不重试：错误信息会说明该怎么做 |
| `maxBackoff` | 单次退避等待的最长秒数（默认 300）；CLI 要求等待更久时，不会提前重试 |
| `schemaRetries` | schema 校验失败时的额外重试次数 |
| `runsRoot` | run 的存放位置（默认 `~/.odw/runs`） |
| `workflowsRoot` | 按名字解析 workflow 的目录（默认 `~/.odw/workflows`） |
| `claudeWorkflowsRoot` | 读取 Claude Code 已保存 workflow 的目录（默认 `~/.claude/workflows`，遵循 `CLAUDE_CONFIG_DIR`） |
| `claudeJobsScope` | dashboard 显示哪些 Claude Code 运行：`"all"`（默认）或 `"project"` |
| `notify` | **ODW 扩展。** 运行结束时的 hook：`{ "command": [argv], "webhook": "https://…", "on": ["done", "failed", "stopped"] }`——见下文 |
| `worktreeSetup` | **ODW 扩展。** 在每个新建的隔离 worktree 里、`.worktreeinclude` 生效之后、agent 启动之前运行的命令：字符串交给平台 shell，数组作为不经 shell 的 argv。它在 agent 的工作区里运行，带着该 agent 的 `ODW_RUN_ID`、`ODW_AGENT_ID` 和 `ODW_PORT`；失败或超时会让这个 agent（而不是整个运行）失败，错误里引用它输出的结尾。`null`（默认）= 不运行 |
| `worktreeSetupTimeout` | worktree setup 被杀掉之前最多运行的秒数（默认 600） |
| `portRange` | **ODW 扩展。** `[first, last]`：每个正在运行的 agent 的 `ODW_PORT` 从这个范围分配（默认 `[41000, 41999]`）；请让它比 `concurrency` 更宽 |
| `fanOutWarn` | **ODW 扩展。** 单次 `parallel()` 或 `pipeline()` 调用扇出的任务或条目超过这个数时，运行记一条带数量的警告（`large fan-out: …`）；从不阻塞。默认 25；`0` 或 `null` = 关闭 |
| `maxDiffBytes` | **ODW 扩展。** run 目录里保存的单个隔离 agent 的 diff 最多多少字节（`agents/<agentId>.diff`，由 `odw diff` / `odw apply` 读取；默认 2 MB）。超出时保留开头（在行边界截断）并加一行 `# odw: diff truncated …`；计数仍描述完整改动 |
| `keepBranches` | **ODW 扩展。** `true`：每个隔离 agent 的改动也都提交到源仓库的分支 `odw/<runId>/<agentId>-<label>`，就像对单个 agent 用 `keep: true`（`keep: false` 可让某个 agent 不受影响）。默认 `false` |
| `maxTranscriptBytes` | **ODW 扩展。** run 目录里为每个 agent 保存的 transcript 最多多少字节——它的 CLI 在 stdout 上打印的内容写入 `agents/<agentId>.transcript.jsonl`（JSONL 适配器的事件按原样保存，其他输出写成 `{"kind":"text"}` 行），stderr 的结尾写入旁边的 `agents/<agentId>.stderr.txt`；用 `odw logs <run> --agent <id\|label>` 查看（默认 5 MB）。超出时以一行 `{"kind":"truncated","bytes":N}` 结束 transcript；`0` = 不保存 |
| `permissions` | **ODW 扩展。** 运行的权限档位：`"read"`、`"edit"`（默认）或 `"full"`——见[权限](#权限每个内置适配器能做什么)。`odw run\|rerun\|resume --permissions` 可覆盖 |
| `agentEnv` | **ODW 扩展。** `"inherit"`（默认）：agent CLI 拿到 ODW 的全部环境变量。`"minimal"`：只传 `PATH`、`HOME`、`USER`、`LOGNAME`、`SHELL`、`LANG`、`LC_*`、`TERM`、`TMPDIR`、`TZ`（以及 Windows 系统变量）、内置 CLI 文档中列出的认证与配置变量（`ANTHROPIC_*`、`CLAUDE_*`、`OPENAI_*`、`CODEX_*`、`GEMINI_*`、`GOOGLE_*`、`DASHSCOPE_*`、`QWEN_*`、`MOONSHOT_*`、`KIMI_*`、`CURSOR_*`、`OPENCODE_*`、代理变量、`NODE_EXTRA_CA_CERTS`）、`ODW_*`、`agentEnvPass` 和适配器的 `env`。`exec()` 命令、`worktreeSetup` 和 `notify` 仍拿到完整环境 |
| `agentEnvPass` | **ODW 扩展。** `"minimal"` 环境下额外放行的变量名或 `*` 通配（如在 Bedrock 上用 Claude Code 时的 `["AWS_*"]`） |

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
| `failures` | **ODW 扩展。** 这个 CLI 自己的失败措辞：`{ "rate_limit": [...], "quota": [...], "auth": [...] }`，正则表达式，先于内置表、不区分大小写地匹配失败运行输出的末尾 |
| `output` | stdout 如何变成回复（默认：去掉首尾空白的文本）——见下文 |
| `permissionArgs` | **ODW 扩展。** 各档位的参数：`{ "read"?: [...], "edit": [...], "full"?: [...] }`（`edit` 必填，没有参数写 `[]`），放在命令中 `{permission_args}` 那一项的位置——设置了它，命令就必须恰好有这一项 |
| `permissions` | **ODW 扩展。** 把该适配器的档位封顶在运行档位之下：它的 agent 取两者中较低的一档 |

### 输出格式

- `{ "format": "text" }`——默认：去掉首尾空白的 stdout 就是回复。
- `{ "format": "jsonl", "eventType": "text", "textPath": ["part", "text"], "select": "last" }`
  ——换行分隔的 JSON 事件，边流式到达边解码；回复是 `type` 为 `eventType` 的最后一个
  事件里 `textPath` 处的文本。
- `{ "format": "json", "textPath": ["response"] }`——stdout 上的一个 JSON 文档。

**ODW 扩展：** 两种 JSON 格式都可以加上 `usagePath`（token 计数）、`costPath`（美元）和
`errorPath`（`true`、一条消息或一个错误对象：这次运行以它失败，不论退出码都像任何失败一样
被归类）；`jsonl` 从 `usageEvent` 事件（默认同 `eventType`）读取用量和花费并累加。用量会在
不同 CLI 的字段名（Anthropic、OpenAI、Codex）之间归一化为：`inputTokens`（含缓存命中的
输入）、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens`、`costUsd`。路径里的整数
用于索引数组（负数从末尾数）。stdout 里找不到声明的文本时，原始 stdout 就作为回复，运行
日志会说明原因——agent 不会因此失败。

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
| `{permission_args}` | **ODW 扩展。** agent 所在档位的参数（来自 `permissionArgs`），各自作为独立的 argv 元素（仅限 command，且该元素只能是这个占位符本身） |

只要一个 CLI 能读取 prompt（经 stdin 或一个参数）并把回复打印到 stdout，它就能接入。非零
退出、超时，或可执行文件缺失，都会表现为一次失败的 agent 调用，并被归类为 `rate_limit`、
`quota`、`auth`、`timeout`、`stalled`、`not_found`、`permission` 或 `exit`（即其
`agent_failed` 事件上的 `reason`；只有 `rate_limit` 会重试——见 `transientRetries`）。
CLI 在输出里报告的失败（`errorPath`：Claude Code stream-json 的 `is_error` 结果，常常以 0
退出）也一样，干净退出、但简短的文本回复只是一条限流、额度或登录错误的情况（如
`API Error: Rate limit reached`）同样算作失败。
