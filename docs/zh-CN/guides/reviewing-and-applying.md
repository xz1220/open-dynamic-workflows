# 审阅与应用改动

[English](../../guides/reviewing-and-applying.md) · 简体中文

使用 `isolation: "worktree"` 的 agent 在自己的检出上工作；它们的改动以 diff 的形式保留，由你审阅并落地。

## 隔离 worktree 与 agent 端口

`agent(prompt, { isolation: "worktree" })` 让这个 agent 在一个一次性的 git worktree 里
运行:它是 HEAD 的干净检出,没有你源目录里的 `.env`、`.venv` 或 `node_modules`。agent
启动前,有两样东西把它准备好:

- **`.worktreeinclude`**:放在仓库根目录(Claude Code 也读这个文件),用 `.gitignore`
  语法列出要带进来的东西。git 不跟踪、且被某一行匹配到的每个文件或目录都会复制进
  worktree(Claude Code 只复制被 gitignore 的文件;ODW 连单纯未跟踪的文件也复制)。
  `.git` 永远不复制,超过 100 MB 的文件会被跳过并记一行日志。`symlink:` 前缀(**ODW
  扩展**)把该行匹配到的东西链接过去而不是复制:对大目录瞬间完成,但它是共享的——agent
  往里写的东西会落到你的源目录。
- **`worktreeSetup`**(**ODW 扩展**):文件就位后在 agent 的工作区里运行,字符串交给
  平台 shell,数组作为 argv。超过 `worktreeSetupTimeout` 秒(默认 600)就会被杀掉;
  setup 失败或超时,失败的是这个 agent 而不是整个运行,错误里带着它输出的结尾。
- **`worktreeTeardown`**(**ODW 扩展**)与之相对:在 worktree 删除之前、在同一个工作区里、带着
  同样的变量运行——不论 agent 成功、失败还是被停止(`odw stop`、worker 收到信号),setup 中途
  失败时也会运行。超过 `worktreeTeardownTimeout` 秒(默认 120)就会被杀掉;失败或超时只在该
  agent 名下记一行日志,不影响 agent 的结果。

```gitignore
# .worktreeinclude
.env
.env.local
config/secrets.json
symlink: node_modules
```

```jsonc
{
  "worktreeSetup": "npm run codegen", // 或一个 argv,例如 ["uv", "sync"]
  "worktreeSetupTimeout": 600,
  "portRange": [41000, 41999]
}
```

每个 agent 进程——不论是否隔离——还会拿到 `ODW_RUN_ID`、`ODW_AGENT_ID` 和 `ODW_PORT`
(**ODW 扩展**)。`ODW_PORT` 来自 `portRange`:本次运行中没有其他正在运行的 agent 占用
它(已经有程序在监听的端口会被跳过),并且直到这次调用结束都归这个 agent 所有。所以并排
运行的 agent 可以各自起一个 dev server:

```js
await parallel(['grid', 'list'].map((layout) => () =>
  agent(`Build the ${layout} layout, start the dev server on port $ODW_PORT and check that the page renders.`,
    { isolation: 'worktree', label: layout })))
```

请让这类 agent 在结束前停掉自己启动的服务:agent CLI 退出前可能会等它自己的后台命令
(`claude -p` 就会),于是 agent——连同它的端口——会一直被占着,直到卡死看门狗或超时结束它。

setup 命令拿到同样的三个变量,`exec()` 命令拿到 `ODW_RUN_ID`。请让 `portRange` 比
`concurrency` 更宽:如果其他 agent 占满了所有端口,新启动的 agent 就不带 `ODW_PORT`
运行,运行日志里会说明。一次调用的每次尝试(schema 重试、卡死重启、限流重试)都从一个新的
worktree 开始,并以同样方式准备。

