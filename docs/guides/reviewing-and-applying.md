# Reviewing and applying changes

English · [简体中文](../zh-CN/guides/reviewing-and-applying.md)

Agents with `isolation: "worktree"` work on their own checkout; what they changed is kept as a diff for you to review and land.

## Isolated worktrees and agent ports

`agent(prompt, { isolation: "worktree" })` runs that agent in a throwaway git
worktree: a clean checkout of HEAD, without the `.env`, `.venv` or
`node_modules` your source tree has. Two things make it ready before the agent
starts:

- **`.worktreeinclude`** at the repository root — the file Claude Code reads
  too — lists what to bring in, in `.gitignore` syntax. Every file or directory
  git does not track that a line matches is copied into the worktree (Claude
  Code copies only gitignored files; ODW copies merely untracked ones as well).
  `.git` is never copied, and a file over 100 MB is left out with a log line. A
  `symlink:` prefix (**ODW extension**) links what the line matches instead of
  copying it: instant for a heavy directory, but shared — what an agent writes
  there lands in your source tree.
- **`worktreeSetup`** (**ODW extension**) runs in the agent's workspace once the
  files are in: a string through the platform shell, an array as an argv. It is
  killed after `worktreeSetupTimeout` seconds (600 by default); a setup that
  fails or times out fails that agent — not the run — with the end of its
  output in the error.
- **`worktreeTeardown`** (**ODW extension**) is its counterpart: it runs in the
  same workspace, with the same variables, just before the worktree is removed —
  after the agent finished, failed or was stopped (`odw stop`, a signal to the
  worker), and after a setup that failed half-way. It is killed after
  `worktreeTeardownTimeout` seconds (120 by default); one that fails or times out
  is logged against the agent, whose result stands.

```gitignore
# .worktreeinclude
.env
.env.local
config/secrets.json
symlink: node_modules
```

```jsonc
{
  "worktreeSetup": "npm run codegen", // or an argv, e.g. ["uv", "sync"]
  "worktreeSetupTimeout": 600,
  "portRange": [41000, 41999]
}
```

Every agent process — isolated or not — also gets `ODW_RUN_ID`, `ODW_AGENT_ID`
and `ODW_PORT` (**ODW extension**). `ODW_PORT` comes from `portRange`; no other
running agent of the run holds it (ports something already listens on are
passed over), and it stays the agent's until its call settles. So agents
running side by side can each start a dev server:

```js
await parallel(['grid', 'list'].map((layout) => () =>
  agent(`Build the ${layout} layout, start the dev server on port $ODW_PORT and check that the page renders.`,
    { isolation: 'worktree', label: layout })))
```

Ask such agents to stop the servers they start before they finish: an agent
CLI may wait for its own background commands before it exits (`claude -p`
does), which holds the agent — and its port — until the stall watchdog or the
timeout ends it.

The setup command gets the same three variables, and `exec()` commands get
`ODW_RUN_ID`. Keep `portRange` wider than `concurrency`: an agent started while
the others hold every port runs without `ODW_PORT`, and the run's log says so.
Each attempt of a call (a schema retry, a stall restart, a rate-limit retry)
starts from a fresh worktree, prepared the same way.

An isolated agent also gets `ODW_SLOT` (**ODW extension**): `odw-<run>-<agent>` —
the run id's random part and the agent id, e.g. `odw-a1b2c3-4` — lowercase
letters, digits and hyphens only, the same for every attempt of the call, its
setup and its teardown. `COMPOSE_PROJECT_NAME` is set to it — over one you set,
which the run's log says once — so `docker compose` in a worktree drives that
agent's own stack, never yours, and parallel agents never share one. Name the
project explicitly all the same (`docker compose -p "$ODW_SLOT" …`), as the recipe
below does. Use it as a database name or volume prefix too (quote it, or swap the
hyphens for underscores, where a hyphen is not allowed).

### Recipe: a compose stack and a database per agent

Each isolated agent brings up its own services on its own port and takes them
down — volumes included — before its worktree goes, whether it succeeded, failed
or was stopped:

```yaml
# compose.yaml — the project is named on the command line: -p "$ODW_SLOT"
services:
  db:
    image: postgres:16
    environment: { POSTGRES_PASSWORD: dev, POSTGRES_DB: app }
    volumes: [data:/var/lib/postgresql/data]
  app:
    build: .
    ports: ["${ODW_PORT}:3000"]
    environment: { DATABASE_URL: "postgres://postgres:dev@db:5432/app" }
    depends_on: [db]
volumes:
  data: {}
```

