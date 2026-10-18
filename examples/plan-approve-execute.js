// Plan → approve → execute: an agent drafts a plan, a person approves it at a
// checkpoint(), and only then does the parallel — and costly — execution
// start. A rejection with a note sends the planner back with that feedback.
//
// checkpoint() is an ODW extension (Claude Code's workflows take no mid-run
// input): this workflow runs on odw only. At the checkpoint the run waits,
// durably and for as long as it takes, until someone answers it — from
// another shell, or from the dashboard (odw serve):
//
//   RUN=$(odw run examples/plan-approve-execute.js --source path/to/repo \
//     --args '{"task": "Add rate limiting to the public API"}')
//   odw status $RUN        # the plan, and the exact commands that answer it
//   odw approve $RUN       # go ahead
//   odw approve $RUN --edit   # change the plan in $EDITOR first; the edited plan runs
//   odw reject $RUN --note "Leave the admin routes alone"   # re-plan with that note
//
// An edited plan must still match PLAN (the checkpoint's schema): odw approve
// and the dashboard refuse one that does not, and so does the run.
//
// The executors edit the source directory in place (the default workspace):
// point --source at the repository, and read the plan before you approve it.

export const meta = {
  name: 'plan-approve-execute',
  description:
    'Draft a plan, wait at a checkpoint for a person to approve it, then execute its steps in parallel and report.',
  whenToUse:
    'A change worth a human look before the expensive fan-out. Pass a task string, or {task, maxSteps?, replans?, timeout?, onTimeout?}: maxSteps caps the plan (default 5), replans is how many plans rejected with a note are redrafted (default 2), timeout is seconds to wait for the decision (default: no limit) and onTimeout what silence means — "approve", "reject" (the default) or "fail". ODW only: uses the checkpoint() extension.',
  phases: [{ title: 'Plan' }, { title: 'Approve' }, { title: 'Execute' }, { title: 'Report' }],
}

const input = typeof args === 'string' ? { task: args } : args || {}
const task = input.task || 'Add input validation to the signup form.'
const maxSteps = Number(input.maxSteps) || 5
const replans = input.replans === undefined ? 2 : Number(input.replans)
// Unattended (cron, CI)? Give the decision a deadline, and decide what silence means.
const timeout = input.timeout ? Number(input.timeout) : undefined
const onTimeout = input.onTimeout || 'reject'

const PLAN = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    steps: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, instructions: { type: 'string' } },
        required: ['title', 'instructions'],
      },
    },
  },
  required: ['summary', 'steps'],
}

let feedback = ''
let plan
let decision
for (let draft = 1; ; draft++) {
  phase('Plan')
  plan = await agent(
    `Plan this task as at most ${maxSteps} steps that can be carried out independently and in parallel ` +
      "(no step may depend on another step's output). Give each step a short title and precise " +
      `instructions. Do not change anything yet.\n\nTASK:\n${task}${feedback}`,
    { label: `plan ${draft}`, phase: 'Plan', schema: PLAN },
  )
  plan.steps = plan.steps.slice(0, maxSteps)

  // Nothing has been changed yet: this is the moment for a person to look.
  phase('Approve')
  decision = await checkpoint(`Run this ${plan.steps.length}-step plan? ${plan.summary}`, {
    payload: plan,
    schema: PLAN, // an approver may edit the plan; the edit must still be a plan
    timeout,
    onTimeout,
  })
  if (decision.approved) {
    // What was approved: the plan as the person edited it, if they did.
    if (decision.edited) {
      plan = decision.payload
      plan.steps = plan.steps.slice(0, maxSteps)
      log(`plan ${draft} approved with edits: ${plan.steps.length} step(s)`)
    }
    break
  }
  if (!decision.note || draft > replans) {
    log(`plan ${draft} rejected (${decision.by})${decision.note ? `: ${decision.note}` : ''}; nothing was changed`)
    return { approved: false, by: decision.by, note: decision.note, plan }
  }
  log(`plan ${draft} rejected: ${decision.note}`)
  feedback =
    `\n\nA reviewer rejected the previous plan with this note; address it:\n${decision.note}` +
    `\n\nPREVIOUS PLAN:\n${JSON.stringify(plan, null, 2)}`
}

phase('Execute')
const approvalNote = decision.note ? `\n\nNOTE FROM THE PERSON WHO APPROVED THE PLAN:\n${decision.note}` : ''
const results = await parallel(
  plan.steps.map((step, i) => () =>
    agent(
      `You are carrying out step ${i + 1} of ${plan.steps.length} of an approved plan.\n\n` +
        `TASK:\n${task}\n\nPLAN SUMMARY:\n${plan.summary}\n\n` +
        `YOUR STEP — ${step.title}:\n${step.instructions}${approvalNote}\n\n` +
        'Do only this step. Reply with a short summary of what you changed.',
      { label: `step ${i + 1}`, phase: 'Execute' },
    ),
  ),
)

phase('Report')
const report = await agent(
  'Summarize the outcome of this approved plan for the person who approved it: what was done, ' +
    `what failed, and what to check next.\n\nPLAN:\n${JSON.stringify(plan, null, 2)}\n\nSTEP RESULTS:\n` +
    results.map((r, i) => `--- step ${i + 1}: ${plan.steps[i].title} ---\n${r === null ? '(failed)' : r}`).join('\n\n'),
  { label: 'report', phase: 'Report' },
)
return {
  approved: true,
  by: decision.by,
  note: decision.note,
  edited: decision.edited,
  plan,
  steps: { total: results.length, done: results.filter((r) => r !== null).length },
  report,
}
