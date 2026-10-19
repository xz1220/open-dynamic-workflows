# ODW 用户需求调研 · 第六轮（2026-10-19）：运行质量与 1.0 就绪度

范围：ROADMAP 0.6–0.9 全部交付后，这一轮**不找新功能**，只看「运行质量」：规模（几十到上百个并行 agent、几千次运行）、Windows、上手与文档、
长任务的崩溃与恢复（合盖睡眠、断网、CLI 中途自动更新、磁盘写满）、发布与打包。
前五轮写过的主题不再重复（成本、限流/额度暂停、resume/replay、diff/apply、检查点、孤儿后台任务、`odw gc` 与磁盘回收、`odw new`/`--dry` 首跑、方言保真等）；
本轮只在它们**运行层面的缺口**上落笔。

方法：约 20 次检索。GitHub issue 一律用 `gh issue view` / `gh search issues` 打开原文核对（日期、状态取自 GitHub）；`npm view` 与 `gh release list` 实际执行；
标「（检索摘要）」的链接只读了搜索结果摘要，未逐字核对；标「（单一来源）」的说法没有找到第二个独立来源。
「ODW 现状」逐条对照 `next`（821bf90）的 `src/`、`web/src/`、`.github/workflows/`、`scripts/`、`README.md`、`CHANGELOG.md`，行号写在条目里；
**没有运行任何重负载或模型 CLI**，所以规模相关的数字是读代码推出来的量级，需要实测确认的地方已标明。

严重度标记：**高** = 新用户或长任务大概率会撞上，后果是跑不起来或静默损失；**中高** = 特定但常见的环境（Windows、合盖、几千次运行）下必现；
**中** = 少数场景，后果可恢复；**低中** = 体验或长期维护问题。

一个总体观察：ODW 的**代码**已经为规模和失败做了很多（增量事件游标、run-list 增量推送、终态运行 30 s 信任缓存、进程组 kill、原子写、`odw gc`），
但**交付面**落后于代码四个月——最新发布仍是 2026-06-11 的 v0.4.0，README 的快速上手、GitHub Action 的示例 tag、CHANGELOG 都指向不存在的版本。
对一个准备叫 1.0 的项目，这比任何一条运行时缺陷都更先挡住新用户，所以本轮把发布与上手排在前面。

---

### 1. 文档描述的版本装不到：最新发布是 v0.4.0，README、Action 示例都指向未发布的东西 —— 高 · S

**痛点：** 新用户照 README 安装（`curl … install.sh | sh`，解析为 `latest`），拿到的是 v0.4.0；然后照「Quick start」敲 `odw new hello` / `odw test` / `odw run hello --dry` / `odw init` / `odw doctor`，全部是未知命令。
CI 用户照 `docs/github-action.md` 写 `uses: xz1220/open-dynamic-workflows/action@v0.7.0`，这个 tag 不存在，job 在解析 action 时就失败。

**证据（本仓库，实测）：**
- `gh release list`：最新 `v0.4.0  Latest  2026-06-11`；`git log v0.4.0..HEAD` 共 583 个提交未发布。
- `git show v0.4.0:src/cli.ts` 的帮助只有 `run/rerun/status/logs/result/list/serve/workflows`——没有 `init/doctor/new/test/--dry`；`git ls-tree v0.4.0 action` 为空（Action 本身也未发布）。
- `README.md:164-200` 的 Quick start 只有一句「This README describes current source. For a released binary, use its bundled skill」作提醒；`README.md:1319`、`docs/github-action.md:122,162`、`action/action.yml:3` 都写 `action@v0.7.0`。
- `scripts/install.sh:290-308`（尾部）只在二进制认识 `odw init` 时才运行它（装到 v0.4.0 时跳过），而「next steps」无论哪个版本都打印 `odw run <workflow.js> --wait`（`install.sh:307`）——与 README 的 `odw new` → `--dry` 引导分叉。
- 同类问题在别处也会被当成 bug 报：codex#54465（2026-10-16）"Standalone Unix updater reports success when curl fails"——安装/更新路径的「看起来成功」同样伤信任。https://github.com/openai/codex/issues/54465

**ODW 现状：** `release.yml` 本身是健全的（tag 必须等于 `package.json` 版本、四平台二进制、`SHA256SUMS`、全部成功才发布），缺的只是**切版本**这个动作和对应的文档版本化。

**建议：** 见第 9 条与 V1。在切版之前，至少把 README 顶部的提醒改成显眼的「当前文档对应未发布的 main；已发布版本 v0.4.0 的文档见 tag」，并把 `action@v0.7.0` 改成真实存在的引用。

---

### 2. README 是 283 KB 的单页手册：新用户找不到第一步，老用户找不到参考 —— 中高 · M

**痛点：** 新用户需要「装 → 跑通一个 → 知道下一步看哪」三屏以内；老用户需要可搜索、可链接的参考页（配置键、CLI 命令、事件类型）。单文件 README 两头都不讨好。

**证据：**
- 本仓库：`README.md` 4,549 行 / 283 KB，`README.zh-CN.md` 3,818 行 / 278 KB（两份需要手工同步）。18 个 `##`、57 个 `###`；最大两节「Configure adapters」1,972 行、「Run and observe」1,303 行，几乎每段都夹着「ODW extension」说明、设计理由和参数表——Diátaxis 所说的「教程、操作指南、参考、解释混写」。
  `README.md:4336-4440` 的「Status」又是一份手写的变更摘要，与 `CHANGELOG.md` 重复且已过期（仍写「0.5.0 development」）。
