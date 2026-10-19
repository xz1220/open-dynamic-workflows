# Dialect conformance suite

The behaviour of Claude Code's workflow dialect, as runnable cases: one script
must run the same on Claude Code's Workflow tool, on ODW, and on any runtime
that implements the dialect. Each case is a plain workflow script with the
result it must produce. A script that keeps to what the documented cases pin
down runs on both; the unspecified ones mark where runtimes may differ.

The cases use the dialect only — `export const meta`, `agent`, `parallel`,
`pipeline`, `phase`, `log`, `args`, `budget`, `workflow` — and no ODW extension
(no `exec`, `checkpoint`, `validate`, `expect`, adapter lists, phase options).
Their agents are scripted: a deterministic mock agent answers each prompt from
a table in the case, so every result is exact.

## Run it on ODW

```bash
odw conformance                    # every case, a line each; exit 1 if any failed
odw conformance --case 6           # one case, by number (6 or 06) or name (06-parallel-order); repeatable
odw conformance --json             # the report as JSON
odw conformance --dir path/to/suite   # another suite directory in this format
```

Each case runs as a real odw run — worker, scheduler, bridge — in a scratch
run store, with a single adapter, `mock`, whose command is
`node mock-agent.mjs <the case's table>`. The run's source directory is the
case's directory, so agents run there and `workflow({ scriptPath })` resolves
against it. Exit codes: 0 when every case passed, 1 when any failed
(unspecified cases included: they pin what ODW does), 2 for a usage error (an
unknown case, a suite or `expected.json` that breaks the format — nothing ran).

The `--json` report: `{ version: 1, odwVersion, suite, passed, failed, cases:
[{ case, number, title, claudeCode, passed, failures, state, durationMs }] }`,
`failures` holding one line per expectation the case missed.

The suite ships with odw (`conformance/` in the npm package); a standalone
binary carries none — pass `--dir` with a checkout's `conformance/` (and have
`node` on PATH for the mock agent). CI runs `odw conformance` on every push.

## Layout

```
conformance/
  README.md          this file
  mock-agent.mjs     the deterministic mock agent
  cases/
    NN-slug/
      slug.js        the case's workflow script (meta.name is the slug)
      expected.json  inputs, the mock table, and what must come out
      *.js           any child workflow the case runs with workflow({ scriptPath })
```

`NN` orders the cases and is what `--case N` selects; numbers are unique.

## expected.json

| Key | Required | Meaning |
| --- | --- | --- |
| `title` | yes | What the case shows, in one line. |
| `claudeCode` | yes | `"documented"`: the behaviour follows from the dialect's documentation. `"unspecified"`: Claude Code's docs do not settle it; the case records what ODW does. |
| `sources` | yes | Where the behaviour is described: repository paths, optionally with an anchor or section (`docs/dynamic-workflows-research.md §3.2`). |
| `notes` | for `unspecified` | What is not documented and what ODW does; any other caveat (running by hand). |
| `args` | no | The workflow's input, any JSON value. Absent: the run is given none. |
| `budget` | no | The run's token target (`budget.total`), a positive integer. Absent: none. |
| `mock` | yes | The mock agent's table (below); `[]` when the case runs no agent. |
| `state` | yes | `"done"`: the script returns a value. `"failed"`: the run fails — a script error. |
| `result` | for `done` | The return value. Compared deep-equal, object key order aside. |
| `error` | no, `failed` only | A substring the run's error message must contain. Only for a message the script itself throws; a runtime's own messages are its own. |
| `logs` | no | Lines `log()` must have emitted, in this order. A runtime may emit lines of its own between them. |
| `phases` | no | Titles `phase()` must have started, in this order; others may come between. |
| `agents` | no | Exactly the agents that must have started — as many, in any order — each `{ label?, phase?, outcome? }` compared on the keys it gives. `outcome` is `"finished"` or `"failed"`; `phase` is the agent's phase (`opts.phase`, else the current `phase()`). `[]`: no agent may start. |

