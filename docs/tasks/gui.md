# ② 客户端（只读展示层）— 任务拆解

> 对应 [ROADMAP](../ROADMAP.md) 的 ②：`(a) Workspace` + `(b) Jobs` +（待定）`(c) 第三维`。
> **视觉真相（visual source of truth）**：`docs/odw-client-mockup.html`（7 屏浅色 mockup，真实 mock 数据）、`docs/odw-client.html`（画廊索引 + 导入说明）、`assets/app-screenshots/*.png`（当前 App 截图）。深色「watch」主题已存档于 `docs/odw-client-mockup-v1-full.html`，本期不做、留待后续。
> 每个任务带：目标 / 做法 / 文件锚点 / 完成标准（DoD）。可直接分配给 agent 开工。

---

## 实现状态（2026-06-05）

> 本文档原是规划稿；下半部分（§5 任务清单）已落地，状态如下。**两处与原规划的偏离**已在正文就地更新：
>
> 1. **前端不是 Svelte/Vite，而是 vanilla TypeScript + esbuild**，内联成单文件 `web/dist/index.html`。理由见 §1.2 决策记录——零运行时依赖的承诺下，连 build-time 框架都省掉，直接搬 mockup 的 CSS/DOM 最省事、产物最小、和 mockup 1:1。
> 2. **活 DAG 由 `RunDetail.agents` 按 phase 分组派生**（phaseOrder = 泳道），不走"显式拓扑事件"。原 G2 的 `groupId/kind/index` 需要把 AsyncLocalStorage 穿进 primitives——对 164 个测试风险偏高，**降级为一条加性的后续项**（见 §3.2 G2）。单层扇出/链的视觉已用「按 phase 堆叠」达成。
>
> | 任务 | 状态 | 备注 |
> |---|---|---|
> | G1 `/api/workflows[/:name]` + `/api/runs/:id/result` | ✅ 完成 | 见 `src/runtime/workflows-view.ts`、`server.ts`；测试覆盖 |
> | G2 拓扑事件 | ◐ 部分 | DAG 改由 agents-by-phase 派生；`agent_started.adapter` 已加；`groupId/kind/index` 留作加性后续 |
> | G3 Web SPA（5 视图） | ✅ 完成 | vanilla TS；对接真实 `odw serve` 全部验证 |
> | G4 embed 接线 | ✅ 完成 | `embed-dashboard.mjs` 改读 `web/dist/index.html`；`build:web` 串进 `prebuild` |
> | G5 Tauri 壳 | ◐ 已搭好、未编译 | `apps/desktop/` 代码齐全；**此环境无 Rust 工具链，未 `tauri build`**，见 `apps/desktop/README.md` |
> | G6 Activity 第三维 | ✅ 完成 | 已采纳为第三维：fleet + 9 类事件 firehose |
> | G7 Settings 写 | ◐ 只读 | 适配器/偏好为只读展示（示意数据）；窄 `/api/config` 写留待后续 |
>
> 后端 164/164 测试通过；`build:web → embed → tsc` 全链路通。`?snap=1` 是截图/CI 钩子（只 poll 一次、不开 SSE，见 §3.3）。

---

## 0. 定位与两条铁律

**客户端 = 基于 ODW 套件的只读观测窗口。** 它把运行时已经在写的东西（run 目录、events.jsonl、result）渲染成好看、可读、实时的看板，**不发起任何运行**。

两条铁律（决定下面全部取舍）：

1. **发起运行的永远是 Agent（走 CLI `odw run <name>`）。** GUI 没有 Run / Launch / Execute / Install 按钮，没有参数表单。
2. **客户端只读。** 唯一被允许的「写」是 App 自身偏好（开机启动、通知开关）与适配器配置——**绝不写 run、绝不调用 `/control`**。

> 推论：服务端早已有的 `POST /api/runs/:id/control`（pause/resume/stop）本客户端**一律不调用**——它是给 CLI / 未来其它客户端的，不在只读窗口的职责里。

---

## 1. 技术选型

### 1.1 外壳：Tauri 2.x

> **选型决策记录（2026-06-05）**：基于两条实际约束定的，不是从 ROADMAP 照抄——
> ① **平台 = 暂时只做 macOS**（跨平台等项目运营起来再议）；② **优先级 = 小而现代**（包体/内存 > 全程留 TS > 顶级原生手感）。
> 这两条直接判定 **Tauri**：macOS-only 让 Tauri 最大的缺点（三套 WebView 内核不一致、尤其 Linux WebKitGTK 的坑）**直接不存在**，WKWebView 在 mac 上够好；而"小包体、低内存、现代"恰是首要诉求。