```jsonc
{
  "worktreeSetup": "docker compose -p \"$ODW_SLOT\" up -d --wait && npm run migrate",
  "worktreeTeardown": "docker compose -p \"$ODW_SLOT\" down -v --remove-orphans",
  "worktreeTeardownTimeout": 120
}
```

```js
await parallel(['grid', 'list'].map((layout) => () =>
  agent(`Build the ${layout} layout; the app runs on http://localhost:$ODW_PORT with its own database.`,
    { isolation: 'worktree', label: layout })))
```

Migrations then run against that agent's database, never a shared one, and the
teardown's `down -v` removes that agent's stack and volumes only — `-p "$ODW_SLOT"`
names it whatever the environment holds. A stack a
worker killed outright (SIGKILL, a second signal) never got its teardown: `odw
gc` lists the `odw-*` compose projects whose run is no longer active, with the
`docker compose -p <name> down -v` to run — it never removes them itself. ODW
does not clone databases or manage services it did not start.

## Review and apply what isolated agents changed (ODW extension)

An isolated agent's worktree is removed when its call settles, but its work is
not lost: before the worktree goes, ODW keeps what the agent changed — edits,
new, deleted, renamed and binary files, staged, committed or not — as a unified
diff in the run directory (`agents/<agentId>.diff`), and records its size,
`changes: { files, insertions, deletions, truncated }`, on the agent's
`agent_finished` event and saved result. `agent()` still returns the reply.
What `.worktreeinclude` placed and `worktreeSetup` produced is not the agent's
change and stays out, unless the agent edited it afterwards.

```bash
odw diff $RUN --stat               # who changed what: files, +/- lines, kept branch
odw diff $RUN --agent fix:auth     # one agent's diff, by label or id — a patch git can read
odw apply $RUN --agent 3 --check   # preview: each file clean, CONFLICT (with its lines) or already applied
odw apply $RUN --agent 3           # apply it to this working tree (git apply --3way)
odw apply $RUN --all --check       # preview every finished agent, each on top of the ones before it
odw apply $RUN --all --verify "npm test"   # apply them in order; roll back one that fails the check
odw apply $RUN --all --resolve --verify "npm test"   # an agent resolves a conflict; applied once verified
odw apply $RUN --all --pr --verify "npm test"   # a branch, one commit per agent, pushed, and a draft PR (gh)
```

`odw apply` applies one agent's diff — or, with `--all`, every finished agent's,
in agentId order — to the git working tree you run it in, with
`git apply --3way`: what applies is staged. Before it touches anything it runs
the same apply against a scratch copy of the index and prints each file as
`clean`, `CONFLICT` — with the conflicting lines as the merge would leave them
in the file, or why it cannot be merged (`deleted here`, `binary`, or an
untracked or ignored file in the way, which git would write over) — or
`already applied`; `--check` stops there (exit 1 on a conflict). A single agent
is then applied, a hunk that clashes left with conflict markers (exit 1).
`--all` previews each agent on top of the ones before it, applies them up to the
first that would conflict, and says which applied and which did not; a failed
agent's diff goes in only by `--agent`. It refuses while a path a diff touches
has uncommitted changes — commit or stash them, or pass `--force`. The dashboard
shows the same diffs in a run's **Changes** tab and serves them at
`GET /api/runs/:id/agents/:agentId/diff`.

`--verify "<cmd>"` — or the `applyVerify` setting, which `--no-verify` skips
once — runs a command at the repository root after each apply, through the
shell and within the `timeout` setting. When it fails or times out, that apply
is rolled back — the paths it touched get back exactly what they held, content
and index entries — and odw exits 1 with the end of the command's output; Ctrl-C
rolls it back the same way. An edit made to those files while the command ran is
set aside first, where odw says. Nothing else is touched — no stash, no reset —
so your other uncommitted work stays as it is. A change that would conflict is
not applied under `--verify`.

`--resolve` (with `--all` or `--agent`) hands an agent whose diff would conflict
to a resolver agent instead of stopping there. odw makes a temporary worktree at
the state the diff lands on — HEAD, the index (the agents applied before it
included), and the agent's files that apply cleanly — and starts a resolver run
in it on the default adapter (or `--adapter A`), told the base, both sides and
the conflicting lines of each conflicting file, to keep both intents and touch
nothing else. Its change is refused unless it edits only the conflicting files,
leaves no conflict markers, and passes the verify command (`--verify` or
`applyVerify`) in that worktree; then it is applied to your tree with the
agent's clean files, the normal way, and `--all` goes on, previewing the agents
after it again. Anything short of that changes nothing in your tree, and odw
says why. `--confirm` shows the resolved diff and asks y/N first (at a
terminal). The resolver is a real run — `origin: "apply-resolve"`, with
`applyResolve: { runId, agentId }` in its meta.json; `odw apply` prints its id,
and `odw diff`, `odw logs`, `odw compare` and the dashboard work on it — linked
from the run applied by `resolvedBy` in its meta.json and an `apply_resolved`
event (`outcome`: applied, refused, declined or interrupted). `--resolve` never
goes with `--force` or `--check`: a path with uncommitted changes in the way is
refused as ever. (ODW extension.)

`--pr` (with `--agent` or `--all`) opens a pull request instead of touching your
working tree — which it never reads or writes, so uncommitted work there stays
put and stays out of the PR. odw makes a branch `odw/<run>-<label>` (`odw/<run>-all`
with `--all`; `-2`, `-3`, … when the name is taken here or on the remote) from
`--base <branch>` — else from the commit HEAD is on, targeting HEAD's branch — in
a temporary worktree, previews and applies each agent there exactly as above
(`--verify` runs there), and commits each agent on its own under **your** git
identity and signing settings; the message names the workflow, the agent, the
diff stat, the run id and the agent's cost when its CLI reported one. An agent
that would conflict, or fails its verify, stops it before the push: the branch is
deleted and nothing leaves the machine. Then it pushes to `--remote` (default
`origin`) and runs `gh pr create --repo <owner/name of that remote>` — a **draft** unless `--ready`, titled
`--title` or after the workflow and agent — with the run summary as its body:
the agents and their commits, the phases, the spend receipt as a table, the
verify result and the `odw diff` commands. Without `gh`, or with `gh` not logged
in, it stops after the push and prints the compare URL. **It never merges.**
(ODW extension.)

- **`keep: true`** (an `agent()` option) or **`keepBranches: true`** (config) also
  commits the change to a branch `odw/<runId>/<agentId>-<label>` of the source
  repository — by `odw <odw@localhost>`, on top of the commit the agent started
  from — to check out, merge or cherry-pick. ODW only creates that branch: your
  HEAD, index and other branches are never touched. `keep: false` opts one agent
  out of `keepBranches`.
- **`maxDiffBytes`** (default 2 MB) caps a stored diff: past it, the head is kept,
  cut at a line, with one final `# odw: diff truncated …` line. The counts still
  describe the whole change; `odw apply` refuses a cut diff — use the branch.
