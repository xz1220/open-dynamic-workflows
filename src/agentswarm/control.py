"""Run control: the pause / resume / stop safe point.

The scheduler calls ``checkpoint()`` right before dispatching each agent. That
single call site is where a run honours external control:

* paused  -> ``checkpoint`` blocks until resumed (or stopped),
* stopped -> ``checkpoint`` raises :class:`RunStopped`, which unwinds the run.

This module holds the in-process implementations. The cross-process variant
(driven by a control file the CLI writes) lives in
:mod:`agentswarm.runtime.file_control` and implements the same tiny protocol.
"""

from __future__ import annotations

import threading
from typing import Protocol, runtime_checkable

from .errors import RunStopped

RUNNING = "running"
PAUSED = "paused"
STOPPED = "stopped"


@runtime_checkable
class Control(Protocol):
    """The minimal contract the scheduler depends on."""

    def checkpoint(self) -> None:
        """Block while paused; raise :class:`RunStopped` if a stop was requested."""

    def state(self) -> str:
        """Current control state: ``running`` / ``paused`` / ``stopped``."""


class NullControl:
    """A control that never pauses or stops. The default for unmanaged runs."""

    def checkpoint(self) -> None:
        return None

    def state(self) -> str:
        return RUNNING


class ThreadControl:
    """Thread-safe in-process control (used by tests and in-process runs)."""

    def __init__(self) -> None:
        self._stopped = False
        # "resumed" is set while running and cleared while paused; threads wait
        # on it at the checkpoint.
        self._resumed = threading.Event()
        self._resumed.set()

    def pause(self) -> None:
        self._resumed.clear()

    def resume(self) -> None:
        self._resumed.set()

    def stop(self) -> None:
        self._stopped = True
        # Wake any paused waiters so they observe the stop instead of hanging.
        self._resumed.set()

    def checkpoint(self) -> None:
        if self._stopped:
            raise RunStopped("run was stopped")
        self._resumed.wait()
        if self._stopped:
            raise RunStopped("run was stopped")

    def state(self) -> str:
        if self._stopped:
            return STOPPED
        return RUNNING if self._resumed.is_set() else PAUSED
