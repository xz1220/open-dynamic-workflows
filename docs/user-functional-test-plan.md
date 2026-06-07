# Open Dynamic Workflows 用户视角功能测试计划

日期：2026-06-07

测试负责人：Codex，以专业最终用户 / QA 用户身份执行

测试范围：ODW CLI、Web 客户端和桌面 App 的用户可见功能测试。本计划刻意从真实用户操作路径出发，不把重点放在内部单元测试上。

## 测试原则

ODW 需要兑现三个面向用户的承诺：

1. 用户或 Agent 可以通过 CLI 创建、发现、运行、查看和控制 dynamic workflows。
2. 客户端 App 可以准确观察 workflow 的执行状态，不主动启动或修改运行中的任务。
3. 桌面 App 可以稳定承载同一套客户端体验。

测试应从用户动作和可见结果开始。内部文件和 API 只用于准备测试数据，或用于确认某个可见行为是否真实发生。

## 测试环境

- 仓库 worktree：`/Users/danielxing/repos/open-dynamic-workflows-functional-test-plan`
- 工作分支：`codex/functional-test-plan`
- Node 版本目标：Node >= 20
- 浏览器测试目标：Codex in-app Browser，用于 Web 客户端的可视化检查
- 桌面端测试目标：macOS Tauri App，优先使用 Computer Use / 可视化桌面控制能力验证
- CLI 测试项目：`/var/folders/5b/h724t4r57sscqb7v7ymbggbw0000gn/T/odw-functional-test-RUTrMi/project`
- CLI 测试 runs root：`/var/folders/5b/h724t4r57sscqb7v7ymbggbw0000gn/T/odw-functional-test-RUTrMi/runs`
- Web 有数据测试地址：`http://127.0.0.1:4328/?snap=1`
- Web 空状态测试地址：`http://127.0.0.1:4329/?snap=1`
- 已观察的桌面 App：`/Applications/Open Dynamic Workflows.app`
- 桌面端真实 smoke run：`20260607-140053-4d9d55` / `desktop-smoke-codex-20260607`

## 结果标记

- 待执行：尚未执行
- 通过：通过测试
- 失败：发现问题，详见备注或问题记录
- 部分通过：核心路径有验证结果，但仍有明确限制或未覆盖点
- 阻塞：受环境、工具或风险限制，无法安全执行

## 准备工作

| ID | 模块 | 场景 | 步骤 | 预期结果 | 结果 | 记录 |
| --- | --- | --- | --- | --- | --- | --- |
| SETUP-01 | 环境 | 安装依赖 | 如有需要，在测试 worktree 中运行 `npm install`。 | 依赖安装成功。 | 通过 | 通过测试。仅出现 Node `UNDICI-EHPA` 警告，原因是当前环境设置了 `NODE_USE_ENV_PROXY=1`。 |
| SETUP-02 | 构建 | 构建 Web bundle 和 TypeScript runtime | 运行 `npm run build`。 | 无报错产出 `web/dist/index.html`、`src/dashboard.generated.ts` 和 `dist/`。 | 通过 | 通过测试。`web/dist/index.html` 已构建并嵌入，然后 TypeScript 编译成功。 |
| SETUP-03 | 测试数据 | 创建隔离项目和 runs root | 在 `/tmp` 下创建临时项目和 runs root，用于 CLI 与 App 测试。 | 测试数据不影响用户真实的 ODW 运行历史。 | 通过 | 通过测试。在 `/var/folders/.../odw-functional-test-RUTrMi` 下创建了隔离的 `smoke`、`fail`、`slow-control` workflow 和独立 runs root。 |

## CLI 功能测试

