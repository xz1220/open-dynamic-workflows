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
  optional. A `phases` entry is `{ title, detail? }` (or just the title); its
  `adapter` and `model` are the defaults of the phase's agents (**ODW
  extension** — see [per-phase routing](#per-phase-adapters-model-tiers-and-fallback-chains-odw-extension)).
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
| `phase(title, opts?)` / `log(msg)` | Label the following work for progress / emit one progress line. `opts` (`{ adapter, model }`, **ODW extension**) gives the phase's agents a CLI and a model. |
| `args` | The workflow input (injected). |
| `budget` | `{ total, spent(), remaining() }` — scale depth to a token target. |
| `workflow(ref, args?)` | Run another workflow inline (one level deep). `ref` is a managed-directory name or `{ scriptPath }`; the child shares this run's concurrency cap, agent counter, and budget. |
| `validate(source)` | Parse and compile-check source without running its workflow body; `meta` is parsed as a pure literal, never evaluated. Returns `{ ok, meta?, errors, warnings }`. **ODW extension** — not part of Claude Code's dialect. |
| `exec(command, opts?)` | Run a command (tests, a build, a linter) without a model; resolves to `{ stdout, stderr, exitCode, signal, timedOut, truncated, durationMs }`. A string runs through the shell, an array as argv. **ODW extension** — not part of Claude Code's dialect. |
| `checkpoint(title, opts?)` | Pause the run until a person approves or rejects; resolves to `{ approved, note, by }`. **ODW extension** — not part of Claude Code's dialect. |

`opts` for `agent`: `{ adapter?, schema?, label?, phase?, model?, agentType?, isolation?, keep?, permissions?, expect?, expectRetries?, allowEmpty? }`.
`adapter` picks the CLI — or, as a list (`['codex', 'claude']`, **ODW
extension**), a fallback chain; `model: '@fast'` picks a tier's model for
whichever CLI runs it (**ODW extension**); `schema` is a raw JSON Schema object (an option, not
a global); `agentType` is a **persona** injected into the prompt — *not* an
adapter name. `keep: true` (**ODW extension**) also commits an isolated agent's
change to a branch `odw/<runId>/<agentId>-<label>`. `permissions: "read"`
(**ODW extension**) runs the agent at a stricter tier than the run's — see
[permission tiers](#permission-tiers-odw-extension).

Write `schema` in the subset ODW checks — `type` (one name), `enum`, `properties`,
`required`, `additionalProperties: false`, `items` (one schema), `minItems`, plus
annotations like `description` and `format`. Any other keyword (`oneOf`, `$ref`,
`const`, `pattern`, `maxItems`, a type union, …) is not checked by ODW: the run's log
says so once, with where it is, and the call runs — or, under `"schemaKeywords":
"strict"`, fails with an `AgentError` before it starts (**ODW extension**). Put a
limit ODW cannot check in a `description`. On `claude` and `codex` the schema is
passed to the CLI natively, which enforces it; ODW validates the reply either way —
see [`references/primitives.md`](references/primitives.md#schema).

`expect` (**ODW extension**) states what must hold once the agent has replied,
and odw checks it — prefer it to asking the model "did you do it?", or to
trusting a reply that says so. `changes: true|false` (some file changed / none
did), `files` (globs, each matching a file it changed or created), `command`
(must exit 0 in the agent's workspace; `timeout` seconds, default 600) and
`match` (a regular expression the reply must match). Work that misses runs
again, on the same adapter, with what it missed in its prompt (`expectRetries`,
default 1), then throws — recoverable — with `reason: "unmet_expectation"` and
`misses`; a miss never falls back, and a call that does fall back keeps its
`expect`. Tool
calls the CLI refused (claude's `permission_denials`) count as a miss too, and
then the reason is `"permission"`. Without `expect`, such a reply stands: the
refused calls are kept as `denied` on the agent and logged once
(`"permissionDenials": "fail"` fails it instead). An empty reply always throws
`reason: "empty_reply"` (`allowEmpty: true` accepts one):

```js
const fix = await agent('Fix the failing parser tests.', {   // ODW extension: expect
  expect: { command: 'npm test', changes: true, files: ['src/parser/**'] },
})
```

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

`opts` for `checkpoint`: `{ payload?, timeout?, onTimeout? }`. `payload` is what
the person should look at (a plan, a summary of the changes); `timeout` is
seconds to wait, after which `onTimeout` approves, rejects, or — the default
`"fail"` — throws a recoverable `CheckpointTimeout`. A rejection is an answer,
not an error: branch on `approved`, and use the person's `note`:

```js
const plan = await agent(`Plan this as independent steps: ${task}`, { schema: PLAN })
const { approved, note } = await checkpoint('Run this plan?', { payload: plan })   // ODW extension
if (!approved) return { approved, note, plan }
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
odw status $RUN             # state, agent count, tokens and cost
odw logs $RUN --follow      # stream progress events
odw logs $RUN --agent 3     # what one agent did: tool calls, results, errors (ODW extension)
odw result $RUN             # print the final value when done
odw pause $RUN / resume $RUN / stop $RUN
odw approve|reject $RUN     # answer a checkpoint() the run waits at — only on the user's say-so
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
odw logs $RUN --agent 4       # what a failed (or hung) agent did: every tool call, result, error
odw stop $RUN                 # give up on the hung lane, then…
odw resume $RUN --wait        # …a NEW run: unchanged agent() calls replay, only the rest run
```

- Read a failed agent's transcript before you retry it (ODW extension):
  `odw logs $RUN --agent <id|label>` prints its tool calls (`▸ Bash  npm test`),
  their results (`✗ Bash error (exit 1, …)`), its retries and the end of its
  stderr; `--follow` watches a running one, `--raw` prints the CLI's own events.
  Fix what it shows — the prompt, a missing tool permission, the environment —
  instead of resubmitting the same call. A replayed (↺) agent has none.
- `odw result --agent` salvages partial results while the run is still going.
- `odw resume` on an ended run (done, failed, stopped, or stale) starts a new
  run with the same script, args and adapter. A call whose prompt and options
  are unchanged (phase aside) returns its saved value for free — no adapter
  call, slot or budget. Edit the script first to fix the failing step: only
  edited and new calls run. `--adapter <name>` switches the default CLI; calls
  that named no adapter still replay.
- On a *paused* run — by `odw pause`, or waiting for a spent quota to reset
  (`quotaWait`) — `odw resume` just continues it in place. A run that is
  still running is refused: `odw stop` it first (or pass `--force`).
- Keep prompts deterministic — one built from `Date.now()` or `Math.random()`
  never matches, so it runs again.

### Review and apply isolated agents' changes (ODW extension)

An agent with `isolation: "worktree"` edits a throwaway worktree, never your
files. Its change is kept with the run as a diff (`agents/<agentId>.diff`) —
`agent()` still returns only the reply:

```bash
odw diff $RUN --stat                  # which agents changed which files, +/- lines
odw diff $RUN --agent <id|label>      # one agent's diff — read it before applying
odw apply $RUN --agent <id> --check   # preview: each file clean, CONFLICT (with its lines) or already applied
odw apply $RUN --agent <id>           # git apply --3way into this working tree (staged)
odw apply $RUN --all --check          # preview every finished agent, each on top of the ones before it
odw apply $RUN --all --verify "<test command>"   # apply them in order; roll back one that fails the check
```

- Preview first (`--check`, exit 1 when anything conflicts), apply what the task
  calls for, and tell the user what you applied and what conflicted (exit 1:
  conflict markers to resolve, where the preview showed them). Run it inside the
  repository the run worked on.
- `--all` applies every finished agent in agentId order, stops before the first
  that would conflict, and says which applied and which did not. A failed
  agent's diff goes in only by `--agent`.
- `--verify "<cmd>"` (or the `applyVerify` setting) runs the command at the
  repository root after each apply and rolls that apply back, exactly, when it
  fails — only the paths the diff touched, never the user's other work. Use the
  project's test or build command when it has one. A change that would conflict
  is not applied under `--verify`.
- `odw apply` refuses while a path the diff touches has uncommitted changes —
  commit or stash first; use `--force` only when the user agrees.
- A diff cut at `maxDiffBytes` cannot be applied: use the agent's branch
  (`keep: true`, or `"keepBranches": true` in the config).

### Permission tiers (ODW extension)

Every agent runs at a tier: `read` (look — never edit or run commands), `edit`
(the default: what each CLI always ran with), or `full` (no sandbox, no
approvals).

- **Research, review, audit and verification fan-outs: use `read`.** Give those
  agents `{ permissions: 'read' }`, or start the whole run read-only with
  `odw run wf.js --permissions read` when no step needs to write. A reviewer that
  can edit may "fix" what it should only report.
- An agent may only lower its run's tier; asking for more fails that agent
  (`agent() asked for permissions "full", but the run allows only "edit"`).
- `read` works on `claude`, `codex` and `gemini`. Other CLIs refuse it: the agent
  fails before it starts, saying which adapter can. Name one of those for read-only
  agents (`adapter: 'claude'`); `odw doctor` lists each adapter's tiers, and every
  `odw run` prints the tier each installed adapter will run with.
- **Never choose `full` on your own.** It removes the sandbox and every approval:
  use it only when the user asks for it, on a machine they treat as disposable.

```js
const findings = await parallel(files.map((f) => () =>
  agent(`Review ${f}: list bugs with evidence; change nothing`, { permissions: 'read', label: f })))  // ODW extension
```

### Per-phase adapters, model tiers and fallback chains (ODW extension)

Mix CLIs and models per stage — a cheap model for wide search or extraction
fan-outs, a strong one for synthesis and verdicts — and keep a long run going
when one CLI runs out of quota.

- **Phase defaults.** `meta.phases: [{ title: 'Search', adapter: 'codex', model: '@fast' }]`,
  or `phase('Search', { adapter: 'codex', model: '@fast' })` for the agents that
  follow. An option the `agent()` call sets always wins.
- **Model tiers.** `model: '@fast'` uses the `models` tier the user configured, with
  each CLI's own model id; an unknown tier fails the agent and lists the tiers. A
  plain model id is passed to every CLI as is — prefer a tier whenever an agent
  may run on more than one CLI.
- **Fallback chains.** `adapter: ['codex', 'claude']` (or the user's `fallback`
  config): when the first CLI's quota is spent or its login is refused, the agent
  runs again on the next one, at the same permission tier, and the log says so
  (`search:3 → claude after codex quota`). Rate limits are still retried in place.
  After three quota failures in a row on one CLI, the run's later agents skip it.
  `odw agents --json` and the `agent_finished` event name the CLI that produced
  each value (`adapter`) and the ones it left (`fellBackFrom`).
- Only name adapters the user has installed (`odw doctor` lists them), and keep
  the user's choice of default CLI: suggest a chain when long runs keep stopping
  on quota, don't add one silently.
- **Pause for a spent quota.** With `"quotaWait": { "max": <seconds> }` in the
  config (off by default), an agent with no CLI left waits for the reset its CLI
  named instead of failing — holding no slot — and the run shows
  `paused until 19:10 (codex quota)`. Suggest it for unattended overnight runs, and
  say the run may then sit for hours; `odw resume <run>` goes on at once.

```js
phase('Extract', { model: '@fast' })   // ODW extension
const claims = await pipeline(sources, (s) => agent(`Extract cited claims from ${s}`, { schema: CLAIMS }))
phase('Verdict', { adapter: ['claude', 'codex'], model: '@strong' })   // ODW extension
return await agent(`Rank these claims by evidence:\n${JSON.stringify(claims.filter(Boolean))}`)
```

### Human checkpoints (ODW extension)

Add a `checkpoint()` only where a person's judgment is worth the wait: before
an expensive or hard-to-undo step (a large fan-out, edits across the
repository, anything that deploys, deletes or spends money), or to have the
user confirm a plan you generated. Don't checkpoint routine steps, and give
unattended runs (cron, CI) a `timeout` with an explicit `onTimeout`.

A run that reaches a checkpoint waits — durably, for as long as it takes —
and shows as `waiting`:

```bash
odw status $RUN     # the question, its payload, and the exact commands that answer it
```

**Never answer a checkpoint on your own.** It exists so that the user decides.
Show the user the question and the payload, and run `odw approve $RUN` or
`odw reject $RUN --note "…"` (add `--checkpoint N` when several wait) only
after the user explicitly tells you to — put their reasons in `--note`. If the
user is not there, leave it waiting: they can answer later from any shell, or
with Approve/Reject in the dashboard (`odw serve`).

`odw run --wait` blocks while a checkpoint waits. Start a workflow with
checkpoints detached (`RUN=$(odw run wf.js)`) and poll `odw status $RUN`, or
bound the wait with `--wait --timeout <s>`. `odw resume` replays finished
agents but asks every checkpoint again.

### Schedule runs (ODW extension)

Set up a recurring run only when the user asks for one: `odw schedule add`
writes into their crontab, LaunchAgents or systemd user units. Show them the
`--dry-run` output first.

```bash
odw schedule add digest digest --cron "0 8 * * 1-5" --cwd ~/work/news --dry-run   # what it would write
odw schedule add digest digest --cron "0 8 * * 1-5" --cwd ~/work/news             # same flags as odw run: --args, --adapter, --config
odw schedule list              # each schedule's backend, last run, next run (local time)
odw schedule run digest        # run it now, as the scheduler will: exit 0 = done (or skipped)
odw schedule remove digest     # delete the OS entry and the definition
```

- odw runs no daemon: `add` writes a cron block (Linux), a launchd agent
  (macOS) or, with `--backend systemd`, a user timer that calls
  `odw schedule run <name>` — which skips a start while the previous run is
  still going, logs one line per run to
  `~/.local/state/odw/schedules/<name>.log`, and fires the `notify` hooks like
  any run.
- The workflow, adapter and config must load when you add the schedule; the
  expression is cron's five fields (`@daily`, `L`, `#` are refused).
- A scheduled run that reaches a `checkpoint()` holds back the next ones until
  it is answered: give unattended checkpoints a `timeout`.

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
  `agent()` returns the reply, not a diff; the run keeps the agent's change as
  a diff to review and apply (`odw diff`, `odw apply`; ODW extensions — see
  above). A fresh worktree lacks
  untracked files: a `.worktreeinclude` at the repository root (gitignore
  syntax; `symlink: node_modules` links instead of copying) brings in `.env`
  and the like, and a `worktreeSetup` command in the config runs before the
  agent (both ODW extensions).
- **Ports**: every agent process gets a unique `$ODW_PORT` (with `$ODW_RUN_ID`
  and `$ODW_AGENT_ID`) — tell parallel agents "start the dev server on
  `$ODW_PORT`" so they never collide, and to stop the server before finishing
  (an agent CLI may wait for its background commands before exiting) (ODW extension).
- **Rate limits**: a rate-limited CLI is retried after a backoff (honoring its
  retry-after); a spent quota or a failed login is not retried — the agent fails
  with what to do, and `odw logs` names the reason — unless it has a fallback
  chain, which moves it to the next CLI (ODW extension). Switch adapter with
  `--adapter` rather than retrying a quota failure. Under `quotaWait` (ODW
  extension) it waits for the quota to reset instead (see routing above).
- **Throttling and the prompt cache** (ODW extensions): an adapter's own
  `concurrency` caps its agents inside the run's, and a rate limit halves that cap
  for the run; on `claude`, a `parallel()`/`pipeline()` whose prompts share their
  first 1,024+ characters starts staggered so the rest read the prompt cache — put
  the shared instructions first and the per-item part last.
- **Cost**: concurrency is capped (default `min(16, cpus - 2)`) and total
  dispatches per run have a hard guard; use `odw pause` / `odw stop` when a
  run exceeds expectations.
- **Results**: the engine never commits, pushes, or applies diffs for you.
  Inspect the `return` value first, then decide the next step — for isolated
  agents, that includes reviewing their kept diffs and running `odw apply`.
- **Secrets** (ODW extension): what odw keeps and serves — transcripts,
  `odw logs`, saved results (`odw result --agent`), the run's error, webhooks —
  shows likely secrets as `«redacted:<kind>»` (`env:NAME` for a secret-named
  variable's value, else the token's kind). The agents and the workflow still
  got the real text; only what was written down is redacted, so a marker in
  `odw logs` is not the agent's mistake. A resumed run replays a redacted
  result as kept: never let a later step depend on a secret an agent printed —
  read it from the environment. The run's own result keeps variables' values
  (only token shapes are redacted there); `"redact": false` turns it off.

## Common mistakes

| Mistake | Correction |
| --- | --- |
| Importing primitives or other modules in the script | Primitives are injected globals; any extra top-level `import`/`export` is rejected by the loader. |
| Variables, spreads, or function calls inside `meta` | `meta` must be a pure literal. |
| Treating all failures in `parallel`/`pipeline` alike | Recoverable failures become `null`; stop, budget and dispatch-limit errors abort. Retry missing results or fail when every item is required; filter only when partial output is acceptable. |
| Branching on which agent finished first | Breaks reproducibility; keep reductions order-independent. |
| Re-running a stalled or failed run from scratch | Read finished agents with `odw result <run> --agent <id>`; `odw stop`, fix the script, then `odw resume` — finished calls replay for free. |
| Retrying a failed agent without looking at what it did | Read its transcript first — `odw logs <run> --agent <id\|label>` shows its tool calls, results, errors and the end of its stderr (ODW extension) — and fix the cause. |
| Asking an agent whether it did the work, or trusting a reply that says so | State it with `expect` — `{ command: 'npm test', changes: true }`: odw checks it after the reply, hands misses back once, and fails the agent with `unmet_expectation` and what it missed (ODW extension; `examples/fix-until-green.js`). |
| Retrying an agent that failed with reason `permission` as if it were flaky, or ignoring a finished agent's `denied` | Both name the tool calls headless mode refused (`denied: Bash (npm test)`) — its reply may rest on work it could not do: ask the user to allow exactly those in the adapter's `permissionArgs` for its tier, or give the agent work it can do without them. |
| Looking for an isolated agent's edits in your files after the run | They are kept as diffs, not merged: `odw diff <run> --stat`, then `odw apply <run> --agent <id> --check` and `odw apply`. |
| Using `validate()` and expecting the script to run on Claude Code | `validate` is an ODW extension and runs on odw only. |
| Using `exec()` and expecting the script to run on Claude Code | `exec` is an ODW extension and runs on odw only; `validate()` warns about it. |
| Using `checkpoint()` and expecting the script to run on Claude Code | `checkpoint` is an ODW extension and runs on odw only; `validate()` warns about it. |
| Approving a checkpoint yourself because the run looks stuck | A waiting checkpoint is the user's decision: show them `odw status $RUN`, and run `odw approve`/`odw reject` only on their explicit say-so. |
| Fanning out research or review agents that can edit | `{ permissions: 'read' }` on those agents, or `odw run --permissions read`: they read and report, and cannot change the tree (ODW extension; claude, codex or gemini). |
| Reaching for `--permissions full` when an agent was refused or denied | `full` drops the sandbox and every approval — ask the user. A refused `read` agent needs a read-capable adapter instead. |
| Giving one CLI's model id to agents that may run on another (a phase default, a fallback chain) | Model ids do not cross CLIs: use a tier, `model: '@fast'`, which picks each CLI's own id (ODW extension). |
| Fanning out wide without watching what it spends | `odw status $RUN` shows the run's tokens and cost so far, and a `parallel()`/`pipeline()` wider than `fanOutWarn` (default 25) logs a warning (ODW extensions). Size fan-outs to `budget.total` when one is set; `--budget` caps output tokens. |
| Hand-writing a cron line around `odw run` | `odw schedule add` writes it with an overlap lock, a log and a pinned `PATH` — and only on the user's request: it edits their crontab or LaunchAgents. |
