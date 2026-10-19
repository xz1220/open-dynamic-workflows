# Tutorial: from a template to your own workflow

English · [简体中文](zh-CN/tutorial.md)

The README's [quick start](../README.md#quick-start) runs a template for $0. This page goes on from there: the templates `odw new` writes, editor completion for workflow scripts, and the runnable examples to copy from. Next: the [workflow API](reference/workflow-api.md) and the [guides](README.md#guides).

## Start from a template (ODW extension)

`odw new` writes a workflow from a template built into the binary, so a binary-only
install has them too; `odw new` alone lists them.

```bash
odw new review-swarm                    # .odw/workflows/review-swarm.js, .odw/tests/…, .odw/evals/…
odw new review-swarm --name pre-merge   # the same, named pre-merge (in the workflow, its test and its eval)
odw new hello --force                   # replace files that exist with other content
odw new hello --yes                     # also write the suggested .worktreeinclude (below)
```

| Template | What it does |
| --- | --- |
| `hello` | two agents describe the repository in parallel; plain JS keeps the more confident answer (read-only) |
| `review-swarm` | review a change through several lenses in parallel, verify every finding, keep what survives |
| `fix-until-green` | an agent fixes a red test suite; odw runs the suite to check it (`expect`) and hands misses back |
| `plan-approve-execute` | draft a plan, wait at a `checkpoint()` for a person, then execute its steps in parallel |
| `pr-shepherd` | take a pull request to green: fix red CI and new review comments, push, ask before marking it ready |
| `fan-out-reduce` | draft N answers in parallel, then synthesize the single best one |

- **What it writes**, in the current directory: `.odw/workflows/<name>.js` (`odw run
  <name>`), `.odw/tests/<name>.json` — starter cases with scripted replies, so `odw test
  <name>` passes at once, for $0 — and, for `review-swarm` and `pr-shepherd`, an eval
  skeleton `.odw/evals/<name>.json` (real runs: edit it before `odw eval <name>`). The
  templates other than `hello` are the [examples](../examples/) of the same name.
- **It never overwrites** a file that exists with other content without `--force`: it
  then writes nothing at all and exits 1. A file that already holds exactly the template
  counts as written, so the same command twice is harmless.
