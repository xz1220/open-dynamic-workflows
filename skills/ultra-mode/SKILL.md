---
name: ultra-mode
description: >
  Execute explicitly authorized Ultracode / Ultra Mode requests: optimize for
  exhaustive, correct answers within the user's stated scope by using any
  available independent-work mechanism (ODW workflows, subagents, dispatched
  workers, or tool-worker fan-out), with serial multi-pass fallback only when no
  such mechanism exists. Use when the user explicitly says ultracode, ultra
  mode, go exhaustive, deep mode, multi-agent, parallel, adversarial,
  comprehensive, do not miss anything, check every angle, or asks for several
  independent verification strategies. Do not activate merely because a task is
  difficult, technical, ambiguous, or high-stakes.
---

# Ultracode / Ultra Mode

Ultracode is a behavioral mode, not a specific tool. When it is active, optimize
only for the most complete and correct answer within the user's scope. Token and
compute cost are not constraints, but cost freedom does not expand the task
scope by itself.

Use whatever independent-work mechanism the environment provides. In this
repository, prefer Open Dynamic Workflows (`odw`). If no independent mechanism
exists, use the serial fallback below and disclose that fallback in the final
answer.

## Scope Discipline

- Treat activation as explicit authorization only. Valid activation can come
  from the current request, a confirmed session setting, or a direct request for
  multi-agent, parallel, adversarial, exhaustive, or independent verification.
- Re-evaluate scope for every request, even in a session where the mode is on.
  Do not let a completed Ultracode task spill into unrelated follow-up work.
- Keep trivial work trivial. If a competent engineer could answer correctly in
  roughly 30 seconds, answer directly even if the mode is active.
- Match depth to the request. Narrow casual requests get modest fan-out and
  light verification; explicit "be exhaustive" requests get broader discovery,
  loop-until-dry exploration, adversarial verification, and synthesis.
- If the request is ambiguous, choose the narrower reasonable scope and state
  what was and was not covered.
- Add workers or rounds only to close a concrete coverage gap. "Budget remains"
  is not a reason by itself; "area X is unexamined" is.

## Pick The Decomposition Purpose

Before dispatching work, decide which purpose the split serves:

- **Coverage**: many independent areas exist, such as files, modules, product
  requirements, or research angles.
- **Confidence**: one answer is needed, but a single plausible pass may be
  wrong; gather independent perspectives and challenge them.
- **Scale**: the task is too large for one pass, such as a full audit, broad
  migration, or large bug hunt.

Most real Ultracode runs combine at least two of these purposes.

## Control Flow

Ask first: can a worker's result be used immediately, or must all sibling
results exist before the next step?

- **Fan-out / fan-in**: dispatch independent units, then merge at a barrier.
  Use this only when the next step needs the whole batch: deduplication,
  ranking, "did anyone find a bug?", or final synthesis.
- **Pipeline**: let each item move through its own stages without waiting for
  unrelated items. Default to this for multi-stage work like discover -> verify
  -> write.
- **Loop-until-dry**: for open-ended discovery, run independent search rounds,
  dedupe findings, then repeat until 2-3 consecutive rounds find nothing new
  (raise the threshold for high-risk audits).
- **Budget-aware expansion**: when the user gives a real effort or token
  budget, continue expanding coverage and verification depth until the budget is
  nearly exhausted or no concrete gaps remain.

Typical audit shape: fan out by domain, run loop-until-dry inside each domain,
send each surviving finding through an independent verification pipeline, then
use one final barrier for deduped synthesis.

## Quality Gates

- **Adversarial verification**: for any non-trivial finding or "fixed" claim,
  send skeptics whose job is to refute it. The burden of proof is on the claim.
  Keep the finding only when most serious refutation attempts fail.
- **Multi-perspective verification**: assign different skeptics to different
  failure modes: requirements fit, security, performance, concrete
  reproduction, edge cases, or unexamined assumptions.
- **Jury mode**: for open-ended design or synthesis, generate several genuinely
  different proposals, score them independently, then build the final answer
  from the strongest proposal plus useful ideas from the others.
- **Multi-strategy search**: when exploring, run different search strategies in
  parallel so one strategy's blind spots do not define the result.
- **Gap review**: after you think the work is complete, run a dedicated pass
  asking what is still missing: unvisited files, unverified claims, unread
  sources, untested edge cases, or uncovered angles. Treat any real gap as new
  work, not as a footnote.
- **Coverage disclosure**: if coverage was bounded in any way, say so
  concretely in the final answer.

## ODW Mapping

When `odw` is available, prefer it for independent work.

1. Check `odw --version`.
2. In this repository, use `examples/ultra-mode.js` for the common planner ->
   lanes -> reviewers -> synthesis pattern.
3. Outside this repository, run the bundled workflow by its path — no copy
   needed: `odw run <this skill's directory>/references/ultra-mode-workflow.js`
   with the same `--args`. Copy it to `.odw/workflows/ultra-mode.js` only to
   customize it or to run it by name.
4. For tasks needing loop-until-dry, custom domain fan-out, or pipeline
   behavior, write a task-specific ODW workflow instead of forcing everything
   through the bundled template.
5. Inspect `final`, `lanes`, and `reviews`; treat them as advisory material.
   Perform real edits, tests, commits, and final judgment yourself.

Bounded run:

```bash
odw run examples/ultra-mode.js --wait --args '{"task":"<task>","intensity":"standard"}'
```

Longer run:

```bash
RUN=$(odw run examples/ultra-mode.js --args '{"task":"<task>","intensity":"max"}')
odw logs "$RUN" --follow
odw result "$RUN"
```

Lanes are saved the moment each finishes, so a long run is usable before
synthesis: `odw agents "$RUN"` lists them with a preview, and
`odw result "$RUN" --agent planner` (or `--agent <id>`) prints one lane's full
output. Use finished lanes instead of redoing their work. If lanes stall, stop
the run, fix the cause, and `odw resume "$RUN"`: finished lanes replay from
disk and only the rest run again.

Useful arguments:

- `task`: required unless passing a bare string.
- `intensity`: `lite`, `standard`, or `max`; default to `standard`.
- `lanes`: independent work lanes; default is 3/4/6 by intensity.
- `reviewers`: adversarial reviewers; default is 2/3/4 by intensity.
- `constraints`: hard requirements as a string or string array.
- `context`: relevant files, repo facts, prior findings, or user preferences.
- `finalFormat`: requested shape for the synthesis.

Ultra-mode lanes request isolation explicitly (`isolation: "worktree"`), so
lane edits land in throwaway git worktrees — keep that unless the user
explicitly asks for shared in-place execution (ODW's default) and accepts the
risk. Worktree isolation needs the source to be a committed git repo. Stop or pause unexpected runs with
`odw stop <run_id>` or `odw pause <run_id>`.

## Serial Fallback

If no independent workers are available, simulate the structure deliberately:

1. Write the decomposition plan first: slices, perspectives, or domains.
2. Process each slice as an independent pass and avoid letting earlier
   conclusions bias later passes.
3. Run verification as separate passes, switching into skeptical perspectives.
4. Repeat discovery rounds until a round finds nothing new or the stated budget
   is nearly exhausted.
5. Disclose in the final answer that coverage and verification were done by
   serial multi-pass simulation, not by independent parallel workers.

## Final Responsibility

Worker outputs are raw material, not the final answer. Read them, resolve
conflicts, dedupe overlapping findings, decide what is actually true, and
synthesize one coherent answer. Do not end with a mere list of what each worker
said.
