# Primitive reference

The primitives are **injected globals** inside a workflow script — never
imported. The script body runs in an async context (top-level `await` and
top-level `return` are legal), with `meta` declared via `export const meta` at
the top (`meta.name` and `meta.description` are required; no other top-level
`import`/`export` may appear in the file).

## agent

```js
agent(prompt, opts?) -> Promise<string | object>
```

Run one coding agent on `prompt`. The only primitive that does real work; every
other primitive organizes calls to it.

- **opts.schema** — a JSON Schema object. When given, the reply is parsed and
  validated, and the agent is retried with corrective feedback until it conforms
  or the retry budget runs out (then the call throws). Without it, the raw reply
  text is returned.
- **opts.label** — a short name for progress display.
- **opts.phase** — overrides the current phase for this one call. Prefer this
  inside `parallel`/`pipeline`, where the global phase is shared.
- **opts.adapter** — which configured CLI to use (e.g. `"codex"`); defaults to
  the config's `defaultAdapter`.
- **opts.model** — a model id forwarded to the adapter's declared model flag
  (e.g. `claude --model …`). If the adapter declares no `flags.model` in config,
  the option is not silently dropped — a routing note appears in the run's logs.
  Model ids do not transfer across CLIs.
- **opts.agentType** — a **persona** injected into the prompt (e.g.
  `"code-reviewer"`), so it works on every CLI. It is **not** an adapter name and
  never affects adapter selection — only `opts.adapter` does.
- **opts.isolation** — `"worktree"` requests isolation; satisfied by the default
  copy-isolated workspace.

Returns the reply text, or the validated object when `schema` is set. Throws on
hard failure (the CLI errored, or the schema never validated). **Inside
`parallel`/`pipeline` a thrown call becomes a `null` slot instead.**

## parallel

```js
parallel(thunks: Array<() => Promise<T>>) -> Promise<Array<T | null>>
```

Run every zero-arg thunk concurrently and **wait for all of them** (a barrier).
Results come back in input order; a thunk that throws yields `null` in its slot,
so one failure does not sink the batch.

Use `parallel` when the next step needs the entire batch at once — dedup, tally,
or a synthesis pass over all results.

```js
const votes = await parallel(
  Array.from({ length: 5 }, () => () => agent('Is X true? yes/no')),
)
const yes = votes.filter((v) => v && v.toLowerCase().startsWith('yes')).length
```

Each thunk must be zero-arg — build them with `.map((x) => () => agent(...))` so
each captures its own value.

## pipeline

```js
pipeline(items, ...stages) -> Promise<unknown[]>
```

Send each item through all stages **independently** — no barrier between stages.
Item B can be in stage 1 while item A is already in stage 3. This is the default
shape for multi-stage work; it avoids the idle time a barrier would impose.

Each stage receives `(previous, item, index)` — take only what you need:

```js
const results = await pipeline(
  files,
  (file) => agent(`Review ${file}`, { schema: FINDINGS }),  // stage 1: (prev = item)
  (review, file) => ({ file, review }),                     // stage 2: (prev, item)
)
```

A stage that throws drops that item to `null` and skips its remaining stages.
`pipeline(items, stage)` with a single stage is just "map this over items
concurrently" — handy when each step itself fans out with `parallel`.

## phase / log

```js
phase(title)    // group following agent calls under a named phase
log(message)    // emit a one-line progress event
```

Both are observation only. `phase` sets a run-global current phase; inside
concurrent sections pass `{ phase }` to `agent` instead, since the global is
shared.

## args / budget

```js
args                                  // the workflow input, injected verbatim
budget // { total: number | null, spent(): number, remaining(): number }
```

`args` is whatever you passed with `--args` (parsed JSON, or a raw string;
JSON-looking input that fails to parse is rejected rather than silently passed
through as a string). `budget.total` is the token target set with
`odw run … --budget <tokens>`, else `null`; scale depth to it, e.g.
`budget.total ? Math.floor(budget.total / 120_000) : 5`.
In v1 `spent()` is a best-effort stub (`0`) and `remaining()` is `total` (or
`Infinity` when no target); real token accounting is a v1.5+ increment.

## workflow

```js
workflow(nameOrRef, args?) -> Promise<unknown>
```

Run another workflow inline. The global is injected for Claude-dialect
compatibility, but it is **not yet implemented in odw** — calling it throws a
clear "not implemented" error. Compose with `agent`/`parallel`/`pipeline`
instead for now.

## schema

A schema is a plain **JSON Schema object** passed to `agent`:

```js
const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, severity: { type: 'string', enum: ['low', 'medium', 'high'] } },
        required: ['title'],
      },
    },
  },
  required: ['findings'],
}
const result = await agent('Review this diff.', { schema: FINDINGS }) // -> validated object
```

Supported keywords: `type` (object/array/string/integer/number/boolean/null),
`properties`, `required`, `additionalProperties`, `items`, `minItems`, `enum`.
Schema is what makes multi-stage pipelines reliable: without it, downstream
stages parse free text and composition becomes guesswork.

## Composition patterns

These are not new primitives — just primitives plus ordinary JavaScript.

- **fan-out → reduce → synthesize** — `parallel` to draft, dedup/merge in JS, one
  final `agent` to synthesize.
- **adversarial verify** — find candidates, then for each run several skeptics
  with `parallel` and keep it only if a majority fail to refute it.
- **judge panel** — score one artifact from several angles, combine in script.
- **loop-until-dry** — `while` loop, each round `parallel` fans out finders,
  dedup against a `seen` set, stop after K empty rounds.

## Determinism rule

Out-of-order execution is fine **as long as your reduction is order-independent**
(accumulate into a set, dedup, tally). Do **not** branch on which agent finished
first or dispatch follow-ups based on completion timing — that makes the run
non-reproducible. This is why v1 offers `parallel`/`pipeline` (batch dispatch
decided by inputs) rather than raw, individually-awaited futures.

## Limits

- **Concurrency cap** — at most N agent CLIs run at once (`min(16, cpus-2)` by
  default; set `concurrency` in config). Excess calls queue.
- **Total-agent backstop** — a hard ceiling on dispatches per run (default
  1000). Exceeding it aborts the run, so a buggy loop cannot fan out forever.
