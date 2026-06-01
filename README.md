<div align="center">

# Open Dynamic Workflows

**An open dynamic workflow runtime for Claude Code-style agent orchestration on _any_ coding agent.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A520-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Status](https://img.shields.io/badge/status-rewrite_in_progress-orange.svg)](#roadmap)

English · [简体中文](README.zh-CN.md)

</div>

---

> 🚧 **Status — active rewrite.** Open Dynamic Workflows is being rebuilt from a
> Python prototype into a **TypeScript / Node** runtime. The engine skeleton and
> the `odw` CLI shell have landed (milestone **M0**); the execution layers
> (**M1–M5**) are in progress. The interfaces below describe the **target**
> design — see the [Roadmap](#roadmap) for what is wired up today.

## What is this?

**Open Dynamic Workflows (ODW)** is a TypeScript / Node CLI runtime for
portable dynamic workflows: JavaScript scripts that fan out coding agents with
`agent()`, `parallel()`, and `pipeline()` outside the host agent's context. If
you are looking for an open dynamic workflow engine for Codex, Claude Code,
Gemini, Qwen, Kimi, or a custom CLI, this is the project.

A **dynamic workflow** is a small JavaScript script that holds an orchestration
plan in ordinary code and dispatches coding-agent CLIs *at scale* — outside the
host agent's own context. You write the script (or hand it one), a runtime runs
it in the background, and only the final result comes back.

Claude Code can already do this, but only inside its own private runtime.
**Open Dynamic Workflows makes the same capability portable**: it is an open
runtime that runs the *same* workflow scripts — Claude's exact dialect
(`export const meta` + injected `agent` / `parallel` / `pipeline` / … globals) —
against **any** coding-agent CLI: Codex, Claude Code, Gemini, Qwen, Kimi, or your
own.

**Why it matters.** Holding the plan in code keeps intermediate work out of the
host's context, lets you fan out dozens of subagents, and makes multi-stage
orchestration reproducible. That pattern is broadly useful but has been locked
inside one vendor's runtime. ODW reopens it as a CLI-agnostic engine, so **any
agent can orchestrate any other** — and the workflow scripts the Claude Code
ecosystem is already producing become portable artifacts.

## A workflow looks like this

```js
// fan-out-reduce.js
export const meta = {
  name: 'fan-out-reduce',
  description: 'Draft in parallel, then synthesize the best answer.',
}

const drafts = await parallel(
  [1, 2, 3, 4].map((i) => () => agent(`Draft #${i}: ${args.question}`)),
)

return await agent(
  'Synthesize the single best answer from these drafts:\n\n' +
    drafts.filter(Boolean).join('\n\n---\n\n'),
)
```

```bash
odw run fan-out-reduce.js --wait --args '{"question": "Design a rate limiter."}'
```

It is **plain JavaScript** in the same dialect Claude Code uses — so a script
written for Claude Code runs here unchanged. The flagship example,
[`examples/deep-research.js`](examples/deep-research.js) (fan-out web research →
adversarial fact-checking → a cited report), is exactly such a script and is the
runtime's v1 acceptance target.

## The primitives

A workflow is `export const meta = {…}` followed by a script body that runs in an
async context. The body composes these **injected globals** with ordinary JS
control flow (loops, `if`, dedup) — no imports:

| Primitive | Role |
| --- | --- |
| `agent(prompt, opts?)` | Run one coding agent on a subtask. The only verb that does work. Returns its text, or a validated object when `opts.schema` is set. |
| `parallel(thunks)` | Run a batch concurrently and wait for all of it (**barrier**). A failed thunk becomes `null`. |
| `pipeline(items, ...stages)` | Stream each item through the stages independently (**no barrier**). Each stage gets `(prev, item, index)`. |
| `phase(title)` / `log(msg)` | Group progress under a phase / emit a progress line. |
| `schema` (JSON Schema) | A typed output contract for `agent`; the reply is validated and retried until it conforms. |
| `args` | The workflow's input, injected verbatim. |
| `budget` | `{ total, spent(), remaining() }` — scale depth to a token target. |
| `workflow(ref, args?)` | Run another workflow inline (one level of nesting). |

Use **`parallel`** when the next step needs the whole batch at once (dedup,
tally, synthesis); **`pipeline`** for multi-stage work (the default). Keep
reductions order-independent — branching on *which agent finished first* breaks
reproducibility.

## Run and observe

The `odw` CLI starts a script in a background worker (fire-and-poll) and lets you
watch it. `--wait` blocks and prints the result.

```bash
odw run wf.js [--args JSON|@file] [--wait]   # start (background); --wait blocks & prints result
odw status <id>          # state + agent count
odw logs <id> --follow   # stream progress events
odw result <id>          # final value
odw pause|resume|stop <id>
odw list
```

A run executes in a detached worker process and persists everything to a run
directory, so it outlives the command that started it and can be observed from
anywhere.

## Configure adapters

Codex, Claude Code, Gemini, Qwen, and Kimi work out of the box. To change the
default, tune flags, or add your own CLI, drop an `odw.config.json` (see
[`odw.config.example.json`](odw.config.example.json)) in the project root,
`~/.config/odw/config.json`, or pass `--config`. ODW only shells out to local
commands — it never calls model APIs directly.

```jsonc
{
  "defaultAdapter": "claude",
  "concurrency": 8,
  "adapters": {
    "my_wrapper": {
      "label": "My custom CLI",
      "command": ["my-agent", "--cwd", "{workspace}", "--prompt-file", "{prompt_file}"]
    }
  }
}
```

## How it works

```
odw (CLI) ─▶ runtime (background worker + run directory)
               └─ loads & transforms ─▶ workflow script (.js, Claude dialect)
                                         └─ injected primitives ─▶ scheduler (async cap + agent backstop)
                                             agent() ─▶ bridge ─▶ adapters ─▶ real CLI subprocess
                                                         ├─ workspace (isolation + diff)
                                                         └─ schema (validate / retry)
```

Two design points are worth calling out:

- **The loader is the crux.** Claude's dialect is neither a normal ES module nor
  a plain script: `export const meta` sits up top, and the body uses top-level
  `await` *and* top-level `return` while referencing injected globals. The loader
  extracts `meta`, strips the `export`, and wraps the body in an async function
  whose parameters *are* the primitives — so the body's `return` becomes the
  workflow's result.
- **No threads.** The engine is async to the core. `agent()` is just an async
  subprocess call, so `parallel` is `Promise.all`, `pipeline` is per-item async
  chains, and the concurrency cap is a small async semaphore — `min(16, cpus-2)`
  by default, with a hard backstop on total dispatches per run.

| Path | Layer |
| --- | --- |
| `src/adapters/` | L1 — uniform CLI invocation (config, placeholders, runner, built-ins) |
| `src/bridge.ts` | L2 — one `agent` call → one CLI run, with schema handling |
| `src/scheduler.ts` | L3 — bounded async concurrency + total-agent backstop |
| `src/primitives.ts`, `src/schema.ts` | L4 — the injected primitives + the data contract |
| `src/loader.ts` | the transform that turns a workflow script into a runnable form |
| `src/runtime/` | L5 — background worker, run directory, control |
| `src/cli.ts` | L6 — the `odw` command |
| `src/workspace.ts` | cross-cutting — workspace isolation and diff |

Workflow scripts stay **plain `.js`** and are never compiled; the engine is
written in **TypeScript** (compiled to ESM, **zero runtime dependencies**) and
ships `.d.ts` authoring types so script authors get editor autocomplete on the
injected globals.

## Install & develop

```bash
git clone https://github.com/xz1220/open-dynamic-workflows.git
cd open-dynamic-workflows
npm install        # dev tooling only — the published package has zero runtime deps
npm run build      # tsc → dist/
npm test           # node:test suite, driven by a mock adapter (no real accounts)
node dist/cli.js --help
```

> Once published, `npm i -g open-dynamic-workflows` (or `npx open-dynamic-workflows …`)
> will put the `odw` command on your PATH.

## Roadmap

This is a milestone-driven rewrite. Each milestone lands green and independently.

| Milestone | Scope | Status |
| --- | --- | --- |
| **M0** | Skeleton: package, strict TS, layered `src/`, CLI shell, test harness | ✅ done |
| **M1** | Adapters + execution bridge + workspace isolation | ⏳ next |
| **M2** | Primitives + async scheduler + **the loader/transform** | ⏳ |
| **M3** | `schema` — structured output (inject / extract / validate / retry) | ⏳ |
| **M4** | Background runtime + full CLI (`run`/`status`/`logs`/`pause`/`stop`) | ⏳ |
| **M5** | 🎯 run [`examples/deep-research.js`](examples/deep-research.js) end-to-end | ⏳ |
| **M6** | Skill doc + references + more examples | ⏳ |

`model` / `agentType`, git-worktree `isolation`, nested `workflow()`, real token
budget accounting, and resume/journaling are tracked as v1.5+ increments. Full
plan: [`docs/dynamic-workflows-tech-plan.md`](docs/dynamic-workflows-tech-plan.md).
Background on the Claude Code dialect ODW aligns with:
[`docs/dynamic-workflows-research.md`](docs/dynamic-workflows-research.md).

## Use as a skill

[`skill/SKILL.md`](skill/SKILL.md) teaches a host agent to author and run
workflows from documentation alone — install it into your agent's skills
directory (Codex CLI → `~/.codex/skills/`, Claude Code → its skills dir). The
[`examples/`](examples/) directory holds runnable workflows: `deep-research.js`,
`fan-out-reduce.js`, `adversarial-verify.js`, `loop-until-dry.js`.

## License

[MIT](LICENSE)
