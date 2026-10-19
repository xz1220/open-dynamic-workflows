# Concepts: how ODW works, and what it shares with Claude Code

English · [简体中文](zh-CN/concepts.md)

Why ODW is built the way it is: the layers from `odw` down to an agent CLI, and how far the Claude Code dialect carries over (the conformance suite pins it down).

## How it works

```
odw (CLI) ─▶ runtime (background worker + run directory)
               └─ loads & transforms ─▶ workflow script (.js, Claude dialect)
                                         └─ injected primitives ─▶ scheduler (async cap + agent backstop)
                                             agent() ─▶ bridge ─▶ adapters ─▶ real CLI subprocess
                                                         ├─ workspace (isolation + diff)
                                                         └─ schema (validate / retry)
```

Two design points are worth calling out:

- **The loader is the crux.** Claude's dialect is neither a normal ES module nor
  a plain script: `export const meta` sits up top, and the body uses top-level
  `await` *and* top-level `return` while referencing injected globals. The loader
  extracts `meta` (with a string/comment/regex-aware scan), strips the `export`,
  and wraps the body in an async function whose parameters *are* the primitives —
  so the body's `return` becomes the workflow's result.
- **No threads.** The engine is async to the core. `agent()` is just an async
  subprocess call, so `parallel` is `Promise.all`, `pipeline` is per-item async
  chains, and the concurrency cap is a small async semaphore — `min(16, cpus-2)`
  by default, with a hard backstop on total dispatches per run.

| Path | Layer |
| --- | --- |
| `src/adapters/` | L1 — uniform CLI invocation (config, placeholders, runner, built-ins) |
| `src/bridge.ts` | L2 — one `agent` call → one CLI run, with schema handling |
| `src/scheduler.ts` | L3 — bounded async concurrency + total-agent backstop |
| `src/primitives.ts`, `src/schema.ts` | L4 — the injected primitives + the data contract |
| `src/loader.ts` | the transform that turns a workflow script into a runnable form |
| `src/runtime/` | L5 — background worker, run directory, control |
| `src/cli.ts` | L6 — the `odw` command |
| `src/workspace.ts` | cross-cutting — workspace isolation and diff |
| `src/changes.ts` | cross-cutting — what isolated agents changed, kept as diffs and branches |

Workflow scripts stay **plain `.js`** and are never compiled; the engine is
written in **TypeScript** (compiled to ESM, **zero runtime dependencies**) and
ships `.d.ts` authoring types so script authors get editor autocomplete on the
injected globals.

## Compatibility and migration

ODW implements the primitive surface below. Scripts that depend on a host's
private runtime behavior need the following checks before migration:

| Feature | ODW behavior and migration check |
| --- | --- |
| Nested `workflow()` | Implemented for one level, sharing the parent's scheduler, control and budget. Flatten deeper nesting. |
| Model selection | Pass `agent(..., {model})` using that CLI's model ID; an adapter without model routing support emits a note. A `meta.phases` entry's `model` (and `adapter`) is the default for its phase's agents, and `model: "@fast"` picks a tier's model per CLI — **ODW extensions** (see [per-phase adapters](guides/adapters-and-models.md#per-phase-adapters-model-tiers-and-fallback-chains-odw-extension)); a phase's model is a model ID like any other, so use a tier when its agents may run on more than one CLI. `meta.model` stays metadata. |
| `agentType` | Loads the named subagent definition (`.claude/agents/<name>.md` and Claude Code's other locations): its body is the persona, and its `model`, `tools`, `isolation` and `effort` map per CLI — tools only ever lower the tier, and every field not applied is logged (**ODW extension**; see [Agent definitions](guides/adapters-and-models.md#agent-definitions-behind-agenttype-odw-extension)). A name with no definition is a one-line persona. It never selects an adapter. |
| Worktree isolation | Starts from committed HEAD, excludes uncommitted edits, and cleans up afterward. Changes are not merged and `agent()` returns the reply, not a diff; ODW keeps each isolated agent's change as a diff to review and apply (`odw diff`, `odw apply`, `keep` branches — ODW extensions; see [Review and apply](guides/reviewing-and-applying.md#review-and-apply-what-isolated-agents-changed-odw-extension)). `.worktreeinclude` is honored (ODW copies untracked files too, not only gitignored ones); its `symlink:` lines, `worktreeSetup` and the agents' `ODW_PORT` are ODW extensions — see [Isolated worktrees](guides/reviewing-and-applying.md#isolated-worktrees-and-agent-ports). |
| Budget | Counts output tokens: the CLI's own count where its adapter reports usage (the built-in `claude` and `codex` do — see [Usage and cost](guides/cost-limits-and-quotas.md#usage-and-cost-odw-extension)), else `ceil(chars / 4)` of each reply. Every CLI run counts: schema and rate-limit retries, and failed runs that reported usage. The guard runs before each dispatch and each schema retry; once the target is spent the run ends and agents still running are stopped. |
| JSON Schema | ODW checks the [documented subset](../skills/open-dynamic-workflows/references/primitives.md#schema); `format` is an annotation. Any other keyword (`$ref`, `const`, `oneOf`, `maxItems`, …) still runs: the run's log names it and where it is, and a CLI that validates schemas itself (`claude`, `codex`) enforces it. `"schemaKeywords": "strict"` refuses such calls instead (ODW extension; see [Structured output](guides/adapters-and-models.md#structured-output-odw-extension)). Use explicit object/array types and supported constraints. |
| Script trust | Run trusted scripts only: a run executes the workflow body as ordinary JavaScript. Loading parses metadata as a pure literal without evaluating it; validation and compatibility warnings are not a sandbox. Triggered, plugin and untrusted runs compile the body in a [strict script context](guides/safety-and-trust.md#strict-script-context-odw-extension) — only the primitives and standard built-ins — which is not a sandbox either. |
| Recovery | Every completed `agent()` result is saved as it lands. `odw resume` continues a paused live worker in place; on an ended run (done, failed, stopped, or stale after a crash) it starts a new run that replays each call whose prompt and options are unchanged and runs the rest. `rerun` starts over. See [Resume a run](guides/running-and-observing.md#resume-a-run-odw-extension). |

The supported primitive names do not guarantee full runtime parity.
`validate(source)`, `exec(command)` and `checkpoint(title)` are ODW extensions and
must be removed when targeting a host that does not provide them (`validate()`
warns about `exec()` and `checkpoint()` calls). Recoverable `null` results require an explicit choice: accept a partial
result, retry, or fail when the task requires every item.

**Conformance suite.** [`conformance/`](../conformance/) holds the dialect's behaviour
as runnable cases: plain workflow scripts in Claude Code's dialect, each with an
`expected.json` (its result, and the logs, phases and agents that matter), run on
a deterministic mock agent. `odw conformance [--json] [--case N]` checks this odw
against them (exit 1 on any failure; CI runs it), and `odw conformance --strict` runs
every case in a [strict script context](guides/safety-and-trust.md#strict-script-context-odw-extension) (CI runs that too). Each case says whether Claude
Code's docs settle its behaviour (`documented`) or not (`unspecified`: it pins
what ODW does). Scripts that keep to what the documented cases pin down run on
both. The cases run on Claude Code by hand — they are plain workflow files — and
[`conformance/README.md`](../conformance/README.md) gives the format, so another
runtime can implement a runner.
