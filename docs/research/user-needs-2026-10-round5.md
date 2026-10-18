# ODW 用户需求调研 · 第五轮（2026-10-18）

范围：ROADMAP 0.6（R1–R12）、0.7（S1–S9）、0.8（T1–T9）全部交付后，用户**仍未被满足**的需求。
本轮专门看前四轮没碰过的角度：工作流编写的上手与调试、团队/社区共享与版本固定、多仓库、agent 之间的交接、
产出质量随时间的变化、IDE/tmux/手机上的可见性、企业策略与成本分摊、以及 2026 年下半年的新趋势（ACP、Claude Code 的 Workflow 工具本身）。
前四轮写过的主题不再重复：成本可见与预估、限流/额度、resume/replay、diff/apply（含 `--resolve`/`--pr`）、笔记板、范围声明、检查点与手机审批、
孤儿后台任务、死循环上限、出网白名单、触发器与 GitHub Action、`odw test`/`--dry`、漂移监测、多账号、工作流记忆、具名令牌、`odw new`、
agent 提问、`odw gc`、保险快照、不可信输入、审阅队列、`ODW_SLOT`、晨报、严格脚本上下文、本地模型。

方法：约 35 次检索。GitHub issue 一律用 `gh issue view` / `gh search issues` 打开原文核对（日期、状态、评论数、反应数均取自 GitHub）；
Claude Code 官方文档（workflows、sub-agents）、ACP 更新页、Adaline、Hamel Husain、Thoughtworks 技术雷达、buildthisnow 已打开核对；
标「（检索摘要）」的链接只读了搜索结果摘要，未逐字核对；标「（单一来源）」的说法没有找到第二个独立来源。
「ODW 现状」逐条对照了 `odw --help`、`README.md`、`types/workflow.d.ts` 与 `src/` 下的相关模块（文件名写在条目里）。

频度标记：**高** = 多个独立来源、近期仍有新报告；**中高** = 若干独立来源；**中** = 少数来源但问题明确；**低中** = 主要是专家或单一来源。

一个总体观察：Claude Code 的 dynamic workflows（2026-05-28 发布）进入第五个月，它自己的 issue 区开始出现大量**方言层面**的问题——
`agentType` 不读 agent 定义、`stallMs`、请求的模型和实际模型对不上、VS Code 里没有 `/workflows`。这些恰好是 ODW「一份脚本、多种 CLI、本地观测台」可以直接回答的，
所以本轮的前几项偏向**方言保真**与**可见性**，而不是新的大功能。

---

### 1. `agentType` 只是一个名字：自定义 agent 的工具白名单、模型、隔离、effort 全部丢失 —— 中高 · M

**痛点：** 用户在 `.claude/agents/<name>.md` 里定义了 agent（系统提示词正文 + `tools`、`model`、`isolation`、`effort` 等前言），
在工作流里写 `agent(prompt, { agentType: "<name>" })`，期望得到「那个 agent」。结果拿到的是一个默认权限、默认模型、在主目录里跑的通用 agent，且没有任何提示。

**证据：**
- anthropics/claude-code#102657（2026-10-16，open）：`agentType` 忽略前言里的 `isolation: worktree`；"three parallel writer agents from one script all started in the same checkout. One agent's `git checkout -b` moved HEAD under the other two"。https://github.com/anthropics/claude-code/issues/102657
- anthropics/claude-code#102096（2026-10-14，open）：`agent()` 静默去掉 agent 定义里声明的 `Agent` 工具，"The removal is silent. Nothing in the agent's transcript or the workflow log says a declared tool was dropped"，影响官方 claude-security 插件。https://github.com/anthropics/claude-code/issues/102096
- anthropics/claude-code#63762（2026-05-29，closed）：定义了 `tools: Read, Glob, Grep` 的 agent 在工作流里 "ran with `Read, Write, Edit, Glob, Grep` and wrote a file to an arbitrary path"；请求 "honor the agentType's `tools:` / `disallowedTools`"，或者让 `agent()` 能直接设最小权限。https://github.com/anthropics/claude-code/issues/63762
- `effort` 前言不生效是同一类问题的另一面：#64706（closed，"All subagents inherit the global `effortLevel`"）、#80569（2026-07-23，open，agent team 也忽略 `effort`）、#67647（closed，请求按子 agent 控制 effort）。
  https://github.com/anthropics/claude-code/issues/64706 · https://github.com/anthropics/claude-code/issues/80569 · https://github.com/anthropics/claude-code/issues/67647
- 官方 sub-agents 文档列出的前言字段：`tools`、`disallowedTools`、`model`（别名或完整 id、`inherit`）、`permissionMode`、`maxTurns`、`effort`、`isolation` 等；
  查找顺序是 managed → `--agents` → `.claude/agents/`（从工作目录向上走到仓库根，最近者胜）→ `~/.claude/agents/` → 插件 `agents/`。https://code.claude.com/docs/en/sub-agents

**ODW 现状：** `agentType` 只被当成人设名：`src/bridge.ts` 的 `personaPreamble()` 往提示词里加一句 "Take on the role of the "<name>" agent"，
`src/router.ts` 的 `noteAgentType()` 记一条「通过提示词注入」的说明。**不读取任何 agent 定义文件**——正文提示词、工具白名单、模型、`isolation`、`effort` 都没有生效，
在 ODW 上同样是「静默的方言降级」，违反 ROADMAP 第 1 节「不做静默降级」。这一点 ODW 比 Claude Code 更有条件做好：它已经有权限三档（X2，只能降档）、按适配器的模型分层（S5/X7）和 worktree 隔离。

