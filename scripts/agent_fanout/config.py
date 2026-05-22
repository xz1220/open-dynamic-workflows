from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - exercised on Python < 3.11.
    try:
        import tomli as tomllib
    except ModuleNotFoundError:  # pragma: no cover
        tomllib = None


@dataclass(frozen=True)
class AgentConfig:
    name: str
    label: str
    command: list[str] | str
    stdin: str | None = None
    env: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class FanoutConfig:
    default_agents: list[str]
    agents: dict[str, AgentConfig]
    timeout_seconds: int = 1800
    workspace_mode: str = "copy"
    capture_diff: bool = True
    max_output_chars: int = 0


def default_config() -> FanoutConfig:
    agents = {
        "codex": AgentConfig(
            name="codex",
            label="Codex CLI",
            command=[
                "codex",
                "exec",
                "--skip-git-repo-check",
                "--sandbox",
                "workspace-write",
                "--cd",
                "{workspace}",
                "-",
            ],
            stdin="{prompt}",
        ),
        "claude": AgentConfig(
            name="claude",
            label="Claude Code",
            command=[
                "claude",
                "--print",
                "--permission-mode",
                "acceptEdits",
                "--no-session-persistence",
                "{prompt}",
            ],
        ),
        "gemini": AgentConfig(
            name="gemini",
            label="Gemini CLI",
            command=["gemini", "--approval-mode", "auto_edit", "{prompt}"],
        ),
    }
    return FanoutConfig(default_agents=["codex", "claude", "gemini"], agents=agents)


def config_search_paths(explicit_path: str | None = None) -> list[Path]:
    paths: list[Path] = []
    if explicit_path:
        paths.append(Path(explicit_path).expanduser())
    env_path = os.environ.get("AGENT_FANOUT_CONFIG")
    if env_path:
        paths.append(Path(env_path).expanduser())
    paths.append(Path.cwd() / "agent-fanout.toml")
    paths.append(Path.home() / ".config" / "agent-fanout" / "config.toml")
    return paths


def load_config(explicit_path: str | None = None) -> tuple[FanoutConfig, Path | None]:
    for path in config_search_paths(explicit_path):
        if path.exists():
            return parse_config(path), path
    return default_config(), None


def parse_config(path: Path) -> FanoutConfig:
    raw = load_toml(path)
    if not isinstance(raw, dict):
        raise ValueError(f"Config must be a TOML table: {path}")

    agents_raw = raw.get("agents")
    if not isinstance(agents_raw, dict) or not agents_raw:
        raise ValueError("Config must define at least one [agents.<name>] table")

    agents: dict[str, AgentConfig] = {}
    for name, value in agents_raw.items():
        if not isinstance(value, dict):
            raise ValueError(f"agents.{name} must be a table")
        command = value.get("command")
        if not isinstance(command, (list, str)):
            raise ValueError(f"agents.{name}.command must be a string or list")
        if isinstance(command, list) and not all(isinstance(part, str) for part in command):
            raise ValueError(f"agents.{name}.command list must contain only strings")
        stdin = value.get("stdin")
        if stdin is not None and not isinstance(stdin, str):
            raise ValueError(f"agents.{name}.stdin must be a string")
        env = value.get("env", {})
        if not isinstance(env, dict) or not all(
            isinstance(key, str) and isinstance(val, str) for key, val in env.items()
        ):
            raise ValueError(f"agents.{name}.env must be a string map")
        label = value.get("label", name)
        if not isinstance(label, str):
            raise ValueError(f"agents.{name}.label must be a string")
        agents[name] = AgentConfig(
            name=name,
            label=label,
            command=command,
            stdin=stdin,
            env=env,
        )

    default_agents = raw.get("default_agents", list(agents.keys()))
    if not isinstance(default_agents, list) or not all(
        isinstance(item, str) for item in default_agents
    ):
        raise ValueError("default_agents must be a list of agent names")

    timeout_seconds = _positive_int(raw.get("timeout_seconds", 1800), "timeout_seconds")
    max_output_chars = _non_negative_int(raw.get("max_output_chars", 0), "max_output_chars")
    workspace_mode = raw.get("workspace_mode", "copy")
    if workspace_mode not in {"copy", "cwd"}:
        raise ValueError("workspace_mode must be 'copy' or 'cwd'")
    capture_diff = raw.get("capture_diff", True)
    if not isinstance(capture_diff, bool):
        raise ValueError("capture_diff must be true or false")

    return FanoutConfig(
        default_agents=default_agents,
        agents=agents,
        timeout_seconds=timeout_seconds,
        workspace_mode=workspace_mode,
        capture_diff=capture_diff,
        max_output_chars=max_output_chars,
    )


