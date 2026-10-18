export const meta = {
  name: 'middle',
  description: 'A child that tries to nest another workflow.',
}

log('middle started')
return await workflow({ scriptPath: './leaf.js' })
