# ③ 发起层（Launch）— 任务拆解

> 对应产品升级（2026-06-10 决策）：客户端从「只读观测台」升级为「**任务式发射台**」——用户在 App 里选一个 coding agent、用自然语言描述任务，系统**生成一个 dynamic workflow**，预览确认后运行，全程在既有 Jobs 视图观测，跑完看结果。
> 交互形态是**单次任务式**（task in → workflow out → run → result），不是 chat；产品核心仍是 dynamic workflows——生成环节本身也是一个 workflow（见 D2）。
> 每个任务带：目标 / 做法 / 文件锚点 / 完成标准（DoD）。可直接分配给 agent 开工。

---

## 0. 定位与铁律修订

[gui.md](gui.md) §0 立了两条铁律：①「发起运行的永远是 Agent（CLI）」②「客户端只读」。**本期有意废止第一条、收窄第二条**——这是产品定位的升级（观测台 → 发射台），不是漂移。修订后的不变量：

1. **GUI 可以发起、控制 ODW 自己的 run**（generate / run / stop）。
2. **Claude provider 仍然严格只读**：`ClaudeRunSource` 的 `controlError` 机制原样保留（`src/runtime/run-source.ts`），GUI 永不写 Claude Code 的 run 数据。
3. **写路径全部走 `odw serve` 的 localhost HTTP API**，Tauri 壳的红线不变：Rust 不碰 run 数据、不写业务逻辑（`apps/desktop/src-tauri/src/lib.rs`），capabilities 无需扩权。
4. **零运行时依赖铁律不变**（gui.md §1.4）：所有新增能力（生成、校验、发起）继续纯 Node 实现。

> **写路径选型记录（诚实版）**：备选是把发起逻辑放进 Tauri Rust command（由 Rust spawn `odw run`）。好处：纯浏览器访问 `odw serve` 时拿不到执行权限，面更小。代价：同一逻辑写两份（web 版没法用）、capabilities 扩权、Rust 红线被破。判定：server 本来就 bind 127.0.0.1、本来就持有 RunStore/config/SSE，写端点放 server + same-origin/Host 防护（§3.5）在「本地工具」威胁模型下足够；若将来 serve 要暴露到局域网，再回头加 token 鉴权（§3.5 已预留闸门）。

---

## 1. 已锁定的产品决策（2026-06-10，用户拍板）

| # | 决策 | 内容 | 接受的代价 |
|---|---|---|---|
| **D1** | 生成方式 = **agent 自由生成** | 把 workflow 方言文档（`skill/SKILL.md`）+ examples 模式摘要喂给所选 agent，针对任务自由编写脚本；**必须配 loader 编译校验 + 报错回喂修复循环**（≤3 次尝试），不允许裸生成 | 首次成功率非 100%，依赖修复循环兜底；一次生成 = 1–3 次 agent 调用的成本 |
| **D2** | 生成载体 = **生成本身就是一个 odw workflow** | 内置 `generate-workflow.js`（Generate → Validate → Repair 多步编排），生成过程作为一个 run 出现在 Jobs，live DAG 全程可观测——「以 dynamic workflows 为核心」贯彻到生成环节 | 比 server 进程内直调 Bridge 多几秒 detached worker 启动开销；换来生成过程可观测、失败可追溯、修复循环用 workflow 原语自然表达 |
| **D3** | 运行确认 = **预览确认再跑** | 生成完成后展示脚本 + 从 meta 提取的 phase 结构预览（复用 DAG 渲染器 static 模式），用户点 Run 才执行 | 多一次点击；换来 agent 动用户文件前有确认闸 + 不满意可改任务重新生成 |
| **D4** | 脚本归宿 = **默认即弃 + 一键收藏** | 生成的脚本落在 run 目录里随 run 留档；跑完结果页提供「Save to Workspace」存为可复用 workflow（进管理目录，Workspace 立即可见） | 多一个按钮的工程量；换来好任务沉淀成资产、Workspace 不被一次性脚本污染 |
| **D5** | 写路径 = **`odw serve` HTTP API** | 见 §0 选型记录 | 浏览器途径攻击面扩大 → §3.5 防护 |
| **D6** | **解禁 `/control` 的 GUI 入口（仅 ODW）** | 从 App 发起的 run 必须能从 App 停掉——active 的 ODW run 加 Stop 按钮（端点早已存在）。废止 gui.md §7 的「control GUI 入口不提供」 | 无实质代价；Claude provider 由 `controlError` 自动拒绝，前端按 provider 隐藏按钮 |

