/**
 * Per-agent limits and runaway-loop detection (L2; an ODW extension).
 *
 * An agent stuck in a loop keeps printing, so the stall watchdog never fires,
 * and `--budget` caps the whole run, not one agent. `limits` caps one agent()
 * call — the `agentLimits` setting, an adapter's own `agentLimits` over it,
 * the call's `limits` over both, key by key (`null` lifts an inherited one):
 *
 *   toolCalls     tool calls the agent makes, over all its CLI runs
 *   costUsd       dollars its CLIs report spending
 *   outputTokens  tokens its CLIs report generating
 *   seconds       wall time since its first CLI run started
 *   repeat        the same tool call — its name and a hash of its arguments —
 *                 this many times in a row within one CLI run
 *
 * They are enforced live, from what the CLI prints as it runs (its JSONL
 * events): Claude Code's stream-json `assistant` tool_use blocks and each
 * message's usage (its `result` brings the cost), Codex's `exec --json`
 * items (command_execution, file_change, mcp_tool_call, web_search) and its
 * per-turn `turn.completed` usage, kilo's and opencode's `tool_use` and
 * `step_finish` (tokens and cost) events, and agy's stream-json tool steps
 * and each step's usage (its `result` brings the total). A breach kills the CLI and
 * everything it started at once, like a stall, and the agent fails with
 * reason `runaway` and the evidence ("Bash `npm test` ×5 in a row", "41 tool
 * calls > 40"). A CLI that prints text reports no usage while it runs: its
 * outputTokens and costUsd are checked when each run ends, against what it
 * reported or ODW's chars/4 estimate of its reply; a CLI that reports no cost
 * at all (Codex) never trips costUsd. The bridge says both once per run.
 *
 * Why `repeat` counts calls in a row, not n within the last 2n: the
 * windowed rule also fires on healthy edit–test cycles (`npm test`, edit,
 * `npm test`, edit, … is the same test command n times in 2n calls), while
 * the same call with the same arguments back to back means nothing the agent
 * did in between could have changed its answer — the loop #35166 describes.
 * A further CLI run (a retry, a restart) starts its own streak: a fresh
 * session re-reading the same files is not a loop.
 */

import { createHash } from "node:crypto";

import { stableJson } from "./journal.js";
import type { Usage } from "./adapters/usage.js";

/** What one agent may do before it is stopped as a runaway (an ODW extension). */
export interface AgentLimits {
  toolCalls?: number;
  costUsd?: number;
  outputTokens?: number;
  seconds?: number;
  repeat?: number;
}

/** A layer of limits as configured or asked for: `null` lifts what a layer below set. */
export type LimitSpec = { [K in LimitName]?: number | null };

export const LIMIT_NAMES = ["toolCalls", "costUsd", "outputTokens", "seconds", "repeat"] as const;

export type LimitName = (typeof LIMIT_NAMES)[number];

/** The limit an agent ran into, what it reached, and the evidence, in a line. */
export interface LimitHit {
  limit: LimitName;
  max: number;
  value: number;
  evidence: string;
}

/** What each limit must be: a whole number for counts, any positive number for dollars and seconds. */
const RULES: Record<LimitName, { integer: boolean; min: number; expected: string }> = {
  toolCalls: { integer: true, min: 1, expected: "a whole number, 1 or more" },
  costUsd: { integer: false, min: 0, expected: "a positive number of dollars" },
  outputTokens: { integer: true, min: 1, expected: "a whole number, 1 or more" },
  seconds: { integer: false, min: 0, expected: "a positive number of seconds" },
  repeat: { integer: true, min: 2, expected: "a whole number, 2 or more" },
};

/**
 * Read a layer of limits (`where` names it in an error, e.g. `"agentLimits"`);
 * `fail` makes the error — a ConfigError for the config, an AgentError for a
 * call. A misspelled key would silently never apply, so it is refused.
 */
