export const meta = {
  name: 'agent-text',
  description: 'agent() without a schema resolves to the reply text.',
}

const reply = await agent('Reply with exactly the text alpha and nothing else.', { label: 'a' })
return { reply, type: typeof reply }
