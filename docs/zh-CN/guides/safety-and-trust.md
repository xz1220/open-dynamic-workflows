# 安全与信任

[English](../../guides/safety-and-trust.md) · 简体中文

agent 可以做什么、odw 不让它们碰什么，以及 odw 不让别人碰什么。

## 权限档位(ODW 扩展)

ODW 让每个 agent 在一个**权限档位**下运行:

- **`read`**——只看,不改文件、不跑命令:用于调研与审查类的 fan-out。
- **`edit`**——默认档位,与各内置适配器一直以来的姿态完全一致。
- **`full`**——无沙箱、无审批:必须显式开启,只用于隔离的机器。

在配置里设定运行的档位(`"permissions": "read"`),或按次指定
`odw run|rerun|resume --permissions read`(不指定时 rerun 和 resume 沿用源运行的档位)。
适配器自己的 `permissions` 和 `agent()` 调用的 `permissions` 只能**降低**它——agent
实际运行在三者中最低的那一档:

```js
// 在允许编辑的运行里,审查者碰不到工作树。
const reviews = await parallel(files.map((f) => () =>
  agent(`Review ${f} for bugs; report, do not fix`, { permissions: 'read', label: f })))
```

请求高于运行所允许档位的 agent 会在启动前失败,报错同时写明两个档位
(`agent() asked for permissions "full", but the run allows only "edit" …`);在
`parallel()` 里它的位置是 `null`,与任何失败的 agent 一样。各档位的参数替换适配器命令中
`{permission_args}` 那一项。只有 CLI 官方文档确认在无头模式下成立的映射才会填上:

| 适配器 | `read` | `edit`(默认) | `full` |
| --- | --- | --- | --- |
| `claude` | `--permission-mode dontAsk --tools Read,Glob,Grep,WebSearch,WebFetch --allowedTools WebSearch WebFetch --strict-mcp-config` | `--permission-mode acceptEdits --allowedTools WebSearch WebFetch` | `--permission-mode bypassPermissions` |
| `codex` | `--sandbox read-only` | `--sandbox workspace-write` | `--sandbox danger-full-access` |
| `gemini` | `--approval-mode default` | `--approval-mode auto_edit` | `--approval-mode yolo` |
| `qwen` | 拒绝 | `--approval-mode auto-edit` | `--approval-mode yolo` |
| `kimi` | 拒绝 | print 模式本身(无参数) | 按 `edit` 运行 |
| `omp` | 拒绝 | `--approval-mode yolo` | 按 `edit` 运行 |
| `kilo`、`opencode` | 拒绝 | `--auto` | 按 `edit` 运行 |
| `cursor` | 拒绝 | `--force` | 按 `edit` 运行 |
| `agy` | 拒绝 | `--mode accept-edits` | `--mode accept-edits --dangerously-skip-permissions` |

- **`read`。** 在 `claude` 上,`dontAsk` 会拒绝一切需要询问的调用,`--tools` 只留下只读的
  内置工具——根本没有 Edit、Write 或 Bash,你设置里的 allow 规则也加不回来——外加联网
  工具;不启动任何 MCP server。`codex` 运行在只读沙箱里:能读文件,不能改,也不能运行需要
  审批的命令(`codex exec` 不向任何人询问)。`gemini` 在 `default` 模式下会在写入和 shell
  工具前询问,无头模式下这等同于拒绝。
- **拒绝。** 没有经过验证的只读模式的 CLI,agent 会在启动前失败:
  `kimi cannot run read-only (…); use an adapter that can (--adapter claude, …), or
  run with --permissions edit`。Qwen 的文档没有说明其 `default` 模式在无头下的行为,所以它
  也没有 `read`。`agy` 同样没有:无头时它总能写入工作区内的文件,plan 模式只是给提示词加前缀。
- **`agy`。** 无头时,需要审批的工具调用会被软拒绝:在 `edit` 下,shell 命令、联网和 MCP
  工具只有在你自己的 `~/.gemini/antigravity-cli/settings.json` 中 `permissions.allow` 规则
  (或其 `toolPermission` 预设)允许时才会运行。被拒绝的调用与 Claude Code 一样记为 `denied`。
- **按 `edit` 运行。** 没有单独完全权限模式的 CLI 会用它的 `edit` 参数运行,每次运行对每个
  适配器只记一条日志。注意:对 `kimi`、`omp`、`kilo`、`opencode` 和 `cursor` 来说,
  `edit` 在无头模式下本来就会批准所有工具调用——把仓库交给它们之前请想清楚。
- **自己的适配器** 用同样的方式声明参数。没有 `permissionArgs` 的适配器按配置的命令原样
  运行,视为 `edit`;在其他档位下,运行会记一条日志,说明 ODW 无法强制执行。

```jsonc
{
  "permissions": "read", // 运行的档位;odw run --permissions 可覆盖
  "adapters": {
    // 给某个内置适配器封顶:不写 "command" 的条目只改它写出的字段
    "codex": { "permissions": "read" },
    "my_wrapper": {
      "command": ["my-agent", "{permission_args}", "--cwd", "{workspace}"],
      "permissionArgs": { "read": ["--read-only"], "edit": [], "full": ["--yolo"] } // "edit" 必填
    }
  }
}
```