隔离 agent 还会拿到 `ODW_SLOT`(**ODW 扩展**):`odw-<run>-<agent>`——运行 id 的随机部分加
agent id,例如 `odw-a1b2c3-4`——只含小写字母、数字和连字符,在这次调用的每次尝试、它的 setup
和 teardown 中都相同。`COMPOSE_PROJECT_NAME` 被设为它——即使你自己设置了,也会被覆盖,运行日志会
说明一次——于是在 worktree 里执行 `docker compose` 操作的就是这个 agent 自己的那套栈,不会是你的,
并行的 agent 也不会共用一套。尽管如此,仍请显式指定项目名(`docker compose -p "$ODW_SLOT" …`),
如下面的配方所示。它也可以用作数据库名或卷名前缀(不允许连字符的地方加引号,或把连字符换成下划线)。

### 配方:每个 agent 一套 compose 栈和独立数据库

每个隔离 agent 在自己的端口上起自己的服务,并在 worktree 删除前把它们连同卷一起拆掉——
不论成功、失败还是被停止:

```yaml
# compose.yaml —— 项目名在命令行上指定:-p "$ODW_SLOT"
services:
  db:
    image: postgres:16
    environment: { POSTGRES_PASSWORD: dev, POSTGRES_DB: app }
    volumes: [data:/var/lib/postgresql/data]
  app:
    build: .
    ports: ["${ODW_PORT}:3000"]
    environment: { DATABASE_URL: "postgres://postgres:dev@db:5432/app" }
    depends_on: [db]
volumes:
  data: {}
```

```jsonc
{
  "worktreeSetup": "docker compose -p \"$ODW_SLOT\" up -d --wait && npm run migrate",
  "worktreeTeardown": "docker compose -p \"$ODW_SLOT\" down -v --remove-orphans",
  "worktreeTeardownTimeout": 120
}
```

```js
await parallel(['grid', 'list'].map((layout) => () =>
  agent(`Build the ${layout} layout; the app runs on http://localhost:$ODW_PORT with its own database.`,
    { isolation: 'worktree', label: layout })))
