export const meta = {
  name: 'agent-daily-digest',
  description:
    "Scan today's sessions across coding agents (Claude Code + Codex), distill the valuable, shareable signal out of the noise, and return a prioritized, evidence-grounded daily digest.",
  whenToUse:
    'Use at end of day (or any time) to turn a chaotic day of agent interactions across Claude Code and Codex into one faithful, shareable digest: what made progress, what is still open, key decisions, and learnings — each item backed by concrete evidence from the raw session logs. Runs on odw and Claude Code unchanged. The backing agent must be able to run a shell and read files under ~/.claude and ~/.codex.',
  phases: [
    { title: 'Discover', detail: "enumerate today's sessions across agents, local-day window" },
    { title: 'Extract', detail: 'de-noise each session and pull evidence-backed items (one agent per session)' },
    { title: 'Synthesize', detail: 'merge across sessions/agents, dedupe, prioritize by value' },
    { title: 'Verify', detail: 'adversarially ground the top items against the raw logs (faithfulness)' },
    { title: 'Report', detail: 'render the shareable Markdown digest and write it to disk' },
  ],
}

// ─────────────────────────────────────────────────────────────────────────────
// Schemas (literal objects — same dialect as examples/deep-research.js)
// ─────────────────────────────────────────────────────────────────────────────

const SESSION_LIST_SCHEMA = {
  type: 'object',
  properties: {
    resolvedDate: { type: 'string' },
    timezone: { type: 'string' },
    sessions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          agent: { type: 'string', enum: ['claude', 'codex'] },
          sessionId: { type: 'string' },
          file: { type: 'string' },
          title: { type: 'string' },
          project: { type: 'string' },
          userMessages: { type: 'integer' },
          firstAt: { type: 'string' },
          lastAt: { type: 'string' },
        },
        required: ['agent', 'file', 'userMessages'],
      },
    },
    notes: { type: 'string' },
  },
  required: ['resolvedDate', 'sessions'],
}

const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    sessionSummary: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['progress', 'decision', 'open_loop', 'problem', 'learning', 'other'],
          },
          title: { type: 'string' },
          detail: { type: 'string' },
          userIntent: { type: 'string' },
          evidence: { type: 'string' },
          entities: { type: 'array', items: { type: 'string' } },
          status: {
            type: 'string',
            enum: ['done', 'in_progress', 'blocked', 'abandoned', 'unknown'],
          },
          signals: {
            type: 'object',
            properties: {
              consequence: { type: 'integer' },
              intent: { type: 'integer' },
              unresolved: { type: 'integer' },
              stakes: { type: 'integer' },
            },
          },
          valueRationale: { type: 'string' },
        },
        required: ['type', 'title', 'detail', 'evidence'],
      },
    },
  },
  required: ['items'],
}

const DIGEST_ITEM = {
  type: 'object',
  properties: {
    priority: { type: 'string', enum: ['P0', 'P1', 'P2'] },
    title: { type: 'string' },
    detail: { type: 'string' },
    status: { type: 'string', enum: ['done', 'in_progress', 'blocked', 'abandoned', 'unknown'] },
    evidence: { type: 'string' },
    recurrence: { type: 'integer' },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          project: { type: 'string' },
          sessionTitle: { type: 'string' },
          sessionId: { type: 'string' },
        },
        required: ['agent'],
      },
    },
  },
  required: ['priority', 'title', 'detail'],
}

const DIGEST_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string' },
    sections: {
      type: 'object',
      properties: {
        progress: { type: 'array', items: DIGEST_ITEM },
        followups: { type: 'array', items: DIGEST_ITEM },
        decisions: { type: 'array', items: DIGEST_ITEM },
        learnings: { type: 'array', items: DIGEST_ITEM },
        other: { type: 'array', items: DIGEST_ITEM },
      },
      required: ['progress', 'followups', 'decisions', 'learnings'],
    },
  },
  required: ['headline', 'sections'],
}

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    accuracy: { type: 'string', enum: ['accurate', 'needs_correction', 'unsupported'] },
    correctedDetail: { type: 'string' },
    correctedEvidence: { type: 'string' },
    note: { type: 'string' },
  },
  required: ['accuracy'],
}