- 已有的 `docs/index.html`（211 KB 着陆页）是营销页，不承担文档导航；`docs/recipes/` 只有 6 篇。
- Diátaxis 把文档分成 tutorials / how-to / reference / explanation 四类，并把「解释混进操作指南」列为最常见的问题；Canonical 已全面采用。https://ubuntu.com/blog/diataxis-a-new-foundation-for-canonical-documentation （检索摘要）
- 同类编排器的做法：Sortie 有独立文档站（Getting started / CLI / 配置参考）并提供 `brew install sortie-ai/tap/sortie`（https://pkg.go.dev/github.com/sortie-ai/sortie@v1.9.0 （检索摘要））；Composio 的 Agent Orchestrator 用 Mintlify 托管文档（https://mintlify.com/ComposioHQ/agent-orchestrator/introduction （检索摘要））。
- 第三轮第 10 条已经解决了「首跑要花钱」（`odw new` + `--dry`），本条只谈结构，不重复。

**ODW 现状：** 内容质量高、覆盖完整；问题是形态。`odw --help` 已 148 行，同样没有分主题的 `odw help <topic>`。

**建议：** 见 V3：README 缩到 ≤300 行（是什么、安装、60 秒首跑、链接），其余按 Diátaxis 拆进 `docs/`（零依赖：纯 Markdown，GitHub 直接渲染；要站点再用 GitHub Pages 的 Jekyll 默认主题，不引入构建依赖），
参考页（配置键、CLI、事件）尽量从代码生成，减少中英两份手工同步的量。

---

### 3. 规模：`odw serve` 每秒把整个运行根和整个 `~/.claude/projects` 扫一遍，Activity 页每 2 秒把全部运行再算一遍 —— 中高 · S–M

**痛点：** 跑了几个月、几千次运行（定时任务 + 触发器 + eval 矩阵很快就到）的用户，看板变慢、风扇转；用户报告的同类问题集中在「文件句柄 / 系统文件表被耗尽」和「长时间运行后越来越卡」。

**证据（外部）：**
- anthropics/claude-code#79920（2026-07-21，open）：后台会话守护进程「opens file descriptors at ~30,000/sec until the system-wide file table is exhausted」，两次内核 panic。https://github.com/anthropics/claude-code/issues/79920
- anthropics/claude-code#82254（2026-07-29，closed）：VS Code 扩展「fd leak from session transcript scanning causes "Error: spawn EBADF" after hours of uptime」——正是「周期性扫描会话目录」这一类实现。https://github.com/anthropics/claude-code/issues/82254
- openai/codex#50498（2026-10-03）：子 agent 收尾不完成，守护进程「exhausts its 256 fd limit in ~22h」；codex#49769（2026-09-30）：EMFILE 让会话不可用。https://github.com/openai/codex/issues/50498 · https://github.com/openai/codex/issues/49769
- 实践者文章：50 个 agent 时「rate limits … usually arrive long before system resources fail」，macOS 默认 `ulimit -n` 256 不够。https://superset.sh/blog/parallel-coding-agents-guide （检索摘要）

**ODW 现状（读代码）：** 已经做对的：事件按字节游标增量读（`src/runtime/run-store.ts:420-470`）、终态运行 30 s 内跳过 stat（`src/runtime/odw-run-source.ts:42,188-229`）、增量 `runs-delta` 帧（`src/runtime/run-feed.ts:121-140`）、Web 端分页渲染（`web/src/main.ts:60`，`HISTORY_PAGE`）。仍然 O(全部运行) 的热点：
- (a) `run-feed.ts:30,54`：`TICK_MS = 1000` 的定时器每秒 `allSummaries()`——ODW 侧 `listRunIds()` 遍历两层目录（`run-store.ts:655-661`），每个非终态运行 stat 两个文件，并对**全部**运行做两次 `JSON.stringify` 签名（`run-feed.ts:143-155`）；
- (b) Claude 侧 `src/runtime/claude-run-source.ts:251-273` 的 `discover()` 每秒对 `~/.claude/projects/*/<session>/` 的每个会话做 2 次 `readdir`——重度 Claude Code 用户有几千个会话目录，即每秒几千次 readdir，**与是否有 cc- 运行无关**；
- (c) Activity 页 `web/src/main.ts:490` 每 2 s 拉 `/api/activity` 与 `/api/review`；后者 `src/runtime/review.ts:425-446` 遍历全部运行，对每个有改动的运行每次都重读 `reviews.jsonl`；每个打开的标签页各算一遍（`server.ts:539-558`）；
- (d) 冷启动：第一次列表对每个运行把整个 `events.jsonl` 读进一块 `Buffer.alloc(size)`（`run-store.ts:451`）并同步解析——几千个运行 × 几百 KB 会把 `odw serve` 的事件循环阻塞数秒（需实测）；`review.ts:461` 的 `readEvents` 同样整文件同步读；
- (e) `run-feed.ts:57` 对运行根 `fs.watch(…, { recursive: true })`：Linux 上 Node 用每目录一个 inotify watch 实现，每个运行 2–3 个目录，几千个运行可能超过老内核 8192 的 `max_user_watches`（错误已被捕获并回退到 tick，不会崩，但会在 stderr 记一条）；
- (f) 运行目录**永不删除**：`odw gc` 只裁剪 transcript（`src/runtime/gc.ts:17-20`），meta/status/events 永远留着，所以上面所有 O(N) 的 N 只增不减。
- 另：`odw-run-source.ts:26` 的整份事件日志 LRU 是 64 条，一条大运行的事件全部在内存里；目前事件量小（transcript 另存），属于低风险。

**严重度：** 中高——功能正确，但「几千次运行」正是 1.0 后定时任务/触发器用户的常态。

