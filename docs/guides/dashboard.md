# The dashboard

English · [简体中文](../zh-CN/guides/dashboard.md)

`odw serve` and what it shows, and how to reach it from elsewhere without opening it up.

## Dashboard: observe, inspect, chat

The dashboard reads like a printed sheet — paper, ink and one signal colour — and
switches to a night theme on demand. What it gives you:

- **Activity** — a ridgeline *pulse* of event density per run, live counters, the
  fleet of running agents per adapter, and a firehose of events across all runs.
- **Jobs** — runs in flight as live cards (phase rail, agent mix, elapsed time),
  plus a filterable, paged history (`#/jobs/live|done|failed` links straight to a filter).
- **A run** — the graph (fan-outs fan, reduces funnel; edges draw in and carry a
  marching signal while their agent runs; zoom, fit and pan), a **timeline** that
  shows where the time went, filterable **logs** with follow, the **result** as a
  collapsible JSON tree, and an **agent drawer** with each finished agent's own output
  — saved as it lands, so it is there mid-run; replayed agents are marked ↺.
  `exec()` command steps sit in the same graph and timeline as terminal-style nodes
  with their exit code; a run's counts include them (they are not agent dispatches).
  A run waiting at a `checkpoint()` shows the question and its payload above the
  graph, with **Approve** / **Reject** and a note when the dashboard can write.
  A **Changes** tab reviews what each isolated agent changed, file by file, with
  the `odw apply` command (and the kept branch) to copy.
- **Workspace** — every saved workflow with a static outline of its phases and the
  primitives each one calls, its source, and its recent runs.
- **Chat Host** — ordinary Codex conversation; mention ODW or workflow and the turn
  is attached to a real background run whose tool card updates live. A plain turn
  runs `codex exec --json` (read-only sandbox, `--ephemeral`) and reads it as the
  built-in `codex` adapter does: the reply is its `--output-last-message` file, else
  its last `agent_message`, and each message shows as it completes while the reply
  streams. The turn's tokens (from `turn.completed`; codex reports no dollars) are
  kept on the message as `usage`. A failure codex reports is classified like an
  agent's: a spent quota or a refused login says what to do — wait for the window to
  reset, or `codex login` — and the message carries `failureReason` (`quota`,
  `auth`, …) (ODW extensions).

<table>
  <tr>
    <td width="50%">
      <strong>Activity</strong><br />
      <img src="../../assets/app-screenshots/activity.png" alt="Activity view: a headline, live counters, a ridgeline pulse of event density per run, the fleet by adapter and the live event stream" />
    </td>
    <td width="50%">
      <strong>Timeline</strong><br />
      <img src="../../assets/app-screenshots/timeline.png" alt="A run's timeline: every agent as a bar from start to finish, grouped by phase, with a now marker while it runs" />
    </td>
  </tr>
  <tr>
    <td width="50%">
      <strong>Jobs</strong><br />
      <img src="../../assets/app-screenshots/jobs.png" alt="Jobs view: live run cards with phase rails and a day-grouped history table" />
    </td>
    <td width="50%">
      <strong>Night theme</strong><br />
      <img src="../../assets/app-screenshots/job-detail-dark.png" alt="A live run graph in the night theme, with glowing signal edges" />
    </td>
  </tr>
  <tr>
    <td width="50%">
      <strong>Needs you</strong><br />
      <img src="../../assets/app-screenshots/needs-you.png" alt="Activity view with a Needs you strip: a run waiting at a checkpoint with a Review button, and a failed run with a Copy resume button" />
    </td>
    <td width="50%">
      <strong>Checkpoints</strong><br />
      <img src="../../assets/app-screenshots/checkpoint.png" alt="A run waiting at a checkpoint: the question and its payload in an approval card with Approve and Reject, and an amber gate node in the graph's Approve lane" />
    </td>
  </tr>
  <tr>
    <td width="50%">
      <strong>Spend</strong><br />
      <img src="../../assets/app-screenshots/spend.png" alt="A run's spend receipt: tokens and dollars by phase with share bars, the split by adapter, and the agents that spent most" />
    </td>
    <td width="50%">
      <strong>Compare</strong><br />
      <img src="../../assets/app-screenshots/compare.png" alt="Two runs of a workflow compared: wall time, tokens, cost, done and failed with their deltas, what the runs ran with, and a row per agent" />
    </td>
  </tr>
