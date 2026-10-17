# Open Dynamic Workflows — 路线图

> 重写日期：2026-10-16（2026-10-17 更新状态）。上一版（2026-06-05）的主线——运行引擎 → 运行记录 → Web 观测 / Chat Host——已基本交付，本版按**用户需求**重新排序。
> 需求依据见 [`docs/research/user-needs-2026-10.md`](research/user-needs-2026-10.md)（15 条排序后的痛点，均附来源）。
> 状态标记：✅ 已交付 · 🚧 本轮进行中 · ⏳ 规划中 · 💤 暂缓。

---

## 0. 定位

**ODW 是动态工作流的可移植运行时，外加一个本地观测台。**

一份 Claude Code 方言的脚本（`export const meta` + 注入的 `agent / parallel / pipeline / phase / log / budget / workflow`），可以原样跑在 Claude Code、Codex、Gemini、Qwen、Kimi、OpenCode、Kilo、Cursor、Oh My Pi 或自定义 CLI 上。每次运行都是一个脱离宿主会话的后台 worker，加一个可查询、可追溯的 run 目录。

调研结论里，ODW 有三点别人难以复制的差异，后面的取舍都围绕它们：

1. **一份脚本，九种以上 CLI。** 直接回应"被单一供应商锁定"和"模型一换，工作流就作废"的抱怨，也让跨供应商互审成为可能。
2. **运行独立于宿主会话。** worker + run 目录的结构意味着：只要把每个 agent 的结果落盘，ODW 就能在 Claude Code 做不到的地方续跑（跨会话、`claude -p` 下）。
3. **本地优先、零运行时依赖、复用用户已经付费的 CLI 订阅。** 还能只读地观测 Claude Code 自己的 workflow 运行。

---

## 1. 设计原则（不随版本变化）

- **零运行时依赖。** 运行时是纯 Node；看板是由内嵌二进制直接服务的单文件 bundle，不访问任何 CDN。
- **方言保真优先。** 能在 Claude Code 跑的脚本，在 ODW 也必须能跑；ODW 独有的能力一律以**显式扩展**的形式提供，并在文档中标明。
- **不做静默降级。** 接受了但没生效的选项要发出响亮的 `LOG`；失败要有类型、有证据，不能被当成成功放过去。
- **状态必须真实。** 进程死了就显示 `stale`，不是 `running`；被停止的运行就是 `stopped`，不是 `done`。
- **写能力保持窄口径。** 看板只能写 Chat Host 会话、偏好设置，以及对 ODW 自己的运行发起控制；Claude provider 永远只读；绑定到非回环地址时一律拒绝写入。

---

## 2. 已交付（截至 2026-10-17）

| 模块 | 内容 |
| --- | --- |
| 运行层 | 全部原语（含嵌套 `workflow()`）、schema 校验与重试、`budget` 估算上限、9 个内置适配器 + 自定义、worktree 隔离、loader 源变换、方言双兼容审计 |
| 运行记录 | detached worker + run 目录（原子写）、JSONL 事件、`workflowName` 创建时写入、`--wait` 终态退出码、`rerun`、`pause/resume/stop`、OS-cron 配方 |
| 看板 | `odw serve`：Activity / Jobs / Job（活 DAG）/ Workspace / Settings / Chat Host，SSE 实时推送，Claude Code 运行只读观测 |
| 分发 | SEA 单文件二进制 + 事务式安装脚本 + skill |

**本轮（2026-10）的可靠性与体验修复：** ✅

