export const meta = {
  name: 'routing',
  description: 'Classify the request, route it to the matching specialist, then grade the result.',
  whenToUse:
    'A request whose right handling depends on its type (bug vs feature vs question, language, or domain). Pass a bare request string, or {request, routes?} as args.',
  phases: [{ title: 'Classify' }, { title: 'Handle' }, { title: 'Grade' }],
}

// Default routes. Each one is a category the classifier can pick plus the
// specialist prompt that handles it. Override with args.routes to re-target.
const DEFAULT_ROUTES = [
  {
    key: 'bug',
    when: 'something is broken, an error, a crash, or wrong behavior',
    prompt:
      'You are a debugging specialist. Diagnose the most likely root cause and propose a minimal, targeted fix. Be concrete.',
  },
  {
    key: 'feature',
    when: 'a request to build, add, or change functionality',
    prompt:
      'You are a senior engineer. Propose a concrete implementation plan: the approach, the main steps, and the key risks.',
  },
  {
    key: 'question',
    when: 'a question seeking an explanation, comparison, or recommendation',
    prompt:
      'You are a domain expert. Answer directly and correctly, then add the one caveat that matters most.',
  },
]

const GRADE = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['accept', 'revise', 'reject'] },
    score: { type: 'number' },
    notes: { type: 'string' },
  },
  required: ['verdict'],
}

const request =
  typeof args === 'string'
    ? args
    : (args && args.request) || 'The login page returns a 500 after the latest deploy.'
const routes =
  args && Array.isArray(args.routes) && args.routes.length ? args.routes : DEFAULT_ROUTES

// The classifier is constrained to the known route keys via an enum, so its
// answer always maps to exactly one handler (or we fall back to the first).
const CLASSIFY = {
  type: 'object',
  properties: {
    category: { type: 'string', enum: routes.map((r) => r.key) },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reason: { type: 'string' },
  },
  required: ['category'],
}

// Phase 1 — one agent decides which specialist should handle the request.
phase('Classify')
log(`Classifying request across ${routes.length} routes`)
const classification = await agent(
  `Classify this request into exactly one category, then explain why.\n\n` +
    `Categories:\n${routes.map((r) => `- ${r.key}: ${r.when}`).join('\n')}\n\n` +
    `Request:\n${request}`,
  { label: 'classify', phase: 'Classify', schema: CLASSIFY }
)

const chosen = routes.find((r) => r.key === classification.category) || routes[0]
log(`Routed to "${chosen.key}"`)

// Phase 2 — the matching specialist handles the request.
phase('Handle')
const output = await agent(`${chosen.prompt}\n\nRequest:\n${request}`, {
  label: `handle:${chosen.key}`,
  phase: 'Handle',
})

// Phase 3 — classify the OUTPUT: grade it against the route so a caller can
// decide whether to ship, revise, or re-route.
phase('Grade')
const grade = await agent(
  `Grade this ${chosen.key} response for correctness and usefulness. ` +
    `Reply "accept" if it stands on its own, "revise" if close, "reject" if wrong.\n\n` +
    `Request:\n${request}\n\nResponse:\n${output}`,
  { label: 'grade', phase: 'Grade', schema: GRADE }
)

return { request, category: chosen.key, classification, output, grade }