**建议：** 见 V5：终态运行写一份 `summary.json`（worker 在终态时写，列表直接读，不再解析事件）；Claude 源的发现改为按会话目录 mtime 缓存、5 s 以上的节奏；
Activity/review 的计算挪到服务端单例缓存（按运行根的变化失效），多个标签页共享；`odw gc --archive <age>` 把过期运行打包成一个 `.odwrun`（已有 `odw bundle`）后删目录。

---

### 4. 规模：并发上限只管「一次运行」，同一台机器上的多次运行互不相知 —— 中 · S–M

**痛点：** 限流与额度是**账号级**的，但 ODW 的 `concurrency`、按适配器的上限、自适应降速都是**每次运行**各算各的。定时任务 + 两个触发器 + 一个手动运行同时在跑时，实际并发是各自上限之和；
一次运行学到的「codex 被限流了，降到 4」不会告诉另一次运行。额度刚重置时批量启动尤其容易撞墙。

**证据：**
- anthropics/claude-code#53922（2026-04-27，closed，12 条评论）：额度重置后用脚本批量开 ~10 个会话，「the first 3–4 sessions start normally, but the next 5–6 sessions fail almost immediately … Server is temporarily limiting requests (not your usage limit)」。https://github.com/anthropics/claude-code/issues/53922
- Bernstein 编排器文档把「按错误率收缩并行度、按 CPU 负载暂停派发、硬性 agent 总数上限」列为编排器加固原语。https://bernstein.readthedocs.io/en/latest/concepts/orchestrator-hardening/ （检索摘要）

**ODW 现状：** `src/scheduler.ts:169-205` 的信号量是进程内的；README `README.md:3742-3760` 明确写「`concurrency` caps how many agents **a run** has going at once」；多账号的上限同样按运行（`README.md:3647`）。
`staggerFanOut`（`src/adapters/builtin.ts:710`）只对声明 `promptCache` 的适配器（目前只有 claude，`builtin.ts:573`）、只在一次 fan-out 内错开。触发器有自己的 `concurrency`（`trigger-route.ts:209`），但那是「运行数」不是「agent 数」。

**建议：** 见 V6：可选的主机级上限 `hostConcurrency: { "*": 24, "codex": 8 }`，用运行根下 `_slots/<adapter>/<n>.lock`（`O_EXCL` 创建、内含 pid + 启动时间，死进程的槽可回收）实现跨进程信号量；
自适应降速把当前上限写到 `_slots/<adapter>/limit.json`，其他运行读取（只降不升，冷却后各自恢复）。

---

### 5. Windows：发布了 Windows 二进制，但 CI 只验证 `--version` 和 `--help`；`exec()` 字符串走 cmd.exe —— 中高 · M

**痛点：** 2026 年 Windows 上的 agent 编排问题集中在路径（MAX_PATH、UNC、混合斜杠）、进程树残留、shell 语义差异与沙箱。ODW 运行时为 Windows 写了不少分支，但没有一个真正在 Windows 上被执行过的测试。

**证据（外部）：**
- anthropics/claude-code#96299（2026-09-23，open，9 条评论）：Windows 上 `claude.exe` 会话进程「accumulate and are never terminated」，11 小时 42 个进程、3.4 GB。https://github.com/anthropics/claude-code/issues/96299
- anthropics/claude-code#101901（2026-10-13，open）：Windows 上 2 个并行后台子 agent 就让 VS Code 扩展宿主 OOM。https://github.com/anthropics/claude-code/issues/101901
- claude-code 在深层 worktree 路径（约 280 字符，超出 260 默认上限）上「Edit/Write tools silently fail to persist」（2026-05，已关闭）；UNC 工作目录下 CLAUDE.md 不加载（2.1.157 回归）。https://claudeissues.com/issue/61303-edit-write-tools-silently-fail-to-persist-in-deep-isolated-worktree-paths-on-win · https://claudeissues.com/issue/64518-bug-claude-md-not-loaded-when-working-directory-is-a-unc-path-windows （检索摘要）
- openai/codex 10 月仍在大量新增 Windows 问题：#54262「turn/start fails with AbsolutePathBuf error due to mixed Linux/Windows cwd」、#55109 沙箱 `CreateProcessAsUserW` 失败等。https://github.com/openai/codex/issues/54262

