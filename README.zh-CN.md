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
  `logs --follow`、`result`、`pause` / `stop`。
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
| 工作区隔离 | 从已保存的 HEAD 创建临时工作区,不含未保存修改,结束后清理。不会自动合并,`agent()` 返回回复而非 diff;需保留的交付物应放进回复或显式持久化。 |
| 预算 | 按 `ceil(字符数 / 4)` 估算所有回复的输出 token,包括 schema 重试(不计输入和失败调用)。每次派发和每次 schema 重试前都会检查;预算用尽时运行结束,仍在运行的 agent 会被停止。 |
| JSON Schema | 只校验[已列出的子集](skills/open-dynamic-workflows/zh-CN/references/primitives.md#schema)。`$ref`、`const`、`oneOf` 等约束不会生效;请明确声明对象/数组类型并使用受支持的约束。 |
| 脚本可信性 | 只运行可信脚本:运行工作流会把正文当作普通 JavaScript 执行。加载时元数据按纯字面量解析,不会被求值;编译检查和兼容性警告都不提供沙箱隔离。 |
| 恢复 | 每个完成的 `agent()` 结果都会在完成时保存。`odw resume` 让已暂停且仍存活的 worker 原地继续;对已结束的运行(done、failed、stopped,或崩溃后的 stale)则启动一个新运行:prompt 和选项都没变的调用直接重放,其余照常执行。`rerun` 从头执行。见[恢复运行](#恢复运行odw-扩展)。 |

原语名称一致不代表运行机制完全等价。`validate(source)` 和 `exec(command)` 是 ODW 扩展,
迁移到未提供它们的宿主时需要去掉(`validate()` 会对 `exec()` 调用给出 warning)。可恢复失败产生的 `null` 需要显式处理：接受部分结果、重试,或在要求完整
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
odw status $RUN          # 状态 + agent 计数
odw agents $RUN          # 每个 agent 及其已保存的结果,运行中也可看
odw logs $RUN --follow   # 流式输出原始进度事件
odw result $RUN          # 最终值
odw pause|resume|stop $RUN
odw list
```

`--fg` / `-d, --detach` / `--wait`(阻塞到结束并打印结果,stderr 仅一行 run id
提示)可显式指定模式;环境变量 `ODW_DETACH=1` 强制后台。

一次运行在独立的 detached worker 进程里执行,并把一切持久化到一个 run 目录——所以它能
比启动它的命令活得更久,也能从任何地方被观测。

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
| `claude` | `claude` | stdout 文本;放行 WebSearch/WebFetch |
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

ODW 只把解码后的最终响应交给 workflow;JSONL 输出会边流式到达边逐行解码,stderr 只保留有限的尾部用于错误信息。
Windows 下的可执行文件探测遵循 `PATHEXT`,所以 `agent.cmd`、`kilo.cmd`、`omp.exe`
这类普通 shim 无需写完整路径也能识别。

配置键全部放在**顶层**——没有 `"settings"` 包装层;odw 会对未知或放错位置的键
在 stderr 上给出警告(附 did-you-mean 提示),而不是静默忽略。没设
`defaultAdapter` 时,odw 会用唯一配置的 adapter——或在全新安装下,用 PATH 上
唯一真实存在的那个 CLI;若装了多个,报错会列出它们并告诉你如何选择。

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

**0.5.0 开发版：**排队任务在真正启动前重新检查暂停、停止和预算;等待命令能识别后台进程
已退出。升级时二进制与 skill 固定同一版本,替换失败恢复旧文件;源码构建显示具体修订号。

**下一版(未发版):**每个已完成 agent 的结果都会**在完成时保存**——`odw agents`、
`odw result --agent` 和看板在运行中即可读取——`odw resume` 则把已结束的运行变成一个新运行,
**重放**每个未改动的 `agent()` 调用,卡住或失败的运行不必再从头开始
([#24](https://github.com/xz1220/open-dynamic-workflows/issues/24))。

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

### 路线图(v1.5+)

`model` / `agentType` 富路由 · adapter 上报的真实 token
用量(当前预算按估算计量)· 用于可重放确定性的
`Date.now`/`Math.random` 沙箱。
完整方案见 [`docs/dynamic-workflows-tech-plan.md`](docs/dynamic-workflows-tech-plan.md);
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
