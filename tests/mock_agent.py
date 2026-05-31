"""A deterministic stand-in for a real coding-agent CLI.

The tests point a ``mock`` adapter at this script so the *real* subprocess path
(adapter -> runner -> bridge) is exercised end to end without any agent account.
Behaviour is driven by environment variables so a test can shape one adapter:

* ``MOCK_STDOUT``   : print exactly this and exit 0 (overrides echo)
* ``MOCK_JSON``     : print this JSON string and exit 0
* ``MOCK_FAIL``     : print ``MOCK_STDERR`` to stderr and exit ``MOCK_EXIT`` (default 3)
* ``MOCK_SLEEP``    : sleep this many seconds before responding
* ``MOCK_TOUCH``    : write ``MOCK_TOUCH_CONTENT`` to this (relative) path — used to test diffs
* ``MOCK_COUNTER``  : path to a call-counter file; the first ``MOCK_BAD`` calls print
                      ``MOCK_BADOUT`` (invalid JSON), later calls print ``MOCK_GOOD`` —
                      used to test schema retry

With no variables set, it echoes the prompt it received (stdin, else last arg).
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path


def _bump(path: str) -> int:
    p = Path(path)
    n = int(p.read_text()) if p.exists() else 0
    n += 1
    p.write_text(str(n))
    return n


def main() -> int:
    stdin = "" if sys.stdin.isatty() else sys.stdin.read()
    prompt = stdin or (sys.argv[-1] if len(sys.argv) > 1 else "")

    if os.environ.get("MOCK_SLEEP"):
        time.sleep(float(os.environ["MOCK_SLEEP"]))

    if os.environ.get("MOCK_TOUCH"):
        Path(os.environ["MOCK_TOUCH"]).write_text(
            os.environ.get("MOCK_TOUCH_CONTENT", "changed by mock\n"), encoding="utf-8"
        )

    if os.environ.get("MOCK_FAIL"):
        sys.stderr.write(os.environ.get("MOCK_STDERR", "mock failure\n"))
        return int(os.environ.get("MOCK_EXIT", "3"))

    counter = os.environ.get("MOCK_COUNTER")
    if counter:
        attempt = _bump(counter)
        if attempt <= int(os.environ.get("MOCK_BAD", "1")):
            sys.stdout.write(os.environ.get("MOCK_BADOUT", "this is not json"))
        else:
            sys.stdout.write(os.environ.get("MOCK_GOOD", "{}"))
        return 0

    if os.environ.get("MOCK_JSON") is not None:
        sys.stdout.write(os.environ["MOCK_JSON"])
        return 0
    if os.environ.get("MOCK_STDOUT") is not None:
        sys.stdout.write(os.environ["MOCK_STDOUT"])
        return 0

    sys.stdout.write(prompt)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
