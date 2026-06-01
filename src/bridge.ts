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
import { describeSchema, extractJson, validate, type JsonSchema } from "./schema.js";
import { withWorkspace, type WorkspaceMode } from "./workspace.js";

export const INDEPENDENCE_PREAMBLE =
  "You are one agent in an automated multi-agent workflow. Work independently " +
  "on the task below. Do not ask clarifying questions and do not assume other " +
  "agents exist. Produce your result directly.";

export interface AgentRequest {
  prompt: string;
  adapter?: string;
  schema?: JsonSchema;
  label?: string;
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
}

export interface BridgeOptions {
  source?: string;
  runner?: CommandRunner;
}

export class Bridge {
  private readonly source: string;
  private readonly runner: CommandRunner;

  constructor(
    private readonly config: Config,
    options: BridgeOptions = {},
  ) {
    this.source = options.source ?? process.cwd();
    this.runner = options.runner ?? runCommand;
  }

  async run(request: AgentRequest): Promise<AgentOutcome> {
    const adapter = resolveAdapter(this.config, request.adapter);
    const settings = this.config.settings;
    const timeout = adapter.timeout ?? settings.timeout ?? undefined;
    const basePrompt = this.composePrompt(request);
    const maxAttempts = request.schema ? settings.schemaRetries + 1 : 1;

    let problems: string[] = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const prompt = problems.length ? `${basePrompt}\n\n${retryFeedback(problems)}` : basePrompt;
      const { cli, diff } = await this.invoke(adapter, prompt, timeout, settings.workspaceMode);
      if (!cliOk(cli)) throw new AdapterExecutionError(cliFailureMessage(adapter, cli));

      const text = cli.stdout.trim();
      if (!request.schema) {
        return { value: text, text, adapter: adapter.name, attempts: attempt, diff, cli };
      }

      const value = extractJson(text);
      problems =
        value === undefined || value === null
          ? ["no JSON value found in the reply"]
          : validate(value, request.schema);
      if (problems.length === 0) {
        return { value, text, adapter: adapter.name, attempts: attempt, diff, cli };
      }
    }

    throw new SchemaValidationError(
      `adapter '${adapter.name}' did not satisfy the schema after ${maxAttempts} attempt(s); ` +
        `last problems: ${problems.join("; ")}`,
    );
  }

  // --- internals -------------------------------------------------------------

  private composePrompt(request: AgentRequest): string {
    const parts = [INDEPENDENCE_PREAMBLE, request.prompt];
    if (request.schema) parts.push(describeSchema(request.schema));
    return parts.join("\n\n");
  }

  private async invoke(
    adapter: Adapter,
    prompt: string,
    timeout: number | undefined,
    mode: WorkspaceMode,
  ): Promise<{ cli: CliResult; diff: string }> {
    return withWorkspace(this.source, mode, async (ws) => {
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
        };
        const command = expandAll(adapter.command, context);
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