| ID | 模块 | 场景 | 步骤 | 预期结果 | 结果 | 记录 |
| --- | --- | --- | --- | --- | --- | --- |
| CLI-01 | 帮助 | 用户可以发现可用命令 | 运行 `node dist/cli.js --help`。 | 帮助信息列出 `run`、`rerun`、`list`、`status`、`logs`、`result`、`serve`、`workflows`、`pause`、`resume` 和 `stop`。 | 通过 | 通过测试。 |
| CLI-02 | 版本 | 用户可以查看已安装版本 | 运行 `node dist/cli.js --version`。 | 输出类似 semver 的 ODW 版本号。 | 通过 | 通过测试：`open-dynamic-workflows 0.2.4`。 |
| CLI-03 | Workflow 创建 | 用户可以手动创建 workflow 文件 | 将一个简单 workflow 写入 `<project>/.odw/workflows/smoke.js`。 | workflow 文件存在于受管理的项目目录。 | 通过 | 通过测试。在临时项目中创建了 `smoke`、`fail` 和 `slow-control` workflow。 |
| CLI-04 | Workflow 发现 | 用户可以列出 workflows | 在 `<project>` 中运行 `node dist/cli.js workflows list --config <config>`。 | 输出中出现 `smoke` workflow 及其来源路径。 | 通过 | 通过测试。`fail`、`slow-control` 和 `smoke` 均出现。还出现了一个全局 Claude workflow，符合当前搜索行为。 |
| CLI-05 | Workflow 解析 | 用户可以查看 workflow 名称解析到哪里 | 在 `<project>` 中运行 `node dist/cli.js workflows where smoke --config <config>`。 | 输出指向 `<project>/.odw/workflows/smoke.js`。 | 通过 | 通过测试。 |
| CLI-06 | 按名称运行 | 用户可以按名称启动 workflow | 运行 `node dist/cli.js run smoke --config <config> --runs-root <runsRoot> --wait`。 | run 成功完成并打印结果。 | 通过 | 通过测试。Run `20260607-134314-b50e53` 完成，结果为 `{ "ok": true, "reply": "mock reply" }`。 |
| CLI-07 | Run 列表 | 用户可以列出已记录的 runs | 运行 `node dist/cli.js list --runs-root <runsRoot>`。 | 完成的 `smoke` run 以 `done` 状态出现。 | 通过 | 通过测试。 |
| CLI-08 | 按 workflow 过滤 | 用户可以只查看某个 workflow 的 runs | 运行 `node dist/cli.js list --workflow smoke --runs-root <runsRoot>`。 | 只出现 `smoke` runs。 | 通过 | 通过测试。 |
| CLI-09 | 状态 | 用户可以查看单个 run 状态 | 运行 `node dist/cli.js status <runId> --runs-root <runsRoot>`。 | 输出包含 run id、`done`、workflow 名称和已派发 agent 数量。 | 通过 | 已对完成状态的 run 通过测试。 |
| CLI-10 | 日志 | 用户可以查看 run 事件 | 运行 `node dist/cli.js logs <runId> --runs-root <runsRoot>`。 | 输出展示 run started / finished 事件和 workflow 日志。 | 通过 | 通过测试。日志包含 `run_started`、`phase_started`、`log`、`agent_started`、`agent_finished` 和 `run_finished`。 |
| CLI-11 | 结果 | 用户可以读取最终结果 | 运行 `node dist/cli.js result <runId> --runs-root <runsRoot>`。 | 输出 workflow 返回值。 | 通过 | 通过测试。 |
| CLI-12 | 重新运行 | 用户可以 rerun 一个已有 run | 运行 `node dist/cli.js rerun <runId> --runs-root <runsRoot>`，然后查看新 run。 | 创建一个使用相同脚本和参数的新 run。 | 通过 | 通过测试。新 run `20260607-134330-067547` 完成，状态为 `done`。 |
| CLI-13 | 失败路径 | 用户获得清晰的失败输出 | 使用 `--wait` 运行一个会抛错的 workflow。 | 命令以非零退出，`result` 能展示错误详情。 | 通过 | 通过测试。退出码为 `1`，输出包含 `run failed: intentional functional failure`。 |
| CLI-14 | 缺失 workflow | 用户获得清晰的未找到反馈 | 运行 `node dist/cli.js run missing-name --config <config> --runs-root <runsRoot>`。 | 命令以非零退出，并解释 workflow 未找到。 | 通过 | 通过测试。输出说明没有名为 `missing-name` 的 workflow，并列出搜索过的 roots。 |
| CLI-15 | 暂停 / 恢复 | 用户可以暂停并恢复运行中的 workflow | 启动一个长耗时 workflow，执行 `pause`，检查 status，再执行 `resume`，等待完成。 | 状态经过 paused/running，最终完成。 | 失败 | 暂停 / 恢复功能本身可用，但暂停期间 `status` 显示 `dispatched: 0 agent(s)`，即使第一个 agent 已完成。见 ISSUE-CLI-01。 |
| CLI-16 | 停止 | 用户可以停止运行中的 workflow | 启动一个长耗时 workflow，执行 `stop`，然后等待 / 查看状态。 | Run 以 `stopped` 结束，`--wait` 对 stopped 映射为非零退出。 | 通过 | 通过测试。Stopped run `20260607-134411-8e2e30` 以 `stopped` 结束，`result` 报告 `run was stopped before completion`。 |

