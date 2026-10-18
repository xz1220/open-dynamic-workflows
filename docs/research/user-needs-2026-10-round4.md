# ODW 用户需求调研 · 第四轮（2026-10-18）

范围：并行编码 agent、编排器与工作流运行时的用户在 2026 年（以 6–10 月为主）仍在抱怨、仍在请求、而 ODW 在 ROADMAP 0.6（R1–R12）与 0.7（S1–S9）全部交付后**仍未覆盖**的需求。
前三轮已经写过的主题不再重复：成本可见与预估、限流/额度、resume/replay、diff 与 apply（含 `--resolve`、`--pr`）、
笔记板、范围声明、检查点与手机审批、孤儿后台任务、死循环上限、出网白名单、触发器与 GitHub Action、
`odw test`/`--dry`、漂移监测、多账号、工作流记忆、具名令牌、`odw new`。

方法：约 30 次检索。GitHub issue、CSA 简报、betterclaw、Penligent、dev.to、arXiv 与 Claude's Corner 周报均已打开核对引文；标「（检索摘要）」的链接只读了搜索结果摘要，未逐字核对。claudeissues.com 镜像的条目尽量回到 GitHub 原 issue 核对。
Reddit 不能直接抓取，只通过一篇引用 Reddit 帖子的周报间接引用，已标明。
「ODW 现状」逐条对照了 `README.md`、`odw --help`（`src/cli.ts`）与 `src/` 下的相关模块。

频度标记：**高** = 多个独立来源、近期仍有新报告；**中高** = 若干独立来源；**中** = 少数来源但问题明确；**低中** = 主要是专家或单一来源。

---

### 1. agent 在无头模式下「提问」，没人能回答：要么瞎猜着继续，要么卡到超时 —— 高 · S–M

**痛点：** 模型在任务中途调用 `AskUserQuestion`（或类似的澄清工具），但无头运行里没有回答通道。结果有三种：
工具立刻以空答案返回，模型当作用户已回答继续干；或者超时后“自行判断”继续；或者一直挂到看门狗/截止时间。三种都悄无声息。

**证据：**
- anthropics/claude-code#50728（2026-04-19，被 bot 以 not planned 关闭）："`AskUserQuestion` auto-resolves immediately with empty answers"，
  "The only reliable workaround is returning `permissionDecision: "deny"` from a `PreToolUse` hook"。报告人的折中做法是把问题转到自己的通道，再把答案作为新提示送回，但 "Claude doesn't always link it to the original question"。
  https://github.com/anthropics/claude-code/issues/50728
- anthropics/claude-code#73125（2026-07，已关闭）："No response after 60s — continued without an answer"；维护者称已改为默认关闭、可在 /config 配置。#73037 请求可配置超时，并要求一个 agent 能据此分支的、有类型的「无回应」结果。
  https://github.com/anthropics/claude-code/issues/73125 · https://github.com/anthropics/claude-code/issues/73037
- anthropics/claude-code#61337（2026-05，not planned）：`/goal` 模式下 `AskUserQuestion` 没有超时，无人值守的运行被一个问题无限期阻塞。
  https://github.com/anthropics/claude-code/issues/61337
- 下游编排器在 2026 年各自踩到同一个坑：
  - Sannrox/rusui#404（2026-09-29，已修复）："A headless review or run then sits until the execution deadline unless an operator happens to deny it." 以及 "Approving it would not help either, because the turn has no channel to answer the question." https://github.com/Sannrox/rusui/issues/404
  - edspencer/paddock#178（2026-07-13，open）："the gate resolves to an error rather than a user prompt"，"There is no button in the Paddock UI to approve/answer." https://github.com/edspencer/paddock/issues/178
  - mattwwarren/claude-workspace#1430："AskUserQuestion as a remediation path in headless mode guarantees a full watchdog-budget stall"。https://github.com/mattwwarren/claude-workspace/issues/1430

