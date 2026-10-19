# Cost, limits and quotas

English · [简体中文](../zh-CN/guides/cost-limits-and-quotas.md)

What a run spends, how to know before it starts, and what odw does when an agent or a CLI misbehaves or runs out.

## Usage and cost (ODW extension)

A fan-out spends quota fast, so a run shows what it spends as it goes. Every
`agent_finished` (and `agent_failed`) event carries the agent's `usage`:
`inputTokens` (cached input included), `outputTokens`, `cacheReadTokens`,
`cacheWriteTokens` and `costUsd`, summed over all its CLI runs, as the CLI reported
them — the built-in `claude` adapter reports them all; the built-in `codex` reports
tokens only (its `turn.completed` events carry no dollars, and ODW invents no prices),
so its agents show tokens and no cost. Where a CLI reports no output tokens (the
text-mode adapters), ODW counts `ceil(chars / 4)` of the reply and marks the figure
`estimated`.

```text
$ odw status $RUN
20261017-101500-ab12cd  [done]  review-swarm
  dispatched: 9 agent(s)
  usage: 1.4M tokens in (1.2M cache read, 96k cache write) · ~50k out · $2.867 (estimated in part: 1 of 9 agents reported no output tokens)
  spend by phase (share of tokens):
    01  Scan    6 agents  1.1M  $2.100  78%  ███████████████▋
    02  Verify  2 agents  296k  $0.767  21%  ████▎
    03  Report  1 agent   10k~       —  <1%  ▏
    not every agent reported dollars, so shares are of tokens
    ~ partly estimated: a CLI that reports no count is measured as characters / 4
```

- `odw status` breaks the spend down by phase — the dashboard's spend receipt in
  text: a line per phase in the order the workflow declared them (one not started
  yet says so), then the agents outside every phase, each with its agents, tokens,
  cost and share, and a bar of Unicode blocks (`#` without a UTF-8 locale). The
  shares are of dollars when every agent that spent reported some, else of tokens.
  It fits 100 columns and is plain text under `NO_COLOR` or in a pipe.
- `odw list` adds a cost column when any listed run reported dollars (`—` for one
  that did not).
- The live view's summary line shows output tokens (what `--budget` counts) and the
  running cost; each settled agent's line shows its own cost.
