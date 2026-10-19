# 适配器与模型

[English](../../guides/adapters-and-models.md) · 简体中文

由哪个 agent CLI、用哪个模型来跑一个 agent，以及如何读取它的输出。全部配置键：[配置参考](../reference/config.md)。

## 配置适配器

Codex、Claude Code、Gemini、Qwen、Kimi、Oh My Pi、Kilo Code、OpenCode、Cursor
以及 Google 的 Antigravity CLI 均开箱即用:

| 适配器 | 本地 CLI | 非交互契约 |
| --- | --- | --- |
| `codex` | `codex` | `exec --json` 事件;回复取自 `--output-last-message` 文件(否则取最后一条 `agent_message`),token 取自 `turn.completed`,错误取自 `turn.failed` / `error`;自带联网搜索;strict schema 走原生(`--output-schema`) |
| `claude` | `claude` | stream-json 事件;回复、用量、花费和错误取自其 `result` 事件;放行 WebSearch/WebFetch;schema 走原生(`--json-schema`) |
| `gemini` | `gemini` | stdout 文本 |
| `qwen` | `qwen` | stdout 文本 |
| `kimi` | `kimi` | stdout 文本 |
| `omp` | `omp` | `--print --no-session --approval-mode yolo`;stdin 传提示词 |
| `kilo` | `kilo` | `run --format json --auto`;从 JSONL 解出最终文本 |
| `opencode` | `opencode` | `run --format json --auto`;从 JSONL 解出最终文本 |
| `cursor` | `agent` | `--print --force --trust`;stdin 传提示词 |
| `agy` | `agy` | `--output-format stream-json`,stdin 传提示词;回复、token、错误和被拒的工具调用(`denied_actions`)取自其 `result` 事件;根为对象的 schema 走原生(`--json-schema`) |

