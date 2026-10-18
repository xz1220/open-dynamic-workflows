# Changelog

Notable changes to Open Dynamic Workflows. Binaries and the installer come from
[GitHub Releases](https://github.com/xz1220/open-dynamic-workflows/releases); everything
marked **ODW extension** is outside Claude Code's workflow dialect and runs on `odw` only.

## Unreleased — 0.5.0

Everything since v0.4.0 (2026-06-11). The theme: runs you can leave alone — they
survive failures, ask before the expensive parts (from your phone too), say what they
cost and what they changed, run on a schedule or on your own server — and many agents
that share a codebase without surprises: limits that stop runaways, background work that
cannot pass for success, declared scopes, a notes board, an egress allowlist. Plus a
dashboard redesigned to watch them, evals and comparisons to check them, and two
independent security reviews whose findings are all fixed.

### Start runs from where work is tracked; run in CI
- Signed inbound triggers (**ODW extension**): the config's `"triggers"` name a
  workflow, a secret (`secretEnv`, or `secret`) and how deliveries are signed —
  `github` (`X-Hub-Signature-256`), `linear` (`Linear-Signature`, `webhookTimestamp`
  within a minute), `slack` (`X-Slack-Signature`, timestamp within five minutes) or
  ODW's own `hmac-sha256` — plus a JSONPath mapping (`$.issue.number`) from the
  webhook's body into the run's args. `odw serve` answers `POST
  /api/triggers/<name>` with `202 { runId }`, off loopback too (the signature is the
  credential), and starts the run `--untrusted` unless the trigger says otherwise.
  Replays start nothing; bad signatures are rate limited; `events`, `dedupe` (one
  active run per issue), `concurrency` and `rateLimit` per trigger; bodies up to 1
  MiB. Recipes: [`docs/recipes/triggers.md`](docs/recipes/triggers.md).
- A triggered run's `context` (trigger, event, delivery id, issue id and URL,
  repository, Slack channel and thread) reaches the `notify` hooks — `context` in
  the payload, `ODW_TRIGGER`, `ODW_EVENT_ID`, `ODW_EVENT_URL` and `ODW_CONTEXT` for a
  command — so a hook can comment on the issue, reply in the thread or open a draft
  PR and link it.
- `odw run --deadline <seconds>` (**ODW extension**) stops the run gracefully once
  they pass: status `stopped` (`stopReason: "deadline"`), diffs and finished agents
  kept. `--wait`/`--fg` print what finished and exit **3**. `--timeout` still only
  stops waiting (exit 124).
