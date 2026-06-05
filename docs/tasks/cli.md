# ① CLI 核心层 — 任务拆解

> 对应 [ROADMAP](../ROADMAP.md) 的 ①：`(a) 运行层 Runtime` + `(b) 运行记录 Runs`。
> 每个任务带:目标 / 做法 / 文件锚点 / 完成标准(DoD)。可直接分配给 agent 开工。
>
> **实现状态(2026-06-05)**:T1–T7 与 R1–R7 全部完成,测试全绿。
> 运行层引入可替换的 `OptionRouter`(默认 `LiteralRouter`,src/router.ts);运行记录改为
> `runs/<workflow-slug>/<runId>/` 分桶并兼容旧扁平 run;dual-compat 审计见 src/dual-compat.ts;
> cron 配方见 [docs/recipes/cron.md](../recipes/cron.md)。

---

## (a) 运行层 Runtime

### 背景与架构裁决

经过一轮跨 CLI 验证(实跑 claude/codex/gemini/qwen/kimi 的 `--help` + 对抗复验,见 §参考)得出:

> **shell-out 是对的架构。方言原语支持不全,不是架构做不到,而是 adapter 契约太窄没接住。** 边界精确到两行:`placeholders.ts:11` 把 token 冻死成 6 个、`bridge.ts:37` 的 `AgentRequest` 只透传 `{prompt, adapter, schema, label}`。所以 `model`/`agentType`/`isolation` 在 `AgentOptions` 里被接受,却到不了任何旗标——`model`/`isolation` 是沉默 no-op,`agentType` 被错当成 adapter 名(primitives.ts:66)。

**本期目标(范围已定)**:把每个方言 option 从"沉默吞掉"变成 **语法透传 + 藏在一个可替换接口后**。**本期不做跨 CLI 一致性**(模型档位抽象、人格 registry、真计量等全部延后,见 §本期不做)。

---

### 核心设计:Router seam + adapter 自声明旗标

把 `agent opts → CLI 调用` 的映射(现在写死在 bridge.ts:135-142 的 inline 拼 context)抽成一个**可注入的 Router**,默认实现做"字面透传",以后可整体替换:

```ts
// 一次调用的"调用计划":argv 增量 + workspace 模式 + 占位符上下文
interface InvocationPlan {
  context: PlaceholderContext;   // 模板展开用 token(本期多一个 model)
  extraArgs: string[];           // 由 adapter 声明的旗标有条件拼出的 argv
  workspaceMode: WorkspaceMode;  // copy | inplace |(以后)worktree
}

interface OptionRouter {
  plan(opts: AgentOptions, adapter: Adapter, settings: Settings): InvocationPlan;
}
```

- **adapter 自己声明能力载体**(没声明 = 不支持该 option),这样新增一个 CLI 的 model 支持 = 填一行声明,不写代码:
  ```ts
  interface Adapter {
    // ...现有字段
    flags?: { model?: string[] /* 以后可加 systemPrompt 等 */ }; // 如 codex: { model: ["-m"] }
  }
  ```
- **默认 `LiteralRouter`**(= "现在的做法",只是补全 + 不丢):opt 有值 **且** adapter 声明了载体 → **有条件地**拼进 argv(有值才拼,天然避开 `--model ""` 崩溃);opt 有值 **但**没载体 → 发 `LOG` 警告(见 T5);`isolation` → 选 workspace 模式。
- **插法**:Router 跟现在的 `runner` 一样**构造时注入** bridge(bridge.ts:67-73 已是这个套路),`invoke()` 里 inline 拼 context 的那段换成 `this.router.plan(...)`。
- **可替换性**:以后做档位抽象 / 人格 registry / 真 worktree,只换一个 `TieredRouter` / `PersonaRouter` / 新 workspace mode,**primitives 与工作流脚本永不变**。

---

### 任务清单

- [x] **T1 — `AgentRequest` 透传三个 option,primitives 不再丢**
  - 做法:`AgentRequest`(bridge.ts:37-42)加 `model? / agentType? / isolation?`;`agent()`(primitives.ts:64-70)把 `opts.model/opts.agentType/opts.isolation` 塞进 request;**删掉** primitives.ts:66 的 `opts.adapter ?? opts.agentType` 错接(adapter 选择只认 `opts.adapter`)。
  - DoD:`agent("x", {model:"m", agentType:"p", isolation:"worktree"})` 后,三者都到达 bridge(单测断言 request 字段);`agentType` 不再影响 adapter 解析。
  - 依赖:无(其他任务的地基)。