- 进程生命周期：超时或停止时按进程组整体 kill（包括孙进程）；停止会中断已在运行的 agent；未处理的 rejection 会把运行记为 failed，而不是让 worker 默默死掉；被脚本吞掉的致命错误不再被误报为 `done`。
- 配置：非法数值（如 `"concurrency": "auto"`）直接报 `ConfigError`，不再带着 NaN 继续运行。
- 结构化输出：从所有候选片段中选出第一个**通过 schema 校验**的 JSON；重试时附上上一次的回复，且每次重试都计入预算。
- 安全：workflow 的 `meta` 改为纯字面量解析，列出工作流时不再执行文件里的任何代码。
- 服务端：缓存命中时同样重新判断进程存活；文件监听加了防抖；事件改为增量读取（`?since` / `?tail`，带 ETag）；新增 `/api/activity` 聚合接口；修复请求体多字节字符在分块边界被截断的问题，超限返回 413；非法转义返回 400；`server.ts` 按职责拆分。
- 构建与 CI：typecheck 不会再悄悄换掉内嵌看板；生成文件做漂移检查；CI 覆盖 Node 20/22/24 和 macOS/Windows；安装脚本校验 SHA256。
- 诊断：新增 `odw doctor [--smoke]`，检查运行环境、配置、运行目录和各适配器；`--smoke` 会发一条真实提示，揪出"以 0 退出却没回答"的无头 CLI。
- 运行列表推送改为增量（`/api/stream?delta=1`）；脚本报错的行号与源文件一致；Windows 终端也能显示实时视图。
- 新示例 `review-swarm.js`：先梳理改动，再按多个视角并行审查，每条发现独立验证，最后输出带证据的分级报告。
- 独立代码复审发现的 15 个问题全部修复：工作流加载阶段的代码注入、停止时先 SIGTERM 再 SIGKILL、schema 歧义不再靠猜、聊天会话与多进程写入、缓存与增量推送的竞态、Windows 实时视图等。
- GitHub Pages 落地页按同一套设计语言重做。
- **看板重新设计**（"纸、墨、信号"）：脉搏图、带走线动画的 DAG、甘特时间线、agent 抽屉、可过滤可跟随的日志、JSON 结果树、命令面板、快捷键、运行结束提示与桌面通知、亮/暗主题、减弱动效、增量渲染（不再重置滚动位置）。

**第三轮（2026-10，`next`）：** ✅

