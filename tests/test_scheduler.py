"""L3: bounded concurrency, the total-agent backstop, and failure handling."""

from __future__ import annotations

import threading
import time

import pytest

from agentswarm.control import ThreadControl
from agentswarm.errors import AgentLimitExceeded, RunStopped
from agentswarm.scheduler import Scheduler


def test_gather_preserves_order_and_runs_concurrently():
    sched = Scheduler(concurrency=4, max_agents=100)
    start = time.monotonic()
    results = sched.gather([(lambda i=i: (time.sleep(0.05), i)[1]) for i in range(4)])
    elapsed = time.monotonic() - start
    assert results == [0, 1, 2, 3]
    assert elapsed < 0.15  # 4 x 50ms ran in parallel, not 200ms serially


def test_concurrency_cap_is_respected():
    sched = Scheduler(concurrency=3, max_agents=100)
    active = 0
    peak = 0
    lock = threading.Lock()

    def work():
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(peak, active)
        time.sleep(0.05)
        with lock:
            active -= 1
        return "ok"

    sched.gather([lambda: sched.run_agent(work) for _ in range(12)])
    assert peak <= 3
    assert peak >= 2  # genuinely concurrent


def test_total_agent_backstop_via_run_agent():
    sched = Scheduler(concurrency=2, max_agents=2)
    assert sched.run_agent(lambda: 1) == 1
    assert sched.run_agent(lambda: 2) == 2
    with pytest.raises(AgentLimitExceeded):
        sched.run_agent(lambda: 3)
    assert sched.dispatched == 2


def test_backstop_propagates_through_gather():
    sched = Scheduler(concurrency=4, max_agents=3)
    with pytest.raises(AgentLimitExceeded):
        sched.gather([lambda: sched.run_agent(lambda: "x") for _ in range(5)])


def test_recoverable_failure_becomes_none_slot():
    sched = Scheduler(concurrency=4, max_agents=100)

    def boom():
        raise ValueError("nope")

    assert sched.gather([lambda: "a", boom, lambda: "c"]) == ["a", None, "c"]


def test_stop_is_fatal_and_aborts_gather():
    control = ThreadControl()
    control.stop()
    sched = Scheduler(concurrency=2, max_agents=100, checkpoint=control.checkpoint)
    with pytest.raises(RunStopped):
        sched.run_agent(lambda: 1)
    with pytest.raises(RunStopped):
        sched.gather([lambda: sched.run_agent(lambda: 1)])
