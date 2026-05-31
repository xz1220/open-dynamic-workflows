"""Placeholder expansion for adapter command templates.

An adapter command is a list of argument templates such as
``["codex", "exec", "--cd", "{workspace}", "-"]``. Before a command runs, every
``{name}`` token is replaced with a value drawn from the call context. Keeping
this as a small pure function (no I/O, no globals) makes the substitution rules
trivial to read and to unit test in isolation.
"""

from __future__ import annotations

import re

# The placeholders an adapter command (or stdin template) may reference.
PLACEHOLDERS = ("prompt", "prompt_file", "workspace", "source", "adapter", "role")

_TOKEN = re.compile(r"\{(" + "|".join(PLACEHOLDERS) + r")\}")


def expand(template: str, context: dict[str, str]) -> str:
    """Replace every known ``{placeholder}`` in *template* using *context*.

    Unknown ``{...}`` tokens are left untouched so that literal braces in a
    command (for example a shell brace expansion) survive. A known placeholder
    that is missing from *context* expands to an empty string.
    """
    return _TOKEN.sub(lambda m: context.get(m.group(1), ""), template)


def expand_all(templates: list[str], context: dict[str, str]) -> list[str]:
    """Expand a list of argument templates."""
    return [expand(t, context) for t in templates]