每次启动都会打印每个已安装适配器实际运行的档位——
`permissions: read — claude read, codex read, kimi refused (no read mode)`——出现在实时
视图里、`--wait` 的第一行之后,以及 detached 运行的 run id 之后。每个 `agent_started`
事件(以及 `odw agents --json`)都带有该 agent 的 `permissions`,`odw doctor` 会列出每个
适配器支持的档位。档位只约束 agent 能做什么:`exec()` 命令属于 workflow 自身,不受影响。
`read` 也不是运行不受信任代码的沙箱——比如 Claude Code 在 `-p` 下仍会执行仓库自带的 hooks;
这样的仓库请以[不受信任](#不受信任的仓库odw-扩展)方式运行。

**Codex 与需要审批的 MCP 工具**([#23](https://github.com/xz1220/open-dynamic-workflows/issues/23))。
没有哪个档位能让 `codex exec` 批准 MCP 工具调用。它不向任何人询问,所以需要审批的工具
调用——比如一次 Figma 写入——会被取消(`user cancelled MCP tool call`);`full` 解除了
沙箱(`--sandbox danger-full-access`),但文档没有说它会批准 MCP 调用
([openai/codex#24135](https://github.com/openai/codex/issues/24135))。请改在 Codex 自己
的配置里预先批准那一个工具([Codex MCP 文档](https://developers.openai.com/codex/mcp)):

```toml
# ~/.codex/config.toml
[mcp_servers.figma.tools.use_figma]
approval_mode = "approve"
```

或者,仅在隔离的机器上,把 codex 的 `full` 换成跳过一切审批和沙箱的参数,再用
`--permissions full` 运行(`permissionArgs` 会整体替换内置的那份,所以其他档位要一并写出):

```jsonc
"adapters": {
  "codex": {
    "permissionArgs": {
      "read": ["--sandbox", "read-only"],
      "edit": ["--sandbox", "workspace-write"],
      "full": ["--dangerously-bypass-approvals-and-sandbox"]
    }
  }
}
```

在 `claude` 上,`full`(`bypassPermissions`)执行工具调用时不会询问。

**agent 能看到你的哪些环境变量。** 默认情况下,agent CLI 继承 ODW 的全部环境变量。
`"agentEnv": "minimal"` 只传递 CLI 启动所需的变量(`PATH`、`HOME`、`USER`、`LOGNAME`、
`SHELL`、`LANG`、`LC_*`、`TERM`、`TMPDIR`、`TZ`,以及 Windows 的系统变量)、内置 CLI 文档
中列出的认证与配置变量(`ANTHROPIC_*`、`CLAUDE_*`、`OPENAI_*`、`CODEX_*`、`GEMINI_*`、
`GOOGLE_*`、`DASHSCOPE_*`、`QWEN_*`、`MOONSHOT_*`、`KIMI_*`、`CURSOR_*`、`OPENCODE_*`、
代理变量和 `NODE_EXTRA_CA_CERTS`)、适配器的 `env`、`ODW_*`,以及你在 `agentEnvPass`
里列出的名字或 `*` 通配——这样 shell 里的云凭据或仓库令牌就不会传给每一个 agent:

```jsonc
{ "agentEnv": "minimal", "agentEnvPass": ["AWS_*"] } // 例如在 Bedrock 上用 Claude Code
```

如果某个 CLI 在 `minimal` 下无法登录,把它需要的变量加进 `agentEnvPass`
(`odw doctor --smoke` 会发一次真实调用来检验)。`exec()` 命令、`worktreeSetup` 和
`notify` 钩子仍拿到完整的环境变量。

## 安全快照与破坏性 git 命令(ODW 扩展)

原地工作的 agent——方言的默认做法,没有 `isolation: "worktree"`——就在你未提交的改动旁边
干活,一条 `git reset --hard` 就能把它们全部丢掉
([claude-code#33850](https://github.com/anthropics/claude-code/issues/33850))。所以在一次
运行的第一个 `edit` 或 `full` 档位的原地 agent 开始之前,odw 会保存工作区里 git 还没有的
东西:用 `git stash create` 保存已跟踪文件的改动(暂存与未暂存),再加上 `.gitignore` 没有
排除的未跟踪文件,合成一个提交存到 `refs/odw/safety/<run>`——你的工作区、index 和 stash
列表都保持原样。干净的工作区不建快照;被忽略的文件从不保存,超过 50 MB 的未跟踪文件不保存,
文件名表明含有密钥的未跟踪文件(`.env`、`.env.*`、`*.pem`、`*.key`、`*.p12`、`id_rsa`、
`id_ed25519`、`id_ecdsa`、`credentials.json`)也不保存——快照会逐一点名。运行用
`safety_snapshot` 事件说明;odw 无法建快照时(不是 git 仓库、正在合并)记一条日志说明原因,
agent 照常运行。

快照是**你仓库里的一个 git ref**:在 `odw gc` 随其运行一起删除它之前(超过 `retention`),
它的提交里保存着你其他未跟踪文件当时的内容——草稿、本地配置、odw 不认识的文件名下的密钥。
按分支或标签推送不会带上它,但 `git push --mirror`(推送所有 ref)会把它公开出去。

```sh
odw restore $RUN --check   # 预览:每个文件 clean、CONFLICT(附冲突行)或 already applied
odw restore $RUN           # 把工作区恢复成快照保存时的样子(git apply --3way,已暂存)
```

`odw restore` 在运行的源仓库里工作,复用
[`odw apply`](reviewing-and-applying.md#审阅并应用隔离-agent-的改动odw-扩展) 的机制:工作区里已经与快照一致的文件
(例如 reset 没有动到的未跟踪文件)会略过;某个路径有未提交改动时拒绝,除非加 `--force`;
HEAD 在那之后移动过(`git reset --hard origin/main`)时,改动以三方合并方式放到新的 HEAD
之上,并说明 HEAD 原来所在的提交。

odw 无法在命令执行前拦住它——那需要各 CLI 自己的 hook——但会在 agent 运行时读取它执行的命令
(Claude Code 的 `Bash`、Codex 的 `command_execution`、kilo、opencode 与 agy 的 shell 工具),
识别 `git reset --hard`、`git checkout .` / `-- .` / `--force`、`git switch --force` /
`--discard-changes`、`git restore .`、`git clean -f…`、`git push --force`(`-f`、
`--force-with-lease`、`+refspec`)、`git push --mirror`、`git push --delete`(`-d`、`:refspec`)、
`git stash drop|clear` 和 `git branch -D`。命令行按 shell 的方式切分(`cd x && …`、
`bash -lc '…'`、`sudo`、`env`、`if …; then …`、`! …`、`git -C dir …`);引号里的文字不算命令。
每条命中都是一个 `destructive_git` 事件——显示在 `odw logs`、实时视图以及看板里该 agent 的抽屉和
节点上——有快照时会提示 `odw restore <run>`。只重置工作区的那几类命令对隔离 agent 不计:它的
worktree 是它自己的——除非 git 被指向别处(`git -C <dir>`、`--git-dir`、`--work-tree`),odw 无法
判断那是哪里,按原地处理。

这种识别**只是提示、尽力而为**,不是防护:它只看命令行上写了什么。由别的程序调用的 git 它看不到——
`find . -exec git checkout -- {} +`、`… | xargs git checkout --`、脚本或 Makefile——git 别名
(把 `reset --hard` 叫作 `git nuke`)、先 `cd` 到另一个 worktree 再执行的普通 `git reset --hard`,
以及不打印工具调用的 CLI(文本适配器)也都看不到。能把工作找回来的是快照,而不是识别。

```jsonc
{ "destructiveGit": "fail" } // 默认 "warn":只记录;"fail":agent 的 CLI 结束后以失败原因 destructive_git 判为失败
```

## 不受信任的仓库(ODW 扩展)

在别人的仓库上运行 agent 是危险的:仓库里的 CLAUDE.md 或 AGENTS.md 会左右 agent,它的
hooks、MCP 服务器和项目设置会在 agent 里运行。对这样的仓库以**不受信任**方式运行——
`odw run|rerun|resume --untrusted`,或在你的配置里写 `"trust": "untrusted"`(默认是
`"trusted"`;不受信任运行的 rerun 和 resume 仍不受信任)。这时每个 CLI 都以它自己文档
给出的"忽略仓库"方式运行,参数加在档位参数之后;没有这种方式的 CLI,运行会为每个适配器
说一次——绝不悄悄降级:

| 适配器 | 不受信任时 | 仍会传给 agent 的 |
| --- | --- | --- |
| `claude` | `--safe-mode`(关闭 CLAUDE.md、skills、插件、hooks、MCP 服务器、命令、agents、workflows;认证照常) | 无 |
| `qwen` | `--safe-mode`(关闭上下文文件、hooks、扩展、skills、MCP 服务器) | 无 |
| `omp` | `--no-extensions --no-skills --no-rules` | AGENTS.md、CLAUDE.md、hooks、MCP 配置 |
| `codex` | 没有文档化的方式 | AGENTS.md(它的 `.codex/` 配置、hooks 和 rules 只对你信任过的项目加载) |
| `gemini` | 没有文档化的方式(它的不受信任文件夹模式在无头下直接退出) | GEMINI.md、`.gemini/settings.json` |
| `kimi` | 没有文档化的方式 | AGENTS.md、skills |
| `kilo`、`opencode` | 没有文档化的方式 | AGENTS.md、项目配置、`.kilo/` / `.opencode/` |
| `cursor` | 没有文档化的方式 | `.cursor/rules`、AGENTS.md、CLAUDE.md、`mcp.json`、hooks |
| `agy` | 没有文档化的方式 | AGENTS.md、GEMINI.md、`.agents/` 下的 rules、skills、agents、`mcp_config.json` |

Claude Code 的 `--bare` 跳过的更多,但它只接受 API key 认证,订阅登录用不了。第一次有
agent 在 codex 上运行时,运行日志里会出现
`codex has no documented way to ignore the repository's AGENTS.md — its instructions
still reach the agent` 这样的一行。

ODW 自己会执行的、属于仓库的代码会被拒绝:仓库 `.worktreeinclude` 里的 `symlink:` 行
不做任何链接(链接等于把源码树交给 agent;普通行照常复制);仓库内配置(例如它的
`./odw.config.json`)设置的 `worktreeSetup` 或 `worktreeTeardown` 不会运行,日志里会说明。你自己的配置
(`--config`、`$ODW_CONFIG`,或仓库之外的 `~/.config/odw/config.json`)里的
`worktreeSetup` 照常运行。ODW 会自行在仓库里找到的配置(它的 `./odw.config.json`)在不受
信任运行中根本不会读取:其中的适配器命令就是仓库的代码。运行改用你自己的
`~/.config/odw/config.json`(在仓库之外)或内置默认值,并在日志里说明;用 `--config` 或
`$ODW_CONFIG` 指定的配置是你自己的选择,照常生效。仓库的配置也无法放宽你在
`~/.config/odw/config.json` 里设置的 `"trust": "untrusted"`。仓库的[工作流记忆](../reference/workflow-api.md#工作流记忆odw-扩展)
(`.odw/memory/`)既不召回也不写入;你放在仓库之外的 `memoryDir` 照常使用。

```jsonc
{
  "trust": "untrusted",
  "adapters": {
    "codex": { "trust": "untrusted" },  // 或者:只让这个适配器在每次运行中都不受信任
    "my_wrapper": {
      "command": ["my-agent", "{permission_args}", "--cwd", "{workspace}"],
      "permissionArgs": { "edit": [] },
      "untrustedArgs": ["--no-project-config"],           // 加在档位参数之后
      "untrustedNote": "my-agent still reads .my-agent/rules" // 每次不受信任运行说一次
    }
  }
}
```

启动横幅里有一行信任信息——`trust: untrusted — claude --safe-mode, codex no documented
way`——`odw doctor` 会显示配置的信任级别,以及每个适配器不受信任时如何运行。不受信任
agent 的 `agent_started` 事件、保存的结果和 `odw agents --json` 行都带有
`trust: "untrusted"`,看板的详情抽屉会显示它,运行的 `run_started` setup 也记录 `trust`。
不受信任不是沙箱:它只在 CLI 允许的地方挡住仓库的指令和配置,agent 能做什么仍由权限
档位决定。

## 不可信输入(ODW 扩展)

issue 正文、PR 标题、评论是任何人写的文字,模型无法可靠地把它和指令区分开:已公开的注入
("Comment and Control"、GitLost)绕过了所有模型层面的防护,由此得出的建议是结构性的——把能力
拿走。**args** 来自外部的运行带有**不可信输入**,这与[不受信任的仓库](#不受信任的仓库odw-扩展)
是两回事。[触发器](scheduling-and-triggers.md#由-webhook-启动运行githublinearslackodw-扩展)启动的每个运行都带有它(除非
触发器写明 `"untrusted": false`),`odw run --untrusted-input` 也一样(rerun / resume / replay 会保留)。
这样的运行:

- **agent 只读**——`permissions: "read"`——除非显式给出了运行档位:`--permissions`,或触发器的
  `"permissions"`;
- **agent CLI 以 `agentEnv: "minimal"` 启动,不带其他厂商的变量,也不带密钥类变量**——`GH_TOKEN`、
  `GITHUB_TOKEN`、`*_API_KEY`、`*_TOKEN`、`*_HEADERS` 等——只保留该 CLI 自身登录文档里的那些(claude 是
  `ANTHROPIC_*`/`CLAUDE_*`,codex 是 `OPENAI_*`/`CODEX_*`,gemini 是 `GEMINI_*` 与 `GOOGLE_API_KEY`、
  `GOOGLE_GENAI_USE_VERTEXAI`、`GOOGLE_GENAI_USE_GCA`、`GOOGLE_CLOUD_PROJECT`、`GOOGLE_CLOUD_LOCATION`,……),
  无论 `agentEnvPass` 列了什么。适配器自己的 `env` 仍然生效,`exec()` 命令(工作流作者写的)得到最小环境加上
  `agentEnvPass`;
- **不运行仓库自己的 worktree setup 与 teardown:** 仓库自身配置设置的 `worktreeSetup` 或 `worktreeTeardown`
  会被丢弃,运行日志会说明,与[不受信任的仓库](#不受信任的仓库odw-扩展)相同;你自己配置里的仍会运行,但不带
  密钥类变量和各厂商的变量(保留 `PATH`、`HOME`、`DOCKER_*` 与 `COMPOSE_*`,docker 和 compose 照常可用);
- **没有隔离时大声说出来:** 若没有 `network` 为白名单(或 `"none"`)的
  [容器沙箱](#在容器中运行-agentodw-扩展),启动横幅、运行日志和 `run_started` 事件都会警告,且只读 agent
  启动时不带其 CLI 的联网工具(Claude Code 的 `WebFetch` 与 `WebSearch`,codex 的 `--search`)——它们可能把
  读到的文件(比如 `actions/checkout` 留在 `.git/config` 里的 token)带出本机。
  配置 `"untrustedInput": { "requireSandbox": true }` 则直接拒绝启动;
- **写之前先问:** 第一个可写(`edit` 或 `full`)的 agent 会停在一个[检查点](checkpoints-and-questions.md#人工检查点odw-扩展)
  等人放行——每个运行只问一次,答复对之后的 agent 都有效;拒绝会让这些 agent 以可捕获的
  `UntrustedInputRejected` 失败。对这样的运行执行 `odw apply --pr` 会在终端询问 `y/N`,或接受
  `--accept-untrusted-input`。触发器的 `"approve": false` 同时关闭两者。

```jsonc
"triggers": {
  "fix-issue": {
    "workflow": "fix-issue", "verify": "github", "secretEnv": "GITHUB_WEBHOOK_SECRET",
    "args": { "issue": "$.issue.number", "body": "$.issue.body" },
    "permissions": "edit"            // agent 可以编辑:第一个会先询问
  }
},
"sandbox": { "kind": "container", "image": "odw-agents:latest", "network": { "allow": "adapter" } },
"untrustedInput": { "requireSandbox": true }
```

工作流通过 `workflow.input` 看到这一点(ODW 扩展;Claude Code 中为 undefined,请写成
`workflow.input?.untrusted`):`untrusted`、它覆盖的 `args`(触发器映射的键;`["*"]` 表示全部)、
`why`(`trigger:<name>`、`--untrusted-input`),以及 `quote(text, label?)`——把文本放进带围栏的
`<untrusted-data>` 块,后面跟一行说明它是数据而不是指令:

```js
const fix = await agent(`修复这个 issue 描述的 bug。\n${workflow.input.quote(args.body, "issue body")}`)
```

meta.json 记录 `untrustedInput: { why, args, approve }`;status.json 和 `run_started` 事件补充档位、
环境以及是否有沙箱,看板的 Job 头部以一行信任信息显示它。这些都不检测或过滤注入,也不让运行
变得「安全」:它只是拿走了那段文字可能要求的能力。

## 严格脚本上下文(ODW 扩展)

工作流就是代码:来自插件、分享文件或触发器的工作流,默认带着 worker 的整个 JavaScript 上下文运行——
`process`、`require`、`fetch` 以及经由它们能拿到的一切。`scriptContext: "strict"` 在一个新的 `vm`
上下文中编译并执行工作流正文,其中只有注入的原语(`agent`、`parallel`、`pipeline`、`phase`、`log`、
`args`、`budget`、`workflow`,以及 ODW 扩展 `validate`、`exec`、`checkpoint`)和标准 JavaScript 内建对象——
也就是 Claude Code 的 Workflow 工具给脚本的那个裸 ECMAScript 环境。没有 `process`、`require`、`fetch`、
`console`、定时器和 `structuredClone`;`eval()` 与 `new Function()` 不编译任何代码;`import()` 在正文编译
时即被拒绝。用到这些时,报错会直接说明原因(`process is not defined: a strict script context
(scriptContext: "strict") has only the workflow primitives and standard JavaScript built-ins, not
Node.js's process — …`),而不是一个光秃秃的 `ReferenceError`;运行在正文开始前就会说明自己是严格的,
以及脚本用到了其中哪些名字。原语返回或抛出的值,以脚本自身环境中的副本到达脚本;脚本抛出的错误离开
时是普通的 `Error`。

```jsonc
{ "scriptContext": "strict" } // 所有运行;"host":所有运行都在 worker 的上下文中
```

不设置时,**触发器启动的运行、Claude Code 插件的工作流、`odw workflows add` 从 git 安装的工作流、输入或仓库不可信的运行使用 strict**,
其余一律 **host**——本地项目与个人工作流照旧运行。触发器启动的运行,其 rerun、resume 与 replay 也是 strict。
配置中的 `"host"` 优先,但它拿走 strict 默认值时,运行日志会给出警告。嵌套的 `workflow()` 与父运行用同一种
上下文——插件的工作流即使在 host 父运行之下也是 strict,除非配置写明 `"host"`。
运行的 `run_started` 事件记录所选的上下文,status.json 中有 `scriptContext: "strict"`,看板 Job 头部的
信任行也会显示。`odw check --capabilities` 列出脚本在严格上下文中会缺少的东西。

**`vm` 不是安全边界。** 严格上下文只是拿走了脚本随手就能碰到的东西;恶意脚本仍可能找到办法逃出
这个上下文,而且每个脚本驱动的 agent 都带着运行的权限行事。`exec()` 仍然可用,它在本机(或运行的容器沙箱)
的 shell 中、带着运行的环境变量执行命令——严格上下文不会拿走命令。运行前请先读一遍工作流,并为 agent 使用
[权限档位](#权限档位odw-扩展)与[容器沙箱](#在容器中运行-agentodw-扩展)。

## 在容器中运行 agent(ODW 扩展)

默认情况下,ODW 以你的身份在本机运行每个 agent CLI,只靠 CLI 自己的权限参数约束。容器
沙箱则把每次 CLI 运行——以及每个 `exec()` 步骤——放进一个全新的 Docker 或 Podman 容器。
它需要显式开启,镜像由你提供:镜像里必须装好 CLI,ODW 从不拉取镜像。

```bash
docker build -t odw-agents --build-arg UID=$(id -u) --build-arg GID=$(id -g) examples/sandbox
odw doctor                                   # 找到引擎、镜像存在、冒烟运行
odw run wf.js --sandbox container --sandbox-image odw-agents
```

[`examples/sandbox/Dockerfile`](../../../examples/sandbox/Dockerfile) 构建一个带 Node、git、Claude
Code 与 Codex 的镜像(用 `--build-arg CLAUDE_CODE_VERSION=…` 固定版本)。也可以写进配置,
按运行、按适配器或按调用设置:

```jsonc
{
  "sandbox": {
    "kind": "container",
    "image": "odw-agents",          // 必填;从不拉取
    "engine": "docker",             // 或 "podman";默认:装了 docker 用 docker,否则 podman
    "network": "default",           // 或 "none",或 { "allow": [...] }(见下文)
    "cliConfig": "copy",            // 或 "mount-ro" | "none"
    "mounts": [{ "source": "~/datasets", "readonly": true }], // 默认只读,除非 "readonly": false
    "memory": "4g", "cpus": 2, "pids": 512 // pids 默认 512;其余用引擎默认值
  },
  "adapters": {
    "codex": { "sandbox": { "kind": "container", "image": "odw-codex", "network": "none" } }
  }
}
```

```js
await agent('Review this diff', { sandbox: { network: 'none', memory: '1g' } })
await agent('Summarize', { sandbox: { image: 'odw-agents' } }) // 在宿主上运行的 run 中单个调用进容器
await exec('npm test')                                          // 在运行的容器里,不联网
await exec('npm ci', { network: 'default' })                    // 需要网络的步骤
```

与权限档位一样,沙箱只能收紧:适配器的 `sandbox` 可以开启容器并设定自己的镜像、引擎、
CLI 配置和更多挂载,网络与各项限制取更严格者;`agent()` 调用可以开启容器(只有在别处都
没给镜像时才能指定镜像)、拿掉网络、降低限制或丢掉 CLI 配置(`cliConfig: "none"`)。任何
更宽松的要求——容器下的 `sandbox: "none"`、沙箱没有的网络、更多内存、换镜像、挂载——都会让
调用在启动前失败。`odw run|rerun|resume --sandbox container [--sandbox-image <镜像>]` 让整次
运行进入容器(配置里的容器,或该镜像的容器);沙箱运行的 rerun 或 resume 仍在沙箱中。

每次 CLI 运行变成(`docker run --rm -i --init --pull never --name odw-<run>-<agent>-<随机> --label odw.run=<run> …`):

- **只有工作区,别无其他。** agent 的工作区——隔离 worktree 或运行的 source——以相同路径
  读写挂载并作为工作目录,所以 diff、transcript、`expect` 检查与 `{workspace}` 照常工作。宿主
  文件系统的其他部分都不可见:只有私有 home、这次 CLI 运行要用的文件(提示词文件、schema
  文件、回复文件)以及你列出的 `mounts`。在隔离 worktree 里,容器内的 `git` 找不到仓库
  (worktree 的 `.git` 指向外面);ODW 照常在宿主上取 diff。agent 需要历史时,用 `mounts`
  把仓库的 `.git` 只读挂进去。
- **CLI 的登录,以副本形式。** `cliConfig: "copy"`(默认)把 CLI 自己的登录与配置文件复制到
  私有临时 home(挂载在 `/odw/home`,运行结束后删除),agent 能用,但改不了你的原件。只复制
  各 CLI 文档点名的文件:Claude Code 的 `~/.claude/.credentials.json`、`settings.json`、
  `CLAUDE.md`、`agents/`、`commands/`、`skills/` 和去掉 `projects`(你的其他仓库)的
  `~/.claude.json`;Codex 的 `~/.codex/auth.json`、`config.toml`、`AGENTS.md`;Gemini 的
  `~/.gemini/settings.json`、`oauth_creds.json`、`google_accounts.json`、`GEMINI.md`、`.env`。
  从不复制会话历史或日志。支持 `CLAUDE_CONFIG_DIR` 与 `CODEX_HOME`。`"mount-ro"` 改为只读
  绑定这些文件(Claude Code 运行时会改写 `~/.claude.json`,它更适合 `copy`);`"none"` 让 home
  为空。macOS 上 Claude Code 把登录存在钥匙串里,没有文件可复制:请设置
  `CLAUDE_CODE_OAUTH_TOKEN`(来自 `claude setup-token`)或 `ANTHROPIC_API_KEY`;Codex 用
  `CODEX_API_KEY`,Gemini 用 `GEMINI_API_KEY`。找不到可复制的文件时,运行会说明一次。CLI 若在
  容器里刷新登录,新令牌写进随后丢弃的副本;若提供方轮换刷新令牌,你本机的登录之后可能需要
  重新 `/login`——沙箱运行最适合长期令牌与 API key。
- **以你的身份,没有特权。** `--user` 为你的 uid:gid(Podman 另加 `--userns keep-id`),agent
  写下的文件归你所有;`--cap-drop ALL`、`--security-opt no-new-privileges`、`--pids-limit`
  (512)、可选的 `--memory` 与 `--cpus`、只读根文件系统加 tmpfs `/tmp`,以及转发信号的 `--init`。
- **只有 `agentEnv` 放行的环境变量**——设置 `"agentEnv": "minimal"` 可挡住 shell 里的其他
  密钥——按名字传递(`--env NAME`),进程列表里看不到值;宿主路径类变量(`PATH`、`HOME`、
  `TMPDIR`、`XDG_*`、`CLAUDE_CONFIG_DIR`、`CODEX_HOME`)不传。
- **`ODW_PORT` 照常设置,但不发布任何端口。** agent 在该端口启动的服务只在它的容器内可达。
- **随运行一起被杀掉。** 超时、停顿、被停止或没有干净退出的 CLI 运行,其容器按名字被杀掉
  (`docker kill`,再 `docker rm --force`);只杀引擎客户端会让容器继续运行。worker 自己被杀时,
  它的退出处理会删除仍在运行的全部容器。崩溃遗留的容器可用
  `docker ps --filter label=odw.run` 找到。

**出站白名单**(ODW 扩展)。agent CLI 必须连到模型 API,所以 `network: "default"` 实际上就是
开放的互联网。白名单让容器只能连到你列出的主机,而且由容器之外的东西来执行:

```jsonc
{
  "sandbox": {
    "kind": "container", "image": "odw-agents",
    "network": { "allow": ["adapter", "registry.npmjs.org", "*.githubusercontent.com"] }
    // "allow": "adapter" —— 只放行该 agent 的适配器所需的主机
    // "proxyImage": "node:22-alpine" —— 让代理跑在另一个镜像里(需要 node)
  }
}
```

- **条目。** 主机名(`api.anthropic.com`)、匹配其子域的通配符(`*.npmjs.org` 匹配
  `registry.npmjs.org`,不匹配 `npmjs.org`)或 IP 字面量(`10.0.0.5`、`[::1]`),都可带端口
  (`example.com:8443`;不带时为 443 与 80)。请求 IP 地址时,除非这个地址本身被列出,一律拒绝——
  通配符从不匹配 IP。`"*"` 会被拒绝:那就是 `network: "default"`。
- **`"adapter"`** 代表 agent 的适配器在 `egressHosts` 中声明的主机(取自各 CLI 文档):
  `claude` 为 api.anthropic.com、claude.ai、platform.claude.com;`codex` 为 api.openai.com、
  chatgpt.com、auth.openai.com;`gemini` 为 generativelanguage.googleapis.com、
  cloudcode-pa.googleapis.com、oauth2.googleapis.com;`agy` 为 cloudcode-pa.googleapis.com、
  oauth2.googleapis.com。可选的遥测不在其中(会被拒绝并记录;Claude Code 可设
  `DISABLE_TELEMETRY` 让它安静)。其他适配器没有声明——给你的适配器加 `"egressHosts": [...]`,
  或直接列出主机。
- **只能收紧。** 适配器或单次调用的 `network: { allow }` 与运行的白名单取交集;`"none"` 仍然优先;
  白名单之下的调用不能要求 `"default"`。`network: "default"` 的 `exec()` 步骤得到运行的白名单
  (去掉 `"adapter"`:步骤没有适配器)。
- **原理。** 第一个需要它的容器会为每个不同的白名单拉起一个运行专属的内部网络
  (`docker network create --internal`:没有出口路由)和一个出站代理边车容器
  (`odw-<run>-egress<n>-…`,标签 `odw.role=egress-proxy`),代理位于引擎默认网络上并同时加入内部网络。
  agent 的容器只加入内部网络,`HTTPS_PROXY`/`HTTP_PROXY`(及小写形式)指向代理,`NO_PROXY` 放过回环地址,
  并设 `NODE_USE_ENV_PROXY=1`。代理只为白名单主机的 443 端口(或条目指定的端口)建立 `CONNECT` 隧道,
  只把明文 HTTP 转发给白名单主机(`Host` 头指向别的主机则拒绝),并且**自己解析域名**——agent 的容器
  对外没有 DNS:在 Docker 上它得到 `--dns 192.0.2.1`,一个无人应答的地址,因为 Docker 26.0 之前的内置
  解析器会经由宿主机把内部网络的查询转发出去(CVE-2024-29018)。代理只在它于内部网络上的地址监听,
  默认网络上的其他容器用不了它。它是 ODW 自带的零依赖脚本(与隐藏命令 `odw __egress-proxy` 是同一份
  代码),用 `node` 跑在**agent 的镜像里——因此镜像需要 node**——或 `proxyImage` 里,加固方式与 agent
  容器相同。
- **拒绝即事件。** 每个被拒绝的请求都会写入 `<运行目录>/egress/` 的一行,运行把它变成
  `egress_denied` 事件(`{ host, port, method, agent }`,步骤则为 `commandId`),出现在
  `odw logs` 与看板中——每次运行最多 200 条,运行结束时再用一行日志说明还有多少条;每个代理的日志
  最多 1 MiB。agent 由其代理 URL 中的用户名标识;丢掉用户名的 CLI 显示为 `agent: null`。这个名字只是
  提示而非证明——它由客户端发送,agent 可以改掉——但改了也得不到什么:同一代理后的 agent 白名单相同。
- **会被清理。** 运行结束时先删除代理,再删除网络;worker 被杀、或结束时有删不掉的,退出处理也会
  这样做。崩溃遗留的网络可用 `docker network ls --filter label=odw.run` 找到。`odw doctor` 会拉起代理,
  并在内部网络上的容器里期望第一个列出的主机返回 200、一个保留域名返回 403,且 example.com 解析不了。
- **安全的失败方式。** 忽略 `HTTPS_PROXY` 的 CLI 或工具完全没有网络:内部网络除了代理别无出路。
  不经代理走 HTTP(S) 的一切——SSH、裸 TCP、UDP——都会失败。白名单不同的 agent 用不同的网络与代理,
  所以 agent 用不了别人的代理。被放行的主机仍是受信任的:agent 能把代码发到任何被放行主机会转发的地方。
- **按名字,而非按站点。** 白名单限制的是连接所用的主机名,也就是这些名字解析到的服务器——而不是
  那里提供的站点。经 `CONNECT` 时,隧道里的 TLS 由 agent 掌控:它可以在 SNI 和内层 `Host` 头里写另一个
  站点(域前置,domain fronting),而被放行名字解析到的服务器——CDN 边缘、共享前端——可能会为它服务。
  放行 CDN 后面的一个名字,可能等于放行了该边缘代理的所有站点;尽量选不在共享前端后面的主机。

缺少引擎或镜像时,运行在第一个 agent 启动前就以 `ConfigError` 失败,并说明如何构建镜像;
`odw doctor` 做同样的检查,并运行 `docker run --rm --pull never --network none <镜像> true`
(不涉及模型)。配置了容器时启动横幅多一行沙箱信息,每个 agent 的 `agent_started` 事件与看板的 AgentView
带 `sandbox: { kind, engine, image, network }`(白名单时 `network: "allowlist"` 并附 `allow` 主机),运行 setup 记录 `sandbox` 供 `odw compare` 比较。
沙箱中的 agent 不记录 CLI 版本:版本探测在宿主上运行,宿主的 CLI 不是镜像里的那个。

**它保护什么,不保护什么。** 它让 agent——以及它运行的一切——读不到也改不了你文件系统的
其余部分(SSH 密钥、其他仓库、shell 配置、真实的 CLI 配置),只能以你的身份运行,也留不下
进程。它**不能**让你的代码远离模型:agent 仍会把读到的内容发给模型 API。在
`network: "default"`(默认值,因为 agent CLI 必须连到模型 API)下它拥有开放网络,可以把工作区
以及环境变量和登录中的密钥发往任何地方——请把密钥挡在 `agentEnv` 之外,不需要模型 API 的
地方都用 `network: "none"`(`exec()` 步骤默认就不联网),需要的地方用出站白名单
(`network: { allow: "adapter" }`):这样 agent 只能连到它的模型 API 和你列出的主机,经由一个
它在容器内改不了的代理,每次拒绝都有记录。工作区是可写的:agent 写在那里的东西
——原地工作时仓库里的 git hook、`package.json` 脚本、Makefile——会在你之后运行它时在宿主上
执行,所以请审阅改动(隔离 worktree 与 `odw apply` 有帮助)。容器与宿主共享内核,不是虚拟机。
无 root 的 Docker 有自己的 uid 映射,文件可能归另一个 uid 所有;SELinux 宿主上的绑定挂载可能
需要重新打标签。不支持 Windows 宿主。

## ODW 所保存内容中的密钥(ODW 扩展)

agent 读到什么就会打印什么——包括 `cat .env`——而 ODW 会保存这些输出:它的 transcript
和 stderr 结尾、它的回复(保存的结果)、运行的日志与错误、发给 webhook 的内容。看板会
提供这一切,在非 loopback 地址上也一样。所以在写下任何内容之前,ODW 会把每个疑似密钥
替换成一个说明其类型的标记:

```text
the key is «redacted:env:STRIPE_SECRET_KEY»
Authorization: Bearer «redacted:bearer»
cloning with «redacted:github»
```

- **`env`** —— ODW 启动 agent 和 `exec()` 命令时所用环境(它自己的,以及每个适配器的
  `env`)中,名字看起来像密钥的变量(`*_KEY`、`*_API_KEY`、`*TOKEN`、`*SECRET*`、
  `*PASSWORD*`、`*_PWD`、`*_PAT`、`AUTHORIZATION`、`AWS_ACCESS_KEY_ID` 和
  `*CONNECTION_STRING` 等云凭据、webhook URL)的值,无论出现在哪里(8 个字符及以上,
  精确匹配),记为 `«redacted:env:NAME»`;以及任何打印出来的、`NAME` 看起来像密钥的
  `NAME=value` 中的值(`.env` 文件、`env` 输出)。
- **`patterns`** —— 常见令牌形态:Anthropic(`sk-ant-…`)、OpenAI(`sk-…`、
  `sk-proj-…`)、GitHub(`ghp_…`、`gho_…`、`ghs_…`、`github_pat_…`)、Slack(`xoxb-…`
  及同类)、AWS access key id、Google API key、JWT、PEM 私钥块和 `Bearer` 令牌——记为
  `«redacted:anthropic»`、`«redacted:openai»`……
- **`extra`** —— 你自己的正则表达式(JavaScript 写法),记为 `«redacted:extra»`。

```jsonc
// 默认值,再加一条自己的规则:
{ "redact": { "env": true, "patterns": true, "extra": ["corp-[0-9a-f]{32}"] } }
// 一切按打印原样保存:
{ "redact": false }
```

会被脱敏的:transcript(在流式写入时进行——跨两段输出的密钥同样会被处理)和 stderr
结尾;保存的 agent 结果(`odw result --agent`、看板的 agent 抽屉);运行的事件——
`odw logs`、日志行、`agent_failed` 的错误(失败时引用的输出先脱敏再截断,所以不会留下
半个密钥)、`exec()` 步骤显示的命令行以及失败的 `check` 引用的输出;运行的错误;
`status.json` 中等待中的检查点;webhook 负载;运行的 `worker.log`——worker 自己的输出,
包括工作流用 `console.log` 打印的 agent 回复,写入时即脱敏;以及 Chat Host 的会话
(`<runsRoot>/_chat/sessions.json` 和 `/api/chat/sessions` 提供的内容):Codex 的回复完整
脱敏,你输入的内容——以及作为消息贴回的运行结果——只脱敏令牌形态,因为那是你的数据;仍在
流式输出的回复在结束前只保留完整的行,开启脱敏前保存的会话文件在读取时脱敏。运行的 `args`
也是你的数据,可能带着令牌:`/api/runs/:id` 和看板提供的 args 会脱敏令牌形态
(`argsRedacted: true`),`/api/schedules` 提供的定时任务 args 也一样——但 `meta.json` 和
定时任务本身按原样保存,所以 `odw rerun` 和 `odw resume` 用原始 args 启动新运行。被脱敏过的
内容会以 `redacted: true` 标明——保存的结果、事件、transcript 行及其在 API 中的条目、
`result.json`、`error.json`、webhook 负载、聊天消息——`odw doctor` 会说明脱敏是否开启、覆盖了哪些变量。脱敏随
输出到达而进行,不会囤积输出:一行等到行尾,一个私钥等到它的最后一行。

不会被脱敏的:
- **agent 拿到的内容。** 提示词和 agent 的环境变量从不改动,`agent()` 和 `exec()` 交回
  给工作流的内容也不改:脱敏只针对写下来的东西。
- **运行的结果** 是工作流自己的数据——它可能有意返回读到的配置——所以 `result.json`
  只应用 `patterns` 和 `extra`,从不应用 `env`。
- **保存的 diff**(`agents/<id>.diff`)是 agent 对你代码的改动:也就是 `odw apply` 要应用、
  保留分支要提交的内容,标记会损坏你的文件。agent 写进代码里的密钥,应在审阅时发现
  (`odw diff`、看板的 Changes 标签页)。
- **`meta.json` 里保存的运行 `args`**(以及定时任务的):`odw rerun` 和 `odw resume`
  必须从你传入的原样开始,只有对外提供的内容会脱敏。Chat Host 交给 Codex 的内容也不脱敏:
  一个回合所回答的消息按你输入的原样交给它(更早的消息按保存的样子)。
- **恢复的运行** 会按保存时的样子(已脱敏)重放 agent 的结果,并在日志中说明。

脱敏是安全网,不是保险库:形态未知、变量名又不像密钥的秘密会按原样保存。用
`agentEnv: "minimal"` 可以让 agent 从一开始就看不到它不需要的东西。
