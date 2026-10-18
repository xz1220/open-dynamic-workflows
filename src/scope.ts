/**
 * Declared scopes (an ODW extension): who touches which files, said before
 * they write.
 *
 * Two agents pointed at the same files produce changes that work alone and
 * conflict at merge time. `agent(prompt, { scope: ["src/parser/**",
 * "docs/parser.md"] })` declares the files a call means to change — globs
 * relative to its workspace, with the `expect` glob rules (./expect) — and
 * ODW uses it twice:
 *
 *   - Scheduling. Two scoped calls in flight at once — in a parallel() or
 *     pipeline() fan-out, or started without an await — whose scopes overlap
 *     do not run at the same time: the later one waits, holding no slot,
 *     until the earlier one has settled, and the run says so once per wait
 *     ("fix-auth waits for refactor-login: both declare src/auth/**"). Calls
 *     whose scopes do not overlap keep running together; a call without
 *     `scope` overlaps nothing, as before. A call waits only for calls made
 *     before it, so waits never form a cycle.
 *
 *   - Out-of-scope writes. Once the call has replied, what it changed (the
 *     paths `expect` reads; see ./expect) is compared with its scope: a file
 *     no scope glob matches is recorded as `outOfScope` on the agent — its
 *     terminal event and saved record — logged, and posted to the notes
 *     board when the agent has notes on. `scopePolicy` (the call's, else the
 *     setting; "warn" by default) says what else: "warn" keeps the reply;
 *     "fail" fails the agent with reason "out_of_scope". With `expect`, a
 *     write outside the scope is a miss, retried like any other.
 *
 * Overlap is decided from the globs alone, conservatively — when in doubt two
 * scopes overlap, which only serializes calls that might not have needed it:
 *
 *   - `{a,b}` alternatives are expanded first, and each alternative compared;
 *   - two literal paths (no wildcard) overlap when they are the same path;
 *   - a literal path and a glob overlap when the glob matches the path;
 *   - two globs overlap when the literal prefix of one (what comes before
 *     its first wildcard) starts with the literal prefix of the other:
 *     `src/auth/**` and `src/auth/*.ts` do, `src/auth/**` and `src/db/**`
 *     do not, and `**` overlaps everything.
 *
 * In place the source tree is shared, so what a call changed is read from
 * the whole tree: a file inside the scope of another scoped call that ran at
 * the same time is that call's, and not counted against this one. Edits of
 * unscoped calls running beside it still count — isolate for an exact answer.
 */

import { AgentError } from "./errors.js";
import { globToRegExp } from "./expect.js";

/** What happens to an agent that wrote outside its scope. */
export type ScopePolicy = "warn" | "fail";

export const SCOPE_POLICIES: readonly ScopePolicy[] = ["warn", "fail"];

/** One scope glob, compiled. */
export interface ScopeGlob {
  glob: string;
  pattern: RegExp;
}

/** A call's declared scope, validated. */
export interface ScopePlan {
  globs: ScopeGlob[];
  policy: ScopePolicy;
}

/**
 * Check an agent() call's `scope` and `scopePolicy` — a misuse is a
 * recoverable AgentError, before anything starts. Null without a scope.
 */
export function planScope(opts: { scope?: unknown; scopePolicy?: unknown }, setting: ScopePolicy = "warn"): ScopePlan | null {
  const { scope, scopePolicy } = opts;
  if (scopePolicy !== undefined && !SCOPE_POLICIES.includes(scopePolicy as ScopePolicy)) {
    throw misuse(`scopePolicy must be "warn" or "fail"; got ${describeValue(scopePolicy)}`);
  }
  if (scope === undefined) {
    if (scopePolicy !== undefined) throw misuse("scopePolicy has no effect without a scope — declare the files the agent may change with scope: [globs]");
    return null;
  }
  if (!Array.isArray(scope) || scope.length === 0 || !scope.every((glob) => typeof glob === "string" && glob.trim() !== "")) {
    throw misuse(`scope must be a non-empty array of globs (non-empty strings); got ${describeValue(scope)}`);
  }
  const globs = [...new Set(scope as string[])].map((glob) => {
    if (glob.startsWith("/")) throw misuse(`scope globs are relative to the agent's workspace; got "${glob}"`);
    try {
      return { glob, pattern: globToRegExp(glob) };
    } catch (err) {
      throw misuse(`scope has an invalid glob "${glob}": ${(err as Error).message}`);
    }
  });
  return { globs, policy: (scopePolicy as ScopePolicy | undefined) ?? setting };
}