```

这样迁移只会落到这个 agent 自己的数据库,不会碰共享库;teardown 的 `down -v` 也只删除这个 agent
的栈和卷——不论环境里有什么,`-p "$ODW_SLOT"` 都指定了它。worker 被直接杀掉(SIGKILL、第二次信号)
时,teardown 来不及运行:`odw gc` 会列出所属运行已不再活跃的 `odw-*` compose 项目,并给出要执行的
`docker compose -p <name> down -v`——它自己从不删除。ODW 不克隆数据库,也不管理不是它启动的服务。

## 审阅并应用隔离 agent 的改动(ODW 扩展)

隔离 agent 的 worktree 会在调用结束时删除,但它的工作不会丢:删除之前,ODW 把这个 agent
的改动——修改、新增、删除、重命名和二进制文件,不论是否暂存或提交——以统一 diff 的形式
保存在 run 目录里(`agents/<agentId>.diff`),并把改动规模
`changes: { files, insertions, deletions, truncated }` 记在该 agent 的 `agent_finished`
事件和已保存结果上。`agent()` 返回的仍是回复。`.worktreeinclude` 放进来的、`worktreeSetup`
生成的东西不算 agent 的改动,不会出现在 diff 里——除非 agent 之后又改了它们。

```bash
odw diff $RUN --stat               # 谁改了什么:文件数、增删行数、保留的分支
odw diff $RUN --agent fix:auth     # 某个 agent 的 diff(按 label 或 id)——git 能读的补丁
odw apply $RUN --agent 3 --check   # 预览:每个文件是 clean、CONFLICT(附冲突行)还是 already applied
odw apply $RUN --agent 3           # 用 git apply --3way 应用到当前工作树
odw apply $RUN --all --check       # 预览所有已完成的 agent,每个都叠在前面的之上
odw apply $RUN --all --verify "npm test"   # 按顺序应用;校验失败的那个回滚
odw apply $RUN --all --resolve --verify "npm test"   # 由 agent 解决冲突;校验通过后才应用
odw apply $RUN --all --pr --verify "npm test"   # 新分支、每个 agent 一个提交、推送、开草稿 PR(gh)
```

`odw apply` 在你所在的 git 工作树里用 `git apply --3way` 应用一个 agent 的 diff——加
`--all` 则按 agentId 顺序应用所有已完成 agent 的 diff:能应用的部分会被暂存。动手之前,它先在
索引的临时副本上做同样的应用,逐个文件给出 `clean`、`CONFLICT`(附上合并后会留在文件里的冲突行,
或无法合并的原因:`deleted here`、`binary`,或挡在那里、git 会直接覆盖的未跟踪/被忽略文件)或
`already applied`;`--check` 到此为止
(有冲突时退出码 1)。单个 agent 随后被应用,冲突处留下标记(退出码 1)。`--all` 把每个 agent
叠在前面的之上预览,依次应用到第一个会冲突的为止,并说明哪些应用了、哪些没有;失败的 agent 的
diff 只能用 `--agent` 单独应用。只要 diff 涉及的路径上有未提交的改动,它就拒绝执行——先提交或
stash,或者加 `--force`。看板在运行的 **Changes** 标签页里展示同样的 diff,并通过
`GET /api/runs/:id/agents/:agentId/diff` 提供。

`--verify "<cmd>"`——或配置 `applyVerify`(`--no-verify` 跳过一次)——在每次应用之后于仓库
根目录通过 shell 运行一条命令,受 `timeout` 配置约束。命令失败或超时时,这次应用会被回滚:它涉及
的路径恢复成应用前的样子,内容和索引项都分毫不差,odw 以退出码 1 结束并给出命令输出的末尾;按下
Ctrl-C 也会同样回滚。命令运行期间这些文件若被改动,改动后的版本会先另存一份,odw 会说明存在哪里。其他东西一概不碰——不 stash、不 reset——你其余的未提交改动保持原样。`--verify` 下
会冲突的改动不会被应用。

`--resolve`(配合 `--all` 或 `--agent`)遇到 diff 会冲突的 agent 时不再停下,而是交给一个
解决冲突的 agent。odw 在 diff 将要落地的状态上建一个临时 worktree——HEAD、索引(包含此前已应用
的 agent)、以及该 agent 能干净应用的文件——并在其中用默认 adapter(或 `--adapter A`)启动一个
resolver 运行,告诉它每个冲突文件的 base、双方版本和冲突行,要求保留双方意图、不碰其他文件。
只有当它的改动只涉及冲突文件、不留冲突标记、并在该 worktree 里通过校验命令(`--verify` 或
`applyVerify`)时,才会连同该 agent 的干净文件按常规方式应用到你的工作树;`--all` 随后继续,
并重新预览其后的 agent。任何一步不满足,你的工作树都不会被改动,odw 会说明原因。`--confirm`
在应用前展示解决后的 diff 并询问 y/N(需要终端)。resolver 是一个真正的运行——meta.json 里有
`origin: "apply-resolve"` 和 `applyResolve: { runId, agentId }`;`odw apply` 会打印它的 id,
`odw diff`、`odw logs`、`odw compare` 和看板都适用——被应用的运行则通过 meta.json 的
`resolvedBy` 和一条 `apply_resolved` 事件(`outcome`:applied、refused、declined 或
interrupted)链接到它。`--resolve` 不能与 `--force` 或 `--check` 同用:有未提交改动挡路的路径
照旧拒绝。(ODW 扩展。)

`--pr`(配合 `--agent` 或 `--all`)不碰你的工作树,而是开一个 pull request——它既不读也不写
你的工作树,所以那里未提交的改动原样保留,也不会进入 PR。odw 在临时 worktree 里从 `--base <分支>`
——否则从 HEAD 所在提交,目标为 HEAD 所在分支——建分支 `odw/<run>-<label>`(`--all` 时为
`odw/<run>-all`;名字在本地或远端已被占用时加 `-2`、`-3`……),在那里按上文的方式逐个预览并应用
每个 agent(`--verify` 也在那里运行),每个 agent 单独一个提交,使用**你自己的** git 身份和签名
设置;提交说明包含工作流、agent、diff 统计、运行 id,以及 CLI 报告了时该 agent 的花费。任何
agent 会冲突或校验失败,都会在推送前停下:分支被删除,什么都不会离开本机。之后推送到 `--remote`
(默认 `origin`),并运行 `gh pr create --repo <该远端的 owner/name>`——默认是**草稿**,加 `--ready` 则不是;标题为 `--title`
或按工作流和 agent 生成——正文是运行摘要:各 agent 及其提交、各阶段、以表格呈现的花费明细、
校验结果和 `odw diff` 命令。没有 `gh` 或 `gh` 未登录时,推送后停下并打印对比页 URL。**它从不合并。**
(ODW 扩展。)

- **`keep: true`**(`agent()` 选项)或 **`keepBranches: true`**(配置)还会把改动提交到源
  仓库的分支 `odw/<runId>/<agentId>-<label>` 上——作者是 `odw <odw@localhost>`,父提交是
  agent 开始时的那个提交——方便检出、合并或 cherry-pick。ODW 只创建这个分支:你的 HEAD、
  索引和其他分支都不会被碰。`keep: false` 让单个 agent 不受 `keepBranches` 影响。
- **`maxDiffBytes`**(默认 2 MB)限制单个 diff 的大小:超出时保留开头部分(在行边界截断),
  并在末尾加一行 `# odw: diff truncated …`。计数仍然描述完整的改动;被截断的 diff
  `odw apply` 会拒绝——请改用分支。
