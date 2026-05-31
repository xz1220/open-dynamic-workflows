"""agent-swarm: portable dynamic workflows for any coding-agent CLI.

A workflow script imports the primitives and defines a ``workflow(args)``
function::

    from agentswarm import agent, parallel, log
    from agentswarm import schema

    META = {"name": "demo", "description": "fan out then synthesize"}

    def workflow(args):
        drafts = parallel([lambda i=i: agent(f"draft idea #{i}") for i in range(3)])
        return agent("Synthesize the best plan from: " + "\\n".join(filter(None, drafts)))

The :mod:`agentswarm.runtime` package runs that script in the background and the
``swarm`` CLI starts and observes runs.
"""

from __future__ import annotations

from . import schema
from .adapters import Adapter, Config, Settings, default_config, load_config
from .context import RunContext, build_context
from .errors import (
    AdapterExecutionError,
    AdapterNotFound,
    AgentLimitExceeded,
    AgentSwarmError,
    ConfigError,
    RunStopped,
    SchemaValidationError,
    WorkflowError,
)
from .primitives import agent, log, parallel, phase, pipeline

__version__ = "0.1.0"

__all__ = [
    # primitives
    "agent",
    "parallel",
    "pipeline",
    "phase",
    "log",
    "schema",
    # configuration / context
    "Adapter",
    "Config",
    "Settings",
    "RunContext",
    "build_context",
    "default_config",
    "load_config",
    # errors
    "AgentSwarmError",
    "ConfigError",
    "AdapterNotFound",
    "AdapterExecutionError",
    "SchemaValidationError",
    "AgentLimitExceeded",
    "RunStopped",
    "WorkflowError",
    "__version__",
]
