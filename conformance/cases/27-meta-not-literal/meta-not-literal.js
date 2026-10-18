const NAME = 'meta-not-literal'
export const meta = {
  name: NAME,
  description: 'meta refers to a variable, so it is not a pure literal.',
}

return await agent('Reply with exactly the text never and nothing else.', { label: 'never' })
