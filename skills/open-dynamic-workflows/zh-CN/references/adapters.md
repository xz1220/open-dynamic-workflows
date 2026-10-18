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
| `agy` | 拒绝 | `--mode accept-edits` | `--mode accept-edits --dangerously-skip-permissions` |

- 请求高于运行（或其适配器）所允许档位的 agent 会在启动前失败，报错同时写明两个档位。
- **拒绝**：对没有 read 参数的 CLI 请求 `read`，agent 会在启动前失败，并说明哪个适配器可以、
  以及如何解除只读。
- **按 `edit` 运行**：对没有 full 参数的 CLI 请求 `full`，会用它的 `edit` 参数运行；每次运行
  对每个适配器只记一条日志。对 `kimi`、`omp`、`kilo`、`opencode` 和 `cursor` 来说，`edit`
  在无头模式下本来就会批准所有工具调用。
- `agy`（Google 的 Antigravity CLI）在无头模式下会软拒绝任何需要审批的工具调用：在 `edit`
  下它可以编辑工作区内的文件，而 shell 命令、联网和 MCP 工具只有在用户自己的
  `~/.gemini/antigravity-cli/settings.json` 中 `permissions.allow` 规则允许时才会运行。它没有
  `read`：没有文档化的参数能阻止它写入。
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
`permissionArgs`；对 `codex` 也一样，保留 `--json`、`--output-last-message {reply_file}` 和它的
`output` 块。

内置的 `claude` 以 Claude Code 的 `--output-format stream-json --verbose` 运行：每一轮
输出一个事件，最后是一个 `result` 事件，带着回复、这次运行的用量和花费，失败时还带
`is_error`。

内置的 `codex` 以 `codex exec --json --output-last-message {reply_file}` 运行：输出 JSONL
事件，回复是 codex 写进该文件的最终消息（否则取最后一个 `item.completed` 的
`agent_message`），token 取自 `turn.completed`（没有花费——codex 不上报），`turn.failed` /
`error` 事件是它自己报告的失败。它的 transcript 会显示每条命令、文件改动、MCP 工具调用和网络搜索。

内置的 `agy`（ODW 扩展）以 print 模式运行 Google 的 Antigravity CLI，`--output-format
stream-json`，提示词走 stdin（https://antigravity.google/docs/cli/headless）：它的事件用
`event` 键标明类型（`output.eventKey`），最后的 `result` 事件带着回复（`response`）、token
（没有花费——agy 不上报）、失败时的 `error`，以及 `denied_actions`（它软拒绝的工具调用）。被拒
的调用常常让 `response` 在 SUCCESS 状态下为空：agent 以 `empty_reply` 失败，`denied` 说明原因。
子 agent 的输出不会进入 agy 的事件流（antigravity-cli#1077）；transcript 会列出它启动的每个子
agent 及其日志。

一种实用的最小权限分工：让 `claude` 写代码（acceptEdits）、让 `codex` 运行/验证
（workspace-write 沙箱）——见 `examples/codex-claude-loop.js`。