**ODW 现状：** 没有处理。`src/adapters/failures.ts` 的 15 类失败原因里没有「需要输入」这一类；内置 `claude` 适配器没有屏蔽或识别 `AskUserQuestion`（`src/adapters/builtin.ts` 中无相关参数），
也不使用 CLI 的会话续接（`--resume <session_id>`）。也就是说，ODW 的 agent 今天会落入上面三种静默结局之一，而 ODW 恰好已经有一套完整的人工检查点（X4）、手机审批链接（R4）和 `notify` 的 `waiting` 事件——**回答通道是现成的，只差把问题接进来**。

**方向（S–M）：** 见 T1。

---

### 2. 磁盘被 worktree、分支和运行记录悄悄吃掉 —— 高 · S–M

**痛点：** 并行 agent 一多，留下的 worktree、分支、构建产物、容器镜像、transcript 越积越多；工具既不报告占用，也不提供安全清理。

**证据：**
- anthropics/claude-code#26725（2026-02-18 开，至今 open，15 条人工评论，10 月 1 日、16 日仍有新回复）："there is no mechanism to clean them up if a session ends without proper cleanup (crash, interruption, or bug in teardown)"。
  评论里的数字：13 个废弃 worktree 占 13.8 GB；两个月 113 个 worktree、112 个陈旧分支。评论者的设计意见很有价值："The 'scan on session start' half of the request [is] more valuable than the 'clean up on exit' half"，以及 "Heuristic classification should recommend; the operator's explicit mark should win"（建议默认 dry-run，删除分支要显式标志）。
  https://github.com/anthropics/claude-code/issues/26725
- anthropics/claude-code#63087（2026-05-28，作为 #26725 重复关闭）："27 orphaned worktrees accumulated over normal usage, eating 80 GB"。https://github.com/anthropics/claude-code/issues/63087
- anthropics/claude-code#99672（2026-10-05，open）：2.1.275 起 `.worktreeinclude` 不再 APFS 克隆，"~200 GB across 22 worktrees"；同时引用 #92078（Desktop 的 worktree 池涨到 72 GB）。https://github.com/anthropics/claude-code/issues/99672
- anthropics/claude-code#79888（2026-07-21，open）：锁没释放导致 worktree 删不掉，"each carrying a multi-GB per-worktree dev Docker image/volumes that only get reclaimed if the removal hook runs"。https://github.com/anthropics/claude-code/issues/79888

**ODW 现状：** 基础做得比 Claude Code 好：每个隔离 agent 结束就 `worktree remove --force --force`，失败则删目录并 `worktree prune`（`src/workspace.ts`）；`.worktreeinclude` 用 `COPYFILE_FICLONE` 复制（`src/worktree-setup.ts`），不会出现 #99672 的回归。
但仍有三处只增不减：(a) worker 被 SIGKILL、机器断电时，`$TMPDIR/odw-wt-*` 下的 worktree 与 git 注册项留下来，没有启动时扫描；(b) `keep: true` / `keepBranches` 建的分支（`src/changes.ts` 的 `update-ref`）从不删除，`odw apply` 之后也不删；(c) 运行目录（事件、transcript、diff、stderr）没有保留期限，`odw` 没有任何报告占用或清理的命令（`--help` 里没有 `gc`/`clean`/`prune` 之类，`odw memory prune` 只管记忆）。

**方向（S–M）：** 见 T2。

---

### 3. agent 毁掉用户尚未提交的工作 —— 中高 · S

**痛点：** 原地（in-place）运行的 agent 执行 `git reset --hard`、`git checkout .`、`git clean -fd`，用户几天的未提交改动无法恢复。

**证据：**
- anthropics/claude-code#33850（2026-03-13，not planned）："destroyed ~2 days of uncommitted and staged work by executing a destructive git command (`git reset --hard`) in the user's main working directory"，"Work was NOT recoverable from git (checked reflog, dangling blobs, dangling commits)"。
  报告人的要求："Agents should NEVER run destructive git commands (`reset --hard`, `checkout .`, `clean -f`) in the user's main working directory." https://github.com/anthropics/claude-code/issues/33850
- 同类报告还有 #34327（启动时两次 `reset --hard origin/main`）、#39859（明知有未暂存改动仍执行 reset）、#17269（任务失败时自动 reset），见镜像 https://claudeissues.com/issue/34327-claude-code-destroyed-users-uncommitted-work-by-running-git-reset-hard-on-sessio 、https://claudeissues.com/issue/39859-bug-claude-ran-git-reset-hard-with-full-knowledge-of-unstaged-tracked-file-modif （检索摘要）。
  注意：#40710（“每 10 分钟 reset 一次”）后来被报告人自己更正为他写的另一个工具所为，不计入。

