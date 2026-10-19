# Workflow API reference

English · [简体中文](../zh-CN/reference/workflow-api.md)

What a workflow script can call. Every option of every primitive is in the skill's [primitive reference](../../skills/open-dynamic-workflows/references/primitives.md); ODW-only primitives and options are marked **ODW extension**.

## The primitives

A workflow is `export const meta = {…}` followed by a script body that runs in an
async context. The body composes these **injected globals** with ordinary JS
control flow (loops, `if`, dedup) — no imports:

| Primitive | Role |
| --- | --- |
| `agent(prompt, opts?)` | Run one coding agent on a subtask. The only verb that does work. Returns its text, or a validated object when `opts.schema` is set. With `opts.expect` its work is checked — a command exits 0, files changed, the reply matches — and retried, told what it missed; see [Check an agent's work](#check-an-agents-work-odw-extension) (**ODW extension**). |
| `parallel(thunks)` | Run a batch concurrently and wait for all of it (**barrier**). Recoverable failures become `null`; stop, budget, and dispatch-limit errors abort the run. `parallel(thunks, { notes: true })` gives its agents the run's notes board — see [Notes between parallel agents](#notes-between-parallel-agents-odw-extension) (**ODW extension**). |
| `pipeline(items, ...stages)` | Stream each item through the stages independently (**no barrier**). Each stage gets `(prev, item, index)`. |
| `phase(title, opts?)` / `log(msg)` | Group progress under a phase / emit a progress line. `opts` — `{ adapter, model }` — gives the phase's agents an adapter and a model (**ODW extension**; see [per-phase adapters](../guides/adapters-and-models.md#per-phase-adapters-model-tiers-and-fallback-chains-odw-extension)). |
| `schema` (JSON Schema) | A typed output contract for `agent`; the reply is validated and retried until it conforms. A keyword ODW cannot check is reported in the run's log (or, with `"schemaKeywords": "strict"`, fails the call), and CLIs that validate schemas (`claude`, `codex`) enforce it natively — see [Structured output](../guides/adapters-and-models.md#structured-output-odw-extension). |
| `args` | The workflow's input, injected verbatim. |
| `budget` | `{ total, spent(), remaining() }` — scale depth to a token target. |
| `workflow(ref, args?)` | Run another workflow inline (one level deep). The child shares this run's concurrency cap, agent counter, and budget; its phases group as their own DAG lanes. |
| `validate(source)` | Parse and compile-check trusted source without running its workflow body. Metadata is parsed as a pure literal, never evaluated. **ODW extension** (not in Claude Code's dialect). |
| `exec(command, opts?)` | Run a command — tests, a build, a linter — without launching a model; resolves to `{ stdout, stderr, exitCode, signal, timedOut, truncated, durationMs }`. A string runs through the shell, an array as argv. Bounded by `timeout` (600 s) and `maxOutputBytes` (8 MiB per stream); a stop kills it. Takes no agent slot. **ODW extension** (not in Claude Code's dialect). |
| `checkpoint(title, opts?)` | Pause the run until a person approves — perhaps with an edited payload — or rejects, from `odw approve\|reject` or the dashboard, and resolve to `{ approved, note, by, payload, edited }`. `opts`: `payload` (what to look at), `schema` (what an edit must match), `timeout` (seconds) and `onTimeout` (`"approve"`, `"reject"`, or the default `"fail"`). Takes no agent slot; a stop still ends the run. See [Human checkpoints](../guides/checkpoints-and-questions.md#human-checkpoints-odw-extension). **ODW extension** (not in Claude Code's dialect). |

Use **`parallel`** when the next step needs the whole batch at once (dedup,
tally, synthesis); **`pipeline`** for multi-stage work (the default). Keep
reductions order-independent — branching on *which agent finished first* breaks
reproducibility. Full reference: [`skills/open-dynamic-workflows/references/primitives.md`](../../skills/open-dynamic-workflows/references/primitives.md).

### Check an agent's work (ODW extension)

A headless agent can "succeed" without doing the work: it says it fixed the bug
and never touched a file, or that the tests pass while they are still red. Rather
than asking the model whether it did it, say what must hold — odw checks it once
the agent has replied (and its `schema`, if any, validated):

```js
const summary = await agent('Fix the failing tests in src/parser.', {
  expect: {
    command: 'npm test',        // must exit 0 in the agent's workspace (timeout: 600 s)
    changes: true,              // some file must change (false: none may)
    files: ['src/parser/**'],   // each glob must match a file it changed or created
    match: '^Fixed',            // a regular expression the reply must match
    mcp: ['github'],            // MCP servers its CLI must have started it with (claude)
    untouched: ['test/**', '**/*.snap', '.github/**'], // no file matching these may change
  },
})
```

Work that misses runs again — once by default (`expectRetries`, per call or in
the config) — with what it missed appended to its prompt, a failed command's
output included. If it still misses, `agent()` throws a recoverable error (a
`null` slot in `parallel()`) carrying `reason: "unmet_expectation"` and `misses`,
one line per check — as do its `agent_failed` event, `odw logs`, the live view
and `/api/runs/:id`:

```text
agent_failed    (Fix) fixer — [unmet_expectation] did not meet: `npm test` must exit 0, and it exited with code 1
```

- **What the agent changed** is read from git, relative to its workspace. In
  place, it is what differs from the source tree as it was before the agent
  started — your own uncommitted edits and odw's run directory are left out, the
  agent's commits count — so edits another in-place agent makes meanwhile count
  too: isolate when that matters. With `isolation: "worktree"`, it is the change
  odw keeps as the agent's diff, and a retry starts over in a fresh worktree
  whose change replaces the earlier one.
- **The command** runs as an `exec()` step under the agent (its events carry
  `forAgentId`), after the change is read, so what it writes is never the
  agent's work; a stop kills it.
- **With a [fallback chain](../guides/adapters-and-models.md#per-phase-adapters-model-tiers-and-fallback-chains-odw-extension),**
  a miss is retried on the adapter whose work missed — never a reason to fall
  back. A call that moves on (a spent quota, a refused login) keeps its `expect`:
  the next adapter starts the work over with its own `expectRetries` — isolated,
  in a fresh worktree; in place, judged against the tree as it was before the
  call began.
- **Refused tool calls count as a miss.** Under the default `edit` tier, Claude
  Code refuses headless every shell command that is not allowlisted; with
  `expect` set, a reply whose `result` lists `permission_denials` is handed back
  like any miss, then fails with `reason: "permission"`, naming the refused
  calls. Without `expect` the reply stands — see below.
- **Without opting in:** an empty reply fails with `reason: "empty_reply"`
  (`allowEmpty: true` accepts one). A reply that stood though the CLI refused it
  tool calls keeps them as `denied` on the agent's `agent_finished` event, its
  saved result and `/api/runs/:id`, and the run logs one line:
  `search:3: Claude Code refused 2 tool calls — Bash (npm test); …; its reply may
  rest on work it could not do (raise its tier with --permissions or allowlist
  the tool)`. `"permissionDenials": "fail"` (or an adapter's own
  `permissionDenials`) fails such agents with `reason: "permission"` instead.
- **MCP servers that did not start.** Claude Code's stream begins with an init
  event listing the MCP servers it started the agent with; one that failed leaves
  the agent without its tools, and it may still say "done". Every server that is
  not `connected` is kept as `mcp: [{ name, status }]` on the agent's
  `agent_finished` (or `agent_failed`) event, its saved result and `/api/runs/:id`,
  and the run logs it once per server and status: ``MCP server github failed to
  start (claude agent `fix-auth`): its tools were unavailable``. The reply stands —
  Claude Code itself only warns — unless `"mcpFailures": "fail"`, which fails an
  agent whose server `failed` or `needs-auth` with `reason: "mcp_unavailable"`.
  `expect: { mcp: [...] }` makes a listed server that is not there — `failed`,
  `needs-auth`, `disabled` or not configured — a miss, retried and then
  `unmet_expectation`. `pending` is neither: Claude Code's docs say not to treat it
  as a failure (servers from `.mcp.json` usually start that way and connect in the
  background).
- **Protected paths stay untouched.** Agents game the checks they are judged by:
  to get green they edit, skip or delete the tests. `untouched` lists globs (as
  `files`: `*` stays within a directory, `**/*.snap` finds one at any depth) that
  no file the agent changed, created or deleted may match — read like `changes`,
  so in place your own edits made before the call do not count. A touched path is
  a miss naming it — ``no file matching "test/**" may change, and 1 did:
  test/add.test.js`` — and the retry is told to restore it.
- **Background work left running.** In headless mode the agent can start a
  background shell command (`run_in_background`) or subagent, end its turn and
  exit: the work dies with the CLI while the result says success
  ([claude-code#85129](https://github.com/anthropics/claude-code/issues/85129)).
  odw follows Claude Code's stream-json task events (`task_started`,
  `task_updated`, `task_notification`) and the background tool calls; work still
  open at the `result` event is kept as `orphaned` on the agent's
  `agent_finished` event, its saved result, `/api/runs/:id` and the dashboard
  drawer, and the run logs one line per agent: `serve:1: Claude Code ended its
  turn with 1 background task still running — Bash (Start the dev server); it
  died when the CLI exited, …`. The reply stands (the default
  `"orphanedBackground": "warn"`); `"orphanedBackground": "fail"` fails such agents
  with `reason: "orphaned_background"`, and with `expect` set it is a miss —
  handed back (“wait for every background command and subagent to finish before
  you reply”), then `orphaned_background`. Any JSONL adapter can declare its CLI's
  background events with `output.background` (see the adapters reference).

Claude Code's Workflow tool ignores `expect`, so there the checks do not run.
[`examples/fix-until-green.js`](../../examples/fix-until-green.js) lets `expect` run a
fix-until-the-tests-pass loop.

### Notes between parallel agents (ODW extension)

Parallel coding agents produce changes that pass alone and break together: one
renames a function another still calls. Told what the concurrent change was,
they mostly avoid it — so odw gives a run a **notes board**, off unless asked for:

```js
const lanes = await parallel(tasks.map((t, i) => () =>
  agent(t, { label: `lane-${i + 1}`, isolation: 'worktree' })), { notes: true })
const review = await agent('Which lanes clash?', { notes: true, schema: CLASHES })
```

- **On for:** `agent(…, { notes: true })`, every agent a `parallel(thunks, { notes: true })`
  starts, or every agent of the run with `"notes": true` in the config.
  `notes: false` opts one agent out. Off by default: a Claude Code workflow runs
  exactly as written.
- **Posting:** an agent with notes on gets `ODW_NOTES`, the path of a small shell
  script of its own, and its prompt says how to use it: `"$ODW_NOTES" "renamed parseX
  → parse"` posts a note; `odw note "…"` does the same where odw is installed (it
  reads the agent's `ODW_RUN_ID`, `ODW_AGENT_ID` and `ODW_NOTES`). Who posted a note
  is the agent whose script dropped it, never what the note says.
- **Reading:** the notes posted before an agent started are in its prompt, under
  "Notes from the other agents in this run" (the latest that fit 8000 characters).
  A running agent is not sent new notes — a CLI takes its prompt once — but
  `"$ODW_NOTES"` alone prints the board as it is now, and the prompt says so.
- **Interface broadcast:** when an agent with notes on and `isolation: "worktree"`
  finishes with a kept change, odw posts a note for it before its `agent_finished`
  event, so the agents the script starts next see it: its diff stat, the files
  it touched, and the lines its diff added or removed that look like declarations
  (`export`, `def`, `func`, `pub fn`, `class`, `interface` — a cheap heuristic for
  every language, at most 12 lines).
- **Bounds:** each note is cut at 2000 characters and redacted like the run's
  events; the board holds 200 notes and 256 KiB, and the run says once when it is
  full. Notes are kept in the run directory as `notes.jsonl`.
- **In a container sandbox** the script works unchanged: the agent's own inbox is
  bound read-write, its script and the board read-only — no other agent's inbox is
  there to write to. The worker takes only regular files from an inbox that is a real
  directory where it made it, never following a link or waiting on a FIFO, so nothing
  an agent plants there makes the host read or delete a file elsewhere.
- **Seeing them:** `odw notes $RUN [--json]`, `note_added` events in `odw logs`, and
  `GET /api/runs/:id/notes`.

Claude Code's Workflow tool ignores these options. [`examples/coordinated-refactor.js`](../../examples/coordinated-refactor.js)
splits a change across isolated lanes on the board, has a reviewer read it, and
runs the lanes that clash again with every note in their prompt.

### Workflow memory (ODW extension)

Every run starts cold: a correction a person made in one run is violated again in
the next. Workflow memory keeps what earlier runs of a workflow learned **in the
repository**, as `.odw/memory/<workflow>.jsonl`, so it is reviewed in pull requests
like any other file. It is off unless asked for, and nothing in it comes from a model
summarizing — only from explicit sources:

| Source | Entry |
| --- | --- |
| `"$ODW_NOTES" --keep "…"` or `odw note --keep [--paths GLOB,…] "…"` (an agent with notes on) | `note`, by that agent — kept only when that agent has memory on (else posted, not kept, and said) |
| a `checkpoint()` rejected with a note | `correction`: `"Ship the plan?" was rejected: <note>` |
| a `checkpoint()` approved with an edited payload | `correction`: a structural diff of the edit, `$.steps[1]: "b" → "c"; removed $.owner` |
| an `expect` miss that a retry of the same agent then met | `lesson`: what was missing, and that a retry told of it fixed it (with the change it kept) |
| `odw memory add <wf> "…" [--paths GLOB,…]` | `note` (or `--kind correction\|lesson`), by hand |

Each line is `{ id, text, kind, paths, commit, run, agent?, at }`: `commit` is HEAD
when it was learned, `paths` the globs (from the repository's top) it is about.
Every entry is kept only where memory is on — `"memory": true` in the config,
`agent(…, { memory: true })` for that agent's kept notes and lessons, `checkpoint(…, {
memory: true })` or `{ memory: { paths: ['src/**'] } }` for its corrections.

```js
const plan = await checkpoint('Ship this plan?', { payload: draft, memory: { paths: ['src/api/**'] } })
await agent('Implement the approved plan.', { memory: true, expect: { command: 'npm test' } })
```

- **Recall:** an agent with memory on (`agent(…, { memory: true })`, or the setting;
  `memory: false` opts one out) finds the entries that still apply ahead of its task,
  under "What earlier runs of this workflow learned", newest first, at most 4 KB, each
  labelled with its kind and where it came from (run and agent, or "by hand") and its
  text quoted (`> ` on every line). The run's log says how many it recalled and how
  many it left out.
- **Staleness:** an entry is stale once a file its `paths` match changed between its
  `commit` and HEAD (`git diff --name-only <commit> HEAD`); stale entries are not
  recalled. An entry without paths never goes stale; one with paths whose commit git
  does not know is stale — nothing vouches for it. At most 32 distinct commits are
  checked per file (the newest entries' first); entries at others count as stale. A
  file over 4 MiB is not read: the run, `odw memory list` and the API say so.
- **Kept when the run ends** — done, failed or stopped — redacted with the run's
  redactor. The same entry learned again replaces the older copy; a file holds at most
  500 entries, the oldest pruned with a line in the run's log. `odw test` and `--dry`
  runs recall but keep nothing.
- **Untrusted runs** neither recall nor keep the repository's memory: the file is the
  repository's content, and what an untrusted run learned would reach later trusted
  runs' prompts. Memory the user keeps outside the repository — `"memoryDir":
  "~/odw-memory/my-repo"` in their own config — is theirs, and an untrusted run uses it:
  only when it is outside the repository both as written and with links resolved,
  and never a `memoryDir` the repository's own config sets.
- **Tending it:** `odw memory list [<wf>] [--stale] [--json]`, `odw memory add <wf>
  "text" [--paths …]`, `odw memory prune [<wf>] --stale` or `odw memory prune <wf> --id
  N` (`--source DIR` picks the repository); `GET /api/memory[?workflow=]` serves the list.

Claude Code's Workflow tool ignores these options.

### Declared scopes (ODW extension)

Two agents pointed at the same files produce changes that conflict only at merge
time. Declaring up front which files each agent means to change lets odw keep
them apart — mostly by running the ones that collide one after the other:

```js
await parallel([
  () => agent('Refactor the login flow.', { label: 'refactor-login', scope: ['src/auth/**'] }),
  () => agent('Fix the token expiry bug.', { label: 'fix-auth', scope: ['src/auth/token.ts'] }),
  () => agent('Document the parser.', { label: 'docs', scope: ['docs/parser.md', 'src/parser/**/*.md'] }),
])
```

- **`scope`** is a list of globs relative to the agent's workspace, with the
  `expect` glob rules (`*` within a directory, `**` across them, `{a,b}`, `[…]`).
  A call without one behaves as before.
- **Overlapping scopes run one after the other.** A scoped call made while an
  earlier scoped call whose scope overlaps has not settled waits for it — holding
  no slot — and the run logs the wait once: `fix-auth waits for refactor-login:
  fix-auth declares src/auth/token.ts, refactor-login src/auth/**` (or `both
  declare src/auth/**`; the log event carries `scopeWait: { for, globs }`). The
  others keep running. This holds for any calls in flight at once — a
  `parallel()` or `pipeline()` fan-out, or calls started without `await` — and a
  call only ever waits for calls made before it. In the example, `fix-auth` runs
  once `refactor-login` is done, while `docs` runs beside them.
- **How overlap is decided** — from the globs alone, conservatively (in doubt they
  overlap, which only serializes): `{a,b}` alternatives are expanded; two literal
  paths overlap when they are the same path; a literal path and a glob when the
  glob matches the path; two globs when the literal prefix of one (the text before
  its first wildcard) starts with the other's. So `src/auth/**` and
  `src/auth/*.ts` overlap, `src/auth/**` and `src/db/**` do not, `src/*.ts` and
  `src/*.md` do (the part after a wildcard is not compared), and `**` overlaps
  everything.
- **Writes outside the scope are flagged.** Once the agent replied, what it changed
  — read as `expect` reads it: an isolated agent's worktree, an in-place agent's
  changes since its call began — is compared with its scope. Files outside it are
  kept as `outOfScope` on its `agent_finished` (or `agent_failed`) event, its saved
  result, `/api/runs/:id`, `odw agents` (`[outside scope: …]` before the value;
  `--json` has `scope` and `outOfScope`) and the dashboard drawer, and logged:
  `fix-auth:2: wrote 1 file outside its scope (src/auth/token.ts) — package.json`.
  With notes on (see [Notes between parallel agents](#notes-between-parallel-agents-odw-extension))
  the board gets a note of them too, so the agents the script starts next know.
- **`scopePolicy`** — per call, else the `"scopePolicy"` setting — is `"warn"` by
  default: the reply stands. `"fail"` fails such an agent with
  `reason: "out_of_scope"`, not retried. With `expect` set, a write outside the
  scope is a miss either way: handed back to the agent (restore those files, keep
  the change inside the scope), then `unmet_expectation`. The run's setup records
  `scopePolicy` for `odw compare`.
- **In place**, the tree is shared: a file inside the scope of another scoped call
  that ran at the same time is that call's, and is not counted against this one.
  Edits by unscoped calls running beside it still count — isolate for an exact
  answer. Outside a git repository nothing can be read: the agent runs, unchecked,
  and the run says so.

Claude Code's Workflow tool ignores `scope` and `scopePolicy`: there the calls run
together as written.

## Check the input, count the nulls (ODW extension)

Two small mistakes make a workflow succeed at doing nothing: `args` of the wrong
shape (an array that arrived as a string of JSON fans out over its characters), and
a fan-out that came back mostly `null` carried on as if it had worked.

**`meta.input`** declares the shape of `args` as a JSON Schema — the subset
`agent()` schemas are checked with (`type`, `enum`, `properties`, `required`,
`additionalProperties: false`, `items`, `minItems`; `description` and `default` are
shown, never applied). Any other keyword is refused when the workflow loads, so
nothing declared goes unchecked. Claude Code ignores `meta.input`.

```js
export const meta = {
  name: 'triage',
  description: 'Triage the open issues of some repositories',
  input: {
    type: 'object',
    properties: { repos: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'owner/name' } },
    required: ['repos'],
  },
}
```

`odw run`, `rerun` and `resume`, a schedule (checked at `odw schedule add` too) and a
trigger (answered `422`) check `args` before the run exists, and name every path at
fault — `$.repos: expected array, got string — it looks encoded twice: the string holds
JSON (an array); pass the array itself, not a string of it`. odw never decodes it for
you. `odw run triage --help` prints what the workflow takes. A nested `workflow()`
call is not checked.

**Fan-out health.** Every `parallel()` and `pipeline()` that settles writes a
`fanout_done` event — how many slots came back ok, failed (by failure reason:
`rate_limit`, `timeout`, …) or `null` — which `odw logs`, the live view and the
dashboard (a chip on the run, amber when one came back mostly null) show. When over
half of one is null, the run logs a line saying so. `parallel(thunks, { minOk })`
turns that into an error: a count, a fraction of the thunks (`0.8`) or `"all"` — fewer
ok results and the call throws a `FanOutShortfall` with the counts instead of
resolving. Without `minOk` nothing changes: failed slots are `null`, as in Claude Code.

`odw check` adds two hints for the same mistakes, never failing the check: a
`parallel()`/`pipeline()` result put through `.filter(Boolean)` whose length nothing
checks, and a list chosen by matching what an agent wrote (a `.filter()` on one of
its fields) whose emptiness nothing checks — when the agent's text matches nothing,
the steps over that list do nothing, and the run reads as if they passed.
