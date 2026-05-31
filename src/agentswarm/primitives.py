"""Programming primitives (L4): the contract workflow scripts are written in.

These are the verbs an author composes with ordinary Python control flow:

* :func:`agent`    — run one coding agent on a subtask (the only verb that does work)
* :func:`parallel` — fan out a batch and wait for all of it (barrier)
* :func:`pipeline` — stream items through stages independently (no barrier)
* :func:`phase`    — label the following work for progress display
* :func:`log`      — surface a progress message

Authors call these as bare functions. They find the active run through a
single module-level binding established by the runtime via :func:`bind`. That is
safe because the runtime executes exactly one workflow per process; the worker
threads that ``parallel`` / ``pipeline`` spawn all share that one binding. Tests
bind a context explicitly.

``args`` is *not* here: it is run data, passed straight into the workflow
function by the runtime, so scripts read it as a normal parameter.
"""

from __future__ import annotations

import inspect
from collections.abc import Callable, Iterable
from contextlib import contextmanager
from typing import Any

from .bridge import AgentRequest
from .context import RunContext
from .errors import FATAL_ERRORS, WorkflowError
from .events import (
    AGENT_FAILED,
    AGENT_FINISHED,
    AGENT_STARTED,
    LOG,
    PHASE_STARTED,
    event,
)

_current: RunContext | None = None


@contextmanager
def bind(ctx: RunContext):
    """Make *ctx* the active run for the duration of the block."""
    global _current
    previous = _current
    _current = ctx
    try:
        yield ctx
    finally:
        _current = previous


def current() -> RunContext:
    """Return the active run context, or fail clearly if there is none."""
    if _current is None:
        raise WorkflowError(
            "no active run; primitives may only be called inside a running workflow"
        )
    return _current


def agent(
    prompt: str,
    *,
    adapter: str | None = None,
    schema: dict | None = None,
    label: str | None = None,
    phase: str | None = None,
) -> Any:
    """Run one coding agent on *prompt* and return its result.

    Without ``schema`` the result is the agent's reply text. With ``schema`` it
    is a validated structured value (the bridge retries until it conforms).
    ``adapter`` selects which configured CLI to use; ``phase`` overrides the
    current phase for this single call (useful inside ``parallel`` /
    ``pipeline`` where the global phase is racy).
    """
    ctx = current()
    display = label or adapter or ctx.config.settings.default_adapter or "agent"
    active_phase = phase if phase is not None else ctx.current_phase
    ctx.emit(event(AGENT_STARTED, label=display, phase=active_phase))

    request = AgentRequest(prompt=prompt, adapter=adapter, schema=schema, label=label)
    try:
        outcome = ctx.scheduler.run_agent(lambda: ctx.bridge.run(request))
    except FATAL_ERRORS:
        raise  # budget exhausted / stop requested: abort the whole run
    except Exception as exc:
        ctx.emit(event(AGENT_FAILED, label=display, phase=active_phase, error=str(exc)))
        raise
    ctx.emit(
        event(
            AGENT_FINISHED,
            label=display,
            phase=active_phase,
            adapter=outcome.adapter,
            attempts=outcome.attempts,
        )
    )
    return outcome.value


def parallel(thunks: Iterable[Callable[[], Any]]) -> list[Any]:
    """Run every thunk concurrently and return all results once all finish.

    This is a barrier: use it when the next step needs the whole batch at once
    (dedup, tally, synthesis). A thunk that raises becomes a ``None`` slot.
    """
    return current().scheduler.gather(list(thunks))


def pipeline(items: Iterable[Any], *stages: Callable) -> list[Any]:
    """Stream each item through every stage independently (no barrier).

    Item B can be in stage 1 while item A is already in stage 3 — the default
    shape for multi-stage work. Each stage callback receives
    ``(previous_result, original_item, index)``; declare only the parameters you
    need. A stage that raises drops that item to ``None`` and skips its
    remaining stages.
    """
    materialized = list(items)
    callables = [_chain(item, index, stages) for index, item in enumerate(materialized)]
    return current().scheduler.gather(callables)


def phase(title: str) -> None:
    """Group the following agent calls under *title* for progress display."""
    ctx = current()
    ctx.current_phase = title
    ctx.emit(event(PHASE_STARTED, phase=title))


def log(message: Any) -> None:
    """Surface a one-line progress message to whoever is watching the run."""
    current().emit(event(LOG, message=str(message)))


# --- internals ---------------------------------------------------------------


def _chain(item: Any, index: int, stages: tuple[Callable, ...]) -> Callable[[], Any]:
    def run_chain() -> Any:
        value = item
        for stage in stages:
            value = _call_stage(stage, value, item, index)
        return value

    return run_chain


def _call_stage(stage: Callable, previous: Any, item: Any, index: int) -> Any:
    """Call *stage* with as many of (previous, item, index) as it accepts."""
    arity = _positional_arity(stage)
    args = (previous, item, index)[: max(1, min(arity, 3))]
    return stage(*args)


def _positional_arity(fn: Callable) -> int:
    try:
        signature = inspect.signature(fn)
    except (TypeError, ValueError):
        return 1
    count = 0
    for parameter in signature.parameters.values():
        if parameter.kind in (parameter.POSITIONAL_ONLY, parameter.POSITIONAL_OR_KEYWORD):
            count += 1
        elif parameter.kind is parameter.VAR_POSITIONAL:
            return 3
    return count or 1
