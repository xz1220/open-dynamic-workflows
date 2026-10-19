# 概念：ODW 如何工作，与 Claude Code 共享什么

[English](../concepts.md) · 简体中文

ODW 为什么这样构建：从 `odw` 到 agent CLI 的各层，以及 Claude Code 方言能沿用到什么程度（由一致性套件确定）。

## 工作原理

```
odw (CLI) ─▶ runtime(后台 worker + run 目录)
               └─ 加载并转换 ─▶ workflow 脚本(.js,Claude 方言)
                                  └─ 注入原语 ─▶ scheduler(async 并发上限 + agent 兜底)
                                      agent() ─▶ bridge ─▶ adapters ─▶ 真实 CLI 子进程
                                                  ├─ workspace(隔离 + diff)
                                                  └─ schema(校验 / 重试)
```

两个值得点出的设计:

- **loader 是关键。** Claude 的方言既不是标准 ES module 也不是普通脚本:`export const meta`
  在顶部,脚本体用了顶层 `await` **和**顶层 `return`,还引用注入的全局。loader 会(用
  字符串/注释/正则感知的扫描)抽出 `meta`、去掉 `export`,再把脚本体包进一个 async 函数,
  其参数**就是**那些原语——于是脚本体的 `return` 就变成 workflow 的返回值。
- **没有线程。** 引擎彻头彻尾是异步的。`agent()` 不过是一次异步子进程调用,所以
  `parallel` 就是 `Promise.all`、`pipeline` 是逐条目的 async 链,并发上限只是一个小小的
  异步信号量——默认 `min(16, CPU核数-2)`,外加一个单次运行总派发量的硬兜底。

| 路径 | 层 |
| --- | --- |
| `src/adapters/` | L1 — 统一的 CLI 调用(配置、占位符、runner、内置适配器) |
| `src/bridge.ts` | L2 — 一次 `agent` 调用 → 一次 CLI 运行,含 schema 处理 |
| `src/scheduler.ts` | L3 — 有界的异步并发 + agent 总量兜底 |
| `src/primitives.ts`、`src/schema.ts` | L4 — 注入的原语 + 数据契约 |
| `src/loader.ts` | 把 workflow 脚本转成可运行形态的转换器 |
| `src/runtime/` | L5 — 后台 worker、run 目录、控制 |
| `src/cli.ts` | L6 — `odw` 命令 |
| `src/workspace.ts` | 横切 — 工作区隔离与 diff |
| `src/changes.ts` | 横切 — 隔离 agent 的改动,保存为 diff 和分支 |

workflow 脚本始终是**纯 `.js`**、从不编译;引擎用 **TypeScript** 写(编译成 ESM,
**零运行时依赖**),并附带 `.d.ts` authoring 类型,让脚本作者在编辑器里对注入的全局有
自动补全。

## 兼容性与迁移

ODW 已实现下列原语能力。依赖宿主私有运行机制的脚本,迁移前需要逐项核对：