export function readLimits(raw: unknown, where: string, fail: (message: string) => Error): LimitSpec {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw fail(`${where} must be an object of limits — { ${LIMIT_NAMES.join(", ")} }; got ${JSON.stringify(raw) ?? String(raw)}`);
  }
  const spec: LimitSpec = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(LIMIT_NAMES as readonly string[]).includes(key)) {
      throw fail(`${where} has no limit "${key}"; use ${LIMIT_NAMES.join(", ")}`);
    }
    const name = key as LimitName;
    if (value === null) {
      spec[name] = null;
      continue;
    }
    const rule = RULES[name];
    const ok =
      typeof value === "number" &&
      Number.isFinite(value) &&
      (rule.min === 0 ? value > 0 : value >= rule.min) &&
      (!rule.integer || Number.isInteger(value));
    if (!ok) throw fail(`${where}.${name} must be ${rule.expected}, or null for none; got ${JSON.stringify(value) ?? String(value)}`);
    spec[name] = value as number;
  }
  return spec;
}

/** The limits that apply: each layer's keys over the ones before it, `null` lifting one. */
export function mergeLimits(...layers: Array<LimitSpec | undefined>): AgentLimits {
  const merged: LimitSpec = {};
  for (const layer of layers) if (layer) Object.assign(merged, layer);
  const limits: AgentLimits = {};
  for (const name of LIMIT_NAMES) {
    const value = merged[name];
    if (typeof value === "number") limits[name] = value;
  }
  return limits;
}

/** Whether any limit is set. */
export function hasLimits(limits: AgentLimits | undefined): limits is AgentLimits {
  return limits !== undefined && LIMIT_NAMES.some((name) => limits[name] !== undefined);
}

/** `limits.repeat=5`: how a hit names its limit in an error. */
export function limitLabel(hit: Pick<LimitHit, "limit" | "max">): string {
  return `limits.${hit.limit}=${hit.limit === "costUsd" ? dollars(hit.max) : hit.max}`;
}

/** A line that cannot be read whole past this is not looked at: no event of interest is that long. */
const MAX_LINE_CHARS = 4 * 1024 * 1024;

/** Tool-call and message ids remembered per CLI run, so an event seen twice counts once. */
const IDS_KEPT = 4096;

/** Characters of a tool call's command, path or query an evidence line quotes. */
const SUMMARY_CHARS = 60;

/**
 * Watches one agent() call against its limits (see the module doc): told
 * when each CLI run starts and ends, and fed what it prints as it arrives.
 * When a limit is reached it calls the run's `stop` once — the bridge kills
 * the CLI — and keeps the {@link hit}.
 */