- A binary file is named in the diff by its object id, not carried in it; git
  applies it from the repository's object store, where ODW wrote it (a kept
  branch pins it for good).
- A failed agent keeps its diff too (the work of one that timed out), and `odw
  resume` brings a replayed agent's diff into the new run. A stopped run keeps none.

```jsonc
{
  "maxDiffBytes": 2097152, // bytes of one agent's diff kept in the run directory
  "keepBranches": false,   // true: every isolated agent's change also goes on a branch
  "applyVerify": null      // e.g. "npm test": run after each odw apply, which is rolled back if it fails
}
```

### The review queue across runs (ODW extension)

Kept diffs pile up across runs faster than anyone reads them. `odw review` lists
every one nobody has dealt with yet — in every run under the runs root — riskiest
first, and says why each ranks where it does:

```bash
odw review                       # kept diffs not reviewed, dismissed or applied, riskiest first
odw review --since 7d --json     # only runs from the last week, for scripts
odw review --all                 # the marked ones too, with who marked them
odw review mark $RUN 3 reviewed --note "checked the migration"   # or dismissed | applied | open (undo)
```

```
2 kept diff(s) to review, riskiest first

HIGH    7  20261018-090000-ab12cd · agent 3 (fix:auth) · 4 file(s) +120 -30 · triage
        +3  touches CI: .github/workflows/ci.yml
        +3  changed 2 file(s) outside its scope: src/db.ts, src/env.ts
        +1  met its expect only after 1 retry
           odw diff … --agent 3 · odw apply … --agent 3 --check · odw review mark … 3 reviewed
```

The score is deterministic and uses only what the run recorded — no model reads
anything. Points: the size of the change (50 / 300 / 1000 lines: +1 / +2 / +3;
6 / 20 files: +1 / +2); the kinds of path it touches, read from the kept diff —
CI (+3), database migrations (+3), auth or security code (+3), dependency
manifests and lock files (+2), tests (+1, and +2 more for deleted tests), binary
files (+2); a diff cut at `maxDiffBytes` (+2); a `--deadline` that killed the
agent (+3); `expect` misses (+4) and `untouched` violations (+4); another failure
(+3: the change is unfinished work); files outside its `scope` (+3); background
work left running (+2); destructive git commands (+3); a fallback or handoff
(+1); a resolver at `odw apply --resolve` (+1); expect retries (+1) and other
retries (+1); cost of $1 / $5 (+1 / +2). A passed `expect.command` check takes one
off. 0–2 is **low**, 3–5 **medium**, 6 and up **high**. Every point is printed
on the entry (`factors` in `--json`), so the order can be argued with.

