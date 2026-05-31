"""Exception hierarchy for agent-swarm.

The split that matters most is *fatal* vs *recoverable*:

* Recoverable errors (a single agent CLI failed, a schema never validated) are
  caught by the concurrency primitives and turned into a ``None`` slot, so one
  bad agent does not sink an entire ``parallel`` / ``pipeline`` batch.
* Fatal errors (the run-wide agent budget is exhausted, or a stop was
  requested) must abort the whole run. They are re-raised through the
  primitives instead of being swallowed.

``FATAL_ERRORS`` is the single source of truth the scheduler consults, so the
two categories never drift apart.
"""

from __future__ import annotations


class AgentSwarmError(Exception):
    """Base class for every error raised by this package."""


class ConfigError(AgentSwarmError):
    """The adapter/run configuration could not be loaded or is invalid."""


class AdapterNotFound(ConfigError):
    """A workflow referenced an adapter name that is not configured."""


class AdapterExecutionError(AgentSwarmError):
    """An agent CLI failed: non-zero exit, timeout, or spawn failure."""


class SchemaValidationError(AgentSwarmError):
    """An agent never produced output matching the requested schema."""


class AgentLimitExceeded(AgentSwarmError):
    """The run-wide cap on total agent dispatches was hit (a runaway guard)."""


class RunStopped(AgentSwarmError):
    """A stop was requested; the run unwinds at the next safe point."""


class WorkflowError(AgentSwarmError):
    """The workflow script is malformed (e.g. missing a ``workflow`` function)."""


# Errors that must propagate through parallel/pipeline rather than becoming a
# ``None`` result slot. Everything else is treated as a recoverable per-item
# failure.
FATAL_ERRORS: tuple[type[BaseException], ...] = (AgentLimitExceeded, RunStopped)
