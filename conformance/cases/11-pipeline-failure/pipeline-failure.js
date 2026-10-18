export const meta = {
  name: 'pipeline-failure',
  description: 'A stage that fails drops its item to null and skips its later stages.',
}

const reachedLast = []
const results = await pipeline(
  ['ok-1', 'broken', 'ok-2', 'thrown'],
  (item) => agent(`Reply with exactly the text ${item} and nothing else.`, { label: item }),
  (reply, item) => {
    if (item === 'thrown') throw new Error('stage two refused')
    return reply.toUpperCase()
  },
  (upper, item) => {
    reachedLast.push(item)
    return upper
  },
)
return {
  length: results.length,
  nulls: results.filter((r) => r === null).length,
  kept: results.filter((r) => r !== null).sort(),
  lastStageSaw: reachedLast.sort(),
}
