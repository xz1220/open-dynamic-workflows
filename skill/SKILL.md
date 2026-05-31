---
name: agent-swarm
description: >
  Give any coding agent dynamic-workflow power. Write a short Python script that
  orchestrates many coding-agent CLI calls (Codex, Claude Code, Gemini, Qwen,
  Kimi, or your own) with composable primitives — agent, parallel, pipeline,
  phase, log, schema — then run it in the background and collect the result. Use
  when a task benefits from fanning out subtasks, multi-stage pipelines,
  adversarial verification, or loop-until-done discovery, rather than one
  in-context attempt.
license: MIT. See LICENSE for full terms.
---

# agent-swarm

A *dynamic workflow* is a small script that holds an orchestration plan in
ordinary code and dispatches coding-agent CLIs at scale — outside your own
context. You (the host agent) **write the script, then run it**; the engine
executes it in a background process and hands back only the final result.

Use this skill when the work is bigger than one call: fan out N drafts and
synthesize, run a multi-stage review pipeline, verify findings adversarially, or
discover until nothing new turns up.

## 1. Write a workflow script

A workflow is a normal Python file with two things: an optional `META` dict and
a `workflow(args)` function. Import the primitives from `agentswarm`:

```python
from agentswarm import agent, parallel, pipeline, phase, log, schema

META = {
    "name": "fan-out-reduce",
    "description": "Draft in parallel, then synthesize.",
    "phases": ["draft", "synthesize"],
}

def workflow(args):
    question = (args or {}).get("question", "Design a cache.")
    drafts = parallel([
        lambda i=i: agent(f"Draft #{i+1}: {question}", phase="draft")
        for i in range(3)
    ])
    drafts = [d for d in drafts if d]              # plain Python reduction
    return agent("Synthesize the best answer from:\n" + "\n---\n".join(drafts),
                 phase="synthesize")
```

- `workflow(args)` returns the final value. `args` is whatever you pass with
  `--args` (parsed JSON).
- Ordinary control flow (loops, `if`, comprehensions, dedup) lives in the
  script. The primitives only **dispatch and wait** — you decide what to do with
  results.

## 2. The primitives (at a glance)

| Primitive | What it does |
| --- | --- |
| `agent(prompt, *, adapter=None, schema=None, label=None, phase=None)` | Run one coding agent on a subtask; returns its reply (text, or a validated object when `schema` is given). The only verb that does work. |
| `parallel(thunks)` | Run a list of zero-arg callables concurrently and **wait for all** (barrier). Returns results in order; a failed one is `None`. |
| `pipeline(items, *stages)` | Stream each item through the stages independently (**no barrier**). Each stage gets `(prev, item, index)` — take what you need. |
| `phase(title)` | Label following work for progress display. |
| `log(message)` | Emit a progress line. |
| `schema.obj/array/string/...` | Build a JSON-Schema contract for `agent(..., schema=...)`. |

`args` is a parameter of `workflow`, not an import. Full reference:
[`references/primitives.md`](references/primitives.md).

**Rule of thumb:** `parallel` when the next step needs the *whole* batch at once
(dedup, tally, synthesis); `pipeline` for multi-stage work (the default). Keep
reductions order-independent — branching on *which agent finished first* breaks
reproducibility.

## 3. Run it

The `swarm` CLI starts the script in the background (fire-and-poll) and lets you
observe it. Use `--wait` to block and print the result:

```bash
swarm run my_workflow.py --wait --args '{"question": "Design a cache."}'
```

Fire-and-poll instead:

```bash
RUN=$(swarm run my_workflow.py)     # prints a run id
swarm status $RUN                   # state + agent count
swarm logs $RUN --follow            # stream progress events
swarm result $RUN                   # print the final value when done
swarm pause $RUN / resume $RUN / stop $RUN
swarm list                          # all runs
```

If `swarm` is not on PATH, use `python -m agentswarm` with the same arguments.

## 4. Configure adapters

Codex, Claude Code, Gemini, Qwen, and Kimi work out of the box. To change the
default, tune flags, or add your own CLI, write an `agentswarm.toml` (see
[`references/adapters.md`](references/adapters.md)) and pass `--config`, or place
it at `./agentswarm.toml` or `~/.config/agentswarm/config.toml`.

## 5. Invariants

- Agents run independently and in isolation; one agent never sees another's
  draft unless your script passes it along.
- By default each agent runs in an isolated copy of the working tree
  (`workspace_mode = "copy"`); your real tree is not modified. Use `inplace` for
  read-only/analysis workflows.
- Concurrency is capped and total dispatches are bounded (a runaway guard). Cost
  is controlled with the concurrency cap, the agent cap, and `pause`/`stop`.
- The result is whatever `workflow(args)` returns. Inspect it, then decide what
  to do — the engine does not commit, push, or apply diffs for you.

## Resources

- [`references/primitives.md`](references/primitives.md) — full primitive
  reference, composition patterns, determinism rule.
- [`references/adapters.md`](references/adapters.md) — adapter config and the
  built-in CLIs.
- `examples/` (repo root) — `fan_out_reduce.py`, `adversarial_verify.py`,
  `loop_until_dry.py`.
