export const meta = {
  name: 'deep-research',
  description: 'Fan-out web research with adversarial fact-checking and a cited synthesis report',
  whenToUse:
    'Deep, multi-source, fact-checked research on a topic. Pass the research question as args ' +
    '(a string, or {question, maxAngles?, sourcesPerAngle?}). Returns a cited Markdown report.',
  phases: [
    { title: 'Plan', detail: 'decompose the question into distinct search angles' },
    { title: 'Gather', detail: 'search the web + fetch sources + extract cited claims per angle' },
    { title: 'Verify', detail: 'adversarially fact-check key claims from multiple lenses' },
    { title: 'Synthesize', detail: 'write a cited Markdown report from verified evidence' },
    { title: 'Critique', detail: 'completeness pass — surface gaps and follow-ups' },
  ],
}

// ---------------------------------------------------------------------------
// Schemas — each agent returns validated structured data (no parsing needed).
// ---------------------------------------------------------------------------

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    interpretation: { type: 'string', description: 'Restated question + scope/assumptions' },
    angles: {
      type: 'array',
      description: 'Distinct, non-overlapping research angles',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'short kebab-case id' },
          question: { type: 'string' },
          searchQueries: { type: 'array', items: { type: 'string' } },
          rationale: { type: 'string' },
        },
        required: ['key', 'question', 'searchQueries'],
      },
    },
  },
  required: ['interpretation', 'angles'],
}

const SOURCES_SCHEMA = {
  type: 'object',
  properties: {
    sources: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
          snippet: { type: 'string' },
          relevance: { type: 'number', description: '0-1 relevance to the angle' },
        },
        required: ['url', 'title'],
      },
    },
  },
  required: ['sources'],
}

const CLAIMS_SCHEMA = {
  type: 'object',
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          statement: { type: 'string' },
          evidence: { type: 'string', description: 'verbatim or close paraphrase supporting the claim' },
          sourceUrl: { type: 'string' },
          sourceTitle: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          importance: { type: 'string', enum: ['key', 'supporting', 'minor'] },
        },
        required: ['statement', 'sourceUrl'],
      },
    },
  },
  required: ['claims'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean', description: 'true if the claim could NOT be independently supported' },
    assessment: { type: 'string' },
    correction: { type: 'string', description: 'corrected statement if the claim is wrong/partial' },
    supportingUrls: { type: 'array', items: { type: 'string' } },
  },
  required: ['refuted', 'assessment'],
}

const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string', description: 'executive summary, 2-4 sentences' },
    markdown: {
      type: 'string',
      description: 'full report in Markdown with inline [n] citations and a Sources section',
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['title', 'summary', 'markdown'],
}

