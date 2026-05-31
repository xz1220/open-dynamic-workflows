"""Workspace isolation and diff capture (cross-cutting).

Each ``agent`` call runs against a *workspace*. Two modes:

* ``copy`` (default): the source tree is copied to a throwaway directory, the
  agent runs there, and the changes it made are returned as a unified diff. The
  caller's real working tree is never touched.
* ``inplace``: the agent runs directly in the source directory and no diff is
  produced. Cheaper, and the right choice for read-only / analysis workflows
  that never write files.

Diffs are computed with the standard library (``difflib``) so there is no
dependency on ``git`` being present. Binary and oversized files are copied but
excluded from the textual diff, which keeps the diff readable and bounded.
"""

from __future__ import annotations

import difflib
import shutil
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

COPY_MODE = "copy"
INPLACE_MODE = "inplace"

# Directories never worth copying into an isolated workspace.
_IGNORED_DIRS = frozenset(
    {".git", ".venv", "venv", "__pycache__", "node_modules", ".pytest_cache", ".ruff_cache"}
)
# Files larger than this are copied but skipped in the textual diff.
_MAX_DIFF_BYTES = 512 * 1024


@dataclass
class Workspace:
    """A directory an agent runs in, plus the means to diff what it changed."""

    path: Path
    source: Path
    _before: dict[str, str] | None  # relpath -> text content, or None for inplace

    def diff(self) -> str:
        """Unified diff of text changes since the workspace was opened.

        Returns an empty string for ``inplace`` mode or when nothing changed.
        """
        if self._before is None:
            return ""
        after = _snapshot(self.path)
        chunks: list[str] = []
        for rel in sorted(set(self._before) | set(after)):
            old = self._before.get(rel, "")
            new = after.get(rel, "")
            if old == new:
                continue
            chunks.extend(
                difflib.unified_diff(
                    old.splitlines(keepends=True),
                    new.splitlines(keepends=True),
                    fromfile=f"a/{rel}",
                    tofile=f"b/{rel}",
                )
            )
        return "".join(chunks)


@contextmanager
def open_workspace(source: Path, mode: str = COPY_MODE) -> Iterator[Workspace]:
    """Open a workspace for one agent run, cleaning up a copy on exit."""
    source = Path(source).resolve()
    if mode == INPLACE_MODE:
        yield Workspace(path=source, source=source, _before=None)
        return
    if mode != COPY_MODE:
        raise ValueError(f"unknown workspace mode {mode!r}; use 'copy' or 'inplace'")

    tmp = Path(tempfile.mkdtemp(prefix="agentswarm-ws-"))
    work = tmp / source.name
    try:
        shutil.copytree(source, work, ignore=_ignore, symlinks=True)
        before = _snapshot(work)
        yield Workspace(path=work, source=source, _before=before)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _ignore(directory: str, names: list[str]) -> set[str]:
    return {n for n in names if n in _IGNORED_DIRS}


def _snapshot(root: Path) -> dict[str, str]:
    """Map each small text file (by path relative to *root*) to its contents."""
    snapshot: dict[str, str] = {}
    for path in root.rglob("*"):
        if not path.is_file() or path.is_symlink():
            continue
        if any(part in _IGNORED_DIRS for part in path.relative_to(root).parts):
            continue
        try:
            if path.stat().st_size > _MAX_DIFF_BYTES:
                continue
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue  # unreadable or binary: copied, but not diffed
        snapshot[str(path.relative_to(root))] = text
    return snapshot
