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
  text is returned. What ODW cannot check in a schema is named in the run's log (or,
  under `"schemaKeywords": "strict"`, fails the call before it starts); CLIs that
  validate schemas get it natively — see [schema](#schema).
- **opts.label** — a short name for progress display.
- **opts.phase** — overrides the current phase for this one call. Prefer this
  inside `parallel`/`pipeline`, where the global phase is shared.
- **opts.adapter** — which configured CLI to use (e.g. `"codex"`); defaults to
  the phase's adapter (below), then the config's `defaultAdapter`. **ODW
  extension:** a list, `["codex", "claude"]`, is a fallback chain in order of
  preference — see [routing](#routing-phase-defaults-model-tiers-fallback-chains-odw-extension).
- **opts.model** — a model id forwarded through the adapter's `{model}` template
  token or declared `flags.model` (e.g. `claude --model …`). Without either
  carrier, the CLI's default model is used and a routing note records the
  ignored option. Model ids are CLI-specific. **ODW extension:** `"@fast"`
  names a model tier — each CLI's own id for it — and a phase may give a
  default model; `meta.model` stays metadata.
- **opts.agentType** — a **persona** injected into the prompt (e.g.
  `"code-reviewer"`), so it works on every CLI. It is **not** an adapter name and
  never affects adapter selection — only `opts.adapter` does. It does not load
  Claude's built-in role permissions, tools, or project subagent definitions.
- **opts.isolation** — `"worktree"` gives this agent a throwaway **git
  worktree** of the source repo (default workspace: the source directory
  itself). Needs a repo with at least one commit; the agent sees HEAD without
  uncommitted changes. The worktree is cleaned up after the call and changes
  are not merged into the source. `agent()` returns only the reply, not a diff
  or a persistent worktree path; the run keeps what the agent changed as a diff
  to review and apply — see [kept changes](#what-an-isolated-agent-changed-odw-extension).
  Before the agent starts, `.worktreeinclude` brings in what a checkout lacks
  (`.env`, `node_modules`, …) and `worktreeSetup` runs — see
  [isolated worktrees](#isolated-worktrees-and-the-agent-environment).
- **opts.keep** (**ODW extension**) — with `isolation: "worktree"`, also commit
  the agent's change to a branch `odw/<runId>/<agentId>-<label>` of the source
  repository. `false` opts one agent out of the `keepBranches` setting. Ignored
  (with a log line) without isolation; Claude Code ignores it.
- **opts.permissions** (**ODW extension**) — `"read"`, `"edit"` or `"full"`: run
  this agent at a stricter permission tier than the run's (`"permissions"` in the
  config, `odw run --permissions`). Use `"read"` for research and review agents:
  they can look but not edit or run commands. It may only lower the tier (read <
  edit < full) — asking for more fails the call with an `AgentError` naming both
  tiers — and an adapter with no read-only mode refuses `"read"` (the call fails
  before its CLI starts; `claude`, `codex` and `gemini` have one). See
  [adapters](adapters.md#permissions-what-each-built-in-may-do). Claude Code
  ignores it.
- **opts.expect** (**ODW extension**) — what must hold once the agent has
  replied, checked by odw: `{ changes?, files?, command?, match?, timeout? }`. See
  [expect](#expect-odw-extension). Claude Code ignores it.
- **opts.expectRetries** (**ODW extension**) — how many times work that missed
  `expect` runs again, told what it missed (default: the `expectRetries`
  setting, 1).
- **opts.allowEmpty** (**ODW extension**) — accept an empty or whitespace-only
  reply as the answer. Without it, an empty reply fails the call with reason
  `"empty_reply"`.

Returns the reply text, or the validated JSON value when `schema` is set. CLI
errors, exhausted schema retries, work that missed its `expect` checks and an
empty reply throw. Inside `parallel`/`pipeline`, these recoverable failures
become `null`. Fatal errors — stop requests, exhausted budgets, the total-agent
cap, and invalid adapter/run configuration — propagate and terminate the run.
A failed CLI run's error carries `reason` (`rate_limit`, `quota`, `auth`,
`timeout`, `stalled`, `not_found`, `permission`, `exit`, `empty_reply` or
`unmet_expectation`), the same as its `agent_failed` event — branch on it in a
`try`/`catch`.

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
phase(title, opts?)    // group following agent calls under a named phase
log(message)           // emit a one-line progress event
```

Both are observation only — save `opts` (below). `phase` sets a run-global
current phase; inside concurrent sections pass `{ phase }` to `agent` instead,
since the global is shared.

## Routing: phase defaults, model tiers, fallback chains (ODW extension)

Which CLI and model each agent runs on, and where it goes when that CLI cannot
take it. Claude Code ignores all of it.

- **Phase defaults.** A `meta.phases` entry `{ title, adapter?, model? }` (a
  plain string entry is just a title) gives its phase's agents an adapter and a
  model; `phase(title, { adapter?, model? })` sets them for the agents that
  follow, in place of the entry (`phase(title)` alone keeps what the phase has;
  `{}` clears it). An option the `agent()` call sets always wins, and a call's
  own `phase` option brings that phase's defaults. A bad `adapter` or `model`
  in `meta.phases` fails the workflow's load (and `validate()`); bad `phase()`
  options throw.
- **Model tiers.** `model: "@fast"` picks the id the `models` setting gives the
  adapter the agent runs on — after a fallback, the next adapter's. A tier
  with no id for that adapter leaves its CLI's default model (logged); an
  unknown tier fails the call with an `AgentError` listing the tiers. A model
  without the `@` (or with characters a tier name cannot have, such as
  `@cf/…`) is a model id, passed to every adapter as is.
- **Fallback chains.** `adapter: ["codex", "claude"]`, or the `fallback`
  setting for the adapter a call runs on: when its CLI's quota is spent or its
  login is refused, the call runs again on the next adapter — a fresh prompt,
  the same options. A rate limit is retried in place (`transientRetries`); any
  other failure is the call's. Each move is a log line
  (`search:3 → claude after codex quota`); the call takes a slot on its new
  adapter, letting the old one's go first; its transcript goes on after an
  `{"kind":"attempt","reason":"fallback","adapter":"claude"}` line; and what
  the failed runs spent still counts. A fallback runs at the call's own
  permission tier — an adapter that cannot run exactly that tier is skipped,
  with a log line. `agent_finished` and the saved result name the adapter that
  produced the value (`adapter`) and the ones left (`fellBackFrom`);
  `agent_failed` names them too when the call fell back.
- **Quota breaker.** After `quotaBreaker` (default 3) quota failures in a row
  on one adapter, the run's later calls skip it: each starts on the next
  adapter of its chain, or fails at once (reason `quota`) without one. One
  warning says so.

```js
export const meta = {
  name: 'triage',
  description: 'Map cheaply, judge carefully.',
  phases: [{ title: 'Map', model: '@fast' }, { title: 'Judge', adapter: ['claude', 'codex'], model: '@strong' }],
}
phase('Map')
const areas = await agent('List the modules touched by HEAD~5..HEAD, one per line.')
phase('Judge')
return await agent(`Which of these needs a careful review first, and why?\n${areas}`)
```

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
`spent()` is the output tokens spent so far across this run, nested workflows
included: the CLI's own count wherever its adapter reports usage (the built-in
`claude` does — an ODW extension), else `ceil(reply characters / 4)` for that
CLI run. Every CLI run of a call counts — schema retries, rate-limit retries, and
failed runs that reported usage; input tokens do not. `remaining()` is
`max(0, total - spent())`, or `Infinity` without a target.

After obtaining a dispatch slot and checking pause/stop, the scheduler rejects
new agent calls when `spent()` reaches the target. In-flight calls may finish
and exceed it. This is a dispatch guard on output tokens, not a limit on
billing. What each agent and the whole run spent — tokens in and out, cache
reads and writes, and cost where the CLI reports it — shows in `odw status`, the
live view and the dashboard (ODW extension).

## workflow

```js
workflow(nameOrRef, args?) -> Promise<unknown>
```

Run another workflow inline and return its final value. A string resolves a
name from the managed workflow directories; `{ scriptPath }` resolves relative
to the run's source directory. The child shares the parent's scheduler,
concurrency cap, agent count, controls, and budget. Its phases have
a `▸ <name>` prefix; it has no separate run id. Omitted child `args` becomes
`null`, rather than inheriting the parent's input.

Only one level is supported: calling `workflow()` from a child throws. Missing
files, unknown names, and invalid child scripts also throw; ordinary errors
can become `null` when this call is inside `parallel`/`pipeline`.

## validate (ODW extension)

`validate(source)` loads a candidate workflow without running its body and
returns `{ ok, meta?, errors, warnings }`. Loading parses `meta` as a pure
literal (never evaluating it) and only compiles the body. Warnings flag selected portability
hazards such as `Date.now()`, `Math.random()` and calls to the ODW-only `exec()` and
`checkpoint()`; they do not block execution.
This helper is not part of the shared core surface. A script's own `validate`
binding takes precedence over the injected helper.

## resume (ODW extension)

`odw resume <run>` on an ended run — done, failed, stopped, or stale after its
worker died — starts a new run with the same script, args and adapter. There,
an `agent()` call **replays**: it returns the value the old run saved, at once,
with no adapter call, concurrency slot, dispatch count or budget, when its
*resume key* matches — the sha256 of its prompt plus its `schema`, `adapter`
(as written in the call, not the run's default), `model`, `agentType`,
`isolation`, `label` and `permissions` (as written in the call). `phase` is not
part of the key, and `--adapter` or `--permissions` on the resume change only
the run's defaults, so calls that name no adapter or tier still replay. Nor
are a phase's default adapter and model (ODW extension), so a phase routed
elsewhere still replays; an adapter list keys in its order, and a model tier
as the tier. A call that fell back replays its value and walks no chain.
Calls with the same key replay in call order (the n-th such call gets the n-th
saved result); a call past them, or one whose prompt or options changed, runs
normally. Nested `workflow()` calls replay the same way. A `checkpoint()` is
never replayed: the resumed run asks it again.

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
- **opts.env** — extra variables, layered over the worker's environment and
  the run's `ODW_RUN_ID`.
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

## checkpoint (ODW extension)

```js
checkpoint(title, opts?) -> Promise<{ approved, note, by }>
```

Pause the run until a person approves or rejects — before an expensive or
hard-to-undo step, or to have a plan confirmed. It is not portable: Claude
Code's workflows take no mid-run input and have no `checkpoint` global
(`validate()` warns about it), and a script's own `checkpoint` binding takes
precedence over the injected one.

- **title** — the question, on one line (whitespace collapsed; events,
  `status.json` and the dashboard keep 200 characters).
- **opts.payload** — what the person should look at: any JSON value. It is
  made JSON-safe (a BigInt becomes its digits, a cycle `"[Circular]"`) and kept
  to 64 KiB; a larger one keeps its start, as text, and the event says
  `truncated`.
- **opts.timeout** — seconds to wait; no limit by default.
- **opts.onTimeout** — what silence means: `"approve"` or `"reject"` resolve
  with `by: "timeout"`; `"fail"` (the default) throws a `CheckpointTimeout` —
  recoverable, like a failed agent: catch it, or let `parallel`/`pipeline` turn
  it into `null`.

The call resolves to `{ approved, note, by }`: `note` is the person's note or
`null`; `by` is `"cli"` (`odw approve|reject`), `"dashboard"` (`odw serve`) or
`"timeout"`. A rejection is an answer, not an error: the script decides what it
means — stop, re-plan with the note, skip a step.

Waiting is not work: a checkpoint takes no concurrency slot, counts toward
neither the total-agent cap nor the budget, and is asked even while the run is
paused; agents already running carry on. A stop — or any fatal error — ends the
wait at once, and the run with it. Several checkpoints can wait at the same time
(inside `parallel`), each numbered in call order (`checkpointId`, from 1).
Misuse (an empty title, a non-positive timeout) throws before anything is asked.

While one waits, the run's display state is `waiting`: `odw status` shows the
question, the payload and the exact `odw approve|reject <run> --checkpoint N`
commands, and the dashboard an Approve/Reject card. Without `--checkpoint` an
answer goes to the oldest checkpoint waiting. Each checkpoint is recorded as
`checkpoint_requested { checkpointId, title, payload, phase }`, then exactly one
`checkpoint_resolved { checkpointId, approved, note, by }` (with an `error`, and
`by: null`, when the run ended first). `odw resume` never replays a checkpoint:
the resumed run asks again.

```js
phase('Plan')
const plan = await agent(`Plan this as independent steps: ${task}`, { schema: PLAN })
phase('Approve')
const { approved, note } = await checkpoint(`Run this ${plan.steps.length}-step plan?`, {
  payload: plan,
  timeout: 3600,
  onTimeout: 'reject', // nobody answered within the hour: change nothing
})
if (!approved) return { approved, note, plan }
phase('Execute')
await parallel(plan.steps.map((step) => () => agent(step.instructions)))
```

The ODW repository's `examples/plan-approve-execute.js` is this flow as a
complete workflow, re-planning when a rejection comes with a note.

## Isolated worktrees and the agent environment

An isolated agent (`isolation: "worktree"`) starts in a clean checkout of HEAD,
so whatever git does not track — `.env`, `.venv`, `node_modules` — is missing
there. Two steps make the worktree ready before the agent starts:

1. **`.worktreeinclude`** at the repository root lists what to bring in, in
   `.gitignore` syntax (patterns relative to the root, `#` comments, `!`
   negations): every file or directory git does not track that a line matches
   is copied into the worktree. Claude Code reads the same file, but copies
   only gitignored files; ODW copies merely untracked ones too. A line starting
   `symlink:` (**ODW extension**) links what it matches to the source instead
   of copying it — instant for a heavy directory (`symlink: node_modules`), but
   shared: what an agent writes there lands in the source tree. `.git` is never
   copied, and a file over 100 MB is left out with a log line naming it.
2. **`worktreeSetup`** (**ODW extension**; see the adapters reference) runs in
   the agent's workspace — a string through the platform shell, an array as an
   argv — and is killed after `worktreeSetupTimeout` seconds (600 by default).
   A setup that fails or times out fails that agent like a CLI error
   (recoverable: `null` inside `parallel`/`pipeline`), with the end of its
   output in the error.

Each attempt of a call (a schema retry, a stall restart) gets a fresh worktree,
prepared the same way.

Every agent process — isolated or not — gets three variables (**ODW
extension**):

| Variable | Value |
| --- | --- |
| `ODW_RUN_ID` | the run's id |
| `ODW_AGENT_ID` | the agent's id, as in its events and `odw agents` |
| `ODW_PORT` | a port from `portRange` (default 41000–41999) that no other running agent of the run holds — ports something already listens on are passed over — kept until the call settles |

So agents running side by side can each start a server without colliding:

```js
await parallel(['grid', 'list'].map((layout) => () =>
  agent(`Build the ${layout} layout, start the dev server on port $ODW_PORT and check that the page renders.`,
    { isolation: 'worktree', label: layout })))
```

When this run's running agents hold every port of the range, the next one runs
without `ODW_PORT` and the run's log says so: keep `portRange` wider than
`concurrency`. The worktree setup gets the same three variables; `exec()`
commands get `ODW_RUN_ID`.

## What an isolated agent changed (ODW extension)

Before an isolated agent's worktree is removed, ODW keeps its change: everything
that differs from the commit it started from — edits, new, deleted, renamed and
binary files, staged, committed or not — as a unified diff in the run directory
(`agents/<agentId>.diff`), with `changes: { files, insertions, deletions,
truncated }` on its `agent_finished` event (or `agent_failed`: a failed agent
keeps its work too) and its saved result. What `.worktreeinclude` placed and
`worktreeSetup` produced is left out unless the agent changed it afterwards; git
ignored files never count, and symlinks are never followed. An agent that changed
nothing keeps no diff; a stopped run keeps none.

```bash
odw diff <run> --stat                    # per agent: files, +/- lines, kept branch
odw diff <run> --agent <id|label>        # one agent's diff, verbatim
odw apply <run> --agent <id|label> --check
odw apply <run> --agent <id|label>       # git apply --3way into the working tree you are in
```

`odw apply` stages what applies and leaves conflict markers where a hunk clashes
(exit 1); it refuses while a path the diff touches has uncommitted changes, unless
`--force`. Several agents that changed different files apply one after another.
A diff past `maxDiffBytes` (default 2 MB) keeps its head and ends with a
`# odw: diff truncated …` line; its counts still describe the whole change, and
`odw apply` refuses it — use the agent's branch (`keep: true`, or
`keepBranches`). Each attempt of a call works in a fresh worktree: a schema retry
that only reformats its reply keeps the earlier attempt's change, while a stall
restart, a rate-limit retry or an `expect` retry redoes the work, so its change
replaces the earlier one. `odw resume` copies a replayed agent's diff into the new run.

## expect (ODW extension)

```js
agent(prompt, { expect: { changes?, files?, command?, match?, timeout? }, expectRetries?, allowEmpty? })
```

What must hold once the agent has replied — checked by odw, instead of asking
the model whether it did the work. Prefer it to a second "did you do it?" agent:

- **changes** — `true`: the agent must change some file; `false`: it must change
  none.
- **files** — globs relative to the agent's workspace (`*`, `**`, `?`, `[…]`,
  `{a,b}`): each must match a file the agent changed or created (a deletion does
  not count).
- **command** — must exit 0, run in the agent's workspace: a string through the
  shell, an array as argv. Killed after `timeout` seconds (default 600), which is
  a miss. It runs as an `exec()` step under the agent — its `command_*` events
  carry `forAgentId` — after the change is read, so what it writes is never the
  agent's work; a stop kills it.
- **match** — a regular expression (its source, no flags) the reply must match.

The checks run once the reply is in and has satisfied its `schema`. What the
agent changed is read from git. In place, it is what differs from the source
tree as it was before the agent's first CLI run: your own uncommitted edits and
the run's directory are left out, the agent's commits count — and so do edits
another in-place agent makes meanwhile, so isolate agents whose changes must be
told apart. `expect.changes` or `expect.files` in place needs a git repository
(else the call fails before its CLI starts). With `isolation: "worktree"`, it is
exactly the change the run keeps as the agent's diff; a schema retry that only
reformats is judged on the attempt that did the work.

Work that misses runs again — `expectRetries` times (default 1, or the
`expectRetries` setting) — with what it missed appended to its prompt, a failed
command's output included; an isolated retry starts over in a fresh worktree.
Each retry is logged, and the transcript marks it `{"kind":"attempt","reason":"expect"}`.
If the work still misses, the call throws (recoverable) with `reason:
"unmet_expectation"` and `misses` — one line per check — on the error and on its
`agent_failed` event:

```js
try {
  await agent('Fix the flaky date test.', { expect: { command: ['npm', 'test', '--', 'dates'], changes: true } })
} catch (err) {
  if (err.reason !== 'unmet_expectation') throw err
  log(`not fixed: ${err.misses.join('; ')}`)   // "`npm test -- dates` must exit 0, and it exited with code 1"
}
```

Typed without opting in: an empty or whitespace-only reply throws with reason
`"empty_reply"` unless `allowEmpty: true`; a reply that claims success while the
CLI refused tool calls — Claude Code's `permission_denials`, read through the
adapter's `output.deniedPath` — throws with reason `"permission"`, naming them.
Neither is retried. `expect` is part of the call's resume key; Claude Code
ignores it, so there the checks do not run.

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

Object and array constraints need their explicit `type`. Annotations —
`description`, `title`, `default`, `examples`, `format`, `$comment`, `$schema` —
constrain nothing and are fine anywhere (`format` is an annotation by default since
JSON Schema 2019-09; Claude Code does not enforce it either).

**Nothing outside the subset goes silently unchecked (ODW extension).** Before the
agent starts, its schema is checked for anything the validator would not enforce:
keywords such as `const`, `$ref`, `oneOf`/`anyOf`/`allOf`, `minimum`/`maximum`,
`pattern` and `maxItems`, schema-valued `additionalProperties`, tuple or boolean
schemas, type unions like `["string", "null"]`, and an object or array keyword
without its `type`. The config's `schemaKeywords` decides what happens:

- `"warn"` (the default) — the call runs and ODW validates the rest; the run's log
  says once which keywords it does not check and where (`"pattern" at
  #/properties/id`), and who enforces them: a CLI that validates schemas itself
  (it got the whole schema), otherwise nobody.
- `"strict"` — the call fails with an `AgentError` naming each one, before anything
  is spawned.

A typo (`requird`, an unknown `type`) or another malformed schema fails the call in
either mode, with a did-you-mean. To make a limit count everywhere, put it in a
`description` (the agent still reads it) and check it in the workflow.

**Native schemas (ODW extension).** A CLI that validates schemas itself is handed
the whole schema as well — `claude` with `--json-schema` (its value comes from
`structured_output`), `codex` with `--output-schema` when the schema is strict (an
object at the root; every object `"additionalProperties": false` and all its
properties `required`) — and it enforces what ODW does not check; ODW still
validates every reply and retries as usual. The prompt describes the schema only to
a CLI that does not take it (`"schemaPrompt": "always"` describes it everywhere).
See [adapters](adapters.md#native-structured-output).

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
  default; set `concurrency` in config). Excess calls queue. An adapter's own
  `concurrency` caps its agents inside that, a rate limit halves it for the run,
  and a fan-out on `claude` whose prompts share a long prefix starts staggered
  (ODW extensions; see `references/adapters.md`).
- **Total-agent backstop** — a hard ceiling on dispatches per run (default
  1000). Exceeding it aborts the run, so a buggy loop cannot fan out forever.
- `exec()` commands count toward neither limit; each is bounded by its own
  `timeout` and `maxOutputBytes`.
- A waiting `checkpoint()` counts toward neither limit either; its own
  `timeout`, if any, bounds the wait.
