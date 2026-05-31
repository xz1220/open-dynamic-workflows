"""L6: the CLI and launcher, end to end through a real background worker process.

These spawn the detached worker, so they also prove the worker can import the
package from a source tree (the PYTHONPATH injection in the launcher).
"""

from __future__ import annotations

import support

from agentswarm import cli
from agentswarm.runtime.launcher import start_run, wait_for
from agentswarm.runtime.run_store import RunStore

WAIT_TIMEOUT = 30.0


def _demo(tmp_path, stdout="hi"):
    config_path = support.write_mock_config(tmp_path, env={"MOCK_STDOUT": stdout})
    body = (
        "from agentswarm import agent\n"
        'META = {"name": "cli-demo"}\n'
        "def workflow(args):\n"
        '    return agent("go")\n'
    )
    return config_path, support.write_workflow(tmp_path, body)


def test_run_wait_prints_the_result(tmp_path, capsys):
    config_path, wf = _demo(tmp_path, stdout="answer-42")
    runs = tmp_path / "runs"
    rc = cli.main(
        ["run", str(wf), "--wait", "--config", str(config_path), "--runs-root", str(runs)]
    )
    assert rc == 0
    assert "answer-42" in capsys.readouterr().out


def test_run_no_wait_prints_run_id(tmp_path, capsys):
    config_path, wf = _demo(tmp_path, stdout="ok")
    runs = tmp_path / "runs"
    rc = cli.main(["run", str(wf), "--config", str(config_path), "--runs-root", str(runs)])
    assert rc == 0
    run_id = capsys.readouterr().out.strip()
    store = RunStore(runs)
    status = wait_for(store, run_id, timeout=WAIT_TIMEOUT)
    assert status["state"] == "done"


def test_status_result_logs_list(tmp_path, capsys):
    config_path, wf = _demo(tmp_path, stdout="collected")
    runs = tmp_path / "runs"
    run_id, store = start_run(
        wf, config_path=str(config_path), runs_root=str(runs), source=str(tmp_path)
    )
    assert wait_for(store, run_id, timeout=WAIT_TIMEOUT)["state"] == "done"

    assert cli.main(["result", run_id, "--runs-root", str(runs)]) == 0
    assert "collected" in capsys.readouterr().out

    assert cli.main(["status", run_id, "--runs-root", str(runs)]) == 0
    assert run_id in capsys.readouterr().out

    assert cli.main(["logs", run_id, "--runs-root", str(runs)]) == 0
    assert "run_finished" in capsys.readouterr().out

    assert cli.main(["list", "--runs-root", str(runs)]) == 0
    assert run_id in capsys.readouterr().out


def test_control_command_writes_control_file(tmp_path):
    config_path, wf = _demo(tmp_path)
    runs = tmp_path / "runs"
    run_id, store = start_run(
        wf, config_path=str(config_path), runs_root=str(runs), source=str(tmp_path)
    )
    wait_for(store, run_id, timeout=WAIT_TIMEOUT)
    assert cli.main(["stop", run_id, "--runs-root", str(runs)]) == 0
    assert store.read_control(run_id) == "stop"


def test_status_for_unknown_run_returns_error(tmp_path):
    assert cli.main(["status", "no-such-run", "--runs-root", str(tmp_path)]) == 1
