/**
 * The built-in mock agent (an ODW extension): what answers every agent of a
 * run that must not call a model — `odw test`'s scripted replies and
 * `odw run --dry`'s stubs. The run itself is real (worker, scheduler, bridge,
 * schema validation and retries, fallback chains, the run store); only the
 * agent CLI is replaced.
 *
 * {@link mockConfig} keeps every adapter the config names — so `agent(p, {
 * adapter })`, phase defaults and fallback chains resolve as they would — but
 * points each at the mock command, plain-text output, a native `--schema`
 * (so the prompt carries no schema text and the mock sees the schema itself)
 * and no sandbox; it also turns off what would reach outside the run: CLI
 * version probes, notify hooks, OpenTelemetry export, quota waits and
 * worktree setup commands.
 *
 * {@link mockRunner} is the bridge's command runner: a mock command is
 * answered in-process by a {@link MockResponder}, given the agent's id, label
 * and phase (read off its agent_started event), the adapter, model, prompt,
 * schema and which attempt this is. Any other command (exec(), git for an
 * isolated agent) runs for real.
 */

import type { CommandRunner, RunCommandOptions } from "../adapters/runner.js";
import { runCommand } from "../adapters/runner.js";
import type { Adapter, CliResult, Config } from "../adapters/types.js";
import type { JsonSchema } from "../schema.js";
import { placeholderFor } from "./placeholder.js";

/** The mock agent's command: no executable of that name is ever started. */
export const MOCK_COMMAND = "odw-mock-agent";
/** The adapter a config without a default adapter gets for bare agent() calls. */
export const MOCK_ADAPTER = "mock";
/** What a dry run's agent without a schema answers. */
export const DRY_REPLY = "(dry run)";

/** The failures a scripted reply can make its agent's CLI end with. */
export const FAIL_KINDS = ["rate_limit", "quota", "auth", "model_unavailable", "permission", "timeout", "stalled", "not_found", "exit"] as const;
export type FailKind = (typeof FAIL_KINDS)[number];

/** One agent CLI call the mock answers. */
export interface MockCall {
  /** Its agent's id (agent_started's `agentId`); null when the bridge gave none. */
  agentId: number | null;
  /** Its agent's label and phase, as its agent_started event names them. */
  label: string | null;
  phase: string | null;
  /** The adapter it runs on (after any fallback). */
  adapter: string;
  model: string | null;
  prompt: string;
  /** The call's JSON Schema; null without one. */
  schema: JsonSchema | null;
  /** Which CLI run of this agent this is, from 1 (schema and rate-limit retries, fallbacks). */
  attempt: number;
}

/** What the mock does for one call. */
export type MockAnswer =
  | { text: string; delayMs?: number }
  | { fail: FailKind; delayMs?: number }
  /** No reply was scripted: the CLI fails, saying so. */
  | { unscripted: string };

export type MockResponder = (call: MockCall) => MockAnswer;

/** A dry run's answer: a schema's smallest valid value, else {@link DRY_REPLY}. */
export function dryAnswer(schema: JsonSchema | null): string {
  return schema ? JSON.stringify(placeholderFor(schema)) : DRY_REPLY;
}

/** The dry run's responder: every agent gets {@link dryAnswer}. */
export const dryResponder: MockResponder = (call) => ({ text: dryAnswer(call.schema) });

/** `config` with every adapter answered by the mock (see the module comment). */
export function mockConfig(config: Config): Config {
  const adapters: Record<string, Adapter> = {};
  for (const [name, adapter] of Object.entries(config.adapters)) adapters[name] = mockAdapter(name, adapter);
  if (!adapters[MOCK_ADAPTER]) adapters[MOCK_ADAPTER] = mockAdapter(MOCK_ADAPTER);
  const fallbackDefault = config.settings.defaultAdapter && adapters[config.settings.defaultAdapter] ? config.settings.defaultAdapter : MOCK_ADAPTER;
  return {
    ...config,
    adapters,
    settings: {
      ...config.settings,
      defaultAdapter: fallbackDefault,
      recordVersions: false,
      notify: null,
      otel: false,
      quotaWait: false,
      sandbox: "none",
      worktreeSetup: null,
      schemaPrompt: "auto",
    },
  };
}

function mockAdapter(name: string, real?: Adapter): Adapter {
  return {
    name,
    ...(real?.label ? { label: real.label } : {}),
    command: [MOCK_COMMAND, name],
    stdin: "{prompt}",
    flags: { model: ["--model"], schema: { args: ["--schema"], mode: "inline" } },
    output: { format: "text" },
    // Every tier is "enforced": the mock does nothing a tier could forbid.
    permissionArgs: { read: [], edit: [], full: [] },
    ...(real?.concurrency !== undefined ? { concurrency: real.concurrency } : {}),
    ...(real?.permissions ? { permissions: real.permissions } : {}),
  };
}

