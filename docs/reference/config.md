# Configuration reference

English · [简体中文](../zh-CN/reference/config.md)

## Where the config is found

An `odw.config.json` is discovered, highest priority first:

1. an explicit `--config <path>`
2. `$ODW_CONFIG`
3. `./odw.config.json`
4. `~/.config/odw/config.json`

A file is merged over the built-ins, so you only write what you change. Every key is
**top-level** — there is no `"settings"` wrapper — and odw warns about an unknown or
misplaced key, with a did-you-mean hint, instead of ignoring it. An annotated example:
[`odw.config.example.json`](../../odw.config.example.json).

Every key with its default and exact meaning is in the skill's
[settings table](../../skills/open-dynamic-workflows/references/adapters.md#settings),
and every field of an adapter's entry in its
[adapter fields table](../../skills/open-dynamic-workflows/references/adapters.md#adapter-fields).
Below, each key by topic, with the section that explains it. Claude Code has no such
file: every key is read by ODW alone.

## Agents and adapters

| Key | Explained in |
| --- | --- |
| `defaultAdapter`, `adapters`, `concurrency`, `maxAgents`, `timeout` | [Configure adapters](../guides/adapters-and-models.md#configure-adapters) |
| `runsRoot`, `workflowsRoot`, `claudeWorkflowsRoot` | [Run and observe](../guides/running-and-observing.md#run-and-observe) |
| `models`, `fallback`, `quotaBreaker` | [Per-phase adapters, model tiers and fallback chains](../guides/adapters-and-models.md#per-phase-adapters-model-tiers-and-fallback-chains-odw-extension) |
| `accounts` | [Several accounts of one CLI](../guides/adapters-and-models.md#several-accounts-of-one-cli) |
| `schemaRetries`, `schemaKeywords`, `schemaPrompt` | [Structured output](../guides/adapters-and-models.md#structured-output-odw-extension) |
| `expectRetries`, `mcpFailures`, `orphanedBackground` | [Check an agent's work](workflow-api.md#check-an-agents-work-odw-extension) |
| `notes` | [Notes between parallel agents](workflow-api.md#notes-between-parallel-agents-odw-extension) |
| `memory`, `memoryDir` | [Workflow memory](workflow-api.md#workflow-memory-odw-extension) |
| `scopePolicy` | [Declared scopes](workflow-api.md#declared-scopes-odw-extension) |
| `repos` | [Multi-repo runs](../guides/multi-repo.md#several-repositories-in-one-run-odw-extension) |
| `questions` | [Agent questions](../guides/checkpoints-and-questions.md#agent-questions-odw-extension) |

## Limits, retries and cost

| Key | Explained in |
| --- | --- |
| `stallTimeout`, `stallRestarts` | [Stall watchdog](../guides/cost-limits-and-quotas.md#stall-watchdog) |
| `agentLimits` | [Per-agent limits and runaway loops](../guides/cost-limits-and-quotas.md#per-agent-limits-and-runaway-loops-odw-extension) |
| `transientRetries`, `maxBackoff` | [Rate limits, quotas and logins](../guides/cost-limits-and-quotas.md#rate-limits-quotas-and-logins) |
| `quotaWait` | [Pause for a spent quota](../guides/cost-limits-and-quotas.md#pause-for-a-spent-quota-odw-extension) |
| `adaptiveConcurrency`, `staggerFanOut`, `fanOutWarn` | [Concurrency per adapter and staggered fan-outs](../guides/cost-limits-and-quotas.md#concurrency-per-adapter-and-staggered-fan-outs) |
| `costGate` | [Know the cost before you run](../guides/cost-limits-and-quotas.md#know-the-cost-before-you-run-odw-extension) |

## Isolation and changes

| Key | Explained in |
| --- | --- |
| `worktreeSetup`, `worktreeSetupTimeout`, `worktreeTeardown`, `worktreeTeardownTimeout`, `portRange` | [Isolated worktrees and agent ports](../guides/reviewing-and-applying.md#isolated-worktrees-and-agent-ports) |
| `maxDiffBytes`, `keepBranches`, `applyVerify` | [Review and apply](../guides/reviewing-and-applying.md#review-and-apply-what-isolated-agents-changed-odw-extension) |

## Safety and trust

| Key | Explained in |
| --- | --- |
| `permissions`, `permissionDenials` | [Permissions](../guides/safety-and-trust.md#permissions-odw-extension) |
| `destructiveGit` | [Safety snapshot and destructive git commands](../guides/safety-and-trust.md#safety-snapshot-and-destructive-git-commands-odw-extension) |
| `trust` | [Untrusted repositories](../guides/safety-and-trust.md#untrusted-repositories-odw-extension) |
| `untrustedInput` | [Untrusted input](../guides/safety-and-trust.md#untrusted-input-odw-extension) |
| `scriptContext` | [Strict script context](../guides/safety-and-trust.md#strict-script-context-odw-extension) |
| `lockedWorkflows` | [Run and observe](../guides/running-and-observing.md#run-and-observe) (installing workflows from git) |
| `sandbox` | [Run agents in containers](../guides/safety-and-trust.md#run-agents-in-containers-odw-extension) |
| `agentEnv`, `agentEnvPass`, `redact` | [Secrets in what ODW keeps](../guides/safety-and-trust.md#secrets-in-what-odw-keeps-odw-extension) |

## Observing, notifying, scheduling

| Key | Explained in |
| --- | --- |
| `maxTranscriptBytes` | [Agent transcripts](../guides/running-and-observing.md#agent-transcripts-odw-extension) |
| `recordVersions`, `driftEval` | [Drift watch](../guides/running-and-observing.md#drift-watch-odw-extension) |
| `modelMismatch` | [The model that actually served an agent](../guides/running-and-observing.md#the-model-that-actually-served-an-agent-odw-extension) |
| `otel` | [Observability](../guides/running-and-observing.md#observability-opentelemetry-traces-odw-extension) |
| `retention` | [Reclaim disk](../guides/running-and-observing.md#reclaim-disk-odw-gc-and-odw-pin-odw-extension) |
| `claudeJobsScope` | [Dashboard](../guides/dashboard.md#dashboard-observe-inspect-chat) |
| `approveLinks` | [Approve from your phone](../guides/dashboard.md#approve-from-your-phone-odw-extension) |
| `notify` | [Run notifications](../guides/notifications.md#run-notifications) |
| `triggers` | [Start runs from webhooks](../guides/scheduling-and-triggers.md#start-runs-from-webhooks-github-linear-slack-odw-extension) |
| `digest` | [Morning digest](../guides/scheduling-and-triggers.md#morning-digest-odw-digest-odw-extension) |
