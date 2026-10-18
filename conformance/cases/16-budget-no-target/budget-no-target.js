export const meta = {
  name: 'budget-no-target',
  description: 'Without a token target, budget.total is null and remaining() is Infinity.',
}

return { total: budget.total, spent: budget.spent(), remainingIsInfinity: budget.remaining() === Infinity }
