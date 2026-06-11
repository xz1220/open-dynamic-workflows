/**
 * The built-in generate-workflow (launch.md D1+D2): authoring a new dynamic
 * workflow IS ITSELF a dynamic workflow, so the generation run shows up in Jobs
 * with a live DAG (Generate → Validate → Repair), its failures are debuggable
 * run artifacts, and the repair loop is expressed in workflow primitives.
 *
 * This module exports the workflow's SOURCE as a string (same reason as
 * dashboard.generated.ts: the SEA binary has no repo files, and the server
 * launches it inline via startRunFromSource). The dialect documentation is NOT
 * baked in here — the server injects it per run as `args.dialectDoc` (from
 * src/skill.generated.ts), so skill/SKILL.md stays the single source of truth.
 *
 * args contract: { task: string, dialectDoc: string, patternsDigest: string }
 * result: { script: string, meta: WorkflowMeta, attempts: number }
 */

/** Curated one-screen digest of the examples/ orchestration patterns. */
export const PATTERNS_DIGEST = `Known orchestration patterns (pick what fits; compose freely):

1. fan-out-reduce — draft N answers in parallel, then synthesize the best one.
   phase('Draft'); const drafts = await parallel([1,2,3].map(i => () => agent(...)))
   phase('Synthesize'); return await agent('synthesize: ' + drafts.filter(Boolean).join('\\n---\\n'))

2. pipeline (multi-stage, no barrier) — stream items through stages independently.
   const out = await pipeline(items, item => agent('stage 1: ' + item), prev => agent('stage 2: ' + prev))

3. adversarial-verify — find candidates, then keep only those that survive independent refutation.
   const found = await agent('find issues', { schema: FINDINGS })
   const verdicts = await parallel(found.issues.map(f => () => agent('try to REFUTE: ' + f.title, { schema: VERDICT })))
   return found.issues.filter((f, i) => verdicts[i] && !verdicts[i].refuted)

4. loop-until-dry — keep fanning out finders until K consecutive rounds add nothing new.
   const seen = new Set(); let dry = 0
   while (dry < 2) { const fresh = (await parallel(...)).filter(Boolean).flatMap(r => r.items).filter(x => !seen.has(x.key));
     if (!fresh.length) { dry++; continue } dry = 0; fresh.forEach(x => seen.add(x.key)) }

5. routing — classify the request, route to the matching specialist, then grade the result.
   const kind = await agent('classify: ' + args.task, { schema: KIND })
   const out = await agent(promptFor(kind), { agentType: kind.specialist })
   return await agent('grade this: ' + out, { schema: GRADE })

6. tournament — N agents attempt the task with different approaches; pairwise judging picks a winner.
   let pool = await parallel(approaches.map(a => () => agent('attempt via ' + a)))
   while (pool.length > 1) { /* judge pairs with agent(..., { schema: PICK }), keep winners */ }

7. generate-and-filter — overproduce ideas in parallel, dedupe in plain code, keep what passes a rubric.

8. duel loop (two CLIs) — one adapter implements, another reviews; a FAIL verdict becomes the
   next round's instruction: agent(fix, { adapter: 'claude' }) ↔ agent(review, { adapter: 'codex' }).`;

/**
 * The workflow source. Plain dialect JavaScript; it uses the `validate` global
 * (ODW extension), so it runs on odw only — by design, it is the engine's own
 * authoring tool, not a portable example.
 */
export const GENERATE_WORKFLOW_SOURCE = `export const meta = {
  name: 'generate-workflow',
  description: 'Author a new dynamic workflow from a task description, then validate and repair it until it compiles.',
  phases: [{ title: 'Generate' }, { title: 'Validate' }, { title: 'Repair' }],
}

// args: { task, dialectDoc, patternsDigest }
if (!args || typeof args.task !== 'string' || !args.task.trim()) {
  throw new Error('generate-workflow needs args.task (the task description)')
}

const SCRIPT_SCHEMA = {
  type: 'object',
  required: ['script'],
  properties: {
    script: { type: 'string', description: 'The complete workflow script source, dialect-correct.' },
    rationale: { type: 'string', description: 'One short line on the orchestration shape chosen.' },
  },
}

const HARD_RULES = [
  'Return ONLY JSON matching the schema; the "script" value is the COMPLETE file content.',
  "The script MUST start with: export const meta = { ... } — a PURE object literal",
  '(no variables, function calls, spreads, or template strings inside meta).',
  'meta.name: short kebab-case; meta.description: one line; declare meta.phases.',
  'Plain JavaScript only — NO TypeScript annotations, NO import/require, NO other export.',
  'Use ONLY the injected globals: agent, parallel, pipeline, phase, log, args, budget, workflow.',
  'NEVER use Date.now(), Math.random(), or new Date() with no arguments.',
  'Top-level await and top-level return are allowed; the final return is the result.',
  'agent(prompt, opts) returns reply text, or a validated object when opts.schema is set.',
  'parallel() slots can be null on failure — .filter(Boolean) before using results.',
  'Do not hardcode adapter names unless the task explicitly needs distinct CLIs per role.',
].join('\\n- ')

const authoring =
  'Write ONE dynamic-workflow script for the task below.\\n\\n' +
  '== Dialect documentation ==\\n' + (args.dialectDoc || '(none provided)') + '\\n\\n' +
  '== Patterns ==\\n' + (args.patternsDigest || '(none provided)') + '\\n\\n' +
  '== Task ==\\n' + args.task + '\\n\\n' +
  '== Hard rules ==\\n- ' + HARD_RULES

phase('Generate')
let draft = await agent(authoring, { schema: SCRIPT_SCHEMA, label: 'author' })
let lastProblems = []

for (let attempt = 1; attempt <= 3; attempt++) {
  phase('Validate')
  const check = validate(draft.script)
  const problems = check.ok ? check.warnings : check.errors
  if (check.ok && check.warnings.length === 0) {
    log('validated on attempt ' + attempt + (draft.rationale ? ' — ' + draft.rationale : ''))
    return { script: draft.script, meta: check.meta, attempts: attempt }
  }
  lastProblems = problems
  log('attempt ' + attempt + ' failed validation: ' + problems.join(' | '))
  if (attempt === 3) break

  phase('Repair')
  const repair =
    'Your previous workflow script failed validation. Fix it and return the COMPLETE corrected script.\\n\\n' +
    '== Validation problems ==\\n- ' + problems.join('\\n- ') + '\\n\\n' +
    '== Previous script ==\\n' + draft.script + '\\n\\n' +
    '== Hard rules (re-read carefully) ==\\n- ' + HARD_RULES
  draft = await agent(repair, { schema: SCRIPT_SCHEMA, label: 'repair-' + attempt })
}

throw new Error('script did not validate after 3 attempts: ' + lastProblems.join('; '))
`;