- **为什么不是 Electron / SwiftUI（诚实版）**：
  - **Electron**：最稳、全 TS、跨平台一致、生态最全，**它是真正的备选**——但包体重（~120–200MB）、内存高，且自带第二个 Node 运行时，与"小而现代"的诉求相反。**仅在将来跨平台时回头重估**（见下方"后路"）。
  - **SwiftUI**：mac 手感最好，但会让 DAG 渲染**分叉成两套**（原生一套、Web 一套），违背"一份渲染器"；且 macOS 锁定。本项目已有 web dashboard，分叉代价不划算。
  - **Tauri**：系统 webview + 薄 Rust 外壳，只管「起进程 + 原生能力」，渲染全交给我们的 Web 前端。**已接受的代价**：原生集成要写一点 Rust；生态较年轻、v1→v2 有过破坏性变更（跟随上游 churn 的成本）。在 macOS-only + 小而现代的前提下，这些可接受。
- **外壳职责边界（薄）**：spawn `odw serve` 这个 sidecar、把 webview 指向它、提供 Dock badge / 系统通知 / 菜单栏常驻 / 窗口生命周期。**Rust 里不写任何业务逻辑、不碰 run 数据**——数据全部来自 localhost server 的 HTTP/SSE。
- **后路（不锁死跨平台）**：本期 90% 工作量（Svelte SPA + §3.2 的 API 契约）**与外壳无关**。将来若要跨到 Win/Linux 且 Tauri 的 Linux WebKitGTK 难受，**把外壳换成 Electron 即可，SPA/API 原样保留**。所以现在选 Tauri 不烧掉未来选项——这也是为什么应优先把 web 版跑通（§5 排序）。

### 1.2 前端：vanilla TypeScript SPA + esbuild + 自定义 SVG DAG

> **已落地的决策（偏离原 Svelte 规划）**：最终用**纯 TypeScript（无前端框架）**，esbuild 打成 IIFE，把 JS/CSS 内联进单文件 `index.html`。

- **为什么 vanilla 而非 Svelte**：零运行时依赖是铁律（§1.4），那把这条逻辑推到底——连编译期框架都不引入，**直接搬 mockup 的 CSS + 手写字符串模板 + 事件委托**。视图本就是「数据 → HTML 字符串」的纯函数（`render(state): string`），状态少、无复杂双向绑定，框架收益不抵其构建/认知成本。产物更小、依赖图更短、和 `docs/odw-client-mockup.html` 1:1。代价：手动 DOM diff（这里用「整段 innerHTML 重渲 + 轮询/SSE 驱动」绕开，规模够小不卡）。
- **DAG 渲染器：自定义 SVG / 绝对定位**（`web/src/dag.ts`），不上 Cytoscape/D3-force。本期单层：phase 泳道（由 `phaseOrder` 排序）+ 每条泳道内 agent 纵向堆叠（达成 `parallel` 扇出 / `pipeline` 链的视觉），边为按下游状态着色的 `<svg>` 贝塞尔、running 节点带流动点。布局确定性，体积小、可控。重型图引擎留给 v0.7 嵌套子图。
- **构建成单文件内联 bundle**：`web/build.mjs`（esbuild）把 `src/main.ts` 打成 IIFE，把 CSS（`src/theme.css`）和 JS 内联进 `web/index.html` 的占位符，输出**自包含 `web/dist/index.html`**，喂给下面的 embed 管线。服务端依旧「零运行时依赖地」吐一个 HTML。

### 1.3 复用既有资产（关键：大半已经在仓库里了）

| 已存在 | 文件 | 客户端如何复用 |
|---|---|---|
| HTTP + SSE API | `src/runtime/server.ts` | 前端直接消费，**不重写服务端**（仅加性扩端点，见 §3.2） |
| run 读模型 | `src/runtime/runs-view.ts`（`RunSummary` / `RunDetail`） | DAG / 列表 / 详情的数据形 |
| 9 类事件 | `src/events.ts` | 事件流、节点状态机 |
| **单 bundle 管线** | `scripts/embed-dashboard.mjs` → `src/dashboard.generated.ts` | **把「读 `src/dashboard.html`」改成「读 SPA 产物」**，其余不变 |
| SEA 打包 | `scripts/build-binary.mjs`（esbuild + SEA + postject） | 二进制内嵌新 SPA，`odw serve` 即真客户端 Web 版 |

