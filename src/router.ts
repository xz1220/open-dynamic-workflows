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

    this.routeModel(request, adapter, context, extraArgs, notes);
    this.noteAgentType(request, adapter, notes);
    const workspaceMode = this.routeIsolation(request, settings, notes);

    return { context, extraArgs, workspaceMode, notes };
  }

  /**
   * model → either a `{model}` token the template already carries, or the flag
   * the adapter declares, appended *only when a value is present* (so a call
   * with no model never produces a dangling `--model ""`). No carrier → a note.
   */
  private routeModel(
    request: AgentRequest,
    adapter: Adapter,
    context: PlaceholderContext,
    extraArgs: string[],
    notes: string[],
  ): void {
    if (!request.model) return;
    const usesToken =
      adapter.command.some((p) => p.includes("{model}")) ||
      (adapter.stdin?.includes("{model}") ?? false);
    const flag = adapter.flags?.model;
    if (usesToken) {
      context.model = request.model;
    } else if (flag && flag.length > 0) {
      extraArgs.push(...flag, request.model);
    } else {
      notes.push(
        `model '${request.model}' requested but adapter '${adapter.name}' declares no model flag ` +
          `— ignored (the CLI's own default model is used)`,
      );
    }
  }

  /**
   * agentType is delivered as prompt text in {@link Bridge.composePrompt} — the
   * one persona mechanism that works on every CLI. No adapter exposes a native
   * system-prompt flag this phase, so always note that the universal path ran
   * (so the author knows it was not a native `--append-system-prompt`).
   */
  private noteAgentType(request: AgentRequest, adapter: Adapter, notes: string[]): void {
    if (!request.agentType) return;
    notes.push(
      `agentType '${request.agentType}' applied via prompt injection (universal); ` +
        `adapter '${adapter.name}' has no native system-prompt flag this phase`,
    );
  }

  /**
   * isolation:'worktree' → a copy-isolated workspace. copy is already isolated
   * (the agent runs on a throwaway tree, changes returned as a diff), so it
   * satisfies the *intent* of worktree without git. Forced even when the run
   * default is `inplace`, because requesting isolation must mean isolation.
   */
  private routeIsolation(
    request: AgentRequest,
    settings: Settings,
    notes: string[],
  ): WorkspaceMode {
    if (request.isolation === "worktree") {
      notes.push(
        "isolation 'worktree' satisfied by a copy-isolated workspace " +
          "(no real git worktree this phase)",
      );
      return "copy";
    }
    return settings.workspaceMode;
  }
}
