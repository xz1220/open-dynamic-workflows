"""Configuration model and loader (L1).

A :class:`Config` is the immutable description of *which* agent CLIs exist
(:class:`Adapter`) and *how* a run behaves (:class:`Settings`). It is loaded
once at run start and then only read, which keeps it safe to share across the
worker threads that the scheduler spawns.

Config sources, highest priority first:

1. an explicit path passed to :func:`load_config`
2. ``$AGENTSWARM_CONFIG``
3. ``./agentswarm.toml``
4. ``~/.config/agentswarm/config.toml``

Built-in adapters and default settings are always present as a base layer; any
file found above is merged on top, so a user only specifies what they change.
"""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

from ..errors import AdapterNotFound, ConfigError
from .builtin import BUILTIN_ADAPTERS, DEFAULT_SETTINGS

_ENV_VAR = "AGENTSWARM_CONFIG"
_SEARCH_PATHS = (
    Path("agentswarm.toml"),
    Path.home() / ".config" / "agentswarm" / "config.toml",
)


@dataclass(frozen=True)
class Adapter:
    """How to invoke one coding-agent CLI."""

    name: str
    command: tuple[str, ...]
    stdin: str | None = None
    env: dict[str, str] = field(default_factory=dict)
    timeout: float | None = None
    label: str | None = None

    @property
    def display_name(self) -> str:
        return self.label or self.name


@dataclass(frozen=True)
class Settings:
    """Run-wide knobs that are independent of any single adapter."""

    default_adapter: str | None
    concurrency: int | None
    max_agents: int
    workspace_mode: str
    timeout: float | None
    schema_retries: int
    runs_root: Path | None

    def resolved_concurrency(self) -> int:
        """Concrete concurrency cap, auto-derived from CPU count when unset.

        Mirrors the reference runtime: at most 16, and always leaving a couple
        of cores for the orchestrating process itself.
        """
        if self.concurrency is not None:
            return max(1, self.concurrency)
        cpu = os.cpu_count() or 4
        return max(1, min(16, cpu - 2))

    def resolved_runs_root(self) -> Path:
        if self.runs_root is not None:
            return self.runs_root
        return Path.home() / ".agentswarm" / "runs"


@dataclass(frozen=True)
class Config:
    adapters: dict[str, Adapter]
    settings: Settings

    def adapter(self, name: str | None) -> Adapter:
        """Resolve an adapter by name, falling back to the configured default.

        Raises :class:`AdapterNotFound` with the available names listed, which
        is the error a workflow author is most likely to hit and most wants
        spelled out.
        """
        chosen = name or self.settings.default_adapter
        if chosen is None:
            if len(self.adapters) == 1:
                return next(iter(self.adapters.values()))
            raise AdapterNotFound(
                "no adapter specified and no default_adapter set; "
                f"available: {', '.join(sorted(self.adapters))}"
            )
        try:
            return self.adapters[chosen]
        except KeyError:
            raise AdapterNotFound(
                f"unknown adapter {chosen!r}; available: {', '.join(sorted(self.adapters))}"
            ) from None


def load_config(path: str | os.PathLike[str] | None = None) -> Config:
    """Load configuration, merging any discovered file over the built-ins."""
    raw = _read_raw(path)
    adapters = _build_adapters(raw.get("adapters", {}))
    settings = _build_settings(raw)
    return Config(adapters=adapters, settings=settings)


def default_config() -> Config:
    """Config from built-ins only — handy for tests and programmatic use."""
    return Config(
        adapters=_build_adapters({}),
        settings=_build_settings({}),
    )


def with_overrides(config: Config, **settings: Any) -> Config:
    """Return a copy of *config* with selected settings replaced.

    Used by the CLI/runtime to apply per-invocation overrides (e.g. a chosen
    ``runs_root``) without mutating shared state.
    """
    return replace(config, settings=replace(config.settings, **settings))


# --- internals ---------------------------------------------------------------


def _read_raw(path: str | os.PathLike[str] | None) -> dict[str, Any]:
    located = _locate(path)
    if located is None:
        return {}
    try:
        with located.open("rb") as fh:
            return tomllib.load(fh)
    except (OSError, tomllib.TOMLDecodeError) as exc:
        raise ConfigError(f"could not read config {located}: {exc}") from exc


def _locate(path: str | os.PathLike[str] | None) -> Path | None:
    if path is not None:
        p = Path(path).expanduser()
        if not p.is_file():
            raise ConfigError(f"config file not found: {p}")
        return p
    env = os.environ.get(_ENV_VAR)
    if env:
        p = Path(env).expanduser()
        if not p.is_file():
            raise ConfigError(f"{_ENV_VAR} points to a missing file: {p}")
        return p
    for candidate in _SEARCH_PATHS:
        if candidate.is_file():
            return candidate
    return None


def _build_adapters(user: dict[str, Any]) -> dict[str, Adapter]:
    merged: dict[str, Any] = {**BUILTIN_ADAPTERS, **(user or {})}
    if not merged:
        raise ConfigError("no adapters configured")
    return {name: _build_adapter(name, spec) for name, spec in merged.items()}


def _build_adapter(name: str, spec: dict[str, Any]) -> Adapter:
    if "command" not in spec or not spec["command"]:
        raise ConfigError(f"adapter {name!r} is missing a non-empty 'command'")
    command = spec["command"]
    if not isinstance(command, list) or not all(isinstance(part, str) for part in command):
        raise ConfigError(f"adapter {name!r} 'command' must be a list of strings")
    env = spec.get("env", {})
    if not isinstance(env, dict):
        raise ConfigError(f"adapter {name!r} 'env' must be a table")
    return Adapter(
        name=name,
        command=tuple(command),
        stdin=spec.get("stdin"),
        env={str(k): str(v) for k, v in env.items()},
        timeout=_as_float(spec.get("timeout")),
        label=spec.get("label"),
    )


def _build_settings(raw: dict[str, Any]) -> Settings:
    merged = {**DEFAULT_SETTINGS, **{k: v for k, v in raw.items() if k != "adapters"}}
    runs_root = merged.get("runs_root")
    return Settings(
        default_adapter=merged.get("default_adapter"),
        concurrency=_as_int(merged.get("concurrency")),
        max_agents=int(merged.get("max_agents") or DEFAULT_SETTINGS["max_agents"]),
        workspace_mode=str(merged.get("workspace_mode") or "copy"),
        timeout=_as_float(merged.get("timeout")),
        schema_retries=int(merged.get("schema_retries") or 0),
        runs_root=Path(runs_root).expanduser() if runs_root else None,
    )


def _as_int(value: Any) -> int | None:
    return None if value is None else int(value)


def _as_float(value: Any) -> float | None:
    return None if value is None else float(value)