> 也就是说：**客户端的 Web 版 ≈ 把 420 行的 `src/dashboard.html` 升级成数据驱动 SPA，走同一条 embed 管线**；原生版 = 给它套个 Tauri 壳。

### 1.4 零运行时依赖铁律（不可破）

- `package.json`（根 = runtime/CLI 包）**永远零 `dependencies`**。esbuild / Tauri / postject 全部是 **build-only**，且隔离在**各自的 workspace**（`web/`、`apps/desktop/`），不渗进 runtime 包。（连前端框架都没有——前端是 vanilla TS，唯一 build dep 是 esbuild。）
- Rust 只存在于 `apps/desktop/src-tauri/`，只在打原生包时编译。

---

## 2. 功能模块（对上设计稿 7 屏）

| 模块 | 数据来源（API） | 设计稿屏 | 写？ |
|---|---|---|---|
| **Workspace** — 有哪些 workflow + 结构 + 源码 | `GET /api/workflows`、`/api/workflows/:name`（**待加**，§3.2 G1） | `?only=s02` | 只读 |
| **Jobs — 列表** — 在跑/历史 run，按 workflow 归属 | `GET /api/runs`、SSE `/api/stream` | `?only=s03` | 只读 |
| **Jobs — Job 详情（活 DAG）** | `GET /api/runs/:id` + `…/events?since=` + SSE | `?only=s04` | 只读 |
| **Jobs — Logs / Result** | `…/events?since=`、`RunDetail.result/error` | `?only=s05` | 只读 |
| **Activity（提案，第三维）** — 机器脉搏：fleet 负载 + 9 类事件 firehose | `/api/runs` 聚合 + 事件多路（**待定**，§3.2 G6） | `?only=s01` | 只读 |
| **Settings** — 适配器 + App 偏好 | 读 `odw.config.json` + 探测；（择机）窄 `/api/config` 写 | `?only=s06` | App 配置 |
| **Foundations** | —（设计系统参考，非运行视图） | `?only=s07` | — |

### 2.1 只读不变量（实现期硬约束）

- 任何 `<button>` 都不得触发 run 的创建/控制。允许的「动作」只有：复制 run id、在 Finder 打开 run 目录、打开 worker.log、跳转/筛选、复制 CLI 命令提示。
- Workspace 里用一行**只读提示**代替 Run 按钮：`$ odw run <name> — runs are started by your agent, not here`。

### 2.2 设计重叠与消解（你看到的「重叠」，在此钉死）

设计稿里几处刻意或顺手的重叠，实现时按下面收敛，避免两套数据 / 两套组件：

| 重叠 | 消解 |
|---|---|
| Activity 的 firehose ↔ Job/Logs 的事件流 | **同一个 `EventRow` 组件**，靠 scope 区分：Activity = 全局 live tail（无过滤）；Logs = 按 `runId` 过滤。一套渲染。 |
| Activity 的「runs active」计数 ↔ Jobs 顶部 active 卡 | **Jobs 是 run 清单的唯一权威**。Activity 只做**聚合数字 + fleet + firehose**，点计数即跳 Jobs；不在 Activity 再列一遍 run。 |
| Workspace 的「该 workflow 的 runs」 ↔ Jobs 全量 | Workspace 的 run 小列表 = **Jobs 的 `workflowName` 过滤视图**（对应 `odw list --workflow`），点进去就是 Jobs 详情；**不另存一份**。 |
| 侧栏「Live now」mini-run ↔ Jobs active 卡 | **同一数据源**（`/api/runs` 过滤 active）。Rail 的 mini-run 是常驻入口，Jobs 的卡是完整态；共享同一 store。 |
| DAG 渲染器出现在多处（Workspace 静态结构图 / Job 活 DAG / 历史回放 / 卡片 mini-glyph） | **这是有意复用，不是重复**：抽成**单一 `<Dag>` 组件**，靠 props 切模式（`mode: static \| live \| replay`、`density`）。一个渲染器，多场景。 |

---

## 3. 代码架构

### 3.1 分层（数据从下往上单向流）

