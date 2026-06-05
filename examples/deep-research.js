export const meta = {
  name: 'deep-research',
  description:
    'Fan-out web research workflow that cross-checks cited claims by vote and returns a sourced report.',
  whenToUse:
    'Use for research questions that need multiple web searches, source fetching, adversarial verification, and a final Markdown report with citations. Requires the underlying agent adapter to have WebSearch/WebFetch tools.',
  phases: [
    { title: 'Plan', detail: 'split the question into independent research angles' },
    { title: 'Search', detail: 'fan out web searches from each angle' },
    { title: 'Extract', detail: 'fetch sources and extract concrete cited claims' },
    { title: 'Vote', detail: 'cross-check each important claim from several skeptical lenses' },
    { title: 'Report', detail: 'synthesize only the claims that survived verification' },
  ],
}

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    scope: { type: 'string' },
    assumptions: { type: 'array', items: { type: 'string' } },
    angles: {
      type: 'array',
      minItems: 3,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          question: { type: 'string' },
          searchQueries: { type: 'array', minItems: 2, items: { type: 'string' } },
          whyItMatters: { type: 'string' },
        },
        required: ['id', 'question', 'searchQueries'],
      },
    },
  },
  required: ['scope', 'angles'],
}

const SEARCH_SCHEMA = {
  type: 'object',
  properties: {
    sources: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          url: { type: 'string' },
          publisher: { type: 'string' },
          date: { type: 'string' },
          snippet: { type: 'string' },
          sourceType: {
            type: 'string',
            enum: ['primary', 'official', 'academic', 'news', 'analysis', 'other'],
          },
          relevance: { type: 'number' },
        },
        required: ['title', 'url'],
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
          sourceUrl: { type: 'string' },
          sourceTitle: { type: 'string' },
          evidence: { type: 'string' },
          importance: { type: 'string', enum: ['key', 'supporting', 'minor'] },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['statement', 'sourceUrl'],
      },
    },
  },
  required: ['claims'],
}

const VOTE_SCHEMA = {
  type: 'object',
  properties: {
    vote: { type: 'string', enum: ['supported', 'refuted', 'uncertain'] },
    rationale: { type: 'string' },
    correction: { type: 'string' },
    supportingUrls: { type: 'array', items: { type: 'string' } },
    contradictingUrls: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number' },
  },
  required: ['vote', 'rationale', 'supportingUrls', 'contradictingUrls'],
}

const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    answer: { type: 'string' },
    markdown: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    remainingUncertainty: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'answer', 'markdown', 'confidence'],
}

const question =
  typeof args === 'string'
    ? args.trim()
    : args && typeof args.question === 'string'
      ? args.question.trim()
      : ''