## Web 客户端 / App 页面功能测试

这些测试使用 `odw serve` 加载的同一套 SPA。覆盖浏览器中的客户端，也覆盖桌面 shell 内部所使用的页面行为。

| ID | 模块 | 场景 | 步骤 | 预期结果 | 结果 | 记录 |
| --- | --- | --- | --- | --- | --- | --- |
| WEB-01 | 启动 | 用户可以打开客户端 | 启动 `node dist/cli.js serve --runs-root <runsRoot> --config <config> --port 4328`，并在浏览器中打开。 | 客户端无阻塞性 console 错误，默认进入 Activity。 | 通过 | 通过测试。页面标题为 `Open Dynamic Workflows`，未捕获页面 console 错误。 |
| WEB-02 | Activity 空状态 | 用户能理解空状态 | 使用空 runs root 打开 Activity。 | 计数器显示 0，事件流说明如何开始一个 run。 | 通过 | 在 4329 端口通过测试。空 Activity 显示 0 计数器和 `No recent events`。 |
| WEB-03 | Activity 有数据状态 | 用户可以看到全局活动 | 注入 demo fixtures，打开 Activity。 | 活跃 run 数、运行中 agent 数、adapter fleet 和事件流与注入数据一致。 | 通过 | 在为两个 running fixtures 设置 alive pid 后通过测试。Activity 显示 `2 runs active`、`7 agents running` 和 adapter fleet 计数。 |
| WEB-04 | Workspace 列表 | 用户可以看到 workflows | 打开 Workspace。 | 可见 ODW workflow 列表，包含名称、描述、phase 数和 managed-dir 来源标签。 | 通过 | 通过测试。ODW 分组显示 8 个 workflows；Claude Code 分组显示 1 个全局 workflow。 |
| WEB-05 | Workspace 详情 | 用户可以查看某个 workflow | 点击 `deep-research`。 | 详情展示名称、描述、CLI 提示、phases、结构、来源和最近 runs。 | 通过 | 通过测试。详情显示 phases、包含 `export const meta` 的来源和最近 runs。 |
| WEB-06 | Workspace 跳转 run 详情 | 用户可以从 workflow 跳到 run | 在 Workspace 中点击一个 recent run。 | App 跳转到该 run 的 Job 详情。 | 通过 | 通过测试。点击 `deep-research` recent run 后进入 Job 详情。 |
| WEB-07 | Jobs 空状态 | 用户能理解 Jobs 空状态 | 使用空 runs root 打开 Jobs。 | 页面提示还没有 runs，并显示 CLI hint。 | 通过 | 在 4329 端口通过测试。 |
| WEB-08 | Jobs 活跃 / 历史 | 用户可以监控活跃和历史 runs | 使用 demo fixtures 打开 Jobs。 | Active strip 显示 running runs；历史表按日期展示 done/failed/stale runs。 | 通过 | 通过测试。Active strip 显示 `agent-daily-digest` 和 `deep-research`；历史区在 Today 下显示 stopped/done/failed/stale rows。 |
| WEB-09 | Job graph | 用户可以查看实时 DAG | 打开一个 running 的 `deep-research` run。 | Graph tab 显示 phase lanes、agent nodes、状态、进度和 ticker。 | 通过 | 通过测试。Graph 显示 5 个 lanes、10 个 nodes、`running/done/failed` 状态和 50% 进度。 |
| WEB-10 | Agent 详情面板 | 用户可以查看某个 agent node | 点击 failed 或 running agent node。 | 详情面板打开，展示 adapter、phase、开始时间、duration/status，失败时展示 error。 | 通过 | 通过测试。失败 node 详情展示了 malformed JSON schema error。 |
| WEB-11 | Logs tab | 用户可以查看事件日志 | 在 Job 详情点击 Logs tab。 | Logs 展示带 timestamp、event type 和 message/agent label 的事件行。 | 失败 | Logs 行可以渲染，但日志内容与 stage header 发生重叠，并拦截 Graph/Logs/Result tabs 的点击。见 ISSUE-WEB-01。 |
| WEB-12 | Result tab 成功状态 | 用户可以查看已完成 run 的结果 | 打开 done run 并点击 Result。 | Result tab 显示 `result.json` 内容。 | 失败 | 直接访问 `/result` URL 可以渲染 `result.json`，但进入 Logs 后 Result tab 因日志行覆盖 header 而无法点击。见 ISSUE-WEB-01 和 ISSUE-WEB-02。 |
| WEB-13 | Result tab 失败状态 | 用户可以查看失败详情 | 打开 failed run 并点击 Result。 | Result tab 显示 `error.json` 内容。 | 通过 | 通过直接访问 failed result 路由完成测试。可见 `error.json` 内容。 |
| WEB-14 | 复制 run id | 用户可以复制 run id | 在 Job 详情点击 `Copy run id`。 | 按钮切换到 copied 状态；如果浏览器允许，剪贴板中包含 run id。 | 通过 | 在 Graph tab 通过测试。剪贴板包含 run id，按钮切换为 `已复制`。Result/Logs 中的复制受 ISSUE-WEB-01 影响。 |
| WEB-15 | 导航状态 | 用户可以在页面间导航且状态不泄漏 | 按 Activity -> Jobs -> Job -> Logs -> Workspace -> 另一个 Job 的路径操作。 | 每个页面渲染正确状态；前一个选中 agent/tab 不污染无关页面。 | 失败 | 访问 Logs 后，再打开另一个裸 Job 详情 URL，页面仍停留在 Logs，而不是回到 Graph。见 ISSUE-WEB-02。 |
| WEB-16 | 语言切换 | 用户可以切换界面语言 | 打开 Settings，切换到中文，导航页面并刷新。 | UI 切换为中文，并在刷新后保持。 | 通过 | 通过测试。`html lang` 变为 `zh-CN`；导航和 Settings 文案已翻译；刷新后仍保持中文。 |
| WEB-17 | 只读不变量 | App 不控制 runs | 检查可见页面并触发可用控件。 | 页面不启动 workflow，也不调用 pause/resume/stop；仅有导航、复制和语言切换是 active。 | 通过 | 通过测试。未发现可见的 run 启动 / 暂停 / 恢复 / 停止控件；Settings 控件除语言外均为展示性。 |
| WEB-18 | 响应式 / 最小窗口 | UI 在较小桌面窗口下仍可用 | 将浏览器缩放到约 980x640。 | 文本和控件保持可见，无明显错位重叠。 | 通过 | 在 980x640 通过测试。未检测到页面级 overflow；导航和主要控件保持可见。 |

