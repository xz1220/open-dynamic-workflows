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
  workflow),支持顶层 `await` 和 `return`。迁移脚本前请核对下方的[兼容性检查表](docs/zh-CN/concepts.md#兼容性与迁移)。
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
  workflow 脚本保持纯 `.js`,并附带 `.d.ts` 类型供编辑器补全(`odw types` 把它写进项目)。

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
安装;替换失败会恢复旧文件。二进制必须与该版本发布的 `SHA256SUMS` 一致(v0.5.0 之前的版本
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

或者,**等 `odw` 发布到 npm 之后**(目前还没有——见 [开发](docs/zh-CN/guides/develop.md#开发))、且你有 Node ≥20,
`npm i -g odw` 就能把 `odw` 装到 PATH 上(skill 仍按上面第 *b* 步装)。在那之前请用上面的二进制。

> 二进制在磁盘上约 110 MB——和任何 Node→二进制 的工具一样,几乎全是内嵌的 Node 运行
> 时——但下载已 gzip 压到约 35 MB。ODW 所**驱动**的 agent(`claude`、`codex` …)仍是你
> 另行安装的独立 CLI。

## 快速开始

本文描述当前源码。使用正式安装包时,以配套 skill 和 `odw --help` 为准;
需要尚未发布的功能,可按[开发](docs/zh-CN/guides/develop.md#开发)中的步骤从源码构建。

只装了一个 CLI(只有 `claude` 或只有 `codex`)?零配置,直接往下看。装了好几个?安装器
已经让你选过默认了;`odw init` 随时可以重选(agent 则在问过你之后用
`odw init --adapter <名字>` 写入)。`odw doctor` 会检查运行环境、配置、运行目录和每个适配器;
`odw doctor --smoke` 还会给默认适配器发一条真实提示——能发现那些装得上、但在无头模式下卡在
登录或审批提示上的 CLI。`odw doctor --models`(ODW 扩展)给配置和 `.odw/workflows` 中提到的
每个「适配器/模型」组合各发一条极短的提示,告诉你哪些模型已经不在了。`odw doctor --local`
(ODW 扩展)检查本地的 Ollama 或 LM Studio:每个模型实际加载的上下文、工具调用能力,加
`--smoke` 还会查长提示的前部是否被静默截断(见[本地模型](docs/zh-CN/guides/adapters-and-models.md#本地模型检查推理服务把廉价阶段交给它odw-扩展))。
`odw doctor` 还会检查一次扇出需要机器提供什么(ODW 扩展,只读):odw 运行时的打开文件数上限
与你打算同时运行的 agent 数比较(`--fanout N`;默认取并发上限——每个 agent 约占 4 个描述符,
odw 自身另需 64 个)、运行根目录和临时目录(`isolation: "worktree"` 的检出放在这里)的剩余
空间(低于 1 GiB 时警告)以及临时目录是否为 tmpfs、PATH 上的 git(worktree 需要 2.17 及以上)。
每条警告都附带修复它的那一行命令;平台上不适用的检查(Windows 上的 `ulimit -n`)会跳过。
第一次运行之前直接敲 `odw`,以及在有运行之前的 `odw doctor`,都会打印下面这段 $0 的首跑步骤。

**第一次运行不花钱。** 从模板开始,先测试,再看它在所有 agent 都用桩回复的情况下跑一遍——然后
再真跑:

```bash
odw new                    # 列出模板:hello、review-swarm、fix-until-green、plan-approve-execute……
odw new hello              # 写入 .odw/workflows/hello.js 和起步测试 .odw/tests/hello.json
odw test hello             # 起步测试:脚本化回复,不调用模型,$0
odw run hello --dry        # 实时视图与阶段树,每个 agent 都是桩回复,$0(看板:odw serve --open)
odw run hello              # 真实运行,用你的默认 agent CLI
```

在终端里,`odw init` 最后会主动提供这一步:写入 `hello`、运行 `odw run hello --dry`,然后打印
看板命令和真实运行的命令——它自己从不发起付费调用。见[从模板开始](docs/zh-CN/tutorial.md#从模板开始odw-扩展)。

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

## 文档

文档对应 `main`；已发布的版本请看对应 tag 下的 `docs/`。按你要做的事查找（[`docs/zh-CN/`](docs/zh-CN/README.md)）：

| 你想…… | 去读 |
| --- | --- |
| 在快速开始之后继续 | [教程](docs/zh-CN/tutorial.md)——模板、编辑器补全、示例 |
| 查脚本能调用什么 | [工作流 API](docs/zh-CN/reference/workflow-api.md) · [原语参考](skills/open-dynamic-workflows/zh-CN/references/primitives.md) |
| 查命令、配置键、事件 | [CLI](docs/zh-CN/reference/cli.md) · [配置](docs/zh-CN/reference/config.md) · [事件与失败原因](docs/zh-CN/reference/events.md) |
| 运行、跟踪、恢复、对比、清理 | [运行与观测](docs/zh-CN/guides/running-and-observing.md) · [看板](docs/zh-CN/guides/dashboard.md) |
| 落地 agent 的改动 | [审阅与应用](docs/zh-CN/guides/reviewing-and-applying.md) · [多仓库运行](docs/zh-CN/guides/multi-repo.md) |
| 让人介入 | [人工检查点与 agent 的提问](docs/zh-CN/guides/checkpoints-and-questions.md) · [通知](docs/zh-CN/guides/notifications.md) |
| 不靠手动启动运行 | [定时与触发](docs/zh-CN/guides/scheduling-and-triggers.md) · [远程运行：CI 与自己的服务器](docs/zh-CN/guides/remote-runs.md) |
| 选择 CLI 与模型 | [适配器与模型](docs/zh-CN/guides/adapters-and-models.md) · [花费、上限与额度](docs/zh-CN/guides/cost-limits-and-quotas.md) |
| 给 agent 与输入划边界 | [安全与信任](docs/zh-CN/guides/safety-and-trust.md) |
| 把工作流做对 | [测试、调试与评估](docs/zh-CN/guides/testing-and-debugging.md) |
| 理解设计 | [概念](docs/zh-CN/concepts.md)——工作原理、与 Claude Code 的兼容性 |
| 照着配方做 | [`docs/recipes/`](docs/recipes/)（英文）——cron、通知、触发器、审阅与应用、恢复运行 |
| 开发 ODW 本身 | [参与开发 ODW](docs/zh-CN/guides/develop.md) |

## 状态

每个版本改了什么、升级前要检查什么,都在 [`CHANGELOG.md`](CHANGELOG.md):`Unreleased` 一节
是 `main` 上尚未发布的内容,每个已发布版本各有一节,也就是对应
[GitHub Release](https://github.com/xz1220/open-dynamic-workflows/releases) 的正文。

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
引擎不发任何网络请求。唯一的例外是你主动要求的诊断:`odw doctor --local` 读取本地推理服务的
状态,加 `--smoke` 时向它发一次探针——只限本机或局域网。
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
