export const meta = {
  name: 'pipeline-stages',
  description: 'Each item runs through every stage; a stage gets (previous, item, index).',
}

const results = await pipeline(
  ['x', 'y', 'z'],
  (previous, item, index) => agent(`Reply with exactly the text ${previous}-${index} and nothing else.`, { label: item }),
  (draft, item, index) => ({ draft, item, index }),
  async (previous) => ({ ...previous, stages: 3 }),
)
// Sorted by index: the order pipeline() returns its results in is case 12.
return results.slice().sort((a, b) => a.index - b.index)
