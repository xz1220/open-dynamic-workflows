# Open Dynamic Workflows — 模块路线图

> 组织方式：先说清「项目是什么」，再按「提供哪些模块」展开成一棵树。
> 本期主线只有三件事：**运行引擎 → 运行记录 → 只读客户端**。
> 分发、参数表单、机器可读参数契约等，明确不在本期（见 §5）。
> 重写日期：2026-06-05

---

## 0. 项目是什么

**ODW 是一个动态工作流的运行时**：用 Claude Code 方言（`export const meta` + 注入 `agent / parallel / pipeline / ...`）写一次工作流脚本，既能在 Claude Code 本体跑，也能经 `odw` 在 Codex / Gemini / Qwen / Kimi / 自定义 CLI 上**原样跑**；再配一个只读客户端，看这些工作流和它们的运行。

两条贯穿全局的事实——它们决定了下面所有取舍：

- **发起运行工作流的，永远是 Agent（走 CLI）。** 没有「人填表单去跑工作流」这回事。
- **客户端是只读窗口。** 只展示，不发起。

根基（也是与单纯「换个 CLI 跑」的区别）：**Claude Code 方言的忠实保真 + 工作流可移植**。

---

## 1. 模块总览

```
Open Dynamic Workflows (ODW)
│
├─ ① CLI（核心层）── odw 运行时 · 纯 Node · 零运行时依赖
│   │
│   ├─ (a) 运行层  Runtime ──── 翻译 / 运行 / 执行工作流，对接不同 CLI
│   │       · 原语    agent · parallel · pipeline · phase · log · args · budget · workflow
│   │       · 加载器  meta 解析 + 源变换 + Claude Code 方言双兼容
│   │       · 调度器  信号量并发 + 1000-agent 兜底 + 预算钩子
│   │       · 适配器  claude · codex · gemini · qwen · kimi · 自定义
│   │
│   └─ (b) 运行记录  Runs ───── 让每次运行可观测、可追溯、可被定时触发
│           · 来源    Agent 经 SKILL.md 写入管理目录（.odw/workflows）
│           · 运行    odw run <name> 按名跑（resolveWorkflow）
│           · 记录    run 目录 + JSONL 事件 + job↔workflow 关联
│           · 退出码  odw run --wait 终态非零
│           · 定时    OS-cron 配方（无新调度模块）
│
└─ ② 客户端（只读展示层）── macOS 原生应用 · 基于 ODW 套件
    │
    ├─ (a) Workspace   有哪些 workflow + 它们的结构
    ├─ (b) Jobs        在跑/历史的 job + 各属于哪个 workflow + 实时进展（活 DAG）
    └─ (c) 待定        （第三个展示维度，暂留空位）
```

---

## 2. ① CLI（核心层）

### (a) 运行层 Runtime — 翻译 / 运行 / 执行 + 对接不同 CLI

**现状（已有）**：`agent / parallel / pipeline / phase / log / args` 全实现并测试；schema 校验 + 重试管线完整；loader 源变换正确、`meta` 纯字面量解析；scheduler 信号量并发 + `dispatchedCount >= maxAgents` 的 1000-agent 兜底（scheduler.ts:52）；5 个内置适配器 + 自定义。

**要做**：
- **消除三处方言级「沉默 no-op」**：`agent.model`、`agentType`（primitives.ts:66 实为 adapter 名 fallback，语义含混）、`isolation:'worktree'`（走 copy fallback）——被接受却未生效时**响亮发 `LOG`，绝不沉默丢弃**。
- **预算硬上限钩子**：`budget.spent()` 暂留桩（primitives.ts:115），但在 scheduler 兜底前先植入 `spent >= total` 钩子（桩态恒不触发、零行为变化），用途是日后给嵌套 `workflow()` 做成本门控。
- **双兼容做成 CI 护栏**：把 Claude Code 方言双兼容从口头约束变成**静态审计 + fixtures**（oracle：`meta` 字面量 eval 出的值 deep-equal 同 span 的 `JSON.parse`）。这是「方言保真」这条命根子的护栏——**做成测试，不做成用户命令**。
- **`meta` 维持 Claude Code 那份**：`name / description / phases`，本期**不加任何字段**。

