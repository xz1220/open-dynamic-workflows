# 原语参考

<sub>[English](../../references/primitives.md) · 简体中文</sub>

原语是 workflow 脚本里的**注入的全局**——绝不 import。脚本体运行在 async 上下文里（顶层
`await` 和顶层 `return` 都合法），`meta` 在最顶部用 `export const meta` 声明
（`meta.name` 和 `meta.description` 必填；文件里不得出现任何其他顶层
`import`/`export`）。

## agent

```js
agent(prompt, opts?) -> Promise<string | object>
```

让一个 coding agent 跑 `prompt`。唯一真正干活的原语；其它原语都只是在组织对它的调用。

- **opts.schema** —— 一个 JSON Schema 对象。给了它，回复就会被解析并校验，并带着纠正反馈
  重试 agent，直到符合契约或重试预算耗尽（届时这次调用抛错）。不给，则返回原始回复文本。
- **opts.label** —— 进度显示用的短名字。
- **opts.phase** —— 为这一次调用覆盖当前 phase。在 `parallel`/`pipeline` 里优先用它，那里
  全局 phase 是共享的。
- **opts.adapter** —— 用哪个配置好的 CLI（如 `"codex"`）；默认用配置里的 `defaultAdapter`。
- **opts.model** —— 一个 model id，转发给该 adapter 声明的 model 旗标（如
  `claude --model …`）。若 adapter 没在配置里声明 `flags.model`，该选项也不会被静默丢弃
  ——运行日志里会出现一条路由说明。model id 不能跨 CLI 通用。
- **opts.agentType** —— 注入进 prompt 的**人设**（如 `"code-reviewer"`），因此在任何 CLI
  上都生效。它**不是** adapter 名，永远不影响 adapter 选择——只有 `opts.adapter` 才会。
- **opts.isolation** —— `"worktree"` 表示请求隔离；由默认的 copy 隔离工作区满足。

返回回复文本，设了 `schema` 则返回校验过的对象。硬失败时抛错（CLI 出错，或 schema 始终
没通过校验）。**在 `parallel`/`pipeline` 内部，抛错的调用会变成一个 `null` 槽位，而不是
抛出。**

## parallel

```js
parallel(thunks: Array<() => Promise<T>>) -> Promise<Array<T | null>>
```

并发执行每个零参 thunk，并**等它们全部完成**（屏障）。结果按输入顺序返回；抛错的 thunk
在它的槽位里给出 `null`，所以一次失败不会拖垮整批。

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

抛错的 stage 会把那个条目降为 `null` 并跳过它剩下的 stage。只有一个 stage 的
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
`budget.total ? Math.floor(budget.total / 120_000) : 5`。v1 里 `spent()` 是尽力而为的
占位（`0`），`remaining()` 就是 `total`（没设目标时为 `Infinity`）；真实的 token 计量是
v1.5+ 的增量。

## workflow

```js
workflow(nameOrRef, args?) -> Promise<unknown>
```

内联调用另一个 workflow。这个全局是为兼容 Claude 方言而注入的，但 **odw 尚未实现**——
调用会抛出明确的 "not implemented" 错误。当下请改用 `agent`/`parallel`/`pipeline`
组合。

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

支持的关键字：`type`（object/array/string/integer/number/boolean/null）、`properties`、
`required`、`additionalProperties`、`items`、`minItems`、`enum`。schema 正是多阶段流水线
可靠的原因：没有它，下游 stage 只能解析自由文本，组合就成了碰运气。

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
个 agent 先跑完来分支，也不要根据完成时机派发后续——那会让运行不可复现。这正是 v1 提供
`parallel`/`pipeline`（由输入决定的批量派发）、而非裸的、逐个 await 的 future 的原因。

## 限制

- **并发上限** —— 同时最多跑 N 个 agent CLI（默认 `min(16, cpus-2)`；在配置里设
  `concurrency`）。多出来的调用排队。
- **agent 总量兜底** —— 单次运行派发量的硬上限（默认 1000）。超过就中止运行，这样一个有
  bug 的循环不会无限扇出。