**ODW 现状（读代码）：**
- CI：`.github/workflows/ci.yml:79-99` 的 `windows-smoke` 只构建并检查 `--version`、`--help`；167 个测试文件全部只在 Linux/macOS 跑（注释说「The full suite leans on POSIX shells」，实际只有 26 个文件用到 sh 桩）。但 `README.md:4434` 写「CI covers Node 20/22/24, macOS and Windows」——言过其实。
- 做对了的：`src/adapters/runner.ts:225-250` 处理 npm 的 `.cmd` 垫片（改走同名 `.ps1`），`executable.ts` 按 `PATHEXT` 查找，`runner.ts:550-570` 用 `taskkill /T /F` 杀进程树，`worktree-setup.ts:306` 用 junction 代替目录符号链接（不需要开发者模式）。
- 缺口：(a) worktree 建在 `%TEMP%\odw-wt-XXXX\<repo>\`（`src/workspace.ts:225`），再加 `node_modules` 深路径很容易过 260；`git worktree add`（`workspace.ts:234`）没有带 `-c core.longpaths=true`（全仓库无 `longpaths`）。
  (b) `exec("…")`、`worktreeSetup`、`expect.command` 的字符串形式走 Node 的 `shell: true`（`src/exec.ts:459`、`worktree-setup.ts:412-414`，文档称「platform shell」`adapters/types.ts:515`），在 Windows 上是 cmd.exe：
  同一份工作流里的 `npm test 2>&1 | tail -50`、`cp .env.example .env`、`$VAR` 在 Windows 上行为不同或直接失败——这与「一份脚本，到处运行」的定位冲突；Claude Code 自己在 Windows 上用 Git Bash 执行 Bash 工具。
  (c) Windows 上停止是直接 `taskkill /F`（`runner.ts:533`），没有 POSIX 那样的 SIGTERM 宽限，CLI 无法收尾；worker 被外部硬杀时 agent 不在任何 Job Object 里，会成为孤儿（对应上面 #96299 的现象）。
  (d) 定时任务在 Windows 上只打印 `schtasks` 命令（`README.md:1190`），容器沙箱不支持（`README.md:3152`）——都已诚实地写明，属于已知限制。

**建议：** 见 V4：Windows CI 跑一个真实子集（不依赖 sh 桩的测试 + 一次 mock 适配器的 `odw run --dry` 端到端 + 一次带 `isolation: "worktree"` 的 mock 运行）；
worktree 加 `-c core.longpaths=true` 并允许 `worktreeRoot` 指向短路径（如 `C:\odw-wt`）；Windows 上字符串命令在找到 Git Bash 时用它（`shell` 设置可覆盖，找不到时大声 `LOG` 一次说明用的是 cmd.exe）；README 把 CI 说法改准确。

---

### 6. 合盖睡眠与断网：卡死看门狗用墙钟，醒来时可能把所有 agent 一起判为 `stalled`；断网没有专门的失败原因 —— 中高 · S

**痛点：** 过夜长任务最常见的中断不是崩溃，而是笔记本睡眠和 Wi-Fi 掉线。用户报告：睡眠打断流式响应后，CLI 反复整段重算、烧掉大量额度；醒来后会话「不知道发生了什么」。

**证据：**
- anthropics/claude-code#102780（2026-10-16，open）：三个并行 agent 过夜，macOS 每 15 分钟睡一次，「Each sleep cut the API stream mid-response … forced a complete rewrite of the turn … zero prompt-cache hits」，循环 6 小时。https://github.com/anthropics/claude-code/issues/102780
- anthropics/claude-code#103233（2026-10-18，open）：「hit some kind of failure loop while my computer was asleep and seems to have eaten up 40% of my weekly usage」，怀疑在子 agent 中。https://github.com/anthropics/claude-code/issues/103233
- 社区已有专门的防睡眠扩展：pi-caffeinate 在 agent 开始时取 `caffeinate` / `systemd-inhibit --what=idle` 锁，结束时释放。https://cdn.jsdelivr.net/gh/georgebashi/pi-caffeinate@main/README.md （检索摘要）；合盖睡眠无法被软件阻止（检索摘要，https://blog.openreplay.com/mac-awake-overnight-agent-runs-caffeinate/ ）。

**ODW 现状（读代码）：**
- `src/adapters/runner.ts:368-374` 的超时用 `setTimeout`（单调时钟，睡眠期间不走），而 `runner.ts:381-389` 的卡死看门狗用 `Date.now() - lastOutputAt`（墙钟，包含睡眠时间）。醒来后第一个到期的看门狗检查会把睡了多久都算作「沉默」——
  一台睡了 1 小时的机器上，`stallTimeout` 小于 1 小时的所有 agent 会在醒来几秒内被同时以 `stalled` 杀掉并消耗 `stallRestarts`（推断，需在真机上复现确认）。两种时钟混用也让「超时」与「卡死」对睡眠的处理不一致。
- 失败原因（`src/adapters/failures.ts:43-75`）没有 `network`/`offline`：断网时 CLI 非零退出被记为 `exit`，`transientRetries`（`builtin.ts:695`）只覆盖限流，于是一次 Wi-Fi 抖动会让 fan-out 里一批 agent 变成 null。已有的 `quotaWait` 机制（暂停派发、不占槽、到点继续）正好可以复用为「网络恢复后继续」。
- 全仓库没有任何防睡眠（`caffeinate`/`systemd-inhibit`/`SetThreadExecutionState`）。

**建议：** 见 V7。

---

### 7. CLI 在运行中途自动更新：同一次运行的前后 agent 跑在不同版本上，ODW 只记第一次 —— 中 · S

**痛点：** Claude Code 原生安装会在后台自动更新并把 `~/.local/bin/claude` 指向新版本，用户关掉自动更新也不一定生效；插件缓存目录在更新时被删除会让并行会话报错。
一次跑几小时的 ODW 运行，前一半 agent 与后一半 agent 可能是不同的 CLI 版本，`odw compare`/漂移监测看不到。

**证据：**
- anthropics/claude-code#91646（2026-09-02，open）：`autoUpdates: false` 在原生安装上被忽略，「updated twice in two days, once mid-session」，`~/.local/bin/claude` 在会话中被重新指向。https://github.com/anthropics/claude-code/issues/91646
- anthropics/claude-code#64718（2026-06-02，closed）：插件更新删除旧缓存目录，其他活动会话「fail with: Plugin directory does not exist」。https://github.com/anthropics/claude-code/issues/64718
- anthropics/claude-code#84732（2026-08-07，closed）：桌面端强制更新两天内两次杀掉一个 6 天的计算任务。https://github.com/anthropics/claude-code/issues/84732
- Claude Code 文档：`DISABLE_AUTOUPDATER=1` 只停后台检查，`DISABLE_UPDATES` 更严格（v2.1.118 加入）。https://code.claude.com/docs/en/setup （检索摘要；具体语义以当时文档为准）

**ODW 现状：** `src/provenance.ts:8-15,156-160`：每个适配器**每次运行只探测一次** `--version`（首次派发时）；没有给 agent 进程设置任何关闭自动更新的环境变量（全仓库无 `AUTOUPDATE`）。

**建议：** 见 V7 的后半：内置 claude 适配器的 agent 环境默认加 `DISABLE_AUTOUPDATER=1`（只影响 ODW 启动的子进程，可在适配器 `env` 覆盖；以当时 Claude Code 文档为准），
版本探测改为「每次派发前比较可执行文件的 realpath + mtime，变了再探测一次」，版本变化写 `cli_version_changed` 事件并 `LOG`，`odw compare` 按 agent 显示版本。

---

### 8. 磁盘写满与重启后的 pid 复用：状态写不下去、或者死了的运行永远显示「在跑」 —— 中 · S

**痛点：** worktree × 并行数很快吃掉磁盘（第四轮第 2 条讲的是回收，本条讲**写满那一刻**）；另一个长期问题是重启后的 pid 复用。

**证据：**
- 2025 年起 Debian 13 默认把 `/tmp` 挂成 tmpfs（上限为内存的 50%），Fedora、Arch 早已如此；Proxmox LXC 中这一上限按宿主内存计算引发 OOM。https://lowendbox.com/?p=49859 · https://forum.proxmox.com/threads/pve9-x-debian13-lxc-tmp.177979/latest （检索摘要）
- anthropics/claude-code#68383（2026-06-14，closed）：Bash 工具在 macOS 上捕获输出时报 ENOSPC。https://github.com/anthropics/claude-code/issues/68383

**ODW 现状（读代码）：**
- worktree 建在 `os.tmpdir()`（`src/workspace.ts:225`）：在 tmpfs 的 Linux 上，16 个大仓库的 worktree 直接占内存；没有可配置的 worktree 根目录，也没有任何派发前的剩余空间检查（全仓库无 `statfs`）。
- 写满时：`JsonlSink.emit` 是裸 `appendFileSync`（`src/runtime/run-store.ts:724-726`），在计时器、配额回调等任意位置同步抛出；随后把状态写成 failed 的 `writeJsonAtomic` 也会失败（`fs-util.ts:39` 只清理临时文件）。
  结果是运行停在 `running`、worker 死掉、看板显示 `stale`，`worker.log`（同一块盘）里可能也写不进原因——用户看不到「磁盘满了」这句话。
- pid 复用：存活判断只有 `process.kill(pid, 0)`，且 `EPERM` 视为存活（`src/runtime/runs-view.ts:440-451`）。断电/重启后，死掉的运行的 pid 若被别的进程（尤其 root 进程）复用，`isRunActive`（`run-liveness.ts:107-115`）返回 true：
  看板显示 running；`odw gc` 永远跳过它（`gc.ts:329,543,661`）；**定时任务的防重叠会一直认为上一次还在跑而跳过**（`src/schedule/command.ts:765`）；触发器的 dedupe/并发同样被卡住（`trigger-route.ts:267-283`）。
  macOS 的 pid 上限 99,999、Windows 的 pid 复用都很快，长期运行的定时任务用户迟早会撞上。代码注释（`runs-view.ts:453-462`）有意不用 `updatedAt` 超时，这是对的；缺的是一个与 pid 绑定的身份。

**建议：** 见 V8。

---

### 9. 发布与打包：一个 1,173 行的「Unreleased — 0.5.0」，没有 Homebrew / winget / npm，Windows 资产是 `.exe.gz` —— 中高 · S–M

**痛点：** 用户期望：版本化的发布、每个版本一段变更（含「升级前要检查的行为变化」）、用自己平台的包管理器安装与升级、可验证的二进制。

**证据：**
- 本仓库：`CHANGELOG.md` 只有一个二级标题 `## Unreleased — 0.5.0`（`CHANGELOG.md:7`），覆盖 0.5–0.9 四个路线版本的全部交付（`odw outcomes`、`agentType`、ACP 等都在里面），以及 `CHANGELOG.md:1125` 起的「Changed behavior — check before upgrading」；
  更早版本（0.1–0.4）在 CHANGELOG 里没有条目，只在 GitHub Release 正文里。`release.yml:99` 用 `generate_release_notes: true`（PR 标题列表），不读 CHANGELOG。
