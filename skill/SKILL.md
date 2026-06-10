---
name: open-dynamic-workflows
description: >
  Give any coding agent dynamic-workflow power. Write a short JavaScript script
  in Claude Code's workflow dialect (export const meta + injected agent /
  parallel / pipeline / phase / log / args / budget globals) and run it against
  any coding-agent CLI (Codex, Claude Code, Gemini, Qwen, Kimi, or your own) with
  the `odw` command. Use when a task benefits from fanning out subtasks,
  multi-stage pipelines, adversarial verification, or loop-until-done discovery,
  rather than one in-context attempt.
license: MIT. See LICENSE for full terms.
---

# Open Dynamic Workflows

> 简体中文版: [`zh-CN/SKILL.md`](zh-CN/SKILL.md)

A *dynamic workflow* is a small JavaScript script that holds an orchestration
plan in ordinary code and dispatches coding-agent CLIs at scale — outside your
own context. You (the host agent) **write the script, then run it**; the runtime
executes it in a background process and hands back only the final result.

The script is plain JavaScript in **Claude Code's exact workflow dialect**, so a
script written for Claude Code runs here unchanged, and one you write here runs
on Claude Code.

Use this when the work is bigger than one call: fan out N drafts and synthesize,
run a multi-stage review pipeline, verify findings adversarially, or discover
until nothing new turns up.

## 1. Write a workflow script

A workflow is `export const meta = {…}` (a **pure literal**, at the top) followed
by a script body. `meta.name` and `meta.description` are **required**; `whenToUse`,
`phases`, and `model` are optional. The body runs in an async context — use `await`
directly — and its top-level `return` is the workflow's result. The primitives are
**injected globals**: do **not** import them — any other top-level `import` or
`export` in the file is rejected by the loader.

```js
// fan-out-reduce.js
export const meta = {
  name: 'fan-out-reduce',
  description: 'Draft in parallel, then synthesize.',
  phases: [{ title: 'Draft' }, { title: 'Synthesize' }],
}

const question = (args && args.question) || 'Design a cache.'

phase('Draft')
const drafts = await parallel(
  [1, 2, 3].map((i) => () => agent(`Draft #${i}: ${question}`, { phase: 'Draft' })),
)

phase('Synthesize')
return await agent(
  'Synthesize the best answer from:\n' + drafts.filter(Boolean).join('\n---\n'),
  { phase: 'Synthesize' },
)
```

- `args` is the input you pass with `--args` (parsed JSON, or a raw string —
  input that *looks* like JSON but fails to parse is rejected, not passed through).
- Ordinary control flow (loops, `if`, dedup) lives in the script. The primitives
  only **dispatch and wait** — you decide what to do with results.

## 2. The primitives (at a glance)

| Primitive | What it does |
| --- | --- |
| `agent(prompt, opts?)` | Run one coding agent on a subtask; returns its reply text, or a validated object when `opts.schema` is set. The only verb that does work. |
| `parallel(thunks)` | Run zero-arg thunks concurrently and **wait for all** (barrier). Order preserved; a failed one is `null`. |
| `pipeline(items, ...stages)` | Stream each item through the stages independently (**no barrier**). Each stage gets `(prev, item, index)`. |
| `phase(title)` / `log(msg)` | Label following work for progress / emit a progress line. |
| `args` | The workflow input (injected). |
| `budget` | `{ total, spent(), remaining() }` — scale depth to a token target. |
| `workflow(ref, args?)` | Run another workflow inline. Part of the dialect; not yet implemented in odw — calling it throws a clear "not implemented" error. |
| `schema` | A raw JSON Schema object passed as `agent(..., { schema })` (an option, not a global). |

`opts` for `agent`: `{ adapter?, schema?, label?, phase?, model?, agentType?, isolation? }`.
`adapter` picks the CLI; `model` is forwarded to that adapter's declared model
flag; `agentType` is a **persona** injected into the prompt (it is *not* an
adapter name); `isolation: "worktree"` is satisfied by the default copy-isolated
workspace. Full reference: [`references/primitives.md`](references/primitives.md).

**Rule of thumb:** `parallel` when the next step needs the *whole* batch at once
(dedup, tally, synthesis); `pipeline` for multi-stage work (the default). Keep
reductions order-independent — branching on *which agent finished first* breaks
reproducibility.

## 3. Run it

The `odw` CLI starts the script in the background (fire-and-poll) and lets you
observe it. Use `--wait` to block and print the result:

```bash
odw run fan-out-reduce.js --wait --args '{"question": "Design a cache."}'
```

Fire-and-poll instead:

```bash
RUN=$(odw run wf.js)        # prints a run id
odw status $RUN             # state + agent count
odw logs $RUN --follow      # stream progress events
odw result $RUN             # print the final value when done
odw pause $RUN / resume $RUN / stop $RUN
odw list                    # all runs
```

## 4. Configure adapters

Codex, Claude Code, Gemini, Qwen, and Kimi work out of the box. To change the
default, tune flags, or add your own CLI, write an `odw.config.json` (see
[`references/adapters.md`](references/adapters.md)) and pass `--config`, or place
it at `./odw.config.json` or `~/.config/odw/config.json`.

## 5. Invariants

- Agents run independently and in isolation; one never sees another's draft
  unless your script passes it along.
- By default each agent runs in an isolated copy of the working tree
  (`workspaceMode: "copy"`); your real tree is not modified. `inplace` runs
  agents **directly in the real tree** — no isolation, no diff — so use it only
  when you *want* in-place edits and point `--source` at a directory you can
  afford to have modified.
- Concurrency is capped (`min(16, cpus-2)` by default) and total dispatches are
  bounded (a runaway guard). Cost is controlled with that cap and `pause`/`stop`.
- The result is whatever the script `return`s. Inspect it, then decide what to do
  — the engine does not commit, push, or apply diffs for you.

## Resources

- [`references/primitives.md`](references/primitives.md) — full primitive
  reference, composition patterns, determinism rule.
- [`references/adapters.md`](references/adapters.md) — adapter config and the
  built-in CLIs.
- `examples/` (repo root) — `deep-research.js`, `fan-out-reduce.js`,
  `adversarial-verify.js`, `loop-until-dry.js`.