**方向（M）：** 见 U1。

---

### 2. 方言细节的漂移：`stallMs` 被静默忽略、monorepo 中嵌套的 `.claude/workflows` 找不到 —— 中 · S

**痛点：** Claude Code 的 Workflow 工具在 5–10 月间补了一些方言细节，按官方文档写的脚本在 ODW 上会出现「接受了但没生效」或「找不到」。

**证据（官方文档，已核对）：** https://code.claude.com/docs/en/workflows
- 每个 agent 的卡死窗口："**One agent**: pass `stallMs` in milliseconds on its `agent()` call, such as `agent(prompt, { stallMs: 1800000 })` for 30 minutes"。
- monorepo："Project workflows also load from every `.claude/workflows/` along that path, and when more than one defines the same name Claude Code runs the one closest to the working directory."
- 一次 `parallel()`/`pipeline()` 最多 4,096 项，"the runtime rejects a longer list with an error"——"A silent cap would drop part of the workload without telling the script"。
- 相关用户报告：#66686 里一次约 70 个 agent 的审查，"a network blip silently killed 26 agents"——长任务需要按 agent 调整卡死窗口而不是全局放宽。https://github.com/anthropics/claude-code/issues/66686

**ODW 现状：**
- `stallMs`：`src/` 中只有配置级 `stallTimeout`（`src/adapters/runner.ts`），`agent()` 选项里没有 `stallMs`，`types/workflow.d.ts` 也没有；传入后被静默丢弃。
- 嵌套目录：`src/workflows/resolve.ts` 的 `searchRoots()` 只看 `<cwd>/.odw/workflows` 与 `<cwd>/.claude/workflows`，不向上走到仓库根；在 `packages/foo/` 下 `odw run <名字>` 找不到根目录的工作流，也不会优先包内的同名工作流。
- 4,096 项上限：ODW 没有这个上限（只有 `maxAgents: 1000`，与 Claude Code 一致）。这不算缺陷，但值得在 `odw check` 里提示「这个脚本在 Claude Code 上会被拒绝」，因为方言双兼容审计（`src/dual-compat.ts`）本来就是做这件事的。

**方向（S）：** 见 U2。

---

### 3. 「我请求了模型 X，实际跑的是哪个？」—— 中高 · S

**痛点：** 按 agent 指定模型（省钱或保质量）之后，用户无法确认它真的生效；账单或用量显示的却是另一个模型。

**证据：**
- anthropics/claude-code#102655（2026-10-16，open）："there is no way to confirm which model each agent actually ran on … Today I can only say a model was *requested*, never that it was *used*." https://github.com/anthropics/claude-code/issues/102655
- anthropics/claude-code#73597（2026-07-02，closed，17 条评论）：在 ultracode 工作流里把子 agent 设为 opus 4.8，计费却记成 Fable。https://github.com/anthropics/claude-code/issues/73597
- anthropics/claude-code#82466（2026-07-30，open）：settings 里的默认模型在会话开始时不被采用。https://github.com/anthropics/claude-code/issues/82466
- 官方 workflows 文档：组织的 `availableModels` 白名单挡住脚本请求的模型时，"that agent runs on a substituted model instead"——替换是设计行为，但用户看不见。https://code.claude.com/docs/en/workflows
- openai/codex#31814（2026-07-09，closed，100 条评论、206 个反应）：GPT-5.6 Sol 下子 agent 无法指定模型。https://github.com/openai/codex/issues/31814
  （这一条 ODW 已经覆盖：按 agent/阶段指定适配器与模型是 X7/S5 的能力；列在这里是为了说明「按 agent 选模型」需求很大，而验证它的那一半缺失。）

**ODW 现状：** `agent_started` 事件记录**请求的**模型（`src/drift.ts` 据此做模型漂移检测），`model_unavailable` 失败原因（S5）能抓住「模型不存在」。
但 CLI 输出里**实际服务的模型**（claude stream-json 的 `system`/`init` 与 assistant 消息里的 `model`、`result` 的 `modelUsage` 键；其他 CLI 只在其 JSON 输出确有该字段时）没有被读取，
`src/adapters/usage.ts` 只解析 token 与花费。于是「请求 opus、实际 sonnet」这类静默替换在 ODW 里同样看不见，`odw compare`/`estimate` 也会把不同模型的成本混在一起。

**方向（S）：** 见 U3。

---

### 4. 多仓库改动：一份工作流要碰两个以上的仓库 —— 中高 · M

**痛点：** 前端 + 后端 + 共享库、或微服务群，需求天然跨仓库；现有 agent 都以一个仓库为根，跨仓库只能开多个互不知情的会话。