/** The paths no glob of `scope` matches. */
export function outsideScope(paths: readonly string[], scope: readonly ScopeGlob[]): string[] {
  return paths.filter((path) => !scope.some(({ pattern }) => pattern.test(path)));
}

/** Whether two globs may match a common path (see the module doc for the rules). */
export function globsOverlap(a: string, b: string): boolean {
  const left = expandBraces(strip(a));
  const right = expandBraces(strip(b));
  return left.some((x) => right.some((y) => alternativesOverlap(x, y)));
}

/** The first pair of globs, one from each scope, that overlap; null when none does. */
export function scopesOverlap(a: readonly string[], b: readonly string[]): [string, string] | null {
  for (const x of a) for (const y of b) if (globsOverlap(x, y)) return [x, y];
  return null;
}

/** The one line a wait is logged with: "fix-auth waits for refactor-login: both declare src/auth/**". */
export function waitNote(waiter: string, holder: string, [mine, theirs]: [string, string]): string {
  const why = mine === theirs ? `both declare ${mine}` : `${waiter} declares ${mine}, ${holder} ${theirs}`;
  return `${waiter} waits for ${holder}: ${why}`;
}

function alternativesOverlap(a: string, b: string): boolean {
  const pa = literalPrefix(a);
  const pb = literalPrefix(b);
  if (pa.literal && pb.literal) return pa.prefix === pb.prefix;
  if (pa.literal) return matches(b, pa.prefix);
  if (pb.literal) return matches(a, pb.prefix);
  return pa.prefix.startsWith(pb.prefix) || pb.prefix.startsWith(pa.prefix);
}

function matches(glob: string, path: string): boolean {
  try {
    return globToRegExp(glob).test(path);
  } catch {
    return true; // never reached for a validated scope; when in doubt, they overlap
  }
}

function strip(glob: string): string {
  return glob.startsWith("./") ? glob.slice(2) : glob;
}

/** A glob's text before its first wildcard, its escapes undone; `literal` when it has none. */
function literalPrefix(glob: string): { prefix: string; literal: boolean } {
  let prefix = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" || c === "?" || c === "[" || c === "{") return { prefix, literal: false };
    if (c === "\\" && i + 1 < glob.length) prefix += glob[++i]!;
    else prefix += c;
  }
  return { prefix, literal: true };
}

/** A glob's `{a,b}` alternatives as separate globs (nested ones too); at most {@link MAX_ALTERNATIVES}, else the glob as it is. */
export function expandBraces(glob: string): string[] {
  const out: string[] = [];
  const queue = [glob];
  while (queue.length > 0) {
    const g = queue.shift()!;
    const open = firstBrace(g);
    if (!open) {
      out.push(g);
    } else {
      for (const alt of open.alternatives) queue.push(g.slice(0, open.start) + alt + g.slice(open.end + 1));
    }
    // A glob of many braces stays one glob: its literal prefix still decides, conservatively.
    if (out.length + queue.length > MAX_ALTERNATIVES) return [glob];
  }
  return out;
}

const MAX_ALTERNATIVES = 64;

/** The first top-level `{…}` of a glob — its bounds and its alternatives — skipping escapes and classes. */
function firstBrace(glob: string): { start: number; end: number; alternatives: string[] } | null {
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "\\") {
      i++;
    } else if (c === "[") {
      const from = glob[i + 1] === "!" ? i + 2 : i + 1;
      const end = glob.indexOf("]", from + 1);
      if (end === -1) return null;
      i = end;
    } else if (c === "{") {
      let depth = 0;
      let part = i + 1;
      const alternatives: string[] = [];
      for (let j = i; j < glob.length; j++) {
        const d = glob[j];
        if (d === "\\") j++;
        else if (d === "{") depth++;
        else if (d === "}" && --depth === 0) {
          alternatives.push(glob.slice(part, j));
          return { start: i, end: j, alternatives };
        } else if (d === "," && depth === 1) {
          alternatives.push(glob.slice(part, j));
          part = j + 1;
        }
      }
      return null;
    }
  }
  return null;
}