> **`gemini` 对个人与免费账号已停止支持。** Google 已于 2026-06-18 停止对个人(Gemini Code
> Assist for individuals)与免费账号的 Gemini CLI 支持;这类登录现在会得到 "This client is no
> longer supported for Gemini Code Assist for individuals",ODW 将其归为 `model_unavailable`
> ([回退链](#按阶段路由与回退链odw-扩展)会换到下一个适配器)。请改用 `agy` 适配器
> (Antigravity CLI)。企业与 Google Cloud 许可据称仍可使用(未经核实)。出处:
> [littlebearapps/untether#720](https://github.com/littlebearapps/untether/issues/720)。

内置的 `codex` 和 `claude` **自带联网能力**,调研类 workflow 零调参就能跑。
`odw init` 会列出装了哪些 CLI
(带各自的权限姿态)并设置默认——在终端里是交互式选择,其他环境退化为纯报告,
`odw init --adapter <名字>` 则不弹提示直接写入。要调参或加自己的 CLI,放一个
`odw.config.json`(见 [`odw.config.example.json`](../../../odw.config.example.json))到项目根、
`~/.config/odw/config.json`,或用 `--config` 指定。ODW 只调用本地命令——绝不直接调
模型 API。

```jsonc
{
  "defaultAdapter": "claude",
  "concurrency": 8,
  "adapters": {
    "my_wrapper": {
      "label": "My custom CLI",
      "command": ["my-agent", "--cwd", "{workspace}", "--prompt-file", "{prompt_file}"]
    }
  }
}
```

自定义适配器默认把 stdout 作为文本并去掉首尾空白。JSONL 事件流需要显式声明事件
类型和最终文本路径:

```jsonc
"output": {
  "format": "jsonl",
  "eventType": "text",
  "textPath": ["part", "text"],
  "select": "last"
}
```

**ODW 扩展:** JSON 输出还可以声明这次运行花了多少、CLI 自己是否报告了失败,以及它拒绝了
agent 的哪些工具调用。内置的 `claude` 适配器就是这样声明的:

```jsonc
"output": {
  "format": "jsonl",
  "eventType": "result",          // 回复所在的事件(以最后一个为准)
  "textPath": ["result"],
  "select": "last",
  "usagePath": ["usage"],         // token 计数,位于 usageEvent 事件中(默认同 eventType)
  "costPath": ["total_cost_usd"], // 美元花费,位于同一事件
  "errorPath": ["is_error"],      // true、一条消息或一个错误对象:这次运行以它失败
  "deniedPath": ["permission_denials"], // CLI 拒绝的工具调用:记在 agent 上并写入日志
  "mcpEvent": "system",           // 列出 MCP 服务器的事件(Claude Code 的 init)
  "mcpPath": ["mcp_servers"]      // 每项 { name, status }:没连上的记在 agent 上并写入日志
}
```

内置 `codex`(以下均为 ODW 扩展)读取 `codex exec --json`:回复是最后一个 `item.type` 为
`agent_message` 的 `item.completed` 事件(`match`)——除非它写入最终消息的文件
(`--output-last-message {reply_file}`)里有,文件优先:`{reply_file}` 是每次 CLI 运行在私有
临时目录里新建的路径,CLI 退出后读取,随后删除。token 取自 `turn.completed`;`turn.failed`
与 `error` 事件是它自己报告的失败(`errorEvents`:事件类型 → 消息所在路径),像其他失败一样
归类——codex 自己重试过、随后这一轮正常完成的 `error` 不算失败:

```jsonc
"codex": {
  "label": "Codex CLI",
  "command": ["codex", "--search", "exec", "--json", "--output-last-message", "{reply_file}",
              "--skip-git-repo-check", "{permission_args}", "--cd", "{workspace}", "-"],
  "stdin": "{prompt}",
  "flags": { "model": ["--model"], "schema": { "args": ["--output-schema"], "mode": "file", "strict": true } },
  "output": {
    "format": "jsonl",
    "eventType": "item.completed",
    "match": { "path": ["item", "type"], "equals": "agent_message" }, // 只有这些事件带回复
    "textPath": ["item", "text"],
    "select": "last",
    "usageEvent": "turn.completed",
    "usagePath": ["usage"],                                          // 只有 token:codex 不报花费
    "errorEvents": { "turn.failed": ["error"], "error": ["message"] }
  },
  "permissionArgs": {
    "read": ["--sandbox", "read-only"],
    "edit": ["--sandbox", "workspace-write"],
    "full": ["--sandbox", "danger-full-access"]
  }
}
```

给 `codex` 写了自己 `command` 的条目会整体替换内置适配器:要连同这个 `output` 块(以及
`--json`)一起写,否则它的 agent 不上报用量,回复也会是 codex 的文本输出。codex 的一轮结束时
若没有任何 agent 消息——回复文件为空、也没有 `agent_message` 事件——回复就是空的,agent 以
`empty_reply` 失败(`allowEmpty: true` 可接受),而不是返回一堆事件;运行日志会写明到底缺了
什么。事件里没有回复而回复文件里有时,回复照常成立,日志说明事件与声明不符。

内置的 `agy`(Google 的 Antigravity CLI,依据它的
[无头模式文档](https://antigravity.google/docs/cli/headless)与更新日志;全部为 ODW 扩展)读取
`--output-format stream-json`,它的事件用 `event` 键标明类型——由 `output.eventKey` 声明
(默认 `"type"`)。回复、token、失败与被拒的工具调用都取自最后的 `result` 事件;agy 不报告
花费。失败回合的 `error`("Individual quota reached … Resets in 2h39m52s."、
"Authentication expired. Please log back in.")与其他失败一样分类。只有根为
`"type": "object"` 的 schema 才走原生(`flags.schema.objectRoot`:其他 schema agy 会在启动时
拒绝),其他的写进提示词。

```jsonc
"agy": {
  "label": "Antigravity CLI",
  "command": ["agy", "--output-format", "stream-json", "--input-format", "text",
              "--disable-slash-commands", "--print-timeout", "24h", "{permission_args}"],
  "stdin": "{prompt}",                                               // 不用 -p:argv 有长度上限
  "flags": { "model": ["--model"], "schema": { "args": ["--json-schema"], "mode": "inline", "objectRoot": true } },
  "output": {
    "format": "jsonl",
    "eventKey": "event",                                             // {"event":"result","result":{…}}
    "eventType": "result",
    "textPath": ["result", "response"],
    "select": "last",
    "usagePath": ["result", "usage"],                                // 只有 token:agy 不报告花费
    "errorPath": ["result", "error"],                                // 只在运行失败时出现
    "structuredPath": ["result", "structured_output"],
    "deniedPath": ["result", "denied_actions"]
  },
  "permissionArgs": {
    "edit": ["--mode", "accept-edits"],
    "full": ["--mode", "accept-edits", "--dangerously-skip-permissions"]
  }
}
```

无头 agy 无法请求审批的工具调用会被软拒绝:运行以 0 退出,`response` 常常是空的
([antigravity-cli#794](https://github.com/google-antigravity/antigravity-cli/issues/794)),
所以 agent 以 `empty_reply` 失败,`denied` 写明 agy 拒绝了什么。子 agent 的输出也不会进入
agy 的事件流([antigravity-cli#1077](https://github.com/google-antigravity/antigravity-cli/issues/1077)):
transcript 会列出它启动的每个子 agent 及其日志路径。agy 的事件流从不说明子 agent 何时结束,
所以 `agy` 没有声明 `output.background`。

在 `acceptEdits` 下,Claude Code 无头运行时会直接拒绝本该询问的操作——比如没在允许列表里
的 shell 命令——而回复仍可能声称成功;`deniedPath` 读的就是这些拒绝。默认情况下回复照常
成立,被拒绝的调用作为 `denied` 记在 agent 上,并写一行日志;`"permissionDenials": "fail"`
(运行级,或写在适配器条目里)让这样的 agent 以 `permission` 失败,而设了 `expect` 的
`agent()` 调用会把它们算作一项缺失。在适配器对应档位的 `permissionArgs` 里放行 agent 需要
的操作。

每个 `usageEvent` 事件的用量会累加;不同 CLI 的字段名(Anthropic、OpenAI、Codex)会被
统一归一化——见 [`src/adapters/usage.ts`](../../../src/adapters/usage.ts)。只打印一个 JSON 文档
的 CLI 则用 `{ "format": "json", "textPath": […], "usagePath": […], "costPath": […],
"errorPath": […], "deniedPath": […] }`;路径里的整数用于索引数组(负数从末尾数)。`errorPath` 上报的失败
会像任何失败的运行一样被归类——不论退出码——所以限流会被重试,额度用尽会说明何时重置。
输出里找不到声明的文本时——CLI 的格式变了,或配置写错了——原始 stdout 就作为回复,运行
日志会说明原因;agent 不会因此失败。同时把回复写进 `{reply_file}` 的 CLI(如 `codex`)先从
文件读取;两处都为空时,回复为空,而不是一堆事件。

ODW 只把解码后的最终响应交给 workflow;JSONL 输出会边流式到达边逐行解码(只保留最新文本
和用量合计,而不是整段记录),stderr 只保留有限的尾部用于错误信息。
Windows 下的可执行文件探测遵循 `PATHEXT`,所以 `agent.cmd`、`kilo.cmd`、`omp.exe`
这类普通 shim 无需写完整路径也能识别。

配置键全部放在**顶层**——没有 `"settings"` 包装层;odw 会对未知或放错位置的键
在 stderr 上给出警告(附 did-you-mean 提示),而不是静默忽略。没设
`defaultAdapter` 时,odw 会用唯一配置的 adapter——或在全新安装下,用 PATH 上
唯一真实存在的那个 CLI;若装了多个,报错会列出它们并告诉你如何选择。

## ACP agent(ODW 扩展)

说 [Agent Client Protocol](https://agentclientprotocol.com)(Zed、JetBrains 编辑器驱动编码 agent 的协议)的
agent 可以直接作为适配器:写上 `"protocol": "acp"` 和启动其 ACP 模式的命令。ODW 像编辑器一样,
经 stdin/stdout 上的 JSON-RPC 驱动它(自带的最小客户端,零依赖)。这只是新增一种接入方式,不替换任何内置适配器的无头模式。

```json
{
  "adapters": {
    "gemini-acp": { "protocol": "acp", "command": ["gemini", "--experimental-acp"], "label": "Gemini CLI (ACP)" }
  }
}
```

ACP 启动参数以各 agent 自己的文档为准(`gemini --help`;较新的 Gemini CLI 可能叫 `--acp`)。
`acp` 适配器不接受 `stdin` 和 `output`(提示与回复走协议),也不能只给内置适配器改 `protocol`——请另起名字。
其余字段照常生效:`env`、`timeout`、`stallTimeout`、`flags.model`(追加到命令)、`permissions`、
`permissionArgs`(按档位给命令加的参数)、`sandbox`、`agentLimits`、回退链与多账号。

ODW 实现的部分(协议版本 1),每次 CLI 运行:

| 步骤 | ODW 的做法 |
| --- | --- |
| `initialize` | 协议版本 1;**不声明任何客户端能力**——没有 `fs`、`terminal`、elicitation(agent 自己读写文件);agent 若请求其中任何方法,回答 method not found |
| `session/new` | `cwd` 为 agent 的工作区(隔离时为其 worktree);ODW 不提供 MCP 服务器 |
| `session/prompt` | agent 的提示作为一个文本块;回合以响应的 `stopReason` 结束——`end_turn` 以外的(`max_tokens`、`max_turn_requests`、`refusal`、`cancelled`)都使这次调用失败 |
| `session/update` | 流式读取消息与思考片段、工具调用及其更新、计划、`usage_update`;回复是 agent 最后一次工具调用之后的消息文本 |
| `session/request_permission` | 立即**按 agent 的权限档位**应答,不问任何人 |
| `session/cancel` | 运行被停止、超时、卡死或触到限额时,在杀进程之前发送 |

档位按工具调用的 ACP `kind` 应答权限请求:

| 档位 | 允许 | 拒绝 |
| --- | --- | --- |
| `read` | `read`、`search`、`think`、`fetch`(不可信输入的运行不含 `fetch` 与 `search`,除非其沙箱网络是允许列表或 none) | `edit`、`delete`、`move`、`execute`、`switch_mode`、`other` 及其他 |
| `edit` | 以上,加 `edit`、`delete`、`move` | `execute`、`switch_mode`、`other` 及其他 |
| `full` | 全部 | 无 |

ODW 选 `allow_once`(或 `reject_once`),从不选 `*_always`——任何应答都不会变成 agent 记住的规则;
agent 没给拒绝选项时,ODW 取消该请求(等于不允许)。每次应答写一个 `acp_permission` 事件
(`toolCallId`、`title`、`kind`、`decision`、`option`、`tier`),在 `odw logs`、实时视图与看板 Logs 页显示;
被拒绝的调用像其他 CLI 被拒的工具调用一样记在 agent 上(`permissionDenials`)。

**对 ACP agent 而言,档位只是建议性的。** 它的强度取决于 agent 自己是否请求权限:ODW 只能拒绝它来问的事。被配置成不经询问就编辑或执行命令的 agent 不会被拦下;
超出档位、kind 不是 `read`、`search`、`think` 的工具调用(包括 `other`、`switch_mode` 与 ODW 不认识的 kind)未经请求就执行时,
ODW 记一个 `decision: "unasked"` 的 `acp_permission` 事件——不会静默放过,但已是事后。真正的保证需要[容器沙箱](safety-and-trust.md#在容器中运行-agentodw-扩展);
有不可信输入时,`untrustedInput.requireSandbox: true` 会拒绝 agent(包括 ACP agent)不在网络受限沙箱中的运行。`read` 档至少要配合 agent 自身的审批设置。

会话以 ODW 自己的 `acp.*` 事件保存(`acp.message`、`acp.thought`、`acp.tool_call`、`acp.tool_result`、
`acp.permission`、`acp.plan`、`acp.usage`、`acp.error`、`acp.result`),不保存原始 JSON-RPC;这些事件进入
agent 的 transcript(`odw logs --agent`、看板抽屉)、实时的 `toolCalls`/`costUsd` 限额与失败原因——JSON-RPC 错误像任何
CLI 失败一样归类(例如 `session/new` 返回 `auth_required` 即原因 `auth`)。用量只取协议携带的部分:
`usage_update` 中以美元计的累计 `cost`;token 数只在 prompt 响应带有 `usage` 对象时读取(协议草案,存在才读)。
两者都没有的 agent,与其他 CLI 一样按回复字符数/4 估算。agent 的 stdout 与缓冲读取的 CLI 一样计入 32 MiB 的输出上限
(超过即停止运行);一条消息与回复最多保留 4 MiB,一段思考 256 KiB,一个工具的输出 64 KiB,`denied` 最多列出 1000 个调用。

`odw doctor --adapter <名字>` 对 ACP agent 做一次握手:只发 `initialize`(不建会话、不发提示、不花钱),
报告 agent 名称与版本、协议版本、`loadSession`、提示与 MCP 能力、登录方式;`--smoke` 照常发一次真实提示。

未实现:把 ODW 做成 ACP *agent*(让编辑器驱动 ODW)、远程传输、elicitation(结构化提问——不声明该能力)、
客户端 `fs` 与 `terminal` 方法、`session/load`、额外工作区根、会话模式与配置项、替 agent 登录(请先自行登录)。

## 结构化输出(ODW 扩展)

`agent(prompt, { schema })` 返回的值要么满足它的 JSON Schema,要么调用失败。背后有两层保障:

- **没有约束会被悄悄放过。** ODW 的校验器检查 `type`(单个类型名)、`enum`、`properties`、
  `required`、`additionalProperties: false`、`items`(单个 schema)和 `minItems`;
  `description`、`title`、`format` 这类注解不构成约束。agent 启动前,ODW 会找出其他内容——
  `oneOf`、`anyOf`、`allOf`、`$ref`、`const`、`pattern`、`minimum`、`maxItems`、
  `["string", "null"]` 这样的类型联合、没有 `"type": "object"` 的对象关键字——并在运行日志里
  只说一次哪些关键字它不检查、位于何处(`"oneOf" at #/properties/status`)。调用照常运行,
  ODW 校验其余部分。设 `"schemaKeywords": "strict"` 则改为在任何东西启动前以 `AgentError`
  拒绝这类调用。拼错的关键字(`requird`,附 did-you-mean 提示)或其他格式错误的 schema 在两种
  模式下都会让调用失败。
- **会校验 schema 的 CLI 直接拿到 schema。** 内置 `claude` 通过 `--json-schema` 拿到
  schema,值取自其 `result` 事件的 `structured_output`;`codex` 拿到
  `--output-schema <file>`,该文件(run 目录下的 `agents/<agentId>.schema.json`)只在它的
  CLI 运行期间存在。ODW 依旧校验每一次回复、带反馈重试;只有不接收原生 schema 的 CLI 才会在
  提示词里看到 schema 描述(`"schemaPrompt": "always"`:所有 CLI 都附上)。

Codex 以 OpenAI 的 strict 模式发送 `--output-schema`,它只接受根为对象、且每个对象都设
`"additionalProperties": false` 并把全部属性列进 `required` 的 schema。其他 schema 仍像以前
一样放在提示词里交给 codex,运行会提示一次。

想让这类关键字真正生效,就把 agent 放到会强制执行它们的 CLI 上:它拿到完整 schema,运行日志
会说明这些关键字交给了它。`schemaKeywords` 取 `"warn"`(默认)或 `"strict"`。

自定义 CLI 在 `flags.schema` 里声明它如何接收 schema——`"inline"`(schema 的 JSON 作为下一个
参数)或 `"file"`(一个保存 schema 的文件路径),只接受 OpenAI strict schema 的 CLI 再加
`"strict": true`;若它的 JSON 输出把校验后的值与文本分开放,再声明位置:

```jsonc
"my_cli": {
  "command": ["my-cli", "--print"],
  "stdin": "{prompt}",
  "flags": { "schema": { "args": ["--schema"], "mode": "inline" } },
  "output": { "format": "json", "textPath": ["text"], "structuredPath": ["data"] }
}
```

schema 参数排在所有其他参数之后(与模型参数同处),且不做占位符展开。没有 `flags.schema`
时,schema 写进提示词,只由 ODW 检查回复。

## `agentType` 读取 agent 定义(ODW 扩展)

`agent(prompt, { agentType: "reviewer" })` 运行 Claude Code 子 agent 文件里定义的那个 agent
——带 YAML 前言的 Markdown,正文是它的提示词(https://code.claude.com/docs/en/sub-agents)——
无论这次调用跑在哪个 CLI 上:

```markdown
---
name: reviewer
description: Reviews a change for bugs
tools: Read, Grep, Glob
model: sonnet
effort: high
---
You are a meticulous reviewer. Report bugs only.
```

ODW 按 Claude Code 的方式查找——认前言里的 `name`,不认文件名:工作目录及其每一级父目录直到仓库根的
`.claude/agents/`(最近者胜),然后同样方式的 `.odw/agents/`(ODW 独有的位置,格式相同),
然后 `~/.claude/agents/`,最后是已安装且启用的 Claude Code 插件的 `agents/`,名字为 `<plugin>:<name>`。映射如下:

| 字段 | ODW |
| --- | --- |
| 正文 | 作为人设提示词,取代原来的一句话人设,所有 CLI 都生效。 |
| `model` | 该调用的默认模型;`agent()` 自己的 `model` 优先,它又优先于阶段的默认值。在 `claude` 上原样传;其他 CLI 上别名经同名的 `models` 层级映射(`"models": { "sonnet": { "codex": "gpt-5.5" } }`),映射不到就用该 CLI 的默认模型,并在运行日志里说明。`inherit` 表示不指定。 |
| `tools`、`disallowedTools` | 给 agent 的[权限档位](safety-and-trust.md#权限档位odw-扩展)封顶,只降不升:只有 Read、Glob、Grep、WebFetch、WebSearch → `read`;不含 Bash → 最高 `edit`。`claude` 另外拿到 `--tools`(与档位自带的列表取交集,只收窄)和 `--disallowedTools`(一个逗号分隔的参数)。每一项必须是工具名,可带规则(`Read`、`Bash(git *)`、`mcp__gh__issue`);其他的——以 `-` 开头、含空白——被略去并记入日志。`tools` 里的规则按其工具计,但不会被强制(`--tools` 只接受工具名),日志会说明。 |
| `isolation: worktree` | 等同 `agent()` 的 `isolation: "worktree"`。 |
| `effort` | `claude --effort`、`codex -c model_reasoning_effort=`(minimal–xhigh);其他 CLI 上日志会说明未生效。 |
| 其他字段 | `permissionMode`、`maxTurns`、`mcpServers`、`hooks`、`skills` 等不生效,日志逐个列出。 |

每个定义每次运行只读一次,并连同文件路径记入日志;`agent_started` 带 `agentType: { name, source, path, sha256 }`,
看板的 agent 抽屉会显示,`odw compare` 会列出两次运行之间文件变了的定义(`agentDefinition.<name>`)。
找不到定义时保留一句话人设,并记一条日志。`--untrusted` 运行中,来自仓库的定义只取正文、tools 与 isolation,
不取 model 和 effort;并且用户自己的与插件的定义优先:仓库里同名的定义不会遮蔽它们(日志会指出)。
名字里带 `:` 的只能是插件的 agent;自称 `x:y` 的定义会被拒绝。定义文件是符号链接时,只有链接目标仍在
它所在的 agents 目录内(用户的:在用户主目录内)才会被读取。适配器在 `flags` 里声明承载方式:`effort`(元素里可写 `{effort}`)、`effortLevels`、`tools`、`disallowedTools`。

```sh
odw agents types                  # 列出这里能用的定义,以及在默认适配器上的映射
odw agents types --adapter codex --json
```

## 按阶段路由与回退链(ODW 扩展)

**ODW 扩展。** 按阶段混用 CLI 和模型——搜索扇出用便宜的模型,综合用强的——并在某个 CLI
额度用尽时让运行换到另一个 CLI 上继续。

**阶段默认值。** `meta.phases` 的条目可以为该阶段的 agent 指定适配器和模型:
`{ title, adapter?, model? }`(纯字符串条目仍然只是标题)。`phase(title, { adapter, model })`
为其后的 agent 设置它们,取代该阶段在 meta 里的条目;只写 `phase(title)` 则保留该阶段已有
的设置。`agent()` 调用自己给出的选项永远优先;调用自带的 `phase` 选项会带上那个阶段的默认值。

```js
export const meta = {
  name: 'research',
  description: 'Search cheaply, synthesize carefully.',
  phases: [
    { title: 'Search', adapter: 'codex', model: '@fast' },
    { title: 'Synthesize', adapter: ['claude', 'codex'], model: '@strong' },
  ],
}
phase('Search')
const notes = await parallel(angles.map((a) => () => agent(`Research ${a}; cite sources.`)))
phase('Synthesize')
return await agent(`Synthesize:\n${notes.filter(Boolean).join('\n---\n')}`)
```

**模型分层。** 配置里的 `models` 定义若干层级,每层为每个适配器给出一个模型 ID。
`model: "@fast"`——写在 `agent()`、`phase()` 或 `meta.phases` 里——让 agent 使用其适配器
在该层级下的模型;回退之后用下一个适配器的。某层级没给该适配器模型时,使用其 CLI 的默认模型
(记一条日志);未知层级会让该 agent 以 `AgentError` 失败,并列出已有的层级。不带 `@` 的
模型就是模型 ID,原样传给每个适配器——所以有回退链时请用层级。

**回退链。** 配置里的 `fallback` 为每个适配器按顺序列出之后要尝试的适配器;
`agent(prompt, { adapter: ["codex", "claude"] })` 为单次调用指定回退链,取代该设置。当
agent 的 CLI 额度用尽或登录被拒时,它会在下一个适配器上重新运行——全新的提示词、相同的
选项——而不是失败(限流仍然在原适配器上扛过去)。每次切换都会记日志,agent 会在新适配器
上取得一个槽位(先释放旧适配器的),它的 transcript 在一行
`{"kind":"attempt","reason":"fallback","adapter":"claude"}` 之后继续,失败的那些运行花掉的
用量照样计入:

```text
search:3 → claude after codex quota
```

- 回退时沿用 agent 自己的权限档位:不能恰好运行该档位的适配器会被跳过并记一条日志——
  绝不换成别的档位运行。
- 调用的 `expect` 检查随它一起走:下一个适配器的工作按同样的方式检查,也在那里重试;没达到
  检查的工作绝不会回退(见[检查 agent 的工作](../reference/workflow-api.md#检查-agent-的工作odw-扩展))。
- `agent_finished` 记录产出结果的适配器,并用 `fellBackFrom` 记录 agent 离开过的那些;保存
  的结果也一样。`odw status`、实时视图(`codex → claude`)和 `/api/runs/:id` 都会显示。
- **额度熔断。** 同一个适配器上连续 `quotaBreaker`(默认 3)次额度失败后,本次运行之后的
  agent 都会跳过它:各自从回退链上的下一个适配器开始,没有回退链的则立即失败。只记一条
  警告,`odw status` 也会列出它。

**交接工作,而不是从头再来。** 默认情况下回退会让 agent 的工作从头开始:隔离 agent 做了一半
的 worktree 被丢弃,下一个 CLI 再花额度把上一个做过的重做一遍。配置
`"fallback": { "handoff": true }`(`handoff` 在这里是保留键,不是适配器)或
`agent(prompt, { handoff: true })`(两个方向都覆盖设置)后,下一个适配器会接着做:

- 隔离 agent 的 worktree 保留下来:下一个适配器在其中运行,做了一半的改动原样在场——并且在
  该调用的每次运行中(卡住后的重启、限流重试、schema 重试)都沿用它。原地 agent 的改动本来就在
  源码树里。worktree 只交给信任级别和容器引擎都相同的适配器:不受信任或沙箱不同的回退会在新的
  worktree 中开始,仍然拿到简报,简报会说明之前的改动没有带过来。
- 它的提示词在任务之前加一段以 *"You are continuing work another agent started…"* 开头的
  交接简报:上一个适配器停下的原因、改过的文件(worktree 的 diff 统计;原地 agent 取其编辑
  类工具调用涉及的文件)、它最后写下的计划或待办(Claude Code 的 `TodoWrite`、Codex 的计划)、
  运行过的命令及其结果、最后几条消息(文本 CLI 取输出末尾)。至多 6 KB,每一部分都先脱敏
  再截断。推理过程无论如何都会丢失——简报是其中看得见的部分,精简到下一个 agent 需要的
  程度。
- 简报保存为 `agents/<id>.handoff.md`;`handoff` 事件 `{ from, to, reason, bytes }` 记录这次
  交接,transcript 在下一个适配器的 `attempt` 行之前有一行 `{"kind":"handoff",…}`
  (`odw logs --agent` 会显示;看板侧栏把简报折叠在其中)。
- `expect` 与保留的 diff 判定最终状态:共享 worktree 相对其基线的 diff,两个适配器的工作都在
  其中。`expect` 重试仍在新的 worktree 中从头开始,等待额度重置(`quotaWait`)之后的调用也
  一样。交接属于同一次调用:`odw resume` 照旧重放该调用。

```jsonc
{ "fallback": { "codex": ["claude"], "handoff": true } }
```

```jsonc
{
  "fallback": { "codex": ["claude"], "claude": ["codex"] },
  "quotaBreaker": 3, // 默认值;0 或 null 表示从不跳过适配器
  "models": {
    "fast": { "claude": "haiku", "codex": "gpt-5-mini" },
    "strong": { "claude": "opus", "codex": "gpt-5" }
  }
}
```

`odw resume` 像重放其他调用一样重放发生过回退的调用,不会再走一遍回退链。一次调用的 resume
key 是它写下的提示词和选项:阶段默认值和运行的默认适配器一样不在其中,所以把某个阶段改到
别处——比如离开额度用尽的 CLI——仍会重放所有已完成的调用。

## 同一个 CLI 的多个账号

**ODW 扩展。** 如果你有不止一个 Claude Code 或 Codex 登录,`accounts` 让一次运行把它们
都用上,不必在某个账号额度用完时手动重新登录。每一项都会成为一个独立的适配器
`<适配器>@<名字>`:

```jsonc
{
  "accounts": {
    "claude": [
      { "name": "work", "configDir": "~/.claude-work" },
      { "name": "home", "configDir": "~/.claude-home", "concurrency": 2 }
    ],
    "codex": [{ "name": "team", "configDir": "~/.codex-team" }]
  }
}
```

- `claude@work` 就是 `claude` 适配器,只是把该 CLI 文档中的配置目录变量设为这个账号的目录:
  Claude Code 用 `CLAUDE_CONFIG_DIR`,Codex 用 `CODEX_HOME`。每个账号先手动登录一次:
  `CLAUDE_CONFIG_DIR=~/.claude-work claude auth login`、`CODEX_HOME=~/.codex-team codex login`。
  其他 CLI 一律拒绝:ODW 不知道有哪个变量能把两个登录分开。
- 每个账号有自己的并发上限(取其适配器的 `concurrency`,或该项自己的)和自己的额度熔断;
  其余定义与其适配器相同。每一项接受 `name`、`configDir`(绝对路径或 `~/` 开头)、
  `concurrency` 和 `label`。
- `agent(…, { adapter: "claude" })`——以及默认适配器、提到 `claude` 的回退链——表示
  *任意一个 claude 账号*:这次调用得到一条由这些账号组成、按余量排序的链,某个账号用完时
  **交接工作**(与 `"fallback": { "handoff": true }` 相同;`agent(…, { handoff: false })`
  则从头开始)。`adapter: "claude@work"` 只在这个账号上运行。
- **余量**在每次路由调用时计算:不处于额度暂停的账号在前(额度熔断已把它移出,或在
  `quotaWait` 下额度用完、等待重置),其次是本次运行中额度失败最少的,再次是本次运行中
  已路由到它、尚未结束的 agent 最少的;相同时保持配置中的顺序。扇出因此会分散到各个账号。
- 模型档位里没有 `claude@work` 的 id 时,使用 `claude` 的。
- agent 的适配器在事件、实时视图、看板抽屉与花费小票中都显示为 `claude@work`;`odw status`
  按账号分组列出 agent(`accounts of claude: claude@home 2 agents · claude@work 1 agent, 1 moved on`)。
- `odw doctor` 不调用模型地检查每个账号的登录——用该账号的目录运行 `claude auth status`
  或 `codex login status`——`odw doctor --smoke --adapter claude` 会通过每个账号各发一次提示词。
- 在容器沙箱中,复制(或绑定)进容器 home 的是该账号的目录,而不是 `~/.claude`。

能否把多个账号合在一起使用,取决于各服务商的服务条款:配置多个账号之前请先确认。ODW
只是在你提供的登录之间切换。

## 本地模型:检查推理服务,把廉价阶段交给它(ODW 扩展)

**ODW 扩展。** 本地模型(Ollama、LM Studio)通过能连接它们的 agent CLI 运行——在
`opencode.json` 里配置了提供方的 `opencode`、`codex --oss`,或你自己的适配器;没有内置的
`ollama` 适配器。它们的失败是静默的:Ollama 以较小的上下文窗口加载模型,提示放不下时就
截掉前面的部分——也就是 CLI 的说明和工具定义——照样返回 HTTP 200。agent CLI 使用的
OpenAI 兼容 `/v1` 端点会忽略请求里的 `num_ctx`,只有服务端的 `OLLAMA_CONTEXT_LENGTH`
能调大它。`odw doctor --local` 在运行之前把这件事查出来:

```bash
odw doctor --local                                   # :11434 上的 Ollama、:1234 上的 LM Studio
odw doctor --endpoint http://gpu-box:11434           # 你指定的服务(隐含 --local)
odw doctor --local --model qwen3-coder:30b --smoke   # 再加一个约 10K token 的截断探针
```

- **只读。** Ollama 的 `/api/version`、`/api/ps`、`/api/tags` 和 `/api/show`,或 OpenAI 兼容
  服务的 `/v1/models`(以及 LM Studio 的 `/api/v0/models`)。不拉取、不加载、不修改任何东西。
  你指定的服务没有应答算检查失败;默认端口上什么都没有,只给一条警告。
- **每个已加载的模型**(或 `--model` 指定的那个):它实际加载的上下文长度——**低于 32K 时
  警告**,并给出调大的方法(`OLLAMA_CONTEXT_LENGTH=32768 ollama serve`;macOS 应用用
  `launchctl setenv`;systemd 用 `systemctl edit ollama`;然后看 `ollama ps` 的 CONTEXT
  列)——以及它是否声明了工具调用能力。Ollama 版本低于 0.13.4(`codex --oss` 指南要求的版本)
  时警告。普通的 OpenAI 兼容服务既不报告上下文也不报告工具能力,检查会如实说明。
- **`--smoke`**(与 `--local` 同用)向 `/v1/chat/completions` 发一次请求:一个约 10K token
  的提示,第一行是随机口令,最后一行要求回复这个口令。回复里没有口令——前面被截掉了,或者
  末尾的指令被忽略——就是一项失败的 doctor 检查(不是运行的失败原因),并附上服务端统计的
  提示 token 数。探针只发往本机或局域网上的服务(回环、私有和链路本地地址、不带点的主机名、
  `.local`、`.lan`、`.internal`、`.home.arpa`),从不发往 Ollama 的云端模型,也不带任何凭据。
  `--timeout <秒>` 限定时长(默认 180)。与 `--local` 同用时,只有 `--adapter` 指名的适配器
  才会一并做冒烟测试。
- 这些探测只属于 doctor;运行仍然只通过 CLI 访问模型。

**配方:侦察在本地,规划和审阅在云端。** 借助[模型档位](#按阶段路由与回退链odw-扩展),
`meta.phases` 里廉价的阶段跑在本地模型上,其余留在云端模型:

```jsonc
// odw.config.json —— "ollama/…" 是 opencode 的 提供方/模型 id,提供方即其 opencode.json 中声明的那个
{
  "models": {
    "local": { "opencode": "ollama/qwen3-coder:30b" },
    "strong": { "claude": "opus", "codex": "gpt-5" }
  }
}
```

```js
export const meta = {
  name: 'triage',
  description: 'Sort the issues locally; plan and review the fixes in the cloud.',
  phases: [
    { title: 'Scout', adapter: 'opencode', model: '@local' },
    { title: 'Plan', adapter: 'claude', model: '@strong' },
    { title: 'Review', adapter: 'claude', model: '@strong' },
  ],
}
```

模型加载后跑一次 `odw doctor --local --model qwen3-coder:30b --smoke`,服务端设置变化后再跑一次。