```
┌─────────────────────────────────────────────────────────────┐
│ apps/desktop  (Tauri 壳, Rust 薄)                              │
│   · spawn `odw serve` sidecar → 等健康 → webview 指向 it       │
│   · 原生: Dock badge / 通知 / 菜单栏常驻 / 窗口生命周期         │
└───────────────▲──────────────────────────────────────────────┘
                │ webview 加载 http://127.0.0.1:<port>/
┌───────────────┴──────────────────────────────────────────────┐
│ web/  (vanilla TS SPA — 唯一一份前端)                          │
│   views: Activity · Workspace · Jobs(list/detail/logs) · Set. │
│   data:  api client(fetch + SSE) → store → 派生 DAG(by-phase)  │
│          重连退避 + stale 标记                                 │
└───────────────▲──────────────────────────────────────────────┘
                │ HTTP + SSE（只读 GET；不调用 /control）
┌───────────────┴──────────────────────────────────────────────┐
│ src/runtime/server.ts  (纯 Node, 零依赖) — 不被前端选型污染     │
│   GET /api/runs · /api/runs/:id · /…/events?since= · /stream  │
│   + /api/workflows[/:name] · /api/runs/:id/result（✅ 已加）   │
│   ← runs-view.ts(RunSummary/RunDetail) · workflows-view.ts ←  │
│     run 目录 / events.jsonl / result / worker.log             │
└──────────────────────────────────────────────────────────────┘
```

**进程模型**：前端只有**一个宿主** = Node server。Tauri 不自己再 host 一份前端（那才会有「渲染分叉」），它只是把 webview 指向 sidecar 起的 `odw serve`。「同一 bundle、两宿主同 hash」因此由构造保证（见 §4.4）。

### 3.2 API 契约（现有 + 待加，全部加性）

**已存在（`src/runtime/server.ts` 文件头已列）**：

```
GET  /api/runs               → [RunSummary]（newest first）
GET  /api/runs/:id           → RunDetail
GET  /api/runs/:id/events    → 原始事件（?since=N 取尾部增量）
GET  /api/stream             → text/event-stream（run 列表变化即推）
POST /api/runs/:id/control   → pause|resume|stop   ← 只读客户端不用
```

**待加（任务见 §5）**：

- **G1 `/api/workflows`**（✅ 已加）：列管理目录（`.odw/workflows` + `~/.odw/workflows`）里的 workflow + `meta(name/description/phases)` + 来源 + 源码。Workspace 的命根子。实现于 `src/runtime/workflows-view.ts`，`readMetaSafe` 用 `loadWorkflowScript().meta` **只编译不执行**。另加 `GET /api/runs/:id/result`（返回 `{value}`，无结果则 404）。
- **G2 拓扑事件（加性，◐ 降级为后续项）**：原计划在 `AGENT_STARTED` 上多发 `groupId / kind / index` 供 `runs-view.ts` 派生 `groups` 树——但这要把 AsyncLocalStorage 穿进 primitives 以拿到当前 group 上下文，**对既有 164 测试风险偏高**。**实际落地**：活 DAG 改由 `RunDetail.agents` **按 `phase` 分组**派生（phaseOrder = 泳道顺序，同 phase 的 agent 在该泳道堆叠），无需任何 primitives 改动即得到单层扇出/链的视觉。**已做的最小加性改动**：`agent_started` 事件带上 `adapter`（`primitives.ts`），`runs-view.ts.foldAgents` 透传到 `AgentView.adapter`，供 fleet 视图分组。`groupId/kind/index` 仍是一条**向后兼容的加性后续项**（旧 events.jsonl 无字段 → 维持 by-phase 派生，不报错），留待要画「嵌套子图」时再补。
- **G6（Activity，✅ 已采纳）**：跨 run 的**事件多路** + 聚合，走路线 (i)——前端 `store.loadActivity` 对每个 active run 拉 `…/events?since=` 的尾部 + active run 详情，客户端归并成 fleet（按 adapter）+ 9 类事件 firehose。服务端零改动；多路 SSE `/api/events/stream` 作为后续优化。

### 3.3 前端 SPA 架构（`web/`，已落地）

```
web/
  index.html          # 外壳：<style>/*INLINE_CSS*/</style> + <script>/*INLINE_JS*/</script> + #app
  build.mjs           # esbuild：bundle src/main.ts(IIFE) → 把 CSS+JS 内联进 index.html → dist/index.html
  demo-fixtures.mjs   # 播种真实 fixtures（live/done/failed/stale runs + .odw/workflows）供本地验证
  tsconfig.json  package.json   # 仅 esbuild 一个 build dep，隔离在此 workspace
  src/
    types.ts          # RunSummary / RunDetail / AgentView / WorkflowSummary|Detail / WorkflowEvent（与 src/ 对齐）
    util.ts           # esc / clsx / fmtClock / fmtDur* / fmtAgo / runDurationSec / TERMINAL
    icons.ts          # logoSvg + icons{}
    theme.css         # mockup 的 :root token + 浅色组件样式（含 .groupcard），1:1 搬运
    api.ts            # fetch 封装：runs / run / events / result / workflows / workflow（全只读 GET）
    store.ts          # Store：SSE connect(退避重连) + loadRuns/loadWorkflows/loadRun/loadResult/loadActivity；ACTIVE_STATES
    dag.ts            # renderDag(run, selectedAi)：phaseOrder 泳道 + agent 堆叠 + 贝塞尔边 + 流动点
    shell.ts          # toolbar/rail/statusbar + Route 接口 + activeRuns()
    native.ts         # Tauri 桥（feature-detect window.__TAURI__）：Dock badge + run:transition 事件
    main.ts           # hash 路由(#/job/:id/[tab]) + enterRoute 轮询 + 点击委托 + ?snap=1 钩子
    views/
      activity.ts  workspace.ts  jobs.ts  job.ts  settings.ts
```