**证据：**
- openai/codex#11956（2026-02-17，open，25 条评论、54 👍 + 32 ❤️）："Multi-repo context is the main reason some of us are still stuck in the CLI … the common 'two repos + shared lib + infra' workflows"。https://github.com/openai/codex/issues/11956
- GitHub Community #190627：Copilot coding agent "sandboxed to a single repository"，建议「把跨仓库需求拆成以共享契约为界的单仓库任务，再手工或用工具协调」。https://github.com/orgs/community/discussions/190627（检索摘要）
- anthropics/claude-code#61434（2026-05-22，closed）：agent view 看不到 git submodule 组织的仓库；#61431（同日，closed）：重复的 `--add-dir` 第二个被静默丢弃。
  https://github.com/anthropics/claude-code/issues/61434 · https://github.com/anthropics/claude-code/issues/61431
- Daniel Vaughan 的 Codex 指南（2026-05-19）：每个仓库一个 Codex 会话、各开一个终端窗格，"neither session knows what the other is doing"。https://codex.danielvaughan.com/2026/05/19/codex-cli-cross-repository-development-multi-repo-sessions-coordination-patterns/（检索摘要）
- mabl 的实践：让 agent 在 75 个仓库里交付代码，靠每仓库说明书 + 校验流水线 + 人工批准合并。https://mabl.com/blog/how-we-built-a-system-for-ai-agents-to-ship-real-code-across-75-repos（检索摘要）
- ACP 在 2026-06-01 把「额外工作区根目录」定为稳定特性（见第 9 条），说明协议层也在为此铺路。

**ODW 现状：** 第四轮因「证据以厂商文章为主」暂缓；本轮补上了有大量反应的 issue。今天 `agent()` 没有 `cwd`/`repo` 选项（`src/primitives.ts` 的选项表），
运行只有一个 `--source`；`exec()` 有 `cwd`（`src/exec.ts`），但 agent 的 worktree 隔离、diff 保留、`odw apply`/`--pr`、`scope`、保险快照都只认一个仓库。
用 `workflow()` + 多次 `odw run --source` 可以勉强拼出来，但改动散落在多次运行里，无法一起审阅或一起回滚。

**方向（M）：** 见 U4。

---

### 5. 工作流跑起来之后看不见：IDE 里没有 `/workflows`，tmux 里没有窗格 —— 中高 · S–M

**痛点：** 在 VS Code / JetBrains / Antigravity 里用 Claude Code 的人，工作流启动后只剩输入框下的一行状态；习惯 tmux 的人想每个 agent 一个窗格实时看。

**证据：**
- anthropics/claude-code#75146（2026-07-07，open，8 条评论，10 月 2、10、14、16 日仍有新回复）：VS Code 扩展不支持 `/workflows`；
  "this is currently our biggest day-to-day friction with the VS Code extension"（多 agent 审查每个 agent 跑 20–60 分钟）；
  另一位评论者指出 Workflow 工具自己的启动消息还在说 "Use /workflows to watch live progress"，扩展随后拒绝该命令。https://github.com/anthropics/claude-code/issues/75146
- anthropics/claude-code#66686（2026-06-09，open，5 条评论）：请求 workflow 子 agent 像 agent team 一样在 tmux 窗格中显示；退而求其次 "A supported CLI command to live-tail a workflow agent's activity … `claude workflow tail <runId> [agentId]`"；
  最低要求 "document the `agent-*.jsonl` transcript layout as a stable interface for external watchers"。https://github.com/anthropics/claude-code/issues/66686
- VS Code 1.109（2026-01）的 Agent Sessions 侧栏把 Claude、Codex、Copilot 并列，但只显示会话，不显示工作流的阶段树。https://www.morphllm.com/vscode-multi-agent（检索摘要）

**ODW 现状：** 这是 ODW 的现成优势：`odw serve` 已经**只读地观测 Claude Code 自己的工作流运行**（`src/runtime/claude-run-source.ts` 读 `~/.claude/projects/.../workflows/` 与 `subagents/workflows/wf_*/agent-*.jsonl`），
看板也有窄屏布局。但：(a) 这些 `cc-` 运行只在看板里可见，`odw status|logs|attach` 不接受 `cc-` id（`src/cli.ts` 对 `bundle`/`compare` 明确拒绝），终端用户无法 tail；
(b) 没有 tmux 集成（全仓库无 `tmux`）；(c) README 没有「在 VS Code 简易浏览器 / JetBrains 里打开看板」的配方，IDE 用户不知道这条路。
另外 anthropics/claude-code#59248（2026-05-14，open，61 条评论）报告 Claude Code 静默清理会话 transcript——ODW 只读观测的 `cc-` 运行也会随之消失。https://github.com/anthropics/claude-code/issues/59248

**方向（S–M）：** 见 U5。

---

### 6. 编写错误让工作流「成功地什么都没做」：参数类型错、扇出大半为 null、复核子集为空 —— 中 · S–M

**痛点：** 工作流脚本里的小错误不会报错，而是变成「校验通过」或「花了很多钱」。

**证据：**
- anthropics/claude-code#69206（2026-06-17，closed）：Workflow 的 `args` 数组被当成 JSON 字符串传进脚本，扇出宽度算错，"the runtime spawned **218** subagents … burning **~700k tokens** before a **human** noticed"（原计划约 10 个）。https://github.com/anthropics/claude-code/issues/69206
- anthropics/claude-code#94535（2026-09-15，open）：verify/fix 循环按审阅者自填的自由文本字段挑选要重跑的「镜头」，一个都没匹配上，"the blocking-findings count fell to 0, and the workflow went on as if verified. A check ran, reported success, and measured nothing." 建议 "Treat an empty re-run set as an error, never as zero blocking findings." https://github.com/anthropics/claude-code/issues/94535
- anthropics/claude-code#66686：70 个 agent 中 26 个被网络抖动静默杀掉，"Diagnosing that required manually grepping `agent-*.jsonl` files"。https://github.com/anthropics/claude-code/issues/66686
- anthropics/claude-code#94911（2026-09-17，open）：一个低风险任务的工作流跑了约 137 次 agent 调用，"33/33 checks came back `pass: false`"，零可用产出。https://github.com/anthropics/claude-code/issues/94911

