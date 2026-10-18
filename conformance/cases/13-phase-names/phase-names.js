export const meta = {
  name: 'phase-names',
  description: 'phase() names the agents that follow; opts.phase names one call.',
  phases: [{ title: 'Draft' }, { title: 'Review' }, { title: 'Verify' }],
}

phase('Draft')
const draft = await agent('Reply with exactly the text draft and nothing else.', { label: 'drafter' })
phase('Review')
const review = await agent('Reply with exactly the text review and nothing else.', { label: 'reviewer' })
const verify = await agent('Reply with exactly the text verify and nothing else.', { label: 'verifier', phase: 'Verify' })
const after = await agent('Reply with exactly the text after and nothing else.', { label: 'after' })
return [draft, review, verify, after]