def select_agents(config: FanoutConfig, override: str | None) -> list[AgentConfig]:
    names = parse_agent_names(override) if override else config.default_agents
    missing = [name for name in names if name not in config.agents]
    if missing:
        known = ", ".join(sorted(config.agents))
        raise ValueError(f"Unknown agent(s): {', '.join(missing)}. Known agents: {known}")
    return [config.agents[name] for name in names]


def parse_agent_names(raw: str) -> list[str]:
    names = [item.strip() for item in raw.split(",") if item.strip()]
    if not names:
        raise ValueError("--agents must name at least one agent")
    return names


def _positive_int(value: Any, key: str) -> int:
    if not isinstance(value, int) or value <= 0:
        raise ValueError(f"{key} must be a positive integer")
    return value


def _non_negative_int(value: Any, key: str) -> int:
    if not isinstance(value, int) or value < 0:
        raise ValueError(f"{key} must be a non-negative integer")
    return value


def load_toml(path: Path) -> dict[str, Any]:
    if tomllib is not None:
        with path.open("rb") as handle:
            return tomllib.load(handle)
    return parse_simple_toml(path.read_text(encoding="utf-8"))


def parse_simple_toml(text: str) -> dict[str, Any]:
    data: dict[str, Any] = {}
    current: dict[str, Any] = data
    for line_number, raw_line in enumerate(text.splitlines(), start=1):
        line = strip_comment(raw_line).strip()
        if not line:
            continue
        if line.startswith("[") and line.endswith("]"):
            current = data
            for part in line[1:-1].split("."):
                if not part:
                    raise ValueError(f"Invalid TOML table on line {line_number}")
                next_table = current.setdefault(part, {})
                if not isinstance(next_table, dict):
                    raise ValueError(f"Cannot redefine TOML value as table on line {line_number}")
                current = next_table
            continue
        if "=" not in line:
            raise ValueError(f"Invalid TOML assignment on line {line_number}")
        key, raw_value = line.split("=", 1)
        key = key.strip()
        if not re.match(r"^[A-Za-z0-9_-]+$", key):
            raise ValueError(f"Unsupported TOML key on line {line_number}: {key}")
        current[key] = parse_simple_toml_value(raw_value.strip(), line_number)
    return data


def parse_simple_toml_value(raw_value: str, line_number: int) -> Any:
    if raw_value == "true":
        return True
    if raw_value == "false":
        return False
    if re.match(r"^-?\d+$", raw_value):
        return int(raw_value)
    try:
        return json.loads(raw_value)
    except json.JSONDecodeError as exc:
        raise ValueError(
            "Python 3.9 fallback parser supports strings, booleans, integers, "
            f"and JSON-style arrays only; invalid value on line {line_number}: {raw_value}"
        ) from exc


def strip_comment(raw_line: str) -> str:
    in_string = False
    escaped = False
    output: list[str] = []
    for char in raw_line:
        if escaped:
            output.append(char)
            escaped = False
            continue
        if char == "\\" and in_string:
            output.append(char)
            escaped = True
            continue
        if char == '"':
            in_string = not in_string
            output.append(char)
            continue
        if char == "#" and not in_string:
            break
        output.append(char)
    return "".join(output)