**ODW 现状：** ODW 在单个 agent 失败时会写一条 `LOG`（`src/primitives.ts`："failed and its result is null"），`odw digest` 能事后汇总失败；
`costGate`（S1）和 `fanOutWarn` 能挡住意外的大扇出。但：(a) 工作流**没有输入 schema**——`meta` 里不能声明 `args` 的形状，`odw run --args` 不做校验，#69206 那种「字符串当数组」在 ODW 上同样会发生；
(b) `parallel()`/`pipeline()` 结束时没有「多少成功、多少为 null」的汇总事件，也没有「少于 N 个成功就失败」的选项，大半为 null 的扇出照样往下走；
(c) `odw check` 只检查能否加载与方言外能力（T8），不做这类常见陷阱的静态提示。

**方向（S–M）：** 见 U6。

---

### 7. 只装了二进制的作者拿不到补全与类型检查 —— 中 · S

**痛点：** 工作流作者希望在编辑器里有原语与选项的补全、悬停文档和基本类型检查；Claude Code 侧则要先运行 `/workflow-authoring` 技能才能让 Claude 「会写」。

**证据：**
- 官方 workflows 文档：修改已保存的脚本前 "run the `/workflow-authoring` bundled skill to load the script-writing reference"；`meta` 必须是纯字面量，否则 "Claude Code drops `/<name>` from `/` autocomplete"。https://code.claude.com/docs/en/workflows
- anthropics/claude-code#63540（2026-05-29，closed）：脚本解析错误总是说成 "TypeScript syntax"，即使是普通 JS 错误。https://github.com/anthropics/claude-code/issues/63540
  （这一半 ODW 已覆盖：`odw check` 给出行列号与代码框。）
- 第三轮第 10 条的上手证据（OrchestratorInc #5996）仍然适用：首次使用的每一步都应「可见地完成」。

**ODW 现状：** `types/workflow.d.ts`（342 行，含 ODW 扩展）只随 npm 包发布（`package.json` 的 `files`）；SEA 二进制和安装脚本不带它，
`odw new` 写出的 `.odw/workflows/<名字>.js` 也没有 `// @ts-check`、`/// <reference>` 或 `jsconfig.json`。README 说「ships `.d.ts` authoring types」，但对只装二进制的用户这条路是断的。

**方向（S）：** 见 U10。

---

### 8. 团队共享工作流：版本漂移与「审过的就是跑的」—— 中 · M

**痛点：** 工作流、技能、agent 定义在团队内复制粘贴，版本漂移；通过插件市场分发后，又担心拉到的代码不是审过的那一版。

**证据：**
- Thoughtworks 技术雷达（2026-04-15，Trial）："Previously, sharing custom commands, specialized agents, MCP servers and skills was a manual process … This often led to version drift, with team members using outdated project instructions." https://www.thoughtworks.com/radar/tools/claude-code-plugin-marketplace
- Rubin Lake 技术雷达：建议从私有组织市场、固定插件来源与明确的负责人开始。https://rubinlake.com/en/technology-radar/developer-ai-and-delivery/claude-code-plugin-marketplace（检索摘要）
- buildthisnow 的 Plugin4Shell 文章（称 2026-09-17 由 Air Security 公开）："the pin was requested but never verified"，建议 "compare the commit actually in the working tree against the pinned SHA and abort on a mismatch"。https://www.buildthisnow.com/blog/guide/mechanics/claude-code-plugin-security（单一来源；另一次检索未找到其他报道，引用前需核对官方安全公告）
- 官方文档：跨团队共享工作流的推荐方式是放进插件，按 `<plugin>:<name>` 命名。https://code.claude.com/docs/en/workflows

**ODW 现状：** 能运行 Claude Code 插件里的工作流（X7，`src/workflows/plugins.ts`，读 `installed_plugins.json` 的 `installPath` 与 `version`），运行记录 `plugin.version`，
`meta.sourceHash` 记录脚本 sha256（`odw compare` 用）。但：(a) 没有不经过 Claude Code 插件系统的安装方式——`odw workflows` 只有 `list`/`where`；
(b) 没有锁文件，团队里每个人 `.odw/workflows/` 或 `~/.odw/workflows/` 里的同名工作流可能不同版本，运行时也不检查；(c) 插件工作流只记录版本字符串，不核对安装目录的实际提交。
ROADMAP 第 5 节把「分发 Hub / 市场」列为暂缓——这里只需要 git + 锁文件，不需要 Hub。

**方向（M）：** 见 U8。

---

### 9. 编排器要跟上 ACP（Agent Client Protocol）—— 中 · M

**痛点：** 每个 CLI 的无头输出格式各不相同（stream-json、`exec --json`、各种 print 模式），适配器要为每个 CLI 单独解析 token、提问、权限请求；ACP 正在成为「编辑器 ↔ agent」的统一协议。

