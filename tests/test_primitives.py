"""L4: primitive semantics, driven by a fake bridge (no subprocess).

These isolate the orchestration logic from real CLIs, so they are fast and
assert exact behaviour: ordering, the parallel barrier, pipeline streaming,
stage arity, failure isolation, and progress events.
"""

from __future__ import annotations

import pytest
import support

from agentswarm.bridge import AgentOutcome
from agentswarm.context import RunContext
from agentswarm.control import NullControl
from agentswarm.errors import WorkflowError
from agentswarm.events import AGENT_FINISHED, AGENT_STARTED, LOG, PHASE_STARTED, MemorySink
from agentswarm.primitives import agent, bind, current, log, parallel, phase, pipeline
from agentswarm.scheduler import Scheduler


class FakeBridge:
    """A bridge that computes a reply from the request without any subprocess."""

    def __init__(self, handler=None):
        self.handler = handler or (lambda req: req.prompt.upper())

    def run(self, request):
        value = self.handler(request)
        return AgentOutcome(
            value=value, text=str(value), adapter=request.adapter or "fake", attempts=1
        )


def make_ctx(bridge=None, *, concurrency=4, max_agents=100):
    return RunContext(
        config=support.make_config(),
        bridge=bridge or FakeBridge(),
        scheduler=Scheduler(concurrency, max_agents),
        control=NullControl(),
        sink=MemorySink(),
    )


def test_current_raises_when_no_run_is_bound():
    with pytest.raises(WorkflowError):
        current()


def test_agent_returns_value_and_emits_events():
    ctx = make_ctx()
    with bind(ctx):
        assert agent("hello") == "HELLO"
    assert ctx.sink.of_type(AGENT_STARTED)
    assert ctx.sink.of_type(AGENT_FINISHED)


def test_parallel_is_a_barrier_keeping_order_and_isolating_failures():
    def handler(req):
        if req.prompt == "boom":
            raise RuntimeError("agent blew up")
        return req.prompt

    ctx = make_ctx(FakeBridge(handler))
    with bind(ctx):
        results = parallel([lambda: agent("a"), lambda: agent("boom"), lambda: agent("c")])
    assert results == ["a", None, "c"]


def test_pipeline_streams_each_item_through_all_stages():
    ctx = make_ctx(FakeBridge(lambda req: req.prompt))
    with bind(ctx):
        out = pipeline(
            [1, 2, 3],
            lambda n: agent(f"draft {n}"),
            lambda draft: agent(f"review: {draft}"),
        )
    assert out == ["review: draft 1", "review: draft 2", "review: draft 3"]


def test_pipeline_passes_prev_item_index_by_arity():
    ctx = make_ctx()
    with bind(ctx):
        out = pipeline(
            ["x"],
            lambda prev: prev + "1",
            lambda prev, item: f"{prev}|{item}",
            lambda prev, item, idx: f"{prev}|{idx}",
        )
    assert out == ["x1|x|0"]


def test_pipeline_isolates_a_failing_item():
    def handler(req):
        if "2" in req.prompt:
            raise RuntimeError("bad item")
        return req.prompt

    ctx = make_ctx(FakeBridge(handler))
    with bind(ctx):
        out = pipeline([1, 2, 3], lambda n: agent(f"x{n}"))
    assert out == ["x1", None, "x3"]


def test_phase_sets_current_and_per_call_override_wins():
    ctx = make_ctx()
    with bind(ctx):
        phase("draft")
        agent("a")
        agent("b", phase="special")
    phases = [e.get("phase") for e in ctx.sink.of_type(AGENT_STARTED)]
    assert "draft" in phases
    assert "special" in phases
    assert ctx.sink.of_type(PHASE_STARTED)


def test_log_emits_a_message_event():
    ctx = make_ctx()
    with bind(ctx):
        log("making progress")
    assert "making progress" in [e["message"] for e in ctx.sink.of_type(LOG)]
