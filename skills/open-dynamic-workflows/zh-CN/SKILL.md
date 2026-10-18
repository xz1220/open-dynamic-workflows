---
name: open-dynamic-workflows
description: >
  编写并运行 dynamic workflow：用 Claude Code 的 workflow 方言写一段简短的 JavaScript
  脚本，再用 `odw` CLI 在宿主 agent 的上下文之外，把子任务扇出给 coding-agent CLI
  （Codex、Claude Code、Gemini、Qwen、Kimi 或自定义），后台跑完后只取回最终结果。
  当一个任务大过单次调用——需要并行扇出多份草稿、多阶段评审流水线、对抗式核验发现，
  或循环挖掘直到无新发现——或用户提到 odw、dynamic workflow、多 agent 编排、扇出
  subagent 时，使用本 skill。
license: MIT
---

# Open Dynamic Workflows

一个 dynamic workflow 就是一段简短的 JavaScript 脚本：编排计划写成普通代码，由
`odw` 在独立的后台进程里执行，把每个子任务派发给一个真实的 coding-agent CLI 进程。
中间产物不进入你的上下文，回到你手里的只有脚本 `return` 的最终值。

使用流程固定三步：**写脚本 → `odw run` → 检视结果再行动**。任务一次调用就能完成时
不要用——直接做。

## 写 workflow 脚本

- 文件最顶部放 `export const meta = {…}`，必须是**纯字面量**（不含变量、函数调用、
  模板插值）。`meta.name` 与 `meta.description` 必填；`whenToUse`、`phases`、`model`
  可选。`phases` 的条目是 `{ title, detail? }`（或者只写标题）；条目里的 `adapter` 和
  `model` 是该阶段 agent 的默认值（**ODW 扩展**——见[按阶段路由](#按阶段指定适配器模型分层与回退链odw-扩展)）。
- 脚本体运行在 async 上下文里：直接用顶层 `await`；顶层 `return` 的值就是整个
  workflow 的结果。
- 原语全部是**注入的全局**——不要 import。除 `export const meta` 外，文件里出现任何
  其他顶层 `import` / `export` 都会被加载器拒绝。
- 循环、`if`、去重等普通控制流直接写在脚本里。原语只负责**派发并等待**，拿结果做
  什么由脚本决定。

```js
// fan-out-reduce.js
export const meta = {
  name: 'fan-out-reduce',
  description: 'Draft in parallel, then synthesize.',
  phases: [{ title: 'Draft' }, { title: 'Synthesize' }],
}

const question = (args && args.question) || 'Design a cache.'

phase('Draft')
const drafts = await parallel(
  [1, 2, 3].map((i) => () => agent(`Draft #${i}: ${question}`, { phase: 'Draft' })),
)

