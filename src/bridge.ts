/**
 * Execution bridge (L2): turn one `agent` call into one CLI invocation.
 *
 * Given an {@link AgentRequest} it: resolves the adapter, composes a
 * self-contained prompt (independence framing + optional schema instructions),
 * runs the adapter in an isolated workspace, and — when a schema is requested —
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
import { runCommand, type CommandRunner } from "./adapters/runner.js";
import {
  adapterDisplayName,
  cliOk,
  type Adapter,
  type CliResult,
  type Config,
} from "./adapters/types.js";
import { AdapterExecutionError, SchemaValidationError } from "./errors.js";
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
  /** `"worktree"` requests isolation; satisfied by a copy-isolated workspace. */
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
  /** Workspace diff (empty for inplace mode / no changes). */
  diff: string;
  cli: CliResult | null;
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

export class Bridge {
  private readonly source: string;
  private readonly runner: CommandRunner;
  private readonly router: OptionRouter;

  constructor(
    private readonly config: Config,
    options: BridgeOptions = {},
  ) {
    this.source = options.source ?? process.cwd();
    this.runner = options.runner ?? runCommand;
    this.router = options.router ?? new LiteralRouter();
  }

  async run(request: AgentRequest): Promise<AgentOutcome> {
    const adapter = resolveAdapter(this.config, request.adapter);
    const settings = this.config.settings;
    const timeout = adapter.timeout ?? settings.timeout ?? undefined;
    // Plan the invocation once: workspace mode, the model token/flag, and the
    // routing notes do not change across schema retries — only the prompt does.
    const plan = this.router.plan({ request, adapter, settings });
    const basePrompt = this.composePrompt(request);
    const maxAttempts = request.schema ? settings.schemaRetries + 1 : 1;

    let problems: string[] = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const prompt = problems.length ? `${basePrompt}\n\n${retryFeedback(problems)}` : basePrompt;
      const { cli, diff } = await this.invoke(adapter, plan, prompt, timeout);
      if (!cliOk(cli)) throw new AdapterExecutionError(cliFailureMessage(adapter, cli));

      const text = cli.stdout.trim();
      if (!request.schema) {
        return { value: text, text, adapter: adapter.name, attempts: attempt, diff, cli, notes: plan.notes };
      }

      const value = extractJson(text);
      // `undefined` is extractJson's only "nothing parsed" sentinel; a parsed
      // JSON `null` is a real value — let validate() decide if the schema allows it.
      problems =
        value === undefined
          ? ["no JSON value found in the reply"]
          : validate(value, request.schema);
      if (problems.length === 0) {
        return { value, text, adapter: adapter.name, attempts: attempt, diff, cli, notes: plan.notes };
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
  ): Promise<{ cli: CliResult; diff: string }> {
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
        const cli = await this.runner(command, { stdin, cwd: ws.path, env, timeout });
        const diff = await ws.diff();
        return { cli, diff };
      } finally {
        if (cleanup) await cleanup();
      }
    });
  }
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
  const detail = (cli.stderr.trim() || cli.stdout.trim()).slice(0, 500);
  const suffix = detail ? `: ${detail}` : "";
  return `adapter '${adapter.name}' ${reason}${suffix}`;
}
