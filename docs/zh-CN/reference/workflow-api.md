# 工作流 API 参考

[English](../../reference/workflow-api.md) · 简体中文

工作流脚本能调用什么。每个原语的全部选项见 skill 的[原语参考](../../../skills/open-dynamic-workflows/zh-CN/references/primitives.md)；只有 ODW 才有的原语与选项都标注了 **ODW 扩展**。

## 编程原语

一个 workflow = `export const meta = {…}` + 一段运行在 async 上下文里的脚本体。脚本体
用普通 JS 控制流(循环、`if`、去重)把这些**注入的全局**串起来——无需 import:

| 原语 | 作用 |
| --- | --- |
| `agent(prompt, opts?)` | 让一个 coding agent 跑一个子任务。唯一真正"产出工作"的原语。返回文本;设了 `opts.schema` 则返回校验过的对象。设了 `opts.expect` 时,它的工作会被检查——某条命令以 0 退出、有文件改动、回复匹配——没达到就带着缺失项重试;见[检查 agent 的工作](#检查-agent-的工作odw-扩展)(**ODW 扩展**)。 |
| `parallel(thunks)` | 一组任务并发执行、**等全部完成**(屏障)。可恢复失败变 `null`;停止、预算耗尽和派发上限错误会中止运行。`parallel(thunks, { notes: true })` 让其 agent 使用本次运行的笔记板——见[并行 agent 之间的笔记](#并行-agent-之间的笔记odw-扩展)(**ODW 扩展**)。 |
| `pipeline(items, ...stages)` | 每个条目独立穿过各 stage(**无屏障**)。每个 stage 收 `(prev, item, index)`。 |
| `phase(title, opts?)` / `log(msg)` | 把进度归入某阶段 / 发一行进度消息。`opts`——`{ adapter, model }`——为该阶段的 agent 指定适配器和模型(**ODW 扩展**;见[按阶段路由](../guides/adapters-and-models.md#按阶段路由与回退链odw-扩展))。 |
| `schema`(JSON Schema) | 给 `agent` 的输出定一个类型契约;回复会被校验,不符就重试。ODW 无法检查的关键字会记入运行日志(设 `"schemaKeywords": "strict"` 则让调用失败);会校验 schema 的 CLI(`claude`、`codex`)直接原生强制执行——见[结构化输出](../guides/adapters-and-models.md#结构化输出odw-扩展)。 |
| `args` | workflow 的输入,原样注入。 |
| `budget` | `{ total, spent(), remaining() }`——按 token 目标动态扩缩深度。 |
| `workflow(ref, args?)` | 内联调用另一个 workflow(仅一层)。子 workflow 共享本次运行的并发上限、agent 计数与预算;其 phase 以独立泳道归组。 |
| `validate(source)` | 解析并编译检查可信源码,不运行工作流正文;元数据按纯字面量解析,不会被求值。**ODW 扩展**(不属于 Claude Code 方言)。 |
| `exec(command, opts?)` | 不启动模型直接运行一条命令——测试、构建、linter;返回 `{ stdout, stderr, exitCode, signal, timedOut, truncated, durationMs }`。字符串经 shell 执行,数组按 argv 执行。受 `timeout`(600 秒)和 `maxOutputBytes`(每个输出流 8 MiB)约束;停止会杀掉它。不占 agent 槽位。**ODW 扩展**(不属于 Claude Code 方言)。 |
| `checkpoint(title, opts?)` | 暂停运行,直到有人批准(可以附上修改后的 payload)或拒绝——用 `odw approve\|reject` 或看板——然后返回 `{ approved, note, by, payload, edited }`。`opts`:`payload`(要给人看的内容)、`schema`(修改必须满足的 JSON Schema)、`timeout`(秒)和 `onTimeout`(`"approve"`、`"reject"`,或默认的 `"fail"`)。不占 agent 槽位;停止依然会结束运行。见[人工检查点](../guides/checkpoints-and-questions.md#人工检查点odw-扩展)。**ODW 扩展**(不属于 Claude Code 方言)。 |

下一步需要"全量结果一次到位"(去重、计票、综合)时用 **`parallel`**;多阶段处理默认用
**`pipeline`**。归并要保持顺序无关——按"谁先跑完"分支会破坏可复现性。完整参考见
[`skills/open-dynamic-workflows/references/primitives.md`](../../../skills/open-dynamic-workflows/references/primitives.md)。

### 检查 agent 的工作(ODW 扩展)

无头运行的 agent 可能"成功"了却没干活:说修好了 bug,其实一个文件都没碰;说测试通过了,
其实还是红的。与其问模型"你做了吗",不如写明必须成立的条件——agent 回复之后(若设了
`schema`,则在校验通过之后),由 odw 来检查:

```js
const summary = await agent('Fix the failing tests in src/parser.', {
  expect: {
    command: 'npm test',        // 必须在 agent 的工作区里以 0 退出(超时 600 秒)
    changes: true,              // 必须有文件改动(false:不许有任何改动)
    files: ['src/parser/**'],   // 每个 glob 都必须匹配到一个被改动或新建的文件
    match: '^Fixed',            // 回复必须匹配的正则表达式
    mcp: ['github'],            // CLI 启动 agent 时必须连上的 MCP 服务器(claude)
    untouched: ['test/**', '**/*.snap', '.github/**'], // 匹配这些 glob 的文件一个都不许改
  },
})
```

没达到要求的工作会重跑——默认一次(`expectRetries`,可按调用或在配置里设)——并把缺失项
追加到提示词里,失败命令的输出也一并附上。仍未达到时,`agent()` 抛出一个可恢复的错误
(在 `parallel()` 里变成 `null`),带有 `reason: "unmet_expectation"` 和逐条列出的
`misses`——它的 `agent_failed` 事件、`odw logs`、实时视图和 `/api/runs/:id` 也都带着它们:

```text
agent_failed    (Fix) fixer — [unmet_expectation] did not meet: `npm test` must exit 0, and it exited with code 1
```

- **agent 改了什么**从 git 读取,路径相对于它的工作区。原地运行时,是与 agent 启动前的
  源码树相比的差异——你自己未提交的改动和 odw 的运行目录不算,agent 的提交算——所以同时
  原地运行的其他 agent 的改动也会算进来:在意这一点就用隔离。用 `isolation: "worktree"`
  时,就是 odw 作为该 agent 的 diff 保留的那份改动,而重试会在全新的 worktree 里从头开始,
  它的改动取代先前的改动。
- **命令**作为 agent 名下的一个 `exec()` 步骤运行(它的事件带 `forAgentId`),在读取改动
  之后执行,所以它写出的文件绝不会被算成 agent 的工作;停止会杀掉它。
- **有[回退链](../guides/adapters-and-models.md#按阶段路由与回退链odw-扩展)时,**缺失项在做出这份工作的
  适配器上重试——缺失绝不会触发回退。因额度用尽或登录被拒而换到下一个适配器的调用会带着
  它的 `expect`:下一个适配器从头开始这项工作,有自己的 `expectRetries`——隔离运行时在全新的
  worktree 里;原地运行时,对照调用开始之前的源码树来判断。
- **被拒绝的工具调用算作一项缺失。** 在默认的 `edit` 档位下,Claude Code 无头运行时会拒绝
  所有不在允许列表里的 shell 命令;设了 `expect` 时,`result` 里列出 `permission_denials`
  的回复会像任何缺失一样交还给 agent,之后以 `reason: "permission"` 失败,并列出被拒绝的
  调用。没设 `expect` 时回复照常成立——见下一条。
- **无需开启:**空回复以 `reason: "empty_reply"` 失败(`allowEmpty: true` 接受空回复)。
  CLI 拒绝了工具调用、但回复照常成立的 agent,会把它们作为 `denied` 记在它的
  `agent_finished` 事件、保存的结果和 `/api/runs/:id` 上,运行还会记一行日志:
  `search:3: Claude Code refused 2 tool calls — Bash (npm test); …; its reply may rest on
  work it could not do (raise its tier with --permissions or allowlist the tool)`。
  `"permissionDenials": "fail"`(或适配器自己的 `permissionDenials`)则让这样的 agent 以
  `reason: "permission"` 失败。
- **没启动起来的 MCP 服务器。** Claude Code 的输出流以一个 init 事件开头,列出它为 agent
  启动的 MCP 服务器;启动失败的服务器会让 agent 用不了它的工具,而 agent 仍可能说"完成了"。
  每个状态不是 `connected` 的服务器都作为 `mcp: [{ name, status }]` 记在 agent 的
  `agent_finished`(或 `agent_failed`)事件、保存的结果和 `/api/runs/:id` 上,运行按服务器
  和状态各记一行日志(每次运行一次):``MCP server github failed to start (claude agent
  `fix-auth`): its tools were unavailable``。回复照常成立——Claude Code 自己也只是警告——
  除非 `"mcpFailures": "fail"`,它让服务器为 `failed` 或 `needs-auth` 的 agent 以
  `reason: "mcp_unavailable"` 失败。`expect: { mcp: [...] }` 则把列出的服务器缺席——
  `failed`、`needs-auth`、`disabled` 或没有配置——算作一项缺失,重试后以
  `unmet_expectation` 失败。`pending` 两者都不算:Claude Code 的文档说不要把它单独当作
  失败(`.mcp.json` 里的服务器通常以这个状态启动,并在后台连接)。
- **受保护的路径不许碰。** agent 会钻考核它的检查的空子:为了变绿去改、跳过或删除测试。
  `untouched` 列出 glob(规则同 `files`:`*` 不跨目录,`**/*.snap` 匹配任意深度),agent
  修改、新建或删除的文件都不许匹配——读取方式同 `changes`,所以原地运行时你在调用之前的
  改动不算。碰到的路径算作一项缺失并被列出——``no file matching "test/**" may change, and
  1 did: test/add.test.js``——重试时会要求 agent 把它们恢复原样。
- **被丢下仍在运行的后台任务。** 无头模式下 agent 可以启动后台 shell 命令
  (`run_in_background`)或子 agent,随后结束回合并退出:任务随 CLI 一起终止,结果却显示成功
  ([claude-code#85129](https://github.com/anthropics/claude-code/issues/85129))。odw 跟踪
  Claude Code stream-json 的任务事件(`task_started`、`task_updated`、`task_notification`)
  和后台工具调用;到 `result` 事件时仍未结束的任务作为 `orphaned` 记在 agent 的
  `agent_finished` 事件、保存的结果、`/api/runs/:id` 和看板侧栏上,运行为每个 agent 记一行
  日志:`serve:1: Claude Code ended its turn with 1 background task still running — Bash
  (Start the dev server); it died when the CLI exited, …`。回复照常成立(默认
  `"orphanedBackground": "warn"`);`"orphanedBackground": "fail"` 让这样的 agent 以
  `reason: "orphaned_background"` 失败;设了 `expect` 时它算作一项缺失——先交还给 agent
  (要求它等所有后台命令和子 agent 结束后再回复),之后以 `orphaned_background` 失败。任何
  JSONL 适配器都可以用 `output.background` 声明自己 CLI 的后台事件(见适配器参考)。

Claude Code 的 Workflow 工具会忽略 `expect`,在那里检查不会执行。
[`examples/fix-until-green.js`](../../../examples/fix-until-green.js) 用 `expect` 驱动一个
"修到测试通过为止"的循环。

### 并行 agent 之间的笔记(ODW 扩展)

并行的编程 agent 常常各自通过、合在一起却出错:一个把函数改了名,另一个还在调用旧名字。只要
告诉它们同时发生的改动是什么,大多数冲突就能避免——所以 odw 为每次运行提供一块**笔记板**,
默认关闭:

```js
const lanes = await parallel(tasks.map((t, i) => () =>
  agent(t, { label: `lane-${i + 1}`, isolation: 'worktree' })), { notes: true })
const review = await agent('Which lanes clash?', { notes: true, schema: CLASHES })
```

- **何时打开:** `agent(…, { notes: true })`、`parallel(thunks, { notes: true })` 启动的每个
  agent,或配置中 `"notes": true` 时运行的每个 agent。`notes: false` 让单个 agent 退出。默认
  关闭:Claude Code 工作流照原样运行。
- **发布:** 打开笔记的 agent 会得到 `ODW_NOTES`——一个属于它自己的小 shell 脚本的路径,提示词里
  会说明用法:`"$ODW_NOTES" "把 parseX 改名为 parse"` 发布一条笔记;装了 odw 的地方
  `odw note "…"` 作用相同(读取 agent 的 `ODW_RUN_ID`、`ODW_AGENT_ID` 与 `ODW_NOTES`)。笔记由谁
  发布,取决于放下它的是哪个 agent 的脚本,而不是笔记里写了什么。
- **读取:** agent 启动前已发布的笔记写在它的提示词里,标题为"Notes from the other agents in this
  run"(取放得下 8000 字符的最新几条)。新笔记不会推送给已在运行的 agent——CLI 只读一次提示词——
  但不带参数的 `"$ODW_NOTES"` 会打印笔记板的当前内容,提示词里也写明了这一点。
- **接口广播:** 打开笔记且 `isolation: "worktree"` 的 agent 带着保留的改动完成时,odw 在其
  `agent_finished` 事件之前替它发布一条笔记,让脚本之后启动的 agent 都能看到:diff 统计、改到的
  文件,以及 diff 中新增或删除的、看起来像声明的行(`export`、`def`、`func`、`pub fn`、`class`、
  `interface`——一个适用于各种语言的廉价启发式,最多 12 行)。
- **上限:** 每条笔记最多 2000 字符,并像运行事件一样脱敏;笔记板最多 200 条、256 KiB,满了运行
  会说一次。笔记保存在运行目录的 `notes.jsonl`。
- **在容器沙箱中** 脚本照常可用:agent 自己的收件箱以读写方式绑定,它的脚本和笔记板以只读方式
  绑定——容器里没有其他 agent 的收件箱可写。worker 只从「确实是它所建位置上的真实目录」的收件箱里取
  普通文件,从不跟随链接、也不会卡在 FIFO 上,所以 agent 放进去的任何东西都不能让宿主机读取或删除
  别处的文件。
- **查看:** `odw notes $RUN [--json]`、`odw logs` 中的 `note_added` 事件,以及
  `GET /api/runs/:id/notes`。

Claude Code 的 Workflow 工具会忽略这些选项。[`examples/coordinated-refactor.js`](../../../examples/coordinated-refactor.js)
把一项改动拆成在笔记板上并行的隔离分支,由审阅者读取笔记板,再让相互冲突的分支带着全部笔记重跑。

### 工作流记忆(ODW 扩展)

每次运行都从零开始:一个人在上一次运行里做的纠正,下一次运行还会再犯。工作流记忆把一个工作流
历次运行学到的东西**存在仓库里**,即 `.odw/memory/<工作流>.jsonl`,像其他文件一样在 PR 里审阅。
默认关闭;其中没有任何内容出自模型总结,只来自明确的来源:

| 来源 | 条目 |
| --- | --- |
| `"$ODW_NOTES" --keep "…"` 或 `odw note --keep [--paths GLOB,…] "…"`(开启笔记的 agent) | `note`,记该 agent——只在该 agent 开启记忆时保留(否则只发布、不保留,并记日志) |
| 带备注被拒绝的 `checkpoint()` | `correction`:`"Ship the plan?" was rejected: <备注>` |
| 修改 payload 后批准的 `checkpoint()` | `correction`:修改的结构化 diff,如 `$.steps[1]: "b" → "c"; removed $.owner` |
| 同一 agent 的重试补上了的 `expect` 未达项 | `lesson`:缺了什么,以及被告知后的重试补上了它(附它保留的改动) |
| `odw memory add <wf> "…" [--paths GLOB,…]` | 手工添加的 `note`(或 `--kind correction\|lesson`) |

每行是 `{ id, text, kind, paths, commit, run, agent?, at }`:`commit` 是学到时的 HEAD,`paths`
是它涉及的 glob(相对仓库根目录)。每种条目都只在开启记忆时保留——配置 `"memory": true`、
对该 agent 保留的笔记与教训用 `agent(…, { memory: true })`、对检查点的纠正用 `checkpoint(…, { memory: true })`
或 `{ memory: { paths: ['src/**'] } }`。

```js
const plan = await checkpoint('Ship this plan?', { payload: draft, memory: { paths: ['src/api/**'] } })
await agent('Implement the approved plan.', { memory: true, expect: { command: 'npm test' } })
```

- **召回:** 开启记忆的 agent(`agent(…, { memory: true })` 或该设置;`memory: false` 让单个 agent
  退出)在任务之前看到仍然适用的条目,标题为 "What earlier runs of this workflow learned",最新的在前,
  至多 4 KB;每条标明种类与来源(运行与 agent,或"手工添加"),正文逐行以 `> ` 引用。运行日志说明
  召回了多少、略去了多少。
- **过期:** 条目的 `paths` 匹配的文件在其 `commit` 与 HEAD 之间有改动(`git diff --name-only
  <commit> HEAD`)即过期,不再召回。没有 paths 的条目永不过期;有 paths 但 git 不认识其提交的条目
  视为过期——没有东西能为它作证。每个文件至多检查 32 个不同的提交(最新条目的优先),其余提交上的条目
  视为过期;超过 4 MiB 的文件不读取,运行、`odw memory list` 与 API 都会说明。
- **运行结束时保存**——无论完成、失败还是被停止——并经运行的脱敏器处理。同一条目再次学到时替换旧的
  那条;每个文件至多 500 条,超出时删去最旧的并记一行日志。`odw test` 与 `--dry` 运行会召回但不保存。
- **不受信任的运行**既不召回也不保存仓库里的记忆:那个文件是仓库的内容,而不受信任的运行学到的东西
  会进入之后受信任运行的提示词。用户放在仓库之外的记忆——在自己的配置里写 `"memoryDir":
  "~/odw-memory/my-repo"`——属于用户自己,不受信任的运行也会使用:前提是它按字面路径和解析链接后
  都在仓库之外;仓库自己的配置设置的 `memoryDir` 一律不算。
- **维护:** `odw memory list [<wf>] [--stale] [--json]`、`odw memory add <wf> "内容" [--paths …]`、
  `odw memory prune [<wf>] --stale` 或 `odw memory prune <wf> --id N`(`--source DIR` 指定仓库);
  `GET /api/memory[?workflow=]` 返回同样的列表。

Claude Code 的 Workflow 工具会忽略这些选项。

### 声明范围(ODW 扩展)

两个 agent 指向同一批文件,改动直到合并时才冲突。事先声明每个 agent 打算改哪些文件,odw 就能把
它们分开——主要做法是让会相撞的 agent 先后运行:

```js
await parallel([
  () => agent('Refactor the login flow.', { label: 'refactor-login', scope: ['src/auth/**'] }),
  () => agent('Fix the token expiry bug.', { label: 'fix-auth', scope: ['src/auth/token.ts'] }),
  () => agent('Document the parser.', { label: 'docs', scope: ['docs/parser.md', 'src/parser/**/*.md'] }),
])
```

- **`scope`** 是相对 agent 工作区的一组 glob,规则同 `expect`(`*` 不跨目录、`**` 跨目录、
  `{a,b}`、`[…]`)。不设 `scope` 的调用行为不变。
- **范围重叠的调用先后运行。** 一个声明了范围的调用发出时,若更早发出、尚未结束的调用范围与它重叠,
  它就等那个调用结束——等待期间不占槽位——运行为每次等待记一行日志:`fix-auth waits for
  refactor-login: fix-auth declares src/auth/token.ts, refactor-login src/auth/**`(或 `both
  declare src/auth/**`;日志事件带 `scopeWait: { for, globs }`)。其余调用照常运行。这适用于
  任何同时在途的调用——`parallel()`、`pipeline()` 扇出,或没有 `await` 就发出的调用——而且一个调用
  只会等它之前发出的调用。上例中 `fix-auth` 在 `refactor-login` 完成后才运行,`docs` 与它们并行。
- **重叠如何判定**——只看 glob,保守判定(拿不准就算重叠,代价只是多串行):先展开 `{a,b}`;两个
  字面路径相同才重叠;字面路径与 glob,glob 匹配该路径即重叠;两个 glob,一个的字面前缀(第一个
  通配符之前的文字)以另一个的字面前缀开头即重叠。因此 `src/auth/**` 与 `src/auth/*.ts` 重叠,
  `src/auth/**` 与 `src/db/**` 不重叠,`src/*.ts` 与 `src/*.md` 重叠(通配符之后的部分不比较),
  `**` 与一切重叠。
- **越出范围的写入会被标出。** agent 回复后,它的改动——按 `expect` 的方式读取:隔离 agent 看它的
  worktree,原地 agent 看调用开始以来的改动——与其范围比较。范围之外的文件记为 `outOfScope`,
  出现在 `agent_finished`(或 `agent_failed`)事件、保存的结果、`/api/runs/:id`、`odw agents`
  (值前显示 `[outside scope: …]`;`--json` 含 `scope` 与 `outOfScope`)和看板侧栏中,并记一行
  日志:`fix-auth:2: wrote 1 file outside its scope (src/auth/token.ts) — package.json`。打开笔记时
  (见[并行 agent 之间的笔记](#并行-agent-之间的笔记odw-扩展)),笔记板上也会贴一条,让脚本之后
  启动的 agent 知道。
- **`scopePolicy`**——调用自己的,否则取 `"scopePolicy"` 设置——默认 `"warn"`:回复照常有效。
  `"fail"` 让这样的 agent 以 `reason: "out_of_scope"` 失败,不重试。设了 `expect` 时,越出范围的
  写入无论如何都算一项缺失:先交还给 agent(恢复那些文件、把改动留在范围内),之后以
  `unmet_expectation` 失败。运行的 setup 记录 `scopePolicy`,供 `odw compare` 使用。
- **原地运行时**源码树是共享的:落在同时运行的另一个已声明范围的调用之范围内的文件算那个调用的,不计入
  本调用。同时运行、未声明范围的调用所做的改动仍会计入——要精确结果请用隔离。不在 git 仓库中时
  无从读取:agent 照常运行、不做检查,运行会说明这一点。

Claude Code 的 Workflow 工具会忽略 `scope` 与 `scopePolicy`:在那里这些调用按原样一起运行。

## 校验输入,清点 null(ODW 扩展)

两类小错误会让工作流「成功地什么都没做」:`args` 形状不对(数组被当成一串 JSON 字符串传进来,
扇出按字符展开),以及大半为 `null` 的扇出被当作成功继续往下走。

**`meta.input`** 用 JSON Schema 声明 `args` 的形状——与 `agent()` 的 schema 用同一个校验子集
(`type`、`enum`、`properties`、`required`、`additionalProperties: false`、`items`、`minItems`;
`description` 与 `default` 只用于展示,不会被应用)。其他关键字在加载工作流时就会被拒绝,所以声明了
的约束不会悄悄不被检查。Claude Code 会忽略 `meta.input`。

```js
export const meta = {
  name: 'triage',
  description: 'Triage the open issues of some repositories',
  input: {
    type: 'object',
    properties: { repos: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'owner/name' } },
    required: ['repos'],
  },
}
```

`odw run`、`rerun`、`resume`、定时任务(`odw schedule add` 时也会检查)和触发器(返回 `422`)都在
运行创建之前校验 `args`,并逐个指出出错的路径——`$.repos: expected array, got string — it looks
encoded twice: …`(看起来被多编码了一次)。odw 不会替你自动解码。`odw run triage --help` 打印工作流
接受的参数。嵌套的 `workflow()` 调用不做校验。

**扇出健康度。** 每个结束的 `parallel()` 与 `pipeline()` 都会写一条 `fanout_done` 事件——多少个
槽位成功、失败(按失败原因计:`rate_limit`、`timeout` 等)或为 `null`——`odw logs`、实时视图和
仪表盘(运行头部的一个标签,有扇出大半为 null 时显示为琥珀色)都会显示。超过一半为 null 时运行会记
一行日志。`parallel(thunks, { minOk })` 把它变成错误:一个数量、thunk 数的一个比例(`0.8`)或
`"all"`——成功数不足时调用抛出带计数的 `FanOutShortfall`,而不是带着 null 返回。不写 `minOk` 时
行为不变:失败的槽位为 `null`,与 Claude Code 一致。

`odw check` 针对同样的错误增加两条提示(从不让检查失败):对 `parallel()`/`pipeline()` 结果
`.filter(Boolean)` 之后没有检查长度的;按 agent 写下的内容筛选出的列表(按它的某个字段 `.filter()`)
之后没有检查是否为空的——agent 的文本一个都没匹配上时,后续步骤什么都没做,运行看上去却像通过了。
