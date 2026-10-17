/**
 * Execution bridge (L2): turn one `agent` call into one CLI invocation.
 *
 * Given an {@link AgentRequest} it: resolves the adapter, composes a
 * self-contained prompt (independence framing + optional schema instructions),
 * runs the adapter in its workspace (the source tree by default, a throwaway
 * git worktree when isolation is requested), and — when a schema is requested —
 * extracts/validates the reply and retries with corrective feedback until it
 * conforms or the retry budget is spent.
 *
 * The command runner is injectable, so the bridge unit-tests with a fake runner
 * and no real agent account.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveAdapter } from "./adapters/config.js";
import { expand, expandAll, type PlaceholderContext } from "./adapters/placeholders.js";
import { AdapterOutputDecoder, decodeAdapterOutput } from "./adapters/output.js";
import { runCommand, type CommandRunner } from "./adapters/runner.js";
import {
  adapterDisplayName,
  cliOk,
  type Adapter,
  type CliResult,
  type Config,
} from "./adapters/types.js";
import { AdapterExecutionError, RunStopped, SchemaValidationError } from "./errors.js";
import { LiteralRouter, type InvocationPlan, type OptionRouter } from "./router.js";
import { describeSchema, extractJson, validate, type JsonSchema } from "./schema.js";
import { withWorkspace } from "./workspace.js";

export const INDEPENDENCE_PREAMBLE =
  "You are one agent in an automated multi-agent workflow. Work independently " +
  "on the task below. Do not ask clarifying questions and do not assume other " +
  "agents exist. Produce your result directly.";

export interface AgentRequest {
  prompt: string;
  adapter?: string;
  schema?: JsonSchema;
  label?: string;
  /** Select a model; routed to the adapter's declared model flag (or noted). */
  model?: string;
  /** Persona to take on; injected into the prompt (universal, every CLI). */
  agentType?: string;
  /** `"worktree"`: run this agent in a throwaway git worktree (as in Claude Code). */
  isolation?: "worktree";
}

/** The persona framing injected for `agentType`, on top of the independence preamble. */
export function personaPreamble(agentType: string): string {
  return (
    `Take on the role of the "${agentType}" agent for this task. Bring the ` +
    `expertise, priorities, and conventions that role implies to the work below.`
  );
}

export interface AgentOutcome {
  /** Validated structured object, or the raw text when no schema. */
  value: unknown;
  /** The raw final reply. */
  text: string;
  /** Adapter name actually used. */
  adapter: string;
  /** How many CLI calls it took (>1 means schema retries happened). */
  attempts: number;
  /**
   * Notes from option routing: options accepted but not honoured natively, and
   * what was done instead. The caller surfaces these as LOG events so no option
   * is dropped silently. Empty when every set option mapped cleanly.
   */
  notes: string[];
}

export interface BridgeOptions {
  source?: string;
  runner?: CommandRunner;
  /** How `agent` options map to a CLI invocation; defaults to {@link LiteralRouter}. */
  router?: OptionRouter;
}

/** What the scheduler hands one call; all optional, so a bare `run(request)` works. */
export interface RunOptions {
  /**
   * The run's abort signal. Aborting kills the CLI process (and everything it
   * started) and ends the call with the signal's reason — the run's fatal
   * error — so it propagates instead of becoming a null slot.
   */
  signal?: AbortSignal;
}

export class Bridge {
  private readonly source: string;
  private readonly runner: CommandRunner;
  private readonly router: OptionRouter;
  private autoPicked: Adapter | undefined;

  constructor(
    private readonly config: Config,
    options: BridgeOptions = {},
  ) {
    this.source = options.source ?? process.cwd();
    this.runner = options.runner ?? runCommand;
    this.router = options.router ?? new LiteralRouter();
  }

  /**
   * The adapter a call runs on: the named one, else the configured default,
   * else the zero-config auto-pick; throws AdapterNotFound (a ConfigError). The
   * auto-pick scans PATH, so it happens once per bridge (one run) and is then
   * reused: every agent of a run gets the same CLI, even if PATH changes.
   */
  adapterFor(name?: string | null): Adapter {
    if (name || this.config.settings.defaultAdapter) return resolveAdapter(this.config, name);
    return (this.autoPicked ??= resolveAdapter(this.config, null));
  }