// ─────────────────────────────────────────────────────────────────────────────
// Args + budget knobs
// ─────────────────────────────────────────────────────────────────────────────

const asObject = args && typeof args === 'object' ? args : {}
const stringArg = (name) => (typeof asObject[name] === 'string' ? asObject[name].trim() : '')
const clamp = (v, min, max) => Math.max(min, Math.min(max, v))
const numberArg = (name, fallback) => {
  const raw = Number(asObject[name])
  return Number.isFinite(raw) ? raw : fallback
}
const integerArg = (name, fallback) => Math.floor(numberArg(name, fallback))

// If args is a bare string, treat it as the target local date (YYYY-MM-DD). Empty => today.
const targetDate = typeof args === 'string' ? args.trim() : stringArg('date')
const AGENTS =
  Array.isArray(asObject.agents) && asObject.agents.length ? asObject.agents : ['claude', 'codex']
// "progress" (default, per the brief: lean toward things that made progress) | "followups" | "retro" | "balanced"
const LENS = stringArg('lens') || 'progress'
const SHOULD_WRITE = asObject.write !== false
const OUT_PATH = stringArg('outPath')

const MAX_SESSIONS = clamp(
  integerArg('maxSessions', budget.total ? Math.floor(budget.total / 80000) : 40),
  1,
  200,
)
const MAX_VERIFY = clamp(
  integerArg('maxVerify', budget.total ? Math.floor(budget.total / 120000) : 12),
  0,
  60,
)

const dayInstruction = targetDate
  ? `Target local calendar day: ${targetDate}. Use DAY="${targetDate}".`
  : 'Target local calendar day: TODAY in the machine\'s local timezone. Compute it with: DAY=$(date +%Y-%m-%d).'

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 — Discover today's sessions across agents
// ─────────────────────────────────────────────────────────────────────────────

phase('Discover')
log(`Scanning ${AGENTS.join(' + ')} sessions for ${targetDate || 'today (local)'}.`)

const discovery = await agent(
  `You are the scanner for a daily coding-agent activity digest. Find EVERY session that had genuine user
activity during one local calendar day, across these agents: ${AGENTS.join(', ')}. Use the shell. Return
METADATA ONLY (no message bodies) so this stays cheap.

${dayInstruction}

CRITICAL timezone rule: every per-line "timestamp" in these logs is UTC (ends with Z), but the day you want is
a LOCAL calendar day. So build a LOCAL-day epoch window and compare each line's UTC timestamp converted to epoch:

  START=$(date -j -f "%Y-%m-%d %H:%M:%S" "$DAY 00:00:00" +%s)
  END=$(date -j -v+1d -f "%Y-%m-%d %H:%M:%S" "$DAY 00:00:00" +%s)

To convert a line timestamp to epoch in jq without regex (avoids fractional-second parse errors):
  ((.timestamp[0:19] + "Z") | fromdateiso8601) as $t | select($t >= $s and $t < $e)
passing START/END as: jq --argjson s "$START" --argjson e "$END" ...

CLAUDE CODE — transcripts at ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl (one project dir per repo;
the dir name is the cwd with "/" replaced by "-"). For each .jsonl file (use: find ~/.claude/projects -maxdepth 2 -name '*.jsonl'),
count GENUINE user prompts whose timestamp falls in [START,END):
  jq -rc --argjson s "$START" --argjson e "$END" '
    select(.type=="user") | select((.isMeta//false)|not)
    | select((.message.content|type)=="string")
    | ((.timestamp[0:19]+"Z")|fromdateiso8601) as $t | select($t>=$s and $t<$e)
    | (.message.content) as $c
    | select(($c|startswith("<"))|not) | select(($c|startswith("[Request"))|not)
    | $c' FILE | wc -l
  (the startswith filters drop injected pseudo-prompts: <command-*>, <local-command-*>, <system-reminder>, <task-notification>, [Request interrupted...])
  Include the file only if that count > 0. Title: last 'ai-title' line -> .aiTitle (fallback: the first genuine user prompt, truncated).
  Project: the .cwd field on any line. sessionId: the .sessionId field (or filename stem).

CODEX — rollouts at ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (the path date is LOCAL; per-line timestamps are UTC).
Candidate files: today's and yesterday's local dirs PLUS a safety net:
  ls ~/.codex/sessions/$(date -j -f %Y-%m-%d "$DAY" +%Y/%m/%d 2>/dev/null)/rollout-*.jsonl 2>/dev/null
  find ~/.codex/sessions -name 'rollout-*.jsonl' -newermt "$DAY 00:00:00" ! -newermt "$DAY 23:59:59" 2>/dev/null
For each candidate, count genuine user prompts in [START,END):
  jq -rc --argjson s "$START" --argjson e "$END" '
    select(.type=="event_msg" and .payload.type=="user_message")
    | ((.timestamp[0:19]+"Z")|fromdateiso8601) as $t | select($t>=$s and $t<$e)
    | .payload.message' FILE | wc -l
  (fallback for CLI-only sessions lacking event_msg: response_item / payload.type=="message" / payload.role=="user",
   joining content[].text where type=="input_text", dropping any text starting with "<environment_context>".)
  Include only if count > 0. Title: ~/.codex/session_index.jsonl thread_name for that id, else first user prompt truncated.
  Project: the session_meta .payload.cwd. sessionId: the session_meta .payload.id.

If jq is unavailable, do the same logic in python3. Tolerate unreadable/partial trailing lines. firstAt/lastAt:
the min/max in-window line timestamp per session (ISO is fine). Return the resolved date, the local timezone
(date +%Z), and the session list. If there are no qualifying sessions, return an empty sessions array.`,
  { label: 'discover', phase: 'Discover', schema: SESSION_LIST_SCHEMA },
)