- `package.json` 仍是 `0.5.0`；`scripts/install.sh:129-139` 的 `predates_checksums` 把 `≤0.5.0` 当作「可能没有 SHA256SUMS」而只警告——若下一个版本就叫 0.5.0，这条放宽会作用在一个其实有校验文件的版本上（无害但不准确）。
- 打包：`release.yml:64-69` 把四个平台都 `gzip -9`，Windows 用户拿到 `odw-win-x64.exe.gz`，Windows 自带工具解不了单文件 `.gz`；`install.sh:42` 在 Windows 上只说「去 Releases 下载」，没有 `install.ps1`、Scoop、winget。没有 Homebrew tap。Intel Mac 没有二进制（`install.sh:50-58`）。
- 签名：macOS 只是 ad-hoc 签名（`scripts/build-binary.mjs:87-93`），用浏览器下载会被 Gatekeeper 拦（`curl` 安装不带隔离属性，所以安装脚本路径不受影响）；Windows 未做 Authenticode，会触发 SmartScreen。
  `install.sh:24-27` 自己写明 SHA256SUMS「does not prove the release is authentic」。GitHub artifact attestations 自 2024-06 GA，Homebrew 的 bottle 已带构建来源证明，`gh attestation verify` 可离线核验，不需要管理密钥。https://fosdem.org/2025/events/attachments/fosdem-2025-5344-enhancing-artifact-security-with-github-artifact-attestations/slides/237184/FOSDEM_20_dl6Zn5Z.pdf （检索摘要）
