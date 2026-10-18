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
| `parallel(thunks)` | Run a batch concurrently and wait for all of it (**barrier**). Recoverable failures become `null`; stop, budget, and dispatch-limit errors abort the run. `parallel(thunks, { notes: true })` gives its agents the run's notes board — see [Notes between parallel agents](#notes-between-parallel-agents-odw-extension) (**ODW extension**). |
| `pipeline(items, ...stages)` | Stream each item through the stages independently (**no barrier**). Each stage gets `(prev, item, index)`. |
| `phase(title, opts?)` / `log(msg)` | Group progress under a phase / emit a progress line. `opts` — `{ adapter, model }` — gives the phase's agents an adapter and a model (**ODW extension**; see [per-phase adapters](#per-phase-adapters-model-tiers-and-fallback-chains-odw-extension)). |
| `schema` (JSON Schema) | A typed output contract for `agent`; the reply is validated and retried until it conforms. A keyword ODW cannot check is reported in the run's log (or, with `"schemaKeywords": "strict"`, fails the call), and CLIs that validate schemas (`claude`, `codex`) enforce it natively — see [Structured output](#structured-output-odw-extension). |
| `args` | The workflow's input, injected verbatim. |
| `budget` | `{ total, spent(), remaining() }` — scale depth to a token target. |
| `workflow(ref, args?)` | Run another workflow inline (one level deep). The child shares this run's concurrency cap, agent counter, and budget; its phases group as their own DAG lanes. |
| `validate(source)` | Parse and compile-check trusted source without running its workflow body. Metadata is parsed as a pure literal, never evaluated. **ODW extension** (not in Claude Code's dialect). |
| `exec(command, opts?)` | Run a command — tests, a build, a linter — without launching a model; resolves to `{ stdout, stderr, exitCode, signal, timedOut, truncated, durationMs }`. A string runs through the shell, an array as argv. Bounded by `timeout` (600 s) and `maxOutputBytes` (8 MiB per stream); a stop kills it. Takes no agent slot. **ODW extension** (not in Claude Code's dialect). |
| `checkpoint(title, opts?)` | Pause the run until a person approves — perhaps with an edited payload — or rejects, from `odw approve\|reject` or the dashboard, and resolve to `{ approved, note, by, payload, edited }`. `opts`: `payload` (what to look at), `schema` (what an edit must match), `timeout` (seconds) and `onTimeout` (`"approve"`, `"reject"`, or the default `"fail"`). Takes no agent slot; a stop still ends the run. See [Human checkpoints](#human-checkpoints-odw-extension). **ODW extension** (not in Claude Code's dialect). |

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
    mcp: ['github'],            // MCP servers its CLI must have started it with (claude)
    untouched: ['test/**', '**/*.snap', '.github/**'], // no file matching these may change
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
- **With a [fallback chain](#per-phase-adapters-model-tiers-and-fallback-chains-odw-extension),**
  a miss is retried on the adapter whose work missed — never a reason to fall
  back. A call that moves on (a spent quota, a refused login) keeps its `expect`:
  the next adapter starts the work over with its own `expectRetries` — isolated,
  in a fresh worktree; in place, judged against the tree as it was before the
  call began.
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
- **MCP servers that did not start.** Claude Code's stream begins with an init
  event listing the MCP servers it started the agent with; one that failed leaves
  the agent without its tools, and it may still say "done". Every server that is
  not `connected` is kept as `mcp: [{ name, status }]` on the agent's
  `agent_finished` (or `agent_failed`) event, its saved result and `/api/runs/:id`,
  and the run logs it once per server and status: ``MCP server github failed to
  start (claude agent `fix-auth`): its tools were unavailable``. The reply stands —
  Claude Code itself only warns — unless `"mcpFailures": "fail"`, which fails an
  agent whose server `failed` or `needs-auth` with `reason: "mcp_unavailable"`.
  `expect: { mcp: [...] }` makes a listed server that is not there — `failed`,
  `needs-auth`, `disabled` or not configured — a miss, retried and then
  `unmet_expectation`. `pending` is neither: Claude Code's docs say not to treat it
  as a failure (servers from `.mcp.json` usually start that way and connect in the
  background).
- **Protected paths stay untouched.** Agents game the checks they are judged by:
  to get green they edit, skip or delete the tests. `untouched` lists globs (as
  `files`: `*` stays within a directory, `**/*.snap` finds one at any depth) that
  no file the agent changed, created or deleted may match — read like `changes`,
  so in place your own edits made before the call do not count. A touched path is
  a miss naming it — ``no file matching "test/**" may change, and 1 did:
  test/add.test.js`` — and the retry is told to restore it.
- **Background work left running.** In headless mode the agent can start a
  background shell command (`run_in_background`) or subagent, end its turn and
  exit: the work dies with the CLI while the result says success
  ([claude-code#85129](https://github.com/anthropics/claude-code/issues/85129)).
  odw follows Claude Code's stream-json task events (`task_started`,
  `task_updated`, `task_notification`) and the background tool calls; work still
  open at the `result` event is kept as `orphaned` on the agent's
  `agent_finished` event, its saved result, `/api/runs/:id` and the dashboard
  drawer, and the run logs one line per agent: `serve:1: Claude Code ended its
  turn with 1 background task still running — Bash (Start the dev server); it
  died when the CLI exited, …`. The reply stands (the default
  `"orphanedBackground": "warn"`); `"orphanedBackground": "fail"` fails such agents
  with `reason: "orphaned_background"`, and with `expect` set it is a miss —
  handed back (“wait for every background command and subagent to finish before
  you reply”), then `orphaned_background`. Any JSONL adapter can declare its CLI's
  background events with `output.background` (see the adapters reference).

Claude Code's Workflow tool ignores `expect`, so there the checks do not run.
[`examples/fix-until-green.js`](examples/fix-until-green.js) lets `expect` run a
fix-until-the-tests-pass loop.

### Notes between parallel agents (ODW extension)

Parallel coding agents produce changes that pass alone and break together: one
renames a function another still calls. Told what the concurrent change was,
they mostly avoid it — so odw gives a run a **notes board**, off unless asked for:

```js
const lanes = await parallel(tasks.map((t, i) => () =>
  agent(t, { label: `lane-${i + 1}`, isolation: 'worktree' })), { notes: true })
const review = await agent('Which lanes clash?', { notes: true, schema: CLASHES })
```

- **On for:** `agent(…, { notes: true })`, every agent a `parallel(thunks, { notes: true })`
  starts, or every agent of the run with `"notes": true` in the config.
  `notes: false` opts one agent out. Off by default: a Claude Code workflow runs
  exactly as written.
- **Posting:** an agent with notes on gets `ODW_NOTES`, the path of a small shell
  script of its own, and its prompt says how to use it: `"$ODW_NOTES" "renamed parseX
  → parse"` posts a note; `odw note "…"` does the same where odw is installed (it
  reads the agent's `ODW_RUN_ID`, `ODW_AGENT_ID` and `ODW_NOTES`). Who posted a note
  is the agent whose script dropped it, never what the note says.
- **Reading:** the notes posted before an agent started are in its prompt, under
  "Notes from the other agents in this run" (the latest that fit 8000 characters).
  A running agent is not sent new notes — a CLI takes its prompt once — but
  `"$ODW_NOTES"` alone prints the board as it is now, and the prompt says so.
- **Interface broadcast:** when an agent with notes on and `isolation: "worktree"`
  finishes with a kept change, odw posts a note for it before its `agent_finished`
  event, so the agents the script starts next see it: its diff stat, the files
  it touched, and the lines its diff added or removed that look like declarations
  (`export`, `def`, `func`, `pub fn`, `class`, `interface` — a cheap heuristic for
  every language, at most 12 lines).
- **Bounds:** each note is cut at 2000 characters and redacted like the run's
  events; the board holds 200 notes and 256 KiB, and the run says once when it is
  full. Notes are kept in the run directory as `notes.jsonl`.
- **In a container sandbox** the script works unchanged: the agent's own notes
  directory is bound read-write, the board read-only — no other agent's inbox is
  there to write to.
- **Seeing them:** `odw notes $RUN [--json]`, `note_added` events in `odw logs`, and
  `GET /api/runs/:id/notes`.

Claude Code's Workflow tool ignores these options. [`examples/coordinated-refactor.js`](examples/coordinated-refactor.js)
splits a change across isolated lanes on the board, has a reviewer read it, and
runs the lanes that clash again with every note in their prompt.

## Compatibility and migration

ODW implements the primitive surface below. Scripts that depend on a host's
private runtime behavior need the following checks before migration:

| Feature | ODW behavior and migration check |
| --- | --- |
| Nested `workflow()` | Implemented for one level, sharing the parent's scheduler, control and budget. Flatten deeper nesting. |
| Model selection | Pass `agent(..., {model})` using that CLI's model ID; an adapter without model routing support emits a note. A `meta.phases` entry's `model` (and `adapter`) is the default for its phase's agents, and `model: "@fast"` picks a tier's model per CLI — **ODW extensions** (see [per-phase adapters](#per-phase-adapters-model-tiers-and-fallback-chains-odw-extension)); a phase's model is a model ID like any other, so use a tier when its agents may run on more than one CLI. `meta.model` stays metadata. |
| `agentType` | A persona added to the prompt. It does not load a host's named subagent configuration or select an adapter. |
| Worktree isolation | Starts from committed HEAD, excludes uncommitted edits, and cleans up afterward. Changes are not merged and `agent()` returns the reply, not a diff; ODW keeps each isolated agent's change as a diff to review and apply (`odw diff`, `odw apply`, `keep` branches — ODW extensions; see [Review and apply](#review-and-apply-what-isolated-agents-changed-odw-extension)). `.worktreeinclude` is honored (ODW copies untracked files too, not only gitignored ones); its `symlink:` lines, `worktreeSetup` and the agents' `ODW_PORT` are ODW extensions — see [Isolated worktrees](#isolated-worktrees-and-agent-ports). |
| Budget | Counts output tokens: the CLI's own count where its adapter reports usage (the built-in `claude` and `codex` do — see [Usage and cost](#usage-and-cost-odw-extension)), else `ceil(chars / 4)` of each reply. Every CLI run counts: schema and rate-limit retries, and failed runs that reported usage. The guard runs before each dispatch and each schema retry; once the target is spent the run ends and agents still running are stopped. |
| JSON Schema | ODW checks the [documented subset](skills/open-dynamic-workflows/references/primitives.md#schema); `format` is an annotation. Any other keyword (`$ref`, `const`, `oneOf`, `maxItems`, …) still runs: the run's log names it and where it is, and a CLI that validates schemas itself (`claude`, `codex`) enforces it. `"schemaKeywords": "strict"` refuses such calls instead (ODW extension; see [Structured output](#structured-output-odw-extension)). Use explicit object/array types and supported constraints. |
| Script trust | Run trusted scripts only: a run executes the workflow body as ordinary JavaScript. Loading parses metadata as a pure literal without evaluating it; validation and compatibility warnings are not a sandbox. |
| Recovery | Every completed `agent()` result is saved as it lands. `odw resume` continues a paused live worker in place; on an ended run (done, failed, stopped, or stale after a crash) it starts a new run that replays each call whose prompt and options are unchanged and runs the rest. `rerun` starts over. See [Resume a run](#resume-a-run-odw-extension). |

The supported primitive names do not guarantee full runtime parity.
`validate(source)`, `exec(command)` and `checkpoint(title)` are ODW extensions and
must be removed when targeting a host that does not provide them (`validate()`
warns about `exec()` and `checkpoint()` calls). Recoverable `null` results require an explicit choice: accept a partial
result, retry, or fail when the task requires every item.

**Conformance suite.** [`conformance/`](conformance/) holds the dialect's behaviour
as runnable cases: plain workflow scripts in Claude Code's dialect, each with an
`expected.json` (its result, and the logs, phases and agents that matter), run on
a deterministic mock agent. `odw conformance [--json] [--case N]` checks this odw
against them (exit 1 on any failure; CI runs it). Each case says whether Claude
Code's docs settle its behaviour (`documented`) or not (`unspecified`: it pins
what ODW does). Scripts that keep to what the documented cases pin down run on
both. The cases run on Claude Code by hand — they are plain workflow files — and
[`conformance/README.md`](conformance/README.md) gives the format, so another
runtime can implement a runner.

## Run and observe

In an interactive terminal, `odw run` attaches a **live foreground view** — every
agent (and `exec()` command step, shown with a `$` prompt) as it starts, spins, and
settles, phase by phase, with the result printed at the end. Ctrl-C detaches (the run keeps going); `odw attach <id>` re-attaches.

```bash
odw run wf.js [--args JSON|@file]            # foreground in a terminal; run keeps its own worker
                                             #   --adapter <name> sets this run's default agent
                                             #   --permissions read|edit|full: what its agents may do
                                             #   --untrusted: keep the repository's CLAUDE.md, hooks… out
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
odw diff $RUN --stat     # what isolated agents changed; odw apply $RUN --agent N (or --all) lands it
odw notes $RUN           # what its agents told each other on the notes board (above)
odw compare $OLD $RUN    # what changed between two runs: setup, time, cost, failures, replies (below)
odw eval review          # cases × adapters × repeats: pass rate, cost and time per cell (below)
odw export $RUN --otlp   # the run as OpenTelemetry traces (OTLP/JSON; --send posts it; below)
odw bundle $RUN          # the run as one redacted file to share: $RUN.odwrun (odw view FILE shows it; below)
odw pause|resume|stop $RUN
odw approve|reject $RUN  # answer a checkpoint() the run waits at (--note TEXT, --checkpoint N)
odw approve $RUN --edit  # …approving its payload as you edit it in $EDITOR (or --payload JSON|@file)
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

**Workflows from Claude Code plugins** (ODW extension). A Claude Code plugin can ship
workflows — `.js` files in its `workflows/` directory, or wherever its
`plugin.json`'s `"workflows"` points. ODW runs the ones your installed, enabled plugins
ship, under the name Claude Code gives them:

```bash
odw workflows list --plugins          # <plugin>:<name>, and which plugin, version and scope
odw run acme-tools:release-audit      # in place, from the plugin's own directory
```

ODW reads `~/.claude/plugins/installed_plugins.json` (honoring `CLAUDE_CONFIG_DIR` and
`CLAUDE_CODE_PLUGIN_CACHE_DIR`; a project or local install counts only inside its
project) and `enabledPlugins` in your `~/.claude/settings.json` and the project's
`.claude/settings.json` and `.claude/settings.local.json` (a plugin with no entry
follows its `defaultEnabled`). It only reads: a plugin's files are never written, and
its scripts run through the same loader as any workflow — a `meta` that is not a pure
literal leaves a script out, as Claude Code leaves it out, and a run logs where its
workflow came from and any ODW-only primitive it uses. A bare name runs a plugin's
workflow only when no project or personal workflow has that name and one plugin ships
it; when a project workflow has it, the project's runs and the run says
`run acme-tools:release-audit for the plugin's`. `GET /api/workflows` lists them with
provider `claude-plugin:<plugin>`, and runs are filed under `<plugin>:<name>`. In an
[untrusted](#untrusted-repositories-odw-extension) run plugin workflows still run —
you installed them — but the repository's settings can only disable a plugin, and a
name never resolves to the repository's own `.odw/workflows` or `.claude/workflows`
(its path still runs it).

**Prefer a browser?** `odw serve` opens a zero-dependency live dashboard onto the same
run directory — every run as a live graph, its timeline, logs and result, streamed over
SSE. No build step, no extra deps, no network access on load.

```bash
odw serve [--open]                      # live dashboard at http://127.0.0.1:4317
odw serve --port 8080 --host 0.0.0.0 --token   # remote, read-only, token-gated (see Remote access)
odw view run.odwrun                     # a shared run bundle, read-only (see Share a run)
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
  `odw pause|resume|stop` control verb is unchanged; a run
  [paused for a spent quota](#pause-for-a-spent-quota-odw-extension) goes on at once;
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
odw approve $RUN --edit   # change the payload first, then approve what you changed
```

or with **Approve** / **Reject** on the run's page in the dashboard (loopback binds
only; it posts `{ action, checkpointId?, note?, payload? }` to `POST /api/runs/:id/checkpoint`;
`GET /api/runs/:id` lists `pendingCheckpoints`, and the run list names each waiting
run's oldest question as `waiting`). The call resolves to
`{ approved, note, by, payload, edited }` — `by` is `cli`, `dashboard` or `timeout` — and a rejection
is an answer, not an error: the script decides what "no" means.

**Approve with edits.** As with Claude Code's plan approval, the person can change
what they approve instead of rejecting and re-running. `odw approve $RUN --edit` opens
`$VISUAL` / `$EDITOR` (else `vi`; `notepad` on Windows) on the checkpoint's payload,
pretty-printed in a private temp file: save an edit to approve it; leave it unchanged
to approve as is; empty the file to abort without answering. Invalid JSON, or an edit
the checkpoint refuses, aborts with the error and keeps the file (its path is
printed). `--payload '<json>'` or `--payload @plan.json` approves an edit without an
editor, and the dashboard sends `payload` with `action: "approve"`. The call then
resolves with `payload` — the edit, or the checkpoint's own payload when there was
none — and `edited: true` only when it differs from the original as JSON; a rejection
and a timeout carry the original. Give `checkpoint()` a `schema` (JSON Schema, checked
by the same validator as `agent()`'s) and an edit must match it: `odw approve`, the API
and the run itself refuse one that does not, with the validator's errors. Without a
schema any JSON value goes — the payload is the script's own data and only the script
knows what an edit may be — so a script that relies on its shape should give one:

```js
const { approved, payload: approvedPlan } = await checkpoint('Run this plan?', { payload: plan, schema: PLAN })
```

- `payload` is any JSON value — a plan, a summary of the changes — kept up to 64 KiB.
- An edited payload is at most 256 KiB of JSON; `checkpoint_resolved` records
  `edited: true` and the edit (cut to 64 KiB like the question's).
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
them — the built-in `claude` adapter reports them all; the built-in `codex` reports
tokens only (its `turn.completed` events carry no dollars, and ODW invents no prices),
so its agents show tokens and no cost. Where a CLI reports no output tokens (the
text-mode adapters), ODW counts `ceil(chars / 4)` of the reply and marks the figure
`estimated`.

```text
$ odw status $RUN
20261017-101500-ab12cd  [done]  review-swarm
  dispatched: 9 agent(s)
  usage: 1.4M tokens in (1.2M cache read, 96k cache write) · ~50k out · $2.867 (estimated in part: 1 of 9 agents reported no output tokens)
  spend by phase (share of tokens):
    01  Scan    6 agents  1.1M  $2.100  78%  ███████████████▋
    02  Verify  2 agents  296k  $0.767  21%  ████▎
    03  Report  1 agent   10k~       —  <1%  ▏
    not every agent reported dollars, so shares are of tokens
    ~ partly estimated: a CLI that reports no count is measured as characters / 4
```

- `odw status` breaks the spend down by phase — the dashboard's spend receipt in
  text: a line per phase in the order the workflow declared them (one not started
  yet says so), then the agents outside every phase, each with its agents, tokens,
  cost and share, and a bar of Unicode blocks (`#` without a UTF-8 locale). The
  shares are of dollars when every agent that spent reported some, else of tokens.
  It fits 100 columns and is plain text under `NO_COLOR` or in a pipe.
- `odw list` adds a cost column when any listed run reported dollars (`—` for one
  that did not).
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
  built-in `claude`'s stream-json, `codex`'s `exec --json`, `kilo` and `opencode`), any other adapter's output as
  `{"kind":"text","text":…}` lines. The end of its stderr (the last 64 KB) goes to
  `agents/<agentId>.stderr.txt`; `odw logs --agent` shows its last lines after the transcript.
- A schema retry, a stall restart or a rate-limit retry goes on in the same file after an
  `{"kind":"attempt","n":2,"reason":"schema"|"stall"|"rate_limit"}` line.
- `maxTranscriptBytes` (default 5 MB per agent) bounds it: past it, one
  `{"kind":"truncated","bytes":N}` line ends the transcript. Transcripts hold whatever the
  agents read and ran — with likely secrets redacted as they stream
  (see [Secrets in what ODW keeps](#secrets-in-what-odw-keeps-odw-extension));
  `"maxTranscriptBytes": 0` keeps none.
- Keeping it never slows an agent down: lines are buffered and appended asynchronously.
- An agent replayed by `odw resume` ran no CLI, so it has no transcript — read the
  original run's.
- The dashboard's API serves it normalized:
  `GET /api/runs/:id/agents/:agentId/transcript?since=<i>` →
  `{ entries, next, more, truncated, replayed }`, each entry
  `{ i, kind: text|tool_call|tool_result|error|attempt|result|raw|truncated, text?, tool?, input?, output?, isError? }`,
  long fields clipped to 4 KB (`clipped: true`), and `redacted: true` on one a secret
  was kept out of.

### Compare two runs (ODW extension)

Re-ran a workflow after editing a prompt, switching adapter or model, or upgrading a
CLI? `odw compare` says what changed:

```bash
odw compare $OLD $NEW                  # setup differences, run totals with B − A, a row per agent
odw compare $OLD $NEW --agent judge    # one agent in both runs, and its whole reply diff (by label or id)
odw compare $OLD $NEW --json           # the same comparison for scripts — GET /api/compare?a=…&b=… serves it
```

- **Setup**: what the runs ran with that differs — the workflow source (its sha256 as
  launched), script, args, odw version, `--budget`, each adapter CLI's version, the
  settings that change behaviour (timeouts, retries, tiers, `fallback`, `models`, …),
  each used adapter's definition, and the adapters and models the agents used.
- **Run**: wall time, tokens in and out, cost, agents done and failed — A, B and B − A.
- **Agents**: each agent is matched across the runs by its label (one each run gives
  once), then by the call key `odw resume` replays by (same prompt and options), then
  by order within its phase; the rest show as only in A or only in B. Each row has
  both states, adapter/model, time, spend, attempts, kept-diff stats, and whether its
  reply is identical or differs (a bounded unified diff of a text reply, a bounded list
  of JSON paths for a structured one; `--agent` shows it whole).
- On a terminal, deltas are red when B is worse (more time or cost, newly failed) and
  green when better; `NO_COLOR` and pipes get plain text. The table fits 100 columns.
- Finished, failed and stopped runs compare alike; a run still going is compared as it
  stands, with a note.

What makes this possible is recorded with every run: odw's version and the workflow's
sha256 in `meta.json`, the behaviour settings on its `run_started` event, each agent's
call key and model on its `agent_started`, and — on an adapter's first agent of the run
— `<cli> --version`, run beside the agent and killed after 3 seconds, as a
`cli_version` event (`odw status` and `GET /api/runs/:id`'s `cliVersions` show it). It
never delays or fails a run; a CLI that does not answer is recorded as unknown. An
adapter whose command is node or another interpreter, a script or a relative path is
not probed. `"recordVersions": false` turns the probes off. `odw eval` (below) builds
on this.

### Evaluate a workflow (ODW extension)

Changed a prompt, a model tier or a CLI, and want to know if the workflow still does
its job — reproducibly, and on every CLI you use? Put a few cases in an eval file and
let `odw eval` run each one on each adapter, several times, and judge the runs:

```bash
odw eval review                          # .odw/evals/review.json; or a path: odw eval examples/evals/routing.json
odw eval review --adapter claude,codex --repeats 5   # override the file's adapters and repeats
odw eval review --json --out today.json  # the report as JSON (stdout and a file)
odw eval review --baseline today.json    # deltas against an earlier report; exit 1 when a cell regressed
```

```json
{
  "workflow": "review",
  "adapters": ["claude", "codex"],
  "repeats": 3,
  "concurrency": 2,
  "timeout": 900,
  "cases": [
    { "name": "small-diff", "args": { "diff": "…" },
      "checks": [
        { "state": "done" },
        { "path": "verdict", "equals": "approve" },
        { "path": "findings[0].file", "matches": "\\.ts$" },
        { "command": "jq -e '.findings | length < 5' \"$ODW_RESULT\"" },
        { "maxCostUsd": 0.5 }, { "maxSeconds": 300 }
      ] }
  ]
}
```

- **The file**: `workflow` (a name or a path, resolved like `odw run` from where you run
  `odw eval`), `cases` (`name`, `args`, `checks`), and optionally `adapters` (each runs
  the whole case set as the run's default adapter, like `odw run --adapter`; absent:
  the config's default), `repeats` (default 1), `concurrency` (runs at once, default 1),
  `budget` (tokens, each run's `--budget`), `timeout` (seconds; a run still going then is
  stopped and fails), `name` and `description`. It is validated strictly — an unknown
  key, a bad path or regex is an error naming where it is — before anything runs.
- **Checks** are judged on the run's outcome, with no model: `{ path, equals }` (deep
  equality), `{ path, contains }` (a substring, or an array element), `{ path, matches,
  flags? }` (a regex; a non-string value is matched as its JSON), `{ path, exists }`
  (`true`, or `false` for "not there"), `{ command, timeout? }` (exits 0, run by the
  shell in the project directory with `ODW_RESULT` — a file holding the result as JSON —
  and `ODW_RUN_ID` set; 300s unless it says), `{ state: "done" | "failed" | "stopped" }`,
  `{ maxCostUsd }` (an unknown cost fails it) and `{ maxSeconds }` (the run's start to
  end). Paths are dot/bracket notation into the result: `verdict`, `findings[0].file`,
  `["odd key"]`; `""` is the whole result. A case without checks gets `{ "state":
  "done" }`; one that lists checks gets exactly those, and a run passes when it meets
  all of them.
- **Runs**: every case × adapter × repeat is a real run in the run store, started from
  this directory and marked `origin: "eval"` with `eval: { name, case, adapter, repeat }`
  in its `meta.json` — `odw list` and the dashboard's run summaries say so. At most
  `concurrency` go at once. Progress is a line per finished run on stderr; Ctrl-C stops
  every run the eval started, keeps no report and ends `odw eval`.
- **The table**: per case × adapter, pass k/n, median wall time, total and mean cost and
  mean tokens; then the totals; then each failed run with the checks it missed and its
  run id — any two runs open side by side with `odw compare`.
- **The report** (JSON, `version: 1`; `src/eval/report.ts` documents every key) carries
  the definition and its sha256 (`evalHash`), the workflow's sha256, the odw version, the
  CLI versions the runs recorded, the cells, and every run with its id and failures. It
  is kept as `<runsRoot>/_evals/<name>/<id>.json` — `GET /api/evals` lists them and `GET
  /api/evals/:name/:id` serves one, read only — and written to `--out`.
- **`--baseline <report.json>`** compares each cell (by case and adapter) with an earlier
  report: pass rate, mean cost and median time, B − A. A cell whose pass rate fell
  regressed. Exit codes: 0 when every run passed — or, with `--baseline`, when no cell
  regressed; 1 otherwise; 2 for a usage error (nothing ran).

### Observability: OpenTelemetry traces (ODW extension)

Teams that already run Langfuse, Arize Phoenix, Jaeger, Grafana Tempo, Datadog or
Honeycomb can see each run there: `odw export` turns a run's record into an
OpenTelemetry trace after the GenAI semantic conventions — OTLP/HTTP with JSON
encoding, no SDK, no dependency.

```bash
odw export $RUN --otlp > trace.json          # offline: the run as OTLP/JSON (--out FILE does the same)
curl -H 'Content-Type: application/json' --data @trace.json "$ENDPOINT/v1/traces"
odw export $RUN --otlp --send                # or post it to the configured endpoint
```

With `otel` in the config, the worker posts every run's trace itself, once, when the run
has ended (done, failed or stopped):

```json
{ "otel": { "endpoint": "http://localhost:4318", "headers": {}, "captureContent": false } }
```

- **Spans.** `invoke_workflow <name>` for the run (`odw.run.id`, `odw.run.state`, its
  totals — never its args); `phase <title>` around each phase's work; `invoke_agent <label>`
  per agent with `gen_ai.provider.name` (`claude` → `anthropic`, `codex` → `openai`,
  `gemini` → `gcp.gemini`, `kimi` → `moonshot_ai`, others their adapter's name),
  `gen_ai.request.model` / `gen_ai.response.model`, `gen_ai.usage.*` (cache tokens included),
  `odw.agent.cost_usd`, `odw.agent.attempts`, and on a failure `error.type` = its reason
  (`rate_limit`, `quota`, …) with status ERROR; `execute_tool <name>` for every tool call
  its transcript shows (`gen_ai.tool.name`, `gen_ai.tool.call.id`, ERROR when it failed);
  `exec <label>` per `exec()` step and `checkpoint <title>` per wait.
- **Retries, fallbacks and quota waits** are span events on their agent (`odw.retry`,
  `odw.fallback`, `odw.quota_wait`): moments within one agent call, at the times the run
  recorded them — not links, which would need spans the run never had.
- **Ids are derived from the run id** (trace id: the first 16 bytes of
  SHA-256(`odw/run/<runId>`); span ids likewise from what each span is), so exporting a
  run again yields the same ids and a backend that keys on them keeps one copy. A resumed
  run's root links to the run it resumed.
- **Times** come from the run's events. Claude Code's stream-json carries no times, so its
  tool calls are placed by where they sit in the transcript, marked `odw.timing.estimated`;
  opencode and kilo report their own.
- **Content is off by default** — prompts, replies and tool output are sensitive. With
  `"captureContent": true` (or `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true`)
  the trace also holds replies (`gen_ai.output.messages`), tool arguments and results, error
  text, `exec()` command lines and checkpoint payloads — the text odw kept, already
  redacted, redacted once more on the way out whatever `redact` says (no environment value
  ever leaves), each field cut at 4096 characters with `…`. Prompts are not kept, so never
  exported.
- **Only the config turns it on.** `OTEL_EXPORTER_OTLP_ENDPOINT` (or `…_TRACES_ENDPOINT`),
  `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES` fill in
  what `otel` leaves out — people set them for other tools, so they alone send nothing. The
  endpoint defaults to `http://localhost:4318`; `/v1/traces` is appended.
- **It never costs the run anything:** one POST with a 5-second limit (shorter if
  `OTEL_EXPORTER_OTLP_TIMEOUT` says), after the outcome is written; a failure is one line in
  the run's `worker.log`. Header values are secrets: never logged, never in events;
  `odw doctor` shows whether export is on, the endpoint's scheme and host, and header names.
- **JSON, not protobuf.** A receiver that takes OTLP/HTTP JSON gets the trace directly (Jaeger,
  Langfuse, the OpenTelemetry Collector); one that takes only protobuf or gRPC (Arize Phoenix,
  for one) gets it through a Collector, whose `otlp` receiver forwards it in either.

Langfuse (its OTLP endpoint takes HTTP Basic auth of the project's key pair):

```json
{
  "otel": {
    "endpoint": "https://cloud.langfuse.com/api/public/otel",
    "headers": {
      "Authorization": "Basic BASE64_OF_PUBLIC_KEY_COLON_SECRET_KEY",
      "x-langfuse-ingestion-version": "4"
    }
  }
}
```

Jaeger, locally (its all-in-one image receives OTLP on 4318; the UI is on 16686):

```bash
docker run --rm -d -p 16686:16686 -p 4318:4318 jaegertracing/all-in-one
echo '{ "otel": { "endpoint": "http://localhost:4318" } }' > odw.config.json
odw run wf.js            # or, for a run you already have: odw export $RUN --otlp --send
```

### Share a run (ODW extension)

Show a run to a teammate, attach it to an issue, or keep it after the run directory is
gone: `odw bundle` writes the run as **one self-contained, redacted file**, and
`odw view` shows it on the dashboard, read-only — no odw config, no runs root, nothing
else of the machine that made it.

```bash
odw bundle $RUN                       # → ./$RUN.odwrun
odw bundle $RUN --out run.odwrun --no-transcripts   # leave the agents' transcripts out
odw view run.odwrun                   # = odw serve --open run.odwrun: opens the run in a browser
```

- **What is in it.** One JSON object (`"format": "odw-run-bundle"`, `"version": 1`): the
  run's meta (its name, script, args, source, adapter, odw version, workflow sha256,
  times), its status, every event, each agent's saved result, the kept diffs, the agents'
  transcripts and stderr (`--no-transcripts` drops them), the result and the error.
- **Redacted, always.** Everything in it — args included — goes through the run's
  redactor: the token shapes, the values of the secret-named variables of the environment
  odw starts agents with (yours and each adapter's `env`), `NAME=value` of secret-looking
  names, and your `redact.extra` — even when the config says `"redact": false`. Each piece
  that had something replaced is marked `redacted: true`, and so is the bundle.
  Kept diffs are redacted too, so a bundle's diff is for reading, not for `odw apply`.
- **Never in it:** the config file or its path, the environment, `notify` and `otel`
  settings, the worker's pid, the worker log, the run's control files. (Prompts are not
  kept in run records, so they are not in it either.) Look before you share:
  `odw view` it first.
- **Capped.** A bundle over 32 MiB is refused with its size and the ways out —
  `--no-transcripts`, or `--max-bytes N` to raise the cap (`odw view` takes the same flag).
- **Opening one trusts nothing in it.** Its size is checked before it is read; the format,
  version and every field's type are checked; the run id must be a run id
  (`[A-Za-z0-9._-]`, not a Claude Code `cc-` id) and every agent id a non-negative
  integer, at most 10 000 agents. It is unpacked into a fresh private temp directory
  (mode 0700) under fixed file names — nothing the file says becomes a path — and removed
  when `odw view` exits. The dashboard then shows that run alone, tagged **shared bundle**:
  no other runs, no Claude Code runs, workflows, schedules or local settings, and every
  write refused (409), on loopback too.

The dashboard's **Share** button on a run copies `odw bundle <run>`.

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
  is attached to a real background run whose tool card updates live. A plain turn
  runs `codex exec --json` (read-only sandbox, `--ephemeral`) and reads it as the
  built-in `codex` adapter does: the reply is its `--output-last-message` file, else
  its last `agent_message`, and each message shows as it completes while the reply
  streams. The turn's tokens (from `turn.completed`; codex reports no dollars) are
  kept on the message as `usage`. A failure codex reports is classified like an
  agent's: a spent quota or a refused login says what to do — wait for the window to
  reset, or `codex login` — and the message carries `failureReason` (`quota`,
  `auth`, …) (ODW extensions).

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
  <tr>
    <td width="50%">
      <strong>Spend</strong><br />
      <img src="assets/app-screenshots/spend.png" alt="A run's spend receipt: tokens and dollars by phase with share bars, the split by adapter, and the agents that spent most" />
    </td>
    <td width="50%">
      <strong>Compare</strong><br />
      <img src="assets/app-screenshots/compare.png" alt="Two runs of a workflow compared: wall time, tokens, cost, done and failed with their deltas, what the runs ran with, and a row per agent" />
    </td>
  </tr>
</table>

Press <kbd>⌘K</kbd> / <kbd>Ctrl K</kbd> (or <kbd>/</kbd>) for the command palette —
jump to any run or workflow, switch theme or language, copy a follow or rerun command.
<kbd>g</kbd> then <kbd>a</kbd>/<kbd>j</kbd>/<kbd>w</kbd>/<kbd>c</kbd>/<kbd>s</kbd> moves
between views, <kbd>1</kbd>–<kbd>5</kbd> switch a run's tabs, <kbd>$</kbd> unfolds where it spent, and <kbd>+</kbd>/<kbd>-</kbd>/<kbd>0</kbd>
zoom the graph. When a run finishes the dashboard says so, and — if you opt in under
Settings — sends a desktop notification while the tab is in the background.

```bash
odw run adversarial-verify --args '{"question":"review src/rate-limiter.js"}'
odw logs --workflow adversarial-verify --follow
```

The dashboard can be viewed off-loopback, but local write operations such as
Chat messages and stopping ODW-owned runs stay guarded by the loopback server.
Claude Code's own runs stay strictly read-only. What it serves of ODW's agents —
transcripts, results, logs, chat sessions — had its likely secrets redacted before it
was written, and a run's `args` are redacted as they are served (see [Secrets in what ODW keeps](#secrets-in-what-odw-keeps-odw-extension)).

### Remote access, read-only (ODW extension)

Watch an overnight run from your phone without handing anyone your machine:

```bash
odw serve --host 0.0.0.0 --token
# odw dashboard → http://192.168.1.20:4317/#token=Xq3…   ← open this one; it is printed once
```

With `--token` and no value, odw makes a random 256-bit token and prints the URL with it
once, as `#token=…` — a fragment, which no request carries, so the token stays out of
server and proxy logs; odw writes it nowhere else. `--token VALUE` (16–256 characters of
`A-Z a-z 0-9 . _ ~ -`) uses yours and never prints it — it does show in the process list,
so prefer the generated one on a shared machine.

The security model:

- **Every `/api` request and the live stream need the token**, one of three ways:
  `Authorization: Bearer <token>` (scripts, `curl`); `?token=<token>` on a request, whose
  answer sets an `HttpOnly`, `SameSite=Strict` cookie (`odw_token_<port>`); or that
  cookie. The dashboard trades the URL's `#token=` for the cookie on load and drops it
  from the address bar. Without a token: 401; the page itself loads and shows a
  "needs a token" screen to paste one into.
- **Tokens are compared in constant time** (both sides hashed first). An address that
  sends 10 wrong tokens within a minute is answered 429, whatever it sends, until the
  minute is up (an IPv6 address counts by its /64); a request with no token at all is
  not counted. Past 100 wrong tokens a minute from everyone together, no token is
  checked until the minute is up, so many addresses cannot keep guessing.
- **Writes stay refused off loopback, whatever the token**: stopping or pausing runs,
  answering checkpoints and Chat are 409 on any bind but 127.0.0.1 / localhost / ::1.
  The token gives remote *reads*, never writes. (On a loopback bind, `--token` gates
  writes like reads, and every existing write guard still applies: exact
  `Content-Type: application/json`, same-origin `Origin`, the DNS-rebinding Host check.)
- **It is plain HTTP.** The token and everything the dashboard shows cross the network
  unencrypted: use it on a network you trust, over a VPN or SSH tunnel
  (`ssh -L 4317:localhost:4317 host` needs no `--host` at all), or behind a TLS proxy.
- **What a token-holder reads** is what the dashboard shows: every project's runs — ODW's
  and, with the default `claudeJobsScope: "all"`, Claude Code's — their args, results,
  events, agents' transcripts and diffs (secrets redacted as above), and the settings
  page's paths and adapters. Narrow it with `--runs-root` and `"claudeJobsScope": "project"`,
  or share one run as a [bundle](#share-a-run-odw-extension) instead.
- **Without `--token`**, an off-loopback bind behaves as before — read-only and open to
  anyone who can reach the port — and `odw serve` prints a loud warning that suggests
  `--token`.

## Configure adapters

Codex, Claude Code, Gemini, Qwen, Kimi, Oh My Pi, Kilo Code, OpenCode, and
Cursor work out of the box:

| Adapter | Local CLI | Non-interactive contract |
| --- | --- | --- |
| `codex` | `codex` | `exec --json` events; reply from its `--output-last-message` file (else its last `agent_message`), tokens from `turn.completed`, errors from `turn.failed` / `error`; web search enabled; strict schemas natively (`--output-schema`) |
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
  "deniedPath": ["permission_denials"], // tool calls the CLI refused: kept on the agent, logged
  "mcpEvent": "system",           // the event that lists the MCP servers (Claude Code's init)
  "mcpPath": ["mcp_servers"]      // { name, status } each: one not connected is kept and logged
}
```

The built-in `codex` (ODW extensions throughout) reads `codex exec --json`: its reply
is the last `item.completed` event whose `item.type` is `agent_message` (`match`) —
unless the file it writes its final message to (`--output-last-message
{reply_file}`) has it, which wins: `{reply_file}` is a fresh path in a private temp
directory for each CLI run, read once the CLI exits and then removed. Its tokens come
from `turn.completed`, and `turn.failed` and `error` events are its own failure report
(`errorEvents`: event type → path to the message), classified like any failure —
an `error` codex retried itself, followed by a completed turn, is no failure:

```jsonc
"codex": {
  "label": "Codex CLI",
  "command": ["codex", "--search", "exec", "--json", "--output-last-message", "{reply_file}",
              "--skip-git-repo-check", "{permission_args}", "--cd", "{workspace}", "-"],
  "stdin": "{prompt}",
  "flags": { "model": ["--model"], "schema": { "args": ["--output-schema"], "mode": "file", "strict": true } },
  "output": {
    "format": "jsonl",
    "eventType": "item.completed",
    "match": { "path": ["item", "type"], "equals": "agent_message" }, // only these events hold the reply
    "textPath": ["item", "text"],
    "select": "last",
    "usageEvent": "turn.completed",
    "usagePath": ["usage"],                                          // tokens only: codex reports no cost
    "errorEvents": { "turn.failed": ["error"], "error": ["message"] }
  },
  "permissionArgs": {
    "read": ["--sandbox", "read-only"],
    "edit": ["--sandbox", "workspace-write"],
    "full": ["--sandbox", "danger-full-access"]
  }
}
```

An entry that gives `codex` its own `command` replaces the built-in whole: keep this
`output` block (and `--json`) with it, or its agents report no usage and their reply
is codex's text output. When a codex turn ends with no agent message — its reply file
empty and no `agent_message` event — the reply is empty, so the agent fails with
`empty_reply` (`allowEmpty: true` accepts it) instead of returning a dump of events,
and the run's log says exactly what was missing; when its events lack the reply but
the reply file has it, the reply stands and the log says the events did not match.

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
the run's log says why; the agent does not fail. A CLI that also writes its reply to
`{reply_file}` (as `codex` does) is read from there first, and when both are empty
its reply is empty rather than a dump of events.

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
`-p`; run such a repository [untrusted](#untrusted-repositories-odw-extension).

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

### Untrusted repositories (ODW extension)

Running agents on someone else's repository is dangerous: its CLAUDE.md or AGENTS.md
steer the agent, and its hooks, MCP servers and project settings run inside it. Run
such a repository **untrusted** — `odw run|rerun|resume --untrusted`, or
`"trust": "untrusted"` in your config (the default is `"trusted"`; a rerun or resume
of an untrusted run stays untrusted). Each CLI then runs in the way of ignoring the
repository its own docs give, after its tier's flags; where it has none, the run says
so once per adapter — never silently:

| Adapter | Untrusted | What still reaches the agent |
| --- | --- | --- |
| `claude` | `--safe-mode` (CLAUDE.md, skills, plugins, hooks, MCP servers, commands, agents, workflows off; auth works) | nothing |
| `qwen` | `--safe-mode` (context files, hooks, extensions, skills, MCP servers off) | nothing |
| `omp` | `--no-extensions --no-skills --no-rules` | AGENTS.md, CLAUDE.md, hooks, MCP config |
| `codex` | no documented way | AGENTS.md (its `.codex/` config, hooks and rules load only for a project you trusted) |
| `gemini` | no documented way (its untrusted-folder mode exits headless) | GEMINI.md, `.gemini/settings.json` |
| `kimi` | no documented way | AGENTS.md, skills |
| `kilo`, `opencode` | no documented way | AGENTS.md, project config, `.kilo/` / `.opencode/` |
| `cursor` | no documented way | `.cursor/rules`, AGENTS.md, CLAUDE.md, `mcp.json`, hooks |

Claude Code's `--bare` would skip even more, but it takes API-key auth only, so
subscription logins could not use it. A line such as
`codex has no documented way to ignore the repository's AGENTS.md — its instructions
still reach the agent` lands in the run's log the first time an agent runs on codex.

The repository's own code that ODW itself would run is refused: the `symlink:` lines
of its `.worktreeinclude` link nothing (a link hands agents the source tree; plain
lines still copy), and a `worktreeSetup` set by a config inside the repository — such
as its `./odw.config.json` — does not run, with a log line saying so. A `worktreeSetup`
from your own config (`--config`, `$ODW_CONFIG`, or `~/.config/odw/config.json`
outside the repository) still runs. A config ODW would find by itself inside the
repository — its `./odw.config.json` — is not read at all in an untrusted run: its
adapter commands are the repository's code. The run uses your
`~/.config/odw/config.json` (outside the repository) or the built-in defaults, and says
so; one you name with `--config` or `$ODW_CONFIG` is your choice and still applies. A
repository's config cannot loosen the `"trust": "untrusted"` your
`~/.config/odw/config.json` sets.

```jsonc
{
  "trust": "untrusted",
  "adapters": {
    "codex": { "trust": "untrusted" },  // or: only this adapter, in every run
    "my_wrapper": {
      "command": ["my-agent", "{permission_args}", "--cwd", "{workspace}"],
      "permissionArgs": { "edit": [] },
      "untrustedArgs": ["--no-project-config"],           // goes after the tier's flags
      "untrustedNote": "my-agent still reads .my-agent/rules" // said once per untrusted run
    }
  }
}
```

The start banner has a trust line — `trust: untrusted — claude --safe-mode, codex no
documented way` — and `odw doctor` shows the config's trust and how each adapter runs
untrusted. An untrusted agent's `agent_started` event, saved result and
`odw agents --json` row carry `trust: "untrusted"`, the dashboard's drawer shows it,
and the run's `run_started` setup records `trust`. Untrusted is not a sandbox: it
keeps the repository's instructions and configuration out where a CLI allows, and the
permission tier still decides what agents may do.

### Run agents in containers (ODW extension)

By default ODW runs each agent CLI on your machine, as you, held back only by the CLI's
own permission flags. The container sandbox runs each CLI run — and each `exec()` step —
in a fresh Docker or Podman container instead. It is opt-in, and the image is yours: it
must hold the CLIs, and ODW never pulls it.

```bash
docker build -t odw-agents --build-arg UID=$(id -u) --build-arg GID=$(id -g) examples/sandbox
odw doctor                                   # engine found, image present, a smoke run
odw run wf.js --sandbox container --sandbox-image odw-agents
```

[`examples/sandbox/Dockerfile`](examples/sandbox/Dockerfile) builds one with Node, git,
Claude Code and Codex (pin their versions with `--build-arg CLAUDE_CODE_VERSION=…`). Or
set it in your config, per run, per adapter, or per call:

```jsonc
{
  "sandbox": {
    "kind": "container",
    "image": "odw-agents",          // required; never pulled
    "engine": "docker",             // or "podman"; default: docker if installed, else podman
    "network": "default",           // or "none" (see below)
    "cliConfig": "copy",            // or "mount-ro" | "none"
    "mounts": [{ "source": "~/datasets", "readonly": true }], // read-only unless "readonly": false
    "memory": "4g", "cpus": 2, "pids": 512 // pids defaults to 512; the rest to the engine's
  },
  "adapters": {
    "codex": { "sandbox": { "kind": "container", "image": "odw-codex", "network": "none" } }
  }
}
```

```js
await agent('Review this diff', { sandbox: { network: 'none', memory: '1g' } })
await agent('Summarize', { sandbox: { image: 'odw-agents' } }) // a call in a run on the host
await exec('npm test')                                          // in the run's container, offline
await exec('npm ci', { network: 'default' })                    // a step that needs the network
```

Like permissions, the sandbox only tightens: an adapter's `sandbox` may turn the
container on and set its own image, engine, CLI config and more mounts, and of network
and the limits the stricter wins; an `agent()` call's may turn it on (naming an image
only when nothing else does), take the network away, lower a limit or drop the CLI's
config (`cliConfig: "none"`). Anything looser — `sandbox: "none"` under a container, a
network its sandbox has not, more memory, another image, mounts — fails the call before
it starts. `odw run|rerun|resume --sandbox container [--sandbox-image <image>]` puts a
whole run in one (the config's container, or one of that image); a rerun or resume of a
sandboxed run stays sandboxed.

What each CLI run becomes (`docker run --rm -i --init --pull never --name odw-<run>-<agent>-<rand> --label odw.run=<run> …`):

- **The workspace, and nothing else of yours.** The agent's workspace — its isolated
  worktree, or the run's source — is bound read-write at the same path and is the
  working directory, so diffs, transcripts, `expect` checks and `{workspace}` work as
  before. The rest of the host's filesystem is not there: only a private home, the files
  this CLI run is handed (its prompt file, schema file and reply file), and the `mounts`
  you list. In an isolated worktree, `git` inside the container cannot reach the
  repository (the worktree's `.git` points outside it); ODW takes the diff on the host as
  always. Bind the repository's `.git` read-only with `mounts` if your agents need history.
  The workspace's own `.git` (a worktree's `.git` file, or the repository's `.git`
  directory when agents work in place) is bound **read-only**: ODW runs git on the host
  in that directory afterwards, and config an agent planted there (`core.fsmonitor`,
  hooks) would otherwise run on the host. Every git ODW runs also turns fsmonitor and
  hooks off, and a reply file that is a link or a FIFO is refused, never followed.
- **The CLI's login, as a copy.** `cliConfig: "copy"` (the default) copies the CLI's own
  login and config files into a private temporary home (bound at `/odw/home`, removed
  after the run), so the agent can use them but never change yours. Only the files each
  CLI's docs name: Claude Code's `~/.claude/.credentials.json`, `settings.json`,
  `CLAUDE.md`, `agents/`, `commands/`, `skills/` and `~/.claude.json` without its
  `projects` (your other repositories); Codex's `~/.codex/auth.json`, `config.toml`,
  `AGENTS.md`; Gemini's `~/.gemini/settings.json`, `oauth_creds.json`,
  `google_accounts.json`, `GEMINI.md`, `.env`. Never session history or logs.
  `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are honoured. `"mount-ro"` binds those files
  read-only instead (Claude Code rewrites `~/.claude.json` as it runs: prefer `copy` for
  it); `"none"` leaves the home empty. On macOS Claude Code keeps its login in the
  Keychain, so there is nothing to copy: set `CLAUDE_CODE_OAUTH_TOKEN` (from
  `claude setup-token`) or `ANTHROPIC_API_KEY`; for Codex `CODEX_API_KEY`, for Gemini
  `GEMINI_API_KEY`. The run says once when it found nothing to copy. A CLI that refreshes
  its login inside the container writes the new token to the copy, which is thrown away;
  where the provider rotates refresh tokens, your own login may then need a fresh
  `/login`, so long-lived tokens and API keys suit sandboxed runs best.
- **You, with no privileges.** `--user` your uid:gid (Podman: also `--userns keep-id`),
  so what agents write is yours; `--cap-drop ALL`, `--security-opt no-new-privileges`,
  `--pids-limit` (512), optional `--memory` and `--cpus`, a read-only root filesystem
  with a tmpfs `/tmp`, and `--init` to forward signals.
- **Only the environment `agentEnv` lets through** — set `"agentEnv": "minimal"` to keep
  your shell's other secrets out — passed by name (`--env NAME`), so no value appears in
  a process listing, less the host's paths (`PATH`, `HOME`, `TMPDIR`, `XDG_*`,
  `CLAUDE_CONFIG_DIR`, `CODEX_HOME`).
- **`ODW_PORT` still set, nothing published.** A server an agent starts on its port is
  reachable inside its container only.
- **Killed with the run.** A CLI run that times out, stalls, is stopped or does not exit
  cleanly has its container killed by name (`docker kill`, then `docker rm --force`);
  killing the engine client alone would leave it running. If the worker itself is killed,
  its exit handler removes every container it still has. `docker ps --filter label=odw.run`
  finds any left by a crash.

A missing engine or image fails the run before its first agent starts, with a
`ConfigError` that says how to build the image; `odw doctor` checks the same and runs
`docker run --rm --pull never --network none <image> true` (no model involved). The
start banner adds a sandbox line when a container is configured, each agent's `agent_started` event and the dashboard's
AgentView carry `sandbox: { kind, engine, image, network }`, and the run's setup records
`sandbox` for `odw compare`. Sandboxed agents record no CLI version: the probe runs on
the host, whose CLI is not the image's.

**What it protects, and what it does not.** It keeps an agent — and anything it runs —
from reading or changing the rest of your filesystem (your SSH keys, other repositories,
your shell profile, your real CLI config), from running as anything but you, and from
leaving processes behind. It does **not** keep your code from the model: the agent
still sends what it reads to its model API. With `network: "default"` (the default, as
agent CLIs must reach their model API) it has the open network, so it can send your
workspace and the secrets in its environment and login anywhere — keep secrets out of
`agentEnv`, and use `network: "none"` wherever no model API is needed (`exec()`
steps are offline by default). The workspace is writable: what an agent writes
there — a git hook in a repository it works in place, a `package.json` script, a
Makefile — runs on your host when you later run it, so review changes (isolated
worktrees and `odw apply` help). A container shares the host's kernel; it is not a VM.
Rootless Docker maps uids its own way, so files may come out owned by another uid; on
SELinux hosts, binds may need relabelling. Windows hosts are not supported.

### Secrets in what ODW keeps (ODW extension)

An agent prints whatever it reads — `cat .env` included — and ODW keeps that output:
its transcript and the end of its stderr, its reply (its saved result), the run's log
and error, what a webhook is told. The dashboard serves all of it, off-loopback too. So
before any of it is written, ODW replaces each likely secret with a marker that says
what it was:

```text
the key is «redacted:env:STRIPE_SECRET_KEY»
Authorization: Bearer «redacted:bearer»
cloning with «redacted:github»
```

- **`env`** — the value of every variable whose name looks secret (`*_KEY`, `*_API_KEY`,
  `*TOKEN`, `*SECRET*`, `*PASSWORD*`, `*_PWD`, `*_PAT`, `AUTHORIZATION`, cloud
  credentials such as `AWS_ACCESS_KEY_ID` and `*CONNECTION_STRING`, webhook URLs) in the
  environment ODW starts agents and `exec()` commands with — its own, and each adapter's
  `env` — wherever it appears (values of 8 characters or more, matched exactly), as
  `«redacted:env:NAME»`; and the value of any `NAME=value` printed whose `NAME` looks
  secret (a `.env` file, `env` output).
- **`patterns`** — well-known token shapes: Anthropic (`sk-ant-…`), OpenAI (`sk-…`,
  `sk-proj-…`), GitHub (`ghp_…`, `gho_…`, `ghs_…`, `github_pat_…`), Slack (`xoxb-…` and
  its kin), AWS access key ids, Google API keys, JWTs, PEM private-key blocks and
  `Bearer` tokens — as `«redacted:anthropic»`, `«redacted:openai»`, …
- **`extra`** — regular expressions of your own (JavaScript sources), as `«redacted:extra»`.

```jsonc
// The default, plus a pattern of your own:
{ "redact": { "env": true, "patterns": true, "extra": ["corp-[0-9a-f]{32}"] } }
// Keep everything as printed:
{ "redact": false }
```

Redacted: transcripts (as they stream — a secret split across two chunks of output
included) and stderr tails; saved agent results (`odw result --agent`, the dashboard's
agent drawer); the run's events — `odw logs`, log lines, `agent_failed` errors (a
failure's quoted output is redacted before it is cut, so no secret is kept in half),
the command lines `exec()` steps show and the output a failed `check` quotes; the
run's error; the waiting checkpoint in `status.json`; webhook payloads; the run's
`worker.log` — the worker's own output, a workflow's `console.log` of an agent's
reply included, redacted as it is written; and the Chat Host's sessions
(`<runsRoot>/_chat/sessions.json`, and what `/api/chat/sessions` serves): Codex's
replies in full, what you typed — and the run results posted back as messages — of
token shapes only, since they are your data; a reply still streaming keeps only its
whole lines until it settles, and a sessions file kept before redaction was on is
redacted as it is read. A run's `args` are your data too, and may hold a token: what
`/api/runs/:id` and the dashboard serve of them has its token shapes redacted
(`argsRedacted: true`), and so does what `/api/schedules` serves of a schedule's —
but `meta.json` and the schedule keep them as given, so `odw rerun` and `odw resume`
start the new run with the original args. What had anything redacted says so with
`redacted: true` — a saved result, an event, a transcript line and its entry in the
API, `result.json`, `error.json`, a webhook payload, a chat message — and `odw doctor`
says whether redaction is on and which variables it covers.
It runs as output arrives, without holding it: a line waits for its end, and a private
key for its last line.

Not redacted:
- **What agents get.** Prompts and an agent's environment are never touched, nor what
  `agent()` and `exec()` hand back to the workflow: redaction is about what is written
  down.
- **The run's result** is the workflow's own data — it may return a config it read on
  purpose — so `result.json` gets `patterns` and `extra` only, never `env`.
- **Kept diffs** (`agents/<id>.diff`) are an agent's change to your code: what
  `odw apply` applies and a kept branch commits, where a marker would corrupt your
  files. A secret an agent wrote into code is there to be caught in review (`odw diff`,
  the dashboard's Changes tab).
- **The run's `args` as kept** in `meta.json` (and a schedule's): `odw rerun` and
  `odw resume` must start from what you passed in. Only what is served of them is
  redacted. Nor is what Codex is given in the Chat Host: the message a turn answers
  goes to it as you typed it (earlier messages as kept).
- **A resumed run** replays an agent's saved result as it was kept — redacted — and its
  log says so.

Redaction is a safety net, not a vault: a secret of a shape it does not know, under a
name that does not look secret, is kept as printed. With `agentEnv: "minimal"`, agents
never see what they do not need in the first place.

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
enable for it), `codex` (`exec --json` prints an event per command, edit and message),
the JSONL adapters `kilo` and `opencode`, or a wrapper that prints
a heartbeat — with a value above the longest quiet stretch a healthy agent has: a
long test run inside one tool call prints nothing either.

### Per-agent limits and runaway loops (ODW extension)

An agent stuck in a loop keeps printing, so the stall watchdog never fires, and
`--budget` caps the whole run, not one agent. `limits` caps one `agent()` call:

```js
await agent("Fix the failing test", {
  limits: { toolCalls: 200, costUsd: 3, outputTokens: 200000, seconds: 1800, repeat: 5 },
});
```

| Limit | Trips when |
| --- | --- |
| `toolCalls` | the agent made more tool calls than this, over all its CLI runs |
| `costUsd` | its CLIs reported spending more dollars than this |
| `outputTokens` | its CLIs reported generating more tokens than this |
| `seconds` | this long has passed since its first CLI run started |
| `repeat` | the same tool call — its name and a hash of its arguments — came this many times **in a row** (2 or more) |

They are enforced **live**, from what the CLI prints as it runs: Claude Code's
stream-json (tool_use blocks and each message's usage; its cost arrives with its
final `result`), Codex's `exec --json` (command, file-change, MCP and web-search items;
each turn's usage) and kilo's and opencode's events (tool calls; each step's tokens and
cost). A breach kills the agent's CLI and everything it started at once, like a stall,
and the agent fails with reason `runaway`: its `agent_failed` event carries
`limitHit: { limit, max, value, evidence }` and its error says
``adapter 'claude' ran away — limits.repeat=5: Bash `npm test` ×5 in a row``
(or `41 tool calls > 40`, `$3.12 > $3.00`). A runaway is not retried by
`transientRetries`, and under `expect` it is not a miss to run again — its limit is
spent. `odw status` lists the runaways with their evidence, `odw agents` shows it in
place of the value, and the dashboard's drawer shows the agent's limits with the one
it hit.

`repeat` counts calls in a row, not *n* within the last *2n*: the windowed rule also
fires on a healthy edit–test cycle (`npm test`, edit, `npm test`, edit, …), while the
same call with the same arguments back to back means nothing the agent did in between
could change the answer. Each further CLI run of the call (a retry, a restart) starts
its own streak.

Set defaults for every agent in the config, and per adapter; a call's `limits`
override both key by key, and `null` lifts an inherited limit:

```jsonc
{
  "agentLimits": { "toolCalls": 300, "repeat": 6 },   // {} (the default) sets none
  "adapters": {
    "codex": { "agentLimits": { "seconds": 1800, "repeat": null } }
  }
}
```

A CLI that prints text (`gemini`, `qwen`, …) reports no usage while it runs: its
`outputTokens` and `costUsd` are checked after each run, against what it reported or
chars/4 of its reply — the run's log says so once. A CLI that reports no dollars at all
(Codex) cannot trip `costUsd`; the log says that once too — use `outputTokens`.

### Rate limits, quotas and logins

**ODW extension.** Every failed agent is classified from its CLI's exit status
and the end of its output: `rate_limit`, `quota`, `auth`, `timeout`, `stalled`,
`not_found` (the CLI could not start), `permission` (a tool call or approval was
refused) or `exit` — and four classes for runs that "succeeded" without the
evidence: `empty_reply`, `unmet_expectation`, under `"mcpFailures": "fail"`
`mcp_unavailable`, and `orphaned_background` (background work left running at the
reply, under `"orphanedBackground": "fail"` or `expect`; see
[Check an agent's work](#check-an-agents-work-odw-extension)) — and `runaway`, an agent killed at one of its
[limits](#per-agent-limits-and-runaway-loops-odw-extension). The class is the `reason` on the `agent_failed` event (with
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
  the run's later agents skip that adapter. With [`quotaWait`](#pause-for-a-spent-quota-odw-extension),
  an agent with no CLI left waits for the quota to reset instead of failing.

Claude Code reports such errors in its output, often with exit 0: its stream-json
`result` event says `is_error: true` with the message (`API Error: Rate limit
reached`, `Claude AI usage limit reached|…`), and that counts as the failure it
names. So do Codex's `turn.failed` and `error` events (`Quota exceeded. Check your
plan and billing details.`, `exceeded retry limit, last status: 429 Too Many
Requests`) — except an `error` it retried itself, after which its turn completed. In text mode (a text adapter, or JSON output that fell back to its raw
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

### Pause for a spent quota (ODW extension)

**ODW extension.** A long run whose every usable CLI is out of quota fails its
remaining agents — fast, thanks to the quota breaker. Left running overnight, you would
rather it waited for the reset and carried on. `quotaWait` makes it do that:

```jsonc
{
  "quotaWait": { "max": 21600 } // wait up to 6 hours for a spent quota to reset; false (the default) fails as above
}
```

When an agent has run out of CLIs on a spent quota — its last adapter's quota failed,
or the quota breaker skipped every one — and a CLI said when its quota resets ("try
again in 3h 22m", "resets 7pm", Claude Code's `usage limit reached|<epoch>`) no more
than `max` seconds away, the run **pauses** instead of failing it:

- The agent waits holding no slot, so agents on CLIs with quota left keep running.
  Until the reset a CLI named, the run passes over that CLI: an agent with a fallback
  moves on, and one with nowhere else to go waits too — before it starts, so it shows
  no agent and takes no slot meanwhile.
- The run shows `paused` and what it waits for: `odw status`, `odw list` and the live
  view say `paused until 19:10 (codex quota)`, `odw run --wait` says it once, and
  `status.json` and `GET /api/runs[/:id]` carry
  `pausedFor: { "reason": "quota", "adapter", "resumeAt" }` (`resumeAt` in Unix seconds).
- At the reset — plus up to 30 seconds of jitter, so the waiting agents do not all come
  back in the same second — each starts over from the start of its chain, and the
  quota breaker forgets the CLI. `odw resume <run>` goes on at once; `odw stop` stops
  the run as always. A `checkpoint()` can wait at the same time.
- A quota failure that names no reset, or one past `max`, still fails the agent as
  above, and the run's log says why
  (`quotaWait: not waiting — codex did not say when its quota resets, so the agent fails`).
- A pause never fires the run-end hooks; add `"paused"` to
  [`notify.on`](#run-notifications) to hear about each one.

```text
quota pause: codex is out of usage quota until 19:10 (in 3h 22m) — its agents wait, holding no slot, and go on then (quotaWait); odw resume goes on now
search:3 waits for codex's quota to reset (quotaWait)
quota pause over: codex's quota reset — its agents go on
search:3 goes on after the quota wait, on codex
```

It is off by default because a run that silently waits for hours would surprise anyone
who did not ask for it. The wait lives in the worker process: if the worker dies, the
run is `stale`, and `odw resume` replays it like any run that ended — its finished
agents come back without running again.

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
- A call's `expect` checks go with it: the next adapter's work is checked the same
  way, and retried there; work that misses never falls back (see
  [Check an agent's work](#check-an-agents-work-odw-extension)).
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
  "on": ["done", "failed", "stopped"]              // the default: every final state; "waiting" and "paused" are opt-in
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

Add `"paused"` to hear when a run [pauses for a spent quota](#pause-for-a-spent-quota-odw-extension)
— once per pause, not when it goes on: the command with `ODW_RUN_STATE=paused`,
`ODW_PAUSED_ADAPTER` and `ODW_RESUME_AT` (Unix seconds), the webhook with
`"state": "paused"`, a `"pausedFor": { "reason": "quota", "adapter", "resumeAt" }` field,
and a `text` line such as `odw · nightly paused until 19:10 (codex quota) · odw resume <run> goes on now`.

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
odw apply $RUN --agent 3 --check   # preview: each file clean, CONFLICT (with its lines) or already applied
odw apply $RUN --agent 3           # apply it to this working tree (git apply --3way)
odw apply $RUN --all --check       # preview every finished agent, each on top of the ones before it
odw apply $RUN --all --verify "npm test"   # apply them in order; roll back one that fails the check
```

`odw apply` applies one agent's diff — or, with `--all`, every finished agent's,
in agentId order — to the git working tree you run it in, with
`git apply --3way`: what applies is staged. Before it touches anything it runs
the same apply against a scratch copy of the index and prints each file as
`clean`, `CONFLICT` — with the conflicting lines as the merge would leave them
in the file, or why it cannot be merged (`deleted here`, `binary`, or an
untracked or ignored file in the way, which git would write over) — or
`already applied`; `--check` stops there (exit 1 on a conflict). A single agent
is then applied, a hunk that clashes left with conflict markers (exit 1).
`--all` previews each agent on top of the ones before it, applies them up to the
first that would conflict, and says which applied and which did not; a failed
agent's diff goes in only by `--agent`. It refuses while a path a diff touches
has uncommitted changes — commit or stash them, or pass `--force`. The dashboard
shows the same diffs in a run's **Changes** tab and serves them at
`GET /api/runs/:id/agents/:agentId/diff`.

`--verify "<cmd>"` — or the `applyVerify` setting, which `--no-verify` skips
once — runs a command at the repository root after each apply, through the
shell and within the `timeout` setting. When it fails or times out, that apply
is rolled back — the paths it touched get back exactly what they held, content
and index entries — and odw exits 1 with the end of the command's output; Ctrl-C
rolls it back the same way. An edit made to those files while the command ran is
set aside first, where odw says. Nothing else is touched — no stash, no reset —
so your other uncommitted work stays as it is. A change that would conflict is
not applied under `--verify`.

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
  "keepBranches": false,   // true: every isolated agent's change also goes on a branch
  "applyVerify": null      // e.g. "npm test": run after each odw apply, which is rolled back if it fails
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
| [`coordinated-refactor.js`](examples/coordinated-refactor.js) | isolated lanes change one repo in parallel on a notes board, each one's interface changes broadcast as it lands → a reviewer names the lanes that clash → they run again knowing what the others changed (ODW only) |

## Develop

```bash
npm ci                # install the locked build dependencies
npm run build         # tsc → dist/
npm test              # node:test suite, driven by a mock adapter (no real accounts)
npm run typecheck     # tsc --noEmit
npx tsx src/cli.ts conformance   # the dialect conformance suite (conformance/); also part of npm test
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
- **Pause for a spent quota.** With `"quotaWait": { "max": 21600 }`, an overnight run
  whose CLIs are out of quota waits for the reset they named — holding no slot, other
  CLIs working on — and carries on, instead of failing its agents. It shows
  `paused until 19:10 (codex quota)`; `odw resume` goes on at once, and
  `notify.on: ["paused"]` tells you (ODW extensions; see
  [Pause for a spent quota](#pause-for-a-spent-quota-odw-extension)).
- **Native structured output.** `claude` (`--json-schema`) and `codex`
  (`--output-schema`, for strict schemas) are handed an agent's schema and enforce it
  themselves; ODW still validates every reply. A schema keyword ODW's validator does
  not check is named in the run's log with where it is, never silently skipped —
  `"schemaKeywords": "strict"` refuses such calls (ODW extensions; see
  [Structured output](#structured-output-odw-extension)).
- **Evidence of success.** `agent(…, { expect })` checks an agent's work instead of
  taking its word — a command exits 0, files changed, the reply matches — and hands
  misses back once before failing with `reason: "unmet_expectation"` and what it
  missed. An empty reply fails as `empty_reply`; tool calls Claude Code refused, and
  MCP servers it could not start, are recorded on the agent and logged — and count
  against `expect` (ODW extensions;
  see [Check an agent's work](#check-an-agents-work-odw-extension)).
- **Permission tiers.** Every agent runs `read`, `edit` (the default, unchanged) or
  `full`, mapped to each CLI's own flags: review and research fan-outs that cannot
  touch the tree (`--permissions read`, `agent(…, { permissions: 'read' })`), full
  access only by explicit opt-in, and a CLI that cannot enforce a tier refused or
  logged — never silently downgraded. `agentEnv: "minimal"` keeps unrelated secrets
  out of agents (ODW extensions; see [Permissions](#permissions-odw-extension)).
- **Secrets kept out of what ODW keeps.** Whatever an agent prints — `cat .env`
  included — is redacted before it reaches its transcript, its saved result, the run's
  log and error or a webhook: the values of secret-named variables and well-known token
  shapes become `«redacted:<kind>»` (ODW extension; see
  [Secrets in what ODW keeps](#secrets-in-what-odw-keeps-odw-extension)).
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
  and land it with `odw apply`: it previews every file — clean, conflicting (with
  the lines) or already applied — before it touches the tree, takes `--all`
  agents in order, and with `--verify "npm test"` rolls back an apply that breaks
  the build, leaving your other uncommitted work alone.
- **Real usage and cost.** The built-in `claude` adapter now reads Claude Code's
  `stream-json`, and the built-in `codex` adapter `codex exec --json`, so every agent
  records the tokens (and, for Claude, the dollars) its CLI reported — in `odw status`,
  the live view and the dashboard — and `--budget` meters real output tokens. Codex
  agents' transcripts show their commands, edits and tool calls. A single fan-out wider than `fanOutWarn` (25) says so up front.
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
cost for more CLIs (Claude Code and Codex report it today; the others are estimated) ·
running Claude plugin
workflows · dashboard views of `odw compare` and `odw eval`. Full plan: [`docs/ROADMAP.md`](docs/ROADMAP.md); the
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
any off-loopback bind refuses writes entirely (the dashboard stays readable — with
<code>--token</code>, only to whoever holds the token).
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
