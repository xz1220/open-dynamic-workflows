"""L5: run store, file control, and in-process workflow execution."""

from __future__ import annotations

import pytest
import support

from agentswarm.control import PAUSED, RUNNING
from agentswarm.errors import RunStopped
from agentswarm.events import LOG, event
from agentswarm.runtime.file_control import FileControl
from agentswarm.runtime.run_store import JsonlSink, RunStore
from agentswarm.runtime.worker import execute_run


# --- run store ---------------------------------------------------------------


def test_run_store_roundtrip(tmp_path):
    store = RunStore(tmp_path)
    rid = store.create(script="wf.py", args={"x": 1}, config_path=None, source=str(tmp_path))
    assert store.exists(rid)
    assert store.read_meta(rid)["args"] == {"x": 1}
    assert store.read_status(rid)["state"] == "pending"

    store.update_status(rid, state="running", dispatched=2)
    assert store.read_status(rid)["state"] == "running"
    assert store.read_status(rid)["dispatched"] == 2

    store.write_result(rid, {"answer": 42})
    assert store.read_result(rid) == {"answer": 42}
    store.write_error(rid, {"error": "boom"})
    assert store.read_error(rid)["error"] == "boom"
    assert store.list_runs() == [rid]


def test_jsonl_sink_appends_and_reads_back(tmp_path):
    store = RunStore(tmp_path)
    rid = store.create(script="wf.py", args=None, config_path=None, source=str(tmp_path))
    sink = JsonlSink(store.events_path(rid))
    sink.emit(event(LOG, message="one"))
    sink.emit(event(LOG, message="two"))
    assert [e["message"] for e in store.read_events(rid)] == ["one", "two"]


def test_concurrent_status_updates_do_not_lose_fields(tmp_path):
    import threading

    store = RunStore(tmp_path)
    rid = store.create(script="wf.py", args=None, config_path=None, source=str(tmp_path))

    def writer(i):
        store.update_status(rid, **{f"k{i}": i})

    threads = [threading.Thread(target=writer, args=(i,)) for i in range(20)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    status = store.read_status(rid)
    assert all(status.get(f"k{i}") == i for i in range(20))


def test_control_file_roundtrip(tmp_path):
    store = RunStore(tmp_path)
    rid = store.create(script="wf.py", args=None, config_path=None, source=str(tmp_path))
    assert store.read_control(rid) is None
    store.write_control(rid, "pause")
    assert store.read_control(rid) == "pause"


# --- file control ------------------------------------------------------------


def test_file_control_stop_raises():
    control = FileControl(read_action=lambda: "stop")
    with pytest.raises(RunStopped):
        control.checkpoint()


def test_file_control_pause_then_resume_reports_states():
    actions = iter(["pause", None])
    states: list[str] = []
    control = FileControl(
        read_action=lambda: next(actions), on_state=states.append, poll_interval=0.01
    )
    control.checkpoint()  # blocks once on pause, returns when it sees running
    assert states == [PAUSED, RUNNING]


# --- in-process execution ----------------------------------------------------


def _run(tmp_path, body, *, args=None, config=None):
    config_path = config or support.write_mock_config(tmp_path, env={"MOCK_STDOUT": "echoed"})
    wf = support.write_workflow(tmp_path, body)
    store = RunStore(tmp_path / "runs")
    rid = store.create(
        script=str(wf), args=args, config_path=str(config_path), source=str(tmp_path)
    )
    state = execute_run(store.run_dir(rid))
    return state, store, rid


def test_execute_run_completes_with_result_and_events(tmp_path):
    body = (
        "from agentswarm import agent, parallel, log\n"
        'META = {"name": "demo", "description": "d"}\n'
        "def workflow(args):\n"
        '    log("starting")\n'
        '    parts = parallel([lambda: agent("one"), lambda: agent("two")])\n'
        '    return {"parts": parts, "n": len(parts), "args": args}\n'
    )
    state, store, rid = _run(tmp_path, body, args={"k": "v"})
    assert state == "done"
    result = store.read_result(rid)
    assert result["n"] == 2
    assert result["parts"] == ["echoed", "echoed"]
    assert result["args"] == {"k": "v"}

    status = store.read_status(rid)
    assert status["name"] == "demo"
    assert status["dispatched"] == 2
    types = {e["type"] for e in store.read_events(rid)}
    assert {"run_started", "run_finished", "log"} <= types


def test_execute_run_records_failure(tmp_path):
    body = "def workflow(args):\n    raise ValueError('boom in workflow')\n"
    state, store, rid = _run(tmp_path, body)
    assert state == "failed"
    error = store.read_error(rid)
    assert "boom in workflow" in error["error"]
    assert "Traceback" in error["traceback"]


def test_execute_run_requires_a_workflow_function(tmp_path):
    state, store, rid = _run(tmp_path, "x = 1\n")
    assert state == "failed"
    assert "workflow" in store.read_error(rid)["error"]


def test_execute_run_honors_a_stop_request(tmp_path):
    body = "from agentswarm import agent\ndef workflow(args):\n    return agent('hi')\n"
    config_path = support.write_mock_config(tmp_path)
    wf = support.write_workflow(tmp_path, body)
    store = RunStore(tmp_path / "runs")
    rid = store.create(
        script=str(wf), args=None, config_path=str(config_path), source=str(tmp_path)
    )
    store.write_control(rid, "stop")  # stop before the first dispatch
    assert execute_run(store.run_dir(rid)) == "stopped"