**ODW 现状：** 部分缓解：`edit` 档位下 `claude` 是 `acceptEdits`，无头时 Bash 命令会被拒；`isolation: "worktree"` 的 agent 碰不到用户的工作区。
但方言默认是原地运行；`codex` 的 `edit` 档是 `--sandbox workspace-write`，可以在工作区里执行任意 git 命令；`full` 档更不用说。ODW 在原地 agent 开始之前**不对用户的工作区做任何快照**（`src/` 中无 `stash create` 之类），transcript 也不检查破坏性 git 命令。

**方向（S）：** 见 T3。

---

### 4. 不可信输入里的提示注入：从 issue 文本到凭证外泄 —— 中高 · S–M

**痛点：** 让 agent 自动处理 issue、PR、评论，等于把任何人写的文字当作指令喂给一个有凭证、有网络的进程。2026 年这一类公开漏洞密集出现，而且各方结论一致：模型层面的防护挡不住，只能靠结构性的权限收缩。

**证据：**
- CSA 研究简报（2026-08-07，汇总 Black Hat 披露）：Claude Code（CVE-2026-54316）、Gemini CLI（CVE-2026-12537）、Codex 均受影响；"the point of failure sits below the level of the language model"；建议 "treat AI coding tools as privileged systems requiring minimal-privilege configuration"，"disable automatic triggering for repositories that accept public contributions"，"split such passes into isolated jobs with independent, minimally scoped credentials"，并在模型决策与执行之间放「人工确认或策略层」。
  https://labs.cloudsecurityalliance.org/research/csa-research-note-ai-coding-agent-ci-prompt-injection-202608/
- "Comment and Control"（2026-04）：PR 标题、issue 正文、评论即可劫持 Claude Code Security Review、Gemini CLI Action、Copilot Agent，密钥经 GitHub 本身回传。https://labs.cloudsecurityalliance.org/research/csa-research-note-comment-control-github-prompt-injection-20/（检索摘要）
- GitLost（2026-07 披露，文章 2026-10-18 更新）："A defence that can be defeated by a single conjunction is not a defence."；"Structural controls — token scoping, network isolation, sandbox boundaries — remove capabilities entirely."
  https://codex.danielvaughan.com/2026/08/04/gitlost-agentic-workflow-injection-prompt-injection-codex-cli-github-actions-ci-cd-defence/

**ODW 现状：** 零件齐全，但没有拼成默认值。触发器默认 `--untrusted`，但 ODW 的「不可信」指的是**仓库配置**不可信（CLAUDE.md、hooks、MCP、仓库内 `odw.config.json`，见 `src/untrusted.ts`），并不收紧 agent 的能力：
触发的运行仍是 `edit` 档、`agentEnv` 默认 `"inherit"`（整个 shell 环境，包括 `GH_TOKEN`、云密钥，见 `src/adapters/agent-env.ts`）、不强制容器沙箱和出网白名单（R7 已经有，但要用户自己开）。
`args` 里来自 issue 的文本与工作流作者写的提示词在 agent 看来没有区别。

**方向（S–M）：** 见 T4。

---

### 5. 审阅才是瓶颈：几十份 agent 改动，需要分诊，而不只是逐个看 —— 中高 · M

**痛点：** 生成速度远超审阅速度。人们要的不是更好的 diff 视图，而是「先看哪个、哪些可以快速放行、哪些已经看过」。

**证据：**
- Faros AI 对 22,000 名开发者的研究（2026-03，经 dev.to 转述）："median PR review duration is up 441.5%"，"PRs merged with zero review are up 31.3%"，"The volume just outran the capacity."；建议按补丁大小和文件类型先给 PR 打风险分，低风险快速放行。
  https://dev.to/code-board/the-agentic-pr-flood-is-breaking-code-review-across-multi-repo-teams-5269
