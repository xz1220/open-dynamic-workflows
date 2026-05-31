"""L1: the subprocess boundary (real processes, no mocking)."""

from __future__ import annotations

import sys

from agentswarm.adapters import run_command


def test_echoes_stdin_and_reports_success():
    echo = "import sys; sys.stdout.write(sys.stdin.read())"
    result = run_command([sys.executable, "-c", echo], stdin="hello")
    assert result.ok
    assert result.stdout == "hello"
    assert result.returncode == 0
    assert not result.timed_out


def test_nonzero_exit_is_not_ok():
    result = run_command([sys.executable, "-c", "import sys; sys.exit(7)"])
    assert not result.ok
    assert result.returncode == 7


def test_timeout_is_reported_not_raised():
    result = run_command([sys.executable, "-c", "import time; time.sleep(5)"], timeout=0.2)
    assert result.timed_out
    assert not result.ok


def test_missing_executable_is_reported():
    result = run_command(["this-binary-does-not-exist-xyz"])
    assert not result.ok
    assert result.returncode == 127
    assert "failed to launch" in result.stderr


def test_env_and_cwd_are_passed(tmp_path):
    code = "import os; print(os.environ['MARKER']); print(os.getcwd())"
    result = run_command(
        [sys.executable, "-c", code],
        cwd=str(tmp_path),
        env={"MARKER": "set", "PATH": ""},
    )
    assert "set" in result.stdout
    assert str(tmp_path) in result.stdout
