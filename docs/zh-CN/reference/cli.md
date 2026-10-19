# CLI 参考

[English](../../reference/cli.md) · 简体中文

每条 `odw` 命令按任务分组，并给出讲解它的页面。你手上这个版本的确切参数以 `odw --help` 为准
（工作流的 `--args` 接受什么，见 `odw run <workflow> --help`）；只有 ODW 才有的命令都是 ODW 扩展——
Claude Code 方言本身没有 CLI。

## 准备

| 命令 | 作用 | 详见 |
| --- | --- | --- |
| `odw init [--adapter <name>] [--check]` | 选定默认的 agent CLI；在终端里以 $0 首跑收尾 | [快速开始](../../../README.zh-CN.md#快速开始) |
| `odw doctor [--smoke] [--adapter <name>\|all] [--fanout <n>]` | 检查本机、配置和每个适配器 | [快速开始](../../../README.zh-CN.md#快速开始) |
| `odw doctor --models` | 给配置中的每个适配器/模型组合发一个极小的提示 | [漂移监测](../guides/running-and-observing.md#漂移监测odw-扩展) |
| `odw doctor --local [--endpoint URL] [--model M] [--smoke]` | 本地 Ollama / LM Studio：上下文长度、工具调用、截断 | [本地模型](../guides/adapters-and-models.md#本地模型检查推理服务把廉价阶段交给它odw-扩展) |
| `odw new [<template>] [--name N] [--force] [--yes]` | 从内置模板生成工作流及其起步测试 | [教程](../tutorial.md#从模板开始odw-扩展) |
| `odw types [--dir .odw] [--force]` | 工作流脚本的编辑器补全 | [教程](../tutorial.md#编辑器补全odw-typesodw-扩展) |
| `odw workflows list\|where\|add\|update\|verify` | 可按名字运行的工作流；从 git 安装并锁定 | [运行与观测](../guides/running-and-observing.md#运行与观测) |
| `odw agents types [--adapter <a>]` | `agentType` 能引用的 agent 定义，以及各自的映射 | [agent 定义](../guides/adapters-and-models.md#agenttype-读取-agent-定义odw-扩展) |

## 运行与观测

| 命令 | 作用 | 详见 |
| --- | --- | --- |
| `odw run <script.js\|name> [--args JSON\|@file]` | 启动工作流：在终端里前台显示，其他场合后台运行；`--fg`、`-d`、`--wait`、`--deadline`、`--budget` | [运行与观测](../guides/running-and-observing.md#运行与观测) |
| `odw attach\|status\|logs\|agents\|result\|list` | 跟踪运行，读取它的状态、事件、agent 与结果 | [运行与观测](../guides/running-and-observing.md#运行与观测) |
| `odw logs <run_id> --agent <id\|label>` | 单个 agent 的 transcript | [Agent transcript](../guides/running-and-observing.md#agent-transcriptodw-扩展) |
| `odw pause\|resume\|stop <run_id>`、`odw rerun <run_id>` | 控制运行；重放已结束的运行 | [恢复运行](../guides/running-and-observing.md#恢复运行odw-扩展) |
| `odw tmux <run_id>`、`odw status\|logs\|attach <cc-…>` | 在 tmux 里看运行；只读查看 Claude Code 自己的运行 | [终端、tmux 与 IDE](../guides/running-and-observing.md#在终端tmux-和-ide-里看运行odw-扩展) |
| `odw compare <runA> <runB>` | 两次运行之间有什么变化 | [对比两次运行](../guides/running-and-observing.md#对比两次运行odw-扩展) |
| `odw export <run_id> --otlp` | 把运行导出为 OpenTelemetry trace | [可观测性](../guides/running-and-observing.md#可观测性opentelemetry-traceodw-扩展) |
| `odw bundle <run_id>`、`odw view FILE.odwrun` | 打包成一个脱敏文件分享，以及查看它 | [分享一次运行](../guides/running-and-observing.md#分享一次运行odw-扩展) |
| `odw gc`、`odw pin <run_id>` | 运行在磁盘上留下了什么；让某次运行免于清理 | [回收磁盘](../guides/running-and-observing.md#回收磁盘odw-gc-与-odw-pinodw-扩展) |
| `odw serve [--port N] [--host H] [--open]` | 实时看板 | [看板](../guides/dashboard.md#看板观测检查对话) |
| `odw token add\|list\|remove` | `odw serve --tokens` 使用的具名令牌 | [具名令牌](../guides/dashboard.md#具名令牌谁做了什么odw-扩展) |

## 审阅、应用、决定

| 命令 | 作用 | 详见 |
| --- | --- | --- |
| `odw diff <run_id>`、`odw apply <run_id> --agent <id>\|--all` | 隔离 agent 改了什么；落地它（`--check`、`--verify`、`--resolve`、`--pr`） | [审阅并应用](../guides/reviewing-and-applying.md#审阅并应用隔离-agent-的改动odw-扩展) |
| `odw review`、`odw review mark` | 跨运行尚未处理的保留 diff | [审阅队列](../guides/reviewing-and-applying.md#跨运行的审阅队列odw-扩展) |
| `odw outcomes` | 按周、工作流、适配器、模型：应用了什么、失败了什么、返工了什么 | [按周看产出结果](../guides/reviewing-and-applying.md#按周看产出结果odw-扩展) |
| `odw restore <run_id>` | 把工作区恢复到运行中第一个原地 agent 之前的样子 | [安全快照](../guides/safety-and-trust.md#安全快照与破坏性-git-命令odw-扩展) |
| `odw approve\|reject <run_id>` | 回答 `checkpoint()`（`--note`、`--edit`、`--payload`） | [人工检查点](../guides/checkpoints-and-questions.md#人工检查点odw-扩展) |
| `odw notes <run_id>`、`odw note "<text>"` | 运行的笔记板；在 agent 内部向它发笔记 | [笔记](workflow-api.md#并行-agent-之间的笔记odw-扩展) |
| `odw memory list\|add\|prune` | 工作流记忆：之前的运行学到了什么 | [工作流记忆](workflow-api.md#工作流记忆odw-扩展) |

## 花费、定时、其他机器

| 命令 | 作用 | 详见 |
| --- | --- | --- |
| `odw estimate <wf>`、`odw run --estimate` | 依据之前的运行给出 p50/p90 的时间、花费、token 与 agent 数 | [运行前先知道花费](../guides/cost-limits-and-quotas.md#运行前先知道花费odw-扩展) |
| `odw schedule add\|list\|remove\|run` | 通过 cron、launchd 或 systemd 定时运行工作流 | [定时运行](../guides/scheduling-and-triggers.md#定时运行odw-扩展) |
| `odw digest` | 跨运行发生了什么：等你处理的、失败的、未达标的、改动、花费 | [晨报](../guides/scheduling-and-triggers.md#晨报odw-digestodw-扩展) |
| `odw run <wf> --on ssh://host`、`odw pull <run_id> --from ssh://host` | 在自己的服务器上运行；把远程运行拷回本地 | [自己的服务器](../guides/remote-runs.md#在自己的服务器上运行odw-扩展) |

## 把工作流做对

| 命令 | 作用 | 详见 |
| --- | --- | --- |
| `odw check <script.js\|name> [--capabilities]` | 能否加载；用了方言之外的什么 | [调试工作流](../guides/testing-and-debugging.md#调试工作流odw-扩展) |
| `odw run <wf> --break <phase\|label> \| --step`、`odw replay <run_id> --agent <id>` | 在阶段或 agent 前停下；单独重跑一个 agent | [调试工作流](../guides/testing-and-debugging.md#调试工作流odw-扩展) |
| `odw test [<wf>]`、`odw run <wf> --dry`、`odw run <wf> --record` | 脚本化回复，不调用模型，$0 | [测试工作流](../guides/testing-and-debugging.md#测试工作流odw-扩展) |
| `odw eval <file\|name>` | 用例 × 适配器 × 重复次数：通过率、花费、时间 | [评估工作流](../guides/testing-and-debugging.md#评估工作流odw-扩展) |
| `odw conformance [--strict]` | 用方言一致性用例检查当前 odw | [兼容性](../concepts.md#兼容性与迁移) |

## 退出码

`0` 完成 · `1` 失败，或被人停止 · `3` 到达 `--deadline` 被停止 · `124` `--timeout` 放弃等待（运行继续）。
其他命令的退出码 1 表示发现了它要检查的问题：`odw apply`（及 `--check`）遇到冲突、`odw workflows verify`
发现不一致、`odw eval --baseline` 有单元格退步——详见各自的章节。