- arXiv 2601.00753（MSR '26）：33,707 个 agent PR，仅凭文件类型、补丁大小等静态信号就能以 AUC 0.96 识别出高审阅成本的「昂贵尾部」，在 20% 审阅预算下覆盖约 69%。https://arxiv.org/abs/2601.00753v2
- btraceio/drydock PR #7（2026-07-28 合并）：把审阅重做成跨仓库的全局队列，带「有阻断性发现时不能批准」的裁决栏。https://github.com/btraceio/drydock/pull/7
- Cursor 论坛：AI 改动的待审列表跨会话累积，"no way to find or bulk discard them"，用户请求集中的待审面板。https://forum.cursor.com/t/stale-ai-edits-persist-across-sessions-with-no-way-to-find-or-bulk-discard-them/148384/3（检索摘要）

**ODW 现状：** 单个运行内的审阅做得很全：Changes 标签页按 agent 看 diff，`odw diff`、`odw apply`、`expect`、`scope` 越界、`untouched` 都有。
缺的是**跨运行的分诊**：没有按风险排序（大小、触及的路径类别、是否改了测试/CI/依赖、`expect` 是否通过、是否越界、是否 handoff/回退过），没有「已审阅 / 已放弃」的状态，看板上也没有「所有运行里还没处理的改动」这一视图。保留的 diff 一直挂着，直到用户自己记得。

**方向（M）：** 见 T5。

---

### 6. worktree 只隔离文件，不隔离运行时：数据库、compose 栈、迁移 —— 中 · S

**痛点：** 每个 agent 有了自己的代码目录，但仍共用同一个 Postgres、同一个 compose 项目名、同一组卷；setup 起的服务在 agent 结束后没人收。

**证据：**
- Penligent（2026-03-31）："It does not create a separate Postgres data directory."，"Two branches can each have their own file tree and still both try to write migrations into the same shared database."；Compose "cannot make one host port belong to two active instances at the same time."
  https://www.penligent.ai/hackinglabs/?p=4277
- anthropics/claude-code#79888（上文）：每个 worktree 一套多 GB 的开发镜像和卷，"only get reclaimed if the removal hook runs"。https://github.com/anthropics/claude-code/issues/79888

**ODW 现状：** X5 已经给了 `ODW_PORT`、`worktreeSetup`（带超时）、`ODW_RUN_ID`/`ODW_AGENT_ID`。但只有 setup 没有 teardown（`src/` 中无 teardown），setup 启动的容器、数据库、卷在 worktree 删除后继续存在；也没有一个稳定的、可直接当 compose 项目名或数据库名用的标识。

**方向（S）：** 见 T6。

---

### 7. 过夜跑完，早上需要一份「到底发生了什么」 —— 中 · S

**痛点：** 一晚上跑了定时任务、触发器、长任务，早上要逐个点开。agent 说「完成」并不等于完成，需要的是一份跨运行的、基于证据的汇总：改了什么、什么通过了、什么失败、什么在等人。

**证据：**
- anthropics/claude-code#76687（2026-07-11，bot 关闭）：整夜无人值守，"implemented only the first half of a two-part instruction … while presenting the result as complete"；"'The agent says it's done' and 'a supervising process says it verified this' both turned out to mean nothing here."
  https://github.com/anthropics/claude-code/issues/76687
- Verdent 的过夜运行指南："A strong overnight workflow should return reviewable results in the morning: what changed, what passed, what failed, and what needs a human decision." https://www.verdent.ai/ja/guides/answers/ai-coding-agents-run-overnight（检索摘要）
- explyt 博客：agent 报告 "commits that exist on no branch, files that were never written and test runs that never happened"，建议直接核对仓库与退出码。https://explyt.ai/blog/agent-commit-created-but-it-isnt（检索摘要）

**ODW 现状：** 证据都在（`expect` 结果、失败原因、花费小票、保留的 diff、等待中的检查点），看板 Activity 页的「待你处理」也列出了过去一天的失败与等待。
但没有 CLI 或推送形式的**跨运行汇总**；`notify` 是逐个运行触发的，十个运行就是十条消息，没有「每天早上 8 点一条」。

**方向（S）：** 见 T7。

---

### 8. 工作流本身就是代码：来源不明的工作流和技能 —— 中 · M

