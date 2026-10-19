# Testing, debugging and evaluating workflows

English · [简体中文](../zh-CN/guides/testing-and-debugging.md)

Make a workflow right before it costs anything, and keep it right as models and CLIs change.

## Debug a workflow (ODW extension)

Three tools for the moment one step of a workflow is wrong — none of them needs the
workflow edited or the whole run paid for again:

```bash
odw check wf.js                           # does it load? errors with line, column and a code frame
odw check wf.js --capabilities            # … and what it names outside the dialect: process, require, import(, …
odw run wf.js --help                      # what it takes as --args, from its meta.input
odw replay $RUN --agent judge             # run that one agent again, as a small new run
odw replay $RUN --agent judge --prompt @better.txt --adapter codex --model gpt-5
odw compare $RUN $REPLAY --agent judge    # the original and the replay side by side
odw run wf.js --break Review              # stop for a decision before phase "Review" (or agent label)
odw run wf.js --step                      # … before every phase
```

**`odw check <script.js|name> [--json]`** compiles a workflow the way a run does —
the `meta` literal parsed as a pure literal, its name, description and phases checked,
the body compiled, never run — and prints `file:line:col: error: …` with the source
lines around it and a caret, then the portability warnings `validate()` gives. Exit 0
when it loads, 1 when it does not. Parse errors say what the compiler says, with a
hint only where one fits: TypeScript syntax when a type annotation, `interface` or
`as` is at fault (not for every error), an `await` inside a callback that is not
`async`, a script that ends before a bracket it opened is closed. The same positions
are in the messages a run fails with and in `validate()`'s errors. `--capabilities`
adds, read off the source and never run, the identifiers it names outside Claude
Code's dialect — `process`, `require`, `import(`, `globalThis`, `Function(`, `eval`,
`fetch`, `console`, timers, … — each with its first line and column and whether a
[strict script context](safety-and-trust.md#strict-script-context-odw-extension) has it, and the ODW
extension primitives it calls (`validate`, `exec`, `checkpoint`, `workflow.input`);
`--json` carries them as `capabilities: { outOfDialect, extensions }`. Its hints — a
fan-out's `.filter(Boolean)` or an agent-text match whose emptiness nothing checks
(see [Check the input, count the nulls](../reference/workflow-api.md#check-the-input-count-the-nulls-odw-extension))
— print as `file:line:col: hint: …` and go in `--json` as `hints`; they never change
the exit code.

Among the warnings are **Claude Code's limits** that ODW does not share: a
`parallel()` or `pipeline()` whose list the source settles at more than 4,096 items
(an array literal, `Array.from({ length: n })`, `Array(n)`, `[...Array(n)]`, through
`.map`/`.fill`/`.keys`), which Claude Code's runtime rejects with an error —
`parallel() on line 12 is given 5,000 items …` — and a `meta` that is not a pure
literal, which Claude Code drops from its completions (ODW refuses it outright).
They are warnings only: ODW runs a fan-out of any size, and `check` still exits 0.

**`odw replay <run> --agent <id|label>`** dispatches one saved `agent()` call again.
Every call's inputs are kept as it starts (`agents/<id>.call.json`: the prompt and
options as the script gave them, the adapter it started on, the model it asked for),
and an isolated agent's `agent_started` event names the commit its worktree checked
out (`base`). The replay is a new run (`origin: "replay"`, `replayOf: { runId,
agentId, label, base }` in its `meta.json`, whose `args` are `{ replayOf }` only: the
prompt and options are kept in the run directory's `call.json`, which nothing serves)
of just that call, with the original's
label and phase, in the original's directory, config, permission tier, trust,
untrusted input and sandbox (a triggered run's replay runs in a strict script context
too) — and, for a `worktree` agent, at the original's base commit whatever HEAD is
now, so it sees the code the original saw. `--prompt @file|TEXT`, `--adapter` and
`--model` replace the original's (each change is printed); it takes `odw run`'s
`--wait`/`--fg`/`-d`/`--timeout`. It prints the new run id and the `odw compare`
command that pairs the replay with its original (by label, or by id when other agents
of the run share the label). A run from before this version saved no calls and cannot
be replayed (`odw rerun` runs the whole workflow).

**`odw run <wf> --break <phase|label>[,…]`** (repeatable) and **`--step`** stop the
run for a decision before the named phases — a nested workflow's phase by its title
or its `▸ child · title` — and before agents with the named `label`, or with `--step`
before every phase. A break is a [checkpoint](checkpoints-and-questions.md#human-checkpoints-odw-extension) the
run asks itself, titled `Break before phase Review` (or `… agent judge`), so `odw
approve|reject`, the dashboard and [phone links](dashboard.md#approve-from-your-phone-odw-extension)
answer it. Its payload is the run so far: `{ before, phasesDone, agents: { done,
failed, running }, results: [the last 20, replies cut to 300 characters], args }`.
`phase()` cannot wait (it is synchronous in the dialect), so the phase's work does:
every `agent()`, `exec()`, `workflow()` and `checkpoint()` called from then on holds
until the answer; agents already running go on; calls with a break's label made while
it waits share it.

- **approve** — the run goes on.
- **reject** — the run stops, as `odw stop` would, the break and your note in the reason.
- **approve with an edited payload** (`--edit`, `--payload`, the dashboard) — only
  `args` is taken: when the run's `args` is an object or an array and the edit keeps
  it one, it is changed in place, so every read of `args` after the answer sees the
  edit. What the script read before keeps its value — a `const { x } = args` at the
  top, and the arguments of the call the break holds (its prompt was built before the
  answer; the calls after it read the edit). That is the only change that cannot
  surprise a running script; any other `args` edit is refused with a log line and the
  run goes on unchanged. The edit lives in this run: `odw rerun`/`resume` start from
  the args in `meta.json`.

A `--break` name that matched nothing is said in the run's log when it ends.

## Evaluate a workflow (ODW extension)

Changed a prompt, a model tier or a CLI, and want to know if the workflow still does
its job — reproducibly, and on every CLI you use? Put a few cases in an eval file and
let `odw eval` run each one on each adapter, several times, and judge the runs:

```bash
odw eval review                          # .odw/evals/review.json; or a path: odw eval examples/evals/routing.json
odw eval review --adapter claude,codex --repeats 5   # override the file's adapters and repeats
odw eval review --json --out today.json  # the report as JSON (stdout and a file)
odw eval review --baseline today.json    # deltas against an earlier report; exit 1 when a cell regressed
```

```json
{
  "workflow": "review",
  "adapters": ["claude", "codex"],
  "repeats": 3,
  "concurrency": 2,
  "timeout": 900,
  "cases": [
    { "name": "small-diff", "args": { "diff": "…" },
      "checks": [
        { "state": "done" },
        { "path": "verdict", "equals": "approve" },
        { "path": "findings[0].file", "matches": "\\.ts$" },
        { "command": "jq -e '.findings | length < 5' \"$ODW_RESULT\"" },
        { "maxCostUsd": 0.5 }, { "maxSeconds": 300 }
      ] }
  ]
}
```

- **The file**: `workflow` (a name or a path, resolved like `odw run` from where you run
  `odw eval`), `cases` (`name`, `args`, `checks`), and optionally `adapters` (each runs
  the whole case set as the run's default adapter, like `odw run --adapter`; absent:
  the config's default), `repeats` (default 1), `concurrency` (runs at once, default 1),
  `budget` (tokens, each run's `--budget`), `timeout` (seconds; a run still going then is
  stopped and fails), `name` and `description`. It is validated strictly — an unknown
  key, a bad path or regex is an error naming where it is — before anything runs.
- **Checks** are judged on the run's outcome, with no model: `{ path, equals }` (deep
  equality), `{ path, contains }` (a substring, or an array element), `{ path, matches,
  flags? }` (a regex; a non-string value is matched as its JSON), `{ path, exists }`
  (`true`, or `false` for "not there"), `{ command, timeout? }` (exits 0, run by the
  shell in the project directory with `ODW_RESULT` — a file holding the result as JSON —
  and `ODW_RUN_ID` set; 300s unless it says), `{ state: "done" | "failed" | "stopped" }`,
  `{ maxCostUsd }` (an unknown cost fails it) and `{ maxSeconds }` (the run's start to
  end). Paths are dot/bracket notation into the result: `verdict`, `findings[0].file`,
  `["odd key"]`; `""` is the whole result. A case without checks gets `{ "state":
  "done" }`; one that lists checks gets exactly those, and a run passes when it meets
  all of them.
- **Runs**: every case × adapter × repeat is a real run in the run store, started from
  this directory and marked `origin: "eval"` with `eval: { name, case, adapter, repeat }`
  in its `meta.json` — `odw list` and the dashboard's run summaries say so. At most
  `concurrency` go at once. Progress is a line per finished run on stderr; Ctrl-C stops
  every run the eval started, keeps no report and ends `odw eval`.
- **The table**: per case × adapter, pass k/n, median wall time, total and mean cost and
  mean tokens; then the totals; then each failed run with the checks it missed and its
  run id — any two runs open side by side with `odw compare`.
- **The report** (JSON, `version: 1`; `src/eval/report.ts` documents every key) carries
  the definition and its sha256 (`evalHash`), the workflow's sha256, the odw version, the
  CLI versions the runs recorded, the cells, and every run with its id and failures. It
  is kept as `<runsRoot>/_evals/<name>/<id>.json` — `GET /api/evals` lists them and `GET
  /api/evals/:name/:id` serves one, read only — and written to `--out`.
- **`--baseline <report.json>`** compares each cell (by case and adapter) with an earlier
  report: pass rate, mean cost and median time, B − A. A cell whose pass rate fell
  regressed. Exit codes: 0 when every run passed — or, with `--baseline`, when no cell
  regressed; 1 otherwise; 2 for a usage error (nothing ran).

## Test a workflow (ODW extension)

A workflow is code: test it like code, without paying a model for every try.
`odw test` runs the real runtime — worker, scheduler, schema validation and retries,
fallback chains, the run store — and answers every agent with a reply you scripted.
Nothing calls a model; a test costs $0 and takes a fraction of a second.

```bash
odw test                                  # every .odw/tests/*.json in this directory
odw test review-swarm                     # .odw/tests/review-swarm.json; or a path: odw test examples/tests/review-swarm.json
odw test review-swarm --case 2 --json     # one case (by number or name); the report as JSON
odw test review-swarm --keep              # keep the scratch runs (odw logs <run_id> --runs-root …); or --runs-root DIR
odw run review-swarm --record             # a real run, kept as a case of .odw/tests/review-swarm.json (--record-to FILE)
odw run review-swarm --dry                # every agent gets a stub: the phase tree and agent counts, $0
odw new review-swarm                      # a template with its starter tests, passing from the start (above)
```

```json
{
  "workflow": "review-swarm",
  "cases": [
    { "name": "a real finding survives",
      "args": { "lenses": ["correctness", "security"] },
      "replies": [
        { "label": "map", "reply": { "summary": "adds a cache", "files": ["src/cache.ts"] } },
        { "label": "review:correctness", "reply": { "findings": [{ "title": "stale read", "severity": "high", "rationale": "…" }] } },
        { "label": "review:security", "fail": "rate_limit" },
        { "label": "verify:*", "reply": { "real": true, "reason": "confirmed" }, "schemaMiss": 1 }
      ],
      "expect": {
        "checks": [{ "path": "confirmed[0].title", "equals": "stale read" }],
        "agents": { "count": 4 },
        "logs": ["1 of 1 findings survived"]
      } }
  ]
}
```

- **The file** (`.odw/tests/<workflow>.json`; [`examples/tests/review-swarm.json`](../../examples/tests/review-swarm.json)
  is a full one): `workflow` (a name or a path, resolved like `odw run` from where you run
  `odw test`; absent: the file's name), `cases` (`name`, `args`, `replies`, `expect`, and
  optionally `default`, `checkpoints: "approve" | "reject"` to answer every `checkpoint()`,
  `timeout` in seconds, default 120), and a file-wide `default`. It is validated strictly
  before anything runs.
- **Replies** script agents by `label` (a glob: `verify:*`), `phase` (a glob), `prompt` (a
  substring) or `adapter`; every matcher an entry gives must hold, and the first matching
  entry answers. It answers with `reply` (a string as is, anything else as JSON — a
  schema call's value), `fail` (`rate_limit`, `quota`, `auth`, `permission`, `timeout`,
  `stalled`, `not_found`, `exit`: read by ODW's failure classes like the real thing, so
  rate limits are retried and quota falls back), `empty: true` (an empty reply) or `dry:
  true` (the `--dry` stub). `schemaMiss: N` replies with something no schema accepts N
  times first (schema retries), `delayMs` answers late (finish order), `once: true` answers
  one agent and is used up (agents sharing a label, in turn).
- **An agent no entry scripts fails the case** — `unscripted agent \`review:tests\` (agent
  #6, phase Review)` — unless a `default` entry (no matchers) answers it.
- **`expect`**: `state` (`"done"` by default, `"failed"`, `"stopped"`), `error` (a substring
  of the run's error), `checks` in `odw eval`'s vocabulary (`{ path, equals | contains |
  matches | exists }`, `{ command }`, `{ state }`, `{ maxSeconds }`, `{ maxCostUsd }` — a
  test costs $0), `agents: { count, labels }` (how many started; exactly these labels, any
  order) and `logs` (substrings of `log()` lines, in this order).
- **Runs** go in a scratch run store, removed afterwards (`--keep`, `--runs-root DIR` keep
  them), marked `origin: "test"`. `exec()` steps, `isolation: "worktree"` and the rest of
  the runtime run for real; only the agent CLIs are replaced. Exit 0 when every case
  passed, 1 when any failed, 2 for a usage error (nothing ran).
- **`odw run <wf> --record [--record-to FILE]`** keeps a real run as a regression fixture:
  once it ends, its worker adds a case named `recorded <run_id>` — the run's input, each
  agent's actual reply (or its failure class), `expect` with the final state, the result
  (when under 8 KB) and the agent count. Redacted like the run's own records, each string
  cut at 4,000 characters; agents sharing a label whose replies differ get one `once`
  entry each, in start order. `odw test` then replays it for $0.
- **`odw run <wf> --dry`** runs with every agent answered by a stub: `"(dry run)"`, or for a
  schema call its smallest valid value (required properties only, `minItems` items, the
  first `enum` value, the lowest number the bounds allow). It waits for the run, then
  prints the phase tree — each phase with how many agents it started and their labels —
  and marks the run `dry: true` in its `meta.json` (the dashboard's run summaries carry
  `dry: true`). No adapter needs to be installed.