Any other key is a format error.

### The mock table

A list of entries; for each prompt the first entry whose `when` occurs in it
answers:

| Key | Meaning |
| --- | --- |
| `when` | A substring of the prompt. A runtime may add to a prompt (a schema's description, corrective feedback on a retry), so the match is by substring, and the same entry answers every attempt. |
| `reply` | The agent's reply: a string is printed as is; any other value as JSON (a schema call's structured output). |
| `fail` | Instead of a reply, fail: `true` (exit 1), or `{ "exit": <non-zero>, "stderr": "…" }`. |
| `delayMs` | Answer this many milliseconds late, so agents finish in another order than they started. |

Exactly one of `reply` and `fail`. A prompt no entry matches makes the mock
exit 3 naming it, so a case never passes on a reply nobody wrote.

`mock-agent.mjs` is the reference implementation: `node mock-agent.mjs
<table.json>` reads the prompt on stdin and writes the reply on stdout. It
reports no token usage.

## Implementing a runner for another runtime

For each case directory, in number order:

1. Read `expected.json`; reject unknown keys.
2. Make the runtime's agent answer from `mock` — through `mock-agent.mjs`, or
   any equivalent that applies the same rules.
3. Run `slug.js` with `args` (if given) as its input and `budget` (if given)
   as its token target, from the case's directory.
4. Compare: the final state; the return value or the error substring; then
   `logs`, `phases` and `agents` as the table above says.
5. Report each case with its `claudeCode` status. A `documented` case that
   fails is a conformance failure. An `unspecified` case that fails is not:
   report it, as the place where the runtime differs from ODW.

## Running the cases on Claude Code by hand

The case scripts are plain workflow files. Copy a case's `.js` files into a
project's `.claude/workflows/` and ask Claude Code to run the workflow by its
name with the case's `args` as input (and its `budget` as the token target),
then compare what it returns with `result`.

There is no mock agent there: the agents are real models. The prompts are
written so a model can give the table's reply exactly ("Reply with exactly the
text alpha and nothing else.", "Return exactly this structured output: …"),
which makes `result` comparable. Cases that need an agent to fail (their
table has a `fail` entry; their `notes` say so) cannot be reproduced by
prompting — a model cannot be told to fail — and `delayMs` orderings happen
only by chance. `workflow({ scriptPath: './child.js' })` resolves against the
run's source directory on ODW; where Claude Code resolves a relative script
path is not documented, so adjust the path when the child is not found.

## Known divergence, not in the suite

Claude Code's Workflow tool throws on `Date.now()`, `Math.random()` and an
argument-less `new Date()` (they would break its resume journal). ODW runs
them, and its `validate()` and the dual-compat scan warn about them. No case
uses them: a portable script must not.

## The cases