- **无框架、纯函数视图**：每个 `views/*.ts` 导出 `render(state): string`，main.ts 把结果塞进 `#app` 并用事件委托接管点击。整段重渲 + 轮询/SSE 驱动，规模够小不卡。
- **主题直接复用 mockup**：`docs/odw-client-mockup.html` 的 `:root` token、浅色组件样式、DAG/节点/事件行样式**就是实现规范**——搬进 `src/theme.css`，1:1 还原。浅色为本期唯一主题；深色 token 先不进（后续加 `data-theme` 切换层）。
- **状态机**：节点状态由事件驱动（`agent_started→running`、`agent_finished→done`、`agent_failed→failed`；run 级 `pending/running/paused/done/failed/stopped/stale`）。SSE 推 + `?since=` 增量；断线→`stale` + 退避重连→`?since=` 追平。
- **`?snap=1` 截图/CI 钩子**：URL 带此参数时 app **只 poll 一次、不开 SSE**——给无头截图（virtual-time-budget 会被开着的 SSE 流挂住）和 CI 用。
- **DAG 布局**：`renderDag` 从 `RunDetail.agents` 按 `phase` 推确定性布局（phase = 泳道，phaseOrder 定列序；同 phase 的 agent 在泳道内纵向堆叠 = 扇出/链的视觉）；边按下游节点状态着色，running 节点带流动点。Workspace 的静态结构图与 Job 的活 DAG 共用同一渲染器，靠数据态区分。

### 3.4 Tauri 壳（`apps/desktop/`，Rust 薄）

- **sidecar**（`src-tauri/src/lib.rs`）：把 per-platform 的 `odw` 二进制声明为 Tauri `externalBin`（`bundle-sidecar.mjs` 拷成 `binaries/odw-<triple>`）；启动时 Rust `spawn odw serve --port 4317`（v1 固定回环端口，后续可探空端口），TCP 探测 `127.0.0.1:4317` 就绪后 `navigate_once` 让窗口加载该 URL（就绪前显示 `splash/index.html`）。
- **原生能力**（全部读 `/api/runs` 派生，不持有业务状态）：
  - **Dock badge** = active run 数（running+paused）；有失败则 badge 转红。
  - **系统通知**：run 完成 = 中性；失败 = 点名失败 agent 并深链到该节点（`tauri-plugin-notification`）。尊重「仅失败时通知」偏好。
  - **菜单栏常驻**（`tray`）：分支 logo glyph + active 数 → 弹出最近 run。
  - **窗口关闭不退出**：detached worker 仍在跑，App 常驻后台继续观测；`⌘Q` 若有活跃 run 给提示。
- **Rust 红线**：不解析 events.jsonl、不算状态、不发起/控制 run。所有这些都从 localhost API 来。

### 3.5 数据流时序（一次「看一个 run」）

```
启动 → Tauri spawn `odw serve` → webview 载入 SPA
SPA → GET /api/runs（列表）→ 订阅 SSE /api/stream（列表变化）
用户选 run → GET /api/runs/:id（RunDetail + groups）→ 画 DAG 初态
          → GET /api/runs/:id/events?since=0（补历史事件）
          → 轮询/流 ?since=N 增量 → 事件落子：节点变色、边流动、phase 推进
断线 → 节点 desaturate + stale badge → 退避重连 → ?since= 追平 → 恢复 live
```

---

## 4. 如何嵌入仓库

### 4.1 目录布局（演进成 monorepo，但 runtime 包不动其性质）

