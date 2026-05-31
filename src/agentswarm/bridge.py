"""Execution bridge (L2): turn one ``agent`` call into one CLI invocation.

The bridge is the seam between the abstract ``agent`` primitive and a concrete
coding-agent CLI. Given a :class:`AgentRequest` it:

1. resolves which adapter to use,
2. composes a self-contained prompt (independence framing + optional schema
   instructions),
3. runs the adapter in an isolated workspace, and
4. when a schema is requested, extracts/validates the reply and retries with
   corrective feedback until it conforms or the retry budget is spent.

Every collaborator it needs — the command runner and the workspace opener — is
injectable, so the whole bridge can be unit tested with a fake runner and no
real agent account.
"""

from __future__ import annotations

import os
import tempfile
from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager, contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import schema as schema_engine
from .adapters import Adapter, CliResult, Config, expand, expand_all, run_command
from .errors import AdapterExecutionError, SchemaValidationError
from .workspace import Workspace, open_workspace

INDEPENDENCE_PREAMBLE = (
    "You are one agent in an automated multi-agent workflow. Work independently "
    "on the task below. Do not ask clarifying questions and do not assume other "
    "agents exist. Produce your result directly."
)

WorkspaceOpener = Callable[[Path, str], AbstractContextManager[Workspace]]


@dataclass(frozen=True)
class AgentRequest:
    """A single agent invocation as requested by the ``agent`` primitive."""

    prompt: str
    adapter: str | None = None
    schema: dict | None = None
    label: str | None = None


@dataclass
class AgentOutcome:
    """The result of one agent invocation, after any schema handling."""

    value: Any  # validated structured object, or the raw text when no schema
    text: str  # the raw final reply
    adapter: str  # adapter name actually used
    attempts: int  # how many CLI calls it took (>1 means schema retries happened)
    diff: str = ""  # workspace diff (empty for inplace mode / no changes)
    cli: CliResult | None = field(default=None, repr=False)


class Bridge:
    def __init__(
        self,
        config: Config,
        *,
        source: str | os.PathLike[str] | None = None,
        runner=run_command,
        workspace_opener: WorkspaceOpener = open_workspace,
    ) -> None:
        self.config = config
        self.source = Path(source or Path.cwd()).resolve()
        self._runner = runner
        self._open_workspace = workspace_opener

    def run(self, request: AgentRequest) -> AgentOutcome:
        adapter = self.config.adapter(request.adapter)
        settings = self.config.settings
        timeout = adapter.timeout if adapter.timeout is not None else settings.timeout
        base_prompt = self._compose_prompt(request)
        max_attempts = (settings.schema_retries + 1) if request.schema else 1

        problems: list[str] = []
        for attempt in range(1, max_attempts + 1):
            prompt = base_prompt
            if problems:
                prompt = base_prompt + "\n\n" + _retry_feedback(problems)
            cli, diff = self._invoke(adapter, prompt, timeout)
            if not cli.ok:
                raise AdapterExecutionError(_cli_failure_message(adapter, cli))

            text = cli.stdout.strip()
            if request.schema is None:
                return AgentOutcome(text, text, adapter.name, attempt, diff, cli)

            value = schema_engine.extract_json(text)
            problems = (
                ["no JSON value found in the reply"]
                if value is None
                else schema_engine.validate(value, request.schema)
            )
            if not problems:
                return AgentOutcome(value, text, adapter.name, attempt, diff, cli)

        raise SchemaValidationError(
            f"adapter {adapter.name!r} did not satisfy the schema after "
            f"{max_attempts} attempt(s); last problems: {problems}"
        )

    # --- internals -----------------------------------------------------------

    def _compose_prompt(self, request: AgentRequest) -> str:
        parts = [INDEPENDENCE_PREAMBLE, request.prompt]
        if request.schema is not None:
            parts.append(schema_engine.describe_schema(request.schema))
        return "\n\n".join(parts)

    def _invoke(
        self, adapter: Adapter, prompt: str, timeout: float | None
    ) -> tuple[CliResult, str]:
        mode = self.config.settings.workspace_mode
        with self._open_workspace(self.source, mode) as ws:
            with _prompt_file(prompt, needed=_uses_prompt_file(adapter)) as prompt_path:
                context = {
                    "prompt": prompt,
                    "prompt_file": prompt_path,
                    "workspace": str(ws.path),
                    "source": str(ws.source),
                    "adapter": adapter.name,
                    "role": adapter.display_name,
                }
                command = expand_all(list(adapter.command), context)
                stdin = expand(adapter.stdin, context) if adapter.stdin else None
                env = {**os.environ, **adapter.env} if adapter.env else None
                cli = self._runner(
                    command, stdin=stdin, cwd=str(ws.path), env=env, timeout=timeout
                )
            diff = ws.diff()
        return cli, diff


def _uses_prompt_file(adapter: Adapter) -> bool:
    token = "{prompt_file}"
    in_command = any(token in part for part in adapter.command)
    in_stdin = adapter.stdin is not None and token in adapter.stdin
    return in_command or in_stdin


@contextmanager
def _prompt_file(prompt: str, *, needed: bool) -> Iterator[str]:
    """Yield a path to a file holding the prompt, only when an adapter needs it."""
    if not needed:
        yield ""
        return
    fd, path = tempfile.mkstemp(prefix="agentswarm-prompt-", suffix=".txt")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(prompt)
        yield path
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def _retry_feedback(problems: list[str]) -> str:
    listed = "\n".join(f"- {p}" for p in problems[:10])
    return (
        "Your previous reply did not satisfy the required schema:\n"
        f"{listed}\n"
        "Return corrected JSON only, with no surrounding text."
    )


def _cli_failure_message(adapter: Adapter, cli: CliResult) -> str:
    reason = "timed out" if cli.timed_out else f"exited with code {cli.returncode}"
    detail = cli.stderr.strip() or cli.stdout.strip()
    suffix = f": {detail[:500]}" if detail else ""
    return f"adapter {adapter.name!r} {reason}{suffix}"
