# 花费、上限与额度

[English](../../guides/cost-limits-and-quotas.md) · 简体中文

一次运行花了多少、如何在开始前就知道，以及 agent 或 CLI 出状况、额度用尽时 odw 怎么做。

## 用量与花费(ODW 扩展)

扇出很快就会烧掉额度,所以运行会边跑边显示花了多少。每个 `agent_finished`(以及
`agent_failed`)事件都带着这个 agent 的 `usage`:`inputTokens`(含缓存命中的输入)、
`outputTokens`、`cacheReadTokens`、`cacheWriteTokens` 和 `costUsd`,按 CLI 上报的数值
在它所有的 CLI 运行上求和——内置 `claude` 适配器这些都会上报;内置 `codex` 只上报 token
(它的 `turn.completed` 事件不带美元花费,ODW 也不自行编造价格),所以 codex agent 只显示
token、不显示花费。CLI 不上报输出 token 时
(文本模式的适配器),ODW 按回复的 `ceil(字符数 / 4)` 计数,并把这个数标记为
`estimated`(估算)。

```text
$ odw status $RUN
20261017-101500-ab12cd  [done]  review-swarm
  dispatched: 9 agent(s)
  usage: 1.4M tokens in (1.2M cache read, 96k cache write) · ~50k out · $2.867 (estimated in part: 1 of 9 agents reported no output tokens)
  spend by phase (share of tokens):
    01  Scan    6 agents  1.1M  $2.100  78%  ███████████████▋
    02  Verify  2 agents  296k  $0.767  21%  ████▎
    03  Report  1 agent   10k~       —  <1%  ▏
    not every agent reported dollars, so shares are of tokens
    ~ partly estimated: a CLI that reports no count is measured as characters / 4
```

- `odw status` 按阶段拆分花费 —— 即看板花费清单(spend receipt)的文本版:按工作流声明的
  顺序每个阶段一行(尚未开始的会注明),最后是不属于任何阶段的 agent;每行给出 agent 数、
  token、花费、占比,以及一条 Unicode 方块组成的占比条(没有 UTF-8 locale 时用 `#`)。
  当每个有花费的 agent 都报了美元时,占比按美元计算,否则按 token。整块不超过 100 列,
  在 `NO_COLOR` 下或输出到管道时为纯文本。
- 当列出的运行中有任何一个报了美元时,`odw list` 会多出一列花费(没有花费的运行显示 `—`)。
- 实时视图的汇总行显示输出 token(也就是 `--budget` 所计的数)和累计花费;每个已结束
  agent 的那一行显示它自己的花费。
- `GET /api/runs` 和 `GET /api/runs/:id` 以 `usage` 给出运行的合计(有 agent 的输出
  token 是估算时带 `estimated: true`),`/api/runs/:id` 还给出每个 agent 自己的用量。
- `budget.spent()` 用同样的方式计算输出 token:CLI 给了计数就用它的计数。
- 单次 `parallel()` 或 `pipeline()` 调用扇出的任务或条目超过 `fanOutWarn`(默认 25;
  `0` 或 `null` 关闭)时,会记一条带数量的警告——
  `large fan-out: parallel() starts 40 tasks (over fanOutWarn: 25) — …`——然后照常运行。

