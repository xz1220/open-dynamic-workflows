export const meta = {
  name: 'parallel-not-thunks',
  description: 'parallel() takes functions; anything else is a script error.',
}

return await parallel(['not a function'])
