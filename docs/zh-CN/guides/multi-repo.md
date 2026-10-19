# 多仓库运行

[English](../../guides/multi-repo.md) · 简体中文

一次运行声明它可以触及的仓库；每个 agent 说明自己在哪个仓库里工作。

## 一次运行涉及多个仓库(ODW 扩展)

前端、后端加共享库的改动本是一件事。给其他仓库起别名,让每个 agent 指向其中一个;它们的改动
仍属同一次运行,一起审阅、一起应用:

```bash
odw run ./wf.js --repo api=../api --repo web=../web    # 别名=路径,可多次
```

```jsonc
// odw.config.json——路径相对运行的源目录,可用 ~
{ "repos": { "api": "../api", "web": "../web" } }
```

```js
export const meta = { name: 'rename-field', description: '…', repos: ['api', 'web'] }
await parallel([
  () => agent('Rename user.login to user.handle in the API.', { repo: 'api', isolation: 'worktree', scope: ['src/**'] }),
  () => agent('Follow the rename in the UI.', { repo: 'web', isolation: 'worktree', expect: { command: 'npm test' } }),
])
const { stdout } = await exec('git log -1 --format=%h', { repo: 'api' })
```

- **只认声明过的别名,不接受路径。** `agent(p, { repo })` 与 `exec(cmd, { repo })` 只接受运行声明过的
  别名——`repos` 设置,或覆盖它的 `--repo name=path`——从不接受路径。运行没有的别名会在调用开始前让
  运行失败;`meta.repos` 列出工作流需要的别名,缺一个则在任何 agent 启动前失败。每个路径都必须是
  git 仓库(`--repo` 在运行创建前就检查)。运行会记下它有哪些仓库,status.json 以 `repos` 保存。
  `odw rerun`、`resume`、`replay` 沿用 `--repo`。
- **一切按仓库生效。** agent 的 CLI 在该仓库的顶层运行——`isolation: "worktree"` 时在它的一个
  worktree 里,diff 与其他隔离 agent 一样保留。它的 `expect`(`files`、`untouched`、`command`)、
  `scope` 与越界检查读的都是该仓库;不同仓库的 scope 互不等待。可写的原地 agent 先给该仓库打一份
  自己的保险快照(`odw restore <run> --repo api` 放回)。`exec()` 的 `cwd` 相对该仓库解析。
  `agent_started` 事件带 `repo: { name, path }`。
- **审阅与应用。** `odw diff` 标出每个 agent 的仓库(`# odw: agent 2 · fix · repo api · …`;
  `--stat` 多一列 REPO,源仓库为 `.`;`--repo <name|.>` 只看一个),`odw review` 与看板的
  「改动」页也一样,后者按仓库分组列出 agent。`odw apply --agent N` 应用到该 agent 所在的仓库——即本次运行为该别名声明的路径(`status.json` 的
  `repos`,并与 `--repo` 核对),事件日志记的路径与之不符或运行从未声明该别名时拒绝;源仓库
  的 agent 仍应用到你运行 odw 的工作区(若那正是本次运行的另一个仓库则拒绝)。`odw apply --all` 先逐个
  仓库预检,只要有一个不能干净应用就什么都不写——全部通过后再按源仓库优先逐个写入;某个仓库应用
  失败(比如它的 `--verify`)时按 `odw apply` 一贯的方式回滚,之前的仓库保留,之后的不再写入。
  `--repo <name|.>` 只应用一个仓库的 agent;`--pr` 与 `--resolve` 一次只处理一个仓库。
- **不可信运行**(`--untrusted`)不采用仓库自带配置里指向仓库之外的路径:这样的别名会被丢弃并说明。
  你自己的配置(`--config`、`~/.config/odw/config.json`)与 `--repo` 可指向任何仓库。
- **这一版不做:** 一个 agent 只写一个仓库(跨仓库的改动拆成每仓库一个 agent,用
  [笔记板](../reference/workflow-api.md#并行-agent-之间的笔记odw-扩展)保持同步);不做跨仓库的原子合并;不自动发现 submodule
  或兄弟目录;`--repo` 与 `--on ssh://` 同用会被拒绝;PR 用 `odw apply --all --pr --repo <name>`
  每仓库各开一个,暂不互相链接;`odw gc` 只查找源仓库的遗留 worktree。

Claude Code 的 Workflow 工具会忽略 `repo` 与 `meta.repos`:在那里所有 agent 都在会话所在的仓库里工作。
