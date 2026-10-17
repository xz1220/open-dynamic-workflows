/**
 * Evidence of success (an ODW extension): checks on what an agent did.
 *
 * A headless agent can "succeed" without doing the work — it replies that the
 * bug is fixed and never touched a file, or that the tests pass while they are
 * still red. `agent(prompt, { expect })` states what must hold once the agent
 * has replied, and ODW checks it rather than asking the model:
 *
 *   - changes  `true`: some file must change; `false`: none may
 *   - files    globs, each of which must match a file the agent changed or
 *              created (not one it deleted)
 *   - command  must exit 0 in the agent's workspace, killed after `timeout`
 *              seconds (600 by default) — an exec() step of the run, shown
 *              under the agent, so a stop kills it
 *   - match    a regular expression the reply must match
 *
 * The checks run once the reply is in and satisfies the call's schema. What
 * the agent changed is what the run keeps as its change: with isolation, the
 * paths of the diff its worktree leaves (./changes — against the base commit,
 * its own commits included, setup files left out); in place, what differs from
 * the source tree as it was before the agent's first CLI run (`git status`
 * against a snapshot, and any commit made since), the run's own directory left
 * out. In place the tree is shared, so edits another agent makes meanwhile
 * count too: isolate for an exact answer. Paths, and the globs that match
 * them, are relative to the agent's workspace, with forward slashes.
 *
 * Work that misses runs again with what it missed appended to its prompt, up
 * to `expectRetries` times (default 1); then the call fails with reason
 * "unmet_expectation" and the list of misses (the bridge's loop, ./bridge).
 * An isolated retry starts over in a fresh worktree, and the change it leaves
 * replaces the earlier one (ChangeRecorder.redo).
 */