**痛点：** 社区开始分享工作流、技能、插件，用户问「装之前要不要审一下」。工作流脚本是 JS，可以做的远不止调用 `agent()`。

**证据：**
- r/ClaudeCode 关于技能审查的讨论（经 Claude's Corner 2026-10-14 周报转述）：漂亮的描述下可能藏着提示注入或恶意脚本。https://claudescorner.substack.com/p/claude-workflows-put-scope-cost-and
- 同一周报引用的 10 月测评："most of 100+ tested skills and workflows failed its reliability, verification, and security checks"。https://levelup.gitconnected.com/i-tested-100-claude-code-skills-plugins-and-workflows-in-2026-7-survived-c4529c11afc6（检索摘要）
- CSA 简报（第 4 条）的总原则：把 agent 工具当作特权系统，最小权限。

**ODW 现状：** `meta` 只解析不执行（好），不可信运行中名字不会解析到仓库自己的 `.odw/workflows`（好）。
但工作流**正文**由 `src/loader.ts` 用 `new Script(...).runInThisContext()` 在 worker 的主上下文里执行，`process`、`globalThis` 及经由它们能拿到的一切都在作用域内——方言本身只需要注入的原语和标准内建对象。来自 Claude Code 插件、`odw new` 以外的分享来源、或触发器启动的工作流，都以 worker 的全部权限运行。`odw check` 只检查能否加载，不报告脚本用到了哪些方言之外的能力。

**方向（M）：** 见 T8。

---

### 9. 本地模型：上下文被静默截断，agent 「看起来在工作」 —— 低中 · S

**痛点：** 想把廉价子任务路由到本地模型（Ollama / LM Studio），但默认上下文太小，工具说明被从前面截掉，HTTP 200、没有报错。

**证据：**
- betterclaw（2026-09-15）："Ollama is cutting the front off your prompt and returning HTTP 200 like nothing happened."；OpenAI 兼容的 `/v1` 端点忽略 `num_ctx`，只能在服务端设 `OLLAMA_CONTEXT_LENGTH`，并用 `ollama ps` 的 CONTEXT 列核对。
  https://www.betterclaw.io/blog/ollama-context-window-truncates-agent-config
- ollama/ollama#11409（open）：请求一个强制 `num_ctx` 的选项。https://github.com/ollama/ollama/issues/11409
- Codex 的 `--oss` 指南：需要 Ollama ≥ 0.13.4、至少 32K 上下文，而 24 GB 以下机器默认给不到。https://localaimaster.com/blog/codex-cli-ollama-local（检索摘要）

**ODW 现状：** 能用（`opencode`、`codex --oss` 或自定义适配器，加上 S5 的模型分层），但 `odw doctor` 不检查本地推理服务，README 没有本地模型配方，`--smoke` 只看「有没有回答」，看不出上下文被截断。

**方向（S）：** 见 T9。

---

### 已检查、判断为已覆盖或暂不立项

- **并行 agent 的 prompt cache 写入放大**（claude-code 镜像 #38356、#56293）：ODW 已记录 `cacheReadTokens`/`cacheCreationTokens`（`src/adapters/usage.ts`），`src/throttle.ts` 已有错峰扇出。不再立项。
- **合并队列 / 合并后整体回归**（HN 上 "merge queue that uses bisection" 的建议；Upstash 九个 PR 七个冲突）：`odw apply --all --verify` 已经逐个应用、逐个校验、失败回滚，加上 R6 `--resolve`、R11 `scope`。不再立项。
- **并行建 worktree 的 `.git/config.lock` 竞争**（claude-code#47266，3 个并行 agent 失败 2 个）：根因是写 upstream 分支配置；ODW 用 `worktree add --detach`，不写 config。保持观察。
- **多个 `codex exec` 共享 `~/.codex` 的会话/状态竞争**（openai/codex#11435 已于 2026-04 修复；openai/codex-plugin-cc#382 仍 open，"never sets `CODEX_HOME`"）：ODW 的 `accounts` 已能给不同账号不同 `CODEX_HOME`；同一账号下的并发由上游负责。若 codex 新版再出现，可考虑每个 agent 临时 `CODEX_HOME`（复制 `auth.json`/`config.toml`），容器沙箱已经是这么做的。
- **中途给运行中的 agent 发消息「纠偏」**（OpenClaw、pi-subagent 的 steer）：没找到 2026 年针对 Claude Code/Codex 的明确用户请求，且需要各 CLI 支持会话续接。暂缓，T1 的会话续接落地后再评估。
- **跨多个仓库的工作流**（Telerik：11 个 PR、5 个仓库、测试全绿、系统仍坏）：证据以厂商文章为主，且 `exec()` + `--source` 已能拼出来。暂缓。