const resolvedDate = discovery.resolvedDate || targetDate || 'today'
const allSessions = (discovery.sessions || []).filter((s) => s && s.file && (s.userMessages || 0) > 0)

if (allSessions.length === 0) {
  log('No qualifying sessions found for the target day.')
  return {
    date: resolvedDate,
    scope: { agents: AGENTS, sessionCount: 0, timezone: discovery.timezone || '' },
    digest: { headline: `No agent activity recorded on ${resolvedDate}.`, sections: emptySections() },
    markdown: `# 🗂️ Agent 每日提炼 · ${resolvedDate}\n\n_当天没有检测到 ${AGENTS.join(' / ')} 的有效会话。_\n`,
    outPath: null,
    stats: { sessions: 0, items: 0, verified: 0 },
  }
}

// Rank sessions by activity, keep the most active up to the cap.
const sessions = allSessions
  .slice()
  .sort((a, b) => (b.userMessages || 0) - (a.userMessages || 0))
  .slice(0, MAX_SESSIONS)
const sessionFileById = new Map()
for (const s of sessions) if (s.sessionId) sessionFileById.set(s.sessionId, s.file)

log(
  `${allSessions.length} sessions found (${sessions.length} in scope): ` +
    AGENTS.map((a) => `${a}=${sessions.filter((s) => s.agent === a).length}`).join(', '),
)

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — Extract evidence-backed items, one agent per session (de-noise here)
// ─────────────────────────────────────────────────────────────────────────────

phase('Extract')

