# Adapters and models

English · [简体中文](../zh-CN/guides/adapters-and-models.md)

Which agent CLI runs an agent, with which model, and how its output is read. Every key: [configuration reference](../reference/config.md).

## Configure adapters

Codex, Claude Code, Gemini, Qwen, Kimi, Oh My Pi, Kilo Code, OpenCode,
Cursor, and Google's Antigravity CLI work out of the box:

| Adapter | Local CLI | Non-interactive contract |
| --- | --- | --- |
| `codex` | `codex` | `exec --json` events; reply from its `--output-last-message` file (else its last `agent_message`), tokens from `turn.completed`, errors from `turn.failed` / `error`; web search enabled; strict schemas natively (`--output-schema`) |
| `claude` | `claude` | stream-json events; reply, usage, cost and errors from its `result` event; WebSearch/WebFetch allowed; schemas natively (`--json-schema`) |
| `gemini` | `gemini` | text on stdout |
| `qwen` | `qwen` | text on stdout |
| `kimi` | `kimi` | text on stdout |
| `omp` | `omp` | `--print --no-session --approval-mode yolo`; prompt on stdin |
| `kilo` | `kilo` | `run --format json --auto`; final text decoded from JSONL |
| `opencode` | `opencode` | `run --format json --auto`; final text decoded from JSONL |
| `cursor` | `agent` | `--print --force --trust`; prompt on stdin |
| `agy` | `agy` | `--output-format stream-json`, prompt on stdin; reply, tokens, errors and refused tool calls (`denied_actions`) from its `result` event; object-rooted schemas natively (`--json-schema`) |

> **`gemini` end of life for individual and free accounts.** Google ended Gemini CLI
> support for individual (Gemini Code Assist for individuals) and free accounts on
> 2026-06-18; such a login now gets "This client is no longer supported for Gemini
> Code Assist for individuals", which ODW classifies as `model_unavailable` (a
> [fallback chain](#per-phase-adapters-model-tiers-and-fallback-chains-odw-extension)
> moves on). Use the `agy` adapter (Antigravity CLI) instead. Enterprise and Google
> Cloud licences reportedly still work (unverified). Source:
> [littlebearapps/untether#720](https://github.com/littlebearapps/untether/issues/720).

The built-in `codex` and `claude` adapters come **web-capable**, so research
workflows run with zero tuning. `odw init`
shows what's installed (with each CLI's permission posture) and sets the
default — interactively at a terminal, as a plain report anywhere else, and
`odw init --adapter <name>` writes the choice without prompting. To tune flags
or add your own CLI, drop an `odw.config.json` (see
[`odw.config.example.json`](../../odw.config.example.json)) in the project root,
`~/.config/odw/config.json`, or pass `--config`. ODW only shells out to local
commands — it never calls model APIs directly.

```jsonc
{
  "defaultAdapter": "claude",
  "concurrency": 8,
  "adapters": {
    "my_wrapper": {
      "label": "My custom CLI",
      "command": ["my-agent", "--cwd", "{workspace}", "--prompt-file", "{prompt_file}"]
    }
  }
}
```

Custom adapters default to trimmed text stdout. For JSONL event streams, declare
the event and final-text path explicitly:

```jsonc
"output": {
  "format": "jsonl",
  "eventType": "text",
  "textPath": ["part", "text"],
  "select": "last"
}
```

**ODW extension:** a JSON output can also say what a run spent, whether the CLI
itself reported a failure, and which tool calls it refused the agent. The
built-in `claude` adapter is declared this way:

```jsonc
"output": {
  "format": "jsonl",
  "eventType": "result",          // the event the reply comes from (the last one wins)
  "textPath": ["result"],
  "select": "last",
  "usagePath": ["usage"],         // token counts, in a usageEvent (default: eventType)
  "costPath": ["total_cost_usd"], // US dollars, in the same event
  "errorPath": ["is_error"],      // true, a message or an error object: the run failed with it
  "deniedPath": ["permission_denials"], // tool calls the CLI refused: kept on the agent, logged
  "mcpEvent": "system",           // the event that lists the MCP servers (Claude Code's init)
  "mcpPath": ["mcp_servers"]      // { name, status } each: one not connected is kept and logged
}
```

