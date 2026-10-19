# Safety and trust

English · [简体中文](../zh-CN/guides/safety-and-trust.md)

What agents may do, what odw keeps from them, and what it keeps from others.

## Permissions (ODW extension)

ODW runs every agent at a **permission tier**:

- **`read`** — look, never edit or run commands: for research and review fan-outs.
- **`edit`** — the default, and exactly what each built-in has always run with.
- **`full`** — no sandbox and no approvals: an explicit opt-in, for isolated machines.

Set the run's tier in the config (`"permissions": "read"`) or per run with
`odw run|rerun|resume --permissions read` (rerun and resume otherwise keep the source
run's). An adapter's own `permissions` and an `agent()` call's `permissions` can only
**lower** it — an agent runs at the lowest of the three:

```js
// Reviewers that cannot touch the tree, in a run that may edit.
const reviews = await parallel(files.map((f) => () =>
  agent(`Review ${f} for bugs; report, do not fix`, { permissions: 'read', label: f })))
```

An agent that asks for more than its run allows fails before it starts, naming both
tiers (`agent() asked for permissions "full", but the run allows only "edit" …`); in a
`parallel()` its slot is `null`, like any failed agent. Each tier's flags take the place
of the `{permission_args}` element of the adapter's command. Only mappings a CLI's own
docs confirm for headless runs are filled in:

| Adapter | `read` | `edit` (default) | `full` |
| --- | --- | --- | --- |
| `claude` | `--permission-mode dontAsk --tools Read,Glob,Grep,WebSearch,WebFetch --allowedTools WebSearch WebFetch --strict-mcp-config` | `--permission-mode acceptEdits --allowedTools WebSearch WebFetch` | `--permission-mode bypassPermissions` |
| `codex` | `--sandbox read-only` | `--sandbox workspace-write` | `--sandbox danger-full-access` |
| `gemini` | `--approval-mode default` | `--approval-mode auto_edit` | `--approval-mode yolo` |
| `qwen` | refused | `--approval-mode auto-edit` | `--approval-mode yolo` |
| `kimi` | refused | its print mode (no flag) | runs `edit` |
| `omp` | refused | `--approval-mode yolo` | runs `edit` |
| `kilo`, `opencode` | refused | `--auto` | runs `edit` |
| `cursor` | refused | `--force` | runs `edit` |
| `agy` | refused | `--mode accept-edits` | `--mode accept-edits --dangerously-skip-permissions` |

- **`read`.** On `claude`, `dontAsk` denies anything that would prompt and `--tools`
  leaves only read-only built-in tools — there is no Edit, Write or Bash for an allow
  rule in your settings to bring back — plus the web; no MCP server starts. `codex`
  runs in its read-only sandbox: it can read files, not edit them or run commands
  that need an approval (`codex exec` asks nobody). `gemini` asks before write and
  shell tools in `default` mode, and headless that is a deny.
- **refused.** A CLI with no verified read-only mode fails the agent before it starts:
  `kimi cannot run read-only (…); use an adapter that can (--adapter claude, …), or
  run with --permissions edit`. Qwen's docs do not say what its `default` mode does
  headless, so it has no `read` either. Nor does `agy`: headless it may always write
  files in its workspace, and its plan mode only prefixes the prompt.
- **`agy`.** Headless, a tool call that needs an approval is soft-denied: at `edit`,
  shell commands, web and MCP tools run only where your own `permissions.allow` rules
  in `~/.gemini/antigravity-cli/settings.json` (or its `toolPermission` preset) allow
  them. What it refused comes back as `denied`, like Claude Code's.
- **runs `edit`.** A CLI with no separate full mode runs its `edit` flags, and the run
  logs that once per adapter. For `kimi`, `omp`, `kilo`, `opencode` and `cursor`,
  `edit` already approves every tool call headless — mind that before handing them a
  repository.
- **Your own adapters** declare their flags the same way. One without `permissionArgs`
  runs its command as configured, treated as `edit`; under another tier the run logs
  once that ODW cannot enforce it.

```jsonc
{
  "permissions": "read", // the run's tier; odw run --permissions overrides it
  "adapters": {
    // cap one built-in: an entry without "command" changes only the fields it sets
    "codex": { "permissions": "read" },
    "my_wrapper": {
      "command": ["my-agent", "{permission_args}", "--cwd", "{workspace}"],
      "permissionArgs": { "read": ["--read-only"], "edit": [], "full": ["--yolo"] } // "edit" is required
    }
  }
}
```

Every start prints the tier each installed adapter runs with —
`permissions: read — claude read, codex read, kimi refused (no read mode)` — in the
live view, after `--wait`'s first line and after a detached run's id. Each
`agent_started` event (and `odw agents --json`) carries the agent's `permissions`, and
`odw doctor` lists every adapter's tiers. A tier governs what agents may do: `exec()`
commands are the workflow's own and are not affected. `read` is not a sandbox for code
you do not trust either — Claude Code, for one, still runs a repository's hooks under
`-p`; run such a repository [untrusted](#untrusted-repositories-odw-extension).

**Codex and MCP tools that ask for approval** ([#23](https://github.com/xz1220/open-dynamic-workflows/issues/23)).
No tier makes `codex exec` approve an MCP tool call. It asks nobody, so a tool call that
needs an approval — a Figma write, say — is cancelled (`user cancelled MCP tool call`),
and `full` lifts the sandbox (`--sandbox danger-full-access`) but is not documented to
approve MCP calls ([openai/codex#24135](https://github.com/openai/codex/issues/24135)).
Pre-approve that one tool in Codex's own config instead
([Codex MCP docs](https://developers.openai.com/codex/mcp)):

```toml
# ~/.codex/config.toml
[mcp_servers.figma.tools.use_figma]
approval_mode = "approve"
```

Or, only on an isolated machine, make codex's `full` the flag that skips every approval
and the sandbox, and run with `--permissions full` (`permissionArgs` replaces the
built-in's whole, so repeat the other tiers):

```jsonc
"adapters": {
  "codex": {
    "permissionArgs": {
      "read": ["--sandbox", "read-only"],
      "edit": ["--sandbox", "workspace-write"],
      "full": ["--dangerously-bypass-approvals-and-sandbox"]
    }
  }
}
```

On `claude`, `full` (`bypassPermissions`) runs tool calls without asking.

**What agents see of your environment.** Agent CLIs inherit ODW's whole environment
by default. `"agentEnv": "minimal"` passes only what a CLI needs to start (`PATH`,
`HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_*`, `TERM`, `TMPDIR`, `TZ`, and the
Windows system variables), the auth and config variables the built-in CLIs document
(`ANTHROPIC_*`, `CLAUDE_*`, `OPENAI_*`, `CODEX_*`, `GEMINI_*`, `GOOGLE_*`,
`DASHSCOPE_*`, `QWEN_*`, `MOONSHOT_*`, `KIMI_*`, `CURSOR_*`, `OPENCODE_*`, the proxy
variables and `NODE_EXTRA_CA_CERTS`), the adapter's `env`, `ODW_*`, and the names or
`*` globs you list in `agentEnvPass` — so a cloud key or a registry token in your shell
does not reach every agent:

```jsonc
{ "agentEnv": "minimal", "agentEnvPass": ["AWS_*"] } // e.g. Claude Code on Bedrock
```

If a CLI cannot log in under `minimal`, add what it needs to `agentEnvPass`
(`odw doctor --smoke` makes one real call to check). `exec()` commands, `worktreeSetup`
and the `notify` hooks keep the whole environment.

## Safety snapshot and destructive git commands (ODW extension)

An agent that works in place — the dialect's default, without `isolation: "worktree"`
— works beside your uncommitted changes, and one `git reset --hard` throws them away
([claude-code#33850](https://github.com/anthropics/claude-code/issues/33850)). So
before a run's first in-place agent at `edit` or `full` starts, odw keeps what your
working tree holds that git does not: `git stash create` for the tracked changes,
staged and not, plus the untracked files `.gitignore` does not exclude, written to
one commit at `refs/odw/safety/<run>` — your tree, index and stash list are left as
they are. A clean tree gets no snapshot; ignored files are never kept, nor untracked
files over 50 MB, nor untracked files whose names say they hold a secret (`.env`,
`.env.*`, `*.pem`, `*.key`, `*.p12`, `id_rsa`, `id_ed25519`, `id_ecdsa`,
`credentials.json`) — the snapshot names each. The run says so in a `safety_snapshot`
event; when odw cannot take one (not a git repository, a merge in progress) it logs
why and the agent goes on.

The snapshot is a git ref **in your repository**: until `odw gc` deletes it with its
run (past `retention`), its commit holds your other untracked files as they were — a
draft, a local config, a secret under a name odw does not know. Nothing you push by
branch or tag carries it, but `git push --mirror` (every ref) would publish it.

```sh
odw restore $RUN --check   # preview: each file clean, CONFLICT (with its lines) or already applied
odw restore $RUN           # put the working tree back as the snapshot kept it (git apply --3way, staged)
```

`odw restore` works in the run's source repository and goes through
[`odw apply`](reviewing-and-applying.md#review-and-apply-what-isolated-agents-changed-odw-extension)'s
machinery: files the tree already holds as kept (an untracked file a reset left
alone) are left out, a path with uncommitted changes refuses unless `--force`, and
when HEAD has moved since (`git reset --hard origin/main`) the changes go on top of
it three-way, and the commit HEAD was at is named.

odw cannot stop a command before it runs — that takes each CLI's own hooks — but it
reads what agents run as they run (Claude Code's `Bash`, Codex's
`command_execution`, the kilo, opencode and agy shell tools) for `git reset --hard`,
`git checkout .` / `-- .` / `--force`, `git switch --force` / `--discard-changes`,
`git restore .`, `git clean -f…`, `git push --force` (`-f`, `--force-with-lease`,
`+refspec`), `git push --mirror`, `git push --delete` (`-d`, `:refspec`), `git stash
drop|clear` and `git branch -D`. Command lines are split as a shell would (`cd x &&
…`, `bash -lc '…'`, `sudo`, `env`, `if …; then …`, `! …`, `git -C dir …`); text in
quotes is not a command. Each hit is a `destructive_git` event — in `odw logs`, the
live view, and the agent's drawer and node in the dashboard — naming `odw restore
<run>` when there is a snapshot. Commands that only reset a working tree do not count
for an isolated agent: its worktree is its own — unless git is pointed elsewhere
(`git -C <dir>`, `--git-dir`, `--work-tree`), which odw cannot place and counts as in
place.

This detection is **advisory and best effort**, not a guard: it sees only what a
command line says. It misses git run by another program — `find . -exec git checkout
-- {} +`, `… | xargs git checkout --`, a script or Makefile —, a git alias (`git
nuke` for `reset --hard`), a `cd` into another worktree before a plain `git reset
--hard`, and any CLI that prints no tool calls (a text adapter). The snapshot, not
the detection, is what gets work back.

```jsonc
{ "destructiveGit": "fail" } // default "warn": recorded; "fail": the agent fails with reason destructive_git once its CLI is done
```

## Untrusted repositories (ODW extension)

Running agents on someone else's repository is dangerous: its CLAUDE.md or AGENTS.md
steer the agent, and its hooks, MCP servers and project settings run inside it. Run
such a repository **untrusted** — `odw run|rerun|resume --untrusted`, or
`"trust": "untrusted"` in your config (the default is `"trusted"`; a rerun or resume
of an untrusted run stays untrusted). Each CLI then runs in the way of ignoring the
repository its own docs give, after its tier's flags; where it has none, the run says
so once per adapter — never silently:

| Adapter | Untrusted | What still reaches the agent |
| --- | --- | --- |
| `claude` | `--safe-mode` (CLAUDE.md, skills, plugins, hooks, MCP servers, commands, agents, workflows off; auth works) | nothing |
| `qwen` | `--safe-mode` (context files, hooks, extensions, skills, MCP servers off) | nothing |
| `omp` | `--no-extensions --no-skills --no-rules` | AGENTS.md, CLAUDE.md, hooks, MCP config |
| `codex` | no documented way | AGENTS.md (its `.codex/` config, hooks and rules load only for a project you trusted) |
| `gemini` | no documented way (its untrusted-folder mode exits headless) | GEMINI.md, `.gemini/settings.json` |
| `kimi` | no documented way | AGENTS.md, skills |
| `kilo`, `opencode` | no documented way | AGENTS.md, project config, `.kilo/` / `.opencode/` |
| `cursor` | no documented way | `.cursor/rules`, AGENTS.md, CLAUDE.md, `mcp.json`, hooks |
| `agy` | no documented way | AGENTS.md, GEMINI.md, `.agents/` rules, skills, agents, `mcp_config.json` |

Claude Code's `--bare` would skip even more, but it takes API-key auth only, so
subscription logins could not use it. A line such as
`codex has no documented way to ignore the repository's AGENTS.md — its instructions
still reach the agent` lands in the run's log the first time an agent runs on codex.

The repository's own code that ODW itself would run is refused: the `symlink:` lines
of its `.worktreeinclude` link nothing (a link hands agents the source tree; plain
lines still copy), and a `worktreeSetup` or `worktreeTeardown` set by a config inside the repository — such
as its `./odw.config.json` — does not run, with a log line saying so. A `worktreeSetup`
from your own config (`--config`, `$ODW_CONFIG`, or `~/.config/odw/config.json`
outside the repository) still runs. A config ODW would find by itself inside the
repository — its `./odw.config.json` — is not read at all in an untrusted run: its
adapter commands are the repository's code. The run uses your
`~/.config/odw/config.json` (outside the repository) or the built-in defaults, and says
so; one you name with `--config` or `$ODW_CONFIG` is your choice and still applies. A
repository's config cannot loosen the `"trust": "untrusted"` your
`~/.config/odw/config.json` sets. Its [workflow memory](../reference/workflow-api.md#workflow-memory-odw-extension)
(`.odw/memory/`) is neither recalled nor written; a `memoryDir` of yours outside the
repository is.

```jsonc
{
  "trust": "untrusted",
  "adapters": {
    "codex": { "trust": "untrusted" },  // or: only this adapter, in every run
    "my_wrapper": {
      "command": ["my-agent", "{permission_args}", "--cwd", "{workspace}"],
      "permissionArgs": { "edit": [] },
      "untrustedArgs": ["--no-project-config"],           // goes after the tier's flags
      "untrustedNote": "my-agent still reads .my-agent/rules" // said once per untrusted run
    }
  }
}
```

The start banner has a trust line — `trust: untrusted — claude --safe-mode, codex no
documented way` — and `odw doctor` shows the config's trust and how each adapter runs
untrusted. An untrusted agent's `agent_started` event, saved result and
`odw agents --json` row carry `trust: "untrusted"`, the dashboard's drawer shows it,
and the run's `run_started` setup records `trust`. Untrusted is not a sandbox: it
keeps the repository's instructions and configuration out where a CLI allows, and the
permission tier still decides what agents may do.

## Untrusted input (ODW extension)

An issue's text, a PR title or a comment is anyone's writing, and a model cannot be
trusted to tell it from instructions: published injections — "Comment and Control",
GitLost — got past every model-level defence, and the advice that came out of them is
structural: take the capabilities away. A run whose **args** come from outside takes
**untrusted input** — separate from an [untrusted repository](#untrusted-repositories-odw-extension).
Every run a [trigger](scheduling-and-triggers.md#start-runs-from-webhooks-github-linear-slack-odw-extension) starts
takes it (unless the trigger says `"untrusted": false`), and so does
`odw run --untrusted-input` (a rerun, resume or replay keeps it). Such a run:

- **runs read-only agents** — `permissions: "read"` — unless the run's tier was given:
  `--permissions`, or the trigger's `"permissions"`;
- **starts agent CLIs with `agentEnv: "minimal"`, no other vendor's variables and no
  secret-named variable** — `GH_TOKEN`, `GITHUB_TOKEN`, `*_API_KEY`, `*_TOKEN`,
  `*_HEADERS`, … — but the ones the CLI's own login documents (`ANTHROPIC_*`/`CLAUDE_*`
  for claude, `OPENAI_*`/`CODEX_*` for codex, `GEMINI_*` and `GOOGLE_API_KEY`,
  `GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_GENAI_USE_GCA`, `GOOGLE_CLOUD_PROJECT`,
  `GOOGLE_CLOUD_LOCATION` for gemini, …), whatever `agentEnvPass` lists. An adapter's
  own `env` still applies, and `exec()` commands — the workflow author's — get the
  minimal environment plus `agentEnvPass`;
- **runs no worktree setup or teardown of the repository's:** a `worktreeSetup` or
  `worktreeTeardown` that the repository's own config sets is dropped, and the run's log
  says so, as in an [untrusted repository](#untrusted-repositories-odw-extension); one of
  your own config still runs, without the secret-named and vendors' variables (`PATH`,
  `HOME`, `DOCKER_*` and `COMPOSE_*` are kept, so docker and compose work);
- **says loudly when nothing boxes it in:** without a
  [container sandbox](#run-agents-in-containers-odw-extension) whose `network` is an
  allowlist (or `"none"`), the start banner, the run's log and its `run_started` event warn,
  and read-only agents start without their CLI's web tools (Claude Code's `WebFetch` and
  `WebSearch`, codex's `--search`), which could carry a file they read — a token
  `actions/checkout` left in `.git/config` — off the machine.
  `"untrustedInput": { "requireSandbox": true }` refuses to start such a run instead;
- **asks before anything writes:** the first agent that may write (`edit` or `full`) waits
  at a [checkpoint](checkpoints-and-questions.md#human-checkpoints-odw-extension) — once per run; its answer stands for
  the rest, and a rejection fails those agents with a catchable `UntrustedInputRejected`.
  `odw apply --pr` of such a run asks `y/N` on the terminal, or takes
  `--accept-untrusted-input`. A trigger's `"approve": false` turns both off.

```jsonc
"triggers": {
  "fix-issue": {
    "workflow": "fix-issue", "verify": "github", "secretEnv": "GITHUB_WEBHOOK_SECRET",
    "args": { "issue": "$.issue.number", "body": "$.issue.body" },
    "permissions": "edit"            // its agents may edit: the first one asks first
  }
},
"sandbox": { "kind": "container", "image": "odw-agents:latest", "network": { "allow": "adapter" } },
"untrustedInput": { "requireSandbox": true }
```

The workflow sees it as `workflow.input` (an ODW extension; undefined in Claude Code, so
read it as `workflow.input?.untrusted`): `untrusted`, the `args` it covers (a trigger's
mapped keys; `["*"]` for all of them), `why` (`trigger:<name>`, `--untrusted-input`), and
`quote(text, label?)`, which puts text in a fenced `<untrusted-data>` block followed by a
line saying it is data, not instructions:

```js
const fix = await agent(`Fix the bug this issue describes.\n${workflow.input.quote(args.body, "issue body")}`)
```

meta.json keeps `untrustedInput: { why, args, approve }`; status.json and the
`run_started` event add the tier, the environment and whether a sandbox held it, and
the dashboard's Job header shows it as a trust line. None of this detects or filters an
injection, and none of it makes a run safe: it only takes away what the text could ask for.

## Strict script context (ODW extension)

A workflow is code: one from a plugin, a shared file or a trigger runs with the worker's
whole JavaScript context unless something says otherwise — `process`, `require`,
`fetch` and all they reach. `scriptContext: "strict"` compiles and runs the workflow
body in a fresh `vm` context that holds only the injected primitives (`agent`,
`parallel`, `pipeline`, `phase`, `log`, `args`, `budget`, `workflow`, and the ODW
extensions `validate`, `exec`, `checkpoint`) and the standard JavaScript built-ins —
the bare ECMAScript realm Claude Code's Workflow tool gives a script. There is no
`process`, `require`, `fetch`, `console`, timers or `structuredClone`; `eval()` and
`new Function()` compile nothing; an `import()` is refused when the body compiles.
Using one fails with a message that says so (`process is not defined: a strict script
context (scriptContext: "strict") has only the workflow primitives and standard
JavaScript built-ins, not Node.js's process — …`) rather than a bare `ReferenceError`,
and the run says it is strict — and which of these names the script uses — before
the body starts. What a primitive returns or throws reaches the script as a copy in
the script's own realm; an error the script throws leaves it as an ordinary `Error`.

```jsonc
{ "scriptContext": "strict" } // every run; "host": every run in the worker's context
```

Unset, a run is **strict when a trigger started it, when its workflow is a Claude
Code plugin's or one `odw workflows add` installed from git, or when its input or its repository is untrusted**, and **host** for
everything else — local and personal workflows run as before. A rerun, resume or
replay of a triggered run is strict too. A config's `"host"` wins, and the run's log
warns when it takes a strict default away. A nested `workflow()` runs in its parent's
context — and a plugin's workflow strict even under a host parent, unless the config
says `"host"`. The run's `run_started` event records the context it
chose, status.json has `scriptContext: "strict"`, and the dashboard's Job header shows
it on the trust line. `odw check --capabilities` lists what a script would miss there.

**`vm` is not a security boundary.** Strict takes away what a script could casually
reach; a hostile script can still find its way out of the context, and every script
drives agents that act with the run's permissions. `exec()` is still there, and runs
its command in a shell on this machine (or the run's container sandbox) with the run's
environment — strict does not take commands away. Read a workflow before you run
it, and use [permissions](#permissions-odw-extension) and a
[container sandbox](#run-agents-in-containers-odw-extension) for the agents.

## Run agents in containers (ODW extension)

By default ODW runs each agent CLI on your machine, as you, held back only by the CLI's
own permission flags. The container sandbox runs each CLI run — and each `exec()` step —
in a fresh Docker or Podman container instead. It is opt-in, and the image is yours: it
must hold the CLIs, and ODW never pulls it.

```bash
docker build -t odw-agents --build-arg UID=$(id -u) --build-arg GID=$(id -g) examples/sandbox
odw doctor                                   # engine found, image present, a smoke run
odw run wf.js --sandbox container --sandbox-image odw-agents
```

[`examples/sandbox/Dockerfile`](../../examples/sandbox/Dockerfile) builds one with Node, git,
Claude Code and Codex (pin their versions with `--build-arg CLAUDE_CODE_VERSION=…`). Or
set it in your config, per run, per adapter, or per call:

```jsonc
{
  "sandbox": {
    "kind": "container",
    "image": "odw-agents",          // required; never pulled
    "engine": "docker",             // or "podman"; default: docker if installed, else podman
    "network": "default",           // or "none", or { "allow": [...] } (see below)
    "cliConfig": "copy",            // or "mount-ro" | "none"
    "mounts": [{ "source": "~/datasets", "readonly": true }], // read-only unless "readonly": false
    "memory": "4g", "cpus": 2, "pids": 512 // pids defaults to 512; the rest to the engine's
  },
  "adapters": {
    "codex": { "sandbox": { "kind": "container", "image": "odw-codex", "network": "none" } }
  }
}
```

```js
await agent('Review this diff', { sandbox: { network: 'none', memory: '1g' } })
await agent('Summarize', { sandbox: { image: 'odw-agents' } }) // a call in a run on the host
await exec('npm test')                                          // in the run's container, offline
await exec('npm ci', { network: 'default' })                    // a step that needs the network
```

Like permissions, the sandbox only tightens: an adapter's `sandbox` may turn the
container on and set its own image, engine, CLI config and more mounts, and of network
and the limits the stricter wins; an `agent()` call's may turn it on (naming an image
only when nothing else does), take the network away, lower a limit or drop the CLI's
config (`cliConfig: "none"`). Anything looser — `sandbox: "none"` under a container, a
network its sandbox has not, more memory, another image, mounts — fails the call before
it starts. `odw run|rerun|resume --sandbox container [--sandbox-image <image>]` puts a
whole run in one (the config's container, or one of that image); a rerun or resume of a
sandboxed run stays sandboxed.

What each CLI run becomes (`docker run --rm -i --init --pull never --name odw-<run>-<agent>-<rand> --label odw.run=<run> …`):

- **The workspace, and nothing else of yours.** The agent's workspace — its isolated
  worktree, or the run's source — is bound read-write at the same path and is the
  working directory, so diffs, transcripts, `expect` checks and `{workspace}` work as
  before. The rest of the host's filesystem is not there: only a private home, the files
  this CLI run is handed (its prompt file, schema file and reply file), and the `mounts`
  you list. In an isolated worktree, `git` inside the container cannot reach the
  repository (the worktree's `.git` points outside it); ODW takes the diff on the host as
  always. Bind the repository's `.git` read-only with `mounts` if your agents need history.
  The workspace's own `.git` (a worktree's `.git` file, or the repository's `.git`
  directory when agents work in place) is bound **read-only**: ODW runs git on the host
  in that directory afterwards, and config an agent planted there (`core.fsmonitor`,
  hooks) would otherwise run on the host. Every git ODW runs also turns fsmonitor and
  hooks off, and a reply file that is a link or a FIFO is refused, never followed.
- **The CLI's login, as a copy.** `cliConfig: "copy"` (the default) copies the CLI's own
  login and config files into a private temporary home (bound at `/odw/home`, removed
  after the run), so the agent can use them but never change yours. Only the files each
  CLI's docs name: Claude Code's `~/.claude/.credentials.json`, `settings.json`,
  `CLAUDE.md`, `agents/`, `commands/`, `skills/` and `~/.claude.json` without its
  `projects` (your other repositories); Codex's `~/.codex/auth.json`, `config.toml`,
  `AGENTS.md`; Gemini's `~/.gemini/settings.json`, `oauth_creds.json`,
  `google_accounts.json`, `GEMINI.md`, `.env`. Never session history or logs.
  `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are honoured. `"mount-ro"` binds those files
  read-only instead (Claude Code rewrites `~/.claude.json` as it runs: prefer `copy` for
  it); `"none"` leaves the home empty. On macOS Claude Code keeps its login in the
  Keychain, so there is nothing to copy: set `CLAUDE_CODE_OAUTH_TOKEN` (from
  `claude setup-token`) or `ANTHROPIC_API_KEY`; for Codex `CODEX_API_KEY`, for Gemini
  `GEMINI_API_KEY`. The run says once when it found nothing to copy. A CLI that refreshes
  its login inside the container writes the new token to the copy, which is thrown away;
  where the provider rotates refresh tokens, your own login may then need a fresh
  `/login`, so long-lived tokens and API keys suit sandboxed runs best.
- **You, with no privileges.** `--user` your uid:gid (Podman: also `--userns keep-id`),
  so what agents write is yours; `--cap-drop ALL`, `--security-opt no-new-privileges`,
  `--pids-limit` (512), optional `--memory` and `--cpus`, a read-only root filesystem
  with a tmpfs `/tmp`, and `--init` to forward signals.
- **Only the environment `agentEnv` lets through** — set `"agentEnv": "minimal"` to keep
  your shell's other secrets out — passed by name (`--env NAME`), so no value appears in
  a process listing, less the host's paths (`PATH`, `HOME`, `TMPDIR`, `XDG_*`,
  `CLAUDE_CONFIG_DIR`, `CODEX_HOME`).
- **`ODW_PORT` still set, nothing published.** A server an agent starts on its port is
  reachable inside its container only.
- **Killed with the run.** A CLI run that times out, stalls, is stopped or does not exit
  cleanly has its container killed by name (`docker kill`, then `docker rm --force`);
  killing the engine client alone would leave it running. If the worker itself is killed,
  its exit handler removes every container it still has. `docker ps --filter label=odw.run`
  finds any left by a crash.

**An egress allowlist** (ODW extension). Agent CLIs need their model API, so in practice
`network: "default"` is the open internet. An allowlist lets a container reach only the
hosts you name, enforced outside it:

```jsonc
{
  "sandbox": {
    "kind": "container", "image": "odw-agents",
    "network": { "allow": ["adapter", "registry.npmjs.org", "*.githubusercontent.com"] }
    // "allow": "adapter" — just the hosts the agent's adapter needs
    // "proxyImage": "node:22-alpine" — run the proxy in another image (it needs node)
  }
}
```

- **Entries.** A host (`api.anthropic.com`), a wildcard over its subdomains
  (`*.npmjs.org` matches `registry.npmjs.org`, not `npmjs.org`), or an IP literal
  (`10.0.0.5`, `[::1]`), each with an optional port (`example.com:8443`; without one,
  443 and 80). A request for an IP address is refused unless that address is listed — a
  wildcard never matches one. `"*"` is refused: that is `network: "default"`.
- **`"adapter"`** stands for the hosts the agent's adapter declares in `egressHosts`,
  from its docs: `claude` api.anthropic.com, claude.ai, platform.claude.com; `codex`
  api.openai.com, chatgpt.com, auth.openai.com; `gemini`
  generativelanguage.googleapis.com, cloudcode-pa.googleapis.com, oauth2.googleapis.com;
  `agy` cloudcode-pa.googleapis.com, oauth2.googleapis.com. Optional telemetry is left
  out (it is refused and logged; set `DISABLE_TELEMETRY` for Claude Code to quiet it).
  Other adapters declare none — give yours `"egressHosts": [...]`, or list its hosts.
- **Tighten only.** An adapter's or a call's `network: { allow }` meets the run's: the
  agent gets the hosts both allow. `"none"` still wins; a call cannot ask for
  `"default"` under an allowlist. An `exec()` step with `network: "default"` gets the
  run's allowlist (less `"adapter"`: a step has no adapter).
- **How.** The first container that needs it brings up, per distinct allowlist, an
  internal network of the run (`docker network create --internal`: no route out) and an
  egress proxy sidecar (`odw-<run>-egress<n>-…`, labelled `odw.role=egress-proxy`) on the
  engine's default network that also joins it. The agent's container joins only the
  internal network, with `HTTPS_PROXY`/`HTTP_PROXY` (and lower-case) pointing at the
  proxy, `NO_PROXY` for loopback and `NODE_USE_ENV_PROXY=1`. The proxy tunnels `CONNECT`
  only to an allowlisted host's port 443 (or the entry's port), forwards plain HTTP only
  to an allowlisted host (refusing a `Host` header that names another), and **resolves
  names itself** — the agent's container has no DNS for the outside: on Docker it gets
  `--dns 192.0.2.1`, an address nothing answers on, because Docker's embedded resolver
  before 26.0 forwarded an internal network's lookups out through the host
  (CVE-2024-29018). The proxy listens only on its address on the internal network, so
  other containers on the default network cannot use it. It is ODW's own
  zero-dependency script (the same code as the hidden `odw __egress-proxy`), run with
  `node` in **the agent's image — which then needs node** — or in `proxyImage`, as
  locked down as an agent's container.
- **Denials are events.** Each refused request is a line in `<run dir>/egress/`, which
  the run turns into `egress_denied` events (`{ host, port, method, agent }`, or
  `commandId` for a step) in `odw logs` and the dashboard — at most 200 per run, then
  one log line at its end saying how many more there were; each proxy's log stops at
  1 MiB. The agent is named by the user name in its proxy URL; a CLI that drops it
  shows `agent: null`. That name is a hint, not proof — the client sends it, and an
  agent could change it — but it gets an agent nothing: every agent behind a proxy has
  the same allowlist.
- **Cleaned up.** At the run's end the proxies are removed, then the networks; the
  worker's exit handler does the same if it is killed, or if one could not be removed at
  the end. `docker network ls --filter label=odw.run` finds any a crash left. `odw
  doctor` brings up the proxy and, from a container on the internal network, expects 200
  for the first host listed, 403 for a reserved one, and example.com not to resolve.
- **The safe failure.** A CLI or tool that ignores `HTTPS_PROXY` gets no network at all:
  there is no route out of the internal network but the proxy. Anything not over HTTP(S)
  through the proxy — SSH, raw TCP, UDP — fails. Agents with different allowlists get
  different networks and proxies, so an agent cannot use another's. Allowed hosts are
  still trusted: an agent can send your code anywhere an allowed host forwards it.
- **By name, not by site.** The list limits the host names a connection is made to, and
  so the servers those names resolve to — not the site served there. Over `CONNECT` the
  TLS inside the tunnel is the agent's: it can name another site in its SNI and inner
  `Host` header (domain fronting), and the server an allowed name resolves to — a CDN's
  edge, a shared front end — may serve it. Allowing one name behind a CDN can admit
  every site that edge fronts for; prefer hosts that are not behind shared front ends.

A missing engine or image fails the run before its first agent starts, with a
`ConfigError` that says how to build the image; `odw doctor` checks the same and runs
`docker run --rm --pull never --network none <image> true` (no model involved). The
start banner adds a sandbox line when a container is configured, each agent's `agent_started` event and the dashboard's
AgentView carry `sandbox: { kind, engine, image, network }` (`network: "allowlist"` with its `allow` hosts), and the run's setup records
`sandbox` for `odw compare`. Sandboxed agents record no CLI version: the probe runs on
the host, whose CLI is not the image's.

**What it protects, and what it does not.** It keeps an agent — and anything it runs —
from reading or changing the rest of your filesystem (your SSH keys, other repositories,
your shell profile, your real CLI config), from running as anything but you, and from
leaving processes behind. It does **not** keep your code from the model: the agent
still sends what it reads to its model API. With `network: "default"` (the default, as
agent CLIs must reach their model API) it has the open network, so it can send your
workspace and the secrets in its environment and login anywhere — keep secrets out of
`agentEnv`, use `network: "none"` wherever no model API is needed (`exec()`
steps are offline by default), and an egress allowlist (`network: { allow: "adapter" }`)
where it is: then the agent reaches its model API and what you list, through a proxy
outside its container that the agent cannot reconfigure, and every refusal is logged. The workspace is writable: what an agent writes
there — a git hook in a repository it works in place, a `package.json` script, a
Makefile — runs on your host when you later run it, so review changes (isolated
worktrees and `odw apply` help). A container shares the host's kernel; it is not a VM.
Rootless Docker maps uids its own way, so files may come out owned by another uid; on
SELinux hosts, binds may need relabelling. Windows hosts are not supported.

## Secrets in what ODW keeps (ODW extension)

An agent prints whatever it reads — `cat .env` included — and ODW keeps that output:
its transcript and the end of its stderr, its reply (its saved result), the run's log
and error, what a webhook is told. The dashboard serves all of it, off-loopback too. So
before any of it is written, ODW replaces each likely secret with a marker that says
what it was:

```text
the key is «redacted:env:STRIPE_SECRET_KEY»
Authorization: Bearer «redacted:bearer»
cloning with «redacted:github»
```

- **`env`** — the value of every variable whose name looks secret (`*_KEY`, `*_API_KEY`,
  `*TOKEN`, `*SECRET*`, `*PASSWORD*`, `*_PWD`, `*_PAT`, `AUTHORIZATION`, cloud
  credentials such as `AWS_ACCESS_KEY_ID` and `*CONNECTION_STRING`, webhook URLs) in the
  environment ODW starts agents and `exec()` commands with — its own, and each adapter's
  `env` — wherever it appears (values of 8 characters or more, matched exactly), as
  `«redacted:env:NAME»`; and the value of any `NAME=value` printed whose `NAME` looks
  secret (a `.env` file, `env` output).
- **`patterns`** — well-known token shapes: Anthropic (`sk-ant-…`), OpenAI (`sk-…`,
  `sk-proj-…`), GitHub (`ghp_…`, `gho_…`, `ghs_…`, `github_pat_…`), Slack (`xoxb-…` and
  its kin), AWS access key ids, Google API keys, JWTs, PEM private-key blocks and
  `Bearer` tokens — as `«redacted:anthropic»`, `«redacted:openai»`, …
- **`extra`** — regular expressions of your own (JavaScript sources), as `«redacted:extra»`.

```jsonc
// The default, plus a pattern of your own:
{ "redact": { "env": true, "patterns": true, "extra": ["corp-[0-9a-f]{32}"] } }
// Keep everything as printed:
{ "redact": false }
```

Redacted: transcripts (as they stream — a secret split across two chunks of output
included) and stderr tails; saved agent results (`odw result --agent`, the dashboard's
agent drawer); the run's events — `odw logs`, log lines, `agent_failed` errors (a
failure's quoted output is redacted before it is cut, so no secret is kept in half),
the command lines `exec()` steps show and the output a failed `check` quotes; the
run's error; the waiting checkpoint in `status.json`; webhook payloads; the run's
`worker.log` — the worker's own output, a workflow's `console.log` of an agent's
reply included, redacted as it is written; and the Chat Host's sessions
(`<runsRoot>/_chat/sessions.json`, and what `/api/chat/sessions` serves): Codex's
replies in full, what you typed — and the run results posted back as messages — of
token shapes only, since they are your data; a reply still streaming keeps only its
whole lines until it settles, and a sessions file kept before redaction was on is
redacted as it is read. A run's `args` are your data too, and may hold a token: what
`/api/runs/:id` and the dashboard serve of them has its token shapes redacted
(`argsRedacted: true`), and so does what `/api/schedules` serves of a schedule's —
but `meta.json` and the schedule keep them as given, so `odw rerun` and `odw resume`
start the new run with the original args. What had anything redacted says so with
`redacted: true` — a saved result, an event, a transcript line and its entry in the
API, `result.json`, `error.json`, a webhook payload, a chat message — and `odw doctor`
says whether redaction is on and which variables it covers.
It runs as output arrives, without holding it: a line waits for its end, and a private
key for its last line.

Not redacted:
- **What agents get.** Prompts and an agent's environment are never touched, nor what
  `agent()` and `exec()` hand back to the workflow: redaction is about what is written
  down.
- **The run's result** is the workflow's own data — it may return a config it read on
  purpose — so `result.json` gets `patterns` and `extra` only, never `env`.
- **Kept diffs** (`agents/<id>.diff`) are an agent's change to your code: what
  `odw apply` applies and a kept branch commits, where a marker would corrupt your
  files. A secret an agent wrote into code is there to be caught in review (`odw diff`,
  the dashboard's Changes tab).
- **The run's `args` as kept** in `meta.json` (and a schedule's): `odw rerun` and
  `odw resume` must start from what you passed in. Only what is served of them is
  redacted. Nor is what Codex is given in the Chat Host: the message a turn answers
  goes to it as you typed it (earlier messages as kept).
- **A resumed run** replays an agent's saved result as it was kept — redacted — and its
  log says so.

Redaction is a safety net, not a vault: a secret of a shape it does not know, under a
name that does not look secret, is kept as printed. With `agentEnv: "minimal"`, agents
never see what they do not need in the first place.