const extractions = await parallel(
  sessions.map((session) => () =>
    agent(
      `You are reading ONE coding-agent session log and distilling the VALUABLE, SHAREABLE signal out of it.
This output will be read by people who were not present and may be shared, so every item must be FAITHFUL and
EVIDENCE-BACKED — never invent, never embellish, quote the real artifacts.

Session: agent=${session.agent}, project=${session.project || 'unknown'}, title=${session.title || '(untitled)'}
File: ${session.file}

STEP 1 — read only the de-noised stream (do NOT cat the whole file; use jq/grep to pull just these):
${
  session.agent === 'codex'
    ? `  user prompts:   jq -rc 'select(.type=="event_msg" and .payload.type=="user_message")|.payload.message' "${session.file}"
                  (fallback: response_item / payload.type=="message" / payload.role=="user", join content[].text where type=="input_text", drop "<environment_context>")
  assistant text: jq -rc 'select(.type=="event_msg" and .payload.type=="agent_message")|.payload.message' "${session.file}"
  tool calls:     jq -rc 'select(.type=="response_item" and .payload.type=="function_call")|{name:.payload.name, arguments:.payload.arguments}' "${session.file}"`
    : `  user prompts:   jq -rc 'select(.type=="user")|select((.isMeta//false)|not)|select((.message.content|type)=="string")|(.message.content) as $c|select(($c|startswith("<"))|not)|select(($c|startswith("[Request"))|not)|$c' "${session.file}"
  assistant text: jq -rc 'select(.type=="assistant")|.message.content[]?|select(.type=="text")|.text' "${session.file}"
  tool calls:     jq -rc 'select(.type=="assistant")|.message.content[]?|select(.type=="tool_use")|{name, input}' "${session.file}"`
}

DROP as noise: agent reasoning/thinking, tool RESULT blobs, retries that immediately succeeded, file reads/searches that
only fed one edit, permission prompts, injected system/environment context. KEEP as signal: what the user actually asked,
decisions and reversals, and STATE-CHANGING actions — git commit/branch/PR, file create/edit/delete, deploy, messages/emails
sent (e.g. Lark), config/secret/prod changes.

STEP 2 — emit discrete items. For each, classify type:
  progress  = something moved forward or got delivered (favor these)
  decision  = a choice made, especially a reversal ("actually use X", "no, do Y instead")
  open_loop = started-not-finished, explicit TODO, unanswered question, tests left red, blocked
  problem   = a failure / rabbit hole / surprising friction (note if still unresolved)
  learning  = a non-obvious thing learned worth keeping
For each item give: title (concrete), detail (self-contained, faithful — readable by someone who wasn't here),
userIntent (the real prompt that triggered it, quoted/tight-paraphrased), evidence (CONCRETE anchors: file paths,
commit hashes, command run, PR number, a short verbatim quote — this is what makes it shareable and checkable),
entities (files / repo / feature names / proper nouns — used to merge the same thing across sessions), status,
and signals scored 0-3: consequence (durable/irreversible/external impact), intent (how hard the user pushed —
repetition, emphasis, corrections), unresolved (how much it still needs attention), stakes (prod/security/money/people).
valueRationale: one line on why this is worth recording.

Be ruthless about noise: a routine session that shipped nothing and decided nothing may yield 0 items — that's fine,
return an empty items array. Quality over quantity. Only genuinely valuable signal.`,
      { label: `extract:${session.agent}:${(session.title || session.sessionId || '').slice(0, 24)}`, phase: 'Extract', schema: EXTRACT_SCHEMA },
    ),
  ),
)

// Attach source/session metadata to every extracted item (in plain JS).
const items = []
sessions.forEach((session, i) => {
  const ex = extractions[i]
  if (!ex || !Array.isArray(ex.items)) return
  for (const it of ex.items) {
    items.push({
      ...it,
      source: {
        agent: session.agent,
        project: session.project || '',
        sessionTitle: session.title || '',
        sessionId: session.sessionId || '',
      },
    })
  }
})

log(`${items.length} candidate items extracted from ${sessions.length} sessions.`)