```
open-dynamic-workflows/
├─ src/                     # ① runtime + CLI（不变；永远纯 Node 零运行时依赖）
│   ├─ runtime/server.ts    # 仅加性扩端点 /api/workflows（G1）
│   ├─ runtime/runs-view.ts # 派生 groups 树（G2）
│   ├─ events.ts            # 加可选 groupId/kind/index（G2）
│   ├─ dashboard.html       # 现役手写看板（被 SPA 产物取代后可删/留作 fallback）
│   └─ dashboard.generated.ts  # embed 产物（改由 SPA 喂）
├─ web/                     # ✅ vanilla TS SPA（唯一前端）— build-only 依赖(esbuild)
│   ├─ build.mjs            # esbuild：内联成单文件 dist/index.html
│   └─ src/                 # types/util/icons/theme/api/store/dag/shell/native/main + views/
├─ apps/
│   └─ desktop/             # ◐ Tauri 壳（已搭好、此环境未编译）
│       ├─ src-tauri/       # Rust（只在打原生包时编译）
│       ├─ scripts/bundle-sidecar.mjs   # 把 ./odw 拷成 binaries/odw-<triple>
│       └─ README.md        # 构建步骤 + "无 Rust 工具链、未编译"说明
├─ scripts/
│   ├─ embed-dashboard.mjs  # ✅ 改：读 web/dist/index.html → 生成 dashboard.generated.ts
│   └─ build-binary.mjs     # 不变：esbuild + SEA + postject
├─ package.json             # 根 = runtime/CLI 包；加 workspaces；dependencies 仍为空
└─ docs/tasks/gui.md        # 本文件
```

- 用 **npm workspaces**：根 `package.json` 已加 `"workspaces": ["web"]`（`apps/desktop` 独立管理自己的 JS 依赖），把前端构建依赖锁在子包里，根包 `dependencies` 保持空。

### 4.2 构建接线（一条链，复用现有 embed）

```
1) web build:   npm run build:web  →  node web/build.mjs
                  → esbuild bundle src/main.ts(IIFE) + 内联 CSS/JS → web/dist/index.html
2) embed:       node scripts/embed-dashboard.mjs
                  → 优先读 web/dist/index.html（存在则取代 src/dashboard.html）
                  → 写 src/dashboard.generated.ts
3) runtime:     tsc → dist/ ; build:binary → 单文件 `odw`（内嵌该 SPA）
4) `odw serve`：浏览器里即「客户端 Web 版」
5) desktop:     (apps/desktop) bundle:sidecar（./odw → binaries/odw-<triple>）→ tauri build
                  → 以步骤 3 的 `odw` 为 sidecar 打包成 .app（webview 指向 sidecar）
```

- 根 `package.json` 已接好：`"build:web": "node web/build.mjs"`，`"prebuild": "npm run build:web && npm run embed"`——所以 `npm run build`/`build:binary` 会自动先打 SPA 再 embed。
- `scripts/embed-dashboard.mjs` 只改**输入源**（优先 `web/dist/index.html`，回退 `src/dashboard.html`），输出与契约不变。开发期 `web` 可单独 `node build.mjs` 重打，`odw serve` 走已生成的 bundle；`web/demo-fixtures.mjs` 可播种真实 run/workflow 数据供本地对接验证。

### 4.3 不可触碰 / 红线

- `src/` 始终是**纯 Node、零运行时依赖**。前端框架、Tauri、Vite **绝不**出现在根 `dependencies`。
- 前端**只有一份**（`web/`）。Tauri 不再 host 第二份（指向 sidecar 即可）。

### 4.4 CI「零渲染分叉」断言

- 既然前端只有一份、且只经 `embed-dashboard.mjs` 进二进制——**不变量退化为「全仓只有一个前端 bundle」**：CI 断言 `src/dashboard.generated.ts` 的内容 hash 来自 `web/dist/index.html`，且 Tauri 打包用的是同一个 `odw` 二进制（同 hash）。任何「Tauri 自带一份前端」的改动应被 CI 拒。

### 4.5 发布管线

- `.github/workflows/release.yml` 已 per-OS 出 `odw` 二进制（SEA 注入本机 node）。**加一步**：在拿到本平台 `odw` 后，`tauri build` 产出签名 + 公证的 `.app`/`.dmg`（Developer ID + notarization），把 `odw` 作为 sidecar 打进去。Web 版随二进制天然就有（`odw serve`）。

---

## 5. 任务清单（按依赖排序；DoD + 文件锚点）

> 排序原则：先把**数据契约**补齐（G1/G2），再做 **Web 版 SPA**（G3/G4，先在浏览器把 DAG 体验跑通——这也是 ROADMAP 给 Tauri 设的 dogfood 闸门），最后**套原生壳**（G5）。Activity（G6）/ Settings 写（G7）独立、可后置。

