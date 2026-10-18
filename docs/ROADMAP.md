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
- **审阅并应用改动（X1）**：worktree agent 的改动在 worktree 删除前落盘为 `agents/<id>.diff`（与 diff 解析器约定的 git 参数；`.worktreeinclude`/`worktreeSetup` 放进去的文件按内容哈希排除；超过 `maxDiffBytes` 在行边界截断并附说明，计数始终描述完整改动）；`keep: true` / `keepBranches` 把改动提交到 `odw/<runId>/<agentId>-<label>` 分支且不碰用户的 HEAD 和索引；`odw diff [--agent] [--stat]`、`odw apply --agent [--check] [--force]`（`git apply --3way`）；`GET /api/runs/:id/agents/:agentId/diff`；看板改动页端到端验证。随后补齐预检与校验：`odw apply` 动手前先在索引的临时副本上做同样的 `git apply --3way --cached`，逐文件报告 clean / CONFLICT（附合并后会留在文件里的冲突行，或 `deleted here`、`binary` 等无法合并的原因）/ already applied（已应用的文件不再参与应用），`--check` 到此为止；`--all` 按 agentId 把已完成的 agent 叠加预览（会冲突的不进入叠加），依次应用到第一个会冲突的为止并报告哪些应用了、哪些没有，失败 agent 的 diff 只能 `--agent` 单独应用；`--verify "<cmd>"` / 配置 `applyVerify`（`--no-verify` 跳过）在每次应用后于仓库根目录运行（受 `timeout` 约束），失败、超时或 Ctrl-C 时不借助 stash 精确回滚该次应用涉及路径的内容（字节、权限、符号链接）与索引项（含冲突阶段、assume-unchanged/skip-worktree 标记），用户其他未提交的改动一概不动，校验期间这些文件上的改动先另存再回滚。索引看不到的东西在工作树里检查：重命名落点上已有的文件、挡路的未跟踪/被忽略文件、需要目录处的文件以及非 UTF-8 路径都在动手前拒绝；每次应用前都先保存涉及的路径，git 写到一半放弃时也能原样恢复；管道或终端断开不会打断回滚。
- **权限档位（X2 前半）**：`read` / `edit` / `full` 三档（ODW 扩展），运行档位来自配置 `permissions` 或 `odw run|rerun|resume --permissions`，适配器自己的 `permissions` 与 `agent(…, { permissions })` 只能降档，越权的调用以写明两个档位的 `AgentError` 失败；各内置适配器的姿态参数移入 `permissionArgs`、在命令的 `{permission_args}` 处展开，默认 `edit` 与原 argv 逐字节一致；只填各 CLI 文档证实的映射（claude、codex、gemini 三档，qwen 有 full），不支持只读的 CLI 在启动前拒绝、没有 full 的按 edit 运行并每个适配器记一次 LOG；启动横幅逐个适配器列出实际档位，`agent_started` 与保存的结果带上档位，`odw doctor` 列出各适配器支持的档位；`agentEnv: "minimal"` 只把必要变量与各 CLI 文档列出的认证变量传给 agent（`agentEnvPass` 追加）。Codex 的 MCP 写工具审批（#23）不由任何档位解决，文档给出 `approval_mode = "approve"` 的做法。
- **密钥脱敏（X2 后半）**（ODW 扩展）：odw 写下的 agent 内容——transcript（随流脱敏，跨两段输出的密钥同样处理，只保留尚未结束的一行或私钥块）与 stderr 结尾（从行首截取，不留半个密钥）、保存的 agent 结果、事件（LOG、`agent_failed` 错误，失败输出先脱敏再截取首尾）、`exec()` 命令行与 `check` 失败输出、运行错误、`status.json` 的等待检查点、webhook 负载——写入前把疑似密钥替换为 `«redacted:<kind>»` 并标 `redacted: true`：agent 与命令所用环境（odw 自身与各适配器 `env`）中名字像密钥的变量（`*_KEY`、`*TOKEN`、`*SECRET*`、`*PASSWORD*`、`AUTHORIZATION`、云凭据）的值（≥ 8 字符，按值转义合成一个正则，长者优先）与此类 `NAME=value`，常见令牌形态（Anthropic、OpenAI、GitHub、Slack、AWS、Google、JWT、PEM 私钥、`Bearer`），以及 `redact.extra`；规则每次运行编译一次。工作流自己的返回值只脱敏令牌形态；提示词、agent 所见与保存的 diff（`odw apply` 要应用）从不脱敏；resume 按保存的样子重放并记一行 LOG。配置 `redact: { env, patterns, extra } | false`，`odw doctor` 报告是否开启；看板类型带 `redacted`。随后补齐最后几处明文：运行的 `worker.log`（worker 进程的 stdout/stderr 在运行的脱敏器建好后随写随脱敏，含工作流的 `console.log`，未结束的行在退出时写出）；Chat Host 的 `_chat/sessions.json` 与 `/api/chat/sessions`（Codex 回复完整脱敏，用户输入与贴回的运行结果只脱敏令牌形态，流式回复结束前只保留整行，旧文件读取时脱敏，消息标 `redacted: true`；当前回合交给 Codex 的消息不脱敏）；运行的 `args` 在 `/api/runs/:id`（`argsRedacted: true`）与 `/api/schedules` 对外提供时脱敏令牌形态，`meta.json` 与定时任务原样保存，`odw rerun`/`odw resume` 用原始 args。`redact: false` 照常关闭全部。
- **不受信任的仓库（X2 收尾）**（ODW 扩展）：`trust: "trusted" | "untrusted"`（配置、`odw run|rerun|resume --untrusted`、按适配器；默认 trusted，不受信任运行的 rerun/resume 仍不受信任）。不受信任时每个 CLI 以其文档给出的"忽略所在仓库"方式运行——`untrustedArgs` 加在档位参数之后：claude `--safe-mode`（关闭 CLAUDE.md、skills、插件、hooks、MCP、自定义命令与 agents、workflows，认证照常；不用 `--bare`，它只接受 API key，订阅用户无法使用）、qwen `--safe-mode`、omp `--no-extensions --no-skills --no-rules`（部分）；codex（AGENTS.md）、gemini（GEMINI.md、`.gemini/settings.json`，其不受信任文件夹模式在无头下直接退出）、kimi、kilo、opencode、cursor 没有文档化的方式（只见于源码的开关不映射），每次运行每个适配器记一行"仍会传给 agent 的内容"（`untrustedNote`），绝不悄悄降级；用户自己的适配器没有 `untrustedArgs` 时同样说明。仓库自己的代码不由 odw 执行：`.worktreeinclude` 的 `symlink:` 行不做链接（普通行照常复制），仓库内配置（如 `./odw.config.json`）设置的 `worktreeSetup` 不运行并记 LOG（用户自己的配置照常）；所用配置是仓库自己的时另说一次其适配器仍生效；仓库内配置不能放宽 `~/.config/odw/config.json` 的 `trust`。信任级别显示在启动横幅、`odw doctor`（每个适配器的不受信任姿态）、运行 setup（`BEHAVIOUR_SETTINGS`）、`agent_started`/保存的结果/`odw agents --json`（`trust: "untrusted"`）、看板类型 `AgentView.trust` 与详情抽屉。
- **有证据的成功（N7 大部分）**：`agent(…, { expect })`（ODW 扩展）在回复与 schema 校验之后检查工作——`changes`（有/无文件改动）、`files`（glob 须匹配改动或新建的文件）、`command`（在 agent 工作区以 0 退出，作为 agent 名下的 `exec()` 步骤，可被停止）、`match`（回复正则）；改动从 git 读取：原地运行对比 agent 启动前的快照（排除用户自己的未提交改动和运行目录，计入 agent 的提交），隔离运行与保留的 diff 完全一致；没达到就带着缺失项（含失败命令的输出）重试 `expectRetries` 次（默认 1），之后以 `reason: "unmet_expectation"` 和 `misses` 失败；隔离重试从全新 worktree 开始并取代先前的改动；缺失在产出回复的适配器上重试、绝不触发回退，回退（额度/登录）的调用在下一个适配器上带着 `expect` 从头开始。无需开启：空回复 → `empty_reply`（`allowEmpty: true` 例外）；claude `result` 的 `permission_denials` 非空而回复声称成功时（输出解码器经 `deniedPath` 读取），默认回复照常成立，被拒绝的调用记为 `agent_finished` 与保存结果上的 `denied` 并写一行日志（与 Claude Code 自己的 Workflow 工具一致），`expect` 下算作一项缺失（重试后仍被拒绝即 `permission`），`permissionDenials: "fail"`（运行级或按适配器）则直接以 `permission` 失败。
- **MCP 状态（N7 收尾）**（ODW 扩展）：读取 Claude Code stream-json 的首个事件 `{"type":"system","subtype":"init"}` 的 `mcp_servers: [{ name, status }]`（字段与状态 `connected`/`failed`/`needs-auth`/`pending`/`disabled` 已对照 headless 文档与 Agent SDK 的 SDKSystemMessage/McpServerStatus 核实），适配器以 `output.mcpEvent` + `output.mcpPath` 通用声明（内置 claude 为 `"system"` + `["mcp_servers"]`，与 Codex 的 `mcp_tool_call` 无关）；状态不是 `connected` 的服务器记为 agent 终止事件与保存结果上的 `mcp: [{ name, status }]`（看板类型 `AgentView.mcp`），每次运行按（服务器，状态）记一行日志（"MCP server github failed to start (claude agent `fix-auth`): its tools were unavailable"）；`mcpFailures: "warn"`（默认，与 Claude Code 只警告一致）保留回复，`"fail"` 让服务器为 `failed` 或 `needs-auth` 的 agent 以 `mcp_unavailable` 失败；`agent(…, { expect: { mcp: ["github"] } })` 把列出的服务器缺席（`failed`、`needs-auth`、`disabled`、未配置）算作缺失，按 `expectRetries` 重试后 `unmet_expectation`。`pending` 按 Claude Code 文档不单独算作失败（`.mcp.json` 的服务器常以此状态启动、在后台连接），只记录与写日志。
- **真实用量与花费（N5）**：内置 `claude` 适配器改用 `stream-json`（逐轮输出，`result` 事件带回复、用量、花费与 `is_error`，错误走失败分类）；JSON / JSONL 输出格式可声明 `usagePath`/`costPath`/`errorPath`，解析不到文本时退回原始输出并记一条 LOG；用量按 agent 与运行汇总（含重试），`budget` 优先计真实输出 token；`odw status`、实时视图与看板显示 token 与花费；单次 `parallel()`/`pipeline()` 超过 `fanOutWarn`（默认 25）时提示。内置 `codex` 随后改用 `codex exec --json --output-last-message {reply_file}`：回复取自该文件（否则取最后一条 `agent_message`），token 取自 `turn.completed`（无花费），transcript 显示命令、改动、MCP 与网络搜索，`turn.failed` / `error` 事件按失败分类；JSONL 输出新增 `match`、`errorEvents` 与 `{reply_file}` 占位符。
- **按阶段指定适配器与模型、回退链（X7 前半）**（ODW 扩展）：`meta.phases` 条目可写 `{ title, adapter?, model? }`（纯字符串仍是标题），`phase(title, { adapter?, model? })` 为其后的调用设置同样的默认值，`agent()` 自己的选项永远优先；resume key 只取调用写下的选项，阶段默认值不进键（与运行默认适配器同理），改动阶段路由后已完成的调用仍会重放。`models` 配置定义模型分层，`model: "@fast"` 按实际运行的适配器取各自的模型 ID，未知层级以列出所有层级的 `AgentError` 失败。`fallback` 配置与 `agent(…, { adapter: ["codex", "claude"] })` 定义回退链：额度用尽或登录失败（限流仍原地重试）时换到链上下一个适配器——全新提示词、相同选项、相同权限档位（不能运行该档位的适配器记 LOG 后跳过，绝不升档）——先释放旧适配器槽位再在新适配器上排队，transcript 记 `{"kind":"attempt","reason":"fallback","adapter":…}`，失败尝试的用量照常计入；`agent_finished` 与保存的结果记录产出值的适配器和 `fellBackFrom`，`odw status`、实时视图与 `/api/runs/:id` 显示回退路径。额度熔断：同一适配器连续 `quotaBreaker`（默认 3）次额度失败后，本次运行之后的调用跳过它（只记一条 LOG）。
- **Claude plugin 工作流（X7 收尾）**（ODW 扩展）：已安装且启用的 Claude Code 插件所带的 workflow（插件的 `workflows/` 目录，或 `plugin.json` 的 `workflows` 字段——一条路径或路径数组，替换默认目录；路径须以 `./` 开头且不出插件目录）以 Claude Code 给的名字 `<插件>:<meta.name>` 运行：`odw run <插件>:<名字>`。发现过程只读：插件根目录为 `$CLAUDE_CODE_PLUGIN_CACHE_DIR` 或 `$CLAUDE_CONFIG_DIR`（默认 `~/.claude`）下的 `plugins/`，读 `installed_plugins.json`（`project`/`local` 作用域的安装只在其 `projectPath` 内生效）、`enabledPlugins`（用户 `settings.json` → 项目 `.claude/settings.json` → `.claude/settings.local.json`，逐键覆盖；没有条目时按清单的 `defaultEnabled`，默认 true）与清单的 `name`；脚本经 dual-compat 审计（`meta` 须为纯字面量，否则像 Claude Code 一样略过并记说明），就地从插件目录运行、从不写入插件文件，走与其他 workflow 相同的加载器，运行日志写明来自哪个插件、版本与作用域，并标出 ODW 独有原语的使用。`odw workflows list --plugins`、`odw workflows where`、`/api/workflows`（provider `claude-plugin:<插件>`，`?provider=` 可指定）与看板 Workspace 的「Claude Code plugins」分组列出它们；运行按 `<插件>:<名字>` 归档，rerun 按路径识别来源。裸名字只在没有项目级/个人级同名 workflow 且只有一个插件提供时解析到插件（多个插件同名报歧义）；与项目 workflow 同名时项目优先并提示 `<插件>:<名字>`。不受信任的运行中插件 workflow 照常允许（用户自己安装的），但仓库的设置只能禁用插件、不能启用，名字也不再解析到仓库自己的 `.odw/workflows`/`.claude/workflows`（给路径仍可运行）。
- **额度暂停（N6 后半）**（ODW 扩展）：`quotaWait: { max: <秒> } | false`，默认 `false`——悄无声息地等上几个小时会让没要求的人意外。一个调用因额度用尽而无适配器可用（链上最后一个额度失败，或熔断跳过了全部）、且某个 CLI 报出的重置时间（"try again in 3h 22m"、"resets 7pm"、Claude 的 `usage limit reached|<epoch>`）在 `max` 之内时，运行**暂停**而不是让它失败：它不占槽位地等待，还有额度的适配器照常运行；在 CLI 报出的重置时间之前，运行跳过该适配器，无处可去的调用在派发前就等待（不显示为 agent、不占槽位）；到点后（加最多 30 秒抖动）从链首重新开始，熔断也随之忘掉该适配器，transcript 记 `{"kind":"attempt","reason":"quota_wait"}`。`status.json` 与 RunSummary 带 `pausedFor: { reason: "quota", adapter, resumeAt }`（`/api/runs[/:id]`、`web/src/types.ts`），`odw status`、`odw list`、实时视图与 `odw run --wait` 显示 "paused until 19:10 (codex quota)"；`odw resume` 立即继续，`odw stop` 照常停止，可与检查点并存；暂停不触发运行结束的 hook，`notify.on` 可选 `"paused"`（每次暂停一次）。没有重置时间或超过 `max` 的额度失败照常失败，并在日志中说明原因。等待留在 worker 进程内：worker 死掉则运行变为 `stale`，`odw resume` 照常重放。