- **人工检查点（X4）**：`checkpoint(title, { payload, timeout, onTimeout })` 持久等待，不占 agent 槽位也不计预算；`odw approve|reject [--note] [--checkpoint N]`、看板审批卡片、`POST /api/runs/:id/checkpoint` 三种回答方式；决定写入只追加的 `decisions.jsonl`，不与停止指令争用 `control.json`；`notify.on` 可选 `"waiting"`；resume 时重新询问；示例 `plan-approve-execute.js`。
- **失败分类与退避（N6 前半）**：8 类失败原因，约 80 条各 CLI 原文样本；限流按 retry-after 或指数退避（带抖动、上限 `maxBackoff`）重试，等待中停止立即生效；额度/登录不重试而给出可操作的提示，同一适配器连续 3 次时告警；Claude 文本模式"以 0 退出的 API 错误"也能识别。
- **worktree 环境（X5）**：`.worktreeinclude`（含 `symlink:`）、带超时的 `worktreeSetup`、每个 agent 独占的 `ODW_PORT` 及 `ODW_RUN_ID`/`ODW_AGENT_ID`。
- 看板：「待你处理」提醒、失败原因旁显示限流/额度的解除时间、为 X1 准备好的改动审阅页；官网新增「为长任务而生」；两篇实用配方（恢复运行、运行通知）；删除无人使用的 skill 内嵌产物。
- **审阅并应用改动（X1）**：worktree agent 的改动在 worktree 删除前落盘为 `agents/<id>.diff`（与 diff 解析器约定的 git 参数；`.worktreeinclude`/`worktreeSetup` 放进去的文件按内容哈希排除；超过 `maxDiffBytes` 在行边界截断并附说明，计数始终描述完整改动）；`keep: true` / `keepBranches` 把改动提交到 `odw/<runId>/<agentId>-<label>` 分支且不碰用户的 HEAD 和索引；`odw diff [--agent] [--stat]`、`odw apply --agent [--check] [--force]`（`git apply --3way`）；`GET /api/runs/:id/agents/:agentId/diff`；看板改动页端到端验证。
- **权限档位（X2 前半）**：`read` / `edit` / `full` 三档（ODW 扩展），运行档位来自配置 `permissions` 或 `odw run|rerun|resume --permissions`，适配器自己的 `permissions` 与 `agent(…, { permissions })` 只能降档，越权的调用以写明两个档位的 `AgentError` 失败；各内置适配器的姿态参数移入 `permissionArgs`、在命令的 `{permission_args}` 处展开，默认 `edit` 与原 argv 逐字节一致；只填各 CLI 文档证实的映射（claude、codex、gemini 三档，qwen 有 full），不支持只读的 CLI 在启动前拒绝、没有 full 的按 edit 运行并每个适配器记一次 LOG；启动横幅逐个适配器列出实际档位，`agent_started` 与保存的结果带上档位，`odw doctor` 列出各适配器支持的档位；`agentEnv: "minimal"` 只把必要变量与各 CLI 文档列出的认证变量传给 agent（`agentEnvPass` 追加）。Codex 的 MCP 写工具审批（#23）不由任何档位解决，文档给出 `approval_mode = "approve"` 的做法。
- **有证据的成功（N7 大部分）**：`agent(…, { expect })`（ODW 扩展）在回复与 schema 校验之后检查工作——`changes`（有/无文件改动）、`files`（glob 须匹配改动或新建的文件）、`command`（在 agent 工作区以 0 退出，作为 agent 名下的 `exec()` 步骤，可被停止）、`match`（回复正则）；改动从 git 读取：原地运行对比 agent 启动前的快照（排除用户自己的未提交改动和运行目录，计入 agent 的提交），隔离运行与保留的 diff 完全一致；没达到就带着缺失项（含失败命令的输出）重试 `expectRetries` 次（默认 1），之后以 `reason: "unmet_expectation"` 和 `misses` 失败；隔离重试从全新 worktree 开始并取代先前的改动；缺失在产出回复的适配器上重试、绝不触发回退，回退（额度/登录）的调用在下一个适配器上带着 `expect` 从头开始。无需开启：空回复 → `empty_reply`（`allowEmpty: true` 例外）；claude `result` 的 `permission_denials` 非空而回复声称成功时（输出解码器经 `deniedPath` 读取），默认回复照常成立，被拒绝的调用记为 `agent_finished` 与保存结果上的 `denied` 并写一行日志（与 Claude Code 自己的 Workflow 工具一致），`expect` 下算作一项缺失（重试后仍被拒绝即 `permission`），`permissionDenials: "fail"`（运行级或按适配器）则直接以 `permission` 失败。
- **真实用量与花费（N5）**：内置 `claude` 适配器改用 `stream-json`（逐轮输出，`result` 事件带回复、用量、花费与 `is_error`，错误走失败分类）；JSON / JSONL 输出格式可声明 `usagePath`/`costPath`/`errorPath`，解析不到文本时退回原始输出并记一条 LOG；用量按 agent 与运行汇总（含重试），`budget` 优先计真实输出 token；`odw status`、实时视图与看板显示 token 与花费；单次 `parallel()`/`pipeline()` 超过 `fanOutWarn`（默认 25）时提示。
- **按阶段指定适配器与模型、回退链（X7 前半）**（ODW 扩展）：`meta.phases` 条目可写 `{ title, adapter?, model? }`（纯字符串仍是标题），`phase(title, { adapter?, model? })` 为其后的调用设置同样的默认值，`agent()` 自己的选项永远优先；resume key 只取调用写下的选项，阶段默认值不进键（与运行默认适配器同理），改动阶段路由后已完成的调用仍会重放。`models` 配置定义模型分层，`model: "@fast"` 按实际运行的适配器取各自的模型 ID，未知层级以列出所有层级的 `AgentError` 失败。`fallback` 配置与 `agent(…, { adapter: ["codex", "claude"] })` 定义回退链：额度用尽或登录失败（限流仍原地重试）时换到链上下一个适配器——全新提示词、相同选项、相同权限档位（不能运行该档位的适配器记 LOG 后跳过，绝不升档）——先释放旧适配器槽位再在新适配器上排队，transcript 记 `{"kind":"attempt","reason":"fallback","adapter":…}`，失败尝试的用量照常计入；`agent_finished` 与保存的结果记录产出值的适配器和 `fellBackFrom`，`odw status`、实时视图与 `/api/runs/:id` 显示回退路径。额度熔断：同一适配器连续 `quotaBreaker`（默认 3）次额度失败后，本次运行之后的调用跳过它（只记一条 LOG）。

---

## 3. 路线：按需求排序

### Now — 0.6「可靠与可控的成本」

