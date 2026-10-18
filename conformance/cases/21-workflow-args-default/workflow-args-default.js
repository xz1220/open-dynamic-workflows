export const meta = {
  name: 'workflow-args-default',
  description: 'A child called without args gets null, not the parent input.',
}

return await workflow({ scriptPath: './child.js' })
