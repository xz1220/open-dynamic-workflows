<div align="center">

<img src="assets/odw-logo.png" alt="Open Dynamic Workflows logo" width="128" />

# Open Dynamic Workflows

**Dynamic workflows for coding agents。** 一个开放运行时,把 Codex、Claude Code、Gemini、
Qwen、Kimi、Oh My Pi、Kilo Code、OpenCode、Cursor 编排成可调度的机群——与
Claude Code 自带 Workflow 工具同一方言,外加一个实时观测每次运行的网页看板。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A520-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](tsconfig.json)
[![tests](https://github.com/xz1220/open-dynamic-workflows/actions/workflows/ci.yml/badge.svg)](https://github.com/xz1220/open-dynamic-workflows/actions/workflows/ci.yml)
[![runtime deps](https://img.shields.io/badge/runtime%20deps-0-blue.svg)](package.json)

[English](README.md) · [简体中文](README.zh-CN.md)

</div>

---

**Open Dynamic Workflows(ODW)** 是一个 TypeScript / Node CLI 运行时,面向可移植的
dynamic workflow:用 JavaScript 脚本在宿主 agent 上下文之外,通过 `agent()`、
`parallel()`、`pipeline()` 扇出并编排 coding agent。如果你想让 Codex、Claude Code、
Gemini、Qwen、Kimi、OMP、Kilo、OpenCode、Cursor 或自定义 CLI 都跑同一份 workflow
脚本,这就是这个项目。

**dynamic workflow** 是一段小小的 JavaScript 脚本:它把编排计划放在普通代码里,在宿主
agent 的上下文**之外**、**大规模**地调度 coding-agent CLI。你写好脚本(或拿到一个),
运行时在后台把它跑完,只把最终结果交回来。Claude Code 已经能在它自己的私有运行时里做
这件事;ODW 把**同一份脚本**做成可移植的——于是 Claude Code 生态里已经在大量产出的
workflow,就成了你在任何 agent 上都能跑的资产。

<div align="center">

<a href="videos/odw-demo/odw-product-demo.mp4">
  <img src="assets/odw.gif" alt="观看 ODW 产品演示 —— 把 coding agent 扇出到一个实时 workflow 上,看它跑起来" width="720" />
</a>

<sub><b><a href="videos/odw-demo/odw-product-demo.mp4">▶ 观看 33 秒演示(带声音)</a></b> —— 写一个 workflow、把 agent 扇出去,看整个运行实时点亮。</sub>

</div>

## 为什么需要编排?

让一个 agent 在自己的上下文里硬磨,很快就到天花板。下表每一行都是你大概率遇过的失败
模式;每个机制都是这个仓库里可直接运行的模式:

| 单 agent 的失败模式 | dynamic workflow 的解法 |
| --- | --- |
| **自评偏差** —— 作者给自己的工作打分 | 跨 CLI 对抗评审:一个 adapter 实现、另一个 adapter 反驳([`adversarial-verify.js`](examples/adversarial-verify.js)、[`codex-claude-loop.js`](examples/codex-claude-loop.js)) |
| **一把梭的质量彩票** | N 种思路同台竞技,两两评判选出幸存者([`tournament.js`](examples/tournament.js)) |
| **串行等待** | `parallel()` 把子任务扇出到几十个 agent 进程,由有界信号量控制([`fan-out-reduce.js`](examples/fan-out-reduce.js)) |
| **上下文污染** —— 长任务挤爆宿主 agent 的窗口 | 运行是 detached 后台 worker;只有最终 `return` 值回来 |
| **长任务不可见** | 每次运行都是一张实时 DAG —— 浏览器看板,或 `odw logs --follow` |

## 亮点

- **可移植** —— 同一份 workflow 脚本可跑在 Codex、Claude Code、Gemini、Qwen、Kimi、
  OMP、Kilo、OpenCode、Cursor 或你自己的 CLI 上;换底层 agent 只需换适配器。
- **Claude 风格的工作流原语** —— `export const meta` + 注入的 `agent` / `parallel` /
  `pipeline` / `phase` / `log` / `args` / `budget` / `workflow` 全局(含嵌套
  workflow),支持顶层 `await` 和 `return`。迁移脚本前请核对下方的[兼容性检查表](#兼容性与迁移)。
- **带 Chat Host 的实时观测台** —— 在浏览器里和 Codex 正常对话;提到 ODW 或 workflow
  的回合会关联到真实异步运行,CLI 发起的 job 也会以实时 DAG 展示,不会污染宿主 agent
  的上下文。
- **在上下文之外、大规模** —— 计划留在代码里,中间产物不污染宿主上下文,可扇出几十个
  subagent。
- **可靠的交接** —— JSON-Schema 结构化输出,自动校验与重试,让多阶段流水线稳定组合,而
  不是在自由文本上碰运气。
- **后台运行、可观测** —— 每次运行都是一个 detached worker + run 目录:`status`、
  `logs --follow`、`result`、`pause` / `stop`,以及在人工 `checkpoint()` 处等待时的
  `approve` / `reject`。
- **无线程、零运行时依赖** —— 引擎是异步 TypeScript(`parallel` 就是 `Promise.all`);
  workflow 脚本保持纯 `.js`,并附带 `.d.ts` 类型供编辑器补全。

## 为什么不直接用 Claude Code 内置的 Workflow 工具?

Claude Code 已经能跑 dynamic workflow——但只能在它自己的私有运行时里、只为 Claude Code
自己跑。ODW 把**同一份脚本**做成可移植、可独立运行的:

- **任意 agent,同一份脚本** —— workflow 不止能跑 Claude Code,还能跑 Codex、Gemini、
  Qwen、Kimi、OMP、Kilo、OpenCode、Cursor 或你自己的 CLI;换适配器即可。
- **带外运行** —— 每次运行都是 detached 后台 worker + run 目录,所以你能对它
  `status` / `logs --follow` / `pause` / `stop`,并从浏览器观测——不依赖任何
  宿主 agent 会话。
- **可移植的资产** —— Claude Code 生态已经在产出的 workflow,就此成为你可以版本化、分享、
  并在任何地方运行的文件。

## 安装

整个安装就是 **一个二进制 + 一个 skill**——无需 Node、无需 npm、不用折腾 PATH、没有
全局模块冲突。挑一种适合你的:

### 1. 让你的 AI Agent 自己装

ODW 本来就是给 coding agent 用的,最省事的就是让它自己装。把下面这段**粘给你的 agent**
(Claude Code、Codex、Gemini …):

> 帮我安装 Open Dynamic Workflows:运行
> `curl -fsSL https://raw.githubusercontent.com/xz1220/open-dynamic-workflows/main/scripts/install.sh | sh`,
> 把 `odw` 二进制装到我的 PATH 上、把 workflow skill 装进你的 skills 目录,
> 然后运行 `odw --version` 确认。从现在起,遇到大到值得扇出的任务,
> 就写一个 ODW workflow 并用 `odw run` 运行它。

它会跑这个脚本、加载 [skill](skills/open-dynamic-workflows/zh-CN/SKILL.md)([English](skills/open-dynamic-workflows/SKILL.md)),然后立刻就能写并跑 workflow。

### 2. 一键脚本

```bash
curl -fsSL https://raw.githubusercontent.com/xz1220/open-dynamic-workflows/main/scripts/install.sh | sh
```

自动下对应平台的预编译二进制(gzip,约 35 MB)到 `~/.local/bin/odw`,并把 skill 装进
`~/.claude/skills/`(没有就退到 `~/.codex/skills/`)。无需 Node。可用环境变量
`ODW_BIN_DIR` 指定目录,或用 `ODW_VERSION=v0.4.0` 固定版本。`latest` 会先解析成一个
确定的发布版本,二进制和 skill 都从该版本下载。所有下载与新二进制验证成功后才替换现有
安装;替换失败会恢复旧文件。二进制必须与该版本发布的 `SHA256SUMS` 一致(v0.5.0 及更早的版本
没有该文件,会带警告安装;更新的版本缺少它则中止,除非设置 `ODW_ALLOW_UNVERIFIED=1`)。自定义部署可用 `ODW_REF` 显式指定 skill 的来源,默认与二进制一致。

### 3. 手动安装

不想把 `curl` 管道丢给 `sh`?从
[Releases](https://github.com/xz1220/open-dynamic-workflows/releases) 下对应 OS/arch 的资产,然后:

```bash
# a) 二进制 —— 先用该版本的 SHA256SUMS 校验,再放到 PATH 上
grep ' odw-darwin-arm64.gz$' SHA256SUMS | shasum -a 256 -c   # 或: sha256sum -c
gunzip odw-darwin-arm64.gz && chmod +x odw-darwin-arm64
mv odw-darwin-arm64 ~/.local/bin/odw

# b) skill 必须取同一发布版本（改成上面下载的版本）
ODW_TAG=v0.4.0
git clone --branch "$ODW_TAG" https://github.com/xz1220/open-dynamic-workflows.git
skill_source=open-dynamic-workflows/skills/open-dynamic-workflows
[ -d "$skill_source" ] || skill_source=open-dynamic-workflows/skill
cp -r "$skill_source" ~/.claude/skills/open-dynamic-workflows
```

或者,**等 `odw` 发布到 npm 之后**(目前还没有——见 [开发](#开发))、且你有 Node ≥20,
`npm i -g odw` 就能把 `odw` 装到 PATH 上(skill 仍按上面第 *b* 步装)。在那之前请用上面的二进制。

> 二进制在磁盘上约 110 MB——和任何 Node→二进制 的工具一样,几乎全是内嵌的 Node 运行
> 时——但下载已 gzip 压到约 35 MB。ODW 所**驱动**的 agent(`claude`、`codex` …)仍是你
> 另行安装的独立 CLI。

## 快速开始

本文描述当前源码。使用正式安装包时,以配套 skill 和 `odw --help` 为准;
需要尚未发布的功能,可按[开发](#开发)中的步骤从源码构建。

只装了一个 CLI(只有 `claude` 或只有 `codex`)?零配置,直接往下看。装了好几个?安装器
已经让你选过默认了;`odw init` 随时可以重选(agent 则在问过你之后用
`odw init --adapter <名字>` 写入)。`odw doctor` 会检查运行环境、配置、运行目录和每个适配器;
`odw doctor --smoke` 还会给默认适配器发一条真实提示——能发现那些装得上、但在无头模式下卡在
登录或审批提示上的 CLI。

ODW 主要是**被你的 coding agent 驱动**的,不是手动跑。装好 skill 和二进制后,你只要把一个
大任务丢给 agent——它会**自己写一个 workflow 并跑起来**,而且是在它自己的上下文之外:

> **你 → 你的 agent:** *"用 Open Dynamic Workflows 深度调研 X 和 Y 的取舍,给我一份带引用
> 的报告。"*
>
> **你的 agent**(已经加载了 ODW skill)写一个 workflow 脚本、跑 `odw run research.js
> --wait`,然后把报告交回来——几十次检索和一轮事实核查都在后台跑完,全程不碰它的上下文。

这正是重点:**agent 保持干净的上下文,把重活扇出给 ODW。**

**你自己跑 `odw`**(或自己写一个 workflow)也是同一条命令。一个 workflow 就是 Claude Code
方言的纯 JavaScript,比如 `fan-out-reduce.js`:

```js
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
# 在本仓库根目录下(脚本就在 examples/ 里);任意路径都行
odw run examples/fan-out-reduce.js --wait --args '{"question": "Design a rate limiter."}'
```

旗舰示例 [`examples/deep-research.js`](examples/deep-research.js)(扇出式联网调研 → 对抗式
事实核查 → 带引用报告)正是这样一个脚本。它的实战版
[`deep-research-verified.js`](examples/deep-research-verified.js)(在 codex 适配器上以
100 个 agent、约 9 分钟端到端验证过)还配了可进 cron 的包装脚本——见
[`docs/recipes/deep-research-verified.md`](docs/recipes/deep-research-verified.md)。

## 编程原语

一个 workflow = `export const meta = {…}` + 一段运行在 async 上下文里的脚本体。脚本体
用普通 JS 控制流(循环、`if`、去重)把这些**注入的全局**串起来——无需 import:

| 原语 | 作用 |
| --- | --- |
| `agent(prompt, opts?)` | 让一个 coding agent 跑一个子任务。唯一真正"产出工作"的原语。返回文本;设了 `opts.schema` 则返回校验过的对象。 |
| `parallel(thunks)` | 一组任务并发执行、**等全部完成**(屏障)。可恢复失败变 `null`;停止、预算耗尽和派发上限错误会中止运行。 |
| `pipeline(items, ...stages)` | 每个条目独立穿过各 stage(**无屏障**)。每个 stage 收 `(prev, item, index)`。 |
| `phase(title)` / `log(msg)` | 把进度归入某阶段 / 发一行进度消息。 |
| `schema`(JSON Schema) | 给 `agent` 的输出定一个类型契约;回复会被校验,不符就重试。 |
| `args` | workflow 的输入,原样注入。 |
| `budget` | `{ total, spent(), remaining() }`——按 token 目标动态扩缩深度。 |
| `workflow(ref, args?)` | 内联调用另一个 workflow(仅一层)。子 workflow 共享本次运行的并发上限、agent 计数与预算;其 phase 以独立泳道归组。 |
| `validate(source)` | 解析并编译检查可信源码,不运行工作流正文;元数据按纯字面量解析,不会被求值。**ODW 扩展**(不属于 Claude Code 方言)。 |
| `exec(command, opts?)` | 不启动模型直接运行一条命令——测试、构建、linter;返回 `{ stdout, stderr, exitCode, signal, timedOut, truncated, durationMs }`。字符串经 shell 执行,数组按 argv 执行。受 `timeout`(600 秒)和 `maxOutputBytes`(每个输出流 8 MiB)约束;停止会杀掉它。不占 agent 槽位。**ODW 扩展**(不属于 Claude Code 方言)。 |
| `checkpoint(title, opts?)` | 暂停运行,直到有人批准或拒绝——用 `odw approve\|reject` 或看板——然后返回 `{ approved, note, by }`。`opts`:`payload`(要给人看的内容)、`timeout`(秒)和 `onTimeout`(`"approve"`、`"reject"`,或默认的 `"fail"`)。不占 agent 槽位;停止依然会结束运行。见[人工检查点](#人工检查点odw-扩展)。**ODW 扩展**(不属于 Claude Code 方言)。 |

下一步需要"全量结果一次到位"(去重、计票、综合)时用 **`parallel`**;多阶段处理默认用
**`pipeline`**。归并要保持顺序无关——按"谁先跑完"分支会破坏可复现性。完整参考见
[`skills/open-dynamic-workflows/references/primitives.md`](skills/open-dynamic-workflows/references/primitives.md)。

## 兼容性与迁移

ODW 已实现下列原语能力。依赖宿主私有运行机制的脚本,迁移前需要逐项核对：

| 功能 | ODW 的行为与迁移要求 |
| --- | --- |
| 嵌套 `workflow()` | 已实现一层嵌套,共享父任务的调度器、控制和预算。更深层的调用需要展平。 |
| 模型选择 | 在 `agent(..., {model})` 中传该 CLI 的模型 ID。`meta.model` 和阶段元数据不设置执行模型;适配器没有模型参数时会记录路由说明。 |
| `agentType` | 将人设加入提示词,不会加载宿主的同名子 agent 配置或选择适配器。 |
| 工作区隔离 | 从已保存的 HEAD 创建临时工作区,不含未保存修改,结束后清理。不会自动合并,`agent()` 返回回复而非 diff;ODW 会把每个隔离 agent 的改动保存为 diff,供审阅和应用(`odw diff`、`odw apply`、`keep` 分支——均为 ODW 扩展;见[审阅并应用](#审阅并应用隔离-agent-的改动odw-扩展))。支持 `.worktreeinclude`(ODW 连未跟踪文件也复制,而不只是被 gitignore 的文件);其中的 `symlink:` 行、`worktreeSetup` 和 agent 的 `ODW_PORT` 是 ODW 扩展——见[隔离 worktree](#隔离-worktree-与-agent-端口)。 |
| 预算 | 计算输出 token:适配器上报用量时用 CLI 自己的计数(内置 `claude` 会上报——见[用量与花费](#用量与花费odw-扩展)),否则按每条回复的 `ceil(字符数 / 4)` 估算。每次 CLI 运行都计入:schema 重试、限流重试,以及上报了用量的失败运行。每次派发和每次 schema 重试前都会检查;预算用尽时运行结束,仍在运行的 agent 会被停止。 |
| JSON Schema | 只校验[已列出的子集](skills/open-dynamic-workflows/zh-CN/references/primitives.md#schema)。`$ref`、`const`、`oneOf` 等约束不会生效;请明确声明对象/数组类型并使用受支持的约束。 |
| 脚本可信性 | 只运行可信脚本:运行工作流会把正文当作普通 JavaScript 执行。加载时元数据按纯字面量解析,不会被求值;编译检查和兼容性警告都不提供沙箱隔离。 |
| 恢复 | 每个完成的 `agent()` 结果都会在完成时保存。`odw resume` 让已暂停且仍存活的 worker 原地继续;对已结束的运行(done、failed、stopped,或崩溃后的 stale)则启动一个新运行:prompt 和选项都没变的调用直接重放,其余照常执行。`rerun` 从头执行。见[恢复运行](#恢复运行odw-扩展)。 |

原语名称一致不代表运行机制完全等价。`validate(source)`、`exec(command)` 和 `checkpoint(title)`
是 ODW 扩展,迁移到未提供它们的宿主时需要去掉(`validate()` 会对 `exec()` 和 `checkpoint()`
调用给出 warning)。可恢复失败产生的 `null` 需要显式处理：接受部分结果、重试,或在要求完整
交付时报告失败。

## 运行与观测

在交互式终端里,`odw run` 会附着一个**实时前台视图**——每个 agent(以及带 `$` 提示符的
`exec()` 命令步骤)的启动、转轮、结算,按 phase 逐步展示,结束时打印结果。Ctrl-C 只是断开观察(运行继续);`odw attach <id>`
可随时重新附着。

```bash
odw run wf.js [--args JSON|@file]            # 终端里前台展示;运行本体仍是独立 worker
                                             #   --adapter <name> 指定这次运行的默认 agent
                                             #   --budget <tokens> 设置 budget.total
```

运行本体永远在 detached 后台 worker 里执行。只要你的 shell 不是终端——`$(…)` 捕获、
管道、cron、CI、另一个 agent——同一条命令保持旧契约:立即返回并打印 run id
(fire-and-poll):

```bash
RUN=$(odw run wf.js)     # 非 TTY:打印 run id 并立即返回
odw attach $RUN          # 实时视图(被管道时为纯行输出);--timeout <s> 超时退出码 124
odw status $RUN          # 状态、agent 计数、token 与花费
odw agents $RUN          # 每个 agent 及其已保存的结果,运行中也可看
odw logs $RUN --follow   # 流式输出原始进度事件
odw logs $RUN --agent 3  # 某个 agent 做了什么:它的工具调用、结果和文字(见下文)
odw result $RUN          # 最终值
odw diff $RUN --stat     # 隔离 agent 改了什么;odw apply $RUN --agent N 应用其中一个
odw pause|resume|stop $RUN
odw approve|reject $RUN  # 回答运行正在等待的 checkpoint()(--note TEXT、--checkpoint N)
odw list
```

`--fg` / `-d, --detach` / `--wait`(阻塞到结束并打印结果,stderr 仅一行 run id
提示)可显式指定模式;环境变量 `ODW_DETACH=1` 强制后台。

一次运行在独立的 detached worker 进程里执行,并把一切持久化到一个 run 目录——所以它能
比启动它的命令活得更久,也能从任何地方被观测。向这个 worker 发送 SIGTERM、SIGINT 或
SIGHUP,效果与 `odw stop` 相同:它的 agent 连同其启动的所有进程都会被杀掉、worktree 被
清理,运行记为 stopped;第二个信号,或运行在 10 秒内没能结束,会让 worker 立即退出。

保存好的 workflow 也可以直接按名字运行。ODW 会先找项目级、再找个人级,并同时读取自己
的目录和 Claude Code 保存 workflow 的目录: `.odw/workflows`、`.claude/workflows`、
`~/.odw/workflows`、`~/.claude/workflows`(遵循 `CLAUDE_CONFIG_DIR`)。

**喜欢用浏览器?** `odw serve` 会对同一个 run 目录开一个零依赖的实时看板——每次运行都是一张
实时图,还有时间线、日志和结果,全部通过 SSE 推送。无需构建,不引入额外依赖,加载时不访问网络。

```bash
odw serve [--open]                      # 实时看板,默认 http://127.0.0.1:4317
odw serve --port 8080 --host 0.0.0.0    # 自定义端口 / 绑定地址
```

![odw serve —— 一次实时 deep-research 运行:五个阶段泳道(Plan → Search → Extract → Vote → Report)绘制成图,运行中的 agent 沿边传递信号,带运行计数与阶段步进条](assets/odw-dashboard.gif)

### 恢复运行(ODW 扩展)

每个 `agent()` 的结果在该 agent 完成的那一刻就保存到 run 目录(`agents/<agentId>.json`),
早于它的 `agent_finished` 事件——所以某条泳道卡住、运行被停止或 worker 死掉,都不会让你
失去已完成的工作。运行的其余部分仍在进行时就能读取:

```bash
odw agents $RUN              # 每个 agent:id、状态、label、phase、适配器、耗时、↺ 重放、结果预览
odw agents $RUN --json       # 同样的行,供脚本使用
odw result $RUN --agent 3    # 某个 agent 已保存的值(JSON;按 id,或 --agent <label>)
odw resume $RUN              # 启动一个新运行,重放每个未改动的 agent() 调用(见下)
```

`odw resume <run_id>` 依运行状态而定:

- **已暂停**(worker 仍存活):原地继续——`odw pause|resume|stop` 这个控制动词不变;
- **已结束**——done、failed、stopped,或 stale(worker 已死):用同样的脚本、args 和
  适配器启动一个**新运行**(在它的 `meta.json` 里记为 `resumedFrom`)。prompt 和选项都
  没变的 `agent()` 调用立即返回已保存的值——不调用适配器、不占并发槽位、不计入派发数、
  不耗预算——并在事件、`odw agents` 和看板里标记为重放(↺)。改动过的和新增的调用照常
  执行,所以修好出错的那一步再 resume,而不是为整个运行再付一次钱。resume 可以串联:
  对 resume 出来的运行再 resume,两次的结果都会重放;
- **仍在运行**:拒绝,因为那会重做仍在进行的工作——先停止它,或加 `--force` 在旁边启动
  重放运行。

调用按以下内容的 sha256 匹配:prompt、`schema`、`adapter`(调用里写的值——resume 时的
`--adapter` 只切换默认值,所以没指定适配器的调用仍会重放)、`model`、`agentType`、
`isolation` 和 `label`;`phase` 不计入。相同的调用按调用顺序重放,所以请保持 prompt
确定。resume 接受与 rerun 相同的参数:`--wait`/`--fg`/`-d`/`--timeout`、`--adapter`、
`--config`、`--runs-root`。看板通过 `GET /api/runs/:id/agents` 和
`GET /api/runs/:id/agents/:agentId` 提供同样的记录。

分步演练——读取已完成的部分、停掉卡住的、修复、再 resume:
[`docs/recipes/recover-a-run.md`](docs/recipes/recover-a-run.md)。

### 人工检查点(ODW 扩展)

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
```

也可以在看板里该运行的页面上点 **Approve** / **Reject**(仅限 loopback 绑定;它向
`POST /api/runs/:id/checkpoint` 发送 `{ action, checkpointId?, note? }`;
`GET /api/runs/:id` 会列出 `pendingCheckpoints`,运行列表则用 `waiting` 标出每个等待中
运行最早的那个问题)。调用返回 `{ approved, note, by }`
——`by` 是 `cli`、`dashboard` 或 `timeout`——拒绝也是一个答复而不是错误:"不"意味着
什么由脚本决定。

- `payload` 可以是任意 JSON 值——计划、改动摘要——最多保留 64 KiB。
- `timeout`(秒)为无人值守的运行限定等待时长;超时后由 `onTimeout` 批准、拒绝,或(默认
  的 `"fail"`)抛出脚本可以捕获的 `CheckpointTimeout`。
- 多个检查点可以同时等待(在 `parallel()` 里),各有自己的编号。
- `odw resume` 永远不会重放检查点:恢复出来的运行会重新提问。
- `odw run --wait` 会在检查点等待期间一直阻塞;它会把命令打印一次,请在另一个 shell
  里回答(或用 `--timeout` 限定等待时长)。
- 运行会记录 `checkpoint_requested` 和 `checkpoint_resolved` 事件,`status.json` 里的
  `waiting` 指向最早一个仍在等待的检查点。在 [`notify.on`](#运行通知) 里加上
  `"waiting"`,你的 hook 就会收到每一个检查点。

[`examples/plan-approve-execute.js`](examples/plan-approve-execute.js) 是完整的
计划 → 批准 → 执行循环,附带说明的拒绝会触发重新规划。

### 用量与花费(ODW 扩展)

扇出很快就会烧掉额度,所以运行会边跑边显示花了多少。每个 `agent_finished`(以及
`agent_failed`)事件都带着这个 agent 的 `usage`:`inputTokens`(含缓存命中的输入)、
`outputTokens`、`cacheReadTokens`、`cacheWriteTokens` 和 `costUsd`,按 CLI 上报的数值
在它所有的 CLI 运行上求和——内置 `claude` 适配器这些都会上报。CLI 不上报输出 token 时
(文本模式的适配器),ODW 按回复的 `ceil(字符数 / 4)` 计数,并把这个数标记为
`estimated`(估算)。

```text
$ odw status $RUN
20261017-101500-ab12cd  [done]  review-swarm
  dispatched: 9 agent(s)
  usage: 1.4M tokens in (1.2M cache read, 96k cache write) · ~38k out · $2.871 (estimated in part: 1 of 9 agents reported no output tokens)
```

- 实时视图的汇总行显示输出 token(也就是 `--budget` 所计的数)和累计花费;每个已结束
  agent 的那一行显示它自己的花费。
- `GET /api/runs` 和 `GET /api/runs/:id` 以 `usage` 给出运行的合计(有 agent 的输出
  token 是估算时带 `estimated: true`),`/api/runs/:id` 还给出每个 agent 自己的用量。
- `budget.spent()` 用同样的方式计算输出 token:CLI 给了计数就用它的计数。
- 单次 `parallel()` 或 `pipeline()` 调用扇出的任务或条目超过 `fanOutWarn`(默认 25;
  `0` 或 `null` 关闭)时,会记一条带数量的警告——
  `large fan-out: parallel() starts 40 tasks (over fanOutWarn: 25) — …`——然后照常运行。

适配器在自己的 `output` 里声明 CLI 在哪里上报用量;见[配置适配器](#配置适配器)。

### 定时运行(ODW 扩展)

每晚的摘要、分诊、审计:`odw schedule` 按 cron 表达式、借助操作系统自带的调度器定时运行
workflow。ODW 不常驻任何 daemon——`add` 写入一条 cron 行、一个 launchd agent 或一个
systemd timer,到点由它回调 odw。

```bash
odw schedule add digest digest --cron "0 8 * * 1-5" --cwd ~/work/news --args '{"since":"yesterday"}'
odw schedule list              # 后端、上次运行(id、状态、时间)、按本地时间计算的下次运行
odw schedule run digest        # 立即运行一次,和调度器触发时完全相同
odw schedule remove digest     # 删除系统里的条目和定义(条目已被手动删掉也没关系)
```

- **后端:** macOS 默认 launchd(`~/Library/LaunchAgents/dev.odw.schedule.<name>.plist`),
  其他系统默认 cron(在你的 crontab 里写入 `# odw:begin <name>` … `# odw:end <name>`
  标记块,其余行原样保留),也可以 `--backend systemd`(用户级 `.service` + `.timer`,带
  `Persistent=true`:关机期间错过的那次会在开机后补跑——cron 会直接跳过;launchd 会在 Mac
  从睡眠中唤醒后补跑一次)。`--dry-run` 原样打印将要写入的内容。Windows 暂不支持:`add`
  会改为打印一条可用的 `schtasks` 命令。
- **每次运行**(`odw schedule run <name>`,即系统条目调用的命令)先拿到该定时任务的锁——
  上一次运行还没结束时,新的一次会被跳过而不是叠加——然后像 `odw run --wait` 那样运行
  workflow,向 `~/.local/state/odw/schedules/<name>.log` 追加一行结果;运行没有以 `done`
  结束时退出码非零。
- **`add` 立即校验** workflow、适配器和配置能否加载,并记录 node/odw 的绝对路径和你当前的
  `PATH`,让 agent CLI 在调度器的环境里也能像在你的 shell 里一样被找到。定义保存在
  `~/.config/odw/schedules.json`。
- **失败通知**走现有的 [`notify`](#运行通知) 钩子:定时运行就是一次普通运行(只关心失败时
  用 `"on": ["failed", "stopped"]`)。

表达式是 cron 的五个字段(数字、`*`、列表、范围、步长、`jan`-`dec`、`sun`-`sat`);
`@daily`、`L`、`#` 之类会被拒绝并说明原因。完整说明,以及手写 cron 行这一手动替代方案:
[`docs/recipes/cron.md`](docs/recipes/cron.md)。

### Agent transcript(ODW 扩展)

`agent()` 只返回最终回复,但运行会保留每个 agent 的 CLI 一路打印的内容——每次工具调用、
每个结果、每次重试——所以"第 7 个 agent 到底做了什么?"有了答案,运行中和失败后都能看:

```bash
odw logs $RUN --agent 7              # 可读形式:它写的文字、▸ 工具调用、✓/✗ 结果、重试、如何结束
odw logs $RUN --agent fix --follow   # 按 label;持续输出,直到该 agent 结束
odw logs $RUN --agent 7 --raw        # transcript 原样保存的各行(JSONL)
```

```text
I'll run the tests first.
▸ Bash  npm test
✗ Bash error (exit 1, 3 lines): not ok 1 - adds
── attempt 2: rate-limit retry ──
▸ Edit  src/add.ts
✓ Edit result (1 line)
■ done · 3 turns · $0.250
```

- agent 运行期间,它的 stdout 流式写入 run 目录下的 `agents/<agentId>.transcript.jsonl`:
  JSONL 适配器的事件按 CLI 打印的原样每行一个(内置 `claude`——stream-json——、`kilo` 和
  `opencode`),其他适配器的输出写成 `{"kind":"text","text":…}` 行。stderr 的结尾(最后
  64 KB)写入 `agents/<agentId>.stderr.txt`;`odw logs --agent` 会在 transcript 之后显示它的最后几行。
- schema 重试、卡死重启或限流重试都接着写在同一个文件里,前面先写一行
  `{"kind":"attempt","n":2,"reason":"schema"|"stall"|"rate_limit"}`。
- `maxTranscriptBytes`(默认每个 agent 5 MB)限制其大小:超出时以一行
  `{"kind":"truncated","bytes":N}` 结束 transcript。transcript 包含 agent 读到和运行过的
  一切;`"maxTranscriptBytes": 0` 则完全不保存。
- 保存从不拖慢 agent:各行先在内存中缓冲,再异步追加到文件。
- 被 `odw resume` 重放的 agent 没有运行任何 CLI,所以没有 transcript——请看原运行的。
- 看板 API 提供规范化后的版本:
  `GET /api/runs/:id/agents/:agentId/transcript?since=<i>` →
  `{ entries, next, more, truncated, replayed }`,每个条目为
  `{ i, kind: text|tool_call|tool_result|error|attempt|result|raw|truncated, text?, tool?, input?, output?, isError? }`,
  长字段截断到 4 KB(`clipped: true`)。

## 看板:观测、检查、对话

看板的视觉像一张印刷品——纸、墨和一种信号色——也可以随时切换到夜间主题。它提供:

- **Activity** —— 每个运行的事件密度"脉搏"山脊图、实时计数、按适配器统计的运行中 agent,
  以及跨所有运行的事件流。
- **Jobs** —— 进行中的运行以实时卡片展示(阶段条、agent 构成、耗时),外加可筛选、分页的历史
  (`#/jobs/live|done|failed` 可直接链接到某个筛选)。
- **单次运行** —— 图(扇出成扇、汇聚成漏斗;边会被"绘制"出来,对应 agent 运行时有信号流动;
  可缩放、适应、拖拽)、显示时间花在哪里的**时间线**、可筛选并可跟随的**日志**、可折叠 JSON 树
  形式的**结果**,以及展示每个已完成 agent 自身输出的 **agent 抽屉**——输出在完成时
  就已保存,运行中即可查看;重放的 agent 标记为 ↺。`exec()` 命令步骤以终端风格的节点
  (带退出码)出现在同一张图和时间线里;运行的计数包含它们(它们不算 agent 派发)。
  在 `checkpoint()` 处等待的运行会在图上方显示问题和它的 payload;看板可写时还提供
  **Approve** / **Reject** 和附言。**Changes** 标签页按文件审阅每个隔离 agent 的改动,
  并可复制 `odw apply` 命令(以及保留的分支)。
- **Workspace** —— 所有已保存的工作流:阶段的静态结构及每个阶段调用的原语、源码和最近的运行。
- **Chat Host** —— 正常的 Codex 对话;提到 ODW 或 workflow 时,该回合会关联到一个真实的后台
  运行,工具卡片实时更新。

<table>
  <tr>
    <td width="50%">
      <strong>Activity</strong><br />
      <img src="assets/app-screenshots/activity.png" alt="Activity 页面:标题、实时计数、每个运行事件密度的脉搏山脊图、按适配器的机队和实时事件流" />
    </td>
    <td width="50%">
      <strong>时间线</strong><br />
      <img src="assets/app-screenshots/timeline.png" alt="一次运行的时间线:每个 agent 是一根从开始到结束的条,按阶段分组,运行中带有当前时刻标记" />
    </td>
  </tr>
  <tr>
    <td width="50%">
      <strong>Jobs</strong><br />
      <img src="assets/app-screenshots/jobs.png" alt="Jobs 页面:带阶段条的实时运行卡片和按日期分组的历史表格" />
    </td>
    <td width="50%">
      <strong>夜间主题</strong><br />
      <img src="assets/app-screenshots/job-detail-dark.png" alt="夜间主题下的实时运行图,信号边带有发光效果" />
    </td>
  </tr>
  <tr>
    <td width="50%">
      <strong>待你处理</strong><br />
      <img src="assets/app-screenshots/needs-you.png" alt="Activity 页面的待你处理:一个停在检查点等待审阅的运行,以及一个可以复制 resume 命令的失败运行" />
    </td>
    <td width="50%">
      <strong>检查点</strong><br />
      <img src="assets/app-screenshots/checkpoint.png" alt="停在检查点的运行:审批卡片里是问题和附带内容,带批准与拒绝按钮;图中 Approve 泳道里是一个琥珀色的关卡节点" />
    </td>
  </tr>
</table>

按 <kbd>⌘K</kbd> / <kbd>Ctrl K</kbd>(或 <kbd>/</kbd>)打开命令面板——跳转到任意运行或工作流、
切换主题或语言、复制跟踪或重跑命令。<kbd>g</kbd> 再按 <kbd>a</kbd>/<kbd>j</kbd>/<kbd>w</kbd>/<kbd>c</kbd>/<kbd>s</kbd>
切换页面,<kbd>1</kbd>–<kbd>4</kbd> 切换运行的标签页,<kbd>+</kbd>/<kbd>-</kbd>/<kbd>0</kbd> 缩放图。
运行结束时看板会提示;如果在设置中开启,标签页在后台时还会发送桌面通知。

```bash
odw run adversarial-verify --args '{"question":"review src/rate-limiter.js"}'
odw logs --workflow adversarial-verify --follow
```

看板可以在非 loopback 地址上查看,但本地写操作(例如 Chat 消息和停止 ODW 自己的运行)
仍由 loopback server 保护。Claude Code 自己的运行始终严格只读。

## 配置适配器

Codex、Claude Code、Gemini、Qwen、Kimi、Oh My Pi、Kilo Code、OpenCode、Cursor
均开箱即用:

| 适配器 | 本地 CLI | 非交互契约 |
| --- | --- | --- |
| `codex` | `codex` | stdout 文本;自带联网搜索 |
| `claude` | `claude` | stream-json 事件;回复、用量、花费和错误取自其 `result` 事件;放行 WebSearch/WebFetch |
| `gemini` | `gemini` | stdout 文本 |
| `qwen` | `qwen` | stdout 文本 |
| `kimi` | `kimi` | stdout 文本 |
| `omp` | `omp` | `--print --no-session --approval-mode yolo`;stdin 传提示词 |
| `kilo` | `kilo` | `run --format json --auto`;从 JSONL 解出最终文本 |
| `opencode` | `opencode` | `run --format json --auto`;从 JSONL 解出最终文本 |
| `cursor` | `agent` | `--print --force --trust`;stdin 传提示词 |

内置的 `codex` 和 `claude` **自带联网能力**,调研类 workflow 零调参就能跑。
`odw init` 会列出装了哪些 CLI
(带各自的权限姿态)并设置默认——在终端里是交互式选择,其他环境退化为纯报告,
`odw init --adapter <名字>` 则不弹提示直接写入。要调参或加自己的 CLI,放一个
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

自定义适配器默认把 stdout 作为文本并去掉首尾空白。JSONL 事件流需要显式声明事件
类型和最终文本路径:

```jsonc
"output": {
  "format": "jsonl",
  "eventType": "text",
  "textPath": ["part", "text"],
  "select": "last"
}
```

**ODW 扩展:** JSON 输出还可以声明这次运行花了多少,以及 CLI 自己是否报告了失败。
内置的 `claude` 适配器就是这样声明的:

```jsonc
"output": {
  "format": "jsonl",
  "eventType": "result",          // 回复所在的事件(以最后一个为准)
  "textPath": ["result"],
  "select": "last",
  "usagePath": ["usage"],         // token 计数,位于 usageEvent 事件中(默认同 eventType)
  "costPath": ["total_cost_usd"], // 美元花费,位于同一事件
  "errorPath": ["is_error"]       // true、一条消息或一个错误对象:这次运行以它失败
}
```

每个 `usageEvent` 事件的用量会累加;不同 CLI 的字段名(Anthropic、OpenAI、Codex)会被
统一归一化——见 [`src/adapters/usage.ts`](src/adapters/usage.ts)。只打印一个 JSON 文档
的 CLI 则用 `{ "format": "json", "textPath": […], "usagePath": […], "costPath": […],
"errorPath": […] }`;路径里的整数用于索引数组(负数从末尾数)。`errorPath` 上报的失败
会像任何失败的运行一样被归类——不论退出码——所以限流会被重试,额度用尽会说明何时重置。
输出里找不到声明的文本时——CLI 的格式变了,或配置写错了——原始 stdout 就作为回复,运行
日志会说明原因;agent 不会因此失败。

ODW 只把解码后的最终响应交给 workflow;JSONL 输出会边流式到达边逐行解码(只保留最新文本
和用量合计,而不是整段记录),stderr 只保留有限的尾部用于错误信息。
Windows 下的可执行文件探测遵循 `PATHEXT`,所以 `agent.cmd`、`kilo.cmd`、`omp.exe`
这类普通 shim 无需写完整路径也能识别。

配置键全部放在**顶层**——没有 `"settings"` 包装层;odw 会对未知或放错位置的键
在 stderr 上给出警告(附 did-you-mean 提示),而不是静默忽略。没设
`defaultAdapter` 时,odw 会用唯一配置的 adapter——或在全新安装下,用 PATH 上
唯一真实存在的那个 CLI;若装了多个,报错会列出它们并告诉你如何选择。

### 卡死看门狗

**ODW 扩展。** 一个卡住的 agent CLI 原本会一直占着并发槽位,直到 `timeout`(默认 30
分钟)。设置 `stallTimeout` 后,若某个 agent 的 stdout *和* stderr 连续这么多秒都没有
任何输出,ODW 会像超时一样杀掉它(连同整个进程组),再用同一个 prompt 重新启动,每次
`agent()` 调用最多重启 `stallRestarts` 次(默认 1)。每次重启都会记一条日志
(`search:3 went quiet for 120s — restarting (1/1)`);用完重启次数后,这次调用失败,
错误信息会说明 agent 卡死(stalled)。停止、暂停或预算上限永远优先于重启。

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
启用)、`kilo` 和 `opencode` 这类 JSONL 适配器,或会打印心跳的包装脚本;并把值设得高于
健康 agent 最长的静默时段——工具调用里跑一轮很长的测试,同样不会有任何输出。

### 限流、额度与登录

**ODW 扩展。** 每个失败的 agent 都会根据其 CLI 的退出状态和输出末尾被归类:`rate_limit`、
`quota`、`auth`、`timeout`、`stalled`、`not_found`(CLI 无法启动)、`permission`(工具
调用或审批被拒)或 `exit`。这个类别就是 `agent_failed` 事件上的 `reason`(CLI 说明了何时
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
- **额度用尽和登录失败**从不重试。错误信息会说明该怎么做——等额度窗口重置、登录该 CLI,
  或用 `--adapter` 换一个适配器——运行本身继续,因为其他适配器可能完全正常。同一个适配器
  上连续三个 agent 都这样失败时,运行会记一条警告;之后用 `odw resume` 会重放所有已完成
  的 agent。一分钟内就会恢复的"额度"(Gemini 免费档就是这样描述它的每分钟限额的)按它
  实际上的限流来处理。

Claude Code 会在输出里报告这类错误,而且常常以 0 退出:它的 stream-json `result` 事件
带着 `is_error: true` 和错误消息(`API Error: Rate limit reached`、
`Claude AI usage limit reached|…`),这会被算作消息所指的那种失败。在文本模式下(文本
适配器,或回退到原始 stdout 的 JSON 输出),一条简短、内容只有这类限流、额度或登录错误
的回复同样会被算作对应的失败——绝不会被当成 agent 的答案。

ODW 能识别的措辞——从每个内置 CLI 的源码和 issue 中收集而来——集中在一张表里:
[`src/adapters/failures.ts`](src/adapters/failures.ts)。用适配器的 `failures` 教它
认识你自己 CLI 的措辞:按类别给出正则表达式,先于内置表、不区分大小写地匹配。

```jsonc
{
  "transientRetries": 3, // 限流后每次 agent() 调用的重试次数;0 = 从不重试
  "maxBackoff": 300, // 单次等待的最长秒数
  "adapters": {
    "my_wrapper": {
      "command": ["my-agent", "{prompt}"],
      "failures": {
        "rate_limit": ["server busy", "E_THROTTLED"],
        "quota": ["monthly tokens? (used up|exhausted)"],
        "auth": ["session expired"]
      }
    }
  }
}
```

### 运行通知

**ODW 扩展。** `notify` 会在一次运行结束时执行一条命令和/或向一个 webhook 发送 POST,
让通宵跑的 workflow 结束后主动告诉你结果:

```jsonc
"notify": {
  "command": ["/usr/local/bin/odw-notify"],        // 参数向量,不经过 shell 执行
  "webhook": "https://hooks.slack.com/services/…", // Slack、Discord 或任何接收 JSON 的端点
  "on": ["done", "failed", "stopped"]              // 默认:所有终态;"waiting" 需显式加入
}
```

这些 hook 只在运行的终态写入之后触发一次,所以既不会拖延、也不会改变终态;失败或卡住
的 hook 只会记录到该运行的 `worker.log`。命令(30 秒后被杀)在运行的源目录里执行,环境
变量里带有 `ODW_RUN_ID`、`ODW_RUN_STATE`、`ODW_WORKFLOW`、`ODW_RUN_DIR`、
`ODW_RESULT_FILE`(仅当运行有结果时)、`ODW_DURATION_SEC`、`ODW_AGENTS` 和
`ODW_FAILED_AGENTS`。webhook(10 秒时限)收到:

```jsonc
{
  "runId": "20261017-041600-3fa2c1",
  "workflow": "deep-research",
  "state": "done", // done | failed | stopped
  "createdAt": 1792210560.2, // Unix 秒
  "finishedAt": 1792210812.5,
  "durationSec": 252,
  "counts": { "agents": 12, "done": 11, "failed": 1 },
  "text": "odw · deep-research finished in 4m12s · 12 agents, 1 failed",
  "content": "odw · deep-research finished in 4m12s · 12 agents, 1 failed"
}
```

失败和被停止的运行还会多一个 `error` 字段。`text` 与 `content` 是同一行摘要,所以
Slack 和 Discord 的 incoming webhook 能直接渲染(同时设置了 Discord 的
`allowed_mentions`,一次运行永远不会 @ 到任何人)。看板的设置页会显示配置了哪些
hook——webhook 只显示协议和主机,因为 URL 的其余部分就是密钥。

在 `on` 里加上 `"waiting"`,就能在每个 [`checkpoint()`](#人工检查点odw-扩展) 开始等人
回答时收到通知。此时 hook 会对每个检查点触发一次,运行照常等待:命令的环境变量带有
`ODW_RUN_STATE=waiting`、`ODW_CHECKPOINT_ID` 和 `ODW_CHECKPOINT_TITLE`(没有
`ODW_RESULT_FILE`);webhook 收到 `"state": "waiting"`、一个
`"checkpoint": { "checkpointId", "title", "since" }` 字段(代替 `finishedAt`),以及一行
写明回答命令的 `text`。

Slack、Discord、ntfy 和桌面横幅的现成配置见
[`docs/recipes/notify.md`](docs/recipes/notify.md)。

### 隔离 worktree 与 agent 端口

`agent(prompt, { isolation: "worktree" })` 让这个 agent 在一个一次性的 git worktree 里
运行:它是 HEAD 的干净检出,没有你源目录里的 `.env`、`.venv` 或 `node_modules`。agent
启动前,有两样东西把它准备好:

- **`.worktreeinclude`**:放在仓库根目录(Claude Code 也读这个文件),用 `.gitignore`
  语法列出要带进来的东西。git 不跟踪、且被某一行匹配到的每个文件或目录都会复制进
  worktree(Claude Code 只复制被 gitignore 的文件;ODW 连单纯未跟踪的文件也复制)。
  `.git` 永远不复制,超过 100 MB 的文件会被跳过并记一行日志。`symlink:` 前缀(**ODW
  扩展**)把该行匹配到的东西链接过去而不是复制:对大目录瞬间完成,但它是共享的——agent
  往里写的东西会落到你的源目录。
- **`worktreeSetup`**(**ODW 扩展**):文件就位后在 agent 的工作区里运行,字符串交给
  平台 shell,数组作为 argv。超过 `worktreeSetupTimeout` 秒(默认 600)就会被杀掉;
  setup 失败或超时,失败的是这个 agent 而不是整个运行,错误里带着它输出的结尾。

```gitignore
# .worktreeinclude
.env
.env.local
config/secrets.json
symlink: node_modules
```

```jsonc
{
  "worktreeSetup": "npm run codegen", // 或一个 argv,例如 ["uv", "sync"]
  "worktreeSetupTimeout": 600,
  "portRange": [41000, 41999]
}
```

每个 agent 进程——不论是否隔离——还会拿到 `ODW_RUN_ID`、`ODW_AGENT_ID` 和 `ODW_PORT`
(**ODW 扩展**)。`ODW_PORT` 来自 `portRange`:本次运行中没有其他正在运行的 agent 占用
它(已经有程序在监听的端口会被跳过),并且直到这次调用结束都归这个 agent 所有。所以并排
运行的 agent 可以各自起一个 dev server:

```js
await parallel(['grid', 'list'].map((layout) => () =>
  agent(`Build the ${layout} layout, start the dev server on port $ODW_PORT and check that the page renders.`,
    { isolation: 'worktree', label: layout })))
```

请让这类 agent 在结束前停掉自己启动的服务:agent CLI 退出前可能会等它自己的后台命令
(`claude -p` 就会),于是 agent——连同它的端口——会一直被占着,直到卡死看门狗或超时结束它。

setup 命令拿到同样的三个变量,`exec()` 命令拿到 `ODW_RUN_ID`。请让 `portRange` 比
`concurrency` 更宽:如果其他 agent 占满了所有端口,新启动的 agent 就不带 `ODW_PORT`
运行,运行日志里会说明。一次调用的每次尝试(schema 重试、卡死重启、限流重试)都从一个新的
worktree 开始,并以同样方式准备。

### 审阅并应用隔离 agent 的改动(ODW 扩展)

隔离 agent 的 worktree 会在调用结束时删除,但它的工作不会丢:删除之前,ODW 把这个 agent
的改动——修改、新增、删除、重命名和二进制文件,不论是否暂存或提交——以统一 diff 的形式
保存在 run 目录里(`agents/<agentId>.diff`),并把改动规模
`changes: { files, insertions, deletions, truncated }` 记在该 agent 的 `agent_finished`
事件和已保存结果上。`agent()` 返回的仍是回复。`.worktreeinclude` 放进来的、`worktreeSetup`
生成的东西不算 agent 的改动,不会出现在 diff 里——除非 agent 之后又改了它们。

```bash
odw diff $RUN --stat               # 谁改了什么:文件数、增删行数、保留的分支
odw diff $RUN --agent fix:auth     # 某个 agent 的 diff(按 label 或 id)——git 能读的补丁
odw apply $RUN --agent 3 --check   # 能否应用到这里?哪些文件会冲突?
odw apply $RUN --agent 3           # 用 git apply --3way 应用到当前工作树
```

`odw apply` 在你所在的 git 工作树里用 `git apply --3way` 应用一个 agent 的 diff:能应用的
部分会被暂存,与你自己的改动冲突的 hunk 做三方合并并留下冲突标记(退出码 1)。只要 diff
涉及的路径上有未提交的改动,它就拒绝执行——先提交或 stash,或者加 `--force`。改动不同
文件的多个 agent 可以依次应用。看板在运行的 **Changes** 标签页里展示同样的 diff,并通过
`GET /api/runs/:id/agents/:agentId/diff` 提供。

- **`keep: true`**(`agent()` 选项)或 **`keepBranches: true`**(配置)还会把改动提交到源
  仓库的分支 `odw/<runId>/<agentId>-<label>` 上——作者是 `odw <odw@localhost>`,父提交是
  agent 开始时的那个提交——方便检出、合并或 cherry-pick。ODW 只创建这个分支:你的 HEAD、
  索引和其他分支都不会被碰。`keep: false` 让单个 agent 不受 `keepBranches` 影响。
- **`maxDiffBytes`**(默认 2 MB)限制单个 diff 的大小:超出时保留开头部分(在行边界截断),
  并在末尾加一行 `# odw: diff truncated …`。计数仍然描述完整的改动;被截断的 diff
  `odw apply` 会拒绝——请改用分支。
- 二进制文件在 diff 里只以对象 id 标出,不携带内容;git 从仓库的对象库里取回它(ODW 记录
  改动时已写入;保留的分支会让它永久保留)。
- 失败的 agent 同样保留 diff(比如超时前完成的工作),`odw resume` 会把重放 agent 的 diff
  带进新运行。被停止的运行不保留 diff。

```jsonc
{
  "maxDiffBytes": 2097152, // run 目录中单个 agent 的 diff 最多保留的字节数
  "keepBranches": false    // true:每个隔离 agent 的改动也都提交到一个分支
}
```

分步说明:[`docs/recipes/review-and-apply.md`](docs/recipes/review-and-apply.md)。

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
  在顶部,脚本体用了顶层 `await` **和**顶层 `return`,还引用注入的全局。loader 会(用
  字符串/注释/正则感知的扫描)抽出 `meta`、去掉 `export`,再把脚本体包进一个 async 函数,
  其参数**就是**那些原语——于是脚本体的 `return` 就变成 workflow 的返回值。
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
| `src/changes.ts` | 横切 — 隔离 agent 的改动,保存为 diff 和分支 |

workflow 脚本始终是**纯 `.js`**、从不编译;引擎用 **TypeScript** 写(编译成 ESM,
**零运行时依赖**),并附带 `.d.ts` authoring 类型,让脚本作者在编辑器里对注入的全局有
自动补全。

## 示例

[`examples/`](examples/) 里是可运行的纯 JS workflow:

| Workflow | 形态 |
| --- | --- |
| [`deep-research.js`](examples/deep-research.js) | 扇出调研 → 对抗式事实核查 → 带引用报告 |
| [`deep-research-verified.js`](examples/deep-research-verified.js) | 实战版:定界 → 搜索 → 抓取 → 三票对抗核查 → 带引用综合,配可进 cron 的包装脚本([配方](docs/recipes/deep-research-verified.md)) |
| [`ultra-mode.js`](examples/ultra-mode.js) | 有纪律的深度工作循环:规划 → 并行攻坚 → 对抗评审 → 综合 |
| [`fan-out-reduce.js`](examples/fan-out-reduce.js) | 并行起草 N 份 → 综合出最佳 |
| [`adversarial-verify.js`](examples/adversarial-verify.js) | 产出发现 → 只保留扛住证伪的 |
| [`review-swarm.js`](examples/review-swarm.js) | 梳理改动 → 按 N 个视角并行审查 → 逐条独立验证(可换另一个 CLI)→ 带证据的分级报告 |
| [`loop-until-dry.js`](examples/loop-until-dry.js) | 循环扇出 finder,连续 K 轮无新发现才停 |
| [`routing.js`](examples/routing.js) | 给请求分类 → 路由到对应专家 → 给结果打分 |
| [`generate-and-filter.js`](examples/generate-and-filter.js) | 并行产出大量点子 → 去重 → 只留过 rubric 的 |
| [`tournament.js`](examples/tournament.js) | N 种思路各自解题 → 两两评判晋级 → 决出唯一胜者 |
| [`codex-claude-loop.js`](examples/codex-claude-loop.js) | 两个对家 CLI 回合制对弈:Claude 实现,Codex 评审,循环直到签收 |
| [`agent-daily-digest.js`](examples/agent-daily-digest.js) | 发现信息源 → 并行提取 → 综合 → 核查 |
| [`test-fix-loop.js`](examples/test-fix-loop.js) | 用 `exec()` 跑测试 → agent 修复失败 → 重跑直到全绿(仅 ODW) |
| [`plan-approve-execute.js`](examples/plan-approve-execute.js) | agent 起草计划 → 有人在 `checkpoint()` 处批准(附说明的拒绝会重新规划)→ 并行执行 → 汇报(仅 ODW) |

## 开发

```bash
npm ci                # 安装锁定版本的构建依赖
npm run build         # tsc → dist/
npm test              # node:test 测试套件,由 mock 适配器驱动(无需真实账号)
npm run typecheck     # tsc --noEmit
npm run build:binary  # 打包 + Node SEA + postject → 单个自包含的 ./build/odw
```

要开发看板:先生成一组持续推进的模拟运行,让一个 server 指向它,再启动开发服务器——它会在每次
刷新页面时重新构建 `web/src`,并把 `/api`(含 SSE)代理到那个 server:

```bash
node web/demo-fixtures.mjs /tmp/odw-demo/runs /tmp/odw-demo/project --live &
echo '{"runsRoot":"/tmp/odw-demo/runs"}' > /tmp/odw-demo/odw.config.json
(cd /tmp/odw-demo/project && npx tsx "$OLDPWD/src/cli.ts" serve --config /tmp/odw-demo/odw.config.json --port 4317) &
node web/dev.mjs --api http://127.0.0.1:4317     # → http://127.0.0.1:5173
```

更新本地源码安装时,先构建更新后的目录,再运行 `npm install -g .`,并将同目录的
`skills/open-dynamic-workflows/` 复制到 agent 的技能目录。已经通过 npm 链接到源码的安装,
会直接使用重新构建的 `dist/`。

版本以 `package.json` 为准。源码构建显示 `0.5.0-dev+g<修订号>`,有未保存修改时附加
`.dirty`;不含 Git 记录的源码包显示 `0.5.0-dev+source`。构建或测试前会生成内嵌版本信息。
正式构建设置 `ODW_RELEASE_TAG=v0.5.0`,要求当前源码正好对应该版本、没有未保存修改,
包版本与锁文件一致,测试和类型检查通过,且二进制报告预期版本。所有平台构建成功后才发布。

`build:binary` 走的是标准的单二进制配方:[esbuild](https://esbuild.github.io/) 把
`dist/`(零依赖 ESM)打包成一个 CommonJS 文件,`node --experimental-sea-config` 生成
[SEA](https://nodejs.org/api/single-executable-applications.html) blob,再由
[postject](https://github.com/nodejs/postject) 把 blob 注入到一份 `node` 二进制的拷贝里
(macOS 下做 ad-hoc 签名)。esbuild 和 postject 都是**仅构建用的 devDependency**——
二进制和 npm 包仍保持零**运行时**依赖。跨平台二进制在 CI 里按操作系统分别构建
([`.github/workflows/release.yml`](.github/workflows/release.yml)):SEA 注入的是宿主
机的 `node`,所以每个目标平台都要在各自的 runner 上构建。

> 发布后,`npm i -g odw`(或 `npx odw …`)会把 `odw` 命令装到你的 PATH 上。

## 状态

**`main` 上的新内容(2026 年 10 月):**
- **人工检查点。** `checkpoint()` 会让运行暂停,直到有人批准或拒绝——通过
  `odw approve|reject`、看板,或可选的 `waiting` 钩子——让计划在昂贵的 fan-out 之前先
  得到一个"可以"(ODW 扩展;见 [`plan-approve-execute.js`](examples/plan-approve-execute.js))。
- **扛过限流。** 每次 agent 失败都会被分类(限流、额度、登录、超时、卡死……)。被限流的
  CLI 会按退避时间重试并遵守它给出的 retry-after;额度耗尽或登录失败则立即失败并说明该
  怎么做——`odw logs`、实时视图和看板里都能看到,连同恢复时间。
- **无需常驻进程的定时运行。** `odw schedule add <name> <workflow> --cron "15 2 * * 1-5"`
  会写入一条 cron、launchd 或 systemd 定时项,由它回调 odw——带防重叠锁、每个定时任务各自的日志,
  `odw schedule list` 里能看到上一次运行([配方](docs/recipes/cron.md))。
- **审阅并应用隔离 agent 的改动。** worktree agent 的改动会在 worktree 删除前保存为 diff
  (排除初始化时放进去的文件),也可以用 `keep` 保留到分支。在看板的**改动**标签页或用 `odw diff`
  审阅,再用 `odw apply`(先加 `--check`)逐个落地。
- **真实用量与花费。** 内置 `claude` 适配器改为读取 Claude Code 的 `stream-json`,每个 agent
  都会记录 CLI 上报的 token 与花费——`odw status`、实时视图和看板里都能看到——`--budget` 也按真实
  输出 token 计量。单次 fan-out 超过 `fanOutWarn`(25)时会提前提示。
- **开箱即用的 worktree。** `.worktreeinclude` 会把 `.env`、`node_modules` 等复制或链接
  进隔离 agent 的 worktree,`worktreeSetup` 运行你的初始化命令,每个 agent 都有自己的
  `$ODW_PORT`。
- 看板 Activity 页新增 **"待你处理"**:等待决定的运行,以及过去一天失败的运行和接着跑的
  `odw resume` 命令。
- **可恢复的运行。** 每个 agent 完成时结果即落盘——运行中就能用 `odw agents` /
  `odw result <run> --agent <id|label>` 或看板查看;`odw resume <run>` 会启动新运行并
  重放所有未变的 `agent()` 调用,卡住或失败的运行只需重跑改动的部分(#24)。
- **`exec()`** 不经模型直接在工作流里运行命令——测试、构建、lint——支持超时、输出上限
  和停止(#31;ODW 扩展),并附 [`test-fix-loop.js`](examples/test-fix-loop.js) 与
  [`review-swarm.js`](examples/review-swarm.js) 两个新示例。
- **运行钩子与卡死看门狗。** 运行结束、失败或停止时触发 `notify` 命令或 webhook(兼容
  Slack/Discord);可选的 `stallTimeout` 会终止并重启长时间无输出的 agent;worker 收到
  SIGTERM 时会干净地停止运行。
- **`odw doctor [--smoke]`** 检查运行环境、配置和每个适配器;加 `--smoke` 会发一条真实
  提示,揪出那些无头模式下没有回答却以 0 退出的 CLI。
- **可靠性。** 超时和停止会作用于 agent 的整个进程树(先 SIGTERM 再 SIGKILL),也能停下
  已在运行的 agent;崩溃或被吞掉的致命错误不会再让运行卡在 `running`,停止的运行也不会被
  记成 `done`;有歧义的结构化回复会重试而不是瞎猜;配置里的非法数字会直接报错。
- **安全与规模。** 工作流 `meta` 只解析、绝不求值,列出工作流时也不编译正文;看板服务端
  增量读取事件、只推送运行列表的变化,上千个运行也依然流畅;安装时校验 SHA256;CI 覆盖
  Node 20/22/24、macOS 与 Windows。
- **全新设计的看板**([见上文](#看板观测检查对话))与落地页。

**0.5.0 开发版：**排队任务在真正启动前重新检查暂停、停止和预算;等待命令能识别后台进程
已退出。升级时二进制与 skill 固定同一版本,替换失败恢复旧文件;源码构建显示具体修订号。

**最新(`main` 上,未发版):**在交互式终端里,`odw run` 现在会直接挂上**前台实时视图**
——Ctrl-C 只脱离不杀任务,`odw attach` 随时挂回,管道/CI 下仍保持先拿 run id 再轮询的
老契约。**首跑引导**落地:装了多个 CLI 时安装器会当场让你选默认,`odw init` 随时重开
这个选择,发射时会预警"裸 `agent()` 调用会失败",配置错误也改为当场失败——不再返回一个
装满 null 的"成功"运行。内置 `codex`/`claude` 适配器**开箱自带联网能力**,实战版
[`deep-research-verified.js`](examples/deep-research-verified.js) 连同可进 cron 的
包装脚本一起入库。更早合入 `main` 的:看板的本地 **Chat Host**(提到 ODW 的回合交给真实
异步运行)、桌面(Tauri)App **退役**、方言补**完整**——嵌套 `workflow()`(共享调度与预算,
仅一层)、`budget.spent()` 估算计量及后续派发前的预算检查、`odw run --adapter
<name>`、随 run 留档的内联脚本运行,以及让 workflow 能生成 workflow 的 `validate()` 原语。

**v0.3.0:****Jobs** 标签页也会展示 **Claude Code 自己的 workflow 运行**——已完成的
历史与正在跑的实时任务——只读,并与 ODW 自己的 run 合并。见
[Releases](https://github.com/xz1220/open-dynamic-workflows/releases)。

**核心运行时已交付。** 完整运行时已在 `main` 上——适配层、执行桥接、工作区隔离、异步调度器、
注入原语、loader/transform、JSON-Schema 引擎、后台运行时,以及 `odw` CLI。回归测试由
[CI](https://github.com/xz1220/open-dynamic-workflows/actions/workflows/ci.yml) 持续检查,
旗舰示例 [`examples/deep-research.js`](examples/deep-research.js) 端到端跑通
(plan → search → extract → vote → report)。

### 路线图

按并行 coding agent 用户反馈的需求排序([调研](docs/research/user-needs-2026-10.md)):
更多 CLI 上报的真实 token 用量与花费(目前 Claude Code 已上报,其余仍按估算)·
无头运行的"成功证据" · 每个 agent 的 transcript · 只读/编辑/完全三档权限 ·
原生结构化输出 · 按阶段指定适配器与回退链 · 评测。完整规划见 [`docs/ROADMAP.md`](docs/ROADMAP.md);
最初的设计见 [`docs/dynamic-workflows-tech-plan.md`](docs/dynamic-workflows-tech-plan.md);
ODW 所对齐的 Claude Code 方言背景见
[`docs/dynamic-workflows-research.md`](docs/dynamic-workflows-research.md)。

## 作为 skill 使用

[`skills/open-dynamic-workflows/SKILL.md`](skills/open-dynamic-workflows/SKILL.md)(简体中文版:[`skills/open-dynamic-workflows/zh-CN/SKILL.md`](skills/open-dynamic-workflows/zh-CN/SKILL.md))
让宿主 agent 仅凭文档就能编写并运行 workflow——把它装进你的 agent 的 skills 目录
(Codex CLI → `~/.codex/skills/`,Claude Code → 它的 skills 目录)。

## FAQ

<details>
<summary><b>这和 CLAUDE.md / AGENTS.md / 一个 skill 有什么区别?</b></summary>

那些是在 agent <i>自己的上下文里</i>教它怎么做事。dynamic workflow 把工作挪到
<i>外面</i>:计划在脚本里,子任务作为独立 agent 进程大规模运行,只有最终值回来。
ODW 也带一个 skill——但 skill 的职责是教你的 agent 写和跑 workflow,而不是充当编排
本身。
</details>

<details>
<summary><b>这和 LangGraph / n8n / Airflow 有什么区别?</b></summary>

那些编排的是 API 调用和自定义节点。ODW 编排的是 <b>coding-agent CLI</b>——你已经在付
费、已经配好的那些(Codex、Claude Code、Gemini、…)——在本次运行自己的工作目录里跑,
工作区隔离和 diff 按 agent 选入。没有 DSL、没有服务集群:一个 workflow 就是一个 Claude Code 现有方言
的纯 JavaScript 文件,引擎是零依赖的 Node CLI。
</details>

<details>
<summary><b>ODW 会直接调用模型 API 吗?</b></summary>

不会。ODW 只 shell 出到你已经登录过的本地 CLI。没有 API key、没有自己的 token 计费、
引擎不发任何网络请求。
</details>

<details>
<summary><b>网页能通过 <code>odw serve</code> 驱动我本机的 agent 吗?</b></summary>

不能。写端点要求 <code>Content-Type: application/json</code> 和同源 Origin,Host 头
有 allowlist 防 DNS rebinding,绑定到非回环地址时写操作一律拒绝(看板仍可读)。
</details>

<details>
<summary><b>桌面 App 去哪了?</b></summary>

已退役。App 本来就是 `odw serve` 所服务的同一份单文件 SPA 外面的一层薄 Tauri 壳,
所以网页看板现在是唯一的客户端——天然跨平台,除 `odw` 本身外无需安装任何东西。
</details>

## Star 趋势

<a href="https://star-history.com/#xz1220/open-dynamic-workflows&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=xz1220/open-dynamic-workflows&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=xz1220/open-dynamic-workflows&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=xz1220/open-dynamic-workflows&type=Date" width="600" />
  </picture>
</a>

## 许可证

[MIT](LICENSE)
