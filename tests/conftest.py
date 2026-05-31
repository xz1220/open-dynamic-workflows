"""Make the tests directory importable (for ``support``) and expose small fixtures."""

from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(__file__))

from support import make_config  # noqa: E402


@pytest.fixture
def cfg():
    """A config with a single mock adapter, inplace workspace mode."""
    return make_config()
