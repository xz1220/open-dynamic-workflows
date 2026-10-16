# Open Dynamic Workflows — 模块路线图

> 组织方式：先说清「项目是什么」，再按「提供哪些模块」展开成一棵树。
> 本期主线只有三件事：**运行引擎 → 运行记录 → 客户端观测 / Chat Host**。
> 分发、参数表单、机器可读参数契约等，明确不在本期（见 §5）。
> 重写日期：2026-06-05

---

## 0. 项目是什么

**ODW 是一个动态工作流的运行时**：用 Claude Code 方言（`export const meta` + 注入 `agent / parallel / pipeline / ...`）写一次工作流脚本，既能在 Claude Code 本体跑，也能经 `odw` 在 Codex / Gemini / Qwen / Kimi / 自定义 CLI 上**原样跑**；再配一个客户端，看这些工作流和它们的运行，并承载本地 Chat Host。

两条贯穿全局的事实——它们决定了下面所有取舍：

- **通用 workflow 发起仍由 Agent / CLI 负责。** 没有 Launch 表单，也不接受浏览器直接提交 inline workflow。
- **客户端写能力保持窄口径。** 允许本地 Chat Host 会话/消息、App 偏好、适配器配置，以及 ODW 自己 run 的控制；Claude provider 仍只读。

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

**定位**：基于 ODW 套件的**只读窗口**。当前看板是 `web/` 下的单页应用（构建为 `web/dist/index.html` 后内嵌；旧的单文件 `src/dashboard.html` 已删除），待升级为数据驱动的 DAG。

**技术选型（2026-07-09 更新）**：客户端形态收敛为**纯 Web**——`odw serve` 的浏览器看板是唯一客户端；此前的 Tauri 原生外壳（`apps/desktop`）已退役删除。运行时永远纯 Node 零依赖；前端经 `scripts/embed-dashboard.mjs` 产出**唯一一份 bundle**，由内嵌二进制直接服务。

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

## 3.5 ③ Chat Host 与 Launch 退役（2026-07-03）

> 早期的 Launch / 发射台路线已从前后端删除：不再提供 `#/launch`、`GET /api/adapters`、`POST /api/generate`、`POST /api/runs`、`POST /api/workflows`。当前 App 入口收敛为 Chat Host + Jobs / Workspace / Activity 观测；Claude provider 仍严格只读。

- **当前用户流**：在 Chat 中正常和 Codex 对话；提到 ODW 或 workflow 时，Chat Host 将该回合关联到真实异步 ODW run，run 完成后以 user message 形式恢复会话并触发下一轮 Codex 工作。
- **保留的引擎能力（CLI 同样受益）**：`validate(source)` 原语；run 级 adapter 覆盖（`odw run --adapter <name>`）；`startRunFromSource`（内联脚本随 run 留档于 run 目录）。
- **方言完备性**：嵌套 `workflow()` 已实现（单层、共享调度与预算，Claude Code 对齐）；`budget.spent()` 从桩升级为估算计量（chars/4），`--budget` 成为真上限。
- **安全面**：本地写能力仅保留 Chat 会话/消息、ODW run 控制与配置类接口，继续通过 `writeGuard`（Content-Type + same-origin）+ Host 头校验（防 DNS rebinding）收敛。

---

## 4. 推进顺序（按依赖，不绑版本号）

1. **`workflowName` 创建时写入 + 反查**（run-store / cli）——客户端 Jobs 的最小前置。
2. **拓扑事件（加性）**——客户端活 DAG 的数据前置；旧 events.jsonl 仍折叠。
3. **客户端 Web 版**：Workspace + Jobs，先在浏览器把 DAG 体验跑通。
4. **退出码保证 + OS-cron 配方**——让运行可被定时触发并判定成败（与 1–3 相对独立）。
5. **运行层补强**：消除沉默 no-op + 预算硬上限钩子 + 双兼容 CI 审计 + SKILL.md 复核（持续）。
6. ~~**Tauri 原生外壳**~~（2026-07-09 取消：桌面外壳已退役，Web 看板是唯一客户端，不再套原生壳）。

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
- `web/` — 看板 SPA，经 `scripts/embed-dashboard.mjs` 内嵌为单一 bundle 工件（待升级为数据驱动 DAG）
- `skills/open-dynamic-workflows/SKILL.md` — 待复核
- `tests/` — 待加双兼容静态审计 + fixtures
