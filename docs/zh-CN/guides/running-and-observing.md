# 运行与观测指南

[English](../../guides/running-and-observing.md) · 简体中文

启动一次运行，跟踪它，回头接着处理它，以及事后清理。

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
继续)。在 CI 里应当用 `--deadline`:见[在 GitHub Actions 中运行](remote-runs.md#在-github-actions-中运行odw-扩展)。

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
[不受信任](safety-and-trust.md#不受信任的仓库odw-扩展)的运行中插件 workflow 照常可用——它们是你自己安装的——
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
文件名不是工作流名(字母、数字与 `. _ -`;且不能是 `__proto__`、`constructor`、`prototype`)
的文件会跳过并给出提示——可用 `--path` 加 `--name` 换个名字安装。从不穿过符号链接写入:
工作流文件、其 test 或 eval、锁文件,或从项目到它们之间的任一目录是符号链接时,`add` 与
`update` 不写入并以退出码 1 结束。
每个工作流在其目录旁的锁文件 `.odw/workflows.lock.json`(`~/.odw/workflows.lock.json`)中有一项:
`{ url, ref, commit, path, sha256, installedAt, test?, eval? }`(`path` 为仓库内路径,`sha256`
为安装的文件内容)。

把锁文件与 `.odw/workflows` 一起提交。`update` 重新拉取每一项的 ref,打印变化的统一 diff,
询问后才写入(本地改过的文件不动,除非 `--force`);`verify` 计算每个锁定文件的哈希——
`odw doctor` 也做同样的检查(「Locked workflows」)。安装的工作流是**第三方**的:
`odw workflows list` 与看板的 Workspace 标出它及其来源与提交,并且除非配置写
`scriptContext: "host"`,它在[严格脚本上下文](safety-and-trust.md#严格脚本上下文odw-扩展)中运行(嵌套
`workflow()` 调用它时也一样)。文件与锁文件不符时,运行的启动横幅与日志会醒目提示;
`"lockedWorkflows": "fail"` 则拒绝启动(默认 `"warn"`)。锁文件无法读取时,其旁的每个工作流
都视为来源未知的第三方且已被修改,`verify` 与 `odw doctor` 会报告该锁文件。`update` 对锁文件
中的 `url`、`ref` 与路径做与 `add` 相同的校验,拉取到的文件校验不通过时保留已安装的版本,
某一项失败只影响该项(退出码 1)。未做:签名、Hub 或搜索、自动更新、
核对 Claude Code 插件安装目录的实际提交。

**喜欢用浏览器?** `odw serve` 会对同一个 run 目录开一个零依赖的实时看板——每次运行都是一张
实时图,还有时间线、日志和结果,全部通过 SSE 推送。无需构建,不引入额外依赖,加载时不访问网络。

```bash
odw serve [--open]                      # 实时看板,默认 http://127.0.0.1:4317
odw serve --port 8080 --host 0.0.0.0 --token   # 远程只读、需要令牌(见「远程只读访问」)
odw view run.odwrun                     # 只读查看分享的运行包(见「分享一次运行」)
odw serve --public-url https://odw.example.com  # 在手机上回答检查点(见「在手机上批准」)
```

![odw serve —— 一次实时 deep-research 运行:五个阶段泳道(Plan → Search → Extract → Vote → Report)绘制成图,运行中的 agent 沿边传递信号,带运行计数与阶段步进条](../../../assets/odw-dashboard.gif)

## 恢复运行(ODW 扩展)

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
  [因额度用尽而暂停](cost-limits-and-quotas.md#额度用尽时暂停odw-扩展)的运行会立即继续;
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
[`docs/recipes/recover-a-run.md`](../../recipes/recover-a-run.md)。

## Agent transcript(ODW 扩展)

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
  一切——疑似密钥在流式写入时即被脱敏(见 [ODW 所保存内容中的密钥](safety-and-trust.md#odw-所保存内容中的密钥odw-扩展));
  `"maxTranscriptBytes": 0` 则完全不保存。
- 保存从不拖慢 agent:各行先在内存中缓冲,再异步追加到文件。
- 被 `odw resume` 重放的 agent 没有运行任何 CLI,所以没有 transcript——请看原运行的。
- 看板 API 提供规范化后的版本:
  `GET /api/runs/:id/agents/:agentId/transcript?since=<i>` →
  `{ entries, next, more, truncated, replayed }`,每个条目为
  `{ i, kind: text|tool_call|tool_result|error|attempt|result|raw|truncated, text?, tool?, input?, output?, isError? }`,
  长字段截断到 4 KB(`clipped: true`),有密钥被拦下的条目带 `redacted: true`。

## 在终端、tmux 和 IDE 里看运行(ODW 扩展)

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

## 对比两次运行(ODW 扩展)

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

CLI 可能在长任务进行中自行更新(Claude Code 的原生安装会在后台更新)。因此运行会再次询问版本——
距上次询问满 30 分钟后在该适配器的下一次派发时问一次;某个 agent 以可疑方式失败(原因不明的退出、
CLI 无法启动)时立即问一次(每分钟至多一次)。答案不同就记一条 `cli_version_changed` 事件——
`{ adapter, command, from, to, message }`,显示在实时视图、`odw logs` 和看板日志中——运行照常继续;
运行的 `cli_version` 仍是第一次的版本,`odw compare` 依旧按运行开始时的版本比较。

## 漂移监测(ODW 扩展)

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

## 实际服务 agent 的模型(ODW 扩展)

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

## 可观测性:OpenTelemetry trace(ODW 扩展)

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

## 分享一次运行(ODW 扩展)

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

## 回收磁盘:`odw gc` 与 `odw pin`(ODW 扩展)

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

## 磁盘写满与 pid 复用(ODW 扩展)

过去运行会悄无声息地结束的两种情形——都是 odw 自己的行为,不属于 Claude Code 方言:

- **磁盘写满。** 运行目录里有 `.odw-reserve`,创建运行时预留的 64 KB。向运行目录写入时遇到 `ENOSPC`
  (或配额的 `EDQUOT`)即结束运行:worker 停止派发、像其他致命错误一样杀掉 agent、删除预留文件腾出空间,
  在 `status.json`(及 `error.json`)里把运行记为 `failed`,并写 `"failureReason": "disk_full"`,
  错误信息说明在哪里写不下、该怎么做。若连这次写入也失败,同一句话写到 worker 的 stderr(`worker.log`)。
  看板把该运行标为 **失败——磁盘已满**。odw 不会为腾空间删除任何东西:先腾出空间(`odw gc` 会列出可删除的内容),
  再 `odw resume` 这次运行——已完成的 agent 会重放。以其他方式结束的运行会归还预留空间。
- **pid 被复用。** 重启后或 pid 空间回绕后(macOS 上限 99,999),已死 worker 的 pid 可能属于另一个进程——
  运行便永远像是活着:列表显示 running,`odw gc` 跳过它,定时任务的防重叠与触发器的去重一直被占着。
  现在 worker 在 `pid` 旁记录其进程的启动时间(`status.json` 的 `pidStart`:Linux 上取开机 id 与 `/proc`
  中的启动时间,其他平台取 `ps -o lstart=`)。活着的 pid 若启动时间不同,就不是这个 worker;
  状态最后写于本次开机之前的运行,其任何 pid 也都不是。隔离 worktree 的 `odw-owner.json` 与定时任务锁同样记录。
  取不到启动时间的平台(Windows)仍只用 pid 探测。
