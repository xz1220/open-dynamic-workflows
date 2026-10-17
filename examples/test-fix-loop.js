// Run the test suite with exec(), hand the failures to an agent to fix, and
// re-run it — until the suite is green or the fix rounds run out.
//
// exec() is an ODW extension (Claude Code has no such global): this workflow
// runs on odw only. The fixer edits the source directory in place (the default
// workspace), so every re-run tests its changes. Point --source at the
// repository under test — a disposable copy if the agent must not touch your
// working tree:
//
//   odw run examples/test-fix-loop.js --source path/to/repo \
//     --args '{"test": "npm test", "maxRounds": 3}'

export const meta = {
  name: 'test-fix-loop',
  description:
    'Run the tests with exec(), have an agent fix the failures, and re-run until green or out of rounds.',
  whenToUse:
    'A repository whose test command fails and should pass. Pass {test?, maxRounds?, timeout?}: test is a shell command string (default "npm test") or an argv array, maxRounds caps the fix rounds (default 3), timeout is seconds per test run (default 600). ODW only: uses the exec() extension.',
  phases: [{ title: 'Test' }, { title: 'Fix' }],
}

const testCommand = (args && args.test) || 'npm test'
const maxRounds = (args && Number(args.maxRounds)) || 3
const timeout = (args && Number(args.timeout)) || 600
const shown = Array.isArray(testCommand) ? testCommand.join(' ') : testCommand

// Test runners print their summary and first failures last: hand the fixer
// the end of each stream, not megabytes of passing output.
const tail = (text, max = 6000) => (text.length > max ? '…' + text.slice(-max) : text)
const verdict = (run) => (run.timedOut ? `timed out after ${timeout}s` : `exit ${run.exitCode}`)

phase('Test')
let run = await exec(testCommand, { label: 'tests', timeout })
const history = [{ round: 0, result: verdict(run), durationMs: run.durationMs }]

let round = 0
while (run.exitCode !== 0 && round < maxRounds) {
  round++
  log(`round ${round}: the tests fail (${verdict(run)}); asking an agent to fix them`)

  phase('Fix')
  const summary = await agent(
    `The test command \`${shown}\` fails in your current working directory (${verdict(run)}).\n\n` +
      `stdout (tail):\n${tail(run.stdout)}\n\nstderr (tail):\n${tail(run.stderr)}\n\n` +
      'Find the root cause and fix the code so that the tests pass. Edit the files in place; ' +
      'change a test only if the test itself is wrong. Reply with a short summary of what you changed.',
    { label: `fix r${round}`, phase: 'Fix' },
  )

  phase('Test')
  run = await exec(testCommand, { label: `tests r${round}`, timeout })
  history.push({ round, result: verdict(run), durationMs: run.durationMs, fix: summary })
}

const passed = run.exitCode === 0
log(passed ? `the tests pass after ${round} fix round(s)` : `the tests still fail after ${round} fix round(s)`)
return { passed, rounds: round, history }
