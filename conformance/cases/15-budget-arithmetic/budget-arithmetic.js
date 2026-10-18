export const meta = {
  name: 'budget-arithmetic',
  description: 'budget: total is the target, spent() grows, remaining() is what is left.',
}

const total = budget.total
const before = budget.spent()
const remainingBefore = budget.remaining()
await agent('Reply with exactly the text abcdefghijklmnopqrstuvwxyz and nothing else.', { label: 'spend' })
const after = budget.spent()
return {
  total,
  spentStartsAtZero: before === 0,
  remainingStartsAtTotal: remainingBefore === total,
  spentGrows: after > before,
  remainingIsTotalMinusSpent: budget.remaining() === Math.max(0, total - after),
}
