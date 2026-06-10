---
name: open-dynamic-workflows
description: >
  给任意 coding agent 加上 dynamic-workflow 能力。用 Claude Code 的 workflow 方言写一段
  简短的 JavaScript 脚本（export const meta + 注入的 agent / parallel / pipeline / phase /
  log / args / budget 全局），再用 `odw` 命令把它跑在任意 coding-agent CLI 上（Codex、
  Claude Code、Gemini、Qwen、Kimi，或你自己的）。当一个任务适合扇出子任务、多阶段流水线、
  对抗式核验，或循环直到无新发现时使用，而不是只在上下文里试一次。
license: MIT。完整条款见 LICENSE。
---

# Open Dynamic Workflows

<sub>[English](../SKILL.md) · 简体中文</sub>

**dynamic workflow** 是一段小小的 JavaScript 脚本：它把编排计划放在普通代码里，在你自己
的上下文**之外**、**大规模**地调度 coding-agent CLI。你（宿主 agent）**先写脚本，再运行
它**；运行时在后台进程里把它跑完，只把最终结果交回来。

脚本是纯 JavaScript，用的就是 **Claude Code 那套一模一样的 workflow 方言**——为 Claude
Code 写的脚本在这里原样可跑，你在这里写的也能跑在 Claude Code 上。

当工作量大过一次调用时用它：扇出 N 份草稿再综合、跑一条多阶段评审流水线、对抗式地核验
发现，或一直挖掘到没有新东西为止。

## 1. 写一个 workflow 脚本

一个 workflow 就是 `export const meta = {…}`（一个**纯字面量**，放在最顶部）后面跟一段
脚本体。`meta.name` 和 `meta.description` 是**必填**的；`whenToUse`、`phases`、`model`
可选。脚本体运行在 async 上下文里——直接用 `await`——它的顶层 `return` 就是 workflow
的结果。原语都是**注入的全局**：**不要** import 它们——文件里出现任何其他顶层
`import` 或 `export` 都会被加载器拒绝。

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

- `args` 是你用 `--args` 传入的输入（解析后的 JSON，或一段原始字符串——*看起来像*
  JSON 但解析失败的输入会被直接拒绝，不会悄悄按字符串传入）。
- 普通控制流（循环、`if`、去重）写在脚本里。原语只负责**派发并等待**——拿结果做什么由
  你决定。

## 2. 原语速览

| 原语 | 作用 |
| --- | --- |
| `agent(prompt, opts?)` | 让一个 coding agent 跑一个子任务；返回它的回复文本，设了 `opts.schema` 则返回校验过的对象。唯一真正干活的动词。 |
| `parallel(thunks)` | 并发执行一组零参 thunk，并**等全部完成**（屏障）。顺序保留；失败的那个是 `null`。 |
| `pipeline(items, ...stages)` | 让每个条目独立地流过各 stage（**无屏障**）。每个 stage 收到 `(prev, item, index)`。 |
| `phase(title)` / `log(msg)` | 给后续工作打上进度标签 / 发一行进度消息。 |
| `args` | workflow 的输入（注入）。 |
| `budget` | `{ total, spent(), remaining() }`——按 token 目标扩缩深度。 |
| `workflow(ref, args?)` | 内联调用另一个 workflow（仅一层）。`ref` 是受管目录中的名字或 `{ scriptPath }`；子 workflow 共享本次 run 的并发上限、agent 计数和预算，其 phase 以 `▸ <名字> · <phase>` 形式归组为独立泳道。 |
| `validate(source)` | 只编译不执行地校验一段候选 workflow 源码；返回 `{ ok, meta?, errors, warnings }`（warnings 标记 Claude Code 禁用的 API）。**ODW 扩展**——不属于 Claude Code 方言，使用它的脚本只能在 odw 上运行。 |
| `schema` | 一个原始 JSON Schema 对象，作为 `agent(..., { schema })` 传入（是选项，不是全局）。 |

`agent` 的 `opts`：`{ adapter?, schema?, label?, phase?, model?, agentType?, isolation? }`。
`adapter` 选择用哪个 CLI；`model` 会转发给该 adapter 声明的 model 旗标；`agentType`
是注入进 prompt 的**人设**（它*不是* adapter 名）；`isolation: "worktree"` 由默认的
copy 隔离工作区满足。完整参考：
[`references/primitives.md`](references/primitives.md)。

**经验法则：** 下一步需要**一整批**结果一次到位（去重、计票、综合）时用 `parallel`；多
阶段处理默认用 `pipeline`。归并要保持顺序无关——按**哪个 agent 先跑完**来分支会破坏可
复现性。

## 3. 运行它

`odw` CLI 在后台启动脚本（fire-and-poll）并让你观测它。用 `--wait` 阻塞并打印结果：

```bash
odw run fan-out-reduce.js --wait --args '{"question": "Design a cache."}'
```

或者 fire-and-poll：

```bash
RUN=$(odw run wf.js)        # 打印一个 run id
odw status $RUN             # 状态 + agent 计数
odw logs $RUN --follow      # 流式输出进度事件
odw result $RUN             # 完成后打印最终值
odw pause $RUN / resume $RUN / stop $RUN
odw list                    # 所有运行
```

## 4. 配置适配器

Codex、Claude Code、Gemini、Qwen、Kimi 开箱即用。要改默认、调参，或加自己的 CLI，写一个
`odw.config.json`（见 [`references/adapters.md`](references/adapters.md)）并传
`--config`，或把它放在 `./odw.config.json` 或 `~/.config/odw/config.json`。

## 5. 不变量

- agent 各自独立、互相隔离地运行；除非你的脚本把它传过去，否则一个 agent 永远看不到另一
  个的草稿。
- 默认每个 agent 在工作树的一个隔离副本里运行（`workspaceMode: "copy"`）；你真实的工作
  树不会被改动。`inplace` 让 agent **直接在真实目录里**运行——没有隔离、没有 diff——
  只在你*想要*就地修改、且 `--source` 指向一个改坏了也无所谓的目录时使用。
- 并发有上限（默认 `min(16, cpus-2)`），总派发量也有界（防失控兜底）。成本就靠这个上限
  和 `pause`/`stop` 来控制。
- 结果就是脚本 `return` 的东西。先检视它，再决定怎么做——引擎不会替你 commit、push 或应
  用 diff。

## 资源

- [`references/primitives.md`](references/primitives.md) —— 完整原语参考、组合模式、
  确定性规则。
- [`references/adapters.md`](references/adapters.md) —— 适配器配置与内置 CLI。
- `examples/`（仓库根目录）—— `deep-research.js`、`fan-out-reduce.js`、
  `adversarial-verify.js`、`loop-until-dry.js`。
