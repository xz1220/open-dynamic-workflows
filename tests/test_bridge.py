"""L2: one agent call -> one CLI invocation, with schema handling.

Most cases drive the real mock CLI through a subprocess; the last drives a fake
runner so the schema-retry feedback loop can be asserted deterministically.
"""

from __future__ import annotations

import pytest
import support

from agentswarm import schema
from agentswarm.adapters import CliResult
from agentswarm.bridge import AgentRequest, Bridge
from agentswarm.errors import AdapterExecutionError, SchemaValidationError


def test_echo_returns_text_with_independence_preamble(tmp_path):
    bridge = Bridge(support.make_config(), source=tmp_path)
    out = bridge.run(AgentRequest(prompt="solve X"))
    assert "solve X" in out.text
    assert "independently" in out.text  # preamble was injected
    assert out.value == out.text
    assert out.adapter == "mock"
    assert out.attempts == 1


def test_schema_success_on_first_try(tmp_path):
    adapters = {"mock": support.mock_adapter(env={"MOCK_JSON": '{"ok": true}'})}
    bridge = Bridge(support.make_config(adapters=adapters), source=tmp_path)
    out = bridge.run(AgentRequest(prompt="p", schema=schema.obj({"ok": schema.boolean()})))
    assert out.value == {"ok": True}
    assert out.attempts == 1


def test_schema_retries_then_succeeds(tmp_path):
    env = {
        "MOCK_COUNTER": str(tmp_path / "counter"),
        "MOCK_BAD": "1",
        "MOCK_GOOD": '{"ok": true}',
    }
    config = support.make_config(adapters={"mock": support.mock_adapter(env=env)}, schema_retries=2)
    out = Bridge(config, source=tmp_path).run(
        AgentRequest(prompt="p", schema=schema.obj({"ok": schema.boolean()}))
    )
    assert out.value == {"ok": True}
    assert out.attempts == 2


def test_schema_exhausted_raises(tmp_path):
    config = support.make_config(
        adapters={"mock": support.mock_adapter(env={"MOCK_STDOUT": "never json"})},
        schema_retries=1,
    )
    with pytest.raises(SchemaValidationError):
        Bridge(config, source=tmp_path).run(
            AgentRequest(prompt="p", schema=schema.obj({"ok": schema.boolean()}))
        )


def test_cli_failure_raises_adapter_error(tmp_path):
    config = support.make_config(adapters={"mock": support.mock_adapter(env={"MOCK_FAIL": "1"})})
    with pytest.raises(AdapterExecutionError):
        Bridge(config, source=tmp_path).run(AgentRequest(prompt="p"))


def test_copy_mode_captures_diff_without_touching_source(tmp_path):
    (tmp_path / "file.txt").write_text("orig\n", encoding="utf-8")
    env = {"MOCK_TOUCH": "file.txt", "MOCK_TOUCH_CONTENT": "new content\n"}
    config = support.make_config(
        adapters={"mock": support.mock_adapter(env=env)}, workspace_mode="copy"
    )
    out = Bridge(config, source=tmp_path).run(AgentRequest(prompt="p"))
    assert "file.txt" in out.diff
    assert "new content" in out.diff
    assert (tmp_path / "file.txt").read_text() == "orig\n"  # source untouched


def test_schema_feedback_is_added_on_retry(tmp_path):
    """With a fake runner we can assert the corrective feedback reaches attempt 2."""
    stdins: list[str] = []
    replies = iter(["this is garbage", '{"ok": true}'])

    def fake_runner(command, *, stdin=None, cwd=None, env=None, timeout=None):
        stdins.append(stdin or "")
        return CliResult(
            returncode=0, stdout=next(replies), stderr="", timed_out=False, duration=0.0
        )

    config = support.make_config(schema_retries=2)
    out = Bridge(config, source=tmp_path, runner=fake_runner).run(
        AgentRequest(prompt="task", schema=schema.obj({"ok": schema.boolean()}))
    )
    assert out.value == {"ok": True}
    assert len(stdins) == 2
    assert "did not satisfy" in stdins[1]
    assert "did not satisfy" not in stdins[0]