- `GET /api/runs` and `GET /api/runs/:id` carry the run's total as `usage`
  (`estimated: true` when some agent's output tokens are an estimate), and
  `/api/runs/:id` each agent's own.
- `budget.spent()` counts output tokens the same way: the CLI's count where it gave one.
- One `parallel()` or `pipeline()` call that fans out more than `fanOutWarn` tasks or
  items (default 25; `0` or `null` turns it off) logs one warning with the count —
  `large fan-out: parallel() starts 40 tasks (over fanOutWarn: 25) — …` — and goes on.

Adapters declare where their CLI reports usage in their `output`; see
[Configure adapters](adapters-and-models.md#configure-adapters).

## Know the cost before you run (ODW extension)

A run says what it spent as it goes; `odw estimate` says what it is likely to spend
before it starts — from what earlier runs of the same workflow spent, never a guess:

```text
$ odw estimate review-swarm --args '{"dir":"src"}'
estimate for review-swarm (5 runs, matched by source)
                  agents  time p50 / p90  cost p50 / p90   out tokens p50 / p90
  total           9–11    6:20 / 7:00     $2.620 / $3.400  43k / 54k
  phase Plan      1       50.0s / 1:00    $0.140 / $0.160  2.1k / 2.1k
  phase Review    7–9     3:13 / 3:47     $2.380 / $3.150  38k / 49k
  phase Report    1       36.0s / 42.0s   $0.090 / $0.090  3.0k / 3.0k
  adapter claude  9–11    5:36 / 5:42     $2.620 / $3.400  43k / 54k
  · based on the last 5 finished runs of this exact source
  · it assumes similar args: fan-outs as wide as in those runs (agents per phase)
  · none of those runs had these args
```

- It reads the last 20 finished (`done`) runs of the workflow — resumed runs left
  out, their replayed agents cost nothing — of the exact same source (`meta.sourceHash`)
  when there are any, else of the same workflow name, and says which. Without any it
  prints `no estimate: no finished runs of this workflow yet`.
- For the run, each phase and each adapter: the median and 90th percentile of the
  wall time, the cost, the tokens and the agents started. Fan-outs are as wide as they
  were in those runs; with `--args` it says how many of them had the same args.
- `odw estimate <wf> --json` prints it for scripts, and `GET /api/estimate?workflow=<name>`
  serves it (`&sourceHash=<sha256>`; without one, the newest run's source is matched).
- `odw run <wf> --estimate` prints the estimate, then asks `start the run? [y/N]` on
  a terminal; `--yes` starts it without asking. With no terminal and no `--yes` it does
  not start.

**In the run.** Before a `parallel()` or `pipeline()` at least `fanOutWarn` wide, or
one a cost gate covers, the run logs a forecast: its width × the median cost of the
agents of that phase in earlier runs (of the agents with the same label prefix, for an
`agent()`), with the p90 — `cost forecast: parallel() of 40 tasks in phase "Review"
~$12.40 (p90 $18.00) — …`. A `pipeline()` counts an agent per item per stage.

**`costGate`.** With `"costGate": { "usd": 5 }` in the config — or
`parallel(thunks, { costGate: { usd: 5 } })`, or `agent(prompt, { costGate: { usd: 1 } })`
for one agent — a fan-out forecast over the gate becomes a checkpoint first:

```js
try {
  await parallel(files.map((f) => () => agent(`Review ${f}`, { label: `review-${f}` })))
} catch (e) {
  if (e.name !== 'CostGateRejected') throw e
  log('review skipped: ' + e.message)   // the person said no; the run goes on
}
```

The checkpoint — `This fan-out is forecast to cost ~$12.40 (p90 $18.00) — go?`, its
payload `{ width, forecast }` — is answered like any other: `odw approve|reject`, the
dashboard, or the [phone approve links](dashboard.md#approve-from-your-phone-odw-extension). A
rejection throws a `CostGateRejected` the script may catch. `costGate: null` on a
`parallel()` lifts the setting for that call. Without history the gate lets fan-outs
through and logs that once per run. `costGate` is recorded in the run's setup for
`odw compare`.

## Stall watchdog

**ODW extension.** A hung agent CLI otherwise holds its slot until `timeout`
(30 minutes by default). Set `stallTimeout` and ODW kills an agent whose stdout
*and* stderr have both been silent that many seconds — its whole process group,
exactly like a timeout — then starts it again with the same prompt, up to
`stallRestarts` times per `agent()` call (default 1). Each restart is logged
(`search:3 went quiet for 120s — restarting (1/1)`); past the cap the call fails
with an error saying the agent stalled. A stop, pause or budget ceiling always
wins over a restart.

**A laptop that slept is not a stall.** Silence is counted on the monotonic clock,
which stands still while the machine sleeps; and the worker compares the wall clock
with it every 30 seconds — a jump of more than a minute (or a check that came that
much later than due: a paused VM, a stopped worker) is a sleep. Every running agent's
silence then starts over, a full `stallTimeout` of grace, and the run logs it once as a
`host_suspended` event (`{ sleptSeconds, message }`). An agent whose connection dropped
while the lid was closed fails as `network` and is retried (see
[Rate limits, quotas and logins](#rate-limits-quotas-and-logins)). ODW does not keep the
machine awake — a closed lid sleeps anyway.

```jsonc
{
  "stallTimeout": 120, // seconds of silence; null (the default) = off
  "stallRestarts": 1,
  "adapters": {
    // per adapter: overrides the run-wide value; 0 turns the watchdog off for it
    "my_wrapper": { "command": ["my-agent", "--stream", "{prompt}"], "stallTimeout": 300 }
  }
}
```

The watchdog is **off by default for every built-in adapter**: some CLIs — the
text-mode ones (`gemini`, `qwen`, `kimi`, …) — print nothing until they finish, so
any stall timeout would kill healthy work. Use it for adapters that stream
progress: `claude` (its stream-json prints an event per turn, so it is now safe to
enable for it), `codex` (`exec --json` prints an event per command, edit and message),
the JSONL adapters `kilo`, `opencode` and `agy` (an event per step), or a wrapper that prints
a heartbeat — with a value above the longest quiet stretch a healthy agent has: a
long test run inside one tool call prints nothing either.

**One agent's window** (Claude Code dialect): `agent(prompt, { stallMs: 1800000 })`
gives that call its own stall window in milliseconds — 30 minutes here — in place of
its adapter's and the run's `stallTimeout`, with the same restarts (`stallRestarts`)
and the same failure (reason `"stalled"`). It works where no `stallTimeout` is set,
so a long fan-out can give its slow reviewers more room and its quick ones less;
`stallMs: 0` turns the watchdog off for that call.

## Per-agent limits and runaway loops (ODW extension)

An agent stuck in a loop keeps printing, so the stall watchdog never fires, and
`--budget` caps the whole run, not one agent. `limits` caps one `agent()` call:

```js
await agent("Fix the failing test", {
  limits: { toolCalls: 200, costUsd: 3, outputTokens: 200000, seconds: 1800, repeat: 5 },
});
```

| Limit | Trips when |
| --- | --- |
| `toolCalls` | the agent made more tool calls than this, over all its CLI runs |
| `costUsd` | its CLIs reported spending more dollars than this |
| `outputTokens` | its CLIs reported generating more tokens than this |
| `seconds` | this long has passed since its first CLI run started |
| `repeat` | the same tool call — its name and a hash of its arguments — came this many times **in a row** (2 or more) |

They are enforced **live**, from what the CLI prints as it runs: Claude Code's
stream-json (tool_use blocks and each message's usage; its cost arrives with its
final `result`), Codex's `exec --json` (command, file-change, MCP and web-search items;
each turn's usage), kilo's and opencode's events (tool calls; each step's tokens and
cost) and agy's stream-json (tool steps; each step's tokens). A breach kills the
agent's CLI and everything it started at once, like a stall, and the agent fails
with reason `runaway`: its `agent_failed` event carries
`limitHit: { limit, max, value, evidence }` and its error says
``adapter 'claude' ran away — limits.repeat=5: Bash `npm test` ×5 in a row``
(or `41 tool calls > 40`, `$3.12 > $3.00`). A runaway is not retried by
`transientRetries`, and under `expect` it is not a miss to run again — its limit is
spent. `odw status` lists the runaways with their evidence, `odw agents` shows it in
place of the value, and the dashboard's drawer shows the agent's limits with the one
it hit.

`repeat` counts calls in a row, not *n* within the last *2n*: the windowed rule also
fires on a healthy edit–test cycle (`npm test`, edit, `npm test`, edit, …), while the
same call with the same arguments back to back means nothing the agent did in between
could change the answer. Each further CLI run of the call (a retry, a restart) starts
its own streak.

Set defaults for every agent in the config, and per adapter; a call's `limits`
override both key by key, and `null` lifts an inherited limit:

```jsonc
{
  "agentLimits": { "toolCalls": 300, "repeat": 6 },   // {} (the default) sets none
  "adapters": {
    "codex": { "agentLimits": { "seconds": 1800, "repeat": null } }
  }
}
```

A CLI that prints text (`gemini`, `qwen`, …) reports no usage while it runs: its
`outputTokens` and `costUsd` are checked after each run, against what it reported or
chars/4 of its reply — the run's log says so once. A CLI that reports no dollars at all
(Codex) cannot trip `costUsd`; the log says that once too — use `outputTokens`.

## Rate limits, quotas and logins

**ODW extension.** Every failed agent is classified from its CLI's exit status
and the end of its output: `rate_limit`, `quota`, `auth`, `timeout`, `stalled`,
`not_found` (the CLI could not start), `permission` (a tool call or approval was
refused), `network` (the connection to the model's API was lost), `model_unavailable` (the model asked for is unknown, retired, or not
offered to the account) or `exit` — and four classes for runs that "succeeded" without the
evidence: `empty_reply`, `unmet_expectation`, under `"mcpFailures": "fail"`
`mcp_unavailable`, and `orphaned_background` (background work left running at the
reply, under `"orphanedBackground": "fail"` or `expect`; see
[Check an agent's work](../reference/workflow-api.md#check-an-agents-work-odw-extension)) — and `out_of_scope`, an agent that
changed files outside its declared scope under `"scopePolicy": "fail"` (see
[Declared scopes](../reference/workflow-api.md#declared-scopes-odw-extension)), `needs_input`, an agent that stopped to ask a
question nobody answered (see [Agent questions](checkpoints-and-questions.md#agent-questions-odw-extension)), `model_substituted`, an agent its CLI
said another model served under `"modelMismatch": "fail"` (see
[The model that actually served an agent](running-and-observing.md#the-model-that-actually-served-an-agent-odw-extension)), and `runaway`, an agent killed at one of its
[limits](#per-agent-limits-and-runaway-loops-odw-extension). The class is the `reason` on the `agent_failed` event (with
`retryAfter`, in seconds, when the CLI said when to come back), the agent's
`failureReason` in the dashboard and `/api/runs/:id`, and it shows in the live
view and `odw logs`:

```text
agent_failed    (Search) search — [quota, retry after 3h 22m] AdapterExecutionError: adapter 'codex' ran out of usage quota — wait for the window to reset (in 3h 22m) and resume the run, or switch adapter with --adapter <name>: You've hit your usage limit…
```

- **Rate limits** — HTTP 429/529, "too many requests", "overloaded", Gemini's
  `RESOURCE_EXHAUSTED` — are ridden out: ODW waits, then runs the agent again,
  up to `transientRetries` times per `agent()` call (default 3). The wait is the
  retry-after the CLI printed (`Retry-After: 30`, "try again in 2 minutes",
  "resets at 7:10pm") or else an exponential backoff (15s, 30s, 60s, …), plus up
  to 20% jitter, and never more than `maxBackoff` seconds (default 300); a CLI
  that asks to wait longer than that is not retried early. Each wait is logged
  (`search:3 hit a rate limit on codex — retrying in 45s (2/3)`); a stop ends it
  at once, and a paused run starts the retry only once resumed.
- **A lost connection** — Node's `ECONNRESET`, `ENOTFOUND`, `EAI_AGAIN`,
  `ETIMEDOUT`, "fetch failed", "socket hang up", "network error", Claude Code's
  "API Error: Connection error.", Codex's "error sending request for url" — is
  `network` (an ODW extension), ridden out exactly like a rate limit: the same
  backoff, its own `transientRetries` per call, logged as `search:3 lost its
  connection on claude — retrying in 15s (1/3)`. Only the final lines of the output
  count, so a test the agent ran against a closed port is not one. It does not lower
  the adapter's adaptive cap.
- **Spent quotas and failed logins** are never retried. The error says what to
  do — wait for the quota window, log in to the CLI, or switch adapter with
  `--adapter` — and the run goes on, since its other adapters may be fine. When
  three agents in a row fail this way on one adapter, the run logs one warning;
  `odw resume` later replays every agent that finished. A "quota" that refills
  within a minute (Gemini's free tier words its per-minute limit that way) is
  treated as the rate limit it is. With a [fallback chain](adapters-and-models.md#per-phase-adapters-model-tiers-and-fallback-chains-odw-extension),
  the agent moves to the next CLI instead, and after three quota failures in a row
  the run's later agents skip that adapter. With [`quotaWait`](#pause-for-a-spent-quota-odw-extension),
  an agent with no CLI left waits for the quota to reset instead of failing.
- **A model that is not there** — unknown to the CLI, retired, or not offered to this
  account ("There's an issue with the selected model", "The model `x` does not exist or
  you do not have access to it", Gemini's "models/x is not found for API version",
  `ModelNotFoundError`, agy's "invalid model selection", Cursor's "Cannot use this
  model") — is `model_unavailable`: never retried, and like a spent quota it moves the
  agent down its fallback chain. Only the final lines of a run's output count, so an
  agent's own work that prints "model not found" is not mistaken for it. `odw doctor
  --models` checks every model the config's `models` tiers, `fallback` chains, default
  adapter and the `.odw/workflows` phases name, one tiny prompt each, and reports `ok`,
  `model_unavailable` or `other` per pair.

Claude Code reports such errors in its output, often with exit 0: its stream-json
`result` event says `is_error: true` with the message (`API Error: Rate limit
reached`, `Claude AI usage limit reached|…`), and that counts as the failure it
names. So do Codex's `turn.failed` and `error` events (`Quota exceeded. Check your
plan and billing details.`, `exceeded retry limit, last status: 429 Too Many
Requests`) — except an `error` it retried itself, after which its turn completed. In text mode (a text adapter, or JSON output that fell back to its raw
stdout), a short reply that is nothing but such a rate-limit, quota or login error
counts as that failure too — never as the agent's answer. An empty reply is an
`empty_reply` failure, not retried. A `result` that claims success while its
`permission_denials` list tool calls headless mode refused stands, the calls
recorded and logged — a `permission` failure naming them only under
`"permissionDenials": "fail"`, or for a call with `expect`.

The wording ODW recognizes — collected from each built-in CLI's source and issue
tracker — lives in one table,
[`src/adapters/failures.ts`](../../src/adapters/failures.ts). Teach it your own CLI's
with an adapter's `failures`: regular expressions per class, matched
case-insensitively before the built-in table.

```jsonc
{
  "transientRetries": 3, // retries per agent() call after a rate limit (and, apart, after a lost connection); 0 = never
  "maxBackoff": 300, // longest single wait, in seconds
  "adapters": {
    "my_wrapper": {
      "command": ["my-agent", "{prompt}"],
      "failures": {
        "rate_limit": ["server busy", "E_THROTTLED"],
        "quota": ["monthly tokens? (used up|exhausted)"],
        "auth": ["session expired"],
        "model_unavailable": ["no such model"],
        "network": ["E_OFFLINE"]
      }
    }
  }
}
```

## Pause for a spent quota (ODW extension)

**ODW extension.** A long run whose every usable CLI is out of quota fails its
remaining agents — fast, thanks to the quota breaker. Left running overnight, you would
rather it waited for the reset and carried on. `quotaWait` makes it do that:

```jsonc
{
  "quotaWait": { "max": 21600 } // wait up to 6 hours for a spent quota to reset; false (the default) fails as above
}
```

When an agent has run out of CLIs on a spent quota — its last adapter's quota failed,
or the quota breaker skipped every one — and a CLI said when its quota resets ("try
again in 3h 22m", "resets 7pm", Claude Code's `usage limit reached|<epoch>`) no more
than `max` seconds away, the run **pauses** instead of failing it:

- The agent waits holding no slot, so agents on CLIs with quota left keep running.
  Until the reset a CLI named, the run passes over that CLI: an agent with a fallback
  moves on, and one with nowhere else to go waits too — before it starts, so it shows
  no agent and takes no slot meanwhile.
- The run shows `paused` and what it waits for: `odw status`, `odw list` and the live
  view say `paused until 19:10 (codex quota)`, `odw run --wait` says it once, and
  `status.json` and `GET /api/runs[/:id]` carry
  `pausedFor: { "reason": "quota", "adapter", "resumeAt" }` (`resumeAt` in Unix seconds).
- At the reset — plus up to 30 seconds of jitter, so the waiting agents do not all come
  back in the same second — each starts over from the start of its chain, and the
  quota breaker forgets the CLI. `odw resume <run>` goes on at once; `odw stop` stops
  the run as always. A `checkpoint()` can wait at the same time.
- A quota failure that names no reset, or one past `max`, still fails the agent as
  above, and the run's log says why
  (`quotaWait: not waiting — codex did not say when its quota resets, so the agent fails`).
- A pause never fires the run-end hooks; add `"paused"` to
  [`notify.on`](notifications.md#run-notifications) to hear about each one.

```text
quota pause: codex is out of usage quota until 19:10 (in 3h 22m) — its agents wait, holding no slot, and go on then (quotaWait); odw resume goes on now
search:3 waits for codex's quota to reset (quotaWait)
quota pause over: codex's quota reset — its agents go on
search:3 goes on after the quota wait, on codex
```

It is off by default because a run that silently waits for hours would surprise anyone
who did not ask for it. The wait lives in the worker process: if the worker dies, the
run is `stale`, and `odw resume` replays it like any run that ended — its finished
agents come back without running again.

## Concurrency per adapter and staggered fan-outs

**ODW extension.** `concurrency` caps how many agents a run has going at once; an
adapter's own `concurrency` caps how many of them run on that CLI — so a fan-out of
16 codex calls runs 4 at a time while other adapters use the rest of the run's slots.
An agent needs a run slot and a slot on its adapter, handed out together: it never
holds one while it waits for the other, each adapter's agents queue first come,
first served, and a free run slot goes to the oldest agent whose adapter has room, so
one throttled adapter never holds up the others. `odw doctor` shows the caps, and
`odw run` states them in its start banner, under the permissions line
(`concurrency: 8 agents at once · per adapter: codex 4`).

```jsonc
{
  "concurrency": 8,
  "adaptiveConcurrency": true, // the default; false keeps every cap fixed
  "staggerFanOut": { "first": 1, "delayMs": 2500 }, // the default; false turns it off
  "adapters": {
    "my_wrapper": {
      "command": ["my-agent", "--cwd", "{workspace}", "--prompt-file", "{prompt_file}"],
      "concurrency": 4 // at most 4 of its agents at once, inside the run's 8
    }
  }
}
```

To cap a built-in adapter, name only what changes — `"codex": { "concurrency": 4 }`
keeps codex's command and flags (an entry without `command` adjusts the built-in;
one with `command` replaces it).

**Adaptive back-pressure.** When an adapter hits a rate limit — an agent about to
wait out a backoff, or one that failed with `rate_limit` — its cap is halved for the
rest of the run, never below 1 (an adapter without a cap of its own starts from the
run-wide one), and each minute without another rate limit gives one slot back. A
fan-out that hit the limit together cuts the cap once, not once per agent. Agents
already running keep their slots — a rate-limited one waits out its backoff in place
— so the lower cap holds back the agents that start next. The cut, and the slot that
brings the cap back in full, are logged:

```text
adaptive concurrency: codex hit a rate limit — at most 4 of its agents at once now (was 8); one slot comes back for each minute without another
adaptive concurrency: no rate limit on codex for 4m — back to 8 of its agents at once
```

**Staggered fan-outs for the prompt cache.** Anthropic's API, behind the built-in
`claude` adapter, caches a prompt's prefix: the first request that sends it writes
it, and later ones read it for a fraction of the price — but only once the first has
been read. A fan-out that starts every agent at once pays the full prefix in each.
So in one `parallel()` or `pipeline()` call, agents on an adapter that declares
`"promptCache": true` (the built-in `claude` does) whose prompts share at least their
first 1,024 characters start `first` at a time; the rest start once the first one's
CLI has produced output — for a JSONL adapter such as `claude`, its first event past
the CLI's start-up `system` events — or `delayMs` later, whichever comes first. Put the shared instructions first and the per-item
part last to benefit. A lone agent, an agent whose prompt is shorter or different (or
on another model or persona), and a replayed one never wait; a held agent holds no
slot, and a stop ends the wait at once. Each staggered fan-out logs one line:

```text
staggered fan-out: 15 claude agents sharing a 3412-character prompt prefix waited 2.1s while the first warmed the prompt cache, until it produced output
```

Declare `"promptCache": true` on your own adapter when its CLI talks to an API that
caches prompts — and on a `claude` entry with its own `command`, which replaces the
built-in (a partial entry such as `"claude": { "concurrency": 4 }` keeps it).