</table>

Press <kbd>⌘K</kbd> / <kbd>Ctrl K</kbd> (or <kbd>/</kbd>) for the command palette —
jump to any run or workflow, switch theme or language, copy a follow or rerun command.
<kbd>g</kbd> then <kbd>a</kbd>/<kbd>j</kbd>/<kbd>w</kbd>/<kbd>c</kbd>/<kbd>s</kbd> moves
between views, <kbd>1</kbd>–<kbd>5</kbd> switch a run's tabs, <kbd>$</kbd> unfolds where it spent, and <kbd>+</kbd>/<kbd>-</kbd>/<kbd>0</kbd>
zoom the graph. When a run finishes the dashboard says so, and — if you opt in under
Settings — sends a desktop notification while the tab is in the background.

```bash
odw run adversarial-verify --args '{"question":"review src/rate-limiter.js"}'
odw logs --workflow adversarial-verify --follow
```

The dashboard can be viewed off-loopback, but local write operations such as
Chat messages and stopping ODW-owned runs stay guarded by the loopback server.
Claude Code's own runs stay strictly read-only. What it serves of ODW's agents —
transcripts, results, logs, chat sessions — had its likely secrets redacted before it
was written, and a run's `args` are redacted as they are served (see [Secrets in what ODW keeps](safety-and-trust.md#secrets-in-what-odw-keeps-odw-extension)).

## Remote access, read-only (ODW extension)

Watch an overnight run from your phone without handing anyone your machine:

```bash
odw serve --host 0.0.0.0 --token
# odw dashboard → http://192.168.1.20:4317/#token=Xq3…   ← open this one; it is printed once
```

With `--token` and no value, odw makes a random 256-bit token and prints the URL with it
once, as `#token=…` — a fragment, which no request carries, so the token stays out of
server and proxy logs; odw writes it nowhere else. `--token VALUE` (16–256 characters of
`A-Z a-z 0-9 . _ ~ -`) uses yours and never prints it — it does show in the process list,
so prefer the generated one on a shared machine.

The security model:

- **Every `/api` request and the live stream need the token**, one of three ways:
  `Authorization: Bearer <token>` (scripts, `curl`); `?token=<token>` on a request, whose
  answer sets an `HttpOnly`, `SameSite=Strict` cookie (`odw_token_<port>`); or that
  cookie. The dashboard trades the URL's `#token=` for the cookie on load and drops it
  from the address bar. Without a token: 401; the page itself loads and shows a
  "needs a token" screen to paste one into.
- **Tokens are compared in constant time** (both sides hashed first). An address that
  sends 10 wrong tokens within a minute is answered 429, whatever it sends, until the
  minute is up (an IPv6 address counts by its /64); a request with no token at all is
  not counted. Past 100 wrong tokens a minute from everyone together, no token is
  checked until the minute is up, so many addresses cannot keep guessing.
- **Writes stay refused off loopback, whatever the token**: stopping or pausing runs,
  answering checkpoints and Chat are 409 on any bind but 127.0.0.1 / localhost / ::1.
  The token gives remote *reads*, never writes. (On a loopback bind, `--token` gates
  writes like reads, and every existing write guard still applies: exact
  `Content-Type: application/json`, same-origin `Origin`, the DNS-rebinding Host check.
  There any valid token writes, whatever its scope: a `read` token can still stop,
  pause or resume runs and mark reviews, as on every other loopback route — the scope
  limits only what a token may do off loopback.)
