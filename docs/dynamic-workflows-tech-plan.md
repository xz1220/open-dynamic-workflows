# Dynamic Workflows 技术方案与任务拆分

> 文档日期：2026-05-30 ｜ 状态：方案草案（待评审） ｜ 关联：[`dynamic-workflows-research.md`](./dynamic-workflows-research.md)
> 目标：把 Claude Code 私有 runtime 内的 "dynamic workflow" 能力，做成一套**任意 coding agent、任意环境**可用的开源实现。本项目为**全新实现**，不沿用、不迁移、不兼容现有代码。

---

## 0. 已锁定的设计决策

| 维度 | 决策 | 说明 |
|---|---|---|
| 脚本语言 | **Python** | 工作流脚本是 import 本库的 Python 文件。`agent()` 本质是"起一个外部 CLI 子进程等结果"，属 I/O-bound，GIL 不构成约束（子进程 I/O 期间释放 GIL）。 |
| v1 原语覆盖 | **核心集 MVP** | 一期先实现最基本的原语 + 基本运行能力。`resume / budget / 嵌套 workflow / 裸 futures / worktree` 不在一期。 |
| 执行模型 | **后台运行时** | 脚本在独立进程后台运行，宿主 fire-and-poll；`--wait` 提供同步等待。 |
| 项目承载 | **全新实现** | 现有 skills / agents 代码直接删除，不考虑迁移与兼容，按核心目标重新设计。 |

---

## 1. 背景与目标

### 1.1 问题

`dynamic-workflows-research.md` 已把事实摸清：dynamic workflow 是"Claude 现写、后台 runtime 执行的一段编排脚本，在上下文之外大规模调度 subagent"。它的价值——把编排搬进代码、中间产物不污染上下文、可大规模 fan-out——非常通用，**但它目前只存在于 Claude Code 的私有 runtime 里**。Codex CLI、Gemini CLI、Qwen、Kimi 以及任何自建 agent 都拿不到这个能力。

### 1.2 目标

> 让**任意一个 coding agent**，在**任意环境**下，都拥有 dynamic workflow 能力。

拆成三个工程目标（与既定的三步对齐）：

1. **封装编程原语**：把"调用任意 coding agent CLI"以及"编排它们"抽象成一套可组合的编程原语。
2. **提供 `skills.md`**：让任意宿主 agent 照着它就能自由编写由这些原语组成的工作流脚本。
3. **自由组合工作流**：基于原语，用户/agent 自由组合出完整 workflow。

其中**原语层是整个项目的核心**——它定义了对外的编程契约，决定了工作流能表达什么。下面第 2 章专门讲它。

---

## 2. 编程原语（核心）

本章只讲逻辑：**有哪些原语**、以及**原语之间是什么关系、如何组合**。不涉及实现代码。

设计立场：**我们要把编排一组 coding agent 时常见的编程原语基本都实现**。原语分两类——"执行/编排"类是真正驱动工作的算子，"标注/数据/约束"类是围绕它们的辅助。工作流脚本本身用普通的 Python 控制流（循环、分支、归并）把这些原语串起来。

### 2.1 有哪些编程原语

