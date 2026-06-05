export const meta = {
  name: 'tournament',
  description: 'Have N agents attempt the same task with different approaches, then judge them pairwise until one wins.',
  whenToUse:
    'A task with a wide solution space where the best approach is unknown and head-to-head comparison beats a single shot. Pass a bare task string, or {task, approaches?} as args.',
  phases: [{ title: 'Compete' }, { title: 'Judge' }],
}

const JUDGE = {
  type: 'object',
  properties: {
    winner: { type: 'string', enum: ['A', 'B'] },
    reason: { type: 'string' },
  },
  required: ['winner'],
}

const task =
  typeof args === 'string' ? args : (args && args.task) || 'Design a URL shortener.'
// Each approach becomes one competitor. Distinct strategies, not just N copies.
const DEFAULT_APPROACHES = [
  'optimize for simplicity — the smallest thing that works',
  'optimize for scale — assume 100x traffic from day one',
  'optimize for safety — correctness, edge cases, and failure modes first',
  'optimize for speed to ship — what a startup builds this week',
]
const approaches =
  args && Array.isArray(args.approaches) && args.approaches.length
    ? args.approaches
    : DEFAULT_APPROACHES

// Phase 1 — every competitor attacks the same task from its own angle
// (barrier: the bracket needs all contenders before any match can run).
phase('Compete')
log(`${approaches.length} competitors attempting the task`)
const solutions = await parallel(
  approaches.map((approach, i) => () =>
    agent(`Attempt this task. Your strategy: ${approach}.\n\nTask:\n${task}`, {
      label: `compete-${i + 1}`,
      phase: 'Compete',
    }).then((solution) => ({ seed: i, approach, solution }))
  )
)

// Phase 2 — single-elimination bracket. Each round pairs survivors and judges
// every match in parallel; winners advance until one remains.
phase('Judge')
let entrants = solutions.filter(Boolean)
if (entrants.length === 0) return { task, error: 'no_solutions' }

const rounds = []
let roundNo = 0
while (entrants.length > 1) {
  roundNo++
  const pairs = []
  for (let i = 0; i < entrants.length; i += 2) {
    pairs.push([entrants[i], entrants[i + 1] || null])
  }
  log(`round ${roundNo}: ${pairs.length} match(es)`)
  const outcomes = await parallel(
    pairs.map((pair, i) => () => judgeMatch(pair[0], pair[1], roundNo, i))
  )
  const advancing = []
  const matches = []
  for (let i = 0; i < pairs.length; i++) {
    const [a, b] = pairs[i]
    if (!b) {
      advancing.push(a) // odd one out gets a bye
      matches.push({ a: a.seed, b: null, winner: a.seed, reason: 'bye' })
      continue
    }
    const out = outcomes[i]
    const winner = out && out.winner === 'B' ? b : a
    advancing.push(winner)
    matches.push({ a: a.seed, b: b.seed, winner: winner.seed, reason: (out && out.reason) || '' })
  }
  rounds.push({ round: roundNo, matches })
  entrants = advancing
}

const champion = entrants[0]
return {
  task,
  winner: { seed: champion.seed, approach: champion.approach, solution: champion.solution },
  rounds,
  competitors: solutions.filter(Boolean).map((s) => ({ seed: s.seed, approach: s.approach })),
}

// One head-to-head match: an independent judge picks A or B against the task.
function judgeMatch(a, b, round, index) {
  return agent(
    `You are an impartial judge in a tournament. Pick the better solution to the task.\n\n` +
      `Task:\n${task}\n\n` +
      `Solution A (${a.approach}):\n${a.solution}\n\n` +
      `Solution B (${b.approach}):\n${b.solution}\n\n` +
      `Reply with the winner ("A" or "B") and a one-line reason.`,
    { label: `judge-r${round}-${index + 1}`, phase: 'Judge', schema: JUDGE }
  )
}
