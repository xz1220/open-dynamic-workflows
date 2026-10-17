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
| `validate(source)` | 解析并编译检查源码,不运行工作流正文;`meta` 按纯字面量解析,绝不求值。返回 `{ ok, meta?, errors, warnings }`。**ODW 扩展**——不属于 Claude Code 方言。 |

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

### 恢复卡住或失败的运行（ODW 扩展）

每个 `agent()` 的结果在该 agent 完成的那一刻就会保存，所以某条泳道卡住、运行被停止或
worker 死掉，都不会丢掉已经完成的工作。不要干等卡住的运行，也不要从头重跑：

```bash
odw agents $RUN               # 每个 agent：状态、label、phase、耗时、结果预览（↺ = 重放）
odw result $RUN --agent 3     # 某个已完成 agent 的值（JSON，按 id 或 label）——运行中也可用
odw stop $RUN                 # 放弃卡住的泳道，然后……
odw resume $RUN --wait        # ……启动一个新运行：未改动的 agent() 调用直接重放，只执行其余部分
```

- 运行仍在进行时，就可以用 `odw result --agent` 取回部分结果。
- 对已结束的运行（done、failed、stopped 或 stale）执行 `odw resume`，会用同样的脚本、
  args 和 adapter 启动新运行。prompt 和选项都没变（phase 除外）的调用免费返回已保存的值——
  不调用 adapter、不占槽位、不耗预算。先改好脚本里出错的那一步：只有改动过的和新增的调用
  会执行。`--adapter <名字>` 切换默认 CLI；没有指定 adapter 的调用仍会重放。
- 对*已暂停*的运行，`odw resume` 只是原地继续。仍在运行的运行会被拒绝：先 `odw stop`
  （或加 `--force`）。
- 保持 prompt 确定：用 `Date.now()` 或 `Math.random()` 拼出的 prompt 永远匹配不上，会重新执行。

## 适配器

Codex、Claude Code、Gemini、Qwen、Kimi 开箱即用，无需配置。要换默认 CLI、调旗标或
接入自定义 CLI 时，读 [`references/adapters.md`](references/adapters.md)，写一个
`odw.config.json`（放在项目根或 `~/.config/odw/config.json`，或用 `--config` 指定）。

如果运行报 **AdapterNotFound**（装了多个 agent CLI 但没选默认）：先跑
`odw init --check` 查看装了哪些 CLI——在你的非交互 shell 里它只报告、绝不弹提示。
然后**问你的用户**想默认用哪个，再用 `odw init --adapter <名字>` 写入他们的选择。
不要替用户悄悄决定：默认值决定了每个裸 `agent()` 调用花的是哪家 CLI 的额度和权限。

如果 agent 很快失败或返回空结果,先跑 `odw doctor`:它会检查运行环境、配置、运行目录和每个
适配器,并给出修复建议。`odw doctor --smoke` 还会给默认适配器发一条真实提示——先征得用户同意
(会消耗一次模型调用)——能发现那些在无头模式下没有回答就以 0 退出的 CLI(通常卡在登录、
信任或审批提示上)。

## 必须知道的行为

- **上下文**：每个 agent 接收自己的提示词；使用默认 source 目录的 agent 共享文件。
  文件修改需要分开时,请选择 worktree 隔离。
- **工作区**：agent 直接在本次运行的 source 目录（`--source`，默认当前目录）里
  工作——与 Claude Code 自带 Workflow 工具同语义。需要隔离时按 agent 传
  `isolation: "worktree"`：agent 获得一个一次性 **git worktree**（要求 source
  是有至少一次提交的 git 仓库；agent 看到的是 HEAD，不含未提交改动）。临时工作区
  随后会被删除,改动不会自动合并。`agent()` 返回回复而非 diff；需要保留的交付物应放进
  回复,或在清理前显式持久化。
- **成本**：并发有上限（默认 `min(16, cpu核数-2)`），单次运行总派发量有硬兜底；超出
  预期时用 `odw pause` / `odw stop`。
- **结果**：引擎不会替你 commit、push 或应用 diff。先检视 `return` 值，再决定下一步。

## 常见错误

| 错误 | 纠正 |
| --- | --- |
| 在脚本里 import 原语或其他模块 | 原语是注入全局；任何额外的顶层 `import`/`export` 都会被加载器拒绝。 |
| `meta` 里用了变量、展开或函数调用 | `meta` 必须是纯字面量。 |
| 将 `parallel`/`pipeline` 中所有失败等同处理 | 可恢复失败变 `null`；停止、预算耗尽和派发上限错误会中止。要求完整交付时须重试缺失结果或报告失败,仅允许部分结果时才过滤。 |
| 按"哪个 agent 先跑完"来分支 | 破坏可复现性；归并要保持顺序无关。 |
| 卡住或失败的运行从头重跑 | 用 `odw result <run> --agent <id>` 读出已完成的 agent；`odw stop`、修好脚本，再 `odw resume`——已完成的调用免费重放。 |
| 用了 `validate()` 还指望脚本跑在 Claude Code 上 | `validate` 是 ODW 扩展，只能在 odw 上运行。 |