phase('Synthesize')
return await agent(
  'Synthesize the best answer from:\n' + drafts.filter(Boolean).join('\n---\n'),
  { phase: 'Synthesize' },
)
```

用 `--args` 传入的输入会注入为全局 `args`（解析后的 JSON，或一段原始字符串——
*看起来像* JSON 但解析失败的输入会被直接拒绝，不会悄悄按字符串传入）。

## 原语速查

| 原语 | 作用 |
| --- | --- |
| `agent(prompt, opts?)` | 让一个 coding agent 跑一个子任务；返回它的回复文本，设了 `opts.schema` 则返回校验过的对象。唯一真正干活的动词。 |
| `parallel(thunks)` | 并发执行一组零参 thunk，并**等全部完成**（屏障）。顺序保留；失败的槽位是 `null`。 |
| `pipeline(items, ...stages)` | 让每个条目独立地流过各 stage（**无屏障**）。每个 stage 收到 `(prev, item, index)`。 |
| `phase(title, opts?)` / `log(msg)` | 给后续工作打上进度标签 / 发一行进度消息。`opts`（`{ adapter, model }`，**ODW 扩展**）为该阶段的 agent 指定 CLI 和模型。 |
| `args` | workflow 的输入（注入）。 |
| `budget` | `{ total, spent(), remaining() }`——按 token 目标扩缩深度。 |
| `workflow(ref, args?)` | 内联调用另一个 workflow（仅一层）。`ref` 是受管目录中的名字或 `{ scriptPath }`；子 workflow 共享本次运行的并发上限、agent 计数和预算。 |
| `validate(source)` | 解析并编译检查源码,不运行工作流正文;`meta` 按纯字面量解析,绝不求值。返回 `{ ok, meta?, errors, warnings }`。**ODW 扩展**——不属于 Claude Code 方言。 |
| `exec(command, opts?)` | 不启动模型直接运行一条命令（测试、构建、linter）；返回 `{ stdout, stderr, exitCode, signal, timedOut, truncated, durationMs }`。字符串经 shell 执行，数组按 argv 执行。**ODW 扩展**——不属于 Claude Code 方言。 |
| `checkpoint(title, opts?)` | 暂停运行，直到有人批准（可以附上修改后的 payload）或拒绝；返回 `{ approved, note, by, payload, edited }`。**ODW 扩展**——不属于 Claude Code 方言。 |

`agent` 的 `opts`：`{ adapter?, schema?, label?, phase?, model?, agentType?, isolation?, keep?, permissions?, expect?, expectRetries?, allowEmpty? }`。
`adapter` 选择用哪个 CLI——写成列表（`['codex', 'claude']`，**ODW 扩展**）就是回退链；
`model: '@fast'` 为实际运行它的 CLI 选出该层级的模型（**ODW 扩展**）；`schema` 是一个原始 JSON Schema 对象（选项，不是全局）；
`agentType` 是注入进 prompt 的**人设**，*不是* adapter 名。`keep: true`（**ODW 扩展**）
还会把隔离 agent 的改动提交到分支 `odw/<runId>/<agentId>-<label>`。`permissions: "read"`
（**ODW 扩展**）让该 agent 以比运行更严格的档位运行——见[权限档位](#权限档位odw-扩展)。

`schema` 请只用 ODW 会检查的子集——`type`（单个类型名）、`enum`、`properties`、`required`、
`additionalProperties: false`、`items`（单个 schema）、`minItems`，外加 `description`、
`format` 等注解。其他关键字（`oneOf`、`$ref`、`const`、`pattern`、`maxItems`、类型联合……）
ODW 不检查：运行日志会连同位置说明一次，调用照常运行——设 `"schemaKeywords": "strict"` 时则在
启动前以 `AgentError` 失败（**ODW 扩展**）。ODW 检查不了的限制请写进 `description`。在
`claude` 和 `codex` 上 schema 会原生交给 CLI，由它强制执行；无论哪种，ODW 都会校验回复——见
[`references/primitives.md`](references/primitives.md#schema)。

`expect`（**ODW 扩展**）写明 agent 回复之后必须成立的条件，由 odw 来检查——优先用它，
而不是问模型"你做了吗"，或相信一个这么说的回复。`changes: true|false`（有文件改动 / 不许
有改动）、`files`（glob 列表，每个都要匹配到一个被改动或新建的文件）、`command`（必须在
agent 的工作区里以 0 退出；`timeout` 秒，默认 600）和 `match`（回复必须匹配的正则）。没
达到要求的工作会在同一个适配器上带着缺失项重跑（`expectRetries`，默认 1），之后抛出可恢复的
错误，带 `reason: "unmet_expectation"` 和 `misses`；缺失绝不会触发回退，而发生回退的调用会
带着它的 `expect`。CLI 拒绝的工具调用（claude 的
`permission_denials`）也算作缺失，此时原因为 `"permission"`。没设 `expect` 时，这样的回复
照常成立：被拒绝的调用作为 `denied` 记在 agent 上，并记一次日志（`"permissionDenials":
"fail"` 则让它失败）。`mcp: ['github']` 要求 Claude Code 启动 agent 时这些 MCP 服务器已连上
（`pending` 也算通过）；不设时，没连上的服务器作为 `mcp` 记在 agent 上，每次运行记一次日志
（`"mcpFailures": "fail"` 让服务器为 `failed` 或 `needs-auth` 的 agent 以 `"mcp_unavailable"`
失败）。空回复总会抛出 `reason: "empty_reply"`（`allowEmpty: true` 接受空回复）：

```js
const fix = await agent('Fix the failing parser tests.', {   // ODW 扩展：expect
  expect: { command: 'npm test', changes: true, files: ['src/parser/**'] },
})
```

`exec` 的 `opts`：`{ cwd?, env?, timeout?, input?, maxOutputBytes?, label?, phase?, check? }`。
默认在源目录中运行，超过 `timeout` 秒（600）后连同它启动的所有进程一起被杀，每个输出流
保留 8 MiB。非零退出码是用来分支的结果，不是错误——除非设了 `check: true`，此时抛出
可恢复的 `ExecError`。它不占 agent 槽位，但暂停和停止对它同样生效：

```js
let run = await exec('npm test')             // ODW 扩展
for (let round = 1; run.exitCode !== 0 && round <= 3; round++) {
  await agent(`Fix the failing tests:\n${run.stdout.slice(-4000)}\n${run.stderr.slice(-4000)}`)
  run = await exec('npm test')
}
```

`checkpoint` 的 `opts`：`{ payload?, schema?, timeout?, onTimeout? }`。`payload` 是要给人看的
内容（计划、改动摘要）；`timeout` 是等待的秒数，超时后由 `onTimeout` 批准、拒绝，或
（默认的 `"fail"`）抛出可恢复的 `CheckpointTimeout`。拒绝也是一个答复而不是错误：按
`approved` 分支，并利用对方的 `note`。对方也可以批准一份**修改过的** payload（`odw approve
--edit` / `--payload`，或看板）：请使用结果里的 `payload`——也就是被批准的内容——而不是你
自己手里的那份（`edited` 表示它是否被改过），并传入 `schema`，让修改必须保持代码所依赖的
结构（不传时任何 JSON 值都接受）：

```js
const plan = await agent(`Plan this as independent steps: ${task}`, { schema: PLAN })
const r = await checkpoint('Run this plan?', { payload: plan, schema: PLAN })   // ODW 扩展
if (!r.approved) return { approved: false, note: r.note, plan }
const approvedPlan = r.payload   // 对方修改后的内容，或 plan 本身
```

**选择法则：** 下一步需要**一整批**结果一次到位（去重、计票、综合）时用 `parallel`；
多阶段处理默认用 `pipeline`。

写嵌套 workflow、schema 重试、budget 扩缩等复杂组合之前，先读
[`references/primitives.md`](references/primitives.md)。

## 运行与观测

```bash
odw run wf.js --wait --args '{"question": "Design a cache."}'   # 阻塞并打印结果
```

长任务用 fire-and-poll，不阻塞自己：

```bash
RUN=$(odw run wf.js)        # 打印一个 run id 后立即返回
odw status $RUN             # 状态、agent 计数、token 与花费
odw logs $RUN --follow      # 流式输出进度事件
odw logs $RUN --agent 3     # 某个 agent 做了什么：工具调用、结果、错误（ODW 扩展）
odw export $RUN --otlp      # 把运行导出为 OpenTelemetry trace（OTLP/JSON）——--send 直接发送（ODW 扩展）
odw bundle $RUN             # 把运行写成一个可分享的脱敏文件 $RUN.odwrun；odw view FILE 只读查看
                            #   （ODW 扩展；--no-transcripts、--out FILE、--max-bytes N）
