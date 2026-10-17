# Run a workflow on a schedule

ODW runs **no daemon**. Running a workflow on a timer is the operating
system's job — cron, launchd and systemd timers already do it well — so
`odw schedule` (an ODW extension) writes an entry into the scheduler your
machine already has, and that entry calls odw back when it is time.

## Recipe: `odw schedule`

```bash
# Every weekday at 08:00, run the "digest" workflow in ~/work/news.
odw schedule add digest digest --cron "0 8 * * 1-5" --cwd ~/work/news --args '{"since":"yesterday"}'

odw schedule list              # each schedule: backend, last run, next run (local time)
odw schedule run digest        # run it now, exactly as the scheduler will
odw schedule remove digest     # delete the OS entry and the definition
```

`add <name> <workflow>` takes the workflow the way `odw run` does — a name
from the workflow directories or a script path — and the same `--args`
(JSON, `@file.json` or a plain string), `--adapter` and `--config`. `--cwd`
is the run's working directory (`odw run --source`), the current one by
default. Names are lowercase letters, digits, `-` and `_`.

What the entry does over a hand-written cron line:

- **No overlap.** Each schedule has a lock
  (`~/.local/state/odw/schedules/<name>.lock`). When the time comes while the
  previous run is still going, the new one is skipped — logged, exit 0 —
  instead of stacking on top of it. A lock left by a crash or a reboot is
  taken over.
- **A log you can read.** `~/.local/state/odw/schedules/<name>.log` gets one
  line per run — `started`, then `done … in 4m12s`, `failed … after 52s: <why>`,
  `stopped`, `skipped` or `failed to start: <why>` — and whatever else the
  entry printed. The run itself keeps its full record (`odw logs <run_id>`,
  `odw serve`).
- **An honest exit code.** Like `odw run --wait`: 0 when the run finished
  `done` (or was skipped), 1 when it failed, stopped, or could not start.
- **Nothing left to the scheduler's environment.** `add` records the absolute
  path of node and odw and your current `PATH` — cron's own is `/usr/bin:/bin`,
  where agent CLIs installed in `~/.local/bin` or Homebrew are not found — and
  pins `--config` (or `$ODW_CONFIG`).
- **Fail fast.** `add` resolves and loads the workflow, the adapter and the
  config now, not at the first 3 a.m. run.
- **`odw schedule list`** shows each schedule's last run (id, state, when),
  its next run, computed from the cron expression in local time, and flags an
  OS entry that was edited away.

`--dry-run` prints exactly what `add` would write — the definition, the
crontab block, the plist or the systemd units — and writes nothing.

## Backends

`add` picks **launchd on macOS** and **cron elsewhere**; `--backend
cron|launchd|systemd` chooses (systemd only when asked). Every entry runs
`odw schedule run <name>` with `PATH` set, its output appended to the
schedule's log.

| | cron | launchd | systemd (user) |
| --- | --- | --- | --- |
| What `add` writes | a block between `# odw:begin <name>` and `# odw:end <name>` in your crontab (`crontab -l`, then `crontab -`); every other line stays as it is | `~/Library/LaunchAgents/dev.odw.schedule.<name>.plist`, loaded with `launchctl bootstrap gui/<uid>` | `~/.config/systemd/user/odw-<name>.service` and `.timer`, then `systemctl --user daemon-reload` and `enable --now` |
| A start missed while the machine was off or asleep | skipped | runs once when the Mac wakes; skipped if it was off | runs once when the machine is back (`Persistent=true`) |
| Limits | — | at most 64 calendar entries: `*/2 9-17 * * 1-5` needs 1350, so use cron for it | user timers run only while you are logged in, unless you run `loginctl enable-linger` once |

`odw schedule remove` takes out exactly what `add` wrote, and is safe to run
again or after you deleted the entry by hand.

**Windows** is not supported yet: `odw schedule add` prints a
`schtasks /Create` line that runs the workflow with `odw run --wait` (Task
Scheduler then skips a start while the previous run goes on), and writes
nothing.

## The cron expression

Five fields — minute (0-59), hour (0-23), day of month (1-31), month (1-12 or
`jan`-`dec`), day of week (0-7 or `sun`-`sat`; 0 and 7 are both Sunday) — each
a list of `*`, `N`, `N-M`, `*/S` or `N-M/S`. When day of month and day of week
are both restricted, a day matching either one fires, as in cron. Anything
cron itself does not take is refused with the reason: `@daily` (write
`0 0 * * *`), `L`, `W`, `#`, `?`, `5/15` (write `5-59/15`), a sixth field, or
a date that never comes (`0 0 30 2 *`).

## Hearing about failures

A scheduled run is an ordinary run, so the [`notify`](notify.md) hooks fire
when it ends. To hear only about the runs that went wrong:

```jsonc
"notify": { "webhook": "https://hooks.example.com/YOUR/PATH", "on": ["failed", "stopped"] }
```

A run that cannot even start — its workflow was deleted, its config no longer
parses — has no run to report on: it is the `failed to start` line in the
schedule's log and a non-zero exit (which cron mails you when `MAILTO` is set).

A run that reaches a [`checkpoint()`](../../README.md#human-checkpoints-odw-extension)
waits for its answer while holding the schedule's lock, so the next starts
are skipped until someone answers; the log says which command does. Give
unattended checkpoints a `timeout`.

## Where things live

| | |
| --- | --- |
| `~/.config/odw/schedules.json` | the definitions — the source of truth |
| `~/.local/state/odw/schedules/<name>.log` | one line per run, plus the entry's own output |
| `~/.local/state/odw/schedules/<name>.last.json` | the last run: id, state, when |
| `~/.local/state/odw/schedules/<name>.lock` | held while a run goes on |

## Manual alternative: a raw cron line

`odw schedule` writes this for you, but a cron line around `odw run --wait`
still works:

- **Run by name.** `odw run <name>` resolves a workflow from the managed
  directories (`./.odw/workflows`, `./.claude/workflows`,
  `~/.odw/workflows`, then `~/.claude/workflows`), so a cron line never
  hard-codes a path.
- **`--wait` gives a real exit code.** With `--wait`, `odw run` blocks until the
  run reaches a terminal state and exits **0** on `done`, **non-zero** on
  `failed`/`stopped`. Without `--wait` it is fire-and-forget and returns 0 as
  soon as the background run is launched — so for cron you almost always want
  `--wait`, otherwise cron can't tell success from failure.

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

Because the exit code is honest, you can chain a notifier:

```cron
0 8 * * * flock -n /tmp/odw-digest.lock odw run digest --wait || curl -fsS -d "digest failed" https://example.test/alert
```

On macOS, `launchd` is the native scheduler; the same contract applies —
invoke `odw run <name> --wait` from a `launchd` job and key off its exit status.
