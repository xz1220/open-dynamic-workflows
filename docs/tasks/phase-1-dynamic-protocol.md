# Phase 1 — Dynamic Protocol：方言与运行时规格

> 2026-07-11。本期唯一交付物是**这份文档本身**：把已经在 main 上跑着的协议照实写清楚、定下来。
> 不改一行代码。所有"顺手也做了吧"的念头一律进文末的候选池，本期不碰。

## 0. 协议是什么

Dynamic Protocol 由三个契约组成，三者共同构成 odw 与一切上层（agent、CLI 用户、未来的 elorae）之间的边界：

| 契约 | 载体 | 谁读谁写 |
|---|---|---|
| **书写契约**（方言） | workflow `.js` 文件 | 作者（人或 agent）写，loader 翻译，引擎执行 |
| **观测契约** | run 目录（7 个基本文件 + 可选启动记录 + 9 种事件） | worker/launcher 写，任何观察者读 |
| **控制契约** | `odw` CLI（run/status/logs/pause/stop…） | 调用方驱动 |

方言的语法**就是标准 JavaScript**（非 TS）。"方言"体现在三条约定：`export const meta` 字面量、8 个注入全局、顶层 `await`/`return` 合法。除此之外没有任何私有语法。

---

## 1. 书写契约：方言

### 1.1 文件形状

```js
export const meta = { name: "...", description: "...", phases: [...] }
// 之后是 body：可用顶层 await，顶层 return 即整个 workflow 的返回值
```

- `meta` 必须是**纯字面量**：不允许变量、函数调用、展开、运算、模板插值。这是 Claude Code 侧的硬约束（它不执行 body、静态提取 meta）；odw 的 loader 也只按纯字面量解析 meta、从不求值（列出工作流不会执行任何文件里的代码），违反即在加载期报错并指出位置。
- meta 字段：`name`（非空字符串）、`description`（字符串）必填；`whenToUse`、`phases[{title, detail?, model?}]`、`model` 可选。
- `phases` 的 title 与 body 中 `phase()` 调用按**字符串精确匹配**关联；对不上不报错，只是各成一组。
- 除 `export const meta` 外，**禁止任何其它顶层 `export` / `import`**（原语是注入的，不是导入的）；违反在加载期即报错。

### 1.2 翻译机制（loader）

loader 是唯一的"翻译"发生地，做三件事：

1. 在**掩码源码**上定位 `export const meta =`（字符串/注释/模板/正则内容全部遮蔽后再扫描，杜绝误匹配），从原始源码切出字面量；
2. 剥掉 `export`；
3. 把剩余 body 包进一个 `AsyncFunction`，其形参**按固定顺序**就是注入全局：

```
(agent, parallel, pipeline, phase, log, args, budget, workflow [, validate]) => { <body> }
```

前 8 个与 Claude Code Workflow 工具完全一致，顺序永不移动。`validate` 是 odw 独有的第 9 参，**条件注入**：body 自己声明了 `validate` 标识符时不注入，脚本自己的绑定生效——保证 Claude Code 上合法的脚本在 odw 上不因重名编译失败。

### 1.3 注入全局的语义

