# 人工检查点与 agent 的提问

[English](../../guides/checkpoints-and-questions.md) · 简体中文

人在哪里介入一次运行：脚本等待的 `checkpoint()`，以及 agent 在无人值守时提出的问题。

## 人工检查点(ODW 扩展)

Claude Code 的 workflow 一旦启动就不再接受输入。`checkpoint()` 让运行停在需要人看一眼的
地方——在昂贵的扇出之前批准计划,或叫停一次跑偏的运行——并持久地等待答复:

```js
const plan = await agent('Plan the migration as independent steps.', { schema: PLAN })
const { approved, note } = await checkpoint('Run this migration plan?', { payload: plan })
if (!approved) return { skipped: true, why: note }
await parallel(plan.steps.map((step) => () => agent(step.instructions)))
```

等待期间,运行在 `odw status`、`odw list`、实时视图和看板里显示为 **waiting**。其他一切
照常:已在运行的 agent 继续,等待中的检查点不占 agent 槽位、不耗预算,`odw stop` 依然
可以结束运行。可以在任意 shell 里回答:

```bash
odw status $RUN       # 问题、它的 payload,以及回答它的确切命令
odw approve $RUN      # 最早在等待的检查点;--checkpoint N 指定某一个
odw reject $RUN --note "Keep the old table until the backfill is verified"
odw approve $RUN --edit   # 先修改 payload,再批准修改后的内容
```

也可以在看板里该运行的页面上点 **Approve** / **Reject**(仅限 loopback 绑定;它向
`POST /api/runs/:id/checkpoint` 发送 `{ action, checkpointId?, note?, payload? }`;
`GET /api/runs/:id` 会列出 `pendingCheckpoints`,运行列表则用 `waiting` 标出每个等待中
运行最早的那个问题)。调用返回 `{ approved, note, by, payload, edited }`
——`by` 是 `cli`、`dashboard`、`link`(签名的[批准链接](dashboard.md#在手机上批准odw-扩展))或 `timeout`——拒绝也是一个答复而不是错误:"不"意味着
什么由脚本决定。

**修改后批准。** 和 Claude Code 的计划审批一样,审批人可以改了再批,而不必拒绝后重跑。
`odw approve $RUN --edit` 会用 `$VISUAL` / `$EDITOR`(否则 `vi`;Windows 上是 `notepad`)
打开一个私有临时文件,里面是格式化后的 payload:保存修改即批准修改后的内容;不改动就按
原样批准;清空文件则放弃、不作答复。JSON 无效或修改不被检查点接受时,命令带着错误退出并
保留该文件(打印其路径)。`--payload '<json>'` 或 `--payload @plan.json` 不经编辑器直接
批准修改,看板则在 `action: "approve"` 时附上 `payload`。调用随后返回的 `payload` 是修改
后的内容(没有修改时是检查点原来的 payload),只有与原 payload 的 JSON 不同时
`edited` 才为 `true`;拒绝和超时都带回原 payload。给 `checkpoint()` 一个 `schema`
(JSON Schema,用与 `agent()` 相同的校验器检查),修改就必须满足它:`odw approve`、API
和运行本身都会拒绝不满足的修改,并给出校验错误。没有 schema 时任何 JSON 值都接受——
payload 是脚本自己的数据,只有脚本知道修改可以是什么样——所以依赖其结构的脚本应当给出
schema:

```js
const { approved, payload: approvedPlan } = await checkpoint('Run this plan?', { payload: plan, schema: PLAN })
```

- `payload` 可以是任意 JSON 值——计划、改动摘要——最多保留 64 KiB。
- 修改后的 payload 最多 256 KiB JSON;`checkpoint_resolved` 会记录 `edited: true` 和
  修改内容(与问题的 payload 一样截断到 64 KiB)。
- `timeout`(秒)为无人值守的运行限定等待时长;超时后由 `onTimeout` 批准、拒绝,或(默认
  的 `"fail"`)抛出脚本可以捕获的 `CheckpointTimeout`。
- 多个检查点可以同时等待(在 `parallel()` 里),各有自己的编号。
- `odw resume` 永远不会重放检查点:恢复出来的运行会重新提问。
- `odw run --wait` 会在检查点等待期间一直阻塞;它会把命令打印一次,请在另一个 shell
  里回答(或用 `--timeout` 限定等待时长)。
- 运行会记录 `checkpoint_requested` 和 `checkpoint_resolved` 事件,`status.json` 里的
  `waiting` 指向最早一个仍在等待的检查点。在 [`notify.on`](notifications.md#运行通知) 里加上
  `"waiting"`,你的 hook 就会收到每一个检查点。

[`examples/plan-approve-execute.js`](../../../examples/plan-approve-execute.js) 是完整的
计划 → 批准 → 执行循环,附带说明的拒绝会触发重新规划。

## agent 的提问(ODW 扩展)

模型有时会在任务中途停下来问用户——Claude Code 的 `AskUserQuestion` 工具。无头运行时没人
能回答:工具立刻空着返回,模型接着瞎猜,或者一直挂到超时
([claude-code#50728](https://github.com/anthropics/claude-code/issues/50728))。odw 从 CLI
的输出流里识别这个调用,**在提问处立即停下 CLI**——agent 绝不会拿着空答案继续——然后按
`questions` 的设置处理:

- `"checkpoint"`(默认)把问题变成一个检查点:与 `checkpoint()` 共用 `odw status`、看板卡片
  (每个选项是一个可点击填入答案的标签)、`notify` 的 `"waiting"` hook 和一次性审批链接。用
  `odw approve <run> --checkpoint N --note "<答案>"` 回答(或批准时把编辑后的 payload 的
  `answer` 填上);同一个 agent() 调用会重新派发——隔离 agent 复用原来的 worktree——提示词末尾
  附上"Earlier in this task you stopped to ask the user: … The user answered: …"。重派会记
  一行日志(`retry.reason: "question"`)并计入预算。`odw reject` 表示拒绝回答:agent 以
  `reason: "needs_input"` 失败。同一调用回答过 3 次后再问,也会失败。
- `"fail"`:agent 立即以 `reason: "needs_input"` 失败;它问了什么会列在 `agent_failed`
  事件、`/api/runs/:id`、看板侧栏和 `odw status` 里。
- `"deny"`:CLI 运行时不带提问工具(适配器的 `questionArgs`:`claude --disallowedTools
  AskUserQuestion`),并告诉 agent 自行假设、在回复里说明假设了什么。仍然提问的以 `needs_input` 失败。

可以在运行级(配置里的 `"questions"`)、适配器级或单个调用上设置:
`agent(prompt, { questions: "fail" })`。只认 CLI 自己的工具调用——以问号结尾的回复不算提问——
也不续接 CLI 会话:调用带着答案重新运行。任何 JSONL 适配器都可以用 `output.questions` 声明自己
CLI 的提问事件(见适配器参考);内置 `claude` 已声明。
