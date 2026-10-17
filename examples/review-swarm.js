export const meta = {
  name: 'review-swarm',
  description: 'Review a change set through several lenses in parallel, verify every finding independently, and keep only what survives.',
  whenToUse:
    'Pre-merge review of a diff or PR where you want breadth (many lenses) without the false positives. Pass {target?, lenses?, verifierAdapter?}.',
  phases: [{ title: 'Map' }, { title: 'Review' }, { title: 'Verify' }, { title: 'Summarize' }],
}

// Inputs (all optional):
//   target           what to review — default: the uncommitted changes (git diff HEAD)
//   lenses           review angles, one agent each
//   verifierAdapter  run verification on a different CLI than the reviewers (cross-vendor check)
const target = args?.target ?? 'the uncommitted changes in this repository (run `git diff HEAD` to see them)'
const lenses = args?.lenses ?? ['correctness', 'security', 'performance', 'readability', 'tests']
const verifyOpts = args?.verifierAdapter ? { adapter: args.verifierAdapter } : {}

const MAP = {
  type: 'object',
  required: ['summary', 'files'],
  properties: {
    summary: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
  },
}

const FINDINGS = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'severity', 'rationale'],
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'number' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          rationale: { type: 'string' },
        },
      },
    },
  },
}

const VERDICT = {
  type: 'object',
  required: ['real', 'reason'],
  properties: { real: { type: 'boolean' }, reason: { type: 'string' } },
}

phase('Map')
const map = await agent(
  `Map ${target}. Summarize what the change does and why, list every file it touches, and name the riskiest parts. Do not review yet.`,
  { schema: MAP, label: 'map' },
)

phase('Review')
const reviews = await parallel(
  lenses.map((lens) => () =>
    agent(
      `Review ${target} strictly through the lens of ${lens}. Context from a first pass:\n` +
        `${map.summary}\nFiles: ${map.files.join(', ')}\nRisks: ${(map.risks ?? []).join('; ')}\n\n` +
        `Report only concrete, verifiable problems (with file and line when you can). No style nits unless the lens is readability.`,
      { schema: FINDINGS, label: `review:${lens}` },
    ),
  ),
)

const findings = reviews.flatMap((r, i) => (r?.findings ?? []).map((f) => ({ ...f, lens: lenses[i] })))
log(`${findings.length} candidate findings from ${lenses.length} lenses`)

phase('Verify')
const verdicts = await pipeline(findings, (f) =>
  agent(
    `Independently check this code review finding against ${target}. Try to refute it; only call it real if you can confirm it in the code.\n\n` +
      `[${f.severity}] ${f.title}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : ''}\n${f.rationale}`,
    { schema: VERDICT, label: `verify:${f.lens}`, ...verifyOpts },
  ),
)

phase('Summarize')
const confirmed = findings
  .map((f, i) => ({ ...f, verdict: verdicts[i] }))
  .filter((f) => f.verdict?.real)
  .sort((a, b) => ['high', 'medium', 'low'].indexOf(a.severity) - ['high', 'medium', 'low'].indexOf(b.severity))
log(`${confirmed.length} of ${findings.length} findings survived verification`)

return {
  summary: map.summary,
  confirmed: confirmed.map(({ verdict, ...f }) => ({ ...f, evidence: verdict.reason })),
  rejected: findings.length - confirmed.length,
  lenses,
}
