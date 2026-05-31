"""L1 adapter layer: a uniform way to call any coding-agent CLI.

Public surface:

* :class:`Adapter`, :class:`Settings`, :class:`Config` and :func:`load_config`
  — the configuration model and loader.
* :class:`CliResult` and :func:`run_command` — the subprocess boundary.
* :func:`expand` — command-template placeholder substitution.
"""

from __future__ import annotations

from .config import (
    Adapter,
    Config,
    Settings,
    default_config,
    load_config,
    with_overrides,
)
from .placeholders import PLACEHOLDERS, expand, expand_all
from .runner import CliResult, CommandRunner, run_command

__all__ = [
    "Adapter",
    "Config",
    "Settings",
    "default_config",
    "load_config",
    "with_overrides",
    "PLACEHOLDERS",
    "expand",
    "expand_all",
    "CliResult",
    "CommandRunner",
    "run_command",
]
