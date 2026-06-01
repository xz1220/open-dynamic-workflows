<div align="center">

# Open Dynamic Workflows

**开放的 dynamic workflow 运行时,让任意 coding agent 都能跑 Claude Code 式的 agent 编排。**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A520-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Status](https://img.shields.io/badge/status-rewrite_in_progress-orange.svg)](#路线图)

[English](README.md) · 简体中文

</div>

---

> 🚧 **状态 — 重构进行中。** Open Dynamic Workflows 正从一个 Python 原型重写为
> **TypeScript / Node** 运行时。引擎骨架与 `odw` CLI 外壳已落地(里程碑 **M0**);
> 执行各层(**M1–M5**)正在推进。下文描述的是**目标设计**——当前已接通的范围见
> [路线图](#路线图)。

## 这是什么?

**Open Dynamic Workflows(ODW)** 是一个 TypeScript / Node CLI 运行时,面向可移植的
dynamic workflow:用 JavaScript 脚本在宿主 agent 上下文之外,通过 `agent()`、
`parallel()`、`pipeline()` 扇出并编排 coding agent。如果你在找一个 open dynamic
workflow engine,想让 Codex、Claude Code、Gemini、Qwen、Kimi 或自定义 CLI 都能跑同一份
workflow 脚本,这就是这个项目。

**dynamic workflow** 是一段小小的 JavaScript 脚本:它把编排计划放在普通代码里,
在宿主 agent 的上下文**之外**、**大规模**地调度 coding-agent CLI。你写好脚本(或
拿到一个),运行时在后台把它跑完,只把最终结果交回来。

Claude Code 已经能做这件事,但只能在它自己的私有运行时里。
**Open Dynamic Workflows 把这套能力做成可移植的**:它是一个开放运行时,能把**同一份**
workflow 脚本——Claude 的原样方言(`export const meta` + 注入的 `agent` /
`parallel` / `pipeline` / … 全局)——跑在**任意** coding-agent CLI 上:Codex、
Claude Code、Gemini、Qwen、Kimi,或你自己的。

**为什么重要。** 把计划留在代码里,中间产物就不会污染宿主上下文,你可以扇出几十个
subagent,多阶段编排也变得可复现。这个模式用途极广,却一直被锁在单一厂商的运行时
里。ODW 把它重新打开成一个与 CLI 无关的引擎,于是**任意 agent 都能编排任意 agent**
——而 Claude Code 生态里已经在大量产出的 workflow 脚本,也就成了可移植的资产。

## 一个 workflow 长这样

```js
// fan-out-reduce.js
export const meta = {
  name: 'fan-out-reduce',
  description: 'Draft in parallel, then synthesize the best answer.',
}

const drafts = await parallel(
  [1, 2, 3, 4].map((i) => () => agent(`Draft #${i}: ${args.question}`)),
)

return await agent(
  'Synthesize the single best answer from these drafts:\n\n' +
    drafts.filter(Boolean).join('\n\n---\n\n'),
)
```

```bash
odw run fan-out-reduce.js --wait --args '{"question": "Design a rate limiter."}'
```

它就是**纯 JavaScript**,和 Claude Code 用的是同一种方言——所以为 Claude Code 写的
脚本在这里**原样可跑**。旗舰示例 [`examples/deep-research.js`](examples/deep-research.js)
(扇出式联网调研 → 对抗式事实核查 → 带引用的报告)正是这样一个脚本,也是本运行时的
v1 验收目标。

## 编程原语

一个 workflow = `export const meta = {…}` + 一段运行在 async 上下文里的脚本体。脚本体
用普通 JS 控制流(循环、`if`、去重)把这些**注入的全局**串起来——无需 import:

| 原语 | 作用 |
| --- | --- |
| `agent(prompt, opts?)` | 让一个 coding agent 跑一个子任务。唯一真正"产出工作"的原语。返回文本;设了 `opts.schema` 则返回校验过的对象。 |
| `parallel(thunks)` | 一组任务并发执行、**等全部完成**(屏障)。失败的那个变 `null`。 |
| `pipeline(items, ...stages)` | 每个条目独立穿过各 stage(**无屏障**)。每个 stage 收 `(prev, item, index)`。 |
| `phase(title)` / `log(msg)` | 把进度归入某阶段 / 发一行进度消息。 |
| `schema`(JSON Schema) | 给 `agent` 的输出定一个类型契约;回复会被校验,不符就重试。 |
| `args` | workflow 的输入,原样注入。 |
| `budget` | `{ total, spent(), remaining() }`——按 token 目标动态扩缩深度。 |
| `workflow(ref, args?)` | 内联调用另一个 workflow(只允许一层嵌套)。 |

下一步需要"全量结果一次到位"(去重、计票、综合)时用 **`parallel`**;多阶段处理默认用
**`pipeline`**。归并要保持顺序无关——按"谁先跑完"分支会破坏可复现性。

## 运行与观测

`odw` CLI 在后台 worker 里启动脚本(fire-and-poll),并让你观测它。`--wait` 会阻塞并
打印结果。

```bash
odw run wf.js [--args JSON|@file] [--wait]   # 启动(后台);--wait 阻塞并打印结果
odw status <id>          # 状态 + agent 计数
odw logs <id> --follow   # 流式输出进度事件
odw result <id>          # 最终值
odw pause|resume|stop <id>
odw list
```

一次运行在独立的 detached worker 进程里执行,并把一切持久化到一个 run 目录——所以它
能比启动它的命令活得更久,也能从任何地方被观测。

## 配置适配器

Codex、Claude Code、Gemini、Qwen、Kimi 开箱即用。要改默认、调参或加自己的 CLI,放一个
`odw.config.json`(见 [`odw.config.example.json`](odw.config.example.json))到项目根、
`~/.config/odw/config.json`,或用 `--config` 指定。ODW 只调用本地命令——绝不直接调
模型 API。

```jsonc
{
  "defaultAdapter": "claude",
  "concurrency": 8,
  "adapters": {
    "my_wrapper": {
      "label": "My custom CLI",
      "command": ["my-agent", "--cwd", "{workspace}", "--prompt-file", "{prompt_file}"]
    }
  }
}
```

## 工作原理

```
odw (CLI) ─▶ runtime(后台 worker + run 目录)
               └─ 加载并转换 ─▶ workflow 脚本(.js,Claude 方言)
                                  └─ 注入原语 ─▶ scheduler(async 并发上限 + agent 兜底)
                                      agent() ─▶ bridge ─▶ adapters ─▶ 真实 CLI 子进程
                                                  ├─ workspace(隔离 + diff)
                                                  └─ schema(校验 / 重试)
```

两个值得点出的设计:

- **loader 是关键。** Claude 的方言既不是标准 ES module 也不是普通脚本:`export const meta`
  在顶部,脚本体用了顶层 `await` **和**顶层 `return`,还引用注入的全局。loader 会抽出
  `meta`、去掉 `export`,再把脚本体包进一个 async 函数,其参数**就是**那些原语——于是
  脚本体的 `return` 就变成 workflow 的返回值。
- **没有线程。** 引擎彻头彻尾是异步的。`agent()` 不过是一次异步子进程调用,所以
  `parallel` 就是 `Promise.all`、`pipeline` 是逐条目的 async 链,并发上限只是一个小小的
  异步信号量——默认 `min(16, CPU核数-2)`,外加一个单次运行总派发量的硬兜底。

| 路径 | 层 |
| --- | --- |
| `src/adapters/` | L1 — 统一的 CLI 调用(配置、占位符、runner、内置适配器) |
| `src/bridge.ts` | L2 — 一次 `agent` 调用 → 一次 CLI 运行,含 schema 处理 |
| `src/scheduler.ts` | L3 — 有界的异步并发 + agent 总量兜底 |
| `src/primitives.ts`、`src/schema.ts` | L4 — 注入的原语 + 数据契约 |
| `src/loader.ts` | 把 workflow 脚本转成可运行形态的转换器 |
| `src/runtime/` | L5 — 后台 worker、run 目录、控制 |
| `src/cli.ts` | L6 — `odw` 命令 |
| `src/workspace.ts` | 横切 — 工作区隔离与 diff |

workflow 脚本始终是**纯 `.js`**、从不编译;引擎用 **TypeScript** 写(编译成 ESM,
**零运行时依赖**),并附带 `.d.ts` authoring 类型,让脚本作者在编辑器里对注入的全局有
自动补全。

## 安装与开发

```bash
git clone https://github.com/xz1220/open-dynamic-workflows.git
cd open-dynamic-workflows
npm install        # 仅开发工具——发布出的包零运行时依赖
npm run build      # tsc → dist/
npm test           # node:test 测试套件,由 mock 适配器驱动(无需真实账号)
node dist/cli.js --help
```

> 发布后,`npm i -g open-dynamic-workflows`(或 `npx open-dynamic-workflows …`)会把
> `odw` 命令装到你的 PATH 上。

## 路线图

这是一次按里程碑推进的重写,每个里程碑独立合入、测试为绿。

| 里程碑 | 范围 | 状态 |
| --- | --- | --- |
| **M0** | 骨架:打包、strict TS、分层 `src/`、CLI 外壳、测试脚手架 | ✅ 完成 |
| **M1** | 适配层 + 执行桥接 + 工作区隔离 | ⏳ 下一步 |
| **M2** | 原语 + 异步调度器 + **loader/transform** | ⏳ |
| **M3** | `schema` — 结构化输出(注入 / 提取 / 校验 / 重试) | ⏳ |
| **M4** | 后台运行时 + 完整 CLI(`run`/`status`/`logs`/`pause`/`stop`) | ⏳ |
| **M5** | 🎯 端到端跑通 [`examples/deep-research.js`](examples/deep-research.js) | ⏳ |
| **M6** | skill 文档 + 原语参考 + 更多示例 | ⏳ |

`model` / `agentType`、git-worktree `isolation`、嵌套 `workflow()`、真实 token 预算计量、
resume/journaling 都作为 v1.5+ 增量。完整方案见
[`docs/dynamic-workflows-tech-plan.md`](docs/dynamic-workflows-tech-plan.md);ODW 所对齐
的 Claude Code 方言背景见
[`docs/dynamic-workflows-research.md`](docs/dynamic-workflows-research.md)。

## 作为 skill 使用

[`skill/SKILL.md`](skill/SKILL.md) 让宿主 agent 仅凭文档就能编写并运行 workflow
——把它装进你的 agent 的 skills 目录(Codex CLI → `~/.codex/skills/`,Claude Code
→ 它的 skills 目录)。[`examples/`](examples/) 下是可运行的 workflow:
`deep-research.js`、`fan-out-reduce.js`、`adversarial-verify.js`、`loop-until-dry.js`。

## 许可证

[MIT](LICENSE)
