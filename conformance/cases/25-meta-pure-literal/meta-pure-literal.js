export const meta = {
  // A pure literal may have comments, quoted keys, nested arrays and trailing commas.
  name: 'meta-pure-literal',
  "description": 'meta is a pure literal: read without running the body.',
  whenToUse: `a template literal without interpolation is fine`,
  phases: [
    { title: 'Only', detail: 'one phase' },
  ],
}

return 'loaded'