## 桌面 App 功能测试

这些测试要求真实可视化桌面交互。环境暴露 Computer Use / 可视化 App 控制能力时，桌面端测试必须使用该能力执行。当前环境没有暴露专用桌面 Computer Use 控制工具，因此已用窗口级截图、进程检查和同一 sidecar URL 的浏览器自动化做可验证补充；原生 Tauri 窗口内点击路径仍按实际情况标记为部分通过或阻塞。

| ID | 模块 | 场景 | 步骤 | 预期结果 | 结果 | 记录 |
| --- | --- | --- | --- | --- | --- | --- |
| DESK-01 | 构建 / 启动条件 | 桌面 App 可构建或已有 App 可启动 | 使用 `npm run build:binary`、`cd apps/desktop && npm run build` 构建，或在已有 `.app` 可用时启动已安装 App。 | App bundle 存在且可打开。 | 通过 | 已有 `/Applications/Open Dynamic Workflows.app` 存在并正在运行。本轮未重新构建当前 worktree 的 App bundle。 |
| DESK-02 | 启动 | 桌面 App 打开 ODW 客户端 | 用 Computer Use 打开 App 并观察窗口。 | Splash 过渡到从本地 sidecar 加载的 ODW 客户端。 | 通过 | 通过 macOS 窗口截图完成可视化验证。窗口显示 ODW 客户端 Activity 页面。当前环境未暴露专用桌面 Computer Use 工具。 |
| DESK-03 | Sidecar | App 启动 `odw serve` sidecar | 启动 App 并检查可见页面 / 进程输出。 | 客户端从 `http://127.0.0.1:4317` 加载，并使用 bundled sidecar。 | 通过 | 进程列表显示 `/Applications/Open Dynamic Workflows.app/.../odw serve --port 4317`，4317 端口正在监听。窗口显示 `Live`。 |
| DESK-04 | 页面操作 | 桌面承载的页面行为与 Web 客户端一致 | 使用 Computer Use 点击 Activity、Workspace、Jobs、Job 详情、Logs、Result、Settings。 | 与 Web 客户端可见行为一致。 | 部分通过 | 已向桌面 sidecar 的默认 runs root 运行真实 flow。桌面窗口可视化显示 `desktop-smoke-codex-20260607` 事件。使用同一个 `http://127.0.0.1:4317` sidecar 在浏览器中验证 Jobs -> detail -> Result 成功。由于专用桌面 CUA 工具未暴露，原生窗口点击仍不可靠。 |
| DESK-05 | 关闭窗口 | 关闭窗口时隐藏 App 而不是退出 | 关闭主窗口，再通过托盘 / Dock 恢复窗口。 | App 保持常驻并可再次显示。 | 阻塞 | 未执行。当前已安装 App 正在运行，且缺少可靠桌面控制；为避免干扰用户环境，未关闭窗口。 |
| DESK-06 | 退出 | 退出 App 会停止 sidecar | 退出 App。 | sidecar 进程不会残留。 | 阻塞 | 未执行。为避免在缺少可靠桌面控制时停止用户正在运行的已安装 App，未执行退出。 |
| DESK-07 | 通知 / badge | 原生信号反映 run 状态变化 | 保持 App 打开，让一个 run 转为 done/failed。 | Dock badge / notification 行为与 active 和终态 run 状态一致。 | 阻塞 | 未执行。需要可靠桌面交互和通知观察能力。 |
| DESK-08 | 端口冲突 | 4317 被占用时用户能看到可理解行为 | 先在 4317 启动另一个 server，再启动 App。 | App 不应静默展示陈旧或错误状态；失败应可理解。 | 阻塞 | 4317 已由正在运行的 ODW sidecar 占用。冲突测试需要退出 / 重启已安装 App。 |