The built-in `codex` (ODW extensions throughout) reads `codex exec --json`: its reply
is the last `item.completed` event whose `item.type` is `agent_message` (`match`) —
unless the file it writes its final message to (`--output-last-message
{reply_file}`) has it, which wins: `{reply_file}` is a fresh path in a private temp
directory for each CLI run, read once the CLI exits and then removed. Its tokens come
from `turn.completed`, and `turn.failed` and `error` events are its own failure report
(`errorEvents`: event type → path to the message), classified like any failure —
an `error` codex retried itself, followed by a completed turn, is no failure:

```jsonc
"codex": {
  "label": "Codex CLI",
  "command": ["codex", "--search", "exec", "--json", "--output-last-message", "{reply_file}",
              "--skip-git-repo-check", "{permission_args}", "--cd", "{workspace}", "-"],
  "stdin": "{prompt}",
  "flags": { "model": ["--model"], "schema": { "args": ["--output-schema"], "mode": "file", "strict": true } },
  "output": {
    "format": "jsonl",
    "eventType": "item.completed",
    "match": { "path": ["item", "type"], "equals": "agent_message" }, // only these events hold the reply
    "textPath": ["item", "text"],
    "select": "last",
    "usageEvent": "turn.completed",
    "usagePath": ["usage"],                                          // tokens only: codex reports no cost
    "errorEvents": { "turn.failed": ["error"], "error": ["message"] }
  },
  "permissionArgs": {
    "read": ["--sandbox", "read-only"],
    "edit": ["--sandbox", "workspace-write"],
    "full": ["--sandbox", "danger-full-access"]
  }
}
```

An entry that gives `codex` its own `command` replaces the built-in whole: keep this
`output` block (and `--json`) with it, or its agents report no usage and their reply
is codex's text output. When a codex turn ends with no agent message — its reply file
empty and no `agent_message` event — the reply is empty, so the agent fails with
`empty_reply` (`allowEmpty: true` accepts it) instead of returning a dump of events,
and the run's log says exactly what was missing; when its events lack the reply but
the reply file has it, the reply stands and the log says the events did not match.