| # | 方向 | 需求 | 规模 | 状态 |
| --- | --- | --- | --- | --- |
| N1 | **每个 agent 的结果落盘 + `odw resume`**：已完成的 agent 结果原子写入 run 目录，可以按运行和按 agent 查询（`odw agents`、`odw result --agent`、API、看板抽屉）；`resume` 重放 `(prompt, opts)` 未变的调用，只重跑变化或失败的部分 | #4 恢复（[#24](https://github.com/xz1220/open-dynamic-workflows/issues/24)） | M | ✅ |
| N2 | **完成通知钩子**：`notify` 配置支持 command 和 webhook（兼容 Slack/Discord），覆盖运行结束、失败、停止；看板侧有提示和桌面通知 | #11 | S | ✅ |
| N3 | **卡死看门狗**：agent 输出长时间没有动静（`stallTimeout`）就终止并重启，重启次数有上限（`stallRestarts`）并记录事件；worker 收到 SIGTERM/SIGINT/SIGHUP 时干净地停止运行 | #5 | S | ✅ |
| N4 | **命令原语** `exec()`（ODW 扩展）：异步执行，支持参数、cwd、超时、输出上限，可被取消，返回 stdout/stderr/退出码，并在 DAG 中可见；附 `test-fix-loop.js` 示例 | [#31](https://github.com/xz1220/open-dynamic-workflows/issues/31) | M | ✅ |
| N5 | **用量与成本**：适配器改用各 CLI 的 JSON 输出模式（`claude --output-format json` 的 `total_cost_usd`、`codex exec --json` 的 usage），按 agent 和阶段记录真实用量，`budget` 改用真实计量；大规模 fan-out 启动前给出预警 | #1 | M | ✅ claude 改用 stream-json，按 agent / 运行记录 token 与花费，`budget` 用真实输出 token，`fanOutWarn`；codex 仍为文本模式 |
| N6 | **失败分类与退避**：区分限流、过载、额度耗尽、鉴权四类失败；按适配器节流，遵守 retry-after；额度耗尽时整体暂停，到重置时间自动恢复；支持回退适配器链 | #3 | M | 🚧 分类、退避重试、可操作的报错 ✅；按适配器的并发上限、限流后自适应减半、为提示缓存错开扇出 ✅；回退链与额度熔断随 X7 ✅；额度暂停待做 |
| N7 | **有证据的成功**：读取 CLI 报告的成功信号（`is_error`、`permission_denials`、MCP 状态），转成有类型的失败；`agent()` 可声明后置条件（"有文件改动"、"某命令通过"）。`odw doctor --smoke` 已交付 | #7（[#23](https://github.com/xz1220/open-dynamic-workflows/issues/23)） | M | 🚧 `agent(…, { expect })`（`changes`/`files`/`command`/`match`，带缺失项重试后以 `unmet_expectation` 失败）、空回复 `empty_reply`、claude `permission_denials` 记为 agent 的 `denied` 并写日志（`expect` 下算缺失，`permissionDenials: "fail"` 时为 `permission`）✅；MCP 状态待做 |
| N8 | **原生结构化输出**：优先使用 `codex --output-schema` / `claude --json-schema`；校验器不检查的 schema 关键字默认在运行日志里大声报告，设 `schemaKeywords: "strict"` 则启动前拒绝 | #12 | S–M | ✅ `claude --json-schema`（取 `result` 事件的 `structured_output`）、`codex --output-schema`（仅 strict schema，文件放在 run 目录、用完即删），本地仍校验每次回复；启动前逐个找出校验器不检查的关键字与位置：默认（`"warn"`）每次运行记录一次 LOG，写明由谁强制执行（拿到原生 schema 的 CLI，否则无人），`"strict"` 以 `AgentError` 拒绝；`format` 视为注解；格式错误的 schema 一律拒绝；`schemaPrompt` |

### Next — 0.7「审阅与掌控」

| # | 方向 | 需求 | 规模 | 状态 |
| --- | --- | --- | --- | --- |
| X1 | **diff 作为运行产物 + `odw apply`**：保留 worktree 的分支和 diff；合并前用 `git merge-tree` 预检，再跑校验命令，逐个合并；看板提供并排 diff 审阅 | #2 | M | ✅ diff 落盘（排除初始化文件、可截断）、`keep` 分支、`odw diff`/`odw apply [--check]`、看板改动页；`git merge-tree` 预检与逐个合并后的校验命令待做 |
| X2 | **权限档位**：read-only / edit / full 三档，映射到各 CLI 的对应参数，启动前展示；环境变量白名单 + 密钥引用脱敏；不受信任的仓库使用 `--bare` | #6 | M | 🚧 三档 + 按 CLI 映射（只填文档证实的）、`--permissions`、`agent()` 只能降档、启动横幅、`odw doctor` 档位、`agentEnv: "minimal"` 白名单 ✅；密钥引用脱敏与 `--bare` 待做 |
| X3 | **agent transcript**：保存每个 agent 的 JSON 流（工具调用、重试）；看板和 `odw logs --agent` 可查看；导出 OpenTelemetry GenAI span | #8 | M | ✅ 记录与回看（`odw logs --agent [--raw] [--follow]`、API、看板实时侧栏）；OpenTelemetry 导出待做 |
| X4 | **人工检查点** `checkpoint()`（ODW 扩展）：持久暂停，`odw approve/reject [--edit]` 继续；看板提供审批入口（依赖 N1） | #9 | M | ✅（`--edit` 待做） |
| X5 | **worktree 环境**：支持 `.worktreeinclude`、带超时的 setup 命令、为每个 agent 分配 `ODW_PORT` | #10 | S | ✅ |
| X6 | **调度**：`odw schedule add/list/remove/run` 写入 cron/launchd/systemd（不引入 daemon）；每个定时任务一把防重叠锁（失效锁自动接管）、每次运行一行日志、上次与下次运行时间；错过的运行按各后端处理（systemd `Persistent=true` 开机补跑）；失败通知复用 `notify` | #14 | S | ✅ |
| X7 | **按阶段指定适配器和模型**：设置默认值、模型分层和回退链；解析 Claude plugin 工作流 | #13 | M | 🚧 阶段默认适配器/模型、模型分层、回退链与额度熔断 ✅；解析 Claude plugin 工作流待做 |

### Later — 0.8+「规模与生态」

- 可选的容器运行器（默认断网）。（#6，L）
- `odw eval`：用例 × 适配器 × 重复次数，输出通过率、成本和延迟；运行元数据记录 CLI 版本；提供 `odw compare runA runB`（`odw diff <run_id>` 已用于查看一次运行保留的改动）。（#15，L）
- 可分享的脱敏运行包；看板远程只读访问（写操作必须带令牌鉴权）。（#11/#13，M）
- 发布方言双兼容测试套件，作为社区工作流的兼容性标准。（#13）

---

## 4. 看板（Web 客户端）路线

当前形态：`odw serve` 内嵌的单文件 SPA（vanilla TS + esbuild，零依赖）。视觉语言是"纸、墨、信号"：暖纸色底、近黑的墨色、一种代表"活着"的信号绿、朱红表示失败、琥珀表示等待；衬线体用于标题和数字，等宽体用于机器信息；暗色模式即墨与纸互换。

| 阶段 | 内容 |
| --- | --- |
| ✅ 本轮 | 增量渲染（morph）；脉搏图；带绘制与流动动画的 DAG（缩放、适应、拖拽、自动跟随当前阶段）；甘特时间线；agent 抽屉；日志过滤与跟随；JSON 树；命令面板（⌘K）与快捷键速查（?）；运行结束提示 + 桌面通知；首次使用引导；主题、动效、语言偏好；键盘可达与对比度；手机与窄屏布局；增量推送运行列表 |
| ✅ 随 N1、N4 | 抽屉内显示 agent 的实际输出（运行中即可查看）；DAG、时间线、日志中显示 `exec()` 命令步骤 |
| ✅ 前端已就绪 | 检查点审批卡片（X4）、token 与花费（N5）、失败原因标签（N6）、运行钩子配置（N2）——后端数据一到即可显示 |
| ✅ 前端已就绪（随 X1） | **改动（Changes）标签页**：按 agent 审阅 worktree 改动——文件卡片可折叠、表头吸顶、新旧行号、替换行按词标出改动、锁文件与删除默认折叠、行数上限外给出 `odw diff`；抽屉内的改动摘要、DAG 节点上的 +/− 角标、运行头部的改动行数；一键复制 `odw apply` 与保留分支的 `git switch`；`j`/`k` 切换 agent |
| ✅ 本轮 | 「待你处理」：Activity 首屏列出等待决定的检查点，以及过去一天失败或失去 worker 的运行（附 `odw resume` 命令）；官网新增「为长任务而生」一节 |
| ⏳ 随 N5、X3 | 按 agent 和阶段的成本视图；transcript 回放 |

开发方式：`node web/demo-fixtures.mjs <runs> <proj> --live` 生成实时模拟数据，`node web/dev.mjs --api http://127.0.0.1:4317` 启动开发服务器（每次刷新都会重新构建）。

---

## 5. 明确不做

- **GUI 发起通用工作流 / 参数表单**：工作流由 Agent 或 CLI 发起；看板只负责观测和控制 ODW 自己的运行。
- **自研常驻调度 daemon**：调度交给操作系统（X6 只负责写入系统定时任务）。
- **托管执行策略 / 根级授权体系**（见 2026-09 triage 中的 PR #30）：等有了具体的托管用户和经过独立评审的威胁模型再议。
- **分发 Hub / 市场**：先做可分享的运行包和兼容性套件，Hub 暂缓。💤
