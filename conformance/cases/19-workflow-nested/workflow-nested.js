export const meta = {
  name: 'workflow-nested',
  description: 'workflow() runs another workflow inline and resolves to its value.',
}

const child = await workflow({ scriptPath: './child.js' }, { word: 'delta' })
return { child }
