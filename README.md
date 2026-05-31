<div align="center">

# agent-swarm

**Portable dynamic workflows for any coding agent, in any environment.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Python](https://img.shields.io/badge/Python-3.11%2B-blue)](https://www.python.org/)

</div>

---

A *dynamic workflow* is a small script that holds an orchestration plan in
ordinary code and dispatches coding-agent CLIs at scale — outside the host
agent's context. Claude Code can do this inside its own private runtime.
**agent-swarm makes the same capability portable**: write a Python script with a
handful of composable primitives, point it at any coding-agent CLI (Codex,
Claude Code, Gemini, Qwen, Kimi, or your own), and run it in the background.

```python
# my_workflow.py
from agentswarm import agent, parallel

META = {"name": "fan-out-reduce", "description": "draft in parallel, then synthesize"}

def workflow(args):
    drafts = parallel([lambda i=i: agent(f"Draft #{i+1}: {args['question']}") for i in range(4)])
    return agent("Synthesize the best answer from:\n" + "\n---\n".join(filter(None, drafts)))
```

```bash
swarm run my_workflow.py --wait --args '{"question": "Design a rate limiter."}'
```

## Why

The pattern — hold the plan in code, fan out subagents, keep intermediate work
out of your context — is broadly useful, but it has been locked inside one
runtime. agent-swarm rebuilds it as an open, CLI-agnostic library so **any**
agent can orchestrate **any** other.

## Install

```bash
pipx install agent-swarm     # or: uvx agent-swarm ... / pip install agent-swarm
```

This puts a `swarm` command on your PATH (`python -m agentswarm` also works).

## The primitives

| Primitive | Role |
| --- | --- |
| `agent(prompt, *, adapter, schema, label, phase)` | Run one coding agent on a subtask. The only verb that does work. |
| `parallel(thunks)` | Run a batch concurrently and wait for all (barrier). |
| `pipeline(items, *stages)` | Stream items through stages independently (no barrier). |
| `phase(title)` / `log(message)` | Progress labelling and messages. |
| `schema.obj/array/string/...` | Typed output contract for reliable hand-offs. |

`parallel` when the next step needs the whole batch at once (dedup, tally,
synthesis); `pipeline` for multi-stage work. Ordinary Python — loops, `if`,
comprehensions — does the reducing. Full reference:
[`skill/references/primitives.md`](skill/references/primitives.md).

## Run and observe

```bash
swarm run wf.py [--args JSON|@file] [--wait]   # start (background); --wait blocks and prints the result
swarm status <id>      # state + agent count
swarm logs <id> -f     # stream progress events
swarm result <id>      # final value
swarm pause|resume|stop <id>
swarm list
```

A run executes in a detached worker process and persists everything to a run
directory, so it outlives the command that started it and can be observed from
anywhere.

## Configure adapters

The five common CLIs work out of the box. To change the default, tune flags, or
add your own, drop an `agentswarm.toml` (see
[`config.example.toml`](config.example.toml)) at `./`,
`~/.config/agentswarm/`, or pass `--config`. agent-swarm only shells out to local
commands — it never calls model APIs directly. Details:
[`skill/references/adapters.md`](skill/references/adapters.md).

## Architecture

Layered, each layer depending only on the one below; workflow scripts touch only
the top.

```
cli ─▶ runtime (background worker + run directory)
        └─ injects ─▶ workflow script
                        └─ primitives ─▶ scheduler (concurrency cap + agent backstop)
                                          agent() ─▶ bridge ─▶ adapters ─▶ real CLI
                                                      └─ workspace (isolation + diff)
                                                      └─ schema (validate / retry)
```

| Path | Layer |
| --- | --- |
| `src/agentswarm/adapters/` | L1 — uniform CLI invocation (config, placeholders, runner, built-ins) |
| `src/agentswarm/bridge.py` | L2 — one agent call → one CLI run, with schema handling |
| `src/agentswarm/scheduler.py` | L3 — bounded concurrency + total-agent backstop |
| `src/agentswarm/primitives.py`, `schema.py` | L4 — the primitives and the data contract |
| `src/agentswarm/runtime/` | L5 — background worker, run directory, control |
| `src/agentswarm/cli.py` | L6 — the `swarm` command |
| `src/agentswarm/workspace.py` | cross-cutting — workspace isolation and diff |

## Use as a skill

[`skill/SKILL.md`](skill/SKILL.md) teaches a host agent to author and run
workflows from documentation alone. Install it into your agent's skills
directory.

## Develop

```bash
uv pip install -e '.[test]'
python -m pytest        # layered suite, driven by a mock adapter — no real accounts
ruff check src tests
```

## Scope

v1 covers the core primitives, schema-checked hand-offs, and background
execution with pause/stop. Resume/journaling, a `budget` primitive, nested
workflows, raw futures, and git-worktree isolation are intentionally deferred —
see [`docs/dynamic-workflows-tech-plan.md`](docs/dynamic-workflows-tech-plan.md).

## License

MIT
