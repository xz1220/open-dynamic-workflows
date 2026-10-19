/**
 * Agent definitions behind `agentType` (ODW extension: U1).
 *
 * In Claude Code, `agent(prompt, { agentType: "<name>" })` names a subagent
 * defined in a Markdown file: YAML frontmatter (`name`, `tools`,
 * `disallowedTools`, `model`, `effort`, `isolation`, …) and a body that is its
 * system prompt (https://code.claude.com/docs/en/sub-agents). ODW reads the same
 * files and maps what each CLI can carry, instead of treating the name as a
 * one-line persona:
 *
 *   - the body is the agent's persona prompt (every CLI: it goes in the prompt);
 *   - `model` is the call's default model — `agent()`'s own `model` wins; on a
 *     CLI other than Claude Code an alias (`sonnet`) maps through the `models`
 *     tier of that name, else the CLI's default runs and the run says so;
 *   - `tools` / `disallowedTools` cap the permission tier — only read-only tools
 *     (Read, Glob, Grep, WebFetch, WebSearch) is `read`, no Bash is at most
 *     `edit` — and never raise it; a CLI that declares tool flags (Claude Code's
 *     `--tools`, `--disallowedTools`) is also handed the lists, narrowed only;
 *   - `isolation: worktree` is `agent()`'s `isolation: "worktree"`;
 *   - `effort` goes to a CLI that declares an effort flag (`claude --effort`,
 *     `codex -c model_reasoning_effort=`), else the run says it had no effect;
 *   - every other field (`permissionMode`, `maxTurns`, `mcpServers`, `hooks`,
 *     `skills`, …) is listed in the run's log as not applied — never dropped
 *     silently.
 *
 * Lookup follows Claude Code's order: `.claude/agents/` in the working directory
 * and each parent up to the repository root (nearest wins), then `.odw/agents/`
 * the same way (an ODW extension, same format), then `~/.claude/agents/`
 * (`$CLAUDE_CONFIG_DIR/agents`), then the `agents/` of installed, enabled
 * Claude Code plugins as `<plugin>:<name>`. A definition is found by its
 * frontmatter `name`, not its file name. Nothing found: the old one-line
 * persona, and a log line. In an untrusted run a definition from the
 * repository gives its body and what only tightens (tools, isolation), not its
 * model or effort. Files are read, never run.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import type { PermissionTier, TrustLevel } from "./adapters/types.js";
import { claudeConfigDir, enabledPluginInstalls, parsePluginRef, pluginFiles } from "./workflows/plugins.js";

/** Where a definition was found: the repository's `.claude/agents`, its `.odw/agents`, the user's, a plugin's. */
export type AgentTypeSource = "project" | "odw" | "user" | "plugin";

/** One agent definition file, parsed. */
export interface AgentDefinition {
  /** What `agentType` names it by: its `name` (a plugin's: `<plugin>:<name>`). */
  name: string;
  source: AgentTypeSource;
  /** The file, absolute. */
  path: string;
  /** sha256 of the file: `agent_started`'s `agentType.sha256`, which `odw compare` reads. */
  sha256: string;
  /** The body: its system prompt, ODW's persona prompt. */
  body: string;
  /** Its frontmatter, as parsed: strings, lists of strings, or `true` for a nested block. */
  fields: Record<string, FieldValue>;
}

type FieldValue = string | string[] | true;

/** What one definition maps to (see {@link planAgentType}); the same on every adapter. */
export interface AgentTypePlan {
  name: string;
  source: AgentTypeSource;
  path: string;
  sha256: string;
  body: string;
  /** Its `model`, unless `inherit` (or dropped in an untrusted run). */
  model?: string;
  /** Its `effort`, when one of the documented levels. */
  effort?: string;
  isolation?: "worktree";
  /** Its `tools` (an allowlist), and `disallowedTools`, as written. */
  tools?: string[];
  disallowedTools?: string[];
  /** The highest tier its tools allow: a cap, never a raise. Absent: no cap. */
  tier?: PermissionTier;
  /** What was not applied and why — unsupported fields, bad values: the run logs them once. */
  notes: string[];
}