- [x] **T2 — `{model}` placeholder + adapter 旗标声明 + 默认 Router**
  - 做法:`PLACEHOLDERS`(placeholders.ts:11)加 `model`,保持未知 token 原样透传不变;`Adapter` 加 `flags`(types.ts:10);实现 `OptionRouter` + `LiteralRouter`,在 bridge.invoke() 用它替换 inline context 构建(bridge.ts:135-148),并把 `extraArgs` 拼到 `expandAll(adapter.command,...)` 之后。
  - DoD:adapter 声明 `flags.model=["--model"]` 时,`agent(..,{model:"m"})` 实际命令含 `--model m`;不传 model 时命令**不含** `--model`(无空值);built-in 模板保持保守(不硬塞旗标,只声明)。
  - 依赖:T1。

- [x] **T3 — `agentType` → 人格 prompt 注入(通用层)**
  - 做法:本期只做**全平台通用的 prompt 注入层**——`composePrompt`(bridge.ts:113-117)把 persona 文本拼进 prompt(用 `request.agentType` 或经 `{role}` 通道)。**不碰**各 CLI 原生 system-prompt 旗标(那是延后的 Tier-2)。
  - DoD:`agent("task", {agentType:"code-reviewer"})` 的最终 prompt 含该 persona 的指令文本(单测);任何 CLI 上都生效(因为只动 prompt)。
  - 依赖:T1。

- [x] **T4 — `isolation:'worktree'` → copy 隔离 + LOG**
  - 做法:Router 把 `isolation:'worktree'` 映射到现有的隔离 workspace 模式(copy 已隔离,workspace.ts);并按 T5 发 `LOG` 说明"worktree 语义已由 copy 隔离满足"。真 git-worktree 延后。
  - DoD:并行写文件的 agent 互不污染(已由 copy 保证);run 日志里出现该 LOG;不报错、不静默。
  - 依赖:T2、T5。

- [x] **T5 — "无原语沉默丢弃"不变量**
  - 做法:Router 发现 option 被 set 但路由不到(model 无声明载体 / isolation 非原生 / 未来任何接受但未兑现的 opt)时,发一条可观测 `LOG`(进 `odw logs` + dashboard),写明"已接受但未原生兑现 + 实际采用了什么"。
  - DoD:每个"被接受却未兑现"的 opt 都产生可见 LOG(单测覆盖三种:model 无载体、isolation worktree、agentType 在无原生旗标的 CLI);**没有任何 opt 被无声吞掉**。
  - 依赖:T2。

- [x] **T6 — `budget` 的 `spent>=total` 硬钩子(空跑就位)**
  - 做法:在 scheduler 的 1000-agent 兜底之前(scheduler.ts:52)插 `if (budget.total!=null && spent()>=total) throw <fatal BudgetExhausted>`,走和 `AgentLimitExceeded` 同样的 fatal 路径。`spent()` **仍保持桩(恒 0)**,故现在恒不触发、零行为变化。
  - DoD:用非桩 budget mock 的单测能证明钩子在 `spent>=total` 时抛 fatal 并中止 run;真实跑(spent=0)行为不变。目的=门控未来 `workflow()` 嵌套。
  - 依赖:无(独立)。

- [x] **T7 — dual-compat 静态审计 + CI**
  - 做法:**新建**一个审计工具(仓库现在没有),机械校验每个工作流的 `meta` 是**真·纯字面量**。Oracle:`meta` 那段 `eval` 出的值,必须 `deepEqual` 同一 span 的 `JSON.parse` 结果(JSON.parse 只认纯数据,计算式会失败/不等)。放 `tests/fixtures/dual-compat/`(known-good / known-bad 各若干),接入 CI。**注意**:odw 的 loader 故意宽松(loader.ts:120),**不改 loader**;审计是测试,不是用户命令、也不是运行时拦截。
  - DoD:8 个 example 全部通过审计;known-bad fixture 全被判失败;CI 拦截不合规的 meta。守的是"方言可反向移植回 Claude Code"这条护城河。
  - 依赖:无(独立)。

---

### 本期明确不做(延后)

把范围钉死,避免蔓延:

- **真 token 计量** `budget.spent()`:需切各 CLI 的 JSON 输出模式 + per-adapter `usagePath`,且 **kimi 根本报不了用量**——天生不可移植。保持桩 + 1000 兜底(T6 钩子已就位)。
- **原生 schema 强制旗标**(codex `--output-schema`、qwen/claude `--json-schema`):odw 侧 prompt+校验+重试**已全平台可用**,原生只是减少重试的增强,延后。
- **persona 原生旗标层(Tier-2)**:claude/qwen 有 `--append-system-prompt`、gemini 靠 env、codex/kimi 无——异构。本期只做 T3 的通用 prompt 注入层。
- **真 git-worktree**:仅 claude 有 `-w/--worktree`;copy 隔离已够且更强(无需 git)。
- **模型档位抽象**(`fast/strong` → 各家映射):属于"一致性",本期不做。
- **`workflow()` 嵌套**:经 `resolveWorkflow`(resolve.ts:14-16)在同一 scheduler/budget 内联跑;**门控条件:必须等 T6 的硬钩子落地后**(嵌套放大 fan-out,是成本爆炸面)。