| 原语 | 类别 | 作用与语义（逻辑） | 一期 |
|---|---|---|---|
| **agent** | 执行原子 | 调度一个 coding agent 跑一个子任务，是唯一真正"产生工作"的原语。输入：一段任务描述 + 选项（用哪个 agent/角色、归属哪个 phase、是否要结构化输出）。输出：该 agent 的最终结果（自由文本，或结构化对象）。语义：在隔离环境里独立运行、与其它 agent 互不串话、只回传结果。 | ✅ |
| **parallel** | 并发编排 | 把一组子任务**同时**发出去，**等全部完成**再统一返回（屏障 / barrier）。用于"必须拿到全部结果后再统一处理"的场景（全局去重、计票、汇总）。单个失败以空值占位，不拖垮整体。 | ✅ |
| **pipeline** | 并发编排 | 一组条目各自独立穿过多个阶段，条目之间**无屏障**（A 已在第 3 阶段时 B 还可在第 1 阶段，流式 / streaming）。用于"每个条目走完即可进入下一步、不空等其他条目"。**多阶段处理的默认形态**。 | ✅ |
| **phase** | 标注/观测 | 把后续的 agent 调用归入一个命名阶段，用于进度分组与展示。 | ✅ |
| **log** | 标注/观测 | 主动向用户/宿主发一行进度消息。 | ✅ |
| **meta** | 声明 | 脚本顶部声明工作流元信息（名字、描述、阶段列表），让运行时知道这是什么工作流。 | ✅ |
| **args** | 数据入口 | 工作流的输入参数（运行时注入），让同一脚本可参数化复用。 | ✅ |
| **schema** | 数据契约 | 给某个 agent 的输出指定一个结构（类型契约）：要求其产出符合该结构的数据，不符合则重试。是节点间"结构化交接"的依据，也是把多个 agent 串成**可靠**流水线的关键。 | ✅ |
| **并发上限** | 规模约束 | 同时在跑的 agent 数设上限，超出的排队。防止打爆机器/配额。属运行时强制，作者无需显式调用。 | ✅ |
| **agent 总量兜底** | 规模约束 | 单次运行累计 agent 数设硬上限，防失控循环无限扇出。 | ✅ |
| **budget** | 扩展 | 把 token/成本预算暴露给脚本，据此动态扩缩或做循环守卫。 | ✗（二期） |
| **workflow（嵌套）** | 扩展 | 把另一个工作流当作一个步骤内联调用（只允许一层嵌套）。 | ✗（二期） |
| **裸 futures** | 扩展 | 非阻塞发出 agent、随后按需查询/汇聚，作为 parallel/pipeline 之外的逃生口（有确定性代价，见 2.2）。 | ✗（二期） |

> `resume / 可重放`不是原语，而是运行时能力，且不在一期范围——见第 5 章。

### 2.2 原语之间的关系与如何组合

**(1) 层次关系：谁是谁的基础**

- `agent` 是**执行原子**——唯一真正干活的单元，其它原语都是围绕它的。
- `parallel` / `pipeline` 是**高阶编排算子**——它们的每个"节点"就是一个 `agent`（或一段含 agent 的逻辑），把多个 agent 组织成并发/多阶段结构。
- `schema` 是**流经节点之间的数据类型**——它约束 `agent` 的输出形状，使下游节点能稳定消费上游产物。
- `meta` / `phase` / `log` 是**横切标注**——不改变计算，只声明工作流身份、分组进度、发送消息。
- `args` 是**入口**，规模约束（并发上限 / 总量兜底）是**包裹一切的边界**。

概念关系（非代码，仅示意）：

```
                 args（输入）
                   │
        ┌──────────▼─────────────────────────┐
        │  工作流脚本：普通 Python 控制流          │
        │  循环 / 分支 / 归并去重 / 计票           │
        │  meta · phase · log （横切标注）        │
        └──────────┬─────────────────────────┘
                   │ 用编排算子组织
            ┌──────▼──────┐      ┌──────────┐
            │  parallel   │      │ pipeline │   高阶编排算子
            │ （屏障/全量）  │      │（流式/多阶段）│
            └──────┬──────┘      └────┬─────┘
                   │  每个节点是一次     │
            ┌──────▼────────────────────▼──────┐
            │            agent                 │   执行原子
            │   └─ schema 约束其输出结构 ─┘        │
            └──────────────────────────────────┘
        ┌──────────────────────────────────────┐
        │   并发上限 / agent 总量兜底（运行时边界）   │
        └──────────────────────────────────────┘
```

**(2) 编排算子的核心区别：屏障 vs 流式**

- `parallel` = **屏障**：必须等齐全部结果。只在"下一步真的需要全量结果一次性到位"时用（去重、计票、汇总）。
- `pipeline` = **流式**：每个条目独立推进、无需互等。多阶段处理默认用它，省掉空等的墙钟时间。
- 两者之外的"纯逻辑归并"（去重、过滤、计票、综合判断）发生在**原语之外的普通脚本代码**里——原语只负责"派发与等待"，决策留给脚本。

