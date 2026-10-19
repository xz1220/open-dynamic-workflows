# Running and observing runs

English · [简体中文](../zh-CN/guides/running-and-observing.md)

Start a run, follow it, come back to it, and clean up after it.

## Run and observe

In an interactive terminal, `odw run` attaches a **live foreground view** — every
agent (and `exec()` command step, shown with a `$` prompt) as it starts, spins, and
settles, phase by phase, with the result printed at the end. Ctrl-C detaches (the run keeps going); `odw attach <id>` re-attaches.

```bash
odw run wf.js [--args JSON|@file]            # foreground in a terminal; run keeps its own worker
                                             #   --adapter <name> sets this run's default agent
                                             #   --permissions read|edit|full: what its agents may do
                                             #   --untrusted: keep the repository's CLAUDE.md, hooks… out
                                             #   --untrusted-input: its args are outside text — read-only, no tokens
                                             #   --budget <tokens> sets budget.total
                                             #   --deadline <s>: STOP the run after s seconds (below)
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
odw review               # kept diffs across runs not dealt with yet, riskiest first, each with why (below)
odw outcomes             # by week, workflow, adapter, model: kept diffs applied/dismissed/left, failures, rework, cost per applied change (below)
odw notes $RUN           # what its agents told each other on the notes board (above)
odw compare $OLD $RUN    # what changed between two runs: setup, time, cost, failures, replies (below)
odw estimate review      # p50/p90 time, cost, tokens and agents of its next run, from earlier runs (below)
odw replay $RUN --agent 3 # that one agent again as a new run, at the commit it saw; --prompt/--adapter/--model (below)
odw eval review          # cases × adapters × repeats: pass rate, cost and time per cell (below)
odw export $RUN --otlp   # the run as OpenTelemetry traces (OTLP/JSON; --send posts it; below)
odw bundle $RUN          # the run as one redacted file to share: $RUN.odwrun (odw view FILE shows it; below)
odw gc                   # what runs left on disk — orphaned worktrees, keep branches, old transcripts; --yes deletes (below)
odw digest               # across runs, from their evidence: needs you, failed, missed checks, changes, spend (below)
odw pause|resume|stop $RUN
odw approve|reject $RUN  # answer a checkpoint() the run waits at (--note TEXT, --checkpoint N)
odw approve $RUN --edit  # …approving its payload as you edit it in $EDITOR (or --payload JSON|@file)
odw list
```

`--fg` / `-d, --detach` / `--wait` (block, then print the result; a single
run-id line on stderr) force a mode explicitly; `ODW_DETACH=1` forces
background from the environment.