**不受信任的仓库（ODW 扩展）。** `odw run --untrusted`（或 `"trust": "untrusted"`）会在
档位参数之后加上每个 CLI 文档给出的"忽略所在仓库"的方式：`claude --safe-mode`（关闭
CLAUDE.md、skills、插件、hooks、MCP 服务器、命令、agents 和 workflows；认证照常）、
`qwen --safe-mode`，以及 `omp --no-extensions --no-skills --no-rules`（它的 AGENTS.md、
CLAUDE.md、hooks 和 MCP 配置仍会加载）。`codex`、`gemini`、`kimi`、`kilo`、`opencode`、
`cursor` 和 `agy` 没有文档化的方式：运行会为每个适配器记一次日志，说明仍有什么传给了 agent
（`codex has no documented way to ignore the repository's AGENTS.md — its instructions
still reach the agent`）。仓库 `.worktreeinclude` 的 `symlink:` 行和仓库内配置设置的
`worktreeSetup` 不会执行。

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
| `stallTimeout` | **ODW 扩展。** agent 在 stdout 和 stderr 上都没有任何输出的最长秒数，超过即像超时一样被杀掉，并用同一个 prompt 重启；`null`（默认）= 关闭。所有内置适配器都默认关闭，因为有些 CLI（文本模式的 `gemini`、`qwen`、`kimi`）在结束前什么都不输出——请只对会流式输出进度的适配器启用：`claude`（stream-json，每一轮一个事件）、`codex`（`exec --json`，每个条目一个事件）、`kilo`、`opencode`，并把值设得高于最长的单次工具调用 |
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
| `adaptiveConcurrency` | **ODW 扩展。** `true`（默认）：一次限流会让它所在适配器的上限（该适配器自己的 `concurrency`，否则为运行级上限）在本次运行余下的时间里减半，最低为 1——同一批扇出一起撞上时只减一次——此后每过一分钟没有再被限流就还回一个槽位；两者都会记日志（`adaptive concurrency: …`）。`false` 让所有上限保持不变 |
| `staggerFanOut` | **ODW 扩展。** `{ "first": 1, "delayMs": 2500 }`（默认）：在一次 `parallel()` 或 `pipeline()` 调用中，运行在声明了 `promptCache` 的适配器上、提示前 1,024 个字符相同的 agent 每次先启动 `first` 个，其余的在第一个 agent 的 CLI 产生输出后（JSONL：越过启动时 `system` 事件之后的第一个事件）或 `delayMs` 之后启动，从而读取提示缓存；单独的、提示较短的和重放的 agent 从不等待，停止会结束等待，每次错开的扇出记一行日志。`false` 或 `null` = 关闭 |
| `maxDiffBytes` | **ODW 扩展。** run 目录里保存的单个隔离 agent 的 diff 最多多少字节（`agents/<agentId>.diff`，由 `odw diff` / `odw apply` 读取；默认 2 MB）。超出时保留开头（在行边界截断）并加一行 `# odw: diff truncated …`；计数仍描述完整改动 |
| `keepBranches` | **ODW 扩展。** `true`：每个隔离 agent 的改动也都提交到源仓库的分支 `odw/<runId>/<agentId>-<label>`，就像对单个 agent 用 `keep: true`（`keep: false` 可让某个 agent 不受影响）。默认 `false` |
| `applyVerify` | **ODW 扩展。** `odw apply` 每次应用后在仓库根目录通过 shell 运行的命令（受 `timeout` 约束），例如 `"npm test"`：命令失败、超时或被中断时，这次应用会被原样回滚（只恢复涉及路径的内容和索引项，其他一概不动）。`odw apply --verify "<cmd>"` 覆盖它，`--no-verify` 跳过它，`--check` 从不运行它。默认 `null`（不运行） |
| `maxTranscriptBytes` | **ODW 扩展。** run 目录里为每个 agent 保存的 transcript 最多多少字节——它的 CLI 在 stdout 上打印的内容写入 `agents/<agentId>.transcript.jsonl`（JSONL 适配器的事件按原样保存，其他输出写成 `{"kind":"text"}` 行），stderr 的结尾写入旁边的 `agents/<agentId>.stderr.txt`；用 `odw logs <run> --agent <id\|label>` 查看（默认 5 MB）。超出时以一行 `{"kind":"truncated","bytes":N}` 结束 transcript；`0` = 不保存 |
| `recordVersions` | **ODW 扩展。** `true`（默认）：某个适配器在一次运行中第一次派发 agent 时，与 agent 并行执行 `<cli> --version`（命令的第一个 argv 元素），3 秒超时，记为 `cli_version` 事件——`odw status`、`GET /api/runs/:id` 的 `cliVersions` 与 `odw compare` 会读取它。它绝不拖慢或导致运行失败；不回应的 CLI 记为未知版本；命令为 node 或其他解释器、脚本或相对路径的适配器不做探测。`false` = 不探测（meta.json 中的 odw 版本与工作流 sha256、`run_started` 上的设置照常记录） |
| `notes` | **ODW 扩展。** `false`（默认）：没有笔记板，agent 按原样运行。`true`：运行中的每个 agent 都使用本次运行的笔记板——启动时已有的笔记写进它的提示词，`ODW_NOTES` 用来发布（`"$ODW_NOTES" "内容"`，或 `odw note "内容"`）和读取笔记；隔离的 agent 完成时，ODW 替它发布所保留改动的接口行。`agent(…, { notes })` 与 `parallel(…, { notes })` 可按调用覆盖。见 primitives.md |
| `permissions` | **ODW 扩展。** 运行的权限档位：`"read"`、`"edit"`（默认）或 `"full"`——见[权限](#权限每个内置适配器能做什么)。`odw run\|rerun\|resume --permissions` 可覆盖 |
| `trust` | **ODW 扩展。** `"trusted"`（默认）或 `"untrusted"`：用于别人的仓库。不受信任时，每个适配器的 `untrustedArgs` 加在档位参数之后（`claude --safe-mode`、`qwen --safe-mode`、`omp --no-extensions --no-skills --no-rules`）；没有文档化方式的 CLI 每次运行说一次（它的 `untrustedNote`）。`.worktreeinclude` 的 `symlink:` 行不做链接，仓库内配置设置的 `worktreeSetup` 不会运行。`odw run\|rerun\|resume --untrusted` 按次设置；仓库内的配置无法放宽 `~/.config/odw/config.json` 设置的信任级别 |
| `agentEnv` | **ODW 扩展。** `"inherit"`（默认）：agent CLI 拿到 ODW 的全部环境变量。`"minimal"`：只传 `PATH`、`HOME`、`USER`、`LOGNAME`、`SHELL`、`LANG`、`LC_*`、`TERM`、`TMPDIR`、`TZ`（以及 Windows 系统变量）、内置 CLI 文档中列出的认证与配置变量（`ANTHROPIC_*`、`CLAUDE_*`、`OPENAI_*`、`CODEX_*`、`GEMINI_*`、`GOOGLE_*`、`DASHSCOPE_*`、`QWEN_*`、`MOONSHOT_*`、`KIMI_*`、`CURSOR_*`、`OPENCODE_*`、代理变量、`NODE_EXTRA_CA_CERTS`）、`ODW_*`、`agentEnvPass` 和适配器的 `env`。`exec()` 命令、`worktreeSetup` 和 `notify` 仍拿到完整环境 |
| `agentEnvPass` | **ODW 扩展。** `"minimal"` 环境下额外放行的变量名或 `*` 通配（如在 Bedrock 上用 Claude Code 时的 `["AWS_*"]`） |
| `schemaKeywords` | **ODW 扩展。** `agent()` 的 schema 里 ODW 校验器不检查的关键字如何处理。`"warn"`（默认）：调用照常运行，ODW 检查其余部分，运行日志只说一次哪些关键字、位于何处、由谁强制执行（接收原生 schema 的适配器 CLI，即 `flags.schema`，否则无人）。`"strict"`：调用在启动前失败，逐个写明。格式错误的 schema 在两种模式下都会失败。`checkpoint()` 的 `schema`（修改后的 payload 必须满足的结构）遵循同样的规则。见[原生结构化输出](#原生结构化输出) |
| `schemaPrompt` | **ODW 扩展。** `"auto"`（默认）：只有不接收原生 schema 的 CLI 才在提示词里看到 schema 描述；`"always"`：所有 CLI 都附上 |
| `fallback` | **ODW 扩展。** 回退链：`{ "codex": ["claude"], … }`——agent 的 CLI 额度用尽或登录被拒时，它会在为其所在适配器列出的下一个适配器上重新运行（全新的提示词、相同的选项、相同的权限档位：不能运行该档位的适配器会被跳过）。限流仍在原地重试。`agent()` 调用自己的列表 `adapter: ["codex", "claude"]` 会取代它。列出的每个适配器都必须已配置。`"handoff": true`（保留键，不是适配器；默认关闭）让回退交接工作而不是从头再来：下一个适配器在同一个 worktree 中继续，提示词以上一个适配器所做之事的简报开头（至多 6 KB），简报保存为 `agents/<id>.handoff.md`；`agent(…, { handoff })` 覆盖它。默认 `{}`——见[路由](primitives.md#路由阶段默认值模型分层回退链odw-扩展) |
| `quotaBreaker` | **ODW 扩展。** 同一个适配器上连续这么多次额度失败后，本次运行之后的 agent 都会跳过它——各自从回退链上的下一个适配器开始，没有回退链的则立即失败——并记一条警告。默认 3；`0` 或 `null` 表示从不跳过 |
| `quotaWait` | **ODW 扩展。** 额度用尽时暂停：`{ "max": <秒数> }` 让因额度用尽而无适配器可用的 agent 不占槽位地等到它的 CLI 报出的重置时间（"try again in 3h 22m"、"resets 7pm"、`usage limit reached\|<epoch>`），只要不超过 `max` 秒，然后从链首重新开始（加最多 30 秒抖动）。在那个重置时间之前，运行会跳过该适配器；无处可去的 agent 在派发前就等待。运行显示为 `paused`，带 `pausedFor: { reason: "quota", adapter, resumeAt }`（`odw status`、`odw list` 和实时视图显示 "paused until 19:10 (codex quota)"）；`odw resume` 立即继续，`odw stop` 照常停止。没有重置时间或超过 `max` 的额度失败仍让 agent 失败（日志会说明）。等待发生在 worker 里：worker 死掉时运行变为 stale，`odw resume` 会重放它。默认 `false`——一个会等上几个小时的运行，应当是有人主动要求的 |
| `models` | **ODW 扩展。** 模型层级：`{ "fast": { "claude": "haiku", "codex": "gpt-5-mini" }, … }`。`model: "@fast"`（写在 `agent()`、`phase()` 或 `meta.phases` 里）让 agent 使用其适配器在该层级下的 ID——回退之后用下一个适配器的；层级没给某适配器 ID 时使用其 CLI 的默认模型（记日志），未知层级会让 agent 失败。层级名由字母、数字、`_`、`-` 和 `.` 组成；列出的每个适配器都必须已配置。默认 `{}` |
| `expectRetries` | **ODW 扩展。** 工作没达到 `expect` 检查的 agent 带着缺失项重跑的次数，之后以 `unmet_expectation` 失败（默认 1；`agent()` 调用自己的 `expectRetries` 优先）——见 [expect](primitives.md#expectodw-扩展) |
| `permissionDenials` | **ODW 扩展。** CLI 拒绝了 agent 的工具调用（`deniedPath`）、而回复声称成功时怎么办：`"warn"`（默认）保留回复——这些调用记为 agent 上的 `denied` 并记一次日志——`"fail"` 让 agent 以 `permission` 失败。适配器自己的 `permissionDenials` 优先；设了 `expect` 的调用无论如何都把被拒绝的调用算作缺失 |
| `mcpFailures` | **ODW 扩展。** CLI 启动 agent 时没连上 MCP 服务器（`mcpPath`：Claude Code 的 init 事件）时怎么办：`"warn"`（默认，与 Claude Code 自己只警告一致）保留回复——每个状态不是 `connected` 的服务器记为 agent 上的 `mcp`，每次运行按服务器和状态各记一次日志——`"fail"` 让服务器为 `failed` 或 `needs-auth` 的 agent 以 `mcp_unavailable` 失败（`pending` 和 `disabled` 从不导致失败）。调用的 `expect.mcp` 列出的服务器则算作缺失 |
| `orphanedBackground` | **ODW 扩展。** CLI 给出回复时仍有后台任务在运行——`run_in_background` 的 shell 命令或它从未等待的子 agent，随 CLI 退出而终止（`output.background`：Claude Code 的任务事件）——时怎么办：`"warn"`（默认）保留回复，任务记为 agent 上的 `orphaned` 并记一次日志；`"fail"` 让 agent 以 `orphaned_background` 失败。设了 `expect` 的调用无论如何都把它算作缺失 |
| `scopePolicy` | **ODW 扩展。** agent 改动了声明的 `scope` 之外的文件时怎么办（见原语参考）：`"warn"`（默认）保留回复，这些文件记为 agent 上的 `outOfScope` 并记日志；`"fail"` 让 agent 以 `out_of_scope` 失败。`agent()` 自己的 `scopePolicy` 优先；设了 `expect` 的调用无论如何都把它算作缺失 |
| `redact` | **ODW 扩展。** `{ "env": true, "patterns": true, "extra": [] }`（默认）：odw 保存和提供的内容——transcript 与 stderr 结尾、保存的结果、事件、运行的错误、webhook 负载——在写下之前把疑似密钥替换为 `«redacted:<kind>»`，并以 `redacted: true` 标明；`worker.log` 与 Chat Host 会话同样脱敏（用户输入只脱敏令牌形态），运行的 `args` 为 `odw rerun` 原样保存、对外提供时脱敏令牌形态。`env`：odw 环境及各适配器 `env` 中名字像密钥的变量（`*_KEY`、`*TOKEN`、`*SECRET*`、`*PASSWORD*`、`AUTHORIZATION`、云凭据）的值（8 个字符及以上），无论出现在哪里，以及这类名字的 `NAME=value`；`patterns`：常见令牌形态（Anthropic、OpenAI、GitHub、Slack、AWS、Google、JWT、私钥、`Bearer`）；`extra`：更多正则表达式。运行的结果只应用 `patterns` 和 `extra`；提示词、agent 看到的内容和保存的 diff 从不脱敏。`false` = 关闭；`odw doctor` 会报告 |
| `otel` | **ODW 扩展。** OpenTelemetry 导出：`false`（默认）什么都不发送——单靠 `OTEL_*` 环境变量不会开启。`true` 或 `{ "endpoint": "http://localhost:4318", "headers": { … }, "captureContent": false }`：运行结束后，worker 把它的 trace（遵循 GenAI 语义约定的 `invoke_workflow` / `phase` / `invoke_agent` / `execute_tool` / `exec` / `checkpoint` span——含用量、花费、模型、失败原因，重试和回退作为 span 事件）以 OTLP/HTTP JSON 发送到 `endpoint` + `/v1/traces`，只发一次，时限 5 秒；失败只在运行的 `worker.log` 留一行，绝不改变运行结果。省略时 `endpoint` 和 `headers` 取自 `OTEL_EXPORTER_OTLP_(TRACES_)ENDPOINT` / `…HEADERS`（默认端点 `http://localhost:4318`）；header 的值是机密，从不写日志或显示。`captureContent`（或 `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true`）会附带回复、工具输入输出和错误文本——发出前再次脱敏，每个字段截断到 4096 个字符。`odw export <run> --otlp [--out FILE \| --send]` 可导出任意运行；`odw doctor` 显示 trace 发往何处 |
| `sandbox` | **ODW 扩展。** `"none"`（默认）：agent CLI 在本机运行。`{ "kind": "container", "image", "engine"?, "network"?, "mounts"?, "cliConfig"?, "memory"?, "cpus"?, "pids"? }`：每次 CLI 运行与每个 `exec()` 步骤都在全新的 Docker/Podman 容器中进行——只以相同路径挂载工作区与私有 home（复制 CLI 的登录文件），以宿主 uid:gid、无 capability、`no-new-privileges`、pids 上限、只读根文件系统运行，环境变量按名字传递；`network` 默认 `"default"`（agent 必须连到模型 API），也可以是 `"none"` 或出站白名单 `{ "allow": [...] \| "adapter", "proxyImage"? }`——容器只加入运行专属的内部网络（`network create --internal`），唯一出口是代理边车（ODW 的零依赖 node 脚本，即隐藏命令 `odw __egress-proxy`，跑在 agent 镜像里——**需要 node**——或 `proxyImage` 里），通过 `HTTPS_PROXY`/`HTTP_PROXY` 访问；代理只为白名单主机的 443（或条目端口）建立 CONNECT、只转发白名单主机的明文 HTTP（`Host` 头须指向该主机）、自己解析域名（Docker 上容器得到 `--dns 192.0.2.1`：无外部 DNS，CVE-2024-29018）、只在内部网络地址上监听，除非列出否则拒绝 IP 字面量；它按主机名而非站点限制：CONNECT 里的 TLS 可以指向同一 CDN 边缘后的其他站点（域前置）；`*.d` 匹配 `d` 的子域而非 `d` 本身；`"adapter"` 即适配器的 `egressHosts`；适配器与调用只能取交集；每次拒绝是一条 `egress_denied` 事件 `{ host, port, method, agent \| commandId }`（每次运行最多 200 条，之后一行日志给出数量；`agent` 是客户端发来的代理用户名，仅作提示）；忽略 `HTTPS_PROXY` 的 CLI 完全没有网络（安全的失败方式）；运行结束与兜底时删除代理和网络，`odw doctor` 期望首个列出的主机返回 200、保留域名返回 403、容器内 example.com 解析不了。`exec()` 步骤默认 `"none"`（`"default"` 即运行的网络，含白名单）；非干净退出时按名字 kill 容器；镜像从不拉取（`examples/sandbox/Dockerfile`），缺引擎或镜像即 `ConfigError`。`odw run\|rerun\|resume --sandbox container [--sandbox-image <镜像>]` 按运行开启；适配器与 `agent()` 只能收紧 |
| `triggers` | **ODW 扩展。** `{}`（默认）：没有。`{ "<名字>": { "workflow", "verify": "github"\|"linear"\|"slack"\|"hmac-sha256", "secret"\|"secretEnv", "args"?: { "<参数>": "$.json.path" }, "events"?, "dedupe"?: "$.path", "concurrency"?, "rateLimit"?: { "max", "windowSec" }, "untrusted"?: true, "source"? } }`：`odw serve` 在 `POST /api/triggers/<名字>` 响应的签名 webhook，各自启动自己的工作流（除非 `"untrusted": false`，否则不受信任），运行的 `context` 传给 `notify`。严格校验：未知字段即报错 |
| `agentLimits` | **ODW 扩展。** `{}`（默认）：不设上限。`{ "toolCalls"?, "costUsd"?, "outputTokens"?, "seconds"?, "repeat"? }`：每个 agent 被当作失控杀掉之前能做多少（原因 `runaway`，`limitHit` 写明上限与证据）——从 claude/codex/kilo/opencode 的输出实时执行；`repeat` 为同一工具调用连续出现的次数（至少 2）。适配器的 `agentLimits` 与 `agent()` 的 `limits` 逐键覆盖它，`null` 取消某项。文本 CLI 的 `outputTokens`/`costUsd` 只在每次运行后检查，不报告花费的 CLI（codex）永远不会触发 `costUsd`——每次运行各提示一次 |

### 适配器字段

| 字段 | 含义 |
| --- | --- |
| `command` | 参数向量；`{placeholder}` 占位符每次调用时展开（必填） |
| `stdin` | 喂给进程 stdin 的可选模板（如 `"{prompt}"`） |
| `env` | 叠加在进程环境之上的额外环境变量（ODW 自己的 `ODW_RUN_ID`、`ODW_AGENT_ID` 和 `ODW_PORT` 优先于它们） |
| `timeout` | 每次调用的超时（秒）（覆盖运行级的 `timeout`） |
| `stallTimeout` | 这个 CLI 的卡死超时（秒）（覆盖运行级的 `stallTimeout`；`0` 表示对该适配器关闭看门狗） |
| `concurrency` | **ODW 扩展。** 在运行级 `concurrency` 之内，这个 CLI 上同时最多运行多少个 agent：一个 agent 需要两边各一个槽位，每个适配器先到先得地排队，被限住的适配器不会挡住其他适配器。不设置：只受运行级上限约束 |
| `promptCache` | **ODW 扩展。** `true`：这个 CLI 背后的模型 API 会缓存提示前缀，所以它的扇出会错开启动（见 `staggerFanOut`）。内置 `claude` 声明了它 |
| `label` | 进度显示用的友好名字 |
| `flags` | 能力声明，如 `{ "model": ["--model"] }`——承载每次调用 `model` 的原生旗标。不声明它，`agent(..., { model })` 对该适配器就不生效（日志里会出现一条路由说明）。**ODW 扩展：**`"schema": { "args": [...], "mode": "inline" \| "file", "strict"?: true, "objectRoot"?: true }` 声明该 CLI 会自己校验调用的 JSON Schema——见[原生结构化输出](#原生结构化输出) |
| `failures` | **ODW 扩展。** 这个 CLI 自己的失败措辞：`{ "rate_limit": [...], "quota": [...], "auth": [...] }`，正则表达式，先于内置表、不区分大小写地匹配失败运行输出的末尾 |
| `output` | stdout 如何变成回复（默认：去掉首尾空白的文本）——见下文 |
| `permissionArgs` | **ODW 扩展。** 各档位的参数：`{ "read"?: [...], "edit": [...], "full"?: [...] }`（`edit` 必填，没有参数写 `[]`），放在命令中 `{permission_args}` 那一项的位置——设置了它，命令就必须恰好有这一项 |
| `permissions` | **ODW 扩展。** 把该适配器的档位封顶在运行档位之下：它的 agent 取两者中较低的一档 |
| `permissionDenials` | **ODW 扩展。** `"warn"` 或 `"fail"`：这个 CLI 自己的 `permissionDenials`，优先于运行级设置 |
| `trust` | **ODW 扩展。** `"untrusted"`：这个适配器在每次运行中都不受信任（`"trusted"` 不能放宽不受信任的运行） |
| `untrustedArgs` | **ODW 扩展。** 让这个 CLI 不读取仓库指令、设置、hooks 和 MCP 服务器的参数，不受信任时加在 `{permission_args}` 处、档位参数之后。不设：运行会说一次它什么也挡不住。在内置适配器上设置它会去掉内置的 `untrustedNote` |
| `untrustedNote` | **ODW 扩展。** 不受信任运行时仍会从仓库传给这个 CLI 的内容，每次运行记一次日志 |
| `sandbox` | **ODW 扩展。** 让这个 CLI 在容器中运行：`{ "kind": "container", … }`，覆盖运行级 `sandbox` 的字段（自己的 `image`、`engine`、`cliConfig`，追加 `mounts`；`network` 与各项限制取更严格者）。运行级沙箱为 `"none"` 时必须给出 `image`；这里写 `"none"` 会被拒绝——只能收紧 |
| `agentLimits` | **ODW 扩展。** 这个 CLI 自己的单 agent 上限，逐键覆盖运行级 `agentLimits`（`null` 取消某项）；`agent()` 的 `limits` 再覆盖它 |
| `egressHosts` | **ODW 扩展。** 这个 CLI 需要访问的主机（模型 API、登录）：容器沙箱的 `"network": { "allow": "adapter" }` 放行的就是它们。claude、codex、gemini、agy 已声明自己的 |

### 输出格式

- `{ "format": "text" }`——默认：去掉首尾空白的 stdout 就是回复。
- `{ "format": "jsonl", "eventType": "text", "textPath": ["part", "text"], "select": "last" }`
  ——换行分隔的 JSON 事件，边流式到达边解码；回复是 `type` 为 `eventType` 的最后一个
  事件里 `textPath` 处的文本。**ODW 扩展：**`eventKey` 指定另一个表示事件类型的键（agy 的
  事件是 `{"event": "result", …}`：`"eventKey": "event"`）；output 中提到的所有事件类型都按它读取。
- `{ "format": "json", "textPath": ["response"] }`——stdout 上的一个 JSON 文档。

**ODW 扩展：** 两种 JSON 格式都可以加上 `usagePath`（token 计数）、`costPath`（美元）、
`errorPath`（`true`、一条消息或一个错误对象：这次运行以它失败，不论退出码都像任何失败一样
被归类）和 `deniedPath`（CLI 拒绝了 agent 的哪些工具调用，回复可能仍声称成功：记为 agent
上的 `denied` 并写入日志，或在 `permissionDenials: "fail"` 下算作 `permission` 失败——内置
`claude` 读取 `permission_denials`）和 `mcpPath`（CLI 启动 agent 时的 MCP 服务器，每项
`{ name, status }`：没连上的记为 agent 上的 `mcp` 并写入日志，或在 `mcpFailures: "fail"` 下
让它失败；`jsonl` 从 `mcpEvent` 事件读取，未设则任何事件——内置 `claude` 从 `system` init
事件读取 `mcp_servers`）；`jsonl` 从 `usageEvent` 事件（默认同 `eventType`）读取用量和花费并累加。用量会在
不同 CLI 的字段名（Anthropic、OpenAI、Codex、agy）之间归一化为：`inputTokens`（含缓存命中的
输入）、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens`、`costUsd`。路径里的整数
用于索引数组（负数从末尾数）。stdout 里找不到声明的文本时，原始 stdout 就作为回复，运行
日志会说明原因——agent 不会因此失败。`structuredPath` 指向 CLI 按原生拿到的 schema 校验过的
值（见下文）。

**ODW 扩展**，仅 `jsonl`：`match: { "path": [...], "equals": <字符串、数字或布尔值> }` 只保留
`path` 处的值等于 `equals` 的文本事件（codex：`{ "path": ["item", "type"], "equals":
"agent_message" }`）；`errorEvents: { "<类型>": [路径] }` 指出文本事件之外、由 CLI 自己报告
失败的事件——路径指向消息（codex：`{ "turn.failed": ["error"], "error": ["message"] }`）。最新
的这类事件像 `errorPath` 一样让运行失败，除非之后出现 `usageEvent`，说明 CLI 继续运行了。把
最终回复写进文件的 CLI 在命令里使用 `{reply_file}`：文件有内容就是回复；文件为空或没写、
stdout 的事件里也没有回复时，回复为空（除非 `allowEmpty`，否则 `empty_reply`），日志会写明缺了什么。

**ODW 扩展**，仅 `jsonl`：`background: { "started": [规则…], "ended": [规则…] }` 说明哪些事件
开始、哪些事件结束后台任务，到最新的文本事件时仍未结束的任务即为孤儿（`orphanedBackground`）。
规则为 `{ "event": <类型>, "each"?: [路径], "where"?: [{ "path": [...], "equals"?: 值 | [值…],
"not"?: 值 | [值…] }], "ids": [[路径]…], "pattern"?: <正则源码>, "kind"?: [[路径]…], "about"?:
[[路径]…] }`：该 `type` 的事件（设了 `each` 时为该处数组的每一项）满足全部 `where` 条件时，以
`ids` 处的值（字符串或数字；设了 `pattern` 时为其第一个捕获组在这些字符串里匹配到的内容）开始或
结束任务。任务以任一 id 为准是同一件：工具调用和它登记的任务是同一件，任一 id 都能结束它。
`kind` 和 `about`（仅开始规则）为记录命名：各取第一个找到的字符串，如 `Bash (npm run dev)`。规则
写错即 `ConfigError`。内置 `claude` 读取 Claude Code stream-json 的 `system` 事件 `task_started`
（`task_type` 为 `in_process_teammate` 的除外）、`task_updated`（`patch.status` 为
`completed`、`failed` 或 `killed` 时结束）和 `task_notification`，`input.run_in_background: true`
的 `assistant` 工具调用 `Bash`、`Agent`、`Task`，以及以 `user` 消息注入的
`<task-notification>`（`<task-id>`、`<tool-use-id>`）。

### 原生结构化输出

**ODW 扩展。** `flags.schema` 声明某个 CLI 会自己校验 JSON Schema，以及它如何接收 schema：

| 字段 | 含义 |
| --- | --- |
| `args` | schema 前面的旗标，如 `["--json-schema"]` |
| `mode` | `"inline"`：schema 的紧凑 JSON 作为下一个参数。`"file"`：一个保存 schema 的文件路径——run 目录下的 `agents/<agentId>.schema.json`（不在运行中时用临时目录），每次 CLI 运行前写入、运行后删除 |
| `strict` | `true` 表示该 CLI 只接受 OpenAI strict 模式的 schema（codex）：其他 schema——根不是对象，或某个对象没有设 `"additionalProperties": false` 并把全部属性列进 `required`——改为写进提示词，运行会提示一次 |
| `objectRoot` | `true` 表示该 CLI 只接受根为 `"type": "object"` 的 schema（agy 会在启动时拒绝其他 schema）：其他 schema 改为写进提示词，运行会提示一次 |

schema 参数排在所有其他参数之后（与模型参数同处），且不做占位符展开；没有 schema 的调用完全
按配置的命令运行。若 CLI 的输出把校验后的值与文本分开放，用 `output.structuredPath` 指出位置；
那里有值（非 null）就是回复的值，否则像任何适配器一样在回复文本里找 JSON。无论哪种，ODW 都会
校验这个值，不满足 schema 时带反馈重试；只有不接收原生 schema 的 CLI 才会在提示词里看到 schema
描述（`schemaPrompt`）。

| 内置适配器 | `flags.schema` | 值的来源 |
| --- | --- | --- |
| `claude` | `{ "args": ["--json-schema"], "mode": "inline" }` | `result` 事件里的 `structured_output`（`"structuredPath": ["structured_output"]`），否则用 `result` 文本 |
| `codex` | `{ "args": ["--output-schema"], "mode": "file", "strict": true }` | 它的最终消息：`--output-last-message` 文件，否则最后一个 `agent_message` 事件 |
| `agy` | `{ "args": ["--json-schema"], "mode": "inline", "objectRoot": true }` | `result` 事件里的 `structured_output`，否则用它的 `response` |

agent 启动前，会对照 ODW 校验器支持的子集检查它的 schema（[原语](primitives.md#schema)）。
其他内容会连同位置在运行日志里写明一次——适配器接收原生 schema 时（`strict` 的适配器上只限
strict schema）交给 CLI，否则没有谁会强制执行——ODW 检查它能检查的部分；设
`"schemaKeywords": "strict"` 时则改为让调用以 `AgentError` 失败。格式错误的 schema 或未知关键字
在两种模式下都会失败。要为某个内置适配器关闭原生 schema，给它不含 `schema` 的 `flags`：
`"claude": { "flags": { "model": ["--model"] } }`。

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
- `on`——哪些终态会触发 hook（默认：全部三种）。还可显式加入 `"waiting"`——每个开始等人
  回答的 `checkpoint()` 触发一次——以及 `"paused"`——每次因额度用尽而暂停（`quotaWait`）
  触发一次：命令拿到 `ODW_RUN_STATE=paused`、`ODW_PAUSED_ADAPTER` 和 `ODW_RESUME_AT`
  （Unix 秒），webhook 收到 `state: "paused"` 与 `pausedFor: { reason, adapter, resumeAt }`。
  暂停从不触发运行结束的 hook。

**ODW 扩展——批准链接。** 当该 runs 根目录有 `odw serve --public-url <url>`（根 URL
`https://host[:port]`，带路径的会被拒绝）在运行时，每个
`waiting` hook 都带上该检查点签名的一次性链接：webhook 收到 `approveUrl`、`rejectUrl` 和
`linksExpireAt`（`text` 末尾也有），命令拿到 `ODW_APPROVE_URL`、`ODW_REJECT_URL`、
`ODW_LINKS_EXPIRE_AT` 和 `ODW_NTFY_ACTIONS`（带 Approve/Reject 两个 `http` 按钮的 ntfy
`Actions` 头）。没有这样的服务时，`linksUnavailable` / `ODW_LINKS_UNAVAILABLE` 说明原因。
链接只能用一次，在 `approveLinks.ttl` 秒内有效（顶层设置，默认 86400）；决定记为 `by: "link"`。

**ODW 扩展——触发器上下文。** 由签名触发器（`triggers`）启动的运行在每个 payload 中带有
`context: { trigger, provider, event?, deliveryId?, id?, url?, repo?, channel?, threadTs?, dedupe? }`，
命令的环境变量中有 `ODW_TRIGGER`、`ODW_EVENT_ID`、`ODW_EVENT_URL` 和 `ODW_CONTEXT`（整个对象的
JSON）；其他运行都没有。

### 占位符

每次调用前在 `command` 和 `stdin` 里展开：

| 占位符 | 值 |
| --- | --- |
| `{prompt}` | 完整拼好的 prompt（独立性引导语 + 任务 + 任何 schema 指令） |
| `{prompt_file}` | 存放 prompt 的临时文件路径（仅在被引用时才写） |
| `{reply_file}` | **ODW 扩展。** 每次新建、位于私有临时目录中的路径，CLI 把最终回复写在这里（`codex --output-last-message`）；CLI 退出后读取，随后删除 |
| `{workspace}` | agent 运行所在的目录（隔离时是它的 git worktree） |
| `{source}` | 原始的工作树 |
| `{adapter}` / `{role}` | 适配器的名字 / 标签 |
| `{permission_args}` | **ODW 扩展。** agent 所在档位的参数（来自 `permissionArgs`），各自作为独立的 argv 元素（仅限 command，且该元素只能是这个占位符本身） |

只要一个 CLI 能读取 prompt（经 stdin 或一个参数）并把回复打印到 stdout，它就能接入。非零
退出、超时，或可执行文件缺失，都会表现为一次失败的 agent 调用，并被归类为 `rate_limit`、
`quota`、`auth`、`timeout`、`stalled`、`not_found`、`permission` 或 `exit`（即其
`agent_failed` 事件上的 `reason`；只有 `rate_limit` 会重试——见 `transientRetries`）。
CLI 在输出里报告的失败（`errorPath`：Claude Code stream-json 的 `is_error` 结果，常常以 0
退出，以及 agy 结果里的 `error`；`errorEvents`：Codex 的 `turn.failed` 与 `error`）也一样，干净退出、但简短的文本回复只是一条限流、额度或登录错误的情况（如
`API Error: Rate limit reached`）同样算作失败。干净退出也可能失败（ODW 扩展）：回复为空时
为 `empty_reply`（除非调用设了 `allowEmpty`），工作没达到调用的 `expect` 检查时为
`unmet_expectation`，CLI 拒绝了工具调用（`deniedPath`）且 `permissionDenials` 为 `"fail"`
或调用设了 `expect` 时为 `permission`，CLI 启动 agent 时有 MCP 服务器 `failed` 或
`needs-auth`（`mcpPath`）且 `mcpFailures` 为 `"fail"` 时为 `mcp_unavailable`，CLI 回复时
仍有后台任务在运行（`background`）且 `orphanedBackground` 为 `"fail"` 或调用设了 `expect`
时为 `orphaned_background`。