**择机（非本期）**：`workflow(nameOrRef)` 经同一个 `resolveWorkflow`（resolve.ts:14-16）跑本地工作流（须先有上面的预算硬上限）；`agentType` → role 映射；`isolation` 真 git-worktree。

### (b) 运行记录 Runs — 可观测、可追溯、可定时

**现状（已有）**：detached worker（launcher.ts spawn + unref，fire-and-forget）+ 文件化 run 目录（原子写）；JSONL 9 类事件；`resolveWorkflow` 命名解析；`odw list` 默认输出已含 name（cli.ts:268）；`--wait` 终态退出码已在 reportTerminal 映射（cli.ts:439-451）；Agent 经 SKILL.md 写入 `.odw/workflows`（管理目录已就位）。

**要做**：
- **job ↔ workflow 关联**（客户端 Jobs 的命根子）：`workflowName` 在**创建时**写入 `CreateRunInput`（run-store.ts:45）——目前只在运行中写（worker.ts:74）；并提供 `odw list --workflow <name>` / `odw logs --workflow <name>` 反查，不扫描全部 meta.json。
- **退出码保证**：非 `--wait` 路径目前 spawn 即返回 0（cli.ts:196）；补齐 `--wait` 对 `failed`/`stopped` 返回非零（已映射，加测试覆盖）。
- **OS-cron 配方**：文档 + shell 模板，**强制 `--wait`**，无 daemon、无新调度模块。
- **SKILL.md 复核**：核对组合模式 ↔ 8 个 example 对齐、原语签名现行、确定性规则成文。

**择机**：`odw cleanup` 按龄清理；dead-pid 标记 `interrupted`。

---

## 3. ② 客户端（只读展示层）

**定位**：基于 ODW 套件的**只读窗口**。当前 `dashboard.html` 是单文件 vanilla JS 看板，待升级为数据驱动的 DAG。

**技术选型**：**Tauri**（避开 Electron 双 Node 税、避开 SwiftUI 与 Web 渲染器分叉）。运行时永远纯 Node 零依赖；Rust 只在客户端构建里，webview 与未改动的 localhost server（`odw serve`）对话。前端经 `scripts/embed-dashboard.mjs` 产出**唯一一份 bundle**，内嵌二进制与原生外壳**同 hash 消费**——CI 断言零渲染代码分叉。

**需运行时先行暴露的（小）契约**：拓扑事件（`agent/parallel/pipeline` 在 `AGENT_STARTED` 上发可选 `groupId/kind/index`，`RunDetail` 派生 groups 树，向后兼容，旧 events.jsonl 仍可折叠）+ SSE `/api/stream?since=` 增量。

### (a) Workspace — 有哪些 workflow + 它们的结构
- 数据：管理目录的脚本列表 + `meta`(name/description/phases)。「结构」先用 `meta.phases` 给泳道层级，更细的 DAG 来自运行时拓扑事件。
- 纯只读，不发起运行。

### (b) Jobs — 在跑/历史的 job + 各属于哪个 workflow + 实时进展
- 数据：run 记录（由 §2(b) 的 `workflowName` 关联）+ events.jsonl 流。
- **活 DAG**：phase 泳道、**单层** parallel fan-out、**单层** pipeline 链、节点按状态变色；SSE 实时 + 断线重连显示缓存 + stale badge，再经 `?since=` 追平。
- **嵌套渲染**（parallel 嵌在 pipeline 内）作为**后续独立交付**渲染为可折叠子图，**绝不降级回 lane**（lane 正是别人已有的）。

### (c) 待定 — 第三个展示维度
暂留空位（此前的候选如 Hub 画廊都依赖分发，本期不适用；待定下真正的第三维再补）。

---

## 3.5 ③ 发起层（Launch）— 观测台升级为发射台（2026-06-11 落地）