- 二进制文件在 diff 里只以对象 id 标出,不携带内容;git 从仓库的对象库里取回它(ODW 记录
  改动时已写入;保留的分支会让它永久保留)。
- 失败的 agent 同样保留 diff(比如超时前完成的工作),`odw resume` 会把重放 agent 的 diff
  带进新运行。被停止的运行不保留 diff。

```jsonc
{
  "maxDiffBytes": 2097152, // run 目录中单个 agent 的 diff 最多保留的字节数
  "keepBranches": false,   // true:每个隔离 agent 的改动也都提交到一个分支
  "applyVerify": null      // 例如 "npm test":每次 odw apply 之后运行,失败则回滚这次应用
}
```

### 跨运行的审阅队列(ODW 扩展)

保留的 diff 在各次运行里越积越多,远快于有人去看。`odw review` 列出运行根目录下所有运行里
还没人处理过的 diff,风险最高的在前,并说明每一条为什么排在这里:

```bash
odw review                       # 尚未审阅、放弃或应用的 diff,按风险从高到低
odw review --since 7d --json     # 只看最近一周的运行,供脚本使用
odw review --all                 # 连同已标记的,以及是谁标记的
odw review mark $RUN 3 reviewed --note "看过迁移了"   # 或 dismissed | applied | open(撤销)
```

分数是确定性的,只用运行记录下来的数据——不让任何模型来读。计分项:改动大小(50 / 300 / 1000
行:+1 / +2 / +3;6 / 20 个文件:+1 / +2);从保留的 diff 中读出的路径类别——CI(+3)、数据库迁移
(+3)、鉴权/安全相关代码(+3)、依赖清单与锁文件(+2)、测试(+1,删除测试再 +2)、二进制文件
(+2);在 `maxDiffBytes` 处被截断的 diff(+2);被 `--deadline` 终止的 agent(+3);`expect` 未达成
(+4)与 `untouched` 违规(+4);其他失败(+3:改动是未完成的工作);`scope` 之外的文件(+3);
留下仍在运行的后台任务(+2);破坏性 git 命令(+3);回退或 handoff(+1);`odw apply --resolve`
时跑过解决冲突的 agent(+1);`expect` 重试(+1)与其他重试(+1);花费达到 $1 / $5(+1 / +2)。
`expect.command` 检查通过则减一分。0–2 为 **low**,3–5 为 **medium**,6 及以上为 **high**。每一分
都打印在条目上(`--json` 中为 `factors`),排序有据可查。