odw result $RUN             # 完成后打印最终值
odw pause $RUN / resume $RUN / stop $RUN
odw approve|reject $RUN     # 回答运行正在等待的 checkpoint()——只在用户明确要求时
                            # （approve --payload JSON|@file 批准用户修改后的内容；--edit 需要用户的终端）
odw compare $OLD $RUN       # 两次运行之间变了什么:配置、耗时、花费、失败、回复(ODW 扩展)
                            #   --agent <label|id>:某个 agent 的完整回复 diff;--json 供脚本使用
odw list                    # 所有运行
```

保存过的 workflow 可直接按名字运行（`odw run <名字>`）；查找顺序：`.odw/workflows`、
`.claude/workflows`、`~/.odw/workflows`、`~/.claude/workflows`。

### 恢复卡住或失败的运行（ODW 扩展）

每个 `agent()` 的结果在该 agent 完成的那一刻就会保存，所以某条泳道卡住、运行被停止或
worker 死掉，都不会丢掉已经完成的工作。不要干等卡住的运行，也不要从头重跑：

```bash
odw agents $RUN               # 每个 agent：状态、label、phase、耗时、结果预览（↺ = 重放）
odw result $RUN --agent 3     # 某个已完成 agent 的值（JSON，按 id 或 label）——运行中也可用
odw logs $RUN --agent 4       # 失败（或卡住）的 agent 做了什么：每次工具调用、结果、错误
odw stop $RUN                 # 放弃卡住的泳道，然后……
odw resume $RUN --wait        # ……启动一个新运行：未改动的 agent() 调用直接重放，只执行其余部分
```

- 重试失败的 agent 之前，先读它的 transcript（ODW 扩展）：
  `odw logs $RUN --agent <id|label>` 会列出它的工具调用（`▸ Bash  npm test`）、调用结果
  （`✗ Bash error (exit 1, …)`）、重试，以及它 stderr 的结尾；`--follow` 可跟踪仍在运行的
  agent，`--raw` 打印 CLI 自己的事件。按看到的问题去修——prompt、缺失的工具权限、环境——
  而不是原样再提交一次。重放（↺）的 agent 没有 transcript。
- 运行仍在进行时，就可以用 `odw result --agent` 取回部分结果。
- 对已结束的运行（done、failed、stopped 或 stale）执行 `odw resume`，会用同样的脚本、
  args 和 adapter 启动新运行。prompt 和选项都没变（phase 除外）的调用免费返回已保存的值——
  不调用 adapter、不占槽位、不耗预算。先改好脚本里出错的那一步：只有改动过的和新增的调用
  会执行。`--adapter <名字>` 切换默认 CLI；没有指定 adapter 的调用仍会重放。
- 对*已暂停*的运行——因 `odw pause`，或在等用尽的额度重置（`quotaWait`）——`odw resume`
  只是原地继续。仍在运行的运行会被拒绝：先 `odw stop`（或加 `--force`）。
- 保持 prompt 确定：用 `Date.now()` 或 `Math.random()` 拼出的 prompt 永远匹配不上，会重新执行。

### 审阅并应用隔离 agent 的改动（ODW 扩展）

带 `isolation: "worktree"` 的 agent 改的是一次性 worktree，从不碰你的文件。它的改动会以
diff 形式随运行保存（`agents/<agentId>.diff`）——`agent()` 返回的仍然只是回复：

```bash
odw diff $RUN --stat                  # 哪些 agent 改了哪些文件，增删多少行
odw diff $RUN --agent <id|label>      # 某个 agent 的 diff——应用前先读
odw apply $RUN --agent <id> --check   # 预览：每个文件是 clean、CONFLICT（附冲突行）还是 already applied
odw apply $RUN --agent <id>           # 用 git apply --3way 应用到当前工作树（会暂存）
odw apply $RUN --all --check          # 预览所有已完成的 agent，每个都叠在前面的之上
odw apply $RUN --all --verify "<测试命令>"   # 按顺序应用；校验失败的那次应用被回滚
```

- 先预览（`--check`，有冲突时退出码 1），按任务需要应用，并告诉用户应用了什么、哪里冲突了
  （退出码 1：有待解决的冲突标记，位置与预览一致）。请在本次运行所针对的仓库里执行。
- `--all` 按 agentId 顺序应用所有已完成的 agent，在第一个会冲突的之前停下，并说明哪些应用了、
  哪些没有。失败的 agent 的 diff 只能用 `--agent` 单独应用。
- `--verify "<cmd>"`（或配置 `applyVerify`）在每次应用后于仓库根目录运行该命令，失败时把这次
  应用原样回滚——只动 diff 涉及的路径，绝不碰用户的其他改动。项目有测试或构建命令时就用它。
  `--verify` 下会冲突的改动不会被应用。
- 只要 diff 涉及的路径上有未提交的改动，`odw apply` 就会拒绝——先提交或 stash；只有用户
  同意时才用 `--force`。
- 超过 `maxDiffBytes` 被截断的 diff 无法应用：改用该 agent 的分支（`keep: true`，或在
  配置里设 `"keepBranches": true`）。

### 权限档位（ODW 扩展）

每个 agent 都在一个档位下运行：`read`（只看——不改文件、不跑命令）、`edit`（默认：各 CLI
一直以来的姿态）或 `full`（无沙箱、无审批）。

- **调研、审查、审计和核验类的扇出：用 `read`。** 给这些 agent 传 `{ permissions: 'read' }`；
  没有任何步骤需要写入时，用 `odw run wf.js --permissions read` 让整个运行只读。能改文件
  的审查者可能会去"修复"它本该只报告的问题。
- agent 只能降低运行的档位；请求更高档位的 agent 会失败
  （`agent() asked for permissions "full", but the run allows only "edit"`）。
- `read` 在 `claude`、`codex` 和 `gemini` 上可用。其他 CLI 会拒绝：agent 在启动前失败，并说明
  哪个适配器可以。只读 agent 请指定其中之一（`adapter: 'claude'`）；`odw doctor` 会列出每个
  适配器支持的档位，每次 `odw run` 也会打印各已安装适配器将以哪个档位运行。
- **绝不要自己决定用 `full`。** 它去掉了沙箱和所有审批：只在用户明确要求、且是在用户视为
  可丢弃的机器上时才用。

```js
const findings = await parallel(files.map((f) => () =>
  agent(`Review ${f}: list bugs with evidence; change nothing`, { permissions: 'read', label: f })))  // ODW 扩展