| 全局 | 语义要点 |
|---|---|
| `agent(prompt, opts?)` | 唯一干活的动词：起一个 adapter 子进程跑子任务。opts：`adapter` / `schema` / `label` / `phase` / `model` / `agentType`（人设，注入提示词，**不是** adapter 名）/ `isolation:"worktree"`（真 git worktree 隔离，与 Claude Code 同机制）。带 `schema` 返回校验后的对象，否则返回文本。 |
| `parallel(thunks)` | **屏障**：全部完成才返回。单个 thunk 的可恢复失败落成结果里的 `null` 槽位，调用本身不 reject；fatal（预算耗尽/stop/总量保险丝）向上抛、终止整个 run。 |
| `pipeline(items, ...stages)` | **无屏障**：每个 item 独立穿过所有 stage，A 在 stage 3 时 B 可以还在 stage 1。stage 签名 `(prev, item, index)`。某 stage 抛错 → 该 item 变 `null`、跳过其余 stage。 |
| `phase(title)` | 设置当前阶段标签 + 发 `phase_started` 事件。纯展示语义，不影响执行。 |
| `log(msg)` | 发 `log` 事件。 |
| `args` | 调用方传入的值原样注入（不是全局函数，是数据）。 |
| `budget` | `{ total, spent(), remaining() }`。计量是**估算**：每个 agent 回复按 chars/4 记 token。无预算时 `total=null`、`remaining()=Infinity`。预算是**硬上限**：每次 agent 派发前检查，超了即 fatal。 |
| `workflow(nameOrRef, args?)` | 内联跑另一个 workflow，**仅一层**（子内再调即抛错）。按名解析走受管目录，或 `{scriptPath}` 相对当前 run 的 source 目录。子 run 共享父的调度器、并发帽、agent 计数、控制与预算池；其 phase 加 `▸ <name> · ` 前缀自成泳道。 |
| `validate(source)`（odw 扩展） | 编译检查一段候选 workflow 源码而不执行：返回 `{ok, meta?, errors, warnings}`，warnings 即双兼容扫描结果。这是"workflow 生成 workflow"的接缝。 |

### 1.4 确定性规则（双兼容）

`Date.now()`、`Math.random()`、无参 `new Date()`：odw 能跑，**Claude Code 会因破坏 resume 日志而拒绝**。`scanDualCompat` 把它们报为 warning（扫描同样基于掩码，`${…}` 插值内的代码照查）。可移植脚本的写法：时间戳经 `args` 传入、随机性用索引变化替代。

### 1.5 结构化输出

异构 CLI 无法像原生 API 那样强制 tool call，可靠性由三段协作构成：schema 描述拼进提示词 → 从自由文本里提取 JSON（fenced → 平衡片段 → 整段）→ 按 JSON Schema 子集校验。失败重试，默认额外 `schemaRetries: 2` 次。校验通过前的中间产物不会返回给脚本。

---

## 2. 运行时语义

### 2.1 调度与保险丝

- 并发帽：同时至多 N 个 agent 子进程，默认 `min(16, cpus − 2)`（config `concurrency` 可覆盖）。槽位释放时直接交给下一个等待者，不存在超订窗口。
- 总量保险丝：每 run 至多 `maxAgents: 1000` 次派发，防失控循环；触发即 fatal。
- 检查顺序（2026-09-07 修正）：先取得并发槽位,再过 `checkpoint()`（见 2.2）、查预算、查保险丝,
  最后计入派发数并启动 agent。排队期间发生的停止、暂停或预算变化会在这里生效;检查失败也释放槽位。
- `agent_started` 事件在**拿到真实调度槽后**才发——排队中的工作不会被展示成"运行中"。

### 2.2 控制（pause / resume / stop）

控制的生效粒度是 **agent 派发边界**：调度器在每次派发前调用 `checkpoint()`——

- `paused` → checkpoint 阻塞等待，直到 resume 或 stop；已在执行的 agent 子进程**不被打断**；
- `stopped` → checkpoint 抛 `RunStopped`，整条 run 展开、落终态 `stopped`。

跨进程实现：CLI 写 run 目录的 `control.json`，worker 侧的 file-control 轮询同一契约。

### 2.3 错误语义

分两类，规则贯穿所有原语：**可恢复失败**（单个 agent 报错、schema 重试耗尽）→ 该槽位/该 item 变 `null`，run 继续；**fatal**（预算耗尽、保险丝、stop）→ 向上抛，终止 run。adapter 路由中的每个降级决定（如 model 旗标不支持）以 `log` 事件显式留痕，**没有静默丢弃的选项**。

### 2.4 适配器契约