  async run(request: AgentRequest, options: RunOptions = {}): Promise<AgentOutcome> {
    const { signal } = options;
    const adapter = this.adapterFor(request.adapter);
    const settings = this.config.settings;
    const timeout = adapter.timeout ?? settings.timeout ?? undefined;
    // Plan the invocation once: workspace mode, the model token/flag, and the
    // routing notes do not change across schema retries — only the prompt does.
    const plan = this.router.plan({ request, adapter, settings });
    const basePrompt = this.composePrompt(request);
    const maxAttempts = request.schema ? settings.schemaRetries + 1 : 1;

    let problems: string[] = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      throwIfAborted(signal);
      const prompt = problems.length ? `${basePrompt}\n\n${retryFeedback(problems)}` : basePrompt;
      const { cli, decoder } = await this.invoke(adapter, plan, prompt, timeout, signal);
      // Killed by a stop (or by a fatal error elsewhere in the run): report
      // the run's reason, not a misleading CLI failure.
      throwIfAborted(signal);
      if (!cliOk(cli)) throw new AdapterExecutionError(cliFailureMessage(adapter, cli));

      // A runner that streams stdout fed the decoder and kept only a tail; an
      // injected runner that does not stream returns the whole stdout instead.
      const text = decoder?.received ? decoder.finish() : decodeAdapterOutput(adapter, cli.stdout);
      if (!request.schema) {
        return { value: text, text, adapter: adapter.name, attempts: attempt, notes: plan.notes };
      }

      // The schema steers extraction to the candidate that satisfies it.
      const value = extractJson(text, request.schema);
      // `undefined` is extractJson's only "nothing parsed" sentinel; a parsed
      // JSON `null` is a real value — let validate() decide if the schema allows it.
      problems =
        value === undefined
          ? ["no JSON value found in the reply"]
          : validate(value, request.schema);
      if (problems.length === 0) {
        return { value, text, adapter: adapter.name, attempts: attempt, notes: plan.notes };
      }
    }

    throw new SchemaValidationError(
      `adapter '${adapter.name}' did not satisfy the schema after ${maxAttempts} attempt(s); ` +
        `last problems: ${problems.join("; ")}`,
    );
  }

  // --- internals -------------------------------------------------------------

  private composePrompt(request: AgentRequest): string {
    const parts = [INDEPENDENCE_PREAMBLE];
    // Persona (agentType) is universal prompt text — it works on every CLI,
    // which native system-prompt flags do not. See LiteralRouter.noteAgentType.
    if (request.agentType) parts.push(personaPreamble(request.agentType));
    parts.push(request.prompt);
    if (request.schema) parts.push(describeSchema(request.schema));
    return parts.join("\n\n");
  }

  private async invoke(
    adapter: Adapter,
    plan: InvocationPlan,
    prompt: string,
    timeout: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<{ cli: CliResult; decoder: AdapterOutputDecoder | null }> {
    // JSONL transcripts are decoded while they stream, so only the final text
    // is retained (and a verbose session is never cut off at the stdout cap);
    // text replies are buffered by the runner under its cap, as before.
    const decoder = adapter.output?.format === "jsonl" ? new AdapterOutputDecoder(adapter) : null;
    const onStdout = decoder
      ? (chunk: string, terminate: (reason: string) => void) => {
          decoder.write(chunk);
          if (decoder.overflow) terminate(decoder.overflow);
        }
      : undefined;
    return withWorkspace(this.source, plan.workspaceMode, async (ws) => {
      let promptFile = "";
      let cleanup: (() => Promise<void>) | undefined;
      if (usesPromptFile(adapter)) {
        const dir = await mkdtemp(join(tmpdir(), "odw-prompt-"));
        promptFile = join(dir, "prompt.txt");
        await writeFile(promptFile, prompt, "utf8");
        cleanup = () => rm(dir, { recursive: true, force: true });
      }
      try {
        const context: PlaceholderContext = {
          prompt,
          prompt_file: promptFile,
          workspace: ws.path,
          source: ws.source,
          adapter: adapter.name,
          role: adapterDisplayName(adapter),
          // Option-derived tokens (the model token this phase) win over the base.
          ...plan.context,
        };
        const command = [...expandAll(adapter.command, context), ...plan.extraArgs];
        const stdin = adapter.stdin ? expand(adapter.stdin, context) : undefined;
        const env = adapter.env
          ? ({ ...process.env, ...adapter.env } as Record<string, string>)
          : undefined;
        // No ws.diff() here: agent() returns the reply, never a diff, so
        // computing one per worktree attempt was pure overhead.
        const cli = await this.runner(command, { stdin, cwd: ws.path, env, timeout, onStdout, signal });
        return { cli, decoder };
      } finally {
        if (cleanup) await cleanup();
      }
    });
  }
}

/**
 * End an aborted call with the run's reason: a fatal error, so it propagates
 * through parallel/pipeline instead of becoming a null slot.
 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new RunStopped("run was stopped");
}

function usesPromptFile(adapter: Adapter): boolean {
  const token = "{prompt_file}";
  return adapter.command.some((part) => part.includes(token)) || (adapter.stdin?.includes(token) ?? false);
}

function retryFeedback(problems: string[]): string {
  const listed = problems
    .slice(0, 10)
    .map((p) => `- ${p}`)
    .join("\n");
  return (
    "Your previous reply did not satisfy the required schema:\n" +
    `${listed}\n` +
    "Return corrected JSON only, with no surrounding text."
  );
}

function cliFailureMessage(adapter: Adapter, cli: CliResult): string {
  const reason = cli.timedOut ? "timed out" : `exited with code ${cli.returncode}`;
  const text = cli.stderr.trim() || cli.stdout.trim();
  // Keep both ends of a long diagnostic: the head usually names the error, the
  // tail holds the final message and the runner's own notes (kill reasons).
  const detail = text.length > 500 ? `${text.slice(0, 250)} … ${text.slice(-250)}` : text;
  const suffix = detail ? `: ${detail}` : "";
  return `adapter '${adapter.name}' ${reason}${suffix}`;
}
