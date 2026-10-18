export const meta = {
  name: 'log',
  description: 'log() emits progress lines in call order.',
}

log('starting')
const word = await agent('Reply with exactly the text gamma and nothing else.', { label: 'g' })
log(`got ${word}`)
log('done')
return word
