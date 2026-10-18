# Start runs from GitHub, Linear or Slack, and answer there

**ODW extension.** A trigger is a named entry in your config that `odw serve`
answers at `POST /api/triggers/<name>`. A webhook whose signature checks out
against the trigger's secret starts the trigger's workflow, with args taken from
the webhook's body, and gets `202 { "runId": … }` back. The run carries a
`context` (where it came from) to your [`notify`](notify.md) hooks, so a hook
can comment on the issue or reply in the thread.

Every value below that looks like a secret, a token or a hook URL is a
placeholder. Put your real ones in environment variables, never in a committed
file.

## The trigger

```jsonc
{
  "triggers": {
    "linear-fix": {
      "workflow": "fix-issue",                       // a managed name (~/.odw/workflows) or an absolute path
      "verify": "linear",                            // github | linear | slack | hmac-sha256
      "secretEnv": "LINEAR_WEBHOOK_SECRET",          // or "secret": "…" (16+ characters), not in a committed file
      "args": {                                      // run arg → JSONPath into the webhook body
        "issue": "$.data.identifier",
        "title": "$.data.title",
        "body": "$.data.description"
      },
      "events": ["Issue.create"],                    // optional: which deliveries start a run
      "dedupe": "$.data.id",                         // optional: one active run per issue
      "concurrency": 2,                              // optional: active runs at once (429 past it)
      "rateLimit": { "max": 30, "windowSec": 3600 }, // the default
      "untrusted": true,                             // the default: issue text is untrusted input
      "source": "~/src/app"                          // optional: the runs' working directory (default: where odw serve runs)
    }
  }
}
```

