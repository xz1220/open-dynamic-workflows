"""L1: command-template placeholder expansion."""

from __future__ import annotations

from agentswarm.adapters import expand, expand_all


def test_known_placeholders_are_replaced():
    ctx = {"prompt": "hi", "workspace": "/tmp/ws"}
    assert expand("run {prompt} in {workspace}", ctx) == "run hi in /tmp/ws"


def test_unknown_braces_are_left_untouched():
    assert expand("echo {undefined} {prompt}", {"prompt": "x"}) == "echo {undefined} x"


def test_missing_known_placeholder_expands_to_empty():
    assert expand("a{prompt}b", {}) == "ab"


def test_expand_all_over_a_command_list():
    cmd = ["tool", "--cd", "{workspace}", "{prompt}"]
    assert expand_all(cmd, {"workspace": "/w", "prompt": "p"}) == ["tool", "--cd", "/w", "p"]
