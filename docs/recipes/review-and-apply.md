# Reviewing and applying what isolated agents changed

Agents working side by side are cheap; reviewing what they did is the slow
part, and agents editing one checkout at once trample each other's files. Give
each its own worktree with `isolation: "worktree"`: ODW keeps what every one of
them changed as a diff in the run directory. You review the diffs, then apply
the ones you want — one at a time or all in order, with git's three-way merge,
previewed before anything is touched and verified after. (`odw diff`,
`odw apply` and `keep` are ODW extensions.)

## 1. Run the agents in worktrees

```js
export const meta = { name: 'fix-in-parallel', description: 'One agent per failing area, each in its own worktree' }

const areas = ['auth', 'cache', 'billing']
return await parallel(areas.map((area) => () =>
  agent(`Fix the failing ${area} tests. Change only the ${area} code.`,
    { isolation: 'worktree', label: `fix:${area}`, keep: true })))
```

Each agent starts from a clean checkout of HEAD (commit what it should see
first). When it is done, its change — edits, new, deleted, renamed and binary
files — is saved as `agents/<agentId>.diff` before its worktree is removed.
`keep: true` also commits the change to a branch `odw/<runId>/<agentId>-<label>`
of your repository; leave it out to keep only the diff, or set
`"keepBranches": true` in the config to keep a branch for every isolated agent.

## 2. See who changed what

```bash
odw diff $RUN --stat
```

```
ID  STATE  LABEL         FILES    +    -  BRANCH
 1  done   fix:auth          2  +40   -3  odw/20261017-120000-3fa9c1/1-fix-auth
 2  done   fix:cache         1   +6   -2  odw/20261017-120000-3fa9c1/2-fix-cache
 3  done   fix:billing       3  +18  -11  odw/20261017-120000-3fa9c1/3-fix-billing
```

Agents that changed the same file may conflict: `odw apply $RUN --all --check`
(step 5) shows which before anything is applied. The dashboard (`odw serve`)
shows the same diffs, file by file, in the run's **Changes** tab.

## 3. Read a diff

```bash
odw diff $RUN --agent fix:auth           # by label, or by id: --agent 1
odw diff $RUN --agent 1 --stat           # just its files and line counts
odw diff $RUN --agent 1 > auth.patch     # it is a plain patch git can read
odw diff $RUN                            # all of them, each under a "# odw: agent …" line
```

## 4. Preview, then apply

```bash
odw apply $RUN --agent fix:billing --check  # what would apply, what would conflict — changes nothing
odw apply $RUN --agent fix:billing          # apply it to the working tree you are in
```

Before it touches anything, `odw apply` runs the same `git apply --3way` against
a scratch copy of the index, and reports every file of the diff:

```
agent 3 (fix:billing) of run 20261017-120000-3fa9c1 would apply with 1 conflict(s) to /home/me/shop:
  M src/billing/invoice.ts  clean
  M src/shared/money.ts     CONFLICT
      at line 12:
      <<<<<<< ours
      export const round = (n: number) => Math.round(n * 100) / 100;
      =======
      export const round = (n: number) => Number(n.toFixed(2));
      >>>>>>> theirs
  A src/billing/tax.ts      already applied
  (ours: what this tree holds · theirs: the agent's change)
```

- **clean** — it applies as is, or merges three-way without a clash.
- **CONFLICT** — with the lines as the merge would leave them in the file, or why
  the file cannot be merged at all: `deleted here` (the agent changed a file you
  deleted), `changed here, deleted by the agent`, `binary: changed on both sides`,
  or something in the way that git would write over or trip on halfway:
  `renamed onto a file that exists here`, `a file git does not track is in the
  way` (untracked or ignored), `dir is a file here, where the diff needs a
  directory`. Any of these means the diff cannot be applied at all: nothing
  changes, and odw says why.
- **already applied** — the file already holds what the agent made of it (you
  merged its branch, or made the same edit). It is left out of the apply.

`--check` stops there, and exits 1 when anything conflicts. Without it:

- `odw apply` runs `git apply --3way` at the root of the repository you are in.
  What applies is **staged**; review it with `git diff --cached`, commit it, or
  `git restore --staged --worktree <path>` to drop it.
- A hunk that clashes with your own committed work is left with `<<<<<<<`
  markers where the preview showed it, and the command exits 1. Resolve them and
  `git add` them, as after a merge.
- What the apply touches is saved first: should git give up halfway through
  writing the tree (say, a directory it may not write to), odw puts back what it
  wrote, and says nothing was changed.
- It refuses while any path the diff touches has uncommitted changes (staged,
  unstaged or untracked) — which includes an agent you just applied that touched
  the same file. Commit or stash first, or pass `--force` to merge over staged
  edits (git still refuses files whose unstaged edits differ from the index).
