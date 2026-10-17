# Primitive reference

The primitives are **injected globals** inside a workflow script — never
imported. The script body runs in an async context (top-level `await` and
top-level `return` are legal), with `meta` declared via `export const meta` at
the top (`meta.name` and `meta.description` are required; no other top-level
`import`/`export` may appear in the file).

ODW supports these core workflow conventions; this does not promise full Claude
runtime equivalence. The execution, validation, and recovery boundaries below
also apply when migrating a shared workflow.

## agent

```js
agent(prompt, opts?) -> Promise<unknown>
```

Run one coding agent on `prompt`. The only primitive that does real work; every
other primitive organizes calls to it.

- **opts.schema** — a JSON Schema object. When given, the reply is parsed and
  validated, and the agent is retried with corrective feedback until it conforms
  or the retry budget runs out (then the call throws). Without it, the raw reply
  text is returned.
- **opts.label** — a short name for progress display.
- **opts.phase** — overrides the current phase for this one call. Prefer this
  inside `parallel`/`pipeline`, where the global phase is shared.
- **opts.adapter** — which configured CLI to use (e.g. `"codex"`); defaults to
  the config's `defaultAdapter`.
- **opts.model** — a model id forwarded through the adapter's `{model}` template
  token or declared `flags.model` (e.g. `claude --model …`). Without either
  carrier, the CLI's default model is used and a routing note records the
  ignored option. Model ids are CLI-specific. `meta.model` and
  `meta.phases[].model` are accepted metadata, but do not select execution
  models; pass `{ model }` to each `agent()` call that needs one.
- **opts.agentType** — a **persona** injected into the prompt (e.g.
  `"code-reviewer"`), so it works on every CLI. It is **not** an adapter name and
  never affects adapter selection — only `opts.adapter` does. It does not load
  Claude's built-in role permissions, tools, or project subagent definitions.
- **opts.isolation** — `"worktree"` gives this agent a throwaway **git
  worktree** of the source repo (default workspace: the source directory
  itself). Needs a repo with at least one commit; the agent sees HEAD without
  uncommitted changes. The worktree is cleaned up after the call and changes
  are not merged into the source. `agent()` returns only the reply, not a diff
  or a persistent worktree path: include required deliverables in the reply or
  explicitly save them outside the temporary worktree.

Returns the reply text, or the validated JSON value when `schema` is set. CLI
errors and exhausted schema retries throw. Inside `parallel`/`pipeline`, these
recoverable failures become `null`. Fatal errors — stop requests, exhausted
estimated budgets, the total-agent cap, and invalid adapter/run configuration —
propagate and terminate the run.

