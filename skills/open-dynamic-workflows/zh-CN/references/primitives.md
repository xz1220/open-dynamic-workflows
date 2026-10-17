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
- **opts.agentType** —— 注入进 prompt 的**人设**（如 `"code-reviewer"`），因此在任何 CLI
  上都生效。它**不是** adapter 名，永远不影响 adapter 选择——只有 `opts.adapter` 才会。
  它不会加载 Claude 内置角色的权限、工具或项目里的子 agent 定义。
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
- **opts.expect**（**ODW 扩展**）—— agent 回复之后必须成立的条件，由 odw 检查：
  `{ changes?, files?, command?, match?, timeout? }`。见 [expect](#expectodw-扩展)。
  Claude Code 会忽略它。
- **opts.expectRetries**（**ODW 扩展**）—— 没达到 `expect` 的工作带着缺失项重跑的次数
  （默认取 `expectRetries` 设置，即 1）。
- **opts.allowEmpty**（**ODW 扩展**）—— 接受空回复或只有空白的回复作为答案。不设时，空回复
  会让调用以 `"empty_reply"` 失败。（CLI 拒绝工具调用默认不会让调用失败：它们会记为
  `denied`——见 [expect](#expectodw-扩展)。）

返回回复文本，设了 `schema` 则返回校验过的 JSON 值。CLI 出错、schema 重试耗尽、工作没达到
`expect`、空回复都会抛错；这些可恢复失败在 `parallel`/`pipeline` 内变成 `null`。停止请求、
预算耗尽和 agent 总量上限以及无效的 adapter/运行配置属于 fatal 错误，会继续向上抛出并终止
运行。失败的 CLI 运行抛出的错误带有 `reason`（`rate_limit`、`quota`、`auth`、`timeout`、
`stalled`、`not_found`、`permission`、`exit`、`empty_reply` 或 `unmet_expectation`），与它的
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
  CLI 额度用尽或登录被拒时，调用会在下一个适配器上重新运行——全新的提示词、相同的选项。限流
  仍在原地重试（`transientRetries`）；其他失败都算调用自己的。每次切换记一行日志
  （`search:3 → claude after codex quota`）；调用会在新适配器上取得槽位，先释放旧适配器的；
  它的 transcript 在一行 `{"kind":"attempt","reason":"fallback","adapter":"claude"}` 之后
  继续；失败的那些运行花掉的用量照样计入。回退时沿用调用自己的权限档位——不能恰好运行该档位
  的适配器会被跳过并记一行日志。`agent_finished` 和保存的结果会写明产出结果的适配器
  （`adapter`）和离开过的那些（`fellBackFrom`）；发生过回退的 `agent_failed` 也会写明。
- **额度熔断。** 同一个适配器上连续 `quotaBreaker`（默认 3）次额度失败后，本次运行之后的
  调用都会跳过它：各自从回退链上的下一个适配器开始，没有回退链的则立即失败（原因为 `quota`）。
  只记一条警告。

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
自己的计数（内置 `claude` 会上报——ODW 扩展），否则这次 CLI 运行按 `ceil(回复字符数 / 4)`
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
checkpoint(title, opts?) -> Promise<{ approved, note, by }>
```

暂停运行，直到有人批准或拒绝——用在昂贵或难以撤销的步骤之前，或让人确认一份计划。它
不可移植：Claude Code 的 workflow 运行中不接受输入，也没有 `checkpoint` 全局
（`validate()` 会对此给出 warning）；脚本自己声明的 `checkpoint` 绑定优先于注入的版本。

- **title** —— 问题，单行（空白会被合并；事件、`status.json` 和看板保留 200 个字符）。
- **opts.payload** —— 要给人看的内容：任意 JSON 值。它会被转成 JSON 安全的形式（BigInt
  变成数字字符串，循环引用变成 `"[Circular]"`），最多保留 64 KiB；更大的只保留开头一段
  文本，事件里会标注 `truncated`。
- **opts.timeout** —— 等待的秒数；默认不限。
- **opts.onTimeout** —— 无人回答时的含义：`"approve"` 或 `"reject"` 以 `by: "timeout"`
  返回；`"fail"`（默认）抛出 `CheckpointTimeout`——与 agent 失败一样可恢复：可以 catch，
  也可以交给 `parallel`/`pipeline` 变成 `null`。

调用返回 `{ approved, note, by }`：`note` 是对方的附言或 `null`；`by` 是 `"cli"`
（`odw approve|reject`）、`"dashboard"`（`odw serve`）或 `"timeout"`。拒绝也是一个答复，
不是错误：它意味着什么由脚本决定——停止、带着附言重新规划、跳过某一步。

等待不是工作：检查点不占并发槽位，不计入 agent 总量上限和预算，运行暂停时也照样提问；
已在运行的 agent 继续运行。停止（或任何致命错误）会立刻结束等待，运行也随之结束。多个
检查点可以同时等待（在 `parallel` 里），按调用顺序编号（`checkpointId`，从 1 开始）。
误用（空标题、非正数的 timeout）会在提问之前就抛错。

等待期间，运行的展示状态是 `waiting`：`odw status` 会显示问题、payload，以及确切的
`odw approve|reject <run> --checkpoint N` 命令，看板则显示一张 Approve/Reject 卡片。
不带 `--checkpoint` 的答复会交给最早在等待的检查点。每个检查点都记录为
`checkpoint_requested { checkpointId, title, payload, phase }`，随后恰好一个
`checkpoint_resolved { checkpointId, approved, note, by }`（运行先结束时带 `error`，且
`by: null`）。`odw resume` 永远不会重放检查点：恢复出来的运行会重新提问。

```js
phase('Plan')
const plan = await agent(`Plan this as independent steps: ${task}`, { schema: PLAN })
phase('Approve')
const { approved, note } = await checkpoint(`Run this ${plan.steps.length}-step plan?`, {
  payload: plan,
  timeout: 3600,
  onTimeout: 'reject', // 一小时内没人回答：什么都不改
})
if (!approved) return { approved, note, plan }
phase('Execute')
await parallel(plan.steps.map((step) => () => agent(step.instructions)))
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

一次调用的每次尝试（schema 重试、卡死重启）都会得到一个新的 worktree，并以同样方式准备。

每个 agent 进程——不论是否隔离——都会拿到三个变量（**ODW 扩展**）：

| 变量 | 值 |
| --- | --- |
| `ODW_RUN_ID` | 本次运行的 id |
| `ODW_AGENT_ID` | 这个 agent 的 id，与它的事件和 `odw agents` 里的一致 |
| `ODW_PORT` | 来自 `portRange`（默认 41000–41999）的一个端口，本次运行中没有其他正在运行的 agent 占用它——已经有程序在监听的端口会被跳过——直到这次调用结束都归它所有 |

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
odw apply <run> --agent <id|label> --check
odw apply <run> --agent <id|label>       # 用 git apply --3way 应用到你所在的工作树
```

`odw apply` 会暂存能应用的部分，在 hunk 冲突处留下冲突标记（退出码 1）；只要 diff 涉及的
路径上有未提交改动它就拒绝，除非加 `--force`。改动不同文件的多个 agent 可以依次应用。超过
`maxDiffBytes`（默认 2 MB）的 diff 只保留开头，并以一行 `# odw: diff truncated …` 结尾；
计数仍描述完整改动，但 `odw apply` 会拒绝它——请改用该 agent 的分支（`keep: true` 或
`keepBranches`）。一次调用的每次尝试都在新的 worktree 里进行：只重排回复格式的 schema
重试会保留之前那次尝试的改动；卡死重启、限流重试或 `expect` 重试会重做工作，所以它的改动
取代之前的。`odw resume` 会把重放 agent 的 diff 复制到新运行里。

## expect（ODW 扩展）

```js
agent(prompt, { expect: { changes?, files?, command?, match?, timeout? }, expectRetries?, allowEmpty? })
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

检查在回复到达、并通过 `schema` 校验之后进行。agent 改了什么从 git 读取。原地运行时，是与
agent 第一次 CLI 运行前的源码树相比的差异：你自己未提交的改动和运行目录不算，agent 的提交算
——同时原地运行的其他 agent 的改动也会算进来，所以需要分清各自改动的 agent 请用隔离。原地
使用 `expect.changes` 或 `expect.files` 需要 git 仓库（否则调用在 CLI 启动前失败）。用
`isolation: "worktree"` 时，就是运行为该 agent 保留的那份 diff；只重排回复格式的 schema 重试，
按真正干活的那次尝试来评判。

没达到要求的工作会重跑——`expectRetries` 次（默认 1，或取 `expectRetries` 设置）——并把缺失
项追加到提示词里，失败命令的输出也一并附上；隔离的重试会在全新的 worktree 里从头开始。每次重试
都会记日志，transcript 里标为 `{"kind":"attempt","reason":"expect"}`。仍未达到时，调用抛出
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

没设 `expect` 时：空回复或只有空白的回复会以 `"empty_reply"` 抛错，除非设了
`allowEmpty: true`。声称成功、但 CLI 拒绝了工具调用的回复照常成立——这些调用作为 `denied`
记在 agent 的 `agent_finished` 事件和保存的结果上，运行也会记一行日志——除非设了
`"permissionDenials": "fail"`（运行级，或写在适配器条目里），此时以 `"permission"` 抛错并
列出它们。两种失败都不重试。`expect` 属于调用的 resume key；Claude Code 会忽略它，在那里检查
不会执行。

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
`--output-schema`——由它强制执行 ODW 不检查的部分；ODW 依旧校验每一次回复并照常重试。只有不
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

这些是编写建议，不是沙箱。ODW 用 `AsyncFunction` 执行 JavaScript，不隔离脚本对 Node
全局对象、文件系统和 shell 的访问。只运行可信脚本；可移植性 warnings 不证明脚本安全，
也不保证它能在另一种运行时执行。

resume 依赖同一条规则：调用按 prompt 和选项、按调用顺序匹配，所以用
`Date.now()`/`Math.random()` 拼出的 prompt，或依赖完成时机的派发，都匹配不上，会重新
执行。`odw rerun` 从头开始，不重放任何调用。

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