**证据：**
- ACP 官方更新页（已核对）：2026-03-09 ACP Registry 发布；2026-06-05 「Session Usage Updates」稳定（上下文用量与可选花费）；2026-06-01 「Additional Workspace Roots」稳定；
  2026-06-25 Rust 与 TypeScript SDK 1.0；2026-07-22 Elicitation（结构化提问）稳定；2026-06-29 请求取消稳定；2026-07-20 v2 草案。https://agentclientprotocol.com/updates
- JetBrains 的 Sergey Ignatov 2026-02 起任 ACP 首席维护者（同上）；gemini-cli 已有 ACP 相关 issue（如 google-gemini/gemini-cli#29288，Zed 作为 ACP 客户端时的会话加载问题）。https://github.com/google-gemini/gemini-cli/issues/29288
- 采用面的证据仍以博客为主。https://www.noqta.tn/en/blog/agent-client-protocol-acp-universal-ai-coding-editor-standard-2026（检索摘要）

**ODW 现状：** 适配器全部是「命令行 + 输出解析」（`src/adapters/builtin.ts`、`output.ts`），没有任何 ACP 支持（全仓库无 `acp` 字样）。
ACP 的几个稳定特性恰好对应 ODW 已有的机制：usage 更新 ↔ N5 用量；elicitation ↔ T1 的 `questions`；权限请求 ↔ X2 档位；额外工作区根 ↔ 第 4 条多仓库；请求取消 ↔ stop/超时。

**方向（M）：** 见 U9。

---

### 10. 产出质量要随时间看：哪些工作流的改动真的被合并了 —— 中 · S–M

**痛点：** 团队需要知道「agent 的产出有多少被接受、要返工几轮、换了模型以后变好还是变坏」，而不仅是一次 eval 的通过率。

**证据：**
- Adaline Labs（2026-04-18）：引用 METR 的研究 "roughly half of test-passing SWE-bench PRs would not be merged by actual repo maintainers"，"automated grader scores are, on average, 24.2 percentage points higher than what maintainers actually accept"；
  建议四个指标：完成率、回归引入率、审阅轮数、失败时的影响面，并且 "requires logging from day one … The early data sets your baseline"。https://labs.adaline.ai/p/evaluate-coding-agents-production
- Hamel Husain（2026-09-30）评 Anthropic 的 auto-eval：先看数据再定评估器；标注要 "in-situ, not in a separate chat"。https://hamel.dev/blog/posts/claude-auto-evals/index.html
- anthropics/claude-code#102494（2026-10-15，open）：请求把上述做法纳入 eval-authoring。https://github.com/anthropics/claude-code/issues/102494
- AgentLens（arXiv，2026-07）：在每晚的评估流水线里比较连续版本、发现产品回归。https://arxiv.org/abs/2607.06624（检索摘要）
- anthropics/claude-code#102926（2026-10-17，open）：并行云端 agent 的产出总要返工，"it cost more usage credits to apply the fixes"。https://github.com/anthropics/claude-code/issues/102926

**ODW 现状：** 证据大多已经在运行目录里：`odw eval --baseline`（离线回归）、T5 审阅队列的 `reviewed/dismissed/applied` 状态（`reviews.jsonl`，带 `by` 与 `--note`）、
`odw apply` 自动标 `applied`、`expect` 的未达成项、`--resolve`/replay/handoff 次数、按 agent 的花费与请求的模型。
但没有任何命令把它们**跨运行、按时间**汇总成「每个工作流 / 适配器 / 模型的接受率、每个被接受改动的花费、返工轮数」的趋势；`odw digest` 只看一个时间窗，不做对比。

**方向（S–M）：** 见 U7。

---

### 已检查、判断为已覆盖或暂不立项

- **手机上看进度、收通知**（Claude Code Remote Control、Agentfy、Tactic Remote 等，见 https://radar.firstaimovers.com/claude-code-remote-control-dispatch-multi-device-guide-2026 （检索摘要））：
  ODW 已有窄屏看板、远程只读、`notify`（含 ntfy 动作按钮）、一次性批准链接（R4）、晨报（T7）。不再立项。
- **按子 agent 指定模型**（openai/codex#31814，100 条评论）：ODW 的阶段/agent 级适配器与模型分层（X7、S5）已覆盖；缺的「验证」那一半归入第 3 条。
- **agent 之间的长上下文交接**（子 agent "starts from scratch"、父 agent 只看到最终输出，见 https://wmedia.es/en/tips/claude-code-subagent-context-loss （检索摘要））：
  ODW 的笔记板（R3）、回退交接（R8）、工作流记忆（S7）与按 agent 保存的结果/transcript 已覆盖主要场景；没有找到 2026 年针对编排器的新的具体请求。
