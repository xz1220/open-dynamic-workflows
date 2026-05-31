# Claude Code Dynamic Workflows 资料

> 资料日期：2026-05-30 ｜ 状态：Claude Code "dynamic workflows" 处于 research preview
> 范围：只收录 Claude Code dynamic workflow 机制本身、它的编程原语、激活与运维，以及 Claude Code 现有的多 agent 编排能力（subagent / agent teams）等事实性资料。

---

## 0. 可信度约定

- **高可信**：核心机制、"谁持有 plan"这条分界、规模上限、resume 语义、激活方式——多个独立来源交叉证实。
- **一手**：第 3.2 节的编程原语（`agent` / `parallel` / `pipeline` / `phase` / `budget` / `schema` / worktree / determinism 限制 / 并发与总量上限）**基于本环境实际暴露的 Claude Code Workflow 工具定义**，不是社区博客转述。
- **需谨慎（已在文中标注 ⚠️）**：确切发布日期、确切版本号、个别营销案例数字——来自单一来源，文中明确 hedge。

---

## 1. 是什么：一句话机制 + 核心分界

**一句话**：dynamic workflow 是"Claude 为你的任务现写、由后台 runtime 执行的一段 JavaScript 编排脚本，它在对话上下文之外大规模调度 subagent"。

**核心分界——谁持有 plan（who holds the plan）**：

| | 计划（loop/branch）放在哪 | 中间结果放在哪 | Claude 上下文里留下什么 |
|---|---|---|---|
| **subagent / skill** | Claude 自己逐轮决策 | 落进 Claude 的上下文窗口 | 全过程 |
| **dynamic workflow** | **脚本变量里** | **脚本变量里** | **只有最终答案** |
| **agent teams** | 多个对等 Claude session 自协调 | 共享任务表 + mailbox | 各自独立上下文 |

把编排"搬进代码"，中间产物不再污染 Claude 的上下文，上下文只承载最终结论——这同时回应了"长时运行会 context rot"和"大规模 fan-out 装不进一个上下文"两个约束。

---

## 2. Claude Code 怎么编排：一条按规模递增的阶梯

dynamic workflow 是 Claude Code 编排能力阶梯的最高一档：

1. **单轮内并行 tool calls**：只读工具（Read/Glob/Grep）并行；有状态工具（Edit/Write/Bash）串行。
2. **后台 bash 命令**：一条非阻塞 shell 命令，**不**生成 agent。
3. **subagent**：经 Agent 工具（v2.1.63 把 `Task` 改名为 `Agent`，旧名仍兼容）扇出的委派 worker，跑在隔离的全新上下文里，只回传摘要；用 `.claude/agents/` 里的 Markdown+YAML 或 SDK 的 `AgentDefinition` 定义。**硬限制：subagent 不能再生 subagent**（防无限嵌套）。
4. **agent teams**（实验性，`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`）：多个**完整** Claude session，有共享任务表 + `SendMessage` mailbox，**彼此直接通信**（subagent 只会向上汇报、互不通信）。
5. **dynamic workflows**（research preview）：脚本持有 plan，在上下文之外调度几十到上百个 subagent。

**决策轴**：**谁持有 plan**——Claude 逐轮（subagent/skill）｜脚本（workflow）｜自协调的对等体（teams）。

---

## 3. Dynamic Workflows 详解

### 3.1 机制与官方定位（高可信）

- **是什么**："A dynamic workflow is a JavaScript script that orchestrates subagents at scale. Claude writes the script for the task you describe, and a runtime executes it in the background while your session stays responsive."
- **它解决的问题**（Anthropic 原话举例）：单个 agent 一遍过搞不定的活——全库 bug 扫描、~500 文件级别的迁移、需要交叉核对来源的研究问题、值得从多个独立角度起草再定稿的硬计划。
- **可重复的"质量模式"**：让独立 agent **对抗式地互相 review** 彼此的发现后再上报，比单遍过更可信。内置的 `/deep-research` 就是这个形态：扇出搜索 → 交叉核对来源 → **对每条 claim 投票** → 过滤掉没扛住交叉检验的 claim → 出带引用的报告。
- **⚠️ 需谨慎的具体包装**：确切发布日期（单源记为 2026-05-28，随 Claude Opus 4.8）、确切版本号（社区/文档记为 Claude Code v2.1.154+、TS Agent SDK v0.3.149+）、旗舰案例（"Bun 作者用它把 Bun 从 Zig 移植到 Rust，~75 万行、测试 99.8% 绿、11 天"——单源营销数字）。机制可信，这些数字请当背景而非事实引用。

