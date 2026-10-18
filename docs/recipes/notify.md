# Getting told when a run finishes

A long run should come to you, not the other way round. ODW has three ways,
from zero setup to fully scripted.

## In the browser

Keep `odw serve` open: every run that finishes, fails or stops raises a toast.
Turn on **Settings → Run notifications** and the dashboard also sends a system
notification while its tab is in the background (the browser asks for
permission once).

## From the config: a webhook or a command

Add a `notify` block to your config. ODW reads the first config it finds —
`--config`, then `$ODW_CONFIG`, then `./odw.config.json`, then
`~/.config/odw/config.json` — and does not merge them, so put the block in the
file your runs actually use (`odw doctor` names it). Hooks fire once per run,
after its final state is on disk; they can neither delay nor change it, and a
failing hook is only logged to the run's `worker.log`. `on` picks the states
that fire (`done`, `failed`, `stopped`; all three by default — plus the opt-in
`waiting` and `paused`, below).

### Slack or Discord

Create an *incoming webhook* in Slack (Apps → Incoming Webhooks) or Discord
(Channel → Integrations → Webhooks), then:

```json
{
  "notify": {
    "webhook": "https://hooks.example.com/YOUR/WEBHOOK/PATH",
    "on": ["failed", "stopped"]
  }
}
```

Paste the URL Slack or Discord gave you in place of the placeholder; this
example only reports the bad news.

The POSTed JSON carries `text` and `content` with the same one-line summary —
`odw · deep-research finished in 4m12s · 12 agents, 1 failed` — so both Slack and
Discord render it as is, plus the structured fields (`runId`, `workflow`,
`state`, `durationSec`, `counts`, and `error` for failed or stopped runs) for
anything else. Treat the webhook URL as a secret — its path is the token. Keep
it out of a committed `odw.config.json` (point `$ODW_CONFIG` at a private file,
or git-ignore the project config); ODW itself only ever shows or logs its scheme
and host.

### ntfy, a desktop notifier, or anything else: a command

The command runs **without a shell** (an argv, killed after 30s) in the run's
source directory, with the run in its environment:

| Variable | Meaning |
| --- | --- |
| `ODW_RUN_ID` | the run id |
| `ODW_RUN_STATE` | `done`, `failed` or `stopped` |
| `ODW_WORKFLOW` | the workflow's name |
| `ODW_RUN_DIR` | the run directory (`events.jsonl`, `agents/`, …) |
| `ODW_RESULT_FILE` | `result.json`, only when the run produced one |
| `ODW_DURATION_SEC` | wall-clock seconds |
| `ODW_AGENTS` / `ODW_FAILED_AGENTS` | agent counts |