import { lstat, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { changedSince, rebaseline, relativeToDir, snapshotTree, type TreeSnapshot } from "./changes.js";
import { AgentError } from "./errors.js";
import type { ExecOptions, ExecResult } from "./exec.js";
import type { Workspace, WorkspaceMode } from "./workspace.js";

/** What `agent(prompt, { expect })` checks once the agent has replied (ODW extension). */
export interface ExpectOptions {
  /** `true`: the agent must change some file; `false`: it must change none. */
  changes?: boolean;
  /** Globs, relative to the agent's workspace: each must match a file it changed or created. */
  files?: string[];
  /** Must exit 0, run in the agent's workspace: a string through the shell, an array as argv. */
  command?: string | string[];
  /** A regular expression (its source, no flags) the reply must match. */
  match?: string;
  /** Seconds the command may run before it is killed — a miss (default 600). */
  timeout?: number;
}

/** The checks of one agent() call, validated. */
export interface ExpectPlan {
  changes?: boolean;
  files: Array<{ glob: string; pattern: RegExp }>;
  command?: string | string[];
  match?: RegExp;
  /** Seconds the command may run. */
  timeout: number;
}

/** The output checks an agent() call asked for, validated before it starts. */
export interface AgentChecks {
  /** Its `expect` checks; null when it has none. */
  expect: ExpectPlan | null;
  /** Its own `expectRetries`, when it set one. */
  expectRetries?: number;
  /** An empty reply is an answer, not an "empty_reply" failure. */
  allowEmpty: boolean;
}

/** One check an attempt's work did not meet. */
export interface ExpectMiss {
  /** What was expected and what happened, in one line: "a file must change, and none did". */
  text: string;
  /** What the agent needs to see to fix it — the end of a failed command's output — for its retry prompt. */
  detail?: string;
}

/**
 * Where the bridge reports a call's work to its checks: an {@link Expectations}.
 * The bridge tells it the workspace mode before the call's first CLI run, hands
 * it each isolated run that ended with a reply before its worktree goes, and
 * asks it, once a reply satisfies the schema, what the work missed.
 */
export interface ExpectationSink {
  /** How many times work that missed may run again, told what it missed. */
  readonly retries: number;
  /** Before the call's first CLI run: where its work happens. */
  begin(mode: WorkspaceMode, source: string): Promise<void>;
  /** An isolated CLI run that ended with a reply, in its worktree before the worktree goes. */
  inspect(ws: Workspace): Promise<void>;
  /** The attempt's reply is in and satisfies its schema: what its work missed — none when it is done. */
  check(reply: string): Promise<ExpectMiss[]>;
  /** What to tell the next attempt about `misses`, appended to its prompt. */
  feedback(misses: ExpectMiss[]): string;
  /** The work runs again: what the next attempts do is judged afresh. */
  retry(): void;
}

/** Seconds an `expect.command` may run, unless `expect.timeout` says otherwise. */
export const DEFAULT_EXPECT_TIMEOUT = 600;

const EXPECT_KEYS = ["changes", "files", "command", "match", "timeout"];

/** Check an agent() call's `expect`, `expectRetries` and `allowEmpty`; a misuse is a recoverable AgentError. */
export function planChecks(opts: { expect?: unknown; expectRetries?: unknown; allowEmpty?: unknown }): AgentChecks {
  const { expectRetries, allowEmpty } = opts;
  if (allowEmpty !== undefined && typeof allowEmpty !== "boolean") {
    throw misuse(`allowEmpty must be true or false; got ${describeValue(allowEmpty)}`);
  }
  if (expectRetries !== undefined && !(typeof expectRetries === "number" && Number.isInteger(expectRetries) && expectRetries >= 0)) {
    throw misuse(`expectRetries must be a whole number, 0 or more; got ${describeValue(expectRetries)}`);
  }
  const checks: AgentChecks = { expect: planExpect(opts.expect), allowEmpty: allowEmpty === true };
  if (expectRetries !== undefined) checks.expectRetries = expectRetries;
  return checks;
}

function planExpect(raw: unknown): ExpectPlan | null {
  if (raw === undefined) return null;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw misuse(`expect must be an object of checks — { changes?, files?, command?, match?, timeout? }; got ${describeValue(raw)}`);
  }
  const spec = raw as Record<string, unknown>;
  for (const key of Object.keys(spec)) {
    // A misspelled check would silently never run.
    if (!EXPECT_KEYS.includes(key)) throw misuse(`expect has no check "${key}"; use ${EXPECT_KEYS.join(", ")}`);
  }
  const plan: ExpectPlan = { files: [], timeout: DEFAULT_EXPECT_TIMEOUT };
  const { changes, files, command, match, timeout } = spec;
  if (changes !== undefined) {
    if (typeof changes !== "boolean") throw misuse(`expect.changes must be true or false; got ${describeValue(changes)}`);
    plan.changes = changes;
  }
  if (files !== undefined) {
    if (!Array.isArray(files) || !files.every((glob) => typeof glob === "string" && glob.trim() !== "")) {
      throw misuse(`expect.files must be an array of globs (non-empty strings); got ${describeValue(files)}`);
    }
    for (const glob of files as string[]) {
      if (glob.startsWith("/")) throw misuse(`expect.files globs are relative to the agent's workspace; got "${glob}"`);
      try {
        plan.files.push({ glob, pattern: globToRegExp(glob) });
      } catch (err) {
        throw misuse(`expect.files has an invalid glob "${glob}": ${(err as Error).message}`);
      }
    }
  }
  if (command !== undefined) {
    const argv = Array.isArray(command) && command.length > 0 && command.every((part) => typeof part === "string") && command[0] !== "";
    if (!(typeof command === "string" && command.trim() !== "") && !argv) {
      throw misuse(
        `expect.command must be a command string (run by the shell) or an argv array of strings; got ${describeValue(command)}`,
      );
    }
    plan.command = command as string | string[];
  }
  if (match !== undefined) {
    if (typeof match !== "string") throw misuse(`expect.match must be a regular expression's source, as a string; got ${describeValue(match)}`);
    try {
      plan.match = new RegExp(match);
    } catch (err) {
      throw misuse(`expect.match is not a valid regular expression: ${(err as Error).message}`);
    }
  }
  if (timeout !== undefined) {
    if (typeof timeout !== "number" || !(timeout > 0)) {
      throw misuse(`expect.timeout must be a positive number of seconds; got ${describeValue(timeout)}`);
    }
    plan.timeout = timeout;
  }
  return plan.changes === undefined && plan.files.length === 0 && plan.command === undefined && plan.match === undefined
    ? null
    : plan;
}