标记写入运行目录中只追加的 `reviews.jsonl`——`{ ts, agentId, state, by, via, note? }`,`by` 是标记者
(与检查点决定一致:本地用户,或看板上具名令牌的名字),`via` 为 `cli`、`dashboard` 或 `apply`;
同一个 agent 以最后一条标记为准。`odw apply` 会把干净应用(或发现已应用)的每个 agent 标为
`applied`;`--check` 不做标记。`odw eval` 启动的运行和 `--resolve` 的解决冲突运行不进入队列。
看板的 **Review** 页(`g r`)展示同一队列及其理由,可把条目标为已审阅或放弃(与所有写操作一样
仅限回环地址——在那里也与所有写操作一样,服务接受的任何令牌都可以,`read` 范围的也不例外),并能在所属运行的 Changes 标签页中打开条目;Activity 的 **待你处理** 会显示等待
审阅的数量。`GET /api/review[?since=7d][&all=1]` 提供该队列,`POST
/api/runs/:id/agents/:agentId/review { state, note? }` 标记一条。

分步说明:[`docs/recipes/review-and-apply.md`](../../recipes/review-and-apply.md)。

### 按周看产出结果(ODW 扩展)

一次 eval 的通过率只说明那一次过没过,说明不了 agent 的产出有多少真的被人接受。`odw outcomes`
跨运行、按周统计这件事,只用运行记录下的证据和审阅标记——没有任何模型参与评判:

```bash
odw outcomes                         # 最近 30 天:按周、工作流、适配器、模型
odw outcomes --since 12w --workflow triage --json   # --since 最多 156w(三年)
odw outcomes --markdown              # 表格,方便贴进 PR 或 wiki
```

各项统计的含义:

- **kept / applied / dismissed / reviewed / left**——保留了 diff 的 agent,按它在
  `reviews.jsonl` 里的最后一条标记归类(`odw apply` 标 `applied`,`odw review mark` 与看板标其余);
  `left` 是没有标记或被放回队列(`open`)的。标记按现在的状态读取,所以运行一周后才应用的 diff 也算在那次运行上。
  「已应用」只看 ODW 自己的标记,不读 PR 的合并状态。
- **failed**——失败与 stale 的运行,原因取其失败 agent 中最多的那个,没有则为 `stale` 或 `script_error`;
  agent 级的失败也按原因计数。
- **rework(返工)**——需要重试(`expect`、限流、卡死、提问)、回退/交接,或在 `odw apply --resolve`
  时需要解决冲突的保留 diff;以及 `odw replay` 发起的运行。
- **per applied change(每个已应用改动的花费)**——该行的全部花费(包括失败的 agent)除以已应用改动数:
  有 agent 报告美元时用美元,否则用 token。
- **与上一个时间段对比**——紧挨着的同样长度的时间段;比例变化 15 个百分点以上(两边各至少 5 个样本),
  或每个已应用改动的花费变化一半以上(两边各至少 3 个)时会标出来。

运行按创建时间计入时间窗。不计入:dry run、仍在进行的运行,以及 `odw eval`、`odw test`、
`odw conformance` 和 `odw apply --resolve` 发起的运行。`odw pull` 拉回的运行一并计入;其他机器的运行根目录各自统计。
工作流行按运行计数;适配器/模型行按 agent 计数,只有它自己的 agent 在某次失败运行里失败时才把那次失败记在它头上。
模型取 CLI 报告实际服务的模型,否则取请求的模型(`… (requested)`),否则为 `(CLI default)`。
看板的 **Review** 页顶部有一张最近 30 天的 **产出结果** 卡片——已应用/保留、按周的堆叠柱、显著变化、
每个工作流一行——数据来自 `GET /api/outcomes[?since=30d][&workflow=W]`。
