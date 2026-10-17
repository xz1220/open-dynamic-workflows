# Changelog

Notable changes to Open Dynamic Workflows. Binaries and the installer come from
[GitHub Releases](https://github.com/xz1220/open-dynamic-workflows/releases); everything
marked **ODW extension** is outside Claude Code's workflow dialect and runs on `odw` only.

## Unreleased — 0.5.0

Everything since v0.4.0 (2026-06-11). The theme: runs you can leave alone — they
survive failures, ask before the expensive parts, say what they cost and what they
changed, and run on a schedule — and a dashboard redesigned to watch them.

### Recover instead of restarting
- Every finished `agent()` result is saved the moment it lands. Read it mid-run with
  `odw agents <run>` and `odw result <run> --agent <id|label>`, or in the dashboard
  ([#24](https://github.com/xz1220/open-dynamic-workflows/issues/24)).
- `odw resume <run>` on an ended run starts a new run that **replays** every unchanged
  `agent()` call for free and runs only what changed or never finished.
- A stall watchdog (`stallTimeout`, `stallRestarts`) kills and restarts agents that go
  quiet; a worker stopped by a signal records the run as stopped and cleans up.
- Failures are classified (rate limit, quota, login, timeout, stall, not found,
  permission, exit). Rate limits are retried after the wait the CLI asked for
  (`transientRetries`, `maxBackoff`); quota and login failures fail fast and say what to
  do — and when the limit lifts.

### Ask a person, tell a person
- `checkpoint(title, { payload, timeout, onTimeout })` pauses a run until someone
  approves or rejects — `odw approve|reject`, the dashboard, or
  `POST /api/runs/:id/checkpoint` (**ODW extension**). Runs show a `waiting` state
  everywhere.
- Run-end hooks: a `notify` command or webhook (Slack/Discord/ntfy-ready) when a run
  finishes, fails, stops — or, opt-in, starts waiting.

### Know what it costs and what it changed
- Real usage and cost: the built-in `claude` adapter reads Claude Code's `stream-json`;
  tokens and dollars per agent and per run in `odw status`, the live view and the
  dashboard; `--budget` meters real output tokens; wide fan-outs warn up front.
- Isolated (`worktree`) agents keep their change as a diff (setup files excluded),
  optionally on a `keep` branch. Review with `odw diff` or the dashboard's Changes tab;
  land with `odw apply [--check]`.
- Transcripts: every agent's CLI output is kept — `odw logs <run> --agent <id|label>
  [--follow]`, or live in the dashboard's Transcript sheet.

### Control what agents may do
- Permission tiers `read` / `edit` / `full` (`--permissions`, per adapter, per call; a
  call can only lower its tier), mapped to each CLI's documented flags; `agentEnv:
  "minimal"` starts agents with only the environment they need (**ODW extension**).
- Per-adapter `concurrency` caps; a rate limit halves that adapter's cap for the rest of
  the run; `claude` fan-outs sharing a long prompt prefix stagger their start so the
  rest read the prompt cache.

### Run on a schedule
- `odw schedule add|list|remove|run` writes a cron, launchd or systemd entry that calls
  back into odw — overlap lock, per-schedule log, last run — with no daemon. The
  dashboard's Jobs page shows what runs next.

### Write workflows
- `exec(command, opts)` runs tests, builds and linters without a model, as steps of the
  graph ([#31](https://github.com/xz1220/open-dynamic-workflows/issues/31); **ODW
  extension**). Examples: `test-fix-loop.js`, `review-swarm.js`, `plan-approve-execute.js`.
- Ready-to-work worktrees: `.worktreeinclude` (with `symlink:` lines), a bounded
  `worktreeSetup` command, and a unique `ODW_PORT` (plus `ODW_RUN_ID`/`ODW_AGENT_ID`) for
  every agent process.
- Adapters for **OMP, Kilo Code, OpenCode and Cursor** (thanks
  [@lzehrung](https://github.com/lzehrung), #32 and #34); the built-in `codex` and
  `claude` adapters get web access out of the box.
- The battle-tested `deep-research-verified.js` with a cron-ready wrapper.

### Use the CLI and the dashboard
- `odw run` attaches a live foreground view in interactive terminals (Ctrl-C detaches;
  `odw attach` re-attaches); pipes and CI keep the fire-and-poll contract.
- First-run onboarding: `odw init` picks the default agent CLI; `odw doctor [--smoke]`
  checks the runtime, config and every adapter — `--smoke` sends one real prompt.
- A redesigned dashboard ("paper, ink and signal"): an Activity pulse with a "Needs
  you" strip, a live DAG with checkpoint gates and diff badges, a timeline, drawers with
  outputs, usage, failure reasons and tiers, the Changes and Transcript views, Upcoming
  schedules, a command palette, light and dark themes, English and Chinese.

### Reliability and safety
- Timeouts and stops reach an agent's whole process tree (SIGTERM, then SIGKILL).
- Workflow `meta` is parsed as a literal and never evaluated; listing workflows never
  compiles a body; installs verify SHA256 checksums.
- The dashboard server reads events incrementally, pushes run-list deltas, and stays
  responsive with thousands of runs.

### Changed behavior — check before upgrading
- The built-in `claude` adapter runs `--output-format stream-json --verbose`. A config
  entry that gives `claude` its own `command` replaces the built-in and needs the
  matching `output` block to report usage (the README shows the full entry).
- An adapter entry **without** `command` now adjusts the built-in (e.g.
  `"codex": { "concurrency": 4 }`); before, it was an error.
- Adaptive concurrency is on by default (`adaptiveConcurrency: false` turns it off), and
  `claude` fan-outs with long shared prompts may wait up to 2.5s to stagger
  (`staggerFanOut: false`).
- `budget.spent()` counts real output tokens where the adapter reports them.
- Config errors are fatal instead of producing a "done" run full of nulls.
- The desktop (Tauri) app is retired in favor of `odw serve`.