**(3) schema 是把多 agent 串成可靠流水线的黏合剂**

没有 `schema`，多阶段流水线传的是自由文本，下游无法稳定解析，组合就退化成"碰运气"。有了 `schema`，每个节点的输出有明确结构，`pipeline` 的后一阶段才能可靠地基于前一阶段结果工作。所以 `schema` 虽是"数据原语"，却是**编排能力可靠落地的前提**，列入一期。

**(4) 原语 + 普通控制流 = 常见工作流形态**

下面这些"形态"不是新原语，而是**原语与普通脚本逻辑的组合**（只讲逻辑）：

- **fan-out → reduce → synthesize**：`parallel` 扇出多个 agent → 普通脚本归并去重 → 再用一个 `agent` 综合定稿。最基本形态。
- **对抗式校验（adversarial verify）**：`pipeline` 第一阶段 `agent` 产出"发现"，第二阶段对每个发现并发派多个"证伪者"`agent`，多数证伪则丢弃。以独立视角互相证伪，过滤不可靠结论。
- **judge 面板**：对同一产物用多个不同视角的 `agent` 打分，脚本综合。
- **loop-until-dry**：脚本层 `while` 循环 + 每轮 `parallel` 扇出 + 普通逻辑去重，连续 K 轮无新发现才停。用于规模未知的发现型任务。

**(5) 组合的确定性约束（决定了一期为何首选 parallel/pipeline）**

- `parallel`/`pipeline` 的**执行**虽乱序，但**派发哪些 agent 由输入决定、不由时序决定**——只要归并是"顺序无关"的（累加进集合、去重），最终结果就确定。
- 反例：按"谁先完成"来决定走哪条分支、派发哪些后续 agent，会让控制流随时序漂移，结果不可重现。
- 所以组合规则是：**乱序 OK（最终结果顺序无关即可），按时序分支不 OK**。这正是一期只提供 `parallel`/`pipeline`、把"裸 futures（可按完成时序自由分支）"推到二期的原因。

---

## 3. 详细设计

本章只到**模块级**：先讲整体分层与项目/代码结构、模块之间的对应关系（总），再讲各模块需要完成的能力（分）。不写具体函数实现；各模块能力先粗后细，后续迭代再细化。

### 3.1（总）分层结构

要让第 2 章的原语真正跑起来，需要自下而上的几层。每层只依赖下层，工作流脚本只接触最上面的原语接口。

| 层 | 职责（这一层要解决的问题） |
|---|---|
| **L1 适配层** | 把任意 coding agent 的 CLI 抽象成**统一调用接口**：命令模板 + 占位符 + stdin + 工作目录。屏蔽 codex / claude / gemini / qwen / kimi 等命令形态的差异。 |
| **L2 执行桥接层** | 把"调用一次某个 agent"封装成原语可用的单元：选用哪个适配器/角色、组装独立运行的任务描述、运行、收集结果、（可选）按 `schema` 校验。是 `agent` 原语与底层 CLI 之间的桥。 |
| **L3 调度层** | 线程池 + 并发上限 + agent 总量兜底，为 `parallel`/`pipeline` 提供受控并发。 |
| **L4 原语层** | 实现第 2 章的原语（`agent`/`parallel`/`pipeline`/`phase`/`log`/`meta`/`args`）与 `schema` 的接入。这是对外编程契约所在。 |
| **L5 运行时层** | 后台进程执行工作流脚本、把原语注入脚本作用域、维护一次运行的状态/进度/控制、产出最终结果。 |
| **L6 接口层** | 对外 CLI（run/status/logs/…）+ `skills.md`（教宿主 agent 写脚本）+ 示例与原语参考。 |
| **工作区隔离**（横切） | 每次 `agent` 调用在隔离副本中运行、回收 diff，默认不污染主工作区。被 L2 使用。 |