适配器在自己的 `output` 里声明 CLI 在哪里上报用量;见[配置适配器](adapters-and-models.md#配置适配器)。

## 运行前先知道花费(ODW 扩展)

运行会边跑边告诉你花了多少;`odw estimate` 在开跑之前就告诉你大概会花多少——依据同一
工作流以往运行的实际花费,绝不凭空猜测:

```text
$ odw estimate review-swarm --args '{"dir":"src"}'
estimate for review-swarm (5 runs, matched by source)
                  agents  time p50 / p90  cost p50 / p90   out tokens p50 / p90
  total           9–11    6:20 / 7:00     $2.620 / $3.400  43k / 54k
  phase Plan      1       50.0s / 1:00    $0.140 / $0.160  2.1k / 2.1k
  phase Review    7–9     3:13 / 3:47     $2.380 / $3.150  38k / 49k
  phase Report    1       36.0s / 42.0s   $0.090 / $0.090  3.0k / 3.0k
  adapter claude  9–11    5:36 / 5:42     $2.620 / $3.400  43k / 54k
  · based on the last 5 finished runs of this exact source
  · it assumes similar args: fan-outs as wide as in those runs (agents per phase)
  · none of those runs had these args
```

- 它读取该工作流最近 20 次已完成(`done`)的运行——不含 resume 出来的运行,它们重放的
  agent 不花钱——有完全相同源码(`meta.sourceHash`)的运行时只用这些,否则用同名工作流
  的运行,并说明是哪一种。一次都没有时输出 `no estimate: no finished runs of this workflow yet`。
- 对整次运行、每个阶段、每个适配器:墙钟时间、花费、token 和启动的 agent 数的中位数和
  第 90 百分位。扇出宽度按那些运行里的实际宽度计;带 `--args` 时会说明其中多少次参数相同。
- `odw estimate <wf> --json` 给脚本用;`GET /api/estimate?workflow=<名称>` 提供同样的数据
  (`&sourceHash=<sha256>`;不给时按最新一次运行的源码匹配)。
- `odw run <wf> --estimate` 先打印估算,在终端上再问 `start the run? [y/N]`;`--yes` 不问
  直接开跑。没有终端又没给 `--yes` 时不会开跑。

**运行中。** 在宽度不小于 `fanOutWarn`、或受成本闸门约束的 `parallel()` / `pipeline()` 之前,
运行会记一条预测:宽度 × 以往运行中同一阶段 agent 花费的中位数(单个 `agent()` 则取同一标签
前缀的 agent),并附 p90——`cost forecast: parallel() of 40 tasks in phase "Review" ~$12.40
(p90 $18.00) — …`。`pipeline()` 按每个条目每个阶段一个 agent 计。

**`costGate`。** 配置里写 `"costGate": { "usd": 5 }`——或 `parallel(thunks, { costGate: { usd: 5 } })`,
或对单个 agent 用 `agent(prompt, { costGate: { usd: 1 } })`——预测超过闸门的扇出会先变成一个
checkpoint:

```js
try {
  await parallel(files.map((f) => () => agent(`Review ${f}`, { label: `review-${f}` })))
} catch (e) {
  if (e.name !== 'CostGateRejected') throw e
  log('review skipped: ' + e.message)   // 对方拒绝了;运行继续
}
```

这个 checkpoint——`This fan-out is forecast to cost ~$12.40 (p90 $18.00) — go?`,payload 为
`{ width, forecast }`——和其他 checkpoint 一样作答:`odw approve|reject`、仪表盘,或
[手机批准链接](dashboard.md#在手机上批准odw-扩展)。拒绝会抛出脚本可以捕获的 `CostGateRejected`。在某个
`parallel()` 上写 `costGate: null` 可为这次调用取消该设置。没有历史时闸门放行所有扇出,并在
每次运行中只记一次。`costGate` 记录在运行的 setup 里,供 `odw compare` 使用。

## 卡死看门狗

**ODW 扩展。** 一个卡住的 agent CLI 原本会一直占着并发槽位,直到 `timeout`(默认 30
分钟)。设置 `stallTimeout` 后,若某个 agent 的 stdout *和* stderr 连续这么多秒都没有
任何输出,ODW 会像超时一样杀掉它(连同整个进程组),再用同一个 prompt 重新启动,每次
`agent()` 调用最多重启 `stallRestarts` 次(默认 1)。每次重启都会记一条日志
(`search:3 went quiet for 120s — restarting (1/1)`);用完重启次数后,这次调用失败,
错误信息会说明 agent 卡死(stalled)。停止、暂停或预算上限永远优先于重启。

**笔记本睡眠不算卡死。** 静默时长按单调时钟计算,机器睡眠时它不走;worker 还每 30 秒比较一次
墙钟与单调时钟——跳变超过一分钟(或检查比预期晚了这么久:虚拟机被暂停、worker 被停住)即视为
睡眠。此时所有运行中 agent 的静默计时清零,重新给一个完整的 `stallTimeout` 宽限,运行记一次
`host_suspended` 事件(`{ sleptSeconds, message }`)。合盖期间连接断开的 agent 会以 `network`
失败并被重试(见[限流、额度与登录](#限流额度与登录))。ODW 不阻止机器睡眠——合盖照样会睡。

```jsonc
{
  "stallTimeout": 120, // 静默的秒数;null(默认)= 关闭
  "stallRestarts": 1,
  "adapters": {
    // 按适配器设置:覆盖运行级的值;0 表示对这个适配器关闭看门狗
    "my_wrapper": { "command": ["my-agent", "--stream", "{prompt}"], "stallTimeout": 300 }
  }
}
```

看门狗**对所有内置适配器默认关闭**:有些 CLI——文本模式的那些(`gemini`、`qwen`、
`kimi`……)——在结束前什么都不输出,任何卡死超时都会误杀正常工作。请只对会流式输出进度
的适配器启用:`claude`(它的 stream-json 每一轮都会输出一个事件,所以现在可以放心对它
启用)、`codex`(`exec --json` 每条命令、每次编辑、每条消息都输出一个事件)、`kilo`、
`opencode` 和 `agy`(每一步一个事件)这类 JSONL 适配器,或会打印心跳的包装脚本;并把值设得高于
健康 agent 最长的静默时段——工具调用里跑一轮很长的测试,同样不会有任何输出。

**单个 agent 的窗口**(Claude Code 方言):`agent(prompt, { stallMs: 1800000 })` 为这一次调用
单独设定卡死窗口(毫秒,此处为 30 分钟),取代其适配器和整个运行的 `stallTimeout`,重启次数
(`stallRestarts`)与失败方式(原因 `"stalled"`)不变。没有设置 `stallTimeout` 时它同样生效,
因此长扇出可以给慢的审查者更宽的窗口、给快的更窄;`stallMs: 0` 关闭这一次调用的看门狗。

## 单 agent 上限与死循环(ODW 扩展)

陷入循环的 agent 一直在输出,所以卡死看门狗永远不会触发;而 `--budget` 限制的是整个运行,
不是单个 agent。`limits` 限制的是一次 `agent()` 调用:

```js
await agent("修好失败的测试", {
  limits: { toolCalls: 200, costUsd: 3, outputTokens: 200000, seconds: 1800, repeat: 5 },
});
```

| 上限 | 何时触发 |
| --- | --- |
| `toolCalls` | agent 的工具调用次数(累计它的所有 CLI 运行)超过此值 |
| `costUsd` | 它的 CLI 报告的花费(美元)超过此值 |
| `outputTokens` | 它的 CLI 报告的输出 token 超过此值 |
| `seconds` | 从它第一次 CLI 运行开始已过去这么多秒 |
| `repeat` | 同一个工具调用——工具名加参数的哈希——**连续**出现这么多次(至少 2) |

这些上限**实时**执行,依据的是 CLI 运行时打印的内容:Claude Code 的 stream-json(tool_use
块与每条消息的用量;花费随最后的 `result` 到来)、Codex 的 `exec --json`(命令、文件改动、
MCP 与网页搜索条目;每一轮的用量)、kilo 和 opencode 的事件(工具调用;每一步的 token
与花费),以及 agy 的 stream-json(工具步骤;每一步的 token)。一旦越界,ODW 会像卡死一样立即杀掉该 agent 的 CLI 及其启动的所有进程,agent 以
`runaway` 失败:`agent_failed` 事件带有 `limitHit: { limit, max, value, evidence }`,错误
信息形如 ``adapter 'claude' ran away — limits.repeat=5: Bash `npm test` ×5 in a row``
(或 `41 tool calls > 40`、`$3.12 > $3.00`)。`runaway` 不会被 `transientRetries` 重试,在
`expect` 下也不算需要重跑的未达标——它的额度已经用完。`odw status` 列出失控的 agent 及证据,
`odw agents` 在值的位置显示证据,看板侧栏显示该 agent 的上限并标出触发的那一项。

`repeat` 统计的是**连续**调用,而不是「最近 2n 次中出现 n 次」:后者在健康的编辑—测试循环
(`npm test`、编辑、`npm test`、编辑……)上也会触发;而同样参数的同一调用接连出现,说明
agent 在两次之间做的事不可能改变结果。同一次调用的后续 CLI 运行(重试、重启)重新计数。

可以在配置中为所有 agent 设默认值,也可以按适配器设置;调用自己的 `limits` 逐键覆盖两者,
`null` 取消继承来的某项上限:

```jsonc
{
  "agentLimits": { "toolCalls": 300, "repeat": 6 },   // {}(默认)= 不设上限
  "adapters": {
    "codex": { "agentLimits": { "seconds": 1800, "repeat": null } }
  }
}
```

只输出文本的 CLI(`gemini`、`qwen`……)运行期间不报告用量:它们的 `outputTokens` 与
`costUsd` 只能在每次运行结束后检查,依据它报告的用量或回复字符数 / 4——运行日志会提示一次。
完全不报告美元花费的 CLI(Codex)无法触发 `costUsd`,日志同样提示一次——请改用 `outputTokens`。

## 限流、额度与登录

**ODW 扩展。** 每个失败的 agent 都会根据其 CLI 的退出状态和输出末尾被归类:`rate_limit`、
`quota`、`auth`、`timeout`、`stalled`、`not_found`(CLI 无法启动)、`permission`(工具
调用或审批被拒)、`network`(与模型 API 的连接断开)、`model_unavailable`(请求的模型未知、已下线或该账号不可用)或
`exit`——另有四个类别,给"成功了"却拿不出证据的运行:`empty_reply`、
`unmet_expectation`、`"mcpFailures": "fail"` 下的 `mcp_unavailable`,以及
`orphaned_background`(回复时仍有后台任务在运行,`"orphanedBackground": "fail"` 或设了
`expect` 时)(见[检查 agent 的工作](../reference/workflow-api.md#检查-agent-的工作odw-扩展));`out_of_scope`:
`"scopePolicy": "fail"` 下改动了声明范围之外文件的 agent(见[声明范围](../reference/workflow-api.md#声明范围odw-扩展));`needs_input`:停下来提问却没人回答的 agent(见[agent 的提问](checkpoints-and-questions.md#agent-的提问odw-扩展));`model_substituted`:`"modelMismatch": "fail"` 下 CLI 报告由其他模型服务的 agent(见[实际服务 agent 的模型](running-and-observing.md#实际服务-agent-的模型odw-扩展));还有 `runaway`:触及[上限](#单-agent-上限与死循环odw-扩展)被杀掉的 agent。这个类别就是 `agent_failed` 事件上的 `reason`(CLI 说明了何时
可以重试时,还带有以秒计的 `retryAfter`),也是看板和 `/api/runs/:id` 里该 agent 的
`failureReason`,并显示在实时视图和 `odw logs` 中:

```text
agent_failed    (Search) search — [quota, retry after 3h 22m] AdapterExecutionError: adapter 'codex' ran out of usage quota — wait for the window to reset (in 3h 22m) and resume the run, or switch adapter with --adapter <name>: You've hit your usage limit…
```

- **限流**——HTTP 429/529、"too many requests"、"overloaded"、Gemini 的
  `RESOURCE_EXHAUSTED`——会被扛过去:ODW 先等待,再重新运行这个 agent,每次 `agent()`
  调用最多 `transientRetries` 次(默认 3)。等待时长取 CLI 打印的 retry-after
  (`Retry-After: 30`、"try again in 2 minutes"、"resets at 7:10pm"),否则按指数退避
  (15s、30s、60s……),再加最多 20% 的随机抖动,且单次绝不超过 `maxBackoff` 秒(默认
  300);CLI 要求等得比这更久时,不会提前重试。每次等待都会记一条日志
  (`search:3 hit a rate limit on codex — retrying in 45s (2/3)`);停止会立刻结束等待,
  暂停的运行要等恢复后才开始重试。
- **连接断开**——Node 的 `ECONNRESET`、`ENOTFOUND`、`EAI_AGAIN`、`ETIMEDOUT`、"fetch failed"、
  "socket hang up"、"network error",Claude Code 的 "API Error: Connection error.",Codex 的
  "error sending request for url"——归为 `network`(ODW 扩展),与限流一样被扛过去:同样的退避,
  每次调用单独计 `transientRetries` 次,日志为 `search:3 lost its connection on claude — retrying
  in 15s (1/3)`。只看输出的最后几行,agent 自己跑的测试连不上端口不会被误判。它不会降低适配器的
  自适应并发上限。
- **额度用尽和登录失败**从不重试。错误信息会说明该怎么做——等额度窗口重置、登录该 CLI,
  或用 `--adapter` 换一个适配器——运行本身继续,因为其他适配器可能完全正常。同一个适配器
  上连续三个 agent 都这样失败时,运行会记一条警告;之后用 `odw resume` 会重放所有已完成
  的 agent。一分钟内就会恢复的"额度"(Gemini 免费档就是这样描述它的每分钟限额的)按它
  实际上的限流来处理。配置了[回退链](adapters-and-models.md#按阶段路由与回退链odw-扩展)时,agent 会换到下一个
  CLI;同一适配器连续三次额度失败后,本次运行之后的 agent 会跳过它。开启
  [`quotaWait`](#额度用尽时暂停odw-扩展) 后,没有 CLI 可换的 agent 会等额度重置,而不是失败。
- **不存在的模型**——CLI 不认识、已下线或该账号不可用("There's an issue with the selected
  model"、"The model `x` does not exist or you do not have access to it"、Gemini 的
  "models/x is not found for API version"、`ModelNotFoundError`、agy 的 "invalid model
  selection"、Cursor 的 "Cannot use this model")——归为 `model_unavailable`:从不重试,并像额度
  用尽一样让 agent 沿回退链换到下一个适配器。只看运行输出的最后几行,所以 agent 自己的工作里
  打印的 "model not found" 不会被误判。`odw doctor --models` 检查配置的 `models` 档位、
  `fallback` 链、默认适配器和 `.odw/workflows` 各阶段提到的每个模型,各发一条极短的提示,
  逐个报告 `ok`、`model_unavailable` 或 `other`。

Claude Code 会在输出里报告这类错误,而且常常以 0 退出:它的 stream-json `result` 事件
带着 `is_error: true` 和错误消息(`API Error: Rate limit reached`、
`Claude AI usage limit reached|…`),这会被算作消息所指的那种失败。Codex 的 `turn.failed`
与 `error` 事件同样如此(`Quota exceeded. Check your plan and billing details.`、
`exceeded retry limit, last status: 429 Too Many Requests`)——它自己重试过、随后这一轮
正常完成的 `error` 除外。在文本模式下(文本
适配器,或回退到原始 stdout 的 JSON 输出),一条简短、内容只有这类限流、额度或登录错误
的回复同样会被算作对应的失败——绝不会被当成 agent 的答案。空回复算作 `empty_reply` 失败,
不重试。声称成功、但 `permission_denials` 列出了被无头模式拒绝的工具调用的 `result` 照常
成立,这些调用被记录并写入日志——只有在 `"permissionDenials": "fail"` 下,或调用设了
`expect` 时,才算作 `permission` 失败并列出它们。

ODW 能识别的措辞——从每个内置 CLI 的源码和 issue 中收集而来——集中在一张表里:
[`src/adapters/failures.ts`](../../../src/adapters/failures.ts)。用适配器的 `failures` 教它
认识你自己 CLI 的措辞:按类别给出正则表达式,先于内置表、不区分大小写地匹配。

```jsonc
{
  "transientRetries": 3, // 限流后(连接断开另计)每次 agent() 调用的重试次数;0 = 从不重试
  "maxBackoff": 300, // 单次等待的最长秒数
  "adapters": {
    "my_wrapper": {
      "command": ["my-agent", "{prompt}"],
      "failures": {
        "rate_limit": ["server busy", "E_THROTTLED"],
        "quota": ["monthly tokens? (used up|exhausted)"],
        "auth": ["session expired"],
        "model_unavailable": ["no such model"],
        "network": ["E_OFFLINE"]
      }
    }
  }
}
```

## 额度用尽时暂停(ODW 扩展)

**ODW 扩展。** 一个长时间运行的 workflow,如果所有可用的 CLI 都用完了额度,剩下的 agent
都会失败——有额度熔断时还失败得很快。通宵跑的时候,你更希望它等到额度重置再接着跑。
`quotaWait` 就是做这个的:

```jsonc
{
  "quotaWait": { "max": 21600 } // 最多等 6 小时让用尽的额度重置;false(默认)则如上直接失败
}
```

当一个 agent 因额度用尽而无 CLI 可用——链上最后一个适配器额度失败,或额度熔断跳过了每一个
——且某个 CLI 说明了额度何时重置("try again in 3h 22m"、"resets 7pm"、Claude Code 的
`usage limit reached|<epoch>`)、距今不超过 `max` 秒时,运行会**暂停**而不是让它失败:

- 这个 agent 等待时不占任何槽位,所以还有额度的 CLI 上的 agent 照常运行。在 CLI 报出的
  重置时间之前,运行会跳过那个 CLI:有回退链的 agent 换下一个,无处可去的 agent 也一起
  等——而且是在启动之前等,所以等待期间既不显示为 agent,也不占槽位。
- 运行显示为 `paused` 并写明在等什么:`odw status`、`odw list` 和实时视图显示
  `paused until 19:10 (codex quota)`,`odw run --wait` 会提示一次;`status.json` 与
  `GET /api/runs[/:id]` 带有 `pausedFor: { "reason": "quota", "adapter", "resumeAt" }`
  (`resumeAt` 为 Unix 秒)。
- 到了重置时间——再加最多 30 秒随机抖动,免得等待的 agent 在同一秒全部回来——每个 agent
  都从它的链首重新开始,额度熔断也会忘掉这个 CLI。`odw resume <run>` 立即继续;
  `odw stop` 照常停止运行。期间可以同时有 `checkpoint()` 在等待。
- 没有给出重置时间的额度失败,或重置时间超过 `max` 的,仍按上文直接失败,运行日志会说明
  原因(`quotaWait: not waiting — codex did not say when its quota resets, so the agent fails`)。
- 暂停从不触发运行结束的 hook;在 [`notify.on`](notifications.md#运行通知) 里加上 `"paused"`,即可在
  每次暂停时收到通知。

```text
quota pause: codex is out of usage quota until 19:10 (in 3h 22m) — its agents wait, holding no slot, and go on then (quotaWait); odw resume goes on now
search:3 waits for codex's quota to reset (quotaWait)
quota pause over: codex's quota reset — its agents go on
search:3 goes on after the quota wait, on codex
```

默认关闭,因为一个悄无声息地等上几个小时的运行,会让没有主动要求的人感到意外。等待发生在
worker 进程里:worker 死掉时,运行会变成 `stale`,`odw resume` 会像对待任何已结束的运行
一样重放它——已完成的 agent 直接取回结果,不会再跑一遍。

## 按适配器限制并发与错开扇出

**ODW 扩展。** `concurrency` 限制一次运行同时有多少个 agent;适配器自己的 `concurrency`
限制其中最多有多少个跑在这个 CLI 上——于是 16 个 codex 调用的扇出每次只跑 4 个,运行
剩下的槽位留给其他适配器。一个 agent 需要一个运行槽位和一个该适配器的槽位,两者同时
发放:它绝不会占着一个去等另一个;每个适配器的 agent 先到先得地排队,空出的运行槽位
交给最早到达、且其适配器还有余量的 agent,因此一个被限住的适配器不会挡住其他适配器。
`odw doctor` 会列出这些上限,`odw run` 也会在启动横幅里、权限那一行下面写明
(`concurrency: 8 agents at once · per adapter: codex 4`)。

```jsonc
{
  "concurrency": 8,
  "adaptiveConcurrency": true, // 默认值;false 让所有上限保持不变
  "staggerFanOut": { "first": 1, "delayMs": 2500 }, // 默认值;false 关闭
  "adapters": {
    "my_wrapper": {
      "command": ["my-agent", "--cwd", "{workspace}", "--prompt-file", "{prompt_file}"],
      "concurrency": 4 // 在运行的 8 个之内,同时最多 4 个
    }
  }
}
```

给内置适配器设上限时,只写要改的字段即可——`"codex": { "concurrency": 4 }` 会保留 codex
原有的命令和参数(不写 `command` 的条目是在内置适配器上做调整;写了 `command` 才会整个替换)。

**自适应降速。** 某个适配器撞上限流时——有 agent 即将退避等待,或有 agent 以
`rate_limit` 失败——它的上限在本次运行余下的时间里减半,最低为 1(没有自己上限的适配器
从运行级上限开始算);此后每过一分钟没有再被限流,就还回一个槽位。同一批扇出一起撞上
限流时,上限只减一次,而不是每个 agent 减一次。已经在跑的 agent 保留它们的槽位——被限流
的 agent 原地等待退避——所以降低后的上限约束的是接下来启动的 agent。减半,以及让上限完全
恢复的那一个槽位,都会记日志:

```text
adaptive concurrency: codex hit a rate limit — at most 4 of its agents at once now (was 8); one slot comes back for each minute without another
adaptive concurrency: no rate limit on codex for 4m — back to 8 of its agents at once
```

**为提示缓存错开扇出。** 内置 `claude` 适配器背后的 Anthropic API 会缓存提示的前缀:第一个
发送它的请求写入缓存,之后的请求只需很小一部分费用即可读取——但前提是第一个请求已经被读完。
所有 agent 同时启动的扇出,每个 agent 都要为完整前缀付费。因此在一次 `parallel()` 或
`pipeline()` 调用中,运行在声明了 `"promptCache": true` 的适配器上(内置 `claude` 就是)、
且提示的前 1,024 个字符相同的 agent,每次先启动 `first` 个;其余的在第一个 agent 的 CLI
产生输出后启动——对 `claude` 这样的 JSONL 适配器而言,是它越过 CLI 启动时那些 `system`
事件之后的第一个事件——或在 `delayMs` 之后启动,以先到者为准。把共享的说明
放在前面、每项不同的部分放在最后,就能从中受益。单独的 agent、提示更短或不同(或用了别的
模型、别的角色)的 agent,以及重放的 agent 从不等待;等待中的 agent 不占任何槽位,停止会
立刻结束等待。每次错开的扇出记一行日志:

```text
staggered fan-out: 15 claude agents sharing a 3412-character prompt prefix waited 2.1s while the first warmed the prompt cache, until it produced output
```

如果你自己的适配器所用的 CLI 连接的是会缓存提示的 API,就给它声明 `"promptCache": true`;
自己写了 `command` 的 `claude` 条目也要声明,因为它会替换内置的那个(只写部分字段的条目,
例如 `"claude": { "concurrency": 4 }`,会保留内置设置)。
