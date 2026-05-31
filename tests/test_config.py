"""L1: configuration model and loader."""

from __future__ import annotations

import pytest

from agentswarm.adapters import default_config, load_config
from agentswarm.errors import AdapterNotFound, ConfigError


def test_default_config_has_builtin_adapters():
    config = default_config()
    assert {"codex", "claude", "gemini", "qwen", "kimi"} <= set(config.adapters)


def test_load_merges_file_over_builtins(tmp_path):
    (tmp_path / "agentswarm.toml").write_text(
        """
        default_adapter = "claude"
        concurrency = 9

        [adapters.custom]
        command = ["my-agent", "{prompt}"]
        """,
        encoding="utf-8",
    )
    config = load_config(tmp_path / "agentswarm.toml")
    assert config.settings.default_adapter == "claude"
    assert config.settings.concurrency == 9
    assert "custom" in config.adapters
    assert "codex" in config.adapters  # builtins still present


def test_user_entry_overrides_builtin(tmp_path):
    (tmp_path / "agentswarm.toml").write_text(
        """
        [adapters.codex]
        command = ["my-codex", "{prompt}"]
        """,
        encoding="utf-8",
    )
    config = load_config(tmp_path / "agentswarm.toml")
    assert config.adapters["codex"].command == ("my-codex", "{prompt}")


def test_adapter_resolution_and_default():
    config = load_config_from_default()
    assert config.adapter(None).name == "claude"
    assert config.adapter("codex").name == "codex"


def test_unknown_adapter_lists_available():
    config = load_config_from_default()
    with pytest.raises(AdapterNotFound) as exc:
        config.adapter("nope")
    assert "nope" in str(exc.value)


def test_missing_default_without_choice_is_an_error():
    config = default_config()  # builtins, no default_adapter, several adapters
    with pytest.raises(AdapterNotFound):
        config.adapter(None)


def test_invalid_adapter_command_is_rejected(tmp_path):
    (tmp_path / "agentswarm.toml").write_text(
        """
        [adapters.broken]
        stdin = "{prompt}"
        """,
        encoding="utf-8",
    )
    with pytest.raises(ConfigError):
        load_config(tmp_path / "agentswarm.toml")


def test_missing_explicit_config_path_raises(tmp_path):
    with pytest.raises(ConfigError):
        load_config(tmp_path / "does-not-exist.toml")


def test_resolved_concurrency_and_runs_root():
    settings = default_config().settings
    assert settings.resolved_concurrency() >= 1
    assert settings.resolved_runs_root().name == "runs"


def load_config_from_default():
    """Builtins plus a default_adapter, built from a temp file-free path."""
    config = default_config()
    from dataclasses import replace

    return replace(config, settings=replace(config.settings, default_adapter="claude"))