if (items.length === 0) {
  const empty = { headline: `Sessions ran on ${resolvedDate} but produced no high-value items.`, sections: emptySections() }
  return finalize(empty, [], resolvedDate, discovery.timezone, sessions, null)
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 — Synthesize: merge across sessions/agents, dedupe, prioritize by value
// ─────────────────────────────────────────────────────────────────────────────

phase('Synthesize')

const lensGuidance =
  LENS === 'followups'
    ? 'Primary axis: what is still OPEN and needs action next. Lead with follow-ups/open loops.'
    : LENS === 'retro'
      ? 'Primary axis: decisions, reversals, and learnings worth keeping. Lead with decisions/learnings.'
      : LENS === 'balanced'
        ? 'Balance all sections evenly; rank purely by value.'
        : 'Primary axis: PROGRESS — lead with what moved forward / got delivered, but keep all sections.'

const digestRaw = await agent(
  `You are the editor of a faithful, shareable daily digest of a person's work with coding agents
(Claude Code + Codex). You are given candidate items already extracted from individual sessions. Produce ONE
comprehensive, prioritized digest. Be faithful: do not invent; preserve each item's evidence and sources.

The north star: VALUABLE INFORMATION. An item earns a high priority by VALUE, roughly =
  consequence (durable/irreversible/external impact)  +  unresolved (still needs attention)
  +  intent (how hard the user pushed)  +  stakes (prod/security/money/people),
AMPLIFIED by recurrence — the same underlying thing showing up across multiple sessions, and especially across
BOTH Claude Code and Codex, is more important (it's a live, central concern). Effort alone is NOT value: a long
rabbit hole that shipped nothing is only worth recording as an open problem, not as an accomplishment.

${lensGuidance}

Do this:
1) MERGE items that refer to the same underlying thing (match on entities/files/repo/feature names) — even across
   different agents and sessions. Combine their evidence and list all sources. Set recurrence = number of distinct
   sessions that touched it.
2) Assign each merged item a priority: P0 (must not be forgotten — high value or genuinely blocking), P1 (clearly
   worth recording), P2 (minor but real). Drop pure noise entirely.
3) Sort each section by priority then recurrence. Place each item in exactly one section:
   progress, followups (open loops/TODOs/blocked), decisions (choices & reversals), learnings (problems+lessons), other.
4) Write a 1-2 sentence headline capturing the day. Keep every detail self-contained and shareable; keep concrete
   evidence anchors (paths, commits, PRs, quotes). Carry forward the sources (agent/project/sessionId/sessionTitle).

Candidate items (JSON):
${JSON.stringify(items.map(compactItem), null, 2)}`,
  { label: 'synthesize', phase: 'Synthesize', schema: DIGEST_SCHEMA },
)

const digest = normalizeDigest(digestRaw)

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4 — Verify: adversarially ground the top items against the raw logs
// ─────────────────────────────────────────────────────────────────────────────

phase('Verify')

const flat = flattenForVerify(digest) // [{ sectionKey, idx, item }]
const toVerify = flat
  .filter((f) => f.item.priority === 'P0' || f.item.priority === 'P1')
  .sort((a, b) => priorityRank(a.item.priority) - priorityRank(b.item.priority))
  .slice(0, MAX_VERIFY)

log(`Grounding ${toVerify.length} top items against the raw logs (faithfulness pass).`)

const verdicts = await parallel(
  toVerify.map((entry) => () => {
    const files = (entry.item.sources || [])
      .map((s) => sessionFileById.get(s.sessionId))
      .filter(Boolean)
    const fileHint = files.length
      ? `Primary log file(s):\n${files.map((f) => `  ${f}`).join('\n')}`
      : 'No file path resolved — locate the matching session under ~/.claude/projects or ~/.codex/sessions.'
    return agent(
      `You are a skeptical fact-checker. Confirm this digest item is FAITHFULLY supported by the raw session log.
Open the file(s), search for the evidence (grep for the paths/commits/quotes/keywords mentioned), and judge:
- "accurate": the claim is supported as written.
- "needs_correction": basically real but the detail/evidence is wrong, overstated, or imprecise — provide a tightened
  correctedDetail and correctedEvidence grounded in what the log actually shows.
- "unsupported": you cannot find support for this in the logs. Default here when genuinely uncertain.
Do NOT rely on the claim's own wording; verify against the file. Be precise about status (done vs still open).

Item:
  title: ${entry.item.title}
  detail: ${entry.item.detail}
  evidence: ${entry.item.evidence || '(none given)'}
  claimed status: ${entry.item.status || 'unknown'}
  sources: ${(entry.item.sources || []).map((s) => `${s.agent}:${s.sessionTitle || s.sessionId || ''}`).join('; ') || '(none)'}

${fileHint}`,
      { label: `verify:${entry.item.title.slice(0, 28)}`, phase: 'Verify', schema: VERIFY_SCHEMA },
    ).then((v) => ({ entry, verdict: v }))
  }),
)

let verifiedCount = 0
let correctedCount = 0
let flaggedCount = 0
for (const r of verdicts.filter(Boolean)) {
  const it = r.entry.item
  const v = r.verdict || {}
  if (v.accuracy === 'accurate') {
    it.verified = true
    verifiedCount++
  } else if (v.accuracy === 'needs_correction') {
    if (v.correctedDetail) it.detail = v.correctedDetail
    if (v.correctedEvidence) it.evidence = v.correctedEvidence
    it.verified = true
    verifiedCount++
    correctedCount++
  } else {
    // unsupported — keep it (faithfulness = don't silently drop) but flag clearly.
    it.verified = false
    it.verifyNote = v.note || 'could not be confirmed from the logs'
    flaggedCount++
  }
}

log(`Verified ${verifiedCount} (${correctedCount} corrected); ${flaggedCount} flagged as unconfirmed.`)

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5 — Report: render shareable Markdown and write it to disk
// ─────────────────────────────────────────────────────────────────────────────

phase('Report')

const scope = {
  agents: AGENTS,
  sessionCount: sessions.length,
  timezone: discovery.timezone || '',
  lens: LENS,
}
const markdown = renderMarkdown(digest, resolvedDate, scope)

let outPath = null
let writeBytes = 0
if (SHOULD_WRITE) {
  const target = OUT_PATH || `~/agent-daily-digest-${resolvedDate}.md`
  // A write sub-agent can claim success without actually writing, so confirm the
  // file landed with an INDEPENDENT check (and retry once) before trusting it.
  const res = await persistDigest(target, markdown)
  outPath = res.bytes > 0 ? res.path : null
  writeBytes = res.bytes
  log(
    res.bytes > 0
      ? `Digest written to ${res.path} (${res.bytes} bytes, confirmed).`
      : `WARNING: could not confirm the digest was written to ${target}. The full Markdown is in the returned result.markdown.`,
  )
}

return finalizeResult(digest, markdown, resolvedDate, scope, sessions, items, outPath, {
  verified: verifiedCount,
  corrected: correctedCount,
  flagged: flaggedCount,
  writeBytes,
})

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (hoisted)
// ─────────────────────────────────────────────────────────────────────────────

function emptySections() {
  return { progress: [], followups: [], decisions: [], learnings: [], other: [] }
}

// Write the digest, then confirm it actually landed with an INDEPENDENT agent
// (a write agent may report success without writing). Retry once. Returns the
// confirmed byte count, or 0 if it never landed.
async function persistDigest(target, content) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    await agent(
      `Write the file ${target} with EXACTLY the content below — verbatim, byte-for-byte, no edits, no summary, no reformatting, no extra text. Expand a leading ~ to the home directory. Create parent directories if needed. After writing, reply with only the file's byte count as a bare integer.

<<<DIGEST_MARKDOWN
${content}
DIGEST_MARKDOWN`,
      { label: attempt === 1 ? 'write-report' : 'write-report-retry', phase: 'Report' },
    )
    const check = await agent(
      `Check the file ${target} (expand a leading ~ to the home directory). If it exists, reply with ONLY its size in bytes as a bare integer. If it does not exist, reply with exactly: MISSING`,
      { label: 'confirm-write', phase: 'Report' },
    )
    const matched = String(check || '').match(/[0-9]{1,}/)
    const bytes = matched ? parseInt(matched[0], 10) : 0
    if (bytes > 0) return { path: target, bytes }
  }
  return { path: target, bytes: 0 }
}

