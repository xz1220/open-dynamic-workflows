export const meta = {
  name: 'agent-schema',
  description: 'agent() with a schema resolves to the validated value, not text.',
}

const VERDICT = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    score: { type: 'integer' },
    tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'score', 'tags'],
}
const value = await agent('Return exactly this structured output: {"verdict": "pass", "score": 3, "tags": ["x", "y"]}', {
  schema: VERDICT,
  label: 'judge',
})
return { value, type: typeof value, tagsIsArray: Array.isArray(value.tags) }
