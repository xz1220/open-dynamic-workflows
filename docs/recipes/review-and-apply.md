# Reviewing and applying what isolated agents changed

Agents working side by side are cheap; reviewing what they did is the slow
part, and agents editing one checkout at once trample each other's files. Give
each its own worktree with `isolation: "worktree"`: ODW keeps what every one of
them changed as a diff in the run directory. You review the diffs, then apply
the ones you want — one at a time, with git's three-way merge. (`odw diff`,
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

Agents that changed the same file collide: once the first is applied, the second
waits until you commit the first (or pass `--force`), and may conflict — decide
which goes first. The dashboard (`odw serve`) shows the same diffs, file by file,
in the run's **Changes** tab.

## 3. Read a diff

```bash
odw diff $RUN --agent fix:auth           # by label, or by id: --agent 1
odw diff $RUN --agent 1 --stat           # just its files and line counts
odw diff $RUN --agent 1 > auth.patch     # it is a plain patch git can read
odw diff $RUN                            # all of them, each under a "# odw: agent …" line
```

## 4. Check, then apply

```bash
odw apply $RUN --agent fix:auth --check  # what would apply, what would conflict — changes nothing
odw apply $RUN --agent fix:auth          # apply it to the working tree you are in
odw apply $RUN --agent fix:cache         # agents that changed other files apply on top
```

- `odw apply` runs `git apply --3way` at the root of the repository you are in.
  What applies is **staged**; review it with `git diff --cached`, commit it, or
  `git restore --staged --worktree <path>` to drop it.
- A hunk that clashes with your own committed work is merged three-way and left
  with `<<<<<<<` markers; the command lists those files and exits 1. Resolve them
  and `git add` them, as after a merge.
- It refuses while any path the diff touches has uncommitted changes (staged,
  unstaged or untracked) — which includes an agent you just applied that touched
  the same file. Commit or stash first, or pass `--force` to merge over staged
  edits (git still refuses files whose unstaged edits differ from the index).
- A kept branch is the other way in: `git switch odw/<run>/<agent>-<label>` to try
  it, or `git merge` / `git cherry-pick` it.

## 5. When a diff is too big

A stored diff is capped at `maxDiffBytes` (2 MB by default). Past it, the file
keeps its head — cut at a line — and ends with one note line:

```
# odw: diff truncated at 2.0 MB — 3 files not shown; keep: true keeps the full change on a branch
```

The counts in `odw diff --stat` and the dashboard still describe the whole
change, but `odw apply` refuses a cut diff. Use the agent's branch (rerun it with
`keep: true` if it had none), or raise `maxDiffBytes`.

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
- **Failed agents** keep their diffs too (say, the work of one that timed out); a
  **stopped** run keeps none. `odw resume` brings a replayed agent's diff into the
  new run, so `odw diff` and `odw apply` work there as well.
- Agents that run without isolation edit your files directly and keep no diff:
  review those with `git diff`.
