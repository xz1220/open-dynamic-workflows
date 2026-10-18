export const meta = {
  name: 'budget-estimate',
  description: 'spent() counts output tokens; without a usage report, characters / 4.',
}

await agent('Reply with exactly the text abcdefghijkl and nothing else.', { label: 'twelve' })
const first = budget.spent()
await agent('Reply with exactly the text wxyz and nothing else.', { label: 'four' })
return [first, budget.spent()]
