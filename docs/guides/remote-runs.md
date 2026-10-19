# Remote runs: CI and your own server

English · [简体中文](../zh-CN/guides/remote-runs.md)

Runs that happen on another machine. The GitHub Action has its own page: [`docs/github-action.md`](../github-action.md).

## Run in GitHub Actions (ODW extension)

A composite action runs a workflow in CI and stops it **before** the job times
out, so its output survives:

```yaml
- uses: xz1220/open-dynamic-workflows/action@v0.X.Y   # pin the release you installed
  with:
    workflow: .odw/workflows/review.js
    timeout-minutes: 30        # the job's timeout-minutes
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

It installs the pinned odw release (SHA-256 checked against the release's
`SHA256SUMS` — integrity, not authenticity; a release without it is refused),
runs `odw run --wait --deadline` with a margin before the job's timeout (the
`args` input goes through a file, never as an argument), writes the spend
receipt, agent table and failures to the job summary, uploads `odw bundle` as an
artifact, and with `apply-pr: true` opens a draft PR. Pull requests from forks,
every `pull_request_target`, a `workflow_run` after a fork's run, and issue or
comment events run `--untrusted`. Inputs, secrets and examples:
[`docs/github-action.md`](../github-action.md).

## Run on your own server (ODW extension)

A laptop that sleeps pauses its runs. Start one on a machine you own instead —
over plain SSH, with no daemon on either side:

```bash
odw run review --on ssh://me@box:2222            # sync the project, start it there detached, print its run id
odw run wf.js --on ssh://box/srv/work/app --sync rsync --args @in.json --adapter codex
odw status $RUN --on ssh://box                   # the same command, run by the odw over there
odw logs $RUN --on ssh://box --follow            # …and odw attach $RUN --on ssh://box shows the live view
odw approve $RUN --on ssh://box                  # answer its checkpoint there (reject, pause, stop, resume too)
odw pull $RUN --from ssh://box                   # copy it here: odw status, diff, apply, compare, the dashboard
```

`--on ssh://[user@]host[:port][/path]` first checks the remote has odw (`odw --version`,
else `npx --no-install odw`) and, when it has not, says how to install it. Then it
copies the project to the remote workdir — `~/odw-remote/<repo>` unless the URL names
one (`ssh://box/~/work/app` is home-relative, `ssh://box/srv/app` absolute):

- `--sync git` (the default): a `git bundle` of HEAD, plus one patch of your
  uncommitted changes — staged, unstaged and untracked files, .gitignore'd ones left
  out — made with a temporary index, so yours is untouched. The run prints which
  commit and how many uncommitted files went along.
- `--sync rsync`: the directory mirrored with `rsync` (needed on both ends),
  .gitignore'd files left out.

The workdir is odw's: each sync replaces what the last one left (files ignored there,
such as a remote `node_modules`, stay), and a directory odw did not make is refused,
never overwritten. A workflow from outside the project (a personal or plugin one)
is sent along. Then `odw run … --detach` starts it there, and the remote run id is
printed with the commands that follow it. `--adapter`, `--permissions`, `--untrusted`,
`--sandbox`, `--sandbox-image` and `--budget` go along; `--config`, `--runs-root`,
`--wait`, `--fg` and `--timeout` are refused (watch it with `odw attach --on`).

**The remote uses its own odw config and agent CLI logins.** Nothing of your
`~/.config/odw/config.json` or your CLIs' logins is copied: install odw there, log in
its agent CLIs there, and give it a config there if it needs one (a project's
`odw.config.json` travels with the project like any file in it). No secret is put on
a command line — `--args` travels as a file on ssh's stdin — and ssh is your own, with
your `~/.ssh/config`, keys and agent; `ODW_SSH` replaces the `ssh` binary (and
`ODW_RSYNC` the `rsync` one).

`odw status|logs|attach|approve|reject|pause|stop|resume <run> --on ssh://host` run that
command on the remote odw and pass its output and exit code back (`ssh -t` for attach,
`logs --follow` and `approve --edit` in a terminal, so attach is the live view; a
`--payload @file` names a file over there). `odw pull <run> --from ssh://host` copies
the run directory into your local runs root — rsync when this machine has it, else tar
over ssh — and marks it `origin: "remote"` with `remote: { url, host, dir, pulledAt }` in
its `meta.json`. The copy is staged under the runs root and moved into place only once it
is whole, so a failed pull leaves nothing (an earlier copy stands); symbolic links,
devices and fifos never come back (rsync `--no-links`, and any the copy holds are
removed and named). A run still going can be pulled again and again: the copy is a
snapshot (the remote worker's pid is dropped, so here it reads as stale until it ends),
and `odw status` says where it came from.

**A pulled run is answered where it runs.** Approving, rejecting, pausing, stopping or
resuming the copy here would change only the copy, so `odw approve|reject|pause|stop|resume`
and the dashboard (409) refuse it and name the command to run instead:
`odw approve <run> --on ssh://host`.
