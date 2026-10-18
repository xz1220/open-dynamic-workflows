export const meta = {
  name: 'parallel-nested',
  description: 'parallel() inside parallel(): each level keeps its own order and nulls.',
}

const groups = [['a1', 'a2'], ['b1', 'broken']]
return await parallel(
  groups.map((group) => () =>
    parallel(group.map((word) => () => agent(`Reply with exactly the text ${word} and nothing else.`, { label: word }))),
  ),
)