```

### 按阶段指定适配器、模型分层与回退链（ODW 扩展）

按阶段混用 CLI 和模型——大范围的搜索或抽取扇出用便宜的模型，综合与裁决用强的——并在某个
CLI 额度用尽时让长时间运行继续下去。

- **阶段默认值。** `meta.phases: [{ title: 'Search', adapter: 'codex', model: '@fast' }]`，
  或用 `phase('Search', { adapter: 'codex', model: '@fast' })` 设置其后的 agent。`agent()`
  调用自己给出的选项永远优先。
- **模型分层。** `model: '@fast'` 使用用户配置的 `models` 层级，各 CLI 用自己的模型 ID；
  未知层级会让该 agent 失败并列出已有层级。普通模型 ID 会原样传给每个 CLI——只要 agent
  可能跑在不止一个 CLI 上，就优先用层级。
- **回退链。** `adapter: ['codex', 'claude']`（或用户配置的 `fallback`）：第一个 CLI 额度
  用尽或登录被拒时，agent 会以相同的权限档位在下一个 CLI 上重新运行，日志会写明
  （`search:3 → claude after codex quota`）。限流仍在原 CLI 上重试。同一个 CLI 连续三次
  额度失败后，本次运行之后的 agent 会跳过它。`odw agents --json` 和 `agent_finished` 事件
  会写明产出每个结果的 CLI（`adapter`）以及它离开过的那些（`fellBackFrom`）。
- 只写用户装好的适配器（`odw doctor` 会列出），并尊重用户选定的默认 CLI：长时间运行总因
  额度停下时，建议用户加回退链，不要擅自加。
- **额度用尽时暂停。** 配置里写上 `"quotaWait": { "max": <秒数> }`（默认关闭）后，无 CLI
  可用的 agent 会等到它的 CLI 报出的重置时间，而不是失败——等待时不占槽位——运行显示为
  `paused until 19:10 (codex quota)`。无人值守的通宵运行可以建议开启，并说明运行可能因此
  停上几个小时；`odw resume <run>` 立即继续。

```js
phase('Extract', { model: '@fast' })   // ODW 扩展
const claims = await pipeline(sources, (s) => agent(`Extract cited claims from ${s}`, { schema: CLAIMS }))
phase('Verdict', { adapter: ['claude', 'codex'], model: '@strong' })   // ODW 扩展
return await agent(`Rank these claims by evidence:\n${JSON.stringify(claims.filter(Boolean))}`)
```

### 人工检查点（ODW 扩展）

只在值得等人判断的地方加 `checkpoint()`：昂贵或难以撤销的步骤之前（大规模扇出、横跨
仓库的修改、任何部署、删除或花钱的操作），或者让用户确认一份你生成的计划。不要给例行
步骤加检查点；无人值守的运行（cron、CI）要给检查点设 `timeout` 并明确 `onTimeout`。

运行到达检查点后会持久地等待——要多久就等多久——并显示为 `waiting`：

```bash
odw status $RUN     # 问题、它的 payload，以及回答它的确切命令
```

**绝不要自己回答检查点。** 它存在的意义就是让用户来决定。把问题和 payload 展示给用户，
只有在用户明确告诉你之后，才运行 `odw approve $RUN` 或 `odw reject $RUN --note "…"`
（有多个在等待时加 `--checkpoint N`）——把用户的理由写进 `--note`。如果用户要求改了再批，
就用 `odw approve $RUN --payload @file.json` 发送用户认可的那份 payload（`--edit` 会在终端里
打开编辑器——那是用户的终端，不是你的）。如果用户不在，就让它
继续等：用户之后可以在任意 shell 里回答，或在看板（`odw serve`）里点 Approve/Reject。

检查点等待期间 `odw run --wait` 会一直阻塞。带检查点的 workflow 请以后台方式启动
（`RUN=$(odw run wf.js)`）并轮询 `odw status $RUN`，或用 `--wait --timeout <秒>` 限定
等待时长。`odw resume` 会重放已完成的 agent，但每个检查点都会重新提问。

### 定时运行（ODW 扩展）

只有用户要求定期运行时才设置：`odw schedule add` 会写入用户的 crontab、LaunchAgents
或 systemd 用户单元。先把 `--dry-run` 的输出给用户看。

```bash
odw schedule add digest digest --cron "0 8 * * 1-5" --cwd ~/work/news --dry-run   # 将要写入什么
odw schedule add digest digest --cron "0 8 * * 1-5" --cwd ~/work/news             # 参数同 odw run：--args、--adapter、--config
odw schedule list              # 每个定时任务的后端、上次运行、下次运行（本地时间）
odw schedule run digest        # 立即按调度器的方式跑一次：退出码 0 = done（或被跳过）
odw schedule remove digest     # 删除系统条目和定义
```

- odw 不常驻 daemon：`add` 写入 cron 标记块（Linux）、launchd agent（macOS），或在
  `--backend systemd` 时写入用户级 timer，由它调用 `odw schedule run <name>`——上一次
  运行未结束时跳过本次，每次运行向 `~/.local/state/odw/schedules/<name>.log` 追加一行，
  并像普通运行一样触发 `notify` 钩子。
- 添加时 workflow、适配器和配置必须能加载；表达式是 cron 的五个字段（`@daily`、`L`、`#`
  会被拒绝）。
