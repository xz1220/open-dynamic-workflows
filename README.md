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
  Qwen, Kimi, OMP, Kilo, OpenCode, Cursor, or your own CLI. Switch adapters.
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
  directory: `status`, `logs --follow`, `result`, `pause` / `stop`.
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
| `agent(prompt, opts?)` | Run one coding agent on a subtask. The only verb that does work. Returns its text, or a validated object when `opts.schema` is set. |
| `parallel(thunks)` | Run a batch concurrently and wait for all of it (**barrier**). Recoverable failures become `null`; stop, budget, and dispatch-limit errors abort the run. |
| `pipeline(items, ...stages)` | Stream each item through the stages independently (**no barrier**). Each stage gets `(prev, item, index)`. |
| `phase(title)` / `log(msg)` | Group progress under a phase / emit a progress line. |
| `schema` (JSON Schema) | A typed output contract for `agent`; the reply is validated and retried until it conforms. |
| `args` | The workflow's input, injected verbatim. |
| `budget` | `{ total, spent(), remaining() }` — scale depth to a token target. |
| `workflow(ref, args?)` | Run another workflow inline (one level deep). The child shares this run's concurrency cap, agent counter, and budget; its phases group as their own DAG lanes. |
| `validate(source)` | Parse and compile-check trusted source without running its workflow body. Metadata is parsed as a pure literal, never evaluated. **ODW extension** (not in Claude Code's dialect). |

Use **`parallel`** when the next step needs the whole batch at once (dedup,
tally, synthesis); **`pipeline`** for multi-stage work (the default). Keep
reductions order-independent — branching on *which agent finished first* breaks
reproducibility. Full reference: [`skills/open-dynamic-workflows/references/primitives.md`](skills/open-dynamic-workflows/references/primitives.md).

## Compatibility and migration

ODW implements the primitive surface below. Scripts that depend on a host's
private runtime behavior need the following checks before migration:

| Feature | ODW behavior and migration check |
| --- | --- |
| Nested `workflow()` | Implemented for one level, sharing the parent's scheduler, control and budget. Flatten deeper nesting. |
| Model selection | Pass `agent(..., {model})` using that CLI's model ID. `meta.model` and phase metadata do not set execution defaults; an adapter without model routing support emits a note. |
| `agentType` | A persona added to the prompt. It does not load a host's named subagent configuration or select an adapter. |
| Worktree isolation | Starts from committed HEAD, excludes uncommitted edits, and cleans up afterward. Changes are not merged and `agent()` returns the reply, not a diff; put required deliverables in that reply or persist them explicitly. |
| Budget | Estimates successful final reply tokens as `ceil(chars / 4)`. Inputs, failed calls and retry replies are not included. The guard stops later dispatches; already-running calls can exceed the target. |
| JSON Schema | Supports the [documented subset](skills/open-dynamic-workflows/references/primitives.md#schema). Unknown constraints such as `$ref`, `const` and `oneOf` are not enforced. Use explicit object/array types and supported constraints. |
| Script trust | Run trusted scripts only: a run executes the workflow body as ordinary JavaScript. Loading parses metadata as a pure literal without evaluating it; validation and compatibility warnings are not a sandbox. |
| Recovery | `resume` continues a paused live worker. `rerun` starts over; completed calls are not journaled and replayed after a crash. |

The supported primitive names do not guarantee full runtime parity.
`validate(source)` is an ODW extension and must be removed when targeting a host
that does not provide it. Recoverable `null` results require an explicit choice:
accept a partial result, retry, or fail when the task requires every item.

## Run and observe

In an interactive terminal, `odw run` attaches a **live foreground view** — every
agent as it starts, spins, and settles, phase by phase, with the result printed
at the end. Ctrl-C detaches (the run keeps going); `odw attach <id>` re-attaches.

```bash
odw run wf.js [--args JSON|@file]            # foreground in a terminal; run keeps its own worker
                                             #   --adapter <name> sets this run's default agent
                                             #   --budget <tokens> sets budget.total
```

The run itself always executes in a detached background worker. Anywhere your
shell is not a terminal — `$(…)` capture, pipes, cron, CI, another agent — the
same command detaches and prints the run id, exactly as before (fire-and-poll):

```bash
RUN=$(odw run wf.js)     # non-TTY: prints the run id and returns immediately
odw attach $RUN          # live view (or plain lines when piped); --timeout <s> exits 124
odw status $RUN          # state + agent count
odw logs $RUN --follow   # stream raw progress events
odw result $RUN          # final value
odw pause|resume|stop $RUN
odw list
```

`--fg` / `-d, --detach` / `--wait` (block, then print the result; a single
run-id line on stderr) force a mode explicitly; `ODW_DETACH=1` forces
background from the environment.

A run executes in a detached worker process and persists everything to a run
directory, so it outlives the command that started it and can be observed from
anywhere.

Saved workflows can also be run by name. ODW searches project workflows first,
then personal workflows, across both its own directories and Claude Code's saved
workflow directories: `.odw/workflows`, `.claude/workflows`, `~/.odw/workflows`,
and `~/.claude/workflows` (honoring `CLAUDE_CONFIG_DIR`).

**Prefer a browser?** `odw serve` opens a zero-dependency live dashboard onto the same
run directory — phase columns, per-agent cards (adapter + elapsed time), and run status
stream in real time over SSE. No build step, no extra deps.

```bash
odw serve [--open]                      # live dashboard at http://127.0.0.1:4317
odw serve --port 8080 --host 0.0.0.0    # custom port / bind address
```

![odw serve — a live board of a deep-research run: phase columns (Search → Extract → Vote → Report), per-agent cards with adapter and elapsed time, and live status](assets/odw-dashboard.png)

Two more of its views — **Activity** (live event stream) and **Job detail**
(the run as a live DAG):

<table>
  <tr>
    <td width="50%">
      <strong>Activity</strong><br />
      <img src="assets/app-screenshots/activity.png" alt="Activity view showing live event stream, active run counters, and per-adapter agent load" />
    </td>
    <td width="50%">
      <strong>Job detail</strong><br />
      <img src="assets/app-screenshots/job-detail.png" alt="Job detail view showing a live workflow graph with phase columns and agent nodes" />
    </td>
  </tr>
</table>

## Dashboard: chat, observe, inspect

The dashboard is an observatory plus a local Chat Host. Use Chat for ordinary
Codex conversation; mention ODW or workflow when a turn should be attached to a
real background run. Runs started from the CLI (`odw run <name>`) and Chat-linked
ODW tasks show up in Jobs as live DAGs with logs and final results.

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
| `codex` | `codex` | text on stdout; web search enabled |
| `claude` | `claude` | text on stdout; WebSearch/WebFetch allowed |
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

ODW keeps raw stdout/stderr in run diagnostics while returning only the decoded
final response. On Windows, executable discovery follows `PATHEXT`, so normal
`agent.cmd`, `kilo.cmd`, and `omp.exe` shims are detected without full paths.

Config keys live at the **top level** — there is no `"settings"` wrapper, and odw
warns about unknown or misplaced keys (with a did-you-mean hint) instead of
silently ignoring them. With no `defaultAdapter` set, odw uses the sole
configured adapter — or, on a fresh install, the sole adapter whose CLI it
actually finds on PATH; if several are installed, the error lists them and shows
how to pick one.

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
| [`loop-until-dry.js`](examples/loop-until-dry.js) | loop fanning out finders until K dry rounds |
| [`routing.js`](examples/routing.js) | classify the request → route to a specialist → grade the result |
| [`generate-and-filter.js`](examples/generate-and-filter.js) | generate many ideas in parallel → dedupe → keep only rubric-passers |
| [`tournament.js`](examples/tournament.js) | N approaches attempt the task → pairwise judging bracket → one winner |
| [`codex-claude-loop.js`](examples/codex-claude-loop.js) | two rival CLIs in a turn-based duel: Claude implements, Codex reviews, repeat until sign-off |
| [`agent-daily-digest.js`](examples/agent-daily-digest.js) | discover sources → extract in parallel → synthesize → verify |

## Develop

```bash
npm ci                # install the locked build dependencies
npm run build         # tsc → dist/
npm test              # node:test suite, driven by a mock adapter (no real accounts)
npm run typecheck     # tsc --noEmit
npm run build:binary  # bundle + Node SEA + postject → a single self-contained ./build/odw
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

### Roadmap (v1.5+)

`model` / `agentType` rich routing · adapter-reported
token usage (today's budget meters an estimate) · resume / journaling · a
`Date.now`/`Math.random` sandbox for replay-determinism. Full plan:
[`docs/dynamic-workflows-tech-plan.md`](docs/dynamic-workflows-tech-plan.md).
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
