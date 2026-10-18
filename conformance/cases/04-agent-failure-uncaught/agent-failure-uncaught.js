export const meta = {
  name: 'agent-failure-uncaught',
  description: 'A failed agent() that nothing catches fails the run.',
}

const first = await agent('Reply with exactly the text broken and nothing else.', { label: 'broken' })
await agent('Reply with exactly the text never and nothing else. ' + first, { label: 'never' })
return 'unreachable'
