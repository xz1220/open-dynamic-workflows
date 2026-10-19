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
登录或审批提示上的 CLI。`odw doctor --models`(ODW 扩展)给配置和 `.odw/workflows` 中提到的
每个「适配器/模型」组合各发一条极短的提示,告诉你哪些模型已经不在了。`odw doctor --local`
(ODW 扩展)检查本地的 Ollama 或 LM Studio:每个模型实际加载的上下文、工具调用能力,加
`--smoke` 还会查长提示的前部是否被静默截断(见[本地模型](#本地模型检查推理服务把廉价阶段交给它odw-扩展))。

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
看板命令和真实运行的命令——它自己从不发起付费调用。见[从模板开始](#从模板开始odw-扩展)。

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

### 从模板开始(ODW 扩展)

`odw new` 从内置在二进制里的模板写出一个 workflow,所以只装了二进制也有这些模板;单独运行
`odw new` 会列出它们。

```bash
odw new review-swarm                    # .odw/workflows/review-swarm.js、.odw/tests/…、.odw/evals/…
odw new review-swarm --name pre-merge   # 同上,但命名为 pre-merge(workflow、测试与 eval 里都改名)
odw new hello --force                   # 覆盖内容不同的已有文件
odw new hello --yes                     # 同时写入建议的 .worktreeinclude(见下)
```

| 模板 | 作用 |
| --- | --- |
| `hello` | 两个 agent 并行描述这个仓库;纯 JS 留下更有把握的那个回答(只读) |
| `review-swarm` | 从多个角度并行审阅改动,逐条核实每个发现,只留下站得住的 |
| `fix-until-green` | agent 修复失败的测试;odw 自己跑测试来检查(`expect`),没达到就退回 |
| `plan-approve-execute` | 起草计划,在 `checkpoint()` 等人批准,再并行执行各步骤 |
| `pr-shepherd` | 把 PR 推到全绿:修复失败的 CI 和新的审阅评论、推送,标记为可审阅前先问人 |
| `fan-out-reduce` | 并行起草 N 个回答,再综合出最好的一个 |

- **写入什么**(在当前目录):`.odw/workflows/<名字>.js`(`odw run <名字>`)、
  `.odw/tests/<名字>.json`——带脚本化回复的起步用例,`odw test <名字>` 立刻通过,$0——以及
  `review-swarm` 与 `pr-shepherd` 的 eval 骨架 `.odw/evals/<名字>.json`(真实运行:先编辑再
  `odw eval <名字>`)。除 `hello` 外,模板就是同名的[示例](examples/)。
- **从不覆盖**内容不同的已有文件,除非加 `--force`:此时什么都不写,退出码 1。已经与模板
  完全相同的文件算作已写入,所以同一条命令跑两次没有副作用。
- **在没有 `.worktreeinclude` 的 git 仓库里**,它会为[隔离 worktree](#隔离-worktree-与-agent-端口)
  打印一份建议:仓库里的 `.env*` 文件(不含 `.env.example` 之类),以及根据 lockfile 推断的
  依赖目录的 `symlink:` 行(npm、yarn、pnpm、bun 对应 `node_modules`;uv、Poetry、Pipenv、PDM
  对应 `.venv`;Composer 对应 `vendor`)。加 `--yes`,或在终端里回答 yes 才写入;否则从不写。
- **`odw init`**(不带 `--check`)最后提供零成本的首跑:在终端里先询问,然后写入 `hello`(若
  `.odw/workflows/hello.js` 已存在则直接用它),带实时视图运行 `odw run hello --dry`,再打印
  `odw serve --open` 和真实的 `odw run hello`。不在终端时只打印这些命令。
- **它也写出 `odw types` 写的东西**(见下),编辑器立刻就能补全新 workflow;`--no-types` 不写。

### 编辑器补全:`odw types`(ODW 扩展)

workflow 脚本拿到的原语是全局变量,编辑器对 `agent()` 及其选项一无所知——除非项目里有方言的
类型声明。`odw types` 从内置在二进制里的副本写出它们(只装了二进制也有):

```bash
odw types                 # .odw/types/odw.d.ts + .odw/jsconfig.json(+ .claude/workflows/jsconfig.json)
odw types --dir editor    # 声明与 jsconfig.json 改写到 editor/ 下
odw types --force         # 连不是 odw 写的 jsconfig.json 也替换
```

- **`.odw/types/odw.d.ts`**:类型声明,文件头写着写出它的 odw 版本。每个 ODW 扩展都带
  `@remarks ODW extension`,悬停即可分辨 Claude Code 方言与只有 ODW 读取的扩展。
- **`.odw/jsconfig.json`**:`include` 覆盖声明、`.odw/workflows/**/*.js` 与
  `.claude/workflows/**/*.js`。`.claude/workflows` 存在时也给它写一份 `jsconfig.json`,
  因为编辑器只用离文件最近的配置。不是 odw 写的 `jsconfig.json` 原样保留,改为打印它需要的
  `include`。
- **`checkJs` 保持关闭**:类型检查器会把方言的顶层 `return` 报成错误(TS1108)。想检查某个
  脚本,就在它首行加 `// @ts-check`。
- **升级之后**,若 `.odw/types/odw.d.ts` 与当前 odw 的声明不一致,`odw doctor` 会警告;
  `odw types` 重写它。odw 自己不编译、不做类型检查。
- **从不穿过符号链接写入**:文件本身是符号链接、从项目往下的某级目录是符号链接,或其目录解析到
  项目之外时,不写——`odw types` 会说明是哪个并以 1 退出。每个文件先写入临时文件再改名覆盖。

## 编程原语

一个 workflow = `export const meta = {…}` + 一段运行在 async 上下文里的脚本体。脚本体
用普通 JS 控制流(循环、`if`、去重)把这些**注入的全局**串起来——无需 import:

| 原语 | 作用 |
| --- | --- |
| `agent(prompt, opts?)` | 让一个 coding agent 跑一个子任务。唯一真正"产出工作"的原语。返回文本;设了 `opts.schema` 则返回校验过的对象。设了 `opts.expect` 时,它的工作会被检查——某条命令以 0 退出、有文件改动、回复匹配——没达到就带着缺失项重试;见[检查 agent 的工作](#检查-agent-的工作odw-扩展)(**ODW 扩展**)。 |
| `parallel(thunks)` | 一组任务并发执行、**等全部完成**(屏障)。可恢复失败变 `null`;停止、预算耗尽和派发上限错误会中止运行。`parallel(thunks, { notes: true })` 让其 agent 使用本次运行的笔记板——见[并行 agent 之间的笔记](#并行-agent-之间的笔记odw-扩展)(**ODW 扩展**)。 |
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
    untouched: ['test/**', '**/*.snap', '.github/**'], // 匹配这些 glob 的文件一个都不许改
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
- **受保护的路径不许碰。** agent 会钻考核它的检查的空子:为了变绿去改、跳过或删除测试。
  `untouched` 列出 glob(规则同 `files`:`*` 不跨目录,`**/*.snap` 匹配任意深度),agent
  修改、新建或删除的文件都不许匹配——读取方式同 `changes`,所以原地运行时你在调用之前的
  改动不算。碰到的路径算作一项缺失并被列出——``no file matching "test/**" may change, and
  1 did: test/add.test.js``——重试时会要求 agent 把它们恢复原样。
- **被丢下仍在运行的后台任务。** 无头模式下 agent 可以启动后台 shell 命令
  (`run_in_background`)或子 agent,随后结束回合并退出:任务随 CLI 一起终止,结果却显示成功
  ([claude-code#85129](https://github.com/anthropics/claude-code/issues/85129))。odw 跟踪
  Claude Code stream-json 的任务事件(`task_started`、`task_updated`、`task_notification`)
  和后台工具调用;到 `result` 事件时仍未结束的任务作为 `orphaned` 记在 agent 的
  `agent_finished` 事件、保存的结果、`/api/runs/:id` 和看板侧栏上,运行为每个 agent 记一行
  日志:`serve:1: Claude Code ended its turn with 1 background task still running — Bash
  (Start the dev server); it died when the CLI exited, …`。回复照常成立(默认
  `"orphanedBackground": "warn"`);`"orphanedBackground": "fail"` 让这样的 agent 以
  `reason: "orphaned_background"` 失败;设了 `expect` 时它算作一项缺失——先交还给 agent
  (要求它等所有后台命令和子 agent 结束后再回复),之后以 `orphaned_background` 失败。任何
  JSONL 适配器都可以用 `output.background` 声明自己 CLI 的后台事件(见适配器参考)。

Claude Code 的 Workflow 工具会忽略 `expect`,在那里检查不会执行。
[`examples/fix-until-green.js`](examples/fix-until-green.js) 用 `expect` 驱动一个
"修到测试通过为止"的循环。

### 并行 agent 之间的笔记(ODW 扩展)

并行的编程 agent 常常各自通过、合在一起却出错:一个把函数改了名,另一个还在调用旧名字。只要
告诉它们同时发生的改动是什么,大多数冲突就能避免——所以 odw 为每次运行提供一块**笔记板**,
默认关闭:

```js
const lanes = await parallel(tasks.map((t, i) => () =>
  agent(t, { label: `lane-${i + 1}`, isolation: 'worktree' })), { notes: true })
const review = await agent('Which lanes clash?', { notes: true, schema: CLASHES })
```

- **何时打开:** `agent(…, { notes: true })`、`parallel(thunks, { notes: true })` 启动的每个
  agent,或配置中 `"notes": true` 时运行的每个 agent。`notes: false` 让单个 agent 退出。默认
  关闭:Claude Code 工作流照原样运行。
- **发布:** 打开笔记的 agent 会得到 `ODW_NOTES`——一个属于它自己的小 shell 脚本的路径,提示词里
  会说明用法:`"$ODW_NOTES" "把 parseX 改名为 parse"` 发布一条笔记;装了 odw 的地方
  `odw note "…"` 作用相同(读取 agent 的 `ODW_RUN_ID`、`ODW_AGENT_ID` 与 `ODW_NOTES`)。笔记由谁
  发布,取决于放下它的是哪个 agent 的脚本,而不是笔记里写了什么。
- **读取:** agent 启动前已发布的笔记写在它的提示词里,标题为"Notes from the other agents in this
  run"(取放得下 8000 字符的最新几条)。新笔记不会推送给已在运行的 agent——CLI 只读一次提示词——
  但不带参数的 `"$ODW_NOTES"` 会打印笔记板的当前内容,提示词里也写明了这一点。
- **接口广播:** 打开笔记且 `isolation: "worktree"` 的 agent 带着保留的改动完成时,odw 在其
  `agent_finished` 事件之前替它发布一条笔记,让脚本之后启动的 agent 都能看到:diff 统计、改到的
  文件,以及 diff 中新增或删除的、看起来像声明的行(`export`、`def`、`func`、`pub fn`、`class`、
  `interface`——一个适用于各种语言的廉价启发式,最多 12 行)。
- **上限:** 每条笔记最多 2000 字符,并像运行事件一样脱敏;笔记板最多 200 条、256 KiB,满了运行
  会说一次。笔记保存在运行目录的 `notes.jsonl`。
- **在容器沙箱中** 脚本照常可用:agent 自己的收件箱以读写方式绑定,它的脚本和笔记板以只读方式
  绑定——容器里没有其他 agent 的收件箱可写。worker 只从「确实是它所建位置上的真实目录」的收件箱里取
  普通文件,从不跟随链接、也不会卡在 FIFO 上,所以 agent 放进去的任何东西都不能让宿主机读取或删除
  别处的文件。
- **查看:** `odw notes $RUN [--json]`、`odw logs` 中的 `note_added` 事件,以及
  `GET /api/runs/:id/notes`。

Claude Code 的 Workflow 工具会忽略这些选项。[`examples/coordinated-refactor.js`](examples/coordinated-refactor.js)
把一项改动拆成在笔记板上并行的隔离分支,由审阅者读取笔记板,再让相互冲突的分支带着全部笔记重跑。

### 工作流记忆(ODW 扩展)

每次运行都从零开始:一个人在上一次运行里做的纠正,下一次运行还会再犯。工作流记忆把一个工作流
历次运行学到的东西**存在仓库里**,即 `.odw/memory/<工作流>.jsonl`,像其他文件一样在 PR 里审阅。
默认关闭;其中没有任何内容出自模型总结,只来自明确的来源:

| 来源 | 条目 |
| --- | --- |
| `"$ODW_NOTES" --keep "…"` 或 `odw note --keep [--paths GLOB,…] "…"`(开启笔记的 agent) | `note`,记该 agent——只在该 agent 开启记忆时保留(否则只发布、不保留,并记日志) |
| 带备注被拒绝的 `checkpoint()` | `correction`:`"Ship the plan?" was rejected: <备注>` |
| 修改 payload 后批准的 `checkpoint()` | `correction`:修改的结构化 diff,如 `$.steps[1]: "b" → "c"; removed $.owner` |
| 同一 agent 的重试补上了的 `expect` 未达项 | `lesson`:缺了什么,以及被告知后的重试补上了它(附它保留的改动) |
| `odw memory add <wf> "…" [--paths GLOB,…]` | 手工添加的 `note`(或 `--kind correction\|lesson`) |

每行是 `{ id, text, kind, paths, commit, run, agent?, at }`:`commit` 是学到时的 HEAD,`paths`
是它涉及的 glob(相对仓库根目录)。每种条目都只在开启记忆时保留——配置 `"memory": true`、
对该 agent 保留的笔记与教训用 `agent(…, { memory: true })`、对检查点的纠正用 `checkpoint(…, { memory: true })`
或 `{ memory: { paths: ['src/**'] } }`。

```js
const plan = await checkpoint('Ship this plan?', { payload: draft, memory: { paths: ['src/api/**'] } })
await agent('Implement the approved plan.', { memory: true, expect: { command: 'npm test' } })
```

- **召回:** 开启记忆的 agent(`agent(…, { memory: true })` 或该设置;`memory: false` 让单个 agent
  退出)在任务之前看到仍然适用的条目,标题为 "What earlier runs of this workflow learned",最新的在前,
  至多 4 KB;每条标明种类与来源(运行与 agent,或"手工添加"),正文逐行以 `> ` 引用。运行日志说明
  召回了多少、略去了多少。
- **过期:** 条目的 `paths` 匹配的文件在其 `commit` 与 HEAD 之间有改动(`git diff --name-only
  <commit> HEAD`)即过期,不再召回。没有 paths 的条目永不过期;有 paths 但 git 不认识其提交的条目
  视为过期——没有东西能为它作证。每个文件至多检查 32 个不同的提交(最新条目的优先),其余提交上的条目
  视为过期;超过 4 MiB 的文件不读取,运行、`odw memory list` 与 API 都会说明。
- **运行结束时保存**——无论完成、失败还是被停止——并经运行的脱敏器处理。同一条目再次学到时替换旧的
  那条;每个文件至多 500 条,超出时删去最旧的并记一行日志。`odw test` 与 `--dry` 运行会召回但不保存。
- **不受信任的运行**既不召回也不保存仓库里的记忆:那个文件是仓库的内容,而不受信任的运行学到的东西
  会进入之后受信任运行的提示词。用户放在仓库之外的记忆——在自己的配置里写 `"memoryDir":
  "~/odw-memory/my-repo"`——属于用户自己,不受信任的运行也会使用:前提是它按字面路径和解析链接后
  都在仓库之外;仓库自己的配置设置的 `memoryDir` 一律不算。
- **维护:** `odw memory list [<wf>] [--stale] [--json]`、`odw memory add <wf> "内容" [--paths …]`、
  `odw memory prune [<wf>] --stale` 或 `odw memory prune <wf> --id N`(`--source DIR` 指定仓库);
  `GET /api/memory[?workflow=]` 返回同样的列表。

Claude Code 的 Workflow 工具会忽略这些选项。

### 声明范围(ODW 扩展)

两个 agent 指向同一批文件,改动直到合并时才冲突。事先声明每个 agent 打算改哪些文件,odw 就能把
它们分开——主要做法是让会相撞的 agent 先后运行:

```js
await parallel([
  () => agent('Refactor the login flow.', { label: 'refactor-login', scope: ['src/auth/**'] }),
  () => agent('Fix the token expiry bug.', { label: 'fix-auth', scope: ['src/auth/token.ts'] }),
  () => agent('Document the parser.', { label: 'docs', scope: ['docs/parser.md', 'src/parser/**/*.md'] }),
])
```

- **`scope`** 是相对 agent 工作区的一组 glob,规则同 `expect`(`*` 不跨目录、`**` 跨目录、
  `{a,b}`、`[…]`)。不设 `scope` 的调用行为不变。
- **范围重叠的调用先后运行。** 一个声明了范围的调用发出时,若更早发出、尚未结束的调用范围与它重叠,
  它就等那个调用结束——等待期间不占槽位——运行为每次等待记一行日志:`fix-auth waits for
  refactor-login: fix-auth declares src/auth/token.ts, refactor-login src/auth/**`(或 `both
  declare src/auth/**`;日志事件带 `scopeWait: { for, globs }`)。其余调用照常运行。这适用于
  任何同时在途的调用——`parallel()`、`pipeline()` 扇出,或没有 `await` 就发出的调用——而且一个调用
  只会等它之前发出的调用。上例中 `fix-auth` 在 `refactor-login` 完成后才运行,`docs` 与它们并行。
- **重叠如何判定**——只看 glob,保守判定(拿不准就算重叠,代价只是多串行):先展开 `{a,b}`;两个
  字面路径相同才重叠;字面路径与 glob,glob 匹配该路径即重叠;两个 glob,一个的字面前缀(第一个
  通配符之前的文字)以另一个的字面前缀开头即重叠。因此 `src/auth/**` 与 `src/auth/*.ts` 重叠,
  `src/auth/**` 与 `src/db/**` 不重叠,`src/*.ts` 与 `src/*.md` 重叠(通配符之后的部分不比较),
  `**` 与一切重叠。
- **越出范围的写入会被标出。** agent 回复后,它的改动——按 `expect` 的方式读取:隔离 agent 看它的
  worktree,原地 agent 看调用开始以来的改动——与其范围比较。范围之外的文件记为 `outOfScope`,
  出现在 `agent_finished`(或 `agent_failed`)事件、保存的结果、`/api/runs/:id`、`odw agents`
  (值前显示 `[outside scope: …]`;`--json` 含 `scope` 与 `outOfScope`)和看板侧栏中,并记一行
  日志:`fix-auth:2: wrote 1 file outside its scope (src/auth/token.ts) — package.json`。打开笔记时
  (见[并行 agent 之间的笔记](#并行-agent-之间的笔记odw-扩展)),笔记板上也会贴一条,让脚本之后
  启动的 agent 知道。
- **`scopePolicy`**——调用自己的,否则取 `"scopePolicy"` 设置——默认 `"warn"`:回复照常有效。
  `"fail"` 让这样的 agent 以 `reason: "out_of_scope"` 失败,不重试。设了 `expect` 时,越出范围的
  写入无论如何都算一项缺失:先交还给 agent(恢复那些文件、把改动留在范围内),之后以
  `unmet_expectation` 失败。运行的 setup 记录 `scopePolicy`,供 `odw compare` 使用。
- **原地运行时**源码树是共享的:落在同时运行的另一个已声明范围的调用之范围内的文件算那个调用的,不计入
  本调用。同时运行、未声明范围的调用所做的改动仍会计入——要精确结果请用隔离。不在 git 仓库中时
  无从读取:agent 照常运行、不做检查,运行会说明这一点。

Claude Code 的 Workflow 工具会忽略 `scope` 与 `scopePolicy`:在那里这些调用按原样一起运行。

### 一次运行涉及多个仓库(ODW 扩展)

前端、后端加共享库的改动本是一件事。给其他仓库起别名,让每个 agent 指向其中一个;它们的改动
仍属同一次运行,一起审阅、一起应用:

```bash
odw run ./wf.js --repo api=../api --repo web=../web    # 别名=路径,可多次
```

```jsonc
// odw.config.json——路径相对运行的源目录,可用 ~
{ "repos": { "api": "../api", "web": "../web" } }
```

```js
export const meta = { name: 'rename-field', description: '…', repos: ['api', 'web'] }
await parallel([
  () => agent('Rename user.login to user.handle in the API.', { repo: 'api', isolation: 'worktree', scope: ['src/**'] }),
  () => agent('Follow the rename in the UI.', { repo: 'web', isolation: 'worktree', expect: { command: 'npm test' } }),
])
const { stdout } = await exec('git log -1 --format=%h', { repo: 'api' })
```

- **只认声明过的别名,不接受路径。** `agent(p, { repo })` 与 `exec(cmd, { repo })` 只接受运行声明过的
  别名——`repos` 设置,或覆盖它的 `--repo name=path`——从不接受路径。运行没有的别名会在调用开始前让
  运行失败;`meta.repos` 列出工作流需要的别名,缺一个则在任何 agent 启动前失败。每个路径都必须是
  git 仓库(`--repo` 在运行创建前就检查)。运行会记下它有哪些仓库,status.json 以 `repos` 保存。
  `odw rerun`、`resume`、`replay` 沿用 `--repo`。
- **一切按仓库生效。** agent 的 CLI 在该仓库的顶层运行——`isolation: "worktree"` 时在它的一个
  worktree 里,diff 与其他隔离 agent 一样保留。它的 `expect`(`files`、`untouched`、`command`)、
  `scope` 与越界检查读的都是该仓库;不同仓库的 scope 互不等待。可写的原地 agent 先给该仓库打一份
  自己的保险快照(`odw restore <run> --repo api` 放回)。`exec()` 的 `cwd` 相对该仓库解析。
  `agent_started` 事件带 `repo: { name, path }`。
- **审阅与应用。** `odw diff` 标出每个 agent 的仓库(`# odw: agent 2 · fix · repo api · …`;
  `--stat` 多一列 REPO,源仓库为 `.`;`--repo <name|.>` 只看一个),`odw review` 与看板的
  「改动」页也一样,后者按仓库分组列出 agent。`odw apply --agent N` 应用到该 agent 所在的仓库;源仓库
  的 agent 仍应用到你运行 odw 的工作区(若那正是本次运行的另一个仓库则拒绝)。`odw apply --all` 先逐个
  仓库预检,只要有一个不能干净应用就什么都不写——全部通过后再按源仓库优先逐个写入;某个仓库应用
  失败(比如它的 `--verify`)时按 `odw apply` 一贯的方式回滚,之前的仓库保留,之后的不再写入。
  `--repo <name|.>` 只应用一个仓库的 agent;`--pr` 与 `--resolve` 一次只处理一个仓库。
- **不可信运行**(`--untrusted`)不采用仓库自带配置里指向仓库之外的路径:这样的别名会被丢弃并说明。
  你自己的配置(`--config`、`~/.config/odw/config.json`)与 `--repo` 可指向任何仓库。
- **这一版不做:** 一个 agent 只写一个仓库(跨仓库的改动拆成每仓库一个 agent,用
  [笔记板](#并行-agent-之间的笔记odw-扩展)保持同步);不做跨仓库的原子合并;不自动发现 submodule
  或兄弟目录;`--repo` 与 `--on ssh://` 同用会被拒绝;PR 用 `odw apply --all --pr --repo <name>`
  每仓库各开一个,暂不互相链接;`odw gc` 只查找源仓库的遗留 worktree。

Claude Code 的 Workflow 工具会忽略 `repo` 与 `meta.repos`:在那里所有 agent 都在会话所在的仓库里工作。

## 兼容性与迁移

ODW 已实现下列原语能力。依赖宿主私有运行机制的脚本,迁移前需要逐项核对：

| 功能 | ODW 的行为与迁移要求 |
| --- | --- |
| 嵌套 `workflow()` | 已实现一层嵌套,共享父任务的调度器、控制和预算。更深层的调用需要展平。 |
| 模型选择 | 在 `agent(..., {model})` 中传该 CLI 的模型 ID;适配器没有模型参数时会记录路由说明。`meta.phases` 条目里的 `model`(以及 `adapter`)是该阶段 agent 的默认值,`model: "@fast"` 按 CLI 选出某层级的模型——都是 **ODW 扩展**(见[按阶段路由](#按阶段路由与回退链odw-扩展));阶段的模型和其他模型 ID 一样,其 agent 可能跑在多个 CLI 上时请用层级。`meta.model` 仍只是元数据。 |
| `agentType` | 加载同名子 agent 定义(`.claude/agents/<name>.md` 及 Claude Code 的其他位置):正文作为人设,`model`、`tools`、`isolation`、`effort` 按 CLI 映射——tools 只会降低档位,没有生效的字段逐个记入日志(**ODW 扩展**;见[agent 定义](#agenttype-读取-agent-定义odw-扩展))。找不到定义时是一句话人设。它从不选择适配器。 |
| 工作区隔离 | 从已保存的 HEAD 创建临时工作区,不含未保存修改,结束后清理。不会自动合并,`agent()` 返回回复而非 diff;ODW 会把每个隔离 agent 的改动保存为 diff,供审阅和应用(`odw diff`、`odw apply`、`keep` 分支——均为 ODW 扩展;见[审阅并应用](#审阅并应用隔离-agent-的改动odw-扩展))。支持 `.worktreeinclude`(ODW 连未跟踪文件也复制,而不只是被 gitignore 的文件);其中的 `symlink:` 行、`worktreeSetup` 和 agent 的 `ODW_PORT` 是 ODW 扩展——见[隔离 worktree](#隔离-worktree-与-agent-端口)。 |
| 预算 | 计算输出 token:适配器上报用量时用 CLI 自己的计数(内置 `claude` 和 `codex` 会上报——见[用量与花费](#用量与花费odw-扩展)),否则按每条回复的 `ceil(字符数 / 4)` 估算。每次 CLI 运行都计入:schema 重试、限流重试,以及上报了用量的失败运行。每次派发和每次 schema 重试前都会检查;预算用尽时运行结束,仍在运行的 agent 会被停止。 |
| JSON Schema | ODW 只检查[已列出的子集](skills/open-dynamic-workflows/zh-CN/references/primitives.md#schema);`format` 是注解。其他关键字(`$ref`、`const`、`oneOf`、`maxItems` 等)照常运行:运行日志会写明关键字及其位置,自己校验 schema 的 CLI(`claude`、`codex`)会强制执行它们。设 `"schemaKeywords": "strict"` 则改为拒绝这类调用(ODW 扩展;见[结构化输出](#结构化输出odw-扩展))。请明确声明对象/数组类型并使用受支持的约束。 |
| 脚本可信性 | 只运行可信脚本:运行工作流会把正文当作普通 JavaScript 执行。加载时元数据按纯字面量解析,不会被求值;编译检查和兼容性警告都不提供沙箱隔离。触发器、插件与不可信的运行在[严格脚本上下文](#严格脚本上下文odw-扩展)中编译正文——只有原语与标准内建对象——它同样不是沙箱。 |
| 恢复 | 每个完成的 `agent()` 结果都会在完成时保存。`odw resume` 让已暂停且仍存活的 worker 原地继续;对已结束的运行(done、failed、stopped,或崩溃后的 stale)则启动一个新运行:prompt 和选项都没变的调用直接重放,其余照常执行。`rerun` 从头执行。见[恢复运行](#恢复运行odw-扩展)。 |

原语名称一致不代表运行机制完全等价。`validate(source)`、`exec(command)` 和 `checkpoint(title)`
是 ODW 扩展,迁移到未提供它们的宿主时需要去掉(`validate()` 会对 `exec()` 和 `checkpoint()`
调用给出 warning)。可恢复失败产生的 `null` 需要显式处理：接受部分结果、重试,或在要求完整
交付时报告失败。

**一致性测试套件。** [`conformance/`](conformance/) 把方言的行为写成可运行的用例:每个用例是
一份 Claude Code 方言的普通工作流脚本,配一个 `expected.json`(返回值,以及要紧的日志、phase
和 agent),由确定性的 mock agent 按表作答。`odw conformance [--json] [--case N]` 用它们检查
当前的 odw(任一用例失败即退出码 1;CI 会运行);`odw conformance --strict` 在[严格脚本上下文](#严格脚本上下文odw-扩展)中运行全部用例(CI 同样会运行)。每个用例都标明 Claude Code 的文档是否确定了
该行为(`documented`),还是没有(`unspecified`:用例记录的是 ODW 的行为)。只依赖 documented
用例所确定行为的脚本,两边都能跑。这些用例是普通工作流文件,也可以在 Claude Code 上手动运行;
[`conformance/README.md`](conformance/README.md) 说明了格式,其他运行时可以据此实现自己的
runner。

## 运行与观测

在交互式终端里,`odw run` 会附着一个**实时前台视图**——每个 agent(以及带 `$` 提示符的
`exec()` 命令步骤)的启动、转轮、结算,按 phase 逐步展示,结束时打印结果。Ctrl-C 只是断开观察(运行继续);`odw attach <id>`
可随时重新附着。

```bash
odw run wf.js [--args JSON|@file]            # 终端里前台展示;运行本体仍是独立 worker
                                             #   --adapter <name> 指定这次运行的默认 agent
                                             #   --permissions read|edit|full:agent 能做什么
                                             #   --untrusted:挡住仓库的 CLAUDE.md、hooks 等
                                             #   --untrusted-input:参数来自外部——只读、不带令牌
                                             #   --budget <tokens> 设置 budget.total
                                             #   --deadline <s>:s 秒后停止运行(见下文)
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
odw review               # 跨运行尚未处理的保留 diff,按风险从高到低,每条附理由(见下文)
odw outcomes             # 按周、工作流、适配器、模型:保留 diff 的应用/放弃/未处理、失败、返工、每个已应用改动的花费(见下文)
odw notes $RUN           # 它的 agent 在笔记板上互相告知的内容(见上文)
odw compare $OLD $RUN    # 两次运行之间变了什么:配置、耗时、花费、失败、回复(见下文)
odw estimate review      # 下一次运行的 p50/p90 耗时、花费、token 和 agent 数,依据以往运行(见下文)
odw replay $RUN --agent 3 # 把这一个 agent 作为新运行重跑,检出它当时的提交;可换 --prompt/--adapter/--model(见下文)
odw eval review          # 用例 × 适配器 × 重复次数:每个单元格的通过率、花费与耗时(见下文)
odw export $RUN --otlp   # 把运行导出为 OpenTelemetry trace(OTLP/JSON;--send 直接发送;见下文)
odw bundle $RUN          # 把运行写成一个可分享的脱敏文件:$RUN.odwrun(用 odw view FILE 查看;见下文)
odw gc                   # 运行留在磁盘上的东西:孤儿 worktree、keep 分支、旧 transcript;--yes 才删(见下文)
odw digest               # 跨运行、基于证据:需要你决定、失败、未达成的检查、待审改动、花费(见下文)
odw pause|resume|stop $RUN
odw approve|reject $RUN  # 回答运行正在等待的 checkpoint()(--note TEXT、--checkpoint N)
odw approve $RUN --edit  # ……先在 $EDITOR 里修改 payload 再批准(或 --payload JSON|@file)
odw list
```

`--fg` / `-d, --detach` / `--wait`(阻塞到结束并打印结果,stderr 仅一行 run id
提示)可显式指定模式;环境变量 `ODW_DETACH=1` 强制后台。

**`--deadline <秒数>`**(ODW 扩展)在运行开始满这么多秒后停止它——像 `odw stop` 一样优雅:
agent 被杀掉,每个已完成 agent 的保存结果都保留,每个隔离 agent 的 diff 也保留——已完成的,
以及被截止时间杀掉的 agent 到那时为止改动的部分,后者在其 `agent_failed` 事件里
标为 `partial: true`(运行详情 `GET /api/runs/:id` 里也有);`odw diff` 可查看,`odw apply` 只在你点名该 agent 时应用它(与任何失败 agent 的 diff 一样)。被人停止(`odw stop`、Ctrl-C)
时,被杀掉的 agent 的改动仍不保留。运行记为 `stopped`(状态里有 `stopReason: "deadline"`)。由 worker 执行,所以任何模式下都有效。配合 `--wait`
或 `--fg` 时,odw 随后打印已完成的部分——`{ "state": "stopped", "reason": "deadline",
"deadline", "finished": [{ agentId, label, phase, value }] }`——并**以退出码 3 退出**。退出码:
0 完成,1 失败或被人停止,3 到达截止时间被停止,124 为 `--timeout`(它只是不再*等待*,运行
继续)。在 CI 里应当用 `--deadline`:见[在 GitHub Actions 中运行](#在-github-actions-中运行odw-扩展)。

一次运行在独立的 detached worker 进程里执行,并把一切持久化到一个 run 目录——所以它能
比启动它的命令活得更久,也能从任何地方被观测。向这个 worker 发送 SIGTERM、SIGINT 或
SIGHUP,效果与 `odw stop` 相同:它的 agent 连同其启动的所有进程都会被杀掉、worktree 被
清理,运行记为 stopped;第二个信号,或运行在 10 秒内没能结束,会让 worker 立即退出。

保存好的 workflow 也可以直接按名字运行。ODW 会先找项目级、再找个人级,并同时读取自己
的目录和 Claude Code 保存 workflow 的目录: `.odw/workflows`、`.claude/workflows`、
`~/.odw/workflows`、`~/.claude/workflows`(遵循 `CLAUDE_CONFIG_DIR`)。

在 monorepo 中,与 Claude Code 一样,项目级目录是从工作目录向上直到仓库根(最近的含 `.git`
的目录;不在仓库中时只看工作目录)沿途的每个 `.odw/workflows` 与 `.claude/workflows`。同名时
最近者胜,所以包内自己的 `audit` 会遮蔽根目录的;同一层里仍是 `.odw` 先于 `.claude`。
与 git 的 `safe.directory` 一样,向上查找在不属于当前用户的父目录之下停止(Windows 上不检查),
若仓库根在它之上,会说明一次。
`odw workflows list --all` 为每一项标出它来自哪个目录(`../../.claude/workflows`)以及被哪一项遮蔽;
`odw workflows where <名字>` 打印实际运行的文件,多个目录都有这个名字时再按优先级列出完整的候选链。

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

**从 git 安装工作流并锁定版本**(ODW 扩展)。用一个 git 仓库在团队里共享工作流,不再到处复制
文件,并固定每个人运行的版本:

```bash
odw workflows add https://example.com/acme/flows.git#v1.2.0     # → .odw/workflows,写入锁文件
odw workflows add git@example.com:acme/flows.git --path flows/audit.js --name audit
odw workflows add ../flows --global                             # 本地仓库 → ~/.odw/workflows
odw workflows verify                  # 按 sha256 核对每个锁定文件;不符时退出码 1(适合 CI)
odw workflows update [audit]          # 拉取锁定 ref 的最新提交:先显示 diff,再询问
```

`add` 用 git 把 `<url>[#ref]`(分支、标签或提交 id;不写则为远端 HEAD)浅取一个提交到临时
目录里新建的裸仓库——不取标签、不取子模块、不检出任何文件、hooks 目录为空、从不提示输入,
只接受 https、ssh(`ssh://` 或 `user@host:path`)和 file URL(本地目录按其 file URL 读取)。
不执行仓库里的任何东西:文件按 git blob 读取,符号链接与子模块跳过,每个 `.js` 只编译不运行,
用来校验 `meta`。取 `--path`(一个文件,或一个目录下的 `.js`),否则取 `.odw/workflows`、
`.claude/workflows`、`workflows` 与仓库根目录中第一个有 `.js` 的;打印每个文件用到的方言外能力
(同 `odw check --capabilities`);询问确认(没有终端时用 `--yes` 接受);然后复制到
`.odw/workflows`——仓库里同处有 `.odw/tests/<name>.json`、`.odw/evals/<name>.json` 时一并复制——
`--global` 时复制到 `~/.odw/workflows`。不是它安装的同名文件不会被替换(`--force` 才会)。
每个工作流在其目录旁的锁文件 `.odw/workflows.lock.json`(`~/.odw/workflows.lock.json`)中有一项:
`{ url, ref, commit, path, sha256, installedAt, test?, eval? }`(`path` 为仓库内路径,`sha256`
为安装的文件内容)。

把锁文件与 `.odw/workflows` 一起提交。`update` 重新拉取每一项的 ref,打印变化的统一 diff,
询问后才写入(本地改过的文件不动,除非 `--force`);`verify` 计算每个锁定文件的哈希——
`odw doctor` 也做同样的检查(「Locked workflows」)。安装的工作流是**第三方**的:
`odw workflows list` 与看板的 Workspace 标出它及其来源与提交,并且除非配置写
`scriptContext: "host"`,它在[严格脚本上下文](#严格脚本上下文odw-扩展)中运行(嵌套
`workflow()` 调用它时也一样)。文件与锁文件不符时,运行的启动横幅与日志会醒目提示;
`"lockedWorkflows": "fail"` 则拒绝启动(默认 `"warn"`)。未做:签名、Hub 或搜索、自动更新、
核对 Claude Code 插件安装目录的实际提交。

**喜欢用浏览器?** `odw serve` 会对同一个 run 目录开一个零依赖的实时看板——每次运行都是一张
实时图,还有时间线、日志和结果,全部通过 SSE 推送。无需构建,不引入额外依赖,加载时不访问网络。

```bash
odw serve [--open]                      # 实时看板,默认 http://127.0.0.1:4317
odw serve --port 8080 --host 0.0.0.0 --token   # 远程只读、需要令牌(见「远程只读访问」)
odw view run.odwrun                     # 只读查看分享的运行包(见「分享一次运行」)
odw serve --public-url https://odw.example.com  # 在手机上回答检查点(见「在手机上批准」)
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
——`by` 是 `cli`、`dashboard`、`link`(签名的[批准链接](#在手机上批准odw-扩展))或 `timeout`——拒绝也是一个答复而不是错误:"不"意味着
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

### agent 的提问(ODW 扩展)

模型有时会在任务中途停下来问用户——Claude Code 的 `AskUserQuestion` 工具。无头运行时没人
能回答:工具立刻空着返回,模型接着瞎猜,或者一直挂到超时
([claude-code#50728](https://github.com/anthropics/claude-code/issues/50728))。odw 从 CLI
的输出流里识别这个调用,**在提问处立即停下 CLI**——agent 绝不会拿着空答案继续——然后按
`questions` 的设置处理:

- `"checkpoint"`(默认)把问题变成一个检查点:与 `checkpoint()` 共用 `odw status`、看板卡片
  (每个选项是一个可点击填入答案的标签)、`notify` 的 `"waiting"` hook 和一次性审批链接。用
  `odw approve <run> --checkpoint N --note "<答案>"` 回答(或批准时把编辑后的 payload 的
  `answer` 填上);同一个 agent() 调用会重新派发——隔离 agent 复用原来的 worktree——提示词末尾
  附上"Earlier in this task you stopped to ask the user: … The user answered: …"。重派会记
  一行日志(`retry.reason: "question"`)并计入预算。`odw reject` 表示拒绝回答:agent 以
  `reason: "needs_input"` 失败。同一调用回答过 3 次后再问,也会失败。
- `"fail"`:agent 立即以 `reason: "needs_input"` 失败;它问了什么会列在 `agent_failed`
  事件、`/api/runs/:id`、看板侧栏和 `odw status` 里。
- `"deny"`:CLI 运行时不带提问工具(适配器的 `questionArgs`:`claude --disallowedTools
  AskUserQuestion`),并告诉 agent 自行假设、在回复里说明假设了什么。仍然提问的以 `needs_input` 失败。

可以在运行级(配置里的 `"questions"`)、适配器级或单个调用上设置:
`agent(prompt, { questions: "fail" })`。只认 CLI 自己的工具调用——以问号结尾的回复不算提问——
也不续接 CLI 会话:调用带着答案重新运行。任何 JSONL 适配器都可以用 `output.questions` 声明自己
CLI 的提问事件(见适配器参考);内置 `claude` 已声明。

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
  usage: 1.4M tokens in (1.2M cache read, 96k cache write) · ~50k out · $2.867 (estimated in part: 1 of 9 agents reported no output tokens)
  spend by phase (share of tokens):
    01  Scan    6 agents  1.1M  $2.100  78%  ███████████████▋
    02  Verify  2 agents  296k  $0.767  21%  ████▎
    03  Report  1 agent   10k~       —  <1%  ▏
    not every agent reported dollars, so shares are of tokens
    ~ partly estimated: a CLI that reports no count is measured as characters / 4
```

- `odw status` 按阶段拆分花费 —— 即看板花费清单(spend receipt)的文本版:按工作流声明的
  顺序每个阶段一行(尚未开始的会注明),最后是不属于任何阶段的 agent;每行给出 agent 数、
  token、花费、占比,以及一条 Unicode 方块组成的占比条(没有 UTF-8 locale 时用 `#`)。
  当每个有花费的 agent 都报了美元时,占比按美元计算,否则按 token。整块不超过 100 列,
  在 `NO_COLOR` 下或输出到管道时为纯文本。
- 当列出的运行中有任何一个报了美元时,`odw list` 会多出一列花费(没有花费的运行显示 `—`)。
- 实时视图的汇总行显示输出 token(也就是 `--budget` 所计的数)和累计花费;每个已结束
  agent 的那一行显示它自己的花费。
- `GET /api/runs` 和 `GET /api/runs/:id` 以 `usage` 给出运行的合计(有 agent 的输出
  token 是估算时带 `estimated: true`),`/api/runs/:id` 还给出每个 agent 自己的用量。
- `budget.spent()` 用同样的方式计算输出 token:CLI 给了计数就用它的计数。
- 单次 `parallel()` 或 `pipeline()` 调用扇出的任务或条目超过 `fanOutWarn`(默认 25;
  `0` 或 `null` 关闭)时,会记一条带数量的警告——
  `large fan-out: parallel() starts 40 tasks (over fanOutWarn: 25) — …`——然后照常运行。

适配器在自己的 `output` 里声明 CLI 在哪里上报用量;见[配置适配器](#配置适配器)。

### 运行前先知道花费(ODW 扩展)

运行会边跑边告诉你花了多少;`odw estimate` 在开跑之前就告诉你大概会花多少——依据同一
工作流以往运行的实际花费,绝不凭空猜测:

```text
$ odw estimate review-swarm --args '{"dir":"src"}'
estimate for review-swarm (5 runs, matched by source)
                  agents  time p50 / p90  cost p50 / p90   out tokens p50 / p90
  total           9–11    6:20 / 7:00     $2.620 / $3.400  43k / 54k
  phase Plan      1       50.0s / 1:00    $0.140 / $0.160  2.1k / 2.1k
  phase Review    7–9     3:13 / 3:47     $2.380 / $3.150  38k / 49k
  phase Report    1       36.0s / 42.0s   $0.090 / $0.090  3.0k / 3.0k
  adapter claude  9–11    5:36 / 5:42     $2.620 / $3.400  43k / 54k
  · based on the last 5 finished runs of this exact source
  · it assumes similar args: fan-outs as wide as in those runs (agents per phase)
  · none of those runs had these args
```

- 它读取该工作流最近 20 次已完成(`done`)的运行——不含 resume 出来的运行,它们重放的
  agent 不花钱——有完全相同源码(`meta.sourceHash`)的运行时只用这些,否则用同名工作流
  的运行,并说明是哪一种。一次都没有时输出 `no estimate: no finished runs of this workflow yet`。
- 对整次运行、每个阶段、每个适配器:墙钟时间、花费、token 和启动的 agent 数的中位数和
  第 90 百分位。扇出宽度按那些运行里的实际宽度计;带 `--args` 时会说明其中多少次参数相同。
- `odw estimate <wf> --json` 给脚本用;`GET /api/estimate?workflow=<名称>` 提供同样的数据
  (`&sourceHash=<sha256>`;不给时按最新一次运行的源码匹配)。
- `odw run <wf> --estimate` 先打印估算,在终端上再问 `start the run? [y/N]`;`--yes` 不问
  直接开跑。没有终端又没给 `--yes` 时不会开跑。

**运行中。** 在宽度不小于 `fanOutWarn`、或受成本闸门约束的 `parallel()` / `pipeline()` 之前,
运行会记一条预测:宽度 × 以往运行中同一阶段 agent 花费的中位数(单个 `agent()` 则取同一标签
前缀的 agent),并附 p90——`cost forecast: parallel() of 40 tasks in phase "Review" ~$12.40
(p90 $18.00) — …`。`pipeline()` 按每个条目每个阶段一个 agent 计。

**`costGate`。** 配置里写 `"costGate": { "usd": 5 }`——或 `parallel(thunks, { costGate: { usd: 5 } })`,
或对单个 agent 用 `agent(prompt, { costGate: { usd: 1 } })`——预测超过闸门的扇出会先变成一个
checkpoint:

```js
try {
  await parallel(files.map((f) => () => agent(`Review ${f}`, { label: `review-${f}` })))
} catch (e) {
  if (e.name !== 'CostGateRejected') throw e
  log('review skipped: ' + e.message)   // 对方拒绝了;运行继续
}
```

这个 checkpoint——`This fan-out is forecast to cost ~$12.40 (p90 $18.00) — go?`,payload 为
`{ width, forecast }`——和其他 checkpoint 一样作答:`odw approve|reject`、仪表盘,或
[手机批准链接](#在手机上批准odw-扩展)。拒绝会抛出脚本可以捕获的 `CostGateRejected`。在某个
`parallel()` 上写 `costGate: null` 可为这次调用取消该设置。没有历史时闸门放行所有扇出,并在
每次运行中只记一次。`costGate` 记录在运行的 setup 里,供 `odw compare` 使用。

### 校验输入,清点 null(ODW 扩展)

两类小错误会让工作流「成功地什么都没做」:`args` 形状不对(数组被当成一串 JSON 字符串传进来,
扇出按字符展开),以及大半为 `null` 的扇出被当作成功继续往下走。

**`meta.input`** 用 JSON Schema 声明 `args` 的形状——与 `agent()` 的 schema 用同一个校验子集
(`type`、`enum`、`properties`、`required`、`additionalProperties: false`、`items`、`minItems`;
`description` 与 `default` 只用于展示,不会被应用)。其他关键字在加载工作流时就会被拒绝,所以声明了
的约束不会悄悄不被检查。Claude Code 会忽略 `meta.input`。

```js
export const meta = {
  name: 'triage',
  description: 'Triage the open issues of some repositories',
  input: {
    type: 'object',
    properties: { repos: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'owner/name' } },
    required: ['repos'],
  },
}
```

`odw run`、`rerun`、`resume`、定时任务(`odw schedule add` 时也会检查)和触发器(返回 `422`)都在
运行创建之前校验 `args`,并逐个指出出错的路径——`$.repos: expected array, got string — it looks
encoded twice: …`(看起来被多编码了一次)。odw 不会替你自动解码。`odw run triage --help` 打印工作流
接受的参数。嵌套的 `workflow()` 调用不做校验。

**扇出健康度。** 每个结束的 `parallel()` 与 `pipeline()` 都会写一条 `fanout_done` 事件——多少个
槽位成功、失败(按失败原因计:`rate_limit`、`timeout` 等)或为 `null`——`odw logs`、实时视图和
仪表盘(运行头部的一个标签,有扇出大半为 null 时显示为琥珀色)都会显示。超过一半为 null 时运行会记
一行日志。`parallel(thunks, { minOk })` 把它变成错误:一个数量、thunk 数的一个比例(`0.8`)或
`"all"`——成功数不足时调用抛出带计数的 `FanOutShortfall`,而不是带着 null 返回。不写 `minOk` 时
行为不变:失败的槽位为 `null`,与 Claude Code 一致。

`odw check` 针对同样的错误增加两条提示(从不让检查失败):对 `parallel()`/`pipeline()` 结果
`.filter(Boolean)` 之后没有检查长度的;按 agent 写下的内容筛选出的列表(按它的某个字段 `.filter()`)
之后没有检查是否为空的——agent 的文本一个都没匹配上时,后续步骤什么都没做,运行看上去却像通过了。

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

### 晨报:`odw digest`(ODW 扩展)

一晚上跑了定时任务、触发器和长任务之后,`odw digest` 把它们汇成一份报告——只用运行记录下来的
证据,绝不复述 agent 对自己工作的说法(不转述任何回复、结果或模型写的总结):

```bash
odw digest                         # 最近 24 小时
odw digest --since 12h             # 90m、12h、2d、1w(最多 156w)
odw digest --since-last            # 从上一份已发送(--notify)的晨报算起
odw digest --workflow nightly      # 只看一个 workflow 的运行
odw digest --json | --markdown     # 给脚本用,或直接粘贴
odw digest --since-last --notify   # 经 notify 钩子发送(notify.on 里要有 "digest")
```

分组,每组附上处理它的命令:

- **需要你决定**——此刻在等待的每个检查点(以及 [agent 的提问](#agent-的提问odw-扩展)),
  不受时间窗限制,附 `odw approve|reject … --checkpoint N`;`--notify` 发送时若有
  `odw serve --public-url` 在运行,每条还带签名的一次性批准/拒绝链接。
- **失败**——失败的运行,以及 worker 已经不在的运行(stale):记录的错误、有几个 agent 没完成、
  原因分布(`timeout 1, exit 2`),以及 `odw resume <run>`。
- **完成,但检查未达成**——已完成的运行中,有 agent 没通过 [`expect`](#检查-agent-的工作odw-扩展)
  检查、改动了[声明范围](#声明范围odw-扩展)之外的文件,或在运行继续的情况下失败了。
- **完成,有待审改动**——隔离 agent 保留了 diff 的已完成运行:文件与行数,以及预览用的
  `odw apply <run> --all --check`。
- **花费**——时间窗内的美元与 token 合计,以及最贵的一次运行。

运行的最后一次写入落在时间窗内即算在内;`--dry` 运行不计。`--notify` 让
[`notify`](#运行通知) 钩子触发一次——一天的运行是一条消息,而不是一个运行一条——并且只有在每个
钩子都成功时才移动 `--since-last` 的标记(`<runsRoot>/_digest/marks.json`,按 `--workflow`
分开);不带 `--notify` 只看不会移动它。每个工作日早上发送:

```jsonc
{
  "notify": { "webhook": "https://hooks.example.com/YOUR/PATH", "on": ["digest"] },
  "digest": { "cron": "0 8 * * 1-5" }
}
```

```bash
odw schedule add morning --digest     # 每次触发:odw digest --since-last --notify(时间取 digest.cron,或 --cron)
```

钩子不会发送晨报的配置会被 `add --digest` 拒绝;`--workflow W` 只汇总一个 workflow。配方:
[`docs/recipes/notify.md`](docs/recipes/notify.md#a-morning-digest)。

### 由 webhook 启动运行:GitHub、Linear、Slack(ODW 扩展)

从工作所在的地方启动运行,并在那里回复。在配置里写一个触发器,`odw serve` 就会响应
`POST /api/triggers/<名字>`:签名校验通过的 webhook 启动该触发器的工作流,参数取自
webhook 的正文,并返回 `202 { "runId" }`。

```jsonc
"triggers": {
  "gh-triage": {
    "workflow": "triage",                          // 受管工作流名或绝对路径
    "verify": "github",                            // github | linear | slack | hmac-sha256
    "secretEnv": "GITHUB_WEBHOOK_SECRET",          // 或 "secret"(至少 16 个字符)
    "args": { "issue": "$.issue.number", "body": "$.issue.body" },  // JSONPath:$.a.b、$['k']、$.a[0]
    "events": ["issues.labeled"],                  // 可选:事件过滤
    "dedupe": "$.issue.number",                    // 可选:每个 issue 同时只有一个运行
    "concurrency": 2,                              // 可选:同时进行的运行上限
    "rateLimit": { "max": 30, "windowSec": 3600 }  // 默认值
    // 默认 "untrusted": true;"source":运行的工作目录
    // "permissions": "edit" 让它的 agent 可以编辑;"approve": false 跳过第一个可写 agent 的询问
  }
}
```

- **按各家文档验签:** GitHub `X-Hub-Signature-256`,Linear `Linear-Signature`(且
  `webhookTimestamp` 在一分钟内),Slack `X-Slack-Signature` 加五分钟内的
  `X-Slack-Request-Timestamp`,其他来源用 ODW 自己的 `X-ODW-Signature`(对
  `<时间戳>.<正文>` 签名)。都是对原始正文的 HMAC-SHA256、常数时间比较;见过的投递
  (重放或重试)不会再启动运行。GitHub 不签时间戳:它的投递的签名与 `X-GitHub-Delivery` id
  保存在运行根目录下 30 天,重启后依然有效(更早的投递会再次通过校验——密钥可能泄露时请轮换)。
- **只认你自己的配置:** `odw serve` 只从你自己的配置读取触发器——`--config`、`$ODW_CONFIG`,
  或仓库之外的 `~/.config/odw/config.json`。仓库自带的 `./odw.config.json` 不能声明触发器:
  其中的 `triggers` 会被拒绝并给出警告(克隆下来的仓库不能借 webhook 进入你的机器),改为
  提供你自己配置里的触发器。
- **默认不受信任:** issue 文本谁都能写,所以这些运行默认 `--untrusted`,并带有
  [不可信输入](#不可信输入odw-扩展)——agent 只读、不带令牌、可写之前先过检查点——除非触发器写明
  `"untrusted": false`。
- **范围很窄:** 只有你配置里的触发器存在,每个只能启动它自己的工作流。未知的名字、尚未设置的
  密钥、错误/缺失/过期的签名一律返回相同的 `401`(按地址限速;`odw serve` 会在日志里写明原因),
  没有密钥的调用方无从得知有哪些触发器;正文超过 1 MiB `413`,超出 `concurrency` 或
  `rateLimit` `429`。这个路由在非回环绑定(`--host`)上也会响应——签名就是凭据,无需
  `--token`——在回环绑定上则只接受回环 `Host` 与 `--public-url` 的主机(隧道的 URL 填在那里);
  DNS 重绑定防护与看板其他部分一样有效。
- **原路回复:** 运行会记录 `context`——触发器、事件、issue 的 id 与 URL、仓库、Slack 频道与
  线程——[`notify`](#运行通知) 钩子都会收到,于是钩子可以在 issue 下评论、在线程里回复,
  或用 `odw apply --pr` 开草稿 PR 并贴上链接。

各平台的设置与这三个钩子:[`docs/recipes/triggers.md`](docs/recipes/triggers.md)。

### 在 GitHub Actions 中运行(ODW 扩展)

一个组合 action 在 CI 中运行工作流,并在 job 超时**之前**把它停下,输出因此得以保留:

```yaml
- uses: xz1220/open-dynamic-workflows/action@v0.7.0
  with:
    workflow: .odw/workflows/review.js
    timeout-minutes: 30        # 与 job 的 timeout-minutes 相同
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

它安装固定版本的 odw(对照该 release 的 `SHA256SUMS` 校验 SHA-256——校验的是完整性而非真实性;
没有 `SHA256SUMS` 的 release 一律拒绝),以 job 超时前留出余量的 `--deadline` 运行
`odw run --wait`(`args` 输入经文件传入,从不作为命令行参数),把花费小票、agent 表和失败写入
job summary,把 `odw bundle` 上传为 artifact,`apply-pr: true` 时开草稿 PR。来自 fork 的 PR、
所有 `pull_request_target`、fork 触发的 `workflow_run`,以及 issue、评论事件以 `--untrusted` 运行。输入、密钥与示例:[`docs/github-action.md`](docs/github-action.md)。

### 在自己的服务器上运行(ODW 扩展)

笔记本一合上,运行就停了。改在你自己的机器上启动——走普通的 SSH,两端都没有 daemon:

```bash
odw run review --on ssh://me@box:2222            # 同步项目,在那边以后台方式启动,打印运行 id
odw run wf.js --on ssh://box/srv/work/app --sync rsync --args @in.json --adapter codex
odw status $RUN --on ssh://box                   # 同一条命令,由那边的 odw 执行
odw logs $RUN --on ssh://box --follow            # ……odw attach $RUN --on ssh://box 显示实时视图
odw approve $RUN --on ssh://box                  # 在那边回答它的检查点(reject、pause、stop、resume 同理)
odw pull $RUN --from ssh://box                   # 拷回本机:odw status、diff、apply、compare、看板都能用
```

`--on ssh://[user@]host[:port][/path]` 先检查远端有没有 odw(`odw --version`,否则
`npx --no-install odw`),没有就告诉你怎么装。然后把项目拷到远端工作目录——默认
`~/odw-remote/<仓库名>`,URL 带路径时用它(`ssh://box/~/work/app` 相对家目录,
`ssh://box/srv/app` 是绝对路径):

- `--sync git`(默认):HEAD 的 `git bundle`,外加一个包含所有未提交改动的补丁——已暂存、
  未暂存和未跟踪的文件,.gitignore 忽略的不带——用临时 index 生成,你的 index 不受影响。
  运行时会说明带了哪个提交、多少个未提交的文件。
- `--sync rsync`:用 `rsync`(两端都需要)镜像整个目录,.gitignore 忽略的文件不带。

工作目录归 odw 所有:每次同步都会替换上一次留下的内容(那边被忽略的文件,比如远端的
`node_modules`,保留),不是 odw 建的目录会被拒绝,绝不覆盖。项目之外的工作流(个人或插件
的)会一并发过去。然后在那边执行 `odw run … --detach`,打印远端运行 id 和后续可用的命令。
`--adapter`、`--permissions`、`--untrusted`、`--sandbox`、`--sandbox-image`、`--budget`
会一并传过去;`--config`、`--runs-root`、`--wait`、`--fg`、`--timeout` 会被拒绝(用
`odw attach --on` 观看)。

**远端使用它自己的 odw 配置和 agent CLI 登录。** 你的 `~/.config/odw/config.json` 和各
CLI 的登录都不会被拷过去:在那边安装 odw、登录 agent CLI,需要时在那边放一份配置(项目里的
`odw.config.json` 和其他文件一样随项目同步)。不会把任何密钥放到命令行上——`--args` 作为
文件经 ssh 的 stdin 传过去——ssh 用的是你自己的,带着你的 `~/.ssh/config`、密钥和 agent;
`ODW_SSH` 可以替换 `ssh` 可执行文件(`ODW_RSYNC` 替换 `rsync`)。

`odw status|logs|attach|approve|reject|pause|stop|resume <run> --on ssh://host` 在远端 odw
上执行这条命令,原样传回输出和退出码(终端里的 attach、`logs --follow` 和 `approve --edit`
用 `ssh -t`,所以 attach 就是实时视图;`--payload @file` 指的是那边的文件)。
`odw pull <run> --from ssh://host` 把运行目录拷进本地的运行根目录——本机有 rsync 就用
rsync,否则走 ssh 上的 tar——并在 `meta.json` 中标记 `origin: "remote"` 和
`remote: { url, host, dir, pulledAt }`。拷贝先放在 runs 根目录下的暂存目录里,完整之后才移到
位,所以拉取失败什么也不会留下(之前的拷贝保持原样);符号链接、设备文件和 fifo 一律不带回来
(rsync 加 `--no-links`,拷贝里若有也会被删除并列出)。还在跑的运行可以反复拉取:拷贝是一个
快照(远端 worker 的 pid 被去掉,所以在本机结束前显示为 stale),`odw status` 会说明它来自哪里。

**拉回来的运行要在它运行的地方回答。** 在本机批准、拒绝、暂停、停止或恢复这份拷贝只会改动拷贝,
所以 `odw approve|reject|pause|stop|resume` 和看板(409)会拒绝,并给出应当执行的命令:
`odw approve <run> --on ssh://host`。

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
  JSONL 适配器的事件按 CLI 打印的原样每行一个(内置 `claude` 的 stream-json、`codex` 的 `exec --json`、`kilo`、
  `opencode` 和 `agy`),其他适配器的输出写成 `{"kind":"text","text":…}` 行。stderr 的结尾(最后
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

### 在终端、tmux 和 IDE 里看运行(ODW 扩展)

看板是一种看法;终端、tmux 窗口和 IDE 面板是另外几种——ODW 自己的运行如此,
**Claude Code 自己的工作流运行**(`cc-…` id,即其 Workflow 工具启动的运行;看板的 Jobs 列表里也有)也一样:

```bash
odw status cc-wf_0da91623-31d                         # 状态与 agent:label、阶段、状态、Claude 的 agent id
odw logs cc-wf_0da91623-31d --follow                  # 事件实时打印,直到运行结束
odw logs cc-wf_0da91623-31d --agent find:engine-store --follow   # 某个 agent 的 transcript(按 label 或 id)
odw attach cc-wf_0da91623-31d                         # 等同 logs --follow,外加一行抬头
odw tmux $RUN                                         # 一个 tmux 窗口:运行概览,外加每个运行中 agent 一个窗格
```

- Claude Code 的运行从 `~/.claude/projects` 下它自己的存储读取(遵循 `CLAUDE_CONFIG_DIR`),覆盖所有项目,
  **只读**:停止或回答它仍在 Claude Code 里完成。其 agent 的 `agent-<id>.jsonl` transcript 渲染方式与 ODW
  agent 相同(`▸` 工具调用、`✓/✗` 结果、正文、thinking);`--raw` 按原样打印各行。Claude Code 可能清理它的
  transcript——运行消失时会明确说明。
- `odw tmux <run> [--layout tiled|even-horizontal|even-vertical|main-horizontal|main-vertical] [--max-panes 6]`
  在当前 tmux 会话里开一个窗口。第一个窗格是概览:打印运行的事件,并在每个 agent 开始时为它开一个窗格
  (`odw logs <run> --agent <id> --follow`),最多 `--max-panes` 个;超出的只在概览里列出跟随它的命令。
  agent 结束后窗格保留(tmux 的 `remain-on-exit`),最后几行之下标明它如何结束。ODW 与 `cc-` 运行都支持。
- 不在 tmux 里时,打印能做到同样效果的 `tmux new-session …` 命令;没装 tmux 时,打印可以手动运行的
  `odw attach` 与 `odw logs --agent … --follow` 命令。只驱动 tmux,不支持其他终端复用器。

**在 VS Code、JetBrains 或 Antigravity 里。** 运行 `odw serve`,然后在 IDE 自带的浏览器面板中打开
`http://127.0.0.1:4317/#/compact`——VS Code:命令面板里的 *Simple Browser: Show*;JetBrains:
*Tools → Web Browsers*(或任意内置浏览器视图)。紧凑布局去掉侧栏:一个运行列表,显示每个运行的实时状态
(运行中的在前,Claude Code 的运行标 `CC`),点开某个运行后顶部有一条细栏可以返回列表。页面 URL 上的
`?compact=1`,或任意路由后的 `?compact`(`#/job/<id>?compact`)同样开启;之后导航时保持开启,
点 *完整看板*(`?compact=0`)关闭。

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
`"recordVersions": false` 关闭探测。`odw eval`(见下文)和漂移监测都建立在这些记录之上。

### 漂移监测(ODW 扩展)

模型被下线或被重新指向、CLI 一夜之间自动升级,工作流却依然"通过"——跑在一个它从未调过的
东西上。因此每次运行都会与**同一工作流上一次结束的运行**比较——运行根目录中同一分桶里最新
的、已结束(done、failed 或 stopped)、不是 dry run、且源码哈希相同或名字相同的那一次:各适配器
CLI 的版本(`cli_version` 事件),以及每个 agent label 在其适配器上请求的模型(`"@tier"` 按
各自运行的 `models` 解析)。每处不同在本次运行记录到时记一次日志:

```text
drift: claude CLI 2.1.302 → 2.1.330 since the last run of review-swarm (20261017-091500-3fa2c1)
drift: reviewer asks claude for model opus-4 → opus-5 since the last run of review-swarm (20261017-091500-3fa2c1)
drift: review-swarm has an eval — check it still passes against its last report: odw eval review-swarm --baseline ~/.odw/runs/_evals/review-swarm/20261017-093000-77e0.json
```

只比较两次运行都记录了的内容:其中一次没用过的适配器或 label、版本未知的 CLI 都不算漂移。
这些变化就是运行摘要的 `drift` 字段——`{ since, changes: [{ kind: "cli" | "model", adapter,
label?, from, to }] }`——见 `GET /api/runs` 与 `/api/runs/:id`;每条日志
也以 `drift` 字段带着该变化。

工作流有 eval 文件(`.odw/evals/<name>.json`)时,第一处漂移会建议拿最新保存的报告作基线
运行它。配置 `"driftEval": true` 后,运行结束时(被停止的除外)会自己启动:`odw eval <name>
--baseline <报告>`,脱离运行在运行的源码目录中,输出写入运行目录的 `drift-eval.log`。由 `odw
eval` 启动的运行不会再启动 eval。dry run 和 `odw test` 的运行不做监测。不提供 `odw schedule
add … --on-cli-change`:定时运行本身就会记录漂移,`driftEval` 会去检验——再加一个轮询 CLI
版本的调度只是多一个守护进程,收益很小。

### 实际服务 agent 的模型(ODW 扩展)

`agent(prompt, { model: "opus" })` 只是一个请求。组织的 `availableModels` 白名单、套餐、已下线的
模型 id 或 CLI 自己的设置都可能让 agent 跑在另一个模型上,而回复里不会提
([claude-code#102655](https://github.com/anthropics/claude-code/issues/102655)、
[#73597](https://github.com/anthropics/claude-code/issues/73597))。只要 CLI 自己的事件写明了
实际服务的模型,odw 就把它记在请求旁边:内置 `claude` 读取 stream-json 的 init 事件
(`model`)、每条 assistant 消息的 `message.model`(Claude Code 自己生成的 `<synthetic>` 除外)
和 result 的 `modelUsage` 键。这些模型作为 `servedModel` 记在 agent 的 `agent_finished` 事件和
保存的结果上,也出现在 `odw agents --json`、`/api/runs/:id`(agent 的 `model` 与
`servedModel`)和看板侧栏("实际模型")里,`odw logs` 也会显示。

它们都不是 CLI 被要求使用的模型时——先解析 `"@tier"`;大小写、`[1m]` 后缀和供应商前缀
(`anthropic/…`、`us.anthropic.…`)不计,别名或较短的 id 完整出现在实际 id 中、其后只跟版本号、日期或 `latest`/`preview` 时算一致
(`opus` ~ `claude-opus-5-5`,但 `gpt-5` ≁ `gpt-5-mini`;`best` 即 opus,`default` 与任何模型一致)——运行写入
`model_substituted` 事件(`{ agentId, label, adapter, requested, served, policy, message }`),
并以一行日志显示:

```text
review:1: asked claude for model 'opus' but it was served by claude-sonnet-4-5 — its reply is kept; modelMismatch: "fail" fails such an agent
```

回复照常成立(默认 `"modelMismatch": "warn"`);`"modelMismatch": "fail"` 让这样的 agent 以
`reason: "model_substituted"` 失败(不重试,不回退)。请求的模型之外顺带用到的辅助模型
(Claude Code 用 haiku 总结 WebFetch)不算替换。看板侧栏标出"已替换",`odw agents` 在值前加
`[served by …, asked …]`,`odw compare` 并排列出 `modelsServed` 并标出该 agent,`odw estimate`
增加按实际模型(第一个报告的模型)分组的 `models`,不同模型的花费不再混在一起。不报告模型的
CLI——codex、agy,以及任何没有 `output.servedModel` 规则的适配器——显示"未报告":不做任何
推断,更不从回复文本里猜。任何 JSONL 适配器都可以用 `output.servedModel` 声明自己 CLI 的模型
事件(见适配器参考)。

### 调试工作流(ODW 扩展)

工作流里某一步不对时,有三件工具可用——都不需要改工作流,也不需要为整次运行再付一次钱:

```bash
odw check wf.js                           # 能否加载?错误带行号、列号和代码片段
odw check wf.js --capabilities            # ……以及它用到的方言之外的名字:process、require、import( 等
odw run wf.js --help                      # 按 meta.input 打印它接受的 --args
odw replay $RUN --agent judge             # 把这一个 agent 作为一次小的新运行重跑
odw replay $RUN --agent judge --prompt @better.txt --adapter codex --model gpt-5
odw compare $RUN $REPLAY --agent judge    # 原 agent 与重跑并排对照
odw run wf.js --break Review              # 在阶段 "Review"(或该 label 的 agent)之前停下等决定
odw run wf.js --step                      # ……在每个阶段之前
```

**`odw check <script.js|名字> [--json]`** 按运行时的方式编译工作流——`meta` 按纯字面量解析,
检查 name、description 与 phases,编译脚本体但绝不执行——打印 `文件:行:列: error: …`,附上前后
几行源码和指向出错列的 `^`,然后是 `validate()` 给出的可移植性警告。能加载退出 0,否则退出 1。
解析错误照编译器的原话说,只在合适时附提示:只有类型注解、`interface` 或 `as` 出错时才提
TypeScript(不再对每个错误都这样说),非 `async` 回调里的 `await`,以及脚本在括号闭合前就结束了。
运行失败时的报错与 `validate()` 的错误里也带同样的位置。`--capabilities` 另外列出(只读源码、绝不执行)
脚本用到的 Claude Code 方言之外的标识符——`process`、`require`、`import(`、`globalThis`、`Function(`、
`eval`、`fetch`、`console`、定时器等——各带首次出现的行列号以及[严格脚本上下文](#严格脚本上下文odw-扩展)
里有没有它,还有它调用的 ODW 扩展原语(`validate`、`exec`、`checkpoint`、`workflow.input`);`--json` 中为
`capabilities: { outOfDialect, extensions }`。它的提示——没检查是否为空的扇出 `.filter(Boolean)` 或按
agent 文本筛选的结果(见[校验输入,清点 null](#校验输入清点-nullodw-扩展))——打印为
`文件:行:列: hint: …`,`--json` 中为 `hints`;它们从不改变退出码。

警告中还包括 ODW 没有、但 **Claude Code 有的限制**:源码字面量即可判定超过 4,096 项的
`parallel()` 或 `pipeline()`(数组字面量、`Array.from({ length: n })`、`Array(n)`、`[...Array(n)]`,
可经 `.map`/`.fill`/`.keys`),Claude Code 的运行时会报错拒绝——`parallel() on line 12 is given
5,000 items …`;以及不是纯字面量的 `meta`,Claude Code 会把它从补全中去掉(ODW 直接拒绝)。
它们只是警告:ODW 照样运行任意规模的扇出,`check` 仍退出 0。

**`odw replay <run> --agent <id|label>`** 把一次保存下来的 `agent()` 调用重新派发。每次调用开始
时都会保存它的输入(`agents/<id>.call.json`:脚本给出的提示词和选项、开始时所用的适配器、请求的
模型),隔离 agent 的 `agent_started` 事件还记下它的 worktree 检出的提交(`base`)。重跑是一次只
含这一个调用的新运行(`meta.json` 中 `origin: "replay"`、`replayOf: { runId, agentId, label,
base }`;其 `args` 只有 `{ replayOf }`,提示词与选项保存在运行目录的 `call.json` 里,不对外提供),沿用原调用的 label 与 phase,在原运行的目录下、用原运行的配置、权限档位、信任级别、不可信输入与
沙箱运行(触发器启动的运行,其 replay 也在严格脚本上下文中运行)——`worktree` agent 则检出原来的 base 提交,不管现在 HEAD 在哪里,所以它看到的代码与
原 agent 相同。`--prompt @文件|文本`、`--adapter` 与 `--model` 替换原值(每项改动都会打印出来);
它接受 `odw run` 的 `--wait`/`--fg`/`-d`/`--timeout`。它打印新运行的 id,以及把重跑与原 agent
配对的 `odw compare` 命令(按 label;同一运行里还有别的 agent 用同一 label 时按 id)。本版本之前的
运行没有保存调用,无法重跑(`odw rerun` 重跑整个工作流)。

**`odw run <wf> --break <阶段|label>[,…]`**(可重复)与 **`--step`** 让运行在指定阶段之前——嵌套
工作流的阶段可写标题或 `▸ 子工作流 · 标题`——以及在带指定 `label` 的 agent 之前停下等决定;
`--step` 则在每个阶段之前。断点就是运行自己发起的[检查点](#人工检查点odw-扩展),标题为
`Break before phase Review`(或 `… agent judge`),所以 `odw approve|reject`、看板与
[手机链接](#在手机上批准odw-扩展)都能回答它。它的 payload 是到此为止的运行情况:`{ before,
phasesDone, agents: { done, failed, running }, results: [最近 20 个,回复截到 300 字符], args }`。
`phase()` 在方言里是同步的、无法等待,所以等待的是该阶段的工作:此后调用的每个 `agent()`、
`exec()`、`workflow()` 和 `checkpoint()` 都会停住直到有答复;已经在跑的 agent 继续;断点等待期间
发出的同 label 调用共用同一个断点。

- **批准**——运行继续。
- **拒绝**——运行停止,与 `odw stop` 相同,原因里写明断点与你的备注。
- **批准并修改 payload**(`--edit`、`--payload`、看板)——只采用 `args`:当运行的 `args` 是对象或
  数组且修改后仍是同类时,原地修改它,于是答复之后对 `args` 的每次读取都看到修改。脚本此前已经
  读到的值保持不变——比如开头的 `const { x } = args`,以及被断点拦住的那次调用的参数(它的提示词在
  答复之前就已拼好;其后的调用会读到修改)。这是唯一不会让正在运行的脚本措手不及的改法;其他对
  `args` 的修改会被拒绝并记一行日志,运行照原样继续。修改只在本次运行内有效:`odw rerun`/`resume`
  仍从 `meta.json` 中的 args 开始。

没有匹配到任何东西的 `--break` 名字,会在运行结束时记入日志。

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

### 测试工作流(ODW 扩展)

工作流就是代码:像测试代码一样测试它,不必每试一次都为模型付费。`odw test` 运行真实的运行时——
worker、调度器、schema 校验与重试、回退链、运行存储——并用你写好的脚本化回复应答每个 agent。
不调用任何模型;一次测试花费 $0,耗时不到一秒。

```bash
odw test                                  # 当前目录下所有 .odw/tests/*.json
odw test review-swarm                     # .odw/tests/review-swarm.json;或给路径:odw test examples/tests/review-swarm.json
odw test review-swarm --case 2 --json     # 只跑一个用例(编号或名字);报告以 JSON 输出
odw test review-swarm --keep              # 保留临时运行(odw logs <run_id> --runs-root …);或 --runs-root DIR
odw run review-swarm --record             # 一次真实运行,存为 .odw/tests/review-swarm.json 的一个用例(--record-to FILE)
odw run review-swarm --dry                # 每个 agent 都得到桩回复:阶段树与各阶段 agent 数,$0
odw new review-swarm                      # 模板连同起步测试,一开始就能通过(见上)
```

```json
{
  "workflow": "review-swarm",
  "cases": [
    { "name": "a real finding survives",
      "args": { "lenses": ["correctness", "security"] },
      "replies": [
        { "label": "map", "reply": { "summary": "adds a cache", "files": ["src/cache.ts"] } },
        { "label": "review:correctness", "reply": { "findings": [{ "title": "stale read", "severity": "high", "rationale": "…" }] } },
        { "label": "review:security", "fail": "rate_limit" },
        { "label": "verify:*", "reply": { "real": true, "reason": "confirmed" }, "schemaMiss": 1 }
      ],
      "expect": {
        "checks": [{ "path": "confirmed[0].title", "equals": "stale read" }],
        "agents": { "count": 4 },
        "logs": ["1 of 1 findings survived"]
      } }
  ]
}
```

- **文件**(`.odw/tests/<workflow>.json`;完整示例见 [`examples/tests/review-swarm.json`](examples/tests/review-swarm.json)):
  `workflow`(名字或路径,与 `odw run` 一样从运行 `odw test` 的目录解析;缺省为文件名)、`cases`
  (`name`、`args`、`replies`、`expect`,以及可选的 `default`、`checkpoints: "approve" | "reject"`
  ——自动应答每个 `checkpoint()`、`timeout` 秒数,默认 120),以及文件级的 `default`。运行前会严格校验。
- **回复**按 `label`(glob:`verify:*`)、`phase`(glob)、`prompt`(子串)或 `adapter` 匹配 agent;
  条目给出的每个匹配条件都须成立,第一个匹配的条目作答。作答方式:`reply`(字符串原样,其他值按 JSON
  ——即 schema 调用的值)、`fail`(`rate_limit`、`quota`、`auth`、`permission`、`timeout`、`stalled`、
  `not_found`、`exit`:ODW 的失败分类会像真实失败一样识别它,因此限流会重试、额度用尽会回退)、
  `empty: true`(空回复)或 `dry: true`(`--dry` 的桩)。`schemaMiss: N` 先回 N 次任何 schema 都不接受的内容
  (触发 schema 重试),`delayMs` 延迟作答(控制完成顺序),`once: true` 只回答一个 agent 后即用完
  (同一标签的多个 agent 依次取用)。
- **没有任何条目匹配的 agent 会让用例失败**——`unscripted agent \`review:tests\` (agent #6, phase Review)`
  ——除非有 `default` 条目(不带匹配条件)应答它。
- **`expect`**:`state`(默认 `"done"`,或 `"failed"`、`"stopped"`)、`error`(运行错误中的子串)、
  `checks`(沿用 `odw eval` 的检查词汇:`{ path, equals | contains | matches | exists }`、`{ command }`、
  `{ state }`、`{ maxSeconds }`、`{ maxCostUsd }`——测试花费为 $0)、`agents: { count, labels }`
  (启动了多少个;恰好这些标签,顺序不限)以及 `logs`(`log()` 输出行中的子串,按此顺序)。
- **运行**放在临时运行存储中,结束后删除(`--keep`、`--runs-root DIR` 可保留),标记为 `origin: "test"`。
  `exec()` 步骤、`isolation: "worktree"` 等运行时的其余部分照常真实执行;只有 agent CLI 被替换。
  全部通过退出码 0,有失败为 1,用法错误为 2(什么都没运行)。
- **`odw run <wf> --record [--record-to FILE]`** 把一次真实运行存为回归固定用例:运行结束后,worker 追加
  一个名为 `recorded <run_id>` 的用例——运行输入、每个 agent 的实际回复(或其失败类别)、包含最终状态、
  结果(小于 8 KB 时)与 agent 数量的 `expect`。与运行自身的记录一样经过脱敏,每个字符串截断到 4,000 字符;
  同一标签但回复不同的 agent 各得一个 `once` 条目,按启动顺序排列。之后 `odw test` 以 $0 回放它。
- **`odw run <wf> --dry`** 让每个 agent 都由桩应答:`"(dry run)"`,或对 schema 调用给出其最小合法值
  (只含必需属性、`minItems` 个元素、`enum` 的第一个值、边界允许的最小数)。它会等待运行结束,然后打印阶段树
  ——每个阶段启动了多少 agent 及其标签——并在 `meta.json` 中标记 `dry: true`(看板的运行摘要带有 `dry: true`)。
  不需要安装任何适配器。

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

### 回收磁盘:`odw gc` 与 `odw pin`(ODW 扩展)

每个隔离 agent 的 worktree 在调用结束时就会删除——但 worker 被 SIGKILL、机器断电时,清理来不及
执行。保留的分支(`keep: true`、`keepBranches`)在你删除之前一直存在,每个运行目录也一直保留 agent
的 transcript。`odw gc` 把这些连同大小一起列出来,**不加 `--yes` 什么都不删**:

```bash
odw gc                        # 默认空跑:列出会删什么、能腾出多少空间
odw gc --older-than 14d       # 超过 14 天的运行算作过期(默认取 retention.days,30)
odw gc --yes                  # 真的删除
odw gc --json                 # 同一份报告,给脚本用
odw pin $RUN                  # odw gc 跳过这个运行,不论多旧;--remove 取消;不带运行 id 列出已固定的
```

- **孤儿 worktree。** 每个隔离 agent 的 worktree 目录(`$TMPDIR/odw-wt-*`)里有一个
  `odw-owner.json`,写明它属于哪个进程、哪个运行、哪个仓库。进程已不在、且所属运行不再活动的,
  就是孤儿;没有这个文件的(旧版 odw 建的)要一天没被改动过才算。清理方式与 worker 自己一样:
  `git worktree unlock`、`worktree remove --force --force`、删目录、`worktree prune`;目录已经
  不在的注册项会被 prune。`odw gc` 查看临时目录,以及当前仓库(`--source DIR`)和每个运行的源仓库
  里注册的 worktree。
- **keep 分支** `odw/<run>/<agent>-<label>`(属于本运行根目录中的运行):HEAD 已经包含其改动
  (提交在 HEAD 中,或 `git cherry` 在 HEAD 里找到同样的补丁——`odw apply` 加一次提交之后就是这样),
  或所属运行超过保留期限时删除。任何地方检出着的分支 git 会拒绝删除,于是保留;本运行根目录不认识
  其运行的分支只计数,从不删除。
- **保险快照** `refs/odw/safety/<run>`(`odw restore` 用来恢复的那份)在所属运行超过保留期限时
  随之删除;本运行根目录不认识其运行的快照只计数,从不删除。
- **过期运行**——已结束且超过保留期限——删除各 agent 的 transcript 和 stderr(运行中最大的部分)。
  `meta.json`、状态、事件、保存的结果和 diff 都保留,所以 `odw list`、`odw estimate`、`odw compare`
  和 `odw apply` 仍然可用;运行目录中的 `gc.json` 记录删了什么,看板为该运行标出 **转录已清理**。
- **从不碰:** 运行中、暂停中或在检查点等待的运行;你固定过的运行(运行目录里的 `pinned.json`,看板
  标出 **已固定**);不是 odw 建的 worktree 和分支。每一项删除前都会再检查一次,失败的会报告(退出码 1),
  其余照常进行。
- **Compose 项目**:名为 `odw-*`(隔离 agent 的 `ODW_SLOT`,即其默认 `COMPOSE_PROJECT_NAME`)
  且所属运行已不活跃的,会连同删除它的 `docker compose -p <name> down -v` 一起列出——**只报告,
  从不删除**。仅当 `docker compose ls` 能立即回答时才看(`$ODW_DOCKER` 可指定另一个 docker);
  没有 docker 时什么都不说。
- **启动时** 每个 worker 只读地查看其仓库注册的 worktree,若有已死运行留下的,就在运行日志里说一次,
  并给出 `odw gc` 命令。`odw doctor` 增加 **Disk** 一行:运行根目录的大小与孤儿 worktree 数。

```jsonc
{
  "retention": { "days": 30, "transcripts": true } // transcripts: false 保留 transcript;gc 只清理 worktree 与分支
}
```

odw 不运行常驻进程:要定期清理,把 `odw gc --yes` 放进你自己的 crontab 或 CI 任务。

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
  运行,工具卡片实时更新。普通回合运行 `codex exec --json`(只读沙箱、`--ephemeral`),
  并按内置 `codex` 适配器的方式解读:回复取自它的 `--output-last-message` 文件,没有时取最后
  一条 `agent_message`;回复流式输出期间,每条消息完成时即显示。该回合的 token(来自
  `turn.completed`;codex 不报美元)记录在消息的 `usage` 上。codex 报告的失败按 agent 失败
  的方式归类:额度用尽或登录被拒时会说明该怎么做 —— 等额度窗口重置,或执行 `codex login` ——
  消息带上 `failureReason`(`quota`、`auth` 等)(ODW 扩展)。

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
  `Content-Type: application/json`、同源 `Origin`、防 DNS rebinding 的 Host 检查。在那里,任何有效令牌
  都能写,与其范围无关:`read` 令牌仍可停止、暂停或恢复运行并标记审阅,与其他 loopback 路由一样——
  范围只限制令牌在 loopback 以外能做什么。)
- **这是明文 HTTP。** 令牌和看板展示的一切都以未加密的形式经过网络:请在你信任的网络中使用,
  或通过 VPN、SSH 隧道(`ssh -L 4317:localhost:4317 host` 根本不需要 `--host`),或放在 TLS
  代理后面。
- **持有令牌的人能读到的**就是看板展示的一切:所有项目的运行——ODW 的,以及在默认
  `claudeJobsScope: "all"` 下 Claude Code 的——它们的 args、结果、事件、agent 的 transcript 和
  diff(按上文脱敏),以及设置页上的路径与适配器。用 `--runs-root` 和 `"claudeJobsScope": "project"`
  缩小范围,或者改为把一次运行作为[运行包](#分享一次运行odw-扩展)分享。
- **不加 `--token` 时**,非 loopback 绑定与以前一样——只读,任何能连到该端口的人都能读——并且
  `odw serve` 会打印一条醒目的警告,建议加上 `--token`。
- **只有两个窄口子能回答检查点,此外什么都不能写**——见[在手机上批准](#在手机上批准odw-扩展):
  签名的一次性批准链接(`--public-url`),以及 `--token-scope approve`。

### 具名令牌:谁做了什么(ODW 扩展)

几个人在同一台机器上查看、批准时,给每人一个自己的令牌,而不是共用一个——这样每个人做的事
都记在他名下,也可以单独收回某一个人的令牌:

```bash
odw token add alice --scope approve --file ~/.config/odw/tokens.json   # 打印 alice 的令牌,仅此一次
odw token add bob --file ~/.config/odw/tokens.json                      # 权限 read(默认)
odw token list --file ~/.config/odw/tokens.json                         # 名字和权限;remove <name> 收回一个
odw serve --host 0.0.0.0 --tokens ~/.config/odw/tokens.json
```

这个文件是 `{ "name", "scope": "read" | "approve", "hash" }` 组成的 JSON 数组,`hash` 是令牌的
sha256(十六进制)——**文件里从不保存令牌本身**;`odw token add` 只打印一次新令牌,只保留它的
哈希(文件以 0600 写入)。收到的令牌先哈希,再按摘要查找,比较从不在令牌本身上进行;上文
`--token` 的所有规则(三种携带方式、429、非 loopback 上拒绝写)对每个令牌都成立。`--tokens`
可以与 `--token`(一个不具名的令牌,配合 `--token-scope`)同时使用;权限为 `approve` 的具名令牌
可以在非 loopback 上回答检查点,`read` 的只能读。`odw serve` 在启动时读取该文件:修改后需重启。
名字为 1–64 个 `A-Z a-z 0-9 . _ @ + -` 字符。

记录了什么、记在哪里:

- 运行 `meta.json` 中的 **`launchedBy`**:你启动的运行记为本地用户(git `user.email`,否则
  `$USER`),从看板(Chat)启动的记为具名令牌的名字,[webhook 触发器](#由-webhook-启动运行githublinearslackodw-扩展)
  启动的记为 `trigger:<name>`。`odw list --by <name>` 列出某人的运行(`--by me`:你自己的);看板的
  运行标题显示"由 … 启动",Jobs 页多出 **我的 / 团队** 筛选——"我的"即 `/api/capabilities` 返回的
  `you`(你令牌的名字;完全没有令牌时为本地用户;不具名的 `--token` 则没有)。
- 检查点决定的 `by`(渠道——`cli`、`dashboard`、`link`——保持不变)旁边多一个 **`who`**:
  `odw approve|reject` 记为 `cli:<$USER> <git user.email>`,看板记为令牌的名字,批准链接在
  `by: "link"` 之外,记下该请求同时携带的具名令牌的名字。它出现在决定日志(`decisions.jsonl`)、
  `checkpoint_resolved` 事件和 `checkpoint()` 的结果(`result.who`)中。
- **暂停、继续和停止**在 `control.json` 中记录 `who`(`odw pause|resume|stop`:`cli:<user>`;
  看板:令牌的名字);运行日志写出 "paused by …" / "resumed by …",停止时 `run_stopped` 事件带
  `who`,`status.json` 带 `stoppedBy`。

这些是标签,不是访问控制:任何能写运行目录的人都能写入任何名字。除两种权限外没有更细的 RBAC。

### 在手机上批准(ODW 扩展)

[`checkpoint()`](#人工检查点odw-扩展) 不必再等你回到终端。用手机能访问到的 URL(通常是一条
HTTPS 隧道)启动看板,并打开 `waiting` 通知 hook:

```bash
odw serve --public-url https://odw.example.com     # 例如放在 cloudflared 或 tailscale funnel 后面
```

`--public-url` 必须是根 URL(`https://host[:port]`):链接在它的 `/approve/` 下应答,所以带路径
的 URL(把 odw 挂在 `/odw` 下的代理)会被拒绝——像隧道那样给 odw 一个独立的主机名。

```json
{ "notify": { "webhook": "https://hooks.example.com/YOUR/WEBHOOK/PATH", "on": ["waiting"] }, "approveLinks": { "ttl": 86400 } }
```

此后每个开始等待的检查点都会发出两条链接,批准与拒绝:webhook 的 JSON 里是 `approveUrl`、
`rejectUrl` 和 `linksExpireAt`(`text` 末尾也有);通知命令拿到 `ODW_APPROVE_URL`、
`ODW_REJECT_URL`、`ODW_LINKS_EXPIRE_AT` 和 `ODW_NTFY_ACTIONS`——一个现成的 ntfy `Actions`
头,带 Approve 与 Reject 两个按钮([示例](docs/recipes/notify.md#approve-from-the-notification))。
打开链接会显示一个小页面——运行、检查点标题、payload 和一个按钮;按下即以 `by: "link"`
记录决定,运行继续。

`odw serve --token X --token-scope approve` 为远程看板做同样的事:持有令牌的人可以批准或拒绝
检查点(与 loopback 上一样可附备注或修改后的 payload)。默认范围是 `read`。

安全模型——唯一的远程写操作是检查点决定:

- **链接就是能力凭证。** 拿到它的任何人都能在它过期或被用掉之前,对那一个检查点做那一个决定——
  像对待承载它的 webhook URL 一样对待它。它是对运行、检查点、动作和过期时间的 HMAC-SHA256,
  密钥按 runs 根目录各有一份(`<runsRoot>/.approve-secret`,权限 0600,由第一次
  `odw serve --public-url` 生成;他人可读的会被替换)。改动链接里的任何内容都会破坏签名;
  `odw serve --rotate-approve-secret` 让之前发出的所有链接失效。
- **只能用一次。** 用过的链接记录在运行目录里(`approve-links/<nonce>`,以独占方式创建,两次
  点击不可能都生效);检查点的另一条链接随之作废。重放、过期的链接(默认 24 小时:
  `approveLinks.ttl`,60 秒到 30 天)或已用别的方式回答的检查点,得到一个清楚的 "410" 页面;
  被篡改的链接得到 "403" 页面——从不出现堆栈。
- **打开链接不会做出任何决定。** 聊天软件的链接预览和邮件扫描只会 `GET`。决定是一个 `POST`,
  带着页面的 CSRF 值,它必须与页面设置的 `HttpOnly`、`SameSite=Strict` cookie 一致;ntfy 按钮
  则在 `X-ODW-Action` 头里写明动作,其他网站的页面发不出这个头。来自其他源的表单会被拒绝,
  页面也不能被嵌入 frame。
- **猜测受到限速**,与错误令牌相同:每个地址每分钟 10 个坏链接(或 CSRF 校验失败),全体合计
  100 个,之后坏链接回 429。链接的签名最先校验,有效的链接从不受限:经同一条隧道发来的坏链接
  挡不住真正的链接。
- **链接只在 `odw serve --public-url` 运行时有效。** 该 runs 根目录没有这样的服务时不会生成链接,
  并在通知里说明原因(`linksUnavailable`、`ODW_LINKS_UNAVAILABLE`)。`/approve/` 路由不需要看板
  令牌——链接本身就是凭证——也不开放任何别的东西:停止、暂停、恢复和 Chat 仍只限 loopback,
  `--token-scope approve` 下同样如此。
- **请用 HTTPS。** 走明文 HTTP 时,路径上的任何人都能读到链接并抢先使用;`--public-url` 是指向
  localhost 以外的 `http://` 时 `odw serve` 会给出警告。隧道连到 loopback 绑定也可以:公开 URL
  的主机名可以越过 DNS rebinding 检查到达 `/approve/`(仅此路由)。

## 配置适配器

Codex、Claude Code、Gemini、Qwen、Kimi、Oh My Pi、Kilo Code、OpenCode、Cursor
以及 Google 的 Antigravity CLI 均开箱即用:

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
| `agy` | `agy` | `--output-format stream-json`,stdin 传提示词;回复、token、错误和被拒的工具调用(`denied_actions`)取自其 `result` 事件;根为对象的 schema 走原生(`--json-schema`) |

> **`gemini` 对个人与免费账号已停止支持。** Google 已于 2026-06-18 停止对个人(Gemini Code
> Assist for individuals)与免费账号的 Gemini CLI 支持;这类登录现在会得到 "This client is no
> longer supported for Gemini Code Assist for individuals",ODW 将其归为 `model_unavailable`
> ([回退链](#按阶段路由与回退链odw-扩展)会换到下一个适配器)。请改用 `agy` 适配器
> (Antigravity CLI)。企业与 Google Cloud 许可据称仍可使用(未经核实)。出处:
> [littlebearapps/untether#720](https://github.com/littlebearapps/untether/issues/720)。

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

内置的 `agy`(Google 的 Antigravity CLI,依据它的
[无头模式文档](https://antigravity.google/docs/cli/headless)与更新日志;全部为 ODW 扩展)读取
`--output-format stream-json`,它的事件用 `event` 键标明类型——由 `output.eventKey` 声明
(默认 `"type"`)。回复、token、失败与被拒的工具调用都取自最后的 `result` 事件;agy 不报告
花费。失败回合的 `error`("Individual quota reached … Resets in 2h39m52s."、
"Authentication expired. Please log back in.")与其他失败一样分类。只有根为
`"type": "object"` 的 schema 才走原生(`flags.schema.objectRoot`:其他 schema agy 会在启动时
拒绝),其他的写进提示词。

```jsonc
"agy": {
  "label": "Antigravity CLI",
  "command": ["agy", "--output-format", "stream-json", "--input-format", "text",
              "--disable-slash-commands", "--print-timeout", "24h", "{permission_args}"],
  "stdin": "{prompt}",                                               // 不用 -p:argv 有长度上限
  "flags": { "model": ["--model"], "schema": { "args": ["--json-schema"], "mode": "inline", "objectRoot": true } },
  "output": {
    "format": "jsonl",
    "eventKey": "event",                                             // {"event":"result","result":{…}}
    "eventType": "result",
    "textPath": ["result", "response"],
    "select": "last",
    "usagePath": ["result", "usage"],                                // 只有 token:agy 不报告花费
    "errorPath": ["result", "error"],                                // 只在运行失败时出现
    "structuredPath": ["result", "structured_output"],
    "deniedPath": ["result", "denied_actions"]
  },
  "permissionArgs": {
    "edit": ["--mode", "accept-edits"],
    "full": ["--mode", "accept-edits", "--dangerously-skip-permissions"]
  }
}
```

无头 agy 无法请求审批的工具调用会被软拒绝:运行以 0 退出,`response` 常常是空的
([antigravity-cli#794](https://github.com/google-antigravity/antigravity-cli/issues/794)),
所以 agent 以 `empty_reply` 失败,`denied` 写明 agy 拒绝了什么。子 agent 的输出也不会进入
agy 的事件流([antigravity-cli#1077](https://github.com/google-antigravity/antigravity-cli/issues/1077)):
transcript 会列出它启动的每个子 agent 及其日志路径。agy 的事件流从不说明子 agent 何时结束,
所以 `agy` 没有声明 `output.background`。

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
| `agy` | 拒绝 | `--mode accept-edits` | `--mode accept-edits --dangerously-skip-permissions` |

- **`read`。** 在 `claude` 上,`dontAsk` 会拒绝一切需要询问的调用,`--tools` 只留下只读的
  内置工具——根本没有 Edit、Write 或 Bash,你设置里的 allow 规则也加不回来——外加联网
  工具;不启动任何 MCP server。`codex` 运行在只读沙箱里:能读文件,不能改,也不能运行需要
  审批的命令(`codex exec` 不向任何人询问)。`gemini` 在 `default` 模式下会在写入和 shell
  工具前询问,无头模式下这等同于拒绝。
- **拒绝。** 没有经过验证的只读模式的 CLI,agent 会在启动前失败:
  `kimi cannot run read-only (…); use an adapter that can (--adapter claude, …), or
  run with --permissions edit`。Qwen 的文档没有说明其 `default` 模式在无头下的行为,所以它
  也没有 `read`。`agy` 同样没有:无头时它总能写入工作区内的文件,plan 模式只是给提示词加前缀。
- **`agy`。** 无头时,需要审批的工具调用会被软拒绝:在 `edit` 下,shell 命令、联网和 MCP
  工具只有在你自己的 `~/.gemini/antigravity-cli/settings.json` 中 `permissions.allow` 规则
  (或其 `toolPermission` 预设)允许时才会运行。被拒绝的调用与 Claude Code 一样记为 `denied`。
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

### 安全快照与破坏性 git 命令(ODW 扩展)

原地工作的 agent——方言的默认做法,没有 `isolation: "worktree"`——就在你未提交的改动旁边
干活,一条 `git reset --hard` 就能把它们全部丢掉
([claude-code#33850](https://github.com/anthropics/claude-code/issues/33850))。所以在一次
运行的第一个 `edit` 或 `full` 档位的原地 agent 开始之前,odw 会保存工作区里 git 还没有的
东西:用 `git stash create` 保存已跟踪文件的改动(暂存与未暂存),再加上 `.gitignore` 没有
排除的未跟踪文件,合成一个提交存到 `refs/odw/safety/<run>`——你的工作区、index 和 stash
列表都保持原样。干净的工作区不建快照;被忽略的文件从不保存,超过 50 MB 的未跟踪文件不保存,
文件名表明含有密钥的未跟踪文件(`.env`、`.env.*`、`*.pem`、`*.key`、`*.p12`、`id_rsa`、
`id_ed25519`、`id_ecdsa`、`credentials.json`)也不保存——快照会逐一点名。运行用
`safety_snapshot` 事件说明;odw 无法建快照时(不是 git 仓库、正在合并)记一条日志说明原因,
agent 照常运行。

快照是**你仓库里的一个 git ref**:在 `odw gc` 随其运行一起删除它之前(超过 `retention`),
它的提交里保存着你其他未跟踪文件当时的内容——草稿、本地配置、odw 不认识的文件名下的密钥。
按分支或标签推送不会带上它,但 `git push --mirror`(推送所有 ref)会把它公开出去。

```sh
odw restore $RUN --check   # 预览:每个文件 clean、CONFLICT(附冲突行)或 already applied
odw restore $RUN           # 把工作区恢复成快照保存时的样子(git apply --3way,已暂存)
```

`odw restore` 在运行的源仓库里工作,复用
[`odw apply`](#审阅并应用隔离-agent-的改动odw-扩展) 的机制:工作区里已经与快照一致的文件
(例如 reset 没有动到的未跟踪文件)会略过;某个路径有未提交改动时拒绝,除非加 `--force`;
HEAD 在那之后移动过(`git reset --hard origin/main`)时,改动以三方合并方式放到新的 HEAD
之上,并说明 HEAD 原来所在的提交。

odw 无法在命令执行前拦住它——那需要各 CLI 自己的 hook——但会在 agent 运行时读取它执行的命令
(Claude Code 的 `Bash`、Codex 的 `command_execution`、kilo、opencode 与 agy 的 shell 工具),
识别 `git reset --hard`、`git checkout .` / `-- .` / `--force`、`git switch --force` /
`--discard-changes`、`git restore .`、`git clean -f…`、`git push --force`(`-f`、
`--force-with-lease`、`+refspec`)、`git push --mirror`、`git push --delete`(`-d`、`:refspec`)、
`git stash drop|clear` 和 `git branch -D`。命令行按 shell 的方式切分(`cd x && …`、
`bash -lc '…'`、`sudo`、`env`、`if …; then …`、`! …`、`git -C dir …`);引号里的文字不算命令。
每条命中都是一个 `destructive_git` 事件——显示在 `odw logs`、实时视图以及看板里该 agent 的抽屉和
节点上——有快照时会提示 `odw restore <run>`。只重置工作区的那几类命令对隔离 agent 不计:它的
worktree 是它自己的——除非 git 被指向别处(`git -C <dir>`、`--git-dir`、`--work-tree`),odw 无法
判断那是哪里,按原地处理。

这种识别**只是提示、尽力而为**,不是防护:它只看命令行上写了什么。由别的程序调用的 git 它看不到——
`find . -exec git checkout -- {} +`、`… | xargs git checkout --`、脚本或 Makefile——git 别名
(把 `reset --hard` 叫作 `git nuke`)、先 `cd` 到另一个 worktree 再执行的普通 `git reset --hard`,
以及不打印工具调用的 CLI(文本适配器)也都看不到。能把工作找回来的是快照,而不是识别。

```jsonc
{ "destructiveGit": "fail" } // 默认 "warn":只记录;"fail":agent 的 CLI 结束后以失败原因 destructive_git 判为失败
```

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
| `agy` | 没有文档化的方式 | AGENTS.md、GEMINI.md、`.agents/` 下的 rules、skills、agents、`mcp_config.json` |

Claude Code 的 `--bare` 跳过的更多,但它只接受 API key 认证,订阅登录用不了。第一次有
agent 在 codex 上运行时,运行日志里会出现
`codex has no documented way to ignore the repository's AGENTS.md — its instructions
still reach the agent` 这样的一行。

ODW 自己会执行的、属于仓库的代码会被拒绝:仓库 `.worktreeinclude` 里的 `symlink:` 行
不做任何链接(链接等于把源码树交给 agent;普通行照常复制);仓库内配置(例如它的
`./odw.config.json`)设置的 `worktreeSetup` 或 `worktreeTeardown` 不会运行,日志里会说明。你自己的配置
(`--config`、`$ODW_CONFIG`,或仓库之外的 `~/.config/odw/config.json`)里的
`worktreeSetup` 照常运行。ODW 会自行在仓库里找到的配置(它的 `./odw.config.json`)在不受
信任运行中根本不会读取:其中的适配器命令就是仓库的代码。运行改用你自己的
`~/.config/odw/config.json`(在仓库之外)或内置默认值,并在日志里说明;用 `--config` 或
`$ODW_CONFIG` 指定的配置是你自己的选择,照常生效。仓库的配置也无法放宽你在
`~/.config/odw/config.json` 里设置的 `"trust": "untrusted"`。仓库的[工作流记忆](#工作流记忆odw-扩展)
(`.odw/memory/`)既不召回也不写入;你放在仓库之外的 `memoryDir` 照常使用。

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

### 不可信输入(ODW 扩展)

issue 正文、PR 标题、评论是任何人写的文字,模型无法可靠地把它和指令区分开:已公开的注入
("Comment and Control"、GitLost)绕过了所有模型层面的防护,由此得出的建议是结构性的——把能力
拿走。**args** 来自外部的运行带有**不可信输入**,这与[不受信任的仓库](#不受信任的仓库odw-扩展)
是两回事。[触发器](#由-webhook-启动运行githublinearslackodw-扩展)启动的每个运行都带有它(除非
触发器写明 `"untrusted": false`),`odw run --untrusted-input` 也一样(rerun / resume / replay 会保留)。
这样的运行:

- **agent 只读**——`permissions: "read"`——除非显式给出了运行档位:`--permissions`,或触发器的
  `"permissions"`;
- **agent CLI 以 `agentEnv: "minimal"` 启动,不带其他厂商的变量,也不带密钥类变量**——`GH_TOKEN`、
  `GITHUB_TOKEN`、`*_API_KEY`、`*_TOKEN`、`*_HEADERS` 等——只保留该 CLI 自身登录文档里的那些(claude 是
  `ANTHROPIC_*`/`CLAUDE_*`,codex 是 `OPENAI_*`/`CODEX_*`,gemini 是 `GEMINI_*` 与 `GOOGLE_API_KEY`、
  `GOOGLE_GENAI_USE_VERTEXAI`、`GOOGLE_GENAI_USE_GCA`、`GOOGLE_CLOUD_PROJECT`、`GOOGLE_CLOUD_LOCATION`,……),
  无论 `agentEnvPass` 列了什么。适配器自己的 `env` 仍然生效,`exec()` 命令(工作流作者写的)得到最小环境加上
  `agentEnvPass`;
- **不运行仓库自己的 worktree setup 与 teardown:** 仓库自身配置设置的 `worktreeSetup` 或 `worktreeTeardown`
  会被丢弃,运行日志会说明,与[不受信任的仓库](#不受信任的仓库odw-扩展)相同;你自己配置里的仍会运行,但不带
  密钥类变量和各厂商的变量(保留 `PATH`、`HOME`、`DOCKER_*` 与 `COMPOSE_*`,docker 和 compose 照常可用);
- **没有隔离时大声说出来:** 若没有 `network` 为白名单(或 `"none"`)的
  [容器沙箱](#在容器中运行-agentodw-扩展),启动横幅、运行日志和 `run_started` 事件都会警告,且只读 agent
  启动时不带其 CLI 的联网工具(Claude Code 的 `WebFetch` 与 `WebSearch`,codex 的 `--search`)——它们可能把
  读到的文件(比如 `actions/checkout` 留在 `.git/config` 里的 token)带出本机。
  配置 `"untrustedInput": { "requireSandbox": true }` 则直接拒绝启动;
- **写之前先问:** 第一个可写(`edit` 或 `full`)的 agent 会停在一个[检查点](#人工检查点odw-扩展)
  等人放行——每个运行只问一次,答复对之后的 agent 都有效;拒绝会让这些 agent 以可捕获的
  `UntrustedInputRejected` 失败。对这样的运行执行 `odw apply --pr` 会在终端询问 `y/N`,或接受
  `--accept-untrusted-input`。触发器的 `"approve": false` 同时关闭两者。

```jsonc
"triggers": {
  "fix-issue": {
    "workflow": "fix-issue", "verify": "github", "secretEnv": "GITHUB_WEBHOOK_SECRET",
    "args": { "issue": "$.issue.number", "body": "$.issue.body" },
    "permissions": "edit"            // agent 可以编辑:第一个会先询问
  }
},
"sandbox": { "kind": "container", "image": "odw-agents:latest", "network": { "allow": "adapter" } },
"untrustedInput": { "requireSandbox": true }
```

工作流通过 `workflow.input` 看到这一点(ODW 扩展;Claude Code 中为 undefined,请写成
`workflow.input?.untrusted`):`untrusted`、它覆盖的 `args`(触发器映射的键;`["*"]` 表示全部)、
`why`(`trigger:<name>`、`--untrusted-input`),以及 `quote(text, label?)`——把文本放进带围栏的
`<untrusted-data>` 块,后面跟一行说明它是数据而不是指令:

```js
const fix = await agent(`修复这个 issue 描述的 bug。\n${workflow.input.quote(args.body, "issue body")}`)
```

meta.json 记录 `untrustedInput: { why, args, approve }`;status.json 和 `run_started` 事件补充档位、
环境以及是否有沙箱,看板的 Job 头部以一行信任信息显示它。这些都不检测或过滤注入,也不让运行
变得「安全」:它只是拿走了那段文字可能要求的能力。

### 严格脚本上下文(ODW 扩展)

工作流就是代码:来自插件、分享文件或触发器的工作流,默认带着 worker 的整个 JavaScript 上下文运行——
`process`、`require`、`fetch` 以及经由它们能拿到的一切。`scriptContext: "strict"` 在一个新的 `vm`
上下文中编译并执行工作流正文,其中只有注入的原语(`agent`、`parallel`、`pipeline`、`phase`、`log`、
`args`、`budget`、`workflow`,以及 ODW 扩展 `validate`、`exec`、`checkpoint`)和标准 JavaScript 内建对象——
也就是 Claude Code 的 Workflow 工具给脚本的那个裸 ECMAScript 环境。没有 `process`、`require`、`fetch`、
`console`、定时器和 `structuredClone`;`eval()` 与 `new Function()` 不编译任何代码;`import()` 在正文编译
时即被拒绝。用到这些时,报错会直接说明原因(`process is not defined: a strict script context
(scriptContext: "strict") has only the workflow primitives and standard JavaScript built-ins, not
Node.js's process — …`),而不是一个光秃秃的 `ReferenceError`;运行在正文开始前就会说明自己是严格的,
以及脚本用到了其中哪些名字。原语返回或抛出的值,以脚本自身环境中的副本到达脚本;脚本抛出的错误离开
时是普通的 `Error`。

```jsonc
{ "scriptContext": "strict" } // 所有运行;"host":所有运行都在 worker 的上下文中
```

不设置时,**触发器启动的运行、Claude Code 插件的工作流、`odw workflows add` 从 git 安装的工作流、输入或仓库不可信的运行使用 strict**,
其余一律 **host**——本地项目与个人工作流照旧运行。触发器启动的运行,其 rerun、resume 与 replay 也是 strict。
配置中的 `"host"` 优先,但它拿走 strict 默认值时,运行日志会给出警告。嵌套的 `workflow()` 与父运行用同一种
上下文——插件的工作流即使在 host 父运行之下也是 strict,除非配置写明 `"host"`。
运行的 `run_started` 事件记录所选的上下文,status.json 中有 `scriptContext: "strict"`,看板 Job 头部的
信任行也会显示。`odw check --capabilities` 列出脚本在严格上下文中会缺少的东西。

**`vm` 不是安全边界。** 严格上下文只是拿走了脚本随手就能碰到的东西;恶意脚本仍可能找到办法逃出
这个上下文,而且每个脚本驱动的 agent 都带着运行的权限行事。`exec()` 仍然可用,它在本机(或运行的容器沙箱)
的 shell 中、带着运行的环境变量执行命令——严格上下文不会拿走命令。运行前请先读一遍工作流,并为 agent 使用
[权限档位](#权限档位odw-扩展)与[容器沙箱](#在容器中运行-agentodw-扩展)。

### 在容器中运行 agent(ODW 扩展)

默认情况下,ODW 以你的身份在本机运行每个 agent CLI,只靠 CLI 自己的权限参数约束。容器
沙箱则把每次 CLI 运行——以及每个 `exec()` 步骤——放进一个全新的 Docker 或 Podman 容器。
它需要显式开启,镜像由你提供:镜像里必须装好 CLI,ODW 从不拉取镜像。

```bash
docker build -t odw-agents --build-arg UID=$(id -u) --build-arg GID=$(id -g) examples/sandbox
odw doctor                                   # 找到引擎、镜像存在、冒烟运行
odw run wf.js --sandbox container --sandbox-image odw-agents
```

[`examples/sandbox/Dockerfile`](examples/sandbox/Dockerfile) 构建一个带 Node、git、Claude
Code 与 Codex 的镜像(用 `--build-arg CLAUDE_CODE_VERSION=…` 固定版本)。也可以写进配置,
按运行、按适配器或按调用设置:

```jsonc
{
  "sandbox": {
    "kind": "container",
    "image": "odw-agents",          // 必填;从不拉取
    "engine": "docker",             // 或 "podman";默认:装了 docker 用 docker,否则 podman
    "network": "default",           // 或 "none",或 { "allow": [...] }(见下文)
    "cliConfig": "copy",            // 或 "mount-ro" | "none"
    "mounts": [{ "source": "~/datasets", "readonly": true }], // 默认只读,除非 "readonly": false
    "memory": "4g", "cpus": 2, "pids": 512 // pids 默认 512;其余用引擎默认值
  },
  "adapters": {
    "codex": { "sandbox": { "kind": "container", "image": "odw-codex", "network": "none" } }
  }
}
```

```js
await agent('Review this diff', { sandbox: { network: 'none', memory: '1g' } })
await agent('Summarize', { sandbox: { image: 'odw-agents' } }) // 在宿主上运行的 run 中单个调用进容器
await exec('npm test')                                          // 在运行的容器里,不联网
await exec('npm ci', { network: 'default' })                    // 需要网络的步骤
```

与权限档位一样,沙箱只能收紧:适配器的 `sandbox` 可以开启容器并设定自己的镜像、引擎、
CLI 配置和更多挂载,网络与各项限制取更严格者;`agent()` 调用可以开启容器(只有在别处都
没给镜像时才能指定镜像)、拿掉网络、降低限制或丢掉 CLI 配置(`cliConfig: "none"`)。任何
更宽松的要求——容器下的 `sandbox: "none"`、沙箱没有的网络、更多内存、换镜像、挂载——都会让
调用在启动前失败。`odw run|rerun|resume --sandbox container [--sandbox-image <镜像>]` 让整次
运行进入容器(配置里的容器,或该镜像的容器);沙箱运行的 rerun 或 resume 仍在沙箱中。

每次 CLI 运行变成(`docker run --rm -i --init --pull never --name odw-<run>-<agent>-<随机> --label odw.run=<run> …`):

- **只有工作区,别无其他。** agent 的工作区——隔离 worktree 或运行的 source——以相同路径
  读写挂载并作为工作目录,所以 diff、transcript、`expect` 检查与 `{workspace}` 照常工作。宿主
  文件系统的其他部分都不可见:只有私有 home、这次 CLI 运行要用的文件(提示词文件、schema
  文件、回复文件)以及你列出的 `mounts`。在隔离 worktree 里,容器内的 `git` 找不到仓库
  (worktree 的 `.git` 指向外面);ODW 照常在宿主上取 diff。agent 需要历史时,用 `mounts`
  把仓库的 `.git` 只读挂进去。
- **CLI 的登录,以副本形式。** `cliConfig: "copy"`(默认)把 CLI 自己的登录与配置文件复制到
  私有临时 home(挂载在 `/odw/home`,运行结束后删除),agent 能用,但改不了你的原件。只复制
  各 CLI 文档点名的文件:Claude Code 的 `~/.claude/.credentials.json`、`settings.json`、
  `CLAUDE.md`、`agents/`、`commands/`、`skills/` 和去掉 `projects`(你的其他仓库)的
  `~/.claude.json`;Codex 的 `~/.codex/auth.json`、`config.toml`、`AGENTS.md`;Gemini 的
  `~/.gemini/settings.json`、`oauth_creds.json`、`google_accounts.json`、`GEMINI.md`、`.env`。
  从不复制会话历史或日志。支持 `CLAUDE_CONFIG_DIR` 与 `CODEX_HOME`。`"mount-ro"` 改为只读
  绑定这些文件(Claude Code 运行时会改写 `~/.claude.json`,它更适合 `copy`);`"none"` 让 home
  为空。macOS 上 Claude Code 把登录存在钥匙串里,没有文件可复制:请设置
  `CLAUDE_CODE_OAUTH_TOKEN`(来自 `claude setup-token`)或 `ANTHROPIC_API_KEY`;Codex 用
  `CODEX_API_KEY`,Gemini 用 `GEMINI_API_KEY`。找不到可复制的文件时,运行会说明一次。CLI 若在
  容器里刷新登录,新令牌写进随后丢弃的副本;若提供方轮换刷新令牌,你本机的登录之后可能需要
  重新 `/login`——沙箱运行最适合长期令牌与 API key。
- **以你的身份,没有特权。** `--user` 为你的 uid:gid(Podman 另加 `--userns keep-id`),agent
  写下的文件归你所有;`--cap-drop ALL`、`--security-opt no-new-privileges`、`--pids-limit`
  (512)、可选的 `--memory` 与 `--cpus`、只读根文件系统加 tmpfs `/tmp`,以及转发信号的 `--init`。
- **只有 `agentEnv` 放行的环境变量**——设置 `"agentEnv": "minimal"` 可挡住 shell 里的其他
  密钥——按名字传递(`--env NAME`),进程列表里看不到值;宿主路径类变量(`PATH`、`HOME`、
  `TMPDIR`、`XDG_*`、`CLAUDE_CONFIG_DIR`、`CODEX_HOME`)不传。
- **`ODW_PORT` 照常设置,但不发布任何端口。** agent 在该端口启动的服务只在它的容器内可达。
- **随运行一起被杀掉。** 超时、停顿、被停止或没有干净退出的 CLI 运行,其容器按名字被杀掉
  (`docker kill`,再 `docker rm --force`);只杀引擎客户端会让容器继续运行。worker 自己被杀时,
  它的退出处理会删除仍在运行的全部容器。崩溃遗留的容器可用
  `docker ps --filter label=odw.run` 找到。

**出站白名单**(ODW 扩展)。agent CLI 必须连到模型 API,所以 `network: "default"` 实际上就是
开放的互联网。白名单让容器只能连到你列出的主机,而且由容器之外的东西来执行:

```jsonc
{
  "sandbox": {
    "kind": "container", "image": "odw-agents",
    "network": { "allow": ["adapter", "registry.npmjs.org", "*.githubusercontent.com"] }
    // "allow": "adapter" —— 只放行该 agent 的适配器所需的主机
    // "proxyImage": "node:22-alpine" —— 让代理跑在另一个镜像里(需要 node)
  }
}
```

- **条目。** 主机名(`api.anthropic.com`)、匹配其子域的通配符(`*.npmjs.org` 匹配
  `registry.npmjs.org`,不匹配 `npmjs.org`)或 IP 字面量(`10.0.0.5`、`[::1]`),都可带端口
  (`example.com:8443`;不带时为 443 与 80)。请求 IP 地址时,除非这个地址本身被列出,一律拒绝——
  通配符从不匹配 IP。`"*"` 会被拒绝:那就是 `network: "default"`。
- **`"adapter"`** 代表 agent 的适配器在 `egressHosts` 中声明的主机(取自各 CLI 文档):
  `claude` 为 api.anthropic.com、claude.ai、platform.claude.com;`codex` 为 api.openai.com、
  chatgpt.com、auth.openai.com;`gemini` 为 generativelanguage.googleapis.com、
  cloudcode-pa.googleapis.com、oauth2.googleapis.com;`agy` 为 cloudcode-pa.googleapis.com、
  oauth2.googleapis.com。可选的遥测不在其中(会被拒绝并记录;Claude Code 可设
  `DISABLE_TELEMETRY` 让它安静)。其他适配器没有声明——给你的适配器加 `"egressHosts": [...]`,
  或直接列出主机。
- **只能收紧。** 适配器或单次调用的 `network: { allow }` 与运行的白名单取交集;`"none"` 仍然优先;
  白名单之下的调用不能要求 `"default"`。`network: "default"` 的 `exec()` 步骤得到运行的白名单
  (去掉 `"adapter"`:步骤没有适配器)。
- **原理。** 第一个需要它的容器会为每个不同的白名单拉起一个运行专属的内部网络
  (`docker network create --internal`:没有出口路由)和一个出站代理边车容器
  (`odw-<run>-egress<n>-…`,标签 `odw.role=egress-proxy`),代理位于引擎默认网络上并同时加入内部网络。
  agent 的容器只加入内部网络,`HTTPS_PROXY`/`HTTP_PROXY`(及小写形式)指向代理,`NO_PROXY` 放过回环地址,
  并设 `NODE_USE_ENV_PROXY=1`。代理只为白名单主机的 443 端口(或条目指定的端口)建立 `CONNECT` 隧道,
  只把明文 HTTP 转发给白名单主机(`Host` 头指向别的主机则拒绝),并且**自己解析域名**——agent 的容器
  对外没有 DNS:在 Docker 上它得到 `--dns 192.0.2.1`,一个无人应答的地址,因为 Docker 26.0 之前的内置
  解析器会经由宿主机把内部网络的查询转发出去(CVE-2024-29018)。代理只在它于内部网络上的地址监听,
  默认网络上的其他容器用不了它。它是 ODW 自带的零依赖脚本(与隐藏命令 `odw __egress-proxy` 是同一份
  代码),用 `node` 跑在**agent 的镜像里——因此镜像需要 node**——或 `proxyImage` 里,加固方式与 agent
  容器相同。
- **拒绝即事件。** 每个被拒绝的请求都会写入 `<运行目录>/egress/` 的一行,运行把它变成
  `egress_denied` 事件(`{ host, port, method, agent }`,步骤则为 `commandId`),出现在
  `odw logs` 与看板中——每次运行最多 200 条,运行结束时再用一行日志说明还有多少条;每个代理的日志
  最多 1 MiB。agent 由其代理 URL 中的用户名标识;丢掉用户名的 CLI 显示为 `agent: null`。这个名字只是
  提示而非证明——它由客户端发送,agent 可以改掉——但改了也得不到什么:同一代理后的 agent 白名单相同。
- **会被清理。** 运行结束时先删除代理,再删除网络;worker 被杀、或结束时有删不掉的,退出处理也会
  这样做。崩溃遗留的网络可用 `docker network ls --filter label=odw.run` 找到。`odw doctor` 会拉起代理,
  并在内部网络上的容器里期望第一个列出的主机返回 200、一个保留域名返回 403,且 example.com 解析不了。
- **安全的失败方式。** 忽略 `HTTPS_PROXY` 的 CLI 或工具完全没有网络:内部网络除了代理别无出路。
  不经代理走 HTTP(S) 的一切——SSH、裸 TCP、UDP——都会失败。白名单不同的 agent 用不同的网络与代理,
  所以 agent 用不了别人的代理。被放行的主机仍是受信任的:agent 能把代码发到任何被放行主机会转发的地方。
- **按名字,而非按站点。** 白名单限制的是连接所用的主机名,也就是这些名字解析到的服务器——而不是
  那里提供的站点。经 `CONNECT` 时,隧道里的 TLS 由 agent 掌控:它可以在 SNI 和内层 `Host` 头里写另一个
  站点(域前置,domain fronting),而被放行名字解析到的服务器——CDN 边缘、共享前端——可能会为它服务。
  放行 CDN 后面的一个名字,可能等于放行了该边缘代理的所有站点;尽量选不在共享前端后面的主机。

缺少引擎或镜像时,运行在第一个 agent 启动前就以 `ConfigError` 失败,并说明如何构建镜像;
`odw doctor` 做同样的检查,并运行 `docker run --rm --pull never --network none <镜像> true`
(不涉及模型)。配置了容器时启动横幅多一行沙箱信息,每个 agent 的 `agent_started` 事件与看板的 AgentView
带 `sandbox: { kind, engine, image, network }`(白名单时 `network: "allowlist"` 并附 `allow` 主机),运行 setup 记录 `sandbox` 供 `odw compare` 比较。
沙箱中的 agent 不记录 CLI 版本:版本探测在宿主上运行,宿主的 CLI 不是镜像里的那个。

**它保护什么,不保护什么。** 它让 agent——以及它运行的一切——读不到也改不了你文件系统的
其余部分(SSH 密钥、其他仓库、shell 配置、真实的 CLI 配置),只能以你的身份运行,也留不下
进程。它**不能**让你的代码远离模型:agent 仍会把读到的内容发给模型 API。在
`network: "default"`(默认值,因为 agent CLI 必须连到模型 API)下它拥有开放网络,可以把工作区
以及环境变量和登录中的密钥发往任何地方——请把密钥挡在 `agentEnv` 之外,不需要模型 API 的
地方都用 `network: "none"`(`exec()` 步骤默认就不联网),需要的地方用出站白名单
(`network: { allow: "adapter" }`):这样 agent 只能连到它的模型 API 和你列出的主机,经由一个
它在容器内改不了的代理,每次拒绝都有记录。工作区是可写的:agent 写在那里的东西
——原地工作时仓库里的 git hook、`package.json` 脚本、Makefile——会在你之后运行它时在宿主上
执行,所以请审阅改动(隔离 worktree 与 `odw apply` 有帮助)。容器与宿主共享内核,不是虚拟机。
无 root 的 Docker 有自己的 uid 映射,文件可能归另一个 uid 所有;SELinux 宿主上的绑定挂载可能
需要重新打标签。不支持 Windows 宿主。

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
启用)、`codex`(`exec --json` 每条命令、每次编辑、每条消息都输出一个事件)、`kilo`、
`opencode` 和 `agy`(每一步一个事件)这类 JSONL 适配器,或会打印心跳的包装脚本;并把值设得高于
健康 agent 最长的静默时段——工具调用里跑一轮很长的测试,同样不会有任何输出。

**单个 agent 的窗口**(Claude Code 方言):`agent(prompt, { stallMs: 1800000 })` 为这一次调用
单独设定卡死窗口(毫秒,此处为 30 分钟),取代其适配器和整个运行的 `stallTimeout`,重启次数
(`stallRestarts`)与失败方式(原因 `"stalled"`)不变。没有设置 `stallTimeout` 时它同样生效,
因此长扇出可以给慢的审查者更宽的窗口、给快的更窄;`stallMs: 0` 关闭这一次调用的看门狗。

### 单 agent 上限与死循环(ODW 扩展)

陷入循环的 agent 一直在输出,所以卡死看门狗永远不会触发;而 `--budget` 限制的是整个运行,
不是单个 agent。`limits` 限制的是一次 `agent()` 调用:

```js
await agent("修好失败的测试", {
  limits: { toolCalls: 200, costUsd: 3, outputTokens: 200000, seconds: 1800, repeat: 5 },
});
```

| 上限 | 何时触发 |
| --- | --- |
| `toolCalls` | agent 的工具调用次数(累计它的所有 CLI 运行)超过此值 |
| `costUsd` | 它的 CLI 报告的花费(美元)超过此值 |
| `outputTokens` | 它的 CLI 报告的输出 token 超过此值 |
| `seconds` | 从它第一次 CLI 运行开始已过去这么多秒 |
| `repeat` | 同一个工具调用——工具名加参数的哈希——**连续**出现这么多次(至少 2) |

这些上限**实时**执行,依据的是 CLI 运行时打印的内容:Claude Code 的 stream-json(tool_use
块与每条消息的用量;花费随最后的 `result` 到来)、Codex 的 `exec --json`(命令、文件改动、
MCP 与网页搜索条目;每一轮的用量)、kilo 和 opencode 的事件(工具调用;每一步的 token
与花费),以及 agy 的 stream-json(工具步骤;每一步的 token)。一旦越界,ODW 会像卡死一样立即杀掉该 agent 的 CLI 及其启动的所有进程,agent 以
`runaway` 失败:`agent_failed` 事件带有 `limitHit: { limit, max, value, evidence }`,错误
信息形如 ``adapter 'claude' ran away — limits.repeat=5: Bash `npm test` ×5 in a row``
(或 `41 tool calls > 40`、`$3.12 > $3.00`)。`runaway` 不会被 `transientRetries` 重试,在
`expect` 下也不算需要重跑的未达标——它的额度已经用完。`odw status` 列出失控的 agent 及证据,
`odw agents` 在值的位置显示证据,看板侧栏显示该 agent 的上限并标出触发的那一项。

`repeat` 统计的是**连续**调用,而不是「最近 2n 次中出现 n 次」:后者在健康的编辑—测试循环
(`npm test`、编辑、`npm test`、编辑……)上也会触发;而同样参数的同一调用接连出现,说明
agent 在两次之间做的事不可能改变结果。同一次调用的后续 CLI 运行(重试、重启)重新计数。

可以在配置中为所有 agent 设默认值,也可以按适配器设置;调用自己的 `limits` 逐键覆盖两者,
`null` 取消继承来的某项上限:

```jsonc
{
  "agentLimits": { "toolCalls": 300, "repeat": 6 },   // {}(默认)= 不设上限
  "adapters": {
    "codex": { "agentLimits": { "seconds": 1800, "repeat": null } }
  }
}
```

只输出文本的 CLI(`gemini`、`qwen`……)运行期间不报告用量:它们的 `outputTokens` 与
`costUsd` 只能在每次运行结束后检查,依据它报告的用量或回复字符数 / 4——运行日志会提示一次。
完全不报告美元花费的 CLI(Codex)无法触发 `costUsd`,日志同样提示一次——请改用 `outputTokens`。

### 限流、额度与登录

**ODW 扩展。** 每个失败的 agent 都会根据其 CLI 的退出状态和输出末尾被归类:`rate_limit`、
`quota`、`auth`、`timeout`、`stalled`、`not_found`(CLI 无法启动)、`permission`(工具
调用或审批被拒)、`model_unavailable`(请求的模型未知、已下线或该账号不可用)或
`exit`——另有四个类别,给"成功了"却拿不出证据的运行:`empty_reply`、
`unmet_expectation`、`"mcpFailures": "fail"` 下的 `mcp_unavailable`,以及
`orphaned_background`(回复时仍有后台任务在运行,`"orphanedBackground": "fail"` 或设了
`expect` 时)(见[检查 agent 的工作](#检查-agent-的工作odw-扩展));`out_of_scope`:
`"scopePolicy": "fail"` 下改动了声明范围之外文件的 agent(见[声明范围](#声明范围odw-扩展));`needs_input`:停下来提问却没人回答的 agent(见[agent 的提问](#agent-的提问odw-扩展));`model_substituted`:`"modelMismatch": "fail"` 下 CLI 报告由其他模型服务的 agent(见[实际服务 agent 的模型](#实际服务-agent-的模型odw-扩展));还有 `runaway`:触及[上限](#单-agent-上限与死循环odw-扩展)被杀掉的 agent。这个类别就是 `agent_failed` 事件上的 `reason`(CLI 说明了何时
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
- **不存在的模型**——CLI 不认识、已下线或该账号不可用("There's an issue with the selected
  model"、"The model `x` does not exist or you do not have access to it"、Gemini 的
  "models/x is not found for API version"、`ModelNotFoundError`、agy 的 "invalid model
  selection"、Cursor 的 "Cannot use this model")——归为 `model_unavailable`:从不重试,并像额度
  用尽一样让 agent 沿回退链换到下一个适配器。只看运行输出的最后几行,所以 agent 自己的工作里
  打印的 "model not found" 不会被误判。`odw doctor --models` 检查配置的 `models` 档位、
  `fallback` 链、默认适配器和 `.odw/workflows` 各阶段提到的每个模型,各发一条极短的提示,
  逐个报告 `ok`、`model_unavailable` 或 `other`。

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
        "auth": ["session expired"],
        "model_unavailable": ["no such model"]
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

### `agentType` 读取 agent 定义(ODW 扩展)

`agent(prompt, { agentType: "reviewer" })` 运行 Claude Code 子 agent 文件里定义的那个 agent
——带 YAML 前言的 Markdown,正文是它的提示词(https://code.claude.com/docs/en/sub-agents)——
无论这次调用跑在哪个 CLI 上:

```markdown
---
name: reviewer
description: Reviews a change for bugs
tools: Read, Grep, Glob
model: sonnet
effort: high
---
You are a meticulous reviewer. Report bugs only.
```

ODW 按 Claude Code 的方式查找——认前言里的 `name`,不认文件名:工作目录及其每一级父目录直到仓库根的
`.claude/agents/`(最近者胜),然后同样方式的 `.odw/agents/`(ODW 独有的位置,格式相同),
然后 `~/.claude/agents/`,最后是已安装且启用的 Claude Code 插件的 `agents/`,名字为 `<plugin>:<name>`。映射如下:

| 字段 | ODW |
| --- | --- |
| 正文 | 作为人设提示词,取代原来的一句话人设,所有 CLI 都生效。 |
| `model` | 该调用的默认模型;`agent()` 自己的 `model` 优先,它又优先于阶段的默认值。在 `claude` 上原样传;其他 CLI 上别名经同名的 `models` 层级映射(`"models": { "sonnet": { "codex": "gpt-5.5" } }`),映射不到就用该 CLI 的默认模型,并在运行日志里说明。`inherit` 表示不指定。 |
| `tools`、`disallowedTools` | 给 agent 的[权限档位](#权限档位odw-扩展)封顶,只降不升:只有 Read、Glob、Grep、WebFetch、WebSearch → `read`;不含 Bash → 最高 `edit`。`claude` 另外拿到 `--tools`(与档位自带的列表取交集,只收窄)和 `--disallowedTools`(一个逗号分隔的参数)。每一项必须是工具名,可带规则(`Read`、`Bash(git *)`、`mcp__gh__issue`);其他的——以 `-` 开头、含空白——被略去并记入日志。`tools` 里的规则按其工具计,但不会被强制(`--tools` 只接受工具名),日志会说明。 |
| `isolation: worktree` | 等同 `agent()` 的 `isolation: "worktree"`。 |
| `effort` | `claude --effort`、`codex -c model_reasoning_effort=`(minimal–xhigh);其他 CLI 上日志会说明未生效。 |
| 其他字段 | `permissionMode`、`maxTurns`、`mcpServers`、`hooks`、`skills` 等不生效,日志逐个列出。 |

每个定义每次运行只读一次,并连同文件路径记入日志;`agent_started` 带 `agentType: { name, source, path, sha256 }`,
看板的 agent 抽屉会显示,`odw compare` 会列出两次运行之间文件变了的定义(`agentDefinition.<name>`)。
找不到定义时保留一句话人设,并记一条日志。`--untrusted` 运行中,来自仓库的定义只取正文、tools 与 isolation,
不取 model 和 effort;并且用户自己的与插件的定义优先:仓库里同名的定义不会遮蔽它们(日志会指出)。
名字里带 `:` 的只能是插件的 agent;自称 `x:y` 的定义会被拒绝。定义文件是符号链接时,只有链接目标仍在
它所在的 agents 目录内(用户的:在用户主目录内)才会被读取。适配器在 `flags` 里声明承载方式:`effort`(元素里可写 `{effort}`)、`effortLevels`、`tools`、`disallowedTools`。

```sh
odw agents types                  # 列出这里能用的定义,以及在默认适配器上的映射
odw agents types --adapter codex --json
```

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

**交接工作,而不是从头再来。** 默认情况下回退会让 agent 的工作从头开始:隔离 agent 做了一半
的 worktree 被丢弃,下一个 CLI 再花额度把上一个做过的重做一遍。配置
`"fallback": { "handoff": true }`(`handoff` 在这里是保留键,不是适配器)或
`agent(prompt, { handoff: true })`(两个方向都覆盖设置)后,下一个适配器会接着做:

- 隔离 agent 的 worktree 保留下来:下一个适配器在其中运行,做了一半的改动原样在场——并且在
  该调用的每次运行中(卡住后的重启、限流重试、schema 重试)都沿用它。原地 agent 的改动本来就在
  源码树里。worktree 只交给信任级别和容器引擎都相同的适配器:不受信任或沙箱不同的回退会在新的
  worktree 中开始,仍然拿到简报,简报会说明之前的改动没有带过来。
- 它的提示词在任务之前加一段以 *"You are continuing work another agent started…"* 开头的
  交接简报:上一个适配器停下的原因、改过的文件(worktree 的 diff 统计;原地 agent 取其编辑
  类工具调用涉及的文件)、它最后写下的计划或待办(Claude Code 的 `TodoWrite`、Codex 的计划)、
  运行过的命令及其结果、最后几条消息(文本 CLI 取输出末尾)。至多 6 KB,每一部分都先脱敏
  再截断。推理过程无论如何都会丢失——简报是其中看得见的部分,精简到下一个 agent 需要的
  程度。
- 简报保存为 `agents/<id>.handoff.md`;`handoff` 事件 `{ from, to, reason, bytes }` 记录这次
  交接,transcript 在下一个适配器的 `attempt` 行之前有一行 `{"kind":"handoff",…}`
  (`odw logs --agent` 会显示;看板侧栏把简报折叠在其中)。
- `expect` 与保留的 diff 判定最终状态:共享 worktree 相对其基线的 diff,两个适配器的工作都在
  其中。`expect` 重试仍在新的 worktree 中从头开始,等待额度重置(`quotaWait`)之后的调用也
  一样。交接属于同一次调用:`odw resume` 照旧重放该调用。

```jsonc
{ "fallback": { "codex": ["claude"], "handoff": true } }
```

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

### 同一个 CLI 的多个账号

**ODW 扩展。** 如果你有不止一个 Claude Code 或 Codex 登录,`accounts` 让一次运行把它们
都用上,不必在某个账号额度用完时手动重新登录。每一项都会成为一个独立的适配器
`<适配器>@<名字>`:

```jsonc
{
  "accounts": {
    "claude": [
      { "name": "work", "configDir": "~/.claude-work" },
      { "name": "home", "configDir": "~/.claude-home", "concurrency": 2 }
    ],
    "codex": [{ "name": "team", "configDir": "~/.codex-team" }]
  }
}
```

- `claude@work` 就是 `claude` 适配器,只是把该 CLI 文档中的配置目录变量设为这个账号的目录:
  Claude Code 用 `CLAUDE_CONFIG_DIR`,Codex 用 `CODEX_HOME`。每个账号先手动登录一次:
  `CLAUDE_CONFIG_DIR=~/.claude-work claude auth login`、`CODEX_HOME=~/.codex-team codex login`。
  其他 CLI 一律拒绝:ODW 不知道有哪个变量能把两个登录分开。
- 每个账号有自己的并发上限(取其适配器的 `concurrency`,或该项自己的)和自己的额度熔断;
  其余定义与其适配器相同。每一项接受 `name`、`configDir`(绝对路径或 `~/` 开头)、
  `concurrency` 和 `label`。
- `agent(…, { adapter: "claude" })`——以及默认适配器、提到 `claude` 的回退链——表示
  *任意一个 claude 账号*:这次调用得到一条由这些账号组成、按余量排序的链,某个账号用完时
  **交接工作**(与 `"fallback": { "handoff": true }` 相同;`agent(…, { handoff: false })`
  则从头开始)。`adapter: "claude@work"` 只在这个账号上运行。
- **余量**在每次路由调用时计算:不处于额度暂停的账号在前(额度熔断已把它移出,或在
  `quotaWait` 下额度用完、等待重置),其次是本次运行中额度失败最少的,再次是本次运行中
  已路由到它、尚未结束的 agent 最少的;相同时保持配置中的顺序。扇出因此会分散到各个账号。
- 模型档位里没有 `claude@work` 的 id 时,使用 `claude` 的。
- agent 的适配器在事件、实时视图、看板抽屉与花费小票中都显示为 `claude@work`;`odw status`
  按账号分组列出 agent(`accounts of claude: claude@home 2 agents · claude@work 1 agent, 1 moved on`)。
- `odw doctor` 不调用模型地检查每个账号的登录——用该账号的目录运行 `claude auth status`
  或 `codex login status`——`odw doctor --smoke --adapter claude` 会通过每个账号各发一次提示词。
- 在容器沙箱中,复制(或绑定)进容器 home 的是该账号的目录,而不是 `~/.claude`。

能否把多个账号合在一起使用,取决于各服务商的服务条款:配置多个账号之前请先确认。ODW
只是在你提供的登录之间切换。

### 本地模型:检查推理服务,把廉价阶段交给它(ODW 扩展)

**ODW 扩展。** 本地模型(Ollama、LM Studio)通过能连接它们的 agent CLI 运行——在
`opencode.json` 里配置了提供方的 `opencode`、`codex --oss`,或你自己的适配器;没有内置的
`ollama` 适配器。它们的失败是静默的:Ollama 以较小的上下文窗口加载模型,提示放不下时就
截掉前面的部分——也就是 CLI 的说明和工具定义——照样返回 HTTP 200。agent CLI 使用的
OpenAI 兼容 `/v1` 端点会忽略请求里的 `num_ctx`,只有服务端的 `OLLAMA_CONTEXT_LENGTH`
能调大它。`odw doctor --local` 在运行之前把这件事查出来:

```bash
odw doctor --local                                   # :11434 上的 Ollama、:1234 上的 LM Studio
odw doctor --endpoint http://gpu-box:11434           # 你指定的服务(隐含 --local)
odw doctor --local --model qwen3-coder:30b --smoke   # 再加一个约 10K token 的截断探针
```

- **只读。** Ollama 的 `/api/version`、`/api/ps`、`/api/tags` 和 `/api/show`,或 OpenAI 兼容
  服务的 `/v1/models`(以及 LM Studio 的 `/api/v0/models`)。不拉取、不加载、不修改任何东西。
  你指定的服务没有应答算检查失败;默认端口上什么都没有,只给一条警告。
- **每个已加载的模型**(或 `--model` 指定的那个):它实际加载的上下文长度——**低于 32K 时
  警告**,并给出调大的方法(`OLLAMA_CONTEXT_LENGTH=32768 ollama serve`;macOS 应用用
  `launchctl setenv`;systemd 用 `systemctl edit ollama`;然后看 `ollama ps` 的 CONTEXT
  列)——以及它是否声明了工具调用能力。Ollama 版本低于 0.13.4(`codex --oss` 指南要求的版本)
  时警告。普通的 OpenAI 兼容服务既不报告上下文也不报告工具能力,检查会如实说明。
- **`--smoke`**(与 `--local` 同用)向 `/v1/chat/completions` 发一次请求:一个约 10K token
  的提示,第一行是随机口令,最后一行要求回复这个口令。回复里没有口令——前面被截掉了,或者
  末尾的指令被忽略——就是一项失败的 doctor 检查(不是运行的失败原因),并附上服务端统计的
  提示 token 数。探针只发往本机或局域网上的服务(回环、私有和链路本地地址、不带点的主机名、
  `.local`、`.lan`、`.internal`、`.home.arpa`),从不发往 Ollama 的云端模型,也不带任何凭据。
  `--timeout <秒>` 限定时长(默认 180)。与 `--local` 同用时,只有 `--adapter` 指名的适配器
  才会一并做冒烟测试。
- 这些探测只属于 doctor;运行仍然只通过 CLI 访问模型。

**配方:侦察在本地,规划和审阅在云端。** 借助[模型档位](#按阶段路由与回退链odw-扩展),
`meta.phases` 里廉价的阶段跑在本地模型上,其余留在云端模型:

```jsonc
// odw.config.json —— "ollama/…" 是 opencode 的 提供方/模型 id,提供方即其 opencode.json 中声明的那个
{
  "models": {
    "local": { "opencode": "ollama/qwen3-coder:30b" },
    "strong": { "claude": "opus", "codex": "gpt-5" }
  }
}
```

```js
export const meta = {
  name: 'triage',
  description: 'Sort the issues locally; plan and review the fixes in the cloud.',
  phases: [
    { title: 'Scout', adapter: 'opencode', model: '@local' },
    { title: 'Plan', adapter: 'claude', model: '@strong' },
    { title: 'Review', adapter: 'claude', model: '@strong' },
  ],
}
```

模型加载后跑一次 `odw doctor --local --model qwen3-coder:30b --smoke`,服务端设置变化后再跑一次。

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
  "on": ["done", "failed", "stopped"]              // 默认:所有终态;"waiting"、"paused" 和 "digest" 需显式加入
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
写明回答命令的 `text`。有 `odw serve --public-url` 在运行时,它们还会带上该检查点签名的一次性
批准与拒绝链接——见[在手机上批准](#在手机上批准odw-扩展)。[agent 的提问](#agent-的提问odw-扩展)
也触发同样的 hook:载荷的 `checkpoint.kind` 为 `"question"`(普通检查点为 `"checkpoint"`),
`checkpoint.question` 写明提问的 agent(`{ agentId, label, adapter }`),命令多出
`ODW_CHECKPOINT_KIND` 与 `ODW_QUESTION_AGENT`,`text` 行提示用 `odw approve … --note` 回答。

加上 `"paused"`,就能在运行[因额度用尽而暂停](#额度用尽时暂停odw-扩展)时收到通知——每次
暂停一次,继续时不再通知:命令的环境变量带有 `ODW_RUN_STATE=paused`、`ODW_PAUSED_ADAPTER`
和 `ODW_RESUME_AT`(Unix 秒);webhook 收到 `"state": "paused"`、一个
`"pausedFor": { "reason": "quota", "adapter", "resumeAt" }` 字段,以及一行类似
`odw · nightly paused until 19:10 (codex quota) · odw resume <run> goes on now` 的 `text`。

由[签名触发器](#由-webhook-启动运行githublinearslackodw-扩展)启动的运行(ODW 扩展)还会在每个
payload 中带上它的 `context`——`{ trigger, provider, event, deliveryId, id, url, repo, channel,
threadTs }`(webhook 有的才有)——命令则得到 `ODW_TRIGGER`、`ODW_EVENT_ID`、`ODW_EVENT_URL`
和 `ODW_CONTEXT`(完整 JSON),于是钩子能在工作来源的 issue 或线程里回复:
[`docs/recipes/triggers.md`](docs/recipes/triggers.md)。

加上 `"digest"`(ODW 扩展),`odw digest --notify`——手动运行或由 `odw schedule add <name> --digest`
触发——就会把[跨运行晨报](#晨报odw-digestodw-扩展)发送一次:命令的环境变量带有 `ODW_RUN_STATE=digest`、
`ODW_DIGEST_TEXT`(一行摘要)、`ODW_DIGEST_FILE` 与 `ODW_DIGEST_MARKDOWN_FILE`(命令结束后删除)、
`ODW_DIGEST_SINCE`、`ODW_DIGEST_NEEDS_YOU` 和 `ODW_DIGEST_FAILED`;webhook 收到 `"kind": "digest"`、
晨报各字段(`needsYou`、`failed`、`unmet`、`changes`、`spend`、`counts`、`since`、`until`)、
`markdown`,以及承载 markdown 的 `text`/`content`(`content` 截到 Discord 的 2000 字符)。

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
- **`worktreeTeardown`**(**ODW 扩展**)与之相对:在 worktree 删除之前、在同一个工作区里、带着
  同样的变量运行——不论 agent 成功、失败还是被停止(`odw stop`、worker 收到信号),setup 中途
  失败时也会运行。超过 `worktreeTeardownTimeout` 秒(默认 120)就会被杀掉;失败或超时只在该
  agent 名下记一行日志,不影响 agent 的结果。

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

隔离 agent 还会拿到 `ODW_SLOT`(**ODW 扩展**):`odw-<run>-<agent>`——运行 id 的随机部分加
agent id,例如 `odw-a1b2c3-4`——只含小写字母、数字和连字符,在这次调用的每次尝试、它的 setup
和 teardown 中都相同。`COMPOSE_PROJECT_NAME` 被设为它——即使你自己设置了,也会被覆盖,运行日志会
说明一次——于是在 worktree 里执行 `docker compose` 操作的就是这个 agent 自己的那套栈,不会是你的,
并行的 agent 也不会共用一套。尽管如此,仍请显式指定项目名(`docker compose -p "$ODW_SLOT" …`),
如下面的配方所示。它也可以用作数据库名或卷名前缀(不允许连字符的地方加引号,或把连字符换成下划线)。

#### 配方:每个 agent 一套 compose 栈和独立数据库

每个隔离 agent 在自己的端口上起自己的服务,并在 worktree 删除前把它们连同卷一起拆掉——
不论成功、失败还是被停止:

```yaml
# compose.yaml —— 项目名在命令行上指定:-p "$ODW_SLOT"
services:
  db:
    image: postgres:16
    environment: { POSTGRES_PASSWORD: dev, POSTGRES_DB: app }
    volumes: [data:/var/lib/postgresql/data]
  app:
    build: .
    ports: ["${ODW_PORT}:3000"]
    environment: { DATABASE_URL: "postgres://postgres:dev@db:5432/app" }
    depends_on: [db]
volumes:
  data: {}
```

```jsonc
{
  "worktreeSetup": "docker compose -p \"$ODW_SLOT\" up -d --wait && npm run migrate",
  "worktreeTeardown": "docker compose -p \"$ODW_SLOT\" down -v --remove-orphans",
  "worktreeTeardownTimeout": 120
}
```

```js
await parallel(['grid', 'list'].map((layout) => () =>
  agent(`Build the ${layout} layout; the app runs on http://localhost:$ODW_PORT with its own database.`,
    { isolation: 'worktree', label: layout })))
```

这样迁移只会落到这个 agent 自己的数据库,不会碰共享库;teardown 的 `down -v` 也只删除这个 agent
的栈和卷——不论环境里有什么,`-p "$ODW_SLOT"` 都指定了它。worker 被直接杀掉(SIGKILL、第二次信号)
时,teardown 来不及运行:`odw gc` 会列出所属运行已不再活跃的 `odw-*` compose 项目,并给出要执行的
`docker compose -p <name> down -v`——它自己从不删除。ODW 不克隆数据库,也不管理不是它启动的服务。

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
odw apply $RUN --all --resolve --verify "npm test"   # 由 agent 解决冲突;校验通过后才应用
odw apply $RUN --all --pr --verify "npm test"   # 新分支、每个 agent 一个提交、推送、开草稿 PR(gh)
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

`--resolve`(配合 `--all` 或 `--agent`)遇到 diff 会冲突的 agent 时不再停下,而是交给一个
解决冲突的 agent。odw 在 diff 将要落地的状态上建一个临时 worktree——HEAD、索引(包含此前已应用
的 agent)、以及该 agent 能干净应用的文件——并在其中用默认 adapter(或 `--adapter A`)启动一个
resolver 运行,告诉它每个冲突文件的 base、双方版本和冲突行,要求保留双方意图、不碰其他文件。
只有当它的改动只涉及冲突文件、不留冲突标记、并在该 worktree 里通过校验命令(`--verify` 或
`applyVerify`)时,才会连同该 agent 的干净文件按常规方式应用到你的工作树;`--all` 随后继续,
并重新预览其后的 agent。任何一步不满足,你的工作树都不会被改动,odw 会说明原因。`--confirm`
在应用前展示解决后的 diff 并询问 y/N(需要终端)。resolver 是一个真正的运行——meta.json 里有
`origin: "apply-resolve"` 和 `applyResolve: { runId, agentId }`;`odw apply` 会打印它的 id,
`odw diff`、`odw logs`、`odw compare` 和看板都适用——被应用的运行则通过 meta.json 的
`resolvedBy` 和一条 `apply_resolved` 事件(`outcome`:applied、refused、declined 或
interrupted)链接到它。`--resolve` 不能与 `--force` 或 `--check` 同用:有未提交改动挡路的路径
照旧拒绝。(ODW 扩展。)

`--pr`(配合 `--agent` 或 `--all`)不碰你的工作树,而是开一个 pull request——它既不读也不写
你的工作树,所以那里未提交的改动原样保留,也不会进入 PR。odw 在临时 worktree 里从 `--base <分支>`
——否则从 HEAD 所在提交,目标为 HEAD 所在分支——建分支 `odw/<run>-<label>`(`--all` 时为
`odw/<run>-all`;名字在本地或远端已被占用时加 `-2`、`-3`……),在那里按上文的方式逐个预览并应用
每个 agent(`--verify` 也在那里运行),每个 agent 单独一个提交,使用**你自己的** git 身份和签名
设置;提交说明包含工作流、agent、diff 统计、运行 id,以及 CLI 报告了时该 agent 的花费。任何
agent 会冲突或校验失败,都会在推送前停下:分支被删除,什么都不会离开本机。之后推送到 `--remote`
(默认 `origin`),并运行 `gh pr create --repo <该远端的 owner/name>`——默认是**草稿**,加 `--ready` 则不是;标题为 `--title`
或按工作流和 agent 生成——正文是运行摘要:各 agent 及其提交、各阶段、以表格呈现的花费明细、
校验结果和 `odw diff` 命令。没有 `gh` 或 `gh` 未登录时,推送后停下并打印对比页 URL。**它从不合并。**
(ODW 扩展。)

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

#### 跨运行的审阅队列(ODW 扩展)

保留的 diff 在各次运行里越积越多,远快于有人去看。`odw review` 列出运行根目录下所有运行里
还没人处理过的 diff,风险最高的在前,并说明每一条为什么排在这里:

```bash
odw review                       # 尚未审阅、放弃或应用的 diff,按风险从高到低
odw review --since 7d --json     # 只看最近一周的运行,供脚本使用
odw review --all                 # 连同已标记的,以及是谁标记的
odw review mark $RUN 3 reviewed --note "看过迁移了"   # 或 dismissed | applied | open(撤销)
```

分数是确定性的,只用运行记录下来的数据——不让任何模型来读。计分项:改动大小(50 / 300 / 1000
行:+1 / +2 / +3;6 / 20 个文件:+1 / +2);从保留的 diff 中读出的路径类别——CI(+3)、数据库迁移
(+3)、鉴权/安全相关代码(+3)、依赖清单与锁文件(+2)、测试(+1,删除测试再 +2)、二进制文件
(+2);在 `maxDiffBytes` 处被截断的 diff(+2);被 `--deadline` 终止的 agent(+3);`expect` 未达成
(+4)与 `untouched` 违规(+4);其他失败(+3:改动是未完成的工作);`scope` 之外的文件(+3);
留下仍在运行的后台任务(+2);破坏性 git 命令(+3);回退或 handoff(+1);`odw apply --resolve`
时跑过解决冲突的 agent(+1);`expect` 重试(+1)与其他重试(+1);花费达到 $1 / $5(+1 / +2)。
`expect.command` 检查通过则减一分。0–2 为 **low**,3–5 为 **medium**,6 及以上为 **high**。每一分
都打印在条目上(`--json` 中为 `factors`),排序有据可查。

标记写入运行目录中只追加的 `reviews.jsonl`——`{ ts, agentId, state, by, via, note? }`,`by` 是标记者
(与检查点决定一致:本地用户,或看板上具名令牌的名字),`via` 为 `cli`、`dashboard` 或 `apply`;
同一个 agent 以最后一条标记为准。`odw apply` 会把干净应用(或发现已应用)的每个 agent 标为
`applied`;`--check` 不做标记。`odw eval` 启动的运行和 `--resolve` 的解决冲突运行不进入队列。
看板的 **Review** 页(`g r`)展示同一队列及其理由,可把条目标为已审阅或放弃(与所有写操作一样
仅限回环地址——在那里也与所有写操作一样,服务接受的任何令牌都可以,`read` 范围的也不例外),并能在所属运行的 Changes 标签页中打开条目;Activity 的 **待你处理** 会显示等待
审阅的数量。`GET /api/review[?since=7d][&all=1]` 提供该队列,`POST
/api/runs/:id/agents/:agentId/review { state, note? }` 标记一条。

分步说明:[`docs/recipes/review-and-apply.md`](docs/recipes/review-and-apply.md)。

#### 按周看产出结果(ODW 扩展)

一次 eval 的通过率只说明那一次过没过,说明不了 agent 的产出有多少真的被人接受。`odw outcomes`
跨运行、按周统计这件事,只用运行记录下的证据和审阅标记——没有任何模型参与评判:

```bash
odw outcomes                         # 最近 30 天:按周、工作流、适配器、模型
odw outcomes --since 12w --workflow triage --json   # --since 最多 156w(三年)
odw outcomes --markdown              # 表格,方便贴进 PR 或 wiki
```

各项统计的含义:

- **kept / applied / dismissed / reviewed / left**——保留了 diff 的 agent,按它在
  `reviews.jsonl` 里的最后一条标记归类(`odw apply` 标 `applied`,`odw review mark` 与看板标其余);
  `left` 是没有标记或被放回队列(`open`)的。标记按现在的状态读取,所以运行一周后才应用的 diff 也算在那次运行上。
  「已应用」只看 ODW 自己的标记,不读 PR 的合并状态。
- **failed**——失败与 stale 的运行,原因取其失败 agent 中最多的那个,没有则为 `stale` 或 `script_error`;
  agent 级的失败也按原因计数。
- **rework(返工)**——需要重试(`expect`、限流、卡死、提问)、回退/交接,或在 `odw apply --resolve`
  时需要解决冲突的保留 diff;以及 `odw replay` 发起的运行。
- **per applied change(每个已应用改动的花费)**——该行的全部花费(包括失败的 agent)除以已应用改动数:
  有 agent 报告美元时用美元,否则用 token。
- **与上一个时间段对比**——紧挨着的同样长度的时间段;比例变化 15 个百分点以上(两边各至少 5 个样本),
  或每个已应用改动的花费变化一半以上(两边各至少 3 个)时会标出来。

运行按创建时间计入时间窗。不计入:dry run、仍在进行的运行,以及 `odw eval`、`odw test`、
`odw conformance` 和 `odw apply --resolve` 发起的运行。`odw pull` 拉回的运行一并计入;其他机器的运行根目录各自统计。
工作流行按运行计数;适配器/模型行按 agent 计数,只有它自己的 agent 在某次失败运行里失败时才把那次失败记在它头上。
模型取 CLI 报告实际服务的模型,否则取请求的模型(`… (requested)`),否则为 `(CLI default)`。
看板的 **Review** 页顶部有一张最近 30 天的 **产出结果** 卡片——已应用/保留、按周的堆叠柱、显著变化、
每个工作流一行——数据来自 `GET /api/outcomes[?since=30d][&workflow=W]`。

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
| [`pr-shepherd.js`](examples/pr-shepherd.js) | 给一个 PR 编号 → 用 `gh` 等待 CI → 隔离的修复 agent 处理红掉的检查和新的评审意见,由 `expect` 校验 → 修复推送到 PR 分支 → `gh pr ready` 之前先过 `checkpoint()`;从不合并,可用 `odw schedule` 定时运行(仅 ODW) |
| [`coordinated-refactor.js`](examples/coordinated-refactor.js) | 多个隔离分支在笔记板上并行修改同一仓库,每个分支落地时广播其接口改动 → 审阅者指出相互冲突的分支 → 这些分支在知道别人改了什么之后重跑(仅 ODW) |

## 开发

```bash
npm ci                # 安装锁定版本的构建依赖
npm run build         # tsc → dist/
npm test              # node:test 测试套件,由 mock 适配器驱动(无需真实账号)
npm run typecheck     # tsc --noEmit
npx tsx src/cli.ts conformance   # 方言一致性测试套件(conformance/);npm test 也会运行
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
- **`odw doctor [--smoke] [--models]`** 检查运行环境、配置和每个适配器;加 `--smoke` 会发一条真实
  提示,揪出那些无头模式下没有回答却以 0 退出的 CLI;加 `--models` 则给配置和工作流提到的每个
  「适配器/模型」组合各发一条。
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
