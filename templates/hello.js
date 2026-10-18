// The smallest useful workflow: two agents look at this repository side by
// side, and plain JavaScript keeps the answer it trusts more. Nothing is
// changed. Try it for $0 first — every agent gets a stub reply — then for real:
//
//   odw test hello          # the scripted cases in .odw/tests/hello.json
//   odw run hello --dry     # the live view and the phase tree, no model called
//   odw run hello           # the real run, on your default agent CLI

export const meta = {
  name: 'hello',
  description: 'Two agents describe this repository in parallel; the more confident answer wins.',
  whenToUse: 'A first run, to see the live view and the dashboard. Pass a topic string, or {topic}, to ask about something else.',
  phases: [{ title: 'Look' }, { title: 'Pick' }],
}

const topic = typeof args === 'string' ? args : (args && args.topic) || 'this repository'

const ANSWER = {
  type: 'object',
  required: ['summary', 'confidence'],
  properties: {
    summary: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
}

phase('Look')
const answers = await parallel(
  ['the README and docs', 'the source code'].map((where, i) => () =>
    agent(
      `In one or two sentences, say what ${topic} is for, judging from ${where}. ` +
        'Read what you need; change nothing. Rate your confidence from 0 to 1.',
      { label: `look:${i + 1}`, schema: ANSWER },
    ),
  ),
)

phase('Pick')
const good = answers.filter(Boolean)
if (good.length === 0) throw new Error('no agent answered')
const best = good.reduce((a, b) => (b.confidence > a.confidence ? b : a))
log(`${good.length} answers; kept the one at confidence ${best.confidence}`)
return { topic, summary: best.summary, confidence: best.confidence, answers: good.length }