- **界面国际化与无障碍**：看板已有中英文（`web/src/i18n.ts`）、主题/动效偏好、键盘可达与对比度；CLI 遵守 `NO_COLOR`（`src/tty.ts`）。没有找到针对同类工具的新请求。
- **组织级策略底线（policy-as-code）**：Codex 的 `requirements.toml`（按字段合并、管理员强制的沙箱与审批策略，https://developers.openai.com/codex/enterprise/managed-configuration （检索摘要））、
  Claude Code 的 managed settings（`disableWorkflows`、`availableModels`、`strictKnownMarketplaces`）、LangWatch 指南 "users cannot override them"（https://langwatch.ai/blog/claude-code-enterprise-usage-spend-governance （检索摘要））。
  需求真实，但 ROADMAP 第 5 节明确暂缓「托管执行策略 / 根级授权体系」，而且 ODW 调用的 CLI 本身会读取这些 managed 配置。建议等有具体的团队用户再做一个「只能收紧」的系统级配置层（`/etc/odw/policy.json`：允许的适配器与模型、最高权限档、必须容器沙箱、单次运行花费上限）。暂缓。
- **成本分摊标签**（按项目/工单计费：LiteLLM 的 `x-litellm-tags` 方案 https://docs.litellm.ai/docs/tutorials/claude_code_customer_tracking ；
  claudeissues 镜像的 #1325「Cost attribution to projects」已关闭（检索摘要））：ODW 的 OTLP 导出已遵守 `OTEL_RESOURCE_ATTRIBUTES`（`src/runtime/otel-export.ts`），可打团队/成本中心标签。
  运行级 `--tag k=v` 与按标签汇总花费是小改动，可并入 U7 的分组维度，不单独立项。
- **跨 CLI 的 hook 一致性**（openai/codex#21753「Full Claude Code Hook Parity」，34 条评论、50 个反应）：hook 发生在 CLI 内部的工具调用层，ODW 无法从外部提供阻断式 hook。不立项；ODW 能做的「观察式」事件已经通过 transcript 解析提供。
- **Claude Code 未经请求就启动大工作流**（#102248、#103122、#94911）：属于 Claude Code 的模型/产品行为；ODW 的工作流只由用户或 Agent 显式发起，且有 `costGate` 与 `fanOutWarn`。不立项。

---

## 0.9 建议路线（按优先级）

排序依据：频度与新近程度；与 ODW 定位（方言保真、一份脚本多种 CLI、运行独立于宿主、本地观测台）的契合度；能否复用现有机制在一两天内完成。
前三项都是「方言保真 / 不做静默降级」类，风险低、直接回应 10 月的新 issue。

**U1 · `agentType` 读取 agent 定义并按 CLI 映射 —— M，对应第 1 条。**
`agentType: "<name>"` 先按 Claude Code 的顺序查找定义：`<cwd>` 向上到仓库根的每个 `.claude/agents/`（最近者胜，按 `name` 字段而非文件名识别）、`.odw/agents/`（ODW 扩展，同格式）、`~/.claude/agents/`、已启用插件的 `agents/`（`<plugin>:<name>`，复用 `src/workflows/plugins.ts` 的发现逻辑）。
找到后：正文作为人设提示词（替换现在的一句话 preamble）；`model` 作为该调用的默认模型（`agent()` 显式 `model` 优先；`sonnet`/`opus`/`haiku` 等别名在非 claude 适配器上经 S5 的模型分层映射，映射不到则大声 `LOG`）；
`tools`/`disallowedTools` 推导权限档——只有只读工具（Read、Glob、Grep、WebFetch、WebSearch）则降为 `read`，不含 Bash 则不高于 `edit`，只能降档不能升档（与 X2 一致），claude 适配器另外原样传 `--allowedTools`/`--disallowedTools`；
`isolation: worktree` 等同 `agent()` 的 `isolation`；`effort` 映射到文档化的参数（claude `--effort`、codex `-c model_reasoning_effort=`），其他适配器大声说明未生效；`maxTurns`、`mcpServers`、`hooks`、`skills` 等第一版不支持的字段逐个列进路由说明。
`agent_started` 事件记录定义文件路径与 sha256（`odw compare` 能看出 agent 定义变了），不可信仓库（`--untrusted`）里仓库内的定义只取正文不取权限相关字段。`odw agents types` 列出可用的 agent 定义及其映射结果。
**不做：** 不实现 `permissionMode`/`hooks`/`mcpServers` 的跨 CLI 映射；不读取 Codex/Gemini 自己的 agent 定义格式（等格式稳定再说）；找不到定义时保持现在的人设注入并 `LOG`，不报错（保持与旧脚本兼容）。

**U2 · 方言补齐：`stallMs`、嵌套工作流目录、`odw check` 的 Claude Code 限制提示 —— S，对应第 2 条。**
`agent(prompt, { stallMs })` 覆盖该调用的 `stallTimeout`（毫秒换算，复用 `src/adapters/runner.ts` 的看门狗与 `stallRestarts`），写进 `types/workflow.d.ts` 与一致性套件（新增 `33-agent-stallms`）。
`src/workflows/resolve.ts` 的项目根改为从 `cwd` 向上走到仓库根，沿途每个 `.odw/workflows/` 与 `.claude/workflows/` 都参与查找，同名时最近者胜；`odw workflows list` 标出每个名字来自哪一层、被哪一层遮蔽；`odw workflows where` 显示完整的候选链。
`odw check` 增加「Claude Code 限制」提示：字面量可判定的超过 4,096 项的 `parallel()`/`pipeline()`、非字面量 `meta`（Claude Code 会把它从补全中去掉）。
**不做：** 不在 ODW 中强制 4,096 项上限（ODW 自己没有这个限制，只提示）；不改变 `.odw` 与 `.claude` 在同一层时的现有优先级。

