# Run a workflow in GitHub Actions

**ODW extension.** `action/action.yml` is a composite action. It:

1. installs the odw release binary its own tag pins (or the `version` input)
   with [`scripts/install.sh`](../scripts/install.sh), checked against the
   release's `SHA256SUMS` — binary only, no skill;
2. runs `odw run <workflow> --wait --deadline <s>`, the deadline being the
   job's `timeout-minutes` less `margin-seconds` (default 300) and the time
   the action already spent — so when the work runs long, the run is
   **stopped** (status `stopped`, finished agents and their diffs kept) while
   the job still has time to report, instead of the runner killing the step and
   everything after it;
3. writes the run's spend receipt, agent table and failures to the job summary;
4. uploads `odw bundle <run>` as the artifact `odw-<run>` — download it and
   `odw view <file>.odwrun` to see the whole run in the dashboard;
5. optionally (`apply-pr: true`, when the run finished `done`) opens a draft
   PR of every isolated agent's change with `odw apply --all --pr`. It never
   merges.

Why `action/` and not the repository root: the root is the npm package and the
CLI's source; a subdirectory keeps the action out of it, at the cost of a
longer `uses:` (`xz1220/open-dynamic-workflows/action@<tag>`) and no Marketplace
listing, which needs a root `action.yml`. Pin it to a release tag, or better a
commit SHA.

## Inputs and outputs

| input | default | |
| --- | --- | --- |
| `workflow` | (required) | a path in the repository, or a managed workflow name |
| `args` | | the workflow's input, JSON or a plain string |
| `timeout-minutes` | `360` | **set it to the job's `timeout-minutes`** |
| `margin-seconds` | `300` | kept after the deadline for the summary, bundle and upload |
| `untrusted` | `auto` | `auto`: untrusted for pull requests from forks and for `issues`, `issue_comment`, review and discussion events; or `true` / `false` |
| `config`, `adapter`, `permissions` | | passed to `odw run` (`--config`, `--adapter`, `--permissions`) |
| `version` | the action's tag | the odw release to install |
| `bundle` | `true` | upload `odw bundle` |
| `apply-pr`, `apply-pr-base` | `false`, | open a draft PR when the run is done |
| `github-token` | `github.token` | what `gh` uses for `apply-pr` |

Outputs: `run-id`, `state` (`done`, `stopped-at-deadline`, `timed-out`,
`failed`), `exit-code` (`odw run --wait`'s: 0 done, 1 failed, 3 stopped at its
deadline) and `odw-version`. The run step fails the job unless the run finished
`done`; the summary and the bundle are written either way.

## Secrets

The agent CLIs need their credentials, exactly as on your machine: install the
CLI in an earlier step, and pass its key as an environment variable from a
repository or environment secret. Never write a key into the workflow file, the
`args`, or a committed `odw.config.json`.

```yaml
env:
  ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}   # claude
  OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}         # codex
```

ODW redacts the values of secret-named variables from what it keeps — the
events, saved results, transcripts and the bundle — so an artifact never
carries the key even if an agent printed it (see *Secrets in what ODW keeps* in
the README). Keep `permissions:` on the job as narrow as the run needs:
`contents: read` unless you use `apply-pr`.

Pull requests from forks get no repository secrets (`pull_request`), which is
GitHub's protection; do not work around it with `pull_request_target` and a
checkout of the fork's code unless the run is untrusted and sandboxed.

## Example: review every pull request

```yaml
name: odw review
on:
  pull_request:

permissions:
  contents: read

jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - run: npm install -g @anthropic-ai/claude-code
      - uses: xz1220/open-dynamic-workflows/action@v0.7.0   # pin a tag or a commit SHA
        with:
          workflow: .odw/workflows/review.js
          args: '{"pr": ${{ github.event.pull_request.number }}}'
          timeout-minutes: 30            # the job's
          adapter: claude
          permissions: read
          # untrusted: auto — a fork's pull request runs --untrusted
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

With `untrusted: auto`, a pull request from a fork runs `--untrusted`: each
agent CLI ignores the repository's `CLAUDE.md`, hooks, MCP servers and settings
where it can, and odw does not read the repository's own `odw.config.json`
(give `config:` a file you control instead). A pull request from a branch of
the same repository runs trusted.

## Example: fix an issue when it is labelled, as a draft PR

```yaml
name: odw fix
on:
  issues:
    types: [labeled]

permissions:
  contents: write
  pull-requests: write

jobs:
  fix:
    if: github.event.label.name == 'odw'
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v4
      - run: npm install -g @openai/codex
      - uses: xz1220/open-dynamic-workflows/action@v0.7.0
        with:
          workflow: fix-issue
          args: '{"issue": ${{ github.event.issue.number }}}'
          timeout-minutes: 60
          adapter: codex
          apply-pr: true
          # untrusted: auto — issue text is written by anyone: runs --untrusted
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          GH_TOKEN: ${{ github.token }}
```

Only the issue *number* goes into `args`; the workflow reads the title and body
itself (`gh issue view`), so issue text never passes through the workflow file's
expressions. The draft PR is committed as `github-actions[bot]` unless the job
sets a git identity.

## On a schedule

`on: schedule` works the same way (`untrusted: auto` runs it trusted — the code
is your default branch). For runs on your own machine instead of a runner, see
`odw schedule` in the README.

## Exit codes, and `--deadline` outside CI

`odw run --deadline <s>` works anywhere: the worker stops the run once `s`
seconds have passed since it started, whatever mode it runs in. With `--wait`
or `--fg` it then prints `{ "state": "stopped", "reason": "deadline",
"deadline": s, "finished": [{ agentId, label, phase, value }] }` and exits `3`.
`--timeout` is different: it only stops *waiting* (exit 124) and leaves the run
going — wrong on a runner that is about to be torn down.
