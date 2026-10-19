# 配置参考

[English](../../reference/config.md) · 简体中文

## 配置文件在哪里找

`odw.config.json` 按以下顺序查找，优先级从高到低：

1. 显式的 `--config <path>`
2. `$ODW_CONFIG`
3. `./odw.config.json`
4. `~/.config/odw/config.json`

文件会合并到内置配置之上，只需写你要改的部分。所有键都在**顶层**——没有 `"settings"` 包装——
odw 遇到未知或放错位置的键会给出警告（附「你是不是想写」提示），而不是悄悄忽略。带注释的示例：
[`odw.config.example.json`](../../../odw.config.example.json)。

每个键的默认值与确切含义见 skill 的[设置表](../../../skills/open-dynamic-workflows/zh-CN/references/adapters.md#设置项)，
适配器条目的每个字段见其[适配器字段表](../../../skills/open-dynamic-workflows/zh-CN/references/adapters.md#适配器字段)。
下面按主题列出每个键，以及讲解它的章节。Claude Code 没有这样的文件：所有键都只由 ODW 读取。

## agent 与适配器

| 键 | 详见 |
| --- | --- |
| `defaultAdapter`、`adapters`、`concurrency`、`maxAgents`、`timeout` | [配置适配器](../guides/adapters-and-models.md#配置适配器) |
| `runsRoot`、`workflowsRoot`、`claudeWorkflowsRoot` | [运行与观测](../guides/running-and-observing.md#运行与观测) |
| `models`、`fallback`、`quotaBreaker` | [按阶段路由与回退链](../guides/adapters-and-models.md#按阶段路由与回退链odw-扩展) |
| `accounts` | [同一个 CLI 的多个账号](../guides/adapters-and-models.md#同一个-cli-的多个账号) |
| `schemaRetries`、`schemaKeywords`、`schemaPrompt` | [结构化输出](../guides/adapters-and-models.md#结构化输出odw-扩展) |
| `expectRetries`、`mcpFailures`、`orphanedBackground` | [检查 agent 的工作](workflow-api.md#检查-agent-的工作odw-扩展) |
| `notes` | [并行 agent 之间的笔记](workflow-api.md#并行-agent-之间的笔记odw-扩展) |
| `memory`、`memoryDir` | [工作流记忆](workflow-api.md#工作流记忆odw-扩展) |
| `scopePolicy` | [声明范围](workflow-api.md#声明范围odw-扩展) |
| `repos` | [多仓库运行](../guides/multi-repo.md#一次运行涉及多个仓库odw-扩展) |
| `questions` | [agent 的提问](../guides/checkpoints-and-questions.md#agent-的提问odw-扩展) |

## 上限、重试与花费

| 键 | 详见 |
| --- | --- |
| `stallTimeout`、`stallRestarts` | [卡死看门狗](../guides/cost-limits-and-quotas.md#卡死看门狗) |
| `agentLimits` | [单 agent 上限与死循环](../guides/cost-limits-and-quotas.md#单-agent-上限与死循环odw-扩展) |
| `transientRetries`、`maxBackoff` | [限流、额度与登录](../guides/cost-limits-and-quotas.md#限流额度与登录) |
| `quotaWait` | [额度用尽时暂停](../guides/cost-limits-and-quotas.md#额度用尽时暂停odw-扩展) |
| `adaptiveConcurrency`、`staggerFanOut`、`fanOutWarn` | [按适配器限制并发与错开扇出](../guides/cost-limits-and-quotas.md#按适配器限制并发与错开扇出) |
| `costGate` | [运行前先知道花费](../guides/cost-limits-and-quotas.md#运行前先知道花费odw-扩展) |

## 隔离与改动

| 键 | 详见 |
| --- | --- |
| `worktreeSetup`、`worktreeSetupTimeout`、`worktreeTeardown`、`worktreeTeardownTimeout`、`portRange` | [隔离 worktree 与 agent 端口](../guides/reviewing-and-applying.md#隔离-worktree-与-agent-端口) |
| `maxDiffBytes`、`keepBranches`、`applyVerify` | [审阅并应用](../guides/reviewing-and-applying.md#审阅并应用隔离-agent-的改动odw-扩展) |

## 安全与信任

| 键 | 详见 |
| --- | --- |
| `permissions`、`permissionDenials` | [权限档位](../guides/safety-and-trust.md#权限档位odw-扩展) |
| `destructiveGit` | [安全快照与破坏性 git 命令](../guides/safety-and-trust.md#安全快照与破坏性-git-命令odw-扩展) |
| `trust` | [不受信任的仓库](../guides/safety-and-trust.md#不受信任的仓库odw-扩展) |
| `untrustedInput` | [不可信输入](../guides/safety-and-trust.md#不可信输入odw-扩展) |
| `scriptContext` | [严格脚本上下文](../guides/safety-and-trust.md#严格脚本上下文odw-扩展) |
| `lockedWorkflows` | [运行与观测](../guides/running-and-observing.md#运行与观测)（从 git 安装工作流） |
| `sandbox` | [在容器中运行 agent](../guides/safety-and-trust.md#在容器中运行-agentodw-扩展) |
| `agentEnv`、`agentEnvPass`、`redact` | [ODW 所保存内容中的密钥](../guides/safety-and-trust.md#odw-所保存内容中的密钥odw-扩展) |

## 观测、通知、定时

| 键 | 详见 |
| --- | --- |
| `maxTranscriptBytes` | [Agent transcript](../guides/running-and-observing.md#agent-transcriptodw-扩展) |
| `recordVersions`、`driftEval` | [漂移监测](../guides/running-and-observing.md#漂移监测odw-扩展) |
| `modelMismatch` | [实际服务 agent 的模型](../guides/running-and-observing.md#实际服务-agent-的模型odw-扩展) |
| `otel` | [可观测性](../guides/running-and-observing.md#可观测性opentelemetry-traceodw-扩展) |
| `retention` | [回收磁盘](../guides/running-and-observing.md#回收磁盘odw-gc-与-odw-pinodw-扩展) |
| `claudeJobsScope` | [看板](../guides/dashboard.md#看板观测检查对话) |
| `approveLinks` | [在手机上批准](../guides/dashboard.md#在手机上批准odw-扩展) |
| `notify` | [运行通知](../guides/notifications.md#运行通知) |
| `triggers` | [由 webhook 启动运行](../guides/scheduling-and-triggers.md#由-webhook-启动运行githublinearslackodw-扩展) |
| `digest` | [晨报](../guides/scheduling-and-triggers.md#晨报odw-digestodw-扩展) |