---

### 参考:per-CLI 旗标(已验证)

| 能力 | claude | codex | gemini | qwen | kimi |
|---|---|---|---|---|---|
| **model 旗标** | `--model` ✅实测 | `-m/--model` ✅实测(喂外来 id 直接 400) | `-m/--model` (doc) | `-m/--model` ✅ | `--model`→**需先在 config.toml 配别名** ⚠️ |
| **自定义 system prompt** | `--append-system-prompt` ✅ | ❌ 无 per-call(AGENTS.md/profile) | ❌ 无旗标(env `GEMINI_SYSTEM_MD`) | `--system-prompt`/`--append` ✅ | ❌ 无 inline(`--agent` 枚举 / `--agent-file`) |
| **原生 schema** | `--json-schema`(未验) | `--output-schema` ✅实测 | 仅 `-o json` 信封,靠 prompt | `--json-schema` (doc) | ❌ 无 |
| **worktree** | `-w/--worktree` ✅ | ❌ | ❌ | ❌ | ❌ |
| **token 用量** | usage + USD ✅实测 | `--json` usage ✅实测 | `-o json` stats (doc) | `-o json` usage (doc) | ❌ 查无 |

⚠️ gemini/qwen 成功路径因无 auth 未实跑(文档+报错信封);kimi token 实测 401 查不到。标"doc"者为"很可能"而非"已证明"。

### 硬限制(写进作者文档,不影响本期决定)

- **模型 id 跨不出本家**:`claude-opus-4-8` 在 codex 上是非法 id(实测 400)。
- **persona 原生机制五花八门**,唯一统一底座是 prompt 文本注入(= T3)。
- **token 计数跨 CLI 不可通约**(不同 tokenizer/provider),只有 claude 有 USD。
- **copy ≠ 真 git worktree**:无 branch/HEAD、`.git` 被排除、改动以 diff 返回;在 agent 内 `git log`/commit 的工作流会有差异。

---

### 文件锚点

- `src/primitives.ts` — `AgentOptions`:25-40;`agent()`:64-70;agentType 错接:66;`budget` 桩:113-117;`workflow` 抛错:119-120
- `src/bridge.ts` — `AgentRequest`:37-42;`composePrompt`:113-117;`invoke()` 拼 context:135-148(Router 落点)
- `src/adapters/placeholders.ts` — `PLACEHOLDERS`:11(加 `model`)
- `src/adapters/types.ts` — `Adapter`:10(加 `flags`)
- `src/adapters/builtin.ts` — 5 个 built-in 模板(加旗标声明,保持模板保守)
- `src/scheduler.ts` — 1000-agent 兜底:52(`spent>=total` 钩子落点)
- `src/workspace.ts` — copy/inplace 隔离(isolation 映射点)
- `src/loader.ts` — meta `eval`:120(**不改**,dual-compat 审计的对照对象)
- `tests/fixtures/dual-compat/` — **待新建**

---

## (b) 运行记录 Runs

> **已定**:① 名词统一用 **`run`**(GUI 的 "Jobs" 视图展示的就是这些 run,命名在 gui.md 再统一);② workflow 身份 = **`meta.name`**;③ 目录用 **方案甲** `runs/<workflow>/<runId>/`。
> 现状:观测面**八成已现成**——`odw list/status/result/logs`、`odw pause/resume/stop`、status.json / events.jsonl(9 类)/ result / error / worker.log 都在。本期只补"**归属索引 + 自动化退出码**",**不造调度器**。

### 背景:缺的就一点点

"看哪些 workflow 有哪些 run"现在已能看个大概(`odw list` 已列 run 且 status.json 带 `name`)。真正缺的:
- **创建时就关联**:`name` 现在是**运行中**才写(worker.ts:74),pending / 没跑起来的 run 不知归属 → 提前到创建时。
- **按 workflow 反查/分组**:现在没有 `--workflow`,问"deep-research 的所有 run"要扫全表。
- 身份/命名(已定,见上)。

### 核心设计:身份 + 目录布局

- **身份 = `meta.name`**:loader 在跑 body 前就 extract 出 meta,所以**创建时即可知**;path-run(`odw run ./x.js`)的脚本也有 meta.name,天然覆盖"路径运行没名字"。
- **lint:文件名 stem == meta.name**(R4),让"运行手柄 `odw run <stem>`"与"身份 meta.name"重合,避免双身份。
- **目录 `runs/<bucket>/<runId>/`**:`bucket` = `meta.name` 的文件系统安全 slug(meta.name 可能含空格/斜杠,落盘前 slug 化;meta.json 里仍存真实 `workflowName`);`runId` 保留现有 `<时间戳>-<随机>`,全局唯一,无跨桶冲突。
- **一个 run = 含 meta.json 的目录**:listRuns 改成**最多两层遍历**,自然兼容旧扁平 run(meta.json 在第 1 层=legacy,第 2 层=新结构)。