- A composite GitHub Action, `xz1220/open-dynamic-workflows/action@<tag>`: installs
  the pinned release (SHA-256 verified; `install.sh` learned `ODW_SKILL=0` for a
  binary-only install), runs `odw run --wait --deadline` a margin before the job's
  timeout, writes the spend receipt, agent table and failures to the job summary,
  uploads `odw bundle`, and can open a draft PR with `odw apply --pr`. Fork pull
  requests and issue events run `--untrusted`, and with `untrusted-input: auto` as
  untrusted input too (`--untrusted-input`; `apply-pr` then passes
  `--accept-untrusted-input`, the write having been held at the run's checkpoint). See
  [`docs/github-action.md`](docs/github-action.md).

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
- Hand the work over on a fallback (`"fallback": { "handoff": true }`, or `agent(…, {
  handoff: true })`; off by default; **ODW extension**): when an agent's CLI runs out
  of quota or its login is refused mid-task, the next adapter of its chain carries on
  instead of starting over — in the same worktree, partial edits in place, its prompt
  starting with a brief (at most 6 KB) of why the last one stopped, the files it changed
  (diff stat), its last plan or to-do list, the commands it ran and how they ended, and
  its last messages. The brief is kept as `agents/<id>.handoff.md`, told by a `handoff`
  event `{ from, to, reason, bytes }`, and marked in the transcript (`odw logs --agent`,
  the dashboard drawer, the brief folded in). `expect` and the kept diff judge the final
  state, against the worktree's base.
- Several accounts of one CLI in one run (`"accounts": { "claude": [{ "name": "work",
  "configDir": "~/.claude-work" }, …] }`; **ODW extension**): each login becomes an
  adapter `claude@work` with its CLI's config-dir variable (`CLAUDE_CONFIG_DIR`,
  `CODEX_HOME`; other CLIs are refused), its own concurrency cap and quota breaker.
  `adapter: "claude"` then runs on any account — the one with the most headroom first
  (not paused for quota, fewest quota failures this run, fewest agents on it) — and hands
  the work over to the next when one runs out. `odw status` groups agents by account,
  `odw doctor` checks each login without a model call (`claude auth status`, `codex
  login status`) and `--smoke` probes each; a container sandbox copies the account's
  directory. Pooling accounts must follow each provider's terms of service.
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
- Orphaned background work (**ODW extension**): in headless mode an agent can start a
  background shell command (`run_in_background`) or subagent, end its turn and exit —
  the work dies with the CLI while the result says success
  ([claude-code#85129](https://github.com/anthropics/claude-code/issues/85129)). ODW
  reads Claude Code's stream-json task events (`task_started`, `task_updated`,
  `task_notification`, plus the background tool calls themselves) and, when work is
  still open at the `result` event, keeps it as `orphaned` on the agent (events, saved
  result, `/api/runs/:id`, the dashboard drawer) and logs it once, while its reply
  stands (the default `"orphanedBackground": "warn"`); `"orphanedBackground": "fail"`
  fails such agents with reason `orphaned_background`, and with `expect` it is a miss —
  handed back, then `orphaned_background`. Adapters declare their CLI's background
  events generically with `output.background` (`started` / `ended` rules); the built-in
  `claude` ships one.
- Agent questions become checkpoints (**ODW extension**; ROADMAP T1, T10): an agent that
  stops to ask the user — Claude Code's `AskUserQuestion` — gets no answer headless and
  goes on guessing ([claude-code#50728](https://github.com/anthropics/claude-code/issues/50728)).
  ODW reads the tool call from the stream and stops the CLI there, then does what
  `"questions"` says (run-wide, per adapter, or `agent(…, { questions })`):
  `"checkpoint"` (the default) asks a person at a checkpoint — `odw status`, a dashboard
  card with the options as chips, the `notify` "waiting" hook and approve links — and
  runs the same call again, in the same worktree, told "earlier you asked X; the user
  answered Y" (`odw approve <run> --checkpoint N --note "<answer>"`); a rejection, a
  fourth question, `"fail"`, or a question asked anyway under `"deny"` fail it with the
  new reason `needs_input`, its questions on the `agent_failed` event, the drawer and
  `odw status`. `"deny"` runs claude with `--disallowedTools AskUserQuestion`
  (`questionArgs`) and tells the agent to assume and say so. The rerun is logged
  (`retry.reason: "question"`) and counts toward the budget. Activity's "Needs you" and
  the command palette show questions and `needs_input` failures apart from checkpoints;
  the `notify` waiting payload carries `checkpoint.kind` (`"checkpoint"` | `"question"`),
  `checkpoint.question` and `ODW_CHECKPOINT_KIND` / `ODW_QUESTION_AGENT`. Adapters
  declare their CLI's question events with `output.questions`; no reply text is ever
  guessed to be a question, and no CLI session is resumed.
- `expect: { untouched: ['test/**', '**/*.snap', '.github/**'] }` (**ODW extension**):
  a file the agent changed, created or deleted that matches a listed glob is a miss
  naming the paths — so an agent cannot edit or skip the tests it is judged by to get
  green. Read like `expect.changes`: an isolated agent's kept diff, an in-place agent's
  change since the call started.
- A `model_unavailable` failure reason (**ODW extension**): a model the CLI does not
  know, has retired, or does not offer the account — Claude Code's "There's an issue
  with the selected model", Codex's "The model `x` does not exist or you do not have
  access to it", Gemini's "models/x is not found for API version" and
  `ModelNotFoundError`, agy's "invalid model selection", OpenCode/Kilo "Model not
  found", Cursor's "Cannot use this model", each sampled with its source in
  `tests/failures.test.ts`. Read from the final lines only; never retried; like a spent
  quota it moves the agent down its fallback chain (and hands over with `handoff`).
  Adapters may add their own wording (`failures.model_unavailable`); `odw test` scripts
  it as `fail: "model_unavailable"`. Gemini CLI's end of life for individual and free
  accounts (2026-06-18) reads as one too, and the README says so.
- `odw doctor --models` (**ODW extension**): one tiny prompt per adapter/model pair the
  config's `models` tiers, `fallback` chains and default adapter, and the phases of
  `.odw/workflows`, name — on that adapter alone, no retry, no fallback — each reported
  `ok`, `model_unavailable` (a failed check) or `other`; `--json` carries `model: {
  adapter, model, result, from }` per check.
- `odw doctor --local [--endpoint URL] [--model M] [--smoke]` (**ODW extension**): checks
  a local Ollama (`/api/version`, `/api/ps`, `/api/tags`, `/api/show`) or OpenAI-compatible
  server (`/v1/models`, LM Studio's `/api/v0/models`), read-only — default ports 11434
  and 1234, or each `--endpoint` (which implies `--local`). Per loaded model: the context
  it is loaded with (a warning under 32K, with how to set `OLLAMA_CONTEXT_LENGTH`; the
  `/v1` endpoint ignores `num_ctx`), whether it declares tool calling, and an Ollama
  below 0.13.4 (what `codex --oss` guides ask for). `--smoke` sends one ~10K-token
  prompt with a passphrase on its first line and the instruction to repeat it on its
  last; no passphrase is a failed check — the silent front truncation. The probe goes
  only to this machine or the local network, never to an Ollama cloud model, with no
  credentials. README recipe: scout phases on a local model through a `models` tier,
  planning and review in the cloud.
- Drift watch (**ODW extension**): every run compares its CLI versions and requested
  models with the workflow's previous finished run and logs each change once (`drift:
  claude CLI 2.1.302 → 2.1.330 since the last run of review-swarm`); the run summary has
  a `drift` field (`{ since, changes }`, web types too), drawn as a `↯ n changes since
  last run` chip on the run and in the jobs list. A workflow with an eval file
  gets `odw eval <name> --baseline <last report>` suggested; `"driftEval": true` starts
  it once the run ends, detached, its output in `drift-eval.log`.

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
- Approve from your phone (**ODW extension**): with `odw serve --public-url <url>`
  running, each `waiting` hook carries the checkpoint's signed one-time approve and
  reject links (`approveUrl`, `rejectUrl`, `linksExpireAt`; `ODW_APPROVE_URL`,
  `ODW_REJECT_URL`, and `ODW_NTFY_ACTIONS` for ntfy Approve/Reject buttons). A link is an
  HMAC-SHA256 over the run, checkpoint, action and expiry (`approveLinks.ttl`, 24h by
  default) under a 0600 per-runs-root secret (`--rotate-approve-secret`); it opens a
  confirmation page, decides once on a POST with the page's CSRF value (or an ntfy
  button's `X-ODW-Action` header), and records `by: "link"`. Replays, expired and
  tampered links get clear 410/403 pages, and bad links are rate limited like wrong
  tokens. `--token-scope approve` lets a remote token holder answer checkpoints from the
  dashboard too. Nothing else becomes writable remotely; without a server, the hooks say
  why there are no links (`linksUnavailable`).
- Named tokens and who did what (**ODW extension**): `odw serve --tokens FILE` gives
  each person a token of their own — `[{ name, scope: "read" | "approve", hash }]`, the
  hash a sha256, so the file never holds a token — beside or instead of `--token`.
  `odw token add <name> [--scope approve] --file FILE` prints a new token once and
  keeps its hash; `odw token list|remove`. A presented token is hashed and looked up.
  Runs record `launchedBy` in `meta.json` (git `user.email` or `$USER` locally, the
  token's name from the dashboard, `trigger:<name>` from a trigger); checkpoint
  decisions add `who` beside `by` (`cli:<user> <email>`, the token's name, and beside
  `by: "link"` the name of a named token the request carries) in the decision log, the
  `checkpoint_resolved` event and `checkpoint()`'s result; pause, resume and stop record
  `who` in `control.json`, the run's log and `run_stopped`. `odw list --by <name|me>`
  filters; the dashboard's run header says who launched it, a checkpoint's answer who
  gave it, and the Jobs page has Mine / Team chips (`/api/capabilities` → `you`).

### Know what it costs and what it changed
- Real usage and cost: the built-in `claude` adapter reads Claude Code's `stream-json`;
  tokens and dollars per agent and per run in `odw status`, the live view and the
  dashboard; `--budget` meters real output tokens; wide fan-outs warn up front.
- Know the cost before you run (**ODW extension**): `odw estimate <wf> [--args JSON]
  [--json]` gives the p50/p90 wall time, cost, tokens and agents of a run — and of each
  phase and adapter — from the last 20 finished runs of the same source (else of the
  same workflow name; it says which), and `no estimate: no finished runs of this
  workflow yet` without any. `odw run --estimate` prints it and asks y/N on a terminal
  (`--yes`: just print); `GET /api/estimate?workflow=…` serves it. Before a
  `parallel()` or `pipeline()` at least `fanOutWarn` wide the run logs a cost forecast
  (width × the median agent of that phase in those runs, and the p90), and with a
  `costGate: { usd }` — the setting, a `parallel()`'s option, or an `agent()`'s — a
  forecast over the gate becomes a checkpoint (`This fan-out is forecast to cost ~$X
  (p90 $Y) — go?`, answerable from the phone links too); a rejection throws a
  catchable `CostGateRejected`. Without history the gate lets fan-outs through and
  says so once. The dashboard's workspace draws the estimate for a workflow with runs:
  the totals, and a p50/p90 range bar per phase.
  Activity adds a Spend card: the last fortnight's dollars (else tokens) per day,
  stacked by the three workflows that spent most, today lit, with the change against
  the fortnight before; dry runs stay out.
- Codex agents report their tokens too: the built-in `codex` adapter runs `codex exec
  --json --output-last-message {reply_file}` — its reply from that file (else the last
  `agent_message` event), tokens from `turn.completed` (no cost: codex reports none),
  its transcript's commands, edits, MCP tool calls and web searches as tool calls, and
  its `turn.failed` / `error` events as the failure, classified like any (an `error`
  codex retried itself is not one). Output declarations gain `match`, `errorEvents`
  and the `{reply_file}` placeholder (**ODW extension**).
- A built-in `agy` adapter for Google's Antigravity CLI (**ODW extension**): print mode
  on `--output-format stream-json`, the prompt on stdin — its reply, tokens (no cost:
  agy reports none), failure and soft-denied tool calls (`denied_actions`) from the
  `result` event; schemas natively with `--json-schema` when their root is an object
  (`flags.schema.objectRoot`); `edit` runs `--mode accept-edits`, `full` adds
  `--dangerously-skip-permissions`, and it has no `read`; its spent quota ("Individual
  quota reached … Resets in …"), AI credits and sign-in failures are classified; its
  transcript, OpenTelemetry export and `agentLimits` read its tool steps, and show the
  subagents it starts (their output never reaches its stream,
  [antigravity-cli#1077](https://github.com/google-antigravity/antigravity-cli/issues/1077)).
  Output declarations gain `eventKey`, the key that names an event's type.
- The spend receipt in the terminal (**ODW extension**): `odw status` prints a "spend
  by phase" block — each phase's agents, tokens, cost, share and a bar of Unicode
  blocks, within 100 columns, plain under `NO_COLOR` — and `odw list` a cost column
  when any listed run reported dollars.
- Isolated (`worktree`) agents keep their change as a diff (setup files excluded),
  optionally on a `keep` branch. Review with `odw diff` or the dashboard's Changes tab;
  land with `odw apply`, which previews every file first — clean, conflicting (with the
  conflicting lines) or already applied — and stops there with `--check`; it never
  writes over a file git does not track, and puts back what git wrote when it gives
  up halfway. `--all` applies every finished agent in order, up to the first that
  would conflict; `--verify "npm test"` (or `applyVerify`) runs a check after each
  apply and rolls an apply that fails it back exactly, leaving the rest of your
  uncommitted work alone (**ODW extension**).
- `odw apply --resolve [--adapter A] [--confirm]` (**ODW extension**): an agent whose
  diff would conflict goes to a resolver agent instead of stopping the apply. It runs as
  a real run (`origin: "apply-resolve"`, linked both ways: `applyResolve` in its meta,
  `resolvedBy` and an `apply_resolved` event in the run applied) in a temporary
  worktree at the state the diff lands on, told the base, both sides and the
  conflicting lines. Its change is applied — with the agent's clean files — only when
  it edits just the conflicting files, leaves no conflict markers and passes the verify
  command there; `--confirm` asks y/N with the resolved diff shown. Otherwise nothing in
  your tree changes, and odw says why.
- `odw apply <run> --agent X|--all --pr [--base B] [--remote R] [--ready] [--title T]`
  (**ODW extension**): the kept diffs go to a new branch `odw/<run>-<label>` (or
  `odw/<run>-all`) from `--base` or HEAD, made in a temporary worktree — your working
  tree is never touched — one commit per agent under your own git identity (workflow,
  agent, diff stat, run id and cost in the message), pushed to `origin`, and opened as
  a **draft** PR with `gh` whose body is the run summary: agents and their commits,
  phases, the spend receipt, the verify result and `odw diff` commands. An agent that
  conflicts or fails `--verify` stops it before the push. Without `gh` (or logged out)
  it prints the compare URL. It never merges.
- `examples/pr-shepherd.js` (**ODW extension**): given a PR number, it waits for CI with
  `gh` through `exec()`, hands red checks (with their failing logs) and review comments
  newer than the last commit to an isolated fixer checked by `expect`, pushes the fix to
  the PR branch, and asks a `checkpoint()` before `gh pr ready`. Never merges;
  cron-ready with `odw schedule`.
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
- Test a workflow for $0 (**ODW extension**): `odw test [<wf|file>] [--case N] [--json]
  [--keep]` runs the cases of `.odw/tests/<wf>.json` as real runs whose agents a built-in
  mock answers from scripted replies — matched by label or phase glob, prompt substring or
  adapter; a reply, a failure (`rate_limit`, `quota`, `auth`, `permission`, `timeout`,
  `stalled`, `not_found`, `exit`, classified like the real thing), an empty reply, a dry
  stub, `schemaMiss: N` invalid replies first, `delayMs`, `once`. An unscripted agent fails
  the case unless a `default` answers it; `expect` takes `odw eval`'s checks plus `agents:
  { count, labels }` and `logs`. Exit 0 / 1 / 2 (usage). `odw run <wf> --record
  [--record-to FILE]` keeps a real run as a case (each agent's actual reply, redacted and
  capped), and `odw run <wf> --dry` answers every agent with a stub — `"(dry run)"` or a
  schema's smallest valid value — prints the phase tree with each phase's agent count,
  and marks the run `dry: true` (also in the dashboard's run summaries). Example:
  `examples/tests/review-swarm.json`.
- Evaluate a workflow (**ODW extension**): `odw eval <file|name>` runs the cases of an
  eval file (`.odw/evals/<name>.json`) on each of its `adapters`, `repeats` times each,
  at most `concurrency` at once, as real runs marked `origin: "eval"` (shown by `odw
  list` and the run summaries), and judges each with checks that need no model — `{
  path, equals | contains | matches | exists }` on the result, a `{ command }` that
  exits 0 with `ODW_RESULT` and `ODW_RUN_ID` set, `{ state }`, `{ maxCostUsd }`, `{
  maxSeconds }`; a per-run `timeout` stops a run and fails it. The table gives pass
  k/n, median time, cost and tokens per case × adapter, then each failure with its
  check and run id. The JSON report (`--json`, `--out`, kept under
  `<runsRoot>/_evals/<name>/`, served read-only by `GET /api/evals[/:name/:id]`) has a
  `version`, the definition's hash, the odw and CLI versions and every run id;
  `--baseline` adds per-cell deltas and exits 1 when a pass rate fell. Ctrl-C stops
  every run the eval started. Example: `examples/evals/routing.json`.
- OpenTelemetry traces (**ODW extension**): `odw export <run> --otlp [--out FILE | --send]`
  writes a run as OTLP/JSON after the GenAI semantic conventions — `invoke_workflow`,
  `phase`, `invoke_agent` (provider, models, usage, cost, attempts, failure reason),
  `execute_tool` from transcripts, `exec` and `checkpoint` spans, retries and fallbacks as
  span events — with no dependency; trace ids derive from the run id, so a re-export
  de-duplicates. With `otel: { endpoint?, headers?, captureContent? }` in the config the
  worker posts each run's trace once at its end (5s limit; a failure is a `worker.log`
  line). The `OTEL_*` variables fill in endpoint, headers and resource but never turn it
  on; content stays out unless captured, then redacted again and cut at 4096 characters;
  `odw doctor` shows where traces go. Any OTLP/HTTP receiver that takes JSON gets it
  directly (Jaeger, Langfuse, an OpenTelemetry Collector in front of the rest).

### Control what agents may do
- Permission tiers `read` / `edit` / `full` (`--permissions`, per adapter, per call; a
  call can only lower its tier), mapped to each CLI's documented flags; `agentEnv:
  "minimal"` starts agents with only the environment they need (**ODW extension**).
- Untrusted repositories (`odw run|rerun|resume --untrusted`, `"trust": "untrusted"`,
  per adapter too; **ODW extension**): each CLI runs in the way of ignoring the
  repository's CLAUDE.md, hooks, MCP servers and settings its docs give — `claude
  --safe-mode` (not `--bare`, which takes API keys only), `qwen --safe-mode`, `omp
  --no-extensions --no-skills --no-rules` — and the run says once per adapter what a CLI
  without one still lets in (`codex has no documented way to ignore the repository's
  AGENTS.md — its instructions still reach the agent`). The repository's
  `.worktreeinclude` `symlink:` lines and a `worktreeSetup` from a config inside it do
  not run; a `./odw.config.json` ODW finds inside it is not read at all (your own
  config or the defaults apply, and the run says so; one you pass with `--config`
  still does); a config inside it cannot loosen the trust your
  `~/.config/odw/config.json` sets. The trust level shows in the start banner, `odw doctor`, the run's setup, each
  agent's events and saved result, and the dashboard's drawer.
- Untrusted input (**ODW extension**): a run whose args are someone else's text — every
  run a trigger starts (unless `"untrusted": false`), and `odw run --untrusted-input`
  (kept by rerun and resume) — gets fewer capabilities, not a filter: read-only agents
  unless `--permissions` or the trigger's new `"permissions"` gives a tier; `agentEnv:
  "minimal"` with every secret-named variable (`GH_TOKEN`, `GITHUB_TOKEN`, `*_API_KEY`,
  `*_TOKEN`, …) withheld but the ones the agent's own CLI login documents, whatever
  `agentEnvPass` says; a loud warning in the start banner, the log and `run_started`
  without a container sandbox whose network is an allowlist or none — refused instead
  under `"untrustedInput": { "requireSandbox": true }`; and a checkpoint before the first
  agent that may write (once per run; a rejection throws a catchable
  `UntrustedInputRejected`), and a `y/N` (or `--accept-untrusted-input`) before `odw apply
  --pr` — both off with the trigger's `"approve": false`. Scripts read `workflow.input` (`{
  untrusted, args, why, quote(text, label?) }`, `quote` putting text in a fenced data
  block); meta.json keeps `untrustedInput: { why, args, approve }`, status.json and
  `run_started` the profile, and the dashboard's Job header shows a trust line.
- Run agents in containers (`sandbox: { "kind": "container", "image": … }`, `odw
  run|rerun|resume --sandbox container [--sandbox-image <image>]`, per adapter, per
  `agent()` call — which may only tighten it; **ODW extension**): each CLI run, and each
  `exec()` step (offline by default), runs in a fresh Docker or Podman container with
  only its workspace bound (same path), a private home holding a copy of the CLI's login
  files, your uid:gid, no capabilities, `no-new-privileges`, a pids limit and a read-only
  root. Env goes by name, never in argv; a run that times out or is stopped has its
  container killed by name. The image is yours (`examples/sandbox/Dockerfile`) and never
  pulled; `odw doctor` checks the engine, the image and a smoke run. Agents keep the
  network by default (they must reach their model API) — see the threat model in the
  README.
- An egress allowlist for container agents (`"network": { "allow": ["adapter",
  "registry.npmjs.org", "*.example.com"] }`, per run, adapter or call — which may only
  narrow it; **ODW extension**): the agent's container joins an internal network of the
  run (`network create --internal`) whose only way out is an egress proxy sidecar —
  ODW's zero-dependency node script (`odw __egress-proxy`), run in the agent's image
  (which then needs node) or `proxyImage`. It tunnels CONNECT only to allowlisted
  host:443 (or the entry's port), forwards plain HTTP only to allowlisted hosts,
  resolves names itself and refuses IP literals unless listed. `"adapter"` is the hosts
  the adapter declares (`egressHosts`: claude, codex, gemini and agy declare their API
  and login hosts). Every refusal is an `egress_denied` event naming the agent; a CLI
  that ignores `HTTPS_PROXY` gets no network at all. Proxies and networks go at the
  run's end and in the kill-all backstop; `odw doctor` smoke-tests the proxy both ways,
  and the real-Docker CI check fetches an allowed host and is refused another.
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
- Per-agent limits and runaway-loop detection (**ODW extension**): `agent(…, { limits:
  { toolCalls, costUsd, outputTokens, seconds, repeat } })`, over the adapter's and the
  run's `agentLimits` key by key (`null` lifts one). They are enforced live from what the
  CLI prints — Claude Code's stream-json, Codex's `exec --json`, kilo/opencode events —
  and a breach kills the agent's CLI and everything it started at once: the agent fails
  with reason `runaway` and `limitHit` names the limit and the evidence
  (``Bash `npm test` ×5 in a row``, `41 tool calls > 40`). `repeat: n` trips on the same tool call
  (name plus a hash of its arguments) n times in a row. A runaway is never retried
  (`transientRetries`) nor an `expect` miss. A text CLI's spend is checked after each run,
  and the run says so once. Shown in `odw status`, `odw agents` and the agent's drawer.
- A safety snapshot before in-place agents, and destructive git commands caught
  (**ODW extension**; anthropics/claude-code#33850): before a run's first agent that
  works in the source tree (no `isolation: "worktree"`) with `edit` or `full`, a tree
  with uncommitted work is kept at `refs/odw/safety/<run>` — `git stash create` for the
  tracked changes plus the untracked, non-ignored files through a scratch index (your
  tree, index and stash list are never touched; ignored files and untracked files over
  50 MB are not kept) — announced by a `safety_snapshot` event. `odw restore <run>
  [--check] [--force]` previews, then puts it back file by file with `odw apply`'s
  three-way machinery, leaving out what the tree already holds as kept. What agents
  run is read as it streams (Claude Code's Bash, Codex's `command_execution`,
  kilo/opencode/agy shell tools) for `git reset --hard`, `git checkout .`/`-- .`/
  `--force`, `git restore .`, `git clean -f…`, `git push --force`, `git stash
  drop|clear` and `git branch -D`: each is a `destructive_git` event naming `odw
  restore`; `"destructiveGit": "fail"` (default `"warn"`) fails the agent with reason
  `destructive_git` once its CLI is done — ODW cannot stop a command before it runs.
  Commands that only reset a working tree do not count for an isolated agent. Shown in
  `odw logs`, the live view, the agent's drawer and node, and a chip on the run's head.

### Run on a schedule
- `odw schedule add|list|remove|run` writes a cron, launchd or systemd entry that calls
  back into odw — overlap lock, per-schedule log, last run — with no daemon. The
  dashboard's Jobs page shows what runs next.
- Run on your own server (**ODW extension**): `odw run <wf> --on
  ssh://[user@]host[:port][/dir]` checks the remote has odw (install hints when not),
  sends the project — a `git bundle` of HEAD plus a patch of the uncommitted changes,
  untracked files included (`--sync git`, the default), or an rsync mirror (`--sync
  rsync`) — into `~/odw-remote/<repo>` (or the URL's path; a directory odw did not
  make is refused), starts it there detached and prints the remote run id.
  `odw status|logs|attach <run> --on ssh://host` run on the remote odw (attach shows
  the live view); `odw pull <run> --from ssh://host` copies the run directory back
  (rsync, else tar over ssh) as `origin: "remote"`, so `status`, `diff`, `apply`,
  `compare` and the dashboard work here — again and again while it runs. Plain ssh
  with your ssh config and agent (`ODW_SSH` overrides the binary), no daemon, no
  secrets on a command line; the remote uses its own odw config and CLI logins.
- `odw digest [--since 12h|--since-last] [--workflow W] [--json|--markdown]
  [--notify]` (**ODW extension**): one report across runs, built only from what they
  recorded — no agent reply, result or model-written summary is repeated. Groups:
  checkpoints and agent questions waiting now (with `odw approve|reject`), failed and
  stale runs (recorded error, why their agents did not finish, `odw resume`), done runs
  whose agents missed `expect` checks, wrote outside their `scope` or failed under a
  run that went on, done runs with kept diffs (`odw apply <run> --all --check`), and
  spend with the most expensive run. `notify.on: ["digest"]` lets `--notify` send it
  once — webhook `kind: "digest"` with the structured digest, `markdown` and
  `text`/`content`, redacted, plus signed one-time approve links while `odw serve
  --public-url` runs; a command gets `ODW_DIGEST_TEXT`, `ODW_DIGEST_FILE`,
  `ODW_DIGEST_MARKDOWN_FILE` and counts. `--since-last` starts where the last digest
  sent ended (`<runsRoot>/_digest/marks.json`, per `--workflow`; moved only when every
  hook succeeded). `odw schedule add <name> --digest [--cron EXPR]` (cron defaults to
  the new `digest: { cron }` setting) sends `odw digest --since-last --notify` on a
  timer — one message a morning instead of one per run. Recipe:
  [`docs/recipes/notify.md`](docs/recipes/notify.md#a-morning-digest).

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
- Workflows from Claude Code plugins (**ODW extension**): the workflows your installed,
  enabled plugins ship (`workflows/`, or the manifest's `"workflows"`) run as
  `odw run <plugin>:<name>` — the name Claude Code gives them — in place and read-only,
  through the same loader; `odw workflows list --plugins` and `GET /api/workflows`
  (provider `claude-plugin:<plugin>`) list them. Discovery follows
  `installed_plugins.json` and `enabledPlugins`; a project workflow of the same bare
  name wins, with a note. Each run logs which plugin, version and scope its workflow
  came from, and any ODW-only primitive it uses.
- A dialect conformance suite ([#13](https://github.com/xz1220/open-dynamic-workflows/issues/13)):
  `conformance/` holds 32 plain workflow scripts in Claude Code's dialect, each with an
  `expected.json` — its result, and the logs, phases and agents that matter — run on a
  deterministic mock agent that answers from a table in the case. `odw conformance
  [--json] [--case N]` checks this odw against them (exit 1 on any failure; CI runs it).
  Each case says whether Claude Code's docs settle its behaviour (`documented`) or not
  (`unspecified`, pinning what ODW does); scripts that pass conformance run on both.
  `conformance/README.md` gives the format for another runtime's runner, and the cases
  run on Claude Code by hand.
- A notes board for parallel agents (**ODW extension**; ROADMAP R3): with `agent(…, {
  notes: true })`, `parallel(thunks, { notes: true })` or `"notes": true`, agents find
  the notes posted before they started in their prompt and post their own with
  `"$ODW_NOTES" "…"` — a small shell script of their own, which works in a container
  sandbox too — or `odw note "…"`. When an isolated agent with notes on finishes with a
  kept change, odw posts its diff stat and the declaration lines (`export`, `def`,
  `func`, `pub fn`, `class`, `interface`) its diff touched before its `agent_finished`,
  so later agents know what it changed. Notes are capped (2000 characters each, 200
  notes, 256 KiB) and redacted, kept as `notes.jsonl`, emitted as `note_added`, and read
  with `odw notes <run> [--json]` and `GET /api/runs/:id/notes`. Off by default.
  Example: `coordinated-refactor.js`.
- Workflow memory with provenance (**ODW extension**; ROADMAP S7): what earlier runs of a
  workflow learned, kept in the repository as `.odw/memory/<workflow>.jsonl` (reviewable
  in PRs), one `{ id, text, kind, paths, commit, run, agent?, at }` per line, from
  explicit sources only — a note kept with `"$ODW_NOTES" --keep "…"` or `odw note --keep
  [--paths …]`, a checkpoint rejected with a note or approved with an edit (a structural
  diff of the payload) under `checkpoint(…, { memory: true | { paths } })`, an `expect`
  miss a retry then met under `agent(…, { memory: true })`, and `odw memory add`; never
  a model's summary; each only where memory is on (a kept note: its agent's). An agent
  with `memory: true` (or `"memory": true` in the config) gets the entries that still
  apply ahead of its task — newest first, at most 4 KB, each labelled with its kind
  and origin and its text quoted —
  and an entry whose `paths` changed since its `commit` (`git diff --name-only`) is
  stale and left out, the run saying how many. Written when the run ends, redacted, at
  most 500 per file (oldest pruned, logged). Untrusted runs neither recall nor keep the
  repository's memory; a `memoryDir` of the user's own outside the repository they use.
  `odw memory list|add|prune`, `GET /api/memory`, and `web/src/types.ts`
  `WorkflowMemory`. The dashboard's workspace lists a workflow's memory, newest first:
  the kind, the run and agent each entry came from, its globs, and stale entries
  struck through, with `odw memory prune <wf> --stale` to copy.
- Declared scopes (**ODW extension**; ROADMAP R11): `agent(…, { scope: ["src/auth/**"] })`
  names the files a call means to change, with the `expect` glob rules. Scoped calls in
  flight at once whose scopes overlap — decided conservatively from the globs: braces
  expanded, equal literal paths, a glob matching a literal path, or one glob's literal
  prefix starting with the other's — run one after the other: the later waits, holding
  no slot, and the run logs it once (`fix-auth waits for refactor-login: both declare
  src/auth/**`); disjoint and unscoped calls keep running together. What an agent changed
  outside its scope is kept as `outOfScope` on its terminal event and saved result,
  logged, shown by `odw agents` and the dashboard, and posted to the notes board when
  notes are on. `scopePolicy` (per call, or the `"scopePolicy"` setting, recorded in a
  run's setup) is `"warn"` by default; `"fail"` fails such an agent with reason
  `out_of_scope`, and with `expect` it is a miss. In place, writes inside the scope of a
  scoped call that ran beside it are not counted.
- Debug one step (**ODW extension**; ROADMAP S4). `odw replay <run> --agent <id|label>
  [--prompt @file|TEXT] [--adapter A] [--model M]` dispatches one saved `agent()` call
  again as a small new run (`origin: "replay"`, `replayOf` in its meta.json): every call
  now keeps its inputs as it starts (`agents/<id>.call.json`), an isolated agent's
  `agent_started` names its worktree's `base` commit, and the replay checks that commit
  out whatever HEAD is now. It prints the `odw compare` command that pairs the replay
  with its original. `odw run <wf> --break <phase|label>[,…]` and `--step` stop the run
  for a decision before those phases or agent labels (or every phase): a checkpoint
  titled `Break before phase X` whose payload is the run so far — approve goes on,
  reject stops the run, an approval with edited `args` changes them in place for what
  the script reads from then on (object or array args only).
- `odw check <script.js|name> [--json]` (**ODW extension**) loads a workflow as a run
  would, never running it, and reports `file:line:col` with a code frame; exit 0 or 1.
  Parse errors now carry the line and column everywhere (runs, `validate()`) and keep
  the compiler's own message, with a hint only where it fits — TypeScript syntax only
  when a type annotation, `interface` or `as` is at fault (anthropics/claude-code#63540
  blamed TypeScript for every parse error), an `await` in a callback that is not
  `async`, a script that ends before a bracket closes — and a `meta` that is declared
  but not exported says what was found.

### Use the CLI and the dashboard
- `odw run` attaches a live foreground view in interactive terminals (Ctrl-C detaches;
  `odw attach` re-attaches); pipes and CI keep the fire-and-poll contract.
- First-run onboarding: `odw init` picks the default agent CLI; `odw doctor [--smoke]`
  checks the runtime, config and every adapter — `--smoke` sends one real prompt.
- `odw new [<template>] [--name N] [--force] [--yes]` (**ODW extension**): a workflow
  from a template embedded in the binary — `hello`, `review-swarm`, `fix-until-green`,
  `plan-approve-execute`, `pr-shepherd`, `fan-out-reduce` — written to
  `.odw/workflows/<name>.js` with a starter test, `.odw/tests/<name>.json`, that `odw
  test <name>` passes at once, and for the review-ish ones an eval skeleton in
  `.odw/evals/`. It never overwrites a file with other content without `--force`
  (then it writes nothing, exit 1); `odw new` alone lists the templates. In a git
  repository without a `.worktreeinclude` it prints one built from the lockfiles
  (`symlink:` lines for `node_modules`, `.venv`, `vendor`) and `.env*` files, and
  writes it with `--yes` or a yes at a terminal. The templates are embedded at build
  time (`scripts/embed-templates.mjs` → `src/templates.generated.ts`, drift-checked in
  CI like the dashboard).
- `odw init` ends with a first run that costs nothing: at a terminal it offers `odw new
  hello` and runs `odw run hello --dry` — the live view, every agent stubbed — then
  prints the dashboard command and the real `odw run hello`. It never makes a paid call
  itself; off a terminal it prints the commands. The README quick start now leads with
  `odw new`, `odw test` and `odw run --dry`, then the real run.
- A redesigned dashboard ("paper, ink and signal"): an Activity pulse with a "Needs
  you" strip, a live DAG with checkpoint gates and diff badges, a timeline, drawers with
  outputs, usage, failure reasons and tiers, the Changes and Transcript views, a Spend
  receipt (where a run's tokens and dollars went, by phase, adapter and agent; `$`),
  Upcoming schedules, a command palette, light and dark themes, English and Chinese.
- The Chat Host talks to codex as the `codex` adapter does (**ODW extension**): `codex
  exec --json` with its reply from `--output-last-message` (else the last
  `agent_message`), each message shown as it completes while the reply streams, the
  turn's tokens kept on the message (`usage`), and a failure codex reports classified
  — a spent quota or a refused login says what to do (`failureReason`).
- Share a run (**ODW extension**): `odw bundle <run> [--out FILE] [--no-transcripts]
  [--max-bytes N]` writes `<run>.odwrun`, one self-contained JSON file — meta, status,
  events, saved agent results, kept diffs, transcripts, the result and the error — all
  through the run's redactor (token shapes and the environment's secret values, even
  with `redact: false`), marked `redacted: true` where something was replaced, never the
  config, the environment or `notify`/`otel`; refused past 32 MiB unless `--max-bytes`
  raises it. `odw view FILE` (`odw serve --open FILE`) shows it read-only: the file is
  checked (size first, run id, integer agent ids, field types), unpacked into a private
  temp dir removed on exit, and served alone, tagged "shared bundle", every write refused.
  The Job header's **Share** copies `odw bundle <run>`.
- Remote read-only access (**ODW extension**): `odw serve --host 0.0.0.0 --token [VALUE]`
  makes every `/api` request and the live stream need the token — `Authorization: Bearer`,
  or `?token=` which sets an HttpOnly SameSite=Strict cookie — compared in constant time,
  with wrong tokens rate limited per address (429). With no VALUE a random token is
  printed once, in the URL (`/#token=…`); the dashboard trades it for the cookie and shows
  a "needs a token" screen without one. Writes stay refused off loopback whatever the token.

### Reliability and safety
- Timeouts and stops reach an agent's whole process tree (SIGTERM, then SIGKILL).
- Workflow `meta` is parsed as a literal and never evaluated; listing workflows never
  compiles a body; installs verify SHA256 checksums.
- The dashboard server reads events incrementally, pushes run-list deltas, and stays
  responsive with thousands of runs.
- `odw gc` and `odw pin` (**ODW extension**): `odw gc [--yes] [--older-than 30d]
  [--json] [--source DIR]` reports what runs left on disk, with sizes — orphaned
  `$TMPDIR/odw-wt-*` worktrees whose process is gone (each worktree now names its
  process, run and repository in `odw-owner.json` beside it), keep branches whose change
  HEAD already holds or whose run is past retention, safety snapshots
  (`refs/odw/safety/<run>`) of runs past retention, and expired runs' transcripts and
  stderr — and deletes nothing without `--yes` (worktrees as the worker would:
  unlock, `remove --force --force`, prune; meta, events, results and diffs of a trimmed
  run stay, `gc.json` says what went). Running, paused and waiting runs, and runs marked
  with `odw pin <run>` (`pinned.json`; `--remove` unpins), are skipped; branches and
  worktrees odw did not make are never looked at. Config `retention: { days: 30,
  transcripts: true }`. Each worker says once in the run's log when its repository has
  orphaned worktrees; `odw doctor` gains a **Disk** line (runs root size, orphans); the
  dashboard tags a run **pinned** or **transcripts trimmed**.

### Security fixes found in review
- A sandboxed agent could plant git config (`core.fsmonitor`, hooks) in its workspace's
  `.git` that ran on the host when ODW captured its diff. A container now gets its
  workspace's `.git` read-only, and every git ODW runs on the host turns fsmonitor and
  hooks off.
- A reply file the agent replaced with a link or a FIFO was followed (returning a host
  file as the reply) or waited on forever; such files are now refused.
- A relative `--config` was resolved by the worker in the run's source directory, so an
  untrusted run could read the repository's own config; it is now made absolute where
  `odw` was started.
- The private homes holding copies of a CLI's login are removed by the worker's exit
  backstop too, not only on a clean exit.
- A sandboxed agent with notes on could read and delete host files through its notes
  inbox: its whole notes directory was bound read-write, so it could replace the inbox
  with a link to a host directory, and the worker's sweep followed links — posting the
  files there to the board, then deleting them. A container now gets only its inbox
  (read-write) and its notes script (read-only), and the sweep takes only regular files
  from an inbox that is a real directory where ODW made it, never following a link or
  waiting on a FIFO.
- The egress proxy checked a plain-HTTP request's URL but sent the client's `Host`
  header on, so an agent could reach any site behind an allowed address. A `Host`
  header naming another host is now refused, and the URL's host is what is sent.
  `CONNECT` can be fronted the same way through TLS SNI (domain fronting); the README's
  threat model now says the allowlist limits by host name, not by site.
- Containers on an egress network get `--dns 192.0.2.1` on Docker, so Docker's embedded
  resolver before 26.0 cannot carry lookups out through the host (CVE-2024-29018); `odw
  doctor`'s egress check fails when an outside name resolves there.
- The egress proxy listened on every interface, so containers on the engine's default
  network could use it; it now listens only on its internal-network address.
- Egress denials are capped: at most 200 `egress_denied` events per run, then one log
  line with the count, and 1 MiB of denial log per proxy. A proxy or network that could
  not be removed at a run's end is left for the exit backstop instead of forgotten.
- `odw pull` kept symbolic links from the remote run directory (rsync `-a`, or the tar
  fallback), so a remote `decisions.jsonl` link made a local `odw approve` write outside
  the runs root. rsync now runs with `--no-links --no-D`, and after any copy every link,
  device, socket or fifo is removed (and named). A pulled run (`origin: "remote"`) is no
  longer answered or controlled here: `odw approve|reject|pause|stop|resume` and the
  dashboard (409) refuse it and point to `odw approve <run> --on ssh://host`, which these
  commands now take.
- A failed `odw pull` left a directory that looked like a local run and blocked every
  later pull of it. The copy now lands in a staging directory under the runs root, is
  checked and marked there, and is renamed into place; a failure leaves nothing, and an
  earlier copy stands as it was.
- Handoff handed a trusted adapter's worktree to an untrusted (or differently sandboxed)
  fallback. The held worktree now records its runs' trust and container engine; a
  fallback that runs otherwise starts in a fresh worktree, its brief saying the work was
  not carried over.
- The handoff brief was redacted only after it was cut, so a secret the cut split could
  survive in part. Each piece — the reason, every file, the plan, every command, every
  message, the output's tail — is now redacted before any cut, and a text tail that
  starts mid-line drops that line.
- After a handoff, a stall restart, rate-limit retry or schema retry on the fallback got
  a fresh worktree but kept the brief that says the work is there. Every run of the call
  on that adapter now keeps the handed-over worktree (an `expect` retry still starts over,
  without the brief).
- Anyone could block every approve link: the bad-link limiter ran before the link's
  signature was checked. The signature is now checked first; a valid link is never held
  back, and only bad ones count and wait.
- `limits.seconds` above about 24.8 days stopped an agent early (a timer's longest wait);
  the timer now waits again for the time still left.
- `odw serve --public-url` with a path minted links nothing answered; such a URL is now
  refused with a clear message: it must be a root (`https://host[:port]`).
- `odw run --on` treated a `--source` or workflow under a directory named like `..data`
  as outside the project.
- `odw apply --pr` let `gh pr create` guess the repository from the checkout (an
  `upstream` remote, a set default). It now passes `--repo owner/name` of the remote the
  branch was pushed to (`HOST/owner/name` off github.com).
- A repository's own config could make `odw serve` start trusted runs for anyone: a
  clone's `./odw.config.json` named a trigger with an inline secret and `"untrusted":
  false`, and the trigger route was matched before the DNS-rebinding Host guard, so a
  page a browser opened could post a signed request to a loopback `odw serve`. Triggers
  now come only from the user's own config (`--config`, `$ODW_CONFIG`, or
  `~/.config/odw/config.json` outside the repository); a repository config's are refused
  with a warning at start. On a loopback bind the Host guard covers the trigger route,
  letting loopback hosts and the `--public-url`'s host through.
- A GitHub delivery could be replayed after an hour, or after `odw serve` restarted
  (GitHub signs no timestamp; its signature was remembered in memory for an hour). Each
  accepted delivery's signature and `X-GitHub-Delivery` id are now kept in
  `<runsRoot>/_triggers/seen.jsonl` for 30 days and checked across restarts. A delivery
  older than that, or replayed against another runs root, still verifies: rotate a
  secret that may have leaked.
- A trigger answered `404` for a name the config lacks and `503` while its secret was
  unset, before any signature check, so an unauthenticated caller could list the
  triggers. An unknown name, an unset secret and a bad, missing or stale signature now
  get the same `401`, after the body is read and checked; `odw serve` logs the reason.
- `--deadline` threw away what isolated agents it killed had changed. Their partial work
  is now captured and kept as their diff, the `agent_failed` event marked `partial:
  true`. A stop by a person still keeps no killed agent's change.
- Dry runs and `odw test`'s recorded runs fed `odw estimate` and the cost forecasts:
  twenty dry runs pushed every real run out of the window, so the estimate had no cost
  and `costGate` let every fan-out through. Runs no model answered (`meta.dry`, `origin:
  "test"`) are now left out.
- The GitHub Action passed its `args` input to `odw run --args` as it was: `@/proc/self/
  environ` made odw read that file into the run, and a leading `-` read as a flag. The
  input now goes through a file (`--args=@<file>`), the other inputs as `--flag=value`.
- The Action's `untrusted: auto` ran a `workflow_run` that followed a fork's run, and a
  same-repository `pull_request_target`, trusted. Both now run `--untrusted`.
- The Action installed a release without published checksums with a warning. It now
  refuses one (`ODW_REQUIRE_CHECKSUMS=1` in `install.sh`), and the docs say the SHA-256
  check proves integrity (the file the release lists), not authenticity.
- `odw replay` put the original prompt in the new run's `meta.json` args, which the
  dashboard serves with token-shape redaction only. The call now lives in the run's
  `call.json`, which nothing serves; `args` hold `{ replayOf }`.
- Workflow memory let an untrusted run reach another repository's memory: "outside
  the repository" was judged with links resolved, so a clone shipping `.odw/memory ->
  ../../victim/.odw/memory` (or a `memoryDir: "../victim/…"` in its own config) had
  the run read that memory into its prompts and write to it. An untrusted run now uses
  memory only from a `memoryDir` of the user's own config that lies outside the
  repository both as written and with links resolved; the run's log names where a
  linked file really is. Also in memory: an entry, and each value of a checkpoint
  edit's summary, was cut before it was redacted, so a long secret or token cut below
  the length the redactor knows it by survived in part — both are now redacted first,
  then cut; so are the notes board's notes and the interface lines ODW posts for a
  kept change, which had the same order. A large file froze the run or `odw serve` (read whole, then one blocking
  `git diff` per distinct commit, for every file on `GET /api/memory`): a file over 4
  MiB (or not a regular file) is now refused and said — in the run's log, by `odw
  memory list`, as `error` in the API — and never written over, and at most 32
  distinct commits are checked per file (the newest entries' first; entries at others
  count as stale), each answer cached per commit and HEAD. Recall told agents its
  entries were kept "by people and checks, not by a model", yet kept notes are
  agents' own words and a multi-line entry could pass for the prompt's own headings:
  the header now says who keeps what, and each entry is labelled with its kind and
  origin (run and agent, or "by hand"), its text quoted with `> ` on every line. A
  note kept with `--keep` now becomes memory only from an agent with memory on (the
  setting or `agent(…, { memory: true })`), the only agents told of `--keep`; from
  others it is posted unkept, and the run says so. `odw memory list` printed an
  entry's `paths`, time and commit raw (terminal escapes); they now pass through the
  sanitizer, and an entry whose `run`, `agent`, `at` or `paths` has the wrong type is
  skipped. Files were written through a predictable `<file>.<pid>.tmp`, which a
  planted link could redirect; the temp name is now random and created fresh (`wx`).
- A read-only Claude Code agent of a run with untrusted input kept `WebFetch` and
  `WebSearch`, so text from outside could have it read a token on disk — the one
  `actions/checkout` leaves in `.git/config` — and send it anywhere. Without a container
  sandbox whose network is an allowlist (or `"none"`), read-only agents now start
  without them (and codex without `--search`); the run's untrusted-input profile and
  warning say so. The Action's docs check out with `persist-credentials: false` for
  untrusted events, its `apply-pr` push authenticates through `gh` for that step only,
  and its run step warns when untrusted input meets an `http.*extraheader` in git's config.
- `agentEnv: "minimal"` passed every vendor's variables to every agent, so under
  untrusted input claude got `OPENAI_*` and gemini every `GOOGLE_*` — a runner's
  `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_OAUTH_ACCESS_TOKEN` or
  `GOOGLE_GHA_CREDS_PATH`. An agent of such a run now keeps only its own CLI's login
  variables (gemini's: `GEMINI_*`, `GOOGLE_API_KEY`, `GOOGLE_GENAI_USE_VERTEXAI`,
  `GOOGLE_GENAI_USE_GCA`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`), and
  `*_HEADERS` (`ANTHROPIC_CUSTOM_HEADERS`) counts as secret-named — withheld, and
  redacted from what ODW keeps. Trusted runs' minimal environment is unchanged.
- A checkpoint's or question's title — a model's words — went into the notify
  webhook's `text` and `content` as written, so `<!channel> <https://evil.example|Approve
  run>` pinged a Slack channel with a fake approve link. Slack's `text` now has `&`, `<`
  and `>` escaped, and Discord's `content` has `@everyone`, `@here`, `<@…>`, `<#…>` and
  `[label](url)` links broken (besides `allowed_mentions: { parse: [] }`).
- Destructive git detection missed `if …; then git reset --hard`, `! git …` and the
  other shell keywords, `git switch --force` / `--discard-changes`, `git push --mirror`,
  `git push --delete` (`-d`, `:refspec`), and an isolated agent's `git -C <dir>` (or
  `--git-dir`, `--work-tree`) reset of another tree. All are now seen; git pointed
  elsewhere counts as in place. The README says the detection is advisory and best
  effort, and names what it misses (`find -exec`, `xargs`, git aliases).
- The safety snapshot kept every untracked file git does not ignore, `.env` and
  `id_rsa` included, in a ref of the repository that `git push --mirror` would publish.
  Untracked files with secret-like names (`.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`,
  `id_rsa`, `id_ed25519`, `id_ecdsa`, `credentials.json`) are now left out and named in
  the `safety_snapshot` event (`secretLike`), and the README says the snapshot is a ref
  in the repository holding other untracked files until `odw gc` expires it.

### Changed behavior — check before upgrading
- Signed triggers in a repository's `./odw.config.json` are no longer served: move them
  to `~/.config/odw/config.json` or pass `--config`. A tunnel to a loopback `odw serve`
  needs `--public-url <the tunnel's URL>` for its webhooks to pass the Host guard.
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
- `odw serve` bound off loopback without `--token` prints a loud warning on stderr that
  suggests `--token` (it stays read-only and open, as before); a positional argument to
  `odw serve` is now a bundle file to show; `--port 0` picks a free port.
