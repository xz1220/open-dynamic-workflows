from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from contextlib import AbstractContextManager
from pathlib import Path

IGNORED_DIRS = {
    ".git",
    ".hg",
    ".svn",
    ".venv",
    "node_modules",
    "dist",
    "build",
    ".next",
    ".pytest_cache",
    ".ruff_cache",
    "__pycache__",
}


class WorkspaceCopy(AbstractContextManager["WorkspaceCopy"]):
    def __init__(self, source: Path, keep: bool = False, mode: str = "copy"):
        self.source = source.resolve()
        self.keep = keep
        self.mode = mode
        self._tmp: tempfile.TemporaryDirectory[str] | None = None
        self.path = self.source
        self.copied = False

    def __enter__(self) -> WorkspaceCopy:
        if self.mode == "cwd":
            self.path = self.source
            return self

        self._tmp = tempfile.TemporaryDirectory(prefix="agent-swarm-")
        self.path = Path(self._tmp.name) / "workspace"
        self.path.mkdir(parents=True)
        self.copied = True
        copy_workspace(self.source, self.path)
        init_baseline(self.path)
        return self

    def __exit__(self, exc_type, exc, traceback) -> bool:
        if self._tmp and not self.keep:
            self._tmp.cleanup()
        return False


def copy_workspace(source: Path, destination: Path) -> None:
    files = git_visible_files(source)
    if files is None:
        shutil.copytree(
            source, destination, dirs_exist_ok=True, symlinks=True, ignore=_ignore_common
        )
        return

    for rel in files:
        src = source / rel
        dst = destination / rel
        if not src.exists() and not src.is_symlink():
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        if src.is_symlink():
            target = os.readlink(src)
            if dst.exists() or dst.is_symlink():
                dst.unlink()
            os.symlink(target, dst)
        elif src.is_file():
            shutil.copy2(src, dst)


def git_visible_files(source: Path) -> list[Path] | None:
    try:
        inside = subprocess.run(
            ["git", "-C", str(source), "rev-parse", "--is-inside-work-tree"],
            check=False,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError:
        return None
    if inside.returncode != 0 or inside.stdout.strip() != "true":
        return None

    result = subprocess.run(
        [
            "git",
            "-C",
            str(source),
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ],
        check=False,
        capture_output=True,
    )
    if result.returncode != 0:
        return None
    return [Path(item.decode()) for item in result.stdout.split(b"\0") if item]


def init_baseline(path: Path) -> None:
    commands = [
        ["git", "init", "-q"],
        ["git", "config", "user.email", "agent-swarm@example.invalid"],
        ["git", "config", "user.name", "Agent Swarm"],
        ["git", "add", "-A"],
        ["git", "commit", "--allow-empty", "-qm", "agent-swarm baseline"],
    ]
    for command in commands:
        subprocess.run(
            command,
            cwd=path,
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )


def collect_diff(path: Path) -> tuple[str, str]:
    if not (path / ".git").exists():
        return "", ""
    subprocess.run(
        ["git", "add", "-N", "."],
        cwd=path,
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    status = subprocess.run(
        ["git", "status", "--short"],
        cwd=path,
        check=False,
        capture_output=True,
        text=True,
    )
    diff = subprocess.run(
        ["git", "diff", "--binary", "--no-ext-diff", "--no-color", "HEAD", "--"],
        cwd=path,
        check=False,
        capture_output=True,
        text=True,
    )
    return status.stdout, diff.stdout


def _ignore_common(_: str, names: list[str]) -> set[str]:
    return {name for name in names if name in IGNORED_DIRS}
