# Events and failure reasons

English · [简体中文](../zh-CN/reference/events.md)

What a run leaves on disk, the events its worker writes as it goes, and the reasons
an agent fails with. The run directory and its events are ODW's own (Claude Code
keeps its runs elsewhere); `odw logs`, the dashboard and `GET /api/runs/:id` read them.
The source of truth is [`src/events.ts`](../../src/events.ts),
[`src/adapters/failures.ts`](../../src/adapters/failures.ts) and the header of
[`src/runtime/run-store.ts`](../../src/runtime/run-store.ts).

## The run directory

A run is `<runsRoot>/<workflow-slug>/<runId>/` (`runsRoot` defaults to `~/.odw/runs`).
The worker writes it; every command reads it, so a run outlives the command that
started it. JSON files are written atomically (a temp file renamed over).

| Path | What it holds |
| --- | --- |
| `meta.json` | the run's description, written once: script, args, source, config, workflow name, what it resumes or replays, who launched it |
| `status.json` | its state (`running`, `paused`, `done`, `failed`, `stopped`) and counters |
| `events.jsonl` | the append-only event stream below |
| `agents/<agentId>.json` | each finished `agent()`'s result, saved as it lands (what `odw resume` replays) |
| `agents/<agentId>.diff` | what an isolated agent changed — see [Review and apply](../guides/reviewing-and-applying.md#review-and-apply-what-isolated-agents-changed-odw-extension) |
| `agents/<agentId>.transcript.jsonl`, `.stderr.txt` | what its CLI printed — see [Agent transcripts](../guides/running-and-observing.md#agent-transcripts-odw-extension) |
| `agents/<agentId>.call.json` | what the call was asked, for `odw replay` |
| `agents/<agentId>.handoff.md` | the brief a fallback gave the next adapter |
| `result.json` / `error.json` | the final value, or the error |
| `control.json`, `decisions.jsonl` | pause/resume/stop requests; answers to `checkpoint()` calls |
| `worker.log` | the worker's own output |

What odw keeps of its agents is redacted first — see
[Secrets in what ODW keeps](../guides/safety-and-trust.md#secrets-in-what-odw-keeps-odw-extension).

## Event types

Each line of `events.jsonl` is one JSON object: `{ "ts": <seconds>, "type": "…", … }`.

| Type | When |
| --- | --- |
| `run_started` | the run began; carries its behaviour settings |
| `run_finished`, `run_failed`, `run_stopped` | the run ended (`run_stopped` carries `who` when a named person stopped it) |
| `phase_started` | `phase(title)` was called |
| `log` | `log(msg)`, and every note odw itself adds to the run's log |
| `agent_started`, `agent_finished`, `agent_failed` | an `agent()` call's life; a failure carries its reason (below) |
| `command_started`, `command_finished`, `command_failed` | an `exec()` step (ODW extension): finished means exit 0 |
| `checkpoint_requested`, `checkpoint_resolved` | a `checkpoint()` began waiting, and was answered (ODW extension) |
| `fanout_done` | a `parallel()` or `pipeline()` call settled: totals, failures by reason, `minOk` (ODW extension) |
| `note_added` | a note on the run's notes board (ODW extension) |
| `handoff` | a fallback handed an agent's work to the next adapter (ODW extension) |
| `cli_version` | an adapter CLI's version, once per run on its first dispatch (ODW extension) |
| `cli_version_changed` | the CLI answered with another version later in the run (ODW extension) |
| `model_substituted` | the CLI said another model served the agent than the one asked for (ODW extension) |
| `host_suspended` | the machine slept; every agent's stall timer started over (ODW extension) |
| `safety_snapshot` | the working tree was snapshot before the first in-place agent (ODW extension) |
| `destructive_git` | an agent ran a destructive git command (ODW extension) |
| `egress_denied` | a container sandbox's egress proxy refused a request (ODW extension) |
| `acp_permission` | an ACP agent's permission request, answered by its tier (ODW extension) |
| `apply_resolved` | `odw apply --resolve` ran a resolver for one of the run's agents (ODW extension) |

`odw export --otlp` turns the same stream into OpenTelemetry traces — see
[Observability](../guides/running-and-observing.md#observability-opentelemetry-traces-odw-extension).

## Failure reasons

An `agent_failed` event, an agent's saved record and `odw outcomes` name one of these.
An adapter's `failures` config can add patterns to the first five — see
[Rate limits, quotas and logins](../guides/cost-limits-and-quotas.md#rate-limits-quotas-and-logins).

| Reason | Meaning |
| --- | --- |
| `rate_limit` | throttled or overloaded for now: retried after a backoff |
| `quota` | a usage window, credit balance or plan limit is spent: wait for the reset (or `quotaWait`) |
| `auth` | not logged in, or the credentials were refused |
| `model_unavailable` | the model is unknown to the CLI, retired, or not available to this account: not retried |
| `network` | the connection to the model's API was lost or never made: retried after a backoff (ODW extension) |
| `timeout` | killed at the timeout |
| `stalled` | killed by the stall watchdog |
| `not_found` | the CLI could not be started |
| `permission` | a tool call or approval the agent needed was refused |
| `exit` | any other non-zero exit |
| `empty_reply` | a clean exit with an empty reply (ODW extension; `allowEmpty: true` accepts one) |
| `unmet_expectation` | the agent's work missed its `expect` checks, retries included (ODW extension) |
| `mcp_unavailable` | an MCP server failed or needs authentication, under `mcpFailures: "fail"` (ODW extension) |
| `runaway` | the agent ran into one of its `limits` and was killed (ODW extension) |
| `orphaned_background` | the CLI exited with background work still running, under `orphanedBackground: "fail"` (ODW extension) |
| `out_of_scope` | the agent changed files outside its `scope`, under `scopePolicy: "fail"` (ODW extension) |
| `needs_input` | the agent asked a question nobody answered (ODW extension) |
| `destructive_git` | the agent ran a destructive git command, under `destructiveGit: "fail"` (ODW extension) |
| `model_substituted` | another model served the agent, under `modelMismatch: "fail"` (ODW extension) |

A run that failed because its disk filled up says `"failureReason": "disk_full"` in
`status.json` — see [A full disk, and a reused pid](../guides/running-and-observing.md#a-full-disk-and-a-reused-pid-odw-extension).
