/**
 * `odw agents types [--adapter <name>] [--json]` (ODW extension; see
 * ./agent-types): the agent definitions `agentType` can name from here, in
 * lookup order, and what each maps to on an adapter — its flags, its
 * permission tier, and what is not applied. Reads files; runs nothing.
 */

import { parseArgs } from "node:util";

import { loadConfig, resolveAdapter } from "./adapters/config.js";
import { minTier, planPermissions, runTier, spliceArgs } from "./adapters/permissions.js";
import { runTrust } from "./adapters/trust.js";
import type { Adapter, Config } from "./adapters/types.js";
import { discoverAgentTypes, narrowTools, planAgentType, type AgentTypePlan } from "./agent-types.js";
import { LiteralRouter } from "./router.js";

/** What one definition maps to on one adapter. */
export interface AgentTypeMapping {
  adapter: string;
  /** The tier its agents run at there (the run's, capped by its tools), or null when it cannot run. */
  permissions: string | null;
  /** The argv the definition adds or narrows: model, effort, tool flags. */
  args: string[];
  /** What it does not apply there, and why. */
  notes: string[];
}

/** One definition and its mapping on `adapter`, as `--json` prints it. */
export function describeAgentType(plan: AgentTypePlan, adapter: Adapter, config: Config): AgentTypeMapping {
  const run = runTier(config);
  const ceiling = planPermissions(adapter, run).requested ?? run;
  const tier = plan.tier ? minTier(ceiling, plan.tier) : undefined;
  const permissions = planPermissions(adapter, run, tier);
  const routed = new LiteralRouter().plan({
    request: { prompt: "", agentType: plan.name, definition: plan },
    adapter,
    settings: config.settings,
  });
  const args = [...routed.extraArgs];
  if (routed.tools) {
    // Only what the definition adds: the tool flag as narrowed from the tier's.
    const before = spliceArgs(adapter.command, permissions.args);
    const after = narrowTools(before, routed.tools.flag, routed.tools.allow);
    const at = after.indexOf(routed.tools.flag);
    if (at !== -1) args.unshift(routed.tools.flag, after[at + 1]!);
  }
  return {
    adapter: adapter.name,
    permissions: permissions.error ? null : (permissions.tier ?? null),
    args,
    notes: [...(permissions.error ? [permissions.error] : []), ...routed.notes],
  };
}

export function cmdAgentTypes(rest: string[]): number {
  const { values } = parseArgs({
    args: rest,
    allowPositionals: false,
    options: { config: { type: "string" }, adapter: { type: "string" }, json: { type: "boolean" } },
  });
  const config = loadConfig(values.config ?? null, { quiet: true });
  let adapter: Adapter;
  try {
    adapter = resolveAdapter(config, values.adapter ?? config.settings.defaultAdapter ?? (config.adapters.claude ? "claude" : undefined));
  } catch (err) {
    process.stderr.write(`odw agents types: ${(err as Error).message}\n`);
    return 2;
  }
  const untrusted = runTrust(config) === "untrusted";
  const { definitions, notes } = discoverAgentTypes({ cwd: process.cwd(), trust: untrusted ? "untrusted" : "trusted" });
  const rows = definitions.map((def) => {
    const plan = planAgentType(def, untrusted);
    return { plan, mapping: describeAgentType(plan, adapter, config) };
  });
  if (values.json) {
    const out = rows.map(({ plan, mapping }) => ({
      name: plan.name,
      source: plan.source,
      path: plan.path,
      sha256: plan.sha256,
      ...(plan.model ? { model: plan.model } : {}),
      ...(plan.effort ? { effort: plan.effort } : {}),
      ...(plan.isolation ? { isolation: plan.isolation } : {}),
      ...(plan.tools ? { tools: plan.tools } : {}),
      ...(plan.disallowedTools ? { disallowedTools: plan.disallowedTools } : {}),
      ...(plan.tier ? { tier: plan.tier } : {}),
      notes: plan.notes,
      mapping,
    }));
    process.stdout.write(JSON.stringify({ definitions: out, notes }, null, 2) + "\n");
    return 0;
  }
  if (rows.length === 0) {
    process.stderr.write(
      "no agent definitions found\n" +
        "  add one as a Markdown file with frontmatter in ./.claude/agents, ./.odw/agents or ~/.claude/agents\n",
    );
  }
  for (const { plan, mapping } of rows) {
    process.stdout.write(`${plan.name}  (${plan.source})  ${plan.path}  sha256 ${plan.sha256.slice(0, 12)}\n`);
    const what = [`persona ${plan.body ? `${plan.body.split("\n").length} lines` : "none (one-line persona)"}`];
    if (plan.model) what.push(`model ${plan.model}`);
    if (plan.tools) what.push(`tools ${plan.tools.join(", ")}`);
    if (plan.disallowedTools) what.push(`disallowedTools ${plan.disallowedTools.join(", ")}`);
    if (plan.isolation) what.push(`isolation ${plan.isolation}`);
    if (plan.effort) what.push(`effort ${plan.effort}`);
    process.stdout.write(`  ${what.join(" · ")}\n`);
    const tier = mapping.permissions ? `permissions ${mapping.permissions}` : "cannot run";
    process.stdout.write(`  on ${mapping.adapter}: ${tier}${mapping.args.length > 0 ? `, ${mapping.args.join(" ")}` : ""}\n`);
    for (const note of [...plan.notes, ...mapping.notes]) process.stdout.write(`  note: ${note}\n`);
  }
  for (const note of notes) process.stderr.write(`note: ${note}\n`);
  return 0;
}
