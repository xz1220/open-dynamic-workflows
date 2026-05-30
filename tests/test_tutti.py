from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from tutti.config import default_config, parse_simple_toml

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "scripts" / "tutti.py"


def write_config(path: Path, python: str) -> Path:
    config = path / "config.toml"
    alpha_code = (
        "import sys; "
        "prompt=sys.stdin.read(); "
        "print('alpha:' + prompt.split('Task:', 1)[1].strip().splitlines()[0])"
    )
    beta_code = (
        "import pathlib; "
        "pathlib.Path('beta.txt').write_text('beta output' + chr(10)); "
        "print('beta done')"
    )
    alpha_command = json.dumps([python, "-c", alpha_code])
    beta_command = json.dumps([python, "-c", beta_code])
    config.write_text(
        f"""
default_agents = ["alpha", "beta"]
timeout_seconds = 30
workspace_mode = "copy"
capture_diff = true

[agents.alpha]
label = "Alpha Mock"
command = {alpha_command}
stdin = "{{prompt}}"

[agents.beta]
label = "Beta Mock"
command = {beta_command}
""".strip()
    )
    return config


def run_cli(tmp_path: Path, args: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["PYTHONPATH"] = str(ROOT / "scripts")
    return subprocess.run(
        [sys.executable, str(CLI), *args],
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


def test_plan_collects_each_agent_raw_output(tmp_path: Path) -> None:
    config = write_config(tmp_path, sys.executable)
    result = run_cli(
        tmp_path,
        ["plan", "--config", str(config), "--task", "design the interface", "--json"],
        cwd=tmp_path,
    )
    assert result.returncode == 0
    payload = json.loads(result.stdout)
    assert payload["action"] == "plan"
    assert [item["agent"] for item in payload["results"]] == ["alpha", "beta"]
    assert "alpha:design the interface" in payload["results"][0]["stdout"]
    assert "beta done" in payload["results"][1]["stdout"]


def test_agent_override_runs_only_named_agent(tmp_path: Path) -> None:
    config = write_config(tmp_path, sys.executable)
    result = run_cli(
        tmp_path,
        ["plan", "--config", str(config), "--agents", "alpha", "--task", "narrow run", "--json"],
        cwd=tmp_path,
    )
    assert result.returncode == 0
    payload = json.loads(result.stdout)
    assert [item["agent"] for item in payload["results"]] == ["alpha"]


def test_execute_uses_isolated_workspace_and_returns_diff(tmp_path: Path) -> None:
    config = write_config(tmp_path, sys.executable)
    source = tmp_path / "source"
    source.mkdir()
    (source / "existing.txt").write_text("original\n")
    subprocess.run(["git", "init", "-q"], cwd=source, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=source, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=source, check=True)
    subprocess.run(["git", "add", "-A"], cwd=source, check=True)
    subprocess.run(["git", "commit", "-qm", "baseline"], cwd=source, check=True)

    result = run_cli(
        tmp_path,
        [
            "execute",
            "--config",
            str(config),
            "--source",
            str(source),
            "--agents",
            "beta",
            "--task",
            "create beta file",
            "--json",
        ],
        cwd=tmp_path,
    )
    assert result.returncode == 0
    payload = json.loads(result.stdout)
    beta = payload["results"][0]
    assert beta["workspace_is_copy"] is True
    assert "beta.txt" in beta["git_status"]
    assert "beta output" in beta["diff"]
    assert not (source / "beta.txt").exists()


def test_review_includes_artifact_content_in_prompt(tmp_path: Path) -> None:
    artifact = tmp_path / "change.patch"
    artifact.write_text("diff --git a/a.txt b/a.txt\n+important artifact line\n")
    config = tmp_path / "config.toml"
    reader_code = (
        "import sys; "
        "data=sys.stdin.read(); "
        "print('has artifact', 'important artifact line' in data)"
    )
    reader_command = json.dumps([sys.executable, "-c", reader_code])
    config.write_text(
        f"""
default_agents = ["reader"]

[agents.reader]
command = {reader_command}
stdin = "{{prompt}}"
""".strip()
    )
    result = run_cli(
        tmp_path,
        [
            "review",
            "--config",
            str(config),
            "--artifact",
            str(artifact),
            "--task",
            "review it",
            "--json",
        ],
        cwd=tmp_path,
    )
    assert result.returncode == 0
    payload = json.loads(result.stdout)
    assert "has artifact True" in payload["results"][0]["stdout"]


def test_prompt_expansion_preserves_placeholders_inside_prompt(tmp_path: Path) -> None:
    artifact = tmp_path / "config.example.toml"
    artifact.write_text('command = ["codex", "--cd", "{workspace}", "-"]\n')
    config = tmp_path / "config.toml"
    reader_code = (
        "import sys; "
        "data=sys.stdin.read(); "
        "artifact=data.split('--- artifact:', 1)[1].split('--- end artifact:', 1)[0]; "
        "target='\"' + '{' + 'workspace' + '}' + '\"'; "
        "print('literal placeholder', target in artifact); "
        "print('temp path leaked', '/tutti-' in artifact)"
    )
    reader_command = json.dumps([sys.executable, "-c", reader_code])
    config.write_text(
        f"""
default_agents = ["reader"]

[agents.reader]
command = {reader_command}
stdin = "{{prompt}}"
""".strip()
    )
    result = run_cli(
        tmp_path,
        [
            "review",
            "--config",
            str(config),
            "--artifact",
            str(artifact),
            "--task",
            "review placeholders",
            "--json",
        ],
        cwd=tmp_path,
    )
    assert result.returncode == 0
    payload = json.loads(result.stdout)
    stdout = payload["results"][0]["stdout"]
    assert "literal placeholder True" in stdout
    assert "temp path leaked False" in stdout


def test_docs_do_not_reference_nonexistent_skill_triggers() -> None:
    invalid = ("$tutti-plan", "$tutti-execute", "$tutti-review")
    paths = [ROOT / "README.md", ROOT / "SKILL.md", ROOT / "agents" / "openai.yaml"]
    for path in paths:
        content = path.read_text()
        for trigger in invalid:
            assert trigger not in content, f"{path} references nonexistent skill {trigger}"


def test_python39_fallback_parser_supports_multiline_arrays() -> None:
    payload = parse_simple_toml(
        """
default_agents = ["codex", "claude"]

[agents.codex]
command = [
  "codex",
  "exec",
  "--cd",
  "{workspace}",
  "-"
]
stdin = "{prompt}"
""".strip()
    )
    assert payload["default_agents"] == ["codex", "claude"]
    assert payload["agents"]["codex"]["command"] == [
        "codex",
        "exec",
        "--cd",
        "{workspace}",
        "-",
    ]
    assert payload["agents"]["codex"]["stdin"] == "{prompt}"


def test_builtin_claude_adapter_uses_stdin() -> None:
    claude = default_config().agents["claude"]
    assert "{prompt}" not in claude.command
    assert claude.stdin == "{prompt}"


def test_builtin_qwen_and_kimi_adapters_are_available() -> None:
    config = default_config()
    assert config.default_agents == ["codex", "claude", "gemini", "qwen", "kimi"]

    qwen = config.agents["qwen"]
    assert qwen.label == "Qwen Code"
    assert qwen.command == [
        "qwen",
        "--approval-mode",
        "auto-edit",
        "--output-format",
        "text",
        "{prompt}",
    ]
    assert qwen.stdin is None

    kimi = config.agents["kimi"]
    assert kimi.label == "Kimi CLI"
    assert kimi.command == [
        "kimi",
        "--work-dir",
        "{workspace}",
        "--print",
        "--input-format",
        "text",
        "--output-format",
        "text",
    ]
    assert kimi.stdin == "{prompt}"