- 定时运行遇到 `checkpoint()` 时，在得到答复前会挡住后续的运行：无人值守的检查点要设
  `timeout`。

## 适配器

Codex、Claude Code、Gemini、Qwen、Kimi 开箱即用，无需配置。要换默认 CLI、调旗标或
接入自定义 CLI 时，读 [`references/adapters.md`](references/adapters.md)，写一个
`odw.config.json`（放在项目根或 `~/.config/odw/config.json`，或用 `--config` 指定）。

如果运行报 **AdapterNotFound**（装了多个 agent CLI 但没选默认）：先跑
`odw init --check` 查看装了哪些 CLI——在你的非交互 shell 里它只报告、绝不弹提示。
然后**问你的用户**想默认用哪个，再用 `odw init --adapter <名字>` 写入他们的选择。
不要替用户悄悄决定：默认值决定了每个裸 `agent()` 调用花的是哪家 CLI 的额度和权限。

如果 agent 很快失败或返回空结果,先跑 `odw doctor`:它会检查运行环境、配置、运行目录和每个
适配器,并给出修复建议。`odw doctor --smoke` 还会给默认适配器发一条真实提示——先征得用户同意
(会消耗一次模型调用)——能发现那些在无头模式下没有回答就以 0 退出的 CLI(通常卡在登录、
信任或审批提示上)。

