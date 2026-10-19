# Multi-repo runs

English · [简体中文](../zh-CN/guides/multi-repo.md)

A run declares the repositories it may touch; each agent names the one it works in.

## Several repositories in one run (ODW extension)

A change that spans a frontend, a backend and a shared library is one piece of work.
Name the other repositories by alias and point each agent at one; their changes stay
one run, reviewed and applied together:

```bash
odw run ./wf.js --repo api=../api --repo web=../web    # alias=path, repeatable
```

```jsonc
// odw.config.json — paths relative to the run's source, ~ allowed
{ "repos": { "api": "../api", "web": "../web" } }
```

```js
export const meta = { name: 'rename-field', description: '…', repos: ['api', 'web'] }
await parallel([
  () => agent('Rename user.login to user.handle in the API.', { repo: 'api', isolation: 'worktree', scope: ['src/**'] }),
  () => agent('Follow the rename in the UI.', { repo: 'web', isolation: 'worktree', expect: { command: 'npm test' } }),
])
const { stdout } = await exec('git log -1 --format=%h', { repo: 'api' })
```

- **Declared, never pointed at.** `agent(p, { repo })` and `exec(cmd, { repo })` take an
  alias the run declares — the `repos` setting, or `--repo name=path` over it — never a
  path. An alias the run lacks fails the run before the call starts; `meta.repos` lists
  the aliases a workflow needs, and a run without one of them fails before any agent
  does. Each path must be a git repository (`--repo` is checked before the run exists).
  The run logs the repositories it has, and status.json keeps them as `repos`.
  `--repo` is kept for `odw rerun`, `resume` and `replay`.
- **Everything per repository.** The agent's CLI runs at that repository's top level —
  with `isolation: "worktree"` in a worktree of it, whose diff is kept as any isolated
  agent's. Its `expect` (`files`, `untouched`, `command`), `scope` and out-of-scope check
  read that repository; scopes in different repositories never wait for each other. An
  in-place agent that may write gets that repository's own safety snapshot
  (`odw restore <run> --repo api` puts it back). `exec()`'s `cwd` resolves against it.
  Its `agent_started` event carries `repo: { name, path }`.
- **Review and apply.** `odw diff` names each agent's repository (`# odw: agent 2 · fix ·
  repo api · …`; `--stat` adds a REPO column, `.` for the source; `--repo <name|.>` shows
  one), as do `odw review` and the dashboard's Changes tab, which groups the agents by
  repository. `odw apply --agent N` applies to the repository the agent worked in —
  the path the run declared for its alias (`status.json`'s `repos`, checked against
  `--repo`), refused when the event log names another or the run never declared it;
  the source's agents still go to the working tree you run odw in (refused when that is
  one of the run's other repositories). `odw apply --all` previews every repository
  first and writes nothing unless each would apply cleanly — then applies them one by
  one, the source first; a repository whose apply fails (its `--verify`, say) is rolled
  back as `odw apply` always does, the ones before it stay and the ones after it are not
  written. `--repo <name|.>` applies one repository's agents; `--pr` and `--resolve`
  take one repository at a time.
- **Untrusted runs** (`--untrusted`) take no path from the repository's own config
  outside the repository: such an alias is dropped, and the run says so. Your own
  config (`--config`, `~/.config/odw/config.json`) and `--repo` name any.
- **Not in this version:** an agent writes to one repository (split a cross-repository
  change into one agent per repository, and use the [notes board](../reference/workflow-api.md#notes-between-parallel-agents-odw-extension)
  to keep them in step); no atomic merge across repositories; no discovery of
  submodules or sibling directories; `--repo` with `--on ssh://` is refused; one PR per
  repository with `odw apply --all --pr --repo <name>`, without cross-links; `odw gc`
  finds orphaned worktrees of the source repository only.

Claude Code's Workflow tool ignores `repo` and `meta.repos`: there every agent works in
the session's repository.