- npm：`npm view odw` 返回 404（名字可用）；而 `npm view open-dynamic-workflows` 显示一个 **0.0.1 版本、由无关账号（imsai）在 2026-05-30 发布**的同名包——用户 `npm i -g open-dynamic-workflows` 会装到别人的东西。README（`README.md:156-158`）只说「once odw is published to npm」。
- Node SEA 官方文档：注入后必须重签；Windows 用 `signtool`（需证书）；文档只给 macOS ad-hoc 示例。https://nodejs.org/download/v8-canary/v26.0.0-v8-canary2026013139dd9cc171/docs/api/single-executable-applications.html （检索摘要）

**ODW 现状：** 发布流水线的「验证 → 四平台构建 → 全部成功才发布 → SHA256SUMS」骨架很好；缺的是版本节奏、CHANGELOG 与发布正文的绑定、包管理器渠道和来源证明。

**关于如何切版本（建议，由维护者决定）：** 现在的 tag 无法回补到历史提交——`version-info.mjs` 要求 tag 等于当时 `package.json` 的版本，而 0.5.0 之后的提交都写着 0.5.0。两种做法：
- **A（推荐）：直接发 `v0.9.0`。** 让二进制版本与 ROADMAP 的 0.6–0.9 标签对齐（ROADMAP、调研笔记、`action@v0.7.0` 这类引用都按路线版本思考）；CHANGELOG 把现有内容改名为 `## 0.9.0 — 2026-10-xx`，开头一段说明「包含路线图 0.5–0.9，自 v0.4.0 起」，把「Changed behavior — check before upgrading」移到最前，
  其余按主题保留（不必硬拆成四个从未发布过的版本）；文档里的 `action@v0.7.0` 一律改成 `@v0.9.0`。之后 1.0 前只发 `0.9.x` 补丁与 `1.0.0-rc.N`。
- **B：发 `v0.5.0`**，ROADMAP 的 0.6–0.9 只作为内部里程碑名。代价是对外版本号与所有内部文档的版本名永久错位，且 `action@v0.7.0` 将来会指向一个内容完全不同的版本。
  无论 A 或 B，都应在同一次提交里把 `install.sh` 的 `predates_checksums` 边界改成 `<0.5.0`（或 `≤0.4.x`）。

---

### 10. 安装脚本整体在顶层执行：截断的下载可能只执行一半 —— 低中 · S

**证据：** `scripts/install.sh` 以 `set -eu` 后直接在顶层执行（`install.sh:29-…`），没有包在函数里最后一行再调用；`curl | sh` 时若连接中断，`sh` 会执行已收到的部分。
同类问题：codex#54465（见第 1 条）。安装是事务式的（失败回滚），所以实际风险低，但改法只有几行（整段包进 `main() { … }`，末行 `main "$@"`），是 rustup、Homebrew 安装脚本的通行做法。

---

### 已检查、判断为已覆盖或暂不立项

- **单次运行内的 fd 与进程上限：** 每个 agent 3 个管道，`concurrency` 默认 `min(16, cpus-2)`（`README.md:4245`），远低于 macOS 默认 256；进程组整体 kill、`killAllAgentProcesses` 在 worker 退出时兜底（`runner.ts:124-135`）。不立项；V2 的 `odw doctor` 加一行 `ulimit -n` 与并发上限的比对提示即可。
- **SSE 扇出：** 已有增量帧与 15 s 心跳（`http-util.ts:253-271`），终态运行不推送；没有发现同类工具在 SSE 上的新问题。不立项。
- **worktree 创建成本（检出时间）：** `git worktree add --detach` 已是最便宜的完整检出；`.worktreeinclude` 的 `symlink:` 共享依赖目录（`src/new.ts:157-187`）已覆盖 `node_modules`。只把「worktree 根目录可配置 + 剩余空间检查」并入 V8。
- **Windows 上的计划任务、容器沙箱：** 已在 README 诚实标注为不支持；需求真实但不是 1.0 门槛。暂缓。
- **代码签名证书（Apple Developer ID 公证、Windows Authenticode）：** 需要付费账号与密钥托管，属于维护者的商业决定；V9 先做无密钥的 GitHub 来源证明。

---

## 1.0 就绪清单（按优先级）

排序依据：是否挡住新用户第一次成功（发布、上手）> 是否在常见环境里造成静默损失（睡眠、磁盘、pid 复用、Windows）> 规模下的体验。每项都控制在一到两天内，复用现有机制。

**V1 · 切一个真实的版本，并让文档与发布对齐 —— S，对应第 1、9 条。**
按第 9 条方案 A 发 `v0.9.0`（或维护者选择的号）：`package.json`/锁文件改版本；CHANGELOG 把 `Unreleased — 0.5.0` 改为 `## 0.9.0 — <日期>`，首段写「自 v0.4.0 起，包含路线图 0.5–0.9」，「Changed behavior — check before upgrading」提到最前，新开空的 `## Unreleased`；
`release.yml` 增加一步：从 CHANGELOG 截取与 tag 同名的小节作为 Release 正文（`body_path`），找不到该小节则发布失败（CI 同时检查 `## Unreleased` 存在）；`generate_release_notes` 保留为附加的 PR 列表。
全仓库的 `action@v0.7.0` 改为新 tag；README「Status」一节删去手写变更摘要，只链接 CHANGELOG；`install.sh` 的 `predates_checksums` 边界改为 `<0.5.0`。发布后用新二进制按 README 的 Quick start 原样走一遍。
**不做：** 不回补 0.5–0.8 的历史 tag（版本校验不允许，也没有意义）；不引入 release-please/changesets 等依赖；不改变 0.x 期间可以有行为变化的约定（只要求写进「check before upgrading」）。