- A kept branch is the other way in: `git switch odw/<run>/<agent>-<label>` to try
  it, or `git merge` / `git cherry-pick` it.

## 5. Apply them all, in order

```bash
odw apply $RUN --all --check   # every finished agent, previewed in agentId order
odw apply $RUN --all           # applied in that order, up to the first that would conflict
```

`--all` takes every agent that finished and kept a diff. The preview stacks each
agent on top of the ones before it, so two agents that edited different parts of
one file both show clean; an agent that would conflict is left out of the stack,
and the ones after it are previewed without it. Applying, `--all` stops before
the first agent that would conflict, and says which applied and which did not:

```
applied to /home/me/shop (staged, as git apply --3way does): agent 1 (fix:auth), agent 2 (fix:cache)
not applied: agent 3 (fix:billing) — stopped at agent 3 (fix:billing): it would conflict
  to apply it and resolve its conflicts by hand: odw apply 20261017-120000-3fa9c1 --agent 3
```

A failed agent's diff — the unfinished work of one that timed out, say — is not
taken by `--all` (it says so); apply it with `--agent` if you want it. Once you
have committed what applied, run `--all` again: the agents already in the tree
are reported `already applied` and skipped.

## 6. Verify before you keep it

```bash
odw apply $RUN --all --verify "npm test"
odw apply $RUN --agent fix:auth --verify "npm run build && npm test"
```

`--verify` runs the command at the root of the repository after each agent's
apply — through the shell, within the `timeout` setting (1800 s by default).
When it passes, the change stays, staged. When it fails or times out, that
agent's apply is **rolled back** and odw exits 1 with the end of the command's
output; Ctrl-C stops the command, rolls the apply back the same way, and ends
odw. With `--all`, the agents verified before it stay applied, and
the ones after it are not tried. A change that would conflict is not applied
under `--verify`: apply it without, and resolve it by hand.

The rollback is exact, and touches nothing else. Just before the apply, odw
saves the paths the diff touches — each file's bytes and mode, or a link's
target, and its index entries — and puts back exactly that. There is no
`git stash` and no `git reset`: your unrelated uncommitted work, staged or not,
stays as it is, and so does whatever the command wrote elsewhere (a build
directory, a log). If one of the touched files changed while the command ran —
the command rewrote it, or you edited it — that version is set aside first, in
the `changed/` folder of a saved copy odw names. Should the rollback itself
fail, odw says which paths still differ and where it kept their saved copy.

Make it the default for every `odw apply` (`--no-verify` skips it once, and
`--check` never runs it):

```json
{ "applyVerify": "npm test" }
```

## 7. When a diff is too big

A stored diff is capped at `maxDiffBytes` (2 MB by default). Past it, the file
keeps its head — cut at a line — and ends with one note line:

```
# odw: diff truncated at 2.0 MB — 3 files not shown; keep: true keeps the full change on a branch
```

The counts in `odw diff --stat` and the dashboard still describe the whole
change, but `odw apply` refuses a cut diff, and `--all` stops at it. Use the
agent's branch (rerun it with `keep: true` if it had none), or raise
`maxDiffBytes`.

## 8. Many runs: start from the review queue (ODW extension)

When diffs pile up over several runs, `odw review` says which to read first —
every kept diff not yet reviewed, dismissed or applied, riskiest first, each
point of its score with the reason (CI or migration paths, an `expect` miss,
files outside its scope, its size, …):

```bash
odw review --since 7d
odw diff $RUN --agent 3                      # read the one at the top
odw apply $RUN --agent 3 --check && odw apply $RUN --agent 3   # marked applied for you
odw review mark $RUN 5 dismissed --note "superseded by run …"
```

The dashboard's **Review** page shows the same queue and marks entries from the
browser; a mark is one line of the run's `reviews.jsonl`, with who made it.

## What is in a diff, and what is not

- **In:** everything the agent changed relative to the commit it started from,
  whether it staged or committed it in its worktree or not.
- **Not in:** what was in the worktree before the agent started — files
  `.worktreeinclude` copied or linked, and whatever `worktreeSetup` generated or
  rewrote (a lock file, codegen output) — unless the agent changed them
  afterwards. Files git ignores are never in it, and ODW never follows a symlink
  into its target.
- **Binary files** are named by their object id rather than carried in the diff;
  git applies them from your repository's object store, where ODW wrote them.
  Unreferenced objects can be pruned by `git gc` after a couple of weeks; a kept
  branch holds on to them for good.
- **Failed agents** keep their diffs too (say, the work of one that timed out),
  applied only by `--agent`, never by `--all`; a **stopped** run keeps none.
  `odw resume` brings a replayed agent's diff into the new run, so `odw diff` and
  `odw apply` work there as well.
- Agents that run without isolation edit your files directly and keep no diff:
  review those with `git diff`.
