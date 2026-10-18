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
  OMP、Kilo、OpenCode、Cursor 或你自己的 CLI 上;换底层 agent 只需换适配器——也可以按阶段
  混用,并在某个 CLI 额度用尽时回退到另一个。
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
| `agent(prompt, opts?)` | 让一个 coding agent 跑一个子任务。唯一真正"产出工作"的原语。返回文本;设了 `opts.schema` 则返回校验过的对象。设了 `opts.expect` 时,它的工作会被检查——某条命令以 0 退出、有文件改动、回复匹配——没达到就带着缺失项重试;见[检查 agent 的工作](#检查-agent-的工作odw-扩展)(**ODW 扩展**)。 |
| `parallel(thunks)` | 一组任务并发执行、**等全部完成**(屏障)。可恢复失败变 `null`;停止、预算耗尽和派发上限错误会中止运行。 |
| `pipeline(items, ...stages)` | 每个条目独立穿过各 stage(**无屏障**)。每个 stage 收 `(prev, item, index)`。 |
| `phase(title, opts?)` / `log(msg)` | 把进度归入某阶段 / 发一行进度消息。`opts`——`{ adapter, model }`——为该阶段的 agent 指定适配器和模型(**ODW 扩展**;见[按阶段路由](#按阶段路由与回退链odw-扩展))。 |
| `schema`(JSON Schema) | 给 `agent` 的输出定一个类型契约;回复会被校验,不符就重试。ODW 无法检查的关键字会记入运行日志(设 `"schemaKeywords": "strict"` 则让调用失败);会校验 schema 的 CLI(`claude`、`codex`)直接原生强制执行——见[结构化输出](#结构化输出odw-扩展)。 |
| `args` | workflow 的输入,原样注入。 |
| `budget` | `{ total, spent(), remaining() }`——按 token 目标动态扩缩深度。 |
| `workflow(ref, args?)` | 内联调用另一个 workflow(仅一层)。子 workflow 共享本次运行的并发上限、agent 计数与预算;其 phase 以独立泳道归组。 |
| `validate(source)` | 解析并编译检查可信源码,不运行工作流正文;元数据按纯字面量解析,不会被求值。**ODW 扩展**(不属于 Claude Code 方言)。 |
| `exec(command, opts?)` | 不启动模型直接运行一条命令——测试、构建、linter;返回 `{ stdout, stderr, exitCode, signal, timedOut, truncated, durationMs }`。字符串经 shell 执行,数组按 argv 执行。受 `timeout`(600 秒)和 `maxOutputBytes`(每个输出流 8 MiB)约束;停止会杀掉它。不占 agent 槽位。**ODW 扩展**(不属于 Claude Code 方言)。 |
| `checkpoint(title, opts?)` | 暂停运行,直到有人批准(可以附上修改后的 payload)或拒绝——用 `odw approve\|reject` 或看板——然后返回 `{ approved, note, by, payload, edited }`。`opts`:`payload`(要给人看的内容)、`schema`(修改必须满足的 JSON Schema)、`timeout`(秒)和 `onTimeout`(`"approve"`、`"reject"`,或默认的 `"fail"`)。不占 agent 槽位;停止依然会结束运行。见[人工检查点](#人工检查点odw-扩展)。**ODW 扩展**(不属于 Claude Code 方言)。 |

下一步需要"全量结果一次到位"(去重、计票、综合)时用 **`parallel`**;多阶段处理默认用
**`pipeline`**。归并要保持顺序无关——按"谁先跑完"分支会破坏可复现性。完整参考见
[`skills/open-dynamic-workflows/references/primitives.md`](skills/open-dynamic-workflows/references/primitives.md)。

### 检查 agent 的工作(ODW 扩展)

无头运行的 agent 可能"成功"了却没干活:说修好了 bug,其实一个文件都没碰;说测试通过了,
其实还是红的。与其问模型"你做了吗",不如写明必须成立的条件——agent 回复之后(若设了
`schema`,则在校验通过之后),由 odw 来检查:

```js
const summary = await agent('Fix the failing tests in src/parser.', {
  expect: {
    command: 'npm test',        // 必须在 agent 的工作区里以 0 退出(超时 600 秒)
    changes: true,              // 必须有文件改动(false:不许有任何改动)
    files: ['src/parser/**'],   // 每个 glob 都必须匹配到一个被改动或新建的文件
    match: '^Fixed',            // 回复必须匹配的正则表达式
    mcp: ['github'],            // CLI 启动 agent 时必须连上的 MCP 服务器(claude)
  },
})
```

没达到要求的工作会重跑——默认一次(`expectRetries`,可按调用或在配置里设)——并把缺失项
追加到提示词里,失败命令的输出也一并附上。仍未达到时,`agent()` 抛出一个可恢复的错误
(在 `parallel()` 里变成 `null`),带有 `reason: "unmet_expectation"` 和逐条列出的
`misses`——它的 `agent_failed` 事件、`odw logs`、实时视图和 `/api/runs/:id` 也都带着它们:

```text
agent_failed    (Fix) fixer — [unmet_expectation] did not meet: `npm test` must exit 0, and it exited with code 1
```

- **agent 改了什么**从 git 读取,路径相对于它的工作区。原地运行时,是与 agent 启动前的
  源码树相比的差异——你自己未提交的改动和 odw 的运行目录不算,agent 的提交算——所以同时
  原地运行的其他 agent 的改动也会算进来:在意这一点就用隔离。用 `isolation: "worktree"`
  时,就是 odw 作为该 agent 的 diff 保留的那份改动,而重试会在全新的 worktree 里从头开始,
  它的改动取代先前的改动。
- **命令**作为 agent 名下的一个 `exec()` 步骤运行(它的事件带 `forAgentId`),在读取改动
  之后执行,所以它写出的文件绝不会被算成 agent 的工作;停止会杀掉它。
- **有[回退链](#按阶段路由与回退链odw-扩展)时,**缺失项在做出这份工作的
  适配器上重试——缺失绝不会触发回退。因额度用尽或登录被拒而换到下一个适配器的调用会带着
  它的 `expect`:下一个适配器从头开始这项工作,有自己的 `expectRetries`——隔离运行时在全新的
  worktree 里;原地运行时,对照调用开始之前的源码树来判断。
- **被拒绝的工具调用算作一项缺失。** 在默认的 `edit` 档位下,Claude Code 无头运行时会拒绝
  所有不在允许列表里的 shell 命令;设了 `expect` 时,`result` 里列出 `permission_denials`
  的回复会像任何缺失一样交还给 agent,之后以 `reason: "permission"` 失败,并列出被拒绝的
  调用。没设 `expect` 时回复照常成立——见下一条。
- **无需开启:**空回复以 `reason: "empty_reply"` 失败(`allowEmpty: true` 接受空回复)。
  CLI 拒绝了工具调用、但回复照常成立的 agent,会把它们作为 `denied` 记在它的
  `agent_finished` 事件、保存的结果和 `/api/runs/:id` 上,运行还会记一行日志:
  `search:3: Claude Code refused 2 tool calls — Bash (npm test); …; its reply may rest on
  work it could not do (raise its tier with --permissions or allowlist the tool)`。
  `"permissionDenials": "fail"`(或适配器自己的 `permissionDenials`)则让这样的 agent 以
  `reason: "permission"` 失败。
- **没启动起来的 MCP 服务器。** Claude Code 的输出流以一个 init 事件开头,列出它为 agent
  启动的 MCP 服务器;启动失败的服务器会让 agent 用不了它的工具,而 agent 仍可能说"完成了"。
  每个状态不是 `connected` 的服务器都作为 `mcp: [{ name, status }]` 记在 agent 的
  `agent_finished`(或 `agent_failed`)事件、保存的结果和 `/api/runs/:id` 上,运行按服务器
  和状态各记一行日志(每次运行一次):``MCP server github failed to start (claude agent
  `fix-auth`): its tools were unavailable``。回复照常成立——Claude Code 自己也只是警告——
  除非 `"mcpFailures": "fail"`,它让服务器为 `failed` 或 `needs-auth` 的 agent 以
  `reason: "mcp_unavailable"` 失败。`expect: { mcp: [...] }` 则把列出的服务器缺席——
  `failed`、`needs-auth`、`disabled` 或没有配置——算作一项缺失,重试后以
  `unmet_expectation` 失败。`pending` 两者都不算:Claude Code 的文档说不要把它单独当作
  失败(`.mcp.json` 里的服务器通常以这个状态启动,并在后台连接)。

Claude Code 的 Workflow 工具会忽略 `expect`,在那里检查不会执行。
[`examples/fix-until-green.js`](examples/fix-until-green.js) 用 `expect` 驱动一个
"修到测试通过为止"的循环。

## 兼容性与迁移

ODW 已实现下列原语能力。依赖宿主私有运行机制的脚本,迁移前需要逐项核对：

| 功能 | ODW 的行为与迁移要求 |
| --- | --- |
| 嵌套 `workflow()` | 已实现一层嵌套,共享父任务的调度器、控制和预算。更深层的调用需要展平。 |
| 模型选择 | 在 `agent(..., {model})` 中传该 CLI 的模型 ID;适配器没有模型参数时会记录路由说明。`meta.phases` 条目里的 `model`(以及 `adapter`)是该阶段 agent 的默认值,`model: "@fast"` 按 CLI 选出某层级的模型——都是 **ODW 扩展**(见[按阶段路由](#按阶段路由与回退链odw-扩展));阶段的模型和其他模型 ID 一样,其 agent 可能跑在多个 CLI 上时请用层级。`meta.model` 仍只是元数据。 |
| `agentType` | 将人设加入提示词,不会加载宿主的同名子 agent 配置或选择适配器。 |
| 工作区隔离 | 从已保存的 HEAD 创建临时工作区,不含未保存修改,结束后清理。不会自动合并,`agent()` 返回回复而非 diff;ODW 会把每个隔离 agent 的改动保存为 diff,供审阅和应用(`odw diff`、`odw apply`、`keep` 分支——均为 ODW 扩展;见[审阅并应用](#审阅并应用隔离-agent-的改动odw-扩展))。支持 `.worktreeinclude`(ODW 连未跟踪文件也复制,而不只是被 gitignore 的文件);其中的 `symlink:` 行、`worktreeSetup` 和 agent 的 `ODW_PORT` 是 ODW 扩展——见[隔离 worktree](#隔离-worktree-与-agent-端口)。 |
| 预算 | 计算输出 token:适配器上报用量时用 CLI 自己的计数(内置 `claude` 和 `codex` 会上报——见[用量与花费](#用量与花费odw-扩展)),否则按每条回复的 `ceil(字符数 / 4)` 估算。每次 CLI 运行都计入:schema 重试、限流重试,以及上报了用量的失败运行。每次派发和每次 schema 重试前都会检查;预算用尽时运行结束,仍在运行的 agent 会被停止。 |
| JSON Schema | ODW 只检查[已列出的子集](skills/open-dynamic-workflows/zh-CN/references/primitives.md#schema);`format` 是注解。其他关键字(`$ref`、`const`、`oneOf`、`maxItems` 等)照常运行:运行日志会写明关键字及其位置,自己校验 schema 的 CLI(`claude`、`codex`)会强制执行它们。设 `"schemaKeywords": "strict"` 则改为拒绝这类调用(ODW 扩展;见[结构化输出](#结构化输出odw-扩展))。请明确声明对象/数组类型并使用受支持的约束。 |
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
                                             #   --permissions read|edit|full:agent 能做什么
                                             #   --untrusted:挡住仓库的 CLAUDE.md、hooks 等
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
odw diff $RUN --stat     # 隔离 agent 改了什么;odw apply $RUN --agent N(或 --all)落地
odw compare $OLD $RUN    # 两次运行之间变了什么:配置、耗时、花费、失败、回复(见下文)
odw eval review          # 用例 × 适配器 × 重复次数:每个单元格的通过率、花费与耗时(见下文)
odw export $RUN --otlp   # 把运行导出为 OpenTelemetry trace(OTLP/JSON;--send 直接发送;见下文)
odw bundle $RUN          # 把运行写成一个可分享的脱敏文件:$RUN.odwrun(用 odw view FILE 查看;见下文)
odw pause|resume|stop $RUN
odw approve|reject $RUN  # 回答运行正在等待的 checkpoint()(--note TEXT、--checkpoint N)
odw approve $RUN --edit  # ……先在 $EDITOR 里修改 payload 再批准(或 --payload JSON|@file)
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

**来自 Claude Code 插件的 workflow**(ODW 扩展)。Claude Code 插件可以自带 workflow——放在
它的 `workflows/` 目录,或 `plugin.json` 的 `"workflows"` 指向的位置。ODW 能运行你已安装
并启用的插件所带的 workflow,名字与 Claude Code 给它们的一致:

```bash
odw workflows list --plugins          # <plugin>:<name>,以及来自哪个插件、版本和作用域
odw run acme-tools:release-audit      # 就地运行,直接读插件自己的目录
```

ODW 读取 `~/.claude/plugins/installed_plugins.json`(遵循 `CLAUDE_CONFIG_DIR` 和
`CLAUDE_CODE_PLUGIN_CACHE_DIR`;project 或 local 作用域的安装只在其项目内生效),以及你的
`~/.claude/settings.json`、项目的 `.claude/settings.json` 和 `.claude/settings.local.json`
里的 `enabledPlugins`(没有条目的插件按其 `defaultEnabled`)。它只读不写:插件的文件从不
被修改,脚本走与其他 workflow 相同的加载器——`meta` 不是纯字面量的脚本会被略过(Claude
Code 也会略过它),运行会在日志里写明 workflow 来自哪里、用到了哪些 ODW 独有的原语。只有当
没有项目级或个人级 workflow 同名、且只有一个插件提供该名字时,裸名字才会运行插件的
workflow;项目里有同名 workflow 时运行项目的那个,并提示
`run acme-tools:release-audit for the plugin's`。`GET /api/workflows` 以 provider
`claude-plugin:<plugin>` 列出它们,运行记录归在 `<plugin>:<name>` 下。在
[不受信任](#不受信任的仓库odw-扩展)的运行中插件 workflow 照常可用——它们是你自己安装的——
但仓库的设置只能禁用插件,不能启用;名字也不会解析到仓库自己的 `.odw/workflows` 或
`.claude/workflows`(给出路径仍可运行)。

**喜欢用浏览器?** `odw serve` 会对同一个 run 目录开一个零依赖的实时看板——每次运行都是一张
实时图,还有时间线、日志和结果,全部通过 SSE 推送。无需构建,不引入额外依赖,加载时不访问网络。

```bash
odw serve [--open]                      # 实时看板,默认 http://127.0.0.1:4317
odw serve --port 8080 --host 0.0.0.0 --token   # 远程只读、需要令牌(见「远程只读访问」)
odw view run.odwrun                     # 只读查看分享的运行包(见「分享一次运行」)
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
  [因额度用尽而暂停](#额度用尽时暂停odw-扩展)的运行会立即继续;
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
odw approve $RUN --edit   # 先修改 payload,再批准修改后的内容
```

也可以在看板里该运行的页面上点 **Approve** / **Reject**(仅限 loopback 绑定;它向
`POST /api/runs/:id/checkpoint` 发送 `{ action, checkpointId?, note?, payload? }`;
`GET /api/runs/:id` 会列出 `pendingCheckpoints`,运行列表则用 `waiting` 标出每个等待中
运行最早的那个问题)。调用返回 `{ approved, note, by, payload, edited }`
——`by` 是 `cli`、`dashboard` 或 `timeout`——拒绝也是一个答复而不是错误:"不"意味着
什么由脚本决定。

**修改后批准。** 和 Claude Code 的计划审批一样,审批人可以改了再批,而不必拒绝后重跑。
`odw approve $RUN --edit` 会用 `$VISUAL` / `$EDITOR`(否则 `vi`;Windows 上是 `notepad`)
打开一个私有临时文件,里面是格式化后的 payload:保存修改即批准修改后的内容;不改动就按
原样批准;清空文件则放弃、不作答复。JSON 无效或修改不被检查点接受时,命令带着错误退出并
保留该文件(打印其路径)。`--payload '<json>'` 或 `--payload @plan.json` 不经编辑器直接
批准修改,看板则在 `action: "approve"` 时附上 `payload`。调用随后返回的 `payload` 是修改
后的内容(没有修改时是检查点原来的 payload),只有与原 payload 的 JSON 不同时
`edited` 才为 `true`;拒绝和超时都带回原 payload。给 `checkpoint()` 一个 `schema`
(JSON Schema,用与 `agent()` 相同的校验器检查),修改就必须满足它:`odw approve`、API
和运行本身都会拒绝不满足的修改,并给出校验错误。没有 schema 时任何 JSON 值都接受——
payload 是脚本自己的数据,只有脚本知道修改可以是什么样——所以依赖其结构的脚本应当给出
schema:

```js
const { approved, payload: approvedPlan } = await checkpoint('Run this plan?', { payload: plan, schema: PLAN })
```

- `payload` 可以是任意 JSON 值——计划、改动摘要——最多保留 64 KiB。
- 修改后的 payload 最多 256 KiB JSON;`checkpoint_resolved` 会记录 `edited: true` 和
  修改内容(与问题的 payload 一样截断到 64 KiB)。
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
在它所有的 CLI 运行上求和——内置 `claude` 适配器这些都会上报;内置 `codex` 只上报 token
(它的 `turn.completed` 事件不带美元花费,ODW 也不自行编造价格),所以 codex agent 只显示
token、不显示花费。CLI 不上报输出 token 时
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
  JSONL 适配器的事件按 CLI 打印的原样每行一个(内置 `claude` 的 stream-json、`codex` 的 `exec --json`、`kilo` 和
  `opencode`),其他适配器的输出写成 `{"kind":"text","text":…}` 行。stderr 的结尾(最后
  64 KB)写入 `agents/<agentId>.stderr.txt`;`odw logs --agent` 会在 transcript 之后显示它的最后几行。
- schema 重试、卡死重启或限流重试都接着写在同一个文件里,前面先写一行
  `{"kind":"attempt","n":2,"reason":"schema"|"stall"|"rate_limit"}`。
- `maxTranscriptBytes`(默认每个 agent 5 MB)限制其大小:超出时以一行
  `{"kind":"truncated","bytes":N}` 结束 transcript。transcript 包含 agent 读到和运行过的
  一切——疑似密钥在流式写入时即被脱敏(见 [ODW 所保存内容中的密钥](#odw-所保存内容中的密钥odw-扩展));
  `"maxTranscriptBytes": 0` 则完全不保存。
- 保存从不拖慢 agent:各行先在内存中缓冲,再异步追加到文件。
- 被 `odw resume` 重放的 agent 没有运行任何 CLI,所以没有 transcript——请看原运行的。
- 看板 API 提供规范化后的版本:
  `GET /api/runs/:id/agents/:agentId/transcript?since=<i>` →
  `{ entries, next, more, truncated, replayed }`,每个条目为
  `{ i, kind: text|tool_call|tool_result|error|attempt|result|raw|truncated, text?, tool?, input?, output?, isError? }`,
  长字段截断到 4 KB(`clipped: true`),有密钥被拦下的条目带 `redacted: true`。

### 对比两次运行(ODW 扩展)

改了提示词、换了适配器或模型、升级了 CLI 之后重跑了工作流?`odw compare` 告诉你变了什么:

```bash
odw compare $OLD $NEW                  # 配置差异、运行总计(含 B − A)、每个 agent 一行
odw compare $OLD $NEW --agent judge    # 某个 agent 在两次运行中的情况,以及完整的回复 diff(按 label 或 id)
odw compare $OLD $NEW --json           # 同一份对比,供脚本使用——GET /api/compare?a=…&b=… 返回同样的结构
```

- **配置**:两次运行所用的、有差异的东西——工作流源码(启动时的 sha256)、脚本、args、odw
  版本、`--budget`、各适配器 CLI 的版本、会改变行为的设置(超时、重试、权限档位、`fallback`、
  `models` 等)、用到的适配器的定义,以及 agent 实际用到的适配器和模型。
- **运行**:总耗时、输入/输出 token、花费、完成与失败的 agent 数——A、B 和 B − A。
- **Agent**:先按 label 匹配(两次运行中各只出现一次的 label),再按 `odw resume` 重放所用的
  调用键匹配(提示词和选项相同即同一调用),最后按所在 phase 内的顺序匹配;其余的显示为仅在 A
  或仅在 B。每行给出两边的状态、适配器/模型、耗时、花费、尝试次数、保留 diff 的统计,以及回复是
  相同还是不同(文本回复给出有上限的统一 diff,结构化回复给出有上限的 JSON 路径列表;`--agent`
  显示完整内容)。
- 在终端里,B 更差(耗时或花费更多、新出现失败)标红,更好标绿;`NO_COLOR` 和管道输出为纯文本。
  表格不超过 100 列。
- 已完成、失败和被停止的运行都可以对比;仍在进行的运行按当前状态对比,并附一条说明。

这一切依赖每次运行记录下的信息:`meta.json` 中的 odw 版本和工作流的 sha256,`run_started`
事件上会改变行为的设置,每个 `agent_started` 上的调用键和模型,以及——某个适配器在本次运行中
第一次派发 agent 时——与 agent 并行执行、3 秒超时的 `<cli> --version`,记为 `cli_version`
事件(`odw status` 和 `GET /api/runs/:id` 的 `cliVersions` 会显示)。它绝不拖慢或导致运行失败;
不回应的 CLI 记为未知版本。命令为 node 或其他解释器、脚本或相对路径的适配器不做探测。
`"recordVersions": false` 关闭探测。`odw eval`(见下文)就建立在这些记录之上。

### 评估工作流(ODW 扩展)

改了提示词、模型分层或 CLI 之后,想知道工作流是否仍然把事情做对——可复现,并且在你用的每个
CLI 上都成立?把几个用例写进一个 eval 文件,`odw eval` 会让每个用例在每个适配器上各跑若干次,
并逐次判定:

```bash
odw eval review                          # .odw/evals/review.json;也可以给路径:odw eval examples/evals/routing.json
odw eval review --adapter claude,codex --repeats 5   # 覆盖文件里的 adapters 与 repeats
odw eval review --json --out today.json  # 以 JSON 输出报告(stdout 和文件)
odw eval review --baseline today.json    # 与之前的报告对比;有单元格退步时以 1 退出
```

```json
{
  "workflow": "review",
  "adapters": ["claude", "codex"],
  "repeats": 3,
  "concurrency": 2,
  "timeout": 900,
  "cases": [
    { "name": "small-diff", "args": { "diff": "…" },
      "checks": [
        { "state": "done" },
        { "path": "verdict", "equals": "approve" },
        { "path": "findings[0].file", "matches": "\\.ts$" },
        { "command": "jq -e '.findings | length < 5' \"$ODW_RESULT\"" },
        { "maxCostUsd": 0.5 }, { "maxSeconds": 300 }
      ] }
  ]
}
```

- **文件**:`workflow`(名字或路径,与 `odw run` 一样从运行 `odw eval` 的目录解析)、`cases`
  (`name`、`args`、`checks`),以及可选的 `adapters`(每个适配器都以运行默认适配器的身份跑完
  全部用例,等同 `odw run --adapter`;省略时用配置的默认适配器)、`repeats`(默认 1)、
  `concurrency`(同时进行的运行数,默认 1)、`budget`(token,作为每次运行的 `--budget`)、
  `timeout`(秒;到时仍在进行的运行会被停止并判为失败)、`name` 与 `description`。文件会被严格
  校验——未知字段、错误的路径或正则都会报错并指出位置——在任何运行开始之前。
- **检查**只看运行结果,不调用模型:`{ path, equals }`(深度相等)、`{ path, contains }`(子串,
  或数组中的某个元素)、`{ path, matches, flags? }`(正则;非字符串值按其 JSON 匹配)、
  `{ path, exists }`(`true`,或 `false` 表示"不存在")、`{ command, timeout? }`(在项目目录中由
  shell 执行并以 0 退出,环境变量 `ODW_RESULT`——存放结果 JSON 的文件——与 `ODW_RUN_ID` 已设置;
  默认 300 秒)、`{ state: "done" | "failed" | "stopped" }`、`{ maxCostUsd }`(花费未知即不通过)
  和 `{ maxSeconds }`(运行从开始到结束)。路径用点/方括号写法指向结果:`verdict`、
  `findings[0].file`、`["odd key"]`;`""` 表示整个结果。没写检查的用例默认 `{ "state": "done" }`;
  写了检查的用例只判这些检查,全部满足才算通过。
- **运行**:每个用例 × 适配器 × 重复都是运行目录里的一次真实运行,从当前目录启动,在 `meta.json`
  中标记 `origin: "eval"` 与 `eval: { name, case, adapter, repeat }`——`odw list` 和看板的运行摘要
  都会显示。同时最多 `concurrency` 个。每完成一次运行在 stderr 打印一行进度;Ctrl-C 会停止本次
  eval 启动的所有运行,不保存报告,并结束 `odw eval`。
- **表格**:每个用例 × 适配器一行——通过 k/n、耗时中位数、总花费与平均花费、平均 token;然后是
  总计;再列出每个失败的运行、它没通过的检查与运行 id——任意两次运行都可以用 `odw compare` 对照。
- **报告**(JSON,`version: 1`;`src/eval/report.ts` 列出每个字段)包含定义及其 sha256
  (`evalHash`)、工作流的 sha256、odw 版本、运行记录到的 CLI 版本、各单元格,以及每次运行的 id
  和失败项。报告保存在 `<runsRoot>/_evals/<name>/<id>.json`——`GET /api/evals` 列出、
  `GET /api/evals/:name/:id` 返回单份,均只读——并写到 `--out`。
- **`--baseline <report.json>`** 按用例与适配器把每个单元格与之前的报告对比:通过率、平均花费、
  耗时中位数,B − A。通过率下降的单元格即为退步。退出码:全部运行通过——或带 `--baseline` 时没有
  单元格退步——为 0;否则为 1;用法错误为 2(没有任何运行开始)。

### 可观测性:OpenTelemetry trace(ODW 扩展)

已经在用 Langfuse、Arize Phoenix、Jaeger、Grafana Tempo、Datadog 或 Honeycomb 的团队,可以在
那里查看每次运行:`odw export` 把运行记录转成遵循 GenAI 语义约定的 OpenTelemetry trace——
OTLP/HTTP + JSON 编码,不需要 SDK,没有依赖。

```bash
odw export $RUN --otlp > trace.json          # 离线:把运行导出为 OTLP/JSON(--out FILE 效果相同)
curl -H 'Content-Type: application/json' --data @trace.json "$ENDPOINT/v1/traces"
odw export $RUN --otlp --send                # 或直接发送到配置的端点
```

配置中有 `otel` 时,worker 会在每次运行结束(done、failed 或 stopped)后自己发送该运行的
trace,且只发一次:

```json
{ "otel": { "endpoint": "http://localhost:4318", "headers": {}, "captureContent": false } }
```

- **Span。** 运行对应 `invoke_workflow <name>`(`odw.run.id`、`odw.run.state`、总用量——
  从不包含 args);`phase <title>` 包住每个阶段的工作;每个 agent 一个 `invoke_agent <label>`,
  带 `gen_ai.provider.name`(`claude` → `anthropic`、`codex` → `openai`、`gemini` →
  `gcp.gemini`、`kimi` → `moonshot_ai`,其余用适配器名)、`gen_ai.request.model` /
  `gen_ai.response.model`、`gen_ai.usage.*`(含缓存 token)、`odw.agent.cost_usd`、
  `odw.agent.attempts`,失败时 `error.type` 为失败原因(`rate_limit`、`quota` 等)且状态为
  ERROR;transcript 中的每次工具调用一个 `execute_tool <name>`(`gen_ai.tool.name`、
  `gen_ai.tool.call.id`,失败时为 ERROR);每个 `exec()` 步骤一个 `exec <label>`,每次等待一个
  `checkpoint <title>`。
- **重试、回退和额度等待**是所属 agent 上的 span 事件(`odw.retry`、`odw.fallback`、
  `odw.quota_wait`):它们是一次 agent 调用中的时刻,时间取自运行记录——不用 link,因为 link
  需要运行里本不存在的独立 span。
- **ID 由运行 id 派生**(trace id 为 SHA-256(`odw/run/<runId>`) 的前 16 字节;span id 同理按
  span 的身份派生),所以重复导出同一运行得到相同 ID,按 ID 去重的后端只保留一份。被续跑的运行,
  根 span 会 link 到它续跑的运行。
- **时间**取自运行事件。Claude Code 的 stream-json 不带时间,所以它的工具调用按在 transcript
  中的位置估算,并标记 `odw.timing.estimated`;opencode 和 kilo 会报告自己的时间。
- **默认不导出内容**——提示词、回复和工具输出都可能敏感。设 `"captureContent": true`(或
  `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true`)后,trace 还会包含回复
  (`gen_ai.output.messages`)、工具参数和结果、错误文本、`exec()` 命令行和检查点 payload——
  都是 odw 已保存、已脱敏的文本,发出前无论 `redact` 如何设置都会再脱敏一次(环境变量的值
  绝不外发),每个字段截断到 4096 个字符并以 `…` 标记。提示词本身不保存,因此从不导出。
- **只有配置能开启它。** `OTEL_EXPORTER_OTLP_ENDPOINT`(或 `…_TRACES_ENDPOINT`)、
  `OTEL_EXPORTER_OTLP_HEADERS`、`OTEL_SERVICE_NAME` 和 `OTEL_RESOURCE_ATTRIBUTES` 只补全
  `otel` 没写的部分——人们会为别的工具设置它们,所以单靠它们什么都不会发送。端点默认为
  `http://localhost:4318`,并追加 `/v1/traces`。
- **绝不拖累运行:** 结果写盘之后只发一次 POST,时限 5 秒(`OTEL_EXPORTER_OTLP_TIMEOUT` 可以
  设得更短);失败只在运行的 `worker.log` 中留一行。header 的值是机密:从不写日志、从不进事件;
  `odw doctor` 只显示是否开启、端点的协议和主机,以及 header 名称。
- **JSON,而非 protobuf。** 接受 OTLP/HTTP JSON 的接收端(Jaeger、Langfuse、OpenTelemetry
  Collector)可直接接收;只接受 protobuf 或 gRPC 的(例如 Arize Phoenix)请经由 Collector,
  它的 `otlp` receiver 可以任一格式转发。

Langfuse(其 OTLP 端点使用项目密钥对的 HTTP Basic 认证):

```json
{
  "otel": {
    "endpoint": "https://cloud.langfuse.com/api/public/otel",
    "headers": {
      "Authorization": "Basic BASE64_OF_PUBLIC_KEY_COLON_SECRET_KEY",
      "x-langfuse-ingestion-version": "4"
    }
  }
}
```

本地 Jaeger(all-in-one 镜像在 4318 接收 OTLP,界面在 16686):

```bash
docker run --rm -d -p 16686:16686 -p 4318:4318 jaegertracing/all-in-one
echo '{ "otel": { "endpoint": "http://localhost:4318" } }' > odw.config.json
odw run wf.js            # 已有的运行则用:odw export $RUN --otlp --send
```

### 分享一次运行(ODW 扩展)

把一次运行给同事看、附到 issue 里,或在运行目录删掉之后留个底:`odw bundle` 把运行写成
**一个自包含、已脱敏的文件**,`odw view` 在看板上只读地展示它——不需要 odw 配置、不需要
运行目录,也不带出生成它的那台机器的任何其他东西。

```bash
odw bundle $RUN                       # → ./$RUN.odwrun
odw bundle $RUN --out run.odwrun --no-transcripts   # 不带 agent 的 transcript
odw view run.odwrun                   # 即 odw serve --open run.odwrun:在浏览器中打开这次运行
```

- **里面有什么。** 一个 JSON 对象(`"format": "odw-run-bundle"`、`"version": 1`):运行的
  meta(名字、脚本、args、source、适配器、odw 版本、工作流 sha256、时间)、status、全部事件、
  每个 agent 保存的结果、保留的 diff、agent 的 transcript 与 stderr(`--no-transcripts` 去掉)、
  结果与错误。
- **始终脱敏。** 其中的一切——包括 args——都经过运行的脱敏器:令牌形态、odw 启动 agent 所用
  环境(你自己的与各适配器的 `env`)中名字像密钥的变量的值、名字像密钥的 `NAME=value`,以及你的
  `redact.extra`——即使配置写了 `"redact": false` 也照样脱敏。有内容被替换的部分标
  `redacted: true`,整个包也一样。保留的 diff 同样脱敏,所以包里的 diff 用于阅读,不能拿去
  `odw apply`。
- **绝不包含:** 配置文件及其路径、环境变量、`notify` 与 `otel` 设置、worker 的 pid、worker 日志、
  运行的控制文件。(提示词本来就不在运行记录里,所以也不在包里。)分享之前先 `odw view` 看一遍。
- **有大小上限。** 超过 32 MiB 的包会被拒绝,并给出大小和办法——`--no-transcripts`,或用
  `--max-bytes N` 提高上限(`odw view` 也接受这个参数)。
- **打开时不信任文件里的任何内容。** 读取前先检查大小;检查格式、版本和每个字段的类型;运行 id
  必须是合法的运行 id(`[A-Za-z0-9._-]`,不能是 Claude Code 的 `cc-` id),每个 agent id 必须是
  非负整数,最多 10 000 个 agent。它被解包到一个全新的私有临时目录(权限 0700),文件名固定——
  文件里写的任何东西都不会变成路径——并在 `odw view` 退出时删除。看板只展示这一次运行,标为
  **分享的运行包**:没有其他运行、没有 Claude Code 运行、工作流、定时任务或本机设置,所有写操作
  一律拒绝(409),在 loopback 上也是如此。

看板上运行的 **分享** 按钮会复制 `odw bundle <run>`。

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
  <tr>
    <td width="50%">
      <strong>花费</strong><br />
      <img src="assets/app-screenshots/spend.png" alt="一次运行的花费小票:按阶段的 token 与花费及占比条、按适配器的分段、花费最多的 agent" />
    </td>
    <td width="50%">
      <strong>对比</strong><br />
      <img src="assets/app-screenshots/compare.png" alt="同一工作流两次运行的对比:总耗时、token、花费、完成与失败数及其变化,运行配置的差异,以及每个 agent 一行" />
    </td>
  </tr>
</table>

按 <kbd>⌘K</kbd> / <kbd>Ctrl K</kbd>(或 <kbd>/</kbd>)打开命令面板——跳转到任意运行或工作流、
切换主题或语言、复制跟踪或重跑命令。<kbd>g</kbd> 再按 <kbd>a</kbd>/<kbd>j</kbd>/<kbd>w</kbd>/<kbd>c</kbd>/<kbd>s</kbd>
切换页面,<kbd>1</kbd>–<kbd>5</kbd> 切换运行的标签页,<kbd>$</kbd> 展开花费小票,<kbd>+</kbd>/<kbd>-</kbd>/<kbd>0</kbd> 缩放图。
运行结束时看板会提示;如果在设置中开启,标签页在后台时还会发送桌面通知。

```bash
odw run adversarial-verify --args '{"question":"review src/rate-limiter.js"}'
odw logs --workflow adversarial-verify --follow
```

看板可以在非 loopback 地址上查看,但本地写操作(例如 Chat 消息和停止 ODW 自己的运行)
仍由 loopback server 保护。Claude Code 自己的运行始终严格只读。看板提供的 ODW agent
内容——transcript、结果、日志——在写下之前已对疑似密钥脱敏
(见 [ODW 所保存内容中的密钥](#odw-所保存内容中的密钥odw-扩展))。

### 远程只读访问(ODW 扩展)

在手机上看一夜的运行,又不把你的机器交给任何人:

```bash
odw serve --host 0.0.0.0 --token
# odw dashboard → http://192.168.1.20:4317/#token=Xq3…   ← 打开这个;它只打印一次
```

`--token` 不带值时,odw 生成一个 256 位的随机令牌,并把带令牌的 URL 以 `#token=…` 的形式打印
一次——这是 URL 片段,任何请求都不会携带它,所以令牌不会进入服务器或代理的日志;odw 也不会把它
写到别处。`--token VALUE`(16–256 个 `A-Z a-z 0-9 . _ ~ -` 字符)使用你给的令牌且从不打印——但它
会出现在进程列表里,所以在共享的机器上请用生成的令牌。

安全模型:

- **每个 `/api` 请求和实时流都需要令牌**,三种方式任选其一:`Authorization: Bearer <token>`
  (脚本、`curl`);请求带上 `?token=<token>`,其响应会设置一个 `HttpOnly`、`SameSite=Strict` 的
  cookie(`odw_token_<端口>`);或者带着这个 cookie。看板加载时用 URL 里的 `#token=` 换取 cookie,
  并把它从地址栏去掉。没有令牌:401;页面本身照常加载,显示一个"需要令牌"的界面供粘贴。
- **令牌按常数时间比较**(两边先各自哈希)。一个地址在一分钟内发来 10 个错误令牌后,无论它再发
  什么都回 429,直到这一分钟过去;完全不带令牌的请求不计数。
- **非 loopback 绑定上写操作一律拒绝,与令牌无关**:停止或暂停运行、回答检查点、Chat,在
  127.0.0.1 / localhost / ::1 以外的任何绑定上都是 409。令牌给的是远程*读*,从不给写。(在 loopback
  绑定上,`--token` 对写操作与读操作同样把关,原有的写保护全部照旧:严格的
  `Content-Type: application/json`、同源 `Origin`、防 DNS rebinding 的 Host 检查。)
- **这是明文 HTTP。** 令牌和看板展示的一切都以未加密的形式经过网络:请在你信任的网络中使用,
  或通过 VPN、SSH 隧道(`ssh -L 4317:localhost:4317 host` 根本不需要 `--host`),或放在 TLS
  代理后面。
- **持有令牌的人能读到的**就是看板展示的一切:所有项目的运行——ODW 的,以及在默认
  `claudeJobsScope: "all"` 下 Claude Code 的——它们的 args、结果、事件、agent 的 transcript 和
  diff(按上文脱敏),以及设置页上的路径与适配器。用 `--runs-root` 和 `"claudeJobsScope": "project"`
  缩小范围,或者改为把一次运行作为[运行包](#分享一次运行odw-扩展)分享。
- **不加 `--token` 时**,非 loopback 绑定与以前一样——只读,任何能连到该端口的人都能读——并且
  `odw serve` 会打印一条醒目的警告,建议加上 `--token`。

## 配置适配器

Codex、Claude Code、Gemini、Qwen、Kimi、Oh My Pi、Kilo Code、OpenCode、Cursor
均开箱即用:

| 适配器 | 本地 CLI | 非交互契约 |
| --- | --- | --- |
| `codex` | `codex` | `exec --json` 事件;回复取自 `--output-last-message` 文件(否则取最后一条 `agent_message`),token 取自 `turn.completed`,错误取自 `turn.failed` / `error`;自带联网搜索;strict schema 走原生(`--output-schema`) |
| `claude` | `claude` | stream-json 事件;回复、用量、花费和错误取自其 `result` 事件;放行 WebSearch/WebFetch;schema 走原生(`--json-schema`) |
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

**ODW 扩展:** JSON 输出还可以声明这次运行花了多少、CLI 自己是否报告了失败,以及它拒绝了
agent 的哪些工具调用。内置的 `claude` 适配器就是这样声明的:

```jsonc
"output": {
  "format": "jsonl",
  "eventType": "result",          // 回复所在的事件(以最后一个为准)
  "textPath": ["result"],
  "select": "last",
  "usagePath": ["usage"],         // token 计数,位于 usageEvent 事件中(默认同 eventType)
  "costPath": ["total_cost_usd"], // 美元花费,位于同一事件
  "errorPath": ["is_error"],      // true、一条消息或一个错误对象:这次运行以它失败
  "deniedPath": ["permission_denials"], // CLI 拒绝的工具调用:记在 agent 上并写入日志
  "mcpEvent": "system",           // 列出 MCP 服务器的事件(Claude Code 的 init)
  "mcpPath": ["mcp_servers"]      // 每项 { name, status }:没连上的记在 agent 上并写入日志
}
```

内置 `codex`(以下均为 ODW 扩展)读取 `codex exec --json`:回复是最后一个 `item.type` 为
`agent_message` 的 `item.completed` 事件(`match`)——除非它写入最终消息的文件
(`--output-last-message {reply_file}`)里有,文件优先:`{reply_file}` 是每次 CLI 运行在私有
临时目录里新建的路径,CLI 退出后读取,随后删除。token 取自 `turn.completed`;`turn.failed`
与 `error` 事件是它自己报告的失败(`errorEvents`:事件类型 → 消息所在路径),像其他失败一样
归类——codex 自己重试过、随后这一轮正常完成的 `error` 不算失败:

```jsonc
"codex": {
  "label": "Codex CLI",
  "command": ["codex", "--search", "exec", "--json", "--output-last-message", "{reply_file}",
              "--skip-git-repo-check", "{permission_args}", "--cd", "{workspace}", "-"],
  "stdin": "{prompt}",
  "flags": { "model": ["--model"], "schema": { "args": ["--output-schema"], "mode": "file", "strict": true } },
  "output": {
    "format": "jsonl",
    "eventType": "item.completed",
    "match": { "path": ["item", "type"], "equals": "agent_message" }, // 只有这些事件带回复
    "textPath": ["item", "text"],
    "select": "last",
    "usageEvent": "turn.completed",
    "usagePath": ["usage"],                                          // 只有 token:codex 不报花费
    "errorEvents": { "turn.failed": ["error"], "error": ["message"] }
  },
  "permissionArgs": {
    "read": ["--sandbox", "read-only"],
    "edit": ["--sandbox", "workspace-write"],
    "full": ["--sandbox", "danger-full-access"]
  }
}
```

给 `codex` 写了自己 `command` 的条目会整体替换内置适配器:要连同这个 `output` 块(以及
`--json`)一起写,否则它的 agent 不上报用量,回复也会是 codex 的文本输出。codex 的一轮结束时
若没有任何 agent 消息——回复文件为空、也没有 `agent_message` 事件——回复就是空的,agent 以
`empty_reply` 失败(`allowEmpty: true` 可接受),而不是返回一堆事件;运行日志会写明到底缺了
什么。事件里没有回复而回复文件里有时,回复照常成立,日志说明事件与声明不符。

在 `acceptEdits` 下,Claude Code 无头运行时会直接拒绝本该询问的操作——比如没在允许列表里
的 shell 命令——而回复仍可能声称成功;`deniedPath` 读的就是这些拒绝。默认情况下回复照常
成立,被拒绝的调用作为 `denied` 记在 agent 上,并写一行日志;`"permissionDenials": "fail"`
(运行级,或写在适配器条目里)让这样的 agent 以 `permission` 失败,而设了 `expect` 的
`agent()` 调用会把它们算作一项缺失。在适配器对应档位的 `permissionArgs` 里放行 agent 需要
的操作。

每个 `usageEvent` 事件的用量会累加;不同 CLI 的字段名(Anthropic、OpenAI、Codex)会被
统一归一化——见 [`src/adapters/usage.ts`](src/adapters/usage.ts)。只打印一个 JSON 文档
的 CLI 则用 `{ "format": "json", "textPath": […], "usagePath": […], "costPath": […],
"errorPath": […], "deniedPath": […] }`;路径里的整数用于索引数组(负数从末尾数)。`errorPath` 上报的失败
会像任何失败的运行一样被归类——不论退出码——所以限流会被重试,额度用尽会说明何时重置。
输出里找不到声明的文本时——CLI 的格式变了,或配置写错了——原始 stdout 就作为回复,运行
日志会说明原因;agent 不会因此失败。同时把回复写进 `{reply_file}` 的 CLI(如 `codex`)先从
文件读取;两处都为空时,回复为空,而不是一堆事件。

ODW 只把解码后的最终响应交给 workflow;JSONL 输出会边流式到达边逐行解码(只保留最新文本
和用量合计,而不是整段记录),stderr 只保留有限的尾部用于错误信息。
Windows 下的可执行文件探测遵循 `PATHEXT`,所以 `agent.cmd`、`kilo.cmd`、`omp.exe`
这类普通 shim 无需写完整路径也能识别。

配置键全部放在**顶层**——没有 `"settings"` 包装层;odw 会对未知或放错位置的键
在 stderr 上给出警告(附 did-you-mean 提示),而不是静默忽略。没设
`defaultAdapter` 时,odw 会用唯一配置的 adapter——或在全新安装下,用 PATH 上
唯一真实存在的那个 CLI;若装了多个,报错会列出它们并告诉你如何选择。

### 结构化输出(ODW 扩展)

`agent(prompt, { schema })` 返回的值要么满足它的 JSON Schema,要么调用失败。背后有两层保障:

- **没有约束会被悄悄放过。** ODW 的校验器检查 `type`(单个类型名)、`enum`、`properties`、
  `required`、`additionalProperties: false`、`items`(单个 schema)和 `minItems`;
  `description`、`title`、`format` 这类注解不构成约束。agent 启动前,ODW 会找出其他内容——
  `oneOf`、`anyOf`、`allOf`、`$ref`、`const`、`pattern`、`minimum`、`maxItems`、
  `["string", "null"]` 这样的类型联合、没有 `"type": "object"` 的对象关键字——并在运行日志里
  只说一次哪些关键字它不检查、位于何处(`"oneOf" at #/properties/status`)。调用照常运行,
  ODW 校验其余部分。设 `"schemaKeywords": "strict"` 则改为在任何东西启动前以 `AgentError`
  拒绝这类调用。拼错的关键字(`requird`,附 did-you-mean 提示)或其他格式错误的 schema 在两种
  模式下都会让调用失败。
- **会校验 schema 的 CLI 直接拿到 schema。** 内置 `claude` 通过 `--json-schema` 拿到
  schema,值取自其 `result` 事件的 `structured_output`;`codex` 拿到
  `--output-schema <file>`,该文件(run 目录下的 `agents/<agentId>.schema.json`)只在它的
  CLI 运行期间存在。ODW 依旧校验每一次回复、带反馈重试;只有不接收原生 schema 的 CLI 才会在
  提示词里看到 schema 描述(`"schemaPrompt": "always"`:所有 CLI 都附上)。

Codex 以 OpenAI 的 strict 模式发送 `--output-schema`,它只接受根为对象、且每个对象都设
`"additionalProperties": false` 并把全部属性列进 `required` 的 schema。其他 schema 仍像以前
一样放在提示词里交给 codex,运行会提示一次。

想让这类关键字真正生效,就把 agent 放到会强制执行它们的 CLI 上:它拿到完整 schema,运行日志
会说明这些关键字交给了它。`schemaKeywords` 取 `"warn"`(默认)或 `"strict"`。

自定义 CLI 在 `flags.schema` 里声明它如何接收 schema——`"inline"`(schema 的 JSON 作为下一个
参数)或 `"file"`(一个保存 schema 的文件路径),只接受 OpenAI strict schema 的 CLI 再加
`"strict": true`;若它的 JSON 输出把校验后的值与文本分开放,再声明位置:

```jsonc
"my_cli": {
  "command": ["my-cli", "--print"],
  "stdin": "{prompt}",
  "flags": { "schema": { "args": ["--schema"], "mode": "inline" } },
  "output": { "format": "json", "textPath": ["text"], "structuredPath": ["data"] }
}
```

schema 参数排在所有其他参数之后(与模型参数同处),且不做占位符展开。没有 `flags.schema`
时,schema 写进提示词,只由 ODW 检查回复。

### 权限档位(ODW 扩展)

ODW 让每个 agent 在一个**权限档位**下运行:

- **`read`**——只看,不改文件、不跑命令:用于调研与审查类的 fan-out。
- **`edit`**——默认档位,与各内置适配器一直以来的姿态完全一致。
- **`full`**——无沙箱、无审批:必须显式开启,只用于隔离的机器。

在配置里设定运行的档位(`"permissions": "read"`),或按次指定
`odw run|rerun|resume --permissions read`(不指定时 rerun 和 resume 沿用源运行的档位)。
适配器自己的 `permissions` 和 `agent()` 调用的 `permissions` 只能**降低**它——agent
实际运行在三者中最低的那一档:

```js
// 在允许编辑的运行里,审查者碰不到工作树。
const reviews = await parallel(files.map((f) => () =>
  agent(`Review ${f} for bugs; report, do not fix`, { permissions: 'read', label: f })))
```

请求高于运行所允许档位的 agent 会在启动前失败,报错同时写明两个档位
(`agent() asked for permissions "full", but the run allows only "edit" …`);在
`parallel()` 里它的位置是 `null`,与任何失败的 agent 一样。各档位的参数替换适配器命令中
`{permission_args}` 那一项。只有 CLI 官方文档确认在无头模式下成立的映射才会填上:

| 适配器 | `read` | `edit`(默认) | `full` |
| --- | --- | --- | --- |
| `claude` | `--permission-mode dontAsk --tools Read,Glob,Grep,WebSearch,WebFetch --allowedTools WebSearch WebFetch --strict-mcp-config` | `--permission-mode acceptEdits --allowedTools WebSearch WebFetch` | `--permission-mode bypassPermissions` |
| `codex` | `--sandbox read-only` | `--sandbox workspace-write` | `--sandbox danger-full-access` |
| `gemini` | `--approval-mode default` | `--approval-mode auto_edit` | `--approval-mode yolo` |
| `qwen` | 拒绝 | `--approval-mode auto-edit` | `--approval-mode yolo` |
| `kimi` | 拒绝 | print 模式本身(无参数) | 按 `edit` 运行 |
| `omp` | 拒绝 | `--approval-mode yolo` | 按 `edit` 运行 |
| `kilo`、`opencode` | 拒绝 | `--auto` | 按 `edit` 运行 |
| `cursor` | 拒绝 | `--force` | 按 `edit` 运行 |

- **`read`。** 在 `claude` 上,`dontAsk` 会拒绝一切需要询问的调用,`--tools` 只留下只读的
  内置工具——根本没有 Edit、Write 或 Bash,你设置里的 allow 规则也加不回来——外加联网
  工具;不启动任何 MCP server。`codex` 运行在只读沙箱里:能读文件,不能改,也不能运行需要
  审批的命令(`codex exec` 不向任何人询问)。`gemini` 在 `default` 模式下会在写入和 shell
  工具前询问,无头模式下这等同于拒绝。
- **拒绝。** 没有经过验证的只读模式的 CLI,agent 会在启动前失败:
  `kimi cannot run read-only (…); use an adapter that can (--adapter claude, …), or
  run with --permissions edit`。Qwen 的文档没有说明其 `default` 模式在无头下的行为,所以它
  也没有 `read`。
- **按 `edit` 运行。** 没有单独完全权限模式的 CLI 会用它的 `edit` 参数运行,每次运行对每个
  适配器只记一条日志。注意:对 `kimi`、`omp`、`kilo`、`opencode` 和 `cursor` 来说,
  `edit` 在无头模式下本来就会批准所有工具调用——把仓库交给它们之前请想清楚。
- **自己的适配器** 用同样的方式声明参数。没有 `permissionArgs` 的适配器按配置的命令原样
  运行,视为 `edit`;在其他档位下,运行会记一条日志,说明 ODW 无法强制执行。

```jsonc
{
  "permissions": "read", // 运行的档位;odw run --permissions 可覆盖
  "adapters": {
    // 给某个内置适配器封顶:不写 "command" 的条目只改它写出的字段
    "codex": { "permissions": "read" },
    "my_wrapper": {
      "command": ["my-agent", "{permission_args}", "--cwd", "{workspace}"],
      "permissionArgs": { "read": ["--read-only"], "edit": [], "full": ["--yolo"] } // "edit" 必填
    }
  }
}
```

每次启动都会打印每个已安装适配器实际运行的档位——
`permissions: read — claude read, codex read, kimi refused (no read mode)`——出现在实时
视图里、`--wait` 的第一行之后,以及 detached 运行的 run id 之后。每个 `agent_started`
事件(以及 `odw agents --json`)都带有该 agent 的 `permissions`,`odw doctor` 会列出每个
适配器支持的档位。档位只约束 agent 能做什么:`exec()` 命令属于 workflow 自身,不受影响。
`read` 也不是运行不受信任代码的沙箱——比如 Claude Code 在 `-p` 下仍会执行仓库自带的 hooks;
这样的仓库请以[不受信任](#不受信任的仓库odw-扩展)方式运行。

**Codex 与需要审批的 MCP 工具**([#23](https://github.com/xz1220/open-dynamic-workflows/issues/23))。
没有哪个档位能让 `codex exec` 批准 MCP 工具调用。它不向任何人询问,所以需要审批的工具
调用——比如一次 Figma 写入——会被取消(`user cancelled MCP tool call`);`full` 解除了
沙箱(`--sandbox danger-full-access`),但文档没有说它会批准 MCP 调用
([openai/codex#24135](https://github.com/openai/codex/issues/24135))。请改在 Codex 自己
的配置里预先批准那一个工具([Codex MCP 文档](https://developers.openai.com/codex/mcp)):

```toml
# ~/.codex/config.toml
[mcp_servers.figma.tools.use_figma]
approval_mode = "approve"
```

或者,仅在隔离的机器上,把 codex 的 `full` 换成跳过一切审批和沙箱的参数,再用
`--permissions full` 运行(`permissionArgs` 会整体替换内置的那份,所以其他档位要一并写出):

```jsonc
"adapters": {
  "codex": {
    "permissionArgs": {
      "read": ["--sandbox", "read-only"],
      "edit": ["--sandbox", "workspace-write"],
      "full": ["--dangerously-bypass-approvals-and-sandbox"]
    }
  }
}
```

在 `claude` 上,`full`(`bypassPermissions`)执行工具调用时不会询问。

**agent 能看到你的哪些环境变量。** 默认情况下,agent CLI 继承 ODW 的全部环境变量。
`"agentEnv": "minimal"` 只传递 CLI 启动所需的变量(`PATH`、`HOME`、`USER`、`LOGNAME`、
`SHELL`、`LANG`、`LC_*`、`TERM`、`TMPDIR`、`TZ`,以及 Windows 的系统变量)、内置 CLI 文档
中列出的认证与配置变量(`ANTHROPIC_*`、`CLAUDE_*`、`OPENAI_*`、`CODEX_*`、`GEMINI_*`、
`GOOGLE_*`、`DASHSCOPE_*`、`QWEN_*`、`MOONSHOT_*`、`KIMI_*`、`CURSOR_*`、`OPENCODE_*`、
代理变量和 `NODE_EXTRA_CA_CERTS`)、适配器的 `env`、`ODW_*`,以及你在 `agentEnvPass`
里列出的名字或 `*` 通配——这样 shell 里的云凭据或仓库令牌就不会传给每一个 agent:

```jsonc
{ "agentEnv": "minimal", "agentEnvPass": ["AWS_*"] } // 例如在 Bedrock 上用 Claude Code
```

如果某个 CLI 在 `minimal` 下无法登录,把它需要的变量加进 `agentEnvPass`
(`odw doctor --smoke` 会发一次真实调用来检验)。`exec()` 命令、`worktreeSetup` 和
`notify` 钩子仍拿到完整的环境变量。

### 不受信任的仓库(ODW 扩展)

在别人的仓库上运行 agent 是危险的:仓库里的 CLAUDE.md 或 AGENTS.md 会左右 agent,它的
hooks、MCP 服务器和项目设置会在 agent 里运行。对这样的仓库以**不受信任**方式运行——
`odw run|rerun|resume --untrusted`,或在你的配置里写 `"trust": "untrusted"`(默认是
`"trusted"`;不受信任运行的 rerun 和 resume 仍不受信任)。这时每个 CLI 都以它自己文档
给出的"忽略仓库"方式运行,参数加在档位参数之后;没有这种方式的 CLI,运行会为每个适配器
说一次——绝不悄悄降级:

| 适配器 | 不受信任时 | 仍会传给 agent 的 |
| --- | --- | --- |
| `claude` | `--safe-mode`(关闭 CLAUDE.md、skills、插件、hooks、MCP 服务器、命令、agents、workflows;认证照常) | 无 |
| `qwen` | `--safe-mode`(关闭上下文文件、hooks、扩展、skills、MCP 服务器) | 无 |
| `omp` | `--no-extensions --no-skills --no-rules` | AGENTS.md、CLAUDE.md、hooks、MCP 配置 |
| `codex` | 没有文档化的方式 | AGENTS.md(它的 `.codex/` 配置、hooks 和 rules 只对你信任过的项目加载) |
| `gemini` | 没有文档化的方式(它的不受信任文件夹模式在无头下直接退出) | GEMINI.md、`.gemini/settings.json` |
| `kimi` | 没有文档化的方式 | AGENTS.md、skills |
| `kilo`、`opencode` | 没有文档化的方式 | AGENTS.md、项目配置、`.kilo/` / `.opencode/` |
| `cursor` | 没有文档化的方式 | `.cursor/rules`、AGENTS.md、CLAUDE.md、`mcp.json`、hooks |

Claude Code 的 `--bare` 跳过的更多,但它只接受 API key 认证,订阅登录用不了。第一次有
agent 在 codex 上运行时,运行日志里会出现
`codex has no documented way to ignore the repository's AGENTS.md — its instructions
still reach the agent` 这样的一行。

ODW 自己会执行的、属于仓库的代码会被拒绝:仓库 `.worktreeinclude` 里的 `symlink:` 行
不做任何链接(链接等于把源码树交给 agent;普通行照常复制);仓库内配置(例如它的
`./odw.config.json`)设置的 `worktreeSetup` 不会运行,日志里会说明。你自己的配置
(`--config`、`$ODW_CONFIG`,或仓库之外的 `~/.config/odw/config.json`)里的
`worktreeSetup` 照常运行。如果所用配置是仓库自己的,不受信任运行还会说一次:它的适配器
和其他设置仍然生效;它也无法放宽你在 `~/.config/odw/config.json` 里设置的
`"trust": "untrusted"`。

```jsonc
{
  "trust": "untrusted",
  "adapters": {
    "codex": { "trust": "untrusted" },  // 或者:只让这个适配器在每次运行中都不受信任
    "my_wrapper": {
      "command": ["my-agent", "{permission_args}", "--cwd", "{workspace}"],
      "permissionArgs": { "edit": [] },
      "untrustedArgs": ["--no-project-config"],           // 加在档位参数之后
      "untrustedNote": "my-agent still reads .my-agent/rules" // 每次不受信任运行说一次
    }
  }
}
```

启动横幅里有一行信任信息——`trust: untrusted — claude --safe-mode, codex no documented
way`——`odw doctor` 会显示配置的信任级别,以及每个适配器不受信任时如何运行。不受信任
agent 的 `agent_started` 事件、保存的结果和 `odw agents --json` 行都带有
`trust: "untrusted"`,看板的详情抽屉会显示它,运行的 `run_started` setup 也记录 `trust`。
不受信任不是沙箱:它只在 CLI 允许的地方挡住仓库的指令和配置,agent 能做什么仍由权限
档位决定。

### ODW 所保存内容中的密钥(ODW 扩展)

agent 读到什么就会打印什么——包括 `cat .env`——而 ODW 会保存这些输出:它的 transcript
和 stderr 结尾、它的回复(保存的结果)、运行的日志与错误、发给 webhook 的内容。看板会
提供这一切,在非 loopback 地址上也一样。所以在写下任何内容之前,ODW 会把每个疑似密钥
替换成一个说明其类型的标记:

```text
the key is «redacted:env:STRIPE_SECRET_KEY»
Authorization: Bearer «redacted:bearer»
cloning with «redacted:github»
```

- **`env`** —— ODW 启动 agent 和 `exec()` 命令时所用环境(它自己的,以及每个适配器的
  `env`)中,名字看起来像密钥的变量(`*_KEY`、`*_API_KEY`、`*TOKEN`、`*SECRET*`、
  `*PASSWORD*`、`*_PWD`、`*_PAT`、`AUTHORIZATION`、`AWS_ACCESS_KEY_ID` 和
  `*CONNECTION_STRING` 等云凭据、webhook URL)的值,无论出现在哪里(8 个字符及以上,
  精确匹配),记为 `«redacted:env:NAME»`;以及任何打印出来的、`NAME` 看起来像密钥的
  `NAME=value` 中的值(`.env` 文件、`env` 输出)。
- **`patterns`** —— 常见令牌形态:Anthropic(`sk-ant-…`)、OpenAI(`sk-…`、
  `sk-proj-…`)、GitHub(`ghp_…`、`gho_…`、`ghs_…`、`github_pat_…`)、Slack(`xoxb-…`
  及同类)、AWS access key id、Google API key、JWT、PEM 私钥块和 `Bearer` 令牌——记为
  `«redacted:anthropic»`、`«redacted:openai»`……
- **`extra`** —— 你自己的正则表达式(JavaScript 写法),记为 `«redacted:extra»`。

```jsonc
// 默认值,再加一条自己的规则:
{ "redact": { "env": true, "patterns": true, "extra": ["corp-[0-9a-f]{32}"] } }
// 一切按打印原样保存:
{ "redact": false }
```

会被脱敏的:transcript(在流式写入时进行——跨两段输出的密钥同样会被处理)和 stderr
结尾;保存的 agent 结果(`odw result --agent`、看板的 agent 抽屉);运行的事件——
`odw logs`、日志行、`agent_failed` 的错误(失败时引用的输出先脱敏再截断,所以不会留下
半个密钥)、`exec()` 步骤显示的命令行以及失败的 `check` 引用的输出;运行的错误;
`status.json` 中等待中的检查点;webhook 负载;运行的 `worker.log`——worker 自己的输出,
包括工作流用 `console.log` 打印的 agent 回复,写入时即脱敏;以及 Chat Host 的会话
(`<runsRoot>/_chat/sessions.json` 和 `/api/chat/sessions` 提供的内容):Codex 的回复完整
脱敏,你输入的内容——以及作为消息贴回的运行结果——只脱敏令牌形态,因为那是你的数据;仍在
流式输出的回复在结束前只保留完整的行,开启脱敏前保存的会话文件在读取时脱敏。运行的 `args`
也是你的数据,可能带着令牌:`/api/runs/:id` 和看板提供的 args 会脱敏令牌形态
(`argsRedacted: true`),`/api/schedules` 提供的定时任务 args 也一样——但 `meta.json` 和
定时任务本身按原样保存,所以 `odw rerun` 和 `odw resume` 用原始 args 启动新运行。被脱敏过的
内容会以 `redacted: true` 标明——保存的结果、事件、transcript 行及其在 API 中的条目、
`result.json`、`error.json`、webhook 负载、聊天消息——`odw doctor` 会说明脱敏是否开启、覆盖了哪些变量。脱敏随
输出到达而进行,不会囤积输出:一行等到行尾,一个私钥等到它的最后一行。

不会被脱敏的:
- **agent 拿到的内容。** 提示词和 agent 的环境变量从不改动,`agent()` 和 `exec()` 交回
  给工作流的内容也不改:脱敏只针对写下来的东西。
- **运行的结果** 是工作流自己的数据——它可能有意返回读到的配置——所以 `result.json`
  只应用 `patterns` 和 `extra`,从不应用 `env`。
- **保存的 diff**(`agents/<id>.diff`)是 agent 对你代码的改动:也就是 `odw apply` 要应用、
  保留分支要提交的内容,标记会损坏你的文件。agent 写进代码里的密钥,应在审阅时发现
  (`odw diff`、看板的 Changes 标签页)。
- **`meta.json` 里保存的运行 `args`**(以及定时任务的):`odw rerun` 和 `odw resume`
  必须从你传入的原样开始,只有对外提供的内容会脱敏。Chat Host 交给 Codex 的内容也不脱敏:
  一个回合所回答的消息按你输入的原样交给它(更早的消息按保存的样子)。
- **恢复的运行** 会按保存时的样子(已脱敏)重放 agent 的结果,并在日志中说明。

脱敏是安全网,不是保险库:形态未知、变量名又不像密钥的秘密会按原样保存。用
`agentEnv: "minimal"` 可以让 agent 从一开始就看不到它不需要的东西。

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
启用)、`codex`(`exec --json` 每条命令、每次编辑、每条消息都输出一个事件)、`kilo` 和
`opencode` 这类 JSONL 适配器,或会打印心跳的包装脚本;并把值设得高于
健康 agent 最长的静默时段——工具调用里跑一轮很长的测试,同样不会有任何输出。

### 限流、额度与登录

**ODW 扩展。** 每个失败的 agent 都会根据其 CLI 的退出状态和输出末尾被归类:`rate_limit`、
`quota`、`auth`、`timeout`、`stalled`、`not_found`(CLI 无法启动)、`permission`(工具
调用或审批被拒)或 `exit`——另有三个类别,给"成功了"却拿不出证据的运行:`empty_reply`、
`unmet_expectation`,以及 `"mcpFailures": "fail"` 下的 `mcp_unavailable`(见[检查 agent 的工作](#检查-agent-的工作odw-扩展))。这个类别就是 `agent_failed` 事件上的 `reason`(CLI 说明了何时
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
  实际上的限流来处理。配置了[回退链](#按阶段路由与回退链odw-扩展)时,agent 会换到下一个
  CLI;同一适配器连续三次额度失败后,本次运行之后的 agent 会跳过它。开启
  [`quotaWait`](#额度用尽时暂停odw-扩展) 后,没有 CLI 可换的 agent 会等额度重置,而不是失败。

Claude Code 会在输出里报告这类错误,而且常常以 0 退出:它的 stream-json `result` 事件
带着 `is_error: true` 和错误消息(`API Error: Rate limit reached`、
`Claude AI usage limit reached|…`),这会被算作消息所指的那种失败。Codex 的 `turn.failed`
与 `error` 事件同样如此(`Quota exceeded. Check your plan and billing details.`、
`exceeded retry limit, last status: 429 Too Many Requests`)——它自己重试过、随后这一轮
正常完成的 `error` 除外。在文本模式下(文本
适配器,或回退到原始 stdout 的 JSON 输出),一条简短、内容只有这类限流、额度或登录错误
的回复同样会被算作对应的失败——绝不会被当成 agent 的答案。空回复算作 `empty_reply` 失败,
不重试。声称成功、但 `permission_denials` 列出了被无头模式拒绝的工具调用的 `result` 照常
成立,这些调用被记录并写入日志——只有在 `"permissionDenials": "fail"` 下,或调用设了
`expect` 时,才算作 `permission` 失败并列出它们。

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

### 额度用尽时暂停(ODW 扩展)

**ODW 扩展。** 一个长时间运行的 workflow,如果所有可用的 CLI 都用完了额度,剩下的 agent
都会失败——有额度熔断时还失败得很快。通宵跑的时候,你更希望它等到额度重置再接着跑。
`quotaWait` 就是做这个的:

```jsonc
{
  "quotaWait": { "max": 21600 } // 最多等 6 小时让用尽的额度重置;false(默认)则如上直接失败
}
```

当一个 agent 因额度用尽而无 CLI 可用——链上最后一个适配器额度失败,或额度熔断跳过了每一个
——且某个 CLI 说明了额度何时重置("try again in 3h 22m"、"resets 7pm"、Claude Code 的
`usage limit reached|<epoch>`)、距今不超过 `max` 秒时,运行会**暂停**而不是让它失败:

- 这个 agent 等待时不占任何槽位,所以还有额度的 CLI 上的 agent 照常运行。在 CLI 报出的
  重置时间之前,运行会跳过那个 CLI:有回退链的 agent 换下一个,无处可去的 agent 也一起
  等——而且是在启动之前等,所以等待期间既不显示为 agent,也不占槽位。
- 运行显示为 `paused` 并写明在等什么:`odw status`、`odw list` 和实时视图显示
  `paused until 19:10 (codex quota)`,`odw run --wait` 会提示一次;`status.json` 与
  `GET /api/runs[/:id]` 带有 `pausedFor: { "reason": "quota", "adapter", "resumeAt" }`
  (`resumeAt` 为 Unix 秒)。
- 到了重置时间——再加最多 30 秒随机抖动,免得等待的 agent 在同一秒全部回来——每个 agent
  都从它的链首重新开始,额度熔断也会忘掉这个 CLI。`odw resume <run>` 立即继续;
  `odw stop` 照常停止运行。期间可以同时有 `checkpoint()` 在等待。
- 没有给出重置时间的额度失败,或重置时间超过 `max` 的,仍按上文直接失败,运行日志会说明
  原因(`quotaWait: not waiting — codex did not say when its quota resets, so the agent fails`)。
- 暂停从不触发运行结束的 hook;在 [`notify.on`](#运行通知) 里加上 `"paused"`,即可在
  每次暂停时收到通知。

```text
quota pause: codex is out of usage quota until 19:10 (in 3h 22m) — its agents wait, holding no slot, and go on then (quotaWait); odw resume goes on now
search:3 waits for codex's quota to reset (quotaWait)
quota pause over: codex's quota reset — its agents go on
search:3 goes on after the quota wait, on codex
```

默认关闭,因为一个悄无声息地等上几个小时的运行,会让没有主动要求的人感到意外。等待发生在
worker 进程里:worker 死掉时,运行会变成 `stale`,`odw resume` 会像对待任何已结束的运行
一样重放它——已完成的 agent 直接取回结果,不会再跑一遍。

### 按阶段路由与回退链(ODW 扩展)

**ODW 扩展。** 按阶段混用 CLI 和模型——搜索扇出用便宜的模型,综合用强的——并在某个 CLI
额度用尽时让运行换到另一个 CLI 上继续。

**阶段默认值。** `meta.phases` 的条目可以为该阶段的 agent 指定适配器和模型:
`{ title, adapter?, model? }`(纯字符串条目仍然只是标题)。`phase(title, { adapter, model })`
为其后的 agent 设置它们,取代该阶段在 meta 里的条目;只写 `phase(title)` 则保留该阶段已有
的设置。`agent()` 调用自己给出的选项永远优先;调用自带的 `phase` 选项会带上那个阶段的默认值。

```js
export const meta = {
  name: 'research',
  description: 'Search cheaply, synthesize carefully.',
  phases: [
    { title: 'Search', adapter: 'codex', model: '@fast' },
    { title: 'Synthesize', adapter: ['claude', 'codex'], model: '@strong' },
  ],
}
phase('Search')
const notes = await parallel(angles.map((a) => () => agent(`Research ${a}; cite sources.`)))
phase('Synthesize')
return await agent(`Synthesize:\n${notes.filter(Boolean).join('\n---\n')}`)
```

**模型分层。** 配置里的 `models` 定义若干层级,每层为每个适配器给出一个模型 ID。
`model: "@fast"`——写在 `agent()`、`phase()` 或 `meta.phases` 里——让 agent 使用其适配器
在该层级下的模型;回退之后用下一个适配器的。某层级没给该适配器模型时,使用其 CLI 的默认模型
(记一条日志);未知层级会让该 agent 以 `AgentError` 失败,并列出已有的层级。不带 `@` 的
模型就是模型 ID,原样传给每个适配器——所以有回退链时请用层级。

**回退链。** 配置里的 `fallback` 为每个适配器按顺序列出之后要尝试的适配器;
`agent(prompt, { adapter: ["codex", "claude"] })` 为单次调用指定回退链,取代该设置。当
agent 的 CLI 额度用尽或登录被拒时,它会在下一个适配器上重新运行——全新的提示词、相同的
选项——而不是失败(限流仍然在原适配器上扛过去)。每次切换都会记日志,agent 会在新适配器
上取得一个槽位(先释放旧适配器的),它的 transcript 在一行
`{"kind":"attempt","reason":"fallback","adapter":"claude"}` 之后继续,失败的那些运行花掉的
用量照样计入:

```text
search:3 → claude after codex quota
```

- 回退时沿用 agent 自己的权限档位:不能恰好运行该档位的适配器会被跳过并记一条日志——
  绝不换成别的档位运行。
- 调用的 `expect` 检查随它一起走:下一个适配器的工作按同样的方式检查,也在那里重试;没达到
  检查的工作绝不会回退(见[检查 agent 的工作](#检查-agent-的工作odw-扩展))。
- `agent_finished` 记录产出结果的适配器,并用 `fellBackFrom` 记录 agent 离开过的那些;保存
  的结果也一样。`odw status`、实时视图(`codex → claude`)和 `/api/runs/:id` 都会显示。
- **额度熔断。** 同一个适配器上连续 `quotaBreaker`(默认 3)次额度失败后,本次运行之后的
  agent 都会跳过它:各自从回退链上的下一个适配器开始,没有回退链的则立即失败。只记一条
  警告,`odw status` 也会列出它。

```jsonc
{
  "fallback": { "codex": ["claude"], "claude": ["codex"] },
  "quotaBreaker": 3, // 默认值;0 或 null 表示从不跳过适配器
  "models": {
    "fast": { "claude": "haiku", "codex": "gpt-5-mini" },
    "strong": { "claude": "opus", "codex": "gpt-5" }
  }
}
```

`odw resume` 像重放其他调用一样重放发生过回退的调用,不会再走一遍回退链。一次调用的 resume
key 是它写下的提示词和选项:阶段默认值和运行的默认适配器一样不在其中,所以把某个阶段改到
别处——比如离开额度用尽的 CLI——仍会重放所有已完成的调用。

### 按适配器限制并发与错开扇出

**ODW 扩展。** `concurrency` 限制一次运行同时有多少个 agent;适配器自己的 `concurrency`
限制其中最多有多少个跑在这个 CLI 上——于是 16 个 codex 调用的扇出每次只跑 4 个,运行
剩下的槽位留给其他适配器。一个 agent 需要一个运行槽位和一个该适配器的槽位,两者同时
发放:它绝不会占着一个去等另一个;每个适配器的 agent 先到先得地排队,空出的运行槽位
交给最早到达、且其适配器还有余量的 agent,因此一个被限住的适配器不会挡住其他适配器。
`odw doctor` 会列出这些上限,`odw run` 也会在启动横幅里、权限那一行下面写明
(`concurrency: 8 agents at once · per adapter: codex 4`)。

```jsonc
{
  "concurrency": 8,
  "adaptiveConcurrency": true, // 默认值;false 让所有上限保持不变
  "staggerFanOut": { "first": 1, "delayMs": 2500 }, // 默认值;false 关闭
  "adapters": {
    "my_wrapper": {
      "command": ["my-agent", "--cwd", "{workspace}", "--prompt-file", "{prompt_file}"],
      "concurrency": 4 // 在运行的 8 个之内,同时最多 4 个
    }
  }
}
```

给内置适配器设上限时,只写要改的字段即可——`"codex": { "concurrency": 4 }` 会保留 codex
原有的命令和参数(不写 `command` 的条目是在内置适配器上做调整;写了 `command` 才会整个替换)。

**自适应降速。** 某个适配器撞上限流时——有 agent 即将退避等待,或有 agent 以
`rate_limit` 失败——它的上限在本次运行余下的时间里减半,最低为 1(没有自己上限的适配器
从运行级上限开始算);此后每过一分钟没有再被限流,就还回一个槽位。同一批扇出一起撞上
限流时,上限只减一次,而不是每个 agent 减一次。已经在跑的 agent 保留它们的槽位——被限流
的 agent 原地等待退避——所以降低后的上限约束的是接下来启动的 agent。减半,以及让上限完全
恢复的那一个槽位,都会记日志:

```text
adaptive concurrency: codex hit a rate limit — at most 4 of its agents at once now (was 8); one slot comes back for each minute without another
adaptive concurrency: no rate limit on codex for 4m — back to 8 of its agents at once
```

**为提示缓存错开扇出。** 内置 `claude` 适配器背后的 Anthropic API 会缓存提示的前缀:第一个
发送它的请求写入缓存,之后的请求只需很小一部分费用即可读取——但前提是第一个请求已经被读完。
所有 agent 同时启动的扇出,每个 agent 都要为完整前缀付费。因此在一次 `parallel()` 或
`pipeline()` 调用中,运行在声明了 `"promptCache": true` 的适配器上(内置 `claude` 就是)、
且提示的前 1,024 个字符相同的 agent,每次先启动 `first` 个;其余的在第一个 agent 的 CLI
产生输出后启动——对 `claude` 这样的 JSONL 适配器而言,是它越过 CLI 启动时那些 `system`
事件之后的第一个事件——或在 `delayMs` 之后启动,以先到者为准。把共享的说明
放在前面、每项不同的部分放在最后,就能从中受益。单独的 agent、提示更短或不同(或用了别的
模型、别的角色)的 agent,以及重放的 agent 从不等待;等待中的 agent 不占任何槽位,停止会
立刻结束等待。每次错开的扇出记一行日志:

```text
staggered fan-out: 15 claude agents sharing a 3412-character prompt prefix waited 2.1s while the first warmed the prompt cache, until it produced output
```

如果你自己的适配器所用的 CLI 连接的是会缓存提示的 API,就给它声明 `"promptCache": true`;
自己写了 `command` 的 `claude` 条目也要声明,因为它会替换内置的那个(只写部分字段的条目,
例如 `"claude": { "concurrency": 4 }`,会保留内置设置)。

### 运行通知

**ODW 扩展。** `notify` 会在一次运行结束时执行一条命令和/或向一个 webhook 发送 POST,
让通宵跑的 workflow 结束后主动告诉你结果:

```jsonc
"notify": {
  "command": ["/usr/local/bin/odw-notify"],        // 参数向量,不经过 shell 执行
  "webhook": "https://hooks.slack.com/services/…", // Slack、Discord 或任何接收 JSON 的端点
  "on": ["done", "failed", "stopped"]              // 默认:所有终态;"waiting" 和 "paused" 需显式加入
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

加上 `"paused"`,就能在运行[因额度用尽而暂停](#额度用尽时暂停odw-扩展)时收到通知——每次
暂停一次,继续时不再通知:命令的环境变量带有 `ODW_RUN_STATE=paused`、`ODW_PAUSED_ADAPTER`
和 `ODW_RESUME_AT`(Unix 秒);webhook 收到 `"state": "paused"`、一个
`"pausedFor": { "reason": "quota", "adapter", "resumeAt" }` 字段,以及一行类似
`odw · nightly paused until 19:10 (codex quota) · odw resume <run> goes on now` 的 `text`。

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
odw apply $RUN --agent 3 --check   # 预览:每个文件是 clean、CONFLICT(附冲突行)还是 already applied
odw apply $RUN --agent 3           # 用 git apply --3way 应用到当前工作树
odw apply $RUN --all --check       # 预览所有已完成的 agent,每个都叠在前面的之上
odw apply $RUN --all --verify "npm test"   # 按顺序应用;校验失败的那个回滚
```

`odw apply` 在你所在的 git 工作树里用 `git apply --3way` 应用一个 agent 的 diff——加
`--all` 则按 agentId 顺序应用所有已完成 agent 的 diff:能应用的部分会被暂存。动手之前,它先在
索引的临时副本上做同样的应用,逐个文件给出 `clean`、`CONFLICT`(附上合并后会留在文件里的冲突行,
或无法合并的原因:`deleted here`、`binary`,或挡在那里、git 会直接覆盖的未跟踪/被忽略文件)或
`already applied`;`--check` 到此为止
(有冲突时退出码 1)。单个 agent 随后被应用,冲突处留下标记(退出码 1)。`--all` 把每个 agent
叠在前面的之上预览,依次应用到第一个会冲突的为止,并说明哪些应用了、哪些没有;失败的 agent 的
diff 只能用 `--agent` 单独应用。只要 diff 涉及的路径上有未提交的改动,它就拒绝执行——先提交或
stash,或者加 `--force`。看板在运行的 **Changes** 标签页里展示同样的 diff,并通过
`GET /api/runs/:id/agents/:agentId/diff` 提供。

`--verify "<cmd>"`——或配置 `applyVerify`(`--no-verify` 跳过一次)——在每次应用之后于仓库
根目录通过 shell 运行一条命令,受 `timeout` 配置约束。命令失败或超时时,这次应用会被回滚:它涉及
的路径恢复成应用前的样子,内容和索引项都分毫不差,odw 以退出码 1 结束并给出命令输出的末尾;按下
Ctrl-C 也会同样回滚。命令运行期间这些文件若被改动,改动后的版本会先另存一份,odw 会说明存在哪里。其他东西一概不碰——不 stash、不 reset——你其余的未提交改动保持原样。`--verify` 下
会冲突的改动不会被应用。

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
  "keepBranches": false,   // true:每个隔离 agent 的改动也都提交到一个分支
  "applyVerify": null      // 例如 "npm test":每次 odw apply 之后运行,失败则回滚这次应用
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
| [`fix-until-green.js`](examples/fix-until-green.js) | 同样的循环改用 `expect`:agent 回复后由 odw 跑测试,把仍然红的测试——或什么都没改的"修复"——交还给它,最后带着缺失项失败(仅 ODW) |
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

**`main` 上的新内容(2026 年 10 月)**——完整清单以及升级前需要留意的变化见
[`CHANGELOG.md`](CHANGELOG.md):
- **按阶段指定适配器,以及回退链。** 阶段可以让自己的 agent 跑在指定的 CLI 和模型上
  (`meta.phases: [{ title, adapter, model }]`、`phase(title, { … })`),`model: "@fast"`
  按 CLI 选出某层级的模型;CLI 额度用尽或登录失效的 agent 会沿回退链换到下一个 CLI
  (`adapter: ["codex", "claude"]`,或配置里的 `fallback`),而不是失败——额度熔断会让运行
  不再尝试已经用尽的 CLI(ODW 扩展;见[按阶段路由](#按阶段路由与回退链odw-扩展))。
- **额度用尽时暂停。** 配置 `"quotaWait": { "max": 21600 }` 后,CLI 额度用尽的通宵运行会
  等到 CLI 报出的重置时间——等待时不占槽位,其他 CLI 照常工作——然后继续,而不是让 agent
  失败。运行显示 `paused until 19:10 (codex quota)`;`odw resume` 立即继续,
  `notify.on: ["paused"]` 会通知你(ODW 扩展;见[额度用尽时暂停](#额度用尽时暂停odw-扩展))。
- **原生结构化输出。** `claude`(`--json-schema`)和 `codex`(`--output-schema`,限 strict
  schema)直接拿到 agent 的 schema 并自行强制执行;ODW 依旧校验每一次回复。ODW 校验器不检查
  的 schema 关键字会连同位置写进运行日志,绝不悄悄跳过——`"schemaKeywords": "strict"` 则拒绝
  这类调用(ODW 扩展;见[结构化输出](#结构化输出odw-扩展))。
- **有证据的成功。** `agent(…, { expect })` 检查 agent 的工作,而不是听它怎么说——某条命令
  以 0 退出、有文件改动、回复匹配——没达到就把缺失项交还给它一次,之后以
  `reason: "unmet_expectation"` 和缺失项失败。空回复以 `empty_reply` 失败;Claude Code
  拒绝的工具调用和它没能启动的 MCP 服务器会记在 agent 上并写入日志——并计入 `expect`(ODW 扩展;见
  [检查 agent 的工作](#检查-agent-的工作odw-扩展))。
- **权限档位。** 每个 agent 以 `read`、`edit`(默认,与以往一致)或 `full` 运行,映射到各
  CLI 自己的参数:审查与调研类 fan-out 碰不到工作树(`--permissions read`、
  `agent(…, { permissions: 'read' })`),完全权限必须显式开启,无法强制执行某档位的 CLI 会被
  拒绝或记录日志——绝不静默降级。`agentEnv: "minimal"` 让无关的密钥不进入 agent
  (ODW 扩展;见[权限档位](#权限档位odw-扩展))。
- **ODW 保存的内容里不留密钥。** agent 打印的任何东西——包括 `cat .env`——在写入它的
  transcript、保存的结果、运行的日志与错误或 webhook 之前都会脱敏:名字像密钥的变量的值和
  常见令牌形态都变成 `«redacted:<kind>»`(ODW 扩展;见
  [ODW 所保存内容中的密钥](#odw-所保存内容中的密钥odw-扩展))。
- **人工检查点。** `checkpoint()` 会让运行暂停,直到有人批准或拒绝——通过
  `odw approve|reject`、看板,或可选的 `waiting` 钩子——让计划在昂贵的 fan-out 之前先
  得到一个"可以"(ODW 扩展;见 [`plan-approve-execute.js`](examples/plan-approve-execute.js))。
- **扛过限流。** 每次 agent 失败都会被分类(限流、额度、登录、超时、卡死……)。被限流的
  CLI 会按退避时间重试并遵守它给出的 retry-after;额度耗尽或登录失败则立即失败并说明该
  怎么做——`odw logs`、实时视图和看板里都能看到,连同恢复时间。
- **会自我调节的限速。** 用 `"concurrency"` 给任意适配器设并发上限;撞上限流时,该适配器在本次
  运行余下时间里上限减半,之后每平静一分钟归还一个名额;共享长提示前缀的 `claude` 扇出会先启动
  一个 agent,让其余的读取它写入的提示缓存,而不是各付一份。
- **看清每个 agent 做了什么。** 每个 agent 的 CLI 输出都会保存为执行记录——工具调用、结果、
  重试——可以用 `odw logs <run> --agent <id|label>` 查看(运行中加 `--follow`),也可以在看板的
  执行记录侧栏里实时跟随。
- **无需常驻进程的定时运行。** `odw schedule add <name> <workflow> --cron "15 2 * * 1-5"`
  会写入一条 cron、launchd 或 systemd 定时项,由它回调 odw——带防重叠锁、每个定时任务各自的日志,
  `odw schedule list` 里能看到上一次运行([配方](docs/recipes/cron.md))。
- **审阅并应用隔离 agent 的改动。** worktree agent 的改动会在 worktree 删除前保存为 diff
  (排除初始化时放进去的文件),也可以用 `keep` 保留到分支。在看板的**改动**标签页或用 `odw diff`
  审阅,再用 `odw apply` 落地:动手之前它会逐个文件预览——干净、冲突(附冲突行)还是已应用——
  `--all` 按顺序应用所有 agent,加上 `--verify "npm test"` 时,把弄坏构建的那次应用回滚,
  你其余的未提交改动不受影响。
- **真实用量与花费。** 内置 `claude` 适配器改为读取 Claude Code 的 `stream-json`,内置 `codex`
  适配器改为读取 `codex exec --json`,每个 agent 都会记录 CLI 上报的 token(Claude 还有花费;
  codex agent 的 transcript 会显示它执行的命令、编辑与工具调用)——`odw status`、实时视图和看板里都能看到——`--budget` 也按真实
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
更多 CLI 上报的真实 token 用量与花费(目前 Claude Code 与 Codex 已上报,其余仍按估算)·
运行 Claude plugin 工作流 · `odw compare` 与 `odw eval` 的看板视图。完整规划见 [`docs/ROADMAP.md`](docs/ROADMAP.md);
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
有 allowlist 防 DNS rebinding,绑定到非回环地址时写操作一律拒绝(看板仍可读;加上
<code>--token</code> 后只有持有令牌的人可读)。
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
