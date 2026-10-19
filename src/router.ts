/**
 * Option router (L2.5): the one place that maps a per-call `agent` option onto a
 * concrete CLI invocation.
 *
 * Every dialect option a workflow can set — `model`, `agentType`, `isolation` —
 * is routed here, behind a replaceable interface. The default {@link LiteralRouter}
 * does *syntactic pass-through*: it forwards an option to whatever carrier the
 * adapter declares (a model flag, a workspace mode, the prompt), and when an
 * option is set but has no native carrier it records a note instead of dropping
 * it silently (see {@link InvocationPlan.notes}). It deliberately does NOT try to
 * make options behave the *same* across CLIs (model ids, persona mechanisms and
 * token meters are all per-CLI); that consistency layer is a future router.
 *
 * Because the router is injected into the {@link Bridge} (just like the command
 * runner), a later `TieredRouter` / `PersonaRouter` / real-worktree mode can drop
 * in with no change to the primitives or to any workflow script.
 */

import type { Adapter, Settings } from "./adapters/types.js";
import type { PlaceholderContext } from "./adapters/placeholders.js";
import type { AgentRequest } from "./bridge.js";
import { resolveModel } from "./routing.js";

/** Whether `adapter` runs Claude Code: its command is `claude` (accounts and user configs included). */
export function isClaudeCli(adapter: Adapter): boolean {
  const exe = (adapter.command[0] ?? "").split(/[\\/]/).pop()!.replace(/\.(?:exe|cmd|bat)$/i, "");
  return exe === "claude";
}
import type { WorkspaceMode } from "./workspace.js";

/** Everything the router needs to plan one invocation. */
export interface RouterInput {
  request: AgentRequest;
  adapter: Adapter;
  settings: Settings;
}

/** The concrete plan for one invocation: tokens, argv tail, and workspace mode. */
export interface InvocationPlan {
  /** Option-derived placeholder tokens (this phase: at most `{model}`). */
  context: PlaceholderContext;
  /** argv appended after the expanded command template (e.g. `--model m`). */
  extraArgs: string[];
  /** Workspace isolation to open the call in. */
  workspaceMode: WorkspaceMode;
  /**
   * Human-readable notes for options that were accepted but not honoured
   * natively (and what was done instead). Surfaced as LOG events so nothing is
   * ever dropped silently. Empty when every set option mapped cleanly.
   */
  notes: string[];
  /**
   * The model id the CLI is asked for — a tier resolved — when the call set
   * one and the adapter carries it (a `{model}` token or its model flag);
   * unset otherwise. What a served model is compared with (ODW extension; see
   * ./served-model).
   */
  model?: string;
  /**
   * ODW extension (see ./agent-types): the built-in tools an agent
   * definition allows, for the CLI's tool flag — narrowed with the tier's.
   */
  tools?: { flag: string; allow: string[] };
}

/** Maps `agent` options onto an {@link InvocationPlan}. Swap to change behaviour. */
export interface OptionRouter {
  plan(input: RouterInput): InvocationPlan;
}

/**
 * The default router: forward each option to its declared carrier, note the ones
 * with no carrier, never drop one silently.
 */
export class LiteralRouter implements OptionRouter {
  plan(input: RouterInput): InvocationPlan {
    const { request, adapter, settings } = input;
    const context: PlaceholderContext = {};
    const extraArgs: string[] = [];
    const notes: string[] = [];

    const model = this.routeModel(request, adapter, settings, context, extraArgs, notes);
    this.noteAgentType(request, adapter, notes);
    const tools = this.routeDefinition(request, adapter, extraArgs, notes);
    const workspaceMode = this.routeIsolation(request);

    return { context, extraArgs, workspaceMode, notes, ...(model !== undefined ? { model } : {}), ...(tools ? { tools } : {}) };
  }

  /**
   * model → either a `{model}` token the template already carries, or the flag
   * the adapter declares, appended *only when a value is present* (so a call
   * with no model never produces a dangling `--model ""`). No carrier → a note.
   * A model tier (`"@fast"`, an ODW extension) is first this adapter's own id
   * for it (see ./routing): an unknown tier fails the call. Returns the model
   * the CLI is asked for, if any.
   */
  private routeModel(
    request: AgentRequest,
    adapter: Adapter,
    settings: Settings,
    context: PlaceholderContext,
    extraArgs: string[],
    notes: string[],
  ): string | undefined {
    const model = resolveModel(request.model ?? this.definitionModel(request, adapter, settings, notes), adapter, settings, notes);
    if (!model) return undefined;
    const usesToken =
      adapter.command.some((p) => p.includes("{model}")) ||
      (adapter.stdin?.includes("{model}") ?? false);
    const flag = adapter.flags?.model;
    if (usesToken) {
      context.model = model;
    } else if (flag && flag.length > 0) {
      extraArgs.push(...flag, model);
    } else {
      notes.push(
        `model '${model}' requested but adapter '${adapter.name}' declares no model flag ` +
          `— ignored (the CLI's own default model is used)`,
      );
      return undefined;
    }
    return model;
  }