/** The tools that only read: an agent limited to them runs at `read`. */
export const READ_ONLY_TOOLS: readonly string[] = ["Read", "Glob", "Grep", "WebFetch", "WebSearch"];

/** `effort` levels Claude Code documents for a subagent. */
export const EFFORT_LEVELS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

/** Fields that describe the agent and change nothing about how it runs. */
const DESCRIPTIVE = new Set(["name", "description", "color"]);
/** Fields ODW maps. */
const MAPPED = new Set(["tools", "disallowedTools", "model", "effort", "isolation"]);

export interface AgentTypeOptions {
  /** Where the run works: the walk up to the repository root starts here. */
  cwd: string;
  trust?: TrustLevel;
}

/** Every definition, in lookup order, the first of a name winning; what was shadowed or unreadable goes in `notes`. */
export function discoverAgentTypes(opts: AgentTypeOptions): { definitions: AgentDefinition[]; notes: string[] } {
  const notes: string[] = [];
  const out: AgentDefinition[] = [];
  const seen = new Map<string, AgentDefinition>();
  const add = (def: AgentDefinition): void => {
    const first = seen.get(def.name);
    if (first) {
      if (first.path !== def.path) notes.push(`agent type '${def.name}' in ${def.path} is shadowed by ${first.path}`);
      return;
    }
    seen.set(def.name, def);
    out.push(def);
  };
  const levels = upToRoot(resolve(opts.cwd));
  for (const [dir, source] of [
    ...levels.map((level) => [join(level, ".claude", "agents"), "project"] as const),
    ...levels.map((level) => [join(level, ".odw", "agents"), "odw"] as const),
    [join(claudeConfigDir(), "agents"), "user"] as const,
  ]) {
    for (const file of markdownFiles(dir)) {
      const def = readDefinition(file, source, notes);
      if (def) add(def);
    }
  }
  for (const plugin of enabledPluginInstalls({ cwd: opts.cwd, trust: opts.trust }, notes)) {
    for (const file of pluginFiles(plugin.installPath, plugin.manifest.agents, "agents", ".md", plugin.id, notes)) {
      const def = readDefinition(file, "plugin", notes, plugin.plugin);
      if (def) add(def);
    }
  }
  return { definitions: out, notes };
}

/** The definition `agentType` names, or null (the caller keeps the one-line persona and says so). */
export function findAgentType(name: string, opts: AgentTypeOptions): AgentDefinition | null {
  const { definitions } = discoverAgentTypes(opts);
  const exact = definitions.find((def) => def.name === name);
  if (exact) return exact;
  // `<plugin>:<name>` only ever names a plugin's agent; a bare name may too, when one plugin alone has it.
  if (parsePluginRef(name)) return null;
  const plugged = definitions.filter((def) => def.source === "plugin" && def.name.split(":")[1] === name);
  return plugged.length === 1 ? plugged[0]! : null;
}

/**
 * What a definition maps to. `untrusted`: in an untrusted run, a definition
 * from the repository (`project`, `odw`) gives its body and what only
 * tightens — tools, isolation — and not its model or effort.
 */