---

## 2. 用户流（一次任务式交互）

```
Launch 视图                     Jobs / Job 详情（全部复用现有视图）
┌─────────────────┐
│ 任务描述 textarea │   POST /api/generate        生成 run（generate-workflow）
│ agent 下拉       │ ──────────────────────────▶ 跳 #/job/:genId — live DAG 看
│ source 目录      │   {task, adapter, source}    Generate→Validate→Repair 推进
└─────────────────┘                                      │ done
                                                         ▼
                              Result tab 特化渲染：脚本预览 + phase pills
                              [ Run ]  [ Regenerate ]  （D3 确认闸）
                                  │ POST /api/runs {script, adapter, source}
                                  ▼
                              跳 #/job/:runId — 正式 run，live DAG / Logs
                                  │ done
                                  ▼
                              Result tab：真实结果 + [ Save to Workspace ]（D4）
                                  │ POST /api/workflows
                                  ▼
                              Workspace 出现该 workflow（可复用，odw run 也能跑）
```

关键复用（这次升级工程量小的原因）：**「运行 + 观测」一段不写任何新视图**——生成 run 和正式 run 都是普通的 ODW run，Job 详情页（live DAG / Logs / Result，1200ms 轮询 + SSE）原样吃下；唯二的特化是 generation run 的 Result tab（预览 + Run 按钮）和 generated run 的 Result tab（Save 按钮）。

---

## 3. 架构与 API 契约（全部加性）

### 3.1 新端点（`src/runtime/server.ts`）

```
GET  /api/adapters            → [{name, installed, isDefault, permissionNote}]
POST /api/generate            → {task, adapter, source}                → {runId}
POST /api/runs                → {script | name, args?, adapter?, source} → {runId}
POST /api/workflows           → {name, source, scope: "global"|"project"} → {path}
POST /api/runs/:id/control    →（已存在）SPA 解禁调用，仅 ODW provider（D6）
```

- **`GET /api/adapters`**：`loadConfig` 的 adapter 表 + `isOnPath` 探测（复用 `src/adapters/config.ts:149` resolveAdapter 的探测逻辑，抽出 `listAdapters(config)`）。`permissionNote` = 该 adapter 的权限模式人话（如 claude `acceptEdits` / codex `workspace-write`），供确认页透明展示（§3.5）。
- **`POST /api/generate`**：薄糖——把内置生成 workflow 用 `startRun` 启动：`args = {task, requestedAdapter, dialectDoc, patternsDigest}`（dialect 文档由 server 注入，见 §3.2），`adapter` 作 run 级覆盖（§3.3-b），`source` 透传。立刻返回 `{runId}`，前端跳 Job 详情。
- **`POST /api/runs`**：通用发起。`script`（inline 源码，走 §3.3-c 的 `startRunFromSource`）或 `name`（管理目录名，走现有 `resolveWorkflow`）二选一；起 run 前先 `loadWorkflowScript` **只编译**校验，编译失败 400 带错误信息（绝不把明知坏的脚本送进 worker）。
- **`POST /api/workflows`**（D4 收藏）：把源码写进管理目录（`resolveWorkflowsRoot` 的全局目录，或 `<source>/.odw/workflows`，由 `scope` 定）；写前编译校验 + 重名 409（前端提示改名）。
- 所有 POST 共用一个 `writeGuard`（§3.5），从现有 `controlRun` 的 CSRF 检查抽出。

### 3.2 内置生成 workflow（D1+D2 的核心交付物）

`src/workflows/generate-workflow.ts` 导出脚本源字符串（与 `dashboard.generated.ts` 同理由：SEA 二进制里没有仓库文件，必须 embed；`skill/SKILL.md` 同样在构建期 embed 成 `src/skill.generated.ts`，server 起 generate run 时作为 `args.dialectDoc` 注入——脚本保持纯净、文档单一来源）。

脚本结构（meta.phases = Generate / Validate / Repair）：

```js
// args: { task, requestedAdapter, dialectDoc, patternsDigest }
phase("Generate")
let draft = await agent(authoringPrompt(args), { schema: SCRIPT_SCHEMA })
for (let attempt = 1; attempt <= 3; attempt++) {
  phase("Validate")
  const check = validate(draft.script)        // ← 新增 host 原语，见 §3.3-a
  if (check.ok) return { script: draft.script, meta: check.meta, attempts: attempt }
  phase("Repair")
  log(`attempt ${attempt} failed: ${check.errors[0]}`)
  draft = await agent(repairPrompt(draft.script, check.errors), { schema: SCRIPT_SCHEMA })
}
throw new Error("3 次尝试后仍未通过编译校验：" + lastErrors)
```

