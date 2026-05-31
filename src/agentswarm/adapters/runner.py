"""The thin subprocess boundary: run one external CLI, capture everything.

This is the only place in the package that actually spawns an external process.
Everything above it (the bridge, the primitives, the runtime) is expressed in
terms of :class:`CliResult`, which makes the higher layers testable without
real agent accounts — a test either points an adapter at a deterministic mock
command, or injects a fake ``run`` callable with the same signature.
"""

from __future__ import annotations

import subprocess
import time
from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class CliResult:
    """The outcome of a single CLI invocation."""

    returncode: int
    stdout: str
    stderr: str
    timed_out: bool
    duration: float

    @property
    def ok(self) -> bool:
        """True when the process exited cleanly and did not time out."""
        return self.returncode == 0 and not self.timed_out


class CommandRunner(Protocol):
    """The injectable contract for executing a command. ``run_command`` fulfils it."""

    def __call__(
        self,
        command: list[str],
        *,
        stdin: str | None = None,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float | None = None,
    ) -> CliResult: ...


def run_command(
    command: list[str],
    *,
    stdin: str | None = None,
    cwd: str | None = None,
    env: dict[str, str] | None = None,
    timeout: float | None = None,
) -> CliResult:
    """Run *command*, returning a :class:`CliResult` instead of raising.

    A timeout or a missing executable is reported through the result
    (``timed_out`` / a non-zero ``returncode`` with the reason on stderr)
    rather than as an exception, so the caller has one uniform thing to inspect.
    """
    started = time.monotonic()
    try:
        completed = subprocess.run(
            command,
            input=stdin,
            cwd=cwd,
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        return CliResult(
            returncode=-1,
            stdout=_as_text(exc.stdout),
            stderr=_as_text(exc.stderr),
            timed_out=True,
            duration=time.monotonic() - started,
        )
    except (FileNotFoundError, PermissionError, OSError) as exc:
        return CliResult(
            returncode=127,
            stdout="",
            stderr=f"failed to launch {command[0]!r}: {exc}",
            timed_out=False,
            duration=time.monotonic() - started,
        )
    return CliResult(
        returncode=completed.returncode,
        stdout=completed.stdout or "",
        stderr=completed.stderr or "",
        timed_out=False,
        duration=time.monotonic() - started,
    )


def _as_text(value: str | bytes | None) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value
