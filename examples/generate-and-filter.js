export const meta = {
  name: 'generate-and-filter',
  description: 'Generate many ideas in parallel, dedupe them, then keep only those that pass a rubric.',
  whenToUse:
    'Brainstorming where you want breadth first, then only the highest-quality, non-duplicate, rubric-passing ideas. Pass a bare topic string, or {topic, generators?, rubric?, threshold?, keep?} as args.',
  phases: [{ title: 'Generate' }, { title: 'Filter' }],
}

const IDEAS = {
  type: 'object',
  properties: {
    ideas: {
      type: 'array',
      minItems: 3,
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, pitch: { type: 'string' } },
        required: ['title'],
      },
    },
  },
  required: ['ideas'],
}

const GRADE = {
  type: 'object',
  properties: {
    score: { type: 'number' }, // 0..1 against the rubric
    verdict: { type: 'string', enum: ['keep', 'drop'] },
    reason: { type: 'string' },
  },
  required: ['score', 'verdict'],
}

const topic =
  typeof args === 'string' ? args : (args && args.topic) || 'Ways to cut cloud spend.'
const generators = (args && Number(args.generators)) || 4
const rubric =
  (args && args.rubric) ||
  'Novel, concrete, high-impact, and realistic to ship within a quarter.'
const threshold = (args && Number(args.threshold)) || 0.5
const keep = (args && Number(args.keep)) || 8

// Distinct lenses so the generators explore different parts of the space
// instead of all returning the same obvious ideas. Cycled by index.
const LENSES = [
  'the cheapest, fastest wins',
  'the contrarian / non-obvious angle',
  'what a 10x more ambitious team would do',
  'what removes the most work for the user',
]

// Phase 1 — fan out independent idea generators (barrier: we want the full set
// before we dedupe and grade).
phase('Generate')
log(`Generating ideas for "${topic}" from ${generators} angles`)
const batches = await parallel(
  Array.from({ length: generators }, (_, i) => () =>
    agent(
      `Brainstorm ideas about:\n${topic}\n\n` +
        `Approach this through the lens of: ${LENSES[i % LENSES.length]}.\n` +
        `Return several distinct ideas, each with a short pitch.`,
      { label: `gen-${i + 1}`, phase: 'Generate', schema: IDEAS }
    )
  )
)

// Dedupe in plain JS by normalized title.
const seen = new Set()
const unique = []
for (const batch of batches.filter(Boolean)) {
  for (const idea of batch.ideas || []) {
    const key = normalize(idea.title)
    if (!key || seen.has(key)) continue
    seen.add(key)
    unique.push(idea)
  }
}
log(`${unique.length} unique ideas; grading each against the rubric`)

// Phase 2 — pipeline: each unique idea streams into a grader as soon as it is
// ready. An idea survives only if the verdict is "keep" AND it clears the score
// threshold.
phase('Filter')
const graded = await pipeline(unique, (idea) =>
  agent(
    `Grade this idea against the rubric and return a 0..1 score plus keep/drop.\n\n` +
      `Rubric: ${rubric}\n\nIdea: ${idea.title}\n${idea.pitch || ''}`,
    { label: 'grade', phase: 'Filter', schema: GRADE }
  ).then((g) => ({ idea, grade: g }))
)

const survivors = graded
  .filter(Boolean)
  .filter((g) => g.grade && g.grade.verdict === 'keep' && Number(g.grade.score) >= threshold)
  .sort((a, b) => Number(b.grade.score) - Number(a.grade.score))
  .slice(0, keep)

return {
  topic,
  generated: batches.filter(Boolean).reduce((n, b) => n + (b.ideas ? b.ideas.length : 0), 0),
  unique: unique.length,
  kept: survivors.map((s) => ({ title: s.idea.title, pitch: s.idea.pitch, score: s.grade.score })),
  dropped: unique.length - survivors.length,
}

function normalize(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
