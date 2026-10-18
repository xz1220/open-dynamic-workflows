export const meta = {
  name: 'args-absent',
  description: 'Without an input, args is null.',
}

return { args: args === undefined ? 'undefined' : args }
