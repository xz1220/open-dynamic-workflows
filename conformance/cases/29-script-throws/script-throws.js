export const meta = {
  name: 'script-throws',
  description: 'An uncaught throw in the body fails the run with its message.',
}

const word = await agent('Reply with exactly the text epsilon and nothing else.', { label: 'first' })
throw new Error('conformance: boom after ' + word)
