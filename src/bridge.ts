/**
 * Execution bridge (L2) — STUB (M1).
 *
 * The seam between the abstract `agent` primitive and a concrete coding-agent
 * CLI. Given an {@link AgentRequest} it: resolves the adapter, composes a
 * self-contained prompt (independence framing + optional schema instructions),
 * runs the adapter in an isolated workspace, and — when a schema is requested —
 * extracts/validates the reply and retries with corrective feedback until it
 * conforms or the retry budget is spent.
 */

import { notImplemented } from "./errors.js";
import type { Config, CliResult } from "./adapters/types.js";
import type { CommandRunner } from "./adapters/runner.js";
import type { JsonSchema } from "./schema.js";

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
  constructor(
    private readonly config: Config,
    private readonly options: BridgeOptions = {},
  ) {
    void this.config;
    void this.options;
  }

  async run(_request: AgentRequest): Promise<AgentOutcome> {
    throw notImplemented("bridge (M1)");
  }
}
