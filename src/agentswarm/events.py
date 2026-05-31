"""Progress events and the sink abstraction.

Events are the one-way channel from a running workflow to whoever is watching
it (the CLI, the run directory, a test). The data shape is deliberately a plain
``dict`` so it round-trips through JSON unchanged — the run directory persists
events as JSONL and the CLI reads them back without any custom decoding.

Both the primitive layer (``log`` / ``phase`` / ``agent``) and the runtime emit
events, so this module sits below both and depends on nothing else in the
package. The concrete file-backed sink lives in :mod:`agentswarm.runtime`.
"""

from __future__ import annotations

import threading
import time
from typing import Any, Protocol, runtime_checkable

# Event type constants — the full vocabulary a watcher may observe.
RUN_STARTED = "run_started"
RUN_FINISHED = "run_finished"
RUN_FAILED = "run_failed"
RUN_STOPPED = "run_stopped"
PHASE_STARTED = "phase_started"
LOG = "log"
AGENT_STARTED = "agent_started"
AGENT_FINISHED = "agent_finished"
AGENT_FAILED = "agent_failed"


def event(type: str, **fields: Any) -> dict[str, Any]:
    """Build a timestamped event record.

    Timestamps come from the wall clock on purpose: events describe *when*
    something happened for an observer, and never feed back into workflow
    control flow, so they do not threaten determinism.
    """
    return {"ts": time.time(), "type": type, **fields}


@runtime_checkable
class EventSink(Protocol):
    """Anything that can receive progress events."""

    def emit(self, ev: dict[str, Any]) -> None: ...


class NullSink:
    """Drops every event. The default when nobody is watching."""

    def emit(self, ev: dict[str, Any]) -> None:  # noqa: D102 - trivial
        return None


class MemorySink:
    """Collects events in a list. Used by in-process tests and ``--wait`` mode."""

    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []
        self._lock = threading.Lock()

    def emit(self, ev: dict[str, Any]) -> None:
        with self._lock:
            self.events.append(ev)

    def of_type(self, type: str) -> list[dict[str, Any]]:
        """Return a snapshot of all collected events of a given type."""
        with self._lock:
            return [e for e in self.events if e.get("type") == type]
