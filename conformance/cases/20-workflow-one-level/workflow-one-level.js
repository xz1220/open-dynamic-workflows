export const meta = {
  name: 'workflow-one-level',
  description: 'workflow() from a child workflow is an error: one level only.',
}

await workflow({ scriptPath: './middle.js' })
return 'unreachable'
