# 看板

[English](../../guides/dashboard.md) · 简体中文

`odw serve` 能看到什么，以及如何在别处访问它而不把它敞开。

## 看板:观测、检查、对话

看板的视觉像一张印刷品——纸、墨和一种信号色——也可以随时切换到夜间主题。它提供:

- **Activity** —— 每个运行的事件密度"脉搏"山脊图、实时计数、按适配器统计的运行中 agent,
  以及跨所有运行的事件流。
- **Jobs** —— 进行中的运行以实时卡片展示(阶段条、agent 构成、耗时),外加可筛选、分页的历史
  (`#/jobs/live|done|failed` 可直接链接到某个筛选)。
- **单次运行** —— 图(扇出成扇、汇聚成漏斗;边会被"绘制"出来,对应 agent 运行时有信号流动;
  可缩放、适应、拖拽)、显示时间花在哪里的**时间线**、可筛选并可跟随的**日志**、可折叠 JSON 树
  形式的**结果**,以及展示每个已完成 agent 自身输出的 **agent 抽屉**——输出在完成时
  就已保存,运行中即可查看;重放的 agent 标记为 ↺。`exec()` 命令步骤以终端风格的节点
  (带退出码)出现在同一张图和时间线里;运行的计数包含它们(它们不算 agent 派发)。
  在 `checkpoint()` 处等待的运行会在图上方显示问题和它的 payload;看板可写时还提供
  **Approve** / **Reject** 和附言。**Changes** 标签页按文件审阅每个隔离 agent 的改动,
  并可复制 `odw apply` 命令(以及保留的分支)。
- **Workspace** —— 所有已保存的工作流:阶段的静态结构及每个阶段调用的原语、源码和最近的运行。
- **Chat Host** —— 正常的 Codex 对话;提到 ODW 或 workflow 时,该回合会关联到一个真实的后台
  运行,工具卡片实时更新。普通回合运行 `codex exec --json`(只读沙箱、`--ephemeral`),
  并按内置 `codex` 适配器的方式解读:回复取自它的 `--output-last-message` 文件,没有时取最后
  一条 `agent_message`;回复流式输出期间,每条消息完成时即显示。该回合的 token(来自
  `turn.completed`;codex 不报美元)记录在消息的 `usage` 上。codex 报告的失败按 agent 失败
  的方式归类:额度用尽或登录被拒时会说明该怎么做 —— 等额度窗口重置,或执行 `codex login` ——
  消息带上 `failureReason`(`quota`、`auth` 等)(ODW 扩展)。

<table>
  <tr>
    <td width="50%">
      <strong>Activity</strong><br />
      <img src="../../../assets/app-screenshots/activity.png" alt="Activity 页面:标题、实时计数、每个运行事件密度的脉搏山脊图、按适配器的机队和实时事件流" />
    </td>
    <td width="50%">
      <strong>时间线</strong><br />
      <img src="../../../assets/app-screenshots/timeline.png" alt="一次运行的时间线:每个 agent 是一根从开始到结束的条,按阶段分组,运行中带有当前时刻标记" />
    </td>
  </tr>
  <tr>
    <td width="50%">
      <strong>Jobs</strong><br />
      <img src="../../../assets/app-screenshots/jobs.png" alt="Jobs 页面:带阶段条的实时运行卡片和按日期分组的历史表格" />
    </td>
    <td width="50%">
      <strong>夜间主题</strong><br />
      <img src="../../../assets/app-screenshots/job-detail-dark.png" alt="夜间主题下的实时运行图,信号边带有发光效果" />
    </td>
  </tr>
  <tr>
    <td width="50%">
      <strong>待你处理</strong><br />
      <img src="../../../assets/app-screenshots/needs-you.png" alt="Activity 页面的待你处理:一个停在检查点等待审阅的运行,以及一个可以复制 resume 命令的失败运行" />
    </td>
    <td width="50%">
      <strong>检查点</strong><br />
      <img src="../../../assets/app-screenshots/checkpoint.png" alt="停在检查点的运行:审批卡片里是问题和附带内容,带批准与拒绝按钮;图中 Approve 泳道里是一个琥珀色的关卡节点" />
    </td>
  </tr>
  <tr>
    <td width="50%">
      <strong>花费</strong><br />
      <img src="../../../assets/app-screenshots/spend.png" alt="一次运行的花费小票:按阶段的 token 与花费及占比条、按适配器的分段、花费最多的 agent" />
    </td>
    <td width="50%">
      <strong>对比</strong><br />
      <img src="../../../assets/app-screenshots/compare.png" alt="同一工作流两次运行的对比:总耗时、token、花费、完成与失败数及其变化,运行配置的差异,以及每个 agent 一行" />
    </td>
  </tr>
