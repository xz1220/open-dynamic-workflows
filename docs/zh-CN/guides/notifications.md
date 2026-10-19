# 通知

[English](../../guides/notifications.md) · 简体中文

不盯着也能知道运行的消息。配方（英文）：[notify](../../recipes/notify.md)。

## 运行通知

**ODW 扩展。** `notify` 会在一次运行结束时执行一条命令和/或向一个 webhook 发送 POST,
让通宵跑的 workflow 结束后主动告诉你结果:

```jsonc
"notify": {
  "command": ["/usr/local/bin/odw-notify"],        // 参数向量,不经过 shell 执行
  "webhook": "https://hooks.slack.com/services/…", // Slack、Discord 或任何接收 JSON 的端点
  "on": ["done", "failed", "stopped"]              // 默认:所有终态;"waiting"、"paused" 和 "digest" 需显式加入
}
```

这些 hook 只在运行的终态写入之后触发一次,所以既不会拖延、也不会改变终态;失败或卡住
的 hook 只会记录到该运行的 `worker.log`。命令(30 秒后被杀)在运行的源目录里执行,环境
变量里带有 `ODW_RUN_ID`、`ODW_RUN_STATE`、`ODW_WORKFLOW`、`ODW_RUN_DIR`、
`ODW_RESULT_FILE`(仅当运行有结果时)、`ODW_DURATION_SEC`、`ODW_AGENTS` 和
`ODW_FAILED_AGENTS`。webhook(10 秒时限)收到:

```jsonc
{
  "runId": "20261017-041600-3fa2c1",
  "workflow": "deep-research",
  "state": "done", // done | failed | stopped
  "createdAt": 1792210560.2, // Unix 秒
  "finishedAt": 1792210812.5,
  "durationSec": 252,
  "counts": { "agents": 12, "done": 11, "failed": 1 },
  "text": "odw · deep-research finished in 4m12s · 12 agents, 1 failed",
  "content": "odw · deep-research finished in 4m12s · 12 agents, 1 failed"
}
```

失败和被停止的运行还会多一个 `error` 字段。`text` 与 `content` 是同一行摘要,所以
Slack 和 Discord 的 incoming webhook 能直接渲染(同时设置了 Discord 的
`allowed_mentions`,一次运行永远不会 @ 到任何人)。看板的设置页会显示配置了哪些
hook——webhook 只显示协议和主机,因为 URL 的其余部分就是密钥。

在 `on` 里加上 `"waiting"`,就能在每个 [`checkpoint()`](checkpoints-and-questions.md#人工检查点odw-扩展) 开始等人
回答时收到通知。此时 hook 会对每个检查点触发一次,运行照常等待:命令的环境变量带有
`ODW_RUN_STATE=waiting`、`ODW_CHECKPOINT_ID` 和 `ODW_CHECKPOINT_TITLE`(没有
`ODW_RESULT_FILE`);webhook 收到 `"state": "waiting"`、一个
`"checkpoint": { "checkpointId", "title", "since" }` 字段(代替 `finishedAt`),以及一行
写明回答命令的 `text`。有 `odw serve --public-url` 在运行时,它们还会带上该检查点签名的一次性
批准与拒绝链接——见[在手机上批准](dashboard.md#在手机上批准odw-扩展)。[agent 的提问](checkpoints-and-questions.md#agent-的提问odw-扩展)
也触发同样的 hook:载荷的 `checkpoint.kind` 为 `"question"`(普通检查点为 `"checkpoint"`),
`checkpoint.question` 写明提问的 agent(`{ agentId, label, adapter }`),命令多出
`ODW_CHECKPOINT_KIND` 与 `ODW_QUESTION_AGENT`,`text` 行提示用 `odw approve … --note` 回答。

加上 `"paused"`,就能在运行[因额度用尽而暂停](cost-limits-and-quotas.md#额度用尽时暂停odw-扩展)时收到通知——每次
暂停一次,继续时不再通知:命令的环境变量带有 `ODW_RUN_STATE=paused`、`ODW_PAUSED_ADAPTER`
和 `ODW_RESUME_AT`(Unix 秒);webhook 收到 `"state": "paused"`、一个
`"pausedFor": { "reason": "quota", "adapter", "resumeAt" }` 字段,以及一行类似
`odw · nightly paused until 19:10 (codex quota) · odw resume <run> goes on now` 的 `text`。

由[签名触发器](scheduling-and-triggers.md#由-webhook-启动运行githublinearslackodw-扩展)启动的运行(ODW 扩展)还会在每个
payload 中带上它的 `context`——`{ trigger, provider, event, deliveryId, id, url, repo, channel,
threadTs }`(webhook 有的才有)——命令则得到 `ODW_TRIGGER`、`ODW_EVENT_ID`、`ODW_EVENT_URL`
和 `ODW_CONTEXT`(完整 JSON),于是钩子能在工作来源的 issue 或线程里回复:
[`docs/recipes/triggers.md`](../../recipes/triggers.md)。

加上 `"digest"`(ODW 扩展),`odw digest --notify`——手动运行或由 `odw schedule add <name> --digest`
触发——就会把[跨运行晨报](scheduling-and-triggers.md#晨报odw-digestodw-扩展)发送一次:命令的环境变量带有 `ODW_RUN_STATE=digest`、
`ODW_DIGEST_TEXT`(一行摘要)、`ODW_DIGEST_FILE` 与 `ODW_DIGEST_MARKDOWN_FILE`(命令结束后删除)、
`ODW_DIGEST_SINCE`、`ODW_DIGEST_NEEDS_YOU` 和 `ODW_DIGEST_FAILED`;webhook 收到 `"kind": "digest"`、
晨报各字段(`needsYou`、`failed`、`unmet`、`changes`、`spend`、`counts`、`since`、`until`)、
`markdown`,以及承载 markdown 的 `text`/`content`(`content` 截到 Discord 的 2000 字符)。

Slack、Discord、ntfy 和桌面横幅的现成配置见
[`docs/recipes/notify.md`](../../recipes/notify.md)。