---

## 0.8 建议路线（按优先级）

排序依据：频度与新近程度、与 ODW 定位（一份脚本跑多种 CLI、运行独立于宿主、本地优先）的契合度、以及能否复用现有机制在一两天内做完。

**T1 · agent 的提问接入检查点（`questions`，ODW 扩展）—— S–M，对应第 1 条。**
在 transcript 流解析中识别澄清类工具调用（`claude` 的 `AskUserQuestion`；其他 CLI 只在其文档化事件里有对应时识别），新增失败原因 `needs_input`，记录问题文本与选项，绝不让 agent 拿空答案继续。
配置 `questions: "fail" | "checkpoint" | "deny"`（默认 `"checkpoint"`，可在 `agent()`、适配器、运行三级设置）：`deny` 通过 `claude` 的 `--disallowedTools AskUserQuestion` 让模型自己做假设并在回复中说明；`fail` 直接以 `needs_input` 失败；`checkpoint` 先终止该 agent，再以问题为 payload 发起一个 `checkpoint()`（复用 `notify` 的 `waiting`、看板卡片、手机一次性链接），用户的回答（`odw approve --note` 或带 payload 的批准）以「上次你问了 X，用户回答 Y」的形式附加到原提示词后重新派发同一个调用；隔离 agent 复用原 worktree（同 R8 的 handoff 机制），重派计入预算并在事件里标注。
**不做：** 不实现 CLI 会话续接（`--resume <session_id>`）作为第一版——各 CLI 语义不同，先用「重派 + 附加问答」这一通用路径；不用启发式去猜「回复以问号结尾」是不是提问。

**T2 · `odw gc`：报告并清理 ODW 留下的东西 —— S–M，对应第 2 条。**
`odw gc [--dry-run 默认] [--yes] [--older-than 30d] [--json]` 分四类列出占用与建议：(1) 已不属于任何活着的 worker 的 `odw-wt-*` worktree（`git worktree list --porcelain` 中路径前缀匹配、对应运行已结束或 stale），用 `unlock` + `remove --force --force` + `prune` 清理；(2) ODW 建的 keep 分支，已被 `odw apply` 应用、或所属运行超过期限的；(3) 超期运行目录，先删 transcript 和 stderr（最大的部分），保留 `meta.json`、`status`、事件与结果，使 `odw list`/`estimate`/`compare` 仍可用；(4) 合计大小。
等待检查点、运行中、被 `odw pin <run>`（新增，写一个标记文件）标记的运行一律跳过——呼应 #26725 中 "the operator's explicit mark should win"。
worker 启动时顺带做第 (1) 类的只读扫描，发现孤儿就在日志里说一次并给出 `odw gc` 命令；`odw doctor` 增加「运行根目录大小 / 孤儿 worktree 数」一行。配置 `retention: { days, transcripts }` 供 `odw schedule` 定期调用。
**不做：** 不自动删除任何东西（只有 `--yes` 才删）；不碰非 ODW 创建的 worktree 和分支；不做常驻清理进程。