> 完整任务拆解与决策记录：[`docs/tasks/launch.md`](tasks/launch.md)。②的「只读」铁律在此**有意修订**（不是漂移）：GUI 可以发起、控制 **ODW 自己的** run；Claude provider 仍严格只读；Tauri 壳零扩权（写全走 `odw serve` 的 loopback HTTP API）。

- **用户流（单次任务式）**：Launch 视图描述任务 + 选 agent → `POST /api/generate` 启动**生成 run**（生成本身就是一个 workflow：Generate → Validate → Repair，live DAG 全程可观测）→ Result tab 特化为脚本预览 + 权限说明 + `[Run]` 确认闸 → 正式 run 跑完后 `[Save to Workspace]` 沉淀为可复用 workflow（`odw run <name>` 同样可跑）。
- **引擎三缝（CLI 同样受益）**：`validate(source)` 原语（workflow 生成 workflow 的自举能力）；run 级 adapter 覆盖（`odw run --adapter <name>`）；`startRunFromSource`（生成的脚本随 run 留档于 run 目录）。
- **方言完备性（同期补齐）**：嵌套 `workflow()` 已实现（单层、共享调度与预算，Claude Code 对齐）；`budget.spent()` 从桩升级为估算计量（chars/4），`--budget` 成为真上限。
- **安全面**：所有写端点过 `writeGuard`（Content-Type + same-origin）+ Host 头校验（防 DNS rebinding）；off-loopback bind 写一律 409。

---

## 4. 推进顺序（按依赖，不绑版本号）

1. **`workflowName` 创建时写入 + 反查**（run-store / cli）——客户端 Jobs 的最小前置。
2. **拓扑事件（加性）**——客户端活 DAG 的数据前置；旧 events.jsonl 仍折叠。
3. **客户端 Web 版**：Workspace + Jobs，先在浏览器把 DAG 体验跑通。
4. **退出码保证 + OS-cron 配方**——让运行可被定时触发并判定成败（与 1–3 相对独立）。
5. **运行层补强**：消除沉默 no-op + 预算硬上限钩子 + 双兼容 CI 审计 + SKILL.md 复核（持续）。
6. **Tauri 原生外壳**：DAG 体验验证通过后，套上原生壳，消费第 3 步同一 bundle。

---

## 5. 本期明确不做

把范围钉死，避免边界蔓延：

- **分发 / Hub / install / publish / upgrade**：整条链推迟到未来；连带 `meta` 的 `args / author / version / license / repository` 一并挂起——**哪天真做分发，再回来加这些字段**。
- **GUI 发起工作流 / 参数表单渲染**：客户端只读，发起永远在 Agent + CLI。
- **`odw describe` / `check` / `new`**：describe、表单的影子；`new` 是前 Agentic 时代的人类脚手架——都不做。
- **自研调度器**：走 OS cron，不写 daemon、不加新模块。
- **真 token 计量、Date/Math.random replay 沙箱、第一方领域模板广度**：均不做。

---

## 附录 · 关键文件锚点

- `src/loader.ts` — `WorkflowMeta`（本期不扩字段）；`assertMeta`
- `src/primitives.ts` — `agentType` fallback:66；`spent` 桩:115；`workflow` 抛错:119-120
- `src/scheduler.ts` — 1000-agent 兜底:52（`spent>=total` 钩子落点）
- `src/runtime/run-store.ts` — `CreateRunInput`:45（待加 `workflowName`）
- `src/runtime/worker.ts` — name 写入:74（仅运行中，待提前到创建时）
- `src/runtime/launcher.ts` — fire-and-forget spawn:60-66
- `src/cli.ts` — list 已含 name:268；reportTerminal 退出码:439-451；非 --wait spawn 即 0:196
- `src/workflows/resolve.ts` — 命名解析 resolver:14-16
- `src/runtime/server.ts` — API 端点（拓扑事件 / SSE）
- `src/dashboard.html` — 待升级为数据驱动 DAG（单一 bundle 工件）
- `skill/SKILL.md` — 待复核
- `tests/` — 待加双兼容静态审计 + fixtures