/** Who holds or waits for a scope: the agent, as the run names it. */
export interface ScopeHolder {
  agentId: number;
  label: string;
}

/**
 * The scoped calls of one run that have not settled, in the order they were
 * made: what a new call waits for, and who ran beside whom. Shared by a
 * run's nested workflow()s, like its agent ids.
 */
export class ScopeLocks {
  private readonly open: ScopeClaim[] = [];

  /**
   * Claim `scope` for a call as it is made: it must wait for every earlier
   * open call whose scope overlaps (see {@link ScopeClaim.wait}), and
   * {@link ScopeClaim.release} once it settled, whatever became of it.
   */
  claim(holder: ScopeHolder, scope: readonly string[]): ScopeClaim {
    const blockers = this.open.flatMap((other) => {
      const pair = scopesOverlap(scope, other.scope);
      return pair ? [{ claim: other, pair }] : [];
    });
    const claim = new ScopeClaim(holder, [...scope], blockers, this.open);
    this.open.push(claim);
    return claim;
  }
}

export class ScopeClaim {
  private running = false;
  private done = false;
  private settle!: () => void;
  private readonly settledPromise = new Promise<void>((resolve) => (this.settle = resolve));
  /** The scope globs of other scoped calls that ran while this one did. */
  private readonly beside = new Set<string>();

  constructor(
    readonly holder: ScopeHolder,
    readonly scope: readonly string[],
    private readonly blockers: Array<{ claim: ScopeClaim; pair: [string, string] }>,
    private readonly open: ScopeClaim[],
  ) {}

  /** Whether an earlier call it must wait for may still be running. */
  get blocked(): boolean {
    return this.blockers.some(({ claim }) => !claim.done);
  }

  /**
   * Wait, holding no slot, until every earlier call whose scope overlaps
   * has settled — `onWait` told once for each one still open as the wait for
   * it begins. A stop (`signal`) ends the wait with its reason.
   */
  async wait(signal: AbortSignal, onWait: (holder: ScopeHolder, pair: [string, string]) => void): Promise<void> {
    for (const { claim, pair } of this.blockers) {
      if (claim.done) continue;
      onWait(claim.holder, pair);
      await abortable(claim.settledPromise, signal);
    }
  }

  /** The call has a slot and its CLI is about to run: every scoped call running now ran beside it. */
  start(): void {
    if (this.running || this.done) return;
    this.running = true;
    for (const other of this.open) {
      if (other === this || !other.running) continue;
      for (const glob of other.scope) this.beside.add(glob);
      for (const glob of this.scope) other.beside.add(glob);
    }
  }

  /** The compiled scopes of the scoped calls that ran beside it, so far. */
  neighbours(): RegExp[] {
    const patterns: RegExp[] = [];
    for (const glob of this.beside) {
      try {
        patterns.push(globToRegExp(glob));
      } catch {
        // validated when claimed
      }
    }
    return patterns;
  }

  /** The call settled: the calls waiting for it may go. Idempotent. */
  release(): void {
    if (this.done) return;
    this.done = true;
    this.running = false;
    const at = this.open.indexOf(this);
    if (at !== -1) this.open.splice(at, 1);
    this.settle();
  }
}

function abortable(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

function misuse(message: string): AgentError {
  return new AgentError(`agent(): ${message}`);
}

function describeValue(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return value.length > 0 ? "an array" : "an empty array";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}