Every call that completes is saved in its run directory
(`agents/<agentId>.json`) before its `agent_finished` event, so a finished
result survives a lane that hangs, a stop, or a dead worker. Read it while the
run is still going with `odw result <run> --agent <id|label>`, or list them all
with `odw agents <run>` (ODW extension). `odw resume` replays saved calls — see
[resume](#resume-odw-extension).

## parallel

```js
parallel(thunks: Array<() => Promise<T>>) -> Promise<Array<T | null>>
```

Run every zero-arg thunk concurrently and **wait for all of them** (a barrier).
Results come back in input order; a recoverable failure yields `null` in its
slot. After all thunks settle, any fatal error is rethrown. Already-running
agents are not killed by this barrier.

Use `parallel` when the next step needs the entire batch at once — dedup, tally,
or a synthesis pass over all results.

```js
const votes = await parallel(
  Array.from({ length: 5 }, () => () => agent('Is X true? yes/no')),
)
const yes = votes.filter((v) => v && v.toLowerCase().startsWith('yes')).length
```

Each thunk must be zero-arg — build them with `.map((x) => () => agent(...))` so
each captures its own value.

## pipeline

```js
pipeline(items, ...stages) -> Promise<unknown[]>
```

Send each item through all stages **independently** — no barrier between stages.
Item B can be in stage 1 while item A is already in stage 3. This is the default
shape for multi-stage work; it avoids the idle time a barrier would impose.

Each stage receives `(previous, item, index)` — take only what you need:

```js
const results = await pipeline(
  files,
  (file) => agent(`Review ${file}`, { schema: FINDINGS }),  // stage 1: (prev = item)
  (review, file) => ({ file, review }),                     // stage 2: (prev, item)
)
```

A recoverable stage failure drops that item to `null` and skips its remaining
stages. Fatal errors propagate after the running chains settle.
`pipeline(items, stage)` with a single stage is just "map this over items
concurrently" — handy when each step itself fans out with `parallel`.

## phase / log

```js
phase(title)    // group following agent calls under a named phase
log(message)    // emit a one-line progress event
```

Both are observation only. `phase` sets a run-global current phase; inside
concurrent sections pass `{ phase }` to `agent` instead, since the global is
shared.

## args / budget

```js
args                                  // the workflow input, injected verbatim
budget // { total: number | null, spent(): number, remaining(): number }
```

`args` is whatever you passed with `--args` (parsed JSON, or a raw string;
JSON-looking input that fails to parse is rejected rather than silently passed
through as a string). `budget.total` is the token target set with
`odw run … --budget <tokens>`, else `null`; scale depth to it, e.g.
`budget.total ? Math.floor(budget.total / 120_000) : 5`.
`spent()` is `ceil(total successful final-reply characters / 4)` across this
run, including nested workflows. Input tokens, failed calls, and intermediate
schema-retry replies are not counted. `remaining()` is
`max(0, total - spent())`, or `Infinity` without a target.

After obtaining a dispatch slot and checking pause/stop, the scheduler rejects
new agent calls when this estimate reaches the target. In-flight calls may
finish and exceed it. This is a dispatch guard based on an estimate, not a
limit on actual token usage or billing.

## workflow

```js
workflow(nameOrRef, args?) -> Promise<unknown>
```

Run another workflow inline and return its final value. A string resolves a
name from the managed workflow directories; `{ scriptPath }` resolves relative
to the run's source directory. The child shares the parent's scheduler,
concurrency cap, agent count, controls, and estimated budget. Its phases have
a `▸ <name>` prefix; it has no separate run id. Omitted child `args` becomes
`null`, rather than inheriting the parent's input.

Only one level is supported: calling `workflow()` from a child throws. Missing
files, unknown names, and invalid child scripts also throw; ordinary errors
can become `null` when this call is inside `parallel`/`pipeline`.

## validate (ODW extension)

`validate(source)` loads a candidate workflow without running its body and
returns `{ ok, meta?, errors, warnings }`. Loading parses `meta` as a pure
literal (never evaluating it) and only compiles the body. Warnings flag selected portability
hazards such as `Date.now()`, `Math.random()` and calls to the ODW-only `exec()`; they do not
block execution.
This helper is not part of the shared core surface. A script's own `validate`
binding takes precedence over the injected helper.

## resume (ODW extension)

`odw resume <run>` on an ended run — done, failed, stopped, or stale after its
worker died — starts a new run with the same script, args and adapter. There,
an `agent()` call **replays**: it returns the value the old run saved, at once,
with no adapter call, concurrency slot, dispatch count or budget, when its
*resume key* matches — the sha256 of its prompt plus its `schema`, `adapter`
(as written in the call, not the run's default), `model`, `agentType`,
`isolation` and `label`. `phase` is not part of the key, and `--adapter` on the
resume changes only the default, so calls that name no adapter still replay.
Calls with the same key replay in call order (the n-th such call gets the n-th
saved result); a call past them, or one whose prompt or options changed, runs
normally. Nested `workflow()` calls replay the same way.

Replayed agents are marked `cached` (↺ in `odw agents` and the dashboard) and
saved again, so a resume of a resume replays them too. Fix the failing step,
or add steps, then resume: only what changed runs. On a paused live run,
`odw resume` keeps its old meaning (continue in place); a still-running run is
refused unless `--force`.

## exec (ODW extension)

```js
exec(command, opts?) -> Promise<{ stdout, stderr, exitCode, signal, timedOut, truncated, durationMs }>
```

Run a command **without launching a model** — the test suite, a build, a
linter — and branch on its real result. It is not portable: Claude Code's
Workflow tool has no `exec` global (`validate()` warns about it), and a
script's own `exec` binding takes precedence over the injected one.

- **command** — a string runs through the platform shell (`/bin/sh -c` on
  POSIX, `cmd.exe /d /s /c` on Windows); an array is an argv run directly,
  without a shell, so no element is interpreted. On Windows, batch files such
  as `npm` run only through the shell: use the string form.
- **opts.cwd** — the working directory. Defaults to the run's source directory
  (where agents run); a relative path resolves against it.
- **opts.env** — extra variables, layered over the worker's environment.
- **opts.input** — text written to stdin; without it, stdin is closed at once.
- **opts.timeout** — seconds, default `600`. On expiry the command is killed
  together with every process it started; the result has `timedOut: true`
  (and `exitCode: null`, `signal: "SIGKILL"`).
- **opts.maxOutputBytes** — bytes kept per stream, default 8 MiB. Output past
  the cap is read and dropped, never fatal; `truncated` says it happened.
- **opts.label** / **opts.phase** — progress display, as for `agent`. The label
  defaults to the first 40 characters of the command.
- **opts.check** — throw an `ExecError` unless the command exits 0.

A non-zero exit is a result, not an error. A program that cannot be launched
reports exit `127` (not found) or `126`, as a shell would. With `check: true`
the failure throws an `ExecError` carrying `.result` — recoverable, like a
failed agent: catch it, or let `parallel`/`pipeline` turn it into `null`.
Misuse (a `cwd` that does not exist, a non-string argv element) throws before
anything runs.

A command is not an agent: it takes no concurrency slot and does not count
toward the total-agent cap or the budget. It still waits while the run is
paused, and a stop (or any fatal error) kills it at once, process group and
all, rejecting the call with that error. Each step is recorded as
`command_started`, then `command_finished` (exit 0) or `command_failed`
(anything else), and shows in `odw logs`, the live view and the dashboard
graph as a command node.

```js
phase('Test')
let run = await exec('npm test', { timeout: 900 })
for (let round = 1; run.exitCode !== 0 && round <= 3; round++) {
  await agent(`Fix the failing tests.\n\n${run.stdout.slice(-4000)}\n${run.stderr.slice(-4000)}`, { phase: 'Fix' })
  run = await exec('npm test', { timeout: 900, label: `npm test r${round}` })
}
await exec(['git', 'diff', '--stat'], { check: true }) // throws ExecError unless exit 0
```

The command runs with the worker's own permissions — the same trust as the
script itself; `exec` adds no sandbox. The ODW repository's
`examples/test-fix-loop.js` is this loop as a complete workflow.

## schema

A schema is a plain **JSON Schema object** passed to `agent`:

```js
const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, severity: { type: 'string', enum: ['low', 'medium', 'high'] } },
        required: ['title'],
      },
    },
  },
  required: ['findings'],
}
const result = await agent('Review this diff.', { schema: FINDINGS }) // -> validated object
```

The validator implements this subset, not the full JSON Schema standard:

| Shape | Enforced constraints |
|---|---|
| `type` as one string | `object`, `array`, `string`, `integer`, `number`, `boolean`, `null` |
| `type: "object"` | `properties`, `required`, and `additionalProperties: false` |
| `type: "array"` | `items` as one schema object and `minItems` |
| `enum` | Structural membership, independently of `type` |

Object and array constraints need their explicit `type`; omitting it skips
those checks. Schema-valued `additionalProperties`, tuple/boolean schemas,
and union-type arrays are outside this subset. Unsupported keywords such as
`const`, `$ref`/`$defs`, `oneOf`/`anyOf`/`allOf`, `minimum`/`maximum`, `pattern`,
`format`, and `maxItems` are not enforced: they may still be sent to the agent
as instructions, but passing validation does not prove them. An unknown
`type` produces a validation error. Rewrite schemas into the supported subset
or explicitly check additional constraints in the workflow.

## Composition patterns

These are not new primitives — just primitives plus ordinary JavaScript.

- **fan-out → reduce → synthesize** — `parallel` to draft, dedup/merge in JS, one
  final `agent` to synthesize.
- **adversarial verify** — find candidates, then for each run several skeptics
  with `parallel` and keep it only if a majority fail to refute it.
- **judge panel** — score one artifact from several angles, combine in script.
- **loop-until-dry** — `while` loop, each round `parallel` fans out finders,
  dedup against a `seen` set, stop after K empty rounds.

## Determinism rule

Out-of-order execution is fine **as long as your reduction is order-independent**
(accumulate into a set, dedup, tally). Do **not** branch on which agent finished
first or dispatch follow-ups based on completion timing — that makes the run
non-reproducible. Prefer input-driven `parallel`/`pipeline` compositions.

These are authoring guidelines, not a sandbox. ODW executes JavaScript with
`AsyncFunction` and does not isolate the script from Node globals or filesystem
and shell access. Run only trusted scripts. Portability warnings do not prove
that a script is safe or will run in another runtime.

Resume depends on the same rule: a call is matched by its prompt and options,
in call order, so a prompt built from `Date.now()`/`Math.random()`, or a
dispatch that depends on completion timing, does not match and runs again.
`odw rerun` starts over without replaying anything.

## Limits

- **Concurrency cap** — at most N agent CLIs run at once (`min(16, cpus-2)` by
  default; set `concurrency` in config). Excess calls queue.
- **Total-agent backstop** — a hard ceiling on dispatches per run (default
  1000). Exceeding it aborts the run, so a buggy loop cannot fan out forever.
- `exec()` commands count toward neither limit; each is bounded by its own
  `timeout` and `maxOutputBytes`.
