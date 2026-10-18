export const meta = {
  name: 'budget-exhausted',
  description: 'Once spent() reaches the target, the next agent() ends the run.',
}

await agent('Reply with exactly the text abcdefghijklmnop and nothing else.', { label: 'spend' })
try {
  await agent('Reply with exactly the text over and nothing else.', { label: 'over' })
} catch (err) {
  // ODW: a spent budget is fatal; catching it does not keep the run going.
}
return 'kept going'
