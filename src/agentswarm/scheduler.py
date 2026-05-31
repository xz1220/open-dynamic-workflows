"""Concurrency scheduler (L3): bounded fan-out with a runaway guard.

Two independent limits are enforced here, and only here:

* **Concurrency cap** — at most N agent CLIs run at once, gated by a semaphore
  acquired around the actual work in :meth:`Scheduler.run_agent`.
* **Total-agent backstop** — a hard ceiling on how many agents a single run may
  ever dispatch, so a buggy ``while`` loop cannot fan out forever.

Orchestration (:meth:`Scheduler.gather`) spawns one short-lived thread per item
rather than drawing from a fixed pool. That is deliberate: a pipeline stage may
itself call ``parallel`` (nested fan-out), and a fixed pool could deadlock when
a held worker waits on a queued one. Threads are cheap because all but N of
them are parked on the semaphore; real concurrency stays bounded by the
semaphore, not by the thread count.

The scheduler knows nothing about agents, bridges or runs. It is handed a
``checkpoint`` callback (the pause/stop safe point) and a plain ``fn`` to run,
which keeps it fully decoupled and unit-testable with trivial callables.
"""

from __future__ import annotations

import threading
from collections.abc import Callable, Iterable
from typing import Any, TypeVar

from .errors import FATAL_ERRORS, AgentLimitExceeded

T = TypeVar("T")

# A no-op safe point; replaced by the run's control object at runtime.
def _no_checkpoint() -> None:
    return None


class Scheduler:
    def __init__(
        self,
        concurrency: int,
        max_agents: int,
        *,
        checkpoint: Callable[[], None] = _no_checkpoint,
    ) -> None:
        self._concurrency = max(1, concurrency)
        self._semaphore = threading.Semaphore(self._concurrency)
        self._max_agents = max_agents
        self._checkpoint = checkpoint
        self._dispatched = 0
        self._lock = threading.Lock()

    @property
    def concurrency(self) -> int:
        return self._concurrency

    @property
    def dispatched(self) -> int:
        """How many agents have been dispatched so far in this run."""
        with self._lock:
            return self._dispatched

    def run_agent(self, fn: Callable[[], T]) -> T:
        """Run one agent unit under the concurrency cap and total backstop.

        Order of operations matters: the pause/stop safe point comes first (so a
        stopped run dispatches nothing more), then the budget is reserved, then
        the semaphore bounds how many run at once.
        """
        self._checkpoint()
        with self._lock:
            if self._dispatched >= self._max_agents:
                raise AgentLimitExceeded(
                    f"run reached its cap of {self._max_agents} agent dispatches"
                )
            self._dispatched += 1
        with self._semaphore:
            return fn()

    def gather(self, callables: Iterable[Callable[[], Any]]) -> list[Any]:
        """Run callables concurrently; return results in input order.

        A recoverable failure in one callable becomes a ``None`` slot so the
        rest of the batch survives. A fatal error (budget exhausted, stop
        requested) is re-raised after the in-flight threads are joined, aborting
        the surrounding workflow.
        """
        callables = list(callables)
        results: list[Any] = [None] * len(callables)
        fatal: list[BaseException] = []
        threads: list[threading.Thread] = []

        def worker(index: int, fn: Callable[[], Any]) -> None:
            try:
                results[index] = fn()
            except FATAL_ERRORS as exc:
                fatal.append(exc)
            except Exception:
                results[index] = None  # recoverable: leave a hole, keep going

        for index, fn in enumerate(callables):
            thread = threading.Thread(
                target=worker, args=(index, fn), name=f"swarm-orch-{index}", daemon=True
            )
            thread.start()
            threads.append(thread)
        for thread in threads:
            thread.join()

        if fatal:
            raise fatal[0]
        return results