## 必须知道的行为

- **上下文**：每个 agent 接收自己的提示词；使用默认 source 目录的 agent 共享文件。
  文件修改需要分开时,请选择 worktree 隔离。
- **工作区**：agent 直接在本次运行的 source 目录（`--source`，默认当前目录）里
  工作——与 Claude Code 自带 Workflow 工具同语义。需要隔离时按 agent 传
  `isolation: "worktree"`：agent 获得一个一次性 **git worktree**（要求 source
  是有至少一次提交的 git 仓库；agent 看到的是 HEAD，不含未提交改动）。临时工作区
  随后会被删除,改动不会自动合并。`agent()` 返回回复而非 diff；运行会把 agent 的改动保存为
  diff，供审阅和应用（`odw diff`、`odw apply`；ODW 扩展——见上文）。新 worktree 不含未跟踪文件：仓库根目录的 `.worktreeinclude`
  （gitignore 语法；`symlink: node_modules` 表示链接而非复制）会把 `.env` 等带进去，
  配置里的 `worktreeSetup` 命令会在 agent 启动前运行（均为 ODW 扩展）。
- **端口**：每个 agent 进程都有唯一的 `$ODW_PORT`（以及 `$ODW_RUN_ID`、`$ODW_AGENT_ID`）——
  让并行的 agent "在 `$ODW_PORT` 上启动开发服务器"，它们就不会冲突；并让它们在结束前停掉服务
  （agent CLI 退出前可能会等待自己的后台命令）（ODW 扩展）。
