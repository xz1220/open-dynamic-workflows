# ODW 文档

[English](../README.md) · 简体中文

文档对应 `main`；已发布的版本请看对应 tag 下的 `docs/`。第一次来？[README](../../README.zh-CN.md)
介绍了如何安装 `odw` 并以 $0 跑通一个工作流——从那里开始。各页按 [Diátaxis](https://diataxis.fr/)
分类：学习用的教程、完成任务的指南、查阅用的参考、帮助理解的概念。配方（`docs/recipes/`）与
GitHub Action 一页目前只有英文。

## 教程

- [教程：从模板到你自己的工作流](tutorial.md)——从内置模板开始，打开编辑器补全，再改写一个可运行的示例

## 指南

- [运行与观测指南](guides/running-and-observing.md)——运行模式、恢复、transcript、tmux 与 IDE、对比、漂移、trace、打包分享、磁盘
- [看板](guides/dashboard.md)——`odw serve`、远程只读访问、具名令牌、在手机上批准
- [审阅与应用改动](guides/reviewing-and-applying.md)——隔离 worktree 与端口、`odw diff` / `apply`、审阅队列、产出结果
- [多仓库运行](guides/multi-repo.md)——一次运行中的 agent 在多个仓库里工作
- [人工检查点与 agent 的提问](guides/checkpoints-and-questions.md)——让运行停下来等人；agent 提问时会发生什么
- [通知](guides/notifications.md)——运行结束、失败或等待时调用命令或 webhook
- [定时与触发](guides/scheduling-and-triggers.md)——`odw schedule`、晨报、由 webhook 启动的运行
- [远程运行：CI 与自己的服务器](guides/remote-runs.md)——GitHub Actions，以及 `odw run --on ssh://host`
- [适配器与模型](guides/adapters-and-models.md)——内置 CLI、自定义与 ACP 适配器、结构化输出、agent 定义、路由、多账号、本地模型
- [花费、上限与额度](guides/cost-limits-and-quotas.md)——用量与花费、预估、卡死看门狗、失控上限、限流、额度暂停、并发
- [安全与信任](guides/safety-and-trust.md)——权限档位、快照、不受信任的仓库与输入、严格脚本、容器、密钥
- [测试、调试与评估工作流](guides/testing-and-debugging.md)——`odw check`、断点、`odw replay`、`odw eval`、`odw test`
- [参与开发 ODW](guides/develop.md)——构建、测试、看板开发服务器、二进制、发布

分步配方（英文）：[cron](../recipes/cron.md) · [notify](../recipes/notify.md) ·
[triggers](../recipes/triggers.md) · [review and apply](../recipes/review-and-apply.md) ·
[recover a run](../recipes/recover-a-run.md) · [verified deep research](../recipes/deep-research-verified.md) ·
[GitHub Action](../github-action.md)。

## 参考

- [工作流 API](reference/workflow-api.md)——注入的原语、`expect`、笔记、记忆、范围、`meta.input`
- [CLI](reference/cli.md)——每条 `odw` 命令，以及讲解它的页面
- [配置](reference/config.md)——`odw.config.json` 在哪里找，以及按主题列出的每个键
- [事件与失败原因](reference/events.md)——运行目录、`events.jsonl` 中的事件类型、agent 失败的原因
- skill 的参考文档，最为详尽：[原语](../../skills/open-dynamic-workflows/zh-CN/references/primitives.md) · [适配器与配置](../../skills/open-dynamic-workflows/zh-CN/references/adapters.md)

## 概念

- [概念：ODW 如何工作，与 Claude Code 共享什么](concepts.md)——引擎的分层、方言，以及迁移脚本前要核对的事
- [一致性套件](../../conformance/README.md)——以可运行用例表达的方言行为（英文）

## 项目

[变更日志](../../CHANGELOG.md) · [路线图](../ROADMAP.md) · [用户调研](../research/) ·
[最初的设计](../dynamic-workflows-tech-plan.md) · [方言背景](../dynamic-workflows-research.md)
