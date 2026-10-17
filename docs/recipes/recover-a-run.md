# Recovering a run that stalled, failed or was stopped

Long fan-outs fail in boring ways: one lane hangs on a prompt it can never
answer, a vendor rate-limits half the agents, a laptop sleeps. ODW keeps every
finished agent's work on disk the moment it finishes, so none of that work is
lost — you can **read it while the run is still going**, and **resume** the run
without paying for it again.

## 1. See what already finished — mid-run

```bash
odw agents $RUN              # id, state, label, phase, adapter, time, a value preview
odw result $RUN --agent 3    # agent #3's saved value as JSON
odw result $RUN --agent search:2   # …or by label (ambiguous labels list their ids)
odw agents $RUN --json       # the same rows for a script or another agent
```

Each completed `agent()` result is written atomically to
`<run dir>/agents/<agentId>.json` before its `agent_finished` event, so this
works while other lanes are still running, after `odw stop`, and after the worker
was killed. The dashboard shows the same output in a run's agent drawer.

A coding agent driving ODW can therefore use partial results instead of waiting
for (or redoing) the whole run: read the lanes that finished, decide, and only
then stop or resume.

## 2. Stop what is stuck

```bash
odw stop $RUN    # every running agent gets SIGTERM, then SIGKILL; worktrees are cleaned up
```

To have ODW do this for you next time, give streaming adapters a stall
watchdog — an agent that prints nothing for `stallTimeout` seconds is killed and
restarted (`stallRestarts` times) — see "Stall watchdog" in the README.

## 3. Fix, then resume

```bash
odw resume $RUN --wait
```

On an ended run (done, failed, stopped, or stale after a crash) `odw resume`
starts a **new** run with the same script, args and adapter. Every `agent()`
call whose prompt and options are unchanged **replays** its saved value at once —
no CLI call, no concurrency slot, no budget — and everything else runs normally.
So the usual loop is:

1. look at the failure (`odw logs $RUN`, the dashboard, `odw result --agent`) — and
   at what the failed agent did: `odw logs $RUN --agent <id|label>` prints its tool
   calls, their results and the end of its stderr (an ODW extension);
2. fix the step that failed — the prompt, a schema, the adapter (`--adapter`),
   or the environment;
3. `odw resume $RUN`: only the changed and the never-finished calls run again.

Replayed agents are marked ↺ in `odw agents`, the logs and the dashboard, and
are saved again, so a resume of a resume keeps replaying them. `exec()` command
steps always run again (they are cheap and their world may have changed).
`odw rerun $RUN` is still there when you want a clean start.

On a run that is merely **paused** (worker alive), `odw resume` keeps its old
meaning and continues it in place; a run that is still running is refused unless
you pass `--force`.

## What a resume key is

A call replays when its *resume key* matches: the sha256 of its prompt plus its
`schema`, `adapter` (as written in the call), `model`, `agentType`, `isolation`
and `label`. `phase` is not part of it, and `--adapter` on the resume changes
only the default, so calls that name no adapter still replay. Calls with the
same key replay in order: the n-th such call gets the n-th saved result.
