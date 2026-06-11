---
name: open-dynamic-workflows
description: >
  编写并运行 dynamic workflow：用 Claude Code 的 workflow 方言写一段简短的 JavaScript
  脚本，再用 `odw` CLI 在宿主 agent 的上下文之外，把子任务扇出给 coding-agent CLI
  （Codex、Claude Code、Gemini、Qwen、Kimi 或自定义），后台跑完后只取回最终结果。
  当一个任务大过单次调用——需要并行扇出多份草稿、多阶段评审流水线、对抗式核验发现，
  或循环挖掘直到无新发现——或用户提到 odw、dynamic workflow、多 agent 编排、扇出
  subagent 时，使用本 skill。
license: MIT
---

# Open Dynamic Workflows

一个 dynamic workflow 就是一段简短的 JavaScript 脚本：编排计划写成普通代码，由
`odw` 在独立的后台进程里执行，把每个子任务派发给一个真实的 coding-agent CLI 进程。
中间产物不进入你的上下文，回到你手里的只有脚本 `return` 的最终值。

使用流程固定三步：**写脚本 → `odw run` → 检视结果再行动**。任务一次调用就能完成时
不要用——直接做。

## 写 workflow 脚本

- 文件最顶部放 `export const meta = {…}`，必须是**纯字面量**（不含变量、函数调用、
  模板插值）。`meta.name` 与 `meta.description` 必填；`whenToUse`、`phases`、`model`
  可选。
- 脚本体运行在 async 上下文里：直接用顶层 `await`；顶层 `return` 的值就是整个
  workflow 的结果。
- 原语全部是**注入的全局**——不要 import。除 `export const meta` 外，文件里出现任何
  其他顶层 `import` / `export` 都会被加载器拒绝。
- 循环、`if`、去重等普通控制流直接写在脚本里。原语只负责**派发并等待**，拿结果做
  什么由脚本决定。

```js
// fan-out-reduce.js
export const meta = {
  name: 'fan-out-reduce',
  description: 'Draft in parallel, then synthesize.',
  phases: [{ title: 'Draft' }, { title: 'Synthesize' }],
}

const question = (args && args.question) || 'Design a cache.'

phase('Draft')
const drafts = await parallel(
  [1, 2, 3].map((i) => () => agent(`Draft #${i}: ${question}`, { phase: 'Draft' })),
)

phase('Synthesize')
return await agent(
  'Synthesize the best answer from:\n' + drafts.filter(Boolean).join('\n---\n'),
  { phase: 'Synthesize' },
)
```

用 `--args` 传入的输入会注入为全局 `args`（解析后的 JSON，或一段原始字符串——
*看起来像* JSON 但解析失败的输入会被直接拒绝，不会悄悄按字符串传入）。

## 原语速查

| 原语 | 作用 |
| --- | --- |
| `agent(prompt, opts?)` | 让一个 coding agent 跑一个子任务；返回它的回复文本，设了 `opts.schema` 则返回校验过的对象。唯一真正干活的动词。 |
| `parallel(thunks)` | 并发执行一组零参 thunk，并**等全部完成**（屏障）。顺序保留；失败的槽位是 `null`。 |
| `pipeline(items, ...stages)` | 让每个条目独立地流过各 stage（**无屏障**）。每个 stage 收到 `(prev, item, index)`。 |
| `phase(title)` / `log(msg)` | 给后续工作打上进度标签 / 发一行进度消息。 |
| `args` | workflow 的输入（注入）。 |
| `budget` | `{ total, spent(), remaining() }`——按 token 目标扩缩深度。 |
| `workflow(ref, args?)` | 内联调用另一个 workflow（仅一层）。`ref` 是受管目录中的名字或 `{ scriptPath }`；子 workflow 共享本次运行的并发上限、agent 计数和预算。 |
| `validate(source)` | 只编译不执行地校验一段候选 workflow 源码；返回 `{ ok, meta?, errors, warnings }`。**ODW 扩展**——不属于 Claude Code 方言。 |

`agent` 的 `opts`：`{ adapter?, schema?, label?, phase?, model?, agentType?, isolation? }`。
`adapter` 选择用哪个 CLI；`schema` 是一个原始 JSON Schema 对象（选项，不是全局）；
`agentType` 是注入进 prompt 的**人设**，*不是* adapter 名。

**选择法则：** 下一步需要**一整批**结果一次到位（去重、计票、综合）时用 `parallel`；
多阶段处理默认用 `pipeline`。

写嵌套 workflow、schema 重试、budget 扩缩等复杂组合之前，先读
[`references/primitives.md`](references/primitives.md)。

## 运行与观测

```bash
odw run wf.js --wait --args '{"question": "Design a cache."}'   # 阻塞并打印结果
```

长任务用 fire-and-poll，不阻塞自己：

```bash
RUN=$(odw run wf.js)        # 打印一个 run id 后立即返回
odw status $RUN             # 状态 + agent 计数
odw logs $RUN --follow      # 流式输出进度事件
odw result $RUN             # 完成后打印最终值
odw pause $RUN / resume $RUN / stop $RUN
odw list                    # 所有运行
```

保存过的 workflow 可直接按名字运行（`odw run <名字>`）；查找顺序：`.odw/workflows`、
`.claude/workflows`、`~/.odw/workflows`、`~/.claude/workflows`。

## 适配器

Codex、Claude Code、Gemini、Qwen、Kimi 开箱即用，无需配置。要换默认 CLI、调旗标或
接入自定义 CLI 时，读 [`references/adapters.md`](references/adapters.md)，写一个
`odw.config.json`（放在项目根或 `~/.config/odw/config.json`，或用 `--config` 指定）。

## 必须知道的行为

- **隔离**：agent 各自独立运行，互相看不见——除非脚本把一个的输出写进另一个的
  prompt。
- **工作区**：默认每个 agent 在工作树的隔离副本里运行（copy 模式），真实目录不会被
  改动。`inplace` 模式没有隔离、没有 diff——只在确实想就地修改、且 `--source` 指向
  改坏也无所谓的目录时使用。
- **成本**：并发有上限（默认 `min(16, cpu核数-2)`），单次运行总派发量有硬兜底；超出
  预期时用 `odw pause` / `odw stop`。
- **结果**：引擎不会替你 commit、push 或应用 diff。先检视 `return` 值，再决定下一步。

## 常见错误

| 错误 | 纠正 |
| --- | --- |
| 在脚本里 import 原语或其他模块 | 原语是注入全局；任何额外的顶层 `import`/`export` 都会被加载器拒绝。 |
| `meta` 里用了变量、展开或函数调用 | `meta` 必须是纯字面量。 |
| 期望 `parallel`/`pipeline` 里的失败抛错 | 失败的槽位是 `null`；归并前先 `.filter(Boolean)`。 |
| 按"哪个 agent 先跑完"来分支 | 破坏可复现性；归并要保持顺序无关。 |
| 用了 `validate()` 还指望脚本跑在 Claude Code 上 | `validate` 是 ODW 扩展，只能在 odw 上运行。 |