  /**
   * agentType is delivered as prompt text in {@link Bridge.composePrompt} — the
   * one persona mechanism that works on every CLI. No adapter exposes a native
   * system-prompt flag this phase, so always note that the universal path ran
   * (so the author knows it was not a native `--append-system-prompt`).
   */
  private noteAgentType(request: AgentRequest, adapter: Adapter, notes: string[]): void {
    if (!request.agentType || request.definition) return;
    notes.push(
      `agentType '${request.agentType}' applied via prompt injection (universal); ` +
        `adapter '${adapter.name}' has no native system-prompt flag this phase`,
    );
  }

  /**
   * An agent definition's `model` (ODW extension; see ./agent-types), when the
   * call names none: as it is on Claude Code, whose ids and aliases it is;
   * elsewhere the `models` tier of that name (`sonnet` → `models.sonnet`), and
   * without one for this adapter the CLI's own default, said in a note.
   */
  private definitionModel(request: AgentRequest, adapter: Adapter, settings: Settings, notes: string[]): string | undefined {
    const def = request.definition;
    if (!def?.model) return undefined;
    if (isClaudeCli(adapter) || def.model.startsWith("@")) return def.model;
    const tiers = settings.models ?? {};
    const ids = Object.prototype.hasOwnProperty.call(tiers, def.model) ? tiers[def.model]! : undefined;
    const own = (key: string | undefined): string | undefined =>
      ids && key !== undefined && Object.prototype.hasOwnProperty.call(ids, key) ? ids[key] : undefined;
    const id = own(adapter.name) ?? own(adapter.account?.adapter);
    if (id !== undefined) return id;
    notes.push(
      `agentType '${def.name}': model '${def.model}' is Claude Code's and has no model for adapter '${adapter.name}' ` +
        `(set models.${def.model}.${adapter.name}) — the CLI's own default model is used`,
    );
    return undefined;
  }

  /**
   * An agent definition's `effort` and tool lists (ODW extension; see
   * ./agent-types), to the flags this adapter declares; what it declares none
   * for is noted. Returns the tools to narrow its command to, if any.
   */
  private routeDefinition(request: AgentRequest, adapter: Adapter, extraArgs: string[], notes: string[]): InvocationPlan["tools"] {
    const def = request.definition;
    if (!def) return undefined;
    const flags = adapter.flags ?? {};
    const who = `agentType '${def.name}'`;
    if (def.effort) {
      const level = def.effort;
      if (!flags.effort) {
        notes.push(`${who}: effort '${level}' not applied — adapter '${adapter.name}' declares no effort flag`);
      } else if (flags.effortLevels && !flags.effortLevels.includes(level)) {
        notes.push(`${who}: effort '${level}' not applied — adapter '${adapter.name}' takes ${flags.effortLevels.join(", ")}`);
      } else {
        const inPlace = flags.effort.some((part) => part.includes("{effort}"));
        extraArgs.push(...flags.effort.map((part) => part.split("{effort}").join(level)), ...(inPlace ? [] : [level]));
      }
    }
    if (def.disallowedTools && def.disallowedTools.length > 0) {
      if (flags.disallowedTools) extraArgs.push(...flags.disallowedTools, ...def.disallowedTools);
      else notes.push(`${who}: disallowedTools act only as its permissions cap on adapter '${adapter.name}', which declares no flag for them`);
    }
    if (def.tools) {
      const tool = flags.tools?.[flags.tools.length - 1];
      if (tool) {
        const mcp = def.tools.filter((name) => name.startsWith("mcp__"));
        if (mcp.length > 0) notes.push(`${who}: ${mcp.join(", ")} not narrowed — ${tool} names built-in tools only`);
        extraArgs.push(...flags.tools!.slice(0, -1));
        return { flag: tool, allow: def.tools };
      }
      notes.push(
        `${who}: tools ${def.tools.join(", ")} act only as its permissions cap ` +
          `(${def.tier ? `"${def.tier}"` : "none: Bash is among them"}) on adapter '${adapter.name}', which declares no tools flag`,
      );
    }
    return undefined;
  }

  /**
   * isolation:'worktree' → a real git worktree, exactly as in Claude Code; no
   * routing note needed because nothing is degraded. Everything else runs in
   * the source directory.
   */
  private routeIsolation(request: AgentRequest): WorkspaceMode {
    return request.isolation === "worktree" ? "worktree" : "inplace";
  }
}
