export const meta = {
  name: 'pipeline-order',
  description: 'pipeline() returns its results in item order, not completion order.',
}

return await pipeline(
  ['slow', 'fast'],
  (item) => agent(`Reply with exactly the text ${item} and nothing else.`, { label: item }),
  (reply, item, index) => `${index}:${reply}`,
)
