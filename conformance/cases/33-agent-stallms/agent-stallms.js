export const meta = {
  name: 'agent-stallms',
  description: 'agent(prompt, { stallMs }) sets that one agent’s stall window; an agent quiet for longer fails.',
}

const patient = await agent('Reply with exactly the text alpha and nothing else.', { label: 'patient', stallMs: 1800000 })
let quiet = null
try {
  await agent('Reply with exactly the text late and nothing else.', { label: 'quiet', stallMs: 400 })
  quiet = 'replied'
} catch (err) {
  quiet = err instanceof Error ? 'failed' : 'threw a non-Error'
}
return { patient, quiet }