- **限流**：被限流的 CLI 会按退避时间重试（遵守它给出的 retry-after）；额度耗尽或登录失败
  不会重试——agent 会失败并说明该怎么做，`odw logs` 会写明原因——除非它有回退链，那样它会
  换到下一个 CLI（ODW 扩展）。遇到额度耗尽，用 `--adapter` 换一个适配器，而不是反复重试。
  开启 `quotaWait`（ODW 扩展）后，它会改为等额度重置（见上文的路由）。
- **限速与提示缓存**（ODW 扩展）：适配器自己的 `concurrency` 在运行级上限之内限制它的
  agent 数，一次限流会让这个上限在本次运行中减半；在 `claude` 上，提示的前 1,024 个以上
  字符相同的 `parallel()`/`pipeline()` 会错开启动，让其余 agent 读取提示缓存——把共享的
  说明放在前面，每项不同的部分放在最后。
- **成本**：并发有上限（默认 `min(16, cpu核数-2)`），单次运行总派发量有硬兜底；超出
  预期时用 `odw pause` / `odw stop`。
- **结果**：引擎不会替你 commit、push 或应用 diff。先检视 `return` 值，再决定下一步——对隔离
  agent 而言，这包括审阅它们保存下来的 diff 并运行 `odw apply`。
- **密钥**（ODW 扩展）：odw 保存和提供的内容——transcript、`odw logs`、保存的结果
  （`odw result --agent`）、运行的错误、webhook、`worker.log`（含工作流里的 `console.log`）、
  Chat Host 会话——会把疑似密钥显示为 `«redacted:<kind>»`
  （名字像密钥的变量的值记为 `env:NAME`，否则记为令牌类型）。agent 和工作流拿到的仍是原文；
  只有写下来的内容被脱敏，所以 `odw logs` 里出现标记并不是 agent 出错。恢复的运行会按保存
  时的样子重放已脱敏的结果：别让后续步骤依赖 agent 打印出来的密钥——从环境变量读取。运行
  自身的结果保留变量的值（那里只脱敏令牌形态），保存的运行 `args` 也一样——看板和 API 显示时
  脱敏令牌形态，`odw rerun` 用原始值；`"redact": false` 可关闭脱敏。

## 常见错误

