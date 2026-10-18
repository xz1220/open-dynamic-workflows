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
- Pause for a spent quota (`"quotaWait": { "max": <seconds> }`, off by default; **ODW
  extension**): an overnight run whose CLIs are out of quota waits for the reset they
  named — holding no slot, while CLIs with quota left keep working — and carries on
  instead of failing its agents. It shows `paused until 19:10 (codex quota)` in
  `odw status`, `odw list`, the live view and the API (`pausedFor`); `odw resume` goes
  on at once. A quota that names no reset, or one past `max`, still fails, saying why.
- Evidence of success: `agent(…, { expect })` checks an agent's work instead of taking
  its word — `command` exits 0 in its workspace, `changes`, `files` (globs), `match` —
  and hands misses back (`expectRetries`, default 1) before failing with
  `unmet_expectation` and the list of misses; `examples/fix-until-green.js`
  (**ODW extension**). A miss is retried on the adapter that produced it; a call that
  falls back keeps its `expect` on the next one. Tool calls Claude Code refused
  (`permission_denials`) are kept as `denied` on the agent and logged once, while its
  reply stands (the default `"permissionDenials": "warn"`); with `expect` they count as
  a miss, and `"permissionDenials": "fail"` fails such agents with reason `permission`.
- MCP health (**ODW extension**): the MCP servers Claude Code's stream-json init event
  says it started an agent without — `failed`, `needs-auth`, `pending`, `disabled` —
  are kept as `mcp` on the agent (events, saved result, `/api/runs/:id`) and logged
  once per run per server and status, while its reply stands (the default
  `"mcpFailures": "warn"`); `"mcpFailures": "fail"` fails an agent whose server
  `failed` or `needs-auth` with reason `mcp_unavailable`, and `expect: { mcp: [...] }`
  makes a listed server that is not there a miss. Adapters declare where their CLI
  lists its servers with `output.mcpEvent` and `output.mcpPath`.

### Ask a person, tell a person
- `checkpoint(title, { payload, timeout, onTimeout })` pauses a run until someone
  approves or rejects — `odw approve|reject`, the dashboard, or
  `POST /api/runs/:id/checkpoint` (**ODW extension**). Runs show a `waiting` state
  everywhere.
- Approve with edits: `odw approve <run> --edit` opens `$EDITOR` on the checkpoint's
  payload (`--payload JSON|@file` without an editor; `payload` in the API), and the call
  resolves to `{ approved, note, by, payload, edited }` — the plan as approved, not
  only a yes. An optional `checkpoint(title, { schema })` makes the CLI, the API and
  the run refuse an edit that does not match it (**ODW extension**).
- Run-end hooks: a `notify` command or webhook (Slack/Discord/ntfy-ready) when a run
  finishes, fails, stops — or, opt-in, starts waiting, or pauses for a spent quota
  (`"paused"`).

### Know what it costs and what it changed
- Real usage and cost: the built-in `claude` adapter reads Claude Code's `stream-json`;
  tokens and dollars per agent and per run in `odw status`, the live view and the
  dashboard; `--budget` meters real output tokens; wide fan-outs warn up front.
- Codex agents report their tokens too: the built-in `codex` adapter runs `codex exec
  --json --output-last-message {reply_file}` — its reply from that file (else the last
  `agent_message` event), tokens from `turn.completed` (no cost: codex reports none),
  its transcript's commands, edits, MCP tool calls and web searches as tool calls, and
  its `turn.failed` / `error` events as the failure, classified like any (an `error`
  codex retried itself is not one). Output declarations gain `match`, `errorEvents`
  and the `{reply_file}` placeholder (**ODW extension**).
- Isolated (`worktree`) agents keep their change as a diff (setup files excluded),
  optionally on a `keep` branch. Review with `odw diff` or the dashboard's Changes tab;
  land with `odw apply`, which previews every file first — clean, conflicting (with the
  conflicting lines) or already applied — and stops there with `--check`; it never
  writes over a file git does not track, and puts back what git wrote when it gives
  up halfway. `--all` applies every finished agent in order, up to the first that
  would conflict; `--verify "npm test"` (or `applyVerify`) runs a check after each
  apply and rolls an apply that fails it back exactly, leaving the rest of your
  uncommitted work alone (**ODW extension**).
