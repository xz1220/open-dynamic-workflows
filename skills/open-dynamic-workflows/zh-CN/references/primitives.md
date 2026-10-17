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
- **opts.label** —— 进度显示用的短名字。
- **opts.phase** —— 为这一次调用覆盖当前 phase。在 `parallel`/`pipeline` 里优先用它，那里
  全局 phase 是共享的。
- **opts.adapter** —— 用哪个配置好的 CLI（如 `"codex"`）；默认用配置里的 `defaultAdapter`。
- **opts.model** —— 一个 model id，通过 adapter 的 `{model}` 模板占位符或
  `flags.model`（如 `claude --model …`）转发。两者都没有时，使用 CLI 自己的默认模型，
  并记录该选项被忽略的路由说明。model id 不能跨 CLI 通用。`meta.model` 和
  `meta.phases[].model` 可作为元数据读取，但不决定执行模型；需要指定模型的每次
  `agent()` 调用都应显式传 `{ model }`。
- **opts.agentType** —— 注入进 prompt 的**人设**（如 `"code-reviewer"`），因此在任何 CLI
  上都生效。它**不是** adapter 名，永远不影响 adapter 选择——只有 `opts.adapter` 才会。
  它不会加载 Claude 内置角色的权限、工具或项目里的子 agent 定义。
- **opts.isolation** —— `"worktree"` 给这个 agent 一个一次性 **git worktree**（默认工作区
  就是 source 目录本身）。要求 source 是有提交的 git 仓库；agent 看到 HEAD，不包含
  未提交改动。调用结束后清理 worktree，不把改动合入 source。`agent()` 只返回回复，
  不返回 diff 或可保留的 worktree 路径；需要保留的交付物应进入回复，或显式保存到临时
  worktree 之外。

返回回复文本，设了 `schema` 则返回校验过的 JSON 值。CLI 出错或 schema 重试耗尽会抛错；
这些可恢复失败在 `parallel`/`pipeline` 内变成 `null`。停止请求、估算预算耗尽和 agent
总量上限以及无效的 adapter/运行配置属于 fatal 错误，会继续向上抛出并终止运行。

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
phase(title)    // group following agent calls under a named phase
log(message)    // emit a one-line progress event
```

两者都只用于观测。`phase` 设置一个运行级的全局当前 phase；在并发段落里改为给 `agent` 传
`{ phase }`，因为那个全局是共享的。

## args / budget

```js
args                                  // the workflow input, injected verbatim
budget // { total: number | null, spent(): number, remaining(): number }
```

`args` 是你用 `--args` 传入的任何东西（解析后的 JSON，或一段原始字符串；*看起来像*
JSON 但解析失败的输入会被拒绝，不会悄悄按字符串传入）。`budget.total`
是用 `odw run … --budget <tokens>` 设的 token 目标，否则为 `null`；按它扩缩深度，例如
`budget.total ? Math.floor(budget.total / 120_000) : 5`。

`spent()` 按本次运行所有成功调用的最终回复字符数总和除以 4 后向上取整，包含子工作流。
输入 token、失败调用和 schema 重试的中间回复不计入。`remaining()` 为
`max(0, total - spent())`；没设目标时为 `Infinity`。

调度器拿到执行槽位并检查暂停/停止后，如果估算值已达到目标，就拒绝新的 agent 调用。
已经运行的调用仍可完成并使估算值超过目标。因此它是按估算值限制后续派发，不是实际
token 用量或费用的硬上限。

## workflow

```js
workflow(nameOrRef, args?) -> Promise<unknown>
```

内联执行另一个 workflow，并返回它的最终值。字符串从受管工作流目录按名解析；
`{ scriptPath }` 相对本次运行的 source 目录解析。子工作流共享父运行的调度器、并发上限、
agent 计数、控制和估算预算。其 phase 带 `▸ <name>` 前缀，不创建独立 run id。
省略子工作流的 `args` 时传入 `null`，不会继承父运行的输入。

只支持一层嵌套：子工作流再调用 `workflow()` 会抛错。文件不存在、名称无法解析或子脚本
无效也会抛错；调用位于 `parallel`/`pipeline` 内时，普通错误可变成 `null`。

## validate（ODW 扩展）

`validate(source)` 加载候选工作流但不执行其 body，返回 `{ ok, meta?, errors, warnings }`。
加载时 `meta` 按纯字面量解析、从不求值，body 只编译不执行。
warnings 提示 `Date.now()`、`Math.random()`、调用仅 ODW 提供的 `exec()` 等部分可移植性风险，
不阻止执行。这个 helper
不属于共享的核心原语；脚本自己声明的 `validate` 绑定优先于注入的 helper。

## resume（ODW 扩展）

对一个已结束的运行——done、failed、stopped，或 worker 死掉后变成 stale——执行
`odw resume <run>`，会用同样的脚本、args 和 adapter 启动一个新运行。新运行里，当一次
`agent()` 调用的*恢复键*与旧运行保存的调用一致时，它会**重放**：立即返回旧运行保存的值，
不调用 adapter、不占并发槽位、不计入派发数、不消耗预算。恢复键是 prompt 加上
`schema`、`adapter`（调用里写的值，而不是运行的默认值）、`model`、`agentType`、
`isolation` 和 `label` 的 sha256。`phase` 不在键里；resume 时的 `--adapter` 只改默认值，
所以没指定 adapter 的调用仍会重放。同一个键的多次调用按调用顺序重放（第 n 次这样的调用
拿到第 n 个保存的结果）；超出的调用，以及 prompt 或选项改变的调用，照常执行。嵌套的
`workflow()` 调用同样会重放。

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
- **opts.env** —— 额外的环境变量，叠加在 worker 自身环境之上。
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

对象和数组约束需要显式 `type`，缺少时跳过这些检查。schema 对象形式的
`additionalProperties`、元组/布尔 schema 和联合类型数组都不属于支持的子集。
`const`、`$ref`/`$defs`、`oneOf`/`anyOf`/`allOf`、`minimum`/`maximum`、`pattern`、
`format`、`maxItems` 等未支持的关键字不会强制校验：它们可能仍作为提示发给 agent，
但校验通过不代表满足这些约束。未知 `type` 会产生校验错误。请将 schema 改写为支持的
子集，或在工作流中显式检查额外约束。

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
  `concurrency`）。多出来的调用排队。
- **agent 总量兜底** —— 单次运行派发量的硬上限（默认 1000）。超过就中止运行，这样一个有
  bug 的循环不会无限扇出。
- `exec()` 命令不计入以上任何一项限制；每条命令由它自己的 `timeout` 和
  `maxOutputBytes` 约束。
