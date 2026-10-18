export const meta = {
  name: 'parallel-agent-fails',
  description: 'An agent that fails inside parallel() is a null slot.',
}

return await parallel([
  () => agent('Reply with exactly the text one and nothing else.', { label: 'one' }),
  () => agent('Reply with exactly the text broken and nothing else.', { label: 'broken' }),
])