### 3.2（总）项目结构与模块关系

采用**标准 Python 包结构**（而非把代码寄居在一个 skill 目录下）：库是仓库的根身份，可被任意 workflow 脚本 `import`、并通过 `pipx`/`uvx`/`pip` 安装出全局 CLI——这才是"任意环境都能跑"的分发通道；skill 退化为骑在库之上的薄封装（教学层），依赖已安装的 CLI。结构层面（非函数实现）：

```
<repo>/
├── pyproject.toml         # 包定义 + console CLI 入口 + 依赖
├── README.md
├── src/<pkg>/             # 库本体：workflow 脚本 import 它，CLI 也用它
│   ├── adapters/          # L1 适配层：配置解析 + 命令模板/占位符展开 + CLI 调用 + 内置适配器
│   ├── bridge.py          # L2 执行桥接：一次 agent 调用 → 选适配器/角色 → 运行 → (schema 校验) → 结果
│   ├── scheduler.py       # L3 调度层：线程池 + 并发上限 + agent 总量兜底
│   ├── primitives.py      # L4 原语层：agent / parallel / pipeline / phase / log / meta / args
│   ├── schema.py          # L4 数据契约：结构化输出的注入 / 提取 / 校验 / 重试
│   ├── runtime/           # L5 运行时（"后端"）：后台 worker + run 目录 + 状态/进度/控制
│   ├── workspace.py       # 横切：工作区隔离与 diff 采集
│   └── cli.py             # L6 接口（"前端"）：run / status / list / logs / pause / stop / result
├── skill/                 # 薄封装：教宿主 agent 用，指向已安装的 CLI
│   ├── SKILL.md           # = skills.md
│   └── references/        # 原语完整参考 + 适配器说明
├── examples/              # 示例工作流脚本（fan-out→reduce、对抗式校验、loop-until-dry…）
├── tests/                 # 以 mock 适配器驱动，不依赖真实账号
└── docs/
```

> **前后端分界**：`runtime/`（后端）是持有状态、在后台进程里执行工作流的服务侧；`cli.py`（前端）是发起 run 与查询状态的客户端。两者经 run 目录（状态/进度/结果）解耦。

模块调用关系（示意）：

```
cli ──> runtime(worker) ──注入原语──> 工作流脚本（用户/agent 编写）
                                         │ 调用
                                    primitives ──用──> scheduler（并发/上限）
                                         │ agent() 经
                                       bridge ──用──> adapters ──> 真实 CLI 子进程
                                         │             workspace（隔离运行 + diff）
                                       schema（校验 agent 输出）
```

一句话串起来：**宿主用 `cli` 发起一次 run → `runtime` 在后台进程里加载脚本并把原语注入其作用域 → 脚本调用 `primitives` → `parallel/pipeline` 经 `scheduler` 受控并发 → 每个 `agent` 经 `bridge` 选适配器、在 `workspace` 隔离里调真实 CLI、必要时由 `schema` 校验 → 结果回到脚本 → 最终值写回 run，供宿主查询。**

### 3.3（分）各模块需要完成的能力

先写到"能力清单"粒度，后续逐步细化。

- **adapters（L1 适配层）**
  - 解析适配器配置；支持命令模板 + 占位符（任务描述 / 工作区 / 角色等）+ stdin 传入。
  - 调用外部 CLI 并捕获 stdout / stderr / 退出码 / 超时。
  - 内置若干常见 coding agent 的开箱适配；允许用户自定义新增。

- **bridge.py（L2 执行桥接层）**
  - 给定（任务描述, 选项）选定适配器/角色，组装"独立运行、互不串话"的任务描述。
  - 在隔离工作区运行一次，返回自由文本；若带 `schema` 则交由 schema 模块校验后返回结构化对象。

- **scheduler.py（L3 调度层）**
  - 维护线程池；强制并发上限与单次运行 agent 总量兜底。
  - 为 `parallel`（屏障）与 `pipeline`（流式）提供并发执行与结果回收；单点失败以空值占位、不拖垮整体。

