# 事件与失败原因

[English](../../reference/events.md) · 简体中文

一次运行在磁盘上留下什么、worker 一路写下的事件，以及 agent 失败时给出的原因。运行目录与其中的事件是
ODW 自己的（Claude Code 把它的运行放在别处）；`odw logs`、看板和 `GET /api/runs/:id` 读取它们。
以源码为准：[`src/events.ts`](../../../src/events.ts)、[`src/adapters/failures.ts`](../../../src/adapters/failures.ts)
和 [`src/runtime/run-store.ts`](../../../src/runtime/run-store.ts) 的文件头注释。

## 运行目录

一次运行是 `<runsRoot>/<workflow-slug>/<runId>/`（`runsRoot` 默认为 `~/.odw/runs`）。worker 写它，
所有命令读它，所以运行比启动它的命令活得更久。JSON 文件以原子方式写入（先写临时文件再改名覆盖）。

| 路径 | 内容 |
| --- | --- |
| `meta.json` | 运行的描述，只写一次：脚本、参数、来源、配置、工作流名、它恢复或重放的是哪次运行、谁启动了它 |
| `status.json` | 状态（`running`、`paused`、`done`、`failed`、`stopped`）与计数 |
| `events.jsonl` | 下文的只追加事件流 |
| `agents/<agentId>.json` | 每个完成的 `agent()` 的结果，落地即保存（`odw resume` 重放的就是它） |
| `agents/<agentId>.diff` | 隔离 agent 的改动——见[审阅并应用](../guides/reviewing-and-applying.md#审阅并应用隔离-agent-的改动odw-扩展) |
| `agents/<agentId>.transcript.jsonl`、`.stderr.txt` | 它的 CLI 打印的内容——见 [Agent transcript](../guides/running-and-observing.md#agent-transcriptodw-扩展) |
| `agents/<agentId>.call.json` | 这次调用被要求做什么，供 `odw replay` 使用 |
| `agents/<agentId>.handoff.md` | 回退时交给下一个适配器的交接简报 |
| `result.json` / `error.json` | 最终值，或错误 |
| `control.json`、`decisions.jsonl` | 暂停/恢复/停止请求；对 `checkpoint()` 的回答 |
| `worker.log` | worker 自己的输出 |

odw 保存的 agent 内容会先脱敏——见 [ODW 所保存内容中的密钥](../guides/safety-and-trust.md#odw-所保存内容中的密钥odw-扩展)。

## 事件类型

`events.jsonl` 的每一行是一个 JSON 对象：`{ "ts": <秒>, "type": "…", … }`。

| 类型 | 何时 |
| --- | --- |
| `run_started` | 运行开始；带上它的行为设置 |
| `run_finished`、`run_failed`、`run_stopped` | 运行结束（由具名的人停止时，`run_stopped` 带 `who`） |
| `phase_started` | 调用了 `phase(title)` |
| `log` | `log(msg)`，以及 odw 自己写进运行日志的每条说明 |
| `agent_started`、`agent_finished`、`agent_failed` | 一次 `agent()` 调用的生命周期；失败时带原因（见下） |
| `command_started`、`command_finished`、`command_failed` | 一个 `exec()` 步骤（ODW 扩展）：finished 表示退出码 0 |
| `checkpoint_requested`、`checkpoint_resolved` | `checkpoint()` 开始等待，以及得到回答（ODW 扩展） |
| `fanout_done` | 一次 `parallel()` 或 `pipeline()` 调用结束：总数、按原因统计的失败、`minOk`（ODW 扩展） |
| `note_added` | 运行笔记板上的一条笔记（ODW 扩展） |
| `handoff` | 回退把 agent 的工作交给了下一个适配器（ODW 扩展） |
| `cli_version` | 适配器 CLI 的版本，每次运行在其首次派发时记录一次（ODW 扩展） |
| `cli_version_changed` | 运行后期 CLI 报出了另一个版本（ODW 扩展） |
| `model_substituted` | CLI 表示服务该 agent 的模型不是所要求的那个（ODW 扩展） |
| `host_suspended` | 机器睡眠过；每个 agent 的卡死计时重新开始（ODW 扩展） |
| `safety_snapshot` | 在第一个原地 agent 之前给工作区拍了快照（ODW 扩展） |
| `destructive_git` | agent 执行了破坏性的 git 命令（ODW 扩展） |
| `egress_denied` | 容器沙箱的出站代理拒绝了一个请求（ODW 扩展） |
| `acp_permission` | ACP agent 的权限请求，按其档位作答（ODW 扩展） |
| `apply_resolved` | `odw apply --resolve` 为运行中的某个 agent 跑了解决冲突的 agent（ODW 扩展） |

`odw export --otlp` 把同一个事件流转换成 OpenTelemetry trace——见
[可观测性](../guides/running-and-observing.md#可观测性opentelemetry-traceodw-扩展)。

## 失败原因

`agent_failed` 事件、agent 的保存记录和 `odw outcomes` 会给出以下之一。适配器的 `failures`
配置可以为前五种添加匹配规则——见[限流、额度与登录](../guides/cost-limits-and-quotas.md#限流额度与登录)。

| 原因 | 含义 |
| --- | --- |
| `rate_limit` | 暂时被限流或过载：退避后重试 |
| `quota` | 用量窗口、余额或套餐额度已用尽：等待重置（或 `quotaWait`） |
| `auth` | 未登录，或凭据被拒绝 |
| `model_unavailable` | CLI 不认识该模型、模型已下线，或该账号不可用：不重试 |
| `network` | 到模型 API 的连接中断或没能建立：退避后重试（ODW 扩展） |
| `timeout` | 超时被杀 |
| `stalled` | 被卡死看门狗杀掉 |
| `not_found` | CLI 无法启动 |
| `permission` | agent 需要的工具调用或批准被拒绝 |
| `exit` | 其他非零退出 |
| `empty_reply` | 正常退出但回复为空（ODW 扩展；`allowEmpty: true` 接受空回复） |
| `unmet_expectation` | agent 的工作未通过 `expect` 检查，重试也算在内（ODW 扩展） |
| `mcp_unavailable` | 在 `mcpFailures: "fail"` 下，某个 MCP 服务器失败或需要认证（ODW 扩展） |
| `runaway` | agent 触到了它的某个 `limits` 而被杀（ODW 扩展） |
| `orphaned_background` | 在 `orphanedBackground: "fail"` 下，CLI 退出时仍有后台工作在跑（ODW 扩展） |
| `out_of_scope` | 在 `scopePolicy: "fail"` 下，agent 改了其 `scope` 之外的文件（ODW 扩展） |
| `needs_input` | agent 提了一个无人回答的问题（ODW 扩展） |
| `destructive_git` | 在 `destructiveGit: "fail"` 下，agent 执行了破坏性的 git 命令（ODW 扩展） |
| `model_substituted` | 在 `modelMismatch: "fail"` 下，服务该 agent 的是另一个模型（ODW 扩展） |

因磁盘写满而失败的运行，会在 `status.json` 中写 `"failureReason": "disk_full"`——见
[磁盘写满与 pid 复用](../guides/running-and-observing.md#磁盘写满与-pid-复用odw-扩展)。
