"""Cross-cutting: workspace isolation and diff capture."""

from __future__ import annotations

from agentswarm.workspace import COPY_MODE, INPLACE_MODE, open_workspace


def _seed(root):
    (root / "keep.txt").write_text("original\n", encoding="utf-8")
    (root / "pkg").mkdir()
    (root / "pkg" / "mod.py").write_text("x = 1\n", encoding="utf-8")


def test_inplace_runs_in_source_and_has_no_diff(tmp_path):
    _seed(tmp_path)
    with open_workspace(tmp_path, INPLACE_MODE) as ws:
        assert ws.path == tmp_path.resolve()
        (ws.path / "keep.txt").write_text("touched\n", encoding="utf-8")
        assert ws.diff() == ""


def test_copy_isolates_changes_from_source(tmp_path):
    _seed(tmp_path)
    with open_workspace(tmp_path, COPY_MODE) as ws:
        assert ws.path != tmp_path.resolve()
        (ws.path / "keep.txt").write_text("changed\n", encoding="utf-8")
        (ws.path / "new.txt").write_text("brand new\n", encoding="utf-8")
        diff = ws.diff()

    # Source is untouched ...
    assert (tmp_path / "keep.txt").read_text() == "original\n"
    assert not (tmp_path / "new.txt").exists()
    # ... but the diff records both the edit and the addition.
    assert "keep.txt" in diff
    assert "changed" in diff
    assert "new.txt" in diff


def test_copy_skips_ignored_directories(tmp_path):
    _seed(tmp_path)
    (tmp_path / ".git").mkdir()
    (tmp_path / ".git" / "HEAD").write_text("ref\n", encoding="utf-8")
    with open_workspace(tmp_path, COPY_MODE) as ws:
        assert not (ws.path / ".git").exists()


def test_copy_cleans_up_on_exit(tmp_path):
    _seed(tmp_path)
    with open_workspace(tmp_path, COPY_MODE) as ws:
        copy_root = ws.path
    assert not copy_root.exists()
