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
- **opts.sandbox** (**ODW extension**) — run this agent's CLI in a container, or a
  stricter one than its run's and adapter's: `"container"`, or `{ network: "none"
  | { allow: [...] }, memory, cpus, pids, cliConfig: "none", image }` (`image` only
  where nothing else sets one; an `allow` list meets the sandbox's own). It may only tighten — `"none"` under a container, a network the
  sandbox has not, a higher limit or another image fails the call before it
  starts. See [adapters](adapters.md#container-sandbox-odw-extension). Not part of
  the resume key. Claude Code ignores it.
- **opts.limits** (**ODW extension**) — what this agent may do before it is killed
  as a runaway: `{ toolCalls?, costUsd?, outputTokens?, seconds?, repeat? }` —
  tool calls over all its CLI runs, dollars and output tokens its CLIs reported,
  seconds since its first CLI run, and the same tool call (name + argument hash)
  `repeat` times **in a row**. Over its adapter's and the run's `agentLimits`
  key by key; `null` lifts one. Enforced live from claude, codex, kilo and
  opencode output (a text CLI's spend only after each run); a breach kills the
  CLI at once and throws — recoverable — with `reason: "runaway"` and
  `limitHit: { limit, max, value, evidence }` on its event (``Bash `npm test`
  ×5 in a row``). Never retried, never an `expect` miss. A malformed value
  throws an `AgentError` before anything runs. Not part of the resume key.
  Claude Code ignores it.
- **opts.expect** (**ODW extension**) — what must hold once the agent has
  replied, checked by odw: `{ changes?, files?, command?, match?, timeout? }`. See
  [expect](#expect-odw-extension). Claude Code ignores it.
- **opts.expectRetries** (**ODW extension**) — how many times work that missed
  `expect` runs again, told what it missed (default: the `expectRetries`
  setting, 1).
- **opts.allowEmpty** (**ODW extension**) — accept an empty or whitespace-only
  reply as the answer. Without it, an empty reply fails the call with reason
  `"empty_reply"`. (Tool calls the CLI refused do not fail a call by default:
  they are recorded as `denied` — see [expect](#expect-odw-extension).)
- **opts.notes** (**ODW extension**) — `true`: the agent gets the run's notes
  board (its prompt shows the notes so far, `ODW_NOTES` posts and reads them,
  and an isolated agent's kept change is broadcast as it finishes); `false`
  opts it out of its `parallel()`'s or the `notes` setting. See
  [notes](#notes-odw-extension). Claude Code ignores it.
- **opts.memory** (**ODW extension**) — `true`: the agent gets the workflow's
  memory that still applies ahead of its task, and an `expect` miss a retry of it
  met is kept as a lesson; `false` opts it out of the `memory` setting. See
  [memory](#memory-odw-extension). Claude Code ignores it.
- **opts.handoff** (**ODW extension**) — `true`: when a fallback moves the
  call to the next adapter, it hands the work over instead of starting it
  over; `false` starts over whatever the `fallback.handoff` setting says. See
  [routing](#routing-phase-defaults-model-tiers-fallback-chains-odw-extension).
  Claude Code ignores it.
- **opts.scope** (**ODW extension**) — globs (relative to the workspace, the
  `expect.files` rules) of the files the agent means to change: a call whose
  scope overlaps an earlier one still in flight waits for it; what it changes
  outside is recorded as `outOfScope`. See [scope](#scope-odw-extension).
  Claude Code ignores it.
- **opts.scopePolicy** (**ODW extension**) — `"warn"` (default: the
  `scopePolicy` setting) or `"fail"`: what a write outside `scope` does. Needs
  `scope`.
- **opts.questions** (**ODW extension**) — what a question the agent stops to
  ask the user (its CLI's clarifying tool call: Claude Code's `AskUserQuestion`)
  does. The CLI is stopped at the question either way. `"checkpoint"` (default:
  the adapter's, else the `questions` setting) asks a person at a checkpoint
  (`checkpoint_requested` carries `question: { agentId, label, adapter,
  questions }`) and runs the call again — in the same worktree when isolated —
  its prompt told "Earlier in this task you stopped to ask the user: … The user
  answered: …" (the approval's note, else an edited payload's `answer`); a
  rejection, or a fourth question, throws with reason `needs_input`. `"fail"`
  throws with reason `needs_input` at once; `"deny"` runs the CLI without its
  question tool (the adapter's `questionArgs`) and tells the agent to assume.
  A `needs_input` failure carries the questions (`agent_failed`'s `questions`).
  Claude Code ignores it.

Returns the reply text, or the validated JSON value when `schema` is set. CLI
errors, exhausted schema retries, work that missed its `expect` checks and an
empty reply throw. Inside `parallel`/`pipeline`, these recoverable failures
become `null`. Fatal errors — stop requests, exhausted budgets, the total-agent
cap, and invalid adapter/run configuration — propagate and terminate the run.
A failed CLI run's error carries `reason` (`rate_limit`, `quota`, `auth`,
`timeout`, `stalled`, `not_found`, `permission`, `exit`, `empty_reply`,
`unmet_expectation` or `needs_input`), the same as its `agent_failed` event — branch on it in a
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

**ODW extension:** `parallel(thunks, { notes: true })` turns the run's notes
board on for every agent its thunks start (an agent's own `notes: false` wins);
`notes` and `costGate` are the only options, anything else throws. See [notes](#notes-odw-extension).
Claude Code's `parallel()` takes only the thunks.

**ODW extension — cost forecast and `costGate`.** Before a `parallel()` or
`pipeline()` at least `fanOutWarn` wide, or one a cost gate covers, the run logs a
forecast from earlier finished runs of the same workflow (the same source when
there are any, else the same name): width × the median cost of that phase's agents,
with the p90 (`cost forecast: parallel() of 40 tasks in phase "Review" ~$12.40
(p90 $18.00) — …`; a `pipeline()` counts items × stages agents). With a gate —
the `costGate` setting `{ usd }`, or `parallel(thunks, { costGate: { usd } })`
(`costGate: null` lifts the setting for one call) — a forecast over `usd` becomes
`checkpoint("This fan-out is forecast to cost ~$X (p90 $Y) — go?", { payload: {
width, forecast } })` before any of its agents start. Approved, it runs; rejected,
the call throws a recoverable `CostGateRejected` (`e.name`; `e.forecast`) that the
script may catch. `agent(prompt, { costGate: { usd } })` gates one agent, by the
agents of its phase with its label prefix (`review-3` → `review`), else the phase's;
a resume that replays it does not ask. Without history the gate lets everything
through and logs that once per run.

```js
try {
  await parallel(files.map((f) => () => agent(`Review ${f}`)), { costGate: { usd: 5 } })
} catch (e) {
  if (e.name !== 'CostGateRejected') throw e
  log('review skipped: ' + e.message)
}
```

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
  setting for the adapter a call runs on: when its CLI's quota is spent, its
  login is refused, or the model it asks for is unavailable (`model_unavailable`:
  unknown to the CLI, retired, or not offered to the account), the call runs again
  on the next adapter — a fresh prompt,
  the same options, its [`expect`](#expect-odw-extension) checks included. A
  rate limit is retried in place (`transientRetries`); any other failure — an
  unmet expectation too — is the call's. Each move is a log line
  (`search:3 → claude after codex quota`); the call takes a slot on its new
  adapter, letting the old one's go first; its transcript goes on after an
  `{"kind":"attempt","reason":"fallback","adapter":"claude"}` line; and what
  the failed runs spent still counts. A fallback runs at the call's own
  permission tier — an adapter that cannot run exactly that tier is skipped,
  with a log line. `agent_finished` and the saved result name the adapter that
  produced the value (`adapter`) and the ones left (`fellBackFrom`);
  `agent_failed` names them too when the call fell back.
- **Handoff.** With `"fallback": { "handoff": true }` or `handoff: true` on
  the call (off by default), a fallback hands the work over instead of
  starting it over: an isolated call's worktree is kept and the next adapter
  runs in it, partial edits in place (an in-place call's are in the source
  tree already), and its prompt starts, ahead of the task, with a brief headed
  "You are continuing work another agent started…" — why the last adapter
  stopped, the files it changed (diff stat; in place, its edit tool calls),
  its last plan or to-do list, the commands it ran and how they ended, its
  last messages; at most 6 KB, each piece redacted before any cut. The next
  adapter keeps the worktree for each of its runs (stall restarts, rate-limit
  and schema retries); a fallback with other trust or another container engine
  gets a fresh one instead, and a brief saying the work was not carried over.
  The brief is kept as
  `agents/<id>.handoff.md`, told by a `handoff` event `{ from, to, reason,
  bytes }` and a `{"kind":"handoff"}` transcript line. `expect` and the kept
  diff judge the final state (the shared worktree against its base); an
  `expect` retry, and a call after a `quotaWait`, still start over. `handoff`
  is not part of the resume key.
- **Quota breaker.** After `quotaBreaker` (default 3) quota failures in a row
  on one adapter, the run's later calls skip it: each starts on the next
  adapter of its chain, or fails at once (reason `quota`) without one. One
  warning says so.
- **Accounts** (ODW extension). With the user's `accounts` config, each login
  is an adapter `<adapter>@<name>` (`claude@work`) with its own config dir,
  concurrency cap and quota breaker. `adapter: "claude"` (or the default
  adapter, or a chain naming it) then means any claude account: a chain of
  the accounts by headroom — not in a quota pause first, then fewest quota
  failures this run, then fewest agents routed to it and not yet finished —
  with handoff on unless the call says `handoff: false`.
  `adapter: "claude@work"` runs on that account alone. Events, `odw status`
  and the dashboard name the account.
- **Pause for a spent quota.** With the `quotaWait` setting (`{ "max":
  <seconds> }`; off by default), a call with no adapter left on a spent quota
  does not fail: it waits, holding no slot, for the reset its CLI named — when
  that is within `max` — then starts over from its chain's start, its
  transcript going on after an `{"kind":"attempt","reason":"quota_wait"}` line.
  Until that reset the run passes over the adapter, and a call with nowhere
  else to go waits before it is dispatched. Your `agent()` call just takes
  longer to return; a quota that names no reset, or one past `max`, fails it
  with reason `quota` as above.

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
A run started on another machine with `odw run … --on ssh://host` (ODW
extension) gets the same `args` and `budget.total`: `--args` is parsed here
and sent as a file, and the script runs from the project's copy there.
`spent()` is the output tokens spent so far across this run, nested workflows
included: the CLI's own count wherever its adapter reports usage (the built-in
`claude` and `codex` do — an ODW extension), else `ceil(reply characters / 4)` for that
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

### workflow.input (ODW extension)

```js
workflow.input -> { untrusted, args, why, quote(text, label?) }   // undefined on Claude Code
```

Whether the run's `args` came from someone who is not the user: a trigger's run
(unless `"untrusted": false`) or `odw run --untrusted-input`. `args` lists the
keys that hold such text (`["*"]`: all of them), `why` says what marked it
(`trigger:<name>`, `--untrusted-input`; `null` when trusted). `quote(text, label?)`
returns `text` in a fenced `<untrusted-data id="…">` block — the fence carries a
digest of the text, so the text cannot close it — followed by a line saying it
is data, not instructions. Read it as `workflow.input?.untrusted` in a script
that must also run on Claude Code. Such a run's agents are read-only unless the
run's permissions were given, and the first agent that may write waits at a
checkpoint; when it is rejected, that agent and every later one that may write
throw `UntrustedInputRejected` (recoverable: catch it, or `parallel` makes it `null`).

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
- **opts.network** (**ODW extension**) — in a run whose `sandbox` is a container,
  the step runs in a fresh container of the run's image, with the run's source
  (and its `cwd`) bound at the same path and the agents' environment; its network
  is `"none"` unless it asks for `"default"` (refused when the sandbox has none) —
  the run's network, an egress allowlist included (its `"adapter"` entry aside).
  No effect outside a sandbox.

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
checkpoint(title, opts?) -> Promise<{ approved, note, by, payload, edited }>
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
- **opts.schema** — a JSON Schema an edited payload must match (below), checked
  by the same validator as `agent()`'s replies. It is audited like one: a
  malformed schema is a misuse; keywords the validator does not check are
  logged (`schemaKeywords: "warn"`) or refused (`"strict"`). Without a schema
  any JSON value is accepted as an edit.
- **opts.timeout** — seconds to wait; no limit by default.
- **opts.onTimeout** — what silence means: `"approve"` or `"reject"` resolve
  with `by: "timeout"`; `"fail"` (the default) throws a `CheckpointTimeout` —
  recoverable, like a failed agent: catch it, or let `parallel`/`pipeline` turn
  it into `null`.
- **opts.memory** — `true` or `{ paths: [globs] }`: a rejection with a note, or
  an approval with an edit, is kept as a `correction` in the workflow's memory
  once the run ends (stale once files `paths` match change); `false`: never.
  Default: the `memory` setting. See [memory](#memory-odw-extension).

The call resolves to `{ approved, note, by, payload, edited }`: `note` is the
person's note or `null`; `by` is `"cli"` (`odw approve|reject`), `"dashboard"`
(`odw serve`), `"link"` (a signed one-time approve link from a `waiting` notify hook,
answered through `odw serve --public-url`; ODW extension) or `"timeout"`. A rejection is an answer, not an error: the script
decides what it means — stop, re-plan with the note, skip a step.
**ODW extension:** `who`, when known, names the person beside the channel —
`"cli:<$USER> <git user.email>"` from `odw approve|reject`, a named token's name
(`odw serve --tokens FILE`) from the dashboard or beside an approve link; absent
otherwise (the timeout, an unnamed `--token`).

The person may approve an **edited** payload instead of rejecting and re-running
(as with Claude Code's plan approval): `odw approve <run> --edit` opens
`$VISUAL`/`$EDITOR` on it, `--payload '<json>'` / `--payload @file.json` sends one,
and the dashboard posts `payload` with `action: "approve"`. `payload` is then what
was approved — the edit, or else the checkpoint's own payload as given (undefined
when it had none) — and `edited` is `true` only when the edit differs from the
original as JSON. A rejection and a timeout carry the original. An edit must be
JSON of at most 256 KiB matching `opts.schema` when given: the CLI and the API
refuse others with the validator's errors, and the run drops one written to its
decision log by hand with a log line, still waiting. So read the approved value
from the result, not from your own variable, and give a `schema` when the code
after the checkpoint relies on the payload's shape.

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
`checkpoint_requested { checkpointId, title, payload, schema?, phase }`, then exactly one
`checkpoint_resolved { checkpointId, approved, note, by }` (with `edited: true` and
the edited `payload`, cut to 64 KiB, for an approval with edits; with an `error`,
and `by: null`, when the run ended first). `odw resume` never replays a checkpoint:
the resumed run asks again.

```js
phase('Plan')
const draft = await agent(`Plan this as independent steps: ${task}`, { schema: PLAN })
phase('Approve')
const { approved, note, payload: plan } = await checkpoint(`Run this ${draft.steps.length}-step plan?`, {
  payload: draft,
  schema: PLAN, // an edited plan must still be a plan
  timeout: 3600,
  onTimeout: 'reject', // nobody answered within the hour: change nothing
})
if (!approved) return { approved, note, plan }
phase('Execute')
await parallel(plan.steps.map((step) => () => agent(step.instructions))) // the plan as approved
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

Its counterpart, **`worktreeTeardown`** (**ODW extension**), runs in the same
workspace with the same variables just before the worktree is removed — after
the agent finished, failed or was stopped — killed after
`worktreeTeardownTimeout` seconds (120 by default). Its failure is logged; the
agent's result stands.

Each attempt of a call (a schema retry, a stall restart) gets a fresh worktree,
prepared the same way.

Every agent process — isolated or not — gets three variables, an isolated one a fourth (**ODW
extension**):

| Variable | Value |
| --- | --- |
| `ODW_RUN_ID` | the run's id |
| `ODW_AGENT_ID` | the agent's id, as in its events and `odw agents` |
| `ODW_PORT` | a port from `portRange` (default 41000–41999) that no other running agent of the run holds — ports something already listens on are passed over — kept until the call settles |
| `ODW_SLOT` | isolated agents only: `odw-<run>-<agent>` (the run id's random part, the agent id; lowercase letters, digits, hyphens), the same for every attempt, setup and teardown of the call. `COMPOSE_PROJECT_NAME` defaults to it unless already set — a compose stack, database or volume prefix per agent |

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
odw apply <run> --agent <id|label> --check   # preview only
odw apply <run> --agent <id|label>       # git apply --3way into the working tree you are in
odw apply <run> --all [--check]          # every finished agent, in agentId order
odw apply <run> --agent <id|label> --verify "<cmd>"   # roll the apply back if <cmd> fails
odw apply <run> --all --resolve [--adapter A] [--confirm] --verify "<cmd>"   # a resolver agent fixes conflicts
odw apply <run> --all --pr [--base B] [--remote R] [--ready] [--title T]   # a branch, pushed, and a draft PR
odw review [--json] [--since 7d] [--all]  # ODW extension: kept diffs across runs not dealt with, riskiest first
odw review mark <run> <id|label> reviewed|dismissed|applied|open [--note TEXT]
```

`odw review` scores each kept diff from recorded data only and lists every
factor (`{ key, points, why }`): 0–2 low, 3–5 medium, 6+ high. Marks are lines
of the run's append-only `reviews.jsonl` — `{ ts, agentId, state, by, via,
note? }`, the last per agent standing; `odw apply` adds `applied` (`via:
"apply"`) for each agent it applied cleanly. Runs of `odw eval` and resolver
runs are left out.

Before it touches the tree, `odw apply` runs the same apply against a scratch
copy of the index and prints each file as `clean`, `CONFLICT` (with the
conflicting lines as the merge would leave them, or why it cannot be merged:
`deleted here`, `binary: …`, an untracked or ignored file in the way) or
`already applied` (left out of the apply);
`--check` stops there, exit 1 on a conflict. It stages what applies and leaves
conflict markers where a hunk clashes (exit 1); it refuses while a path the diff
touches has uncommitted changes, unless `--force`. `--all` previews every
finished agent stacked in agentId order (one that would conflict is left out of
the stack) and applies them up to the first that would conflict; a failed
agent's diff goes in only by `--agent`. `--verify "<cmd>"`, or the
`applyVerify` setting (`--no-verify` skips it), runs `<cmd>` at the repository
root after each apply, within `timeout`; when it fails or times out, that apply
is rolled back exactly — the touched paths' content and index entries, nothing
else — and odw exits 1 with the end of its output (a signal rolls it back too,
then ends odw). A change that would conflict is not applied under `--verify`.
`--resolve` (ODW extension) hands such a change to a resolver agent instead: a
run of its own (`origin: "apply-resolve"`, `applyResolve: { runId, agentId }` in
its meta.json; the run applied gets `resolvedBy` and an `apply_resolved` event)
in a temporary worktree at HEAD + the index + the agent's clean files, told the
base, both sides and the conflicting lines of each file. Its change is applied
with the agent's clean files only when it edits just the conflicting files,
leaves no conflict markers and passes `<cmd>` in that worktree (`--confirm`: y/N
at a terminal first); otherwise the tree is unchanged and odw says why. Only
text conflicts are resolved; never with `--force` or `--check`.
`--pr` (ODW extension) leaves the working tree alone — never read or written —
and makes a branch `odw/<run>-<label>` (`odw/<run>-all`; `-2`, … when taken) from
`--base` or HEAD in a temporary worktree, applies (and verifies) each agent there
as above, commits each on its own under the user's git identity (workflow,
agent, diff stat, run id, cost), pushes to `--remote` (`origin`) and runs `gh pr
create --repo <that remote's owner/name>` — a draft unless `--ready` — with the run summary as the body (agents
and commits, phases, spend, verify result, `odw diff` commands). A conflict or a
failed verify deletes the branch before the push; without `gh` (or logged out)
it prints the compare URL after the push. It never merges; not with `--check`,
`--force` or `--resolve`. `examples/pr-shepherd.js` keeps a PR green afterwards:
red CI and new review comments go to an `expect`-checked fixer, its fix is pushed
to the PR branch, and a `checkpoint()` comes before `gh pr ready`.
A diff past `maxDiffBytes` (default 2 MB) keeps its head and ends with a
`# odw: diff truncated …` line; its counts still describe the whole change, and
`odw apply` refuses it (`--all` stops there) — use the agent's branch
(`keep: true`, or `keepBranches`). Each attempt of a call works in a fresh worktree: a schema retry
that only reformats its reply keeps the earlier attempt's change, while a stall
restart, a rate-limit retry or an `expect` retry redoes the work, so its change
replaces the earlier one. `odw resume` copies a replayed agent's diff into the new run.

## expect (ODW extension)

```js
agent(prompt, { expect: { changes?, files?, command?, match?, mcp?, untouched?, timeout? }, expectRetries?, allowEmpty? })
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
- **mcp** — MCP server names: each must be among the servers the agent's CLI
  says it started the agent with (Claude Code's stream-json init event, read
  through the adapter's `output.mcpPath`), `connected` — or `pending`, which
  Claude Code's docs say is no failure on its own (a server still connecting in
  the background, or one with a cached tool list it connects on first use).
  `failed`, `needs-auth`, `disabled` or not configured is a miss. An adapter that
  declares no `mcpPath` cannot be checked: the call fails before its CLI starts.
- **untouched** — globs, as `files`, that no file the agent changed, created or
  deleted may match: the tests, snapshots and CI config it must not edit, skip
  or delete to get green (`['test/**', '**/*.snap', '.github/**']`; `*` stays
  within a directory). A touched path is a miss naming it — `no file matching
  "test/**" may change, and 1 did: test/add.test.js` — and the retry is told to
  restore it. Read from git like `changes`.

The checks run once the reply is in and has satisfied its `schema`. What the
agent changed is read from git. In place, it is what differs from the source
tree as it was before the agent's first CLI run: your own uncommitted edits and
the run's directory are left out, the agent's commits count — and so do edits
another in-place agent makes meanwhile, so isolate agents whose changes must be
told apart. `expect.changes`, `expect.files` or `expect.untouched` in place needs a git repository
(else the call fails before its CLI starts). With `isolation: "worktree"`, it is
exactly the change the run keeps as the agent's diff; a schema retry that only
reformats is judged on the attempt that did the work.

Work that misses runs again — `expectRetries` times (default 1, or the
`expectRetries` setting) — with what it missed appended to its prompt, a failed
command's output included; an isolated retry starts over in a fresh worktree.
Each retry is logged, and the transcript marks it `{"kind":"attempt","reason":"expect"}`.
A retry runs on the adapter whose work missed: a miss never falls back. A call
that falls back (a spent quota, a refused login) keeps its `expect`, and the
next adapter starts the work over with its own retries — isolated, in a fresh
worktree; in place, judged against the tree as it was before the call's first
CLI run. If the work still misses, the call throws (recoverable) with `reason:
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

Tool calls the CLI refused — Claude Code's `permission_denials`, read through the
adapter's `output.deniedPath` — count as a miss: the retry is told which, and a
call still refused after its retries throws with reason `"permission"`, its
`misses` listing the refusal and anything else the work missed.

So does background work the CLI left running when it replied — a shell command
started with `run_in_background` or a subagent, still open at Claude Code's
`result` event (its stream-json task events, read through the adapter's
`output.background`), which died as the CLI exited: the retry is told to wait
for every background command and subagent before replying, and a call that
still leaves some throws with reason `"orphaned_background"`.

Without `expect`: an empty or whitespace-only reply throws with reason
`"empty_reply"` unless `allowEmpty: true`. A reply that claims success while the
CLI refused tool calls stands — they are kept as `denied` on the agent's
`agent_finished` event and saved result, and the run logs one line — unless
`"permissionDenials": "fail"` (run-wide, or in the adapter's entry), which throws
with reason `"permission"`, naming them. MCP servers its CLI started it without —
any status but `connected` — are kept as `mcp: [{ name, status }]` on the agent's
terminal event and saved result, and the run logs each server and status once
(``MCP server github failed to start (claude agent `fix-auth`): its tools were
unavailable``); `"mcpFailures": "fail"` throws for a server that `failed` or
`needs-auth` with reason `"mcp_unavailable"` (one `expect.mcp` lists is a miss
instead). Background work its CLI left running when it replied is kept as
`orphaned` on the agent's `agent_finished` event and saved result, and the run
logs one line per agent (`serve:1: Claude Code ended its turn with 1 background
task still running — Bash (Start the dev server); …`);
`"orphanedBackground": "fail"` throws with reason `"orphaned_background"`
instead. None of these failures is retried. `expect` is
part of the call's resume key; Claude Code ignores it, so there the checks do not
run.

## notes (ODW extension)

```js
agent(prompt, { notes: true })                 // this agent
parallel(thunks, { notes: true })              // every agent its thunks start
// odw.config.json: "notes": true              // every agent of the run
```

A run-scoped board where parallel agents tell each other what the others must
know — an interface they changed, a decision — so changes that pass alone do not
break together. Off by default (dialect fidelity); `notes: false` opts one agent out.

- **Posting.** An agent with notes on gets `ODW_NOTES`, the path of a POSIX shell
  script of its own: `"$ODW_NOTES" "renamed parseX → parse"` posts a note,
  `"$ODW_NOTES"` alone prints the board. `odw note "…"` does the same (it needs the
  agent's `ODW_RUN_ID` and `ODW_AGENT_ID`). Its prompt says so.
- **Reading.** The notes posted before an agent started are appended to its
  prompt — "Notes from the other agents in this run:", `#<n> [agent <id> · <label>]
  <text>`, the latest that fit 8000 characters. New notes are not pushed into a
  running agent (a CLI takes its prompt once); it can run `"$ODW_NOTES"` again.
- **Interface broadcast.** An isolated (`isolation: "worktree"`) agent with notes
  on that kept a change has a `kind: "interface"` note posted for it before its
  `agent_finished` event: its diff stat, the files it touched, and the diff lines
  it added (`+`) or removed (`-`) that look like declarations — `export`, `def`,
  `func`, `pub fn`, `class`, `interface` — at most 12. Agents the script starts
  after it see it in their prompt.
- **Bounds.** A note is cut at 2000 characters and redacted; the board holds 200
  notes and 256 KiB (later notes are dropped and the run logs it once).
- **Where.** `notes.jsonl` in the run directory; each note is a `note_added`
  event too. `odw notes <run> [--json]` prints it; `GET /api/runs/:id/notes`
  serves `[{ noteId, ts, by: { agentId, label }, text, kind, truncated?, redacted? }]`.
- **Containers.** Under a container sandbox the agent's inbox is bound
  read-write, its script and the board read-only, at the same paths: the script
  works there. The worker takes only regular files from the inbox, never
  following a link.
- **Not persisted, no board.** An in-process run without a run directory logs
  once that its agents run without one. A call replayed by `odw resume` posts
  nothing. `notes` is not part of the resume key.
- **Keeping a note.** `"$ODW_NOTES" --keep "…"` or `odw note --keep [--paths
  GLOB,…] "…"` posts a note marked `keep` that becomes workflow memory when the
  run ends — see [memory](#memory-odw-extension). Only an agent with memory on is
  told of `--keep` and has its notes kept; from one without, the note is posted
  unkept and the run says so.

## memory (ODW extension)

```js
agent(prompt, { memory: true })                          // recall; keep its met expect misses
checkpoint(title, { memory: true })                      // keep its corrections
checkpoint(title, { memory: { paths: ['src/api/**'] } }) // …stale once those files change
// odw.config.json: "memory": true                       // every agent and checkpoint
```

What earlier runs of a workflow learned, kept in the repository as
`.odw/memory/<workflow>.jsonl` (reviewable in PRs). One JSON object per line:
`{ id, text, kind: "note"|"correction"|"lesson", paths: [globs], commit, run, agent?, at }`.

- **Sources — explicit only, no model summarizing.** A note kept with `--keep`
  (`note`, from an agent with memory on); a checkpoint rejected with a note (`correction`,
  `"<title>" was rejected: <note>`) or approved with an edited payload
  (`correction`, a structural diff: `$.steps[1]: "b" → "c"; removed $.owner`); an
  `expect` miss a retry of the same agent then met (`lesson`, `"<label>": <miss> —
  it was fixed by a retry told what was missing (…)`); `odw memory add`.
  Every entry only where memory is on (the call's `memory`, else the
  setting). Cost-gate and `--break` checkpoints never write memory.
- **Recall.** An agent with memory on gets, ahead of its task, the entries that
  still apply under "## What earlier runs of this workflow learned", newest first,
  at most 4 KB, each labelled with its kind and origin (run and agent, or "by
  hand") and its text quoted (`> ` on every line); the run logs how many it
  recalled, how many were stale, and how many did not fit. Read once per run.
- **Staleness.** An entry with `paths` is stale once a file they match (a glob,
  or a directory and all under it) changed between its `commit` and HEAD; one
  whose commit git does not know is stale too. No paths: never stale. At most 32
  distinct commits are checked per file (newest entries first; others count as
  stale); a file over 4 MiB is not read, and that is said.
- **Writing.** Once the run ends (done, failed or stopped), at HEAD as it was when
  each was learned, redacted with the run's redactor; the same kind + text + paths
  replaces the older entry; at most 500 entries, the oldest pruned with a log
  line. `odw test` and `--dry` runs keep nothing. A run that is not persisted has
  no memory and says so once.
- **Untrusted runs** neither recall nor keep the repository's memory (its content
  is the repository's, and what such a run learned would reach trusted runs'
  prompts). `memoryDir` set in your own config to a directory outside the
  repository (as written and with links resolved) is yours: an untrusted run
  uses it. A `memoryDir` the repository's own config sets never is.
- **CLI.** `odw memory list [<wf>] [--stale] [--json]`, `odw memory add <wf> "text"
  [--paths G,…] [--kind …]`, `odw memory prune [<wf>] --stale | <wf> --id N`
  (`--source DIR`, `--config FILE`). `GET /api/memory[?workflow=]` serves the list.
- `memory` is not part of the resume key; a replayed call learns nothing.

## scope (ODW extension)

```js
agent(prompt, { scope: ['src/parser/**', 'docs/parser.md'] })   // the files it means to change
agent(prompt, { scope: [...], scopePolicy: 'fail' })              // a write outside fails it
// odw.config.json: "scopePolicy": "fail"                        // for every scoped call
```

Declared scopes keep agents that work on one codebase at the same time off each
other's files — an advisory plan, not a sandbox.

- **Globs.** Non-empty, relative to the agent's workspace, with the `expect.files`
  rules (`*`, `**`, `?`, `[…]`, `{a,b}`, `\` escapes). `scope: []`, an absolute
  path, an invalid glob, or `scopePolicy` without `scope` throws a recoverable
  `AgentError` before anything starts.
- **Scheduling.** A scoped call made while an earlier scoped call whose scope
  overlaps has not settled waits for it before it asks for a slot (holding none),
  then runs; it waits only for calls made before it. Calls without `scope` overlap
  nothing. The run logs each wait once — `"fix-auth waits for refactor-login: both
  declare src/auth/**"`, or `"… : fix-auth declares src/auth/token.ts,
  refactor-login src/auth/**"` — a `log` event with `scopeWait: { for: <agentId>,
  globs: [mine, theirs] }`.
- **Overlap** is decided from the globs, conservatively: `{a,b}` expanded; two
  literal paths overlap when equal; a literal path and a glob when the glob
  matches it; two globs when one's literal prefix (before its first wildcard)
  starts with the other's — `src/auth/**` ~ `src/auth/*.ts`, `src/auth/**` !~
  `src/db/**`, `src/*.ts` ~ `src/*.md`, `**` ~ everything.
- **Out-of-scope writes.** Once the reply is in, the agent's change (as `expect`
  reads it: an isolated worktree's diff, or in place what changed since the call
  began) is compared with its scope. Files no glob matches are `outOfScope` on its
  `agent_finished`/`agent_failed` event and saved record, logged
  (`"fixer:1: wrote 1 file outside its scope (src/auth/**) — package.json"`), shown
  by `odw agents` and the dashboard, and — with notes on — posted to the board as a
  `kind: "scope"` note.
- **Policy.** `"warn"` (default) keeps the reply. `"fail"` fails the agent with
  reason `"out_of_scope"`, not retried. With `expect`, a write outside the scope is
  a miss whatever the policy: retried with what it missed, then
  `"unmet_expectation"`.
- **In place**, a file inside the scope of another scoped call that ran at the same
  time is not counted against this one; edits of unscoped calls beside it are.
  Outside a git repository the change cannot be read: logged, not checked.
- **Events.** `agent_started` carries `scope`. `scope` and `scopePolicy` are not
  part of the resume key; a replayed call waits for nobody and keeps its recorded
  `outOfScope`.

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
properties `required`), `agy` with `--json-schema` when its root is an object (its
value comes from `structured_output`) — and it enforces what ODW does not check; ODW still
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

## odw eval (ODW extension)

`odw eval` runs one workflow over a set of cases, on one or more adapters,
several times each, judges every run with checks that need no model, and
reports pass rate, cost and latency per case × adapter. It is an ODW
extension: Claude Code has no counterpart.

```bash
odw eval <file|name> [--adapter a,b] [--repeats N] [--json] [--out report.json]
                     [--baseline report.json] [--config P] [--runs-root DIR]
```

`<name>` is `.odw/evals/<name>.json` in the current directory (tracked by git
like `.odw/workflows/`); anything ending in `.json` or holding a path
separator is a file path. `--adapter` (comma-separated, or repeated) and
`--repeats` override the file's.

### The eval file

```json
{
  "name": "review",
  "description": "optional",
  "workflow": "review",
  "adapters": ["claude", "codex"],
  "repeats": 3,
  "concurrency": 2,
  "budget": 200000,
  "timeout": 900,
  "cases": [
    { "name": "small-diff", "args": { "diff": "…" }, "checks": [{ "state": "done" }] }
  ]
}
```

| Key | Meaning |
| --- | --- |
| `workflow` | required: a workflow name or a script path, resolved exactly like `odw run`'s, from the directory `odw eval` runs in |
| `cases` | required, non-empty: `{ name, args?, checks? }`; names unique, at most 100 characters |
| `adapters` | optional: each runs the whole case set as the run's default adapter (`odw run --adapter`); absent: the config's default adapter, named in the report |
| `repeats` | runs per case per adapter, 1–1000 (default 1) |
| `concurrency` | runs at once, 1–64 (default 1); jobs go in adapter, case, repeat order |
| `budget` | optional: tokens, each run's `--budget` (`budget.total` in the script) |
| `timeout` | optional: seconds a run may take; then it is stopped (`odw stop`) and fails with a `timeout` failure |
| `name` | optional: the eval's name (letters, digits, `.`, `_`, `-`); else the file name without `.json` |
| `description` | optional text, kept in the report |

Any other key, a malformed check, path or regex is a `ConfigError` naming
where it is (`cases[1].checks[0].path: …`), and `odw eval` exits 2 before any
run starts — as it does for an unknown adapter, a workflow that does not
resolve or load, or a baseline that is not a report.

### Checks

A check is an object with exactly one of these shapes. A run passes when it
meets every check of its case. A case without `checks` gets
`[{ "state": "done" }]`; a case that lists checks gets exactly those (add
`{ "state": "done" }` when you want it too).

| Check | Passes when |
| --- | --- |
| `{ path, equals }` | the value at `path` deep-equals `equals` (key order aside) |
| `{ path, contains }` | a string there contains the string; an array there has an element deep-equal to it |
| `{ path, matches, flags? }` | a string there matches the regex (flags out of `i m s u`); another value is matched as its JSON |
| `{ path, exists }` | `true`: `path` leads to a value (`null` counts); `false`: it does not |
| `{ command, timeout? }` | the shell command exits 0, run in the project directory with `ODW_RESULT` (a temp file holding the run's result as JSON; `null` when it did not finish `done`), `ODW_RUN_ID`, `ODW_EVAL_NAME`, `ODW_EVAL_CASE`, `ODW_EVAL_ADAPTER`, `ODW_EVAL_REPEAT`; killed after `timeout` seconds (default 300) |
| `{ state }` | the run ended `"done"`, `"failed"` or `"stopped"` |
| `{ maxCostUsd }` | the run's agents cost at most that, as their CLIs reported it; an unknown cost fails |
| `{ maxSeconds }` | the run took at most that, from its `run_started` event to its end |

`path` is dot/bracket notation into the run's return value: `verdict`,
`findings[0].file`, `items.2` (a digit key indexes an array),
`["odd.key"]`, `['odd key']`; `""` is the whole result. Only own keys are
followed.

### The runs

Every case × adapter × repeat is a real odw run in the run store, started like
`odw run` from the current directory with the cell's adapter as `--adapter`
(none for the config's default) and the eval's `budget`. Its `meta.json` has
`origin: "eval"` and `eval: { name, case, adapter, repeat }`; `odw list`
shows `(eval <name> · <case> · <adapter> #<repeat>)` and `GET /api/runs`
summaries carry `eval`. A `checkpoint()` the run reaches waits for an answer
like any run's (progress names it); give the eval a `timeout`.

Ctrl-C (SIGINT, SIGTERM, SIGHUP) stops every run the eval started — a stop
request each — waits up to 30 seconds for them to end (a second Ctrl-C does
not wait), keeps no report, and ends `odw eval` by that signal.

### Output and exit codes

Progress is a line per finished run on stderr. Then stdout gets the table —
per case × adapter: pass k/n, median wall time, total and mean cost, mean
tokens (input + output); the totals; each failed run with its run id and every
check it missed — or, with `--json`, the report. With `--baseline`, a second
table gives each cell's pass rate (A → B) and B − A of pass rate, mean cost and
median time, then the cells that regressed.

Exit 0 when every run passed — or, with `--baseline`, when no cell's pass rate
fell below the baseline's (failures that were there before are no
regression); 1 otherwise; 2 for a usage error.

### The report

Kept as `<runsRoot>/_evals/<name>/<id>.json`, written to `--out`, printed by
`--json`, read back by `--baseline`; `GET /api/evals` lists the kept ones
(newest first) and `GET /api/evals/:name/:id` serves one, read only. Keys:

- `version` (1), `name`, `id` (start time, then 6 hex digits), `file`, `description`
- `evalHash`: sha256 of the definition as run (keys sorted, flags applied); `definition`: that definition
- `workflow`: `{ ref, script, sourceHash }`; `odwVersion`; `cliVersions`: `{ <adapter>: [versions the runs' cli_version events recorded] }`
- `startedAt`, `finishedAt` (ISO 8601), `wallMs`
- `totals`: `{ runs, passed, failed, passRate, costUsd, inputTokens, outputTokens }`
- `cells`: `[{ case, adapter, runs, passed, passRate, medianMs, costUsd, meanCostUsd, meanTokens, runIds }]`
- `runs`: `[{ runId, case, adapter, repeat, state, passed, timedOut, wallMs, inputTokens, outputTokens, costUsd, estimated, cliVersions, error, failures: [{ check, message }] }]`
- `baseline`: null, or `{ file, name, id, evalHash, sameDefinition, cells: [{ case, adapter, status, passRate, meanCostUsd, medianMs }], regressed: [{ case, adapter }] }` — each figure `{ a, b, delta }` (A the baseline, delta B − A); `status` is `regressed` (pass rate fell), `improved`, `unchanged`, `new` or `missing`

Costs and tokens are summed and averaged over the runs whose CLIs reported
them, and null when none did. Any two run ids open side by side with
`odw compare <runA> <runB>`.

## odw new (ODW extension)

```bash
odw new                                          # the templates, one line each (stdout)
odw new <template> [--name N] [--force] [--yes]
```

The templates are embedded in the binary: `hello` (two read-only agents in
parallel, plain JS picks), `review-swarm`, `fix-until-green`,
`plan-approve-execute`, `pr-shepherd`, `fan-out-reduce` (the examples of the
same name). One writes, under the current directory:

| File | What |
| --- | --- |
| `.odw/workflows/<name>.js` | the workflow; `meta.name` is `<name>` |
| `.odw/tests/<name>.json` | starter cases with scripted replies: `odw test <name>` passes at once, $0 |
| `.odw/evals/<name>.json` | review-swarm and pr-shepherd only: an eval skeleton (real runs — edit it first) |

- `--name` (default: the template's name) — letters, digits and `. _ -`, not
  first, at most 128, not ending in `.js` — replaces the template's name in all
  three files.
- A file that exists with other content is a conflict: without `--force`
  nothing is written, each conflict is named, exit 1. A file that already holds
  exactly the template is left as it is, so the same command twice exits 0.
- In a git repository whose root has no `.worktreeinclude`, it prints a
  suggested one: the root's `.env*` files (not `*.example`, `*.sample`,
  `*.template`, `*.dist`), then `symlink: node_modules` (for `package-lock.json`,
  `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`, `bun.lockb`),
  `symlink: .venv` (`uv.lock`, `poetry.lock`, `Pipfile.lock`, `pdm.lock`),
  `symlink: vendor` (`composer.lock`). Written with `--yes`, or a yes at a
  terminal prompt; otherwise only printed.
- Exit 0 written (or already there), 1 refused, 2 usage (an unknown template, a
  bad name).
- `odw init` (not `--check`) ends with the first run: at a terminal it asks
  (Enter: yes), writes `hello` unless `.odw/workflows/hello.js` exists, runs
  `odw run hello --dry`, then prints `odw serve --open`, `odw test hello` and
  `odw run hello`; elsewhere it prints the commands only. It never calls a
  model.

## odw test (ODW extension)

```bash
odw test [<wf|file.json>] [--case N|name]... [--json] [--keep] [--runs-root DIR] [--config P]
odw run <wf> --dry
odw run <wf> --record [--record-to FILE]
```

`odw test` runs a workflow's test cases as real odw runs — worker, scheduler,
bridge, schema validation and retries, fallback chains, the run store —
in-process, with every agent CLI replaced by a built-in mock that answers from
the case's scripted replies. Nothing calls a model. `<wf>` is
`.odw/tests/<wf>.json`; a `.json` or a path is a file; nothing runs every
`.odw/tests/*.json`. Runs go in a scratch run store, removed afterwards
(`--keep` or `--runs-root DIR` keep them), marked `origin: "test"`.

### The test file

```json
{
  "workflow": "review-swarm",
  "description": "optional",
  "default": { "dry": true },
  "cases": [{
    "name": "unique per file",
    "args": {},
    "replies": [ { "label": "verify:*", "phase": "Verify", "reply": { "real": true, "reason": "ok" } } ],
    "default": { "reply": "ok" },
    "expect": { "state": "done", "error": "…", "checks": [], "agents": { "count": 3, "labels": [] }, "logs": [] },
    "checkpoints": "approve",
    "timeout": 120
  }]
}
```

| Key | Meaning |
| --- | --- |
| `workflow` | A name or a path, resolved like `odw run`'s from where `odw test` runs. Absent: the file's name without `.json`. |
| `default` | File-wide reply for agents no entry scripts (an entry without matchers); a case's own `default` wins. Absent: such an agent fails the case. |
| `cases[].args` | The workflow's input; absent: null. |
| `cases[].replies` | Reply entries, below. |
| `cases[].expect` | What must come out, below. Absent: `{ "state": "done" }`. |
| `cases[].checkpoints` | `"approve"` or `"reject"`: every `checkpoint()` is answered so. Absent: it waits, and the case runs into its timeout. |
| `cases[].timeout` | Seconds (default 120); a run still going then is stopped and the case fails. |

Any other key is an error naming where it is; nothing runs.

**Reply entries.** Matchers — each one given must hold; the first entry that
matches answers: `label` (glob: `*`, `?`), `phase` (glob; an agent outside any
phase matches none), `prompt` (substring), `adapter` (glob; after a fallback,
the adapter it moved to). Exactly one answer: `reply` (a string as is, any
other value as JSON — a schema call's value), `fail` (`rate_limit` | `quota` |
`auth` | `permission` | `timeout` | `stalled` | `not_found` | `exit`: worded so
ODW's failure classes read it like the real thing — a rate limit is retried
`transientRetries` times with no wait, a quota falls back down a chain),
`empty: true` (an empty reply), `dry: true` (the `--dry` stub). Modifiers:
`schemaMiss: N` (the first N attempts reply with text no schema accepts, then
the answer: exercises schema retries; with `reply` or `dry`), `delayMs` (answer
late: finish order), `once: true` (answers one agent — all its attempts — then
is used up; agents sharing a label get such entries in turn). An agent nothing
matches, with no `default`, gets a failing CLI and fails the case:
`unscripted agent \`label\` (agent #N, phase P)`.

**`expect`.** `state` (`"done"` default, `"failed"`, `"stopped"`), `error` (a
substring of the run's error), `checks` (the `odw eval` vocabulary above:
`{ path, equals | contains | matches | exists }`, `{ command }` — with
`ODW_RESULT`, `ODW_RUN_ID` and `ODW_TEST_CASE` — `{ state }`, `{ maxSeconds }`,
`{ maxCostUsd }` against a cost of $0), `agents: { count, labels }` (how many
agents started; exactly these labels as a multiset), `logs` (substrings of
`log()` lines, in this order, others between).

**Output and exit codes.** A line per case (✔/✖, name, agents, time, then each
missed expectation as `check: what was found`). `--json`: `{ version: 1,
odwVersion, passed, failed, runsRoot, cases: [{ file, workflow, case, name,
passed, failures: [{ check, message }], runId, state, agents, durationMs }] }`.
Exit 0 all passed, 1 any failed, 2 usage (a bad flag or file, an unknown case,
a workflow that does not load).

**The mock.** Every adapter of the config is kept by name (so `agent(p, {
adapter })`, phase defaults and fallback chains resolve) but runs the mock:
plain-text output, the schema handed over natively (so prompts carry no schema
text), every permission tier honoured, no sandbox, no CLI version probe, no
notify hooks, no OpenTelemetry export, no quota wait, no worktree setup command.
A config without a usable default adapter gets one named `mock`. `exec()`,
`isolation: "worktree"` and the rest run for real.

**`odw run <wf> --record [--record-to FILE]`.** A real run (it costs what a run
costs) whose worker, once the run has ended, adds a case named `recorded
<run_id>` to `FILE` (default `.odw/tests/<meta.name>.json` in the run's source
directory; made if missing, a case of the same name replaced, the rest kept):
its `args`, a reply entry per agent — `{ label, phase?, reply }` with the value
the run saved, or `{ fail: <failure class> }` / `{ empty: true }` for a failed
one — and `expect: { state, error?, checks?: [{ path: "", equals: <result> }],
agents: { count } }` (the result only when its JSON is under 8,000 characters).
Agents sharing a label and phase whose replies differ get one `once` entry
each, in start order. Redacted with the run's redactor (input included); every
string cut at 4,000 characters; at most 500 entries. Not with `--dry` or `--on`.

**`odw run <wf> --dry`.** Every agent answered by a stub: `"(dry run)"`, or for
a schema call its smallest valid value — required properties only, `minItems`
items, `const` / the first `enum` value, the first `anyOf`/`oneOf` branch,
`allOf` merged, local `$ref` followed, the lowest number the bounds allow, `""`
(or `minLength` × `"x"`; a known `format` gets a sample). The run is marked
`dry: true` in `meta.json` (and the dashboard summary); `odw run --dry` waits for
it (never `--detach`) and prints to stderr the phase tree: each declared or
started phase with how many agents it started and their labels.

## Debugging: odw check, odw replay, --break / --step (ODW extension)

```bash
odw check wf.js [--json]                      # load it as a run would (never runs it): exit 0, or 1 with file:line:col + a code frame
odw replay $RUN --agent <id|label> [--prompt @file|TEXT] [--adapter A] [--model M] [--wait|--fg|-d]
odw run wf.js --break <phase|label>[,…] [--break …]   # a checkpoint before those phases / agent labels
odw run wf.js --step                                  # a checkpoint before every phase
```

- **check**: the `meta` literal, its name/description/phases, the body compiled.
  Parse errors keep the compiler's message plus `(line L:C)`; a hint is added
  only when it fits (TypeScript syntax, `await` in a non-async callback, the
  script ending before a bracket closes). `validate()` reports the same.
- **replay**: every `agent()` call saves `agents/<id>.call.json` as it starts
  (prompt, options, adapter it started on, model asked for); an isolated
  agent's `agent_started` carries `base` (its worktree's commit). A replay is
  a new run (`origin: "replay"`, `replayOf: { runId, agentId, label, base? }`;
  its meta `args` are `{ replayOf }` only — the prompt is in the run's unserved
  `call.json`) of that one call — same label, phase, source dir, config, tier, trust,
  sandbox, and for `isolation: "worktree"` the original `base` whatever HEAD
  is now. `odw compare <source> <replay> --agent <label>` pairs the two (the
  CLI prints it, with the id when the label is shared). Runs from before this
  version saved no calls: `odw rerun`.
- **--break / --step**: a break is a `checkpoint()` the run asks itself, title
  `Break before phase X` / `Break before agent X`, payload `{ before,
  phasesDone, agents: { done, failed, running }, results: [last 20], args }`
  — answered with `odw approve|reject`, the dashboard or a phone link. After
  `phase(X)` (which cannot wait) every `agent()`, `exec()`, `workflow()` and
  `checkpoint()` call holds until the answer; agents already running go on.
  Approve: continue. Reject: the run stops (state `stopped`). Approve with an
  edited payload: only `args` is taken, in place, when `args` is an object or
  array and stays one — reads after the answer see it; what was read before
  (including the held call's own prompt) does not. Other edits are refused
  with a log line. `meta.json` keeps the original args (rerun/resume use them).

## odw conformance

```bash
odw conformance [--json] [--case N|name]... [--dir DIR]
```

The dialect's behaviour as runnable cases (`conformance/` in the ODW
repository, shipped with the npm package): each a plain workflow script in
Claude Code's dialect with an `expected.json` — its result, and the logs,
phases and agents that matter — run on a deterministic mock agent that answers
from a table in the case. `odw conformance` runs each as a real odw run and
prints pass/fail per case; exit 1 on any failure, 2 for an unknown case or a
suite that breaks the format. Each case is `documented` (Claude Code's docs
settle the behaviour) or `unspecified` (they do not; the case pins what ODW
does — the place to expect a difference). Scripts that pass conformance run
on both: keep to what the documented cases pin down. The command is ODW's; the
cases themselves run on Claude Code by hand, and `conformance/README.md` gives
the format for another runtime's runner.

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
