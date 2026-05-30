from __future__ import annotations

import concurrent.futures
import json
import os
import re
import shlex
import subprocess
import tempfile
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

from .config import AgentConfig, SwarmConfig
from .workspace import WorkspaceCopy, collect_diff

PLACEHOLDER_PATTERN = re.compile(r"\{(prompt|prompt_file|workspace|source|action|agent)\}")


@dataclass
class Artifact:
    path: str
    content: str


@dataclass
class AgentResult:
    agent: str
    label: str
    status: str
    exit_code: int | None
    duration_seconds: float
    command: list[str] | str
    workspace: str
    workspace_is_copy: bool
    stdout: str
    stderr: str
    git_status: str
    diff: str
    error: str | None = None


@dataclass
class SwarmRun:
    action: str
    task: str
    source: str
    config_path: str | None
    started_at: str
    results: list[AgentResult]

    def to_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False, indent=2)

    def to_markdown(self) -> str:
        lines = [
            f"# tutti {self.action}",
            "",
            f"- source: `{self.source}`",
            f"- started_at: `{self.started_at}`",
            (
                f"- config: `{self.config_path}`"
                if self.config_path
                else "- config: built-in defaults"
            ),
            f"- agents: {', '.join(result.agent for result in self.results)}",
            "",
            "No synthesis, vote, or consensus has been applied. Raw agent outputs follow.",
            "",
        ]
        for result in self.results:
            lines.extend(render_result(result))
        return "\n".join(lines).rstrip() + "\n"


def run_swarm(
    *,
    action: str,
    task: str,
    source: Path,
    config: SwarmConfig,
    config_path: Path | None,
    agents: list[AgentConfig],
    artifacts: list[Artifact],
    workspace_mode: str | None = None,
    keep_workspaces: bool = False,
    timeout_seconds: int | None = None,
) -> SwarmRun:
    started_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    mode = workspace_mode or config.workspace_mode
    timeout = timeout_seconds or config.timeout_seconds
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(agents)) as executor:
        futures = [
            executor.submit(
                run_agent,
                action=action,
                task=task,
                source=source,
                config=config,
                agent=agent,
                artifacts=artifacts,
                workspace_mode=mode,
                keep_workspace=keep_workspaces,
                timeout_seconds=timeout,
            )
            for agent in agents
        ]
        results = [future.result() for future in futures]
    return SwarmRun(
        action=action,
        task=task,
        source=str(source.resolve()),
        config_path=str(config_path) if config_path else None,
        started_at=started_at,
        results=results,
    )


def run_agent(
    *,
    action: str,
    task: str,
    source: Path,
    config: SwarmConfig,
    agent: AgentConfig,
    artifacts: list[Artifact],
    workspace_mode: str,
    keep_workspace: bool,
    timeout_seconds: int,
) -> AgentResult:
    started = time.monotonic()
    with WorkspaceCopy(source, keep=keep_workspace, mode=workspace_mode) as workspace:
        prompt = build_prompt(
            action=action,
            task=task,
            agent=agent,
            workspace=workspace.path,
            artifacts=artifacts,
        )
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            delete=False,
            prefix="tutti-prompt-",
            suffix=".md",
        ) as handle:
            handle.write(prompt)
            prompt_file = Path(handle.name)
        try:
            command = expand_command(
                agent.command,
                prompt=prompt,
                prompt_file=prompt_file,
                workspace=workspace.path,
                source=source,
                action=action,
                agent=agent.name,
            )
            stdin = (
                expand_text(
                    agent.stdin,
                    prompt=prompt,
                    prompt_file=prompt_file,
                    workspace=workspace.path,
                    source=source,
                    action=action,
                    agent=agent.name,
                )
                if agent.stdin is not None
                else None
            )
            env = os.environ.copy()
            env.update(
                {
                    key: expand_text(
                        value,
                        prompt=prompt,
                        prompt_file=prompt_file,
                        workspace=workspace.path,
                        source=source,
                        action=action,
                        agent=agent.name,
                    )
                    for key, value in agent.env.items()
                }
            )
            result = run_command(
                command,
                cwd=workspace.path,
                stdin=stdin,
                env=env,
                timeout_seconds=timeout_seconds,
            )
            status = "ok" if result.returncode == 0 else "failed"
            stdout = truncate(result.stdout, config.max_output_chars)
            stderr = truncate(result.stderr, config.max_output_chars)
            error = None
            exit_code = result.returncode
        except subprocess.TimeoutExpired as exc:
            command = exc.cmd if isinstance(exc.cmd, (list, str)) else str(exc.cmd)
            status = "timeout"
            stdout = truncate(_maybe_decode(exc.stdout), config.max_output_chars)
            stderr = truncate(_maybe_decode(exc.stderr), config.max_output_chars)
            error = f"Timed out after {timeout_seconds} seconds"
            exit_code = None
        except FileNotFoundError as exc:
            command = agent.command
            status = "failed"
            stdout = ""
            stderr = ""
            error = str(exc)
            exit_code = None
        finally:
            try:
                prompt_file.unlink(missing_ok=True)
            except NameError:
                pass

        git_status = ""
        diff = ""
        if config.capture_diff:
            git_status, diff = collect_diff(workspace.path)
        return AgentResult(
            agent=agent.name,
            label=agent.label,
            status=status,
            exit_code=exit_code,
            duration_seconds=round(time.monotonic() - started, 3),
            command=command,
            workspace=str(workspace.path),
            workspace_is_copy=workspace.copied,
            stdout=stdout,
            stderr=stderr,
            git_status=git_status,
            diff=diff,
            error=error,
        )