</table>

按 <kbd>⌘K</kbd> / <kbd>Ctrl K</kbd>(或 <kbd>/</kbd>)打开命令面板——跳转到任意运行或工作流、
切换主题或语言、复制跟踪或重跑命令。<kbd>g</kbd> 再按 <kbd>a</kbd>/<kbd>j</kbd>/<kbd>w</kbd>/<kbd>c</kbd>/<kbd>s</kbd>
切换页面,<kbd>1</kbd>–<kbd>5</kbd> 切换运行的标签页,<kbd>$</kbd> 展开花费小票,<kbd>+</kbd>/<kbd>-</kbd>/<kbd>0</kbd> 缩放图。
运行结束时看板会提示;如果在设置中开启,标签页在后台时还会发送桌面通知。

```bash
odw run adversarial-verify --args '{"question":"review src/rate-limiter.js"}'
odw logs --workflow adversarial-verify --follow
```

看板可以在非 loopback 地址上查看,但本地写操作(例如 Chat 消息和停止 ODW 自己的运行)
仍由 loopback server 保护。Claude Code 自己的运行始终严格只读。看板提供的 ODW agent
内容——transcript、结果、日志——在写下之前已对疑似密钥脱敏
(见 [ODW 所保存内容中的密钥](safety-and-trust.md#odw-所保存内容中的密钥odw-扩展))。

## 远程只读访问(ODW 扩展)

在手机上看一夜的运行,又不把你的机器交给任何人:

```bash
odw serve --host 0.0.0.0 --token
# odw dashboard → http://192.168.1.20:4317/#token=Xq3…   ← 打开这个;它只打印一次
```

`--token` 不带值时,odw 生成一个 256 位的随机令牌,并把带令牌的 URL 以 `#token=…` 的形式打印
一次——这是 URL 片段,任何请求都不会携带它,所以令牌不会进入服务器或代理的日志;odw 也不会把它
写到别处。`--token VALUE`(16–256 个 `A-Z a-z 0-9 . _ ~ -` 字符)使用你给的令牌且从不打印——但它
会出现在进程列表里,所以在共享的机器上请用生成的令牌。

安全模型:

- **每个 `/api` 请求和实时流都需要令牌**,三种方式任选其一:`Authorization: Bearer <token>`
  (脚本、`curl`);请求带上 `?token=<token>`,其响应会设置一个 `HttpOnly`、`SameSite=Strict` 的
  cookie(`odw_token_<端口>`);或者带着这个 cookie。看板加载时用 URL 里的 `#token=` 换取 cookie,
  并把它从地址栏去掉。没有令牌:401;页面本身照常加载,显示一个"需要令牌"的界面供粘贴。
- **令牌按常数时间比较**(两边先各自哈希)。一个地址在一分钟内发来 10 个错误令牌后,无论它再发
  什么都回 429,直到这一分钟过去;完全不带令牌的请求不计数。
- **非 loopback 绑定上写操作一律拒绝,与令牌无关**:停止或暂停运行、回答检查点、Chat,在
  127.0.0.1 / localhost / ::1 以外的任何绑定上都是 409。令牌给的是远程*读*,从不给写。(在 loopback
  绑定上,`--token` 对写操作与读操作同样把关,原有的写保护全部照旧:严格的
  `Content-Type: application/json`、同源 `Origin`、防 DNS rebinding 的 Host 检查。在那里,任何有效令牌
  都能写,与其范围无关:`read` 令牌仍可停止、暂停或恢复运行并标记审阅,与其他 loopback 路由一样——
  范围只限制令牌在 loopback 以外能做什么。)
- **这是明文 HTTP。** 令牌和看板展示的一切都以未加密的形式经过网络:请在你信任的网络中使用,
  或通过 VPN、SSH 隧道(`ssh -L 4317:localhost:4317 host` 根本不需要 `--host`),或放在 TLS
  代理后面。
- **持有令牌的人能读到的**就是看板展示的一切:所有项目的运行——ODW 的,以及在默认
  `claudeJobsScope: "all"` 下 Claude Code 的——它们的 args、结果、事件、agent 的 transcript 和
  diff(按上文脱敏),以及设置页上的路径与适配器。用 `--runs-root` 和 `"claudeJobsScope": "project"`
  缩小范围,或者改为把一次运行作为[运行包](running-and-observing.md#分享一次运行odw-扩展)分享。
- **不加 `--token` 时**,非 loopback 绑定与以前一样——只读,任何能连到该端口的人都能读——并且
  `odw serve` 会打印一条醒目的警告,建议加上 `--token`。
- **只有两个窄口子能回答检查点,此外什么都不能写**——见[在手机上批准](#在手机上批准odw-扩展):
  签名的一次性批准链接(`--public-url`),以及 `--token-scope approve`。

## 具名令牌:谁做了什么(ODW 扩展)

几个人在同一台机器上查看、批准时,给每人一个自己的令牌,而不是共用一个——这样每个人做的事
都记在他名下,也可以单独收回某一个人的令牌:

```bash
odw token add alice --scope approve --file ~/.config/odw/tokens.json   # 打印 alice 的令牌,仅此一次
odw token add bob --file ~/.config/odw/tokens.json                      # 权限 read(默认)
odw token list --file ~/.config/odw/tokens.json                         # 名字和权限;remove <name> 收回一个
odw serve --host 0.0.0.0 --tokens ~/.config/odw/tokens.json
```

这个文件是 `{ "name", "scope": "read" | "approve", "hash" }` 组成的 JSON 数组,`hash` 是令牌的
sha256(十六进制)——**文件里从不保存令牌本身**;`odw token add` 只打印一次新令牌,只保留它的
哈希(文件以 0600 写入)。收到的令牌先哈希,再按摘要查找,比较从不在令牌本身上进行;上文
`--token` 的所有规则(三种携带方式、429、非 loopback 上拒绝写)对每个令牌都成立。`--tokens`
可以与 `--token`(一个不具名的令牌,配合 `--token-scope`)同时使用;权限为 `approve` 的具名令牌
可以在非 loopback 上回答检查点,`read` 的只能读。`odw serve` 在启动时读取该文件:修改后需重启。
名字为 1–64 个 `A-Z a-z 0-9 . _ @ + -` 字符。

记录了什么、记在哪里:

- 运行 `meta.json` 中的 **`launchedBy`**:你启动的运行记为本地用户(git `user.email`,否则
  `$USER`),从看板(Chat)启动的记为具名令牌的名字,[webhook 触发器](scheduling-and-triggers.md#由-webhook-启动运行githublinearslackodw-扩展)
  启动的记为 `trigger:<name>`。`odw list --by <name>` 列出某人的运行(`--by me`:你自己的);看板的
  运行标题显示"由 … 启动",Jobs 页多出 **我的 / 团队** 筛选——"我的"即 `/api/capabilities` 返回的
  `you`(你令牌的名字;完全没有令牌时为本地用户;不具名的 `--token` 则没有)。
- 检查点决定的 `by`(渠道——`cli`、`dashboard`、`link`——保持不变)旁边多一个 **`who`**:
  `odw approve|reject` 记为 `cli:<$USER> <git user.email>`,看板记为令牌的名字,批准链接在
  `by: "link"` 之外,记下该请求同时携带的具名令牌的名字。它出现在决定日志(`decisions.jsonl`)、
  `checkpoint_resolved` 事件和 `checkpoint()` 的结果(`result.who`)中。
- **暂停、继续和停止**在 `control.json` 中记录 `who`(`odw pause|resume|stop`:`cli:<user>`;
  看板:令牌的名字);运行日志写出 "paused by …" / "resumed by …",停止时 `run_stopped` 事件带
  `who`,`status.json` 带 `stoppedBy`。

这些是标签,不是访问控制:任何能写运行目录的人都能写入任何名字。除两种权限外没有更细的 RBAC。

## 在手机上批准(ODW 扩展)

[`checkpoint()`](checkpoints-and-questions.md#人工检查点odw-扩展) 不必再等你回到终端。用手机能访问到的 URL(通常是一条
HTTPS 隧道)启动看板,并打开 `waiting` 通知 hook:

```bash
odw serve --public-url https://odw.example.com     # 例如放在 cloudflared 或 tailscale funnel 后面
```

`--public-url` 必须是根 URL(`https://host[:port]`):链接在它的 `/approve/` 下应答,所以带路径
的 URL(把 odw 挂在 `/odw` 下的代理)会被拒绝——像隧道那样给 odw 一个独立的主机名。

```json
{ "notify": { "webhook": "https://hooks.example.com/YOUR/WEBHOOK/PATH", "on": ["waiting"] }, "approveLinks": { "ttl": 86400 } }
```

此后每个开始等待的检查点都会发出两条链接,批准与拒绝:webhook 的 JSON 里是 `approveUrl`、
`rejectUrl` 和 `linksExpireAt`(`text` 末尾也有);通知命令拿到 `ODW_APPROVE_URL`、
`ODW_REJECT_URL`、`ODW_LINKS_EXPIRE_AT` 和 `ODW_NTFY_ACTIONS`——一个现成的 ntfy `Actions`
头,带 Approve 与 Reject 两个按钮([示例](../../recipes/notify.md#approve-from-the-notification))。
打开链接会显示一个小页面——运行、检查点标题、payload 和一个按钮;按下即以 `by: "link"`
记录决定,运行继续。

`odw serve --token X --token-scope approve` 为远程看板做同样的事:持有令牌的人可以批准或拒绝
检查点(与 loopback 上一样可附备注或修改后的 payload)。默认范围是 `read`。

安全模型——唯一的远程写操作是检查点决定:

- **链接就是能力凭证。** 拿到它的任何人都能在它过期或被用掉之前,对那一个检查点做那一个决定——
  像对待承载它的 webhook URL 一样对待它。它是对运行、检查点、动作和过期时间的 HMAC-SHA256,
  密钥按 runs 根目录各有一份(`<runsRoot>/.approve-secret`,权限 0600,由第一次
  `odw serve --public-url` 生成;他人可读的会被替换)。改动链接里的任何内容都会破坏签名;
  `odw serve --rotate-approve-secret` 让之前发出的所有链接失效。
- **只能用一次。** 用过的链接记录在运行目录里(`approve-links/<nonce>`,以独占方式创建,两次
  点击不可能都生效);检查点的另一条链接随之作废。重放、过期的链接(默认 24 小时:
  `approveLinks.ttl`,60 秒到 30 天)或已用别的方式回答的检查点,得到一个清楚的 "410" 页面;
  被篡改的链接得到 "403" 页面——从不出现堆栈。
- **打开链接不会做出任何决定。** 聊天软件的链接预览和邮件扫描只会 `GET`。决定是一个 `POST`,
  带着页面的 CSRF 值,它必须与页面设置的 `HttpOnly`、`SameSite=Strict` cookie 一致;ntfy 按钮
  则在 `X-ODW-Action` 头里写明动作,其他网站的页面发不出这个头。来自其他源的表单会被拒绝,
  页面也不能被嵌入 frame。
- **猜测受到限速**,与错误令牌相同:每个地址每分钟 10 个坏链接(或 CSRF 校验失败),全体合计
  100 个,之后坏链接回 429。链接的签名最先校验,有效的链接从不受限:经同一条隧道发来的坏链接
  挡不住真正的链接。
- **链接只在 `odw serve --public-url` 运行时有效。** 该 runs 根目录没有这样的服务时不会生成链接,
  并在通知里说明原因(`linksUnavailable`、`ODW_LINKS_UNAVAILABLE`)。`/approve/` 路由不需要看板
  令牌——链接本身就是凭证——也不开放任何别的东西:停止、暂停、恢复和 Chat 仍只限 loopback,
  `--token-scope approve` 下同样如此。
- **请用 HTTPS。** 走明文 HTTP 时,路径上的任何人都能读到链接并抢先使用;`--public-url` 是指向
  localhost 以外的 `http://` 时 `odw serve` 会给出警告。隧道连到 loopback 绑定也可以:公开 URL
  的主机名可以越过 DNS rebinding 检查到达 `/approve/`(仅此路由)。
