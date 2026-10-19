# Scheduling and triggers

English · [简体中文](../zh-CN/guides/scheduling-and-triggers.md)

Runs nobody starts by hand: on a timer, as a digest of what happened, or from a webhook. Step-by-step recipes: [cron](../recipes/cron.md), [triggers](../recipes/triggers.md).

## Schedule runs (ODW extension)

Nightly digests, triage, audits: `odw schedule` runs a workflow on a cron
expression through your operating system's own scheduler. ODW runs no daemon —
`add` writes a cron line, a launchd agent or a systemd timer that calls odw back.

```bash
odw schedule add digest digest --cron "0 8 * * 1-5" --cwd ~/work/news --args '{"since":"yesterday"}'
odw schedule list              # backend, last run (id, state, when), next run in local time
odw schedule run digest        # run it now, exactly as the scheduler will
odw schedule remove digest     # delete the OS entry and the definition (safe if it is gone already)
```

- **Backends:** launchd on macOS (`~/Library/LaunchAgents/dev.odw.schedule.<name>.plist`),
  cron elsewhere (a `# odw:begin <name>` … `# odw:end <name>` block in your crontab;
  every other line stays as it is), or `--backend systemd` (a user `.service` + `.timer`
  with `Persistent=true`, so a start missed while the machine was off runs when it is back —
  cron skips it; launchd runs it once the Mac wakes from sleep). `--dry-run` prints exactly
  what would be written. Windows is not supported yet: `add` prints a `schtasks` line instead.
- **Each run** (`odw schedule run <name>`, what the entry calls) takes the schedule's lock — a
  start that finds the previous run still going is skipped, not stacked — runs the workflow
  like `odw run --wait`, appends one line to `~/.local/state/odw/schedules/<name>.log`, and
  exits non-zero unless the run finished `done`.
- **`add` fails fast** on a workflow, adapter or config that does not load, and records the
  absolute node/odw paths and your `PATH`, so the agent CLIs resolve under the scheduler as
  they do in your shell. Definitions live in `~/.config/odw/schedules.json`.
- **Failures** reach you through the usual [`notify`](notifications.md#run-notifications) hooks: a scheduled
  run is an ordinary run (`"on": ["failed", "stopped"]` for failures only).

The expression is cron's five fields (numbers, `*`, lists, ranges, steps, `jan`-`dec`,
`sun`-`sat`); `@daily`, `L`, `#` and the like are refused with the reason. The full guide,
and the raw cron line as the manual alternative: [`docs/recipes/cron.md`](../recipes/cron.md).

## Morning digest: `odw digest` (ODW extension)

After a night of schedules, triggers and long runs, `odw digest` is one report across
all of them — built only from what the runs recorded, never from what an agent said
about its own work (no reply, result or model-written summary is repeated):

```bash
odw digest                         # the last 24 hours
odw digest --since 12h             # 90m, 12h, 2d, 1w (at most 156w)
odw digest --since-last            # since the last digest that was sent (--notify)
odw digest --workflow nightly      # one workflow's runs
odw digest --json | --markdown     # for scripts, or to paste
odw digest --since-last --notify   # send it through the notify hooks ("digest" in notify.on)
```

Groups, each with the command that acts on it:

