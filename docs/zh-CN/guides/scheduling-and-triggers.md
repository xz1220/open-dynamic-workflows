# 定时与触发

[English](../../guides/scheduling-and-triggers.md) · 简体中文

不靠手动启动的运行：定时、汇总已发生之事的晨报，或由 webhook 触发。分步配方（英文）：[cron](../../recipes/cron.md)、[triggers](../../recipes/triggers.md)。

## 定时运行(ODW 扩展)

每晚的摘要、分诊、审计:`odw schedule` 按 cron 表达式、借助操作系统自带的调度器定时运行
workflow。ODW 不常驻任何 daemon——`add` 写入一条 cron 行、一个 launchd agent 或一个
systemd timer,到点由它回调 odw。

```bash
odw schedule add digest digest --cron "0 8 * * 1-5" --cwd ~/work/news --args '{"since":"yesterday"}'
odw schedule list              # 后端、上次运行(id、状态、时间)、按本地时间计算的下次运行
odw schedule run digest        # 立即运行一次,和调度器触发时完全相同
odw schedule remove digest     # 删除系统里的条目和定义(条目已被手动删掉也没关系)
```

- **后端:** macOS 默认 launchd(`~/Library/LaunchAgents/dev.odw.schedule.<name>.plist`),
  其他系统默认 cron(在你的 crontab 里写入 `# odw:begin <name>` … `# odw:end <name>`
  标记块,其余行原样保留),也可以 `--backend systemd`(用户级 `.service` + `.timer`,带
  `Persistent=true`:关机期间错过的那次会在开机后补跑——cron 会直接跳过;launchd 会在 Mac
  从睡眠中唤醒后补跑一次)。`--dry-run` 原样打印将要写入的内容。Windows 暂不支持:`add`
  会改为打印一条可用的 `schtasks` 命令。
- **每次运行**(`odw schedule run <name>`,即系统条目调用的命令)先拿到该定时任务的锁——
  上一次运行还没结束时,新的一次会被跳过而不是叠加——然后像 `odw run --wait` 那样运行
  workflow,向 `~/.local/state/odw/schedules/<name>.log` 追加一行结果;运行没有以 `done`
  结束时退出码非零。
- **`add` 立即校验** workflow、适配器和配置能否加载,并记录 node/odw 的绝对路径和你当前的
  `PATH`,让 agent CLI 在调度器的环境里也能像在你的 shell 里一样被找到。定义保存在
  `~/.config/odw/schedules.json`。
- **失败通知**走现有的 [`notify`](notifications.md#运行通知) 钩子:定时运行就是一次普通运行(只关心失败时
  用 `"on": ["failed", "stopped"]`)。

表达式是 cron 的五个字段(数字、`*`、列表、范围、步长、`jan`-`dec`、`sun`-`sat`);
`@daily`、`L`、`#` 之类会被拒绝并说明原因。完整说明,以及手写 cron 行这一手动替代方案:
[`docs/recipes/cron.md`](../../recipes/cron.md)。

## 晨报:`odw digest`(ODW 扩展)

一晚上跑了定时任务、触发器和长任务之后,`odw digest` 把它们汇成一份报告——只用运行记录下来的
证据,绝不复述 agent 对自己工作的说法(不转述任何回复、结果或模型写的总结):

```bash
odw digest                         # 最近 24 小时
odw digest --since 12h             # 90m、12h、2d、1w(最多 156w)
odw digest --since-last            # 从上一份已发送(--notify)的晨报算起
odw digest --workflow nightly      # 只看一个 workflow 的运行
odw digest --json | --markdown     # 给脚本用,或直接粘贴
odw digest --since-last --notify   # 经 notify 钩子发送(notify.on 里要有 "digest")
```

分组,每组附上处理它的命令:

