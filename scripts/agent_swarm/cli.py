from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .config import load_config, select_agents
from .core import Artifact, run_swarm

VALID_ACTIONS = ("plan", "execute", "review")


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "action", None):
        parser.print_help()
        return 0
    return run_from_args(args)


def plan_main(argv: list[str] | None = None) -> int:
    return command_entry("plan", argv)


def execute_main(argv: list[str] | None = None) -> int:
    return command_entry("execute", argv)


def review_main(argv: list[str] | None = None) -> int:
    return command_entry("review", argv)


def command_entry(action: str, argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog=f"agent-swarm-{action}")
    add_common_args(parser)
    parser.set_defaults(action=action)
    args = parser.parse_args(argv)
    return run_from_args(args)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="agent-swarm")
    subparsers = parser.add_subparsers(dest="action")
    for action in VALID_ACTIONS:
        subparser = subparsers.add_parser(action)
        add_common_args(subparser)
    return parser


def add_common_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--task", help="Task, problem, or review focus text.")
    parser.add_argument("--agents", help="Comma-separated agent names overriding default_agents.")
    parser.add_argument("--config", help="Path to agent-swarm TOML config.")
    parser.add_argument("--source", default=".", help="Workspace source to copy. Defaults to cwd.")
    parser.add_argument(
        "--artifact",
        action="append",
        default=[],
        help="Artifact file for review. Repeatable.",
    )
    parser.add_argument(
        "--workspace-mode",
        choices=["copy", "cwd"],
        help="Override workspace mode.",
    )
    parser.add_argument(
        "--no-workspace-copy",
        action="store_true",
        help="Run in the source workspace directly.",
    )
    parser.add_argument(
        "--keep-workspaces",
        action="store_true",
        help="Keep temporary workspaces for inspection.",
    )
    parser.add_argument("--timeout", type=int, help="Per-agent timeout in seconds.")
    parser.add_argument("--json", action="store_true", help="Print JSON instead of Markdown.")
    parser.add_argument(
        "prompt",
        nargs=argparse.REMAINDER,
        help="Task text when --task is not used.",
    )


def run_from_args(args: argparse.Namespace) -> int:
    try:
        task = read_task(args)
        config, config_path = load_config(args.config)
        agents = select_agents(config, args.agents)
        workspace_mode = "cwd" if args.no_workspace_copy else args.workspace_mode
        artifacts = load_artifacts(args.artifact)
        run = run_swarm(
            action=args.action,
            task=task,
            source=Path(args.source),
            config=config,
            config_path=config_path,
            agents=agents,
            artifacts=artifacts,
            workspace_mode=workspace_mode,
            keep_workspaces=args.keep_workspaces,
            timeout_seconds=args.timeout,
        )
    except Exception as exc:
        print(f"agent-swarm: {exc}", file=sys.stderr)
        return 2
    print(run.to_json() if args.json else run.to_markdown(), end="")
    return 0 if all(result.status == "ok" for result in run.results) else 1


def read_task(args: argparse.Namespace) -> str:
    if args.task:
        return args.task
    if args.prompt:
        prompt = " ".join(args.prompt).strip()
        if prompt:
            return prompt
    if not sys.stdin.isatty():
        stdin = sys.stdin.read().strip()
        if stdin:
            return stdin
    raise ValueError("missing task text; pass --task, positional text, or stdin")


def load_artifacts(paths: list[str]) -> list[Artifact]:
    artifacts: list[Artifact] = []
    for raw_path in paths:
        if raw_path == "-":
            artifacts.append(Artifact(path="<stdin>", content=sys.stdin.read()))
            continue
        path = Path(raw_path).expanduser()
        if not path.exists():
            raise ValueError(f"artifact not found: {path}")
        if not path.is_file():
            raise ValueError(f"artifact is not a file: {path}")
        content = path.read_text(encoding="utf-8", errors="replace")
        artifacts.append(Artifact(path=str(path), content=content))
    return artifacts