export class LimitWatch {
  /** The limit the call ran into, once it has. */
  hit: LimitHit | null = null;
  /** When its first CLI run started, in ms: what `seconds` counts from. */
  private startedAt: number | null = null;
  private toolCalls = 0;
  /** What the call's finished runs spent, and what the running one has reported so far. */
  private spentTokens = 0;
  private spentUsd = 0;
  private runTokens = 0;
  private runUsd = 0;
  /** Output tokens per Claude message id: each message's usage comes again with each of its blocks. */
  private messages = new Map<string, number>();
  /** The running CLI run's final usage (Claude's `result`): it replaces the per-message sum. */
  private runFinal: { tokens?: number; usd?: number } = {};
  /** The running CLI run reported a cost, live or at its end. */
  private sawCost = false;
  private seen = new Set<string>();
  private streak: { key: string; tool: string; about: string | undefined; n: number } | null = null;
  private partial = "";
  private skipping = false;
  private limits: AgentLimits = {};
  private jsonl = false;
  private stop: (() => void) | null = null;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * A CLI run starts under `limits` (its adapter's), its output JSONL events
   * or not; `stop` kills it. When the call is already past `seconds`, `stop`
   * is called at once.
   */
  startRun(limits: AgentLimits, jsonl: boolean, stop: () => void): void {
    this.endRun();
    this.limits = limits;
    this.jsonl = jsonl;
    this.stop = stop;
    this.runTokens = 0;
    this.runUsd = 0;
    this.runFinal = {};
    this.sawCost = false;
    this.messages.clear();
    this.seen.clear();
    this.streak = null;
    this.partial = "";
    this.skipping = false;
    this.startedAt ??= this.now();
    if (this.hit) return stop();
    const seconds = limits.seconds;
    if (seconds === undefined) return;
    // A timer waits at most 2^31-1 ms (about 24.8 days): one that fires before
    // the call has run `seconds` arms another for the time still left.
    const arm = (): void => {
      const left = seconds * 1000 - (this.now() - this.startedAt!);
      if (left > 0) {
        this.timer = setTimeout(arm, Math.min(left, 2 ** 31 - 1));
        return;
      }
      const ran = (this.now() - this.startedAt!) / 1000;
      this.trip({ limit: "seconds", max: seconds, value: ran, evidence: `running ${Math.round(ran)}s > ${seconds}s` });
    };
    arm();
  }

  /** What the CLI printed on stdout, as it arrives. Never throws. */
  stdout(chunk: string): void {
    if (!this.jsonl || this.hit || !this.stop || !this.watching()) return;
    let from = 0;
    for (let nl = chunk.indexOf("\n"); nl !== -1; nl = chunk.indexOf("\n", from)) {
      const piece = chunk.slice(from, nl);
      from = nl + 1;
      if (this.skipping) {
        this.skipping = false;
        this.partial = "";
        continue;
      }
      const line = this.partial + piece;
      this.partial = "";
      this.line(line);
      if (this.hit) return;
    }
    if (this.skipping) return;
    this.partial += chunk.slice(from);
    if (this.partial.length > MAX_LINE_CHARS) {
      this.partial = "";
      this.skipping = true;
    }
  }

  /** The CLI run is over (or never started): its timer stops, its last unterminated line is read. */
  endRun(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.partial && !this.skipping && !this.hit && this.stop) this.line(this.partial);
    this.partial = "";
    this.stop = null;
  }

  /**
   * The run's output is decoded: what it spent — `usage` as its CLI reported
   * it, else `estimate` (chars/4 of its reply) for its output tokens — is the
   * call's, and checked against `outputTokens` and `costUsd` (a text CLI's
   * only check). Returns the hit, the live one included, or null.
   */
  settle(usage: Usage | undefined, estimate?: number): LimitHit | null {
    this.endRun();
    const tokens = usage?.outputTokens ?? this.runFinal.tokens ?? (this.runTokens > 0 ? this.runTokens : undefined);
    const usd = usage?.costUsd ?? this.runFinal.usd ?? (this.sawCost ? this.runUsd : undefined);
    const estimated = tokens === undefined && estimate !== undefined;
    this.spentTokens += tokens ?? estimate ?? 0;
    if (usd !== undefined) {
      this.spentUsd += usd;
      this.sawCost = true;
    }
    this.runTokens = 0;
    this.runUsd = 0;
    this.runFinal = {};
    this.messages.clear();
    if (!this.hit) this.checkSpend(estimated);
    return this.hit;
  }

  /** The run just settled reported a cost (live, or at its end). */
  get reportedCost(): boolean {
    return this.sawCost;
  }

  /** Something to watch the output for: a count, a streak or a spend limit. */
  private watching(): boolean {
    const l = this.limits;
    return l.toolCalls !== undefined || l.repeat !== undefined || l.outputTokens !== undefined || l.costUsd !== undefined;
  }

  private trip(hit: LimitHit): void {
    if (this.hit) return;
    this.hit = hit;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.stop?.();
  }

  // --- the events -------------------------------------------------------------------