### 3.2 编程原语（基于本环境实际暴露的 Workflow 工具，一手）

> 下面这些不是社区转述：它们就是本环境 Claude Code Workflow 工具的真实接口。社区把这部分标为 medium confidence，是因为他们只能看官方文档页+博客；这里是直接对着工具签名写的。

**脚本骨架**：每个脚本以一个**纯字面量** `meta` 导出开头，然后是脚本体。

```javascript
export const meta = {
  name: 'review-changes',
  description: 'Review changed files across dimensions, verify each finding',
  // 可选: whenToUse, model
  phases: [{ title: 'Review' }, { title: 'Verify' }],   // 每个 phase() 一条
}
// 脚本体：async 上下文，直接 await
phase('Review')
const found = await agent('审查 bugs ...', { schema: FINDINGS_SCHEMA })
```

**核心 hooks：**

| 原语 | 语义 |
|---|---|
| `agent(prompt, opts?)` | 跑一个 subagent。无 `schema` 返回其最终文本（string）；有 `schema`（JSON Schema）则**强制它调 StructuredOutput 工具**，返回校验过的对象，**不匹配就重试**。`opts`：`label`、`phase`、`schema`、`model`、`agentType`、`isolation:'worktree'`。用户中途跳过则返回 `null`（用 `.filter(Boolean)`）。 |
| `parallel(thunks)` | **屏障（barrier）**：等所有 thunk 完成再返回。抛错的 thunk 解析为 `null`（调用本身不 reject）。 |
| `pipeline(items, s1, s2, …)` | **无屏障流水线**：每个 item 独立穿过所有 stage，A 可在 stage3 时 B 还在 stage1。stage 回调收 `(prevResult, originalItem, index)`。某 stage 抛错则该 item 掉为 `null` 并跳过其余 stage。**多阶段默认用它。** |
| `phase(title)` / `log(msg)` | 进度分组 / 给用户发进度行。 |
| `args` | Workflow 调用时传入的输入（JSON 原样）。 |
| `budget` | `{ total, spent(), remaining() }`——把用户设的 token 目标暴露给脚本，可据此动态扩缩或做循环守卫。 |
| `workflow(name\|{scriptPath}, args?)` | 内联调用另一个 workflow（**只允许一层嵌套**）。 |

**硬约束：**

- **并发上限** `min(16, CPU核数 - 2)`；**单次运行 agent 总量上限 1000**（runaway 兜底）。
- **确定性强制**：脚本里 `Date.now()` / `Math.random()` / 无参 `new Date()` 会**抛错**——因为 journaling/resume 需要可确定性重放。要时间戳就经 `args` 传入；要随机就按 index 变化。
- 脚本**无文件系统 / 无 Node API 访问**；只有 agent 能读写/跑命令，脚本只负责协调。
- 纯 JavaScript（不是 TS）。
- **resume**：每次 `agent()` 结果都被 journaled；用 `resumeFromRunId` 重跑时，未改动的最长前缀**直接命中缓存**，第一个改动/新增的调用起才真正重跑。同一 session 内有效。

**典型形态（fan out → reduce → synthesize）**，以及"流水线默认、必要时才上屏障"的判断：

```javascript
// 默认：pipeline——某维度审完即刻进入校验，不空等其他维度
const results = await pipeline(
  DIMENSIONS,
  d => agent(d.prompt, { phase: 'Review', schema: FINDINGS_SCHEMA }),
  review => parallel(review.findings.map(f => () =>
    agent(`对抗式校验：${f.title}`, { phase: 'Verify', schema: VERDICT_SCHEMA })
      .then(v => ({ ...f, verdict: v }))))
)
const confirmed = results.flat().filter(Boolean).filter(f => f.verdict?.isReal)

// 仅当 stage N 真的需要 stage N-1 的全量结果时才用屏障（如全局去重后再校验）
const all = await parallel(DIMENSIONS.map(d => () => agent(d.prompt, { schema: FINDINGS_SCHEMA })))
const deduped = dedupe(all.filter(Boolean).flatMap(r => r.findings))   // 真正需要"一次性拿全部"
```