adapter = 一条命令模板（数组），如 `["codex", "exec", "--cd", "{workspace}", "-"]`。已知占位符共 7 个——`{prompt}`、`{prompt_file}`、`{workspace}`、`{source}`、`{adapter}`、`{role}`、`{model}`——执行前替换；未知 `{…}` 原样保留。工作区默认就地：agent 直接在 source 目录工作（与 Claude Code 的 Workflow 工具同语义）。隔离按 agent 选入（`isolation: "worktree"`）：agent 获得一次性 git worktree（要求 source 是有提交的 git 仓库；agent 看到 HEAD，不含未提交改动），改动以 diff 返回、worktree 用后即删。单 agent 超时默认 1800 秒。运行时**只 shell 本地命令，从不直连模型 API**。

---

## 3. 观测契约：run 目录

```
<runsRoot>/<workflow-slug>/<runId>/     # runsRoot 默认 ~/.odw/runs
  meta.json      不可变：script、args、source、configPath、workflowName、origin…
  status.json    可变：状态机（running/paused/done/failed/stopped）+ 计数器
  events.jsonl   追加式进度流（见下）
  result.json    成功时的最终 return 值
  error.json     失败时的 message + stack
  control.json   CLI 写入的 pause/resume/stop 请求
  worker.log     worker 进程的 stdout/stderr
  worker.pid     可选：launcher 启动后写一次的正整数 PID（2026-09-07 新增）
```

- `runId` 全局唯一，是对外的唯一 handle（按 id 找 run 不依赖桶路径；兼容旧的扁平目录）。
- 所有 JSON 写入原子化（临时文件 + rename），并发读者不会读到半个文件。
- 终态集合 `{done, failed, stopped}`：进入后不再变化。
- 内联脚本发起的 run 把源码物化为 run 目录内的 `workflow.js`——**run 目录自包含**，事后可完整复现"当时跑的是什么"。
- `worker.pid` 用于 worker 尚未写 `status.pid` 时的存活检查,避免 launcher 与 worker 同时修改状态文件。
  `wait`、`logs --follow`、`attach` 共用检查:进程已退出则及时非零返回,观察者不改写历史状态。
  旧记录仍可读取;缺少 PID 时保留启动宽限,已知存活的进程不会因暂时没有输出而被判为失败。

事件共 **9 种**，形状 `{ts, type, ...fields}`（`ts` 为秒、浮点、墙钟——事件只供观察、永不回流控制，故不违反确定性）：

| 类别 | 事件 | 关键字段 |
|---|---|---|
| run 生命周期 | `run_started` / `run_finished` / `run_failed` / `run_stopped` | — |
| 阶段 | `phase_started` | `phase` |
| 消息 | `log` | `message`、可选 `label`/`phase` |
| agent 生命周期 | `agent_started` / `agent_finished` / `agent_failed` | `label`、`phase`、`adapter`；finished 带 `attempts`，failed 带 `error` |

---

## 4. 控制契约：CLI

`run`（发起，默认立即返回；`--wait` 阻塞并映射退出码）、`rerun`、`status`、`result`、`logs [--follow]`、`list`、`workflows`、`pause` / `resume` / `stop`、`serve`。`__worker` 为内部入口。

`serve`（HTTP + SSE + 看板）今天在 odw 里；按 elorae 拆分方向它的归属是开放问题——**本文档只记录现状，不预支决定**。

---

## 5. 验收清单（本期完成的定义）

- [ ] **新人测试**：一个没读过源码的人（或干净会话里的 agent），只凭本文档写出一个用到 `schema` + `parallel` 的 workflow，`odw run` 一次跑通。
- [ ] **逆向测试**：只凭本文档解读一个真实 run 目录的全部文件和事件流，零处需要翻代码。
- [ ] **一致性核对**：与 `skills/open-dynamic-workflows/SKILL.md`、README、`types/workflow.d.ts` 三处交叉检查无矛盾；发现矛盾以代码为准、修文档。
- [ ] 文档合入 main。

四项全勾，本期关闭。任何新想法不改变本期范围。

## 6. 非目标（候选池，仅登记）

`meta.json` 加 `formatVersion`；事件流的机器可读 schema；`index.ts` 导出面升级为受承诺的公共 API；跨 run 全局并发帽（文件租约方案）；elorae 接口选型落地；chat/serve 的迁移。——全部是后续 phase 的候选，各自立项各自验收。
