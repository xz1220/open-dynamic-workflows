# Notifications

English · [简体中文](../zh-CN/guides/notifications.md)

Hear about a run without watching it. Recipe: [notify](../recipes/notify.md).

## Run notifications

**ODW extension.** `notify` runs a command and/or POSTs to a webhook when a run
ends, so an overnight run can tell you how it went:

```jsonc
"notify": {
  "command": ["/usr/local/bin/odw-notify"],        // an argv, run WITHOUT a shell
  "webhook": "https://hooks.slack.com/services/…", // Slack, Discord, or any JSON endpoint
  "on": ["done", "failed", "stopped"]              // the default: every final state; "waiting", "paused" and "digest" are opt-in
}
```

The hooks fire once, after the run's final state is written, so they can neither
delay nor change it; a hook that fails or hangs is only logged to the run's
`worker.log`. The command (killed after 30s) runs in the run's source directory
with `ODW_RUN_ID`, `ODW_RUN_STATE`, `ODW_WORKFLOW`, `ODW_RUN_DIR`,
`ODW_RESULT_FILE` (only when the run has a result), `ODW_DURATION_SEC`,
`ODW_AGENTS` and `ODW_FAILED_AGENTS` in its environment. The webhook (10s limit)
receives:

```jsonc
{
  "runId": "20261017-041600-3fa2c1",
  "workflow": "deep-research",
  "state": "done", // done | failed | stopped
  "createdAt": 1792210560.2, // Unix seconds
  "finishedAt": 1792210812.5,
  "durationSec": 252,
  "counts": { "agents": 12, "done": 11, "failed": 1 },
  "text": "odw · deep-research finished in 4m12s · 12 agents, 1 failed",
  "content": "odw · deep-research finished in 4m12s · 12 agents, 1 failed"
}
```

Failed and stopped runs add an `error` field. `text` and `content` carry the
same line, so Slack and Discord incoming webhooks render it as is (Discord's
`allowed_mentions` is set too, so a run never pings anyone). The dashboard's
settings show which hooks are configured — the webhook as scheme and host only,
since the rest of its URL is the secret.

Add `"waiting"` to `on` to hear about every
[`checkpoint()`](checkpoints-and-questions.md#human-checkpoints-odw-extension) that starts waiting for a person.
The hooks then fire once per checkpoint, while the run waits on: the command with
`ODW_RUN_STATE=waiting`, `ODW_CHECKPOINT_ID` and `ODW_CHECKPOINT_TITLE` (and no
`ODW_RESULT_FILE`), the webhook with `"state": "waiting"`, a
`"checkpoint": { "checkpointId", "title", "since" }` field in place of `finishedAt`,
and a `text` line naming the command that answers it. While an `odw serve --public-url`
runs, they also carry the checkpoint's signed one-time approve and reject links — see
[Approve from your phone](dashboard.md#approve-from-your-phone-odw-extension). An
[agent's question](checkpoints-and-questions.md#agent-questions-odw-extension) fires the same hooks: the payload's
`checkpoint.kind` is `"question"` (else `"checkpoint"`), `checkpoint.question` names the
agent that asked (`{ agentId, label, adapter }`), the command gets `ODW_CHECKPOINT_KIND`
and `ODW_QUESTION_AGENT`, and the `text` line says to answer with `odw approve … --note`.

Add `"paused"` to hear when a run [pauses for a spent quota](cost-limits-and-quotas.md#pause-for-a-spent-quota-odw-extension)
— once per pause, not when it goes on: the command with `ODW_RUN_STATE=paused`,
`ODW_PAUSED_ADAPTER` and `ODW_RESUME_AT` (Unix seconds), the webhook with
`"state": "paused"`, a `"pausedFor": { "reason": "quota", "adapter", "resumeAt" }` field,
and a `text` line such as `odw · nightly paused until 19:10 (codex quota) · odw resume <run> goes on now`.

A run a [signed trigger](scheduling-and-triggers.md#start-runs-from-webhooks-github-linear-slack-odw-extension)
started (ODW extension) also carries its `context` — `{ trigger, provider, event,
deliveryId, id, url, repo, channel, threadTs }`, as far as the webhook had them — in
every payload, and to the command as `ODW_TRIGGER`, `ODW_EVENT_ID`, `ODW_EVENT_URL` and
`ODW_CONTEXT` (all of it, as JSON), so a hook can answer on the issue or in the
thread the work came from: [`docs/recipes/triggers.md`](../recipes/triggers.md).

Add `"digest"` (ODW extension) to have `odw digest --notify` — by hand or from
`odw schedule add <name> --digest` — send the [cross-run digest](scheduling-and-triggers.md#morning-digest-odw-digest-odw-extension)
once: the command with `ODW_RUN_STATE=digest`, `ODW_DIGEST_TEXT` (the one-line summary),
`ODW_DIGEST_FILE` and `ODW_DIGEST_MARKDOWN_FILE` (deleted once it exits), `ODW_DIGEST_SINCE`,
`ODW_DIGEST_NEEDS_YOU` and `ODW_DIGEST_FAILED`; the webhook with `"kind": "digest"`, the
digest's fields (`needsYou`, `failed`, `unmet`, `changes`, `spend`, `counts`, `since`, `until`),
`markdown`, and `text`/`content` carrying the markdown (`content` cut to Discord's 2000 characters).

Ready-made setups for Slack, Discord, ntfy and desktop banners:
[`docs/recipes/notify.md`](../recipes/notify.md).