| 功能 | ODW 的行为与迁移要求 |
| --- | --- |
| 嵌套 `workflow()` | 已实现一层嵌套,共享父任务的调度器、控制和预算。更深层的调用需要展平。 |
| 模型选择 | 在 `agent(..., {model})` 中传该 CLI 的模型 ID;适配器没有模型参数时会记录路由说明。`meta.phases` 条目里的 `model`(以及 `adapter`)是该阶段 agent 的默认值,`model: "@fast"` 按 CLI 选出某层级的模型——都是 **ODW 扩展**(见[按阶段路由](guides/adapters-and-models.md#按阶段路由与回退链odw-扩展));阶段的模型和其他模型 ID 一样,其 agent 可能跑在多个 CLI 上时请用层级。`meta.model` 仍只是元数据。 |
| `agentType` | 加载同名子 agent 定义(`.claude/agents/<name>.md` 及 Claude Code 的其他位置):正文作为人设,`model`、`tools`、`isolation`、`effort` 按 CLI 映射——tools 只会降低档位,没有生效的字段逐个记入日志(**ODW 扩展**;见[agent 定义](guides/adapters-and-models.md#agenttype-读取-agent-定义odw-扩展))。找不到定义时是一句话人设。它从不选择适配器。 |
| 工作区隔离 | 从已保存的 HEAD 创建临时工作区,不含未保存修改,结束后清理。不会自动合并,`agent()` 返回回复而非 diff;ODW 会把每个隔离 agent 的改动保存为 diff,供审阅和应用(`odw diff`、`odw apply`、`keep` 分支——均为 ODW 扩展;见[审阅并应用](guides/reviewing-and-applying.md#审阅并应用隔离-agent-的改动odw-扩展))。支持 `.worktreeinclude`(ODW 连未跟踪文件也复制,而不只是被 gitignore 的文件);其中的 `symlink:` 行、`worktreeSetup` 和 agent 的 `ODW_PORT` 是 ODW 扩展——见[隔离 worktree](guides/reviewing-and-applying.md#隔离-worktree-与-agent-端口)。 |
| 预算 | 计算输出 token:适配器上报用量时用 CLI 自己的计数(内置 `claude` 和 `codex` 会上报——见[用量与花费](guides/cost-limits-and-quotas.md#用量与花费odw-扩展)),否则按每条回复的 `ceil(字符数 / 4)` 估算。每次 CLI 运行都计入:schema 重试、限流重试,以及上报了用量的失败运行。每次派发和每次 schema 重试前都会检查;预算用尽时运行结束,仍在运行的 agent 会被停止。 |
| JSON Schema | ODW 只检查[已列出的子集](../../skills/open-dynamic-workflows/zh-CN/references/primitives.md#schema);`format` 是注解。其他关键字(`$ref`、`const`、`oneOf`、`maxItems` 等)照常运行:运行日志会写明关键字及其位置,自己校验 schema 的 CLI(`claude`、`codex`)会强制执行它们。设 `"schemaKeywords": "strict"` 则改为拒绝这类调用(ODW 扩展;见[结构化输出](guides/adapters-and-models.md#结构化输出odw-扩展))。请明确声明对象/数组类型并使用受支持的约束。 |
| 脚本可信性 | 只运行可信脚本:运行工作流会把正文当作普通 JavaScript 执行。加载时元数据按纯字面量解析,不会被求值;编译检查和兼容性警告都不提供沙箱隔离。触发器、插件与不可信的运行在[严格脚本上下文](guides/safety-and-trust.md#严格脚本上下文odw-扩展)中编译正文——只有原语与标准内建对象——它同样不是沙箱。 |
| 恢复 | 每个完成的 `agent()` 结果都会在完成时保存。`odw resume` 让已暂停且仍存活的 worker 原地继续;对已结束的运行(done、failed、stopped,或崩溃后的 stale)则启动一个新运行:prompt 和选项都没变的调用直接重放,其余照常执行。`rerun` 从头执行。见[恢复运行](guides/running-and-observing.md#恢复运行odw-扩展)。 |

原语名称一致不代表运行机制完全等价。`validate(source)`、`exec(command)` 和 `checkpoint(title)`
是 ODW 扩展,迁移到未提供它们的宿主时需要去掉(`validate()` 会对 `exec()` 和 `checkpoint()`
调用给出 warning)。可恢复失败产生的 `null` 需要显式处理：接受部分结果、重试,或在要求完整
交付时报告失败。

**一致性测试套件。** [`conformance/`](../../conformance/) 把方言的行为写成可运行的用例:每个用例是
一份 Claude Code 方言的普通工作流脚本,配一个 `expected.json`(返回值,以及要紧的日志、phase
和 agent),由确定性的 mock agent 按表作答。`odw conformance [--json] [--case N]` 用它们检查
当前的 odw(任一用例失败即退出码 1;CI 会运行);`odw conformance --strict` 在[严格脚本上下文](guides/safety-and-trust.md#严格脚本上下文odw-扩展)中运行全部用例(CI 同样会运行)。每个用例都标明 Claude Code 的文档是否确定了
该行为(`documented`),还是没有(`unspecified`:用例记录的是 ODW 的行为)。只依赖 documented
用例所确定行为的脚本,两边都能跑。这些用例是普通工作流文件,也可以在 Claude Code 上手动运行;
[`conformance/README.md`](../../conformance/README.md) 说明了格式,其他运行时可以据此实现自己的
runner。
