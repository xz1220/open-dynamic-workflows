# 远程运行：CI 与自己的服务器

[English](../../guides/remote-runs.md) · 简体中文

在另一台机器上进行的运行。GitHub Action 另有专页（英文）：[`docs/github-action.md`](../../github-action.md)。

## 在 GitHub Actions 中运行(ODW 扩展)

一个组合 action 在 CI 中运行工作流,并在 job 超时**之前**把它停下,输出因此得以保留:

```yaml
- uses: xz1220/open-dynamic-workflows/action@v0.X.Y   # 固定为你安装的版本
  with:
    workflow: .odw/workflows/review.js
    timeout-minutes: 30        # 与 job 的 timeout-minutes 相同
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

它安装固定版本的 odw(对照该 release 的 `SHA256SUMS` 校验 SHA-256——校验的是完整性而非真实性;
没有 `SHA256SUMS` 的 release 一律拒绝),以 job 超时前留出余量的 `--deadline` 运行
`odw run --wait`(`args` 输入经文件传入,从不作为命令行参数),把花费小票、agent 表和失败写入
job summary,把 `odw bundle` 上传为 artifact,`apply-pr: true` 时开草稿 PR。来自 fork 的 PR、
所有 `pull_request_target`、fork 触发的 `workflow_run`,以及 issue、评论事件以 `--untrusted` 运行。输入、密钥与示例:[`docs/github-action.md`](../../github-action.md)。

## 在自己的服务器上运行(ODW 扩展)

笔记本一合上,运行就停了。改在你自己的机器上启动——走普通的 SSH,两端都没有 daemon:

```bash
odw run review --on ssh://me@box:2222            # 同步项目,在那边以后台方式启动,打印运行 id
odw run wf.js --on ssh://box/srv/work/app --sync rsync --args @in.json --adapter codex
odw status $RUN --on ssh://box                   # 同一条命令,由那边的 odw 执行
odw logs $RUN --on ssh://box --follow            # ……odw attach $RUN --on ssh://box 显示实时视图
odw approve $RUN --on ssh://box                  # 在那边回答它的检查点(reject、pause、stop、resume 同理)
odw pull $RUN --from ssh://box                   # 拷回本机:odw status、diff、apply、compare、看板都能用
```

`--on ssh://[user@]host[:port][/path]` 先检查远端有没有 odw(`odw --version`,否则
`npx --no-install odw`),没有就告诉你怎么装。然后把项目拷到远端工作目录——默认
`~/odw-remote/<仓库名>`,URL 带路径时用它(`ssh://box/~/work/app` 相对家目录,
`ssh://box/srv/app` 是绝对路径):

- `--sync git`(默认):HEAD 的 `git bundle`,外加一个包含所有未提交改动的补丁——已暂存、
  未暂存和未跟踪的文件,.gitignore 忽略的不带——用临时 index 生成,你的 index 不受影响。
  运行时会说明带了哪个提交、多少个未提交的文件。
- `--sync rsync`:用 `rsync`(两端都需要)镜像整个目录,.gitignore 忽略的文件不带。

工作目录归 odw 所有:每次同步都会替换上一次留下的内容(那边被忽略的文件,比如远端的
`node_modules`,保留),不是 odw 建的目录会被拒绝,绝不覆盖。项目之外的工作流(个人或插件
的)会一并发过去。然后在那边执行 `odw run … --detach`,打印远端运行 id 和后续可用的命令。
`--adapter`、`--permissions`、`--untrusted`、`--sandbox`、`--sandbox-image`、`--budget`
会一并传过去;`--config`、`--runs-root`、`--wait`、`--fg`、`--timeout` 会被拒绝(用
`odw attach --on` 观看)。

**远端使用它自己的 odw 配置和 agent CLI 登录。** 你的 `~/.config/odw/config.json` 和各
CLI 的登录都不会被拷过去:在那边安装 odw、登录 agent CLI,需要时在那边放一份配置(项目里的
`odw.config.json` 和其他文件一样随项目同步)。不会把任何密钥放到命令行上——`--args` 作为
文件经 ssh 的 stdin 传过去——ssh 用的是你自己的,带着你的 `~/.ssh/config`、密钥和 agent;
`ODW_SSH` 可以替换 `ssh` 可执行文件(`ODW_RSYNC` 替换 `rsync`)。

`odw status|logs|attach|approve|reject|pause|stop|resume <run> --on ssh://host` 在远端 odw
上执行这条命令,原样传回输出和退出码(终端里的 attach、`logs --follow` 和 `approve --edit`
用 `ssh -t`,所以 attach 就是实时视图;`--payload @file` 指的是那边的文件)。
`odw pull <run> --from ssh://host` 把运行目录拷进本地的运行根目录——本机有 rsync 就用
rsync,否则走 ssh 上的 tar——并在 `meta.json` 中标记 `origin: "remote"` 和
`remote: { url, host, dir, pulledAt }`。拷贝先放在 runs 根目录下的暂存目录里,完整之后才移到
位,所以拉取失败什么也不会留下(之前的拷贝保持原样);符号链接、设备文件和 fifo 一律不带回来
(rsync 加 `--no-links`,拷贝里若有也会被删除并列出)。还在跑的运行可以反复拉取:拷贝是一个
快照(远端 worker 的 pid 被去掉,所以在本机结束前显示为 stale),`odw status` 会说明它来自哪里。

**拉回来的运行要在它运行的地方回答。** 在本机批准、拒绝、暂停、停止或恢复这份拷贝只会改动拷贝,
所以 `odw approve|reject|pause|stop|resume` 和看板(409)会拒绝,并给出应当执行的命令:
`odw approve <run> --on ssh://host`。
