# User needs and pain points — parallel coding-agent orchestration (2026-10)

Research input for the [roadmap](../ROADMAP.md). About 60 searches and ~30 primary
sources (Hacker News, Reddit, GitHub issues, vendor docs), each finding checked
against ODW `main` at `16f57ee`. Frequency: **Very high** = in nearly every thread;
**High** = repeatedly, independent sources; **Medium** = several; **Low-medium** =
mostly expert voices.

## Ranked needs

### 1. Runaway spend, no per-agent cost visibility — Very high
Fan-outs drain plan windows in minutes and nobody can see which agent spent what.
- "spun up 62 Opus 4.8 1M sub-agents… maxed out my ~5hr cap in..... 18 minutes?" — [HN](https://news.ycombinator.com/item?id=48311705)
- "it launched 102 agents and blew my $120 quota in 6 minutes" — [HN](https://hn.nuxt.dev/item/48883275)
- "No visibility into how fast my budget was being obliterated" — [Cursor forum](https://forum.cursor.com/t/pro-plan-burned-in-10-minutes-by-background-agent-calls-completely-unacceptable/118368)
- Per-subagent token tracking was closed "not planned" in Claude Code — [#22625](https://claudeissues.com/issue/22625-feature-per-subagent-token-usage-tracking)

ODW today: `budget` estimates chars/4 of final replies; the plain-text `claude` adapter discards the cost the CLI knows.
Direction: use the CLIs' JSON modes (`claude --output-format json` reports `total_cost_usd` + usage — [docs](https://code.claude.com/docs/en/headless); `codex exec --json` emits `turn.completed.usage` — [ref](https://codex.danielvaughan.com/2026/04/08/codex-exec-jsonl-reference/)), record usage per agent, show live cost per agent/phase, warn before large fan-outs, pass remaining budget down as per-call caps. **M · now**

### 2. Reviewing and merging parallel output — Very high
Review, not generation, is the bottleneck, and parallel branches collide.
- "review is hands down the biggest bottleneck"; "stuck in merge hell" — [HN](https://news.ycombinator.com/item?id=45489884)
- Replayed agent-PR merges conflicted 41.7% across different agents vs 19.8% for the same agent — [summary of arXiv 2607.04697](https://codex.danielvaughan.com/2026/07/28/agent-pr-merge-conflicts-concurrent-coding-agents-codex-cli-worktree-isolation-coordination-defence/)

ODW today: worktree diffs were computed then dropped.
Direction: keep diffs/branches as run artifacts; `odw apply <run>` that merges one at a time with a `git merge-tree` pre-check and a verify command; a side-by-side diff review view. **M · next**

### 3. Usage limits, 429/529 and backoff — High
- "the session pauses and the user must manually wait and type 'continue'" — [claude-code #35744](https://github.com/anthropics/claude-code/issues/35744)
- "fallback logic for 429 quota errors is unreliable" — [gemini-cli #9248](https://github.com/google-gemini/gemini-cli/issues/9248)
- Claude's workflows only wait out usage limits interactively, not under `claude -p` — [docs](https://code.claude.com/docs/en/workflows.md)

Direction: classify adapter failures (rate limit / overload / quota / auth), per-adapter throttles with retry-after backoff, a run-level quota pause that resumes at the parsed reset time, fallback adapter chains. **M · now**

### 4. Resume instead of starting over — High
- "Can i pause and resume/retry workflows? How stateful are they?" — [HN](https://news.ycombinator.com/item?id=48311705)
- A restarted pipeline "re-billed about $19 of LLM calls that had already finished" — [HackerNoon](https://hackernoon.com/you-dont-need-temporal-yet-durable-execution-for-ai-agents-in-150-lines)
- Claude Code replays completed agents; an open-source rival ships `resumeFromRunId`/`forkFromRunId` — [dynamic-workflows](https://pi.dev/packages/@fish59fish/dynamic-workflows)

Direction: persist each completed agent result atomically ([#24](https://github.com/xz1220/open-dynamic-workflows/issues/24)); `odw resume` replaying unchanged calls; later `odw fork`. ODW runs don't depend on a host session, so it can resume where Claude Code cannot. **M→L · now**

### 5. Hung, stalled and runaway agents — High
- `--print` deadlocks with deferred tools — [#35262](https://claudeissues.com/issue/35262-bug-print-mode-hangs-in-v2-1-76-deferred-tools-agent-skill-websearch-cause-inter)
- Gemini CLI's default approval mode "will hang indefinitely" headless — [guide](https://skills.sh/cachemoney/agent-toolkit/gemini)
- Agents are "terrible at recognizing when they're going in circles" — [HN](https://news.ycombinator.com/item?id=47520220)

Direction: kill the whole process group (done in this iteration), a quiet-output watchdog (`stallMs`) with capped restarts, stall/retry events, pass `maxTurns` through. **S · now**

### 6. Permissions, sandboxing, secrets — High
- "This is why Claude Code only runs in docker for me." — [HN](https://hn.nuxt.dev/item/46268222)
- Vibe Kanban criticised for yolo-by-default — [review](https://markferree.substack.com/p/agent-orchestration-for-the-timid)
- `claude -p` runs a repo's hooks and `.mcp.json` servers even in untrusted folders — [docs](https://code.claude.com/docs/en/headless)

Direction: named permission profiles (read-only / edit / full) mapped to each CLI's flags and shown before launch; an env allowlist with redacted secret references; `--bare` for untrusted repos; later an optional container runner with networking off. **M · next (containers L · later)**

### 7. Headless runs that "succeed" but did nothing — Medium-high
- A denied tool call still exits 0 with `"subtype": "success"` — [wmedia](https://wmedia.es/en/tips/claude-code-dangerously-skip-permissions-silent-failure)
- 41 of 2,114 cron `claude -p` runs "succeeded" doing nothing — [NextFuture](https://nextfuture.io.vn/blog/claude-p-trong-cron-41-2-114-lan-fail-ma-exit-code-van-0)
- Related: [claude-code-action #647](https://github.com/anthropics/claude-code-action/issues/647), ODW [#23](https://github.com/xz1220/open-dynamic-workflows/issues/23)

Direction: read each CLI's success signals (`is_error`, `permission_denials`, MCP status) into typed failures; optional `agent()` postconditions ("files changed", "command passes"); `odw doctor --headless`. **M · now**

### 8. Seeing what each agent did — Medium-high
- Subagents are a black box between prompt and output — [claude-code #5974](https://claudeissues.com/issue/5974-feature-request-ui-for-subagent-execution-transparency-and-debugging)
- Copilot's coding agent streams live session logs — [docs](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/troubleshoot-coding-agent)

Direction: per-agent transcripts from the adapters' JSON streams, shown in the dashboard and `odw logs --agent`; OpenTelemetry GenAI spans — [spec](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans). **M · next**

### 9. Human checkpoints mid-run — Medium
- Claude Code workflows: "No mid-run user input" — [docs](https://code.claude.com/docs/en/workflows.md)
- LangGraph [HITL](https://docs.langchain.com/oss/python/langgraph/human-in-the-loop) and Mastra [suspend/resume](https://mastra.ai/en/docs/workflows/suspend-and-resume) have it built in.

Direction: an ODW-only `checkpoint(title, payload)` that pauses durably (needs #4), surfaced in status/dashboard/notifications, continued with `odw approve|reject`. **M · next**

### 10. Worktree environment setup — Medium
- New worktrees lack `.env`, `.venv`, `node_modules` — [claude-code #27744](https://github.com/anthropics/claude-code/issues/27744)
- Conductor ships setup scripts and per-workspace ports — [docs](https://www.conductor.build/docs/guides/parallel-agents/run-multiple-claude-code-sessions)

Direction: honour `.worktreeinclude`, a timed `setup` command, an `ODW_PORT` per agent. **S · now**

### 11. Notifications while away — Medium
- "kept losing track of when it was done" — [r/ClaudeAI](https://reddit.sentinel-team.org/posts/1sgj41t/snapshots/2026-04-09T16%3A41%3A00.47446Z)
- Omnara launch thread — [HN](https://news.ycombinator.com/item?id=46991591)

Direction: dashboard toasts + desktop notifications (done in this iteration); `notify` hooks (command, webhook, ntfy) for finished / failed / quota-paused / approval-needed. **S · now**

### 12. Reliable structured output — Medium
- `--json-schema` returned `structured_output: null` with `subtype: success` — [write-up](https://mer.vin/news/structured_output-is-null-even-though-subtype-is-success/)
- Inter-agent misalignment is one of three failure categories in [MAST](https://arxiv.org/abs/2503.13657).

Direction: prefer native constrained output (`codex --output-schema`, `claude --json-schema`); reject unsupported schema keywords before launch; log every attempt. **S–M · now**

### 13. Portability, model mixing, reuse — Medium (ODW's core)
- "a way to scope and implement these multi-agent orchestration features that isn't locked in to one provider" — [HN](https://news.ycombinator.com/item?id=48311705)
- "with every new model update, I'm leaving behind full workflows I've built" — [HN](https://news.ycombinator.com/item?id=47218318)

Direction: phase-level adapter/model defaults and fallback chains; resolve Claude plugin workflows; shareable redacted run bundles; publish the dual-compatibility suite. **M · next**

### 14. Reliable scheduling — Low-medium
- "The most dangerous failure in a scheduled agent is a silent one" — [guide](https://aicatchup.com/practices/scheduled-claude-agent-automations)
- Goose ships `goose schedule add` — [man](https://www.mankier.com/1/goose-schedule-add)

Direction: `odw schedule add` writing cron/launchd/systemd entries (no daemon) with overlap locks and failure notifications. **S · next**

### 15. Evaluating and reproducing workflows — Low-medium
- Ad hoc testing gives "neither reproducibility across runs nor comparability across versions" — [AEVAL](https://arxiv.org/abs/2607.16345)

Direction: `odw eval` (cases × adapters × repeats → pass rate, cost, latency); record CLI versions in run metadata; `odw diff runA runB`. **L · later**

## What competitors do well that ODW lacks

- **Claude Code's Workflow tool** — resume by replay, stalled-agent restart, waiting out usage limits, per-agent token counts and a large-workflow warning, plan approval, staggered launches for prompt-cache reuse, plugin distribution.
- **dynamic-workflows (Pi)** — resume/fork from saved results, cost and tokens/s, pending checkpoints in the dashboard.
- **Conductor, Superset, Vibe Kanban, Sculptor** — setup scripts, port allocation, diff review/merge UIs, containers, notification hooks.
- **Codex cloud, Copilot coding agent, Jules, Cursor** — off-laptop execution, best-of-N, live session logs, network firewalls.
- **Temporal, Inngest, LangGraph, Mastra** — durable steps, per-provider throttles, built-in approval steps.

## Where ODW is differentiated

- **One script, nine-plus CLIs** — answers lock-in and model churn, and enables cross-vendor review.
- **Runs outlive the host session** — a detached worker plus a run directory; with persisted agent results ODW can resume across sessions and under `claude -p`.
- **Local-first, zero runtime dependencies, uses the CLI subscriptions people already pay for**, and observes Claude Code's own workflow runs read-only.

> Watch: Anthropic announced moving `claude -p` usage onto a separate Agent SDK
> credit, later reported paused — [report](https://www.agenticwire.news/article/claude-agent-sdk-200-credit-dev-guide).
> ODW's "runs on your existing subscription" story depends on how this lands.