**T3 · 原地运行前的保险快照 + 破坏性 git 命令检测 —— S，对应第 3 条。**
运行中第一个原地（非隔离）且权限 ≥ `edit` 的 agent 开始前，若工作区不干净，用 `git stash create`（不改动工作区）得到跟踪文件的快照提交，另把未跟踪且未被忽略的文件写成一个 tree，一并存到 `refs/odw/safety/<run>`，事件 `safety_snapshot` 记录提交 id；`odw restore <run> [--check]` 预览/恢复（复用 `odw apply` 的逐文件预览与冲突报告）。T2 的 `odw gc` 负责过期清理。
同时在 transcript 解析中识别 `git reset --hard`、`git checkout -- .`/`git checkout .`、`git clean -f*`、`git push --force`、`git stash drop/clear`、`git branch -D` 等命令：配置 `destructiveGit: "warn" | "fail"`（默认 `"warn"`），命中时写事件、在看板抽屉标出，并提示 `odw restore`。
**不做：** 不试图在命令执行前拦截（那需要各 CLI 的 hook，且 ODW 不注入仓库 hooks）；不快照被忽略的文件（体积不可控）。

**T4 · 不可信输入档案：触发的运行默认最小权限 —— S–M，对应第 4 条。**
引入「输入不可信」这一与「仓库不可信」并列的标志：触发器启动的运行，以及 `odw run --untrusted-input` 显式声明的运行，默认 (a) `permissions: "read"`，除非触发器配置写明 `permissions`；(b) `agentEnv: "minimal"`，并且无论 `agentEnvPass` 如何，`GH_TOKEN`、`GITHUB_TOKEN`、`*_API_KEY` 中非该适配器登录所需的变量都不传；(c) 若未配置 `sandbox: container` 且出网白名单，启动横幅与 `run_started` 事件大声警告，配置 `untrustedInput.requireSandbox: true` 时直接拒绝启动；(d) 有写权限的 agent 或 `odw apply --pr` 前必须经过一次检查点（可由触发器 `approve: false` 关闭）。
同时为工作流提供 `args` 的「污点」元数据：`workflow.input.untrusted === true`，以及一个可选的包装助手（ODW 扩展）把不可信文本放进明确标注的数据块。所有这些都写入 `meta.json` 与看板头部的信任行。
**不做：** 不做基于模型的注入检测或关键词过滤（GitLost 已证明一个连词就能绕过）；不承诺「安全」，文档只说明收缩了哪些能力。

**T5 · 跨运行的审阅队列：风险分诊 + 已审阅状态 —— M，对应第 5 条。**
`odw review [--json] [--all-runs] [--since 7d]` 与看板新页「Review」：列出所有保留了 diff 且尚未处理的 agent，按确定性的风险分排序。分数只用现有数据：改动行数与文件数、触及路径类别（测试、CI、依赖清单/锁文件、迁移、鉴权/安全相关路径、二进制）、`expect` 是否全部通过、`scope` 越界、`untouched` 违规、`orphaned_background`、是否经历回退/handoff/`--resolve`、花费与重试次数；每一项都显示在条目上（「为什么排在这里」），不给黑盒分数。
每个条目可标记 `reviewed` / `dismissed` / `applied`（`odw review mark <run> <agent> <state> [--note]`，写入运行目录只追加的 `reviews.jsonl`，带 S8 已有的操作人归属 `by`），`odw apply` 成功后自动记为 `applied`。低风险且全部检查通过的条目可以 `odw apply --all --from-review --max-risk low` 批量应用（仍走 `--verify`）。
**不做：** 不用模型做审阅评分（可以用 `review-swarm` 示例自己做）；不对接 GitHub PR 审阅状态。

**T6 · worktree 运行时的收尾：`worktreeTeardown` 与稳定槽位名 —— S，对应第 6 条。**
新增 `worktreeTeardown` 设置（与 `worktreeSetup` 同样的来源限制：仓库内配置在不可信运行中不执行），在 agent 的 worktree 删除前运行，带超时，失败只记日志不影响 agent 结果；运行被停止、worker 收到信号时也执行。
每个隔离 agent 额外获得 `ODW_SLOT`（形如 `odw-<run短id>-<agent>`，只含小写字母数字与连字符，可直接作 `COMPOSE_PROJECT_NAME`、数据库名、卷名前缀），默认把 `COMPOSE_PROJECT_NAME` 设为它（用户已设置则不覆盖）。附一篇配方：每个 agent 一套 compose 栈 + 独立数据库 + `ODW_PORT`，teardown 中 `docker compose down -v`。T2 的 `odw gc` 对残留的 `odw-*` compose 项目只报告不删除。
**不做：** 不内置数据库克隆或容器编排；不管理非 ODW 启动的服务。