**U3 · 记录实际服务的模型，替换要大声说 —— S，对应第 3 条。**
在适配器的输出规则里新增 `output.servedModel`（与 R1 的 `output.background` 同样是声明式规则）：内置 claude 读 stream-json 的 `system`/`init.model` 与 `result.modelUsage` 的键，codex/agy/opencode 只在其 JSON 输出文档化地包含模型字段时读取。
`agent_done` 记录 `servedModel`（可能多个），与请求的模型不一致时（按 S5 的别名表与前缀规则比较，`claude-opus-5-5` 与 `opus` 视为一致）写 `model_substituted` 事件并 `LOG`；配置 `modelMismatch: "warn" | "fail"`（默认 `warn`，`fail` 时以新的失败原因 `model_substituted` 失败）。
看板抽屉、`odw agents`、`odw compare` 与 S1 的估算使用实际模型；`odw estimate` 按实际模型分组历史，避免不同模型的花费混在一起。
**不做：** 不从回复文本里猜模型；CLI 不报告模型时只显示「未报告」，不推断。

**U4 · 输入 schema 与扇出健康度 —— S–M，对应第 6 条。**
(a) `meta.input`（ODW 扩展，JSON Schema，与 `agent()` 的 `schema` 用同一个校验器）：`odw run`/`rerun`/`schedule`/触发器在启动前校验 `args`，失败即 `ConfigError` 并指出路径；
`--args` 给的是 JSON 字符串而 schema 要数组/对象时，报错并提示「看起来是被多编码了一次」而不是自动解码；`odw run <wf> --help` 按 schema 打印参数说明；Claude Code 忽略 `meta.input`（与其他扩展一样在文档中标明）。
(b) 每个 `parallel()`/`pipeline()` 结束时写 `fanout_done` 事件（总数、成功、null、按失败原因计数），超过一半为 null 时 `LOG` 一次；新增选项 `parallel(thunks, { minOk: n | "all" | 0.8 })`（ODW 扩展），不足时抛出带计数的错误，而不是带着大半 null 继续。
(c) `odw check` 增加两条静态提示：对 `parallel`/`pipeline` 结果直接 `.filter(Boolean)` 后没有检查长度的；用 agent 返回的字符串字段做集合筛选、而筛选结果未检查是否为空的（#94535 的形状），只作提示不报错。
**不做：** 不做通用 JS lint；不改变 Claude Code 方言里 null 的语义（默认行为不变，只有显式 `minOk` 才抛出）。

**U5 · 在终端、tmux 和 IDE 里看运行（含 Claude Code 自己的运行）—— S–M，对应第 5 条。**
`odw status|logs [--agent] [--follow]` 接受 `cc-` id（复用 `claude-run-source.ts` 的读取与 `odw logs --agent` 的 transcript 渲染，只读），回应 #66686 的 "`claude workflow tail`" 请求；
`odw tmux <run> [--layout tiled]`：在当前 tmux 会话里开一个窗口，概览窗格跑 `odw attach`，每个运行中的 agent 一个窗格跑 `odw logs --agent <id> --follow`，agent 结束时窗格保留最后几行并标注状态，新 agent 开始时补窗格（窗格数上限可配，超出的只在概览里列出）；ODW 与 `cc-` 运行都支持。
看板增加 `#/job/<id>?compact` 紧凑视图（无侧栏，适合 VS Code 简易浏览器 / JetBrains 内置浏览器的窄面板），README 增加「在 VS Code / JetBrains / Antigravity 里看工作流」配方。
`odw pin` 扩展到 `cc-` 运行：把该运行的 journal 与 transcript 复制进 ODW 的运行根目录（只读归档），防止被 Claude Code 的 transcript 清理删除（#59248）。
**不做：** 不写 VS Code/JetBrains 扩展；不对 Claude Code 的运行提供任何写操作（停止、批准等仍在 Claude Code 内完成）；不依赖 tmux 以外的终端复用器。

**U6 · 多仓库工作流：`repos` 与 `agent({ repo })` —— M，对应第 4 条。**
配置或 `odw run --repo name=path`（可多次）声明运行涉及的仓库，`meta.repos`（ODW 扩展）可声明需要的名字；`agent(p, { repo: "api" })`、`exec(cmd, { repo })` 在该仓库中运行，`isolation: "worktree"` 在该仓库建 worktree。
diff 按 `(agent, repo)` 保留，`odw diff`/`odw apply`/`odw review` 显示仓库名，`odw apply --all` 按仓库分组、逐仓库预检，任一仓库冲突则整体不应用（全部预检通过后再逐个写入，失败按仓库回滚）；`--pr` 在每个仓库各开一个草稿 PR，并在每个 PR 正文里互相链接。
`scope`（R11）与保险快照（T3）按仓库各自生效；未声明的仓库路径一律拒绝（防止 agent 被指到任意目录）；`--on ssh://` 第一版不支持多仓库，明确报错。
**不做：** 不做跨仓库的原子合并或合并队列；不自动发现 submodule 或兄弟目录（显式声明）；不在一个 agent 里同时给多个仓库的写权限（需要跨仓库改动就拆成多个 agent，以 R3 的笔记板同步接口）。