A push to your phone through [ntfy](https://ntfy.sh) (or your own ntfy server):

```json
{
  "notify": {
    "command": ["sh", "-c", "curl -s -d \"$ODW_WORKFLOW $ODW_RUN_STATE\" https://ntfy.sh/your-topic"]
  }
}
```

A desktop banner — macOS (AppleScript reads the environment itself), then Linux:

```json
{ "notify": { "command": ["osascript", "-e", "display notification ((system attribute \"ODW_WORKFLOW\") & \" \" & (system attribute \"ODW_RUN_STATE\")) with title \"odw\""] } }
```

```json
{ "notify": { "command": ["sh", "-c", "notify-send odw \"$ODW_WORKFLOW $ODW_RUN_STATE\""] } }
```

`sh -c` is there only because those one-liners expand variables; a plain
argv such as `["/usr/local/bin/odw-notify"]` needs no shell, and a script of
your own is the easiest place for anything longer.

## When a run needs a decision

A workflow that calls [`checkpoint()`](../../README.md#human-checkpoints-odw-extension)
waits for a person. Add `"waiting"` to `on` and the same hooks fire once per
checkpoint as it starts waiting — the command with `ODW_RUN_STATE=waiting`,
`ODW_CHECKPOINT_ID` and `ODW_CHECKPOINT_TITLE`, the webhook with
`"state": "waiting"` and a `text` line naming the command that answers it:

```json
{
  "notify": {
    "webhook": "https://hooks.example.com/YOUR/WEBHOOK/PATH",
    "on": ["waiting", "failed"]
  }
}
```

Answer from any shell with `odw approve <run> --note "…"` (or `odw reject`), or
with Approve/Reject in the dashboard, which also raises a toast — and, with Run
notifications on, a system notification — the moment a run starts waiting. To
approve a changed payload instead (the plan minus a step, say), use
`odw approve <run> --edit`, which opens it in `$EDITOR`, or
`odw approve <run> --payload @plan.json`; the run's log and `odw logs` then say
"approved with edits". The hooks fire when a checkpoint starts waiting, not when
it is answered.

### Approve from the notification

**ODW extension.** Run the dashboard where your phone can reach it — an HTTPS tunnel to
`odw serve` is easiest — and name that URL:

```bash
odw serve --public-url https://odw.example.com
```

From then on each `waiting` hook carries the checkpoint's two signed, one-time links
(valid 24 hours; `"approveLinks": { "ttl": <seconds> }` changes it). A Slack or Discord
webhook shows them at the end of its `text`; any JSON receiver gets `approveUrl`,
`rejectUrl` and `linksExpireAt`. Opening a link shows the checkpoint and one button;
pressing it decides, once. Without a running `odw serve --public-url` for the runs root
there are no links, and the payload's `linksUnavailable` says so. The security model is
in the [README](../../README.md#approve-from-your-phone-odw-extension).

[ntfy](https://ntfy.sh) can put **Approve** and **Reject** buttons on the push itself. The
command hook gets a ready-made `Actions` header in `ODW_NTFY_ACTIONS` — two `http` actions
that POST to the links, name their action in an `X-ODW-Action` header and clear the
notification once they succeed:

```json
{
  "notify": {
    "command": ["sh", "-c", "curl -s -H \"Title: $ODW_WORKFLOW waits\" -H \"Actions: $ODW_NTFY_ACTIONS\" -d \"$ODW_CHECKPOINT_TITLE\" https://ntfy.sh/your-topic"],
    "on": ["waiting"]
  }
}
```

`ODW_NTFY_ACTIONS` looks like this (ntfy's simple header format: one action per `;`,
fields separated by `,`, `headers.<name>=<value>` for a request header, `clear=true` to
dismiss the notification after the request succeeds — see
[ntfy: action buttons](https://docs.ntfy.sh/publish/#action-buttons) and its
[`http` action](https://docs.ntfy.sh/publish/#send-http-request)):

```
http, Approve, https://odw.example.com/approve/…, method=POST, headers.X-ODW-Action=approve, clear=true; http, Reject, https://odw.example.com/approve/…, method=POST, headers.X-ODW-Action=reject, clear=true
```

When the links are unavailable the variable is unset, and `ODW_LINKS_UNAVAILABLE` says
why; the push above then arrives without buttons. Anyone subscribed to the topic can
press them — use a topic name nobody can guess, or your own ntfy server with access
control. `ODW_APPROVE_URL` and `ODW_REJECT_URL` hold the bare links for any other
notifier.

## When a run pauses for a spent quota

With [`quotaWait`](../../README.md#pause-for-a-spent-quota-odw-extension) on, a run
whose CLIs are out of quota waits for the reset instead of failing. Add `"paused"`
to `on` to hear about each pause — once, not when the run goes on, which it does by
itself: the command with `ODW_RUN_STATE=paused`, `ODW_PAUSED_ADAPTER` and
`ODW_RESUME_AT` (Unix seconds), the webhook with `"state": "paused"`,
`"pausedFor": { "reason": "quota", "adapter", "resumeAt" }` and a `text` line such
as `odw · nightly paused until 19:10 (codex quota) · odw resume <run> goes on now`:

```json
{
  "quotaWait": { "max": 21600 },
  "notify": {
    "webhook": "https://hooks.example.com/YOUR/WEBHOOK/PATH",
    "on": ["paused", "done", "failed"]
  }
}
```

Top up the account (or switch plans) and run `odw resume <run>` to go on before the
reset.

## From a script or cron: the exit code

`odw run <name> --wait` blocks until the run ends and exits non-zero when it
failed or was stopped, so any scheduler or CI job can react — see
[cron.md](cron.md).