- **It is plain HTTP.** The token and everything the dashboard shows cross the network
  unencrypted: use it on a network you trust, over a VPN or SSH tunnel
  (`ssh -L 4317:localhost:4317 host` needs no `--host` at all), or behind a TLS proxy.
- **What a token-holder reads** is what the dashboard shows: every project's runs — ODW's
  and, with the default `claudeJobsScope: "all"`, Claude Code's — their args, results,
  events, agents' transcripts and diffs (secrets redacted as above), and the settings
  page's paths and adapters. Narrow it with `--runs-root` and `"claudeJobsScope": "project"`,
  or share one run as a [bundle](running-and-observing.md#share-a-run-odw-extension) instead.
- **Without `--token`**, an off-loopback bind behaves as before — read-only and open to
  anyone who can reach the port — and `odw serve` prints a loud warning that suggests
  `--token`.
- **Two narrow exceptions answer checkpoints, and nothing else** — see
  [Approve from your phone](#approve-from-your-phone-odw-extension): signed one-time
  approve links (`--public-url`), and `--token-scope approve`.

## Named tokens: who did what (ODW extension)

When several people watch and approve on one box, give each a token of their own instead
of sharing one — what each does is then attributed to them, and one can be withdrawn
without the others:

```bash
odw token add alice --scope approve --file ~/.config/odw/tokens.json   # prints alice's token, once
odw token add bob --file ~/.config/odw/tokens.json                      # scope read (the default)
odw token list --file ~/.config/odw/tokens.json                         # names and scopes; remove <name> withdraws one
odw serve --host 0.0.0.0 --tokens ~/.config/odw/tokens.json
```

The file is a JSON array of `{ "name", "scope": "read" | "approve", "hash" }`, where
`hash` is the token's sha256 in hex — **it never holds a token**; `odw token add` prints
the new one once and keeps only its hash (the file is written 0600). A presented token is
hashed and looked up by that digest, so the comparison never runs over the token itself;
every rule of `--token` above (the three ways to send it, the 429s, writes off loopback)
holds for each. `--tokens` works alongside `--token` (an unnamed token, with
`--token-scope`); a named token of scope `approve` answers checkpoints off loopback, one
of scope `read` only reads. `odw serve` reads the file when it starts: restart it to take
a change. Names are 1–64 of `A-Z a-z 0-9 . _ @ + -`.

What is recorded, and where:

- **`launchedBy`** in a run's `meta.json`: the local user for a run you start (git
  `user.email`, else `$USER`), a named token's name for a run started from the dashboard
  (Chat), and `trigger:<name>` for a [webhook trigger](scheduling-and-triggers.md#start-runs-from-webhooks-github-linear-slack-odw-extension)'s.
  `odw list --by <name>` lists one person's runs (`--by me`: yours); the dashboard's run
  header says "launched by …", and its Jobs page gets **Mine / Team** chips — mine is the
  name `/api/capabilities` reports as `you` (your token's name; the local user when there
  is no token at all; none for the unnamed `--token`).
- **`who`** beside a checkpoint decision's `by` (the channel — `cli`, `dashboard`,
  `link` — stays as it was): `cli:<$USER> <git user.email>` from `odw approve|reject`, the
  token's name from the dashboard, and — beside `by: "link"` — the name of a named token
  the approve link's request also carries. It is in the decision log
  (`decisions.jsonl`), the `checkpoint_resolved` event and `checkpoint()`'s result
  (`result.who`).
- **Pause, resume and stop** record `who` in `control.json` (`odw pause|resume|stop`:
  `cli:<user>`; the dashboard: the token's name); the run logs "paused by …" / "resumed
  by …", and a stop puts `who` on `run_stopped` and `stoppedBy` in `status.json`.

These are labels, not access control: anyone who can write the runs root can write any
name into it. There is no RBAC beyond the two scopes.

## Approve from your phone (ODW extension)

A [`checkpoint()`](checkpoints-and-questions.md#human-checkpoints-odw-extension) no longer has to wait for you to get
back to the terminal. Run the dashboard with the URL your phone reaches it at — usually
an HTTPS tunnel — and turn on the `waiting` notify hook:

```bash
odw serve --public-url https://odw.example.com     # e.g. behind cloudflared or tailscale funnel
```

`--public-url` is a root URL (`https://host[:port]`): links are answered at `/approve/` on
it, so a URL with a path (a proxy serving odw under `/odw`) is refused — give odw a host
of its own, as a tunnel does.

```json
{ "notify": { "webhook": "https://hooks.example.com/YOUR/WEBHOOK/PATH", "on": ["waiting"] }, "approveLinks": { "ttl": 86400 } }
```

Each checkpoint that starts waiting then sends two links, approve and reject: in the
webhook's JSON as `approveUrl`, `rejectUrl` and `linksExpireAt` (and at the end of its
`text`), and to a notify command as `ODW_APPROVE_URL`, `ODW_REJECT_URL`,
`ODW_LINKS_EXPIRE_AT` and `ODW_NTFY_ACTIONS` — a ready-made ntfy `Actions` header with an
Approve and a Reject button ([recipe](../recipes/notify.md#approve-from-the-notification)).
Opening a link shows a small page — the run, the checkpoint's title, its payload and one
button; pressing it records the decision with `by: "link"`, and the run goes on.

`odw serve --token X --token-scope approve` does the same for a remote dashboard: a token
holder can approve or reject checkpoints (with a note or an edited payload, as on
loopback). The default scope is `read`.

The security model — the only remote writes are checkpoint decisions:

- **A link is a capability.** Anyone who has it can make that one decision on that one
  checkpoint, until it expires or is used — treat it like the webhook URL it travels
  through. It is an HMAC-SHA256 over the run, the checkpoint, the action and the expiry,
  under a per-runs-root secret (`<runsRoot>/.approve-secret`, mode 0600, made by the
  first `odw serve --public-url`; one others can read is replaced). Nothing in a link can
  be changed without breaking its signature; `odw serve --rotate-approve-secret` kills
  every link sent before.
- **One use.** A used link is recorded in the run directory (`approve-links/<nonce>`,
  created exclusively, so two presses cannot both count); the checkpoint's other link
  is spent with it. A replay, an expired link (default 24 hours: `approveLinks.ttl`,
  60 s to 30 days) or a checkpoint answered some other way gets a clear "410" page;
  a tampered link a "403" page — never a stack trace.
- **Opening a link decides nothing.** Chat-app link previews and mail scanners only
  `GET`. The decision is a `POST` carrying the page's CSRF value, which must match an
  `HttpOnly`, `SameSite=Strict` cookie the page set; an ntfy button instead names the
  action in an `X-ODW-Action` header, which no other site's page can send. A form from
  another origin is refused, and the page cannot be framed.
- **Guessing is rate limited** like wrong tokens: 10 bad links (or failed CSRF checks)
  a minute per address, 100 from everyone, then 429 for bad links. A link's signature is
  checked first, so a valid link is never held back: bad links sent through the same
  tunnel cannot block the real ones.
- **Links work only while `odw serve --public-url` runs.** Without one for the runs root,
  no links are minted, and the payload says why (`linksUnavailable`,
  `ODW_LINKS_UNAVAILABLE`). The `/approve/` route needs no dashboard token — the link
  is the credential — and opens nothing else: stop, pause, resume and Chat stay
  loopback-only, also under `--token-scope approve`.
- **Use HTTPS.** Over plain HTTP anyone on the path can read a link and use it first;
  `odw serve` warns when `--public-url` is `http://` to anything but localhost. A tunnel
  to a loopback bind works: the public URL's host may reach `/approve/` (only) past the
  DNS-rebinding check.
