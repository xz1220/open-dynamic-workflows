"""Command-line front end (L6).

``swarm`` starts runs and observes them. It is a thin client over the run
directory: ``run`` launches a background worker, everything else reads or pokes
the run directory. Nothing here holds run state — that lives on disk — so the
CLI and the worker stay fully decoupled.

Commands::

    swarm run <script.py> [--args JSON|@file] [--wait]
    swarm list
    swarm status <run_id>
    swarm logs <run_id> [--follow]
    swarm result <run_id>
    swarm pause|resume|stop <run_id>
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

from .adapters import load_config
from .errors import AgentSwarmError
from .runtime.launcher import start_run, wait_for
from .runtime.run_store import TERMINAL_STATES, RunStore


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.print_help()
        return 2
    try:
        return args.func(args)
    except AgentSwarmError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except FileNotFoundError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


# --- parser ------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="swarm", description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command")

    run = sub.add_parser("run", help="launch a workflow script in the background")
    run.add_argument("script", help="path to the workflow .py file")
    run.add_argument("--args", help="JSON args for the workflow, or @file.json")
    run.add_argument("--config", help="path to an agentswarm.toml config")
    run.add_argument("--runs-root", help="directory to store runs under")
    run.add_argument("--source", help="working tree the agents operate on (default: cwd)")
    run.add_argument("--wait", action="store_true", help="block until the run finishes")
    run.add_argument("--timeout", type=float, help="seconds to wait when --wait is set")
    run.set_defaults(func=_cmd_run)

    for name, help_text in [
        ("status", "show a run's current state"),
        ("result", "print a finished run's return value"),
        ("logs", "print a run's progress events"),
    ]:
        p = sub.add_parser(name, help=help_text)
        p.add_argument("run_id")
        _add_store_args(p)
        if name == "logs":
            p.add_argument("--follow", action="store_true", help="stream until the run ends")
        p.set_defaults(func={"status": _cmd_status, "result": _cmd_result, "logs": _cmd_logs}[name])

    listing = sub.add_parser("list", help="list known runs")
    _add_store_args(listing)
    listing.set_defaults(func=_cmd_list)

    for action in ("pause", "resume", "stop"):
        p = sub.add_parser(action, help=f"{action} a running workflow")
        p.add_argument("run_id")
        _add_store_args(p)
        p.set_defaults(func=_make_control_cmd(action))

    return parser


def _add_store_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--config", help="path to an agentswarm.toml config")
    parser.add_argument("--runs-root", help="directory runs are stored under")


# --- commands ----------------------------------------------------------------


def _cmd_run(args: argparse.Namespace) -> int:
    run_id, store = start_run(
        args.script,
        args=_parse_args_value(args.args),
        config_path=args.config,
        runs_root=args.runs_root,
        source=args.source,
    )
    if not args.wait:
        print(run_id)
        print(f"started run {run_id} (use `swarm status {run_id}`)", file=sys.stderr)
        return 0

    print(f"running {run_id} ...", file=sys.stderr)
    status = wait_for(store, run_id, timeout=args.timeout)
    return _report_terminal(store, run_id, status)


def _cmd_status(args: argparse.Namespace) -> int:
    store = _store(args)
    _require_run(store, args.run_id)
    status = store.read_status(args.run_id)
    meta = store.read_meta(args.run_id)
    name = status.get("name") or Path(meta.get("script", "")).name
    print(f"{args.run_id}  [{status.get('state', '?')}]  {name}")
    if status.get("description"):
        print(f"  {status['description']}")
    print(f"  dispatched: {status.get('dispatched', 0)} agent(s)")
    return 0


def _cmd_result(args: argparse.Namespace) -> int:
    store = _store(args)
    _require_run(store, args.run_id)
    status = store.read_status(args.run_id)
    return _report_terminal(store, args.run_id, status)


def _cmd_logs(args: argparse.Namespace) -> int:
    store = _store(args)
    _require_run(store, args.run_id)
    seen = 0
    while True:
        events = store.read_events(args.run_id)
        for ev in events[seen:]:
            print(_format_event(ev))
        seen = len(events)
        if not args.follow:
            return 0
        if store.read_status(args.run_id).get("state") in TERMINAL_STATES:
            return 0
        time.sleep(0.3)


def _cmd_list(args: argparse.Namespace) -> int:
    store = _store(args)
    run_ids = store.list_runs()
    if not run_ids:
        print("no runs found", file=sys.stderr)
        return 0
    for run_id in run_ids:
        status = store.read_status(run_id)
        name = status.get("name") or ""
        print(f"{run_id}  {status.get('state', '?'):<8}  {name}")
    return 0


def _make_control_cmd(action: str):
    def command(args: argparse.Namespace) -> int:
        store = _store(args)
        _require_run(store, args.run_id)
        store.write_control(args.run_id, action)
        print(f"{action} requested for {args.run_id}", file=sys.stderr)
        return 0

    return command


# --- helpers -----------------------------------------------------------------


def _store(args: argparse.Namespace) -> RunStore:
    if args.runs_root:
        return RunStore(args.runs_root)
    return RunStore(load_config(args.config).settings.resolved_runs_root())


def _require_run(store: RunStore, run_id: str) -> None:
    if not store.exists(run_id):
        raise FileNotFoundError(f"no such run: {run_id}")


def _report_terminal(store: RunStore, run_id: str, status: dict[str, Any]) -> int:
    """Print the outcome of a (hopefully) finished run; return an exit code."""
    state = status.get("state")
    if state == "done":
        print(json.dumps(store.read_result(run_id), ensure_ascii=False, indent=2))
        return 0
    if state == "failed":
        error = store.read_error(run_id) or {}
        print(f"run failed: {error.get('error', 'unknown error')}", file=sys.stderr)
        return 1
    if state == "stopped":
        print("run was stopped before completion", file=sys.stderr)
        return 1
    print(f"run is still {state!r}; not finished", file=sys.stderr)
    return 1


def _parse_args_value(raw: str | None) -> Any:
    """Interpret --args: ``@file`` reads JSON from a file; otherwise parse JSON.

    A value that is not valid JSON is passed through as a plain string, so
    ``--args hello`` works without quoting.
    """
    if raw is None:
        return None
    if raw.startswith("@"):
        raw = Path(raw[1:]).read_text(encoding="utf-8")
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return raw


def _format_event(ev: dict[str, Any]) -> str:
    stamp = time.strftime("%H:%M:%S", time.localtime(ev.get("ts", 0)))
    etype = ev.get("type", "?")
    phase = f" ({ev['phase']})" if ev.get("phase") else ""
    if etype == "log":
        detail = ev.get("message", "")
    elif etype == "phase_started":
        detail = f"phase: {ev.get('phase', '')}"
        phase = ""
    elif etype in ("agent_started", "agent_finished", "agent_failed"):
        detail = ev.get("label", "agent")
        if etype == "agent_failed":
            detail += f" — {ev.get('error', '')}"
    else:
        detail = ev.get("error", "") or ev.get("run_id", "")
    return f"[{stamp}] {etype:<15}{phase} {detail}".rstrip()


if __name__ == "__main__":
    raise SystemExit(main())