**V2 · 「安装后 60 秒」路径与 `odw doctor` 的运行环境检查 —— S，对应第 2、3、8 条。**
`odw doctor` 增加三行只读检查：`ulimit -n`（与 `concurrency` × 4 比较，偏低时给出提升方法）、运行根与 `os.tmpdir()` 的剩余空间及是否 tmpfs（Linux 读 `/proc/mounts`）、运行根的运行数与总大小（超过 2,000 个或 5 GB 时建议 `odw gc`）。
安装脚本结尾与 `odw init` 的「下一步」统一成同一段三行文字（`odw new hello` → `odw run hello --dry` → `odw serve --open`），替换 `install.sh:307` 那行 v0.4.0 时代的 `odw run <workflow.js> --wait`。顺带把 `install.sh` 整体包进 `main()`（第 10 条）。
**不做：** 不自动修改系统限制或挂载；不在 `doctor` 里做任何付费调用（`--smoke` 照旧可选）。

**V3 · README 瘦身与文档拆分（Diátaxis）—— M，对应第 2 条。**
README（中英各一份）缩到 ≤300 行：一句话定位、动图、为什么、安装（含 Windows）、60 秒首跑、「下一步读什么」链接表、状态与许可证。其余内容原样搬进 `docs/`：
`docs/tutorial/`（第一个工作流、第一次并行、第一次审阅与 apply）、`docs/how-to/`（现有 recipes 并入，加「过夜跑」「在 CI 里跑」「多账号」等）、`docs/reference/`（CLI、配置键、事件类型、失败原因、方言 vs ODW 扩展对照表）、`docs/concepts/`（运行目录、worker、隔离、信任）。
参考页里能生成的部分（CLI 帮助、配置键与默认值、失败原因列表）用 `scripts/` 下的零依赖脚本从源码生成，CI 做漂移检查（与 `embed-*.mjs` 同法），以减少中英两份手工同步；中文先只翻译 README 与 tutorial，reference 先只出英文并在中文目录页说明。GitHub Pages 用默认 Jekyll 主题直接渲染 `docs/`，着陆页 `docs/index.html` 链到它。
**不做：** 不引入 Docusaurus/Mintlify 等构建依赖；不重写内容（这一步只搬家与分类，避免与功能开发冲突）；不做文档版本切换器（README 顶部写「文档对应 main，已发布版本见对应 tag 的 docs/」）。

**V4 · Windows 的真实 CI 与三处 POSIX 假设 —— M，对应第 5 条。**
`windows-smoke` 扩成 `windows-test`：跑不依赖 sh 桩的测试子集（测试文件里用 `process.platform` 跳过的只占少数，按文件白名单起步，逐步扩大），外加两条端到端：mock 适配器的 `odw run hello --dry --wait`、带 `isolation: "worktree"` 的 mock 运行与 `odw diff`。
代码：`git worktree add` 加 `-c core.longpaths=true`（Windows），新增设置 `worktreeRoot`（默认仍为 `os.tmpdir()`，Windows 文档推荐 `C:\odw-wt`）；字符串命令在 Windows 上若找到 Git Bash（`CLAUDE_CODE_GIT_BASH_PATH`、`PATH`、`%ProgramFiles%\Git\bin\bash.exe`）就用它，否则用 cmd.exe 并在运行开始时 `LOG` 一次「exec 字符串走 cmd.exe」，设置 `shell: "bash" | "cmd" | "pwsh" | <路径>` 可覆盖；README 的 CI 说法改准确。
**不做：** 不做 Windows 的 Job Object 管理（需要原生模块，违背零依赖；在文档里说明硬杀 worker 的后果）；不在 1.0 前支持 Windows 计划任务与容器沙箱；不做 WSL 专门路径。

**V5 · 看板在几千次运行下保持常数开销 —— S–M，对应第 3 条。**
(a) worker 在终态时写 `summary.json`（`summaryFrom` 的结果 + 事件文件的大小与 inode），`OdwRunSource` 对有它且签名吻合的终态运行直接读它，不再解析事件；(b) Claude 源的 `discover()` 改为按项目目录与会话目录的 mtime 缓存，未变的目录不再 readdir，节奏降到 5 s（有 cc- 运行在跑时 1 s）；
(c) `/api/activity` 与 `/api/review` 的结果在服务端缓存，按运行列表签名失效，多个标签页共享，`reviews.jsonl` 按 stat 签名缓存；(d) `odw gc --archive <age>`：过期且未 pin 的运行先 `odw bundle` 成 `<runsRoot>/_archive/<id>.odwrun` 再删除目录（`odw view` 照旧能看），默认仍是 dry run。
用 `web/demo-fixtures.mjs` 生成 5,000 个运行做一次前后对比，把数字写进 PR。
**不做：** 不引入 SQLite 等索引存储；不改变运行目录格式（`summary.json` 是可丢弃的缓存，缺失或不符时回退到现有路径）；不做服务端分页 API（Web 端已分页渲染）。

**V6 · 主机级并发上限与跨运行共享的降速 —— S–M，对应第 4 条。**
可选设置 `hostConcurrency: { "*": n, "<adapter>": m }`：在 `scheduler.ts` 的进程内信号量之外，再取运行根下 `_slots/<adapter>/` 的文件槽（`O_EXCL` 创建，内容为 pid、进程启动时间与运行 id，持有者已死则回收，复用 V8 的身份判断），取不到时与 `quotaWait` 一样不占本运行的槽、显示「等待主机槽位」；
自适应降速把当前上限写入 `_slots/<adapter>/limit.json`（带过期时间），其他运行取 min；额度重置后的首次派发按适配器加 0–2 s 随机抖动（对 #53922 的批量启动）。`odw status`/看板显示「主机：codex 6/8」。
**不做：** 不做常驻调度守护进程（ROADMAP 第 5 节）；不跨机器协调；不设默认值（不配置时行为与现在完全一致）。