  private line(text: string): void {
    const trimmed = text.trim();
    if (!trimmed.startsWith("{")) return;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!isRecord(event)) return;
    if (typeof event.type !== "string") {
      if (typeof event.event === "string") this.agyEvent(event);
      if (!this.hit) this.checkSpend(false);
      return;
    }
    switch (event.type) {
      // Claude Code stream-json: tool_use blocks, and each message's usage.
      case "assistant": {
        const message = isRecord(event.message) ? event.message : {};
        for (const block of Array.isArray(message.content) ? message.content : []) {
          if (!isRecord(block)) continue;
          if (block.type === "tool_use" || block.type === "server_tool_use" || block.type === "mcp_tool_use") {
            this.call(block.id, block.name, block.input);
            if (this.hit) return;
          }
        }
        // Each block of a message comes with the message's usage so far: the latest counts once.
        const usage = isRecord(message.usage) ? message.usage : null;
        const out = usage ? count(usage.output_tokens) : undefined;
        if (out !== undefined && typeof message.id === "string") {
          const before = this.messages.get(message.id) ?? 0;
          if (out > before) {
            this.remember(this.messages, message.id, out);
            this.runTokens += out - before;
          }
        }
        break;
      }
      case "result": {
        // The session's own totals, as it ends.
        const usage = isRecord(event.usage) ? event.usage : null;
        const out = usage ? count(usage.output_tokens) : undefined;
        if (out !== undefined) this.runFinal.tokens = out;
        const usd = count(event.total_cost_usd);
        if (usd !== undefined) {
          this.runFinal.usd = usd;
          this.sawCost = true;
        }
        break;
      }
      // kilo / opencode: a tool reported once it is done; each step's tokens and cost.
      case "tool_use": {
        const part = isRecord(event.part) ? event.part : {};
        const state = isRecord(part.state) ? part.state : {};
        this.call(part.callID ?? part.id, part.tool, state.input);
        break;
      }
      case "step_finish": {
        const part = isRecord(event.part) ? event.part : {};
        const tokens = isRecord(part.tokens) ? part.tokens : {};
        const out = (count(tokens.output) ?? 0) + (count(tokens.reasoning) ?? 0);
        this.runTokens += out;
        const usd = count(part.cost);
        if (usd !== undefined) {
          this.runUsd += usd;
          this.sawCost = true;
        }
        break;
      }
      // Codex `exec --json`: a tool's item, the first time it shows; each turn's usage.
      case "item.started":
      case "item.completed":
        this.codexItem(event.type === "item.completed", event.item);
        break;
      case "turn.completed": {
        const usage = isRecord(event.usage) ? event.usage : null;
        this.runTokens += (usage ? count(usage.output_tokens) : undefined) ?? 0;
        break;
      }
      default:
        return;
    }
    if (!this.hit) this.checkSpend(false);
  }

  /**
   * agy stream-json (events named by `event`; https://antigravity.google/docs/cli/headless):
   * a tool step, once it shows its parameters or ends; each step's usage; the
   * result's total.
   */
  private agyEvent(event: Record<string, unknown>): void {
    if (event.event === "result") {
      const result = isRecord(event.result) ? event.result : {};
      const usage = isRecord(result.usage) ? result.usage : null;
      const out = usage ? count(usage.output_tokens) : undefined;
      if (out !== undefined) this.runFinal.tokens = out;
      return;
    }
    if (event.event !== "step_update" || !isRecord(event.step_update)) return;
    const step = event.step_update;
    if (step.step_type === "tool") {
      const info = isRecord(step.tool_info) ? step.tool_info : {};
      if (info.parameters !== undefined || step.state !== "ACTIVE") {
        const name = typeof step.tool_name === "string" && step.tool_name ? step.tool_name : info.name;
        this.call(`agy:${String(step.conversation_id ?? "")}:${String(step.step_index ?? "")}`, name, info.parameters);
      }
    }
    // A step's usage comes once, as it ends.
    const usage = isRecord(step.usage) && step.state !== "ACTIVE" ? step.usage : null;
    this.runTokens += (usage ? count(usage.output_tokens) : undefined) ?? 0;
  }

  private codexItem(done: boolean, raw: unknown): void {
    if (!isRecord(raw)) return;
    const words = (value: unknown): string => (typeof value === "string" ? value : "");
    switch (raw.type) {
      case "command_execution":
        return this.call(raw.id, "shell", { command: words(raw.command) });
      case "mcp_tool_call":
        return this.call(raw.id, [words(raw.server), words(raw.tool)].filter(Boolean).join(".") || "mcp", raw.arguments);
      case "file_change":
        return this.call(raw.id, "edit", raw.changes);
      case "web_search":
        // A search may start before its query is known: it counts once it is done.
        if (done) this.call(raw.id, "web_search", { query: raw.query, action: raw.action });
        return;
      default:
        return;
    }
  }

  /** One tool call: counted (once per id), and checked against `toolCalls` and `repeat`. */
  private call(id: unknown, name: unknown, input: unknown): void {
    if (typeof id === "string" && id) {
      if (this.seen.has(id)) return;
      this.remember(this.seen, id);
    }
    const tool = typeof name === "string" && name ? name : "tool";
    this.toolCalls++;
    const { toolCalls, repeat } = this.limits;
    if (toolCalls !== undefined && this.toolCalls > toolCalls) {
      return this.trip({
        limit: "toolCalls",
        max: toolCalls,
        value: this.toolCalls,
        evidence: `${this.toolCalls} tool calls > ${toolCalls}`,
      });
    }
    if (repeat === undefined) return;
    const key = `${tool}\u0000${argumentsHash(input)}`;
    if (this.streak?.key === key) this.streak.n++;
    else this.streak = { key, tool, about: summary(input), n: 1 };
    if (this.streak.n >= repeat) {
      const { about, n } = this.streak;
      this.trip({
        limit: "repeat",
        max: repeat,
        value: n,
        evidence: `${tool}${about !== undefined ? ` \`${about}\`` : ""} ×${n} in a row`,
      });
    }
  }

  private checkSpend(estimated: boolean): void {
    const { outputTokens, costUsd } = this.limits;
    const tokens = this.spentTokens + (this.runFinal.tokens ?? this.runTokens);
    if (outputTokens !== undefined && tokens > outputTokens) {
      const about = estimated ? " (estimated: chars/4 of its reply)" : "";
      return this.trip({
        limit: "outputTokens",
        max: outputTokens,
        value: tokens,
        evidence: `${thousands(tokens)} output tokens > ${thousands(outputTokens)}${about}`,
      });
    }
    const usd = this.spentUsd + (this.runFinal.usd ?? this.runUsd);
    if (costUsd !== undefined && usd > costUsd) {
      this.trip({ limit: "costUsd", max: costUsd, value: usd, evidence: `${dollars(usd)} > ${dollars(costUsd)}` });
    }
  }

  /** Keep `key` (with `value`, for a map), forgetting the oldest past {@link IDS_KEPT}. */
  private remember(into: Set<string> | Map<string, number>, key: string, value = 0): void {
    if (into instanceof Map) into.set(key, value);
    else into.add(key);
    if (into.size > IDS_KEPT) into.delete(into.keys().next().value!);
  }
}

/** A stable hash of a tool call's arguments: the same arguments, whatever their key order, hash alike. */
export function argumentsHash(input: unknown): string {
  let json: string;
  try {
    json = stableJson(input ?? null);
  } catch {
    json = String(input);
  }
  return createHash("sha256").update(json).digest("hex").slice(0, 16);
}

/** The input fields that say what a call is about, in the order they are looked for. */
const SUMMARY_FIELDS = ["command", "file_path", "filePath", "notebook_path", "pattern", "path", "url", "query", "description", "prompt"];

/** What a tool call is about, on one line and short — its command, file, pattern, … — or nothing. */
function summary(input: unknown): string | undefined {
  let text: string | undefined;
  if (typeof input === "string") text = input;
  else if (isRecord(input)) {
    for (const field of SUMMARY_FIELDS) {
      const value = input[field];
      if (typeof value === "string" && value.trim()) {
        text = value;
        break;
      }
    }
  }
  if (text === undefined) return undefined;
  // eslint-disable-next-line no-control-regex
  const line = text.replace(/[\u0000-\u001f\u007f`]+/g, " ").replace(/\s+/g, " ").trim();
  if (!line) return undefined;
  return line.length > SUMMARY_CHARS ? `${line.slice(0, SUMMARY_CHARS - 1)}…` : line;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function dollars(usd: number): string {
  return `$${usd < 1 ? usd.toFixed(4).replace(/0{1,2}$/, "") : usd.toFixed(2)}`;
}

function thousands(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
