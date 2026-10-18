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
- To run on Claude Code's Workflow tool as well, keep to the dialect: no ODW
  extension, and no behaviour the conformance suite marks `unspecified`.
  Scripts that pass conformance run on both — `odw conformance` runs the
  suite (`conformance/` in the ODW repository; [primitives](references/primitives.md#odw-conformance)).

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
| `parallel(thunks)` | Run zero-arg thunks concurrently and **wait for all** (barrier). Order preserved; a failed slot is `null`. `parallel(thunks, { notes: true })` gives its agents the run's notes board (**ODW extension**; below). |
| `pipeline(items, ...stages)` | Stream each item through the stages independently (**no barrier**). Each stage receives `(prev, item, index)`. |
| `phase(title, opts?)` / `log(msg)` | Label the following work for progress / emit one progress line. `opts` (`{ adapter, model }`, **ODW extension**) gives the phase's agents a CLI and a model. |
| `args` | The workflow input (injected). |
| `budget` | `{ total, spent(), remaining() }` — scale depth to a token target. |
| `workflow(ref, args?)` | Run another workflow inline (one level deep). `ref` is a managed-directory name or `{ scriptPath }`; the child shares this run's concurrency cap, agent counter, and budget. |
| `validate(source)` | Parse and compile-check source without running its workflow body; `meta` is parsed as a pure literal, never evaluated. Returns `{ ok, meta?, errors, warnings }`. **ODW extension** — not part of Claude Code's dialect. |
| `exec(command, opts?)` | Run a command (tests, a build, a linter) without a model; resolves to `{ stdout, stderr, exitCode, signal, timedOut, truncated, durationMs }`. A string runs through the shell, an array as argv. **ODW extension** — not part of Claude Code's dialect. |
| `checkpoint(title, opts?)` | Pause the run until a person approves (perhaps with an edited payload) or rejects; resolves to `{ approved, note, by, payload, edited }`. **ODW extension** — not part of Claude Code's dialect. |

`opts` for `agent`: `{ adapter?, schema?, label?, phase?, model?, agentType?, isolation?, keep?, permissions?, expect?, expectRetries?, allowEmpty?, notes?, handoff?, scope?, scopePolicy?, questions?, stallMs? }`.
`stallMs` (Claude Code dialect) is that one agent's stall window in milliseconds
(`{ stallMs: 1800000 }` = 30 minutes), in place of the `stallTimeout` setting.
`adapter` picks the CLI — or, as a list (`['codex', 'claude']`, **ODW
extension**), a fallback chain; `model: '@fast'` picks a tier's model for
whichever CLI runs it (**ODW extension**); `schema` is a raw JSON Schema object (an option, not
a global); `agentType` names a subagent definition (`.claude/agents/<name>.md`,
`.odw/agents/`, `~/.claude/agents/`, `<plugin>:<name>`) — its body is the persona,
its `model`/`tools`/`isolation`/`effort` map per CLI, tools only lower the tier
(**ODW extension**; `odw agents types` shows the mapping); with no definition it is
a one-line persona, and it is never an adapter name. `keep: true` (**ODW extension**) also commits an isolated agent's
change to a branch `odw/<runId>/<agentId>-<label>`. `permissions: "read"`
(**ODW extension**) runs the agent at a stricter tier than the run's — see
[permission tiers](#permission-tiers-odw-extension).

Write `schema` in the subset ODW checks — `type` (one name), `enum`, `properties`,
`required`, `additionalProperties: false`, `items` (one schema), `minItems`, plus
annotations like `description` and `format`. Any other keyword (`oneOf`, `$ref`,
`const`, `pattern`, `maxItems`, a type union, …) is not checked by ODW: the run's log
says so once, with where it is, and the call runs — or, under `"schemaKeywords":
"strict"`, fails with an `AgentError` before it starts (**ODW extension**). Put a
limit ODW cannot check in a `description`. On `claude`, `codex` and `agy` the schema is
passed to the CLI natively, which enforces it; ODW validates the reply either way —
see [`references/primitives.md`](references/primitives.md#schema).

`expect` (**ODW extension**) states what must hold once the agent has replied,
and odw checks it — prefer it to asking the model "did you do it?", or to
trusting a reply that says so. `changes: true|false` (some file changed / none
did), `files` (globs, each matching a file it changed or created), `command`
(must exit 0 in the agent's workspace; `timeout` seconds, default 600) and
`match` (a regular expression the reply must match), and `untouched` (globs no
file it changed, created or deleted may match — `['test/**', '**/*.snap']`, so
it cannot edit or skip the tests to get green). Work that misses runs
again, on the same adapter, with what it missed in its prompt (`expectRetries`,
default 1), then throws — recoverable — with `reason: "unmet_expectation"` and
`misses`; a miss never falls back, and a call that does fall back keeps its
`expect`. Tool
calls the CLI refused (claude's `permission_denials`) count as a miss too, and
then the reason is `"permission"`. Without `expect`, such a reply stands: the
refused calls are kept as `denied` on the agent and logged once
(`"permissionDenials": "fail"` fails it instead). `mcp: ['github']` needs those
MCP servers connected when Claude Code started the agent (`pending` passes);
without it, servers that were not are kept as `mcp` on the agent and logged once
per run (`"mcpFailures": "fail"` fails an agent whose server `failed` or
`needs-auth`, reason `"mcp_unavailable"`). Background work its CLI left running
when it replied (a `run_in_background` command or subagent, killed as `-p`
exits) is a miss too, reason `"orphaned_background"`; without `expect` it is
kept as `orphaned` on the agent and logged once (`"orphanedBackground": "fail"`
fails it instead). The model its CLI said served it is kept as `servedModel`;
one that is not the `model` asked for is a logged `model_substituted` event
(`"modelMismatch": "fail"` fails it, reason `"model_substituted"`; a CLI that
names no model is "not reported"). An empty reply always throws
`reason: "empty_reply"` (`allowEmpty: true` accepts one):

```js
const fix = await agent('Fix the failing parser tests.', {   // ODW extension: expect
  expect: { command: 'npm test', changes: true, files: ['src/parser/**'] },
})
```

`notes` (**ODW extension**) gives agents that change one codebase in parallel a
run-scoped notes board, so their changes still fit together: `agent(…, { notes:
true })`, `parallel(thunks, { notes: true })`, or `"notes": true` in the config
(off by default; `notes: false` opts one agent out). Such an agent finds the notes
posted before it started in its prompt, and posts with `"$ODW_NOTES" "renamed
parseX → parse"` (or `odw note "…"`); `"$ODW_NOTES"` alone prints the board. An
isolated agent's kept change is posted for it as it finishes — its diff stat and
the declaration lines (`export`, `def`, `func`, `pub fn`, `class`, `interface`) its
diff touched — so agents started after it see it. Use it for parallel worktree
lanes on shared code, then read the board with `odw notes $RUN`; see
`examples/coordinated-refactor.js` and
[`references/primitives.md`](references/primitives.md#notes-odw-extension):

```js
const lanes = await parallel(tasks.map((t, i) => () =>      // ODW extension: notes
  agent(t, { label: `lane-${i + 1}`, isolation: 'worktree' })), { notes: true })
```

`memory` (**ODW extension**) carries what earlier runs of a workflow learned into the
next: `.odw/memory/<workflow>.jsonl` in the repository, filled only from explicit
sources — a note kept with `"$ODW_NOTES" --keep "…"` (or `odw note --keep`), a
checkpoint rejected with a note or approved with an edit (`checkpoint(…, { memory:
true })`), an `expect` miss a retry then met (`agent(…, { memory: true })`), and
`odw memory add`. An agent with `memory: true` (or `"memory": true` in the config)
gets the entries still applying ahead of its task — newest first, at most 4 KB; an
entry whose `paths` changed since its commit is stale and left out. Untrusted runs
skip the repository's memory. Tend it with `odw memory list|add|prune`; see
[`references/primitives.md`](references/primitives.md#memory-odw-extension).

`scope` (**ODW extension**) declares the files an agent means to change — globs
like `expect.files`. Parallel calls whose scopes overlap run one after the other
(the later waits for the earlier, logged once: "fix-auth waits for
refactor-login: both declare src/auth/**"); disjoint and unscoped ones run
together. What an agent changed outside its scope is recorded as `outOfScope`,
logged, and posted to the notes board when notes are on; `scopePolicy: "fail"`
(or the `"scopePolicy"` setting) fails it with reason `out_of_scope`, and with
`expect` it is a miss. Give each lane of a fan-out over shared code a scope; see
[`references/primitives.md`](references/primitives.md#scope-odw-extension):

```js
await parallel([                                             // ODW extension: scope
  () => agent('Refactor login.', { label: 'refactor-login', scope: ['src/auth/**'] }),
  () => agent('Fix token expiry.', { label: 'fix-auth', scope: ['src/auth/token.ts'] }), // waits
  () => agent('Document the parser.', { label: 'docs', scope: ['docs/**'] }),            // runs beside
])
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

`opts` for `checkpoint`: `{ payload?, schema?, timeout?, onTimeout? }`. `payload`
is what the person should look at (a plan, a summary of the changes); `timeout`
is seconds to wait, after which `onTimeout` approves, rejects, or — the default
`"fail"` — throws a recoverable `CheckpointTimeout`. A rejection is an answer,
not an error: branch on `approved`, and use the person's `note`. The person may
also approve an **edited** payload (`odw approve --edit` / `--payload`, or the
dashboard): use the result's `payload` — what was approved — rather than your
own copy (`edited` says whether it changed), and pass a `schema` so an edit must
keep the shape your code relies on (without one, any JSON value is accepted):

```js
const plan = await agent(`Plan this as independent steps: ${task}`, { schema: PLAN })
const r = await checkpoint('Run this plan?', { payload: plan, schema: PLAN })   // ODW extension
if (!r.approved) return { approved: false, note: r.note, plan }
const approvedPlan = r.payload   // the person's edit, or plan itself
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

When a run must end by a time — a CI job's timeout, the user's "give it ten
minutes" — add `--deadline <seconds>` (ODW extension): the run is then STOPPED
when they pass, its finished agents and diffs kept; `--wait` prints `{ state:
"stopped", reason: "deadline", finished: [{ agentId, label, phase, value }] }`
and exits 3. `--timeout <s>` is not that: it only stops waiting (exit 124) and
the run goes on.

For long runs, fire-and-poll instead of blocking yourself:

```bash
RUN=$(odw run wf.js)        # prints a run id and returns immediately
odw status $RUN             # state, agent count, tokens and cost (by phase: ODW extension)
odw logs $RUN --follow      # stream progress events
odw logs $RUN --agent 3     # what one agent did: tool calls, results, errors (ODW extension)
odw export $RUN --otlp      # the run as OpenTelemetry traces, OTLP/JSON — --send posts it (ODW extension)
odw bundle $RUN             # the run as one redacted file to share, $RUN.odwrun; odw view FILE shows it
                            #   read-only (ODW extension; --no-transcripts, --out FILE, --max-bytes N)
odw gc                      # what runs left on disk — orphaned worktrees, keep branches, old transcripts — with
                            #   sizes (ODW extension); a dry run: --yes deletes, only on the user's say-so;
                            #   --older-than 14d, --json; odw pin $RUN keeps a run out of it (--remove unpins)
odw digest                  # one report across runs, from their evidence only (ODW extension): checkpoints
                            #   waiting, failed runs + odw resume, missed expect/scope, kept diffs, spend;
                            #   --since 12h | --since-last, --workflow W, --json | --markdown; --notify sends it
                            #   ("digest" in notify.on) — only on the user's say-so
odw result $RUN             # print the final value when done
odw pause $RUN / resume $RUN / stop $RUN
odw approve|reject $RUN     # answer a checkpoint() the run waits at — only on the user's say-so
                            # (approve --payload JSON|@file approves the user's edit; --edit needs their terminal)
odw compare $OLD $RUN       # what changed between two runs: setup, time, cost, failures, replies (ODW extension)
odw estimate wf.js          # p50/p90 time, cost, tokens, agents of its next run, from its earlier runs (ODW extension)
                            #   --json for scripts; odw run --estimate prints it and asks y/N first (--yes: just print)
                            #   --agent <label|id>: one agent's whole reply diff; --json for scripts
odw replay $RUN --agent 3   # that one agent() call again, as a new run, at the commit it saw (ODW extension);
                            #   --prompt @file|TEXT, --adapter A, --model M replace its own; prints the compare command
odw run wf.js --break Review  # stop for a decision (a checkpoint) before phase/label "Review"; --step: every phase
odw check wf.js             # does it load? file:line:col, a code frame, portability warnings; exit 0/1
                            #   --capabilities: what it names outside the dialect (process, require, import(, …) and the ODW extensions it calls
                            #   warns of Claude Code's limits: a parallel()/pipeline() over 4,096 items, a meta that is not a pure literal
                            #   hints (never failing): a fan-out's .filter(Boolean), or a list matched on an agent's text, that nothing checks is non-empty
odw run wf.js --help        # what it takes as --args, from its meta.input (ODW extension)
odw eval review             # cases × adapters × repeats: pass rate, cost, time per cell (ODW extension; below)
odw test review             # scripted replies, no model, $0: does the logic hold? (ODW extension; below)
odw run review --dry        # every agent stubbed: the phase tree and agent counts, $0 (ODW extension)
odw new review-swarm        # a built-in template + its starter test in .odw/; odw new lists them (ODW extension; below)
odw notes $RUN              # what its agents told each other on the notes board (ODW extension)
odw list                    # all runs (with a cost column once one reported dollars)
odw list --by me            # the runs one person launched (meta.launchedBy; ODW extension)
odw token add alice --scope approve --file tokens.json  # a named token for odw serve --tokens (ODW extension)
```

Both patterns above behave exactly like this for you: your shell is not a
terminal, so `odw run` detaches and prints the run id. Only a bare invocation
in a human's interactive terminal attaches a live progress view instead
(Ctrl-C there detaches; the run keeps going; `odw attach <run_id>` re-attaches).
Force either way with `-d`/`--detach` or `--fg`, or `ODW_DETACH=1`.

Saved workflows run by name (`odw run <name>`); lookup order:
`.odw/workflows`, `.claude/workflows` — in each directory from the working
directory up to the repository root, nearest first (a monorepo package's own
workflow shadows the root's; `odw workflows where <name>` shows the chain) —
then `~/.odw/workflows`, `~/.claude/workflows`. Workflows that installed, enabled Claude Code plugins
ship run as `odw run <plugin>:<name>` (ODW extension; `odw workflows list
--plugins` lists them): in place, read-only, same dialect. A bare name reaches
a plugin's workflow only when no project or personal one has it — use the
`<plugin>:<name>` form to be sure which runs.

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
odw apply $RUN --all --resolve --verify "<test command>"   # a resolver agent fixes a conflict; applied once verified
odw apply $RUN --all --pr --verify "<test command>"   # a new branch, pushed, and a draft PR (gh); never merges
odw review [--since 7d] [--json]      # kept diffs across runs nobody dealt with yet, riskiest first (ODW extension)
odw review mark $RUN <id|label> reviewed|dismissed|applied|open [--note T]
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
- `--resolve` (ODW extension; `[--adapter A] [--confirm]`) hands a conflict to a
  resolver agent — a run of its own, whose id `odw apply` prints — in a temporary
  worktree; its change is applied only when it edits just the conflicting files,
  leaves no markers and passes the verify command there. Give it `--verify`, and
  tell the user the resolver's run id; `--confirm` asks y/N at a terminal, so
  leave it off when no person is there to answer.
- `odw apply` refuses while a path the diff touches has uncommitted changes —
  commit or stash first; use `--force` only when the user agrees.
- `--pr` (ODW extension; `[--base B] [--remote R] [--ready] [--title T]`) puts the
  diffs on a new branch `odw/<run>-<label>` made in a temporary worktree, one
  commit per agent under the user's git identity, pushes it and opens a draft PR
  with `gh` (or prints the compare URL without `gh`). It never touches the
  working tree and never merges; it pushes, so use it only when the user asked
  for a PR. A conflict or a failed `--verify` stops it before the push.
- A diff cut at `maxDiffBytes` cannot be applied: use the agent's branch
  (`keep: true`, or `"keepBranches": true` in the config).
- `odw review` (ODW extension) is the queue across runs: each kept diff not yet
  reviewed, dismissed or applied, with a deterministic risk score from what the
  run recorded (size, CI/migration/auth/dependency/test/binary paths, `expect`
  misses, scope, background work, destructive git, fallbacks, retries, cost) and
  every point's reason. When the user asks what to look at, start there and quote
  the reasons. `odw apply` marks what it applied cleanly as `applied`; mark the
  rest only when the user decided (`reviewed`, `dismissed`; `open` undoes).

An agent **without** isolation works in the user's own tree. Before a run's
first such agent at `edit` or `full`, odw keeps the tree's uncommitted work —
tracked changes and untracked, non-ignored files — at `refs/odw/safety/<run>`
(ODW extension; a `safety_snapshot` event says so; a clean tree gets none). What
agents run is read for destructive git commands (`git reset --hard`, `git
checkout .`, `git clean -f`, `git push --force`, `git stash drop|clear`, `git
branch -D`, …): each is a `destructive_git` event, and `"destructiveGit":
"fail"` fails the agent with reason `"destructive_git"` once its CLI is done
(default `"warn"`; odw cannot stop the command itself). When one shows up, tell
the user, and put their work back only when they agree:

```bash
odw restore $RUN --check   # preview, file by file, as odw apply does
odw restore $RUN           # put back the working tree the snapshot kept (--force over uncommitted changes)
```

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
- **Someone else's repository: run it `--untrusted`** (ODW extension). Each CLI
  then ignores the repository's CLAUDE.md, hooks, MCP servers and settings where
  its docs give a way (`claude --safe-mode`, `qwen --safe-mode`), and the run says
  once which CLIs cannot (codex still reads AGENTS.md) — prefer `adapter: 'claude'`
  there. The repository's own `worktreeSetup`/`worktreeTeardown` and `.worktreeinclude` links do not
  run. It is not a sandbox: pair it with `--permissions read` for review work.
- **Args that are someone else's text — an issue, a PR, a comment — are untrusted
  input** (ODW extension): `odw run --untrusted-input`, and every run a trigger
  starts. Its agents are read-only unless `--permissions` (or the trigger's
  `permissions`) says otherwise, start with a minimal environment without
  `GH_TOKEN`/`*_API_KEY`-like variables, and the first one that may write waits at a
  checkpoint; without a container sandbox with an allowlist network the run warns
  (`untrustedInput.requireSandbox: true` refuses it). In the script, read
  `workflow.input?.untrusted` and pass such text as `workflow.input.quote(text,
  label)` — a marked data block — never spliced in as instructions. It removes
  capabilities; it does not make a run safe.
- **Need a real boundary? Run agents in a container** (ODW extension):
  `odw run wf.js --sandbox container --sandbox-image <image>`, or `sandbox` in the
  config. Each CLI run and `exec()` step goes in a fresh Docker/Podman container
  holding only its workspace and a copy of the CLI's login. The user builds the
  image (`examples/sandbox/Dockerfile`; ODW never pulls); check with `odw doctor`.
  Agents keep the network (they must reach their model API) — so it guards the
  user's files, not their code from the model — unless `sandbox.network` is an
  egress allowlist (`{ allow: "adapter" }` or a host list; ODW extension): then
  only those hosts, through a proxy outside the container, and each refusal is an
  `egress_denied` event. `agent(p, { sandbox: { network: 'none' } })` may only
  tighten it.

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
  config): when the first CLI's quota is spent, its login is refused, or the model
  it asks for is unavailable (`model_unavailable`), the agent runs again on the next one, at the same permission tier, and the log says so
  (`search:3 → claude after codex quota`). Rate limits are still retried in place.
  After three quota failures in a row on one CLI, the run's later agents skip it.
  `odw agents --json` and the `agent_finished` event name the CLI that produced
  each value (`adapter`) and the ones it left (`fellBackFrom`).
- **Handoff** (**ODW extension**). By default the next CLI starts the work over.
  With `handoff: true` on the call (or the user's `"fallback": { "handoff": true }`)
  it carries on instead: in the same worktree, its prompt starting with a brief of
  what the last one did (`agents/<id>.handoff.md`). Suggest it for long, isolated
  agents whose partial work is worth keeping.
- **Accounts** (**ODW extension**). When the user's config has `accounts`,
  `adapter: 'claude'` already means any of their claude logins — ordered by
  headroom, handing the work over when one runs out — and `'claude@work'` one
  login. Write `adapter: 'claude'`; name an account only when the user asks.
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
user asks for changes to what they approve, send exactly the payload they
approved with `odw approve $RUN --payload @file.json` (`--edit` opens an editor
in a terminal — theirs, not yours). If the
user is not there, leave it waiting: they can answer later from any shell, or
with Approve/Reject in the dashboard (`odw serve`), or from their phone through
the signed one-time approve links a `waiting` notify hook sends while
`odw serve --public-url <url>` runs (ODW extension). Those links are the user's:
never open, follow or POST to one yourself.

`odw run --wait` blocks while a checkpoint waits. Start a workflow with
checkpoints detached (`RUN=$(odw run wf.js)`) and poll `odw status $RUN`, or
bound the wait with `--wait --timeout <s>`. `odw resume` replays finished
agents but asks every checkpoint again.

**Agent questions (ODW extension).** An agent that stops to ask the user (Claude
Code's `AskUserQuestion`) is stopped at the question, never left to guess. By
default (`questions: "checkpoint"`) the question waits like a checkpoint —
`odw status $RUN` shows it as "an agent asks" with its options — and the answer
reruns the same call, told it. The same rule holds: **relay the question to the
user and answer only with their words** — `odw approve $RUN --checkpoint N --note
"<their answer>"`; `odw reject` declines and the agent fails with reason
`needs_input`. For unattended runs prefer `agent(prompt, { questions: "deny" })`
(no question tool; the agent assumes and says so) or `"fail"` (reason
`needs_input`), and put what an agent would ask in its prompt.

**Cost gates (ODW extension).** Before a big fan-out, rather than a checkpoint of
your own, a `costGate` asks only when it matters: with `"costGate": { "usd": 5 }`
in the config, or `parallel(thunks, { costGate: { usd: 5 } })` (or an `agent()`'s
`costGate` for one expensive agent), a fan-out forecast — from earlier runs of the
same workflow — to cost more than that waits at a checkpoint (`This fan-out is
forecast to cost ~$X (p90 $Y) — go?`). A rejection throws `CostGateRejected`;
catch it (`e.name === 'CostGateRejected'`) to go on without that fan-out. Without
history the gate lets everything through. Before suggesting a large run, show the
user `odw estimate <wf>` — it never guesses: with no finished runs it says so.

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
- One morning message instead of one per run: `odw schedule add <name> --digest
  [--cron EXPR]` sends `odw digest --since-last --notify` (cron defaults to the
  config's `digest.cron`; refused unless `notify.on` lists `"digest"`).

### Run on the user's own server (ODW extension)

When the user wants a run to go on while their laptop sleeps, start it on a
machine they own over plain ssh (no daemon). Only with a host they name.

```bash
RUN=$(odw run review --on ssh://me@box)          # sync the project, start there detached, print the run id
odw status $RUN --on ssh://me@box                # status|logs|attach run on the remote odw
odw approve $RUN --on ssh://me@box               # so do approve|reject|pause|stop|resume
odw pull $RUN --from ssh://me@box                # copy it here (again while it runs) for diff/apply/compare
```

- A pulled copy (`origin: "remote"`) is a snapshot: answer or control the run
  where it runs, with `--on`. Locally, `odw approve|reject|pause|stop|resume`
  refuse it and name that command.

- The remote needs odw on the PATH of a non-interactive ssh session, its own
  odw config and its own agent CLI logins: nothing of the user's config or
  logins is copied. Missing odw is reported with install hints.
- `--sync git` (default) sends a git bundle of HEAD plus a patch of every
  uncommitted change (untracked included, ignored left out); `--sync rsync`
  mirrors the directory. The workdir is `~/odw-remote/<repo>` unless the URL
  has a path (`ssh://box/~/work/app`); odw refuses a non-empty directory it
  did not make.
- `--config`, `--runs-root`, `--wait`, `--fg`, `--timeout` are refused with
  `--on`; `--args`, `--adapter`, `--permissions`, `--untrusted`, `--sandbox`,
  `--budget`, `--deadline` go along (`--args` as a file on stdin, never on a command line).
- A pulled run is marked `origin: "remote"`; until it ends there, the local
  copy is a snapshot that reads as stale — pull again to refresh it.

### Start runs from webhooks, or in CI (ODW extension)

- **Signed triggers.** The config's `"triggers": { "<name>": { workflow, verify:
  "github"|"linear"|"slack"|"hmac-sha256", secretEnv (or secret), args: { key:
  "$.json.path" }, events?, dedupe?, concurrency?, rateLimit?, untrusted?,
  permissions?, approve? } }` make `odw serve` answer `POST /api/triggers/<name>`:
  a webhook whose signature checks out starts that workflow — `--untrusted` and
  with untrusted input (read-only agents unless `permissions`; a checkpoint before
  the first that may write unless `approve: false`) unless the trigger says
  `"untrusted": false` — and gets `202 { runId }`. The run's `context` (trigger,
  event, issue id and URL, repo, Slack channel and thread) reaches the `notify`
  hooks (`context` in the payload; `ODW_TRIGGER`, `ODW_EVENT_ID`,
  `ODW_EVENT_URL`, `ODW_CONTEXT` for a command), so a hook can answer on the
  issue. Set this up only when the user asks; the secrets are theirs to place in
  environment variables, never in a committed file. Triggers go in the user's
  own config (`~/.config/odw/config.json`, or `--config`): `odw serve` refuses
  those of a repository's `./odw.config.json`, and a tunnel to a loopback bind
  needs `--public-url <tunnel URL>`.
- **GitHub Actions.** `uses: xz1220/open-dynamic-workflows/action@<tag>` with
  `workflow:` and `timeout-minutes:` (the job's) runs `odw run --wait
  --deadline` a margin before the job times out, writes the receipt to the job
  summary and uploads `odw bundle`; `apply-pr: true` opens a draft PR. See
  `docs/github-action.md` in the repository.

### Evaluate a workflow (ODW extension)

To check a workflow still does its job after a prompt, model or CLI change —
on each adapter, several times — write an eval file and run `odw eval`. Every
run costs what a normal run costs: confirm the cases × adapters × repeats
with the user first.

```bash
odw eval review                                    # .odw/evals/review.json (or a path to any .json)
odw eval review --adapter claude,codex --repeats 3 # override the file's adapters and repeats
odw eval review --json --out base.json             # the report as JSON; also kept under <runsRoot>/_evals/
odw eval review --baseline base.json               # deltas per cell; exit 1 when a pass rate fell
```

```json
{ "workflow": "review", "adapters": ["claude", "codex"], "repeats": 3, "concurrency": 2, "timeout": 900,
  "cases": [{ "name": "small-diff", "args": { "diff": "…" },
              "checks": [{ "state": "done" }, { "path": "verdict", "equals": "approve" }, { "maxCostUsd": 0.5 }] }] }
```

- Checks need no model: `{ path, equals | contains | matches | exists }` on the
  run's result (`findings[0].file`; `""` is all of it), `{ command }` (exits 0;
  `ODW_RESULT` names a file with the result JSON, `ODW_RUN_ID` the run),
  `{ state }`, `{ maxCostUsd }`, `{ maxSeconds }`. No checks means
  `{ "state": "done" }`.
- Each case × adapter × repeat is a real run marked `origin: "eval"`; the table
  gives pass k/n, median time, cost and tokens per cell, then each failure with
  its check and run id (open two with `odw compare`). Exit 0 all passed (or,
  with `--baseline`, nothing regressed), 1 otherwise, 2 for a usage error.
- The whole file format and report: [`references/primitives.md`](references/primitives.md#odw-eval-odw-extension).

### Test a workflow (ODW extension)

To check a workflow's logic without paying a model — after editing it, or
before its first real run — script its agents' replies and run `odw test`.
It runs the real runtime (schema retries, fallbacks, the run store); only the
agent CLIs are replaced by a built-in mock. A test costs $0: no need to ask.

```bash
odw test review-swarm                     # .odw/tests/review-swarm.json (or a path); no name: every file there
odw test review-swarm --case 2 --json     # one case, by number or name; the report as JSON
odw run review-swarm --dry                # every agent gets a stub: the phase tree and agent counts, $0
odw run review-swarm --record             # a real (paid) run, kept as a test case to replay for $0
```

```json
{ "workflow": "review-swarm",
  "cases": [{ "name": "one finding", "args": { "lenses": ["correctness"] },
              "replies": [{ "label": "map", "reply": { "summary": "s", "files": [] } },
                          { "label": "review:*", "reply": { "findings": [] }, "schemaMiss": 1 },
                          { "label": "verify:*", "fail": "rate_limit" }],
              "default": { "dry": true },
              "expect": { "checks": [{ "path": "rejected", "equals": 0 }], "agents": { "count": 2 }, "logs": ["0 candidate"] } }] }
```

- A reply entry matches by `label` / `phase` (globs), `prompt` (substring),
  `adapter`; the first match answers with `reply` (text, or JSON for a schema
  call), `fail` (`rate_limit`, `quota`, `auth`, `permission`, `timeout`,
  `stalled`, `not_found`, `exit`), `empty: true` or `dry: true`; `schemaMiss:
  N`, `delayMs`, `once: true` modify it. An agent nothing matches fails the case
  ("unscripted agent `x`") unless a `default` entry answers it.
- `expect`: `state` (default "done"), `error`, `checks` (`odw eval`'s), `agents:
  { count, labels }`, `logs` (substrings, in order). Exit 0 all passed, 1 any
  failed, 2 usage.
- `--dry` stubs are `"(dry run)"` or a schema's smallest valid value; the run is
  marked `dry: true`. `--record` costs what a normal run costs — confirm first.
- The whole format: [`references/primitives.md`](references/primitives.md#odw-test-odw-extension).

### Start from a template (ODW extension)

When the user's task matches a built-in template, start from it instead of a
blank file: `odw new` lists them (hello, review-swarm, fix-until-green,
plan-approve-execute, pr-shepherd, fan-out-reduce), and `odw new <template>
[--name N]` writes `.odw/workflows/<name>.js`, a starter test
`.odw/tests/<name>.json` that `odw test <name>` passes at once, and for
review-swarm and pr-shepherd an eval skeleton `.odw/evals/<name>.json`. Edit
the workflow and its test together; `odw test` and `odw run <name> --dry` cost
$0, so no need to ask before them.

- It refuses to overwrite a file with other content (exit 1, nothing written)
  unless `--force` — ask the user before passing it.
- In a git repository without a `.worktreeinclude` it prints a suggested one
  (`.env*` files, `symlink:` lines for dependency directories) and writes it
  only with `--yes`: show it to the user and ask first.
- `odw init` at a human's terminal ends by offering `odw new hello` and
  `odw run hello --dry`; in your shell it only prints those commands.
- Details: [`references/primitives.md`](references/primitives.md#odw-new-odw-extension).

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
`odw doctor --models` (ODW extension; also ask first: one tiny prompt per pair)
probes every adapter/model pair the config's `models` tiers, `fallback` chains,
default adapter and `.odw/workflows` phases name, and reports `ok`,
`model_unavailable` (the CLI does not know the model, retired it, or does not
offer it to the account) or `other` for each — run it when agents fail with
`model_unavailable`. A run whose CLI version or requested models changed since the
workflow's last run logs `drift: …` lines and carries a `drift` field in its summary
(ODW extension); if the workflow has an eval, suggest `odw eval <name> --baseline
<last report>` (the line names it), or `"driftEval": true` to have it start by itself.
When phases route to a local model (Ollama, LM Studio — through `opencode`, `codex
--oss` or a custom adapter; there is no built-in `ollama` adapter), run `odw doctor
--local [--endpoint URL] [--model M]` (ODW extension, read-only): it reports each
loaded model's context — a warning under 32K, with how to set `OLLAMA_CONTEXT_LENGTH`
— and tool calling. Its `--smoke` sends a ~10K-token prompt to that local server
only (never a cloud model) and fails when the instruction at its end is not followed,
the silent front-truncation that otherwise passes as an agent "working"; ask first,
it runs the model.

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
  agent (both ODW extensions); a `worktreeTeardown` runs before the worktree
  goes — success, failure or stop — and each isolated agent gets `$ODW_SLOT`
  (`odw-<run>-<agent>`, its default `COMPOSE_PROJECT_NAME`) for a compose stack
  or database of its own (ODW extensions).
- **Ports**: every agent process gets a unique `$ODW_PORT` (with `$ODW_RUN_ID`
  and `$ODW_AGENT_ID`) — tell parallel agents "start the dev server on
  `$ODW_PORT`" so they never collide, and to stop the server before finishing
  (an agent CLI may wait for its background commands before exiting) (ODW extension).
- **Rate limits**: a rate-limited CLI is retried after a backoff (honoring its
  retry-after); a spent quota, a failed login or a model the CLI does not have
  (`model_unavailable`) is not retried — the agent fails
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
  `odw logs`, saved results (`odw result --agent`), the run's error, webhooks,
  `worker.log` (a `console.log` in the workflow included), Chat Host sessions —
  shows likely secrets as `«redacted:<kind>»` (`env:NAME` for a secret-named
  variable's value, else the token's kind). The agents and the workflow still
  got the real text; only what was written down is redacted, so a marker in
  `odw logs` is not the agent's mistake. A resumed run replays a redacted
  result as kept: never let a later step depend on a secret an agent printed —
  read it from the environment. The run's own result keeps variables' values
  (only token shapes are redacted there), and so do the run's `args` as kept —
  the dashboard and API show their token shapes redacted, `odw rerun` uses the
  originals; `"redact": false` turns it off.

## Common mistakes

| Mistake | Correction |
| --- | --- |
| Importing primitives or other modules in the script | Primitives are injected globals; any extra top-level `import`/`export` is rejected by the loader. |
| Reaching for `process`, `require`, `fetch`, `console` or timers in a script | Not in the dialect: Claude Code gives a bare ECMAScript realm, and so does ODW's strict script context (`scriptContext: "strict"`, ODW extension) — the default for triggered, plugin and untrusted runs, where such a name fails the run with a message saying so. Pass data in `args`, log with `log()`, let an agent fetch; `odw check --capabilities` lists what a script names. `vm` is not a security boundary. |
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
| Running agents on a repository you did not write as if it were the user's | `odw run --untrusted` (ODW extension): `claude --safe-mode` and the like keep its instructions, hooks and settings out; the run logs which CLIs cannot. |
| Giving one CLI's model id to agents that may run on another (a phase default, a fallback chain) | Model ids do not cross CLIs: use a tier, `model: '@fast'`, which picks each CLI's own id (ODW extension). |
| Letting a long agent run unbounded, or retrying one that failed with reason `runaway` as if it were flaky | Give it `limits: { toolCalls, costUsd, repeat: 5 }` (or `agentLimits` in the config): odw kills an agent stuck repeating the same tool call or past its caps at once (ODW extension). A `runaway` failure's `limitHit` says what it was doing — change the prompt or the task, don't just raise the limit. |
| Fanning out wide without watching what it spends | `odw status $RUN` shows the run's tokens and cost so far, phase by phase, and a `parallel()`/`pipeline()` wider than `fanOutWarn` (default 25) logs a warning (ODW extensions). Size fan-outs to `budget.total` when one is set; `--budget` caps output tokens. |
| Taking `args` on faith, or a list that arrived as a string of JSON | Declare `meta.input` (a JSON Schema; ODW extension, Claude Code ignores it): odw checks `args` before the run starts, names each path at fault, and calls a string of JSON "encoded twice". `odw run wf.js --help` prints it. |
| Going on with a fan-out that came back mostly `null` | Every `parallel()`/`pipeline()` logs its ok / failed / null counts (`fanout_done`), and a line when most are null; `parallel(thunks, { minOk: 0.8 })` (or a count, or `"all"`) throws a `FanOutShortfall` instead (ODW extensions). `odw check` hints at a `.filter(Boolean)` or an agent-text match whose emptiness nothing checks. |
| Hand-writing a cron line around `odw run` | `odw schedule add` writes it with an overlap lock, a log and a pinned `PATH` — and only on the user's request: it edits their crontab or LaunchAgents. |