if (!question) {
  log('Missing research question. Pass a string or { "question": "..." }.')
  return { error: 'missing_question' }
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
const numberArg = (name, fallback) => {
  const raw = args && typeof args === 'object' ? Number(args[name]) : NaN
  return Number.isFinite(raw) ? raw : fallback
}
const integerArg = (name, fallback) => Math.floor(numberArg(name, fallback))

const budgetAngles = budget.total ? Math.floor(budget.total / 120000) : 4
const MAX_ANGLES = clamp(integerArg('maxAngles', budgetAngles), 3, 8)
const SOURCES_PER_ANGLE = clamp(integerArg('sourcesPerAngle', 4), 2, 8)
const CLAIMS_PER_ANGLE = clamp(integerArg('claimsPerAngle', 6), 3, 12)
const MAX_CLAIMS_TO_VERIFY = clamp(integerArg('maxClaimsToVerify', MAX_ANGLES * 4), 4, 32)
const VOTING_LENSES = [
  'independent corroboration from a different source',
  'primary or official source check',
  'contradiction search and counter-evidence',
  'date, recency, and changed-context check',
]

phase('Plan')
log(`Planning ${MAX_ANGLES} research angles for: ${question}`)

const plan = await agent(
  `You are the lead researcher for a deep-research workflow.

Question:
${question}

Create up to ${MAX_ANGLES} independent research angles. Make them non-overlapping and collectively useful.
For each angle, include 2-4 concrete WebSearch queries. Prefer angles that force different evidence paths:
definitions/background, primary entities, data and numbers, recent changes, disagreement, risks, and comparisons.`,
  { label: 'plan', phase: 'Plan', schema: PLAN_SCHEMA },
)

const angles = (plan.angles || []).slice(0, MAX_ANGLES)
if (angles.length === 0) {
  return { error: 'no_angles', question, plan }
}

phase('Search')
log(`Searching from ${angles.length} angles.`)

const searchResults = await parallel(
  angles.map((angle) => () =>
    agent(
      `Use WebSearch to find high-quality sources for this research angle.

Main question:
${question}

Angle:
${angle.question}

Suggested searches:
${(angle.searchQueries || []).map((q) => `- ${q}`).join('\n')}

Return the best ${SOURCES_PER_ANGLE} sources. Prefer primary, official, academic, reputable news, or expert analysis.
Avoid thin SEO pages, duplicate syndications, and sources that do not directly support the angle.`,
      { label: `search:${angle.id}`, phase: 'Search', schema: SEARCH_SCHEMA },
    )
  ),
)

phase('Extract')
log('Fetching sources and extracting cited claims.')

const extracted = await parallel(
  angles.map((angle, index) => () => {
    const found = searchResults[index]
    const sources = (found && found.sources ? found.sources : []).slice(0, SOURCES_PER_ANGLE)
    return agent(
      `Use WebFetch on the sources below and extract concrete, checkable claims.

Main question:
${question}

Angle:
${angle.question}

Sources:
${sources.map((s, i) => `${i + 1}. ${s.title} - ${s.url}`).join('\n')}

Return up to ${CLAIMS_PER_ANGLE} claims. Every claim must have a sourceUrl. Favor specific claims with dates,
numbers, named entities, or causal assertions. Do not include claims that are only opinion or cannot be checked.`,
      { label: `extract:${angle.id}`, phase: 'Extract', schema: CLAIMS_SCHEMA },
    )
  }),
)

const sourceByUrl = new Map()
for (const found of searchResults.filter(Boolean)) {
  for (const source of found.sources || []) {
    if (source.url && !sourceByUrl.has(source.url)) sourceByUrl.set(source.url, source)
  }
}

const allClaims = []
const seenClaims = new Set()
for (const batch of extracted.filter(Boolean)) {
  for (const claim of batch.claims || []) {
    const key = normalizeClaim(claim.statement)
    if (!key || seenClaims.has(key)) continue
    seenClaims.add(key)
    allClaims.push(claim)
  }
}

const claimsToVerify = allClaims
  .filter((claim) => claim.importance === 'key' || claim.confidence !== 'high')
  .slice(0, MAX_CLAIMS_TO_VERIFY)

log(`${allClaims.length} unique claims extracted; ${claimsToVerify.length} selected for voting.`)

phase('Vote')
const votedClaims = await parallel(
  claimsToVerify.map((claim, claimIndex) => () =>
    parallel(
      VOTING_LENSES.map((lens) => () =>
        agent(
          `You are one voter in a deep-research verification panel.

Your lens:
${lens}

Use WebSearch and WebFetch. Do not rely only on the original source. Vote "supported" only when independent
evidence supports the claim. Vote "refuted" when credible evidence contradicts it. Vote "uncertain" when
the evidence is weak, missing, or ambiguous.

Main question:
${question}

Claim:
${claim.statement}

Original source:
${claim.sourceUrl}`,
          { label: `vote:${claimIndex + 1}`, phase: 'Vote', schema: VOTE_SCHEMA },
        )
      )
    ).then((votes) => tallyVotes(claim, votes.filter(Boolean)))
  ),
)

const verification = votedClaims.filter(Boolean)
const acceptedClaims = verification.filter((item) => item.accepted)
const rejectedClaims = verification.filter((item) => !item.accepted)

const supportingClaims = allClaims.filter(
  (claim) => claim.importance !== 'key' && claim.confidence === 'high' && !claimsToVerify.includes(claim),
)

log(`${acceptedClaims.length} claims survived voting; ${rejectedClaims.length} were rejected or left uncertain.`)

phase('Report')
const evidence = {
  question,
  scope: plan.scope,
  assumptions: plan.assumptions || [],
  acceptedClaims,
  supportingClaims: supportingClaims.map((claim) => ({
    statement: claim.statement,
    sourceUrl: claim.sourceUrl,
    evidence: claim.evidence,
  })),
  rejectedClaims: rejectedClaims.map((item) => ({
    statement: item.claim.statement,
    reason: item.reason,
    corrections: item.corrections,
  })),
  sources: Array.from(sourceByUrl.values()).map((source) => ({
    title: source.title,
    url: source.url,
    publisher: source.publisher,
    date: source.date,
    sourceType: source.sourceType,
  })),
}

const report = await agent(
  `Write the final deep-research report in Markdown.

Rules:
- Answer the question directly.
- Use only acceptedClaims and high-confidence supportingClaims as factual evidence.
- Do not use rejectedClaims as facts; mention them only as caveats when useful.
- Include inline numbered citations like [1], [2].
- End with a "## Sources" section mapping citation numbers to URLs.
- If evidence is thin, say so plainly.

Evidence JSON:
${JSON.stringify(evidence, null, 2)}`,
  { label: 'report', phase: 'Report', schema: REPORT_SCHEMA },
)

return {
  question,
  report,
  verification: {
    accepted: acceptedClaims.length,
    rejected: rejectedClaims.length,
    totalVoted: verification.length,
  },
  acceptedClaims,
  rejectedClaims,
  stats: {
    angles: angles.length,
    sources: sourceByUrl.size,
    extractedClaims: allClaims.length,
    votedClaims: verification.length,
  },
}

function normalizeClaim(statement) {
  return String(statement || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180)
}

function tallyVotes(claim, votes) {
  const supported = votes.filter((vote) => vote.vote === 'supported').length
  const refuted = votes.filter((vote) => vote.vote === 'refuted').length
  const uncertain = votes.filter((vote) => vote.vote === 'uncertain').length
  const accepted = votes.length > 0 && supported >= 2 && refuted === 0 && supported > uncertain
  const corrections = votes.map((vote) => vote.correction).filter(Boolean)
  const supportingUrls = unique(
    [claim.sourceUrl].concat(votes.flatMap((vote) => vote.supportingUrls || [])).filter(Boolean),
  )
  const contradictingUrls = unique(votes.flatMap((vote) => vote.contradictingUrls || []).filter(Boolean))
  const reason = accepted
    ? `accepted by ${supported}/${votes.length} voters`
    : `rejected or uncertain: ${supported} supported, ${refuted} refuted, ${uncertain} uncertain`

  return {
    claim,
    accepted,
    reason,
    votes,
    corrections,
    supportingUrls,
    contradictingUrls,
  }
}

function unique(items) {
  const out = []
  const seen = new Set()
  for (const item of items) {
    const key = String(item).trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}