- **In a git repository without a `.worktreeinclude`**, it prints one for
  [isolated worktrees](guides/reviewing-and-applying.md#isolated-worktrees-and-agent-ports): the repository's `.env*`
  files (not `.env.example` and the like), and `symlink:` lines for the dependency
  directories its lockfiles imply (`node_modules` for npm, yarn, pnpm and bun; `.venv`
  for uv, Poetry, Pipenv and PDM; `vendor` for Composer). It writes it with `--yes`, or
  when you say yes at a terminal; never otherwise.
- **It also writes what `odw types` writes** (below), so the editor completes the new
  workflow at once; `--no-types` leaves that out.
- **`odw init`** (not `--check`) ends with the $0 first run: at a terminal it asks, then
  writes `hello` (unless `.odw/workflows/hello.js` exists — then it runs that one) and
  runs `odw run hello --dry` with its live view, then prints `odw serve --open` and the
  real `odw run hello`. Off a terminal it only prints the commands.

## Editor completion: `odw types` (ODW extension)

Workflow scripts get the primitives as globals, so an editor knows nothing of `agent()`
and its options — unless the dialect's declarations are in the project. `odw types`
writes them, from a copy built into the binary (a binary-only install has them too):

```bash
odw types                 # .odw/types/odw.d.ts + .odw/jsconfig.json (+ .claude/workflows/jsconfig.json)
odw types --dir editor    # the declarations and jsconfig.json under editor/ instead
odw types --force         # also replace a jsconfig.json that is not odw's
```

- **`.odw/types/odw.d.ts`**: the declarations, the odw version that wrote them in the
  header. Each ODW extension carries `@remarks ODW extension`, so hovering an option
  tells Claude Code's dialect from what only ODW reads.
- **`.odw/jsconfig.json`**: `include` covers the declarations, `.odw/workflows/**/*.js`
  and `.claude/workflows/**/*.js`. When `.claude/workflows` exists it gets its own
  `jsconfig.json` too, since an editor uses the config nearest a file. A `jsconfig.json`
  odw did not write is left as it is, and the `include` it needs is printed instead.
- **`checkJs` stays off**: a type checker reads the dialect's top-level `return` as an
  error (TS1108). Put `// @ts-check` atop a script to have it checked anyway.
- **After an upgrade**, `odw doctor` warns when `.odw/types/odw.d.ts` no longer matches
  this odw's declarations; `odw types` rewrites it. Nothing is compiled or checked by odw.
- **Never through a symlink**: a file that is a symlink, or under a directory that is
  one (from the project down), or whose directory resolves outside the project, is not
  written — `odw types` says which and exits 1. Each file is written to a temporary
  file renamed over it.

## Examples

Runnable, plain-JS workflows in [`examples/`](../examples/):

| Workflow | Pattern |
| --- | --- |
| [`deep-research.js`](../examples/deep-research.js) | fan-out research → adversarial fact-check → cited report |
| [`deep-research-verified.js`](../examples/deep-research-verified.js) | the battle-tested variant: scope → search → fetch → 3-vote verify → cited synthesis, with a cron-ready wrapper ([recipe](recipes/deep-research-verified.md)) |
| [`ultra-mode.js`](../examples/ultra-mode.js) | disciplined deep-work loop: plan → parallel attack → adversarial review → synthesize |
| [`fan-out-reduce.js`](../examples/fan-out-reduce.js) | draft N in parallel → synthesize the best |
| [`adversarial-verify.js`](../examples/adversarial-verify.js) | surface findings → keep only those that survive refutation |
| [`review-swarm.js`](../examples/review-swarm.js) | map a change set → review it through N lenses in parallel → verify every finding (optionally on another CLI) → ranked, evidenced report |
| [`loop-until-dry.js`](../examples/loop-until-dry.js) | loop fanning out finders until K dry rounds |
| [`routing.js`](../examples/routing.js) | classify the request → route to a specialist → grade the result |
| [`generate-and-filter.js`](../examples/generate-and-filter.js) | generate many ideas in parallel → dedupe → keep only rubric-passers |
| [`tournament.js`](../examples/tournament.js) | N approaches attempt the task → pairwise judging bracket → one winner |
| [`codex-claude-loop.js`](../examples/codex-claude-loop.js) | two rival CLIs in a turn-based duel: Claude implements, Codex reviews, repeat until sign-off |
| [`agent-daily-digest.js`](../examples/agent-daily-digest.js) | discover sources → extract in parallel → synthesize → verify |
| [`test-fix-loop.js`](../examples/test-fix-loop.js) | run the tests with `exec()` → an agent fixes the failures → re-run until green (ODW only) |
| [`fix-until-green.js`](../examples/fix-until-green.js) | the same loop with `expect`: odw runs the tests after the agent replies and hands a red suite — or a "fix" that changed nothing — back to it, then fails with what it missed (ODW only) |
| [`plan-approve-execute.js`](../examples/plan-approve-execute.js) | an agent drafts a plan → a person approves it at a `checkpoint()` (a rejection with a note re-plans) → parallel execution → report (ODW only) |
| [`pr-shepherd.js`](../examples/pr-shepherd.js) | a PR number → wait for CI with `gh` → an isolated fixer takes red checks and new review comments, checked by `expect` → the fix is pushed to the PR branch → a `checkpoint()` before `gh pr ready`; never merges, cron-ready with `odw schedule` (ODW only) |
| [`coordinated-refactor.js`](../examples/coordinated-refactor.js) | isolated lanes change one repo in parallel on a notes board, each one's interface changes broadcast as it lands → a reviewer names the lanes that clash → they run again knowing what the others changed (ODW only) |