- **需要你决定**——此刻在等待的每个检查点(以及 [agent 的提问](checkpoints-and-questions.md#agent-的提问odw-扩展)),
  不受时间窗限制,附 `odw approve|reject … --checkpoint N`;`--notify` 发送时若有
  `odw serve --public-url` 在运行,每条还带签名的一次性批准/拒绝链接。
- **失败**——失败的运行,以及 worker 已经不在的运行(stale):记录的错误、有几个 agent 没完成、
  原因分布(`timeout 1, exit 2`),以及 `odw resume <run>`。
- **完成,但检查未达成**——已完成的运行中,有 agent 没通过 [`expect`](../reference/workflow-api.md#检查-agent-的工作odw-扩展)
  检查、改动了[声明范围](../reference/workflow-api.md#声明范围odw-扩展)之外的文件,或在运行继续的情况下失败了。
- **完成,有待审改动**——隔离 agent 保留了 diff 的已完成运行:文件与行数,以及预览用的
  `odw apply <run> --all --check`。
- **花费**——时间窗内的美元与 token 合计,以及最贵的一次运行。

运行的最后一次写入落在时间窗内即算在内;`--dry` 运行不计。`--notify` 让
[`notify`](notifications.md#运行通知) 钩子触发一次——一天的运行是一条消息,而不是一个运行一条——并且只有在每个
钩子都成功时才移动 `--since-last` 的标记(`<runsRoot>/_digest/marks.json`,按 `--workflow`
分开);不带 `--notify` 只看不会移动它。每个工作日早上发送:

```jsonc
{
  "notify": { "webhook": "https://hooks.example.com/YOUR/PATH", "on": ["digest"] },
  "digest": { "cron": "0 8 * * 1-5" }
}
```

```bash
odw schedule add morning --digest     # 每次触发:odw digest --since-last --notify(时间取 digest.cron,或 --cron)
```

钩子不会发送晨报的配置会被 `add --digest` 拒绝;`--workflow W` 只汇总一个 workflow。配方:
[`docs/recipes/notify.md`](../../recipes/notify.md#a-morning-digest)。

## 由 webhook 启动运行:GitHub、Linear、Slack(ODW 扩展)

从工作所在的地方启动运行,并在那里回复。在配置里写一个触发器,`odw serve` 就会响应
`POST /api/triggers/<名字>`:签名校验通过的 webhook 启动该触发器的工作流,参数取自
webhook 的正文,并返回 `202 { "runId" }`。

```jsonc
"triggers": {
  "gh-triage": {
    "workflow": "triage",                          // 受管工作流名或绝对路径
    "verify": "github",                            // github | linear | slack | hmac-sha256
    "secretEnv": "GITHUB_WEBHOOK_SECRET",          // 或 "secret"(至少 16 个字符)
    "args": { "issue": "$.issue.number", "body": "$.issue.body" },  // JSONPath:$.a.b、$['k']、$.a[0]
    "events": ["issues.labeled"],                  // 可选:事件过滤
    "dedupe": "$.issue.number",                    // 可选:每个 issue 同时只有一个运行
    "concurrency": 2,                              // 可选:同时进行的运行上限
    "rateLimit": { "max": 30, "windowSec": 3600 }  // 默认值
    // 默认 "untrusted": true;"source":运行的工作目录
    // "permissions": "edit" 让它的 agent 可以编辑;"approve": false 跳过第一个可写 agent 的询问
  }
}
```

- **按各家文档验签:** GitHub `X-Hub-Signature-256`,Linear `Linear-Signature`(且
  `webhookTimestamp` 在一分钟内),Slack `X-Slack-Signature` 加五分钟内的
  `X-Slack-Request-Timestamp`,其他来源用 ODW 自己的 `X-ODW-Signature`(对
  `<时间戳>.<正文>` 签名)。都是对原始正文的 HMAC-SHA256、常数时间比较;见过的投递
  (重放或重试)不会再启动运行。GitHub 不签时间戳:它的投递的签名与 `X-GitHub-Delivery` id
  保存在运行根目录下 30 天,重启后依然有效(更早的投递会再次通过校验——密钥可能泄露时请轮换)。
- **只认你自己的配置:** `odw serve` 只从你自己的配置读取触发器——`--config`、`$ODW_CONFIG`,
  或仓库之外的 `~/.config/odw/config.json`。仓库自带的 `./odw.config.json` 不能声明触发器:
  其中的 `triggers` 会被拒绝并给出警告(克隆下来的仓库不能借 webhook 进入你的机器),改为
  提供你自己配置里的触发器。
- **默认不受信任:** issue 文本谁都能写,所以这些运行默认 `--untrusted`,并带有
  [不可信输入](safety-and-trust.md#不可信输入odw-扩展)——agent 只读、不带令牌、可写之前先过检查点——除非触发器写明
  `"untrusted": false`。
- **范围很窄:** 只有你配置里的触发器存在,每个只能启动它自己的工作流。未知的名字、尚未设置的
  密钥、错误/缺失/过期的签名一律返回相同的 `401`(按地址限速;`odw serve` 会在日志里写明原因),
  没有密钥的调用方无从得知有哪些触发器;正文超过 1 MiB `413`,超出 `concurrency` 或
  `rateLimit` `429`。这个路由在非回环绑定(`--host`)上也会响应——签名就是凭据,无需
  `--token`——在回环绑定上则只接受回环 `Host` 与 `--public-url` 的主机(隧道的 URL 填在那里);
  DNS 重绑定防护与看板其他部分一样有效。
- **原路回复:** 运行会记录 `context`——触发器、事件、issue 的 id 与 URL、仓库、Slack 频道与
  线程——[`notify`](notifications.md#运行通知) 钩子都会收到,于是钩子可以在 issue 下评论、在线程里回复,
  或用 `odw apply --pr` 开草稿 PR 并贴上链接。

各平台的设置与这三个钩子:[`docs/recipes/triggers.md`](../../recipes/triggers.md)。
