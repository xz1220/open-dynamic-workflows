---
name: open-dynamic-workflows
description: >
  Write and run dynamic workflows: short JavaScript scripts in Claude Code's
  workflow dialect, run with the `odw` CLI outside the host agent's context,
  fanning subtasks out to coding-agent CLIs (Codex, Claude Code, Gemini, Qwen,
  Kimi, or your own) in a background process and handing back only the final
  result. Use this skill when a task is bigger than a single call — parallel
  draft fan-out, multi-stage review pipelines, adversarial verification of
  findings, or discovery loops that run until nothing new turns up — or when
  the user mentions odw, dynamic workflows, multi-agent orchestration, or
  fanning out subagents.
license: MIT
---

# Open Dynamic Workflows

A dynamic workflow is a short JavaScript script: the orchestration plan is
ordinary code, executed by `odw` in a detached background process, dispatching
each subtask to a real coding-agent CLI process. Intermediate output never
enters your context; all that comes back is the script's final `return` value.

The flow is always three steps: **write the script → `odw run` → inspect the
result, then act**. Don't use this for work that fits in a single call — just
do it directly.

## Write the workflow script

- The file starts with `export const meta = {…}` — a **pure literal** (no
  variables, function calls, or template interpolation). `meta.name` and
  `meta.description` are required; `whenToUse`, `phases`, and `model` are
  optional.
- The body runs in an async context: use top-level `await` directly; the
  top-level `return` value is the workflow's result.
- The primitives are **injected globals** — never import them. Any top-level
  `import` / `export` other than `export const meta` is rejected by the
  loader.
- Ordinary control flow (loops, `if`, dedup) lives in the script. The
  primitives only **dispatch and wait**; what to do with results is the
  script's decision.

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

Input passed with `--args` is injected as the global `args` (parsed JSON, or a
raw string — input that *looks like* JSON but fails to parse is rejected
outright, never silently passed through as a string).

## Primitives at a glance

| Primitive | What it does |
| --- | --- |
| `agent(prompt, opts?)` | Run one coding agent on a subtask; returns its reply text, or a validated object when `opts.schema` is set. The only verb that does real work. |
| `parallel(thunks)` | Run zero-arg thunks concurrently and **wait for all** (barrier). Order preserved; a failed slot is `null`. |
| `pipeline(items, ...stages)` | Stream each item through the stages independently (**no barrier**). Each stage receives `(prev, item, index)`. |
| `phase(title)` / `log(msg)` | Label the following work for progress / emit one progress line. |
| `args` | The workflow input (injected). |
| `budget` | `{ total, spent(), remaining() }` — scale depth to a token target. |
| `workflow(ref, args?)` | Run another workflow inline (one level deep). `ref` is a managed-directory name or `{ scriptPath }`; the child shares this run's concurrency cap, agent counter, and budget. |
| `validate(source)` | Parse and compile-check source without running its workflow body; `meta` is parsed as a pure literal, never evaluated. Returns `{ ok, meta?, errors, warnings }`. **ODW extension** — not part of Claude Code's dialect. |
| `exec(command, opts?)` | Run a command (tests, a build, a linter) without a model; resolves to `{ stdout, stderr, exitCode, signal, timedOut, truncated, durationMs }`. A string runs through the shell, an array as argv. **ODW extension** — not part of Claude Code's dialect. |

`opts` for `agent`: `{ adapter?, schema?, label?, phase?, model?, agentType?, isolation? }`.
`adapter` picks the CLI; `schema` is a raw JSON Schema object (an option, not
a global); `agentType` is a **persona** injected into the prompt — *not* an
adapter name.

`opts` for `exec`: `{ cwd?, env?, timeout?, input?, maxOutputBytes?, label?, phase?, check? }`.
It runs in the source directory by default, is killed after `timeout` seconds
(600) with everything it started, and keeps 8 MiB per stream. A non-zero exit
is a result to branch on, not an error — unless `check: true`, which throws a
recoverable `ExecError`. It takes no agent slot, but pause and stop apply:

```js
let run = await exec('npm test')             // ODW extension
for (let round = 1; run.exitCode !== 0 && round <= 3; round++) {
  await agent(`Fix the failing tests:\n${run.stdout.slice(-4000)}\n${run.stderr.slice(-4000)}`)
  run = await exec('npm test')
}
```

**Rule of thumb:** use `parallel` when the next step needs the **whole batch**
at once (dedup, tally, synthesis); default to `pipeline` for multi-stage work.

Before writing complex compositions — nested workflows, schema retries,
budget-scaled depth — read
[`references/primitives.md`](references/primitives.md).

## Run and observe

```bash
odw run wf.js --wait --args '{"question": "Design a cache."}'   # block and print the result
```

For long runs, fire-and-poll instead of blocking yourself:

