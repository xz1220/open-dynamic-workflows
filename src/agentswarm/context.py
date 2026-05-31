"""The per-run context shared by the primitives.

A :class:`RunContext` is the single object a running workflow talks to,
indirectly, through the primitives. It bundles the wired-up layers (bridge,
scheduler), the control and event sink, the run's ``args``, and the mutable
display state (``meta``, ``current_phase``).

:func:`build_context` is the one place that wires the layers together from a
:class:`Config`, so the runtime worker (and tests) get a ready-to-use context
in a single call.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any

from .adapters import Config
from .bridge import Bridge
from .control import Control, NullControl
from .events import EventSink, NullSink
from .scheduler import Scheduler


@dataclass
class RunContext:
    config: Config
    bridge: Bridge
    scheduler: Scheduler
    control: Control
    sink: EventSink
    args: Any = None
    meta: dict[str, Any] = field(default_factory=dict)
    current_phase: str | None = None

    def emit(self, ev: dict[str, Any]) -> None:
        self.sink.emit(ev)


def build_context(
    config: Config,
    *,
    source: str | os.PathLike[str] | None = None,
    args: Any = None,
    sink: EventSink | None = None,
    control: Control | None = None,
) -> RunContext:
    """Wire a full run context from a config and the run's surroundings."""
    sink = sink or NullSink()
    control = control or NullControl()
    bridge = Bridge(config, source=source)
    scheduler = Scheduler(
        config.settings.resolved_concurrency(),
        config.settings.max_agents,
        checkpoint=control.checkpoint,
    )
    return RunContext(
        config=config,
        bridge=bridge,
        scheduler=scheduler,
        control=control,
        sink=sink,
        args=args,
    )
