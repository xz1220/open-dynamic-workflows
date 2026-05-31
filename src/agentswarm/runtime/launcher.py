"""Start runs in the background and wait on them (L5).

``start_run`` is fire-and-forget: it creates the run directory, spawns a
detached worker process, and returns the run id immediately. The caller polls
the run directory afterwards (that is what the CLI's ``status`` / ``logs`` /
``result`` do, and what ``wait_for`` does for ``--wait``).
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from ..adapters import load_config
from .run_store import TERMINAL_STATES, RunStore


def start_run(
    script: str | os.PathLike[str],
    *,
    args: Any = None,
    config_path: str | None = None,
    runs_root: str | os.PathLike[str] | None = None,
    source: str | os.PathLike[str] | None = None,
) -> tuple[str, RunStore]:
    """Create a run and launch its worker process; return ``(run_id, store)``."""
    script_path = Path(script).resolve()
    if not script_path.is_file():
        raise FileNotFoundError(f"workflow script not found: {script_path}")

    config = load_config(config_path)  # validates config & resolves runs_root default
    root = Path(runs_root) if runs_root else config.settings.resolved_runs_root()
    source_dir = str(Path(source).resolve()) if source else os.getcwd()

    store = RunStore(root)
    run_id = store.create(
        script=str(script_path),
        args=args,
        config_path=config_path,
        source=source_dir,
    )

    command = [sys.executable, "-m", "agentswarm.runtime.worker", str(store.run_dir(run_id))]
    with store.log_path(run_id).open("w", encoding="utf-8") as logfile:
        subprocess.Popen(  # noqa: S603 - command is fully controlled
            command,
            stdout=logfile,
            stderr=subprocess.STDOUT,
            cwd=source_dir,
            env=_worker_env(),
            start_new_session=True,  # detach: the run outlives this process
        )
    return run_id, store


def wait_for(
    store: RunStore,
    run_id: str,
    *,
    timeout: float | None = None,
    poll_interval: float = 0.2,
) -> dict[str, Any]:
    """Block until the run reaches a terminal state (or *timeout*); return status."""
    deadline = None if timeout is None else time.monotonic() + timeout
    while True:
        status = store.read_status(run_id)
        if status.get("state") in TERMINAL_STATES:
            return status
        if deadline is not None and time.monotonic() >= deadline:
            return status
        time.sleep(poll_interval)


def _worker_env() -> dict[str, str]:
    """Let the worker import ``agentswarm`` even when running from a source tree."""
    env = dict(os.environ)
    src_dir = Path(__file__).resolve().parents[2]  # .../src
    existing = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = os.pathsep.join([str(src_dir), existing] if existing else [str(src_dir)])
    return env
