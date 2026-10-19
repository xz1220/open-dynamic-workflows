# 测试、调试与评估工作流

[English](../../guides/testing-and-debugging.md) · 简体中文

在花钱之前把工作流做对，并在模型与 CLI 变化时保持它正确。

## 调试工作流(ODW 扩展)

工作流里某一步不对时,有三件工具可用——都不需要改工作流,也不需要为整次运行再付一次钱:

```bash
odw check wf.js                           # 能否加载?错误带行号、列号和代码片段
odw check wf.js --capabilities            # ……以及它用到的方言之外的名字:process、require、import( 等
odw run wf.js --help                      # 按 meta.input 打印它接受的 --args
odw replay $RUN --agent judge             # 把这一个 agent 作为一次小的新运行重跑
odw replay $RUN --agent judge --prompt @better.txt --adapter codex --model gpt-5
odw compare $RUN $REPLAY --agent judge    # 原 agent 与重跑并排对照
odw run wf.js --break Review              # 在阶段 "Review"(或该 label 的 agent)之前停下等决定
odw run wf.js --step                      # ……在每个阶段之前
```

**`odw check <script.js|名字> [--json]`** 按运行时的方式编译工作流——`meta` 按纯字面量解析,
检查 name、description 与 phases,编译脚本体但绝不执行——打印 `文件:行:列: error: …`,附上前后
几行源码和指向出错列的 `^`,然后是 `validate()` 给出的可移植性警告。能加载退出 0,否则退出 1。
解析错误照编译器的原话说,只在合适时附提示:只有类型注解、`interface` 或 `as` 出错时才提
TypeScript(不再对每个错误都这样说),非 `async` 回调里的 `await`,以及脚本在括号闭合前就结束了。
运行失败时的报错与 `validate()` 的错误里也带同样的位置。`--capabilities` 另外列出(只读源码、绝不执行)
脚本用到的 Claude Code 方言之外的标识符——`process`、`require`、`import(`、`globalThis`、`Function(`、
`eval`、`fetch`、`console`、定时器等——各带首次出现的行列号以及[严格脚本上下文](safety-and-trust.md#严格脚本上下文odw-扩展)
里有没有它,还有它调用的 ODW 扩展原语(`validate`、`exec`、`checkpoint`、`workflow.input`);`--json` 中为
`capabilities: { outOfDialect, extensions }`。它的提示——没检查是否为空的扇出 `.filter(Boolean)` 或按
agent 文本筛选的结果(见[校验输入,清点 null](../reference/workflow-api.md#校验输入清点-nullodw-扩展))——打印为
`文件:行:列: hint: …`,`--json` 中为 `hints`;它们从不改变退出码。

警告中还包括 ODW 没有、但 **Claude Code 有的限制**:源码字面量即可判定超过 4,096 项的
`parallel()` 或 `pipeline()`(数组字面量、`Array.from({ length: n })`、`Array(n)`、`[...Array(n)]`,
可经 `.map`/`.fill`/`.keys`),Claude Code 的运行时会报错拒绝——`parallel() on line 12 is given
5,000 items …`;以及不是纯字面量的 `meta`,Claude Code 会把它从补全中去掉(ODW 直接拒绝)。
它们只是警告:ODW 照样运行任意规模的扇出,`check` 仍退出 0。

**`odw replay <run> --agent <id|label>`** 把一次保存下来的 `agent()` 调用重新派发。每次调用开始
时都会保存它的输入(`agents/<id>.call.json`:脚本给出的提示词和选项、开始时所用的适配器、请求的
模型),隔离 agent 的 `agent_started` 事件还记下它的 worktree 检出的提交(`base`)。重跑是一次只
含这一个调用的新运行(`meta.json` 中 `origin: "replay"`、`replayOf: { runId, agentId, label,
base }`;其 `args` 只有 `{ replayOf }`,提示词与选项保存在运行目录的 `call.json` 里,不对外提供),沿用原调用的 label 与 phase,在原运行的目录下、用原运行的配置、权限档位、信任级别、不可信输入与
沙箱运行(触发器启动的运行,其 replay 也在严格脚本上下文中运行)——`worktree` agent 则检出原来的 base 提交,不管现在 HEAD 在哪里,所以它看到的代码与
原 agent 相同。`--prompt @文件|文本`、`--adapter` 与 `--model` 替换原值(每项改动都会打印出来);
它接受 `odw run` 的 `--wait`/`--fg`/`-d`/`--timeout`。它打印新运行的 id,以及把重跑与原 agent
配对的 `odw compare` 命令(按 label;同一运行里还有别的 agent 用同一 label 时按 id)。本版本之前的
运行没有保存调用,无法重跑(`odw rerun` 重跑整个工作流)。

**`odw run <wf> --break <阶段|label>[,…]`**(可重复)与 **`--step`** 让运行在指定阶段之前——嵌套
工作流的阶段可写标题或 `▸ 子工作流 · 标题`——以及在带指定 `label` 的 agent 之前停下等决定;
`--step` 则在每个阶段之前。断点就是运行自己发起的[检查点](checkpoints-and-questions.md#人工检查点odw-扩展),标题为
`Break before phase Review`(或 `… agent judge`),所以 `odw approve|reject`、看板与
[手机链接](dashboard.md#在手机上批准odw-扩展)都能回答它。它的 payload 是到此为止的运行情况:`{ before,
phasesDone, agents: { done, failed, running }, results: [最近 20 个,回复截到 300 字符], args }`。
`phase()` 在方言里是同步的、无法等待,所以等待的是该阶段的工作:此后调用的每个 `agent()`、
`exec()`、`workflow()` 和 `checkpoint()` 都会停住直到有答复;已经在跑的 agent 继续;断点等待期间
发出的同 label 调用共用同一个断点。

- **批准**——运行继续。
- **拒绝**——运行停止,与 `odw stop` 相同,原因里写明断点与你的备注。
- **批准并修改 payload**(`--edit`、`--payload`、看板)——只采用 `args`:当运行的 `args` 是对象或
  数组且修改后仍是同类时,原地修改它,于是答复之后对 `args` 的每次读取都看到修改。脚本此前已经
  读到的值保持不变——比如开头的 `const { x } = args`,以及被断点拦住的那次调用的参数(它的提示词在
  答复之前就已拼好;其后的调用会读到修改)。这是唯一不会让正在运行的脚本措手不及的改法;其他对
  `args` 的修改会被拒绝并记一行日志,运行照原样继续。修改只在本次运行内有效:`odw rerun`/`resume`
  仍从 `meta.json` 中的 args 开始。

没有匹配到任何东西的 `--break` 名字,会在运行结束时记入日志。

## 评估工作流(ODW 扩展)

改了提示词、模型分层或 CLI 之后,想知道工作流是否仍然把事情做对——可复现,并且在你用的每个
CLI 上都成立?把几个用例写进一个 eval 文件,`odw eval` 会让每个用例在每个适配器上各跑若干次,
并逐次判定:

```bash
odw eval review                          # .odw/evals/review.json;也可以给路径:odw eval examples/evals/routing.json
odw eval review --adapter claude,codex --repeats 5   # 覆盖文件里的 adapters 与 repeats
odw eval review --json --out today.json  # 以 JSON 输出报告(stdout 和文件)
odw eval review --baseline today.json    # 与之前的报告对比;有单元格退步时以 1 退出
```

```json
{
  "workflow": "review",
  "adapters": ["claude", "codex"],
  "repeats": 3,
  "concurrency": 2,
  "timeout": 900,
  "cases": [
    { "name": "small-diff", "args": { "diff": "…" },
      "checks": [
        { "state": "done" },
        { "path": "verdict", "equals": "approve" },
        { "path": "findings[0].file", "matches": "\\.ts$" },
        { "command": "jq -e '.findings | length < 5' \"$ODW_RESULT\"" },
        { "maxCostUsd": 0.5 }, { "maxSeconds": 300 }
      ] }
  ]
}
```

- **文件**:`workflow`(名字或路径,与 `odw run` 一样从运行 `odw eval` 的目录解析)、`cases`
  (`name`、`args`、`checks`),以及可选的 `adapters`(每个适配器都以运行默认适配器的身份跑完
  全部用例,等同 `odw run --adapter`;省略时用配置的默认适配器)、`repeats`(默认 1)、
  `concurrency`(同时进行的运行数,默认 1)、`budget`(token,作为每次运行的 `--budget`)、
  `timeout`(秒;到时仍在进行的运行会被停止并判为失败)、`name` 与 `description`。文件会被严格
  校验——未知字段、错误的路径或正则都会报错并指出位置——在任何运行开始之前。
- **检查**只看运行结果,不调用模型:`{ path, equals }`(深度相等)、`{ path, contains }`(子串,
  或数组中的某个元素)、`{ path, matches, flags? }`(正则;非字符串值按其 JSON 匹配)、
  `{ path, exists }`(`true`,或 `false` 表示"不存在")、`{ command, timeout? }`(在项目目录中由
  shell 执行并以 0 退出,环境变量 `ODW_RESULT`——存放结果 JSON 的文件——与 `ODW_RUN_ID` 已设置;
  默认 300 秒)、`{ state: "done" | "failed" | "stopped" }`、`{ maxCostUsd }`(花费未知即不通过)
  和 `{ maxSeconds }`(运行从开始到结束)。路径用点/方括号写法指向结果:`verdict`、
  `findings[0].file`、`["odd key"]`;`""` 表示整个结果。没写检查的用例默认 `{ "state": "done" }`;
  写了检查的用例只判这些检查,全部满足才算通过。
- **运行**:每个用例 × 适配器 × 重复都是运行目录里的一次真实运行,从当前目录启动,在 `meta.json`
  中标记 `origin: "eval"` 与 `eval: { name, case, adapter, repeat }`——`odw list` 和看板的运行摘要
  都会显示。同时最多 `concurrency` 个。每完成一次运行在 stderr 打印一行进度;Ctrl-C 会停止本次
  eval 启动的所有运行,不保存报告,并结束 `odw eval`。
- **表格**:每个用例 × 适配器一行——通过 k/n、耗时中位数、总花费与平均花费、平均 token;然后是
  总计;再列出每个失败的运行、它没通过的检查与运行 id——任意两次运行都可以用 `odw compare` 对照。
- **报告**(JSON,`version: 1`;`src/eval/report.ts` 列出每个字段)包含定义及其 sha256
  (`evalHash`)、工作流的 sha256、odw 版本、运行记录到的 CLI 版本、各单元格,以及每次运行的 id
  和失败项。报告保存在 `<runsRoot>/_evals/<name>/<id>.json`——`GET /api/evals` 列出、
  `GET /api/evals/:name/:id` 返回单份,均只读——并写到 `--out`。
- **`--baseline <report.json>`** 按用例与适配器把每个单元格与之前的报告对比:通过率、平均花费、
  耗时中位数,B − A。通过率下降的单元格即为退步。退出码:全部运行通过——或带 `--baseline` 时没有
  单元格退步——为 0;否则为 1;用法错误为 2(没有任何运行开始)。

## 测试工作流(ODW 扩展)

工作流就是代码:像测试代码一样测试它,不必每试一次都为模型付费。`odw test` 运行真实的运行时——
worker、调度器、schema 校验与重试、回退链、运行存储——并用你写好的脚本化回复应答每个 agent。
不调用任何模型;一次测试花费 $0,耗时不到一秒。

```bash
odw test                                  # 当前目录下所有 .odw/tests/*.json
odw test review-swarm                     # .odw/tests/review-swarm.json;或给路径:odw test examples/tests/review-swarm.json
odw test review-swarm --case 2 --json     # 只跑一个用例(编号或名字);报告以 JSON 输出
odw test review-swarm --keep              # 保留临时运行(odw logs <run_id> --runs-root …);或 --runs-root DIR
odw run review-swarm --record             # 一次真实运行,存为 .odw/tests/review-swarm.json 的一个用例(--record-to FILE)
odw run review-swarm --dry                # 每个 agent 都得到桩回复:阶段树与各阶段 agent 数,$0
odw new review-swarm                      # 模板连同起步测试,一开始就能通过(见上)
```

```json
{
  "workflow": "review-swarm",
  "cases": [
    { "name": "a real finding survives",
      "args": { "lenses": ["correctness", "security"] },
      "replies": [
        { "label": "map", "reply": { "summary": "adds a cache", "files": ["src/cache.ts"] } },
        { "label": "review:correctness", "reply": { "findings": [{ "title": "stale read", "severity": "high", "rationale": "…" }] } },
        { "label": "review:security", "fail": "rate_limit" },
        { "label": "verify:*", "reply": { "real": true, "reason": "confirmed" }, "schemaMiss": 1 }
      ],
      "expect": {
        "checks": [{ "path": "confirmed[0].title", "equals": "stale read" }],
        "agents": { "count": 4 },
        "logs": ["1 of 1 findings survived"]
      } }
  ]
}
```

- **文件**(`.odw/tests/<workflow>.json`;完整示例见 [`examples/tests/review-swarm.json`](../../../examples/tests/review-swarm.json)):
  `workflow`(名字或路径,与 `odw run` 一样从运行 `odw test` 的目录解析;缺省为文件名)、`cases`
  (`name`、`args`、`replies`、`expect`,以及可选的 `default`、`checkpoints: "approve" | "reject"`
  ——自动应答每个 `checkpoint()`、`timeout` 秒数,默认 120),以及文件级的 `default`。运行前会严格校验。
- **回复**按 `label`(glob:`verify:*`)、`phase`(glob)、`prompt`(子串)或 `adapter` 匹配 agent;
  条目给出的每个匹配条件都须成立,第一个匹配的条目作答。作答方式:`reply`(字符串原样,其他值按 JSON
  ——即 schema 调用的值)、`fail`(`rate_limit`、`quota`、`auth`、`permission`、`timeout`、`stalled`、
  `not_found`、`exit`:ODW 的失败分类会像真实失败一样识别它,因此限流会重试、额度用尽会回退)、
  `empty: true`(空回复)或 `dry: true`(`--dry` 的桩)。`schemaMiss: N` 先回 N 次任何 schema 都不接受的内容
  (触发 schema 重试),`delayMs` 延迟作答(控制完成顺序),`once: true` 只回答一个 agent 后即用完
  (同一标签的多个 agent 依次取用)。
- **没有任何条目匹配的 agent 会让用例失败**——`unscripted agent \`review:tests\` (agent #6, phase Review)`
  ——除非有 `default` 条目(不带匹配条件)应答它。
- **`expect`**:`state`(默认 `"done"`,或 `"failed"`、`"stopped"`)、`error`(运行错误中的子串)、
  `checks`(沿用 `odw eval` 的检查词汇:`{ path, equals | contains | matches | exists }`、`{ command }`、
  `{ state }`、`{ maxSeconds }`、`{ maxCostUsd }`——测试花费为 $0)、`agents: { count, labels }`
  (启动了多少个;恰好这些标签,顺序不限)以及 `logs`(`log()` 输出行中的子串,按此顺序)。
- **运行**放在临时运行存储中,结束后删除(`--keep`、`--runs-root DIR` 可保留),标记为 `origin: "test"`。
  `exec()` 步骤、`isolation: "worktree"` 等运行时的其余部分照常真实执行;只有 agent CLI 被替换。
  全部通过退出码 0,有失败为 1,用法错误为 2(什么都没运行)。
- **`odw run <wf> --record [--record-to FILE]`** 把一次真实运行存为回归固定用例:运行结束后,worker 追加
  一个名为 `recorded <run_id>` 的用例——运行输入、每个 agent 的实际回复(或其失败类别)、包含最终状态、
  结果(小于 8 KB 时)与 agent 数量的 `expect`。与运行自身的记录一样经过脱敏,每个字符串截断到 4,000 字符;
  同一标签但回复不同的 agent 各得一个 `once` 条目,按启动顺序排列。之后 `odw test` 以 $0 回放它。
- **`odw run <wf> --dry`** 让每个 agent 都由桩应答:`"(dry run)"`,或对 schema 调用给出其最小合法值
  (只含必需属性、`minItems` 个元素、`enum` 的第一个值、边界允许的最小数)。它会等待运行结束,然后打印阶段树
  ——每个阶段启动了多少 agent 及其标签——并在 `meta.json` 中标记 `dry: true`(看板的运行摘要带有 `dry: true`)。
  不需要安装任何适配器。
