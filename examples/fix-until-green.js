// Have an agent fix a red test suite — and let odw, not the agent's word,
// decide whether it did.
//
// agent(…, { expect }) is an ODW extension (Claude Code ignores it): once the
// agent replies, odw runs the test command in the agent's workspace and checks
// that the agent changed a file. Work that misses goes back to the agent with
// the failing output appended to its prompt, up to expectRetries times; still
// red, the call fails with reason "unmet_expectation" and the list of what it
// missed, and this workflow reports that instead of passing "fixed it" along.
// Compare test-fix-loop.js, which runs the same loop by hand with exec().
//
// The fixer edits the source directory in place (the default workspace), so
// every check tests its changes. Point --source at the repository under test —
// a disposable copy if the agent must not touch your working tree:
//
//   odw run examples/fix-until-green.js --source path/to/repo \
//     --args '{"test": "npm test", "retries": 2}'

export const meta = {
  name: 'fix-until-green',
  description:
    'Have an agent fix a failing test suite; odw checks the fix with expect (the suite must exit 0, a file must change) and hands misses back.',
  whenToUse:
    'A repository whose test command fails and should pass. Pass {test?, retries?, timeout?}: test is a shell command string (default "npm test") or an argv array, retries is how often red work goes back to the agent (default 2), timeout is seconds per test run (default 600). ODW only: uses the expect extension.',
  phases: [{ title: 'Test' }, { title: 'Fix' }],
}

const test = (args && args.test) || 'npm test'
const retries = args && Number.isInteger(args.retries) ? args.retries : 2
const timeout = (args && Number(args.timeout)) || 600
const shown = Array.isArray(test) ? test.join(' ') : test

// Test runners print their summary and first failures last.
const tail = (text, max = 6000) => (text.length > max ? '…' + text.slice(-max) : text)

phase('Test')
const before = await exec(test, { label: 'tests', timeout })
if (before.exitCode === 0) {
  log('the tests already pass: nothing to fix')
  return { passed: true, fixed: false }
}

phase('Fix')
try {
  const summary = await agent(
    `The test command \`${shown}\` fails in your current working directory (exit ${before.exitCode}).\n\n` +
      `stdout (tail):\n${tail(before.stdout)}\n\nstderr (tail):\n${tail(before.stderr)}\n\n` +
      'Find the root cause and fix the code so that the tests pass. Edit the files in place; ' +
      'change a test only if the test itself is wrong. Reply with a short summary of what you changed.',
    {
      label: 'fixer',
      // Checked by odw once the agent replies (ODW extension): not "did you do it?".
      expect: { command: test, changes: true, timeout },
      expectRetries: retries,
    },
  )
  log('the tests pass')
  return { passed: true, fixed: true, summary }
} catch (err) {
  // reason "unmet_expectation": the suite stayed red, or nothing changed — misses say which.
  log(`the tests still fail: ${err.message}`)
  return { passed: false, fixed: false, reason: err.reason ?? null, misses: err.misses ?? [] }
}