```bash
RUN=$(odw run wf.js)        # prints a run id and returns immediately
odw status $RUN             # state + agent count
odw logs $RUN --follow      # stream progress events
odw result $RUN             # print the final value when done
odw pause $RUN / resume $RUN / stop $RUN
odw list                    # all runs
```

Both patterns above behave exactly like this for you: your shell is not a
terminal, so `odw run` detaches and prints the run id. Only a bare invocation
in a human's interactive terminal attaches a live progress view instead
(Ctrl-C there detaches; the run keeps going; `odw attach <run_id>` re-attaches).
Force either way with `-d`/`--detach` or `--fg`, or `ODW_DETACH=1`.

Saved workflows run by name (`odw run <name>`); lookup order:
`.odw/workflows`, `.claude/workflows`, `~/.odw/workflows`,
`~/.claude/workflows`.

### Recover a stalled or failed run (ODW extension)

Every `agent()` result is saved the moment that agent finishes, so a hung
lane, a stop, or a dead worker never loses the work already done. Don't wait
on a stuck run or start it over:

```bash
odw agents $RUN               # each agent: state, label, phase, time, value preview (↺ = replayed)
odw result $RUN --agent 3     # one finished agent's value as JSON (id or label) — works mid-run
odw stop $RUN                 # give up on the hung lane, then…
odw resume $RUN --wait        # …a NEW run: unchanged agent() calls replay, only the rest run
```

- `odw result --agent` salvages partial results while the run is still going.
- `odw resume` on an ended run (done, failed, stopped, or stale) starts a new
  run with the same script, args and adapter. A call whose prompt and options
  are unchanged (phase aside) returns its saved value for free — no adapter
  call, slot or budget. Edit the script first to fix the failing step: only
  edited and new calls run. `--adapter <name>` switches the default CLI; calls
  that named no adapter still replay.
- On a *paused* run, `odw resume` just continues it in place. A run that is
  still running is refused: `odw stop` it first (or pass `--force`).
- Keep prompts deterministic — one built from `Date.now()` or `Math.random()`
  never matches, so it runs again.

## Adapters

Codex, Claude Code, Gemini, Qwen, and Kimi work out of the box with no
configuration. To change the default CLI, tune flags, or plug in a custom CLI,
read [`references/adapters.md`](references/adapters.md) and write an
`odw.config.json` (at the project root or `~/.config/odw/config.json`, or pass
`--config`).

If a run fails with **AdapterNotFound** (several agent CLIs installed, no
default picked): run `odw init --check` to see which CLIs are installed — in
your non-interactive shell it only reports, never prompts. Then **ask your
user** which CLI to default to and persist their answer with
`odw init --adapter <name>`. Do not pick for them silently; the default decides
which vendor's CLI (and whose quota/permissions) every bare `agent()` call uses.

If agents fail fast or come back empty, run `odw doctor`: it checks the
runtime, config, run directory and every adapter, and prints what to fix.
`odw doctor --smoke` additionally sends the default adapter one real prompt —
ask your user first (it costs a model call) — and catches a CLI that exits 0
without answering when headless (a login, trust or approval prompt).

## Behavior you must know

- **Context**: each agent receives its own prompt. Agents using the default
  source directory share files; use worktree isolation when file edits must be separate.
- **Workspace**: agents run directly in the run's source directory (`--source`,
  default the current directory) — the same semantics as Claude Code's own
  Workflow tool. For isolation, ask per agent with `isolation: "worktree"`: the
  agent gets a throwaway **git worktree** (needs the source to be a git repo
  with at least one commit; the agent sees HEAD, not uncommitted edits).
  The temporary worktree is removed afterward and changes are not merged.
  `agent()` returns the reply, not a diff; include required deliverables in the
  reply or persist them explicitly before cleanup.
- **Cost**: concurrency is capped (default `min(16, cpus - 2)`) and total
  dispatches per run have a hard guard; use `odw pause` / `odw stop` when a
  run exceeds expectations.
- **Results**: the engine never commits, pushes, or applies diffs for you.
  Inspect the `return` value first, then decide the next step.

## Common mistakes

| Mistake | Correction |
| --- | --- |
| Importing primitives or other modules in the script | Primitives are injected globals; any extra top-level `import`/`export` is rejected by the loader. |
| Variables, spreads, or function calls inside `meta` | `meta` must be a pure literal. |
| Treating all failures in `parallel`/`pipeline` alike | Recoverable failures become `null`; stop, budget and dispatch-limit errors abort. Retry missing results or fail when every item is required; filter only when partial output is acceptable. |
| Branching on which agent finished first | Breaks reproducibility; keep reductions order-independent. |
| Re-running a stalled or failed run from scratch | Read finished agents with `odw result <run> --agent <id>`; `odw stop`, fix the script, then `odw resume` — finished calls replay for free. |
| Using `validate()` and expecting the script to run on Claude Code | `validate` is an ODW extension and runs on odw only. |
| Using `exec()` and expecting the script to run on Claude Code | `exec` is an ODW extension and runs on odw only; `validate()` warns about it. |