- **Signatures.** Each provider's is checked the way its documentation says,
  in constant time, over the raw body:
  - `github`: `X-Hub-Signature-256: sha256=<HMAC-SHA256 of the body>`
    ([GitHub docs](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)).
    GitHub signs no timestamp, so each accepted delivery's signature and
    `X-GitHub-Delivery` id are kept under the runs root
    (`_triggers/seen.jsonl`) for 30 days, across `odw serve` restarts: a
    replay inside them starts nothing. What that leaves: a captured delivery
    older than 30 days, or one replayed against another runs root (or after
    `_triggers/` was deleted), verifies again. Rotate the secret if one may
    have leaked, and keep `dedupe`, a `rateLimit` and `untrusted` on.
  - `linear`: `Linear-Signature: <HMAC-SHA256 of the body, hex>`, and the body's
    `webhookTimestamp` within a minute of now
    ([Linear docs](https://linear.app/developers/webhooks#securing-webhooks)).
  - `slack`: `X-Slack-Signature: v0=<HMAC-SHA256 of "v0:<timestamp>:<body>">` with
    `X-Slack-Request-Timestamp` within five minutes
    ([Slack docs](https://api.slack.com/authentication/verifying-requests-from-slack)).
  - `hmac-sha256`: ODW's own, for anything else — `X-ODW-Signature:
    sha256=<HMAC-SHA256 of "<timestamp>.<body>">` with `X-ODW-Timestamp: <Unix
    seconds>` within five minutes, and optionally `X-ODW-Event` (what `events`
    matches) and `X-ODW-Delivery`.
- **Answers.** `202 { ok, trigger, runId }` when a run started. One `401` for
  a name the config lacks, a secret not set yet, a missing or bad signature and
  a stale timestamp alike — a caller without the secret cannot learn which
  triggers exist; `odw serve` logs the real reason on its stderr (`429` once an
  address sent too many; a good signature is never held back). `413` past
  1 MiB, for any name; `404` only when no trigger is served at all. `200` with `duplicate`,
  `ignored` (an event `events` does not list) or `deduped` (`runId` of the run
  still going for the same `dedupe` value) starts nothing; `429` with
  `retry-after` when `concurrency` runs are active or `rateLimit` is spent.
  Slack's `url_verification` and GitHub's `ping` are answered.
- **Untrusted by default.** Anyone who can open an issue writes the text your
  agents read, so a trigger's runs are `--untrusted`: each agent CLI ignores the
  repository's own instructions, hooks and settings where it can (see
  *Untrusted repositories* in the README), and a workflow name never resolves to
  the repository's `.odw/workflows`. Name a managed workflow or give an absolute
  path. For anything public, also give `odw serve` a config (`--config`) with
  `"permissions": "read"` or a [container
  sandbox](../../README.md#run-agents-in-containers-odw-extension): triggered runs
  use the config `odw serve` was started with.
- **Your config, never the repository's.** `odw serve` takes triggers only
  from a config of your own: `--config`, `$ODW_CONFIG`, or
  `~/.config/odw/config.json` outside the repository it runs in. A
  repository's `./odw.config.json` is code the repository ships — a clone
  must not open a webhook that starts (trusted) runs on your machine — so
  its `triggers` are refused with a warning at start, and those of your
  `~/.config/odw/config.json` are served instead (their runs read that
  config). `"untrusted": false` therefore only ever comes from your own config.
- **Reaching it.** The route answers off loopback too (with `--host`); the
  signature is its credential, so it needs no `--token`. On a loopback bind
  the DNS-rebinding guard holds for it as for the dashboard: only loopback
  `Host`s and the `--public-url`'s host pass — so a tunnel to a loopback bind
  needs `--public-url <the tunnel's URL>`. The rest of the dashboard keeps its
  rules. `odw serve` prints each trigger's URL at start (under `--public-url`,
  when you give one), and warns about a secret it cannot read.

```bash
export LINEAR_WEBHOOK_SECRET='paste-the-signing-secret-here'
odw serve --public-url https://odw.example.com     # behind your tunnel or reverse proxy
#   trigger linear-fix → POST https://odw.example.com/api/triggers/linear-fix (linear-signed; runs fix-issue, untrusted)
```

### GitHub

Repository → Settings → Webhooks → Add webhook: payload URL
`https://odw.example.com/api/triggers/gh-triage`, content type
`application/json`, a secret, and the events you want.

```json
{
  "triggers": {
    "gh-triage": {
      "workflow": "triage",
      "verify": "github",
      "secretEnv": "GITHUB_WEBHOOK_SECRET",
      "events": ["issues.labeled"],
      "args": { "issue": "$.issue.number", "repo": "$.repository.full_name", "title": "$.issue.title", "body": "$.issue.body" },
      "dedupe": "$.issue.number"
    }
  }
}
```

`events` matches the `X-GitHub-Event` header (`issues`) or it with the body's
`action` (`issues.labeled`).

### Slack

Create a Slack app; under Event Subscriptions set the request URL to
`https://odw.example.com/api/triggers/slack-ask` and subscribe to
`app_mention`; copy the app's signing secret.

```json
{
  "triggers": {
    "slack-ask": {
      "workflow": "answer-question",
      "verify": "slack",
      "secretEnv": "SLACK_SIGNING_SECRET",
      "events": ["app_mention"],
      "args": { "question": "$.event.text" }
    }
  }
}
```

A slash command (form-encoded) works too: `events: ["/odw"]`, `args: {
"question": "$.text" }`.

### Anything else (curl)

```bash
body='{"id":"build-812","url":"https://ci.example.com/builds/812"}'
ts=$(date +%s)
sig=$(printf '%s.%s' "$ts" "$body" | openssl dgst -sha256 -hmac "$ODW_TRIGGER_SECRET" | sed 's/^.* //')
curl -sS https://odw.example.com/api/triggers/ci-flaky \
  -H 'content-type: application/json' -H "x-odw-timestamp: $ts" -H "x-odw-signature: sha256=$sig" \
  --data "$body"
```

## The context, and answering where the work came from

A triggered run's `meta.json` keeps `context`, and every notify hook gets it:

| field | GitHub | Linear | Slack |
| --- | --- | --- | --- |
| `trigger`, `provider` | always | always | always |
| `event` | `issues.labeled` | `Issue.create` | `app_mention`, `/odw` |
| `deliveryId` | `X-GitHub-Delivery` | `Linear-Delivery` | `event_id` |
| `id` | issue or PR number | the issue's id (a comment's issue) | the message `ts` |
| `url` | the issue, PR or comment | the issue | — |
| `repo` | `owner/name` | — | — |
| `channel`, `threadTs` | — | — | where to reply |
| `dedupe` | the `dedupe` value, when set | | |

The webhook payload carries it as `context`; a command gets `ODW_TRIGGER`,
`ODW_EVENT_ID`, `ODW_EVENT_URL` and `ODW_CONTEXT` (all of it, as JSON). Runs no
trigger started have none of them, so one notify command can serve every
trigger and leave other runs alone. A notify command runs without a shell and is
killed after 30 seconds, so the recipes below are small Node scripts (Node 20+,
no packages).

### Comment on the Linear issue

```json
{ "notify": { "command": ["node", "/home/you/.odw/hooks/linear-comment.mjs"], "on": ["done", "failed", "stopped"] } }
```

```js
// /home/you/.odw/hooks/linear-comment.mjs — needs LINEAR_API_KEY in odw serve's environment
const ctx = JSON.parse(process.env.ODW_CONTEXT ?? "null");
if (!ctx || ctx.provider !== "linear" || !ctx.id) process.exit(0); // not a Linear-triggered run
const state = process.env.ODW_RUN_STATE;
const body = `odw run \`${process.env.ODW_RUN_ID}\` (${process.env.ODW_WORKFLOW}) ${state}: ` +
  `${process.env.ODW_AGENTS} agents, ${process.env.ODW_FAILED_AGENTS} failed.`;
const res = await fetch("https://api.linear.app/graphql", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: process.env.LINEAR_API_KEY },
  body: JSON.stringify({
    query: "mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }",
    variables: { input: { issueId: ctx.id, body } },
  }),
});
if (!res.ok) throw new Error(`Linear answered ${res.status}`);
```

### Reply in the Slack thread

```js
// /home/you/.odw/hooks/slack-reply.mjs — needs SLACK_BOT_TOKEN (a bot with chat:write)
const ctx = JSON.parse(process.env.ODW_CONTEXT ?? "null");
if (!ctx || ctx.provider !== "slack" || !ctx.channel) process.exit(0);
const res = await fetch("https://slack.com/api/chat.postMessage", {
  method: "POST",
  headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
  body: JSON.stringify({
    channel: ctx.channel,
    ...(ctx.threadTs ? { thread_ts: ctx.threadTs } : {}),
    text: `odw run ${process.env.ODW_RUN_ID} ${process.env.ODW_RUN_STATE} (${process.env.ODW_AGENTS} agents)`,
  }),
});
const said = await res.json();
if (!said.ok) throw new Error(`Slack said ${said.error}`);
```

Add `"waiting"` to `notify.on` and, with `odw serve --public-url`, the same
hook can post a checkpoint's approve and reject links (`ODW_APPROVE_URL`,
`ODW_REJECT_URL`) into the thread.

### Open a draft PR and link it on the GitHub issue

`odw apply --pr` pushes a branch and opens a draft PR with `gh`; it takes longer
than a notify command may, so the hook starts it in the background:

```js
// /home/you/.odw/hooks/open-pr.mjs
import { spawn } from "node:child_process";
const ctx = JSON.parse(process.env.ODW_CONTEXT ?? "null");
if (!ctx || ctx.provider !== "github" || process.env.ODW_RUN_STATE !== "done") process.exit(0);
spawn("sh", ["/home/you/.odw/hooks/open-pr.sh", process.env.ODW_RUN_ID, ctx.id, ctx.repo], {
  detached: true, stdio: "ignore", cwd: process.cwd(), // the run's source checkout
}).unref();
```

```sh
#!/bin/sh
# /home/you/.odw/hooks/open-pr.sh <run_id> <issue_number> <owner/repo> — gh must be logged in
set -eu
out=$(odw apply "$1" --all --pr --title "odw: fix #$2" 2>&1) || { gh issue comment "$2" --repo "$3" --body "odw run $1 finished, but its changes did not apply: see odw apply $1 --check"; exit 1; }
url=$(printf '%s\n' "$out" | sed -n 's/.*PR: \(https:[^ ]*\).*/\1/p' | tail -n 1)
gh issue comment "$2" --repo "$3" --body "odw opened a draft PR for this issue: ${url:-see odw apply $1}"
```

It never merges: the PR stays a draft for a person to review. A `notify` takes
one command, so to answer on several providers, point it at one script that
dispatches on `ctx.provider`.