**U7 · `odw outcomes`：跨运行的接受率与返工趋势 —— S–M，对应第 10 条。**
`odw outcomes [--workflow W] [--by workflow|adapter|model|tag] [--since 90d] [--bucket week] [--json|--markdown]`：只用已记录的证据，按周给出——运行数、`expect` 全部达成率、保留了改动的 agent 中被 `applied` / `dismissed` / 未处理的比例（T5 的状态）、
每个被应用改动的花费、需要 `--resolve`/replay/handoff/重试的比例、`untouched`/`scope` 违规率；与上一个时间段对比并标出显著变化。U3 落地后按实际模型分组；运行级 `--tag k=v`（写入 `meta.json`、OTLP 导出的属性）作为分组维度。
`odw review mark … --note` 的备注与 `dismissed` 条目可以 `odw outcomes --export-cases` 导出为 `.odw/evals/` 用例草稿（输入 args + 人的判断），让「在现场标注」直接变成 eval 数据。看板 Evals 页增加趋势条。
**不做：** 不用模型给产出打分；不接入 GitHub 的 PR 合并状态（第一版只看 ODW 自己记录的 `applied`）；不做跨机器汇总（各自的运行根目录各自统计，`odw pull` 拉回的运行一并计入）。

**U8 · 从 git 安装工作流并锁定版本 —— M，对应第 8 条。**
`odw workflows add <git-url|path>[#ref] [--name N] [--global]`：浅克隆到临时目录，把 `meta` 校验通过的 `.js`（以及同目录的 `.odw/tests/`、`.odw/evals/` 对应文件）复制进 `.odw/workflows/`，
写 `.odw/workflows.lock.json`：`{ name, source, ref, commit, sha256 }`；复制前展示 `odw check --capabilities` 的结果并要求确认（`--yes` 跳过），方言外能力（`process`、`require` 等）默认以 `scriptContext: strict` 运行。
`odw workflows verify` 对比锁文件与磁盘（sha256 不符则报告「本地被改过」），`odw workflows update [<name>]` 拉新提交并显示脚本 diff 后再写入；运行时若工作流在锁文件中而 sha256 不符，启动横幅大声提示（配置 `lockedWorkflows: "warn" | "fail"`）。
Claude Code 插件工作流：运行时读取安装目录的 git 提交（若是 git 检出）并与 `installed_plugins.json` 记录的提交比对，不符则警告，`meta.json` 记录实际提交。
**不做：** 不做 Hub、搜索或评分（ROADMAP 第 5 节）；不做签名；不自动更新。

**U9 · ACP 适配器类型 —— M，对应第 9 条。**
适配器新增 `"protocol": "acp"`（ODW 扩展）：以子进程启动 ACP agent（适配器的 `command` 给出各 CLI 文档化的 ACP 启动方式，或 ACP Registry 中的 agent；具体参数实现时按各 CLI 当时的文档核对），零依赖实现 JSON-RPC 2.0 over stdio 的最小客户端——`initialize`、`session/new`（`cwd` 为 agent 的工作区，U6 落地后用「额外工作区根」）、`session/prompt`、读 `session/update` 流（文本、工具调用、usage 更新）、`session/cancel`（停止与超时）。
权限请求按 X2 档位自动应答（`read` 档拒绝写入与执行，`edit` 档拒绝执行等），每次应答写事件；elicitation 请求接入 T1 的 `questions` 策略（`checkpoint`/`deny`/`fail`）；客户端文件系统能力第一版不声明（agent 自己读写）。
transcript、用量、失败分类复用现有管线；`odw doctor --adapter <acp适配器>` 做一次握手与能力报告。
**不做：** 不把 ODW 做成 ACP agent（让编辑器驱动 ODW 是另一回事）；不实现远程传输（工作组尚未定稿）；不替换现有内置适配器，ACP 只是新增一种接入方式。

**U10 · 编辑器补全开箱即用：`odw types` —— S，对应第 7 条。**
把 `types/workflow.d.ts` 嵌入二进制（与模板相同的 `scripts/embed-*.mjs` 生成方式与 CI 漂移检查）；`odw types [--dir .odw]` 写出 `.odw/types/odw.d.ts` 与 `.odw/jsconfig.json`（`checkJs: true`，`include` 覆盖 `.odw/workflows/**/*.js` 与 `.claude/workflows/**/*.js`），版本号写进文件头，ODW 升级后 `odw doctor` 提示过期。
`odw new` 默认顺带执行（`--no-types` 关闭），模板首行加 `// @ts-check`；类型里的 ODW 扩展逐个标注 `@remarks ODW extension — Claude Code ignores it`，悬停即可分辨方言与扩展；U4 的 `meta.input` 落地后，`args` 的类型按 schema 生成（`odw types --from-meta`）。
**不做：** 不内置 TypeScript 编译或 `tsc` 检查（零依赖）；不支持 `.ts` 工作流（方言是纯 JS）；不写编辑器插件。

**优先顺序建议：** U1 → U2 → U3 先做（方言保真与「不做静默降级」，都是 10 月仍在新增的 issue，且 ODW 能比 Claude Code 做得更好）；
U4、U5 次之（编写错误与可见性，后者把 ODW 已有的 Claude Code 观测能力推到 IDE/tmux 用户面前，是获客点）；U10 是一天以内的小补丁，可与 U4 同批；
U6、U8、U9 规模较大、涉及 apply/适配器层，放在后面；U7 依赖 U3 的实际模型数据，最好在 U3 之后。
