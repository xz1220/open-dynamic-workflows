# 教程：从模板到你自己的工作流

[English](../tutorial.md) · 简体中文

README 的[快速开始](../../README.zh-CN.md#快速开始)以 $0 跑通了一个模板。本页接着往下：`odw new` 写出的模板、工作流脚本的编辑器补全，以及可以照抄的可运行示例。下一步：[工作流 API](reference/workflow-api.md) 与各篇[指南](README.md#指南)。

## 从模板开始(ODW 扩展)

`odw new` 从内置在二进制里的模板写出一个 workflow,所以只装了二进制也有这些模板;单独运行
`odw new` 会列出它们。

```bash
odw new review-swarm                    # .odw/workflows/review-swarm.js、.odw/tests/…、.odw/evals/…
odw new review-swarm --name pre-merge   # 同上,但命名为 pre-merge(workflow、测试与 eval 里都改名)
odw new hello --force                   # 覆盖内容不同的已有文件
odw new hello --yes                     # 同时写入建议的 .worktreeinclude(见下)
```

| 模板 | 作用 |
| --- | --- |
| `hello` | 两个 agent 并行描述这个仓库;纯 JS 留下更有把握的那个回答(只读) |
| `review-swarm` | 从多个角度并行审阅改动,逐条核实每个发现,只留下站得住的 |
| `fix-until-green` | agent 修复失败的测试;odw 自己跑测试来检查(`expect`),没达到就退回 |
| `plan-approve-execute` | 起草计划,在 `checkpoint()` 等人批准,再并行执行各步骤 |
| `pr-shepherd` | 把 PR 推到全绿:修复失败的 CI 和新的审阅评论、推送,标记为可审阅前先问人 |
| `fan-out-reduce` | 并行起草 N 个回答,再综合出最好的一个 |

- **写入什么**(在当前目录):`.odw/workflows/<名字>.js`(`odw run <名字>`)、
  `.odw/tests/<名字>.json`——带脚本化回复的起步用例,`odw test <名字>` 立刻通过,$0——以及
  `review-swarm` 与 `pr-shepherd` 的 eval 骨架 `.odw/evals/<名字>.json`(真实运行:先编辑再
  `odw eval <名字>`)。除 `hello` 外,模板就是同名的[示例](../../examples/)。
- **从不覆盖**内容不同的已有文件,除非加 `--force`:此时什么都不写,退出码 1。已经与模板
  完全相同的文件算作已写入,所以同一条命令跑两次没有副作用。
- **在没有 `.worktreeinclude` 的 git 仓库里**,它会为[隔离 worktree](guides/reviewing-and-applying.md#隔离-worktree-与-agent-端口)
  打印一份建议:仓库里的 `.env*` 文件(不含 `.env.example` 之类),以及根据 lockfile 推断的
  依赖目录的 `symlink:` 行(npm、yarn、pnpm、bun 对应 `node_modules`;uv、Poetry、Pipenv、PDM
  对应 `.venv`;Composer 对应 `vendor`)。加 `--yes`,或在终端里回答 yes 才写入;否则从不写。
- **`odw init`**(不带 `--check`)最后提供零成本的首跑:在终端里先询问,然后写入 `hello`(若
  `.odw/workflows/hello.js` 已存在则直接用它),带实时视图运行 `odw run hello --dry`,再打印
  `odw serve --open` 和真实的 `odw run hello`。不在终端时只打印这些命令。
- **它也写出 `odw types` 写的东西**(见下),编辑器立刻就能补全新 workflow;`--no-types` 不写。

## 编辑器补全:`odw types`(ODW 扩展)

workflow 脚本拿到的原语是全局变量,编辑器对 `agent()` 及其选项一无所知——除非项目里有方言的
类型声明。`odw types` 从内置在二进制里的副本写出它们(只装了二进制也有):

```bash
odw types                 # .odw/types/odw.d.ts + .odw/jsconfig.json(+ .claude/workflows/jsconfig.json)
odw types --dir editor    # 声明与 jsconfig.json 改写到 editor/ 下
odw types --force         # 连不是 odw 写的 jsconfig.json 也替换
```

- **`.odw/types/odw.d.ts`**:类型声明,文件头写着写出它的 odw 版本。每个 ODW 扩展都带
  `@remarks ODW extension`,悬停即可分辨 Claude Code 方言与只有 ODW 读取的扩展。
- **`.odw/jsconfig.json`**:`include` 覆盖声明、`.odw/workflows/**/*.js` 与
  `.claude/workflows/**/*.js`。`.claude/workflows` 存在时也给它写一份 `jsconfig.json`,
  因为编辑器只用离文件最近的配置。不是 odw 写的 `jsconfig.json` 原样保留,改为打印它需要的
  `include`。
- **`checkJs` 保持关闭**:类型检查器会把方言的顶层 `return` 报成错误(TS1108)。想检查某个
  脚本,就在它首行加 `// @ts-check`。
- **升级之后**,若 `.odw/types/odw.d.ts` 与当前 odw 的声明不一致,`odw doctor` 会警告;
  `odw types` 重写它。odw 自己不编译、不做类型检查。
- **从不穿过符号链接写入**:文件本身是符号链接、从项目往下的某级目录是符号链接,或其目录解析到
  项目之外时,不写——`odw types` 会说明是哪个并以 1 退出。每个文件先写入临时文件再改名覆盖。

## 示例

[`examples/`](../../examples/) 里是可运行的纯 JS workflow:

| Workflow | 形态 |
| --- | --- |
| [`deep-research.js`](../../examples/deep-research.js) | 扇出调研 → 对抗式事实核查 → 带引用报告 |
| [`deep-research-verified.js`](../../examples/deep-research-verified.js) | 实战版:定界 → 搜索 → 抓取 → 三票对抗核查 → 带引用综合,配可进 cron 的包装脚本([配方](../recipes/deep-research-verified.md)) |
| [`ultra-mode.js`](../../examples/ultra-mode.js) | 有纪律的深度工作循环:规划 → 并行攻坚 → 对抗评审 → 综合 |
| [`fan-out-reduce.js`](../../examples/fan-out-reduce.js) | 并行起草 N 份 → 综合出最佳 |
| [`adversarial-verify.js`](../../examples/adversarial-verify.js) | 产出发现 → 只保留扛住证伪的 |
| [`review-swarm.js`](../../examples/review-swarm.js) | 梳理改动 → 按 N 个视角并行审查 → 逐条独立验证(可换另一个 CLI)→ 带证据的分级报告 |
| [`loop-until-dry.js`](../../examples/loop-until-dry.js) | 循环扇出 finder,连续 K 轮无新发现才停 |
| [`routing.js`](../../examples/routing.js) | 给请求分类 → 路由到对应专家 → 给结果打分 |
| [`generate-and-filter.js`](../../examples/generate-and-filter.js) | 并行产出大量点子 → 去重 → 只留过 rubric 的 |
| [`tournament.js`](../../examples/tournament.js) | N 种思路各自解题 → 两两评判晋级 → 决出唯一胜者 |
| [`codex-claude-loop.js`](../../examples/codex-claude-loop.js) | 两个对家 CLI 回合制对弈:Claude 实现,Codex 评审,循环直到签收 |
| [`agent-daily-digest.js`](../../examples/agent-daily-digest.js) | 发现信息源 → 并行提取 → 综合 → 核查 |
| [`test-fix-loop.js`](../../examples/test-fix-loop.js) | 用 `exec()` 跑测试 → agent 修复失败 → 重跑直到全绿(仅 ODW) |
| [`fix-until-green.js`](../../examples/fix-until-green.js) | 同样的循环改用 `expect`:agent 回复后由 odw 跑测试,把仍然红的测试——或什么都没改的"修复"——交还给它,最后带着缺失项失败(仅 ODW) |
| [`plan-approve-execute.js`](../../examples/plan-approve-execute.js) | agent 起草计划 → 有人在 `checkpoint()` 处批准(附说明的拒绝会重新规划)→ 并行执行 → 汇报(仅 ODW) |
| [`pr-shepherd.js`](../../examples/pr-shepherd.js) | 给一个 PR 编号 → 用 `gh` 等待 CI → 隔离的修复 agent 处理红掉的检查和新的评审意见,由 `expect` 校验 → 修复推送到 PR 分支 → `gh pr ready` 之前先过 `checkpoint()`;从不合并,可用 `odw schedule` 定时运行(仅 ODW) |
| [`coordinated-refactor.js`](../../examples/coordinated-refactor.js) | 多个隔离分支在笔记板上并行修改同一仓库,每个分支落地时广播其接口改动 → 审阅者指出相互冲突的分支 → 这些分支在知道别人改了什么之后重跑(仅 ODW) |
