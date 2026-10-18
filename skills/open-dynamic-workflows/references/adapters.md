# Adapters & configuration

An **adapter** is how `odw` invokes one coding-agent CLI. `odw` never calls model
APIs directly — it only shells out to a local command, passing the composed
prompt via stdin or an argument and reading the reply from stdout.

## Built-in adapters

Five ship out of the box, usable with no config file: `codex`, `claude`,
`gemini`, `qwen`, `kimi`. They use each CLI's non-interactive mode.

### Permissions: what each built-in may do

The templates are intentionally conservative, and the built-ins are **not**
equally privileged. Each agent runs at a **permission tier** (an ODW extension):
`read`, `edit` (the default) or `full` — the run's comes from `"permissions"` in
the config or `odw run|rerun|resume --permissions <tier>`, and an adapter's own
`"permissions"` and an `agent()` call's `permissions` may only lower it. At the
default `edit` tier:

- `codex` runs with `--sandbox workspace-write`: it can **edit files and run
  commands** inside its workspace out of the box. It also carries `--search`,
  so it can **search the web** natively.
- `claude` runs with `--permission-mode acceptEdits` plus
  `--allowedTools WebSearch WebFetch`: it can **edit files and use the web**,
  but **not run commands** (a prompt that asks it to execute something will
  stall or be refused). The web allowlist matters: headless acceptEdits
  silently denies WebSearch/WebFetch otherwise, which breaks research
  workflows like `examples/deep-research.js`. To let Claude run commands too,
  run it at `full` (`--permissions full`: `--permission-mode bypassPermissions`)
  — which has **no sandbox**, so do that only against a throwaway `--source`
  directory, never your real repo.

A tier's flags take the place of the `{permission_args}` element of the
adapter's command (its `permissionArgs`). Only mappings a CLI's own docs
confirm for headless runs are filled in:

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

- An agent that asks for more than its run (or its adapter) allows fails before
  it starts, naming both tiers.
- **refused**: `read` on a CLI with no read flags fails the agent before it
  starts, naming an adapter that can and how to lift the read.
- **runs `edit`**: `full` on a CLI with no full flags runs its `edit` flags; the
  run logs that once per adapter. For `kimi`, `omp`, `kilo`, `opencode` and
  `cursor`, `edit` already approves every tool call headless.
- An adapter without `permissionArgs` (your own CLI) runs its command as
  configured, treated as `edit`; under another tier the run logs once that ODW
  cannot enforce it.
- `codex` at any tier cannot approve an MCP tool call that asks for approval:
  pre-approve the tool in `~/.codex/config.toml`
  (`[mcp_servers.<server>.tools.<tool>] approval_mode = "approve"`) — see
  "Permissions" in the README.

Every `odw run` prints the tier each installed adapter runs with; each
`agent_started` event carries the agent's `permissions`; `odw doctor` lists every
adapter's tiers.

```json
{
  "permissions": "read",
  "adapters": {
    "codex": { "permissions": "read" },
    "my_wrapper": {
      "command": ["my-agent", "{permission_args}", "--cwd", "{workspace}"],
      "permissionArgs": { "read": ["--read-only"], "edit": [], "full": ["--yolo"] }
    }
  }
}
```

An entry without `command` changes only the fields it sets on the built-in of
its name (`"codex": { "permissions": "read" }` above). One with a `command`
replaces the built-in whole — for `claude`, keep the stream-json flags, the
`output` block and its `permissionArgs`, as `odw.config.example.json` does; for
`codex`, likewise `--json`, `--output-last-message {reply_file}` and its `output` block.

The built-in `claude` runs Claude Code's `--output-format stream-json --verbose`:
an event per turn, ending in a `result` event that carries the reply, the run's
usage and cost, and `is_error` when it failed.

The built-in `codex` runs `codex exec --json --output-last-message {reply_file}`:
JSONL events, its reply the final message codex writes to that file (else the last
`item.completed` `agent_message`), its tokens from `turn.completed` (no cost — codex
reports none), and `turn.failed` / `error` events its own failure report. Its
transcript shows each command, file change, MCP tool call and web search.