**按预算扩缩 / loop-until-dry：**

```javascript
const seen = new Set(); let dry = 0
while (dry < 2) {                                  // 连续 2 轮无新发现才停
  const fresh = (await parallel(FINDERS.map(f => () => agent(f.prompt, { schema: BUGS }))))
    .filter(Boolean).flatMap(r => r.bugs).filter(b => !seen.has(key(b)))
  if (!fresh.length) { dry++; continue }
  dry = 0; fresh.forEach(b => seen.add(key(b)))
  // ……对 fresh 做多视角 judge 面板……
}
```

### 3.3 激活方式与运维（高可信）

- **激活**：在 prompt 里出现关键字 **`workflow`**；或 `/effort ultracode`（xhigh 推理 + 对每个实质任务自动编排 workflow）；或内置的 `/deep-research`；用 `/workflows` 管理运行（暂停/恢复/停止/把脚本存成 `/command`）。
- **成本**：可能比普通 session **消耗多得多的 token**（每个 agent 自带上下文开销）；计入用量/限流。省钱手段：脚本可把某些 stage 路由到更小的模型（`agent(..., { model })`），其余用 session 模型。
- **权限**：workflow 扇出的 subagent **一律以 acceptEdits 运行并继承 session 的工具白名单**，无论 session 本身处于何种权限模式；不在白名单里的 shell/web/MCP 工具仍可能中途弹确认——长跑前先加白名单。

### 3.4 注意事项（事实层面）

- **research preview**：API surface 与运维细节（版本号、各计划默认、并发数、Bedrock/Vertex/Foundry 可用性）会漂移，落地前现查。
- **token 经济学**：Anthropic 报多 agent 编排 ~15x 普通 chat token（单 agent ~4x），token 用量能解释约 80% 的效果方差；其公开指引是只对高价值、可并行、信息超单上下文、需对接大量复杂工具的任务才划算。
- **同 session resume 的边界**：退出 Claude Code 后 workflow 从头跑（不跨进程续跑）。
- **⚠️ 待核实项**：发布日期、版本号、Bun 移植案例数字——单源，按背景而非硬事实处理。

---

## 4. 附录

### 4.1 术语速查

- **dynamic workflow**：Claude 现写、runtime 后台执行的 JS 编排脚本，大规模调度 subagent。
- **who holds the plan**：计划落在 Claude 上下文（subagent）/ 脚本变量（workflow）/ 对等体（teams）——理解三者差异的钥匙。
- **subagent / agent teams**：Claude Code 的两类多 agent 形态（隔离上下文的委派 worker ／ 互相通信的对等 session）。
- **fan out → reduce → synthesize**：扇出 → （纯 JS）归并去重 → 收尾 agent 综合，最常见的 workflow 形态。
- **barrier vs streaming**：`parallel()` 等齐全部（屏障）；`pipeline()` 各 item 独立穿过（流式，默认）。
- **loop-until-dry**：连续 K 轮无新发现才停，用于规模未知的发现型任务。
- **adversarial verify / judge panel**：让独立 agent 互相证伪 / 多视角评审，过滤不可靠结论（`/deep-research` 即此形态）。
- **structured handoff**：用 schema 给节点输出定类型（`agent(..., { schema })`，StructuredOutput 强制 + 重试）。
- **ultracode**：`/effort ultracode` = xhigh 推理 + 自动 workflow 编排。

### 4.2 参考来源

> 核心机制类为高可信；带 ⚠️ 的具体数字/日期为单源，按背景对待。

- 官方：`code.claude.com/docs/en/workflows`、`/sub-agents`、`/agent-teams`、`/headless`、changelog；`claude.com/blog/introducing-dynamic-workflows-in-claude-code`（⚠️ 日期/版本/Bun 案例为单源）。
- Anthropic：`anthropic.com/research/building-effective-agents`（workflows vs agents、五种 workflow pattern）、`anthropic.com/engineering/multi-agent-research-system`（orchestrator-worker、~15x token、80% 方差）。
- 本环境一手：Claude Code **Workflow 工具定义**（§3.2 原语的一手依据）。
