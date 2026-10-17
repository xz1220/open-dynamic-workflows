# Adapters & configuration

An **adapter** is how `odw` invokes one coding-agent CLI. `odw` never calls model
APIs directly — it only shells out to a local command, passing the composed
prompt via stdin or an argument and reading the reply from stdout.

## Built-in adapters

Five ship out of the box, usable with no config file: `codex`, `claude`,
`gemini`, `qwen`, `kimi`. They use each CLI's non-interactive mode.

### Permissions: what each built-in may do

The templates are intentionally conservative, and the built-ins are **not**
equally privileged:

- `codex` runs with `--sandbox workspace-write`: it can **edit files and run
  commands** inside its workspace out of the box. It also carries `--search`,
  so it can **search the web** natively.
- `claude` runs with `--permission-mode acceptEdits` plus
  `--allowedTools WebSearch WebFetch`: it can **edit files and use the web**,
  but **not run commands** (a prompt that asks it to execute something will
  stall or be refused). The web allowlist matters: headless acceptEdits
  silently denies WebSearch/WebFetch otherwise, which breaks research
  workflows like `examples/deep-research.js`. To let Claude run commands too, override the adapter with
  `--dangerously-skip-permissions` — which has **no sandbox**, so do that only
  against a throwaway `--source` directory, never your real repo. An override
  replaces the whole adapter: keep the stream-json flags and the `output` block
  (as below) to keep its usage, cost and error reporting:

```json
{
  "adapters": {
    "claude": {
      "command": ["claude", "--print", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", "--no-session-persistence"],
      "stdin": "{prompt}",
      "output": { "format": "jsonl", "eventType": "result", "textPath": ["result"], "select": "last", "usagePath": ["usage"], "costPath": ["total_cost_usd"], "errorPath": ["is_error"] }
    }
  }
}
```

The built-in `claude` runs Claude Code's `--output-format stream-json --verbose`:
an event per turn, ending in a `result` event that carries the reply, the run's
usage and cost, and `is_error` when it failed.

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
| `stallTimeout` | **ODW extension.** Seconds an agent may print nothing on stdout or stderr before it is killed (like a timeout) and restarted with the same prompt; `null` (default) = off. Off for every built-in because some CLIs (the text-mode `gemini`, `qwen`, `kimi`) print nothing until they finish — enable it for adapters that stream progress: `claude` (stream-json, an event per turn), `kilo`, `opencode`, with a value above the longest single tool call |
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
| `maxDiffBytes` | **ODW extension.** Bytes of an isolated agent's diff kept in the run directory (`agents/<agentId>.diff`, read by `odw diff` / `odw apply`; default 2 MB). Past it the head is kept, cut at a line, with a `# odw: diff truncated …` note; the counts still describe the whole change |
| `keepBranches` | **ODW extension.** `true`: every isolated agent's change is also committed to a branch `odw/<runId>/<agentId>-<label>` of the source repository, as `keep: true` does for one agent (`keep: false` opts one out). Default `false` |
| `maxTranscriptBytes` | **ODW extension.** Bytes of each agent's transcript kept in the run directory — what its CLI printed on stdout, `agents/<agentId>.transcript.jsonl` (a JSONL adapter's events as received, other output as `{"kind":"text"}` lines), beside the end of its stderr in `agents/<agentId>.stderr.txt`; read with `odw logs <run> --agent <id\|label>` (default 5 MB). Past it one `{"kind":"truncated","bytes":N}` line ends the transcript; `0` keeps none |

### Adapter fields

| Field | Meaning |
| --- | --- |
| `command` | argument vector; `{placeholder}` tokens are expanded per call (required) |
| `stdin` | optional template fed to the process's stdin (e.g. `"{prompt}"`) |
| `env` | extra environment variables layered over the process environment (ODW's own `ODW_RUN_ID`, `ODW_AGENT_ID` and `ODW_PORT` win over them) |
| `timeout` | per-call timeout in seconds (overrides the run-wide `timeout`) |
| `stallTimeout` | stall timeout in seconds for this CLI (overrides the run-wide `stallTimeout`; `0` turns the watchdog off for this adapter) |
| `label` | human-friendly name for progress display |
| `flags` | capability declaration, e.g. `{ "model": ["--model"] }` — the native flag that carries a per-call `model`. Without it, `agent(..., { model })` is not honored for this adapter (a routing note appears in the logs) |
| `failures` | **ODW extension.** This CLI's own failure wording: `{ "rate_limit": [...], "quota": [...], "auth": [...] }`, regular expressions matched case-insensitively against the end of a failed run's output before the built-in table |
| `output` | how stdout becomes the reply (default: trimmed text) — see below |

### Output formats

- `{ "format": "text" }` — the default: the trimmed stdout is the reply.
- `{ "format": "jsonl", "eventType": "text", "textPath": ["part", "text"], "select": "last" }`
  — newline-delimited JSON events, decoded as they stream; the reply is the text at
  `textPath` in the last event whose `type` is `eventType`.
- `{ "format": "json", "textPath": ["response"] }` — one JSON document on stdout.

**ODW extension:** both JSON formats may add `usagePath` (the token counts), `costPath`
(US dollars) and `errorPath` (`true`, a message or an error object: the run failed
with it, classified like any failure whatever its exit status); `jsonl` reads usage
and cost from `usageEvent` events (default: `eventType`) and adds them up. Usage is
normalized across the CLIs' field names (Anthropic's, OpenAI's, Codex's):
`inputTokens` (cached input included), `outputTokens`, `cacheReadTokens`,
`cacheWriteTokens`, `costUsd`. A whole number in a path indexes an array (negative:
from its end). When stdout does not have the declared text, the raw stdout is the
reply and the run's log says why — the agent does not fail.

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
- `on` — which final states fire the hooks (default: all three).

### Placeholders

Expanded in `command` and `stdin` before each call:

| Token | Value |
| --- | --- |
| `{prompt}` | the full composed prompt (independence framing + task + any schema instruction) |
| `{prompt_file}` | path to a temp file holding the prompt (written only when referenced) |
| `{workspace}` | the directory the agent runs in (its git worktree when it is isolated) |
| `{source}` | the original working tree |
| `{adapter}` / `{role}` | the adapter's name / label |

A CLI fits as long as it reads a prompt (via stdin or an argument) and prints its
reply to stdout. Non-zero exit, a timeout, or a missing executable surface as a
failed agent call, classified as `rate_limit`, `quota`, `auth`, `timeout`,
`stalled`, `not_found`, `permission` or `exit` (the `reason` on its
`agent_failed` event; only `rate_limit` is retried — see `transientRetries`).
So does a failure the CLI reports in its output (`errorPath`: Claude Code's
stream-json `is_error` result, often with exit 0), and a clean exit whose short
text reply is nothing but a rate-limit, quota or login error (`API Error: Rate
limit reached`).
