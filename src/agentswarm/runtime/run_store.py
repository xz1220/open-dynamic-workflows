"""The run directory: the file-backed seam between front and back.

A run is just a directory under ``runs_root``. The background worker writes to
it; the CLI reads from it. They never talk directly, which is what lets a run
outlive the command that started it and be observed from anywhere.

Layout of ``<runs_root>/<run_id>/``::

    meta.json      immutable run description (script, args, source, config)
    status.json    mutable state (running/paused/done/failed/stopped, counters)
    events.jsonl   append-only progress stream
    result.json    final return value (on success)
    error.json     message + traceback (on failure)
    control.json   pause/resume/stop request written by the CLI
    worker.log     the worker process's stdout/stderr

All JSON writes are atomic (temp file + rename) so a concurrent reader never
sees a half-written file.
"""

from __future__ import annotations

import json
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any

# Terminal states: a run in one of these will not change again.
TERMINAL_STATES = frozenset({"done", "failed", "stopped"})

_META = "meta.json"
_STATUS = "status.json"
_EVENTS = "events.jsonl"
_RESULT = "result.json"
_ERROR = "error.json"
_CONTROL = "control.json"
_LOG = "worker.log"


class RunStore:
    """Reads and writes run directories under a root."""

    def __init__(self, root: str | os.PathLike[str]) -> None:
        self.root = Path(root)
        # Serializes status read-modify-write: within a worker, the main thread
        # and FileControl (on pause/stop) may both update status concurrently.
        self._status_lock = threading.Lock()

    # --- creation & paths ----------------------------------------------------

    def create(
        self,
        *,
        script: str,
        args: Any,
        config_path: str | None,
        source: str,
    ) -> str:
        run_id = _new_run_id()
        directory = self.run_dir(run_id)
        directory.mkdir(parents=True, exist_ok=False)
        _write_json(
            directory / _META,
            {
                "run_id": run_id,
                "script": str(script),
                "args": args,
                "config_path": config_path,
                "source": str(source),
                "created_at": time.time(),
            },
        )
        _write_json(
            directory / _STATUS,
            {"run_id": run_id, "state": "pending", "dispatched": 0, "updated_at": time.time()},
        )
        return run_id

    def run_dir(self, run_id: str) -> Path:
        return self.root / run_id

    def exists(self, run_id: str) -> bool:
        return (self.run_dir(run_id) / _META).is_file()

    def events_path(self, run_id: str) -> Path:
        return self.run_dir(run_id) / _EVENTS

    def log_path(self, run_id: str) -> Path:
        return self.run_dir(run_id) / _LOG

    def control_path(self, run_id: str) -> Path:
        return self.run_dir(run_id) / _CONTROL

    # --- meta & status -------------------------------------------------------

    def read_meta(self, run_id: str) -> dict[str, Any]:
        return _read_json(self.run_dir(run_id) / _META) or {}

    def read_status(self, run_id: str) -> dict[str, Any]:
        return _read_json(self.run_dir(run_id) / _STATUS) or {}

    def update_status(self, run_id: str, **fields: Any) -> dict[str, Any]:
        """Merge *fields* into status.json and stamp ``updated_at`` (atomically)."""
        with self._status_lock:
            status = self.read_status(run_id)
            status.update(fields)
            status["updated_at"] = time.time()
            _write_json(self.run_dir(run_id) / _STATUS, status)
            return status

    # --- events --------------------------------------------------------------

    def read_events(self, run_id: str) -> list[dict[str, Any]]:
        path = self.events_path(run_id)
        if not path.is_file():
            return []
        events: list[dict[str, Any]] = []
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line:
                events.append(json.loads(line))
        return events

    # --- result & error ------------------------------------------------------

    def write_result(self, run_id: str, value: Any) -> None:
        _write_json(self.run_dir(run_id) / _RESULT, {"value": value}, default=str)

    def read_result(self, run_id: str) -> Any:
        payload = _read_json(self.run_dir(run_id) / _RESULT)
        return None if payload is None else payload.get("value")

    def has_result(self, run_id: str) -> bool:
        return (self.run_dir(run_id) / _RESULT).is_file()

    def write_error(self, run_id: str, error: dict[str, Any]) -> None:
        _write_json(self.run_dir(run_id) / _ERROR, error)

    def read_error(self, run_id: str) -> dict[str, Any] | None:
        return _read_json(self.run_dir(run_id) / _ERROR)

    # --- control -------------------------------------------------------------

    def write_control(self, run_id: str, action: str) -> None:
        _write_json(self.control_path(run_id), {"action": action, "at": time.time()})

    def read_control(self, run_id: str) -> str | None:
        payload = _read_json(self.control_path(run_id))
        return None if payload is None else payload.get("action")

    # --- listing -------------------------------------------------------------

    def list_runs(self) -> list[str]:
        if not self.root.is_dir():
            return []
        ids = [p.name for p in self.root.iterdir() if (p / _META).is_file()]
        return sorted(ids)


class JsonlSink:
    """An :class:`agentswarm.events.EventSink` that appends to events.jsonl.

    Thread-safe: ``parallel`` / ``pipeline`` emit from many worker threads at
    once, so each append is serialized under a lock.
    """

    def __init__(self, path: str | os.PathLike[str]) -> None:
        self.path = Path(path)
        self._lock = threading.Lock()

    def emit(self, ev: dict[str, Any]) -> None:
        line = json.dumps(ev, ensure_ascii=False, default=str)
        with self._lock:
            with self.path.open("a", encoding="utf-8") as fh:
                fh.write(line + "\n")


# --- module helpers ----------------------------------------------------------


def _new_run_id() -> str:
    return f"{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}"


def _write_json(path: Path, payload: Any, *, default=None) -> None:
    # Unique temp name (pid + random) so concurrent writers to the same target
    # never fight over one ".tmp" file; the rename itself is atomic.
    tmp = path.parent / f"{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
    body = json.dumps(payload, ensure_ascii=False, indent=2, default=default)
    tmp.write_text(body, encoding="utf-8")
    os.replace(tmp, path)


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
