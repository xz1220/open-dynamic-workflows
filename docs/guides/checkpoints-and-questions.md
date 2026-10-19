# Human checkpoints and agent questions

English · [简体中文](../zh-CN/guides/checkpoints-and-questions.md)

Where a person comes into a run: a `checkpoint()` the script waits at, and a question an agent asks headless.

## Human checkpoints (ODW extension)

Claude Code's workflows take no input once they start. `checkpoint()` lets a run
stop where a person should look — approve the plan before the expensive fan-out,
or end a run that went off the rails — and wait, durably, for the answer:

```js
const plan = await agent('Plan the migration as independent steps.', { schema: PLAN })
const { approved, note } = await checkpoint('Run this migration plan?', { payload: plan })
if (!approved) return { skipped: true, why: note }
await parallel(plan.steps.map((step) => () => agent(step.instructions)))
```

While it waits, the run shows as **waiting** in `odw status`, `odw list`, the live
view and the dashboard. Nothing else is held up: agents already running carry on, a
waiting checkpoint takes no agent slot and spends no budget, and `odw stop` still
ends the run. Answer it from any shell:

```bash
odw status $RUN       # the question, its payload, and the exact commands that answer it
odw approve $RUN      # the oldest checkpoint waiting; --checkpoint N picks one
odw reject $RUN --note "Keep the old table until the backfill is verified"
odw approve $RUN --edit   # change the payload first, then approve what you changed
```

or with **Approve** / **Reject** on the run's page in the dashboard (loopback binds
only; it posts `{ action, checkpointId?, note?, payload? }` to `POST /api/runs/:id/checkpoint`;
`GET /api/runs/:id` lists `pendingCheckpoints`, and the run list names each waiting
run's oldest question as `waiting`). The call resolves to
`{ approved, note, by, payload, edited }` — `by` is `cli`, `dashboard`, `link` (a signed
[approve link](dashboard.md#approve-from-your-phone-odw-extension)) or `timeout` — and a rejection
is an answer, not an error: the script decides what "no" means.

**Approve with edits.** As with Claude Code's plan approval, the person can change
what they approve instead of rejecting and re-running. `odw approve $RUN --edit` opens
`$VISUAL` / `$EDITOR` (else `vi`; `notepad` on Windows) on the checkpoint's payload,
pretty-printed in a private temp file: save an edit to approve it; leave it unchanged
to approve as is; empty the file to abort without answering. Invalid JSON, or an edit
the checkpoint refuses, aborts with the error and keeps the file (its path is
printed). `--payload '<json>'` or `--payload @plan.json` approves an edit without an
editor, and the dashboard sends `payload` with `action: "approve"`. The call then
resolves with `payload` — the edit, or the checkpoint's own payload when there was
none — and `edited: true` only when it differs from the original as JSON; a rejection
and a timeout carry the original. Give `checkpoint()` a `schema` (JSON Schema, checked
by the same validator as `agent()`'s) and an edit must match it: `odw approve`, the API
and the run itself refuse one that does not, with the validator's errors. Without a
schema any JSON value goes — the payload is the script's own data and only the script
knows what an edit may be — so a script that relies on its shape should give one:

```js
const { approved, payload: approvedPlan } = await checkpoint('Run this plan?', { payload: plan, schema: PLAN })
```

- `payload` is any JSON value — a plan, a summary of the changes — kept up to 64 KiB.
- An edited payload is at most 256 KiB of JSON; `checkpoint_resolved` records
  `edited: true` and the edit (cut to 64 KiB like the question's).
- `timeout` (seconds) bounds the wait for unattended runs; `onTimeout` then approves,
  rejects, or (the default, `"fail"`) throws a `CheckpointTimeout` the script can catch.
- Several checkpoints can wait at once (inside `parallel()`), each with its own number.
- `odw resume` never replays a checkpoint: a resumed run asks again.
- `odw run --wait` blocks while a checkpoint waits; it prints the commands once, so
  answer from another shell (or bound the wait with `--timeout`).
- The run records `checkpoint_requested` and `checkpoint_resolved` events, and
  `status.json` names the oldest open checkpoint as `waiting`. With `"waiting"` in
  [`notify.on`](notifications.md#run-notifications) your hooks hear about each one.

[`examples/plan-approve-execute.js`](../../examples/plan-approve-execute.js) is the full
plan → approve → execute loop, re-planning when a rejection comes with a note.

## Agent questions (ODW extension)

A model sometimes stops mid-task to ask the user something — Claude Code's
`AskUserQuestion` tool. Run headless, nobody can answer: the tool comes back
empty and the model goes on guessing, or the run hangs until a timeout
([claude-code#50728](https://github.com/anthropics/claude-code/issues/50728)).
odw reads the call from the CLI's stream, **stops the CLI at the question** — an
agent never goes on with an empty answer — and then does what `questions` says:

- `"checkpoint"` (the default) turns the question into a checkpoint: the same
  `odw status`, dashboard card (each option a chip that fills the answer), `notify`
  `"waiting"` hook and one-time approve links as `checkpoint()`. Answer it with
  `odw approve <run> --checkpoint N --note "<answer>"` (or an approval whose edited
  payload has an `answer`); the same agent() call runs again — in the same worktree
  when isolated — its prompt ending with “Earlier in this task you stopped to ask
  the user: … The user answered: …”. The rerun is logged (`retry.reason:
  "question"`) and counts toward the budget. `odw reject` declines: the agent
  fails with `reason: "needs_input"`. A call answered 3 times that asks again fails too.
- `"fail"` fails the agent at once with `reason: "needs_input"`; its `agent_failed`
  event, `/api/runs/:id`, the drawer and `odw status` list what it asked.
- `"deny"` runs the CLI without its question tool (the adapter's `questionArgs`:
  `claude --disallowedTools AskUserQuestion`) and tells the agent to assume and say
  what it assumed. One that asks anyway fails with `needs_input`.

Set it for the run (`"questions"` in the config), per adapter, or per call:
`agent(prompt, { questions: "fail" })`. Only the CLI's own tool call counts — a
reply that ends in a question mark is not a question — and no CLI session is
resumed: the call runs again, told the answer. Any JSONL adapter can declare its
CLI's question events with `output.questions` (see the adapters reference); the
built-in `claude` does.