- **authoring prompt 的上下文**：`dialectDoc`（SKILL.md 全文，~6KB）+ `patternsDigest`（examples/ 八个模式的名称、一句话适用场景、骨架片段——手工策展、embed 在脚本里，让 agent 见过六大编排模式再下笔）+ 用户任务 + 方言硬约束清单（meta 纯字面量、禁 `Date.now()/Math.random()/new Date()`、纯 JS 无类型标注——这些正是 agent 最常犯的错，prompt 里点名 + validate 兜底）。
- **生成 run 失败也是 feature**：3 次不过即 run failed，错误进 error.json，用户在 Jobs 里能看到每次尝试的报错——比黑盒 loading 转圈后弹「生成失败」可调试得多。

### 3.3 引擎加性改动（三处小缝）

- **(a) `validate(source)` 原语**：host 提供的 workflow global（`src/primitives.ts` 注入，调 `src/loader.ts` 的 `loadWorkflowScript` **只编译不执行**），返回 `{ok, meta?, errors?}`。这是「生成 workflow 的 workflow」的通用能力，不是一次性补丁——任何自举/元编排场景都用得上。对既有 164 测试零影响（纯新增 global）。
- **(b) run 级 adapter 覆盖**：`StartRunOptions` + `CreateRunInput` 加可选 `adapter`，落进 meta.json，worker（`src/runtime/worker.ts`）读出后作为该 run 内 `resolveAdapter` 的默认名（优先级：`agent()` 显式 `adapter` 选项 > run 级覆盖 > config `defaultAdapter` > 现有 auto-pick）。这是「用户在 App 里选 agent」的落点；CLI 顺手得到 `odw run --adapter <name>`（与 GUI 同一条缝）。
- **(c) inline 脚本发起**：`startRunFromSource(sourceCode, opts)`（`src/runtime/launcher.ts`）——先 `store.create`、把源码写成 run 目录内的 `workflow.js`、meta.script 指向它、再 spawn worker。生成的脚本天然随 run 留档（D4 的「即弃但可查」），不需要额外的临时目录。

### 3.4 前端（`web/`，沿用 vanilla TS + 字符串模板）

- **新路由 `#/launch` + `views/launch.ts`**：任务 textarea、agent 下拉（`/api/adapters`，未安装的置灰）、source 目录输入。rail 加 Launch 入口；Workspace/Jobs 的空状态 CTA 指向它（替换现有「runs are started by your agent, not here」banner——那句话本期起不再为真）。
- **source 目录选择（v1 务实版）**：文本输入 + localStorage 最近目录列表；POST 后 server 校验目录存在（不存在 400 回显）。Tauri 原生目录选择器（dialog plugin）是 v1.1 加性项——纯 web 版没有原生对话框，feature-detect 分叉，本期不做。
- **Job 详情两处特化**（`views/job.ts`，按 `workflowName` / meta 识别）：
  - generation run（`workflowName === "generate-workflow"`）done 后，Result tab 渲染为**预览页**：脚本（复用 Workspace 的 `highlight()`）+ phase pills（meta.phases）+ `[Run]`（POST /api/runs，带上原 adapter/source）+ `[Regenerate]`（回 Launch 预填原任务）。
  - 由 generate 链路发起的正式 run done 后，Result tab 追加 `[Save to Workspace]`（弹名字输入 → POST /api/workflows）。识别方式：POST /api/runs 时 meta 记 `origin: "launch"`（CreateRunInput 加性字段）。
- **Stop 按钮（D6）**：Job 详情 header 对 active 且 provider=odw 的 run 显示 Stop → 既有 `POST /api/runs/:id/control`。Claude run 不显示（`controlError` 在 RunDetail 暴露与否检查后定）。
- **api.ts 解禁**：删「No control calls — by design」注释，新增 `generate/launch/saveWorkflow/control` 四个 POST 封装；其余读路径不动。

### 3.5 安全（诚实版）

新增的真实攻击面是**浏览器途径**：`POST /api/runs` 接 inline 脚本 = 「驱动本机 agent 执行任意任务」的 HTTP 端点。本机进程本来就能跑任意代码（odw 是本地工具，这不是新风险）；要防的是**恶意网页**经由用户浏览器打 localhost（CSRF / DNS rebinding）。措施：