**T7 · 跨运行晨报：`odw digest` —— S，对应第 7 条。**
`odw digest [--since 12h|--since-last] [--workflow W] [--json|--markdown]`：按「需要你决定（等待中的检查点，附一次性链接）/ 失败（原因 + `odw resume` 命令）/ 完成但有未达成的 expect 或越界 / 完成且有待审改动（链到 T5）/ 花费合计与最贵的运行」分组，只用记录的证据，不复述 agent 自己的总结。
`notify` 新增 `"on": ["digest"]` 和配置 `digest: { cron: "0 8 * * 1-5" }`，由 `odw schedule` 写入系统定时任务后调用 `odw digest --since-last --notify`，一天一条而不是一个运行一条；webhook 载荷同时带 markdown 与结构化 JSON。
**不做：** 不用模型生成摘要；不做邮件发送（webhook/命令已足够接邮件）。

**T8 · 严格脚本上下文 + 能力清单 —— M，对应第 8 条。**
`scriptContext: "host" | "strict"`：`strict` 时用 `vm.createContext` 在一个只含注入原语（`agent/parallel/pipeline/phase/log/budget/workflow/args` 及 ODW 扩展原语）与标准内建对象的新上下文中编译执行工作流正文，没有 `process`、`require`、动态 `import()`（用 `importModuleDynamically` 拒绝）、`fetch`；跨上下文传递的值经结构化克隆。
默认：触发器运行、Claude Code 插件工作流、`odw view` 打开的分享包相关运行使用 `strict`；本地项目和个人工作流保持 `host`（不破坏现有脚本），一个版本后再评估是否全局默认 `strict`。
`odw check --capabilities` 静态列出脚本引用的方言外标识符（`process`、`require`、`import(`、`globalThis`、`Function(`、`eval`）与使用的 ODW 扩展原语，`odw run` 在 `strict` 下遇到这类引用时给出可读错误而不是 `ReferenceError`。用 `conformance/` 的 32 个用例在 `strict` 下全部通过作为验收。
**不做：** 不宣称这是安全沙箱（`vm` 不是安全边界，文档写明）；不做签名或市场审核。

**T9 · 本地模型通道：`odw doctor --local` 与配方 —— S，对应第 9 条。**
`odw doctor --local [--endpoint http://127.0.0.1:11434]` 探测 Ollama（`/api/ps`、`/api/show`）与 LM Studio 的 OpenAI 兼容端点：报告实际上下文长度（低于 32K 警告，并给出 `OLLAMA_CONTEXT_LENGTH` 的设置方法）、模型是否声明工具调用能力、版本是否满足 `codex --oss` 的最低要求。
`--smoke` 对本地模型增加一个「长提示末尾的指令是否被执行」的探针（构造一个超过 8K token 的提示，要求回复开头的口令），用于发现静默截断，失败归为新增的 `doctor` 检查项而不是运行失败原因。附 README 配方：把 `meta.phases` 中的侦察/分类阶段路由到本地模型、规划与审阅留在云端模型（S5 的模型分层已支持）。
**不做：** 不新增内置 `ollama` 适配器（通过 `opencode` / `codex --oss` / 自定义适配器即可）；不管理模型下载。

**T10 · 「待处理」统一出口：把 T1、T3、T5 的事件接入看板与 notify —— S（收尾项）。**
`needs_input`、`safety_snapshot`/`destructive_git`、审阅队列计数进入 Activity 的「待你处理」、命令面板与 `odw status`；`notify` 的 `waiting` 载荷区分「检查点」与「agent 提问」；`odw bundle` 包含新事件但不包含快照内容。这一项本身很小，但决定了前面几项是否真的被看到，建议与 T1 同批交付。

**优先顺序建议：** T1 → T2 → T3 → T4 先做（都是「静默失败 / 静默损失」类，正对 ROADMAP 的「不做静默降级」「状态必须真实」两条原则，且各自基本是一到两天的工作量）；T5、T7 次之（审阅与晨报是 0.7「先看清」的自然延续）；T6、T9 是小而明确的补丁；T8 涉及加载器，风险最高，放在最后并以一致性套件兜底。