function compactItem(it) {
  return {
    type: it.type,
    title: it.title,
    detail: it.detail,
    userIntent: it.userIntent,
    evidence: it.evidence,
    entities: it.entities || [],
    status: it.status || 'unknown',
    signals: it.signals || {},
    valueRationale: it.valueRationale,
    source: it.source,
  }
}

function normalizeDigest(raw) {
  const sections = Object.assign(emptySections(), (raw && raw.sections) || {})
  for (const key of Object.keys(sections)) {
    if (!Array.isArray(sections[key])) sections[key] = []
  }
  return { headline: (raw && raw.headline) || '', sections }
}

function flattenForVerify(digest) {
  const out = []
  for (const sectionKey of Object.keys(digest.sections)) {
    digest.sections[sectionKey].forEach((item, idx) => out.push({ sectionKey, idx, item }))
  }
  return out
}

function priorityRank(p) {
  return p === 'P0' ? 0 : p === 'P1' ? 1 : 2
}

function shortProject(p) {
  if (!p) return ''
  const parts = String(p).split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : String(p)
}

function renderItem(it) {
  const badge = it.priority ? `[${it.priority}] ` : ''
  const status = it.status && it.status !== 'unknown' ? ` · _${it.status}_` : ''
  const lines = [`- ${badge}**${it.title}**${status}`]
  if (it.detail) lines.push(`  ${it.detail}`)
  if (it.sources && it.sources.length) {
    const src = it.sources
      .map((s) => {
        const proj = s.project ? `:${shortProject(s.project)}` : ''
        const t = s.sessionTitle ? ` — ${s.sessionTitle}` : ''
        return `${s.agent}${proj}${t}`
      })
      .join('; ')
    const rec = it.recurrence > 1 ? ` (跨 ${it.recurrence} 处 session)` : ''
    lines.push(`  ↳ 来源: ${src}${rec}`)
  }
  if (it.evidence) lines.push(`  ↳ 依据: ${it.evidence}`)
  if (it.verified === false) lines.push(`  ⚠️ 未能从原始记录中核实${it.verifyNote ? ` — ${it.verifyNote}` : ''}`)
  return lines.join('\n')
}