The built-in `agy` (Google's Antigravity CLI, from its
[headless docs](https://antigravity.google/docs/cli/headless) and changelog; ODW
extensions throughout) reads `--output-format stream-json`, whose events name their
type with an `event` key — `output.eventKey` says so (default `"type"`). Its reply,
tokens, failure and refused tool calls all come from its final `result` event; agy
reports no cost. A failed turn's `error` ("Individual quota reached … Resets in
2h39m52s.", "Authentication expired. Please log back in.") is classified like any
failure. It takes a schema natively only when its root is `"type": "object"`
(`flags.schema.objectRoot`: agy refuses any other at startup); any other goes in the
prompt.

```jsonc
"agy": {
  "label": "Antigravity CLI",
  "command": ["agy", "--output-format", "stream-json", "--input-format", "text",
              "--disable-slash-commands", "--print-timeout", "24h", "{permission_args}"],
  "stdin": "{prompt}",                                               // not -p: argv caps its length
  "flags": { "model": ["--model"], "schema": { "args": ["--json-schema"], "mode": "inline", "objectRoot": true } },
  "output": {
    "format": "jsonl",
    "eventKey": "event",                                             // {"event":"result","result":{…}}
    "eventType": "result",
    "textPath": ["result", "response"],
    "select": "last",
    "usagePath": ["result", "usage"],                                // tokens only: agy reports no cost
    "errorPath": ["result", "error"],                                // present only when the run failed
    "structuredPath": ["result", "structured_output"],
    "deniedPath": ["result", "denied_actions"]
  },
  "permissionArgs": {
    "edit": ["--mode", "accept-edits"],
    "full": ["--mode", "accept-edits", "--dangerously-skip-permissions"]
  }
}
```

A tool call headless agy could not ask approval for is soft-denied: the run exits 0,
often with an empty `response`
([antigravity-cli#794](https://github.com/google-antigravity/antigravity-cli/issues/794)),
so the agent fails with `empty_reply` and its `denied` names what agy refused. And a
subagent's output never reaches agy's stream
([antigravity-cli#1077](https://github.com/google-antigravity/antigravity-cli/issues/1077)):
the transcript shows each subagent it started, with the path of its log. agy's stream
never says when a subagent ends, so `agy` declares no `output.background`.

Under `acceptEdits`, Claude Code refuses headless what it would have asked about —
a shell command that is not allowlisted, say — and the reply may still claim
success; the refusals are what `deniedPath` reads. By default the reply stands,
with the refused calls recorded as `denied` on the agent and one log line;
`"permissionDenials": "fail"` (run-wide, or in an adapter's entry) fails such
agents with reason `permission`, and an `agent()` call with `expect` counts them
as a miss. Allow what your agents need in the adapter's `permissionArgs` for
their tier.

Usage from every `usageEvent` adds up; it is normalized across the CLIs' field
names (Anthropic's, OpenAI's, Codex's — see
[`src/adapters/usage.ts`](../../src/adapters/usage.ts)). A CLI that prints one JSON
document instead takes `{ "format": "json", "textPath": […], "usagePath": […],
"costPath": […], "errorPath": […], "deniedPath": […] }`; a whole number in a path indexes an array
(negative: from its end). A failure reported at `errorPath` is classified like
any failed run — whatever the exit status — so a rate limit is retried and a spent
quota says when it resets. When the declared text is not in the output — a CLI
whose format drifted, or a misconfiguration — the raw stdout becomes the reply and
the run's log says why; the agent does not fail. A CLI that also writes its reply to
`{reply_file}` (as `codex` does) is read from there first, and when both are empty
its reply is empty rather than a dump of events.

ODW returns only the decoded final response to the workflow; JSONL output is
decoded line by line as it streams (keeping the latest text and a usage total, not
the transcript), and only a bounded tail of stderr is kept for error messages. On
Windows, executable discovery follows `PATHEXT`, so normal
`agent.cmd`, `kilo.cmd`, and `omp.exe` shims are detected without full paths.

Config keys live at the **top level** — there is no `"settings"` wrapper, and odw
warns about unknown or misplaced keys (with a did-you-mean hint) instead of
silently ignoring them. With no `defaultAdapter` set, odw uses the sole
configured adapter — or, on a fresh install, the sole adapter whose CLI it
actually finds on PATH; if several are installed, the error lists them and shows
how to pick one.

## ACP agents (ODW extension)

An agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com)
(the protocol Zed and JetBrains editors use to drive coding agents) can be an
adapter as is: give it `"protocol": "acp"` and the command that starts its ACP
mode. ODW then drives it the way an editor would, over JSON-RPC on its stdin and
stdout, with a small client of its own (no dependency). It adds a way to connect
agents and replaces nothing: the built-in adapters keep their headless modes.

```json
{
  "adapters": {
    "gemini-acp": { "protocol": "acp", "command": ["gemini", "--experimental-acp"], "label": "Gemini CLI (ACP)" }
  }
}
```

Check each agent's own docs for its ACP flag (`gemini --help`; newer Gemini CLI
releases may name it `--acp`). An `acp` adapter takes no `stdin` and no `output`,
since the prompt and reply go over the protocol, and it cannot be a built-in with only
`protocol` changed, so give it a name of its own. Everything else works as for
any adapter: `env`, `timeout`, `stallTimeout`, `flags.model` (appended to its
command), `permissions`, `permissionArgs` (flags for its command, per tier),
`sandbox`, `agentLimits`, fallback chains and accounts.

What ODW implements (protocol version 1), per CLI run of an agent call:

| Step | What ODW does |
| --- | --- |
| `initialize` | protocol version 1; **no client capabilities**: no `fs`, no `terminal`, no elicitation. The agent reads and writes files itself. A request for any of them is answered "method not found" |
| `session/new` | `cwd` is the agent's workspace (its worktree when isolated); no MCP servers from ODW |
| `session/prompt` | the agent's prompt as one text block; the turn ends with the response's `stopReason`. Anything but `end_turn` (`max_tokens`, `max_turn_requests`, `refusal`, `cancelled`) fails the call |
| `session/update` | message and thought chunks, tool calls and their updates, plans and `usage_update` are read as they stream. The reply is the message text after the agent's last tool call |
| `session/request_permission` | answered at once **by the agent's permission tier**. Nobody is asked |
| `session/cancel` | sent when the run is stopped, times out, stalls or hits a limit, just before its process is killed |

How the tier answers a permission request, by the tool call's ACP `kind`:

| Tier | Allowed | Rejected |
| --- | --- | --- |
| `read` | `read`, `search`, `think`, `fetch` (not `fetch` or `search` for a run with untrusted input, unless its sandbox network is an allowlist or none) | `edit`, `delete`, `move`, `execute`, `switch_mode`, `other`, anything else |
| `edit` | those, plus `edit`, `delete`, `move` | `execute`, `switch_mode`, `other`, anything else |
| `full` | everything | nothing |

ODW selects `allow_once` (or `reject_once`), never an `*_always` option, so no
answer becomes a rule the agent remembers. When the agent offers no reject option,
ODW cancels the request, which allows nothing. Each answer is an
`acp_permission` event (`toolCallId`, `title`, `kind`, `decision`, `option`,
`tier`). These events show in `odw logs`, the live view and the dashboard's Logs
tab. What was refused is recorded on the agent like any CLI's refused tool calls
(`permissionDenials`).

**For an ACP agent the tier is advisory.** It is only as strong as the agent's own
asking: ODW can refuse only what the agent asks about, and an agent configured to
edit or run commands without asking is not stopped. When a tool call beyond the tier
whose kind is anything but `read`, `search` or `think` (`other`, `switch_mode` and
kinds ODW does not know included) runs without a request, ODW records an
`acp_permission` event with `decision: "unasked"` and does not let it pass silently —
after the fact. A real guarantee needs the
[container sandbox](safety-and-trust.md#run-agents-in-containers-odw-extension); with untrusted input,
`untrustedInput.requireSandbox: true` refuses a run whose agents (ACP ones included)
are not in one with a boxed-in network. Pair a `read` tier with the agent's own
approval settings at least.

The session is kept as ODW's own `acp.*` events (`acp.message`, `acp.thought`,
`acp.tool_call`, `acp.tool_result`, `acp.permission`, `acp.plan`, `acp.usage`,
`acp.error`, `acp.result`). It does not keep the raw JSON-RPC. Those events feed the
agent's transcript (`odw logs --agent`, the dashboard drawer), its live
`toolCalls` and `costUsd` limits, and its failure reasons. A JSON-RPC error is
classified like any CLI failure. An `auth_required` error from `session/new`, for
one, is reason `auth`. Usage comes from what the protocol carries:
`usage_update`'s cumulative `cost` when it is in US dollars, and token counts
only when the prompt response carries a `usage` object (a draft of the
protocol, read when present). An agent that reports neither gets chars/4 of its
reply, as any CLI does. The agent's stdout counts against the 32 MiB output cap a buffered
CLI's does (past it the run is stopped); a message and the reply keep at most 4 MiB,
a thought 256 KiB, a tool's output 64 KiB, and `denied` lists at most 1000 calls.

`odw doctor --adapter <name>` gives an ACP agent a handshake: it sends
`initialize` alone (no session, no prompt, nothing spent) and reports the agent's
name and version, protocol version, `loadSession`, prompt and MCP capabilities,
and login methods. `--smoke` sends it one real prompt, as for any adapter.

Not implemented: ODW as an ACP *agent* (an editor driving ODW), remote
transports, elicitation (structured questions; the capability is not declared),
the client `fs` and `terminal` methods, `session/load`, extra workspace roots,
session modes and config options, and authenticating for the agent (log in to it
first).

## Structured output (ODW extension)

`agent(prompt, { schema })` returns a value that satisfies its JSON Schema, or the
call fails. Two things back that up:

- **Nothing goes silently unchecked.** ODW's validator checks `type` (one name),
  `enum`, `properties`, `required`, `additionalProperties: false`, `items` (one
  schema) and `minItems`; annotations such as `description`, `title` and `format`
  constrain nothing. Before an agent starts, ODW looks for anything else — `oneOf`,
  `anyOf`, `allOf`, `$ref`, `const`, `pattern`, `minimum`, `maxItems`, a type union
  like `["string", "null"]`, an object keyword without `"type": "object"` — and the
  run's log says, once, which keywords it does not check and where (`"oneOf" at
  #/properties/status`). The call still runs, and ODW validates the rest.
  `"schemaKeywords": "strict"` refuses such a call instead, with an `AgentError`,
  before anything is spawned. A typo (`requird`, with a did-you-mean) or another
  malformed schema fails the call in either mode.
- **CLIs that validate schemas get them natively.** The built-in `claude` is handed
  the schema with `--json-schema`, and the value comes from the `structured_output`
  of its `result` event; `codex` gets `--output-schema <file>`, a file
  (`agents/<agentId>.schema.json` in the run directory) that exists only while its
  CLI runs. ODW still validates every reply and retries with feedback, and it
  describes the schema in the prompt only to CLIs that do not take it natively
  (`"schemaPrompt": "always"`: to every CLI).

Codex sends `--output-schema` in OpenAI's strict mode, which refuses a schema unless
its root is an object and every object sets `"additionalProperties": false` and lists
all its properties in `required`. Any other schema goes to codex in the prompt, as
before, and the run says so once.

To make such keywords count, run the agent on an adapter whose CLI enforces them:
it is handed the whole schema, and the run's log says the keywords are left to it.
`schemaKeywords` is `"warn"` (the default) or `"strict"`.

A CLI of your own declares how it takes a schema in `flags.schema` — `"inline"`
(the schema's JSON is the next argument) or `"file"` (the path of a file holding it),
plus `"strict": true` for a CLI that takes only OpenAI strict schemas — and, when its
JSON output carries the validated value apart from its text, where:

```jsonc
"my_cli": {
  "command": ["my-cli", "--print"],
  "stdin": "{prompt}",
  "flags": { "schema": { "args": ["--schema"], "mode": "inline" } },
  "output": { "format": "json", "textPath": ["text"], "structuredPath": ["data"] }
}
```

The schema goes after every other argument, where a model flag goes, and is never
placeholder-expanded. Without `flags.schema` the prompt describes the schema and
only ODW checks the reply.

## Agent definitions behind `agentType` (ODW extension)

`agent(prompt, { agentType: "reviewer" })` runs the agent defined in a Claude Code
subagent file — Markdown with YAML frontmatter, its body the agent's prompt
(https://code.claude.com/docs/en/sub-agents) — on whichever CLI the call runs:

```markdown
---
name: reviewer
description: Reviews a change for bugs
tools: Read, Grep, Glob
model: sonnet
effort: high
---
You are a meticulous reviewer. Report bugs only.
```

ODW looks the name up as Claude Code does — by the frontmatter `name`, not the file
name: `.claude/agents/` in the working directory and each parent up to the
repository root (nearest wins), then `.odw/agents/` the same way (an ODW-only
location, same format), then `~/.claude/agents/`, then the `agents/` of installed,
enabled Claude Code plugins as `<plugin>:<name>`. What it maps:

| Field | ODW |
| --- | --- |
| body | The persona prompt, in place of the one-line persona, on every CLI. |
| `model` | The call's default model; `agent()`'s own `model` wins, and so does it over a phase's. On `claude` as it is; on another CLI an alias maps through the `models` tier of the same name (`"models": { "sonnet": { "codex": "gpt-5.5" } }`), else that CLI's default model runs and the run's log says so. `inherit` is no model. |
| `tools`, `disallowedTools` | A cap on the agent's [permission tier](safety-and-trust.md#permissions-odw-extension), never a raise: only Read, Glob, Grep, WebFetch, WebSearch → `read`; no Bash → at most `edit`. `claude` is also given `--tools` (narrowed with its tier's list, never widened) and `--disallowedTools` (one comma-separated argument). Each entry must be a tool name with an optional rule (`Read`, `Bash(git *)`, `mcp__gh__issue`); anything else — a leading `-`, whitespace — is left out and logged. A rule in `tools` counts as its tool and is not enforced (`--tools` takes names only): the log says so. |
| `isolation: worktree` | `agent()`'s `isolation: "worktree"`. |
| `effort` | `claude --effort`, `codex -c model_reasoning_effort=` (minimal–xhigh); on other CLIs the log says it had no effect. |
| anything else | `permissionMode`, `maxTurns`, `mcpServers`, `hooks`, `skills`, … are not applied, and the log names each one. |

Each definition is read once per run and logged with its file; `agent_started`
carries `agentType: { name, source, path, sha256 }`, the dashboard's agent drawer
shows it, and `odw compare` lists a definition whose file changed between two runs
(`agentDefinition.<name>`). A name no definition has keeps the one-line persona,
with a log line. In an `--untrusted` run a definition from the repository gives its
body, tools and isolation — not its model or effort — and the user's and plugins'
definitions come first: a repository's of the same name never shadows them (the log
names it). Only a plugin's agents have a `:` in their name; a definition naming
itself `x:y` is refused. A definition file that is a symlink is followed only when it
stays in its agents directory (the user's: in their home). Adapters declare the carriers
in `flags`: `effort` (an element may hold `{effort}`), `effortLevels`, `tools`,
`disallowedTools`.

```sh
odw agents types                  # each definition here, and what it maps to on the default adapter
odw agents types --adapter codex --json
```

## Per-phase adapters, model tiers and fallback chains (ODW extension)

**ODW extension.** Mix CLIs and models per stage — a cheap model for the search
fan-out, a strong one for the synthesis — and keep a run going on another CLI when
one runs out of quota.

**Phase defaults.** A `meta.phases` entry may give its phase's agents an adapter and
a model: `{ title, adapter?, model? }` (a plain string entry is still just a title).
`phase(title, { adapter, model })` sets them for the agents that follow, in place of
the phase's entry; `phase(title)` alone keeps what the phase has. An option the
`agent()` call sets always wins, and a call's own `phase` option brings that phase's
defaults.

```js
export const meta = {
  name: 'research',
  description: 'Search cheaply, synthesize carefully.',
  phases: [
    { title: 'Search', adapter: 'codex', model: '@fast' },
    { title: 'Synthesize', adapter: ['claude', 'codex'], model: '@strong' },
  ],
}
phase('Search')
const notes = await parallel(angles.map((a) => () => agent(`Research ${a}; cite sources.`)))
phase('Synthesize')
return await agent(`Synthesize:\n${notes.filter(Boolean).join('\n---\n')}`)
```

**Model tiers.** The `models` setting names tiers, each with a model id per adapter.
`model: "@fast"` — in `agent()`, `phase()` or `meta.phases` — runs an agent with the
id its adapter has for the tier; after a fallback, the next adapter's. An adapter the
tier names no model for runs its CLI's default (a log line says so); an unknown tier
fails the agent with an `AgentError` that lists the tiers. A model without the `@` is
a model id, passed to every adapter as it is — so give a fallback chain a tier.

**Fallback chains.** The `fallback` setting gives each adapter the ones to try after
it, in order; `agent(prompt, { adapter: ["codex", "claude"] })` names the chain for one
call, in place of the setting. When an agent's CLI has spent its usage quota or its
login is refused, the agent runs again on the next adapter — a fresh prompt, the same
options — instead of failing (a rate limit is still ridden out in place). Each move is
logged, the agent takes a slot on its new adapter (letting the old one's go first),
its transcript goes on after an `{"kind":"attempt","reason":"fallback","adapter":"claude"}`
line, and what the failed runs spent still counts:

```text
search:3 → claude after codex quota
```

- A fallback runs at the agent's own permission tier: an adapter that cannot run
  exactly that tier is skipped, with a log line — never run at another.
- A call's `expect` checks go with it: the next adapter's work is checked the same
  way, and retried there; work that misses never falls back (see
  [Check an agent's work](../reference/workflow-api.md#check-an-agents-work-odw-extension)).
- `agent_finished` names the adapter that produced the value and, as `fellBackFrom`,
  the ones the agent left; so does its saved result. `odw status`, the live view
  (`codex → claude`) and `/api/runs/:id` show them.
- **Quota breaker.** After `quotaBreaker` (default 3) quota failures in a row on one
  adapter, the run's later agents skip it: each starts on the next adapter of its
  chain, or fails at once without one. One warning says so, and `odw status` names it.

**Hand the work over instead of starting over.** By default a fallback starts the
agent's work over: an isolated agent's partial worktree is thrown away, and the next
CLI spends its quota redoing what the last one did. With `"fallback": { "handoff": true }`
(`handoff` is a reserved key there, not an adapter) or `agent(prompt, { handoff: true })`
— which overrides the setting either way — the next adapter carries the work on:

- An isolated agent's worktree is kept: the next adapter runs in it, the partial edits
  in place — and keeps it for each of its runs of the call (a stall restart, a rate-limit
  or schema retry). An in-place agent's edits are in the source tree already. A worktree
  is handed only to an adapter that runs with the same trust and container engine: an
  untrusted or differently sandboxed fallback starts in a fresh one, still with the
  brief, which says the work was not carried over.
- Its prompt starts, ahead of the task, with a brief headed *"You are continuing work
  another agent started…"*: why the last adapter stopped, the files it changed (the
  worktree's diff stat; for an in-place agent, the files its edit tool calls named), the
  last plan or to-do list it wrote (Claude Code's `TodoWrite`, Codex's plan), the
  commands it ran and how they ended, and its last few messages (a text CLI: the end of
  its output). At most 6 KB, each piece redacted before anything is cut. The reasoning is lost
  either way — the brief is the visible part of it, cut down to what the next agent needs.
- The brief is kept as `agents/<id>.handoff.md`; a `handoff` event `{ from, to, reason,
  bytes }` says so, and the transcript has a `{"kind":"handoff",…}` line before the next
  adapter's `attempt` line (`odw logs --agent` shows it; the dashboard drawer folds the
  brief in).
- `expect` and the kept diff judge the final state: the shared worktree's diff against
  its base, both adapters' work in it. An `expect` retry still starts over in a fresh
  worktree, and so does a call that waited out a quota (`quotaWait`). A handoff is part
  of one call: `odw resume` replays the call as before.

```jsonc
{ "fallback": { "codex": ["claude"], "handoff": true } }
```

```jsonc
{
  "fallback": { "codex": ["claude"], "claude": ["codex"] },
  "quotaBreaker": 3, // the default; 0 or null never skips an adapter
  "models": {
    "fast": { "claude": "haiku", "codex": "gpt-5-mini" },
    "strong": { "claude": "opus", "codex": "gpt-5" }
  }
}
```

`odw resume` replays a call that fell back like any other, and walks no chain. A
call's resume key is its prompt and options as written: a phase's defaults stay out of
it, like the run's default adapter, so routing a phase elsewhere — say, off a CLI that
ran out of quota — still replays every call that finished.

## Several accounts of one CLI

**ODW extension.** If you have more than one Claude Code or Codex login, `accounts`
lets one run use them all instead of you logging in again when one runs out. Each
entry becomes an adapter of its own, `<adapter>@<name>`:

```jsonc
{
  "accounts": {
    "claude": [
      { "name": "work", "configDir": "~/.claude-work" },
      { "name": "home", "configDir": "~/.claude-home", "concurrency": 2 }
    ],
    "codex": [{ "name": "team", "configDir": "~/.codex-team" }]
  }
}
```

- `claude@work` is the `claude` adapter with its CLI's documented config-dir variable
  set to the account's directory: `CLAUDE_CONFIG_DIR` for Claude Code, `CODEX_HOME` for
  Codex. Log each one in once by hand: `CLAUDE_CONFIG_DIR=~/.claude-work claude auth login`,
  `CODEX_HOME=~/.codex-team codex login`. Any other CLI is refused: ODW knows no
  variable that would keep two logins apart.
- Each account has its own concurrency cap (its adapter's `concurrency`, or the entry's
  own) and its own quota breaker; the rest of the definition is its adapter's. An entry
  takes `name`, `configDir` (absolute or `~/`), `concurrency` and `label`.
- `agent(…, { adapter: "claude" })` — and the default adapter, and a fallback chain
  naming `claude` — means *any claude account*: the call gets a chain of the accounts,
  ordered by headroom, and **hands the work over** when one runs out (as `"fallback":
  { "handoff": true }` does; `agent(…, { handoff: false })` starts over instead).
  `adapter: "claude@work"` runs on that account alone.
- **Headroom**, worked out each time a call is routed: accounts not in a quota pause
  first (the quota breaker took them out, or under `quotaWait` their quota is spent
  until a reset), then the fewest quota failures this run, then the fewest of the
  run's agents routed to them and not yet finished; ties keep the config's order. A
  fan-out spreads over the accounts that way.
- A model tier without an id for `claude@work` uses the one for `claude`.
- The agent's adapter reads `claude@work` in its events, the live view, the dashboard's
  drawer and spend receipt; `odw status` groups agents by account (`accounts of claude:
  claude@home 2 agents · claude@work 1 agent, 1 moved on`).
- `odw doctor` checks each account's login without a model call — `claude auth
  status` or `codex login status` with the account's directory — and `odw doctor
  --smoke --adapter claude` sends one prompt through each account.
- In a container sandbox, the account's directory is what gets copied (or bound) into
  the container's home, not `~/.claude`.

Whether you may pool several accounts is up to each provider's terms of service: check
them before you configure more than one. ODW only switches between logins you give it.

## Local models: check the server, route the cheap phases (ODW extension)

**ODW extension.** Local models (Ollama, LM Studio) run through an agent CLI that
talks to them — `opencode` with a provider in its `opencode.json`, `codex --oss`, or
your own adapter; there is no built-in `ollama` adapter. Their failure is silent:
Ollama loads a model with a small context window and, when a prompt does not fit,
cuts its front — the CLI's instructions and tool definitions — and still answers HTTP
200. Its OpenAI-compatible `/v1` endpoint, the one agent CLIs use, ignores a request's
`num_ctx`; only the server's `OLLAMA_CONTEXT_LENGTH` raises it. `odw doctor --local`
checks for that before a run does:

```bash
odw doctor --local                                   # Ollama on :11434, LM Studio on :1234
odw doctor --endpoint http://gpu-box:11434           # a server you name (implies --local)
odw doctor --local --model qwen3-coder:30b --smoke   # and a ~10K-token truncation probe
```

- **Read-only.** Ollama's `/api/version`, `/api/ps`, `/api/tags` and `/api/show`, or an
  OpenAI-compatible server's `/v1/models` (and LM Studio's `/api/v0/models`). Nothing is
  pulled, loaded or changed. A server you named that does not answer is a failed check;
  nothing on the default ports, one warning.
- **Per loaded model** (or the one `--model` names): the context it is loaded with — a
  **warning under 32K**, with how to raise it (`OLLAMA_CONTEXT_LENGTH=32768 ollama
  serve`; the macOS app: `launchctl setenv`; systemd: `systemctl edit ollama`; then the
  CONTEXT column of `ollama ps`) — and whether it declares tool calling. The Ollama
  version gets a warning below 0.13.4, the version `codex --oss` guides ask for. A plain
  OpenAI-compatible server reports neither context nor tools, and the check says so.
- **`--smoke`** (with `--local`) sends one request to `/v1/chat/completions`: a
  ~10K-token prompt with a random passphrase on its first line and, on its last, the
  instruction to reply with it. A reply without it — the front was cut, or the end
  ignored — is a failed doctor check (not a run failure reason), with the prompt tokens
  the server counted. The probe goes only to a server on this machine or the local
  network (loopback, private and link-local addresses, a bare host name, `.local`,
  `.lan`, `.internal`, `.home.arpa`), never to an Ollama cloud model, and carries no
  credentials. `--timeout <seconds>` bounds it (default 180). With `--local`, adapters
  are smoke-tested too only when `--adapter` names them.
- These probes are the doctor's own; runs still reach models only through the CLIs.

**Recipe: scout locally, plan and review in the cloud.** With a [model
tier](#per-phase-adapters-model-tiers-and-fallback-chains-odw-extension), the cheap
phases of `meta.phases` run on the local model and the rest stay on a cloud one:

```jsonc
// odw.config.json — "ollama/…" is opencode's provider/model id for the provider its opencode.json declares
{
  "models": {
    "local": { "opencode": "ollama/qwen3-coder:30b" },
    "strong": { "claude": "opus", "codex": "gpt-5" }
  }
}
```

```js
export const meta = {
  name: 'triage',
  description: 'Sort the issues locally; plan and review the fixes in the cloud.',
  phases: [
    { title: 'Scout', adapter: 'opencode', model: '@local' },
    { title: 'Plan', adapter: 'claude', model: '@strong' },
    { title: 'Review', adapter: 'claude', model: '@strong' },
  ],
}
```

Run `odw doctor --local --model qwen3-coder:30b --smoke` once the model is loaded, and
again whenever the server's settings change.