**V7 · 睡眠、断网与 CLI 中途更新 —— S，对应第 6、7 条。**
(a) 卡死看门狗改用单调时钟（`performance.now()`）计算沉默时长；worker 每 30 s 比较墙钟与单调时钟的差，跳变超过 60 s 记 `host_suspended { sleptSeconds }` 事件，把所有 agent 的沉默计时清零并给一个 `stallTimeout` 的宽限；
(b) 新失败原因 `network`（CLI 输出中可识别的连接错误，按适配器声明式规则匹配，与 `output.background` 同法），并新增设置 `networkWait`：与 `quotaWait` 相同的暂停派发机制，探测（对适配器的 API 主机做 TCP 连接）恢复后继续，`notify.on: ["paused"]` 照常通知；
(c) 可选 `keepAwake: true`：运行期间在 macOS 跑 `caffeinate -i -w <worker pid>`、Linux 跑 `systemd-inhibit --what=idle`（存在时），Windows 跳过并说明，文档写清合盖仍会睡；
(d) 内置 claude 适配器的 agent 环境默认带 `DISABLE_AUTOUPDATER=1`（以当时 Claude Code 文档为准，适配器 `env` 可覆盖）；版本探测在可执行文件 realpath/mtime 变化时重做，写 `cli_version_changed` 并 `LOG`。
**不做：** 不修改系统电源设置（不碰 `pmset`）；不对网络错误做无限重试（`networkWait.max` 必填，与 `quotaWait` 一致）；不阻止用户手动更新 CLI。

**V8 · 磁盘写满与 pid 复用 —— S，对应第 8 条。**
(a) 存活判断加身份：worker 启动时在 `status.json` 记 `bootTime`（`Date.now() - os.uptime()*1000`，四舍五入到分钟）；判断时若当前开机时间晚于记录的 `bootTime`，该 pid 一律视为已死（重启后的复用全部消除），同次开机内的复用再用 Linux `/proc/<pid>/stat` 的 starttime、其他平台的 `ps -o lstart=` 核对（取不到则维持现状）；
(b) `JsonlSink.emit` 捕获 `ENOSPC`/`EDQUOT`：停止派发、把运行转为 `paused`（`pausedFor: "disk"`），在运行根预留的 64 KB 占位文件（运行创建时写）删除后写下最终状态与一行明确的原因，`odw resume` 在空间恢复后继续；
(c) 派发 worktree 前检查 worktree 根目录的剩余空间（`fs.statfsSync`，Node ≥18.15），低于 `diskMinFree`（默认 2 GB）时同样暂停并通知；Linux 上 `os.tmpdir()` 是 tmpfs 时运行开始 `LOG` 一次并建议设置 V4 的 `worktreeRoot`。
**不做：** 不自动删除任何东西来腾空间（只提示 `odw gc`）；不做跨平台的进程启动时间原生绑定（取不到就降级为现状）。

**V9 · 包管理器渠道与来源证明 —— S–M，对应第 9 条。**
`release.yml`：Windows 资产改为 `.zip`（同时保留 `.gz` 一个版本以兼容旧安装脚本）；加 `actions/attest-build-provenance` 为每个二进制生成来源证明，README 写 `gh attestation verify odw-… --repo xz1220/open-dynamic-workflows`；
发布后自动向 `xz1220/homebrew-tap` 推送公式更新（darwin-arm64、linux-x64/arm64）、生成 Scoop 清单（`bucket/odw.json`）；提供 `install.ps1`（下载 zip、校验 SHA256SUMS、放到 `%LOCALAPPDATA%\Programs\odw` 并加入用户 PATH）。
npm：发布 `odw`（名字目前可用）作为 Node ≥20 用户的第二渠道（`prepublishOnly` 已有），README 明确警示 `open-dynamic-workflows` 这个 npm 名不是本项目。winget 清单在有 Authenticode 签名之前不提交（SmartScreen 与 winget 审核都会卡未签名安装器）。
**不做：** 不买证书、不做 Apple 公证（维护者另行决定）；不发 Intel Mac 二进制；不做自动更新（`odw` 不自升级，交给包管理器）。

**V10 · 1.0 的兼容承诺写下来 —— S，对应第 9 条。**
新增 `docs/reference/stability.md`（V3 的一页）：哪些是 1.0 的稳定面——Claude Code 方言（以一致性套件为准）、`odw` 的命令与退出码、`odw.config.json` 的键、运行目录中 `meta.json`/`status.json`/`events.jsonl` 的字段、HTTP API 的只读端点；哪些明确不稳定（看板内部 API、`--json` 之外的人类可读输出、带 `experimental` 标注的扩展）。
事件与配置加 `schemaVersion`，`odw doctor` 对旧运行根给出提示；CHANGELOG 的「Changed behavior」改名为「Breaking」并在 1.0 之后只允许出现在主版本。
**不做：** 不在 1.0 前冻结 ODW 扩展的全部细节（逐项标注 stable/experimental 即可）；不承诺对 0.x 运行目录的永久兼容（`odw doctor` 提示迁移）。

**优先顺序建议：** V1 → V2 → V3 先做（不切版本，其他改进都到不了用户手里；V2 很小，可与 V1 同批）；
V7、V8 次之（过夜长任务的静默损失，正是 ODW「运行独立于宿主、可以离开」的承诺所在，且都能复用 `quotaWait` 的暂停机制）；
V4 与 V9 一起做（Windows 的 CI、shell 与安装渠道是同一批用户）；V5、V6 在有实测数据之后做；V10 在 1.0-rc 前完成。