function renderMarkdown(digest, date, scope) {
  const out = [`# 🗂️ Agent 每日提炼 · ${date}`, '']
  if (digest.headline) {
    out.push(`> ${digest.headline}`, '')
  }
  out.push(
    `**范围**: ${scope.agents.join(' + ')} · ${scope.sessionCount} 个 session` +
      (scope.timezone ? ` · 时区 ${scope.timezone}` : '') +
      ` · 视角 ${scope.lens}`,
    '',
  )
  const sectionDefs = [
    ['progress', '✅ 进展 / 成果 (Progress)'],
    ['followups', '⏭️ 待办 / 开放回路 (Follow-ups)'],
    ['decisions', '🧭 关键决策与反转 (Decisions)'],
    ['learnings', '💡 踩坑与沉淀 (Learnings)'],
    ['other', '📎 其他 (Other)'],
  ]
  for (const [key, label] of sectionDefs) {
    const list = digest.sections[key] || []
    if (!list.length) continue
    out.push(`## ${label}`, '')
    for (const it of list) out.push(renderItem(it))
    out.push('')
  }
  out.push('---', '_由 agent-daily-digest workflow 生成；每条均附原始 session 依据，可追溯、可分享。_')
  return out.join('\n').trim() + '\n'
}

function finalizeResult(digest, markdown, date, scope, sessions, items, outPath, verifyStats) {
  const sectionCounts = {}
  for (const key of Object.keys(digest.sections)) sectionCounts[key] = digest.sections[key].length
  return {
    date,
    scope,
    digest,
    markdown,
    outPath,
    stats: {
      sessions: sessions.length,
      sessionsByAgent: scope.agents.reduce((acc, a) => {
        acc[a] = sessions.filter((s) => s.agent === a).length
        return acc
      }, {}),
      candidateItems: items.length,
      sectionCounts,
      verify: verifyStats,
    },
  }
}

function finalize(digest, items, date, timezone, sessions, outPath) {
  const scope = { agents: AGENTS, sessionCount: sessions.length, timezone: timezone || '', lens: LENS }
  const markdown = renderMarkdown(normalizeDigest(digest), date, scope)
  return finalizeResult(normalizeDigest(digest), markdown, date, scope, sessions, items, outPath, {
    verified: 0,
    corrected: 0,
    flagged: 0,
  })
}