const CRITIQUE_SCHEMA = {
  type: 'object',
  properties: {
    gaps: { type: 'array', items: { type: 'string' } },
    unverifiedClaims: { type: 'array', items: { type: 'string' } },
    suggestedFollowups: { type: 'array', items: { type: 'string' } },
    overallConfidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['gaps'],
}

// ---------------------------------------------------------------------------
// Inputs — accept a plain string or an options object.
// ---------------------------------------------------------------------------

const question =
  typeof args === 'string'
    ? args.trim()
    : args && typeof args.question === 'string'
      ? args.question.trim()
      : ''

if (!question) {
  log('No research question provided. Invoke with args: "your question" or {question: "..."}.')
  return { error: 'missing_question' }
}

// Scale depth to the token budget when the user set one (a "+Nk" directive); else use defaults.
const optMaxAngles = args && Number(args.maxAngles)
const MAX_ANGLES = optMaxAngles
  ? Math.max(3, Math.min(8, optMaxAngles))
  : budget.total
    ? Math.min(8, Math.max(4, Math.floor(budget.total / 120_000)))
    : 5
const SOURCES_PER_ANGLE = args && Number(args.sourcesPerAngle) ? Number(args.sourcesPerAngle) : 4
const VERIFY_LENSES = ['primary-source check', 'recency & currency', 'contradicting evidence']

// ---------------------------------------------------------------------------
// Phase 1 — Plan: decompose the question into diverse research angles.
// ---------------------------------------------------------------------------

phase('Plan')
log(`Planning up to ${MAX_ANGLES} research angles for: ${question}`)

const plan = await agent(
  `You are a research lead. Decompose this research question into distinct, non-overlapping angles ` +
    `for a deep, multi-source investigation.\n\n` +
    `RESEARCH QUESTION:\n${question}\n\n` +
    `Produce ${MAX_ANGLES} angles that together give comprehensive coverage. Diversify by modality: ` +
    `fundamentals/definitions, key players & entities, recent developments (time-based), ` +
    `data & numbers, counterarguments/risks, and comparisons. For each angle, give 2-3 concrete ` +
    `web search queries. First restate your interpretation of the question and its scope.`,
  { label: 'plan', schema: PLAN_SCHEMA }
)

const angles = (plan.angles || []).slice(0, MAX_ANGLES)
log(`${angles.length} angles planned.`)

// ---------------------------------------------------------------------------
// Phase 2 — Gather: per angle, search → fetch+extract. Pipelined (no barrier):
// one angle can be extracting while another is still searching.
// ---------------------------------------------------------------------------

phase('Gather')
const gathered = await pipeline(
  angles,
  // Stage 1: find the best sources for this angle via web search.
  (angle) =>
    agent(
      `You are a research scout. Use the WebSearch tool to find the best sources for this angle. ` +
        `Run several searches, prefer authoritative / primary sources, and avoid low-quality SEO spam.\n\n` +
        `ANGLE: ${angle.question}\n` +
        `SUGGESTED QUERIES: ${(angle.searchQueries || []).join(' | ')}\n\n` +
        `Return the top ${SOURCES_PER_ANGLE} most relevant sources with url, title, a short snippet, ` +
        `and a relevance score (0-1).`,
      { label: `search:${angle.key}`, phase: 'Gather', schema: SOURCES_SCHEMA }
    ),
  // Stage 2: fetch the top sources and extract verifiable, cited claims.
  (found, angle) =>
    agent(
      `You are a research analyst. Fetch the most relevant of these sources with the WebFetch tool and ` +
        `extract concrete, verifiable claims relevant to the angle. EVERY claim must cite the source URL ` +
        `it came from. Mark importance (key/supporting/minor) and your confidence. Do not invent claims.\n\n` +
        `ANGLE: ${angle.question}\n\n` +
        `SOURCES (fetch the top ${SOURCES_PER_ANGLE}):\n` +
        (found.sources || []).map((s, i) => `${i + 1}. ${s.title} — ${s.url}`).join('\n'),
      { label: `extract:${angle.key}`, phase: 'Gather', schema: CLAIMS_SCHEMA }
    )
)

// Barrier-justified merge: dedupe across ALL claims before the expensive verify pass.
const allClaims = gathered.filter(Boolean).flatMap((g) => g.claims || [])
log(`${allClaims.length} claims gathered across angles.`)

const seen = new Set()
const keyClaims = []
for (const c of allClaims) {
  const norm = (c.statement || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 140)
  if (!norm || seen.has(norm)) continue
  seen.add(norm)
  // Verify the load-bearing claims and anything the analyst flagged as shaky.
  if (c.importance === 'key' || c.confidence === 'low') keyClaims.push(c)
}
log(`${keyClaims.length} key/uncertain claims selected for adversarial verification.`)

// ---------------------------------------------------------------------------
// Phase 3 — Verify: each key claim is attacked from multiple independent lenses.
// A claim survives only if a majority of lenses fail to refute it.
// ---------------------------------------------------------------------------

phase('Verify')
const verifications = await parallel(
  keyClaims.map((claim) => () =>
    parallel(
      VERIFY_LENSES.map((lens) => () =>
        agent(
          `You are a skeptical fact-checker. Try to REFUTE the claim below using INDEPENDENT web ` +
            `research (WebSearch/WebFetch) through this lens: "${lens}". Do not rely on the original ` +
            `source. Default to refuted=true if you cannot find solid independent support. Be specific ` +
            `about what you found and cite supporting URLs.\n\n` +
            `CLAIM: ${claim.statement}\n` +
            `ORIGINAL SOURCE: ${claim.sourceUrl}`,
          { label: `verify:${lens}`, phase: 'Verify', schema: VERDICT_SCHEMA }
        )
      )
    ).then((votes) => {
      const valid = votes.filter(Boolean)
      const refutedCount = valid.filter((v) => v.refuted).length
      return {
        claim,
        verdicts: valid,
        supported: valid.length > 0 && refutedCount < Math.ceil(valid.length / 2),
        corrections: valid.map((v) => v.correction).filter(Boolean),
      }
    })
  )
)

const checked = verifications.filter(Boolean)
const supported = checked.filter((v) => v.supported)
const disputed = checked.filter((v) => !v.supported)
log(`Verification done: ${supported.length} supported, ${disputed.length} disputed/uncertain.`)

// ---------------------------------------------------------------------------
// Phase 4 — Synthesize: write a cited report using only verified evidence.
// ---------------------------------------------------------------------------

phase('Synthesize')
const evidence = {
  supportedKeyClaims: supported.map((v) => ({
    statement: v.claim.statement,
    source: v.claim.sourceUrl,
    corrections: v.corrections,
  })),
  disputedKeyClaims: disputed.map((v) => ({
    statement: v.claim.statement,
    source: v.claim.sourceUrl,
    corrections: v.corrections,
  })),
  supportingClaims: allClaims
    .filter((c) => c.importance !== 'key')
    .map((c) => ({ statement: c.statement, source: c.sourceUrl })),
}

const report = await agent(
  `You are a research writer. Write a rigorous, well-structured research report in Markdown that ` +
    `answers the question. Use ONLY the verified evidence below. Use inline numbered citations [1], [2], … ` +
    `and end with a "## Sources" section mapping each number to its URL. Clearly flag disputed/uncertain ` +
    `points and state your overall confidence. Never invent facts or sources.\n\n` +
    `QUESTION:\n${question}\n\n` +
    `INTERPRETATION:\n${plan.interpretation || ''}\n\n` +
    `EVIDENCE (JSON):\n${JSON.stringify(evidence, null, 2)}`,
  { label: 'synthesize', schema: REPORT_SCHEMA }
)

// ---------------------------------------------------------------------------
// Phase 5 — Critique: completeness pass for gaps and follow-ups.
// ---------------------------------------------------------------------------

phase('Critique')
const critique = await agent(
  `You are a research editor doing a completeness pass. Given the question and the draft report, ` +
    `identify what is missing: unaddressed sub-questions, claims that remain unverified, missing recent ` +
    `developments, and concrete follow-up searches that would strengthen it.\n\n` +
    `QUESTION:\n${question}\n\nREPORT:\n${report.markdown}`,
  { label: 'critique', schema: CRITIQUE_SCHEMA }
)

return {
  question,
  interpretation: plan.interpretation,
  report,
  verification: { supported: supported.length, disputed: disputed.length },
  critique,
  stats: { angles: angles.length, claims: allClaims.length, keyClaims: keyClaims.length },
}
