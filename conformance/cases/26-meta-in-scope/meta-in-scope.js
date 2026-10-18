export const meta = {
  name: 'meta-in-scope',
  description: 'The body can read its own meta.',
  phases: [{ title: 'First' }, { title: 'Second' }],
}

return { name: meta.name, phases: meta.phases.map((p) => p.title) }