export function planAgentType(def: AgentDefinition, untrusted = false): AgentTypePlan {
  const notes: string[] = [];
  const plan: AgentTypePlan = { name: def.name, source: def.source, path: def.path, sha256: def.sha256, body: def.body, notes };
  const fromRepo = untrusted && (def.source === "project" || def.source === "odw");
  const scalar = (key: string): string | undefined => {
    const value = def.fields[key];
    if (value === undefined) return undefined;
    if (typeof value === "string" && value !== "") return value;
    notes.push(`${key}: ${describe(value)} is not a single value — not applied`);
    return undefined;
  };
  const list = (key: string): string[] | undefined => {
    const value = def.fields[key];
    if (value === undefined) return undefined;
    if (value === true) {
      notes.push(`${key} is not a list of tool names — not applied`);
      return undefined;
    }
    return (Array.isArray(value) ? value : value.split(",")).map((tool) => tool.trim()).filter((tool) => tool !== "");
  };

  const model = scalar("model");
  if (model !== undefined && model !== "inherit") {
    if (fromRepo) notes.push(`model '${model}' not applied: the definition is the repository's and the run is untrusted`);
    else plan.model = model;
  }
  const effort = scalar("effort");
  if (effort !== undefined) {
    if (!EFFORT_LEVELS.includes(effort)) notes.push(`effort '${effort}' is not one of ${EFFORT_LEVELS.join(", ")} — not applied`);
    else if (fromRepo) notes.push(`effort '${effort}' not applied: the definition is the repository's and the run is untrusted`);
    else plan.effort = effort;
  }
  const isolation = scalar("isolation");
  if (isolation === "worktree") plan.isolation = "worktree";
  else if (isolation !== undefined) notes.push(`isolation '${isolation}' is not "worktree" — not applied`);
  const tools = list("tools");
  if (tools) plan.tools = tools;
  const disallowed = list("disallowedTools");
  if (disallowed) plan.disallowedTools = disallowed;
  const tier = toolsTier(tools, disallowed);
  if (tier) plan.tier = tier;

  const unsupported = Object.keys(def.fields).filter((key) => !DESCRIPTIVE.has(key) && !MAPPED.has(key));
  if (unsupported.length > 0) notes.push(`not supported by ODW, not applied: ${unsupported.join(", ")}`);
  return plan;
}

/**
 * The highest tier a tool list allows: only read-only tools — `read`; no Bash
 * — `edit`; else none. A tool with a rule (`Bash(git *)`) counts as its tool;
 * a disallowed one takes its tool away only when it has no rule.
 */
export function toolsTier(tools: string[] | undefined, disallowed: string[] | undefined): PermissionTier | undefined {
  const denied = new Set((disallowed ?? []).filter((tool) => !tool.includes("(")));
  if (tools) {
    const allowed = tools.map(toolName).filter((tool) => !denied.has(tool));
    if (allowed.every((tool) => READ_ONLY_TOOLS.includes(tool))) return "read";
    return allowed.includes("Bash") ? undefined : "edit";
  }
  return denied.has("Bash") ? "edit" : undefined;
}

/** A tool's name without its rule: `Bash(git *)` → `Bash`. */
export function toolName(tool: string): string {
  const at = tool.indexOf("(");
  return (at === -1 ? tool : tool.slice(0, at)).trim();
}

/**
 * `argv` with only `allow`'s built-in tools available through `flag`
 * (Claude Code's `--tools`, a comma-separated list): an existing list — a
 * read tier's — is narrowed to the tools both name; else the flag is added.
 * MCP tools (`mcp__…`) are not built-ins and are left out of it.
 */
export function narrowTools(argv: readonly string[], flag: string, allow: readonly string[]): string[] {
  const wanted = [...new Set(allow.map(toolName).filter((tool) => tool !== "" && !tool.startsWith("mcp__")))];
  const at = argv.indexOf(flag);
  if (at !== -1 && at + 1 < argv.length) {
    const have = argv[at + 1]!.split(",").map((tool) => tool.trim());
    const kept = have.filter((tool) => wanted.includes(tool));
    return [...argv.slice(0, at + 1), kept.join(","), ...argv.slice(at + 2)];
  }
  return [...argv, flag, wanted.join(",")];
}

/** The run's one log line for a definition: where it came from, what it maps to, and what it does not. */
export function agentTypeSummary(plan: AgentTypePlan): string {
  const mapped = ["its body is the persona prompt"];
  if (plan.model) mapped.push(`model '${plan.model}' unless agent() names one`);
  if (plan.tier) mapped.push(`tools cap permissions at "${plan.tier}"`);
  if (plan.isolation) mapped.push(`isolation "${plan.isolation}"`);
  if (plan.effort) mapped.push(`effort '${plan.effort}'`);
  const rest = plan.notes.length > 0 ? `; ${plan.notes.join("; ")}` : "";
  return `agentType '${plan.name}': ${plan.path} (${plan.source}) — ${mapped.join(", ")}${rest}`;
}