### 任务清单

- [x] **R1 — 创建时写入 workflow 身份 + 目录分桶**
  - 做法:`CreateRunInput`(run-store.ts:45)加 `workflowName`;`cmdRun`(cli.ts:147)在 launch 前用 `loadWorkflowScript(source).meta`(**只编译不执行**)取 `meta.name`,传入 create;`create()`(run-store.ts:58)把 run 落到 `runs/<slug(meta.name)>/<runId>/`,真实 `workflowName` 写进 meta.json。worker.ts:74 现有运行中写 name 可保留(冗余无害)。
  - DoD:新 run 落在 `runs/<name>/<runId>/`;meta.json 含 `workflowName`;一个 pending 的 run 也已知归属。
  - 依赖:无(B 段地基)。

- [x] **R2 — `listRuns` 两层遍历 + 兼容旧扁平 run**
  - 做法:`listRuns`(run-store.ts:155)改为"找含 meta.json 的目录,最多下探两层",bucket = 其父目录名;返回项带 `{runId, workflowName}`,按 runId(时间戳前缀)倒序。
  - DoD:新旧两种结构都被列出;时间倒序;旧扁平 run 不报错。
  - 依赖:R1。

- [x] **R3 — 按 workflow 反查(不全表扫描)**
  - 做法:`odw list --workflow <name>` 直接读 `runs/<slug(name)>/`;`odw logs --workflow <name>`(cmdLogs:223)读该桶最近一条 run 的 worker.log;`odw list`(cmdList:254)默认输出保留 name 列(cli.ts:268)。
  - DoD:两条命令只读对应桶、不扫全部 run;`odw list` 全量走 R2。
  - 依赖:R1、R2。

- [x] **R4 — `stem == meta.name` 的 lint**
  - 做法:加一个校验(可并进 §a 的 **T7** 审计,或独立):工作流文件名 stem 必须 == 其 `meta.name`,不等则告警/失败。
  - DoD:8 个 example 通过;构造一个 stem≠meta.name 的 fixture 被判失败。
  - 依赖:无。

- [x] **R5 — `--wait` 终态退出码保证**
  - 做法:`odw run --wait` 对 `failed`/`stopped` 终态返回非零(复用 reportTerminal,cli.ts:439-451);非 `--wait` 仍在 spawn 即返回 0(fire-and-forget,正确,**不改**,cli.ts:196)。
  - DoD:`--wait` 跑失败/停止的 run 返回非零(测试覆盖),成功返回 0。**这是一切自动化(含 cron)的前提。**
  - 依赖:无。

- [x] **R6 —(可选)cron 配方文档**
  - 做法:一份 doc + shell 模板:`0 8 * * * flock -n /tmp/odw-digest.lock odw run digest --wait`(`--wait` 拿退出码、`flock` 防重叠)。**无调度代码、无 daemon、无新模块。**
  - DoD:macOS/Linux 照配方能定时跑命名 workflow,成功 exit 0 / 失败 exit 非零,且 ODW 未加任何调度代码。
  - 依赖:R5。

- [x] **R7 —(可选,低优先)`odw rerun <runId>`**
  - 做法:读该 run 的 meta.json(script/args/config/source/budget),原样再发一次(= 新 run)。
  - DoD:`odw rerun <id>` 产生一个 args 相同的新 run。
  - 依赖:R1。

### 本期明确不做(延后)

- **自研调度器 / daemon**:走 OS cron(R6 配方),不造。
- **清理旧 run** `odw cleanup`(按龄):延后(runs 目录会持续增长,已知债)。
- **死进程 → `interrupted`**:延后(status.json 已有 `pid`,补一步检测即可,非本期)。
- **只读分享 / `--export` run-link**:延后(社会证明类,归 GUI/后续)。

### 文件锚点(b)

- `src/runtime/run-store.ts` — `CreateRunInput`:45;`create()`:58(分桶 + 写 workflowName);`listRuns`:155(改两层遍历)
- `src/runtime/worker.ts` — name 写入:74(运行中写,可保留)
- `src/runtime/launcher.ts` — fire-and-forget spawn:60-66
- `src/cli.ts` — `cmdRun`:147(创建前取 meta.name);`cmdLogs`:223 / `cmdList`:254(加 `--workflow`);list 已含 name:268;reportTerminal 退出码:439-451;非 --wait spawn 即 0:196
- `src/loader.ts` — `loadWorkflowScript().meta`(只编译不执行,取 meta.name)
- `src/workflows/resolve.ts` — 命名解析:14-16(stem 身份来源)
