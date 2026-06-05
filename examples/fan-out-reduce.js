export const meta = {
  name: 'fan-out-reduce',
  description: 'Draft N answers in parallel, then synthesize the single best one.',
  whenToUse:
    'A question worth attacking from several independent angles before committing to one answer. Pass a bare question string, or {question, drafts?} as args.',
  phases: [{ title: 'Draft' }, { title: 'Synthesize' }],
}

const question =
  typeof args === 'string' ? args : (args && args.question) || 'Design a rate limiter.'
const n = (args && Number(args.drafts)) || 4

// Phase 1 — fan out N independent drafts (barrier: we need all of them).
phase('Draft')
log(`Drafting ${n} independent answers for: ${question}`)
const drafts = await parallel(
  Array.from({ length: n }, (_, i) => () =>
    agent(`Draft #${i + 1}. Answer this concisely and concretely:\n${question}`, {
      label: `draft-${i + 1}`,
      phase: 'Draft',
    })
  )
)

const good = drafts.filter(Boolean)
log(`${good.length}/${n} drafts succeeded; synthesizing.`)

// Phase 2 — reduce in plain JS, then one agent synthesizes the winner.
phase('Synthesize')
return await agent(
  `Synthesize the single best answer to the question from these independent drafts. ` +
    `Keep what is strong, drop what is weak, and resolve contradictions.\n\n` +
    `QUESTION:\n${question}\n\nDRAFTS:\n` +
    good.map((d, i) => `--- draft ${i + 1} ---\n${d}`).join('\n\n'),
  { label: 'synthesize', phase: 'Synthesize' }
)
