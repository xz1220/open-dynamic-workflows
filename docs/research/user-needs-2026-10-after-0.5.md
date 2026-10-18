## After 0.5.0: what builders still ask for (research, 2026-10-18)

Scope: needs from people running parallel coding agents and orchestrators that ODW
0.5.0 does **not** cover. Things 0.5.0 already ships are excluded: resume and replay,
stall watchdog, quota pause, `expect`, checkpoints, cost, diffs and `odw apply`,
containers, redaction, schedules, eval/compare and OTLP.

Sources: GitHub issues, Hacker News threads, arXiv and blogs, all opened while writing
this. Reddit could not be fetched from this environment, so no Reddit threads are cited.

### 1. Headless runs report success after the agent's background work was killed — High · S
- **Pain:** the model starts a background task or subagent, ends its turn, and `-p` exits. The work dies, and the run looks green.
- **Evidence:**
  - "from the outside it looks like the turn completed successfully while the actual work … never finished" ([claude-code #85129](https://github.com/anthropics/claude-code/issues/85129), Aug 2026, still unfixed)
  - "A run that ends with pending background tasks reporting `success` is the worst of both: silent and green" ([claude-code-action #1462](https://github.com/anthropics/claude-code-action/issues/1462))
  - The same failure in Google's new CLI: a subagent's "~22k-token output was never emitted on the parent run's `stream-json` stdout" ([antigravity-cli #1077](https://github.com/google-antigravity/antigravity-cli/issues/1077))
- **ODW lacks:** a check that every background task or subagent started in the transcript finished before the `result` event. `expect` only catches this when the call sets it.
- **Direction (S):** while parsing `stream-json`, track background or `run_in_background` tool starts and their completions. If any is still open at `result`, fail the agent with a new reason `orphaned_background` (with `warn`/`fail` modes like `permissionDenials`). Optionally have the `claude` adapter append a "never end a turn with background work running" system prompt.

### 2. Runaway loops: the agent repeats the same call for hours — High · S–M
- **Pain:** an agent stuck in a loop still produces output, so a stall watchdog never fires, and spend keeps climbing.
- **Evidence:**
  - "repeatedly sending the same requests for several hours … $500+ of unexpected token usage". The fix a commenter proposed: "comparing the last 3-5 tool calls for exact duplicates … tool name + arguments hash" ([claude-code #35166](https://github.com/anthropics/claude-code/issues/35166), closed not planned)
  - "There is no mechanism to limit the number of tool calls a sub-agent can make" ([claude-code #36727](https://github.com/anthropics/claude-code/issues/36727))
  - From HN: agents are "terrible at recognizing when they're going in circles" ([Optio thread](https://news.ycombinator.com/item?id=47520220))
- **ODW lacks:** per-agent ceilings and loop detection. `stallTimeout` catches silence, not repetition, and `--budget` caps the whole run, not a single agent.
- **Direction (S–M):** `agent(…, { limits: { toolCalls, costUsd, outputTokens, repeat: 3 } })`, enforced live from the transcript stream. The repeat rule matches the tool name plus a hash of its arguments. A breach kills the agent with reason `runaway`, and the event names the repeated call.

### 3. Parallel agents don't know what the others decided — High · M
- **Pain:** each change passes alone, but they break together, because one agent changed an interface another still relies on.
- **Evidence:**
  - "Parallel coding agents can produce patches that work alone but fail when merged". Interference hit 97% of constructed runs, and "a message describing the completed concurrent change recovered 82%" ([arXiv 2609.25396, Sep 2026](https://arxiv.org/abs/2609.25396))
  - "Without a first-class shared scope, the parent must manually relay information between agents" ([codex #21027](https://github.com/openai/codex/issues/21027))
- **ODW lacks:** any channel between sibling agents in a `parallel()` fan-out. The only way information moves is through the script, after a sibling has returned.
- **Direction (M):** a run-scoped notes board (**ODW extension**). Agents append notes through an injected file or command, such as `odw note "renamed parseX → parse"`, and later agents get new notes in their prompt or worktree. When an agent finishes, ODW posts a summary of its interface changes (its diff stat plus the exported signatures it touched). Also ship an example that re-runs the siblings' `expect` after one of them lands.

### 4. Merge conflicts at integration time still need a human — High · M
- **Pain:** `apply --all` stops at the first conflict, and people want the agent to rebase or resolve and then re-verify.
- **Evidence:**
  - "one issue I've seen with other tools doing worktree stuff is they don't deal with merge conflicts automatically" (mashlol, [Superset Launch HN](https://news.ycombinator.com/item?id=48236770))
  - "Merge and integration, not the coding step itself, is often where the actual time cost of running multiple agents shows up" ([Codacy, Sep 2026](https://blog.codacy.com/does-your-engineering-team-have-a-parallelization-strategy-for-ai-coding-agents-2026))
- **ODW lacks:** a resolve step. `odw apply` previews and reports conflicts, then stops.
- **Direction (M):** `odw apply --all --resolve [adapter]`. On a conflict, dispatch an agent in a temporary worktree with the base, both sides and the conflicting hunks. Accept its result only if `applyVerify` passes, and record it as a new agent in the run so it can be reviewed with `odw diff`.

### 5. Approving and steering from a phone — Medium-high · M
- **Pain:** a checkpoint or a stuck run waits until you get back to the terminal or the loopback dashboard.
- **Evidence:**
  - "If you step away, Claude Code stalls until you come back and press "y"" ([claude-remote-approver](https://github.com/yuuichieguchi/claude-remote-approver), which uses ntfy approve/deny buttons)
  - "If the laptop sleeps, the session waits." The guide's recommended setup is a VPS with phone control ([Product Compass, Oct 2026](https://www.productcompass.pm/p/claude-code-vps))
- **ODW lacks:** any remote write path. `odw serve` off loopback is read-only by design, and `notify` can say a run is waiting but cannot take the answer.
- **Direction (M):** a separate, narrow approve-only capability: signed, single-use approve/reject links per checkpoint, carried in the `notify` webhook payload (with ntfy action buttons), plus `--token-scope approve` for the remote dashboard. This keeps the "narrow write" principle, because the only writes are checkpoint decisions and pause, resume or stop.

### 6. Agents game the checks they are judged by — Medium · S
- **Pain:** to get green, an agent edits or skips tests, and `expect: { command: 'npm test' }` then passes.
- **Evidence:**
  - "We observe explicit reward hacking by both Codex and Claude Code". The detection the paper uses includes "test file edit detection" ([EvilGenie, arXiv 2511.21654 v2, May 2026](https://arxiv.org/abs/2511.21654v1))
  - Cursor's own CI-autofix template lets the agent fix the bug *or* "skip a test it identifies as flaky" ([Cursor CI autofix](https://cursor.com/workflows/autonomous-agents/ci-autofix))
- **ODW lacks:** a negative constraint. `expect.files` says what must change, but nothing says what must *not* change.
- **Direction (S):** `expect: { untouched: ['test/**', '*.snap', '.github/**'] }`, which counts as a miss if the diff touches a listed path. Also add an optional `command` run against the *base* versions of the protected files (held-out check).

### 7. Network egress is all-or-nothing — Medium · M
- **Pain:** a container's network is `none` or `default`. Agents need their model API, so in practice the network is wide open.
- **Evidence:**
  - Treat the vendor sandbox as "the inner ring, not the boundary". The author recommends "a firewall or cloud egress rule the agent cannot influence" ([oddguan, May 2026](https://oddguan.com/blog/second-time-same-sandbox-anthropic-claude-code-network-allowlist-bypass-data-exfiltration/))
  - "Put agent traffic behind controls that are not controlled by the agent process itself" ([Penligent, May 2026](https://www.penligent.ai/hackinglabs/claude-code-sandbox-bypass/))
- **ODW lacks:** a host allowlist for containerized agents.
- **Direction (M):** `sandbox.network: { allow: ['api.anthropic.com', 'registry.npmjs.org'] }`. This is enforced by an ODW-run egress proxy sidecar on an internal network, outside the agent's container. Each adapter gets default hosts, every denied connection is logged as an event, and `odw doctor` tests the allowlist.

### 8. Closing the loop with CI and PR review — Medium · M–L
- **Pain:** people want ticket → PR → fix red CI → address review comments, without hosting it on a SaaS.
- **Evidence:**
  - Optio "monitors CI and reviews, feeds failures and review comments back to the agent". On HN its critics warned about auto-merge: "decided to enable auto-merge, such that the PR actually merged" ([Optio Show HN](https://news.ycombinator.com/item?id=47520220))
  - Cursor ships the hosted version: on "a failing CI run for an open pull request", it "commits a fix to the PR branch" ([Cursor CI autofix](https://cursor.com/workflows/autonomous-agents/ci-autofix))
- **ODW lacks:** any `gh`/forge integration. There is no PR output, no CI or review trigger, and `odw schedule` is time-based only.
- **Direction (M–L):** `odw apply --pr` (push the `keep` branch and open a draft PR with the run summary and spend receipt). Add an `examples/pr-shepherd.js` that polls `gh pr checks` and review comments on a schedule, plus a checkpoint before anything is marked ready. Never auto-merge.

### 9. Planning who touches which files, before they write — Medium · M
- **Pain:** conflicts show up only at merge time, and orchestration should split or sequence overlapping work before it runs.
- **Evidence:**
  - "Two agents pointed at the same files produce merge conflicts that appear only at merge time" ([Ivy, Sep 2026](https://ivy.app/blog/agent-orchestration-patterns-for-coding-agents))
  - Declared-scope admission raised integration success "from 65.6% to 96.7%", but mostly by serializing the work ([Claim Plane, arXiv 2608.00947](https://arxiv.org/abs/2608.00947))
- **ODW lacks:** declared scopes on `agent()`, and any scheduler that uses them.
- **Direction (M):** `agent(…, { scope: ['src/parser/**'] })`. `parallel()` serializes calls whose scopes overlap, and a write outside the declared scope is flagged through the diff and `expect`. This should be advisory by default, since the paper shows strict blocking hurts pass rates.

### 10. A fallback or resume starts over on another CLI instead of continuing — Medium · M
- **Pain:** when Claude's quota runs out mid-task, the codex fallback redoes the work from scratch, because context doesn't cross CLIs.
- **Evidence:**
  - "So cross-agent resume carries an inherent performance penalty: you keep the (visible) transcript but lose the reasoning", and "this switch is going to burn subscription limits" ([Ctx Show HN](https://news.ycombinator.com/item?id=47836740))
  - "Claude CLI sessions are stateless … context and pending tasks are lost unless manually documented" ([claude-code #11455](https://github.com/anthropics/claude-code/issues/11455))
- **ODW lacks:** a handoff. The README says the next adapter "starts the work over", and the partial worktree and transcript are thrown away.
- **Direction (M):** `fallback: { handoff: true }`. Keep the failed attempt's worktree. Build a handoff brief from its transcript (the files it touched, the last plan and messages, and its diff so far), prepend it to the next adapter's prompt, and record the brief as an artifact.

### 11. Off-laptop execution without a SaaS — Medium · L
- **Pain:** overnight fan-outs die when the laptop sleeps, and people want to dispatch to their own VPS.
- **Evidence:**
  - "I might use this if it supported any old cloud or VPS, and was at most $10/mo" and "I like to own my hardware, not rent it" ([Boxes.dev Show HN](https://news.ycombinator.com/item?id=48399358))
  - "If the laptop sleeps, the session waits" ([Product Compass](https://www.productcompass.pm/p/claude-code-vps))
- **ODW lacks:** remote dispatch. You can run `odw` on a box over SSH, but you can't submit a run from a laptop or sync its run directory back.
- **Direction (L):** `odw run --on ssh://host`. It rsyncs the workflow and a git bundle, starts the remote worker, and tunnels `serve`. Afterwards `odw pull <run>` brings the run directory back, so `diff`, `apply` and `compare` work locally. No daemon is needed, consistent with the "no resident scheduler" stance.

### 12. Google's Antigravity CLI (`agy`) has no adapter — Low-medium · S
- **Pain:** Gemini users are moving to `agy`, which now has a scriptable headless mode.
- **Evidence:**
  - v1.1.8 (Jul 2026): "Print mode (-p / --print) now supports structured, machine-readable output via the --output-format flag", plus `--json-schema` ([release notes](https://www.havoptic.com/r/antigravity-cli-1.1.8))
  - Already used headless with `-p --output-format stream-json` in real runs ([antigravity-cli #1077](https://github.com/google-antigravity/antigravity-cli/issues/1077))
- **ODW lacks:** a built-in `agy` adapter. Today it would have to be declared by hand.
- **Direction (S):** a built-in `agy` adapter with `stream-json` usage, native `--json-schema`, failure samples for classification, and a conformance run. Pair it with item 1's check, since `agy` drops subagent output.

### What to build next (top 4)
1. **Orphaned-background detection (S).** This is the cheapest fix for the "silent and green" failure the 0.5.0 evidence theme is meant to prevent, and it hits Claude Code and `agy` today.
2. **Per-agent limits and loop detection (S–M).** These complete the cost story: 0.5.0 shows spend, and this stops one runaway agent from burning a run's budget overnight.
3. **Run-scoped notes board plus interface-change broadcast (M).** This is the one research-backed fix for semantic conflicts (82% recovered), and only a cross-agent runtime like ODW can do it across CLIs.
4. **Approve-only remote links and scope (M).** This makes checkpoints usable away from the desk while keeping writes narrow. It pairs with `notify`, and later with off-laptop runs (item 11).

Quick wins to slot in alongside these: `expect.untouched` (item 6, S) and the `agy` adapter (item 12, S).