1. **`writeGuard`（所有 POST）**：要求 `Content-Type: application/json`（杜绝 CORS simple request）+ Origin 存在时必须 same-origin——从 `controlRun`（`server.ts:291`）抽出复用。
2. **Host 校验（防 DNS rebinding，新增）**：默认回环 bind 下，`Host` 头不是 `localhost`/`127.0.0.1`（带端口）一律 403。读端点也一并套上（顺手补的防护，加性）。
3. **off-loopback 一刀切**：`--host` 非回环时，所有写端点直接 409（「writes are loopback-only; token auth is a future opt-in」）。看板可以远程看，发射台不行——直到做 token。
4. **agent 权限透明**：确认页（预览页）显示所选 adapter 的 `permissionNote`（来自 /api/adapters）——用户点 Run 前知道 agent 将以什么权限动 `source` 目录。权限本身仍由 `odw.config.json` 的 adapter flags 决定，GUI 不提供旁路提权。

### 3.6 不碰的东西

- `runs-view.ts` / SSE / DAG 渲染器 / Activity / Workspace 读模型：零改动（生成 run 是普通 run）。
- Tauri 壳与 capabilities：零改动（写全走 localhost HTTP）。
- 零运行时依赖：`package.json` dependencies 仍为空。

---

## 4. 本期不做 / 待定

- **chat 式多轮调整**（「把第二个 phase 改成 5 个 agent」）：单次任务式是本期定位；多轮微调 = Regenerate 带上次脚本作上下文，留待验证需求后做。
- **Tauri 原生目录选择器**：v1.1 加性项（见 §3.4）。
- **off-loopback 的 token 鉴权**：预留闸门（§3.5-3），有真实远程需求再做。
- **生成 workflow 的流式 token 级输出**：Jobs 的事件流粒度（agent 起止 + log）已够观测，不做 SSE token 流。
- **参数表单 / schema 驱动的 args UI**：收藏后的 workflow 复跑仍走 CLI 或后续迭代；本期 Launch 只管「任务 → 新 workflow」主线。

---

## 5. 任务清单（按依赖排序；DoD + 文件锚点）

> 排序原则：先引擎缝（L1，CLI 也受益）、再生成 workflow（L2，可纯 CLI 验证、不依赖前端）、再 server 端点（L3）、最后前端（L4/L5/L6）。L1–L3 全程可用 mock adapter 测试，不烧真 token。

- [x] **L1 — 引擎三缝：adapter 覆盖 + inline 发起 + validate 原语**
  - 做法：§3.3 的 (a)(b)(c)。`resolveAdapter` 的 fallback 链插入 run 级覆盖；`startRunFromSource` 写 `workflow.js` 进 run 目录；`validate` global 注入 primitives。CLI 加 `odw run --adapter <name>`。
  - DoD：单测覆盖三缝（含：坏脚本 inline 发起被 400 级拒绝逻辑的库函数版、validate 对禁用 API/非纯 meta 的报错、adapter 覆盖优先级链）；既有测试全绿。
  - 锚点：`src/runtime/launcher.ts`、`src/runtime/run-store.ts`、`src/runtime/worker.ts`、`src/adapters/config.ts`、`src/primitives.ts`、`src/loader.ts`、`src/cli.ts`。

- [x] **L2 — 内置 generate-workflow + 文档 embed**
  - 做法：§3.2。`scripts/embed-skill.mjs`（仿 embed-dashboard）→ `src/skill.generated.ts`；`src/workflows/generate-workflow.ts` 导出脚本串 + patternsDigest；authoring/repair prompt 含方言硬约束清单。
  - DoD：mock adapter 下——首次即合法脚本→1 次过；故意先回坏脚本（用了 Date.now / meta 非字面量）→ Repair 收敛；3 次全坏→run failed 且 error.json 含末次报错。真 adapter 冒烟：一个真实任务生成出可 `odw run` 的脚本。
  - 锚点：`src/workflows/generate-workflow.ts`、`scripts/embed-skill.mjs`、`skill/SKILL.md`、`examples/`。
  - 依赖：L1。

- [x] **L3 — server 写端点 + writeGuard/Host 校验**
  - 做法：§3.1 + §3.5。抽 `writeGuard`；四个新端点；off-loopback 写禁用；`GET /api/adapters` 的 `listAdapters`。
  - DoD：`tests/server.test.ts` 扩：generate→runId→（mock）done→result 含脚本；POST /api/runs inline 坏脚本 400；跨 Origin 403 / 错 Host 403 / off-loopback 写 409；POST /api/workflows 落盘 + 重名 409 + Workspace 列表立即可见。
  - 锚点：`src/runtime/server.ts`、`src/runtime/workflows-view.ts`。
  - 依赖：L1、L2。