A useful minimal-privilege split: let `claude` write code (acceptEdits) and let
`codex` run/verify it (workspace-write sandbox) — see
`examples/codex-claude-loop.js`.

## Config file

To change the default, tune flags, or add your own CLI, write an
`odw.config.json`. It is discovered, highest priority first:

1. an explicit `--config <path>`
2. `$ODW_CONFIG`
3. `./odw.config.json`
4. `~/.config/odw/config.json`

A user file is merged over the built-ins, so you only specify what you change.

```json
{
  "defaultAdapter": "claude",
  "concurrency": 8,
  "maxAgents": 1000,
  "timeout": 1800,
  "schemaRetries": 2,
  "runsRoot": "~/.odw/runs",

  "adapters": {
    "my_wrapper": {
      "label": "My custom CLI",
      "command": ["my-agent", "--cwd", "{workspace}", "--prompt-file", "{prompt_file}"],
      "env": { "MY_FLAG": "1" },
      "timeout": 600,
      "flags": { "model": ["--model"] }
    }
  }
}
```

All settings are **top-level keys** — do not nest them under a `"settings"`
wrapper. odw warns on stderr about unknown or misplaced keys (with a
did-you-mean hint) instead of silently ignoring them.

### Settings

| Key | Meaning |
| --- | --- |
| `defaultAdapter` | adapter used when a call does not name one. Unset: the sole configured adapter, or — on a fresh install — the sole adapter whose CLI is actually on PATH |
| `concurrency` | max agent CLIs running at once; omit for auto (`min(16, cpus-2)`) |
| `maxAgents` | hard cap on total dispatches per run (runaway guard) |
| `timeout` | per-agent CLI timeout in seconds |
| `stallTimeout` | **ODW extension.** Seconds an agent may print nothing on stdout or stderr before it is killed (like a timeout) and restarted with the same prompt; `null` (default) = off. Off for every built-in because some CLIs (the text-mode `gemini`, `qwen`, `kimi`) print nothing until they finish — enable it for adapters that stream progress: `claude` (stream-json, an event per turn), `codex` (`exec --json`, an event per item), `kilo`, `opencode`, with a value above the longest single tool call |
| `stallRestarts` | restarts per `agent()` call after a stall before the call fails with a "stalled" error (default 1) |
| `transientRetries` | **ODW extension.** Retries per `agent()` call after its CLI hit a rate limit (429/529, overloaded), each after an exponential backoff that honors a retry-after the CLI printed (default 3; `0` = never). A spent quota or a failed login is never retried: its error says what to do |
| `maxBackoff` | the longest single backoff wait, in seconds (default 300); a CLI that asks to wait longer is not retried early |
| `schemaRetries` | extra attempts when a schema fails to validate |
| `runsRoot` | where runs are stored (default `~/.odw/runs`) |
| `workflowsRoot` | where workflows are resolved by name (default `~/.odw/workflows`) |
| `claudeWorkflowsRoot` | where Claude Code saved workflows are picked up (default `~/.claude/workflows`, honors `CLAUDE_CONFIG_DIR`) |
| `claudeJobsScope` | which Claude Code runs the dashboard shows: `"all"` (default) or `"project"` |
| `notify` | **ODW extension.** Run-end hooks: `{ "command": [argv], "webhook": "https://…", "on": ["done", "failed", "stopped"] }` — see below |
| `worktreeSetup` | **ODW extension.** A command run in each new isolated worktree after `.worktreeinclude` has been applied and before its agent starts: a string through the platform shell, or an argv array run without one. It runs in the agent's workspace with the agent's `ODW_RUN_ID`, `ODW_AGENT_ID` and `ODW_PORT`; one that fails or times out fails that agent (not the run), quoting the end of its output. `null` (default) = none |
| `worktreeSetupTimeout` | seconds the worktree setup may run before it is killed (default 600) |
| `portRange` | **ODW extension.** `[first, last]`: the ports each running agent's `ODW_PORT` comes from (default `[41000, 41999]`); keep it wider than `concurrency` |
| `fanOutWarn` | **ODW extension.** When one `parallel()` or `pipeline()` call fans out more than this many tasks or items, the run logs one warning with the count (`large fan-out: …`); it never blocks. Default 25; `0` or `null` = off |
| `adaptiveConcurrency` | **ODW extension.** `true` (default): a rate limit halves its adapter's cap (its own `concurrency`, else the run-wide one) for the rest of the run, never below 1 — once per fan-out that hit it together — and each minute without another gives one slot back; both are logged (`adaptive concurrency: …`). `false` keeps every cap fixed |
| `staggerFanOut` | **ODW extension.** `{ "first": 1, "delayMs": 2500 }` (default): in one `parallel()` or `pipeline()` call, agents on an adapter with `promptCache` whose prompts share their first 1,024 characters start `first` at a time, the rest once the first one's CLI has produced output (JSONL: its first event past the start-up `system` ones) or `delayMs` later, so they read the prompt cache; lone, short-prompt and replayed agents never wait, a stop ends the wait, one log line per staggered fan-out. `false` or `null` = off |
| `maxDiffBytes` | **ODW extension.** Bytes of an isolated agent's diff kept in the run directory (`agents/<agentId>.diff`, read by `odw diff` / `odw apply`; default 2 MB). Past it the head is kept, cut at a line, with a `# odw: diff truncated …` note; the counts still describe the whole change |
| `keepBranches` | **ODW extension.** `true`: every isolated agent's change is also committed to a branch `odw/<runId>/<agentId>-<label>` of the source repository, as `keep: true` does for one agent (`keep: false` opts one out). Default `false` |
| `applyVerify` | **ODW extension.** A command line `odw apply` runs at the repository root after each apply, through the shell and within `timeout`, e.g. `"npm test"`: when it fails, times out or is interrupted, that apply is rolled back exactly (the touched paths' content and index entries; nothing else). `odw apply --verify "<cmd>"` overrides it, `--no-verify` skips it, `--check` never runs it. Default `null` (none) |
| `maxTranscriptBytes` | **ODW extension.** Bytes of each agent's transcript kept in the run directory — what its CLI printed on stdout, `agents/<agentId>.transcript.jsonl` (a JSONL adapter's events as received, other output as `{"kind":"text"}` lines), beside the end of its stderr in `agents/<agentId>.stderr.txt`; read with `odw logs <run> --agent <id\|label>` (default 5 MB). Past it one `{"kind":"truncated","bytes":N}` line ends the transcript; `0` keeps none |
| `recordVersions` | **ODW extension.** `true` (default): on an adapter's first agent of a run, `<cli> --version` (its command's first argv element) runs beside the agent, killed after 3s, and is recorded as a `cli_version` event — `odw status`, `cliVersions` in `GET /api/runs/:id`, and `odw compare` read it. It never delays or fails the run; a CLI that does not answer is recorded as unknown; an adapter whose command is node or another interpreter, a script or a relative path is not probed. `false` runs no probe (the odw version and workflow sha256 in meta.json, and the settings on `run_started`, are recorded either way) |
| `permissions` | **ODW extension.** The run's permission tier: `"read"`, `"edit"` (default) or `"full"` — see [permissions](#permissions-what-each-built-in-may-do). `odw run\|rerun\|resume --permissions` overrides it |
| `agentEnv` | **ODW extension.** `"inherit"` (default): agent CLIs get ODW's whole environment. `"minimal"`: only `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_*`, `TERM`, `TMPDIR`, `TZ` (and the Windows system variables), the auth and config variables the built-in CLIs document (`ANTHROPIC_*`, `CLAUDE_*`, `OPENAI_*`, `CODEX_*`, `GEMINI_*`, `GOOGLE_*`, `DASHSCOPE_*`, `QWEN_*`, `MOONSHOT_*`, `KIMI_*`, `CURSOR_*`, `OPENCODE_*`, the proxy variables, `NODE_EXTRA_CA_CERTS`), `ODW_*`, `agentEnvPass` and the adapter's `env`. `exec()` commands, `worktreeSetup` and `notify` keep the whole environment |
| `agentEnvPass` | **ODW extension.** More names, or `*` globs, a `"minimal"` agent environment passes (e.g. `["AWS_*"]` for Claude Code on Bedrock) |
| `schemaKeywords` | **ODW extension.** What happens to keywords in an `agent()` schema that ODW's validator does not check. `"warn"` (default): the call runs, ODW checks the rest, and the run logs once which keywords, where, and who enforces them (an adapter's CLI that takes schemas natively, `flags.schema`, else nobody). `"strict"`: the call fails before it starts, naming each one. A malformed schema fails in either mode. A `checkpoint()` `schema` (what an edited payload must match) is held to the same rule. See [native structured output](#native-structured-output) |
| `schemaPrompt` | **ODW extension.** `"auto"` (default): the prompt describes the schema only to a CLI that does not take it natively; `"always"`: to every CLI |
| `fallback` | **ODW extension.** Fallback chains: `{ "codex": ["claude"], … }` — when an agent's CLI has spent its usage quota or its login is refused, the agent runs again on the next adapter listed for the one it was on (a fresh prompt, the same options, the same permission tier: an adapter that cannot run that tier is skipped). A rate limit is still retried in place. An `agent()` call's own list, `adapter: ["codex", "claude"]`, takes its place. Every adapter named must be configured. Default `{}` — see [routing](primitives.md#routing-phase-defaults-model-tiers-fallback-chains-odw-extension) |
| `quotaBreaker` | **ODW extension.** After this many quota failures in a row on one adapter, the run's later agents skip it — each starts on the next adapter of its chain, or fails at once without one — with one warning. Default 3; `0` or `null` = never |
| `quotaWait` | **ODW extension.** Pause for a spent quota: `{ "max": <seconds> }` makes an agent with no adapter left on a spent quota wait — holding no slot — for the reset its CLI named ("try again in 3h 22m", "resets 7pm", `usage limit reached\|<epoch>`), when that is at most `max` seconds away, then start over from its chain's start (plus up to 30s of jitter). Until that reset the run passes over the adapter; one with nowhere else to go waits before it is dispatched. The run shows `paused` with `pausedFor: { reason: "quota", adapter, resumeAt }` ("paused until 19:10 (codex quota)" in `odw status`, `odw list`, the live view); `odw resume` goes on at once, `odw stop` stops it. A quota that names no reset, or one past `max`, still fails the agent (logged). The wait lives in the worker: if it dies, the run is stale and `odw resume` replays it. Default `false` — a run that waits for hours should be one someone asked for |
| `models` | **ODW extension.** Model tiers: `{ "fast": { "claude": "haiku", "codex": "gpt-5-mini" }, … }`. `model: "@fast"` (in `agent()`, `phase()` or `meta.phases`) runs an agent with its adapter's id for the tier — after a fallback, the next adapter's; an adapter the tier names no id for runs its CLI's default (logged), and an unknown tier fails the agent. Tier names are letters, digits, `_`, `-` and `.`; every adapter named must be configured. Default `{}` |
| `expectRetries` | **ODW extension.** How many times an agent whose work missed its `expect` checks runs again, told what it missed, before it fails with reason `unmet_expectation` (default 1; an `agent()` call's own `expectRetries` wins) — see [expect](primitives.md#expect-odw-extension) |
| `permissionDenials` | **ODW extension.** What a reply that claims success does when the CLI refused the agent tool calls (`deniedPath`): `"warn"` (default) keeps it — the calls are recorded as `denied` on the agent and logged once — and `"fail"` fails the agent with reason `permission`. An adapter's own `permissionDenials` wins; a call with `expect` counts refused calls as a miss either way |
| `mcpFailures` | **ODW extension.** What an agent does when its CLI started it without an MCP server (`mcpPath`: Claude Code's init event): `"warn"` (default, as Claude Code itself only warns) keeps the reply — every server that is not `connected` is recorded as `mcp` on the agent and logged once per run per server and status — and `"fail"` fails an agent whose server `failed` or `needs-auth` with reason `mcp_unavailable` (`pending` and `disabled` never fail it). A server the call's `expect.mcp` lists is a miss instead |
| `redact` | **ODW extension.** `{ "env": true, "patterns": true, "extra": [] }` (default): what odw keeps and serves — transcripts and stderr tails, saved results, events, the run's error, webhook payloads — has likely secrets replaced by `«redacted:<kind>»` before it is written, and says so with `redacted: true` — and so do `worker.log` and the Chat Host's sessions (what a person typed: token shapes only), while a run's `args` are kept as given for `odw rerun` and served with token shapes redacted. `env`: the values (8+ characters) of secret-named variables (`*_KEY`, `*TOKEN`, `*SECRET*`, `*PASSWORD*`, `AUTHORIZATION`, cloud credentials) of odw's environment and each adapter's `env`, wherever they appear, and `NAME=value` of such names; `patterns`: well-known token shapes (Anthropic, OpenAI, GitHub, Slack, AWS, Google, JWT, private keys, `Bearer`); `extra`: more regular expressions. The run's result gets `patterns` and `extra` only; prompts, what agents see and kept diffs are never redacted. `false` = off; `odw doctor` reports it |

### Adapter fields

| Field | Meaning |
| --- | --- |
| `command` | argument vector; `{placeholder}` tokens are expanded per call (required) |
| `stdin` | optional template fed to the process's stdin (e.g. `"{prompt}"`) |
| `env` | extra environment variables layered over the process environment (ODW's own `ODW_RUN_ID`, `ODW_AGENT_ID` and `ODW_PORT` win over them) |
| `timeout` | per-call timeout in seconds (overrides the run-wide `timeout`) |
| `stallTimeout` | stall timeout in seconds for this CLI (overrides the run-wide `stallTimeout`; `0` turns the watchdog off for this adapter) |
| `concurrency` | **ODW extension.** At most this many agents at once on this CLI, inside the run-wide `concurrency`: an agent needs a slot in both, each adapter queues first come, first served, and a throttled adapter never holds up the others. Unset: the run-wide cap alone |
| `promptCache` | **ODW extension.** `true`: this CLI's model API caches a prompt's prefix, so its fan-outs start staggered (see `staggerFanOut`). The built-in `claude` declares it |
| `label` | human-friendly name for progress display |
| `flags` | capability declaration, e.g. `{ "model": ["--model"] }` — the native flag that carries a per-call `model`. Without it, `agent(..., { model })` is not honored for this adapter (a routing note appears in the logs). **ODW extension:** `"schema": { "args": [...], "mode": "inline" \| "file", "strict"?: true }` says the CLI validates a call's JSON Schema itself — see [native structured output](#native-structured-output) |
| `failures` | **ODW extension.** This CLI's own failure wording: `{ "rate_limit": [...], "quota": [...], "auth": [...] }`, regular expressions matched case-insensitively against the end of a failed run's output before the built-in table |
| `output` | how stdout becomes the reply (default: trimmed text) — see below |
| `permissionArgs` | **ODW extension.** Each tier's flags: `{ "read"?: [...], "edit": [...], "full"?: [...] }` (`edit` required, `[]` for none), put where the command has a `{permission_args}` element — which it must have exactly when this is set |
| `permissions` | **ODW extension.** Caps this adapter's tier below the run's: its agents get the lower of the two |
| `permissionDenials` | **ODW extension.** `"warn"` or `"fail"`: this CLI's own `permissionDenials`, over the run-wide setting |

### Output formats

- `{ "format": "text" }` — the default: the trimmed stdout is the reply.
- `{ "format": "jsonl", "eventType": "text", "textPath": ["part", "text"], "select": "last" }`
  — newline-delimited JSON events, decoded as they stream; the reply is the text at
  `textPath` in the last event whose `type` is `eventType`.
- `{ "format": "json", "textPath": ["response"] }` — one JSON document on stdout.

**ODW extension:** both JSON formats may add `usagePath` (the token counts), `costPath`
(US dollars), `errorPath` (`true`, a message or an error object: the run failed
with it, classified like any failure whatever its exit status) and `deniedPath`
(the tool calls the CLI refused the agent, under a reply that may claim success:
recorded as `denied` on the agent and logged, or a `permission` failure under
`permissionDenials: "fail"` — the built-in `claude` reads `permission_denials`) and
`mcpPath` (the MCP servers the CLI started the agent with, `{ name, status }` each:
one not `connected` is recorded as `mcp` on the agent and logged, or fails it under
`mcpFailures: "fail"`; `jsonl` reads it from `mcpEvent` events, else any event —
the built-in `claude` reads `mcp_servers` from its `system` init event);
`jsonl` reads usage
and cost from `usageEvent` events (default: `eventType`) and adds them up. Usage is
normalized across the CLIs' field names (Anthropic's, OpenAI's, Codex's):
`inputTokens` (cached input included), `outputTokens`, `cacheReadTokens`,
`cacheWriteTokens`, `costUsd`. A whole number in a path indexes an array (negative:
from its end). When stdout does not have the declared text, the raw stdout is the
reply and the run's log says why — the agent does not fail. A `structuredPath`
points at the value the CLI validated against a schema it was handed natively (see
below).

**ODW extension**, `jsonl` only: `match: { "path": [...], "equals": <string, number
or boolean> }` keeps only the text events whose value at `path` is `equals` (codex:
`{ "path": ["item", "type"], "equals": "agent_message" }`), and `errorEvents: {
"<type>": [path] }` names events that are the CLI's own failure report — the path
leads to the message — apart from its text events (codex: `{ "turn.failed":
["error"], "error": ["message"] }`). The latest such event fails the run like
`errorPath`, unless a later `usageEvent` shows the CLI went on. A CLI that writes its
final reply to a file takes `{reply_file}` in its command: a file with text is the
reply; when it is empty or never written and stdout's events held no reply either,
the reply is empty (`empty_reply` unless `allowEmpty`) and the log says what was
missing.

### Native structured output

**ODW extension.** `flags.schema` declares that a CLI validates a JSON Schema itself,
and how it takes one:

| Field | Meaning |
| --- | --- |
| `args` | the flag(s) before the schema, e.g. `["--json-schema"]` |
| `mode` | `"inline"`: the schema's compact JSON is the next argument. `"file"`: the path of a file holding it — `agents/<agentId>.schema.json` in the run directory (a temp directory outside a run), written before each CLI run and removed after it |
| `strict` | `true` for a CLI that takes only OpenAI strict-mode schemas (codex): any other schema — one whose root is not an object, or with an object that is not `"additionalProperties": false` with all its properties `required` — goes in the prompt instead, and the run says so once |

The schema goes after every other argument, where a model flag goes, and is not
placeholder-expanded; a call without a schema runs the command exactly as
configured. When the CLI's output carries the validated value apart from its text,
`output.structuredPath` says where; a value there (not null) is the reply's value,
else the reply text is searched for the JSON, as for any adapter. ODW validates the
value either way and retries with feedback when it does not satisfy the schema; the
prompt describes the schema only to CLIs that do not take it (`schemaPrompt`).

| Built-in | `flags.schema` | The value comes from |
| --- | --- | --- |
| `claude` | `{ "args": ["--json-schema"], "mode": "inline" }` | `structured_output` in its `result` event (`"structuredPath": ["structured_output"]`), else the `result` text |
| `codex` | `{ "args": ["--output-schema"], "mode": "file", "strict": true }` | its final message: the `--output-last-message` file, else its last `agent_message` event |

Before an agent starts, its schema is checked against the subset ODW's validator
enforces ([primitives](primitives.md#schema)). Anything else is named in the run's
log, once, with where it is — left to the CLI when the adapter takes the schema
natively (on a `strict` one, only a strict schema), enforced by nobody otherwise —
and ODW checks the part it can; under `"schemaKeywords": "strict"` the call fails
with an `AgentError` instead. A malformed schema or an unknown keyword fails in either
mode. To turn native schemas off for a built-in, give its `flags` without `schema`:
`"claude": { "flags": { "model": ["--model"] } }`.

### Run notifications (`notify`)

The hooks fire once per run, after its final state is written, so they can
neither delay nor change it; a hook that fails or hangs is only logged to the
run's `worker.log`.

- `command` — an argv run **without** a shell (killed after 30s), in the run's
  source directory, with `ODW_RUN_ID`, `ODW_RUN_STATE`, `ODW_WORKFLOW`,
  `ODW_RUN_DIR`, `ODW_RESULT_FILE` (only when the run has a result),
  `ODW_DURATION_SEC`, `ODW_AGENTS` and `ODW_FAILED_AGENTS` in its environment.
- `webhook` — an http(s) URL that receives a JSON POST (10s limit):
  `{ runId, workflow, state, createdAt, finishedAt, durationSec,
  counts: { agents, done, failed }, error?, text, content }`. `text` and
  `content` carry one summary line ("odw · deep-research finished in 4m12s ·
  12 agents, 1 failed"), so Slack and Discord incoming webhooks render it as is.
- `on` — which final states fire the hooks (default: all three). Opt-in, also
  `"waiting"` — once per `checkpoint()` that starts waiting for a person — and
  `"paused"` — once per pause for a spent quota (`quotaWait`), with
  `ODW_RUN_STATE=paused`, `ODW_PAUSED_ADAPTER` and `ODW_RESUME_AT` (Unix seconds)
  for the command, `state: "paused"` and `pausedFor: { reason, adapter, resumeAt }`
  for the webhook. A pause never fires the run-end hooks.

### Placeholders

Expanded in `command` and `stdin` before each call:

| Token | Value |
| --- | --- |
| `{prompt}` | the full composed prompt (independence framing + task + any schema instruction) |
| `{prompt_file}` | path to a temp file holding the prompt (written only when referenced) |
| `{reply_file}` | **ODW extension.** A fresh path, in a private temp directory, where the CLI writes its final reply (`codex --output-last-message`); read once the CLI exits, then removed |
| `{workspace}` | the directory the agent runs in (its git worktree when it is isolated) |
| `{source}` | the original working tree |
| `{adapter}` / `{role}` | the adapter's name / label |
| `{permission_args}` | **ODW extension.** The agent's tier flags from `permissionArgs`, as argv elements of their own (command only; the element must be the token alone) |

A CLI fits as long as it reads a prompt (via stdin or an argument) and prints its
reply to stdout. Non-zero exit, a timeout, or a missing executable surface as a
failed agent call, classified as `rate_limit`, `quota`, `auth`, `timeout`,
`stalled`, `not_found`, `permission` or `exit` (the `reason` on its
`agent_failed` event; only `rate_limit` is retried — see `transientRetries`).
So does a failure the CLI reports in its output (`errorPath`: Claude Code's
stream-json `is_error` result, often with exit 0; `errorEvents`: Codex's `turn.failed`
and `error`), and a clean exit whose short
text reply is nothing but a rate-limit, quota or login error (`API Error: Rate
limit reached`). A clean exit can still fail (ODW extensions): with reason
`empty_reply` when the reply is empty (unless the call sets `allowEmpty`),
`unmet_expectation` when the work missed the call's `expect` checks, and
`permission` when the CLI refused tool calls (`deniedPath`) and either
`permissionDenials` is `"fail"` or the call has `expect`, and `mcp_unavailable`
when the CLI started the agent without an MCP server that `failed` or
`needs-auth` (`mcpPath`) and `mcpFailures` is `"fail"`.