## 执行记录

| 时间 | Case ID | 观察记录 |
| --- | --- | --- |
| 2026-06-07 | PLAN | 创建用户视角功能测试计划。 |
| 2026-06-07 | SETUP-01..03 | 完成依赖安装、Web/runtime 构建，并创建隔离临时项目和 runs root。 |
| 2026-06-07 | CLI-01..14 | CLI help/version/workflow discovery/run/list/status/logs/result/rerun/failure/missing workflow 均通过。 |
| 2026-06-07 | CLI-15 | 暂停 / 恢复功能可用，但 paused status 展示的 dispatched count 不准确。 |
| 2026-06-07 | CLI-16 | stop 功能可用，且 `result` 正确报告 stopped 状态。 |
| 2026-06-07 | WEB-01..18 | 使用有数据和空状态 fixtures 测试浏览器客户端，发现 Logs/header 覆盖和 tab 状态泄漏问题。 |
| 2026-06-07 | DESK-01..03 | 通过窗口级截图确认已安装桌面 App 和 sidecar 正常运行。 |
| 2026-06-07 | DESK-04..08 | 完整桌面点击、关闭 / 退出、通知和端口冲突用例受专用桌面 CUA 工具缺失及干扰已安装 App 的风险限制。 |
| 2026-06-07 | DESK-04 补测 | 将真实 workflow `desktop-smoke-codex-20260607` 运行到 `~/.odw/runs`；桌面窗口显示新事件。通过浏览器自动化在 `127.0.0.1:4317` 的桌面 sidecar 上验证 Jobs -> detail -> Result。 |