- [x] **G1 — `/api/workflows` 端点（Workspace 数据前置）** ✅
  - 做法：读模型抽到 `src/runtime/workflows-view.ts`（`listWorkflowSummaries` / `workflowDetail`，`readMetaSafe` 用 `loadWorkflowScript().meta` **只编译不执行**）；`server.ts` 加 `GET /api/workflows`、`GET /api/workflows/:name`（404 on miss）、`GET /api/runs/:id/result`。`cli.ts` 把 `cwd`/`config` 透传进 `startServer`。
  - DoD：✅ 两端点返回真实管理目录内容；`:name` 含 phases 与源码；不执行任何脚本 body。`tests/server.test.ts` 覆盖（写 `.odw/workflows/echo.js` → 断言 list/detail/404）。
  - 锚点：`src/runtime/workflows-view.ts`、`src/runtime/server.ts`、`src/loader.ts`。

- [◐] **G2 — 拓扑事件（加性）+ DAG 派生** — **降级为后续项**
  - **实际落地**：活 DAG 不靠显式拓扑事件，改由 `RunDetail.agents` **按 `phase` 分组**派生（见 §3.2 G2、§3.3 DAG）。最小加性改动：`agent_started` 带 `adapter`（`primitives.ts`）→ `runs-view.ts.foldAgents` 透传到 `AgentView.adapter`。
  - **留作后续**：`groupId/kind/index`（需 AsyncLocalStorage 穿进 primitives）——要画嵌套子图时再补，向后兼容。
  - 锚点：`src/events.ts`、`src/primitives.ts`、`src/runtime/runs-view.ts`。

- [x] **G3 — Web 版 SPA（`web/`）：5 视图** ✅
  - 做法：按 §3.3 搭 **vanilla TS** SPA（非 Svelte），主题 1:1 还原 `docs/odw-client-mockup.html`（浅色）。消费 `/api/runs`、`/api/runs/:id`、`…/events?since=`、SSE `/api/stream`、`/api/workflows`、`/api/runs/:id/result`。
  - DoD：✅ 对接真实 `odw serve`（+ `demo-fixtures.mjs` 播种）验证：Activity（计数/fleet/firehose）、Workspace（列表+结构+源码）、Jobs（active+历史）、Job（活 DAG 扇出 + 红色 failed 节点 / Logs 9 类事件 / Result 真值）、Settings；断 SSE → stale，重连 `?since=` 追平；**全程无任何发起/控制按钮**。
  - 锚点：`web/`、`docs/odw-client-mockup.html`。
  - 依赖：G1。

- [x] **G4 — embed 接线：SPA 进二进制** ✅
  - 做法：`scripts/embed-dashboard.mjs` 优先读 `web/dist/index.html`；根 `package.json` 加 `workspaces: ["web"]`、`build:web`、`prebuild = build:web && embed`。
  - DoD：✅ `build:web → embed → tsc` 全链通；`odw serve` 渲染真 SPA；runtime 包 `dependencies` 仍为空。
  - 锚点：`scripts/embed-dashboard.mjs`、`package.json`、`src/dashboard.generated.ts`。
  - 依赖：G3。

- [◐] **G5 — Tauri 原生壳（`apps/desktop/`）** — **已搭好、此环境未编译**
  - 做法：按 §3.4 写齐 `src-tauri/`（`lib.rs` sidecar+tray+通知+关闭不退出、`tauri.conf.json`、`capabilities/default.json` 只读 allow-list、`Cargo.toml`、`build.rs`、`main.rs`）+ `splash/` + `scripts/bundle-sidecar.mjs` + `README.md`。
  - **状态**：代码齐全且按 Tauri 2 API 自检通过，但**此环境无 `cargo`/`rustc`/`@tauri-apps/cli`，未执行过 `tauri build`**。需在有工具链的 mac 上首次编译 + 图标 + 签名公证。详见 `apps/desktop/README.md`。
  - 锚点：`apps/desktop/`、`.github/workflows/release.yml`（加 `tauri build` 一步，TODO）。
  - 依赖：G4。**dogfood 闸门**：Web DAG 体验先被 ≥3 名非作者用户验证（ROADMAP §硬闸门）。

- [x] **G6 — Activity 第三维** ✅（已采纳）
  - 做法：前端归并（`store.loadActivity` 对每个 active run 拉 `?since=` 尾部 + active 详情）→ 跨 run firehose + 按 adapter 的 fleet 聚合。视图 = `?only=s01`。
  - DoD：✅ 跨所有 run 滚动 9 类事件 + 按 adapter 显示 fleet 负载；计数点击跳 Jobs（不另列 run）。
  - 锚点：`web/src/views/activity.ts`。

