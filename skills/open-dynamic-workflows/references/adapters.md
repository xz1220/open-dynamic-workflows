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
  against a throwaway `--source` directory, never your real repo:

```json
{
  "adapters": {
    "claude": {
      "command": ["claude", "--print", "--dangerously-skip-permissions", "--no-session-persistence"],
      "stdin": "{prompt}"
    }
  }
}
```

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
| `stallTimeout` | **ODW extension.** Seconds an agent may print nothing on stdout or stderr before it is killed (like a timeout) and restarted with the same prompt; `null` (default) = off. Off for every built-in because some CLIs (`claude --print` in text mode) print nothing until they finish — enable it for adapters that stream progress |
| `stallRestarts` | restarts per `agent()` call after a stall before the call fails with a "stalled" error (default 1) |
| `schemaRetries` | extra attempts when a schema fails to validate |
| `runsRoot` | where runs are stored (default `~/.odw/runs`) |
| `workflowsRoot` | where workflows are resolved by name (default `~/.odw/workflows`) |
| `claudeWorkflowsRoot` | where Claude Code saved workflows are picked up (default `~/.claude/workflows`, honors `CLAUDE_CONFIG_DIR`) |
| `claudeJobsScope` | which Claude Code runs the dashboard shows: `"all"` (default) or `"project"` |
| `notify` | **ODW extension.** Run-end hooks: `{ "command": [argv], "webhook": "https://…", "on": ["done", "failed", "stopped"] }` — see below |

### Adapter fields

| Field | Meaning |
| --- | --- |
| `command` | argument vector; `{placeholder}` tokens are expanded per call (required) |
| `stdin` | optional template fed to the process's stdin (e.g. `"{prompt}"`) |
| `env` | extra environment variables layered over the process environment |
| `timeout` | per-call timeout in seconds (overrides the run-wide `timeout`) |
| `stallTimeout` | stall timeout in seconds for this CLI (overrides the run-wide `stallTimeout`; `0` turns the watchdog off for this adapter) |
| `label` | human-friendly name for progress display |
| `flags` | capability declaration, e.g. `{ "model": ["--model"] }` — the native flag that carries a per-call `model`. Without it, `agent(..., { model })` is not honored for this adapter (a routing note appears in the logs) |

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
| `{workspace}` | the directory the agent runs in (an isolated copy in `copy` mode) |
| `{source}` | the original working tree |
| `{adapter}` / `{role}` | the adapter's name / label |

A CLI fits as long as it reads a prompt (via stdin or an argument) and prints its
reply to stdout. Non-zero exit, a timeout, or a missing executable surface as a
failed agent call.
