// Two rival CLIs hand code to each other through a shared on-disk directory.
// This ONLY works in inplace mode against a throwaway --source dir.
//
// odw.config.json (keys are FLAT/top-level — nesting under "settings" is
// silently ignored and you fall back to copy mode, where edits evaporate):
//   {
//     "defaultAdapter": "claude",
//     "workspaceMode": "inplace",
//     "adapters": {
//       "claude": {
//         "command": ["claude", "--print", "--dangerously-skip-permissions", "--no-session-persistence"],
//         "stdin": "{prompt}"
//       }
//     }
//   }
// The claude override lets the IMPLEMENTER run commands (self-test with node),
// not just edit files. Drop the adapters block to keep Claude write-only
// (acceptEdits). The codex checker can already run commands with no flag change.
// --dangerously-skip-permissions has NO sandbox: safe ONLY because --source is a
// throwaway dir; never point it at a real repo.
//
// Run (point --source at a scratch dir, NEVER your real repo — agents edit it):
//   mkdir -p /tmp/odw-cc-loop && cp odw.config.json /tmp/odw-cc-loop/
//   odw run examples/codex-claude-loop.js \
//     --source /tmp/odw-cc-loop --config /tmp/odw-cc-loop/odw.config.json --wait

export const meta = {
  name: 'codex-claude-loop',
  description:
    'Two rival CLIs in a turn-based loop: Claude Code implements, Codex reviews, repeat until Codex signs off.',
  whenToUse:
    'A coding task you want built by one agent and adversarially checked by another. REQUIRES workspaceMode "inplace" and a throwaway --source dir: the two agents hand code to each other through that shared directory on disk (Claude writes the file, Codex reads/runs the same file). Pass a bare task string, or {task, file?, maxRounds?}.',
  phases: [{ title: 'Implement' }, { title: 'Review' }],
}

// Codex's verdict. Kept to the schema subset odw actually validates: type/enum/
// required/additionalProperties only — no multi-type unions, required is explicit.
const REVIEW = {
  type: 'object',
  required: ['verdict', 'summary'],
  additionalProperties: false,
  properties: {
    verdict: { enum: ['pass', 'fail'] },
    summary: { type: 'string' },
    issue: { type: 'string' }, // optional: the concrete defect, when fail
    failing_case: { type: 'string' }, // optional: an input that breaks it
  },
}

const task =
  typeof args === 'string'
    ? args
    : (args && args.task) ||
      'Implement and module.exports a function compareVersions(a, b) in solution.js that ' +
        'compares two semantic-version strings "MAJOR.MINOR.PATCH" NUMERICALLY and returns ' +
        '-1 if a < b, 0 if equal, 1 if a > b. "1.2" and "1.2.0" must compare equal; ' +
        'leading/trailing whitespace is ignored. No dependencies.'
const file = (args && args.file) || 'solution.js'
const maxRounds = (args && Number(args.maxRounds)) || 3

// The shared workspace IS the inplace --source dir: Claude writes `file` there,
// Codex reads/runs the very same file. The only thing threaded through prompts is
// the review feedback — the code itself travels on disk between the two agents.
const transcript = []
let lastReview = null
let passed = false
let round = 0

while (round < maxRounds && !passed) {
  round++

  // Implementer — Claude Code. Round 1 builds from the task; later rounds fix
  // against Codex's last verdict.
  phase('Implement')
  const directive =
    round === 1
      ? `Implement the task below. Write your solution to \`${file}\` in your current working directory.`
      : `A reviewer rejected your \`${file}\`. Fix it so it passes.\n` +
        `Reviewer summary: ${lastReview.summary}\n` +
        `Issue: ${lastReview.issue || '(none given)'}\n` +
        `Failing case: ${lastReview.failing_case || '(none given)'}`
  const impl = await agent(
    `${directive}\n\nTASK:\n${task}\n\n` +
      `Work directly in your current directory — create or edit \`${file}\` in place. ` +
      `You MAY run it (e.g. \`node ${file}\`) to self-test before finishing. ` +
      `When finished, briefly summarize what you implemented or changed.`,
    { adapter: 'claude', label: `claude-impl-r${round}`, phase: 'Implement' }
  )
  log(`round ${round}: Claude implemented`)

  // Checker — Codex. Reads the file Claude just wrote (same dir on disk) and may
  // run it to probe edge cases, then returns a structured verdict.
  phase('Review')
  const review = await agent(
    `You are a strict, adversarial code reviewer. The implementer just wrote or updated ` +
      `\`${file}\` in your current working directory. Read it, and check it rigorously against ` +
      `the task. You MAY run it (e.g. \`node ${file}\`) to test tricky inputs. ` +
      `Return verdict "pass" only if it is fully correct; otherwise "fail" with a specific ` +
      `issue and a concrete failing input.\n\nTASK:\n${task}\n\nImplementer's note:\n${impl}`,
    { adapter: 'codex', label: `codex-review-r${round}`, phase: 'Review', schema: REVIEW }
  )
  lastReview = review
  transcript.push({ round, implementation: impl, review })

  if (review.verdict === 'pass') {
    passed = true
    log(`round ${round}: Codex PASSED — ${review.summary}`)
  } else {
    log(`round ${round}: Codex FAILED — ${review.issue || review.summary}`)
  }
}

return { task, file, rounds: transcript.length, passed, transcript }