| Case | Behaviour | Claude Code |
| --- | --- | --- |
| [01-agent-text](cases/01-agent-text/) | agent() without a schema resolves to the reply text | documented |
| [02-agent-schema](cases/02-agent-schema/) | agent() with a schema resolves to the validated value | documented |
| [03-agent-failure-caught](cases/03-agent-failure-caught/) | a failed agent() rejects with an Error that try/catch recovers from | documented |
| [04-agent-failure-uncaught](cases/04-agent-failure-uncaught/) | a failed agent() nothing catches fails the run, and nothing after it runs | documented |
| [05-agent-schema-exhausted](cases/05-agent-schema-exhausted/) | a reply that never matches its schema makes agent() reject once the retries are spent | unspecified |
| [06-parallel-order](cases/06-parallel-order/) | parallel() waits for every thunk and returns results in input order | documented |
| [07-parallel-thunk-throws](cases/07-parallel-thunk-throws/) | a thunk that throws becomes null in its slot; parallel() does not reject | documented |
| [08-parallel-agent-fails](cases/08-parallel-agent-fails/) | an agent failure inside parallel() becomes null in its slot | documented |
| [09-parallel-nested](cases/09-parallel-nested/) | nested parallel() calls keep their shape, order and null slots | documented |
| [10-pipeline-stages](cases/10-pipeline-stages/) | pipeline() runs each item through every stage, each stage called with (previous, item, index) | documented |
| [11-pipeline-failure](cases/11-pipeline-failure/) | a failing stage (an agent, or a throw) drops its item to null and skips the item's later stages | documented |
| [12-pipeline-order](cases/12-pipeline-order/) | pipeline() returns results in item order, whatever order the items finish in | unspecified |
| [13-phase-names](cases/13-phase-names/) | phase(title) labels the agents that follow; opts.phase overrides it for one call only | documented |
| [14-log](cases/14-log/) | log(message) emits one progress line per call, in call order | documented |
| [15-budget-arithmetic](cases/15-budget-arithmetic/) | budget.total is the token target; spent() starts at 0 and grows; remaining() is max(0, total - spent()) | documented |
| [16-budget-no-target](cases/16-budget-no-target/) | without a target, budget.total is null and remaining() is Infinity | unspecified |
| [17-budget-estimate](cases/17-budget-estimate/) | spent() counts output tokens; for a CLI that reports none, characters / 4 rounded up | unspecified |
| [18-budget-exhausted](cases/18-budget-exhausted/) | once spent() reaches the target, the next agent() is refused and the run fails, caught or not | unspecified |
| [19-workflow-nested](cases/19-workflow-nested/) | workflow({ scriptPath }, args) runs the child inline with those args and resolves to its return value | documented |
| [20-workflow-one-level](cases/20-workflow-one-level/) | workflow() inside a child workflow throws (one level of nesting); uncaught, the run fails | documented |
| [21-workflow-args-default](cases/21-workflow-args-default/) | a child workflow called without args sees args === null, not the parent's input | unspecified |
| [22-args-object](cases/22-args-object/) | args is the workflow's JSON input, verbatim | documented |
| [23-args-string](cases/23-args-string/) | a string input arrives in args as that string | documented |
| [24-args-absent](cases/24-args-absent/) | without an input, args is null | unspecified |
| [25-meta-pure-literal](cases/25-meta-pure-literal/) | meta as a pure literal (comments, quoted keys, trailing commas) loads and the body runs | documented |
| [26-meta-in-scope](cases/26-meta-in-scope/) | the body can read its own meta as a constant | unspecified |
| [27-meta-not-literal](cases/27-meta-not-literal/) | a meta that is not a pure literal (here, a variable) fails before the body runs | documented |
| [28-meta-missing-description](cases/28-meta-missing-description/) | meta.name and meta.description are required: a meta without a description fails before the body runs | documented |
| [29-script-throws](cases/29-script-throws/) | an uncaught throw in the body fails the run with that message, after the work before it | documented |
| [30-script-syntax-error](cases/30-script-syntax-error/) | a body that does not parse fails the run before any agent starts | documented |
| [31-script-import](cases/31-script-import/) | a top-level import statement fails the run before any agent starts | unspecified |
| [32-parallel-not-thunks](cases/32-parallel-not-thunks/) | parallel() given something other than functions throws, and uncaught, the run fails | unspecified |
| [33-agent-stallms](cases/33-agent-stallms/) | agent(prompt, { stallMs }) sets that agent's stall window: one quiet for longer fails, one given more time replies | documented |

## Adding a case

Take the next number, write `slug.js` in the dialect only, and an
`expected.json` citing where the behaviour is described. When nothing in the
dialect's documentation settles it, mark it `"unspecified"` and say in `notes`
what ODW does — do not guess what Claude Code does. `npm test` checks every
case: it runs green on ODW, uses no ODW extension, has a pure `meta` wherever
it loads, and cites sources that exist.
