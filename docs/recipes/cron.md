# Scheduling a workflow with OS cron

ODW ships **no scheduler and no daemon**. Running a workflow on a timer is the
operating system's job — `cron` already does it well. ODW only has to make a run
*scriptable*, and it does:

- **Run by name.** `odw run <name>` resolves a workflow from the managed
  directory (`./.odw/workflows`, then `~/.odw/workflows`), so a cron line never
  hard-codes a path.
- **`--wait` gives a real exit code.** With `--wait`, `odw run` blocks until the
  run reaches a terminal state and exits **0** on `done`, **non-zero** on
  `failed`/`stopped`. Without `--wait` it is fire-and-forget and returns 0 as
  soon as the background run is launched — so for cron you almost always want
  `--wait`, otherwise cron can't tell success from failure.

## Recipe

```cron
# Run the "digest" workflow every day at 08:00.
# --wait    → cron sees the run's real success/failure exit code
# flock -n  → skip this tick if the previous run is still going (no overlap)
0 8 * * * flock -n /tmp/odw-digest.lock odw run digest --wait >> ~/.odw/log/digest.log 2>&1
```

Notes:

- **`flock`** (util-linux; on macOS install `flock` via Homebrew, or drop it if
  overlap is acceptable) takes the lock for the duration of the command and
  releases it on exit, so a long run never stacks on top of itself.
- **Redirect output** to a log you can inspect; cron mails stdout/stderr by
  default, which gets noisy.
- **PATH in cron is minimal.** If `odw` isn't found, use its absolute path
  (`which odw`) or set `PATH=` at the top of the crontab.
- **Per-run inputs:** add `--args '{"date":"today"}'` (or `--args @file.json`)
  exactly as on the command line.

## Reacting to failure

Because the exit code is honest, you can chain a notifier:

```cron
0 8 * * * flock -n /tmp/odw-digest.lock odw run digest --wait || curl -fsS -d "digest failed" https://example.test/alert
```

## macOS: launchd alternative

`cron` works on macOS, but `launchd` is the native scheduler. The same contract
applies — invoke `odw run <name> --wait` from a `launchd` job and key off its
exit status. ODW adds nothing here; the workflow is just a command that returns
0 or non-zero.