/** What `agent_started` records of the definition an agent ran as: `odw compare` sees it change. */
export function agentTypeField(plan: AgentTypePlan): { name: string; source: AgentTypeSource; path: string; sha256: string } {
  return { name: plan.name, source: plan.source, path: plan.path, sha256: plan.sha256 };
}

// --- reading -------------------------------------------------------------------

/** The working directory, then each parent up to the repository root (one with `.git`); only `cwd` outside a repository. */
function upToRoot(cwd: string): string[] {
  const levels: string[] = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    levels.push(dir);
    if (existsSync(join(dir, ".git"))) return levels;
    if (dirname(dir) === dir) return [cwd];
  }
}

function markdownFiles(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => join(dir, name))
    .filter((path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    });
}

/** One definition file, or null (with a note) when it cannot be one. */
function readDefinition(path: string, source: AgentTypeSource, notes: string[], plugin?: string): AgentDefinition | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    notes.push(`could not read ${path}: ${(err as Error).message}`);
    return null;
  }
  const parsed = parseFrontmatter(text);
  if (!parsed) {
    notes.push(`${path} has no frontmatter (--- … ---); not an agent definition`);
    return null;
  }
  const own = typeof parsed.fields.name === "string" && parsed.fields.name !== "" ? parsed.fields.name : null;
  const name = own ?? basename(path, ".md");
  if (!own) notes.push(`${path} has no name in its frontmatter; known by its file name '${name}'`);
  return {
    name: plugin ? `${plugin}:${name}` : name,
    source,
    path,
    sha256: createHash("sha256").update(text).digest("hex"),
    body: parsed.body.trim(),
    fields: parsed.fields,
  };
}

/**
 * The YAML frontmatter Claude Code's agent files use, read for what it says:
 * `key: value` (quotes dropped), `key: [a, b]`, `key:` over `- item` lines,
 * `key: |` / `>` over indented text. Anything else nested under a key (a
 * `hooks` map) is kept as `true`: present, not read. Null without frontmatter.
 */
export function parseFrontmatter(text: string): { fields: Record<string, FieldValue>; body: string } | null {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (end === -1) return null;
  const fields: Record<string, FieldValue> = {};
  const head = lines.slice(1, end);
  for (let i = 0; i < head.length; i++) {
    const line = head[i]!;
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m || /^\s/.test(line)) continue;
    const key = m[1]!;
    const raw = m[2]!.replace(/\s+#.*$/, "").trim();
    // The lines indented under it.
    const nested: string[] = [];
    while (i + 1 < head.length && (head[i + 1]!.trim() === "" || /^\s/.test(head[i + 1]!) || /^-\s/.test(head[i + 1]!))) {
      nested.push(head[++i]!);
    }
    const inner = nested.filter((l) => l.trim() !== "");
    if (raw === "|" || raw === ">" || raw === "|-" || raw === ">-") {
      fields[key] = inner.map((l) => l.trim()).join(raw.startsWith("|") ? "\n" : " ");
    } else if (raw === "") {
      fields[key] = inner.length > 0 && inner.every((l) => /^\s*-\s+/.test(l)) ? inner.map((l) => unquote(l.replace(/^\s*-\s+/, ""))) : inner.length > 0 ? true : "";
    } else if (raw.startsWith("[") && raw.endsWith("]")) {
      fields[key] = raw
        .slice(1, -1)
        .split(",")
        .map((item) => unquote(item))
        .filter((item) => item !== "");
    } else {
      fields[key] = unquote(raw);
    }
  }
  return { fields, body: lines.slice(end + 1).join("\n") };
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) return v.slice(1, -1);
  return v;
}

function describe(value: FieldValue): string {
  return value === true ? "a nested block" : JSON.stringify(value);
}
