export const meta = {
  name: 'script-syntax-error',
  description: 'A body that does not parse fails before anything runs.',
}

const ok = await agent('Reply with exactly the text never and nothing else.', { label: 'never' })
return { ok,
