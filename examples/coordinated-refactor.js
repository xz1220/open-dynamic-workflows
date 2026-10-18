// Split a refactor across parallel agents that tell each other what they
// changed — so their changes still fit together once merged.
//
// Parallel coding agents produce changes that pass alone and break together:
// one renames a function another still calls. Here every lane runs with the
// run's notes board (an ODW extension; Claude Code ignores the options):
//
//   - parallel(…, { notes: true }) gives each lane `ODW_NOTES` and tells it, in
//     its prompt, to post what the others must know (`"$ODW_NOTES" "…"` or
//     `odw note "…"`), and to read the board again before it finishes;
//   - as each isolated lane finishes, odw posts its interface changes for it —
//     its diff stat and the declaration lines (export, def, func, pub fn,
//     class, interface) its diff touched;
//   - a read-only reviewer reads the whole board and names the lanes whose
//     change relies on something another lane changed; those lanes run again,
//     now with every note in their prompt, under the same `expect` check.
//
// Each lane works in its own worktree; nothing touches your tree until you
// review and apply the kept changes: `odw diff <run>`, then `odw apply <run>
// --agent lane-N` for each lane — its `lane-N-reconciled` agent instead, when
// it was reconciled.
// `odw notes <run>` prints the board.
//
//   odw run examples/coordinated-refactor.js --source path/to/repo --args '{
//     "tasks": ["Rename parseX to parse in src/parser.ts and its callers",
//               "Add a --strict flag to the CLI in src/cli.ts"],
//     "check": "npm test" }'

export const meta = {
  name: 'coordinated-refactor',
  description:
    'Parallel isolated agents share a notes board and an automatic broadcast of their interface changes; a reviewer finds lanes that clash and they run again knowing what the others changed.',
  whenToUse:
    'A change that splits into parallel tasks touching shared code. Pass {tasks: [string, …], check?}: tasks are the lanes, check is a command each lane must pass in its worktree (a shell string or an argv array). ODW only: uses the notes board and expect extensions.',
  phases: [{ title: 'Change' }, { title: 'Review' }, { title: 'Reconcile' }],
}

const tasks = Array.isArray(args && args.tasks) ? args.tasks.filter((t) => typeof t === 'string' && t.trim()) : []
if (tasks.length === 0) throw new Error('pass {"tasks": ["…", "…"]}: one task per parallel lane')
const check = args && args.check
const expect = check ? { command: check } : undefined

const lane = (task, i, extra = '', label = `lane-${i + 1}`) =>
  agent(
    `You are lane ${i + 1} of ${tasks.length} in a coordinated change. Other lanes work on the same ` +
      `repository at the same time, each in its own worktree:\n` +
      tasks.map((t, j) => `  ${j + 1}. ${t}`).join('\n') +
      `\n\nYour task (lane ${i + 1}): ${task}\n\n` +
      'As soon as you change something another lane may use — a name, a signature, a file layout, a ' +
      'behaviour — post a note saying exactly what changed. Before you finish, read the notes again ' +
      'and adapt your change to what the other lanes changed: their code is not in your worktree, only ' +
      'their notes tell you, and your change must still work once all of them are merged.' +
      extra +
      '\n\nReply with a short summary of your change.',
    { label, isolation: 'worktree', ...(expect ? { expect } : {}) },
  )

phase('Change')
const first = await parallel(
  tasks.map((task, i) => () => lane(task, i)),
  { notes: true },
)

phase('Review')
const CLASHES = {
  type: 'object',
  required: ['clashes'],
  properties: {
    clashes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['lane', 'why'],
        properties: { lane: { type: 'integer', minimum: 1 }, why: { type: 'string' } },
      },
    },
  },
}
const review = await agent(
  `${tasks.length} lanes changed one repository in parallel:\n` +
    tasks.map((t, i) => `  ${i + 1}. ${t}\n     summary: ${first[i] === null ? '(failed)' : String(first[i]).slice(0, 600)}`).join('\n') +
    '\n\nThe notes board below has what each lane said and the interface lines each one touched. ' +
    'List the lanes whose change relies on something another lane changed — a renamed or re-shaped ' +
    'function, type or file — and say why. List none when they fit together. Do not edit any file.',
  { label: 'reviewer', schema: CLASHES, notes: true },
)

const redo = [...new Set(review.clashes.map((c) => c.lane).filter((n) => Number.isInteger(n) && n >= 1 && n <= tasks.length))]
if (redo.length === 0) {
  log('the lanes fit together: nothing to reconcile')
  return { lanes: first, clashes: [], reconciled: [] }
}

phase('Reconcile')
log(`reconciling lane(s) ${redo.join(', ')} with what the others changed`)
const second = await parallel(
  redo.map((n) => () => {
    const why = review.clashes.filter((c) => c.lane === n).map((c) => c.why).join('; ')
    return lane(tasks[n - 1], n - 1, `\n\nA reviewer found your earlier attempt clashes with another lane: ${why}. ` +
      'The notes below say what the other lanes changed: write your change against those, not against the code as it was.',
      `lane-${n}-reconciled`)
  }),
  { notes: true },
)
return {
  lanes: first,
  clashes: review.clashes,
  reconciled: redo.map((n, i) => ({ lane: n, summary: second[i] })),
}
