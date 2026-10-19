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
  [compatibility checklist](docs/concepts.md#compatibility-and-migration).
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
  `.d.ts` authoring types for editor autocomplete (`odw types` writes them into a
  project).

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
replacement fails. The binary must match the release's `SHA256SUMS` (releases
before v0.5.0 predate it and install with a warning; for newer ones a missing list
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

Or, **once `odw` is published to npm** (not yet — see [Develop](docs/guides/develop.md#develop)) and you
have Node ≥20, `npm i -g odw` will put `odw` on your PATH (you'd still do step *b*
for the skill). For now, use the binary above.

> The on-disk binary is ~110 MB — almost entirely the embedded Node runtime, like
> any Node→binary tool — but the download is gzipped to ~35 MB. The agents ODW
> *drives* (`claude`, `codex`, …) remain their own CLIs you install separately.

## Quick start

This README describes current source. For a released binary, use its bundled
skill and `odw --help`; to use unreleased features, build from source as described
under [Develop](docs/guides/develop.md#develop).

One CLI installed (just `claude`, or just `codex`)? Zero config — skip ahead.
Several? The installer already asked you to pick a default; `odw init` re-opens
that choice anytime (agents use `odw init --adapter <name>` after asking you).
`odw doctor` checks the setup — runtime, config, run directory, every adapter —
and `odw doctor --smoke` sends your default adapter one real prompt, catching a
CLI that installs fine but blocks on a login or approval prompt when headless.
`odw doctor --models` (ODW extension) sends one tiny prompt to every adapter/model
pair your config and `.odw/workflows` name, and says which models are gone.
`odw doctor --local` (ODW extension) checks a local Ollama or LM Studio server: the
context each model is loaded with, tool calling, and with `--smoke` whether a long
prompt's front is silently cut (see [Local models](docs/guides/adapters-and-models.md#local-models-check-the-server-route-the-cheap-phases-odw-extension)).
`odw doctor` also checks what a fan-out needs of the machine (ODW extension, read-only):
the open-file limit odw runs with against the agents you mean to run at once
(`--fanout N`; default: the concurrency cap — each agent holds ~4 descriptors, on top of
64 for odw), free space at the runs root and in the temp dir where `isolation: "worktree"`
checkouts go (a warning under 1 GiB) and whether that temp dir is a tmpfs, and the git on
PATH (2.17 or newer for worktrees). Each warning comes with the line that fixes it; what
does not apply on a platform (`ulimit -n` on Windows) is skipped. Bare `odw` before your
first run, and `odw doctor` until there is one, print the $0 first run below.

**Your first run costs nothing.** Start from a template, test it, watch it run with
every agent stubbed — then run it for real:

```bash
odw new                    # the templates: hello, review-swarm, fix-until-green, plan-approve-execute, …
odw new hello              # writes .odw/workflows/hello.js and a starter test, .odw/tests/hello.json
odw test hello             # the starter test: scripted replies, no model called, $0
odw run hello --dry        # the live view and the phase tree, every agent stubbed, $0 (odw serve --open: the dashboard)
odw run hello              # the real run, on your default agent CLI
```

At a terminal, `odw init` ends by offering exactly this: it writes `hello` and runs
`odw run hello --dry`, then prints the dashboard command and the real run — it never
makes a paid call itself. See [Start from a template](docs/tutorial.md#start-from-a-template-odw-extension).

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

## Documentation

The docs describe `main`; for a released version, read `docs/` at its tag. The map,
by what you came to do ([`docs/`](docs/README.md)):

| You want to… | Read |
| --- | --- |
| go on from the quick start | [Tutorial](docs/tutorial.md) — templates, editor completion, the examples |
| look up what a script can call | [Workflow API](docs/reference/workflow-api.md) · [primitive reference](skills/open-dynamic-workflows/references/primitives.md) |
| look up a command, a config key, an event | [CLI](docs/reference/cli.md) · [Configuration](docs/reference/config.md) · [Events and failure reasons](docs/reference/events.md) |
| run, follow, resume, compare, clean up | [Running and observing](docs/guides/running-and-observing.md) · [Dashboard](docs/guides/dashboard.md) |
| land what agents changed | [Reviewing and applying](docs/guides/reviewing-and-applying.md) · [Multi-repo runs](docs/guides/multi-repo.md) |
| bring a person in | [Checkpoints and agent questions](docs/guides/checkpoints-and-questions.md) · [Notifications](docs/guides/notifications.md) |
| run without starting it by hand | [Scheduling and triggers](docs/guides/scheduling-and-triggers.md) · [Remote runs: CI and your own server](docs/guides/remote-runs.md) |
| choose CLIs and models | [Adapters and models](docs/guides/adapters-and-models.md) · [Cost, limits and quotas](docs/guides/cost-limits-and-quotas.md) |
| keep agents and inputs in bounds | [Safety and trust](docs/guides/safety-and-trust.md) |
| make a workflow right | [Testing, debugging and evaluating](docs/guides/testing-and-debugging.md) |
| understand the design | [Concepts](docs/concepts.md) — how it works, compatibility with Claude Code |
| follow a recipe | [`docs/recipes/`](docs/recipes/) — cron, notify, triggers, review and apply, recover a run |
| work on ODW itself | [Developing ODW](docs/guides/develop.md) |

## Status

What changed in each release — and what to check before upgrading — is in
[`CHANGELOG.md`](CHANGELOG.md): its `Unreleased` section is what `main` has that no
release has yet, and every released version has a section of its own, which is also
the text of its [GitHub Release](https://github.com/xz1220/open-dynamic-workflows/releases).

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
no token billing of its own, no network calls from the engine. The one exception is
a diagnostic you ask for: `odw doctor --local` reads a local model server's status,
and with `--smoke` sends it one probe — on this machine or the local network only.
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
