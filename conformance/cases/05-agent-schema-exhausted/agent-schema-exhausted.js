export const meta = {
  name: 'agent-schema-exhausted',
  description: 'A reply that never matches its schema makes agent() reject.',
}

const SHAPE = { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] }
try {
  await agent('Return exactly this structured output: {"n": 1}', { schema: SHAPE, label: 'shape' })
  return { caught: false }
} catch (err) {
  return { caught: err instanceof Error }
}
