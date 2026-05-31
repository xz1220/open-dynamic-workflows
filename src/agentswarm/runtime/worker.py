"""Workflow worker (L5): load one script and run it to completion.

This is the back end. It runs in its own process (started by the launcher), so
the workflow holds its entire plan in local variables while only the final
return value is written back to the run directory. Exactly one run executes per
worker process, which is what makes the process-global primitive binding safe.

It can also be called in-process (``execute_run``) — that is how the tests
exercise the full stack without spawning a subprocess.
"""

from __future__ import annotations

import inspect
import os
import sys
import traceback
from pathlib import Path
from typing import Any

from ..adapters import load_config
from ..context import build_context
from ..errors import RunStopped, WorkflowError
from ..events import RUN_FAILED, RUN_FINISHED, RUN_STARTED, RUN_STOPPED, event
from ..primitives import bind
from .file_control import FileControl
from .run_store import JsonlSink, RunStore


def execute_run(run_dir: str | os.PathLike[str]) -> str:
    """Run the workflow described by *run_dir*; return its terminal state."""
    run_dir = Path(run_dir)
    store = RunStore(run_dir.parent)
    run_id = run_dir.name

    meta = store.read_meta(run_id)
    if not meta:
        raise WorkflowError(f"no run metadata found at {run_dir}")

    config = load_config(meta.get("config_path"))
    sink = JsonlSink(store.events_path(run_id))
    control = FileControl(
        read_action=lambda: store.read_control(run_id),
        on_state=lambda state: store.update_status(run_id, state=state),
    )
    args = meta.get("args")
    ctx = build_context(config, source=meta.get("source"), args=args, sink=sink, control=control)

    store.update_status(run_id, state="running", pid=os.getpid())
    sink.emit(event(RUN_STARTED, run_id=run_id))

    try:
        namespace = _load_script(meta["script"])
        _record_meta(store, run_id, namespace)
        workflow_fn = _resolve_workflow(namespace)
        with bind(ctx):
            result = _call_workflow(workflow_fn, args)
    except RunStopped:
        sink.emit(event(RUN_STOPPED, run_id=run_id))
        store.update_status(run_id, state="stopped", dispatched=ctx.scheduler.dispatched)
        return "stopped"
    except BaseException as exc:  # noqa: BLE001 - persist the failure, never crash silently
        sink.emit(event(RUN_FAILED, run_id=run_id, error=str(exc)))
        store.write_error(run_id, {"error": str(exc), "traceback": traceback.format_exc()})
        store.update_status(run_id, state="failed", dispatched=ctx.scheduler.dispatched)
        return "failed"

    store.write_result(run_id, result)
    sink.emit(event(RUN_FINISHED, run_id=run_id))
    store.update_status(run_id, state="done", dispatched=ctx.scheduler.dispatched)
    return "done"


# --- script loading ----------------------------------------------------------


def _load_script(path: str) -> dict[str, Any]:
    script_path = Path(path)
    if not script_path.is_file():
        raise WorkflowError(f"workflow script not found: {script_path}")
    # Let a script import helper modules sitting next to it.
    sys.path.insert(0, str(script_path.parent))
    namespace: dict[str, Any] = {
        "__name__": "__agentswarm_workflow__",
        "__file__": str(script_path),
    }
    source = script_path.read_text(encoding="utf-8")
    exec(compile(source, str(script_path), "exec"), namespace)  # noqa: S102 - trusted local script
    return namespace


def _record_meta(store: RunStore, run_id: str, namespace: dict[str, Any]) -> None:
    meta = namespace.get("META")
    if isinstance(meta, dict):
        store.update_status(
            run_id,
            name=meta.get("name"),
            description=meta.get("description"),
            phases=meta.get("phases"),
        )


def _resolve_workflow(namespace: dict[str, Any]):
    fn = namespace.get("workflow")
    if not callable(fn):
        raise WorkflowError("workflow script must define a callable named 'workflow'")
    return fn


def _call_workflow(fn, args: Any) -> Any:
    """Call ``workflow(args)`` if it takes a parameter, else ``workflow()``."""
    try:
        parameters = inspect.signature(fn).parameters.values()
        accepts_arg = any(
            p.kind
            in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD, p.VAR_POSITIONAL)
            for p in parameters
        )
    except (TypeError, ValueError):
        accepts_arg = True
    return fn(args) if accepts_arg else fn()


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) != 1:
        print("usage: python -m agentswarm.runtime.worker <run_dir>", file=sys.stderr)
        return 2
    execute_run(argv[0])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