/** The CLI result each failure kind ends with: the wording ODW's failure classes read. */
function failure(kind: FailKind, duration: number): CliResult {
  const base = { stdout: "", timedOut: false, duration };
  switch (kind) {
    case "rate_limit":
      return { ...base, returncode: 1, stderr: "mock agent: Error: 429 Too Many Requests (rate limit exceeded)" };
    case "quota":
      return { ...base, returncode: 1, stderr: "mock agent: You've hit your usage limit" };
    case "auth":
      return { ...base, returncode: 1, stderr: "mock agent: Not logged in. Please run /login" };
    case "model_unavailable":
      return { ...base, returncode: 1, stderr: "mock agent: model_not_found: the model does not exist or you do not have access to it" };
    case "permission":
      return { ...base, returncode: 1, stderr: "mock agent: the tool call was denied" };
    case "timeout":
      return { ...base, returncode: -1, stderr: "mock agent: [timed out]", timedOut: true };
    case "stalled":
      return { ...base, returncode: -1, stderr: "mock agent: [stalled]", stalled: true };
    case "not_found":
      return { ...base, returncode: 127, stderr: "mock agent: command not found" };
    default:
      return { ...base, returncode: 1, stderr: "mock agent: scripted failure (exit 1)" };
  }
}

/**
 * The bridge's command runner for a mocked run: mock commands answered by
 * `responder`, anything else by `fallback`. `agentOf` names an agent's label
 * and phase by its id (the run's agent_started event).
 */
export function mockRunner(
  responder: MockResponder,
  agentOf: (agentId: number) => { label: string | null; phase: string | null } | null,
  fallback: CommandRunner = runCommand,
): CommandRunner {
  const attempts = new Map<number, number>();
  return async (command: string[], options: RunCommandOptions = {}): Promise<CliResult> => {
    if (command[0] !== MOCK_COMMAND) return fallback(command, options);
    const began = Date.now();
    const agentId = Number(options.env?.ODW_AGENT_ID);
    const id = Number.isInteger(agentId) ? agentId : null;
    const attempt = id === null ? 1 : (attempts.get(id) ?? 0) + 1;
    if (id !== null) attempts.set(id, attempt);
    const who = id === null ? null : agentOf(id);
    const flag = (name: string): string | null => {
      const at = command.indexOf(name, 2);
      return at === -1 ? null : (command[at + 1] ?? null);
    };
    let schema: JsonSchema | null = null;
    const schemaText = flag("--schema");
    if (schemaText !== null) {
      try {
        schema = JSON.parse(schemaText) as JsonSchema;
      } catch {
        schema = null;
      }
    }
    const answer = responder({
      agentId: id,
      label: who?.label ?? null,
      phase: who?.phase ?? null,
      adapter: command[1] ?? MOCK_ADAPTER,
      model: flag("--model"),
      prompt: options.stdin ?? "",
      schema,
      attempt,
    });
    const delay = "delayMs" in answer ? (answer.delayMs ?? 0) : 0;
    if (delay > 0 && !(await wait(delay, options.signal))) {
      return { returncode: -1, stdout: "", stderr: "[aborted; process terminated]", timedOut: false, duration: seconds(began) };
    }
    if (options.signal?.aborted) {
      return { returncode: -1, stdout: "", stderr: "[aborted before start]", timedOut: false, duration: 0 };
    }
    if ("unscripted" in answer) {
      return { returncode: 3, stdout: "", stderr: `mock agent: ${answer.unscripted}`, timedOut: false, duration: seconds(began) };
    }
    if ("fail" in answer) return failure(answer.fail, seconds(began));
    if (answer.text) options.observeStdout?.(answer.text);
    return { returncode: 0, stdout: answer.text, stderr: "", timedOut: false, duration: seconds(began) };
  };
}

/** A bridge `sleep` that does not: backoffs and staggers of a mocked run take no time. */
export async function noSleep(_ms: number, _signal?: AbortSignal): Promise<void> {
  // As the bridge's own sleep, it never throws: the caller checks its signal.
}

/** Wait `ms`; false when `signal` aborted first. */
function wait(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve(true);
    }, ms);
    const stop = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener("abort", stop, { once: true });
  });
}

function seconds(since: number): number {
  return (Date.now() - since) / 1000;
}
