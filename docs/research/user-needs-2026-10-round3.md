# ODW user needs, round 3 (research, 2026-10-18)

Scope: what people running parallel coding agents, orchestrators and workflow runtimes
still ask for in mid-to-late October 2026 that ODW does not cover after everything in
CHANGELOG "Unreleased — 0.5.0" and ROADMAP R1–R12. Every link below was opened. "ODW
lacks" was checked against README.md, CHANGELOG.md, `odw --help` (v0.5.0-dev+gcba0f95) and `src/`.

Ranking weighs how often a need comes up, how recent it is, and how well it fits ODW's
position: one script across many CLIs, runs independent of the host session, local-first.

---

### 1. No forecast before a run: you learn the cost only at the end. High · S–M

**Pain:** people approve a fan-out without knowing whether it will cost $2 or $600, or
whether the width buys any quality.

- anthropics/claude-code#95816 (Sep 21, 2026, open): "A money-audit ran 547 planned agents
  … ~180 ran (~36.6M tokens, ~$606, 4h15m) before I stopped it." and "Please cap total
  agent fan-out / warn before large runs". https://github.com/anthropics/claude-code/issues/95816
- anthropics/claude-code#101248 (Oct 11, 2026, open): "I find out only at the end whether a
  task cost $0.50 or $15, or took 3 minutes or 40." https://github.com/anthropics/claude-code/issues/101248
- openai/codex#46390 (Sep 18, 2026, open): "I had no intuitive way to know whether I was
  authorizing approximately $2, $10, or $50". https://github.com/openai/codex/issues/46390
- openai/codex#51519 (Oct 6, 2026, open) asks for "a warning/checkpoint before unexpectedly
  large consumption". A Codex DX engineer says more than two sub-agents at once is "almost
  certainly burning tokens for 0 quality gain" (Sep 21, 2026).
  https://github.com/openai/codex/issues/51519 · https://mixed-news.com/en/codex-developer-parallel-agents-limit-nous-1393-agents/

**ODW lacks:** ODW measures cost after the fact: the spend receipt, `odw compare` and the
cost/time columns in `odw eval`. Before a run it only has `fanOutWarn` (one `parallel()`
wider than 25) and a `--budget` token target that the script itself has to check. It does
not estimate cost from past runs of the same workflow, and it cannot stop before an
expensive phase on the basis of a forecast.

**Direction (S–M):** `odw run --estimate` (also `odw estimate <wf> --args`). Use the last N
runs of the same workflow sha256 or name (already in `meta.json`) to give a p50/p90 cost and
wall time per phase and per adapter. Add a per-fan-out estimate inside the run: before a
`parallel()` wider than X, multiply its width by that label's historical median cost. Add
an opt-in `costGate: { usd }` that turns a fan-out whose forecast exceeds the gate into an
automatic `checkpoint()` with the estimate as its payload. That way the approve-from-phone
flow you already have also covers "this phase will cost ~$40, go?". With no history, say
"no estimate" instead of guessing.

---

### 2. You cannot preview or test a workflow without paying for real agents. High · M

**Pain:** a workflow is code that fans out dozens of agents, but the only way to check its
control flow (branches, retries, schema handling) is to run it for real.

- anthropics/claude-code#66304 (Jun 8, 2026; closed by the stale bot): "Workflows are powerful
  but opaque to author and expensive to run." and "kicking one off blind — without a clear
  view of its phases, the agent calls in each phase … is risky".
  https://github.com/anthropics/claude-code/issues/66304
- anthropics/claude-code#13330: "No way to test workflows without actual execution." and
  "For complex workflows with branching, it's critical to verify all paths before production
  use." https://github.com/anthropics/claude-code/issues/13330

**ODW lacks:** a deterministic mock agent exists, but only inside `odw conformance` and
ODW's own `npm test`. Workflow authors cannot use it. `odw eval` runs real agents only.
`validate()` is a primitive for compile-checking, and there is no `odw validate`/`odw
check` command. Nothing renders the planned phase/agent structure before a run.

