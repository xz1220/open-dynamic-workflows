"""Cross-process run control backed by the run directory.

Same contract as the in-process controls in :mod:`agentswarm.control`, but the
pause/stop signal arrives through a file the CLI writes. The worker polls that
file at each safe point. It is decoupled from :class:`RunStore` through two
callbacks — one to read the desired action, one to report a state change — so
this class has no knowledge of the directory layout.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable

from ..control import PAUSED, RUNNING, STOPPED
from ..errors import RunStopped


class FileControl:
    def __init__(
        self,
        read_action: Callable[[], str | None],
        *,
        on_state: Callable[[str], None] | None = None,
        poll_interval: float = 0.2,
    ) -> None:
        self._read_action = read_action
        self._on_state = on_state or (lambda _state: None)
        self._poll = poll_interval
        self._reported = RUNNING
        self._lock = threading.Lock()

    def checkpoint(self) -> None:
        while True:
            action = self._read_action()
            if action == "stop":
                self._report(STOPPED)
                raise RunStopped("run was stopped")
            if action == "pause":
                self._report(PAUSED)
                time.sleep(self._poll)
                continue
            self._report(RUNNING)
            return

    def state(self) -> str:
        action = self._read_action()
        if action == "stop":
            return STOPPED
        if action == "pause":
            return PAUSED
        return RUNNING

    def _report(self, state: str) -> None:
        with self._lock:
            if state == self._reported:
                return
            self._reported = state
        self._on_state(state)