- Transcripts: every agent's CLI output is kept — `odw logs <run> --agent <id|label>
  [--follow]`, or live in the dashboard's Transcript sheet.
- Compare two runs: `odw compare <runA> <runB>` shows what changed after you edited a
  prompt, switched adapter or model, or upgraded a CLI — the setup differences
  (workflow sha256, args, odw and CLI versions, behaviour settings, adapters and
  models), wall time, tokens, cost and failures with B − A, and a row per agent
  (matched by label, then by its resume call key, then by order in its phase) with
  whether its reply is identical or differs; red when worse, green when better.
  `--agent` shows one agent's whole reply diff, `--json` and `GET /api/compare` the
  documented structure. Every run now records odw's version and its workflow's sha256
  in `meta.json`, its behaviour settings on `run_started`, and each adapter CLI's
  `--version` on its first dispatch (a `cli_version` event, never delaying the run;
  `"recordVersions": false` turns it off) (**ODW extension**).

### Control what agents may do
- Permission tiers `read` / `edit` / `full` (`--permissions`, per adapter, per call; a
  call can only lower its tier), mapped to each CLI's documented flags; `agentEnv:
  "minimal"` starts agents with only the environment they need (**ODW extension**).
- Secrets stay out of what odw keeps and serves: whatever an agent prints — `cat .env`
  included — is redacted before it reaches its transcript and stderr tail, its saved
  result, the run's events and error or a webhook. The values of secret-named variables
  (`*_KEY`, `*TOKEN`, `*SECRET*`, `*PASSWORD*`, …) of the environment agents and
  commands start with, `NAME=value` of such names, and well-known token shapes
  (Anthropic, OpenAI, GitHub, Slack, AWS, Google keys, JWTs, private keys, `Bearer`)
  become `«redacted:<kind>»`, marked `redacted: true`; `redact.extra` adds patterns of
  your own and `odw doctor` reports it (**ODW extension**). Prompts, what agents see and
  kept diffs are never redacted; the run's result only of token shapes. So are the
  run's `worker.log` (a workflow's `console.log` included) and the Chat Host's sessions
  (Codex's replies in full, what you typed of token shapes only, a streaming reply
  line by line); a run's `args` — and a schedule's — are served by the API and the
  dashboard with their token shapes redacted (`argsRedacted: true`), while `odw rerun`
  and `odw resume` still start from the args as given.
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
- Native structured output: `claude` (`--json-schema`) and `codex` (`--output-schema`,
  for strict schemas) are handed an `agent()`'s schema and enforce it themselves, and
  ODW still validates every reply. Before an agent starts, its schema is checked for
  keywords ODW's validator does not check: the run's log names each one, where it is
  and who enforces it — the CLI when it got the schema natively, otherwise nobody —
  once (`schemaKeywords`: `"warn"` by default; `"strict"` refuses such calls)
  (**ODW extension**; adapters declare native support with `flags.schema` and
  `output.structuredPath`).
- Per-phase adapters and models, model tiers and fallback chains (**ODW extension**):
  `meta.phases: [{ title, adapter, model }]` or `phase(title, { adapter, model })`;
  `model: "@fast"` picks each CLI's own model from the `models` setting; an agent whose
  CLI ran out of quota or is logged out moves down its chain (`adapter: ["codex",
  "claude"]`, or `fallback` in the config) instead of failing, at the same permission
  tier — and `odw status`, the live view and the dashboard's data say where it went.

### Use the CLI and the dashboard
- `odw run` attaches a live foreground view in interactive terminals (Ctrl-C detaches;
  `odw attach` re-attaches); pipes and CI keep the fire-and-poll contract.
- First-run onboarding: `odw init` picks the default agent CLI; `odw doctor [--smoke]`
  checks the runtime, config and every adapter — `--smoke` sends one real prompt.
- A redesigned dashboard ("paper, ink and signal"): an Activity pulse with a "Needs
  you" strip, a live DAG with checkpoint gates and diff badges, a timeline, drawers with
  outputs, usage, failure reasons and tiers, the Changes and Transcript views, a Spend
  receipt (where a run's tokens and dollars went, by phase, adapter and agent; `$`),
  Upcoming schedules, a command palette, light and dark themes, English and Chinese.

### Reliability and safety
- Timeouts and stops reach an agent's whole process tree (SIGTERM, then SIGKILL).
- Workflow `meta` is parsed as a literal and never evaluated; listing workflows never
  compiles a body; installs verify SHA256 checksums.
- The dashboard server reads events incrementally, pushes run-list deltas, and stays
  responsive with thousands of runs.

### Changed behavior — check before upgrading
- The built-in `codex` adapter runs `codex exec --json --output-last-message
  {reply_file}` (it ran text mode). A config entry that gives `codex` its own `command`
  replaces the built-in and needs the matching `output` block to report usage and to
  read its reply from the events (the README shows the full entry). A codex turn that
  ends with no agent message is now an `empty_reply` failure (`allowEmpty: true`
  accepts it) rather than a reply.
- The built-in `claude` adapter runs `--output-format stream-json --verbose`. A config
  entry that gives `claude` its own `command` replaces the built-in and needs the
  matching `output` block to report usage (the README shows the full entry).
- An adapter entry **without** `command` now adjusts the built-in (e.g.
  `"codex": { "concurrency": 4 }`); before, it was an error.
- Adaptive concurrency is on by default (`adaptiveConcurrency: false` turns it off), and
  `claude` fan-outs with long shared prompts may wait up to 2.5s to stagger
  (`staggerFanOut: false`).
- `budget.spent()` counts real output tokens where the adapter reports them.
- A schema keyword ODW's validator does not check (`oneOf`, `anyOf`, `$ref`, `const`,
  `pattern`, `minimum`, `maxItems`, a type union, …) is now reported in the run's log,
  once, with where it is; before, it was skipped without a word. The call still runs
  unless `"schemaKeywords": "strict"`, which refuses it. `format` is an annotation and
  is not reported. A malformed schema (a typo such as `requird`, an unknown `type`)
  now fails its call in either mode.
- `claude` and `codex` agents no longer get their schema described in the prompt when
  their CLI takes it natively (`"schemaPrompt": "always"` keeps the description). An
  entry that gives either its own `command` replaces the built-in: copy `flags.schema`
  (and `claude`'s `output.structuredPath`) from the example config to keep native schemas.
- A `meta.phases` entry's `model` now sets the model of that phase's agents (it was
  metadata only): use a tier (`"@fast"`) when they may run on more than one CLI.
- After 3 quota failures in a row on one adapter (`quotaBreaker`), a run's later agents
  skip it — and fail at once when they have no fallback chain; `"quotaBreaker": null`
  keeps trying the adapter every time.
- An empty or whitespace-only reply fails the agent with reason `empty_reply`;
  `agent(…, { allowEmpty: true })` accepts one.
- Redaction is on by default: transcripts, saved agent results, events, `error.json`
  and webhook payloads show likely secrets as `«redacted:<kind>»`, and `result.json`
  token shapes; a resumed run replays a redacted agent result as kept. `"redact": false`
  keeps everything as printed.
- Config errors are fatal instead of producing a "done" run full of nulls.
- The desktop (Tauri) app is retired in favor of `odw serve`.
