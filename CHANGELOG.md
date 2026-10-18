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
- `expect: { untouched: ['test/**', '**/*.snap', '.github/**'] }` (**ODW extension**):
  a file the agent changed, created or deleted that matches a listed glob is a miss
  naming the paths — so an agent cannot edit or skip the tests it is judged by to get
  green. Read like `expect.changes`: an isolated agent's kept diff, an in-place agent's
  change since the call started.

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
- `odw serve` bound off loopback without `--token` prints a loud warning on stderr that
  suggests `--token` (it stays read-only and open, as before); a positional argument to
  `odw serve` is now a bundle file to show; `--port 0` picks a free port.