Marks go to the run directory's append-only `reviews.jsonl` — `{ ts, agentId,
state, by, via, note? }`, `by` who marked it (as for checkpoint decisions: the
local user, or a named token's name from the dashboard), `via` `cli`,
`dashboard` or `apply`; the last mark of an agent stands. `odw apply` marks each
agent it applied cleanly (or found already applied) as `applied`; `--check`
marks nothing. Runs `odw eval` started and `--resolve`'s resolver runs are not
on the queue. The dashboard's **Review** page (`g r`) shows the same queue with
its reasons, marks entries reviewed or dismissed (loopback only, like every
write — and there, like every write, with any token the server takes, a `read`-scope
one included), and opens an entry in its run's Changes tab; Activity's **Needs you**
says how many wait. `GET /api/review[?since=7d][&all=1]` serves it, `POST
/api/runs/:id/agents/:agentId/review { state, note? }` marks one.

Step by step: [`docs/recipes/review-and-apply.md`](../recipes/review-and-apply.md).

### Outcomes over weeks (ODW extension)

A pass rate says whether one eval passed; it does not say how much of what the
agents produced people actually took. `odw outcomes` counts that across runs, by
week, from what the runs recorded and the review marks — no model judges anything:

```bash
odw outcomes                         # the last 30 days: by week, workflow, adapter and model
odw outcomes --since 12w --workflow triage --json   # --since: at most 156w (three years)
odw outcomes --markdown              # tables, for a PR or a wiki page
```

```
odw outcomes · last 30d · 14 runs

Runs        11 done · 3 failed (timeout 2, script_error 1)
Agents      41 · 4 failed (timeout 3, unmet_expectation 1) · 6 retries over 4 agents · 1 fell back
Kept diffs  12 · 7 applied (58%) · 2 dismissed · 1 reviewed · 2 left
Rework      4 of the kept needed a retry, fallback or resolver (33%) · 1 resolved at apply
Checks      1 missed expect · 0 changed untouched files · 1 wrote outside scope
Spend       $18.40 · 2.1M tokens · per applied change: $2.629

Against the window before
  - applied share of kept diffs 80% → 58% (worse)

By week (UTC, from Monday)
  2026-09-21  3 runs · 0 failed · 2 kept · 2 applied (100%) · 0 dismissed · 0 left · per applied $1.900
  …
By workflow / By adapter / By model   runs (agents) · failed · kept · applied · dismissed · left · reworked · per applied
```

What each count is:

- **kept / applied / dismissed / reviewed / left** — the agents that kept a diff,
  by their last mark in `reviews.jsonl` (`odw apply` marks `applied`; `odw review
  mark` and the dashboard mark the rest); `left` has no mark or was put back `open`.
  Marks are read as they stand now, so a diff applied a week after its run counts
  for that run. Applied is ODW's own mark: a PR's merge state is not read.
- **failed** — failed and stale runs, by the commonest failure reason of their
  failed agents, else `stale` or `script_error`; agents' failures by reason too.
- **rework** — kept diffs that needed a retry (`expect`, rate limit, stall,
  question), a fallback or handoff, or a resolver at `odw apply --resolve`; and
  runs `odw replay` started.
- **per applied change** — everything the row spent (failed agents included)
  over its applied changes: dollars when some agent reported them, else tokens.
- **Against the window before** — the same counts for the window as long just
  before; a share that moves 15 points or more (over at least 5 on both sides) or
  a cost per applied change that moves by half (over at least 3) is called out.

A run counts in the window it was created in. Left out: dry runs, runs still going,
and the runs `odw eval`, `odw test`, `odw conformance` and `odw apply --resolve`
started. Runs `odw pull` copied here count like any other; another machine's runs
root is counted there. A workflow row counts its runs; an adapter or model row counts
its agents and is charged a failed run only when one of its own agents failed in it.
The model is the one the CLI said served the agent, else the one it asked for
(`… (requested)`), else `(CLI default)`. The dashboard's **Review** page opens
with an **Outcomes** card for the last 30 days — applied of kept, a stacked column
per week, what moved, a line per workflow — from `GET /api/outcomes[?since=30d][&workflow=W]`.