**Direction (M):** turn the conformance mock into a user-facing feature.
(a) `odw test <wf>` with a `.odw/tests/<name>.json` that scripts replies per label/phase or
by matching the prompt (`{ "label": "verify-*", "reply": {...} }`, or "fail with
rate_limit", "empty_reply", "schema miss once"). It runs the real runtime at $0 and asserts
on the result, logs and agent counts, using the same check vocabulary as eval.
(b) `--record` on a real run saves replies as fixtures. Replaying them gives a regression
test for prompt and control-flow edits. This is also the "golden trace" practitioners ask
for (see #6).
(c) `odw run --dry` is the mock run with every agent answered by a stub. It prints the phase
tree and how many agents each phase would start, which, together with #1, is the preview
#66304 asked for.

---

### 3. Debugging one step means re-running the run. Medium-high · M

**Pain:** when one agent's prompt or output is wrong, authors want to re-run just that step
with an edited prompt, or pause before a phase and inspect it. Today they rerun or resume
everything.

- LangGraph's time-travel docs make this a first-class operation, "Retry from a prior
  checkpoint", with the caveat that "Replay re-executes nodes—it doesn't just read from
  cache." https://docs.langchain.com/oss/python/langgraph/use-time-travel
- reliant-labs/reliant PR #683 (merged Oct 10, 2026): a failed sub-agent used to pause
  everything, which "cancelled every in-flight activity … and parked every thread … until a
  human resumed it". The fix lets the parent "resume it, retry with a fresh agent, or
  continue". https://github.com/reliant-labs/reliant/pull/683
- Authoring feedback is part of the same pain. anthropics/claude-code#63540 (closed by the
  stale bot): a misleading parse error "led me (and would lead anyone) to scan for type
  annotations that aren't there". https://github.com/anthropics/claude-code/issues/63540

**ODW lacks:** `odw resume` replays unchanged calls, so editing one prompt and resuming
does re-run only that call and everything after it. But you have to edit the workflow
file. There is no way to re-run one agent in isolation with its recorded inputs, to set a
breakpoint, or to step through phases. There is no `odw check` command that reports parse
errors with a source excerpt.

**Direction (M):**
- `odw replay <run> --agent <label>`: re-dispatch one saved call (prompt, options, adapter
  and model, at the worktree base it saw) as a small new run, optionally with
  `--prompt @file` or `--adapter`. Then `odw compare` it against the original agent.
- `odw run --break <phase|label>` (and `--step`): insert an implicit checkpoint before the
  named phase or each phase, reusing the checkpoint machinery, so the dashboard and phone
  links work. Approve with edits so args can be changed before continuing.
- `odw check <wf>`: `validate()` from the CLI, with line and column, a code frame, and the
  `meta` literal checked.

---

### 4. Starting runs from where work is tracked (Linear, Slack, GitHub). Medium-high · M

**Pain:** teams assign work in Linear, Jira, Slack or GitHub issues and want the agent run
to start from there and report back there. Copying context into a terminal is the friction.

- anthropics/claude-code#12925 (open since Dec 2025, +1s through Sep 2026): "the only ways to
  get it with Claude Code are Routines plus a custom webhook relay, or a third-party agent
  (Cyrus)" and "native Linear agent assignment … is becoming a real factor in tooling
  decisions." https://github.com/anthropics/claude-code/issues/12925
- Codex already does it: "you can assign issues to Codex the same way you assign them to
  teammates", and "Codex starts work and posts updates back to the issue."
  https://learn.chatgpt.com/docs/third-party/linear

**ODW lacks:** integrations only go out. ODW sends `notify` webhooks, ntfy buttons, signed
approve links and draft PRs, and it runs workflows on a schedule. It has no endpoint that
starts a run, and nothing posts progress back to an issue. `odw serve` only allows
approve-scoped writes remotely.

**Direction (M):** triggers declared in the config, e.g. `"triggers": { "linear-fix": {
"workflow": "fix-issue", "secret": "...", "args": { "issue": "$.data.identifier", "body":
"$.data.description" } } }`. Expose them as `POST /api/triggers/<name>`, refused unless the
HMAC signature checks out (Linear, GitHub and Slack each sign their webhooks). Add a
`--token-scope trigger` token. Apply a per-trigger rate limit and concurrency of 1 per
issue, and run with `--untrusted` by default, because issue text is untrusted input. Go
back out through the existing `notify` with a `context` object carrying the issue
id/URL, and ship recipes ("comment on the Linear issue", "reply in the Slack thread",
"open the draft PR and link it"). Do not build a Linear app; ship signed webhooks plus
recipes.

---

### 5. No ready path into GitHub Actions; CI timeouts lose the run's output. Medium · S–M

**Pain:** people want the same workflow to run in CI on a label, a schedule or a PR. In
GitHub Actions a step timeout kills the agent run together with its cleanup and output.

- anthropics/claude-code-action#1881 (Oct 5, 2026, open): when `timeout-minutes` hits, "the
  runner kills the whole composite step. The action's own `always()` cleanup steps die with
  it", and the workaround is "accept that a run hitting it loses its cleanup."
  https://github.com/anthropics/claude-code-action/issues/1881
- anthropics/claude-code-action#1462 (Jul 2, 2026, open): background work killed while
  "the action step concluded `success`", which is "silent and green".
  https://github.com/anthropics/claude-code-action/issues/1462

**ODW lacks:** it has all the pieces: `--wait`, exit codes, orphan detection, `odw bundle`,
`odw apply --pr`, and PR shepherding. But it ships no GitHub Action or documented CI recipe.
`--timeout` exits 124 and leaves the run going, which is wrong on an ephemeral runner.
Nothing writes the receipt to `$GITHUB_STEP_SUMMARY`. The repo's `.github/workflows/` only
builds ODW itself.

**Direction (S–M):** a composite `xz1220/odw-action`. It installs the pinned binary
(SHA256-checked like `install.sh`) and runs `odw run <wf> --wait` with a
`--deadline <s>` (new flag), which **stops** the run gracefully (stopped, diffs kept) a
margin before the step's `timeout-minutes`. It writes the spend receipt, agent table and
failures to the job summary, uploads `odw bundle` as an artifact, and optionally runs `apply
--pr`. Document secrets/OIDC use and `--untrusted` for fork PRs.

---

### 6. Model and CLI churn breaks workflows, sometimes silently. Medium · S–M

**Pain:** model names get retired, CLIs reach end of life or change flags, and a model bump
can change behaviour while every check stays green.

- gh-aw-workshop#257 (Oct 13–14, 2026): "The agent failed because the configured model name
  is invalid, unknown, or unavailable for this engine/account." Retrying does not help.
  https://github.com/Bananito921/gh-aw-workshop/issues/257
- littlebearapps/untether#720 (closed Sep 30, 2026): "Google ended Gemini CLI support for
  individual and free accounts on 2026-06-18", and Antigravity "must not reuse the `gemini`
  engine id (auth, flags and session semantics all differ)".
  https://github.com/littlebearapps/untether/issues/720
- "Your Model Upgrade Broke Three Workflows and the Tests Still Passed" (dev.to): "A tool
  call that used to fire now doesn't." Its advice: "Pin a golden trace for every workflow
  you care about." https://dev.to/saurav_bhattacharya/your-model-upgrade-broke-three-workflows-and-the-tests-still-passed-2ef1

**ODW lacks:** ODW records CLI versions (`cli_version`) and has `odw compare` and `odw eval
--baseline`, so it can *measure* drift once you think to look. It does not detect that a
CLI or model changed and check for you. `odw doctor --smoke` tests the default model only,
not every model named in `meta.phases`, model tiers or fallback chains. A retired model
name is not a classified failure reason (it presumably lands in `not_found`/`exit`). The
README's `gemini` adapter rows have no end-of-life note for individual/free accounts.

**Direction (S–M):**
- `odw doctor --models` probes every adapter/model pair the config and the workflows name
  (one short prompt each, opt-in because it costs a little).
- A `model_unavailable` failure reason that fails fast and falls through the fallback chain.
- "Drift watch": when a run records a CLI version or model different from the previous run of
  the same workflow, log it once and, if the workflow has an eval file, suggest or schedule
  `odw eval --baseline` (`odw schedule add … --on-cli-change`).
- With #2, the recorded fixtures serve as golden traces: compare tool-call counts and
  schema shape between versions.

---

### 7. Nothing learned in one run carries over to the next. Medium · M

**Pain:** each run starts cold. Conventions found, dead ends and user corrections are lost,
or users maintain them by hand.

- anomalyco/opencode#16077 (closed "not planned", Oct 1, 2026): "decisions, learned
  conventions, and task state from an earlier session do not re-enter context unless you
  manually paste them", and "We end up hand-rolling per-session memory via external tools."
  https://github.com/anomalyco/opencode/issues/16077
- arXiv 2606.13174, "Compiling User Corrections into Runtime Enforcement for Coding Agents"
  (Jun 2026): "a correction remembered in one session may still be violated in the next".
  https://arxiv.org/abs/2606.13174
- arXiv 2610.04838, MemTrace (Oct 4, 2026), on why memory must be checked before reuse:
  "repository changes can invalidate earlier execution evidence."
  https://arxiv.org/html/2610.04838v1

**ODW lacks:** the notes board (R3) lasts for one run only. Saved results, transcripts and
checkpoint notes are never fed back into later runs. Vendors keep declining this
("not planned" at Claude Code #14227 and OpenCode #16077), which leaves room for a
runtime-level feature that works across CLIs.

**Direction (M):** an opt-in workflow memory, `.odw/memory/<workflow>.jsonl`, kept in the
repo so it can be reviewed in PRs.
- Entries come from explicit sources only: `odw note --keep`, checkpoint reject notes and
  approve-with-edits diffs (the user corrections in 2606.13174), and `expect` misses that
  were later fixed.
- Each entry carries provenance: the run, the commit sha, and the paths it concerns.
- On later runs, `agent(…, { memory: true })` prepends the entries that still apply. An
  entry whose paths changed since its sha is marked stale and left out, as MemTrace
  suggests.
- `odw memory list|prune` manages entries. Do not summarize transcripts with a model by
  default.

---

### 8. Team use: who did what, a shared runner, and shared limits. Medium · M–L

**Pain:** setups are built for one developer. Teams want several people to launch, watch
and approve runs on one machine or box, with attribution and without passing a single
token around.

- anthropics/claude-code#92517 (Sep 6, 2026, open): "Work stalls on one person's cap while
  everyone else's capacity sits idle." Today they write "a hand-off ledger to a shared
  network drive … which is fragile and loses everything that was not written down."
  https://github.com/anthropics/claude-code/issues/92517
- Launch HN: Runtime (YC P26), on why teams moved to shared agent infrastructure: "Every
  repo required an engineer doing one-off local setup." and "Skills and context lived in
  one person's head." It sells RBAC "scoped per human and per agent".
  https://news.ycombinator.com/item?id=48225040

**ODW lacks:** `odw serve` has one token with a scope of `read` or `approve`. Approvals
record a channel (`by: cli | dashboard | link`), not a person. Runs carry no launcher
identity. `--on ssh://` gives one shared box but no per-person view. The ROADMAP rules out a
hosted policy/authorization system, so this has to stay small.

**Direction (M, capped):** named tokens (`odw serve --tokens tokens.json`: `{ name, scope,
hash }`). Record `by: "alice"` on approvals, stops and triggers, and `launchedBy` in
`meta.json`, from `$USER`/git `user.email` locally or the token name remotely. Add a "mine
/ team" filter in the dashboard and `odw list --by`. Leave out RBAC beyond the existing
scopes and any hosting, in line with ROADMAP §5.

---

### 9. Several subscriptions or accounts, one run. Medium · S

**Pain:** heavy users and small teams own several Claude or Codex accounts and want work to
move to the account with quota left instead of re-logging in by hand.

- anthropics/claude-code#34341 (closed as a duplicate of #20131): "This cycle happens
  multiple times per day for heavy users and breaks flow significantly", and the request:
  "When one account hits its rate limit, automatically switch to the next available
  profile". https://github.com/anthropics/claude-code/issues/34341
- anthropics/claude-code#92517 (above): pool allowance across members so capacity is not
  stranded. https://github.com/anthropics/claude-code/issues/92517

**ODW lacks:** most of the machinery exists: adapter entries take `env`, fallback chains
with `handoff`, per-adapter quota breakers, `quotaWait`, and `CLAUDE_CONFIG_DIR`/`CODEX_HOME`
are respected. But there is no documented "accounts" concept. You have to hand-write one
adapter per config dir and chain them, and routing does not prefer the account with the
most headroom.

**Direction (S):** `"accounts": { "claude": ["~/.claude-work", "~/.claude-personal"] }`
expands into `claude@work`/`claude@personal` adapters, each with its own `CLAUDE_CONFIG_DIR`
(or `CODEX_HOME`), its own concurrency cap and its own quota breaker. Treat them as an
implicit fallback chain with handoff, and spread new dispatches by observed headroom.
`odw doctor` checks each login. Document that pooling must respect each provider's terms.

---

### 10. First run: from install to a first useful workflow. Low-medium · S

**Pain:** orchestrators still lose new users between "installed" and "first useful run".
Too many steps, unclear state, and repo setup that lives in one person's head.

- OrchestratorInc/agent-orchestrator PR #5996 (Sep 28, 2026), reworking first-run
  onboarding: "We want to reduce the number of clicks the user needs to make to get
  onboarded", and a stale screen "led me to believe that I didn't complete the step".
  https://github.com/OrchestratorInc/agent-orchestrator/pull/5996
- Launch HN: Runtime: "Every repo required an engineer doing one-off local setup."
  https://news.ycombinator.com/item?id=48225040

**ODW lacks:** `odw init` and `odw doctor [--smoke]` cover the machine. The quick start's
first run is a real, paid run of `examples/fan-out-reduce.js` from the repo checkout. A
binary-only install has no built-in examples, and there is no `odw new` to scaffold a
workflow into `.odw/workflows/`. No $0 demo exists until #2 lands.

**Direction (S):** `odw new [<template>]`, with templates such as review-swarm,
fix-until-green, plan-approve-execute and pr-shepherd embedded in the binary. It writes
`.odw/workflows/<name>.js` plus a starter `.odw/evals`/`.odw/tests` file, and on a git repo
offers `.worktreeinclude` from detected lockfiles and `.env*`. `odw init` should end with
`odw run hello --dry` (the mock from #2), which shows the live view and dashboard at no
cost, then print the real command.

---

## Build next (top 4)

1. **Pre-run estimate and cost gate (#1, S–M).** It is the most frequent and most recent
   ask (#95816, #101248, codex #46390, #51519, all Sep–Oct 2026). ODW already has the data
   (per-agent cost history keyed by workflow sha) and the gate (`checkpoint()` and phone
   approval), so it is mostly wiring.
2. **`odw test` / `--dry` with scripted agents and recorded fixtures (#2, M).** It makes
   workflows authorable and previewable at $0, provides the golden traces that #6 needs,
   and the $0 demo that #10 needs. The conformance mock is the starting point.
3. **Signed inbound triggers plus recipes for Linear, GitHub and Slack (#4, M), with the
   GitHub Action (#5, S–M).** Both are about starting a run where the work is tracked and
   reporting back there. They share `--deadline`, `--untrusted` defaults and the
   notify-with-context plumbing.
4. **`odw replay --agent` and `--break` / `--step` (#3, M).** These let you debug one step
   without re-running or editing the whole workflow, and they reuse resume keys and
   checkpoints.

Next in line: drift watch and `doctor --models` (#6), accounts (#9), workflow memory with
provenance (#7), and named tokens (#8).