| 错误 | 纠正 |
| --- | --- |
| 在脚本里 import 原语或其他模块 | 原语是注入全局；任何额外的顶层 `import`/`export` 都会被加载器拒绝。 |
| `meta` 里用了变量、展开或函数调用 | `meta` 必须是纯字面量。 |
| 将 `parallel`/`pipeline` 中所有失败等同处理 | 可恢复失败变 `null`；停止、预算耗尽和派发上限错误会中止。要求完整交付时须重试缺失结果或报告失败,仅允许部分结果时才过滤。 |
| 按"哪个 agent 先跑完"来分支 | 破坏可复现性；归并要保持顺序无关。 |
| 卡住或失败的运行从头重跑 | 用 `odw result <run> --agent <id>` 读出已完成的 agent；`odw stop`、修好脚本，再 `odw resume`——已完成的调用免费重放。 |
| 不看失败的 agent 做了什么就重试 | 先读它的 transcript——`odw logs <run> --agent <id\|label>` 会显示它的工具调用、结果、错误和 stderr 的结尾（ODW 扩展）——再修原因。 |
| 问 agent 是否完成了工作，或相信一个这么说的回复 | 用 `expect` 写明——`{ command: 'npm test', changes: true }`：odw 在回复后检查，把缺失项交还一次，仍未达到就以 `unmet_expectation` 和缺失项让该 agent 失败（ODW 扩展；`examples/fix-until-green.js`）。 |
| 把以 `permission` 失败的 agent 当成偶发问题重试，或忽略已完成 agent 上的 `denied` | 两者都列出了无头模式拒绝的工具调用（`denied: Bash (npm test)`）——它的回复可能建立在没能完成的工作上：请用户在适配器对应档位的 `permissionArgs` 里只放行这些，或给 agent 不需要它们的工作。 |
| 运行结束后在自己的文件里找隔离 agent 的修改 | 它们以 diff 保存，不会自动合并：先 `odw diff <run> --stat`，再 `odw apply <run> --agent <id> --check`，然后 `odw apply`。 |
| 用了 `validate()` 还指望脚本跑在 Claude Code 上 | `validate` 是 ODW 扩展，只能在 odw 上运行。 |
| 用了 `exec()` 还指望脚本跑在 Claude Code 上 | `exec` 是 ODW 扩展，只能在 odw 上运行；`validate()` 会对此给出 warning。 |
| 用了 `checkpoint()` 还指望脚本跑在 Claude Code 上 | `checkpoint` 是 ODW 扩展，只能在 odw 上运行；`validate()` 会对此给出 warning。 |
| 看运行像是卡住了，就自己批准了检查点 | 等待中的检查点由用户决定：给用户看 `odw status $RUN`，只有用户明确同意后才运行 `odw approve`/`odw reject`。 |
| 扇出的调研或审查 agent 能改文件 | 给这些 agent 传 `{ permissions: 'read' }`，或用 `odw run --permissions read`：它们只读取和报告，改不了工作树（ODW 扩展；claude、codex 或 gemini）。 |
| agent 被拒绝或被拦下时，转而用 `--permissions full` | `full` 去掉了沙箱和所有审批——先问用户。被拒绝的 `read` agent 需要的是一个支持只读的适配器。 |
| 把某个 CLI 的模型 ID 交给可能跑在别的 CLI 上的 agent（阶段默认值、回退链） | 模型 ID 不能跨 CLI 通用：用层级 `model: '@fast'`，它会为每个 CLI 选出自己的 ID（ODW 扩展）。 |
| 大规模扇出却不看它花了多少 | `odw status $RUN` 会显示运行到目前为止的 token 与花费，比 `fanOutWarn`（默认 25）更宽的 `parallel()`/`pipeline()` 会记一条警告（均为 ODW 扩展）。设了 `budget.total` 时按它决定扇出规模；`--budget` 限制输出 token。 |
| 自己手写一条包着 `odw run` 的 cron 行 | `odw schedule add` 会带上防重叠锁、日志和固定的 `PATH` 写好它——且只在用户要求时使用：它会改动用户的 crontab 或 LaunchAgents。 |
