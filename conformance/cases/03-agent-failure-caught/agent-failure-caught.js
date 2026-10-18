export const meta = {
  name: 'agent-failure-caught',
  description: 'A failed agent() rejects; try/catch recovers and the run goes on.',
}

let caught = null
try {
  await agent('Reply with exactly the text broken and nothing else.', { label: 'broken' })
  caught = false
} catch (err) {
  caught = { isError: err instanceof Error, hasMessage: typeof err.message === 'string' && err.message.length > 0 }
}
const after = await agent('Reply with exactly the text beta and nothing else.', { label: 'after' })
return { caught, after }
