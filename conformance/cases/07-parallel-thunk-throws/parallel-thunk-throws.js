export const meta = {
  name: 'parallel-thunk-throws',
  description: 'A thunk that throws is a null slot; parallel() itself resolves.',
}

const results = await parallel([
  () => agent('Reply with exactly the text one and nothing else.', { label: 'one' }),
  async () => {
    throw new Error('branch two failed')
  },
  () => agent('Reply with exactly the text three and nothing else.', { label: 'three' }),
])
return { results, resolved: true }
