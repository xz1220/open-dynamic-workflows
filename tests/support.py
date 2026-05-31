"""Shared builders for the test suite: a mock adapter, configs, and fixtures-on-disk."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from agentswarm.adapters import Adapter, Config, Settings

MOCK_AGENT = Path(__file__).parent / "mock_agent.py"


def mock_command(*extra: str) -> tuple[str, ...]:
    return (sys.executable, str(MOCK_AGENT), *extra)


def mock_adapter(
    name: str = "mock", *, stdin: str | None = "{prompt}", env: dict | None = None
) -> Adapter:
    return Adapter(name=name, command=mock_command(), stdin=stdin, env=env or {})


def make_settings(**overrides: Any) -> Settings:
    base: dict[str, Any] = dict(
        default_adapter="mock",
        concurrency=4,
        max_agents=1000,
        workspace_mode="inplace",
        timeout=30.0,
        schema_retries=2,
        runs_root=None,
    )
    base.update(overrides)
    return Settings(**base)


def make_config(adapters: dict[str, Adapter] | None = None, **settings: Any) -> Config:
    adapters = adapters or {"mock": mock_adapter()}
    return Config(adapters=adapters, settings=make_settings(**settings))


def write_mock_config(
    directory: Path,
    *,
    workspace_mode: str = "inplace",
    schema_retries: int = 2,
    env: dict[str, str] | None = None,
    **extra: Any,
) -> Path:
    """Write an agentswarm.toml whose ``mock`` adapter runs :data:`MOCK_AGENT`."""
    lines = [
        'default_adapter = "mock"',
        f'workspace_mode = "{workspace_mode}"',
        f"schema_retries = {schema_retries}",
    ]
    for key, value in extra.items():
        lines.append(f"{key} = {json.dumps(value)}")
    lines += [
        "",
        "[adapters.mock]",
        f"command = {json.dumps([sys.executable, str(MOCK_AGENT)])}",
        'stdin = "{prompt}"',
    ]
    if env:
        lines.append("[adapters.mock.env]")
        lines.extend(f"{k} = {json.dumps(v)}" for k, v in env.items())
    path = directory / "agentswarm.toml"
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def write_workflow(directory: Path, body: str, *, name: str = "wf.py") -> Path:
    path = directory / name
    path.write_text(body, encoding="utf-8")
    return path