- **Needs you** — every checkpoint (and [agent question](checkpoints-and-questions.md#agent-questions-odw-extension))
  waiting now, whatever the window, with `odw approve|reject … --checkpoint N`; sent
  with `--notify` while an `odw serve --public-url` runs, each also carries its signed
  one-time approve/reject links.
- **Failed** — failed runs and runs whose worker died (stale): the recorded error, how
  many agents did not finish and why (`timeout 1, exit 2`), and `odw resume <run>`.
- **Done, but checks were not met** — done runs with agents that missed their
  [`expect`](../reference/workflow-api.md#check-an-agents-work-odw-extension) checks, wrote outside their
  [`scope`](../reference/workflow-api.md#declared-scopes-odw-extension), or failed under a run that went on.
- **Done, with changes to review** — done runs whose isolated agents kept a diff: files
  and lines, and `odw apply <run> --all --check` to preview it.
- **Spend** — dollars and tokens over the window, and the most expensive run.

A run is in the window when its last write is; dry runs are left out. `--notify` fires
the [`notify`](notifications.md#run-notifications) hooks once — a day's runs make one message, not
one per run — and moves the `--since-last` mark (`<runsRoot>/_digest/marks.json`, per
`--workflow`) only when every hook succeeded; looking without `--notify` never moves it.
To send it every weekday morning:

```jsonc
{
  "notify": { "webhook": "https://hooks.example.com/YOUR/PATH", "on": ["digest"] },
  "digest": { "cron": "0 8 * * 1-5" }
}
```

```bash
odw schedule add morning --digest     # each fire: odw digest --since-last --notify (cron: digest.cron, or --cron)
```

`add --digest` refuses a config whose hooks would not send it; `--workflow W` narrows
it. Recipe: [`docs/recipes/notify.md`](../recipes/notify.md#a-morning-digest).

## Start runs from webhooks: GitHub, Linear, Slack (ODW extension)

Start a run from where the work is tracked, and answer there. Name a trigger in
the config and `odw serve` answers `POST /api/triggers/<name>`: a webhook whose
signature checks out starts the trigger's workflow, its args taken from the
webhook's body, and gets `202 { "runId" }` back.

```jsonc
"triggers": {
  "gh-triage": {
    "workflow": "triage",                          // a managed name or an absolute path
    "verify": "github",                            // github | linear | slack | hmac-sha256
    "secretEnv": "GITHUB_WEBHOOK_SECRET",          // or "secret" (16+ characters)
    "args": { "issue": "$.issue.number", "body": "$.issue.body" },  // JSONPath: $.a.b, $['k'], $.a[0]
    "events": ["issues.labeled"],                  // optional filter
    "dedupe": "$.issue.number",                    // optional: one active run per issue
    "concurrency": 2,                              // optional cap on active runs
    "rateLimit": { "max": 30, "windowSec": 3600 }  // the default
    // "untrusted": true is the default; "source": the runs' working directory
    // "permissions": "edit" lets its agents edit; "approve": false skips the go the first one asks
  }
}
```

- **Signed, each as its provider documents:** GitHub `X-Hub-Signature-256`,
  Linear `Linear-Signature` (and `webhookTimestamp` within a minute), Slack
  `X-Slack-Signature` with `X-Slack-Request-Timestamp` within five minutes, or
  ODW's own `X-ODW-Signature` over `<timestamp>.<body>` for anything else. HMAC-SHA256
  over the raw body, compared in constant time; a delivery seen before (a replay,
  a retry) starts nothing. GitHub signs no timestamp: its deliveries' signatures
  and `X-GitHub-Delivery` ids are kept under the runs root for 30 days, across
  restarts (older ones verify again — rotate a secret that may have leaked).
- **Your config only:** `odw serve` takes triggers from a config of your own —
  `--config`, `$ODW_CONFIG`, or `~/.config/odw/config.json` outside the
  repository. A repository's `./odw.config.json` cannot name one: its
  `triggers` are refused with a warning (a clone must not open a webhook into
  your machine), and your own config's are served instead.
- **Untrusted by default:** issue text is anyone's input, so the runs are
  `--untrusted` and take [untrusted input](safety-and-trust.md#untrusted-input-odw-extension) — read-only
  agents, no tokens, a checkpoint before any may write — unless the trigger says
  `"untrusted": false`.
- **Narrow:** only the triggers of your config exist, each starts only its own
  workflow. An unknown name, a secret not set yet and a bad, missing or stale
  signature get the same `401` (rate limited per address; `odw serve` logs the
  reason), so a caller without the secret learns nothing of which triggers
  exist; `413` past 1 MiB, `429` past `concurrency` or `rateLimit`. The route
  answers off loopback (`--host`) — the signature is its credential, no
  `--token` — and on a loopback bind only through loopback `Host`s and the
  `--public-url`'s (give a tunnel's URL there); the DNS-rebinding guard holds as
  for the rest of the dashboard.
- **Answer back:** the run records a `context` — the trigger, the event, the
  issue's id and URL, the repository, a Slack channel and thread — that
  [`notify`](notifications.md#run-notifications) hooks receive, so a hook can comment on the issue,
  reply in the thread, or open a draft PR with `odw apply --pr` and link it.

Setup per provider and those three hooks:
[`docs/recipes/triggers.md`](../recipes/triggers.md).
