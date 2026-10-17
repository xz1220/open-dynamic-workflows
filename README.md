<div align="center">

<img src="assets/odw-logo.png" alt="Open Dynamic Workflows logo" width="128" />

# Open Dynamic Workflows

**Dynamic workflows for coding agents.** An open runtime that turns Codex, Claude Code,
Gemini, Qwen, Kimi, Oh My Pi, Kilo Code, OpenCode, and Cursor into orchestrated
fleets — same scripts as Claude Code's own Workflow tool, plus a live web dashboard.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A520-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](tsconfig.json)
[![tests](https://github.com/xz1220/open-dynamic-workflows/actions/workflows/ci.yml/badge.svg)](https://github.com/xz1220/open-dynamic-workflows/actions/workflows/ci.yml)
[![runtime deps](https://img.shields.io/badge/runtime%20deps-0-blue.svg)](package.json)

[English](README.md) · [简体中文](README.zh-CN.md)

</div>

---

**Open Dynamic Workflows (ODW)** is a TypeScript / Node CLI runtime for
portable dynamic workflows: JavaScript scripts that fan out coding agents with
`agent()`, `parallel()`, and `pipeline()` outside the host agent's context. If
you are looking for an open dynamic workflow engine for Codex, Claude Code,
Gemini, Qwen, Kimi, OMP, Kilo, OpenCode, Cursor, or a custom CLI, this is the project.

A **dynamic workflow** is a small JavaScript script that holds an orchestration
plan in ordinary code and dispatches coding-agent CLIs *at scale* — outside the
host agent's own context. You write the script (or hand it one), a runtime runs
it in the background, and only the final result comes back. Claude Code can
already do this inside its own private runtime; ODW makes the **same scripts**
portable to any agent, so the workflows the Claude Code ecosystem is already
producing become artifacts you can run anywhere.

<div align="center">

<a href="videos/odw-demo/odw-product-demo.mp4">
  <img src="assets/odw.gif" alt="Watch the ODW product demo — fan coding agents out across a live workflow and watch it run" width="720" />
</a>

<sub><b><a href="videos/odw-demo/odw-product-demo.mp4">▶ Watch the 33-second demo with sound</a></b> — author a workflow, fan agents out, and watch the run light up live.</sub>

</div>

## Why orchestrate at all?

Letting one agent grind in its own context tops out fast. Each row is a failure
mode you have probably met; each mechanism is a runnable pattern in this repo:

| One-agent failure mode | The dynamic-workflow answer |
| --- | --- |
| **Self-review bias** — the author grades its own work | Cross-CLI adversarial review: one adapter implements, a different one refutes ([`adversarial-verify.js`](examples/adversarial-verify.js), [`codex-claude-loop.js`](examples/codex-claude-loop.js)) |
| **One-shot quality lottery** | N approaches compete, pairwise judging picks a survivor ([`tournament.js`](examples/tournament.js)) |
| **Serial waiting** | `parallel()` fans subtasks across dozens of agent processes under a bounded semaphore ([`fan-out-reduce.js`](examples/fan-out-reduce.js)) |
| **Context pollution** — long work trashes the host agent's window | Runs are detached background workers; only the final `return` value comes back |
| **Invisible long runs** | Every run is a live DAG — browser dashboard or `odw logs --follow` |

## Highlights

- **Portable** — run the *same* workflow script on Codex, Claude Code, Gemini,
  Qwen, Kimi, OMP, Kilo, OpenCode, Cursor, or your own CLI. Switch adapters — or
  mix them per phase, and fall back to another CLI when one runs out of quota.
- **Claude-style workflow primitives** — `export const meta` + injected
  `agent` / `parallel` / `pipeline` / `phase` / `log` / `args` / `budget` /
  `workflow` globals (nested workflows included), with top-level `await` and
  `return`. Port scripts against the supported behavior in the
  [compatibility checklist](#compatibility-and-migration).
- **A live observatory with Chat Host** — talk to Codex in the browser, mention
  ODW or workflow to attach an asynchronous run, and watch CLI-launched jobs as
  live DAGs without polluting the host agent's context.
- **Out of context, at scale** — the plan lives in code, so intermediate work
  never pollutes the host's context and you can fan out dozens of subagents.
- **Reliable hand-offs** — JSON-Schema structured outputs, validated and retried,
  so multi-stage pipelines compose instead of guessing on free text.
- **Background & observable** — every run is a detached worker backed by a run
  directory: `status`, `logs --follow`, `result`, `pause` / `stop`, and
  `approve` / `reject` for a run that waits at a human `checkpoint()`.
- **No threads, zero runtime dependencies** — the engine is async TypeScript
  (`parallel` is `Promise.all`); workflow scripts stay plain `.js` and ship with
  `.d.ts` authoring types for editor autocomplete.

## Why not just use Claude Code's built-in Workflow tool?

Claude Code can already run dynamic workflows — but only inside its own private
runtime, for Claude Code itself. ODW makes the **same scripts** portable and
standalone:

- **Any agent, same script** — run a workflow on Codex, Gemini, Qwen, Kimi, OMP,
  Kilo, OpenCode, Cursor, or your own CLI, not just Claude Code. Switch the
  underlying agent by switching adapters.
- **Out of band** — runs are detached background workers backed by a run
  directory, so you can `status` / `logs --follow` / `pause` / `stop` them and
  watch from the browser — independent of any host agent session.
- **Portable artifacts** — the workflows the Claude Code ecosystem is already
  producing become files you can version, share, and run anywhere.

## Install

The whole install is **a binary + a skill** — no Node, no npm, no PATH
gymnastics, no global-module conflicts. Pick whichever path fits.

### 1. Let your AI agent install it

ODW is built for coding agents, so the easiest path is to let yours do it. Paste
this to your agent (Claude Code, Codex, Gemini, …):

> Install Open Dynamic Workflows for me: run
> `curl -fsSL https://raw.githubusercontent.com/xz1220/open-dynamic-workflows/main/scripts/install.sh | sh`
> to put the `odw` binary on my PATH and the workflow skill in your skills
> directory, then run `odw --version` to confirm. From now on, when a task is big
> enough to fan out, write an ODW workflow and run it with `odw run`.

It runs the script, picks up the [skill](skills/open-dynamic-workflows/SKILL.md), and can author and run
workflows immediately.

### 2. One-command script

```bash
curl -fsSL https://raw.githubusercontent.com/xz1220/open-dynamic-workflows/main/scripts/install.sh | sh
```

Downloads the prebuilt binary for your platform (gzipped, ~35 MB) to
`~/.local/bin/odw` and installs the skill into `~/.claude/skills/` (falling back
to `~/.codex/skills/`). No Node required. `latest` resolves to one release tag;
the binary and skill both come from that tag. All downloads and the new binary
are validated before replacing an existing installation, with rollback if the
replacement fails. The binary must match the release's `SHA256SUMS` (releases up
to v0.5.0 predate it and install with a warning; for newer ones a missing list
aborts unless `ODW_ALLOW_UNVERIFIED=1`). Override the destination with
`ODW_BIN_DIR`, or pin a release with `ODW_VERSION=v0.4.0`. `ODW_REF` explicitly
overrides the skill's source ref for custom deployments; the default keeps it
matched to the binary.

### 3. Manual

Prefer not to pipe `curl` into `sh`? Grab the asset for your OS/arch from
[Releases](https://github.com/xz1220/open-dynamic-workflows/releases), then:

```bash
# a) the binary — check it against the release's SHA256SUMS, then onto your PATH
grep ' odw-darwin-arm64.gz$' SHA256SUMS | shasum -a 256 -c   # or: sha256sum -c
gunzip odw-darwin-arm64.gz && chmod +x odw-darwin-arm64
mv odw-darwin-arm64 ~/.local/bin/odw

# b) use the SAME release for the skill (set this to the version you downloaded)
ODW_TAG=v0.4.0
git clone --branch "$ODW_TAG" https://github.com/xz1220/open-dynamic-workflows.git
skill_source=open-dynamic-workflows/skills/open-dynamic-workflows
[ -d "$skill_source" ] || skill_source=open-dynamic-workflows/skill
cp -r "$skill_source" ~/.claude/skills/open-dynamic-workflows
```

Or, **once `odw` is published to npm** (not yet — see [Develop](#develop)) and you
have Node ≥20, `npm i -g odw` will put `odw` on your PATH (you'd still do step *b*
for the skill). For now, use the binary above.

> The on-disk binary is ~110 MB — almost entirely the embedded Node runtime, like
> any Node→binary tool — but the download is gzipped to ~35 MB. The agents ODW
> *drives* (`claude`, `codex`, …) remain their own CLIs you install separately.

## Quick start

This README describes current source. For a released binary, use its bundled
skill and `odw --help`; to use unreleased features, build from source as described
under [Develop](#develop).

One CLI installed (just `claude`, or just `codex`)? Zero config — skip ahead.
Several? The installer already asked you to pick a default; `odw init` re-opens
that choice anytime (agents use `odw init --adapter <name>` after asking you).
`odw doctor` checks the setup — runtime, config, run directory, every adapter —
and `odw doctor --smoke` sends your default adapter one real prompt, catching a
CLI that installs fine but blocks on a login or approval prompt when headless.

ODW is mostly driven **by your coding agent**, not by hand. With the skill and
binary installed, just ask your agent for something big — it writes a workflow and
runs it for you, out of its own context:

> **You → your agent:** *"Use Open Dynamic Workflows to deep-research X vs Y and
> write me a cited report."*
>
> **Your agent** (it picked up the ODW skill) writes a workflow script and runs
> `odw run research.js --wait`, then hands back the report — dozens of searches
> and a fact-check pass ran in the background, never touching its context.

That's the whole point: the agent keeps a clean context and fans the heavy work
out to ODW.

**Running `odw` yourself** — or authoring a custom workflow — is the same one
command. A workflow is plain JavaScript in Claude Code's dialect, e.g.
`fan-out-reduce.js`:

```js
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
# from this repo's root (the script ships in examples/); any path works
odw run examples/fan-out-reduce.js --wait --args '{"question": "Design a rate limiter."}'
```

The flagship [`examples/deep-research.js`](examples/deep-research.js) (fan-out web
research → adversarial fact-check → cited report) is exactly such a script. Its
battle-tested sibling [`deep-research-verified.js`](examples/deep-research-verified.js)
(validated at 100 agents / ~9 min on the codex adapter) ships with a cron-ready
wrapper — see [`docs/recipes/deep-research-verified.md`](docs/recipes/deep-research-verified.md).

## The primitives

A workflow is `export const meta = {…}` followed by a script body that runs in an
async context. The body composes these **injected globals** with ordinary JS
control flow (loops, `if`, dedup) — no imports:

| Primitive | Role |
| --- | --- |
| `agent(prompt, opts?)` | Run one coding agent on a subtask. The only verb that does work. Returns its text, or a validated object when `opts.schema` is set. With `opts.expect` its work is checked — a command exits 0, files changed, the reply matches — and retried, told what it missed; see [Check an agent's work](#check-an-agents-work-odw-extension) (**ODW extension**). |
| `parallel(thunks)` | Run a batch concurrently and wait for all of it (**barrier**). Recoverable failures become `null`; stop, budget, and dispatch-limit errors abort the run. |
| `pipeline(items, ...stages)` | Stream each item through the stages independently (**no barrier**). Each stage gets `(prev, item, index)`. |
| `phase(title, opts?)` / `log(msg)` | Group progress under a phase / emit a progress line. `opts` — `{ adapter, model }` — gives the phase's agents an adapter and a model (**ODW extension**; see [per-phase adapters](#per-phase-adapters-model-tiers-and-fallback-chains-odw-extension)). |
| `schema` (JSON Schema) | A typed output contract for `agent`; the reply is validated and retried until it conforms. A keyword ODW cannot check is reported in the run's log (or, with `"schemaKeywords": "strict"`, fails the call), and CLIs that validate schemas (`claude`, `codex`) enforce it natively — see [Structured output](#structured-output-odw-extension). |
| `args` | The workflow's input, injected verbatim. |
| `budget` | `{ total, spent(), remaining() }` — scale depth to a token target. |
| `workflow(ref, args?)` | Run another workflow inline (one level deep). The child shares this run's concurrency cap, agent counter, and budget; its phases group as their own DAG lanes. |
| `validate(source)` | Parse and compile-check trusted source without running its workflow body. Metadata is parsed as a pure literal, never evaluated. **ODW extension** (not in Claude Code's dialect). |
| `exec(command, opts?)` | Run a command — tests, a build, a linter — without launching a model; resolves to `{ stdout, stderr, exitCode, signal, timedOut, truncated, durationMs }`. A string runs through the shell, an array as argv. Bounded by `timeout` (600 s) and `maxOutputBytes` (8 MiB per stream); a stop kills it. Takes no agent slot. **ODW extension** (not in Claude Code's dialect). |
| `checkpoint(title, opts?)` | Pause the run until a person approves or rejects — from `odw approve\|reject` or the dashboard — and resolve to `{ approved, note, by }`. `opts`: `payload` (what to look at), `timeout` (seconds) and `onTimeout` (`"approve"`, `"reject"`, or the default `"fail"`). Takes no agent slot; a stop still ends the run. See [Human checkpoints](#human-checkpoints-odw-extension). **ODW extension** (not in Claude Code's dialect). |

Use **`parallel`** when the next step needs the whole batch at once (dedup,
tally, synthesis); **`pipeline`** for multi-stage work (the default). Keep
reductions order-independent — branching on *which agent finished first* breaks
reproducibility. Full reference: [`skills/open-dynamic-workflows/references/primitives.md`](skills/open-dynamic-workflows/references/primitives.md).

### Check an agent's work (ODW extension)

A headless agent can "succeed" without doing the work: it says it fixed the bug
and never touched a file, or that the tests pass while they are still red. Rather
than asking the model whether it did it, say what must hold — odw checks it once
the agent has replied (and its `schema`, if any, validated):

```js
const summary = await agent('Fix the failing tests in src/parser.', {
  expect: {
    command: 'npm test',        // must exit 0 in the agent's workspace (timeout: 600 s)
    changes: true,              // some file must change (false: none may)
    files: ['src/parser/**'],   // each glob must match a file it changed or created
    match: '^Fixed',            // a regular expression the reply must match
  },
})
```

Work that misses runs again — once by default (`expectRetries`, per call or in
the config) — with what it missed appended to its prompt, a failed command's
output included. If it still misses, `agent()` throws a recoverable error (a
`null` slot in `parallel()`) carrying `reason: "unmet_expectation"` and `misses`,
one line per check — as do its `agent_failed` event, `odw logs`, the live view
and `/api/runs/:id`:

```text
agent_failed    (Fix) fixer — [unmet_expectation] did not meet: `npm test` must exit 0, and it exited with code 1
```

- **What the agent changed** is read from git, relative to its workspace. In
  place, it is what differs from the source tree as it was before the agent
  started — your own uncommitted edits and odw's run directory are left out, the
  agent's commits count — so edits another in-place agent makes meanwhile count
  too: isolate when that matters. With `isolation: "worktree"`, it is the change
  odw keeps as the agent's diff, and a retry starts over in a fresh worktree
  whose change replaces the earlier one.
- **The command** runs as an `exec()` step under the agent (its events carry
  `forAgentId`), after the change is read, so what it writes is never the
  agent's work; a stop kills it.
- **Refused tool calls count as a miss.** Under the default `edit` tier, Claude
  Code refuses headless every shell command that is not allowlisted; with
  `expect` set, a reply whose `result` lists `permission_denials` is handed back
  like any miss, then fails with `reason: "permission"`, naming the refused
  calls. Without `expect` the reply stands — see below.
- **Without opting in:** an empty reply fails with `reason: "empty_reply"`
  (`allowEmpty: true` accepts one). A reply that stood though the CLI refused it
  tool calls keeps them as `denied` on the agent's `agent_finished` event, its
  saved result and `/api/runs/:id`, and the run logs one line:
  `search:3: Claude Code refused 2 tool calls — Bash (npm test); …; its reply may
  rest on work it could not do (raise its tier with --permissions or allowlist
  the tool)`. `"permissionDenials": "fail"` (or an adapter's own
  `permissionDenials`) fails such agents with `reason: "permission"` instead.

Claude Code's Workflow tool ignores `expect`, so there the checks do not run.
[`examples/fix-until-green.js`](examples/fix-until-green.js) lets `expect` run a
fix-until-the-tests-pass loop.

## Compatibility and migration

ODW implements the primitive surface below. Scripts that depend on a host's
private runtime behavior need the following checks before migration:

| Feature | ODW behavior and migration check |
| --- | --- |
| Nested `workflow()` | Implemented for one level, sharing the parent's scheduler, control and budget. Flatten deeper nesting. |
| Model selection | Pass `agent(..., {model})` using that CLI's model ID; an adapter without model routing support emits a note. A `meta.phases` entry's `model` (and `adapter`) is the default for its phase's agents, and `model: "@fast"` picks a tier's model per CLI — **ODW extensions** (see [per-phase adapters](#per-phase-adapters-model-tiers-and-fallback-chains-odw-extension)); a phase's model is a model ID like any other, so use a tier when its agents may run on more than one CLI. `meta.model` stays metadata. |
| `agentType` | A persona added to the prompt. It does not load a host's named subagent configuration or select an adapter. |
| Worktree isolation | Starts from committed HEAD, excludes uncommitted edits, and cleans up afterward. Changes are not merged and `agent()` returns the reply, not a diff; ODW keeps each isolated agent's change as a diff to review and apply (`odw diff`, `odw apply`, `keep` branches — ODW extensions; see [Review and apply](#review-and-apply-what-isolated-agents-changed-odw-extension)). `.worktreeinclude` is honored (ODW copies untracked files too, not only gitignored ones); its `symlink:` lines, `worktreeSetup` and the agents' `ODW_PORT` are ODW extensions — see [Isolated worktrees](#isolated-worktrees-and-agent-ports). |
| Budget | Counts output tokens: the CLI's own count where its adapter reports usage (the built-in `claude` does — see [Usage and cost](#usage-and-cost-odw-extension)), else `ceil(chars / 4)` of each reply. Every CLI run counts: schema and rate-limit retries, and failed runs that reported usage. The guard runs before each dispatch and each schema retry; once the target is spent the run ends and agents still running are stopped. |
| JSON Schema | ODW checks the [documented subset](skills/open-dynamic-workflows/references/primitives.md#schema); `format` is an annotation. Any other keyword (`$ref`, `const`, `oneOf`, `maxItems`, …) still runs: the run's log names it and where it is, and a CLI that validates schemas itself (`claude`, `codex`) enforces it. `"schemaKeywords": "strict"` refuses such calls instead (ODW extension; see [Structured output](#structured-output-odw-extension)). Use explicit object/array types and supported constraints. |
| Script trust | Run trusted scripts only: a run executes the workflow body as ordinary JavaScript. Loading parses metadata as a pure literal without evaluating it; validation and compatibility warnings are not a sandbox. |
| Recovery | Every completed `agent()` result is saved as it lands. `odw resume` continues a paused live worker in place; on an ended run (done, failed, stopped, or stale after a crash) it starts a new run that replays each call whose prompt and options are unchanged and runs the rest. `rerun` starts over. See [Resume a run](#resume-a-run-odw-extension). |

The supported primitive names do not guarantee full runtime parity.
`validate(source)`, `exec(command)` and `checkpoint(title)` are ODW extensions and
must be removed when targeting a host that does not provide them (`validate()`
warns about `exec()` and `checkpoint()` calls). Recoverable `null` results require an explicit choice: accept a partial
result, retry, or fail when the task requires every item.

## Run and observe

In an interactive terminal, `odw run` attaches a **live foreground view** — every
agent (and `exec()` command step, shown with a `$` prompt) as it starts, spins, and
settles, phase by phase, with the result printed at the end. Ctrl-C detaches (the run keeps going); `odw attach <id>` re-attaches.

```bash
odw run wf.js [--args JSON|@file]            # foreground in a terminal; run keeps its own worker
                                             #   --adapter <name> sets this run's default agent
                                             #   --permissions read|edit|full: what its agents may do
                                             #   --budget <tokens> sets budget.total
```

The run itself always executes in a detached background worker. Anywhere your
shell is not a terminal — `$(…)` capture, pipes, cron, CI, another agent — the
same command detaches and prints the run id, exactly as before (fire-and-poll):

```bash
RUN=$(odw run wf.js)     # non-TTY: prints the run id and returns immediately
odw attach $RUN          # live view (or plain lines when piped); --timeout <s> exits 124
odw status $RUN          # state, agent count, tokens and cost
odw agents $RUN          # each agent and its saved result, mid-run too
odw logs $RUN --follow   # stream raw progress events
odw logs $RUN --agent 3  # what one agent did: its tool calls, results and text (below)
odw result $RUN          # final value
odw diff $RUN --stat     # what isolated agents changed; odw apply $RUN --agent N applies one
odw pause|resume|stop $RUN
odw approve|reject $RUN  # answer a checkpoint() the run waits at (--note TEXT, --checkpoint N)
odw list
```

`--fg` / `-d, --detach` / `--wait` (block, then print the result; a single
run-id line on stderr) force a mode explicitly; `ODW_DETACH=1` forces
background from the environment.

A run executes in a detached worker process and persists everything to a run
directory, so it outlives the command that started it and can be observed from
anywhere. Sending that worker SIGTERM, SIGINT or SIGHUP stops the run just like
`odw stop` — its agents and everything they started are killed, their worktrees
removed, and the run is recorded stopped; a second signal, or the run not ending
within 10 seconds, makes the worker exit at once.

Saved workflows can also be run by name. ODW searches project workflows first,
then personal workflows, across both its own directories and Claude Code's saved
workflow directories: `.odw/workflows`, `.claude/workflows`, `~/.odw/workflows`,
and `~/.claude/workflows` (honoring `CLAUDE_CONFIG_DIR`).

**Prefer a browser?** `odw serve` opens a zero-dependency live dashboard onto the same
run directory — every run as a live graph, its timeline, logs and result, streamed over
SSE. No build step, no extra deps, no network access on load.

```bash
odw serve [--open]                      # live dashboard at http://127.0.0.1:4317
odw serve --port 8080 --host 0.0.0.0    # custom port / bind address
```

![odw serve — a live deep-research run: five phase lanes (Plan → Search → Extract → Vote → Report) drawn as a graph, running agents tracing signal along their edges, per-run counters and a phase stepper](assets/odw-dashboard.gif)

### Resume a run (ODW extension)

Each `agent()` result is saved to the run directory (`agents/<agentId>.json`)
the moment that agent finishes — before its `agent_finished` event — so a lane
that hangs, a stop, or a dead worker never costs you the work already done. Read
it while the rest of the run is still going:

```bash
odw agents $RUN              # every agent: id, state, label, phase, adapter, time, ↺ replayed, value preview
odw agents $RUN --json       # the same rows for scripts
odw result $RUN --agent 3    # one agent's saved value as JSON (by id, or --agent <label>)
odw resume $RUN              # a new run that replays every unchanged agent() call (below)
```

`odw resume <run_id>` acts on the run's state:

- **paused** (its worker alive): it continues in place — the
  `odw pause|resume|stop` control verb is unchanged;
- **ended** — done, failed, stopped, or stale (the worker died): it starts a
  **new run** with the same script, args and adapter (recorded as `resumedFrom`
  in its `meta.json`). Every `agent()` call whose prompt and options are
  unchanged returns its saved value at once — no adapter call, no concurrency
  slot, no dispatch count, no budget — and is marked replayed (↺) in the events,
  `odw agents` and the dashboard. Edited and new calls run normally, so fix the
  failing step and resume instead of paying for the whole run again. Resumes
  chain: a resume of a resume replays both;
- **still running**: refused, since it would redo the work in flight — stop it
  first, or pass `--force` to start the replaying run alongside.

A call matches by the sha256 of its prompt, `schema`, `adapter` (as written in
the call — `--adapter` on the resume switches only the default, so calls that
name none still replay), `model`, `agentType`, `isolation` and `label`;
`phase` is left out. Identical calls replay in call order, so keep prompts
deterministic. Resume takes rerun's flags: `--wait`/`--fg`/`-d`/`--timeout`,
`--adapter`, `--config`, `--runs-root`. The dashboard serves the same records:
`GET /api/runs/:id/agents` and `GET /api/runs/:id/agents/:agentId`.

A step-by-step walkthrough — read what finished, stop what is stuck, fix, resume:
[`docs/recipes/recover-a-run.md`](docs/recipes/recover-a-run.md).

### Human checkpoints (ODW extension)

Claude Code's workflows take no input once they start. `checkpoint()` lets a run
stop where a person should look — approve the plan before the expensive fan-out,
or end a run that went off the rails — and wait, durably, for the answer:

```js
const plan = await agent('Plan the migration as independent steps.', { schema: PLAN })
const { approved, note } = await checkpoint('Run this migration plan?', { payload: plan })
if (!approved) return { skipped: true, why: note }
await parallel(plan.steps.map((step) => () => agent(step.instructions)))
```

While it waits, the run shows as **waiting** in `odw status`, `odw list`, the live
view and the dashboard. Nothing else is held up: agents already running carry on, a
waiting checkpoint takes no agent slot and spends no budget, and `odw stop` still
ends the run. Answer it from any shell:

```bash
odw status $RUN       # the question, its payload, and the exact commands that answer it
odw approve $RUN      # the oldest checkpoint waiting; --checkpoint N picks one
odw reject $RUN --note "Keep the old table until the backfill is verified"
```

or with **Approve** / **Reject** on the run's page in the dashboard (loopback binds
only; it posts `{ action, checkpointId?, note? }` to `POST /api/runs/:id/checkpoint`;
`GET /api/runs/:id` lists `pendingCheckpoints`, and the run list names each waiting
run's oldest question as `waiting`). The call resolves to
`{ approved, note, by }` — `by` is `cli`, `dashboard` or `timeout` — and a rejection
is an answer, not an error: the script decides what "no" means.

- `payload` is any JSON value — a plan, a summary of the changes — kept up to 64 KiB.
- `timeout` (seconds) bounds the wait for unattended runs; `onTimeout` then approves,
  rejects, or (the default, `"fail"`) throws a `CheckpointTimeout` the script can catch.
- Several checkpoints can wait at once (inside `parallel()`), each with its own number.
- `odw resume` never replays a checkpoint: a resumed run asks again.
- `odw run --wait` blocks while a checkpoint waits; it prints the commands once, so
  answer from another shell (or bound the wait with `--timeout`).
- The run records `checkpoint_requested` and `checkpoint_resolved` events, and
  `status.json` names the oldest open checkpoint as `waiting`. With `"waiting"` in
  [`notify.on`](#run-notifications) your hooks hear about each one.

[`examples/plan-approve-execute.js`](examples/plan-approve-execute.js) is the full
plan → approve → execute loop, re-planning when a rejection comes with a note.

### Usage and cost (ODW extension)

A fan-out spends quota fast, so a run shows what it spends as it goes. Every
`agent_finished` (and `agent_failed`) event carries the agent's `usage`:
`inputTokens` (cached input included), `outputTokens`, `cacheReadTokens`,
`cacheWriteTokens` and `costUsd`, summed over all its CLI runs, as the CLI reported
them — the built-in `claude` adapter reports them all. Where a CLI reports no output
tokens (the text-mode adapters), ODW counts `ceil(chars / 4)` of the reply and marks
the figure `estimated`.

```text
$ odw status $RUN
20261017-101500-ab12cd  [done]  review-swarm
  dispatched: 9 agent(s)
  usage: 1.4M tokens in (1.2M cache read, 96k cache write) · ~38k out · $2.871 (estimated in part: 1 of 9 agents reported no output tokens)
```

- The live view's summary line shows output tokens (what `--budget` counts) and the
  running cost; each settled agent's line shows its own cost.
- `GET /api/runs` and `GET /api/runs/:id` carry the run's total as `usage`
  (`estimated: true` when some agent's output tokens are an estimate), and
  `/api/runs/:id` each agent's own.
- `budget.spent()` counts output tokens the same way: the CLI's count where it gave one.
- One `parallel()` or `pipeline()` call that fans out more than `fanOutWarn` tasks or
  items (default 25; `0` or `null` turns it off) logs one warning with the count —
  `large fan-out: parallel() starts 40 tasks (over fanOutWarn: 25) — …` — and goes on.

Adapters declare where their CLI reports usage in their `output`; see
[Configure adapters](#configure-adapters).

### Schedule runs (ODW extension)

Nightly digests, triage, audits: `odw schedule` runs a workflow on a cron
expression through your operating system's own scheduler. ODW runs no daemon —
`add` writes a cron line, a launchd agent or a systemd timer that calls odw back.

```bash
odw schedule add digest digest --cron "0 8 * * 1-5" --cwd ~/work/news --args '{"since":"yesterday"}'
odw schedule list              # backend, last run (id, state, when), next run in local time
odw schedule run digest        # run it now, exactly as the scheduler will
odw schedule remove digest     # delete the OS entry and the definition (safe if it is gone already)
```

- **Backends:** launchd on macOS (`~/Library/LaunchAgents/dev.odw.schedule.<name>.plist`),
  cron elsewhere (a `# odw:begin <name>` … `# odw:end <name>` block in your crontab;
  every other line stays as it is), or `--backend systemd` (a user `.service` + `.timer`
  with `Persistent=true`, so a start missed while the machine was off runs when it is back —
  cron skips it; launchd runs it once the Mac wakes from sleep). `--dry-run` prints exactly
  what would be written. Windows is not supported yet: `add` prints a `schtasks` line instead.
- **Each run** (`odw schedule run <name>`, what the entry calls) takes the schedule's lock — a
  start that finds the previous run still going is skipped, not stacked — runs the workflow
  like `odw run --wait`, appends one line to `~/.local/state/odw/schedules/<name>.log`, and
  exits non-zero unless the run finished `done`.
- **`add` fails fast** on a workflow, adapter or config that does not load, and records the
  absolute node/odw paths and your `PATH`, so the agent CLIs resolve under the scheduler as
  they do in your shell. Definitions live in `~/.config/odw/schedules.json`.
- **Failures** reach you through the usual [`notify`](#run-notifications) hooks: a scheduled
  run is an ordinary run (`"on": ["failed", "stopped"]` for failures only).

The expression is cron's five fields (numbers, `*`, lists, ranges, steps, `jan`-`dec`,
`sun`-`sat`); `@daily`, `L`, `#` and the like are refused with the reason. The full guide,
and the raw cron line as the manual alternative: [`docs/recipes/cron.md`](docs/recipes/cron.md).

### Agent transcripts (ODW extension)

`agent()` hands back only the final reply, but the run keeps what each agent's CLI
printed on the way — every tool call, every result, every retry — so "what did agent 7
actually do?" has an answer, while it runs and after it failed:

```bash
odw logs $RUN --agent 7              # readable: its text, ▸ tool calls, ✓/✗ results, retries, how it ended
odw logs $RUN --agent fix --follow   # by label; keeps printing until that agent settles
odw logs $RUN --agent 7 --raw        # the transcript's lines exactly as kept (JSONL)
```

```text
I'll run the tests first.
▸ Bash  npm test
✗ Bash error (exit 1, 3 lines): not ok 1 - adds
── attempt 2: rate-limit retry ──
▸ Edit  src/add.ts
✓ Edit result (1 line)
■ done · 3 turns · $0.250
```

- While an agent runs, its stdout streams to `agents/<agentId>.transcript.jsonl` in the
  run directory: a JSONL adapter's events one per line, as its CLI printed them (the
  built-in `claude` — stream-json — `kilo` and `opencode`), any other adapter's output as
  `{"kind":"text","text":…}` lines. The end of its stderr (the last 64 KB) goes to
  `agents/<agentId>.stderr.txt`; `odw logs --agent` shows its last lines after the transcript.
- A schema retry, a stall restart or a rate-limit retry goes on in the same file after an
  `{"kind":"attempt","n":2,"reason":"schema"|"stall"|"rate_limit"}` line.
- `maxTranscriptBytes` (default 5 MB per agent) bounds it: past it, one
  `{"kind":"truncated","bytes":N}` line ends the transcript. Transcripts hold whatever the
  agents read and ran; `"maxTranscriptBytes": 0` keeps none.
- Keeping it never slows an agent down: lines are buffered and appended asynchronously.
- An agent replayed by `odw resume` ran no CLI, so it has no transcript — read the
  original run's.
- The dashboard's API serves it normalized:
  `GET /api/runs/:id/agents/:agentId/transcript?since=<i>` →
  `{ entries, next, more, truncated, replayed }`, each entry
  `{ i, kind: text|tool_call|tool_result|error|attempt|result|raw|truncated, text?, tool?, input?, output?, isError? }`,
  long fields clipped to 4 KB (`clipped: true`).

## Dashboard: observe, inspect, chat

The dashboard reads like a printed sheet — paper, ink and one signal colour — and
switches to a night theme on demand. What it gives you:

- **Activity** — a ridgeline *pulse* of event density per run, live counters, the
  fleet of running agents per adapter, and a firehose of events across all runs.
- **Jobs** — runs in flight as live cards (phase rail, agent mix, elapsed time),
  plus a filterable, paged history (`#/jobs/live|done|failed` links straight to a filter).
- **A run** — the graph (fan-outs fan, reduces funnel; edges draw in and carry a
  marching signal while their agent runs; zoom, fit and pan), a **timeline** that
  shows where the time went, filterable **logs** with follow, the **result** as a
  collapsible JSON tree, and an **agent drawer** with each finished agent's own output
  — saved as it lands, so it is there mid-run; replayed agents are marked ↺.
  `exec()` command steps sit in the same graph and timeline as terminal-style nodes
  with their exit code; a run's counts include them (they are not agent dispatches).
  A run waiting at a `checkpoint()` shows the question and its payload above the
  graph, with **Approve** / **Reject** and a note when the dashboard can write.
  A **Changes** tab reviews what each isolated agent changed, file by file, with
  the `odw apply` command (and the kept branch) to copy.
- **Workspace** — every saved workflow with a static outline of its phases and the
  primitives each one calls, its source, and its recent runs.
- **Chat Host** — ordinary Codex conversation; mention ODW or workflow and the turn
  is attached to a real background run whose tool card updates live.

<table>
  <tr>
    <td width="50%">
      <strong>Activity</strong><br />
      <img src="assets/app-screenshots/activity.png" alt="Activity view: a headline, live counters, a ridgeline pulse of event density per run, the fleet by adapter and the live event stream" />
    </td>
    <td width="50%">
      <strong>Timeline</strong><br />
      <img src="assets/app-screenshots/timeline.png" alt="A run's timeline: every agent as a bar from start to finish, grouped by phase, with a now marker while it runs" />
    </td>
  </tr>
  <tr>
    <td width="50%">
      <strong>Jobs</strong><br />
      <img src="assets/app-screenshots/jobs.png" alt="Jobs view: live run cards with phase rails and a day-grouped history table" />
    </td>
    <td width="50%">
      <strong>Night theme</strong><br />
      <img src="assets/app-screenshots/job-detail-dark.png" alt="A live run graph in the night theme, with glowing signal edges" />
    </td>
  </tr>
  <tr>
    <td width="50%">
      <strong>Needs you</strong><br />
      <img src="assets/app-screenshots/needs-you.png" alt="Activity view with a Needs you strip: a run waiting at a checkpoint with a Review button, and a failed run with a Copy resume button" />
    </td>
    <td width="50%">
      <strong>Checkpoints</strong><br />
      <img src="assets/app-screenshots/checkpoint.png" alt="A run waiting at a checkpoint: the question and its payload in an approval card with Approve and Reject, and an amber gate node in the graph's Approve lane" />
    </td>
  </tr>
</table>

Press <kbd>⌘K</kbd> / <kbd>Ctrl K</kbd> (or <kbd>/</kbd>) for the command palette —
jump to any run or workflow, switch theme or language, copy a follow or rerun command.
<kbd>g</kbd> then <kbd>a</kbd>/<kbd>j</kbd>/<kbd>w</kbd>/<kbd>c</kbd>/<kbd>s</kbd> moves
between views, <kbd>1</kbd>–<kbd>4</kbd> switch a run's tabs, and <kbd>+</kbd>/<kbd>-</kbd>/<kbd>0</kbd>
zoom the graph. When a run finishes the dashboard says so, and — if you opt in under
Settings — sends a desktop notification while the tab is in the background.

```bash
odw run adversarial-verify --args '{"question":"review src/rate-limiter.js"}'
odw logs --workflow adversarial-verify --follow
```

The dashboard can be viewed off-loopback, but local write operations such as
Chat messages and stopping ODW-owned runs stay guarded by the loopback server.
Claude Code's own runs stay strictly read-only.

## Configure adapters

Codex, Claude Code, Gemini, Qwen, Kimi, Oh My Pi, Kilo Code, OpenCode, and
Cursor work out of the box:

| Adapter | Local CLI | Non-interactive contract |
| --- | --- | --- |
| `codex` | `codex` | text on stdout; web search enabled; strict schemas natively (`--output-schema`) |
| `claude` | `claude` | stream-json events; reply, usage, cost and errors from its `result` event; WebSearch/WebFetch allowed; schemas natively (`--json-schema`) |
| `gemini` | `gemini` | text on stdout |
| `qwen` | `qwen` | text on stdout |
| `kimi` | `kimi` | text on stdout |
| `omp` | `omp` | `--print --no-session --approval-mode yolo`; prompt on stdin |
| `kilo` | `kilo` | `run --format json --auto`; final text decoded from JSONL |
| `opencode` | `opencode` | `run --format json --auto`; final text decoded from JSONL |
| `cursor` | `agent` | `--print --force --trust`; prompt on stdin |

The built-in `codex` and `claude` adapters come **web-capable**, so research
workflows run with zero tuning. `odw init`
shows what's installed (with each CLI's permission posture) and sets the
default — interactively at a terminal, as a plain report anywhere else, and
`odw init --adapter <name>` writes the choice without prompting. To tune flags
or add your own CLI, drop an `odw.config.json` (see
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

Custom adapters default to trimmed text stdout. For JSONL event streams, declare
the event and final-text path explicitly:

```jsonc
"output": {
  "format": "jsonl",
  "eventType": "text",
  "textPath": ["part", "text"],
  "select": "last"
}
```

**ODW extension:** a JSON output can also say what a run spent, whether the CLI
itself reported a failure, and which tool calls it refused the agent. The
built-in `claude` adapter is declared this way:

```jsonc
"output": {
  "format": "jsonl",
  "eventType": "result",          // the event the reply comes from (the last one wins)
  "textPath": ["result"],
  "select": "last",
  "usagePath": ["usage"],         // token counts, in a usageEvent (default: eventType)
  "costPath": ["total_cost_usd"], // US dollars, in the same event
  "errorPath": ["is_error"],      // true, a message or an error object: the run failed with it
  "deniedPath": ["permission_denials"] // tool calls the CLI refused: kept on the agent, logged
}
```

Under `acceptEdits`, Claude Code refuses headless what it would have asked about —
a shell command that is not allowlisted, say — and the reply may still claim
success; the refusals are what `deniedPath` reads. By default the reply stands,
with the refused calls recorded as `denied` on the agent and one log line;
`"permissionDenials": "fail"` (run-wide, or in an adapter's entry) fails such
agents with reason `permission`, and an `agent()` call with `expect` counts them
as a miss. Allow what your agents need in the adapter's `permissionArgs` for
their tier.

Usage from every `usageEvent` adds up; it is normalized across the CLIs' field
names (Anthropic's, OpenAI's, Codex's — see
[`src/adapters/usage.ts`](src/adapters/usage.ts)). A CLI that prints one JSON
document instead takes `{ "format": "json", "textPath": […], "usagePath": […],
"costPath": […], "errorPath": […], "deniedPath": […] }`; a whole number in a path indexes an array
(negative: from its end). A failure reported at `errorPath` is classified like
any failed run — whatever the exit status — so a rate limit is retried and a spent
quota says when it resets. When the declared text is not in the output — a CLI
whose format drifted, or a misconfiguration — the raw stdout becomes the reply and
the run's log says why; the agent does not fail.

ODW returns only the decoded final response to the workflow; JSONL output is
decoded line by line as it streams (keeping the latest text and a usage total, not
the transcript), and only a bounded tail of stderr is kept for error messages. On
Windows, executable discovery follows `PATHEXT`, so normal
`agent.cmd`, `kilo.cmd`, and `omp.exe` shims are detected without full paths.

Config keys live at the **top level** — there is no `"settings"` wrapper, and odw
warns about unknown or misplaced keys (with a did-you-mean hint) instead of
silently ignoring them. With no `defaultAdapter` set, odw uses the sole
configured adapter — or, on a fresh install, the sole adapter whose CLI it
actually finds on PATH; if several are installed, the error lists them and shows
how to pick one.

### Structured output (ODW extension)

`agent(prompt, { schema })` returns a value that satisfies its JSON Schema, or the
call fails. Two things back that up:

- **Nothing goes silently unchecked.** ODW's validator checks `type` (one name),
  `enum`, `properties`, `required`, `additionalProperties: false`, `items` (one
  schema) and `minItems`; annotations such as `description`, `title` and `format`
  constrain nothing. Before an agent starts, ODW looks for anything else — `oneOf`,
  `anyOf`, `allOf`, `$ref`, `const`, `pattern`, `minimum`, `maxItems`, a type union
  like `["string", "null"]`, an object keyword without `"type": "object"` — and the
  run's log says, once, which keywords it does not check and where (`"oneOf" at
  #/properties/status`). The call still runs, and ODW validates the rest.
  `"schemaKeywords": "strict"` refuses such a call instead, with an `AgentError`,
  before anything is spawned. A typo (`requird`, with a did-you-mean) or another
  malformed schema fails the call in either mode.
- **CLIs that validate schemas get them natively.** The built-in `claude` is handed
  the schema with `--json-schema`, and the value comes from the `structured_output`
  of its `result` event; `codex` gets `--output-schema <file>`, a file
  (`agents/<agentId>.schema.json` in the run directory) that exists only while its
  CLI runs. ODW still validates every reply and retries with feedback, and it
  describes the schema in the prompt only to CLIs that do not take it natively
  (`"schemaPrompt": "always"`: to every CLI).

Codex sends `--output-schema` in OpenAI's strict mode, which refuses a schema unless
its root is an object and every object sets `"additionalProperties": false` and lists
all its properties in `required`. Any other schema goes to codex in the prompt, as
before, and the run says so once.

To make such keywords count, run the agent on an adapter whose CLI enforces them:
it is handed the whole schema, and the run's log says the keywords are left to it.
`schemaKeywords` is `"warn"` (the default) or `"strict"`.

A CLI of your own declares how it takes a schema in `flags.schema` — `"inline"`
(the schema's JSON is the next argument) or `"file"` (the path of a file holding it),
plus `"strict": true` for a CLI that takes only OpenAI strict schemas — and, when its
JSON output carries the validated value apart from its text, where:

```jsonc
"my_cli": {
  "command": ["my-cli", "--print"],
  "stdin": "{prompt}",
  "flags": { "schema": { "args": ["--schema"], "mode": "inline" } },
  "output": { "format": "json", "textPath": ["text"], "structuredPath": ["data"] }
}
```

The schema goes after every other argument, where a model flag goes, and is never
placeholder-expanded. Without `flags.schema` the prompt describes the schema and
only ODW checks the reply.

### Permissions (ODW extension)

ODW runs every agent at a **permission tier**:

- **`read`** — look, never edit or run commands: for research and review fan-outs.
- **`edit`** — the default, and exactly what each built-in has always run with.
- **`full`** — no sandbox and no approvals: an explicit opt-in, for isolated machines.

Set the run's tier in the config (`"permissions": "read"`) or per run with
`odw run|rerun|resume --permissions read` (rerun and resume otherwise keep the source
run's). An adapter's own `permissions` and an `agent()` call's `permissions` can only
**lower** it — an agent runs at the lowest of the three:

```js
// Reviewers that cannot touch the tree, in a run that may edit.
const reviews = await parallel(files.map((f) => () =>
  agent(`Review ${f} for bugs; report, do not fix`, { permissions: 'read', label: f })))
```

An agent that asks for more than its run allows fails before it starts, naming both
tiers (`agent() asked for permissions "full", but the run allows only "edit" …`); in a
`parallel()` its slot is `null`, like any failed agent. Each tier's flags take the place
of the `{permission_args}` element of the adapter's command. Only mappings a CLI's own
docs confirm for headless runs are filled in:

| Adapter | `read` | `edit` (default) | `full` |
| --- | --- | --- | --- |
| `claude` | `--permission-mode dontAsk --tools Read,Glob,Grep,WebSearch,WebFetch --allowedTools WebSearch WebFetch --strict-mcp-config` | `--permission-mode acceptEdits --allowedTools WebSearch WebFetch` | `--permission-mode bypassPermissions` |
| `codex` | `--sandbox read-only` | `--sandbox workspace-write` | `--sandbox danger-full-access` |
| `gemini` | `--approval-mode default` | `--approval-mode auto_edit` | `--approval-mode yolo` |
| `qwen` | refused | `--approval-mode auto-edit` | `--approval-mode yolo` |
| `kimi` | refused | its print mode (no flag) | runs `edit` |
| `omp` | refused | `--approval-mode yolo` | runs `edit` |
| `kilo`, `opencode` | refused | `--auto` | runs `edit` |
| `cursor` | refused | `--force` | runs `edit` |

- **`read`.** On `claude`, `dontAsk` denies anything that would prompt and `--tools`
  leaves only read-only built-in tools — there is no Edit, Write or Bash for an allow
  rule in your settings to bring back — plus the web; no MCP server starts. `codex`
  runs in its read-only sandbox: it can read files, not edit them or run commands
  that need an approval (`codex exec` asks nobody). `gemini` asks before write and
  shell tools in `default` mode, and headless that is a deny.
- **refused.** A CLI with no verified read-only mode fails the agent before it starts:
  `kimi cannot run read-only (…); use an adapter that can (--adapter claude, …), or
  run with --permissions edit`. Qwen's docs do not say what its `default` mode does
  headless, so it has no `read` either.
- **runs `edit`.** A CLI with no separate full mode runs its `edit` flags, and the run
  logs that once per adapter. For `kimi`, `omp`, `kilo`, `opencode` and `cursor`,
  `edit` already approves every tool call headless — mind that before handing them a
  repository.
- **Your own adapters** declare their flags the same way. One without `permissionArgs`
  runs its command as configured, treated as `edit`; under another tier the run logs
  once that ODW cannot enforce it.

```jsonc
{
  "permissions": "read", // the run's tier; odw run --permissions overrides it
  "adapters": {
    // cap one built-in: an entry without "command" changes only the fields it sets
    "codex": { "permissions": "read" },
    "my_wrapper": {
      "command": ["my-agent", "{permission_args}", "--cwd", "{workspace}"],
      "permissionArgs": { "read": ["--read-only"], "edit": [], "full": ["--yolo"] } // "edit" is required
    }
  }
}
```

Every start prints the tier each installed adapter runs with —
`permissions: read — claude read, codex read, kimi refused (no read mode)` — in the
live view, after `--wait`'s first line and after a detached run's id. Each
`agent_started` event (and `odw agents --json`) carries the agent's `permissions`, and
`odw doctor` lists every adapter's tiers. A tier governs what agents may do: `exec()`
commands are the workflow's own and are not affected. `read` is not a sandbox for code
you do not trust either — Claude Code, for one, still runs a repository's hooks under
`-p`.

**Codex and MCP tools that ask for approval** ([#23](https://github.com/xz1220/open-dynamic-workflows/issues/23)).
No tier makes `codex exec` approve an MCP tool call. It asks nobody, so a tool call that
needs an approval — a Figma write, say — is cancelled (`user cancelled MCP tool call`),
and `full` lifts the sandbox (`--sandbox danger-full-access`) but is not documented to
approve MCP calls ([openai/codex#24135](https://github.com/openai/codex/issues/24135)).
Pre-approve that one tool in Codex's own config instead
([Codex MCP docs](https://developers.openai.com/codex/mcp)):

```toml
# ~/.codex/config.toml
[mcp_servers.figma.tools.use_figma]
approval_mode = "approve"
```

Or, only on an isolated machine, make codex's `full` the flag that skips every approval
and the sandbox, and run with `--permissions full` (`permissionArgs` replaces the
built-in's whole, so repeat the other tiers):

```jsonc
"adapters": {
  "codex": {
    "permissionArgs": {
      "read": ["--sandbox", "read-only"],
      "edit": ["--sandbox", "workspace-write"],
      "full": ["--dangerously-bypass-approvals-and-sandbox"]
    }
  }
}
```

On `claude`, `full` (`bypassPermissions`) runs tool calls without asking.

**What agents see of your environment.** Agent CLIs inherit ODW's whole environment
by default. `"agentEnv": "minimal"` passes only what a CLI needs to start (`PATH`,
`HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_*`, `TERM`, `TMPDIR`, `TZ`, and the
Windows system variables), the auth and config variables the built-in CLIs document
(`ANTHROPIC_*`, `CLAUDE_*`, `OPENAI_*`, `CODEX_*`, `GEMINI_*`, `GOOGLE_*`,
`DASHSCOPE_*`, `QWEN_*`, `MOONSHOT_*`, `KIMI_*`, `CURSOR_*`, `OPENCODE_*`, the proxy
variables and `NODE_EXTRA_CA_CERTS`), the adapter's `env`, `ODW_*`, and the names or
`*` globs you list in `agentEnvPass` — so a cloud key or a registry token in your shell
does not reach every agent:

```jsonc
{ "agentEnv": "minimal", "agentEnvPass": ["AWS_*"] } // e.g. Claude Code on Bedrock
```

If a CLI cannot log in under `minimal`, add what it needs to `agentEnvPass`
(`odw doctor --smoke` makes one real call to check). `exec()` commands, `worktreeSetup`
and the `notify` hooks keep the whole environment.

### Stall watchdog

**ODW extension.** A hung agent CLI otherwise holds its slot until `timeout`
(30 minutes by default). Set `stallTimeout` and ODW kills an agent whose stdout
*and* stderr have both been silent that many seconds — its whole process group,
exactly like a timeout — then starts it again with the same prompt, up to
`stallRestarts` times per `agent()` call (default 1). Each restart is logged
(`search:3 went quiet for 120s — restarting (1/1)`); past the cap the call fails
with an error saying the agent stalled. A stop, pause or budget ceiling always
wins over a restart.

```jsonc
{
  "stallTimeout": 120, // seconds of silence; null (the default) = off
  "stallRestarts": 1,
  "adapters": {
    // per adapter: overrides the run-wide value; 0 turns the watchdog off for it
    "my_wrapper": { "command": ["my-agent", "--stream", "{prompt}"], "stallTimeout": 300 }
  }
}
```

The watchdog is **off by default for every built-in adapter**: some CLIs — the
text-mode ones (`gemini`, `qwen`, `kimi`, …) — print nothing until they finish, so
any stall timeout would kill healthy work. Use it for adapters that stream
progress: `claude` (its stream-json prints an event per turn, so it is now safe to
enable for it), the JSONL adapters `kilo` and `opencode`, or a wrapper that prints
a heartbeat — with a value above the longest quiet stretch a healthy agent has: a
long test run inside one tool call prints nothing either.

### Rate limits, quotas and logins

**ODW extension.** Every failed agent is classified from its CLI's exit status
and the end of its output: `rate_limit`, `quota`, `auth`, `timeout`, `stalled`,
`not_found` (the CLI could not start), `permission` (a tool call or approval was
refused) or `exit` — and two classes for runs that "succeeded" without the
evidence: `empty_reply` and `unmet_expectation` (see
[Check an agent's work](#check-an-agents-work-odw-extension)). The class is the `reason` on the `agent_failed` event (with
`retryAfter`, in seconds, when the CLI said when to come back), the agent's
`failureReason` in the dashboard and `/api/runs/:id`, and it shows in the live
view and `odw logs`:

```text
agent_failed    (Search) search — [quota, retry after 3h 22m] AdapterExecutionError: adapter 'codex' ran out of usage quota — wait for the window to reset (in 3h 22m) and resume the run, or switch adapter with --adapter <name>: You've hit your usage limit…
```

- **Rate limits** — HTTP 429/529, "too many requests", "overloaded", Gemini's
  `RESOURCE_EXHAUSTED` — are ridden out: ODW waits, then runs the agent again,
  up to `transientRetries` times per `agent()` call (default 3). The wait is the
  retry-after the CLI printed (`Retry-After: 30`, "try again in 2 minutes",
  "resets at 7:10pm") or else an exponential backoff (15s, 30s, 60s, …), plus up
  to 20% jitter, and never more than `maxBackoff` seconds (default 300); a CLI
  that asks to wait longer than that is not retried early. Each wait is logged
  (`search:3 hit a rate limit on codex — retrying in 45s (2/3)`); a stop ends it
  at once, and a paused run starts the retry only once resumed.
- **Spent quotas and failed logins** are never retried. The error says what to
  do — wait for the quota window, log in to the CLI, or switch adapter with
  `--adapter` — and the run goes on, since its other adapters may be fine. When
  three agents in a row fail this way on one adapter, the run logs one warning;
  `odw resume` later replays every agent that finished. A "quota" that refills
  within a minute (Gemini's free tier words its per-minute limit that way) is
  treated as the rate limit it is. With a [fallback chain](#per-phase-adapters-model-tiers-and-fallback-chains-odw-extension),
  the agent moves to the next CLI instead, and after three quota failures in a row
  the run's later agents skip that adapter.

Claude Code reports such errors in its output, often with exit 0: its stream-json
`result` event says `is_error: true` with the message (`API Error: Rate limit
reached`, `Claude AI usage limit reached|…`), and that counts as the failure it
names. In text mode (a text adapter, or JSON output that fell back to its raw
stdout), a short reply that is nothing but such a rate-limit, quota or login error
counts as that failure too — never as the agent's answer. An empty reply is an
`empty_reply` failure, not retried. A `result` that claims success while its
`permission_denials` list tool calls headless mode refused stands, the calls
recorded and logged — a `permission` failure naming them only under
`"permissionDenials": "fail"`, or for a call with `expect`.

The wording ODW recognizes — collected from each built-in CLI's source and issue
tracker — lives in one table,
[`src/adapters/failures.ts`](src/adapters/failures.ts). Teach it your own CLI's
with an adapter's `failures`: regular expressions per class, matched
case-insensitively before the built-in table.

```jsonc
{
  "transientRetries": 3, // retries per agent() call after a rate limit; 0 = never
  "maxBackoff": 300, // longest single wait, in seconds
  "adapters": {
    "my_wrapper": {
      "command": ["my-agent", "{prompt}"],
      "failures": {
        "rate_limit": ["server busy", "E_THROTTLED"],
        "quota": ["monthly tokens? (used up|exhausted)"],
        "auth": ["session expired"]
      }
    }
  }
}
```

### Per-phase adapters, model tiers and fallback chains (ODW extension)

**ODW extension.** Mix CLIs and models per stage — a cheap model for the search
fan-out, a strong one for the synthesis — and keep a run going on another CLI when
one runs out of quota.

**Phase defaults.** A `meta.phases` entry may give its phase's agents an adapter and
a model: `{ title, adapter?, model? }` (a plain string entry is still just a title).
`phase(title, { adapter, model })` sets them for the agents that follow, in place of
the phase's entry; `phase(title)` alone keeps what the phase has. An option the
`agent()` call sets always wins, and a call's own `phase` option brings that phase's
defaults.

```js
export const meta = {
  name: 'research',
  description: 'Search cheaply, synthesize carefully.',
  phases: [
    { title: 'Search', adapter: 'codex', model: '@fast' },
    { title: 'Synthesize', adapter: ['claude', 'codex'], model: '@strong' },
  ],
}
phase('Search')
const notes = await parallel(angles.map((a) => () => agent(`Research ${a}; cite sources.`)))
phase('Synthesize')
return await agent(`Synthesize:\n${notes.filter(Boolean).join('\n---\n')}`)
```

**Model tiers.** The `models` setting names tiers, each with a model id per adapter.
`model: "@fast"` — in `agent()`, `phase()` or `meta.phases` — runs an agent with the
id its adapter has for the tier; after a fallback, the next adapter's. An adapter the
tier names no model for runs its CLI's default (a log line says so); an unknown tier
fails the agent with an `AgentError` that lists the tiers. A model without the `@` is
a model id, passed to every adapter as it is — so give a fallback chain a tier.

**Fallback chains.** The `fallback` setting gives each adapter the ones to try after
it, in order; `agent(prompt, { adapter: ["codex", "claude"] })` names the chain for one
call, in place of the setting. When an agent's CLI has spent its usage quota or its
login is refused, the agent runs again on the next adapter — a fresh prompt, the same
options — instead of failing (a rate limit is still ridden out in place). Each move is
logged, the agent takes a slot on its new adapter (letting the old one's go first),
its transcript goes on after an `{"kind":"attempt","reason":"fallback","adapter":"claude"}`
line, and what the failed runs spent still counts:

```text
search:3 → claude after codex quota
```

- A fallback runs at the agent's own permission tier: an adapter that cannot run
  exactly that tier is skipped, with a log line — never run at another.
- `agent_finished` names the adapter that produced the value and, as `fellBackFrom`,
  the ones the agent left; so does its saved result. `odw status`, the live view
  (`codex → claude`) and `/api/runs/:id` show them.
- **Quota breaker.** After `quotaBreaker` (default 3) quota failures in a row on one
  adapter, the run's later agents skip it: each starts on the next adapter of its
  chain, or fails at once without one. One warning says so, and `odw status` names it.

```jsonc
{
  "fallback": { "codex": ["claude"], "claude": ["codex"] },
  "quotaBreaker": 3, // the default; 0 or null never skips an adapter
  "models": {
    "fast": { "claude": "haiku", "codex": "gpt-5-mini" },
    "strong": { "claude": "opus", "codex": "gpt-5" }
  }
}
```

`odw resume` replays a call that fell back like any other, and walks no chain. A
call's resume key is its prompt and options as written: a phase's defaults stay out of
it, like the run's default adapter, so routing a phase elsewhere — say, off a CLI that
ran out of quota — still replays every call that finished.

### Concurrency per adapter and staggered fan-outs

**ODW extension.** `concurrency` caps how many agents a run has going at once; an
adapter's own `concurrency` caps how many of them run on that CLI — so a fan-out of
16 codex calls runs 4 at a time while other adapters use the rest of the run's slots.
An agent needs a run slot and a slot on its adapter, handed out together: it never
holds one while it waits for the other, each adapter's agents queue first come,
first served, and a free run slot goes to the oldest agent whose adapter has room, so
one throttled adapter never holds up the others. `odw doctor` shows the caps, and
`odw run` states them in its start banner, under the permissions line
(`concurrency: 8 agents at once · per adapter: codex 4`).

```jsonc
{
  "concurrency": 8,
  "adaptiveConcurrency": true, // the default; false keeps every cap fixed
  "staggerFanOut": { "first": 1, "delayMs": 2500 }, // the default; false turns it off
  "adapters": {
    "my_wrapper": {
      "command": ["my-agent", "--cwd", "{workspace}", "--prompt-file", "{prompt_file}"],
      "concurrency": 4 // at most 4 of its agents at once, inside the run's 8
    }
  }
}
```

To cap a built-in adapter, name only what changes — `"codex": { "concurrency": 4 }`
keeps codex's command and flags (an entry without `command` adjusts the built-in;
one with `command` replaces it).

**Adaptive back-pressure.** When an adapter hits a rate limit — an agent about to
wait out a backoff, or one that failed with `rate_limit` — its cap is halved for the
rest of the run, never below 1 (an adapter without a cap of its own starts from the
run-wide one), and each minute without another rate limit gives one slot back. A
fan-out that hit the limit together cuts the cap once, not once per agent. Agents
already running keep their slots — a rate-limited one waits out its backoff in place
— so the lower cap holds back the agents that start next. The cut, and the slot that
brings the cap back in full, are logged:

```text
adaptive concurrency: codex hit a rate limit — at most 4 of its agents at once now (was 8); one slot comes back for each minute without another
adaptive concurrency: no rate limit on codex for 4m — back to 8 of its agents at once
```

**Staggered fan-outs for the prompt cache.** Anthropic's API, behind the built-in
`claude` adapter, caches a prompt's prefix: the first request that sends it writes
it, and later ones read it for a fraction of the price — but only once the first has
been read. A fan-out that starts every agent at once pays the full prefix in each.
So in one `parallel()` or `pipeline()` call, agents on an adapter that declares
`"promptCache": true` (the built-in `claude` does) whose prompts share at least their
first 1,024 characters start `first` at a time; the rest start once the first one's
CLI has produced output — for a JSONL adapter such as `claude`, its first event past
the CLI's start-up `system` events — or `delayMs` later, whichever comes first. Put the shared instructions first and the per-item
part last to benefit. A lone agent, an agent whose prompt is shorter or different (or
on another model or persona), and a replayed one never wait; a held agent holds no
slot, and a stop ends the wait at once. Each staggered fan-out logs one line:

```text
staggered fan-out: 15 claude agents sharing a 3412-character prompt prefix waited 2.1s while the first warmed the prompt cache, until it produced output
```

Declare `"promptCache": true` on your own adapter when its CLI talks to an API that
caches prompts — and on a `claude` entry with its own `command`, which replaces the
built-in (a partial entry such as `"claude": { "concurrency": 4 }` keeps it).

### Run notifications

**ODW extension.** `notify` runs a command and/or POSTs to a webhook when a run
ends, so an overnight run can tell you how it went:

```jsonc
"notify": {
  "command": ["/usr/local/bin/odw-notify"],        // an argv, run WITHOUT a shell
  "webhook": "https://hooks.slack.com/services/…", // Slack, Discord, or any JSON endpoint
  "on": ["done", "failed", "stopped"]              // the default: every final state; "waiting" is opt-in
}
```

The hooks fire once, after the run's final state is written, so they can neither
delay nor change it; a hook that fails or hangs is only logged to the run's
`worker.log`. The command (killed after 30s) runs in the run's source directory
with `ODW_RUN_ID`, `ODW_RUN_STATE`, `ODW_WORKFLOW`, `ODW_RUN_DIR`,
`ODW_RESULT_FILE` (only when the run has a result), `ODW_DURATION_SEC`,
`ODW_AGENTS` and `ODW_FAILED_AGENTS` in its environment. The webhook (10s limit)
receives:

```jsonc
{
  "runId": "20261017-041600-3fa2c1",
  "workflow": "deep-research",
  "state": "done", // done | failed | stopped
  "createdAt": 1792210560.2, // Unix seconds
  "finishedAt": 1792210812.5,
  "durationSec": 252,
  "counts": { "agents": 12, "done": 11, "failed": 1 },
  "text": "odw · deep-research finished in 4m12s · 12 agents, 1 failed",
  "content": "odw · deep-research finished in 4m12s · 12 agents, 1 failed"
}
```

Failed and stopped runs add an `error` field. `text` and `content` carry the
same line, so Slack and Discord incoming webhooks render it as is (Discord's
`allowed_mentions` is set too, so a run never pings anyone). The dashboard's
settings show which hooks are configured — the webhook as scheme and host only,
since the rest of its URL is the secret.

Add `"waiting"` to `on` to hear about every
[`checkpoint()`](#human-checkpoints-odw-extension) that starts waiting for a person.
The hooks then fire once per checkpoint, while the run waits on: the command with
`ODW_RUN_STATE=waiting`, `ODW_CHECKPOINT_ID` and `ODW_CHECKPOINT_TITLE` (and no
`ODW_RESULT_FILE`), the webhook with `"state": "waiting"`, a
`"checkpoint": { "checkpointId", "title", "since" }` field in place of `finishedAt`,
and a `text` line naming the command that answers it.

Ready-made setups for Slack, Discord, ntfy and desktop banners:
[`docs/recipes/notify.md`](docs/recipes/notify.md).

### Isolated worktrees and agent ports

`agent(prompt, { isolation: "worktree" })` runs that agent in a throwaway git
worktree: a clean checkout of HEAD, without the `.env`, `.venv` or
`node_modules` your source tree has. Two things make it ready before the agent
starts:

- **`.worktreeinclude`** at the repository root — the file Claude Code reads
  too — lists what to bring in, in `.gitignore` syntax. Every file or directory
  git does not track that a line matches is copied into the worktree (Claude
  Code copies only gitignored files; ODW copies merely untracked ones as well).
  `.git` is never copied, and a file over 100 MB is left out with a log line. A
  `symlink:` prefix (**ODW extension**) links what the line matches instead of
  copying it: instant for a heavy directory, but shared — what an agent writes
  there lands in your source tree.
- **`worktreeSetup`** (**ODW extension**) runs in the agent's workspace once the
  files are in: a string through the platform shell, an array as an argv. It is
  killed after `worktreeSetupTimeout` seconds (600 by default); a setup that
  fails or times out fails that agent — not the run — with the end of its
  output in the error.

```gitignore
# .worktreeinclude
.env
.env.local
config/secrets.json
symlink: node_modules
```

```jsonc
{
  "worktreeSetup": "npm run codegen", // or an argv, e.g. ["uv", "sync"]
  "worktreeSetupTimeout": 600,
  "portRange": [41000, 41999]
}
```

Every agent process — isolated or not — also gets `ODW_RUN_ID`, `ODW_AGENT_ID`
and `ODW_PORT` (**ODW extension**). `ODW_PORT` comes from `portRange`; no other
running agent of the run holds it (ports something already listens on are
passed over), and it stays the agent's until its call settles. So agents
running side by side can each start a dev server:

```js
await parallel(['grid', 'list'].map((layout) => () =>
  agent(`Build the ${layout} layout, start the dev server on port $ODW_PORT and check that the page renders.`,
    { isolation: 'worktree', label: layout })))
```

Ask such agents to stop the servers they start before they finish: an agent
CLI may wait for its own background commands before it exits (`claude -p`
does), which holds the agent — and its port — until the stall watchdog or the
timeout ends it.

The setup command gets the same three variables, and `exec()` commands get
`ODW_RUN_ID`. Keep `portRange` wider than `concurrency`: an agent started while
the others hold every port runs without `ODW_PORT`, and the run's log says so.
Each attempt of a call (a schema retry, a stall restart, a rate-limit retry)
starts from a fresh worktree, prepared the same way.

### Review and apply what isolated agents changed (ODW extension)

An isolated agent's worktree is removed when its call settles, but its work is
not lost: before the worktree goes, ODW keeps what the agent changed — edits,
new, deleted, renamed and binary files, staged, committed or not — as a unified
diff in the run directory (`agents/<agentId>.diff`), and records its size,
`changes: { files, insertions, deletions, truncated }`, on the agent's
`agent_finished` event and saved result. `agent()` still returns the reply.
What `.worktreeinclude` placed and `worktreeSetup` produced is not the agent's
change and stays out, unless the agent edited it afterwards.

```bash
odw diff $RUN --stat               # who changed what: files, +/- lines, kept branch
odw diff $RUN --agent fix:auth     # one agent's diff, by label or id — a patch git can read
odw apply $RUN --agent 3 --check   # would it apply here, and what would conflict?
odw apply $RUN --agent 3           # apply it to this working tree (git apply --3way)
```

`odw apply` applies one agent's diff to the git working tree you run it in with
`git apply --3way`: what applies is staged, and a hunk that clashes with your
own change is merged three-way and left with conflict markers (exit 1). It
refuses while a path the diff touches has uncommitted changes — commit or stash
them, or pass `--force`. Agents that changed different files apply one after
another. The dashboard shows the same diffs in a run's **Changes** tab and serves
them at `GET /api/runs/:id/agents/:agentId/diff`.

- **`keep: true`** (an `agent()` option) or **`keepBranches: true`** (config) also
  commits the change to a branch `odw/<runId>/<agentId>-<label>` of the source
  repository — by `odw <odw@localhost>`, on top of the commit the agent started
  from — to check out, merge or cherry-pick. ODW only creates that branch: your
  HEAD, index and other branches are never touched. `keep: false` opts one agent
  out of `keepBranches`.
- **`maxDiffBytes`** (default 2 MB) caps a stored diff: past it, the head is kept,
  cut at a line, with one final `# odw: diff truncated …` line. The counts still
  describe the whole change; `odw apply` refuses a cut diff — use the branch.
- A binary file is named in the diff by its object id, not carried in it; git
  applies it from the repository's object store, where ODW wrote it (a kept
  branch pins it for good).
- A failed agent keeps its diff too (the work of one that timed out), and `odw
  resume` brings a replayed agent's diff into the new run. A stopped run keeps none.

```jsonc
{
  "maxDiffBytes": 2097152, // bytes of one agent's diff kept in the run directory
  "keepBranches": false    // true: every isolated agent's change also goes on a branch
}
```

Step by step: [`docs/recipes/review-and-apply.md`](docs/recipes/review-and-apply.md).

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
  extracts `meta` (with a string/comment/regex-aware scan), strips the `export`,
  and wraps the body in an async function whose parameters *are* the primitives —
  so the body's `return` becomes the workflow's result.
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
| `src/changes.ts` | cross-cutting — what isolated agents changed, kept as diffs and branches |

Workflow scripts stay **plain `.js`** and are never compiled; the engine is
written in **TypeScript** (compiled to ESM, **zero runtime dependencies**) and
ships `.d.ts` authoring types so script authors get editor autocomplete on the
injected globals.

## Examples

Runnable, plain-JS workflows in [`examples/`](examples/):

| Workflow | Pattern |
| --- | --- |
| [`deep-research.js`](examples/deep-research.js) | fan-out research → adversarial fact-check → cited report |
| [`deep-research-verified.js`](examples/deep-research-verified.js) | the battle-tested variant: scope → search → fetch → 3-vote verify → cited synthesis, with a cron-ready wrapper ([recipe](docs/recipes/deep-research-verified.md)) |
| [`ultra-mode.js`](examples/ultra-mode.js) | disciplined deep-work loop: plan → parallel attack → adversarial review → synthesize |
| [`fan-out-reduce.js`](examples/fan-out-reduce.js) | draft N in parallel → synthesize the best |
| [`adversarial-verify.js`](examples/adversarial-verify.js) | surface findings → keep only those that survive refutation |
| [`review-swarm.js`](examples/review-swarm.js) | map a change set → review it through N lenses in parallel → verify every finding (optionally on another CLI) → ranked, evidenced report |
| [`loop-until-dry.js`](examples/loop-until-dry.js) | loop fanning out finders until K dry rounds |
| [`routing.js`](examples/routing.js) | classify the request → route to a specialist → grade the result |
| [`generate-and-filter.js`](examples/generate-and-filter.js) | generate many ideas in parallel → dedupe → keep only rubric-passers |
| [`tournament.js`](examples/tournament.js) | N approaches attempt the task → pairwise judging bracket → one winner |
| [`codex-claude-loop.js`](examples/codex-claude-loop.js) | two rival CLIs in a turn-based duel: Claude implements, Codex reviews, repeat until sign-off |
| [`agent-daily-digest.js`](examples/agent-daily-digest.js) | discover sources → extract in parallel → synthesize → verify |
| [`test-fix-loop.js`](examples/test-fix-loop.js) | run the tests with `exec()` → an agent fixes the failures → re-run until green (ODW only) |
| [`fix-until-green.js`](examples/fix-until-green.js) | the same loop with `expect`: odw runs the tests after the agent replies and hands a red suite — or a "fix" that changed nothing — back to it, then fails with what it missed (ODW only) |
| [`plan-approve-execute.js`](examples/plan-approve-execute.js) | an agent drafts a plan → a person approves it at a `checkpoint()` (a rejection with a note re-plans) → parallel execution → report (ODW only) |

## Develop

```bash
npm ci                # install the locked build dependencies
npm run build         # tsc → dist/
npm test              # node:test suite, driven by a mock adapter (no real accounts)
npm run typecheck     # tsc --noEmit
npm run build:binary  # bundle + Node SEA + postject → a single self-contained ./build/odw
```

Working on the dashboard? Seed a simulated fleet that keeps moving, point a server
at it, and run the dev server — it rebuilds `web/src` on every page load and proxies
`/api` (SSE included) to that server:

```bash
node web/demo-fixtures.mjs /tmp/odw-demo/runs /tmp/odw-demo/project --live &
echo '{"runsRoot":"/tmp/odw-demo/runs"}' > /tmp/odw-demo/odw.config.json
(cd /tmp/odw-demo/project && npx tsx "$OLDPWD/src/cli.ts" serve --config /tmp/odw-demo/odw.config.json --port 4317) &
node web/dev.mjs --api http://127.0.0.1:4317     # → http://127.0.0.1:5173
```

To update a local source installation, build the updated checkout and run
`npm install -g .`, then copy its `skills/open-dynamic-workflows/` directory into
your agent's skills directory. Existing npm-linked checkouts use the rebuilt
`dist/` immediately.

`package.json` is the version source. Source builds identify themselves as
`0.5.0-dev+g<revision>` (`.dirty` marks uncommitted changes); source archives use
`0.5.0-dev+source`. Build scripts generate the embedded version before compiling
or testing. Release builds set `ODW_RELEASE_TAG=v0.5.0` and require a clean
checkout at that tag, matching package and lockfile versions, passing tests and
type checks, and a binary that reports the expected version. The release workflow
publishes only after all platform builds succeed.

`build:binary` follows the standard single-executable recipe: [esbuild](https://esbuild.github.io/)
bundles `dist/` (zero-dep ESM) into one CommonJS file, `node --experimental-sea-config`
turns it into a [SEA](https://nodejs.org/api/single-executable-applications.html)
blob, and [postject](https://github.com/nodejs/postject) grafts that blob into a
copy of the `node` binary (ad-hoc code-signed on macOS). esbuild and postject are
**build-only devDependencies** — the binary and the npm package stay zero
*runtime* dependencies. Cross-platform binaries are built per-OS in CI
([`.github/workflows/release.yml`](.github/workflows/release.yml)); SEA injects
into the host's `node`, so each target is built on its own runner.

> Once published, `npm i -g odw` (or `npx odw …`) puts the `odw` command on your PATH.

## Status

**What's new on `main` (October 2026)** — the full list, with what to check before
upgrading, is in [`CHANGELOG.md`](CHANGELOG.md):
- **Per-phase adapters and fallback chains.** A phase can run its agents on its own
  CLI and model (`meta.phases: [{ title, adapter, model }]`, `phase(title, { … })`),
  `model: "@fast"` picks each CLI's model for a tier, and an agent whose CLI ran out of
  quota or is logged out moves down its chain (`adapter: ["codex", "claude"]`, or
  `fallback` in the config) instead of failing — with a quota breaker that stops
  trying a spent CLI (ODW extensions; see
  [Per-phase adapters](#per-phase-adapters-model-tiers-and-fallback-chains-odw-extension)).
- **Native structured output.** `claude` (`--json-schema`) and `codex`
  (`--output-schema`, for strict schemas) are handed an agent's schema and enforce it
  themselves; ODW still validates every reply. A schema keyword ODW's validator does
  not check is named in the run's log with where it is, never silently skipped —
  `"schemaKeywords": "strict"` refuses such calls (ODW extensions; see
  [Structured output](#structured-output-odw-extension)).
- **Evidence of success.** `agent(…, { expect })` checks an agent's work instead of
  taking its word — a command exits 0, files changed, the reply matches — and hands
  misses back once before failing with `reason: "unmet_expectation"` and what it
  missed. An empty reply fails as `empty_reply`; tool calls Claude Code refused are
  recorded on the agent and logged — and count against `expect` (ODW extensions;
  see [Check an agent's work](#check-an-agents-work-odw-extension)).
- **Permission tiers.** Every agent runs `read`, `edit` (the default, unchanged) or
  `full`, mapped to each CLI's own flags: review and research fan-outs that cannot
  touch the tree (`--permissions read`, `agent(…, { permissions: 'read' })`), full
  access only by explicit opt-in, and a CLI that cannot enforce a tier refused or
  logged — never silently downgraded. `agentEnv: "minimal"` keeps unrelated secrets
  out of agents (ODW extensions; see [Permissions](#permissions-odw-extension)).
- **Human checkpoints.** `checkpoint()` pauses a run until a person approves or
  rejects — with `odw approve|reject`, the dashboard, or an opt-in `waiting` hook —
  so a plan gets a yes before the expensive fan-out (ODW extension; see
  [`plan-approve-execute.js`](examples/plan-approve-execute.js)).
- **Rate limits ridden out.** Every agent failure is classified (rate limit, quota,
  login, timeout, stall, …). A rate-limited CLI is retried after a backoff that
  honors its retry-after; a spent quota or a failed login fails fast with what to do
  — in `odw logs`, the live view and the dashboard, with the reset time.
- **Throttles that learn.** Cap any adapter with `"concurrency"`; a rate limit halves
  that adapter's cap for the rest of the run and quiet minutes give slots back; and
  a `claude` fan-out sharing a long prompt prefix starts one agent first so the rest
  read its prompt cache instead of each paying for it.
- **See what each agent did.** Every agent's CLI output is kept as a transcript —
  tool calls, results, retries — readable with `odw logs <run> --agent <id|label>`
  (`--follow` while it runs) or live in the dashboard's Transcript sheet.
- **Scheduled runs without a daemon.** `odw schedule add <name> <workflow> --cron
  "15 2 * * 1-5"` writes a cron, launchd or systemd entry that calls back into odw —
  with an overlap lock, a per-schedule log and the last run in `odw schedule list`
  ([recipe](docs/recipes/cron.md)).
- **Review and apply what isolated agents changed.** A worktree agent's change
  is kept as a diff when its worktree goes (setup files left out), optionally on
  a `keep` branch. Read it in the dashboard's **Changes** tab or with `odw diff`,
  and land it with `odw apply` (`--check` first) — one agent at a time.
- **Real usage and cost.** The built-in `claude` adapter now reads Claude Code's
  `stream-json`, so every agent records the tokens and dollars its CLI reported —
  in `odw status`, the live view and the dashboard — and `--budget` meters real
  output tokens. A single fan-out wider than `fanOutWarn` (25) says so up front.
- **Ready-to-work worktrees.** `.worktreeinclude` copies or links `.env`,
  `node_modules` and the like into isolated agents' worktrees, `worktreeSetup` runs
  your bootstrap command, and every agent gets its own `$ODW_PORT`.
- **"Needs you"** on the dashboard's Activity page: runs waiting for a decision, and
  the day's failed runs with the `odw resume` command that picks them up.
- **Recoverable runs.** Every finished agent's result is saved as it lands — read it
  mid-run with `odw agents` / `odw result <run> --agent <id|label>` or in the
  dashboard — and `odw resume <run>` starts a new run that replays every unchanged
  `agent()` call, so a stalled or failed run costs only the work that changed (#24).
- **`exec()`** runs a command from a workflow without a model — tests, builds,
  linters — with timeouts, output caps and stop handling (#31; ODW extension), and
  the new [`test-fix-loop.js`](examples/test-fix-loop.js) and
  [`review-swarm.js`](examples/review-swarm.js) examples.
- **Run hooks and a stall watchdog.** A `notify` command or webhook (Slack/Discord-
  ready) fires when a run finishes, fails or stops; an opt-in `stallTimeout` kills
  and restarts agents that go quiet; a SIGTERM to the worker stops the run cleanly.
- **`odw doctor [--smoke]`** checks the runtime, config and every adapter — and with
  `--smoke` sends one real prompt to catch CLIs that exit 0 without answering.
- **Reliability.** Timeouts and stops reach an agent's whole process tree (SIGTERM,
  then SIGKILL) and agents already running; crashes and swallowed fatal errors can no
  longer leave a run `running` or call a stopped run `done`; ambiguous structured
  replies are retried instead of guessed; malformed config numbers fail loudly.
- **Safety and scale.** Workflow `meta` is parsed, never evaluated, and listings never
  compile a body; the dashboard server reads events incrementally, pushes only run-list
  deltas and stays responsive with thousands of runs; installs verify SHA256 checksums;
  CI covers Node 20/22/24, macOS and Windows.
- **A redesigned dashboard** ([above](#dashboard-observe-inspect-chat)) and landing page.

**0.5.0 development:** queued tasks recheck pause, stop, and budget before
starting. Waiting commands detect a vanished worker instead of waiting forever.
Upgrades keep the binary and skill on the same release and roll back replacement
failures; source builds now report their revision.

**What's new (unreleased, on `main`):** `odw run` now attaches a **live
foreground view** in interactive terminals — Ctrl-C detaches, `odw attach`
re-attaches, and pipes/CI keep the fire-and-poll contract. First-run
**onboarding** landed: the installer asks you to pick a default agent when
several CLIs are installed, `odw init` re-opens that choice anytime, launches
warn upfront when bare `agent()` calls would fail, and config errors are now
fatal instead of returning a "done" run full of nulls. The built-in
`codex`/`claude` adapters got **web access** out of the box, and the
battle-tested [`deep-research-verified.js`](examples/deep-research-verified.js)
ships with a cron-ready wrapper. Earlier on `main`: the dashboard's local
**Chat Host** (hand ODW-mentioned turns to a real asynchronous run), the
desktop (Tauri) app **retired** in favor of `odw serve`, and the dialect made
broader — nested `workflow()` (shared scheduler/budget, one level deep),
estimated `budget.spent()` accounting with a guard before later dispatches,
`odw run --adapter <name>`, inline-source runs archived in their run directory,
and a `validate()` primitive so workflows can generate workflows.

**v0.3.0:** the **Jobs** tab also surfaces **Claude Code's own workflow runs** —
finished history and live in-flight jobs — read-only, merged alongside ODW's own
runs. See
[Releases](https://github.com/xz1220/open-dynamic-workflows/releases).

**Core runtime is shipped.** The full runtime is on `main` — the adapter layer, execution
bridge, workspace isolation, the async scheduler, the injected primitives, the
loader/transform, the JSON-Schema engine, the background runtime, and the `odw`
CLI. The regression suite runs in [CI](https://github.com/xz1220/open-dynamic-workflows/actions/workflows/ci.yml), and the flagship [`examples/deep-research.js`](examples/deep-research.js)
runs end-to-end (plan → search → extract → vote → report).

### Roadmap

Ranked by what users of parallel coding agents report needing
([research](docs/research/user-needs-2026-10.md)): adapter-reported token usage and
cost for more CLIs (Claude Code reports it today; the others are estimated) ·
running Claude plugin
workflows · evaluation. Full plan: [`docs/ROADMAP.md`](docs/ROADMAP.md); the
original design: [`docs/dynamic-workflows-tech-plan.md`](docs/dynamic-workflows-tech-plan.md).
Background on the Claude Code dialect ODW aligns with:
[`docs/dynamic-workflows-research.md`](docs/dynamic-workflows-research.md).

## Use as a skill

[`skills/open-dynamic-workflows/SKILL.md`](skills/open-dynamic-workflows/SKILL.md) (简体中文: [`skills/open-dynamic-workflows/zh-CN/SKILL.md`](skills/open-dynamic-workflows/zh-CN/SKILL.md))
teaches a host agent to author and run workflows from documentation alone —
install it into your agent's skills directory (Codex CLI → `~/.codex/skills/`,
Claude Code → its skills dir).

## FAQ

<details>
<summary><b>How is this different from a CLAUDE.md / AGENTS.md / a skill?</b></summary>

Those teach an agent how to behave <i>inside its own context</i>. A dynamic
workflow moves the work <i>out</i>: the plan lives in a script, the subtasks run
as separate agent processes at scale, and only the final value returns. ODW
ships a skill too — but the skill's job is to teach your agent to write and run
workflows, not to be the orchestration.
</details>

<details>
<summary><b>How is this different from LangGraph / n8n / Airflow?</b></summary>

Those orchestrate API calls and custom nodes. ODW orchestrates <b>coding-agent
CLIs</b> — the agents you already pay for and configure (Codex, Claude Code,
Gemini, …) — in the run's own working directory, with opt-in per-agent
workspace isolation and diffs. There is no DSL and no server farm: a workflow is one plain JavaScript
file in Claude Code's existing dialect, and the engine is a zero-dependency
Node CLI.
</details>

<details>
<summary><b>Does ODW call model APIs directly?</b></summary>

No. ODW only shells out to local CLIs you already authenticated. No API keys,
no token billing of its own, no network calls from the engine.
</details>

<details>
<summary><b>Can a web page drive my local agents through <code>odw serve</code>?</b></summary>

No. Write endpoints require <code>Content-Type: application/json</code> and a
same-origin Origin, the Host header is allowlisted against DNS rebinding, and
any off-loopback bind refuses writes entirely (the dashboard stays readable).
</details>

<details>
<summary><b>What happened to the desktop app?</b></summary>

Retired. The app was a thin Tauri shell over the same single-file SPA that
<code>odw serve</code> already serves, so the web dashboard is now the single
client — cross-platform, nothing to install beyond <code>odw</code> itself.
</details>

## Star history

<a href="https://star-history.com/#xz1220/open-dynamic-workflows&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=xz1220/open-dynamic-workflows&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=xz1220/open-dynamic-workflows&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=xz1220/open-dynamic-workflows&type=Date" width="600" />
  </picture>
</a>

## License

[MIT](LICENSE)