- [x] **L4 — Launch 视图 + 路由 + 入口**
  - 做法：§3.4 第 1–2 条。`views/launch.ts`、rail 入口、空状态 CTA 替换、`api.ts` 四个 POST 封装。
  - DoD：浏览器对接真 `odw serve`：填任务→选 agent→Generate→自动跳 generation run 的 live DAG；未安装 adapter 置灰；目录不存在的报错回显在表单。
  - 锚点：`web/src/views/launch.ts`、`web/src/main.ts`、`web/src/shell.ts`、`web/src/api.ts`、`web/src/views/{workspace,jobs}.ts`。
  - 依赖：L3。

- [x] **L5 — Job 详情特化：预览/Run、Save to Workspace**
  - 做法：§3.4 第 3 条。generation run 的 Result tab 预览页（脚本 + phase pills + Run/Regenerate）；`origin:"launch"` 的 run 的 Save 按钮。
  - DoD：端到端走通 §2 全链路（生成→预览→Run→结果→收藏→Workspace 可见且 `odw run <name>` 可复跑）；预览页展示 adapter 权限说明。
  - 锚点：`web/src/views/job.ts`、`web/src/dag.ts`（static 模式入参）、`src/runtime/run-store.ts`（origin 字段）。
  - 依赖：L4。

- [x] **L6 — Stop 按钮（D6 解禁）**
  - 做法：Job 详情 header + Jobs active 卡对 provider=odw 且 active 的 run 加 Stop → 既有 control 端点。
  - DoD：从 App 发起的 run 可从 App 停掉，状态流转到 stopped 并即时反映；Claude run 不出现按钮。
  - 锚点：`web/src/views/job.ts`、`web/src/views/jobs.ts`、`web/src/api.ts`。
  - 依赖：L4（api.ts 解禁）。

- [x] **L7 — 文档对齐**（2026-06-11 落地:ROADMAP §3.5、gui.md §0 修订指针、README/zh 发射台章节 + 真实运行截图;偏离:mockup HTML 不再补 Launch 屏——`assets/app-screenshots/launch*.png` 三张真实截图已是视觉真相,mockup 退役为历史稿）
  - 做法：ROADMAP 加「③ 发起层」一节；gui.md §0 处加修订指针（本文件）；README 演示链路待 L5 后录制；`docs/odw-client-mockup.html` 补 Launch 屏（视觉真相，可与 L4 并行）。
  - DoD：新读者从 ROADMAP 能读到铁律修订的来龙去脉；mockup 与实现 1:1。
  - 锚点：`docs/ROADMAP.md`、`docs/tasks/gui.md`、`README.md`、`docs/odw-client-mockup.html`。

---

## 附录 · 文件锚点

- `src/runtime/launcher.ts:31` — `startRun`（path/name 入口；L1 加 `startRunFromSource` + adapter 覆盖）
- `src/runtime/run-store.ts:52` — `CreateRunInput`（L1 加 `adapter`、L5 加 `origin`）
- `src/runtime/worker.ts:27` — `executeRun`（L1：读 meta.adapter 作 run 级默认）
- `src/adapters/config.ts:149` — `resolveAdapter` / `isOnPath`（L1 覆盖链 + L3 `listAdapters`）
- `src/primitives.ts` — workflow globals（L1 注入 `validate`）
- `src/loader.ts:68` — `loadWorkflowScript`（validate 与 POST /api/runs 的编译校验共用）
- `src/runtime/server.ts` — 新端点 + writeGuard + Host 校验（`controlRun` 的 CSRF 检查抽出复用，`server.ts:291`）
- `src/workflows/generate-workflow.ts`（新）— 内置生成 workflow 源串 + patternsDigest
- `scripts/embed-skill.mjs`（新）→ `src/skill.generated.ts` — SKILL.md 进二进制
- `skill/SKILL.md` — workflow 方言权威文档（authoring prompt 的 `dialectDoc`）
- `examples/` — 八个编排模式（patternsDigest 的策展来源）
- `web/src/views/launch.ts`（新）、`web/src/views/job.ts`、`web/src/api.ts`、`web/src/shell.ts`、`web/src/main.ts`
- `docs/tasks/gui.md` — 被修订的铁律出处（§0、§2.1、§7）