- **primitives.py（L4 原语层）**
  - 实现 `agent / parallel / pipeline / phase / log / meta / args` 的语义（见第 2 章）。
  - `agent` 经 bridge 执行；`parallel/pipeline` 经 scheduler 并发；`phase/log` 产出进度；`meta/args` 对接运行时。

- **schema.py（L4 数据契约）**
  - 把结构要求注入任务描述；从 agent 输出里提取候选结果并校验；不合格按策略重试，重试与失败可观测。

- **runtime/（L5 运行时层）**
  - `run` 后台拉起 worker 进程；worker 加载脚本、把原语注入其作用域、执行到产出最终值。
  - 维护一次运行的 run 目录：状态、进度事件、最终结果。
  - 控制面**异步优先**：`run` 立即返回运行标识，宿主用 `status`/`logs`/`result` 轮询（fire-and-poll）；`--wait` 作为同步等待的封装。
  - 支持 `pause`/`stop`（在安全点——派发新 agent 前——生效）。

- **workspace.py（横切：工作区隔离）**
  - 每次 agent 调用基于源工作区建隔离副本（或直接在当前目录模式），运行后采集 diff，默认不写回主工作区。

- **cli.py / SKILL.md / references / examples（L6 接口层）**
  - CLI 暴露 `run / status / list / logs / pause / stop / result`。
  - `skills.md` + 原语参考 + 可运行示例，让宿主 agent 仅凭文档即可自助编写并运行新工作流。

---

## 4. MVP 范围与分期

一期只做"最基本的原语 + 能在后台跑起来"，把不确定、重投入的能力（尤其 resume）推后。

| 范畴 | 一期-A（最小可用） | 一期-B（可靠组合） | 二期（fast-follow） |
|---|---|---|---|
| 原语 | agent / parallel / pipeline / phase / log / meta / args | + schema（注入+校验+重试） | budget、嵌套 workflow、裸 futures |
| 调度 | 并发上限 + agent 总量兜底 | — | — |
| 运行时 | 后台 worker、run 目录、status/logs、pause/stop、`run`(fire-and-poll)+`--wait` | — | **resume**（先崩溃恢复再编辑级）、worktree 隔离 |
| 接口 | CLI + 内置适配器 + 1~2 个示例 | skills.md + 原语参考 + 全套示例 | 更多适配器 / MCP 包装、TUI/Web 观测 |

**明确不在一期**：`resume` / journaling（崩溃与编辑级都不做——一期崩溃就重跑）、`budget`、嵌套 `workflow`、裸 futures、worktree。理由：一期先验证"原语能不能把多 agent 编排成有用的工作流"这一核心命题，可重放等属于成熟度而非可行性。

---

## 5. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 异构 CLI 不稳定吐结构化结果 | `schema` 命中率低 | 注入结构要求 + 提取 + 校验 + 重试；失败可观测；二期可走适配器原生 JSON 模式 |
| 一期无 resume，长跑中断需重跑 | 浪费已完成的 agent 工作 | 一期接受重跑；二期补崩溃恢复（journaling）。先用并发上限/总量兜底/`stop` 控成本 |
| token/时长成本失控 | 费用/限流 | 并发上限 + agent 总量兜底 + `pause`/`stop`；二期 `budget` 做硬上限 |
| 后台进程生命周期（孤儿/退出后续跑） | 运维困难 | run 目录 + 状态心跳；明确"宿主退出后 run 不跨进程续跑" |
| 按时序分支破坏可组合性 | 结果不可重现 | 一期只提供 `parallel`/`pipeline`；裸 futures 推到二期并在 skills.md 标注代价 |

---

## 6. 任务拆分（Task 拆分）

全新实现，无迁移负担。按里程碑组织，标注**依赖**与**验收**。每个 M 可独立合并、测试绿。

