# 原语参考

<sub>[English](../../references/primitives.md) · 简体中文</sub>

原语是 workflow 脚本里的**注入的全局**——绝不 import。脚本体运行在 async 上下文里（顶层
`await` 和顶层 `return` 都合法），`meta` 在最顶部用 `export const meta` 声明
（`meta.name` 和 `meta.description` 必填；文件里不得出现任何其他顶层
`import`/`export`）。

ODW 支持这些核心工作流约定，不承诺与 Claude 的完整运行时等价。迁移共享工作流时，
也需要核对下文的执行、校验和恢复边界。

## agent

```js
agent(prompt, opts?) -> Promise<unknown>
```

让一个 coding agent 跑 `prompt`。唯一真正干活的原语；其它原语都只是在组织对它的调用。

- **opts.schema** —— 一个 JSON Schema 对象。给了它，回复就会被解析并校验，并带着纠正反馈
  重试 agent，直到符合契约或重试预算耗尽（届时这次调用抛错）。不给，则返回原始回复文本。
  schema 里 ODW 检查不了的内容会记入运行日志（设 `"schemaKeywords": "strict"` 时则让调用在
  启动前失败）；会校验 schema 的 CLI 直接原生拿到它——见 [schema](#schema)。
- **opts.label** —— 进度显示用的短名字。
- **opts.phase** —— 为这一次调用覆盖当前 phase。在 `parallel`/`pipeline` 里优先用它，那里
  全局 phase 是共享的。
- **opts.adapter** —— 用哪个配置好的 CLI（如 `"codex"`）；默认先用阶段的适配器（见下文），
  再用配置里的 `defaultAdapter`。**ODW 扩展：** 写成列表 `["codex", "claude"]` 就是按偏好
  排序的回退链——见[路由](#路由阶段默认值模型分层回退链odw-扩展)。
- **opts.model** —— 一个 model id，通过 adapter 的 `{model}` 模板占位符或
  `flags.model`（如 `claude --model …`）转发。两者都没有时，使用 CLI 自己的默认模型，
  并记录该选项被忽略的路由说明。model id 不能跨 CLI 通用。**ODW 扩展：** `"@fast"`
  指定一个模型层级——各 CLI 用自己在该层级下的 ID——阶段也可以给出默认模型；`meta.model`
  仍只是元数据。
- **opts.agentType** —— 子 agent 定义的名字（**ODW 扩展**）：带 YAML 前言的 Markdown，按前言 `name`
  依次在工作目录到仓库根的 `.claude/agents/`（最近者胜）、`.odw/agents/`、`~/.claude/agents/`、
  已启用插件的 `agents/`（`<plugin>:<name>`）中查找。正文作为人设提示词（所有 CLI）；`model` 是该调用的默认模型
  （`opts.model` 优先；非 claude 的 CLI 上别名经同名 `models` 层级映射，映射不到用 CLI 默认模型并记日志）；
  `tools`/`disallowedTools` 给权限档位封顶（只有只读工具 → `read`，不含 Bash → `edit`；只降不升），并以
  `--tools`（只收窄）和 `--disallowedTools` 传给 `claude`；`isolation: worktree` 隔离该 agent；`effort` 传给
  `claude --effort` / `codex -c model_reasoning_effort=`。其他字段（`permissionMode`、`maxTurns`、`mcpServers`、
  `hooks`、`skills` 等）记为未生效。`--untrusted` 运行中仓库内的定义只取正文、tools 与 isolation。找不到定义时是一句话人设并记日志。
  它**不是** adapter 名，永远不影响 adapter 选择——只有 `opts.adapter` 才会。`odw agents types` 列出定义及其映射。
- **opts.isolation** —— `"worktree"` 给这个 agent 一个一次性 **git worktree**（默认工作区
  就是 source 目录本身）。要求 source 是有提交的 git 仓库；agent 看到 HEAD，不包含
  未提交改动。调用结束后清理 worktree，不把改动合入 source。`agent()` 只返回回复，
  不返回 diff 或可保留的 worktree 路径；运行会把 agent 的改动保存为 diff，供审阅和应用
  ——见[保存的改动](#隔离-agent-的改动odw-扩展)。agent 启动前，`.worktreeinclude` 会补上
  检出缺少的文件（`.env`、`node_modules` 等），然后运行 `worktreeSetup`——见
  [隔离 worktree](#隔离-worktree-与-agent-环境)。
- **opts.keep**（**ODW 扩展**）—— 配合 `isolation: "worktree"`，还会把 agent 的改动提交到
  源仓库的分支 `odw/<runId>/<agentId>-<label>`。`false` 让单个 agent 不受 `keepBranches`
  设置影响。没有隔离时会被忽略（并记一行日志）；Claude Code 会忽略它。
- **opts.permissions**（**ODW 扩展**）—— `"read"`、`"edit"` 或 `"full"`：让这个 agent 以比
  运行（配置里的 `"permissions"`、`odw run --permissions`）更严格的权限档位运行。调研和审查
  类 agent 请用 `"read"`：它们能看，不能改文件、不能跑命令。它只能降低档位（read < edit <
  full）——请求更高档位会让调用以 `AgentError` 失败，报错写明两个档位——没有只读模式的适配器会
  拒绝 `"read"`（调用在 CLI 启动前失败；`claude`、`codex` 和 `gemini` 有只读模式）。见
  [适配器](adapters.md#权限每个内置适配器能做什么)。Claude Code 会忽略它。
- **opts.sandbox**（**ODW 扩展**）—— 让这个 agent 的 CLI 在容器中运行，或在比运行与适配器更严格的容器中运行：`"container"`，或 `{ network: "none" | { allow: [...] }, memory, cpus, pids, cliConfig: "none", image }`（只有别处都没设镜像时才能给 `image`；`allow` 列表与沙箱自己的取交集）。只能收紧——容器下的 `"none"`、沙箱没有的网络、更高的限制或换镜像都会让调用在启动前失败。见 [adapters](adapters.md)。不计入 resume key。Claude Code 会忽略它。
- **opts.limits**（**ODW 扩展**）—— 这个 agent 被当作失控杀掉之前能做多少：`{ toolCalls?, costUsd?, outputTokens?, seconds?, repeat? }`——累计所有 CLI 运行的工具调用次数、CLI 报告的美元花费与输出 token、从第一次 CLI 运行起的秒数，以及同一工具调用（工具名 + 参数哈希）**连续**出现 `repeat` 次。逐键覆盖适配器与运行级的 `agentLimits`，`null` 取消某项。从 claude、codex、kilo、opencode 的输出实时执行（文本 CLI 的花费只能在每次运行后检查）；越界立即杀掉 CLI 并抛出可恢复的错误，`reason: "runaway"`，事件上的 `limitHit: { limit, max, value, evidence }` 写明证据（``Bash `npm test` ×5 in a row``）。不会重试，也不算 `expect` 未达标。格式错误的值在任何东西运行前抛出 `AgentError`。不计入 resume key。Claude Code 会忽略它。
- **opts.expect**（**ODW 扩展**）—— agent 回复之后必须成立的条件，由 odw 检查：
  `{ changes?, files?, command?, match?, timeout? }`。见 [expect](#expectodw-扩展)。
  Claude Code 会忽略它。
- **opts.expectRetries**（**ODW 扩展**）—— 没达到 `expect` 的工作带着缺失项重跑的次数
  （默认取 `expectRetries` 设置，即 1）。
- **opts.allowEmpty**（**ODW 扩展**）—— 接受空回复或只有空白的回复作为答案。不设时，空回复
  会让调用以 `"empty_reply"` 失败。（CLI 拒绝工具调用默认不会让调用失败：它们会记为
  `denied`——见 [expect](#expectodw-扩展)。）
- **opts.notes**（**ODW 扩展**）—— `true`：该 agent 使用本次运行的笔记板（提示词里有已有的笔记，
  `ODW_NOTES` 用来发布和读取笔记，隔离 agent 完成时广播其保留改动）；`false` 让它退出所在
  `parallel()` 或 `notes` 设置的笔记板。见 [notes](#notesodw-扩展)。Claude Code 会忽略它。
- **opts.memory**（**ODW 扩展**）—— `true`：该 agent 在任务之前看到工作流仍然适用的记忆，它被重试补上的
  `expect` 未达项作为教训保留；`false` 让它退出 `memory` 设置。见 [memory](#memoryodw-扩展)。
  Claude Code 会忽略它。
- **opts.handoff**（**ODW 扩展**）—— `true`：回退把调用移到下一个适配器时交接工作，而不是从头
  再来；`false` 无论 `fallback.handoff` 设置如何都从头再来。见[路由](#路由阶段默认值模型分层回退链odw-扩展)。
  Claude Code 会忽略它。
- **opts.scope**（**ODW 扩展**）—— agent 打算改动的文件的 glob（相对工作区，规则同
  `expect.files`）：范围与仍在途的更早调用重叠时先等它结束；范围之外的改动记为 `outOfScope`。
  见 [scope](#scopeodw-扩展)。Claude Code 会忽略它。
- **opts.scopePolicy**（**ODW 扩展**）—— `"warn"`（默认：`scopePolicy` 设置）或 `"fail"`：
  越出 `scope` 的写入如何处理。需要同时设 `scope`。
- **opts.questions**（**ODW 扩展**）—— agent 停下来向用户提问（CLI 的澄清工具调用：Claude
  Code 的 `AskUserQuestion`）时怎么办。无论哪种，CLI 都在提问处被停下。`"checkpoint"`（默认：
  适配器的设置，否则 `questions` 设置）在检查点上问人（`checkpoint_requested` 带
  `question: { agentId, label, adapter, questions }`），然后重新运行这个调用——隔离时复用同一个
  worktree——提示词附上"Earlier in this task you stopped to ask the user: … The user answered: …"
  （答案取批准时的 note，否则取编辑后 payload 的 `answer`）；被拒绝，或第四次提问，以
  `needs_input` 抛错。`"fail"` 立即以 `needs_input` 抛错；`"deny"` 让 CLI 不带提问工具运行
  （适配器的 `questionArgs`）并告诉 agent 自行假设。`needs_input` 失败带着问题列表
  （`agent_failed` 的 `questions`）。Claude Code 会忽略它。
- **opts.stallMs**（Claude Code 方言）—— 这个 agent 的卡死窗口，单位毫秒：
  `agent(prompt, { stallMs: 1800000 })` 让它的 CLI 可以 30 分钟没有输出，超过后卡死看门狗将其终止并
  重启（`stallRestarts`，默认 1 次），之后调用以 `stalled` 原因抛错。它取代适配器和整个运行的
  `stallTimeout`，没有设置 `stallTimeout` 时同样生效；`0` 关闭这一次调用的看门狗（ODW 的解释）。
  不是非负数时，在 agent 启动前抛错。

返回回复文本，设了 `schema` 则返回校验过的 JSON 值。CLI 出错、schema 重试耗尽、工作没达到
`expect`、空回复都会抛错；这些可恢复失败在 `parallel`/`pipeline` 内变成 `null`。停止请求、
预算耗尽和 agent 总量上限以及无效的 adapter/运行配置属于 fatal 错误，会继续向上抛出并终止
运行。失败的 CLI 运行抛出的错误带有 `reason`（`rate_limit`、`quota`、`auth`、`timeout`、
`stalled`、`not_found`、`permission`、`exit`、`empty_reply`、`unmet_expectation` 或 `needs_input`），与它的
`agent_failed` 事件一致——可以在 `try`/`catch` 里据此分支。

每次完成的调用都会在发出 `agent_finished` 事件之前保存到运行目录
（`agents/<agentId>.json`），所以某条泳道卡住、运行被停止或 worker 死掉，已完成的
结果都不会丢。运行仍在进行时就可以用 `odw result <run> --agent <id|label>` 读取，
或用 `odw agents <run>` 列出全部（ODW 扩展）。`odw resume` 会重放已保存的调用——见
[resume](#resumeodw-扩展)。

## parallel

```js
parallel(thunks: Array<() => Promise<T>>) -> Promise<Array<T | null>>
```

并发执行每个零参 thunk，并**等它们全部完成**（屏障）。结果按输入顺序返回；可恢复失败
在对应槽位给出 `null`。全部 thunk 结束后，若有 fatal 错误则重新抛出。屏障不会强杀
已经运行的 agent。

当下一步需要**一整批**结果一次到位时用 `parallel`——去重、计票，或对所有结果做一遍
综合。

```js
const votes = await parallel(
  Array.from({ length: 5 }, () => () => agent('Is X true? yes/no')),
)
const yes = votes.filter((v) => v && v.toLowerCase().startsWith('yes')).length
```

每个 thunk 必须是零参——用 `.map((x) => () => agent(...))` 来构造，这样每个都捕获自己的值。

**ODW 扩展：** `parallel(thunks, { notes: true })` 为其 thunk 启动的每个 agent 打开本次运行的
笔记板（agent 自己的 `notes: false` 优先）；只有 `notes` 和 `costGate` 两个选项，其他键会抛错。见
[notes](#notesodw-扩展)。Claude Code 的 `parallel()` 只接受 thunk 数组。

**ODW 扩展——花费预测与 `costGate`。** 在宽度不小于 `fanOutWarn`、或受成本闸门约束的
`parallel()` / `pipeline()` 之前，运行会依据同一工作流以往已完成的运行（有相同源码的就只用
这些，否则按同名）记一条预测：宽度 × 该阶段 agent 花费的中位数，并附 p90（`cost forecast:
parallel() of 40 tasks in phase "Review" ~$12.40 (p90 $18.00) — …`；`pipeline()` 按条目数 × 阶段数
计 agent）。设了闸门——`costGate` 设置 `{ usd }`，或 `parallel(thunks, { costGate: { usd } })`
（`costGate: null` 为这次调用取消设置）——预测超过 `usd` 时，在任何 agent 启动之前先变成
`checkpoint("This fan-out is forecast to cost ~$X (p90 $Y) — go?", { payload: { width, forecast } })`。
批准则照常运行；拒绝则该调用抛出可恢复的 `CostGateRejected`（看 `e.name`；`e.forecast`），脚本
可以捕获。`agent(prompt, { costGate: { usd } })` 为单个 agent 设闸门，依据同阶段、同标签前缀
（`review-3` → `review`）的 agent，没有则取整个阶段；resume 重放它时不会再问。没有历史时闸门
全部放行，每次运行只记一次。

```js
try {
  await parallel(files.map((f) => () => agent(`Review ${f}`)), { costGate: { usd: 5 } })
} catch (e) {
  if (e.name !== 'CostGateRejected') throw e
  log('review skipped: ' + e.message)
}
```

## pipeline

```js
pipeline(items, ...stages) -> Promise<unknown[]>
```

让每个条目**独立地**流过所有 stage——stage 之间没有屏障。条目 B 可以还在 stage 1，而条目
A 已经在 stage 3。这是多阶段处理的默认形态；它避免了屏障会带来的空等。

每个 stage 收到 `(previous, item, index)`——按需取用：

```js
const results = await pipeline(
  files,
  (file) => agent(`Review ${file}`, { schema: FINDINGS }),  // stage 1: (prev = item)
  (review, file) => ({ file, review }),                     // stage 2: (prev, item)
)
```

stage 的可恢复失败会把那个条目降为 `null` 并跳过它剩下的 stage；fatal 错误在正在执行的
各条处理链结束后继续向上抛出。只有一个 stage 的
`pipeline(items, stage)` 就是“把它并发地映射到各条目上”——当每一步自己又用 `parallel`
扇出时很顺手。

## phase / log

```js
phase(title, opts?)    // group following agent calls under a named phase
log(message)           // emit a one-line progress event
```

两者都只用于观测——`opts` 除外（见下文）。`phase` 设置一个运行级的全局当前 phase；在并发段落里改为给 `agent` 传
`{ phase }`，因为那个全局是共享的。

## 路由：阶段默认值、模型分层、回退链（ODW 扩展）

每个 agent 跑在哪个 CLI、用哪个模型，以及那个 CLI 接不了时去哪里。Claude Code 会忽略这些。

- **阶段默认值。** `meta.phases` 的条目 `{ title, adapter?, model? }`（纯字符串条目只是
  标题）为该阶段的 agent 指定适配器和模型；`phase(title, { adapter?, model? })` 为其后的
  agent 设置它们，取代该条目（只写 `phase(title)` 保留阶段已有的设置；传 `{}` 则清空）。
  `agent()` 调用自己给出的选项永远优先，调用自带的 `phase` 选项会带上那个阶段的默认值。
  `meta.phases` 里写错的 `adapter` 或 `model` 会让工作流加载失败（`validate()` 也会报出）；
  写错的 `phase()` 选项会抛错。
- **模型分层。** `model: "@fast"` 选用 `models` 设置为 agent 所在适配器给出的 ID——回退之后
  用下一个适配器的。该层级没给这个适配器 ID 时，使用其 CLI 的默认模型（记日志）；未知层级
  会让调用以 `AgentError` 失败并列出已有层级。不带 `@` 的模型（或含有层级名不允许的字符，
  如 `@cf/…`）就是模型 ID，原样传给每个适配器。
- **回退链。** `adapter: ["codex", "claude"]`，或调用所在适配器在 `fallback` 设置里的回退链：
  CLI 额度用尽、登录被拒或请求的模型不可用（`model_unavailable`：CLI 不认识、已下线或该账号
  不可用）时，调用会在下一个适配器上重新运行——全新的提示词、相同的选项，
  [`expect`](#expectodw-扩展) 检查也一样。限流仍在原地重试（`transientRetries`）；其他失败
  ——包括没达到 expect 检查——都算调用自己的。每次切换记一行日志
  （`search:3 → claude after codex quota`）；调用会在新适配器上取得槽位，先释放旧适配器的；
  它的 transcript 在一行 `{"kind":"attempt","reason":"fallback","adapter":"claude"}` 之后
  继续；失败的那些运行花掉的用量照样计入。回退时沿用调用自己的权限档位——不能恰好运行该档位
  的适配器会被跳过并记一行日志。`agent_finished` 和保存的结果会写明产出结果的适配器
  （`adapter`）和离开过的那些（`fellBackFrom`）；发生过回退的 `agent_failed` 也会写明。
- **交接。** 配置 `"fallback": { "handoff": true }` 或在调用上写 `handoff: true`（默认关闭）时，
  回退交接工作而不是从头再来：隔离调用的 worktree 保留下来，下一个适配器在其中运行，做了一半的
  改动原样在场（原地调用的改动本来就在源码树里）；它的提示词在任务之前加一段以
  "You are continuing work another agent started…" 开头的简报——上一个适配器停下的原因、改过的
  文件（diff 统计；原地调用取其编辑类工具调用）、最后的计划或待办、运行过的命令及结果、最后几条
  消息；至多 6 KB，每一部分先脱敏再截断。下一个适配器的每次运行（卡住重启、限流与 schema
  重试）都沿用这个 worktree；信任级别或容器引擎不同的回退则拿到新的 worktree，简报会说明改动没有
  带过来。简报保存为 `agents/<id>.handoff.md`，并记 `handoff` 事件
  `{ from, to, reason, bytes }` 和一行 `{"kind":"handoff"}` transcript。`expect` 与保留的 diff
  判定最终状态（共享 worktree 相对其基线）；`expect` 重试和 `quotaWait` 之后的调用仍从头开始。
  `handoff` 不在 resume key 中。
- **额度熔断。** 同一个适配器上连续 `quotaBreaker`（默认 3）次额度失败后，本次运行之后的
  调用都会跳过它：各自从回退链上的下一个适配器开始，没有回退链的则立即失败（原因为 `quota`）。
  只记一条警告。
- **多账号**（ODW 扩展）。用户配置了 `accounts` 时，每个登录是一个适配器 `<适配器>@<名字>`
  （`claude@work`），有自己的配置目录、并发上限和额度熔断。`adapter: "claude"`（或默认
  适配器、提到它的回退链）表示任意一个 claude 账号：按余量排序的账号链——不处于额度暂停的
  在前，其次是本次运行额度失败最少的，再次是已路由到它且未结束的 agent 最少的——并开启交接，
  除非调用写了 `handoff: false`。`adapter: "claude@work"` 只在该账号上运行。事件、`odw status`
  与看板都会写明账号。
- **额度用尽时暂停。** 配置了 `quotaWait`（`{ "max": <秒数> }`；默认关闭）时，因额度用尽而无
  适配器可用的调用不会失败：它不占槽位地等到 CLI 报出的重置时间——只要在 `max` 之内——然后从
  链首重新开始，transcript 在 `{"kind":"attempt","reason":"quota_wait"}` 一行之后继续。在那个
  重置时间之前，运行会跳过该适配器，无处可去的调用在派发前就等待。你的 `agent()` 只是返回得更
  晚；没有重置时间或超过 `max` 的额度失败照上文以原因 `quota` 失败。

```js
export const meta = {
  name: 'triage',
  description: 'Map cheaply, judge carefully.',
  phases: [{ title: 'Map', model: '@fast' }, { title: 'Judge', adapter: ['claude', 'codex'], model: '@strong' }],
}
phase('Map')
const areas = await agent('List the modules touched by HEAD~5..HEAD, one per line.')
phase('Judge')
return await agent(`Which of these needs a careful review first, and why?\n${areas}`)
```

## args / budget

```js
args                                  // the workflow input, injected verbatim
budget // { total: number | null, spent(): number, remaining(): number }
```

`args` 是你用 `--args` 传入的任何东西（解析后的 JSON，或一段原始字符串；*看起来像*
JSON 但解析失败的输入会被拒绝，不会悄悄按字符串传入）。`budget.total`
是用 `odw run … --budget <tokens>` 设的 token 目标，否则为 `null`；按它扩缩深度，例如
`budget.total ? Math.floor(budget.total / 120_000) : 5`。

`spent()` 是本次运行到目前为止花掉的输出 token，包含子工作流：适配器上报用量时用 CLI
自己的计数（内置 `claude` 和 `codex` 会上报——ODW 扩展），否则这次 CLI 运行按 `ceil(回复字符数 / 4)`
计。一次调用的每次 CLI 运行都计入——schema 重试、限流重试，以及上报了用量的失败运行；
输入 token 不计入。`remaining()` 为 `max(0, total - spent())`；没设目标时为 `Infinity`。

调度器拿到执行槽位并检查暂停/停止后，如果 `spent()` 已达到目标，就拒绝新的 agent 调用。
已经运行的调用仍可完成并超过目标。因此它是按输出 token 限制后续派发，不是费用的硬上限。
每个 agent 和整个运行花了多少——输入与输出 token、缓存读写，以及 CLI 上报时的花费——会显示
在 `odw status`、实时视图和看板里（ODW 扩展）。

## workflow

```js
workflow(nameOrRef, args?) -> Promise<unknown>
```

内联执行另一个 workflow，并返回它的最终值。字符串从受管工作流目录按名解析；
`{ scriptPath }` 相对本次运行的 source 目录解析。子工作流共享父运行的调度器、并发上限、
agent 计数、控制和预算。其 phase 带 `▸ <name>` 前缀，不创建独立 run id。
省略子工作流的 `args` 时传入 `null`，不会继承父运行的输入。

只支持一层嵌套：子工作流再调用 `workflow()` 会抛错。文件不存在、名称无法解析或子脚本
无效也会抛错；调用位于 `parallel`/`pipeline` 内时，普通错误可变成 `null`。

### workflow.input（ODW 扩展）

```js
workflow.input -> { untrusted, args, why, quote(text, label?) }   // 在 Claude Code 中为 undefined
```

本次运行的 `args` 是否来自用户以外的人：触发器启动的运行（除非 `"untrusted": false`）或
`odw run --untrusted-input`。`args` 列出含有这类文字的键（`["*"]` 表示全部），`why` 说明由谁
标记（`trigger:<name>`、`--untrusted-input`；受信任时为 `null`）。`quote(text, label?)` 把
`text` 放进带围栏的 `<untrusted-data id="…">` 块——围栏带有文本的摘要，文本无法提前闭合它——
后面跟一行说明它是数据而不是指令。脚本若也要在 Claude Code 上运行，请写成
`workflow.input?.untrusted`。这样的运行中 agent 默认只读（除非给出了运行档位），第一个可写的
agent 要先过检查点；被拒绝时，它和之后每个可写的 agent 都抛出 `UntrustedInputRejected`
（可恢复：可以捕获，在 `parallel` 中会变成 `null`）。

## validate（ODW 扩展）

`validate(source)` 加载候选工作流但不执行其 body，返回 `{ ok, meta?, errors, warnings }`。
加载时 `meta` 按纯字面量解析、从不求值，body 只编译不执行。
warnings 提示 `Date.now()`、`Math.random()`、调用仅 ODW 提供的 `exec()` 和 `checkpoint()` 等部分可移植性风险，
不阻止执行。这个 helper
不属于共享的核心原语；脚本自己声明的 `validate` 绑定优先于注入的 helper。

## resume（ODW 扩展）

对一个已结束的运行——done、failed、stopped，或 worker 死掉后变成 stale——执行
`odw resume <run>`，会用同样的脚本、args 和 adapter 启动一个新运行。新运行里，当一次
`agent()` 调用的*恢复键*与旧运行保存的调用一致时，它会**重放**：立即返回旧运行保存的值，
不调用 adapter、不占并发槽位、不计入派发数、不消耗预算。恢复键是 prompt 加上
`schema`、`adapter`（调用里写的值，而不是运行的默认值）、`model`、`agentType`、
`isolation`、`label` 和 `permissions`（调用里写的值）的 sha256。`phase` 不在键里；resume
时的 `--adapter` 或 `--permissions` 只改运行的默认值，所以没指定 adapter 或档位的调用仍会重放。阶段的默认适配器和模型（ODW 扩展）同样不在键里，所以把阶段改到别处后仍会重放；适配器列表按其顺序计入键，模型层级按层级名计入。发生过回退的调用会重放它的值，不会再走一遍回退链。同一个键的多次调用按调用顺序重放（第 n 次这样的调用
拿到第 n 个保存的结果）；超出的调用，以及 prompt 或选项改变的调用，照常执行。嵌套的
`workflow()` 调用同样会重放。`checkpoint()` 永远不会重放：恢复出来的运行会重新提问。

重放的 agent 在各处都标记为 `cached`（`odw agents` 和看板里显示 ↺），并会再次保存，
所以对 resume 出来的运行再 resume，也会重放它们。修好出错的步骤或加上新步骤后 resume：
只有改动的部分会执行。对仍存活且已暂停的运行，`odw resume` 保持原意（原地继续）；仍在
运行的运行会被拒绝，除非加 `--force`。

## exec（ODW 扩展）

```js
exec(command, opts?) -> Promise<{ stdout, stderr, exitCode, signal, timedOut, truncated, durationMs }>
```

**不启动模型**直接运行一条命令——测试套件、构建、linter——再按真实结果分支。它不可移植：
Claude Code 的 Workflow 工具没有 `exec` 全局（`validate()` 会对此给出 warning）；脚本
自己声明的 `exec` 绑定优先于注入的版本。

- **command** —— 字符串交给平台 shell 执行（POSIX 上是 `/bin/sh -c`，Windows 上是
  `cmd.exe /d /s /c`）；数组是 argv，不经 shell 直接执行，任何元素都不会被解释。在
  Windows 上，`npm` 这类批处理文件只能经 shell 运行：请用字符串形式。
- **opts.cwd** —— 工作目录。默认是本次运行的源目录（agent 运行的地方）；相对路径按它
  解析。
- **opts.env** —— 额外的环境变量，叠加在 worker 自身环境和本次运行的 `ODW_RUN_ID` 之上。
- **opts.input** —— 写入 stdin 的文本；不传则 stdin 立即关闭。
- **opts.timeout** —— 秒，默认 `600`。超时后命令连同它启动的所有进程一起被杀，结果里
  `timedOut: true`（同时 `exitCode: null`、`signal: "SIGKILL"`）。
- **opts.maxOutputBytes** —— 每个输出流保留的字节数，默认 8 MiB。超出部分照常读取后
  丢弃，绝不致命；`truncated` 标明发生过截断。
- **opts.label** / **opts.phase** —— 进度展示，与 `agent` 相同。label 默认取命令的前
  40 个字符。
- **opts.check** —— 命令没有以 0 退出时抛出 `ExecError`。
- **opts.network**（**ODW 扩展**）—— 运行的 `sandbox` 为容器时，该步骤在运行镜像的全新容器里执行，以相同路径挂载运行的 source（及其 `cwd`），环境同 agent；网络默认 `"none"`，可要求 `"default"`（沙箱本身没有网络时拒绝）——即运行的网络，包括出站白名单（其中的 `"adapter"` 条目除外）。不在沙箱中时无效。

非零退出码是结果，不是错误。无法启动的程序像 shell 一样报告退出码 `127`（找不到）或
`126`。设了 `check: true` 时，失败会抛出携带 `.result` 的 `ExecError`——与 agent 失败
一样可恢复：可以 catch，也可以交给 `parallel`/`pipeline` 变成 `null`。误用（`cwd`
不存在、argv 元素不是字符串）会在任何东西运行之前就抛错。

命令不是 agent：它不占并发槽位，也不计入 agent 总量上限和预算。但运行暂停时它同样
等待；停止（或任何致命错误）会立刻杀掉它及其整个进程组，并以该错误拒绝这次调用。每一步
都记录为 `command_started`，随后是 `command_finished`（退出码 0）或 `command_failed`
（其他一切情况），并在 `odw logs`、实时视图和看板图中显示为命令节点。

```js
phase('Test')
let run = await exec('npm test', { timeout: 900 })
for (let round = 1; run.exitCode !== 0 && round <= 3; round++) {
  await agent(`Fix the failing tests.\n\n${run.stdout.slice(-4000)}\n${run.stderr.slice(-4000)}`, { phase: 'Fix' })
  run = await exec('npm test', { timeout: 900, label: `npm test r${round}` })
}
await exec(['git', 'diff', '--stat'], { check: true }) // 退出码不为 0 时抛出 ExecError
```

命令以 worker 自身的权限运行——与脚本本身同等的信任；`exec` 不提供沙箱。ODW 仓库里的
`examples/test-fix-loop.js` 就是这个循环的完整 workflow。

## checkpoint（ODW 扩展）

```js
checkpoint(title, opts?) -> Promise<{ approved, note, by, payload, edited }>
```

暂停运行，直到有人批准或拒绝——用在昂贵或难以撤销的步骤之前，或让人确认一份计划。它
不可移植：Claude Code 的 workflow 运行中不接受输入，也没有 `checkpoint` 全局
（`validate()` 会对此给出 warning）；脚本自己声明的 `checkpoint` 绑定优先于注入的版本。

- **title** —— 问题，单行（空白会被合并；事件、`status.json` 和看板保留 200 个字符）。
- **opts.payload** —— 要给人看的内容：任意 JSON 值。它会被转成 JSON 安全的形式（BigInt
  变成数字字符串，循环引用变成 `"[Circular]"`），最多保留 64 KiB；更大的只保留开头一段
  文本，事件里会标注 `truncated`。
- **opts.schema** —— 修改后的 payload 必须满足的 JSON Schema（见下文），由检查 `agent()`
  回复的同一个校验器检查，也像它一样先审查：格式错误的 schema 属于误用；校验器不检查的
  关键字会记一行日志（`schemaKeywords: "warn"`）或被拒绝（`"strict"`）。没有 schema 时，
  任何 JSON 值都可以作为修改。
- **opts.timeout** —— 等待的秒数；默认不限。
- **opts.onTimeout** —— 无人回答时的含义：`"approve"` 或 `"reject"` 以 `by: "timeout"`
  返回；`"fail"`（默认）抛出 `CheckpointTimeout`——与 agent 失败一样可恢复：可以 catch，
  也可以交给 `parallel`/`pipeline` 变成 `null`。
- **opts.memory** —— `true` 或 `{ paths: [globs] }`：带备注的拒绝、或修改后的批准，在运行结束时作为
  `correction` 保留进工作流记忆（`paths` 匹配的文件改动后即过期）；`false`：从不。默认取 `memory` 设置。
  见 [memory](#memoryodw-扩展)。

调用返回 `{ approved, note, by, payload, edited }`：`note` 是对方的附言或 `null`；`by` 是 `"cli"`
（`odw approve|reject`）、`"dashboard"`（`odw serve`）、`"link"`（`waiting` 通知带来的签名一次性
批准链接，经 `odw serve --public-url` 回答；ODW 扩展）或 `"timeout"`。拒绝也是一个答复，
不是错误：它意味着什么由脚本决定——停止、带着附言重新规划、跳过某一步。
**ODW 扩展：**已知时，`who` 在渠道之外给出答复人——`odw approve|reject` 为
`"cli:<$USER> <git user.email>"`，看板或批准链接旁为具名令牌（`odw serve --tokens FILE`）的名字；
其他情况（超时、不具名的 `--token`）没有这个字段。

对方可以批准一份**修改过的** payload，而不必拒绝后重跑（与 Claude Code 的计划审批一样）：
`odw approve <run> --edit` 用 `$VISUAL`/`$EDITOR` 打开它，`--payload '<json>'` /
`--payload @file.json` 直接发送一份，看板则在 `action: "approve"` 时附上 `payload`。此时
`payload` 是被批准的内容——修改后的版本，否则是检查点原样的 payload（没有时为
undefined）——只有与原 payload 的 JSON 不同时 `edited` 才为 `true`。拒绝和超时都带回原
payload。修改必须是最多 256 KiB 的 JSON，且在给出 `opts.schema` 时满足它：CLI 和 API 会
带着校验错误拒绝不满足的修改，手写进决定日志的则由运行丢弃并记一行日志，检查点继续等待。
所以请从结果里读取被批准的值，而不是用自己的变量；检查点之后的代码依赖 payload 结构时，
请给出 `schema`。

等待不是工作：检查点不占并发槽位，不计入 agent 总量上限和预算，运行暂停时也照样提问；
已在运行的 agent 继续运行。停止（或任何致命错误）会立刻结束等待，运行也随之结束。多个
检查点可以同时等待（在 `parallel` 里），按调用顺序编号（`checkpointId`，从 1 开始）。
误用（空标题、非正数的 timeout）会在提问之前就抛错。

等待期间，运行的展示状态是 `waiting`：`odw status` 会显示问题、payload，以及确切的
`odw approve|reject <run> --checkpoint N` 命令，看板则显示一张 Approve/Reject 卡片。
不带 `--checkpoint` 的答复会交给最早在等待的检查点。每个检查点都记录为
`checkpoint_requested { checkpointId, title, payload, schema?, phase }`，随后恰好一个
`checkpoint_resolved { checkpointId, approved, note, by }`（修改后批准时带 `edited: true`
和修改后的 `payload`，截断到 64 KiB；运行先结束时带 `error`，且 `by: null`）。
`odw resume` 永远不会重放检查点：恢复出来的运行会重新提问。

```js
phase('Plan')
const draft = await agent(`Plan this as independent steps: ${task}`, { schema: PLAN })
phase('Approve')
const { approved, note, payload: plan } = await checkpoint(`Run this ${draft.steps.length}-step plan?`, {
  payload: draft,
  schema: PLAN, // 修改后的计划也必须还是一份计划
  timeout: 3600,
  onTimeout: 'reject', // 一小时内没人回答：什么都不改
})
if (!approved) return { approved, note, plan }
phase('Execute')
await parallel(plan.steps.map((step) => () => agent(step.instructions))) // 按批准的计划执行
```

ODW 仓库里的 `examples/plan-approve-execute.js` 就是这个流程的完整 workflow，附带说明
的拒绝会触发重新规划。

## 隔离 worktree 与 agent 环境

隔离的 agent（`isolation: "worktree"`）从 HEAD 的干净检出开始，所以 git 不跟踪的东西——
`.env`、`.venv`、`node_modules`——在那里都不存在。agent 启动前分两步把 worktree 准备好：

1. **`.worktreeinclude`**：放在仓库根目录，用 `.gitignore` 语法（模式相对根目录，`#`
   注释，`!` 取反）列出要带进来的东西：git 不跟踪、且被某一行匹配到的每个文件或目录，都会
   复制进 worktree。Claude Code 也读这个文件，但只复制被 gitignore 的文件；ODW 连单纯
   未跟踪的文件也复制。以 `symlink:` 开头的行（**ODW 扩展**）把匹配到的东西链接到源目录
   而不是复制——对大目录（`symlink: node_modules`）瞬间完成，但它是共享的：agent 往里写
   的东西会落到源目录。`.git` 永远不复制；超过 100 MB 的文件会被跳过，并在日志里点名。
2. **`worktreeSetup`**（**ODW 扩展**；见适配器参考）在 agent 的工作区里运行——字符串
   交给平台 shell，数组作为 argv——超过 `worktreeSetupTimeout` 秒（默认 600）就被杀掉。
   setup 失败或超时，会像 CLI 出错一样让这个 agent 失败（可恢复：在 `parallel`/`pipeline`
   里变成 `null`），错误里带着它输出的结尾。

与之相对的 **`worktreeTeardown`**（**ODW 扩展**）在 worktree 删除之前、在同一个工作区里、
带着同样的变量运行——不论 agent 成功、失败还是被停止——超过 `worktreeTeardownTimeout` 秒
（默认 120）就被杀掉。它失败只记日志，agent 的结果不变。

一次调用的每次尝试（schema 重试、卡死重启）都会得到一个新的 worktree，并以同样方式准备。

每个 agent 进程——不论是否隔离——都会拿到三个变量，隔离 agent 还有第四个（**ODW 扩展**）：

| 变量 | 值 |
| --- | --- |
| `ODW_RUN_ID` | 本次运行的 id |
| `ODW_AGENT_ID` | 这个 agent 的 id，与它的事件和 `odw agents` 里的一致 |
| `ODW_PORT` | 来自 `portRange`（默认 41000–41999）的一个端口，本次运行中没有其他正在运行的 agent 占用它——已经有程序在监听的端口会被跳过——直到这次调用结束都归它所有 |
| `ODW_SLOT` | 仅隔离 agent：`odw-<run>-<agent>`（运行 id 的随机部分加 agent id；只含小写字母、数字和连字符），在这次调用的每次尝试、setup 和 teardown 中都相同。`COMPOSE_PROJECT_NAME` 未设置时默认取它——每个 agent 一套 compose 栈、数据库或卷名前缀 |

这样并行的 agent 各自起服务也不会冲突：

```js
await parallel(['grid', 'list'].map((layout) => () =>
  agent(`Build the ${layout} layout, start the dev server on port $ODW_PORT and check that the page renders.`,
    { isolation: 'worktree', label: layout })))
```

当本次运行中正在运行的 agent 占满了整个端口范围，下一个 agent 就不带 `ODW_PORT` 运行，
运行日志会说明这一点：请让 `portRange` 比 `concurrency` 更宽。worktree setup 拿到同样的
三个变量；`exec()` 命令拿到 `ODW_RUN_ID`。

## 隔离 agent 的改动（ODW 扩展）

在隔离 agent 的 worktree 被删除之前，ODW 会保存它的改动：相对它开始时那个提交的一切
差异——修改、新增、删除、重命名和二进制文件，不论是否暂存或提交——以统一 diff 的形式存进
run 目录（`agents/<agentId>.diff`），并把 `changes: { files, insertions, deletions,
truncated }` 记在它的 `agent_finished` 事件（或 `agent_failed`：失败的 agent 同样保留它的
工作）和已保存结果上。`.worktreeinclude` 放进来的、`worktreeSetup` 生成的东西不算在内，
除非 agent 之后又改了它们；被 git 忽略的文件从不计入，符号链接也从不被跟随。什么都没改的
agent 不保留 diff；被停止的运行也不保留。

```bash
odw diff <run> --stat                    # 每个 agent：文件数、增删行数、保留的分支
odw diff <run> --agent <id|label>        # 某个 agent 的 diff，原样输出
odw apply <run> --agent <id|label> --check   # 只预览
odw apply <run> --agent <id|label>       # 用 git apply --3way 应用到你所在的工作树
odw apply <run> --all [--check]          # 所有已完成的 agent，按 agentId 顺序
odw apply <run> --agent <id|label> --verify "<cmd>"   # <cmd> 失败则回滚这次应用
odw apply <run> --all --resolve [--adapter A] [--confirm] --verify "<cmd>"   # 由 resolver agent 解决冲突
odw apply <run> --all --pr [--base B] [--remote R] [--ready] [--title T]   # 新分支、推送、开草稿 PR
odw review [--json] [--since 7d] [--all]  # ODW 扩展：跨运行尚未处理的保留 diff，按风险从高到低
odw review mark <run> <id|label> reviewed|dismissed|applied|open [--note TEXT]
```

`odw review` 只用记录下的数据给每个保留 diff 打分，并列出每一个计分项（`{ key, points, why }`）：
0–2 为 low，3–5 为 medium，6 及以上为 high。标记是运行目录中只追加的 `reviews.jsonl` 里的一行——
`{ ts, agentId, state, by, via, note? }`，每个 agent 以最后一条为准；`odw apply` 每干净应用一个
agent 就追加一条 `applied`（`via: "apply"`）。`odw eval` 的运行和 resolver 运行不进入队列。

动手之前，`odw apply` 先在索引的临时副本上做同样的应用，逐个文件给出 `clean`、`CONFLICT`
（附上合并后会留在文件里的冲突行，或无法合并的原因：`deleted here`、`binary: …`、挡在那里的未跟踪或被忽略文件）或
`already applied`（不再应用）；`--check` 到此为止，有冲突时退出码 1。它会暂存能应用的部分，
在 hunk 冲突处留下冲突标记（退出码 1）；只要 diff 涉及的路径上有未提交改动它就拒绝，除非加
`--force`。`--all` 按 agentId 顺序把所有已完成的 agent 叠起来预览（会冲突的那个不进入叠加），
并依次应用到第一个会冲突的为止；失败的 agent 的 diff 只能用 `--agent` 应用。`--verify "<cmd>"`
或配置 `applyVerify`（`--no-verify` 跳过）在每次应用后于仓库根目录运行 `<cmd>`，受 `timeout`
约束；命令失败或超时时，这次应用会被原样回滚——只恢复涉及路径的内容和索引项，其他一概不动——
odw 以退出码 1 结束并给出命令输出的末尾（被信号中断时同样回滚，然后 odw 随该信号结束）。`--verify` 下会冲突的改动不会被应用。
`--resolve`（ODW 扩展）则把这样的改动交给一个 resolver agent：它是单独的一次运行（meta.json 里
有 `origin: "apply-resolve"` 和 `applyResolve: { runId, agentId }`；被应用的运行得到 `resolvedBy`
和一条 `apply_resolved` 事件），在 HEAD + 索引 + 该 agent 干净文件的临时 worktree 中进行，提示词
给出每个冲突文件的 base、双方版本和冲突行。只有当它只改冲突文件、不留冲突标记、并在该 worktree
里通过 `<cmd>` 时（`--confirm`：先在终端回答 y/N），它的改动才会连同 agent 的干净文件一起应用；
否则工作树不变，odw 说明原因。只处理文本冲突；不能与 `--force` 或 `--check` 同用。
`--pr`（ODW 扩展）不碰工作树——既不读也不写——而是在临时 worktree 里从 `--base` 或 HEAD 建分支
`odw/<run>-<label>`（`odw/<run>-all`；被占用时加 `-2`……），在那里按上文方式应用（并校验）每个
agent，每个单独提交、使用用户自己的 git 身份（工作流、agent、diff 统计、运行 id、花费），推送到
`--remote`（`origin`）后运行 `gh pr create --repo <该远端的 owner/name>`——默认草稿，`--ready` 则否——正文为运行摘要（agent 与
提交、阶段、花费、校验结果、`odw diff` 命令）。冲突或校验失败会在推送前删除分支；没有 `gh`（或未
登录）时推送后打印对比页 URL。从不合并；不能与 `--check`、`--force`、`--resolve` 同用。
`examples/pr-shepherd.js` 之后看护这个 PR：红掉的 CI 和新的评审意见交给经 `expect` 校验的修复
agent，修复推送到 PR 分支，`gh pr ready` 之前先过 `checkpoint()`。
超过 `maxDiffBytes`（默认 2 MB）的 diff 只保留开头，并以一行 `# odw: diff truncated …` 结尾；
计数仍描述完整改动，但 `odw apply` 会拒绝它（`--all` 在此停下）——请改用该 agent 的分支
（`keep: true` 或 `keepBranches`）。一次调用的每次尝试都在新的 worktree 里进行：只重排回复格式的 schema
重试会保留之前那次尝试的改动；卡死重启、限流重试或 `expect` 重试会重做工作，所以它的改动
取代之前的。`odw resume` 会把重放 agent 的 diff 复制到新运行里。

## expect（ODW 扩展）

```js
agent(prompt, { expect: { changes?, files?, command?, match?, mcp?, untouched?, timeout? }, expectRetries?, allowEmpty? })
```

agent 回复之后必须成立的条件——由 odw 检查，而不是问模型有没有做完。优先用它，而不是
再派一个"你做了吗"的 agent：

- **changes** —— `true`：agent 必须改动某个文件；`false`：不许改动任何文件。
- **files** —— 相对 agent 工作区的 glob（`*`、`**`、`?`、`[…]`、`{a,b}`）：每个都必须匹配到
  一个 agent 改动或新建的文件（删除不算）。
- **command** —— 必须在 agent 的工作区里以 0 退出：字符串经 shell 执行，数组按 argv 执行。
  超过 `timeout` 秒（默认 600）会被杀掉，算作未达到。它作为 agent 名下的一个 `exec()` 步骤
  运行——它的 `command_*` 事件带 `forAgentId`——在读取改动之后执行，所以它写出的文件绝不会
  被算成 agent 的工作；停止会杀掉它。
- **match** —— 回复必须匹配的正则表达式（只给源码，不带 flag）。
- **mcp** —— MCP 服务器名列表：每个都必须出现在 agent 的 CLI 报告的、启动 agent 时的服务器里
  （Claude Code stream-json 的 init 事件，经适配器的 `output.mcpPath` 读取），状态为
  `connected`——或 `pending`，Claude Code 的文档说它本身不算失败（仍在后台连接，或带缓存的
  工具列表、首次使用时才连接）。`failed`、`needs-auth`、`disabled` 或没有配置都算缺失。没有
  声明 `mcpPath` 的适配器无法检查：调用在 CLI 启动前就失败。
- **untouched** —— glob 列表（规则同 `files`），agent 修改、新建或删除的文件都不许匹配：它不该
  为了变绿去改、跳过或删除的测试、快照和 CI 配置（`['test/**', '**/*.snap', '.github/**']`；
  `*` 不跨目录）。碰到的路径算作一项缺失并被列出——`no file matching "test/**" may change,
  and 1 did: test/add.test.js`——重试时会要求 agent 把它们恢复原样。和 `changes` 一样从 git 读取。

检查在回复到达、并通过 `schema` 校验之后进行。agent 改了什么从 git 读取。原地运行时，是与
agent 第一次 CLI 运行前的源码树相比的差异：你自己未提交的改动和运行目录不算，agent 的提交算
——同时原地运行的其他 agent 的改动也会算进来，所以需要分清各自改动的 agent 请用隔离。原地
使用 `expect.changes`、`expect.files` 或 `expect.untouched` 需要 git 仓库（否则调用在 CLI 启动前失败）。用
`isolation: "worktree"` 时，就是运行为该 agent 保留的那份 diff；只重排回复格式的 schema 重试，
按真正干活的那次尝试来评判。

没达到要求的工作会重跑——`expectRetries` 次（默认 1，或取 `expectRetries` 设置）——并把缺失
项追加到提示词里，失败命令的输出也一并附上；隔离的重试会在全新的 worktree 里从头开始。每次重试
都会记日志，transcript 里标为 `{"kind":"attempt","reason":"expect"}`。重试在做出这份工作的
适配器上进行：缺失绝不会触发回退。回退的调用（额度用尽、登录被拒）会带着它的 `expect`，下一个
适配器从头开始这项工作，有自己的重试次数——隔离运行时在全新的 worktree 里；原地运行时，对照
调用第一次 CLI 运行前的源码树来判断。仍未达到时，调用抛出
可恢复的错误，错误和它的 `agent_failed` 事件上都带有 `reason: "unmet_expectation"` 和逐条的
`misses`：

```js
try {
  await agent('Fix the flaky date test.', { expect: { command: ['npm', 'test', '--', 'dates'], changes: true } })
} catch (err) {
  if (err.reason !== 'unmet_expectation') throw err
  log(`not fixed: ${err.misses.join('; ')}`)   // "`npm test -- dates` must exit 0, and it exited with code 1"
}
```

CLI 拒绝的工具调用——Claude Code 的 `permission_denials`，经适配器的 `output.deniedPath`
读取——算作一项缺失：重试时会告诉 agent 是哪些，重试之后仍被拒绝的调用会以 `"permission"`
抛错，`misses` 里列出这次拒绝以及工作的其他缺失。

CLI 回复时仍在运行的后台任务也一样——用 `run_in_background` 启动的 shell 命令或子 agent，
到 Claude Code 的 `result` 事件时仍未结束（读取它 stream-json 的任务事件，经适配器的
`output.background`），随 CLI 退出而终止：重试时会要求 agent 等所有后台命令和子 agent 结束后
再回复，重试之后仍丢下后台任务的调用以 `"orphaned_background"` 抛错。

没设 `expect` 时：空回复或只有空白的回复会以 `"empty_reply"` 抛错，除非设了
`allowEmpty: true`。声称成功、但 CLI 拒绝了工具调用的回复照常成立——这些调用作为 `denied`
记在 agent 的 `agent_finished` 事件和保存的结果上，运行也会记一行日志——除非设了
`"permissionDenials": "fail"`（运行级，或写在适配器条目里），此时以 `"permission"` 抛错并
列出它们。CLI 启动 agent 时没连上的 MCP 服务器——状态不是 `connected` 的——作为
`mcp: [{ name, status }]` 记在 agent 的终止事件和保存的结果上，运行按服务器和状态各记一次日志；
`"mcpFailures": "fail"` 让服务器为 `failed` 或 `needs-auth` 的调用以 `"mcp_unavailable"` 抛错
（`expect.mcp` 列出的服务器则算作缺失）。CLI 回复时仍在运行的后台任务作为 `orphaned` 记在
agent 的 `agent_finished` 事件和保存的结果上，运行为每个 agent 记一行日志；
`"orphanedBackground": "fail"` 则以 `"orphaned_background"` 抛错。CLI 报告的实际服务模型（ODW
扩展；`output.servedModel`）作为 `servedModel` 记在 agent 的 `agent_finished` 事件和保存的结果上；
这些模型都不是 `model` 向 CLI 请求的那个时，运行写入 `model_substituted` 事件并记一行日志，
`"modelMismatch": "fail"` 则以 `"model_substituted"` 抛错。CLI 不报告模型时只显示"未报告"，不做推断。这些失败都不重试。`expect` 属于调用的 resume key；Claude Code 会忽略它，在那里检查
不会执行。

## notes（ODW 扩展）

```js
agent(prompt, { notes: true })                 // 这一个 agent
parallel(thunks, { notes: true })              // 其 thunk 启动的每个 agent
// odw.config.json: "notes": true              // 本次运行的每个 agent
```

运行级的笔记板：并行的 agent 在上面告诉彼此必须知道的事——改了哪个接口、做了什么决定——
避免各自通过、合在一起却出错的改动。默认关闭（保持方言一致）；`notes: false` 让单个 agent 退出。

- **发布。** 打开笔记的 agent 会得到 `ODW_NOTES`——一个属于它自己的 POSIX shell 脚本的路径：
  `"$ODW_NOTES" "把 parseX 改名为 parse"` 发布一条笔记，不带参数的 `"$ODW_NOTES"` 打印笔记板。
  `odw note "…"` 作用相同（需要 agent 的 `ODW_RUN_ID` 与 `ODW_AGENT_ID`）。提示词里会说明用法。
- **读取。** agent 启动前已发布的笔记追加在它的提示词末尾——"Notes from the other agents in
  this run:"，每条为 `#<n> [agent <id> · <label>] <内容>`，取放得下 8000 字符的最新几条。新笔记
  不会推送给已经在运行的 agent（CLI 只读一次提示词）；它可以再次运行 `"$ODW_NOTES"`。
- **接口广播。** 打开笔记、`isolation: "worktree"` 且保留了改动的 agent，在其 `agent_finished`
  事件之前由 ODW 替它发布一条 `kind: "interface"` 的笔记：diff 统计、改到的文件，以及 diff 中新增
  （`+`）或删除（`-`）的、看起来像声明的行——`export`、`def`、`func`、`pub fn`、`class`、
  `interface`——最多 12 行。脚本之后启动的 agent 会在提示词里看到它。
- **上限。** 每条笔记最多 2000 字符并经过脱敏；笔记板最多 200 条、256 KiB（之后的笔记被丢弃，
  运行记一次日志）。
- **位置。** 运行目录中的 `notes.jsonl`；每条笔记也是一个 `note_added` 事件。`odw notes <run>
  [--json]` 打印它；`GET /api/runs/:id/notes` 返回
  `[{ noteId, ts, by: { agentId, label }, text, kind, truncated?, redacted? }]`。
- **容器。** 在容器沙箱中，agent 自己的收件箱以读写、它的脚本和笔记板以只读方式按相同路径绑定：脚本照常可用。worker 只从收件箱取普通文件，从不跟随链接。
- **不持久化则没有笔记板。** 没有运行目录的进程内运行会记一次日志，其 agent 不带笔记板运行。
  被 `odw resume` 重放的调用不发布任何笔记。`notes` 不属于 resume key。
- **保留笔记。** `"$ODW_NOTES" --keep "…"` 或 `odw note --keep [--paths GLOB,…] "…"` 发布一条标记为
  `keep` 的笔记，运行结束时成为工作流记忆——见 [memory](#memoryodw-扩展)。只有开启记忆的 agent
  会被告知 `--keep`，其笔记才会保留；未开启的 agent 的这类笔记只发布、不保留，并记日志。

## memory（ODW 扩展）

```js
agent(prompt, { memory: true })                          // 召回；保留它被补上的 expect 未达项
checkpoint(title, { memory: true })                      // 保留它的纠正
checkpoint(title, { memory: { paths: ['src/api/**'] } }) // …这些文件改动后即过期
// odw.config.json: "memory": true                       // 每个 agent 与检查点
```

一个工作流历次运行学到的东西，存在仓库里的 `.odw/memory/<工作流>.jsonl`（可在 PR 中审阅）。每行一个
JSON 对象：`{ id, text, kind: "note"|"correction"|"lesson", paths: [globs], commit, run, agent?, at }`。

- **来源——只有明确的来源，不由模型总结。** 用 `--keep` 保留的笔记（`note`，来自开启记忆的 agent）；带备注被拒绝的
  检查点（`correction`，`"<标题>" was rejected: <备注>`）或修改 payload 后批准的检查点（`correction`，
  结构化 diff：`$.steps[1]: "b" → "c"; removed $.owner`）；同一 agent 的重试补上了的 `expect` 未达项
  （`lesson`）；`odw memory add`。每种条目都只在开启记忆时保留（调用的 `memory`，否则看设置）。
  花费闸门与 `--break` 的检查点从不写入记忆。
- **召回。** 开启记忆的 agent 在任务之前看到仍然适用的条目，标题 "## What earlier runs of this workflow
  learned"，最新的在前，至多 4 KB，每条标明种类与来源（运行与 agent，或"手工添加"），正文逐行以 `> `
  引用；运行日志说明召回了多少、多少已过期、多少放不下。每次运行只读一次。
- **过期。** 有 `paths` 的条目在其 `commit` 与 HEAD 之间、paths 匹配的文件（glob，或目录及其下所有文件）
  有改动即过期；git 不认识其提交的也算过期。没有 paths 的永不过期。每个文件至多检查 32 个不同的提交
  （最新条目的优先，其余视为过期）；超过 4 MiB 的文件不读取，并会说明。
- **写入。** 运行结束时（完成、失败或被停止），按各条学到时的 HEAD 记录，经运行的脱敏器处理；种类、文本
  与 paths 相同的条目替换旧的那条；至多 500 条，超出时删去最旧的并记日志。`odw test` 与 `--dry` 运行
  不保存。不持久化的运行没有记忆，并说明一次。
- **不受信任的运行**既不召回也不保存仓库里的记忆（那是仓库的内容，这样的运行学到的东西会进入受信任运行的
  提示词）。你在自己的配置里把 `memoryDir` 设为仓库之外的目录，那就是你自己的：不受信任的运行也会使用（按字面路径和解析链接后都须在仓库之外）。仓库自己的配置设置的
  `memoryDir` 一律不算。
- **CLI。** `odw memory list [<wf>] [--stale] [--json]`、`odw memory add <wf> "内容" [--paths G,…]
  [--kind …]`、`odw memory prune [<wf>] --stale | <wf> --id N`（`--source DIR`、`--config FILE`）。
  `GET /api/memory[?workflow=]` 返回同样的列表。
- `memory` 不属于 resume key；被重放的调用不学习任何东西。

## scope（ODW 扩展）

```js
agent(prompt, { scope: ['src/parser/**', 'docs/parser.md'] })   // 打算改动的文件
agent(prompt, { scope: [...], scopePolicy: 'fail' })              // 越出范围的写入让它失败
// odw.config.json: "scopePolicy": "fail"                        // 对每个声明了范围的调用
```

声明范围让同时改动同一代码库的 agent 互不踩到对方的文件——是一份建议性的计划，不是沙箱。

- **Glob。** 非空、相对 agent 工作区，规则同 `expect.files`（`*`、`**`、`?`、`[…]`、`{a,b}`、
  `\` 转义）。`scope: []`、绝对路径、无效 glob，或没有 `scope` 却设了 `scopePolicy`，都会在启动前
  抛出可恢复的 `AgentError`。
- **调度。** 一个声明了范围的调用发出时，若更早发出、尚未结束的调用范围与之重叠，它在申请槽位之前
  先等那个调用结束（等待时不占槽位），然后运行；它只等在它之前发出的调用。没有 `scope` 的调用与
  任何调用都不重叠。运行为每次等待记一次日志——`"fix-auth waits for refactor-login: both declare
  src/auth/**"`，或 `"…: fix-auth declares src/auth/token.ts, refactor-login src/auth/**"`——
  即带 `scopeWait: { for: <agentId>, globs: [mine, theirs] }` 的 `log` 事件。
- **重叠**只看 glob、保守判定：先展开 `{a,b}`；两个字面路径相同才重叠；字面路径与 glob，glob 匹配它
  即重叠；两个 glob，一个的字面前缀（第一个通配符之前）以另一个的字面前缀开头即重叠——
  `src/auth/**` ~ `src/auth/*.ts`、`src/auth/**` !~ `src/db/**`、`src/*.ts` ~ `src/*.md`、`**` ~ 一切。
- **越出范围的写入。** 回复到达后，agent 的改动（按 `expect` 的读法：隔离 worktree 的 diff，或原地
  调用开始以来的改动）与其范围比较。没有任何 glob 匹配的文件记为 `agent_finished`/`agent_failed`
  事件与保存记录上的 `outOfScope`，记日志（`"fixer:1: wrote 1 file outside its scope (src/auth/**)
  — package.json"`），在 `odw agents` 与看板中显示，打开笔记时还作为 `kind: "scope"` 笔记贴到笔记板。
- **策略。** `"warn"`（默认）保留回复。`"fail"` 让 agent 以 `"out_of_scope"` 失败，不重试。设了
  `expect` 时，无论策略如何，越出范围的写入都算一项缺失：带着缺失项重试，之后以
  `"unmet_expectation"` 失败。
- **原地运行时**，落在同时运行的另一个已声明范围调用之范围内的文件不计入本调用；同时运行的未声明范围
  调用的改动会计入。不在 git 仓库中时无法读取改动：记日志，不做检查。
- **事件。** `agent_started` 带 `scope`。`scope` 与 `scopePolicy` 不属于 resume key；被重放的调用
  不等待任何调用，保留记录中的 `outOfScope`。

## schema

schema 就是传给 `agent` 的一个普通 **JSON Schema 对象**：

```js
const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, severity: { type: 'string', enum: ['low', 'medium', 'high'] } },
        required: ['title'],
      },
    },
  },
  required: ['findings'],
}
const result = await agent('Review this diff.', { schema: FINDINGS }) // -> validated object
```

校验器实现以下子集，不是完整的 JSON Schema 标准：

| 写法 | 实际校验 |
|---|---|
| `type` 为单个字符串 | `object`、`array`、`string`、`integer`、`number`、`boolean`、`null` |
| `type: "object"` | `properties`、`required`、`additionalProperties: false` |
| `type: "array"` | `items` 为一个 schema 对象，以及 `minItems` |
| `enum` | 按 JSON 结构比较成员，独立于 `type` 生效 |

对象和数组约束需要显式 `type`。`description`、`title`、`default`、`examples`、`format`、
`$comment`、`$schema` 等注解不构成约束，放在哪里都可以（自 JSON Schema 2019-09 起 `format`
默认只是注解；Claude Code 也不强制执行它）。

**子集之外的内容不会被悄悄放过（ODW 扩展）。** agent 启动前，会检查它的 schema 里有没有
校验器不会强制执行的内容：`const`、`$ref`、`oneOf`/`anyOf`/`allOf`、`minimum`/`maximum`、
`pattern`、`maxItems` 等关键字，schema 对象形式的 `additionalProperties`，元组或布尔 schema，
`["string", "null"]` 这样的类型联合，以及缺少对应 `type` 的对象或数组关键字。由配置里的
`schemaKeywords` 决定怎么处理：

- `"warn"`（默认）——调用照常运行，ODW 校验其余部分；运行日志只说一次哪些关键字它不检查、
  位于何处（`"pattern" at #/properties/id`），以及由谁强制执行：自己校验 schema 的 CLI（它拿到
  了完整 schema），否则无人。
- `"strict"`——在任何东西启动前，调用以 `AgentError` 失败，逐个写明它们。

拼写错误（`requird`、未知的 `type`）或其他格式错误的 schema 在两种模式下都会让调用失败，并附
did-you-mean 提示。想让某个限制处处生效，就写进 `description`（agent 仍会读到），并在工作流里
自行检查。

**原生 schema（ODW 扩展）。** 自己会校验 schema 的 CLI 还会直接拿到完整 schema——`claude`
通过 `--json-schema`（值取自 `structured_output`），`codex` 在 schema 为 strict（根为对象；
每个对象都设 `"additionalProperties": false` 并把全部属性列进 `required`）时通过
`--output-schema`，`agy` 在 schema 根为对象时通过 `--json-schema`（值取自 `structured_output`）
——由它强制执行 ODW 不检查的部分；ODW 依旧校验每一次回复并照常重试。只有不
接收原生 schema 的 CLI 才会在提示词里看到 schema 描述（`"schemaPrompt": "always"` 则全部附上）。
见[适配器](adapters.md#原生结构化输出)。

## 组合模式

这些不是新原语——只是原语加上普通的 JavaScript。

- **扇出 → 归并 → 综合** —— `parallel` 起草，在 JS 里去重/合并，最后一个 `agent` 综合。
- **对抗式核验** —— 找出候选，然后对每个用 `parallel` 跑若干质疑者，只有多数没能证伪它时
  才保留。
- **评审团** —— 从几个角度给同一个产物打分，在脚本里汇总。
- **循环直到无新发现** —— `while` 循环，每轮用 `parallel` 扇出 finder，对着一个 `seen`
  集合去重，连续 K 轮为空才停。

## 确定性规则

乱序执行没问题，**只要你的归并是顺序无关的**（累加进一个集合、去重、计票）。**不要**按哪
个 agent 先跑完来分支，也不要根据完成时机派发后续——那会让运行不可复现。优先使用由输入
决定的 `parallel`/`pipeline` 组合。

这些是编写建议，不是沙箱。默认情况下 ODW 在 worker 自己的上下文中执行正文，Node
全局对象、文件系统和 shell 都触手可及。严格脚本上下文(`scriptContext: "strict"`,ODW 扩展;
触发器、插件与不可信运行的默认值)在一个新的 `vm` 上下文中编译正文，其中只有原语与标准内建
对象——没有 `process`、`require`、`import()`、`fetch`、`console`、定时器、`eval`——脚本用到时
会说明原因;`odw check --capabilities` 列出脚本用到的方言之外的名字。`vm` 同样不是安全边界。
只运行可信脚本；可移植性 warnings 不证明脚本安全，也不保证它能在另一种运行时执行。

resume 依赖同一条规则：调用按 prompt 和选项、按调用顺序匹配，所以用
`Date.now()`/`Math.random()` 拼出的 prompt，或依赖完成时机的派发，都匹配不上，会重新
执行。`odw rerun` 从头开始，不重放任何调用。

## odw eval（ODW 扩展）

`odw eval` 让一个工作流跑一组用例，在一个或多个适配器上各跑若干次，用不需要模型的检查判定每次
运行，并按用例 × 适配器报告通过率、花费与延迟。这是 ODW 扩展，Claude Code 没有对应功能。

```bash
odw eval <file|name> [--adapter a,b] [--repeats N] [--json] [--out report.json]
                     [--baseline report.json] [--config P] [--runs-root DIR]
```

`<name>` 指当前目录下的 `.odw/evals/<name>.json`（与 `.odw/workflows/` 一样纳入 git）；以 `.json`
结尾或含路径分隔符的参数是文件路径。`--adapter`（逗号分隔，或重复给出）与 `--repeats` 覆盖文件中的值。

### eval 文件

```json
{
  "name": "review",
  "description": "可选",
  "workflow": "review",
  "adapters": ["claude", "codex"],
  "repeats": 3,
  "concurrency": 2,
  "budget": 200000,
  "timeout": 900,
  "cases": [
    { "name": "small-diff", "args": { "diff": "…" }, "checks": [{ "state": "done" }] }
  ]
}
```

| 字段 | 含义 |
| --- | --- |
| `workflow` | 必填：工作流名字或脚本路径，与 `odw run` 完全相同地从运行 `odw eval` 的目录解析 |
| `cases` | 必填、非空：`{ name, args?, checks? }`；名字唯一，最多 100 个字符 |
| `adapters` | 可选：每个适配器都作为运行的默认适配器（`odw run --adapter`）跑完全部用例；省略时用配置的默认适配器，报告中写出其名字 |
| `repeats` | 每个用例在每个适配器上的运行次数，1–1000（默认 1） |
| `concurrency` | 同时进行的运行数，1–64（默认 1）；按适配器、用例、重复的顺序派发 |
| `budget` | 可选：token，作为每次运行的 `--budget`（脚本中的 `budget.total`） |
| `timeout` | 可选：每次运行可用的秒数；超时即停止（`odw stop`），并以 `timeout` 失败 |
| `name` | 可选：eval 的名字（字母、数字、`.`、`_`、`-`）；否则取文件名去掉 `.json` |
| `description` | 可选说明，写入报告 |

其他字段、写错的检查、路径或正则都会报 `ConfigError` 并指出位置（`cases[1].checks[0].path: …`），
`odw eval` 在任何运行开始前以 2 退出——未知适配器、无法解析或加载的工作流、不是报告的 baseline 同样如此。

### 检查

每个检查是恰好具有下列一种形态的对象。一次运行满足其用例的全部检查才算通过。没写 `checks`
的用例为 `[{ "state": "done" }]`；写了检查的用例只判这些（需要时自己加上 `{ "state": "done" }`）。

| 检查 | 通过条件 |
| --- | --- |
| `{ path, equals }` | `path` 处的值与 `equals` 深度相等（不计键顺序） |
| `{ path, contains }` | 该处的字符串包含该字符串；该处的数组有与之深度相等的元素 |
| `{ path, matches, flags? }` | 该处的字符串匹配正则（flags 取自 `i m s u`）；其他值按其 JSON 匹配 |
| `{ path, exists }` | `true`：`path` 指向一个值（`null` 也算）；`false`：不指向任何值 |
| `{ command, timeout? }` | shell 命令以 0 退出；在项目目录中执行，设置 `ODW_RESULT`（存放运行结果 JSON 的临时文件；运行未以 `done` 结束时为 `null`）、`ODW_RUN_ID`、`ODW_EVAL_NAME`、`ODW_EVAL_CASE`、`ODW_EVAL_ADAPTER`、`ODW_EVAL_REPEAT`；`timeout` 秒后被杀（默认 300） |
| `{ state }` | 运行以 `"done"`、`"failed"` 或 `"stopped"` 结束 |
| `{ maxCostUsd }` | 运行中 agent 的花费（按各 CLI 上报）不超过该值；花费未知即不通过 |
| `{ maxSeconds }` | 运行从 `run_started` 事件到结束不超过该秒数 |

`path` 用点/方括号写法指向运行的返回值：`verdict`、`findings[0].file`、`items.2`（数字键可索引
数组）、`["odd.key"]`、`['odd key']`；`""` 表示整个结果。只沿对象自身的键查找。

### 运行

每个用例 × 适配器 × 重复都是运行目录中的一次真实 odw 运行，像 `odw run` 一样从当前目录启动，
以单元格的适配器作为 `--adapter`（默认适配器时不传），并带上 eval 的 `budget`。其 `meta.json`
含 `origin: "eval"` 与 `eval: { name, case, adapter, repeat }`；`odw list` 显示
`(eval <name> · <case> · <adapter> #<repeat>)`，`GET /api/runs` 的摘要带 `eval`。运行遇到的
`checkpoint()` 与普通运行一样等待回答（进度中会提示）；请给 eval 设 `timeout`。

Ctrl-C（SIGINT、SIGTERM、SIGHUP）会停止本次 eval 启动的所有运行——各写一个停止请求——最多等
30 秒让它们结束（再按一次 Ctrl-C 不再等待），不保存报告，并以该信号结束 `odw eval`。

### 输出与退出码

每完成一次运行在 stderr 打印一行进度。随后 stdout 输出表格——每个用例 × 适配器：通过 k/n、
耗时中位数、总花费与平均花费、平均 token（输入 + 输出）；总计；每个失败运行的运行 id 及其没通过的
每项检查——或在 `--json` 时输出报告。带 `--baseline` 时再输出一张表：每个单元格的通过率（A → B），
以及通过率、平均花费、耗时中位数的 B − A，最后列出退步的单元格。

全部运行通过——或带 `--baseline` 时没有单元格的通过率低于 baseline——退出 0（原本就失败的不算
退步）；否则 1；用法错误为 2。

### 报告

保存在 `<runsRoot>/_evals/<name>/<id>.json`，写到 `--out`，由 `--json` 打印，被 `--baseline` 读回；
`GET /api/evals` 列出已保存的报告（最新在前），`GET /api/evals/:name/:id` 返回单份，均只读。字段：

- `version`（1）、`name`、`id`（开始时间加 6 位十六进制）、`file`、`description`
- `evalHash`：实际运行的定义的 sha256（键排序、已应用命令行参数）；`definition`：该定义
- `workflow`：`{ ref, script, sourceHash }`；`odwVersion`；`cliVersions`：`{ <adapter>: [各运行 cli_version 事件记录的版本] }`
- `startedAt`、`finishedAt`（ISO 8601）、`wallMs`
- `totals`：`{ runs, passed, failed, passRate, costUsd, inputTokens, outputTokens }`
- `cells`：`[{ case, adapter, runs, passed, passRate, medianMs, costUsd, meanCostUsd, meanTokens, runIds }]`
- `runs`：`[{ runId, case, adapter, repeat, state, passed, timedOut, wallMs, inputTokens, outputTokens, costUsd, estimated, cliVersions, error, failures: [{ check, message }] }]`
- `baseline`：null，或 `{ file, name, id, evalHash, sameDefinition, cells: [{ case, adapter, status, passRate, meanCostUsd, medianMs }], regressed: [{ case, adapter }] }`——每个数值为 `{ a, b, delta }`（A 为 baseline，delta 为 B − A）；`status` 为 `regressed`（通过率下降）、`improved`、`unchanged`、`new` 或 `missing`

花费与 token 只对上报了它们的运行求和与平均，都未上报时为 null。任意两个运行 id 都可以用
`odw compare <runA> <runB>` 对照。

## odw new（ODW 扩展）

```bash
odw new                                          # 列出模板，每行一个（stdout）
odw new <模板> [--name N] [--force] [--yes]
```

模板内置在二进制里：`hello`（两个只读 agent 并行，纯 JS 挑选）、`review-swarm`、
`fix-until-green`、`plan-approve-execute`、`pr-shepherd`、`fan-out-reduce`（即同名示例）。
在当前目录下写入：

| 文件 | 内容 |
| --- | --- |
| `.odw/workflows/<名字>.js` | workflow；`meta.name` 为 `<名字>` |
| `.odw/tests/<名字>.json` | 带脚本化回复的起步用例：`odw test <名字>` 立即通过，$0 |
| `.odw/evals/<名字>.json` | 仅 review-swarm 与 pr-shepherd：eval 骨架（真实运行——先编辑） |

- `--name`（默认为模板名）——字母、数字与 `. _ -`（不能打头），最长 128，不能以 `.js` 结尾——
  在三个文件里替换模板名。
- 已存在且内容不同的文件是冲突：不加 `--force` 时什么都不写，逐个列出冲突，退出 1。已经与模板
  完全相同的文件保持不动，所以同一条命令跑两次也退出 0。
- 在根目录没有 `.worktreeinclude` 的 git 仓库里，会打印一份建议：根目录的 `.env*` 文件（不含
  `*.example`、`*.sample`、`*.template`、`*.dist`），然后是 `symlink: node_modules`（对应
  `package-lock.json`、`npm-shrinkwrap.json`、`yarn.lock`、`pnpm-lock.yaml`、`bun.lock`、
  `bun.lockb`）、`symlink: .venv`（`uv.lock`、`poetry.lock`、`Pipfile.lock`、`pdm.lock`）、
  `symlink: vendor`（`composer.lock`）。加 `--yes` 或在终端提示里回答 yes 才写入，否则只打印。
- 退出码：0 已写入（或已存在），1 拒绝覆盖，2 用法错误（未知模板、名字不合法）。
- `odw init`（不带 `--check`）最后是首跑：在终端里先询问（回车即 yes），若
  `.odw/workflows/hello.js` 不存在则写入 `hello`，运行 `odw run hello --dry`，再打印
  `odw serve --open`、`odw test hello` 与 `odw run hello`；不在终端时只打印命令。它从不调用模型。

## odw test（ODW 扩展）

```bash
odw test [<wf|file.json>] [--case N|name]... [--json] [--keep] [--runs-root DIR] [--config P]
odw run <wf> --dry
odw run <wf> --record [--record-to FILE]
```

`odw test` 把工作流的测试用例作为真实的 odw 运行在进程内执行——worker、调度器、bridge、schema
校验与重试、回退链、运行存储——每个 agent CLI 都由内置 mock 替换，按用例的脚本化回复作答，不调用
任何模型。`<wf>` 指 `.odw/tests/<wf>.json`；`.json` 结尾或含路径分隔符的是文件；不给参数则运行所有
`.odw/tests/*.json`。运行放在临时运行存储中，结束后删除（`--keep` 或 `--runs-root DIR` 可保留），标记为
`origin: "test"`。

### 测试文件

| 键 | 含义 |
| --- | --- |
| `workflow` | 名字或路径，与 `odw run` 一样从运行 `odw test` 的目录解析。缺省：文件名去掉 `.json`。 |
| `default` | 文件级回复，应答没有条目匹配的 agent（不带匹配条件的条目）；用例自己的 `default` 优先。缺省：这样的 agent 让用例失败。 |
| `cases[].args` | 工作流输入；缺省为 null。 |
| `cases[].replies` | 回复条目，见下。 |
| `cases[].expect` | 必须得到的结果，见下。缺省：`{ "state": "done" }`。 |
| `cases[].checkpoints` | `"approve"` 或 `"reject"`：每个 `checkpoint()` 都这样应答。缺省：它会等待，用例最终超时。 |
| `cases[].timeout` | 秒数（默认 120）；届时仍在运行则停止，用例失败。 |

其他键都是错误，并指明位置；什么都不会运行。

**回复条目。** 匹配条件——给出的每一个都须成立，第一个匹配的条目作答：`label`（glob：`*`、`?`）、
`phase`（glob；不在任何阶段的 agent 不匹配）、`prompt`（子串）、`adapter`（glob；回退后为转到的适配器）。
恰好一种作答：`reply`（字符串原样，其他值按 JSON——即 schema 调用的值）、`fail`（`rate_limit` |
`quota` | `auth` | `permission` | `timeout` | `stalled` | `not_found` | `exit`：措辞让 ODW 的失败分类像
真实失败一样识别——限流会无等待地重试 `transientRetries` 次，额度用尽会沿回退链转移）、`empty: true`
（空回复）、`dry: true`（`--dry` 的桩）。修饰：`schemaMiss: N`（前 N 次尝试回复任何 schema 都不接受的
文本，然后作答：用于检验 schema 重试；与 `reply` 或 `dry` 同用）、`delayMs`（延迟作答：控制完成顺序）、
`once: true`（只回答一个 agent——包括它的所有尝试——之后即用完；同一标签的 agent 依次取用）。
没有条目匹配且无 `default` 的 agent 会得到一个失败的 CLI，并让用例失败：
`unscripted agent \`label\` (agent #N, phase P)`。

**`expect`。** `state`（默认 `"done"`，或 `"failed"`、`"stopped"`）、`error`（运行错误中的子串）、
`checks`（上文 `odw eval` 的检查词汇：`{ path, equals | contains | matches | exists }`、`{ command }`
——带 `ODW_RESULT`、`ODW_RUN_ID` 与 `ODW_TEST_CASE`——`{ state }`、`{ maxSeconds }`、按 $0 判定的
`{ maxCostUsd }`）、`agents: { count, labels }`（启动的 agent 数；标签作为多重集恰好相等）、`logs`
（`log()` 行中的子串，按此顺序，中间可有其他行）。

**输出与退出码。** 每个用例一行（✔/✖、名字、agent 数、耗时，随后每个未满足的期望写作
`check: 实际发现`）。`--json`：`{ version: 1, odwVersion, passed, failed, runsRoot, cases: [{ file,
workflow, case, name, passed, failures: [{ check, message }], runId, state, agents, durationMs }] }`。
全部通过退出 0，有失败为 1，用法错误为 2（错误的参数或文件、未知用例、无法加载的工作流）。

**mock。** 配置中的每个适配器都按名字保留（因此 `agent(p, { adapter })`、阶段默认值与回退链照常解析），
但都运行 mock：纯文本输出、schema 以原生方式传入（提示词中不含 schema 文本）、所有权限档位都视为可执行、
无沙箱、不探测 CLI 版本、不触发 notify 钩子、不导出 OpenTelemetry、不等待额度、不运行 worktree setup 命令。
配置没有可用的默认适配器时，会得到一个名为 `mock` 的。`exec()`、`isolation: "worktree"` 等照常真实执行。

**`odw run <wf> --record [--record-to FILE]`。** 一次真实运行（花费与普通运行相同），运行结束后其 worker
向 `FILE`（默认运行源目录下的 `.odw/tests/<meta.name>.json`；不存在则创建，同名用例被替换，其余保留）
追加一个名为 `recorded <run_id>` 的用例：它的 `args`、每个 agent 一个回复条目——`{ label, phase?, reply }`
为运行保存的值，失败的 agent 为 `{ fail: <失败类别> }` / `{ empty: true }`——以及
`expect: { state, error?, checks?: [{ path: "", equals: <结果> }], agents: { count } }`（结果的 JSON 少于
8,000 字符时才比较）。同一标签与阶段但回复不同的 agent 各得一个 `once` 条目，按启动顺序。用运行的脱敏器
脱敏（包括输入）；每个字符串截断到 4,000 字符；最多 500 个条目。不能与 `--dry` 或 `--on` 同用。

**`odw run <wf> --dry`。** 每个 agent 都由桩应答：`"(dry run)"`，或对 schema 调用给出最小合法值——只含必需
属性、`minItems` 个元素、`const` / `enum` 的第一个值、`anyOf`/`oneOf` 的第一个分支、合并后的 `allOf`、
跟随本地 `$ref`、边界允许的最小数、`""`（或 `minLength` 个 `"x"`；已知的 `format` 给出样例）。运行在
`meta.json`（以及看板摘要）中标记为 `dry: true`；`odw run --dry` 会等待它结束（不可 `--detach`），并在
stderr 打印阶段树：每个声明或启动过的阶段、它启动的 agent 数及其标签。

## 调试：odw check、odw replay、--break / --step（ODW 扩展）

```bash
odw check wf.js [--json]                      # 按运行的方式加载（绝不执行）：退出 0，或退出 1 并给出 文件:行:列 + 代码片段
odw replay $RUN --agent <id|label> [--prompt @文件|文本] [--adapter A] [--model M] [--wait|--fg|-d]
odw run wf.js --break <阶段|label>[,…] [--break …]    # 在这些阶段 / agent label 之前加一个检查点
odw run wf.js --step                                  # 在每个阶段之前加一个检查点
```

- **check**：`meta` 字面量、其 name/description/phases、编译脚本体。解析错误保留编译器原话并附
  `(line 行:列)`；只在合适时附提示（TypeScript 语法、非 async 回调里的 `await`、括号未闭合脚本就
  结束了）。`validate()` 给出同样的内容。警告中包括 Claude Code 的限制：源码字面量即可判定（数组
  字面量、`Array.from({ length: n })`、`Array(n)`、`[...Array(n)]`）超过 4,096 项的
  `parallel()`/`pipeline()`——Claude Code 会拒绝，ODW 照常运行；以及不是纯字面量的 `meta`。
- **replay**：每次 `agent()` 调用开始时保存 `agents/<id>.call.json`（提示词、选项、开始时的适配器、
  请求的模型）；隔离 agent 的 `agent_started` 带 `base`（其 worktree 的提交）。重跑是只含这一个调用的
  新运行（`origin: "replay"`、`replayOf: { runId, agentId, label, base? }`）——label、phase、源码目录、
  配置、权限档位、信任级别、沙箱都与原来相同，`isolation: "worktree"` 时检出原来的 `base`，不管现在
  HEAD 在哪。`odw compare <原运行> <重跑> --agent <label>` 把两者配对（CLI 会打印该命令，label
  被共用时用 id）。本版本之前的运行没有保存调用：用 `odw rerun`。
- **--break / --step**：断点就是运行自己发起的 `checkpoint()`，标题 `Break before phase X` /
  `Break before agent X`，payload 为 `{ before, phasesDone, agents: { done, failed, running },
  results: [最近 20 个], args }`——用 `odw approve|reject`、看板或手机链接回答。`phase(X)`（无法等待）
  之后调用的每个 `agent()`、`exec()`、`workflow()` 和 `checkpoint()` 都停住直到有答复；已在跑的 agent
  继续。批准：继续。拒绝：运行停止（状态 `stopped`）。批准并修改 payload：只采用 `args`，且只在
  `args` 为对象或数组并保持同类时原地修改——答复之后的读取会看到修改，此前读到的（包括被拦住的
  那次调用自己的提示词）不变。其他修改会被拒绝并记一行日志。`meta.json` 保留原始 args（rerun/resume 用它）。

## odw conformance

```bash
odw conformance [--json] [--case N|name]... [--dir DIR]
```

把方言的行为写成可运行的用例（ODW 仓库的 `conformance/`，随 npm 包发布）：每个用例是一份
Claude Code 方言的普通工作流脚本，配一个 `expected.json`——返回值，以及要紧的日志、phase 和
agent——由确定性的 mock agent 按用例里的表作答。`odw conformance` 把每个用例当作一次真实的
odw 运行来跑，逐个打印通过与否；任一失败退出码为 1，未知用例或不符合格式的套件为 2。每个用例
要么是 `documented`（Claude Code 的文档确定了该行为），要么是 `unspecified`（文档没有确定；
用例记录的是 ODW 的行为——也就是可能出现差异的地方）。通过一致性测试的脚本两边都能跑：只依赖
documented 用例所确定的行为。这条命令属于 ODW；用例本身可以在 Claude Code 上手动运行，
`conformance/README.md` 说明了格式，供其他运行时实现自己的 runner。

## 限制

- **并发上限** —— 同时最多跑 N 个 agent CLI（默认 `min(16, cpus-2)`；在配置里设
  `concurrency`）。多出来的调用排队。适配器自己的 `concurrency` 在此之内限制它的 agent，
  一次限流会让它在本次运行中减半；在 `claude` 上，提示共享较长前缀的扇出会错开启动
  （均为 ODW 扩展；见 `references/adapters.md`）。
- **agent 总量兜底** —— 单次运行派发量的硬上限（默认 1000）。超过就中止运行，这样一个有
  bug 的循环不会无限扇出。
- `exec()` 命令不计入以上任何一项限制；每条命令由它自己的 `timeout` 和
  `maxOutputBytes` 约束。
- 等待中的 `checkpoint()` 同样不计入任何一项限制；如果设了 `timeout`，等待时长由它限定。
