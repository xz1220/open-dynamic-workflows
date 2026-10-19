# CLI reference

English · [简体中文](../zh-CN/reference/cli.md)

Every `odw` command, grouped by task, with the page that explains it. The exact
flags of the build you have are in `odw --help` (and `odw run <workflow> --help`
for what a workflow takes as `--args`); ODW-only commands are ODW extensions — the
Claude Code dialect has no CLI of its own.

## Set up

| Command | What it does | Explained in |
| --- | --- | --- |
| `odw init [--adapter <name>] [--check]` | pick the default agent CLI; at a terminal, ends with the $0 first run | [Quick start](../../README.md#quick-start) |
| `odw doctor [--smoke] [--adapter <name>\|all] [--fanout <n>]` | check this machine, the config and every adapter | [Quick start](../../README.md#quick-start) |
| `odw doctor --models` | one tiny prompt to every configured adapter/model pair | [Drift watch](../guides/running-and-observing.md#drift-watch-odw-extension) |
| `odw doctor --local [--endpoint URL] [--model M] [--smoke]` | a local Ollama / LM Studio server: context length, tool calling, truncation | [Local models](../guides/adapters-and-models.md#local-models-check-the-server-route-the-cheap-phases-odw-extension) |
| `odw new [<template>] [--name N] [--force] [--yes]` | a workflow and its starter test from a built-in template | [Tutorial](../tutorial.md#start-from-a-template-odw-extension) |
| `odw types [--dir .odw] [--force]` | editor completion for workflow scripts | [Tutorial](../tutorial.md#editor-completion-odw-types-odw-extension) |
| `odw workflows list\|where\|add\|update\|verify` | workflows runnable by name; install them from git, locked | [Run and observe](../guides/running-and-observing.md#run-and-observe) |
| `odw agents types [--adapter <a>]` | the agent definitions `agentType` can name, and what each maps to | [Agent definitions](../guides/adapters-and-models.md#agent-definitions-behind-agenttype-odw-extension) |

## Run and observe

| Command | What it does | Explained in |
| --- | --- | --- |
| `odw run <script.js\|name> [--args JSON\|@file]` | start a workflow: foreground at a terminal, detached elsewhere; `--fg`, `-d`, `--wait`, `--deadline`, `--budget` | [Run and observe](../guides/running-and-observing.md#run-and-observe) |
| `odw attach\|status\|logs\|agents\|result\|list` | follow a run, read its state, events, agents and result | [Run and observe](../guides/running-and-observing.md#run-and-observe) |
| `odw logs <run_id> --agent <id\|label>` | one agent's transcript | [Agent transcripts](../guides/running-and-observing.md#agent-transcripts-odw-extension) |
| `odw pause\|resume\|stop <run_id>`, `odw rerun <run_id>` | control a run; replay an ended one | [Resume a run](../guides/running-and-observing.md#resume-a-run-odw-extension) |
| `odw tmux <run_id>`, `odw status\|logs\|attach <cc-…>` | a run in tmux; Claude Code's own runs, read-only | [Terminal, tmux, IDE](../guides/running-and-observing.md#watch-runs-in-a-terminal-tmux-or-your-ide-odw-extension) |
| `odw compare <runA> <runB>` | what changed between two runs | [Compare two runs](../guides/running-and-observing.md#compare-two-runs-odw-extension) |
| `odw export <run_id> --otlp` | the run as OpenTelemetry traces | [Observability](../guides/running-and-observing.md#observability-opentelemetry-traces-odw-extension) |
| `odw bundle <run_id>`, `odw view FILE.odwrun` | one redacted file to share, and showing it | [Share a run](../guides/running-and-observing.md#share-a-run-odw-extension) |
| `odw gc`, `odw pin <run_id>` | what runs left on disk; keep a run from it | [Reclaim disk](../guides/running-and-observing.md#reclaim-disk-odw-gc-and-odw-pin-odw-extension) |
| `odw serve [--port N] [--host H] [--open]` | the live dashboard | [Dashboard](../guides/dashboard.md#dashboard-observe-inspect-chat) |
| `odw token add\|list\|remove` | named tokens for `odw serve --tokens` | [Named tokens](../guides/dashboard.md#named-tokens-who-did-what-odw-extension) |

## Review, apply, decide

| Command | What it does | Explained in |
| --- | --- | --- |
| `odw diff <run_id>`, `odw apply <run_id> --agent <id>\|--all` | what isolated agents changed; land it (`--check`, `--verify`, `--resolve`, `--pr`) | [Review and apply](../guides/reviewing-and-applying.md#review-and-apply-what-isolated-agents-changed-odw-extension) |
| `odw review`, `odw review mark` | kept diffs across runs not dealt with yet | [The review queue](../guides/reviewing-and-applying.md#the-review-queue-across-runs-odw-extension) |
| `odw outcomes` | by week, workflow, adapter, model: what was applied, failed, reworked | [Outcomes over weeks](../guides/reviewing-and-applying.md#outcomes-over-weeks-odw-extension) |
| `odw restore <run_id>` | the working tree as it was before the run's first in-place agent | [Safety snapshot](../guides/safety-and-trust.md#safety-snapshot-and-destructive-git-commands-odw-extension) |
| `odw approve\|reject <run_id>` | answer a `checkpoint()` (`--note`, `--edit`, `--payload`) | [Human checkpoints](../guides/checkpoints-and-questions.md#human-checkpoints-odw-extension) |
| `odw notes <run_id>`, `odw note "<text>"` | a run's notes board; post to it from inside an agent | [Notes](workflow-api.md#notes-between-parallel-agents-odw-extension) |
| `odw memory list\|add\|prune` | workflow memory: what earlier runs learned | [Workflow memory](workflow-api.md#workflow-memory-odw-extension) |

## Cost, schedules, other machines

| Command | What it does | Explained in |
| --- | --- | --- |
| `odw estimate <wf>`, `odw run --estimate` | p50/p90 time, cost, tokens and agents from earlier runs | [Know the cost](../guides/cost-limits-and-quotas.md#know-the-cost-before-you-run-odw-extension) |
| `odw schedule add\|list\|remove\|run` | run a workflow on a timer through cron, launchd or systemd | [Schedule runs](../guides/scheduling-and-triggers.md#schedule-runs-odw-extension) |
| `odw digest` | what happened across runs: needs you, failed, missed checks, changes, spend | [Morning digest](../guides/scheduling-and-triggers.md#morning-digest-odw-digest-odw-extension) |
| `odw run <wf> --on ssh://host`, `odw pull <run_id> --from ssh://host` | run on your own server; copy a remote run here | [Your own server](../guides/remote-runs.md#run-on-your-own-server-odw-extension) |

## Make a workflow right

| Command | What it does | Explained in |
| --- | --- | --- |
| `odw check <script.js\|name> [--capabilities]` | does it load; what it names outside the dialect | [Debug a workflow](../guides/testing-and-debugging.md#debug-a-workflow-odw-extension) |
| `odw run <wf> --break <phase\|label> \| --step`, `odw replay <run_id> --agent <id>` | stop before phases or agents; run one agent again | [Debug a workflow](../guides/testing-and-debugging.md#debug-a-workflow-odw-extension) |
| `odw test [<wf>]`, `odw run <wf> --dry`, `odw run <wf> --record` | scripted replies, no model, $0 | [Test a workflow](../guides/testing-and-debugging.md#test-a-workflow-odw-extension) |
| `odw eval <file\|name>` | cases × adapters × repeats: pass rate, cost, time | [Evaluate a workflow](../guides/testing-and-debugging.md#evaluate-a-workflow-odw-extension) |
| `odw conformance [--strict]` | this odw against the dialect's conformance cases | [Compatibility](../concepts.md#compatibility-and-migration) |

## Exit codes

`0` done · `1` failed, or stopped by a person · `3` stopped at its `--deadline` ·
`124` `--timeout` gave up waiting (the run goes on). Elsewhere, exit 1 means the
command found what it checks for: a conflict for `odw apply` (and `--check`), a
mismatch for `odw workflows verify`, a regressed cell for `odw eval --baseline` —
see their sections.
