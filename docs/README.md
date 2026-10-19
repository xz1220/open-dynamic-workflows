# ODW documentation

English · [简体中文](zh-CN/README.md)

The docs describe `main`; for a released version, read `docs/` at its tag. New here?
The [README](../README.md) installs `odw` and runs a workflow for $0 — start there.
The pages are sorted the [Diátaxis](https://diataxis.fr/) way: a tutorial to learn,
guides to get a task done, reference to look things up, concepts to understand.

## Tutorial

- [Tutorial: from a template to your own workflow](tutorial.md) — start from a built-in template, get editor completion, then adapt a runnable example

## Guides

- [Running and observing runs](guides/running-and-observing.md) — run modes, resume, transcripts, tmux and IDEs, compare, drift, traces, bundles, disk
- [The dashboard](guides/dashboard.md) — `odw serve`, remote read-only access, named tokens, approving from a phone
- [Reviewing and applying changes](guides/reviewing-and-applying.md) — isolated worktrees and ports, `odw diff` / `apply`, the review queue, outcomes
- [Multi-repo runs](guides/multi-repo.md) — one run whose agents work in several repositories
- [Human checkpoints and agent questions](guides/checkpoints-and-questions.md) — pause a run for a person; what happens when an agent asks
- [Notifications](guides/notifications.md) — a command or a webhook when a run ends, fails or waits
- [Scheduling and triggers](guides/scheduling-and-triggers.md) — `odw schedule`, the morning digest, runs started by webhooks
- [Remote runs: CI and your own server](guides/remote-runs.md) — GitHub Actions, and `odw run --on ssh://host`
- [Adapters and models](guides/adapters-and-models.md) — the built-in CLIs, custom and ACP adapters, structured output, agent definitions, routing, accounts, local models
- [Cost, limits and quotas](guides/cost-limits-and-quotas.md) — usage and cost, estimates, the stall watchdog, runaway limits, rate limits, quota pauses, concurrency
- [Safety and trust](guides/safety-and-trust.md) — permission tiers, snapshots, untrusted repositories and input, strict scripts, containers, secrets
- [Testing, debugging and evaluating workflows](guides/testing-and-debugging.md) — `odw check`, breakpoints, `odw replay`, `odw eval`, `odw test`
- [Developing ODW](guides/develop.md) — build, test, the dashboard dev server, binaries, releases

Step-by-step recipes: [cron](recipes/cron.md) · [notify](recipes/notify.md) ·
[triggers](recipes/triggers.md) · [review and apply](recipes/review-and-apply.md) ·
[recover a run](recipes/recover-a-run.md) · [verified deep research](recipes/deep-research-verified.md) ·
[the GitHub Action](github-action.md).

## Reference

- [Workflow API](reference/workflow-api.md) — the injected primitives, `expect`, notes, memory, scopes, `meta.input`
- [CLI](reference/cli.md) — every `odw` command, and the page that explains it
- [Configuration](reference/config.md) — where `odw.config.json` is found, and every key by topic
- [Events and failure reasons](reference/events.md) — the run directory, the event types in `events.jsonl`, why an agent failed
- The skill's references, the most detailed of all: [primitives](../skills/open-dynamic-workflows/references/primitives.md) · [adapters and configuration](../skills/open-dynamic-workflows/references/adapters.md)

## Concepts

- [Concepts: how ODW works, and what it shares with Claude Code](concepts.md) — the engine's layers, the dialect, and what to check before porting a script
- [The conformance suite](../conformance/README.md) — the dialect's behaviour as runnable cases

## The project

[Changelog](../CHANGELOG.md) · [Roadmap](ROADMAP.md) · [user research](research/) ·
[the original design](dynamic-workflows-tech-plan.md) · [background on the dialect](dynamic-workflows-research.md)
