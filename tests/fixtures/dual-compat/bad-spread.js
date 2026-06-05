const base = { name: 'bad-spread' }
export const meta = {
  ...base,
  description: 'uses a spread, which a static reader cannot resolve',
}
return 1
