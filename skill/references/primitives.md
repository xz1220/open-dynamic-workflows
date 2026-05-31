# Primitive reference

The primitives are imported from `agentswarm` and called inside `workflow(args)`.
They find the active run automatically — no context object to thread through.

```python
from agentswarm import agent, parallel, pipeline, phase, log, schema
```

## agent

```python
agent(prompt, *, adapter=None, schema=None, label=None, phase=None) -> str | object
```

Run one coding agent on `prompt`. This is the only primitive that does real
work; every other primitive organizes calls to it.

- **adapter** — which configured CLI to use (e.g. `"codex"`). Defaults to the
  config's `default_adapter`.
- **schema** — a JSON-Schema dict (see [schema](#schema)). When given, the reply
  is parsed and validated, and the agent is retried with corrective feedback
  until it conforms or the retry budget runs out (then the call raises). Without
  it, the raw reply text is returned.
- **label** — a short name for progress display.
- **phase** — overrides the current phase for this one call. Prefer this inside
  `parallel`/`pipeline`, where the global phase is shared across threads.

Returns the reply text, or the validated object when `schema` is set. Raises on
hard failure (the CLI errored, or the schema never validated). Inside
`parallel`/`pipeline` a raised call becomes a `None` slot instead.

## parallel

```python
parallel(thunks: list[Callable[[], T]]) -> list[T | None]
```

Run every zero-arg callable concurrently and **wait for all of them** (a
barrier). Results come back in input order; a callable that raises yields `None`
in its slot, so one failure does not sink the batch.

Use `parallel` when the next step needs the entire batch at once — dedup, tally,
or a synthesis pass over all results.

```python
votes = parallel([lambda: agent("Is X true? answer yes/no") for _ in range(5)])
yes = sum(1 for v in votes if v and v.strip().lower().startswith("yes"))
```

Each thunk must be zero-arg. When building them in a loop, bind loop variables
with default arguments (`lambda i=i: ...`) so every thunk captures its own value.

## pipeline

```python
pipeline(items, *stages: Callable) -> list
```

Send each item through all stages **independently** — no barrier between stages.
Item B can be in stage 1 while item A is already in stage 3. This is the default
shape for multi-stage work; it avoids the idle time a barrier would impose.

Each stage callback receives `(previous_result, original_item, index)`; declare
only the parameters you need:

```python
results = pipeline(
    files,
    lambda f: agent(f"Review {f}", schema=FINDINGS),     # stage 1: (prev=item)
    lambda review, f: {"file": f, "review": review},     # stage 2: (prev, item)
)
```

A stage that raises drops that item to `None` and skips its remaining stages.
The return value is the list of each item's final result (or `None`), in order.

`pipeline(items, stage)` with a single stage is just "map this over items
concurrently" — handy when each map step itself fans out with `parallel`.

## phase / log

```python
phase(title)     # group following agent calls under a named phase
log(message)     # emit a one-line progress event
```

Both are observation only — they change progress output, not results. `phase`
sets a run-global current phase; inside concurrent sections pass `phase=` to
`agent` instead, since the global is shared across threads.

## schema

Build a JSON-Schema contract with the constructors (or write the dict by hand):

```python
schema.obj(properties, required=None)   # object; all properties required by default
schema.array(items, min_items=None)     # array of `items`
schema.string() / schema.number() / schema.integer() / schema.boolean()
schema.enum(*values)                    # one of a fixed set
```

```python
FINDINGS = schema.obj({
    "findings": schema.array(schema.obj({
        "title": schema.string(),
        "severity": schema.enum("low", "medium", "high"),
    })),
})
result = agent("Review this diff.", schema=FINDINGS)  # -> validated dict
```

Schema is what makes multi-stage pipelines reliable: without it, downstream
stages parse free text and composition becomes guesswork.

## Composition patterns

These are not new primitives — just primitives plus ordinary Python.

- **fan-out → reduce → synthesize** — `parallel` to draft, dedup/merge in
  Python, one final `agent` to synthesize.
- **adversarial verify** — find candidates, then for each run several skeptics
  with `parallel` and keep it only if a majority fail to refute it.
- **judge panel** — score one artifact from several angles, combine in script.
- **loop-until-dry** — `while` loop, each round `parallel` fans out finders,
  dedup against a `seen` set, stop after K empty rounds.

## Determinism rule

Out-of-order execution is fine **as long as your reduction is order-independent**
(accumulate into a set, dedup, tally). Do **not** branch on which agent finished
first or dispatch follow-ups based on completion timing — that makes the run
non-reproducible. This is why the v1 primitives are `parallel`/`pipeline` (batch
dispatch decided by inputs) rather than raw, individually-awaited futures.

## Limits

- **Concurrency cap** — at most N agent CLIs run at once (configurable; auto by
  default). Excess calls queue.
- **Total-agent backstop** — a hard ceiling on dispatches per run (default
  1000). Exceeding it aborts the run, so a buggy loop cannot fan out forever.