function misuse(message: string): AgentError {
  return new AgentError(`agent(): ${message}`);
}

function describeValue(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return value.length > 0 ? "an array" : "an empty array";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") return value.trim() ? "a string" : "an empty string";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

/**
 * A glob as a regular expression over a whole path with forward slashes: `*`
 * is any run of characters but `/`, `?` one of them, `**` as a whole segment
 * any number of directories (`src/**` is everything under src, and a leading
 * `**` segment before `x.ts` finds an x.ts at any depth), `[…]` a character
 * class (`[!…]` negated), `{a,b}` either, and `\` escapes the next character.
 * A leading `./` is dropped.
 */
export function globToRegExp(glob: string): RegExp {
  const g = glob.startsWith("./") ? glob.slice(2) : glob;
  let source = "";
  let braces = 0;
  for (let i = 0; i < g.length; ) {
    const c = g[i]!;
    if (c === "*") {
      const double = g[i + 1] === "*";
      const segment = double && (i === 0 || g[i - 1] === "/") && (i + 2 === g.length || g[i + 2] === "/");
      if (segment && i + 2 === g.length) {
        source += ".*";
        i += 2;
      } else if (segment) {
        source += "(?:[^/]*/)*";
        i += 3;
      } else {
        source += "[^/]*";
        i += double ? 2 : 1;
      }
    } else if (c === "?") {
      source += "[^/]";
      i++;
    } else if (c === "[") {
      // A `]` right after the opening bracket (or its `!`) belongs to the class.
      const from = g[i + 1] === "!" ? i + 2 : i + 1;
      const end = g.indexOf("]", from + 1);
      if (end === -1) throw new Error("an unclosed [");
      const body = g.slice(from, end).replace(/[\\\]^]/g, "\\$&");
      source += `[${g[i + 1] === "!" ? "^" : ""}${body}]`;
      i = end + 1;
    } else if (c === "{") {
      braces++;
      source += "(?:";
      i++;
    } else if (c === "}" && braces > 0) {
      braces--;
      source += ")";
      i++;
    } else if (c === "," && braces > 0) {
      source += "|";
      i++;
    } else if (c === "\\" && i + 1 < g.length) {
      source += escapeRegExp(g[i + 1]!);
      i += 2;
    } else {
      source += escapeRegExp(c);
      i++;
    }
  }
  if (braces > 0) throw new Error("an unclosed {");
  return new RegExp(`^${source}$`);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** What a workspace showed about an attempt's work. */
interface Evidence {
  /** The paths the agent changed, relative to its workspace; null when no check reads them. */
  changed: string[] | null;
  /** Of those, the ones some `files` glob matches that are there now: changed or created, not deleted. */
  present: string[];
  /** The command check's miss, null when it passed; undefined when there is none. */
  command?: ExpectMiss | null;
}

/** What an {@link Expectations} needs from its run. */
export interface ExpectDeps {
  /** Run the command check as an exec() step of the run, under its agent. */
  exec(command: string | string[], opts: ExecOptions): Promise<ExecResult>;
  /** The run's abort signal: a stop ends a git listing at once. */
  signal?: AbortSignal;
  /**
   * Directories whose files are never the agent's change in place: the run's
   * own directory, which ODW writes while the agent works (when it lies in
   * the source tree, as a project-local runsRoot puts it).
   */
  ignore?: string[];
}

/**
 * The `expect` checks of one agent() call (see the module doc), as its bridge
 * call's {@link ExpectationSink}.
 */
export class Expectations implements ExpectationSink {
  private isolated = false;
  private source = "";
  /** In place: the source tree before the agent's first run, and where the workspace is in it. */
  private snapshot: TreeSnapshot | null = null;
  private within = "";
  /** In place: the `ignore` directories inside the tree, relative to its root. */
  private ignored: string[] = [];
  /**
   * Isolated: what the worktree of this round's attempt that changed anything
   * showed — else of its latest attempt — as the change the run keeps is.
   */
  private kept: Evidence | null = null;

  constructor(
    private readonly plan: ExpectPlan,
    readonly retries: number,
    private readonly deps: ExpectDeps,
  ) {}

  /** Whether a check reads what the agent changed. */
  private get readsChanges(): boolean {
    return this.plan.changes !== undefined || this.plan.files.length > 0;
  }

  async begin(mode: WorkspaceMode, source: string): Promise<void> {
    this.isolated = mode === "worktree";
    this.source = source;
    if (this.isolated || !this.readsChanges) return;
    try {
      this.snapshot = await snapshotTree(source, this.deps.signal);
      const root = await realpath(this.snapshot.root);
      const inTree = async (dir: string): Promise<string> => relative(root, await realpath(dir)).split(sep).join("/");
      this.within = await inTree(source);
      for (const dir of this.deps.ignore ?? []) {
        const rel = await inTree(dir).catch(() => "..");
        if (rel !== "" && rel !== ".." && !rel.startsWith("../")) this.ignored.push(rel);
      }
    } catch (err) {
      if (this.deps.signal?.aborted) throw err;
      const checks = [this.plan.changes !== undefined ? "expect.changes" : null, this.plan.files.length ? "expect.files" : null];
      throw new AgentError(
        `agent(): ${checks.filter(Boolean).join(" and ")} read what the agent changed from git, and '${source}' is not in a ` +
          `git repository (${errorText(err)}) — run it in one, or check the work with expect.command`,
      );
    }
  }

  async inspect(ws: Workspace): Promise<void> {
    if (!this.readsChanges && this.plan.command === undefined) {
      this.kept = { changed: null, present: [] }; // `match` alone reads only the reply
      return;
    }
    // The change decides which attempt's work stands, so it is read even for a command alone.
    const changed = await this.read(() => ws.changedPaths(this.deps.signal));
    // An attempt that changed nothing — a schema retry that only reformats its
    // reply — leaves the round's earlier evidence standing, as it leaves the
    // change the run keeps.
    if (changed !== null && changed.length === 0 && this.kept?.changed?.length) return;
    this.kept = await this.gather(ws.path, changed);
  }

  async check(reply: string): Promise<ExpectMiss[]> {
    if (this.isolated) {
      if (!this.kept) throw new Error("expect: the agent's worktree was never looked at");
      return this.judge(reply, this.kept);
    }
    const snapshot = this.snapshot;
    const before = snapshot ? await this.changedInPlace(snapshot) : null;
    const evidence = await this.gather(this.source, before && before.map((path) => relativeToDir(this.within, path)));
    const misses = this.judge(reply, evidence);
    if (misses.length > 0 && snapshot && before && this.plan.command !== undefined) {
      // What the command wrote in the shared tree (a report, a cache) is not
      // the agent's: a retry is judged without it.
      const seen = new Set(before);
      const after = await this.changedInPlace(snapshot);
      await rebaseline(snapshot, after.filter((path) => !seen.has(path)));
    }
    return misses;
  }

  /** What changed in the source tree since the snapshot, relative to its root — ODW's own files left out. */
  private async changedInPlace(snapshot: TreeSnapshot): Promise<string[]> {
    const changed = await this.read(() => changedSince(snapshot, this.deps.signal));
    return changed.filter((path) => !this.ignored.some((dir) => path === dir || path.startsWith(`${dir}/`)));
  }

  feedback(misses: ExpectMiss[]): string {
    const listed = misses
      .map((miss) => (miss.detail ? `- ${miss.text}. Its output ended with:\n<<<\n${miss.detail}\n>>>` : `- ${miss.text}`))
      .join("\n");
    const start = this.isolated
      ? "You start again in a fresh checkout: the previous attempt's changes are not in it, so do the whole task."
      : "The previous attempt's changes are still in your working directory: build on them, or undo what is wrong.";
    return (
      "Your previous attempt at this task did not meet these expectations, which are checked again when you reply:\n" +
      `${listed}\n\n${start} Then reply as the task asks.`
    );
  }

  retry(): void {
    this.kept = null;
  }

  /** Read what the agent changed from git; a failure says so (a stop is the caller's to report). */
  private async read<T>(list: () => Promise<T>): Promise<T> {
    try {
      return await list();
    } catch (err) {
      if (this.deps.signal?.aborted) throw err;
      throw new Error(`expect: could not read what the agent changed: ${errorText(err)}`);
    }
  }

  /** Read a workspace's evidence: the files the checks name, then the command's verdict. */
  private async gather(dir: string, changed: string[] | null): Promise<Evidence> {
    const present: string[] = [];
    if (changed && this.plan.files.length > 0) {
      for (const path of changed) {
        if (!this.plan.files.some((file) => file.pattern.test(path))) continue;
        // A deleted file is a change, but not one a glob asks for.
        if (await lstat(join(dir, path)).then(() => true, () => false)) present.push(path);
      }
    }
    // After the change is read: what the command writes (a build, a report) is not the agent's.
    const command = this.plan.command !== undefined ? await this.runCommand(dir) : undefined;
    return { changed, present, command };
  }

  private async runCommand(dir: string): Promise<ExpectMiss | null> {
    const command = this.plan.command!;
    const result = await this.deps.exec(command, { cwd: dir, timeout: this.plan.timeout });
    if (result.exitCode === 0 && !result.timedOut) return null;
    const how = result.timedOut
      ? `it timed out after ${this.plan.timeout}s`
      : result.exitCode !== null
        ? `it exited with code ${result.exitCode}`
        : `it was killed by signal ${result.signal ?? "(unknown)"}`;
    return { text: `\`${clip(commandLine(command), COMMAND_CHARS)}\` must exit 0, and ${how}`, detail: outputEnd(result) };
  }

  private judge(reply: string, evidence: Evidence): ExpectMiss[] {
    const misses: ExpectMiss[] = [];
    const { changes, files, match } = this.plan;
    const changed = evidence.changed ?? [];
    if (changes === true && changed.length === 0) misses.push({ text: "a file must change, and none did" });
    if (changes === false && changed.length > 0) {
      misses.push({ text: `no file may change, and ${changed.length === 1 ? "1 did" : `${changed.length} did`}: ${listPaths(changed)}` });
    }
    for (const { glob, pattern } of files) {
      if (!evidence.present.some((path) => pattern.test(path))) {
        misses.push({ text: `a file matching ${JSON.stringify(glob)} must change or be created, and none did` });
      }
    }
    if (evidence.command) misses.push(evidence.command);
    if (match && !match.test(reply)) misses.push({ text: `the reply must match /${clip(match.source, 80)}/, and it does not` });
    return misses;
  }
}

/** Characters of the command a miss names. */
const COMMAND_CHARS = 80;

/** Characters of a failed command's output, from each stream's end, quoted back in a retry prompt. */
const OUTPUT_CHARS = 3000;

/** The paths a miss names: the first few, and how many more. */
function listPaths(paths: string[]): string {
  const shown = paths.slice(0, 5).join(", ");
  return paths.length > 5 ? `${shown} and ${paths.length - 5} more` : shown;
}

/** The command on one line, as a person would type it. */
function commandLine(command: string | string[]): string {
  const text = typeof command === "string" ? command : command.map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : JSON.stringify(arg))).join(" ");
  return text.replace(/\s+/g, " ").trim();
}

/** The end of each stream of a failed command, for the agent to fix it from; undefined when it printed nothing. */
function outputEnd(result: ExecResult): string | undefined {
  const end = (text: string): string => (text.length > OUTPUT_CHARS ? `…${text.slice(-OUTPUT_CHARS)}` : text);
  const parts: string[] = [];
  if (result.stdout.trim()) parts.push(end(result.stdout.trimEnd()));
  if (result.stderr.trim()) parts.push(end(result.stderr.trimEnd()));
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
