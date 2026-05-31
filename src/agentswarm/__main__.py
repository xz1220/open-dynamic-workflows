"""Enable ``python -m agentswarm`` as an alias for the ``swarm`` CLI."""

from __future__ import annotations

from .cli import main

if __name__ == "__main__":
    raise SystemExit(main())