### M0 — 项目骨架
> 依赖：无。
- 建标准包：`src/<pkg>/` 布局、`pyproject.toml`（依赖 + console CLI 入口）、空模块（adapters / bridge / scheduler / primitives / schema / runtime / workspace / cli）、`skill/` 薄层占位、测试脚手架与 mock 适配器约定。
- **验收**：`pipx`/`uvx` 可装出全局 CLI 且 `--help` 可用；`pytest` 空跑通过；目录结构落地。

### M1 — 适配层 + 执行桥接 + 工作区隔离
> 依赖：M0。
- adapters：配置解析、占位符/命令模板、CLI 调用与捕获、内置适配器。
- workspace：隔离副本运行 + diff 采集。
- bridge：一次 agent 调用（选适配器 → 组装任务描述 → 隔离运行 → 收结果）。
- **验收**：用 mock 适配器，能在隔离工作区跑一次"agent 调用"并取回 stdout 与 diff。

### M2 — 核心原语 + 调度层（一期-A 主体）
> 依赖：M1。
- scheduler：线程池 + 并发上限 + agent 总量兜底。
- primitives：`agent`/`parallel`/`pipeline`/`phase`/`log`/`meta`/`args`。
- **验收**：mock 适配器单测覆盖 parallel 屏障语义、pipeline 流式与错误传播、并发上限、总量兜底。

### M3 — schema 结构化输出（一期-B）
> 依赖：M2。
- schema：注入结构要求 → 提取 → 校验 → 重试；接入 `agent`。
- **验收**：mock 模拟"先吐脏结果再吐合法结果"，断言重试后命中；耗尽后按策略行为正确。

### M4 — 后台运行时 + CLI
> 依赖：M2（可与 M3 并行）。
- runtime：后台 worker、run 目录、状态/进度、`pause`/`stop`。
- cli：`run`（fire-and-poll）/`--wait`/`status`/`list`/`logs`/`pause`/`stop`/`result`。
- **验收**：一个长跑 mock 工作流可后台启动、`status`/`logs` 可观测、`pause`/`stop` 生效、`result` 取到最终值。

### M5 — skills.md + 原语参考 + 示例工作流
> 依赖：M3、M4。
- 重写 `SKILL.md`（=skills.md）；`references/primitives.md` 原语完整参考；`examples/`（fan-out→reduce、对抗式校验、loop-until-dry）。
- **验收**：示例全部能 `run` 跑通（mock 适配器）；文档自检无指向不存在的命令/原语。

### M6 — 测试、文档、发布
> 依赖：M5。
- 补齐原语/运行时/schema 测试矩阵（mock，不依赖真实账号）；README / 打包 / 版本。
- **验收**：CI/pytest 全绿；文档与示例自洽。

**关键路径**：`M0 → M1 → M2 → {M3, M4} → M5 → M6`（M3 与 M4 在 M2 后可并行）。

---

## 7. 验收总纲

1. **能力达成**：任一配置好的 coding-agent CLI，可被一段 Python 工作流脚本编排成 fan-out→reduce→synthesize / 对抗式校验 / loop-until-dry，且能后台运行、可观测、可停止。
2. **可移植**：原语层不绑定任何特定宿主；换一组适配器即可换底层 agent。
3. **可被 agent 自助使用**：宿主 agent 仅凭 `skills.md` 即可写出并运行新工作流。

---

## 附录 A — 与 research 文档的术语映射

| research 术语 | 本方案落点 |
|---|---|
| who holds the plan | 脚本变量（后台 worker 进程内），上下文只回传最终值 |
| fan out → reduce → synthesize | `parallel/pipeline` 扇出 → 纯 Python 归并 → 收尾 `agent` 综合 |
| barrier vs streaming | `parallel`（屏障）/ `pipeline`（流式，默认） |
| adversarial verify / judge panel | 原语 + 普通控制流的组合形态（见 §2.2） |
| loop-until-dry | 脚本 `while` + `parallel` + 去重（见 §2.2） |
| structured handoff | `schema`（注入 + 校验 + 重试） |
| determinism 限制 | 乱序 OK、按时序分支不 OK（见 §2.2(5)） |
| resume / journaling | 运行时能力，**不在一期**（见 §4、§5） |