---

## 3. 路线：按需求排序

### Now — 0.6「可靠与可控的成本」

| # | 方向 | 需求 | 规模 | 状态 |
| --- | --- | --- | --- | --- |
| N1 | **每个 agent 的结果落盘 + `odw resume`**：已完成的 agent 结果原子写入 run 目录，可以按运行和按 agent 查询（`odw agents`、`odw result --agent`、API、看板抽屉）；`resume` 重放 `(prompt, opts)` 未变的调用，只重跑变化或失败的部分 | #4 恢复（[#24](https://github.com/xz1220/open-dynamic-workflows/issues/24)） | M | ✅ |
| N2 | **完成通知钩子**：`notify` 配置支持 command 和 webhook（兼容 Slack/Discord），覆盖运行结束、失败、停止；看板侧有提示和桌面通知 | #11 | S | ✅ |
| N3 | **卡死看门狗**：agent 输出长时间没有动静（`stallTimeout`）就终止并重启，重启次数有上限（`stallRestarts`）并记录事件；worker 收到 SIGTERM/SIGINT/SIGHUP 时干净地停止运行 | #5 | S | ✅ |
| N4 | **命令原语** `exec()`（ODW 扩展）：异步执行，支持参数、cwd、超时、输出上限，可被取消，返回 stdout/stderr/退出码，并在 DAG 中可见；附 `test-fix-loop.js` 示例 | [#31](https://github.com/xz1220/open-dynamic-workflows/issues/31) | M | ✅ |
| N5 | **用量与成本**：适配器改用各 CLI 的 JSON 输出模式（`claude --output-format json` 的 `total_cost_usd`、`codex exec --json` 的 usage），按 agent 和阶段记录真实用量，`budget` 改用真实计量；大规模 fan-out 启动前给出预警 | #1 | M | ✅ claude 改用 stream-json，按 agent / 运行记录 token 与花费，`budget` 用真实输出 token，`fanOutWarn`；codex 改用 `exec --json`：token（codex 不报花费）、transcript 中的工具调用、以 CLI 自报的 `turn.failed` / `error` 归类失败，回复取自 `--output-last-message`（`match`、`errorEvents`、`{reply_file}`） |
| N6 | **失败分类与退避**：区分限流、过载、额度耗尽、鉴权四类失败；按适配器节流，遵守 retry-after；额度耗尽时整体暂停，到重置时间自动恢复；支持回退适配器链 | #3 | M | ✅ 分类、退避重试、可操作的报错；按适配器的并发上限、限流后自适应减半、为提示缓存错开扇出；回退链与额度熔断随 X7；额度暂停（`quotaWait`，到重置时间自动恢复） |
| N7 | **有证据的成功**：读取 CLI 报告的成功信号（`is_error`、`permission_denials`、MCP 状态），转成有类型的失败；`agent()` 可声明后置条件（"有文件改动"、"某命令通过"）。`odw doctor --smoke` 已交付 | #7（[#23](https://github.com/xz1220/open-dynamic-workflows/issues/23)） | M | ✅ `agent(…, { expect })`（`changes`/`files`/`command`/`match`，带缺失项重试后以 `unmet_expectation` 失败）、空回复 `empty_reply`、claude `permission_denials` 记为 agent 的 `denied` 并写日志（`expect` 下算缺失，`permissionDenials: "fail"` 时为 `permission`）、MCP 状态（init 事件的 `mcp_servers` 记为 agent 的 `mcp` 并写日志，`mcpFailures: "fail"` 时为 `mcp_unavailable`，`expect.mcp`）✅ |
| N8 | **原生结构化输出**：优先使用 `codex --output-schema` / `claude --json-schema`；校验器不检查的 schema 关键字默认在运行日志里大声报告，设 `schemaKeywords: "strict"` 则启动前拒绝 | #12 | S–M | ✅ `claude --json-schema`（取 `result` 事件的 `structured_output`）、`codex --output-schema`（仅 strict schema，文件放在 run 目录、用完即删），本地仍校验每次回复；启动前逐个找出校验器不检查的关键字与位置：默认（`"warn"`）每次运行记录一次 LOG，写明由谁强制执行（拿到原生 schema 的 CLI，否则无人），`"strict"` 以 `AgentError` 拒绝；`format` 视为注解；格式错误的 schema 一律拒绝；`schemaPrompt` |

### Next — 0.7「审阅与掌控」

| # | 方向 | 需求 | 规模 | 状态 |
| --- | --- | --- | --- | --- |
| X1 | **diff 作为运行产物 + `odw apply`**：保留 worktree 的分支和 diff；合并前用 `git merge-tree` 预检，再跑校验命令，逐个合并；看板提供并排 diff 审阅 | #2 | M | ✅ diff 落盘（排除初始化文件、可截断）、`keep` 分支、`odw diff`/`odw apply [--check]`、看板改动页；合并前逐文件预检（临时索引上的 `git apply --3way --cached`，没有分支的 diff 同样适用）、`--all` 叠加预览并逐个应用、`--verify`/`applyVerify` 校验失败精确回滚 ✅；看板改动页可复制预览、全部预览与全部应用命令 ✅ |
| X2 | **权限档位**：read-only / edit / full 三档，映射到各 CLI 的对应参数，启动前展示；环境变量白名单 + 密钥引用脱敏；不受信任的仓库使用 `--bare` | #6 | M | ✅ 三档 + 按 CLI 映射（只填文档证实的）、`--permissions`、`agent()` 只能降档、启动横幅、`odw doctor` 档位、`agentEnv: "minimal"` 白名单、密钥脱敏（`redact`；含 `worker.log`、Chat Host 会话、对外提供的运行 `args`）✅；不受信任的仓库（`--untrusted`：claude `--safe-mode` 而非只认 API key 的 `--bare`，没有文档化方式的 CLI 每次运行明说，仓库的 `worktreeSetup`/`symlink:` 不执行）✅ |
| X3 | **agent transcript**：保存每个 agent 的 JSON 流（工具调用、重试）；看板和 `odw logs --agent` 可查看；导出 OpenTelemetry GenAI span | #8 | M | ✅ 记录与回看（`odw logs --agent [--raw] [--follow]`、API、看板实时侧栏）；OpenTelemetry 导出：`odw export <run> --otlp [--out\|--send]`（GenAI 语义约定的 OTLP/JSON，零依赖，trace id 由 run id 派生）、配置 `otel` 时运行结束自动发送一次、内容默认不导出（`captureContent` 开启，再脱敏并截断）、`odw doctor` 显示去向 ✅ |
| X4 | **人工检查点** `checkpoint()`（ODW 扩展）：持久暂停，`odw approve/reject [--edit]` 继续；看板提供审批入口（依赖 N1） | #9 | M | ✅（含 `--edit` / `--payload` 修改后批准、`schema` 校验；看板编辑器待做） |
| X5 | **worktree 环境**：支持 `.worktreeinclude`、带超时的 setup 命令、为每个 agent 分配 `ODW_PORT` | #10 | S | ✅ |
| X6 | **调度**：`odw schedule add/list/remove/run` 写入 cron/launchd/systemd（不引入 daemon）；每个定时任务一把防重叠锁（失效锁自动接管）、每次运行一行日志、上次与下次运行时间；错过的运行按各后端处理（systemd `Persistent=true` 开机补跑）；失败通知复用 `notify` | #14 | S | ✅ |
| X7 | **按阶段指定适配器和模型**：设置默认值、模型分层和回退链；解析 Claude plugin 工作流 | #13 | M | ✅ 阶段默认适配器/模型、模型分层、回退链与额度熔断 ✅；Claude plugin 工作流（`odw run <插件>:<名字>`，只读发现、按 `enabledPlugins` 启用、项目同名优先并提示）✅ |

### Later — 0.8+「规模与生态」

- 可选的容器运行器（默认断网）。（#6，L）
- ✅ **`odw compare <runA> <runB> [--json] [--agent <label|id>]`**（ODW 扩展；#15 的前半）：每次运行记录它用了什么——`meta.json` 中的 odw 版本与工作流源码的 sha256，`run_started` 上会改变行为的设置与各适配器定义的指纹，`agent_started` 上的调用键与模型，以及各适配器首次派发时与 agent 并行、3 秒超时的 `<cli> --version`（`cli_version` 事件，不拖慢、不导致失败；node、解释器、脚本与相对路径不探测；`recordVersions: false` 关闭）；纯函数比较器按 label → resume 调用键 → phase 内顺序匹配 agent，给出配置差异、运行总计（耗时、token、花费、完成/失败，含 B − A）、每个 agent 的状态/适配器/模型/耗时/花费/尝试次数/保留 diff 统计与回复对比（文本为有上限的统一 diff，结构化回复为 JSON 路径 diff）；终端表格不超过 100 列，更差标红、更好标绿；`GET /api/compare?a=&b=` 只读返回同一结构（看板视图待接入）。
- ✅ **`odw eval <file|name> [--adapter a,b] [--repeats N] [--json] [--out F] [--baseline F]`**（ODW 扩展；#15 的后半）：eval 文件（`.odw/evals/<name>.json`，与 `.odw/workflows/` 一样纳入版本库）列出工作流、用例 `{ name, args, checks }`、可选的适配器矩阵（每个适配器作为运行默认适配器跑完全部用例）、`repeats`、`concurrency`、每次运行的 `budget` 与 `timeout`，启动前严格校验；检查不调用模型——结果路径（点/方括号写法）上的 `equals`/`contains`/`matches`/`exists`、在项目目录中以 0 退出的 `command`（带 `ODW_RESULT` 与 `ODW_RUN_ID`）、`state`、`maxCostUsd`、`maxSeconds`，未写检查即 `state: done`；每个用例 × 适配器 × 重复都是运行目录里标记 `origin: "eval"` 与 `eval: { name, case, adapter, repeat }` 的真实运行（`odw list` 与运行摘要可区分），最多 `concurrency` 个并行，超时即停止并判失败，Ctrl-C 停止本次启动的全部运行；表格按单元格给出通过 k/n、耗时中位数、总/平均花费与平均 token，附总计和带检查与运行 id 的失败；带 `version` 的 JSON 报告含定义哈希、工作流 sha256、odw 与各 CLI 版本（取自 `cli_version` 事件）和每个运行 id（可直接 `odw compare`），保存在 `<runsRoot>/_evals/<name>/<id>.json`；`--baseline` 给出每个单元格通过率、花费、延迟的 B − A 与退步的单元格；退出码 0（全部通过或无退步）/ 1 / 2（用法错误）；只读的 `GET /api/evals` 与 `GET /api/evals/:name/:id`，`web/src/types.ts` 已有类型（看板视图待接入）；示例 `examples/evals/routing.json`。
- ✅ **可分享的脱敏运行包；看板远程只读访问**（ODW 扩展；#11/#13）：`odw bundle <run> [--out FILE] [--no-transcripts] [--max-bytes N]` 写出一个自包含的 `<run>.odwrun`（JSON：meta 只保留描述运行的字段、status 去掉 pid、事件、保存的 agent 结果、保留的 diff、transcript 与 stderr、结果与错误），全部经过运行的脱敏器（令牌形态与环境中密钥变量的值，即使 `redact: false`），被替换处标 `redacted: true`，绝不包含配置文件、环境变量与 notify/otel 设置；默认 32 MiB 上限。`odw view FILE`（`odw serve --open FILE`）读取前先查大小，校验运行 id 正则、agent id 为非负整数（最多 10 000 个）与各字段类型，解包到 0700 的私有临时目录（文件名固定，退出即删），看板只展示这一次运行并标「分享的运行包」，所有写操作 409（loopback 上也是）。`odw serve --token [VALUE]`：每个 `/api` 请求与 SSE 需要令牌（Bearer 头、`?token=` 换取 HttpOnly SameSite=Strict cookie、或该 cookie），常数时间比较，按地址限制错误次数（429）；不带值时生成随机令牌，只在 URL（`/#token=…`）里打印一次；HTML 外壳无需令牌并显示「需要令牌」界面；非 loopback 绑定上写操作无论有无令牌一律拒绝（与原计划「写操作带令牌鉴权」不同：远程写入仍不开放），不带 `--token` 的非 loopback 绑定打印醒目警告。看板 Job 头部的「分享」复制 `odw bundle <run>`。
- ✅ **方言一致性测试套件，作为社区工作流的兼容性标准**（#13）：`conformance/cases/NN-slug/` 下 32 个只用 Claude Code 方言的普通工作流脚本，各配一个 `expected.json`——输入（`args`、`budget`）、mock agent 的应答表（`mock`：按 `when` 子串匹配，`reply` / `fail` / `delayMs`）与必须出现的结果（`state`、`result` 或 `error` 子串，可选的有序 `logs`、`phases` 与不计顺序的 `agents`）；覆盖 `agent`（文本、schema、失败与 try/catch）、`parallel`（顺序、单支失败、嵌套）、`pipeline`、`phase`、`log`、`budget`、嵌套 `workflow()`、`args`、`meta` 纯字面量与必须是脚本错误的情形。每个用例标明 Claude Code 文档是否确定该行为（`documented`），文档未确定的标 `unspecified` 并在 `notes` 写明 ODW 的做法，不做猜测。`odw conformance [--json] [--case N|name]... [--dir DIR]` 把每个用例作为真实运行跑在确定性的 `conformance/mock-agent.mjs` 上，逐个报告通过与否（失败退出 1，格式错误退出 2）；CI 的 test 任务和 `npm test` 都会运行；套件随 npm 包发布；`conformance/README.md` 说明格式与在 Claude Code 上手动运行的方法。已知差异（Claude Code 禁用 `Date.now()` 等，ODW 只警告）写在 README，不进用例。

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
| ✅ 本轮 | 执行记录侧栏（运行中实时跟随、追加不重绘）；Jobs 页「即将运行」（下一次触发、cron 的自然语言描述、上次运行）；检查点关卡节点与等待提醒；抽屉里的权限档位、回退链、未达成的预期与被拒的工具调用；DAG 节点上的回退链与被拒计数 |
| ✅ 本轮 | 额度暂停卡片（重置时间、倒计时、立即继续）与运行卡片上的「暂停至」；花费小票：按阶段、按适配器与花费最多的 agent（`$` 键） |
| ⏳ | 运行之间的对比（`odw compare`：`GET /api/compare` 与 `web/src/types.ts` 的 `RunComparison` 已就绪）；eval 报告视图（`odw eval`：`GET /api/evals[/:name/:id]` 与 `EvalReport`、`EvalReportSummary` 已就绪，eval 运行的摘要带 `eval` 标记）；检查点审批时编辑 payload；MCP 状态与 codex 用量在抽屉中的呈现 |

开发方式：`node web/demo-fixtures.mjs <runs> <proj> --live` 生成实时模拟数据，`node web/dev.mjs --api http://127.0.0.1:4317` 启动开发服务器（每次刷新都会重新构建）。

---

## 5. 明确不做

- **GUI 发起通用工作流 / 参数表单**：工作流由 Agent 或 CLI 发起；看板只负责观测和控制 ODW 自己的运行。
- **自研常驻调度 daemon**：调度交给操作系统（X6 只负责写入系统定时任务）。
- **托管执行策略 / 根级授权体系**（见 2026-09 triage 中的 PR #30）：等有了具体的托管用户和经过独立评审的威胁模型再议。
- **分发 Hub / 市场**：先做可分享的运行包和兼容性套件，Hub 暂缓。💤