- [◐] **G7 — Settings 配置写** — 本期只读
  - **实际落地**：Settings **只读**展示适配器/偏好（示意数据）+ "no run button by design" 说明 banner。
  - **留作后续**：窄 `/api/config`（读/写 `odw.config.json`，仅适配器 + App 偏好，绝不涉及 run）。
  - 锚点：`web/src/views/settings.ts`、（可选）`src/runtime/server.ts`。

---

## 6. 设计稿映射（屏 → 视图/组件）

| 设计稿（`?only=`） | 视图模块 | 关键渲染 | 数据 |
|---|---|---|---|
| `s01` Activity | `views/activity.ts` | fleet(by-adapter) · 9-event firehose · 计数 | `store.loadActivity`（`/api/runs` 聚合 + 多路 `?since=`） |
| `s02` Workspace | `views/workspace.ts` | master 列表 · structureLane · `highlight()` 源码 · phasepills | `/api/workflows[/:name]` |
| `s03` Jobs 列表 | `views/jobs.ts` | runCard(active strip + spark) · 按日期分组历史表 | `/api/runs` + SSE |
| `s04` Job 活 DAG | `views/job.ts` · `dag.ts` | `renderDag` · detailPanel · phasestepper | `/api/runs/:id` + `?since=` |
| `s05` Logs & Result | `views/job.ts`(tab) | logsTab(EventRow) · resultTab | `…/events` · `/api/runs/:id/result` |
| `s06` Settings | `views/settings.ts` | adapters · app prefs · "no run button" banner | config 探测（示意） |
| `s07` Foundations | —（token 来源） | `src/theme.css` | — |

---

## 7. 本期不做 / 待定

- **嵌套 DAG 折叠子图**（parallel 套 pipeline）：渲染推迟到 **v0.7**，做成可折叠子图，**绝不降级回泳道**。本期只单层。
- **GUI 发起运行 / 参数表单**：永不（铁律一）。
- **Hub / install / 分发**：本期整条不做（ROADMAP §5）。
- **`/control` 的 GUI 入口**（pause/resume/stop 按钮）：只读客户端不提供。
- **第三维 = Activity**：**已采纳**（机器脉搏：fleet + firehose）。已实现于 `views/activity.ts`、`store.loadActivity`。备选（历史回放浏览器）留待后续。
- **深色「watch」主题**：本期只做浅色；深色作为后续 `data-theme` 切换层补回（视觉已存档于 `docs/odw-client-mockup-v1-full.html`）。

---

## 附录 · 文件锚点

- `src/runtime/server.ts` — API 端点（+ `/api/workflows[/:name]`、`/api/runs/:id/result`；`cwd`/`config` 透传）✅
- `src/runtime/workflows-view.ts` — Workspace 读模型（`listWorkflowSummaries`/`workflowDetail`/`readMetaSafe`）✅
- `src/runtime/runs-view.ts` — `RunSummary` / `RunDetail`（`foldAgents` 透传 `AgentView.adapter`）✅
- `src/runtime/run-store.ts` — run 目录读写（`workflowName`、`listRuns`，见 cli.md R1–R3）
- `src/events.ts` — 9 类事件常量（`groupId/kind/index` 留作加性后续）
- `src/primitives.ts` — `agent_started` 带 `adapter`（拓扑字段待后续）✅
- `src/loader.ts` — `loadWorkflowScript().meta`（Workspace 只编译取 meta）
- `src/dashboard.html` — 现役手写看板（被 SPA 取代，留作 fallback）
- `src/dashboard.generated.ts` — embed 产物（改由 `web/dist` 喂）✅
- `scripts/embed-dashboard.mjs` — 单 bundle 管线（优先读 `web/dist/index.html`）✅
- `scripts/build-binary.mjs` — SEA 打包（不变）
- `package.json` — 加 `workspaces: ["web"]` + `build:web` + `prebuild`；`dependencies` 保持空 ✅
- `web/` — ✅ vanilla TS SPA（`build.mjs` + `src/` + `index.html` + `demo-fixtures.mjs`）
- `apps/desktop/` — ◐ Tauri 壳（`src-tauri/` + `scripts/bundle-sidecar.mjs` + `splash/` + `README.md`；未编译）
- `.github/workflows/release.yml` — 加 `tauri build` 一步（TODO）
- 视觉真相：`docs/odw-client-mockup.html`、`docs/odw-client.html`、`assets/app-screenshots/*.png`