def build_prompt(
    *, action: str, task: str, agent: AgentConfig, workspace: Path, artifacts: list[Artifact]
) -> str:
    action_title = action.upper()
    lines = [
        "You are one of several independent coding agents in an tutti run.",
        "Other agents are receiving the same request, but you must not coordinate with them.",
        "Do not ask for or infer their drafts. Do not run a debate or consensus process.",
        "Return your own raw result for the main agent to inspect.",
        "",
        f"Action: {action_title}",
        f"Agent key: {agent.name}",
        f"Workspace: {workspace}",
        "",
    ]
    if action == "plan":
        lines.extend(
            [
                "Produce an independent plan or design. Do not edit files.",
                "Call out assumptions, risks, and validation steps.",
            ]
        )
    elif action == "execute":
        lines.extend(
            [
                "Attempt the implementation independently in this isolated workspace copy.",
                "Do not write outside the workspace. Do not commit, push, or open a PR.",
                "Leave any file edits in the workspace; Tutti will collect the diff.",
            ]
        )
    elif action == "review":
        lines.extend(
            [
                "Review the provided artifact independently.",
                "Prioritize correctness, regressions, security, maintainability, "
                "and missing tests.",
                "Quote only small snippets when needed; otherwise refer to files and lines.",
            ]
        )
    lines.extend(["", "Task:", task.strip(), ""])
    if artifacts:
        lines.append("Artifacts:")
        for artifact in artifacts:
            lines.extend(
                [
                    f"--- artifact: {artifact.path} ---",
                    artifact.content.rstrip(),
                    f"--- end artifact: {artifact.path} ---",
                    "",
                ]
            )
    return "\n".join(lines).rstrip() + "\n"


def run_command(
    command: list[str] | str,
    *,
    cwd: Path,
    stdin: str | None,
    env: dict[str, str],
    timeout_seconds: int,
) -> subprocess.CompletedProcess[str]:
    if isinstance(command, str):
        return subprocess.run(
            command,
            cwd=cwd,
            input=stdin,
            capture_output=True,
            text=True,
            shell=True,
            env=env,
            timeout=timeout_seconds,
        )
    return subprocess.run(
        command,
        cwd=cwd,
        input=stdin,
        capture_output=True,
        text=True,
        shell=False,
        env=env,
        timeout=timeout_seconds,
    )


def expand_command(
    command: list[str] | str,
    *,
    prompt: str,
    prompt_file: Path,
    workspace: Path,
    source: Path,
    action: str,
    agent: str,
) -> list[str] | str:
    if isinstance(command, str):
        return expand_text(
            command,
            prompt=prompt,
            prompt_file=prompt_file,
            workspace=workspace,
            source=source,
            action=action,
            agent=agent,
        )
    return [
        expand_text(
            item,
            prompt=prompt,
            prompt_file=prompt_file,
            workspace=workspace,
            source=source,
            action=action,
            agent=agent,
        )
        for item in command
    ]


def expand_text(
    value: str | None,
    *,
    prompt: str,
    prompt_file: Path,
    workspace: Path,
    source: Path,
    action: str,
    agent: str,
) -> str:
    if value is None:
        return ""
    replacements = {
        "prompt": prompt,
        "prompt_file": str(prompt_file),
        "workspace": str(workspace),
        "source": str(source.resolve()),
        "action": action,
        "agent": agent,
    }
    expanded = PLACEHOLDER_PATTERN.sub(lambda match: replacements[match.group(1)], value)
    return os.path.expandvars(expanded)


def render_result(result: AgentResult) -> list[str]:
    command = result.command if isinstance(result.command, str) else shlex.join(result.command)
    lines = [
        f"## Agent: {result.agent}",
        "",
        f"- label: {result.label}",
        f"- status: {result.status}",
        f"- exit_code: {result.exit_code}",
        f"- duration_seconds: {result.duration_seconds}",
        f"- workspace: `{result.workspace}`",
        f"- workspace_is_copy: {str(result.workspace_is_copy).lower()}",
        f"- command: `{command}`",
    ]
    if result.error:
        lines.append(f"- error: {result.error}")
    lines.extend(["", "### Raw stdout", "```text", result.stdout.rstrip(), "```", ""])
    if result.stderr:
        lines.extend(["### Raw stderr", "```text", result.stderr.rstrip(), "```", ""])
    if result.git_status:
        lines.extend(
            [
                "### Git status in isolated workspace",
                "```text",
                result.git_status.rstrip(),
                "```",
                "",
            ]
        )
    if result.diff:
        lines.extend(
            [
                "### Diff from isolated workspace",
                "```diff",
                result.diff.rstrip(),
                "```",
                "",
            ]
        )
    return lines


def truncate(value: str, max_chars: int) -> str:
    if max_chars <= 0 or len(value) <= max_chars:
        return value
    omitted = len(value) - max_chars
    return value[:max_chars] + f"\n[tutti truncated {omitted} chars]\n"


def _maybe_decode(value: str | bytes | None) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode(errors="replace")
    return value
