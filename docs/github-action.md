# Run a workflow in GitHub Actions

**ODW extension.** `action/action.yml` is a composite action. It:

1. installs the odw release binary its own tag pins (or the `version` input)
   with [`scripts/install.sh`](../scripts/install.sh), checked against the
   release's `SHA256SUMS` — binary only, no skill. A release that publishes no
   `SHA256SUMS` (odw 0.4.x and older) is refused, never installed unverified;
   see [What the checksum does and does not prove](#what-the-checksum-does-and-does-not-prove);
2. runs `odw run <workflow> --wait --deadline <s>`, the deadline being the
   job's `timeout-minutes` less `margin-seconds` (default 300) and the time
   the action already spent — so when the work runs long, the run is
   **stopped** (status `stopped`; finished agents and their diffs kept, and
   what each isolated agent the deadline killed had changed so far, marked
   `partial: true`) while the job still has time to report, instead of the
   runner killing the step and everything after it;
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
| `args` | | the workflow's input, JSON or a plain string — written to a file and passed as `--args=@<file>`, so a value starting with `@` or `-` is taken as text, never as a file to read or a flag |
| `timeout-minutes` | `360` | **set it to the job's `timeout-minutes`** |
| `margin-seconds` | `300` | kept after the deadline for the summary, bundle and upload |
| `untrusted` | `auto` | `auto`: untrusted for pull requests from forks, every `pull_request_target`, a `workflow_run` whose triggering run came from another repository (a fork's), and `issues`, `issue_comment`, review and discussion events; or `true` / `false` |
| `untrusted-input` | `auto` | `auto`: as `untrusted` decides; or `true` / `false`. Untrusted input (`odw run --untrusted-input`): agents get no token-like variables beyond their own CLI's login, read access unless `permissions` says otherwise, and the first agent that may write waits at a checkpoint (notify's approve links answer it) until the deadline |
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
`untrusted: auto` runs every `pull_request_target`, and every `workflow_run`
that follows a fork's run, `--untrusted` — both carry the base repository's
secrets while acting on code or text a fork controls.

**Check out with `persist-credentials: false` for any event whose text or code
is not yours.** `actions/checkout` keeps the job's `GITHUB_TOKEN` in
`.git/config` (`http.https://github.com/.extraheader`) by default, so every
later step — and every agent that can read files, a read-only one included —
can read it, and an agent with a network can send it anywhere. Untrusted input
withholds token-like *variables*, not files. With untrusted input on, the run
step warns (in the log and the job summary) when git's config holds such a
header. `apply-pr` does not need it: its push authenticates through `gh` with
`github-token`, for that step only.

## What the checksum does and does not prove

The install step checks the downloaded binary's SHA-256 against the
`SHA256SUMS` published in the same GitHub release, and fails on a mismatch, on
a release without `SHA256SUMS`, or on a runner with no `sha256sum`/`shasum`.
That proves **integrity**: the binary is the file the release lists, not one
corrupted or swapped on the way. It does **not** prove **authenticity**: both
files come from the same release, so whoever can change the release's assets
(a compromised maintainer account or token) can change both. Pinning the
action to a commit SHA pins `install.sh` and this script, not the release's
assets.

Future work: pin each release's `SHA256SUMS` into the action at tag time (so an
asset changed after the tag fails the check), or verify signed build
provenance (GitHub artifact attestations / Sigstore).

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
        with:
          persist-credentials: false   # a fork's PR: no token in .git/config for agents to read
      - run: npm install -g @anthropic-ai/claude-code
      - uses: xz1220/open-dynamic-workflows/action@v0.X.Y   # pin the release you installed (a tag or a commit SHA)
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
        with:
          persist-credentials: false   # issue text is anyone's: no token in .git/config
      - run: npm install -g @openai/codex
      - uses: xz1220/open-dynamic-workflows/action@v0.X.Y   # pin the release you installed
        with:
          workflow: fix-issue
          args: '{"issue": ${{ github.event.issue.number }}}'
          timeout-minutes: 60
          adapter: codex
          apply-pr: true
          permissions: edit
          # untrusted: auto — issue text is written by anyone: runs --untrusted.
          # It must write and read the issue with GH_TOKEN, so it opts out of
          # untrusted input knowingly; see below.
          untrusted-input: false
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          GH_TOKEN: ${{ github.token }}
```

Only the issue *number* goes into `args`; the workflow reads the title and body
itself (`gh issue view`), so issue text never passes through the workflow file's
expressions. Left at `auto`, an issue event's run would also be untrusted
input: no `GH_TOKEN` for the agents, read-only agents, and a checkpoint before
the first that may write — the safer shape for a workflow that only reads and
comments through its own steps. Opting out hands the agents a token while they
read text anyone wrote; give such a job the narrowest `permissions:` block and a
`sandbox` with an egress allowlist. The draft PR is committed as `github-actions[bot]` unless the job
sets a git identity.

## On a schedule

`on: schedule` works the same way (`untrusted: auto` runs it trusted — the code
is your default branch). For runs on your own machine instead of a runner, see
`odw schedule` in the README.

## Exit codes, and `--deadline` outside CI

`odw run --deadline <s>` works anywhere: the worker stops the run once `s`
seconds have passed since it started, whatever mode it runs in. Finished
agents' results and diffs are kept, and so is what each isolated agent it killed
had changed so far, marked `partial: true` on its `agent_failed` event (`odw
apply` applies it only when that agent is named); a stop by a person keeps no
killed agent's change. With `--wait`
or `--fg` it then prints `{ "state": "stopped", "reason": "deadline",
"deadline": s, "finished": [{ agentId, label, phase, value }] }` and exits `3`.
`--timeout` is different: it only stops *waiting* (exit 124) and leaves the run
going — wrong on a runner that is about to be torn down.