## 补测：真实桌面端 Smoke Run

在初轮测试后，我专门为桌面端验证在本 session 中实际运行了一个 dynamic flow：

- Workflow：`desktop-smoke-codex-20260607`
- Run id：`20260607-140053-4d9d55`
- Runs root：`/Users/danielxing/.odw/runs`
- 命令路径：`node dist/cli.js run <temp>/desktop-smoke-codex-20260607.js --config <temp>/odw.config.json --runs-root /Users/danielxing/.odw/runs --wait`
- 结果：通过；返回 `{ "ok": true, "source": "codex-session", "reply": "mock reply" }`

验证情况：

- `http://127.0.0.1:4317/api/runs` 显示该 run 为 `done`。
- `http://127.0.0.1:4317/api/runs/20260607-140053-4d9d55` 显示 2 个 phases、1 个 done agent，并且 `hasResult: true`。
- 桌面窗口截图显示新的 `desktop-smoke-codex-20260607` Activity 事件位于 live event stream 顶部，包括 `RUN_STARTED`、`AGENT_STARTED`、`RUN_FINISHED`。
- 使用浏览器自动化访问同一个桌面 sidecar URL，也就是 `http://127.0.0.1:4317/?snap=1`，完成了 Jobs -> 新 run -> Result 的点击路径。Job 详情显示正确 workflow 名称、`done` badge、2 个 phase lanes、一个 done 的 `desktop-agent`，并显示预期的 `result.json`。

限制：

- 仍未完成 Tauri 原生窗口内部的稳定点击-through 验证。ODW 窗口已经可见后，我尝试过一次坐标点击，但页面没有从 Activity 切换到 Jobs。同一路径通过 4317 sidecar 的浏览器自动化可以成功。因此原生窗口交互结论是部分验证，不是完全验证。

## 发现的问题

| ID | 严重程度 | 模块 | 相关用例 | 摘要 | 详情 |
| --- | --- | --- | --- | --- | --- |
| ISSUE-WEB-01 | 高 | Web Job Detail | WEB-11, WEB-12, WEB-14 | Logs 内容与 stage header 重叠，并拦截 tab / copy 点击。 | 在 Job 详情的 Logs tab 中，可视化截图显示日志行从 header 下方开始。对可见 Result tab 位置执行 `document.elementFromPoint()` 返回 `.logrow`，所以从 Logs 点击 Result 无效。这也解释了 Result/Logs 区域复制操作失败的表现。 |
| ISSUE-WEB-02 | 中 | Web navigation state | WEB-12, WEB-15 | Job tab 状态会在不同 jobs / 裸 job routes 之间泄漏。 | 访问 `#/job/<run>/logs` 后，再打开另一个裸 `#/job/<other-run>` 路由，仍显示 Logs，而不是默认回到 Graph。直接访问 `#/job/<run>/result` 可以工作，所以 result renderer 本身正常，问题在用户导航状态。 |
| ISSUE-CLI-01 | 低 | CLI status | CLI-15 | Paused run 的 status 展示不准确的 dispatched count。 | 在 `slow-control` 中，第一个 agent 完成后请求 pause。`status` 正确显示 `[paused]`，但同时显示 `dispatched: 0 agent(s)`，即使已有一个 agent 运行过。最终状态稍后显示为 `dispatched: 2`。 |
| ISSUE-DESK-01 | 中 | 桌面测试 / 窗口管理 | DESK-04 | 已安装桌面窗口最初位于屏幕外 / 其他 Space；原生窗口坐标点击仍不可靠。 | `odw-desktop` 有真实窗口，名称为 `Open Dynamic Workflows`，但初始全屏截图只显示 Codex。System Events 报告窗口位置为 `{165, -960}`，随后才被移动。按 window id 截图可正确看到 App，后续全屏截图也能看到它在当前桌面。一次 Jobs 坐标点击仍没有切换视图，而同一路径通过 4317 sidecar 的浏览器自动化可以成功。 |