**`--deadline <seconds>`** (ODW extension) stops the run once that many seconds
have passed since it started — gracefully, like `odw stop`: its agents are
killed, every finished agent's saved result is kept, and so is every isolated
agent's diff — a finished one's, and what one the deadline killed had changed so
far, marked `partial: true` on its `agent_failed` event and in the run's detail
(`GET /api/runs/:id`); `odw diff` shows it, and `odw apply` applies it only when
you name that agent, as for any failed agent's. A stop
by a person (`odw stop`, Ctrl-C) keeps no killed agent's change, as before. The
run is recorded `stopped` (`stopReason: "deadline"` in its status). The
worker enforces it, so it holds in every mode. With `--wait` or `--fg`, odw then
prints what finished — `{ "state": "stopped", "reason": "deadline", "deadline",
"finished": [{ agentId, label, phase, value }] }` — and **exits 3**. Exit codes:
0 done, 1 failed or stopped by a person, 3 stopped at its deadline, 124 for
`--timeout`, which only gives up *waiting* and leaves the run going. In CI,
`--deadline` is the one to use: see [Run in GitHub Actions](remote-runs.md#run-in-github-actions-odw-extension).

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

In a monorepo, as in Claude Code, the project directories are every `.odw/workflows`
and `.claude/workflows` from the working directory up to the repository root (the
nearest directory holding `.git`; outside a repository, the working directory alone).
As git's `safe.directory` does, the walk stops below a parent not owned by the current
user (not checked on Windows), and says so once when a repository root lay beyond it.
The nearest one wins a name, so a package's own `audit` shadows the root's; at one
level `.odw` still comes before `.claude`. `odw workflows list --all` labels each
entry with its directory (`../../.claude/workflows`) and says which entry shadows it;
`odw workflows where <name>` prints the file that runs and, when more than one
directory has the name, the whole chain in precedence order.

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
[untrusted](safety-and-trust.md#untrusted-repositories-odw-extension) run plugin workflows still run —
you installed them — but the repository's settings can only disable a plugin, and a
name never resolves to the repository's own `.odw/workflows` or `.claude/workflows`
(its path still runs it).

**Install workflows from git, locked** (ODW extension). Share workflows through a git
repository instead of copying files around, and pin what each teammate runs:

```bash
odw workflows add https://example.com/acme/flows.git#v1.2.0     # → .odw/workflows, locked
odw workflows add git@example.com:acme/flows.git --path flows/audit.js --name audit
odw workflows add ../flows --global                             # a local repository → ~/.odw/workflows
odw workflows verify                  # every locked file against its sha256; exit 1 on a mismatch (CI)
odw workflows update [audit]          # newest commit of the locked ref: shows the diff, then asks
```

`add` fetches `<url>[#ref]` (a branch, tag or commit id; none: the remote's HEAD) with
git, one commit deep, into a fresh bare repository in a temp directory — no tags, no
submodules, nothing checked out, an empty hooks directory, never a prompt, and only
https, ssh (`ssh://` or `user@host:path`) and file URLs (a local directory is read as its
file URL). Nothing from the repository is executed: files are read as git blobs, symlinks
and submodules are skipped, and each `.js` is compiled — not run — to check its `meta`.
It takes `--path` (a file, or a directory's `.js` files), else the first of
`.odw/workflows`, `.claude/workflows`, `workflows` and the repository root that has
any; prints what each reaches outside the dialect (as `odw check --capabilities`);
asks (`--yes` to accept without a terminal); and copies them into `.odw/workflows` —
with the workflow's `.odw/tests/<name>.json` and `.odw/evals/<name>.json` when the
repository has them beside it — or into `~/.odw/workflows` with `--global`. It never
replaces a file it did not install (`--force` does). A file whose name is not a
workflow name (letters, digits and `. _ -`; never `__proto__`, `constructor` or
`prototype`) is skipped with a note — `--path` and `--name` install it under one. Nothing
is written through a symlink: when the workflow, its test or eval, the lock, or a
directory from the project down to them is one, `add` and `update` write nothing there
and exit 1. Each workflow gets an entry in
the lock beside its directory, `.odw/workflows.lock.json` (`~/.odw/workflows.lock.json`):

```json
{ "version": 1, "workflows": { "audit": {
  "url": "https://example.com/acme/flows.git", "ref": "v1.2.0", "commit": "<40-hex commit>",
  "path": ".odw/workflows/audit.js", "sha256": "<sha256 of the installed file>",
  "installedAt": "2026-10-19T08:00:00.000Z",
  "test": { "path": ".odw/tests/audit.json", "sha256": "…" } } } }
```

Commit the lock with `.odw/workflows`. `update` re-fetches each entry's ref, prints a
unified diff of what changed and asks before writing (a file modified locally is left
alone unless `--force`); `verify` hashes every locked file — `odw doctor` runs the same
check ("Locked workflows"). An installed workflow is **third-party**: `odw workflows
list` and the dashboard's Workspace say so with its source and commit, and it runs in
a [strict script context](safety-and-trust.md#strict-script-context-odw-extension) unless the config
says `scriptContext: "host"` (so does a nested `workflow()` of it). A run of one whose
file no longer matches its lock says so in its start banner and log;
`"lockedWorkflows": "fail"` refuses to start it instead (default `"warn"`). Beside a
lock that cannot be read, every workflow counts as third-party from an unknown source
and modified, and `verify` and `odw doctor` report the lock. `update` takes a lock's
`url`, `ref` and paths only as `add` would, leaves a fetched file that does not check
as it was, and an entry that fails fails alone (exit 1). Not done:
signatures, a hub or search, automatic updates, and checking a Claude Code plugin's
installed commit.

**Prefer a browser?** `odw serve` opens a zero-dependency live dashboard onto the same
run directory — every run as a live graph, its timeline, logs and result, streamed over
SSE. No build step, no extra deps, no network access on load.

```bash
odw serve [--open]                      # live dashboard at http://127.0.0.1:4317
odw serve --port 8080 --host 0.0.0.0 --token   # remote, read-only, token-gated (see Remote access)
odw view run.odwrun                     # a shared run bundle, read-only (see Share a run)
odw serve --public-url https://odw.example.com  # answer checkpoints from your phone (see Approve from your phone)
```

![odw serve — a live deep-research run: five phase lanes (Plan → Search → Extract → Vote → Report) drawn as a graph, running agents tracing signal along their edges, per-run counters and a phase stepper](../../assets/odw-dashboard.gif)

## Resume a run (ODW extension)

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
  [paused for a spent quota](cost-limits-and-quotas.md#pause-for-a-spent-quota-odw-extension) goes on at once;
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
[`docs/recipes/recover-a-run.md`](../recipes/recover-a-run.md).

## Agent transcripts (ODW extension)

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
  built-in `claude`'s stream-json, `codex`'s `exec --json`, `kilo`, `opencode` and `agy`), any other adapter's output as
  `{"kind":"text","text":…}` lines. The end of its stderr (the last 64 KB) goes to
  `agents/<agentId>.stderr.txt`; `odw logs --agent` shows its last lines after the transcript.
- A schema retry, a stall restart or a rate-limit retry goes on in the same file after an
  `{"kind":"attempt","n":2,"reason":"schema"|"stall"|"rate_limit"}` line.
- `maxTranscriptBytes` (default 5 MB per agent) bounds it: past it, one
  `{"kind":"truncated","bytes":N}` line ends the transcript. Transcripts hold whatever the
  agents read and ran — with likely secrets redacted as they stream
  (see [Secrets in what ODW keeps](safety-and-trust.md#secrets-in-what-odw-keeps-odw-extension));
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

## Watch runs in a terminal, tmux or your IDE (ODW extension)

The dashboard is one way to watch; a terminal, a tmux window and an IDE panel are the
others — for ODW's runs and for **Claude Code's own workflow runs** (`cc-…` ids, the ones
its Workflow tool starts; the dashboard's Jobs list shows them):

```bash
odw status cc-wf_0da91623-31d                         # its state and agents: label, phase, state, Claude's agent id
odw logs cc-wf_0da91623-31d --follow                  # its events as they come, until it ends
odw logs cc-wf_0da91623-31d --agent find:engine-store --follow   # one agent's transcript (by label or id)
odw attach cc-wf_0da91623-31d                         # the same as logs --follow, under a header
odw tmux $RUN                                         # a tmux window: the run, and a pane per running agent
```

- A Claude Code run is read from its store under `~/.claude/projects` (`CLAUDE_CONFIG_DIR`
  honored), every project's, **read-only**: stopping it or answering it stays in Claude
  Code. Its agents' `agent-<id>.jsonl` transcripts read like an ODW agent's (`▸` tool
  calls, `✓/✗` results, text, thinking); `--raw` prints the lines as kept. Claude Code
  may clean its transcripts up — a run that vanished says so.
- `odw tmux <run> [--layout tiled|even-horizontal|even-vertical|main-horizontal|main-vertical] [--max-panes 6]`
  opens one window inside your tmux session. Its first pane is the overview: the run's
  events, and a pane opened for each agent as it starts (`odw logs <run> --agent <id> --follow`),
  up to `--max-panes`; past the cap it lists the command that follows each of the others.
  A pane whose agent settled stays (tmux's `remain-on-exit`), its last lines under how it
  ended. ODW and `cc-` runs alike.
- Outside tmux it prints the `tmux new-session …` command that does the same; without
  tmux, the `odw attach` and `odw logs --agent … --follow` commands to run by hand. Only
  tmux is driven — no other terminal multiplexer.

**In VS Code, JetBrains or Antigravity.** Run `odw serve`, then open
`http://127.0.0.1:4317/#/compact` in the IDE's own browser panel — VS Code: *Simple Browser:
Show* from the command palette; JetBrains: *Tools → Web Browsers* (or any built-in
browser view). The compact layout drops the rail: a run list with each run's live state
(live runs first, Claude Code's tagged `CC`), and a run opens under a slim bar back to the
list. `?compact=1` on the page URL or `?compact` after any route (`#/job/<id>?compact`)
turns it on too; it stays on as you navigate, and *Full dashboard* (`?compact=0`) turns it off.

## Compare two runs (ODW extension)

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
on this, and so does drift watch.

A CLI can update itself under a long run (Claude Code's native installer does, in the
background). So a run asks again — at the adapter's next dispatch once 30 minutes have
passed since it last asked, and at once (at most once a minute) when one of its agents
fails oddly: an unexplained exit, or a CLI that could not start. A different answer
lands as a `cli_version_changed` event — `{ adapter, command, from, to, message }`,
shown in the live view, `odw logs` and the dashboard's logs — and the run goes on; the
run's `cli_version` stays the first one, so `odw compare` still holds runs to what they
started with.

## Drift watch (ODW extension)

A model gets retired or re-pointed, a CLI upgrades itself overnight, and the workflow
still "passes" on something it was never tuned for. Every run is therefore compared with
the **previous finished run of the same workflow** — the newest one in its bucket of the
runs root that ended (done, failed or stopped), was no dry run, and has the same source
hash or the same name: each adapter CLI's version (its `cli_version` event) and the model
each agent label asked for on its adapter (a `"@tier"` read through each run's own
`models`). Each difference is logged once, as soon as the run records it:

```text
drift: claude CLI 2.1.302 → 2.1.330 since the last run of review-swarm (20261017-091500-3fa2c1)
drift: reviewer asks claude for model opus-4 → opus-5 since the last run of review-swarm (20261017-091500-3fa2c1)
drift: review-swarm has an eval — check it still passes against its last report: odw eval review-swarm --baseline ~/.odw/runs/_evals/review-swarm/20261017-093000-77e0.json
```

Only what both runs recorded counts: an adapter or a label one of them never used, or a
CLI whose version is unknown, is no drift. The changes are the run summary's `drift`
field — `{ since, changes: [{ kind: "cli" | "model", adapter, label?, from, to }] }` — in
`GET /api/runs` and `/api/runs/:id`; each log line carries the change
as `drift`.

When the workflow has an eval file (`.odw/evals/<name>.json`), the first drift suggests
running it against its newest kept report. With `"driftEval": true` in the config the
run starts it itself once it ends (not when it was stopped): `odw eval <name> --baseline
<report>`, detached, from the run's source directory, its output in the run directory's
`drift-eval.log`. A run `odw eval` started never starts another. Dry runs and `odw test`
runs are not watched. There is no `odw schedule add … --on-cli-change`: a scheduled run
already logs its drift, and `driftEval` checks it — a schedule that polls CLI versions
would be one more daemon for little gain.

## The model that actually served an agent (ODW extension)

`agent(prompt, { model: "opus" })` is a request. An organisation's `availableModels`
allowlist, a plan, a retired id or a CLI's own setting can put the agent on another model,
and the reply never says so
([claude-code#102655](https://github.com/anthropics/claude-code/issues/102655),
[#73597](https://github.com/anthropics/claude-code/issues/73597)). Where a CLI's own events
name the model that served the agent, odw records it beside the request: the built-in
`claude` reads stream-json's init event (`model`), each assistant message's
`message.model` (not Claude Code's own `<synthetic>` ones) and the result's `modelUsage`
keys. The models go on the agent's `agent_finished` event and saved result as
`servedModel`, in `odw agents --json`, `/api/runs/:id` (the agent's `model` and
`servedModel`) and the dashboard drawer ("served by"), and `odw logs` shows them.

When none of them is the model its CLI was asked for — a `"@tier"` resolved first; case, a
`[1m]` suffix and a provider prefix (`anthropic/…`, `us.anthropic.…`) do not count, and an
alias or shorter id matches a served id that holds it whole, followed only by a version,
date or `latest`/`preview` (`opus` ~ `claude-opus-5-5`, but `gpt-5` ≁ `gpt-5-mini`;
`best` is opus, `default` matches anything) — the run writes a `model_substituted` event
(`{ agentId, label, adapter, requested, served, policy, message }`) and shows it as a log
line:

```text
review:1: asked claude for model 'opus' but it was served by claude-sonnet-4-5 — its reply is kept; modelMismatch: "fail" fails such an agent
```

The reply stands (the default `"modelMismatch": "warn"`); `"modelMismatch": "fail"` fails
such agents with `reason: "model_substituted"` (not retried, no fallback). A helper model
next to the requested one (Claude Code summarising a WebFetch on haiku) is no
substitution. The drawer flags it as "substituted", `odw agents` prefixes the value with
`[served by …, asked …]`, `odw compare` sets `modelsServed` side by side and marks the
agent, and `odw estimate` adds a `models` group (by the first served model) so one model's
spend is not mixed with another's. A CLI that names no model — codex, agy, and any adapter
without `output.servedModel` rules — is "not reported": nothing is guessed, least of all
from the reply. Any JSONL adapter can declare its CLI's model events with
`output.servedModel` (see the adapters reference).

## Observability: OpenTelemetry traces (ODW extension)

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

## Share a run (ODW extension)

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

## Reclaim disk: `odw gc` and `odw pin` (ODW extension)

Each isolated agent's worktree is removed when its call settles — but a worker that is
SIGKILLed, or a machine that loses power, never gets to. Kept branches (`keep: true`,
`keepBranches`) stay until you delete them, and every run directory keeps its agents'
transcripts. `odw gc` reports all of it, with sizes, and **deletes nothing unless you
pass `--yes`**:

```bash
odw gc                        # dry run (the default): what would go, and how much it frees
odw gc --older-than 14d       # runs older than 14 days count as expired (default: retention.days, 30)
odw gc --yes                  # delete it
odw gc --json                 # the same report for scripts
odw pin $RUN                  # odw gc skips this run, whatever its age; --remove unpins; no run id lists pins
```

- **Orphaned worktrees.** Every isolated agent's worktree directory
  (`$TMPDIR/odw-wt-*`) holds an `odw-owner.json` naming the process, run and
  repository it is for. One whose process is gone — and whose run is not active —
  is an orphan; one without the file (made by an older odw) only once it has not
  been touched for a day. They are removed as the worker would have: `git worktree
  unlock`, `worktree remove --force --force`, the directory, `worktree prune`. A
  registration whose directory is already gone is pruned. `odw gc` looks at the
  temp directory and the registered worktrees of the current repository (`--source
  DIR`) and of each run's source.
- **Keep branches** `odw/<run>/<agent>-<label>` of a run in this runs root go
  when HEAD already holds their change (the commit is in HEAD, or `git cherry` finds
  the same patch there — what `odw apply` and a commit leave), or when their run is
  older than the retention. A branch checked out anywhere is refused by git and
  stays; a branch whose run this runs root does not know is counted, never deleted.
- **Safety snapshots** `refs/odw/safety/<run>` (what `odw restore` puts back) go with
  their run once it is older than the retention; one of a run this runs root does not
  know is counted, never deleted.
- **Expired runs** — ended, and older than the retention — have their agents'
  transcripts and stderr removed: the largest part of a run. `meta.json`, status,
  events, saved results and diffs stay, so `odw list`, `odw estimate`, `odw compare`
  and `odw apply` still work; `gc.json` in the run records what went, and the
  dashboard tags the run **transcripts trimmed**.
- **Never touched:** a run that is running, paused or waiting at a checkpoint; a
  run you pinned (`pinned.json` in its directory; the dashboard tags it **pinned**);
  worktrees and branches odw did not make. Each removal is checked again just before
  it happens, and one that fails is reported (exit 1) while the rest goes on.
- **Compose projects** named `odw-*` (an isolated agent's `ODW_SLOT`, its default
  `COMPOSE_PROJECT_NAME`) whose run is not active are listed, with the `docker
  compose -p <name> down -v` that removes one — **reported only, never removed**.
  Only when `docker compose ls` answers at once (`$ODW_DOCKER` names another
  docker); without docker nothing is said.
- **At start-up** each worker looks, read-only, at its repository's registered
  worktrees, and says once in the run's log when runs that died left some behind,
  with the `odw gc` command. `odw doctor` has a **Disk** line: the runs root's size
  and the orphaned worktrees.

```jsonc
{
  "retention": { "days": 30, "transcripts": true } // transcripts: false keeps them; gc then removes only worktrees and branches
}
```

odw runs no daemon: to collect on a timer, put `odw gc --yes` in your own crontab or
CI job.

## A full disk, and a reused pid (ODW extension)

Two ways a run used to end without a word — both odw's own, not Claude Code's dialect:

- **The disk fills up.** A run directory holds `.odw-reserve`, 64 KB set aside when
  the run is created. A write to the run directory that fails with `ENOSPC` (or a
  quota's `EDQUOT`) ends the run: the worker stops dispatching, kills its agents as
  for any fatal error, deletes the reserve for room, and records the run `failed`
  with `"failureReason": "disk_full"` in `status.json` (and `error.json`), with an
  error that says where and what to do. Should even that write fail, the same line
  goes to the worker's stderr (`worker.log`). The dashboard marks the run
  **failed — disk full**. Nothing is deleted to make room: free some space (`odw gc`
  lists what it can remove), then `odw resume` the run — finished agents replay.
  A run that ends any other way gives its reserve back.
- **A pid is reused.** A dead worker's pid can belong to another process after a
  reboot or once the pid space wraps (macOS stops at 99,999) — and then the run
  looked alive forever: listed as running, skipped by `odw gc`, holding a schedule's
  overlap guard and a trigger's dedupe. The worker now records, beside its `pid`, when
  its process started (`pidStart` in `status.json`: on Linux the boot id and start
  time from `/proc`, elsewhere `ps -o lstart=`). A live pid whose process started
  at another time is not the worker; neither is any pid of a run whose status was
  last written before the machine booted. Isolated worktrees' `odw-owner.json` and
  schedule locks record it the same way. Where the start cannot be read (Windows),
  liveness stays the bare pid probe.
