export const meta = {
  name: 'parallel-order',
  description: 'parallel() resolves in input order, not completion order.',
}

const words = ['one', 'two', 'three']
return await parallel(words.map((word) => () => agent(`Reply with exactly the text ${word} and nothing else.`, { label: word })))
