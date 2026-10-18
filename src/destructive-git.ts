/**
 * Destructive git commands in what an agent ran (T3; an ODW extension).
 *
 * An agent working in the user's tree can throw away days of uncommitted work
 * with one command — `git reset --hard`, `git checkout .`, `git clean -fd` —
 * and nothing in its reply says so. ODW cannot stop such a command before it
 * runs (that takes each CLI's own hooks, and ODW injects none into a
 * repository), but it can see it go by: a {@link DestructiveGitWatch} reads
 * what the agent's CLI prints as it runs — normalized like a transcript
 * (runtime/transcript-view), so Claude Code's Bash tool, Codex's
 * command_execution items, kilo's and opencode's shell tool and agy's
 * run_command all count — and reports each shell command that is one of:
 *
 *   git reset --hard                       the working tree and index back to a commit
 *   git checkout . / -- . / --force        every file back to the index (or a commit)
 *   git restore .                          the same, by its newer name
 *   git clean -f…                          untracked files deleted (not -n, a dry run)
 *   git push --force / -f / +refspec       the remote's history rewritten
 *   git stash drop / clear                 stashed work dropped
 *   git branch -D                          a branch deleted, merged or not
 *
 * The first four touch the working tree they run in: they count only for an
 * agent that works in place — an isolated agent's own worktree is its to
 * throw away. The last three reach the whole repository (its refs, its
 * stashes, its remote), so they count for every agent.
 *
 * A command is read the way a shell would split it: `cd x && git reset
 * --hard`, `bash -lc 'git clean -fd'`, `sudo -u me git …`, `env A=1 git …`
 * and git's own global options (`git -C dir …`) are seen through; a quoted
 * string is not a command (`grep "git reset --hard" notes.md` is no hit).
 * What the `destructiveGit` setting does with a hit is the caller's (see
 * ./primitives): `"warn"` records it, `"fail"` fails the agent once its CLI
 * is done.
 */

import type { Adapter, CliResult } from "./adapters/types.js";
import type { AttemptReason } from "./transcript.js";
import { TranscriptNormalizer, type TranscriptEntry } from "./runtime/transcript-view.js";

/** What a destructive git command reaches: the working tree it runs in, or the whole repository. */
export type DestructiveScope = "worktree" | "repository";

/** One destructive git command an agent ran. */
export interface DestructiveGitHit {
  /** The command as the agent ran it, on one line and cut at {@link COMMAND_CHARS}. */
  command: string;
  /** What it is, in a word or three: "git reset --hard", "git clean -f". */
  what: string;
  scope: DestructiveScope;
}

/** Characters of a command a hit keeps. */
const COMMAND_CHARS = 300;

/** Characters of one line a watch reads at most; the rest of a longer line is skipped (a huge tool result). */
const LINE_MAX_CHARS = 1024 * 1024;

/** Hits a watch keeps per agent call; past them, more are counted. */
const HITS_KEPT = 50;

/** Shells whose `-c` script is read as a command line of its own. */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "fish"]);

/** Words that run the command after them: skipped, with their own options. */
const WRAPPERS = new Set(["sudo", "doas", "env", "command", "exec", "nohup", "time", "nice", "ionice", "timeout", "stdbuf", "builtin"]);

/** Options of a wrapper that take the next word as their value. */
const WRAPPER_VALUES: Record<string, ReadonlySet<string>> = {
  sudo: new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-T"]),
  doas: new Set(["-u", "-C"]),
  env: new Set(["-u", "-C", "-S", "--unset", "--chdir", "--split-string"]),
  nice: new Set(["-n", "--adjustment"]),
  ionice: new Set(["-c", "-n", "-p", "-P", "-u"]),
  timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
};

/** git's global options that take the next word as their value. */
const GIT_GLOBAL_VALUES = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--exec-path"]);

/** Pathspecs that name the whole tree. */
const WHOLE_TREE = new Set([".", "./", ":/", ":/.", "*", ":(top)", ":(top).", ":(top)/"]);

/**
 * The destructive git commands in one shell command line, in the order they
 * appear — each `what` and its scope — or none.
 */
export function destructiveGitCommands(line: string, depth = 0): Array<{ what: string; scope: DestructiveScope }> {
  const found: Array<{ what: string; scope: DestructiveScope }> = [];
  for (const words of simpleCommands(line)) {
    const at = commandStart(words);
    if (at >= words.length) continue;
    const name = basename(words[at]!);
    if (SHELLS.has(name) && depth < 3) {
      // `bash -lc 'git reset --hard'`: the script after a flag with a c in it.
      for (let i = at + 1; i < words.length - 1; i++) {
        if (/^-[a-z]*c[a-z]*$/.test(words[i]!)) {
          found.push(...destructiveGitCommands(words[i + 1]!, depth + 1));
          break;
        }
        if (!words[i]!.startsWith("-")) break;
      }
      continue;
    }
    if (name === "eval" && depth < 3) {
      found.push(...destructiveGitCommands(words.slice(at + 1).join(" "), depth + 1));
      continue;
    }
    if (name !== "git" && name !== "git.exe") continue;
    const hit = gitHit(words.slice(at + 1));
    if (hit) found.push(hit);
  }
  return found;
}

/** What a git invocation's arguments (after `git`) make it, when it is destructive. */
function gitHit(args: string[]): { what: string; scope: DestructiveScope } | null {
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) {
    const arg = args[i]!;
    i += GIT_GLOBAL_VALUES.has(arg) ? 2 : 1;
  }
  const sub = args[i];
  if (sub === undefined) return null;
  const rest = args.slice(i + 1);
  const dashes = rest.indexOf("--");
  const options = (dashes === -1 ? rest : rest.slice(0, dashes)).filter((a) => a.startsWith("-"));
  const operands = dashes === -1 ? rest.filter((a) => !a.startsWith("-")) : [...rest.slice(0, dashes).filter((a) => !a.startsWith("-")), ...rest.slice(dashes + 1)];
  /** A short-option cluster (`-fdx`) or the long option has `short`/`long`. */
  const has = (short: string, long?: string): boolean =>
    options.some((o) => (long !== undefined && (o === long || o.startsWith(`${long}=`))) || (/^-[A-Za-z]+$/.test(o) && o.slice(1).includes(short)));
  switch (sub) {
    case "reset":
      return options.includes("--hard") ? { what: "git reset --hard", scope: "worktree" } : null;
    case "checkout":
      if (has("f", "--force")) return { what: "git checkout --force", scope: "worktree" };
      return operands.some((o) => WHOLE_TREE.has(o)) ? { what: "git checkout .", scope: "worktree" } : null;
    case "restore": {
      // `--staged` alone touches only the index; the working tree is restored by default or with --worktree.
      const worktree = has("W", "--worktree") || !has("S", "--staged");
      return worktree && operands.some((o) => WHOLE_TREE.has(o)) ? { what: "git restore .", scope: "worktree" } : null;
    }
    case "clean":
      return has("f", "--force") && !has("n", "--dry-run") ? { what: "git clean -f", scope: "worktree" } : null;
    case "push":
      if (has("f", "--force") || options.some((o) => o.startsWith("--force-with-lease")) || operands.some((o) => o.startsWith("+") && o.length > 1)) {
        return { what: "git push --force", scope: "repository" };
      }
      return null;
    case "stash":
      return rest[0] === "drop" || rest[0] === "clear" ? { what: `git stash ${rest[0]}`, scope: "repository" } : null;
    case "branch":
      if (has("D")) return { what: "git branch -D", scope: "repository" };
      return has("d", "--delete") && has("f", "--force") ? { what: "git branch -D", scope: "repository" } : null;
    default:
      return null;
  }
}

/** Where the command itself starts in a simple command: past variable assignments and wrappers (`sudo`, `env`, …). */
function commandStart(words: string[]): number {
  let i = 0;
  for (;;) {
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++;
    const word = words[i];
    if (word === undefined || !WRAPPERS.has(basename(word))) return i;
    const wrapper = basename(word);
    const values = WRAPPER_VALUES[wrapper];
    i++;
    while (i < words.length && words[i]!.startsWith("-")) {
      i += values?.has(words[i]!) ? 2 : 1;
    }
    // `timeout 60 git …`, `nice 10 …`: the duration before the command.
    if (wrapper === "timeout" && i < words.length && /^\d/.test(words[i]!)) i++;
  }
}

function basename(word: string): string {
  const slash = Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\"));
  return slash === -1 ? word : word.slice(slash + 1);
}

/**
 * A shell command line as its simple commands, each a list of words: split
 * at `;`, `&`, `|`, newlines, parentheses, `$(` and backquotes; quotes and
 * backslashes taken away the way the shell would. A quoted word is one word,
 * whatever it holds.
 */
export function simpleCommands(line: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  const endWord = (): void => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = (): void => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "'") {
      const close = line.indexOf("'", i + 1);
      const end = close === -1 ? line.length : close;
      word += line.slice(i + 1, end);
      inWord = true;
      i = end;
    } else if (c === '"') {
      inWord = true;
      for (i++; i < line.length && line[i] !== '"'; i++) {
        if (line[i] === "\\" && i + 1 < line.length && '"\\$`\n'.includes(line[i + 1]!)) i++;
        word += line[i]!;
      }
    } else if (c === "\\") {
      if (i + 1 < line.length && line[i + 1] !== "\n") {
        word += line[i + 1]!;
        inWord = true;
      }
      i++;
    } else if (c === " " || c === "\t") {
      endWord();
    } else if (c === "#" && !inWord) {
      // A comment runs to the end of its line.
      const nl = line.indexOf("\n", i);
      i = nl === -1 ? line.length : nl - 1;
    } else if (c === ";" || c === "&" || c === "|" || c === "\n" || c === "\r" || c === "(" || c === ")" || c === "`" || c === "{" || c === "}") {
      if ((c === "{" || c === "}") && inWord) {
        word += c;
        continue;
      }
      endCommand();
    } else if (c === "$" && line[i + 1] === "(") {
      endCommand();
      i++;
    } else {
      word += c;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

/** The shell command a normalized tool call ran, when it ran one: its input's `command` (agy: `CommandLine`). */
function commandOf(entry: TranscriptEntry): string | null {
  let input = entry.input;
  if (typeof input === "string") {
    // An input cut at 4 KB comes as JSON text: what it says, when it still parses.
    try {
      input = JSON.parse(input);
    } catch {
      return null;
    }
  }
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const value = [record.command, record.CommandLine, record.cmd].find((v) => typeof v === "string" || Array.isArray(v));
  if (typeof value === "string") return value;
  // An argv (`["bash", "-lc", "git …"]`): its words, each quoted as the shell would read it back.
  if (Array.isArray(value) && value.every((w) => typeof w === "string")) return value.map((w) => `'${w.replace(/'/g, "'\\''")}'`).join(" ");
  return null;
}

/** A command on one line, cut at {@link COMMAND_CHARS}. */
function oneLine(command: string): string {
  const line = command.replace(/\s+/g, " ").trim();
  return line.length > COMMAND_CHARS ? `${line.slice(0, COMMAND_CHARS - 1)}…` : line;
}

/**
 * Watches one agent() call's CLI runs for destructive git commands (see the
 * module doc). It takes what a transcript sink takes (bridge.ts's
 * TranscriptSink): told as each CLI run starts and ends, fed what it prints as
 * it arrives. A JSONL adapter's tool calls are read; a text adapter prints no
 * tool calls ODW can tell from its prose, so its runs are not. `onHit` is told
 * each command once, as soon as it shows (the first {@link HITS_KEPT}; the
 * rest are counted in `more`); an agent `isolated` in a worktree
 * reports only the commands that reach the whole repository.
 */
export class DestructiveGitWatch {
  /** The commands it ran, in order (at most {@link HITS_KEPT}). */
  readonly hits: DestructiveGitHit[] = [];
  /** Hits past {@link HITS_KEPT}: counted, not kept. */
  more = 0;
  private readonly seen = new Set<string>();
  private normalizer = new TranscriptNormalizer();
  private jsonl = false;
  private partial = "";
  private skipping = false;
  private heard = false;

  constructor(
    private readonly onHit: (hit: DestructiveGitHit) => void,
    private readonly isolated: boolean,
  ) {}

  beginRun(_reason?: AttemptReason, adapter?: Adapter): void {
    this.flush();
    this.jsonl = adapter?.output?.format === "jsonl";
    this.normalizer = new TranscriptNormalizer();
    this.heard = false;
  }

  stdout(chunk: string): void {
    if (!chunk || !this.jsonl) return;
    this.heard = true;
    let from = 0;
    for (let nl = chunk.indexOf("\n"); nl !== -1; nl = chunk.indexOf("\n", from)) {
      const line = this.partial + chunk.slice(from, nl);
      this.partial = "";
      from = nl + 1;
      if (this.skipping) this.skipping = false;
      else this.line(line);
    }
    if (this.skipping) return;
    this.partial += chunk.slice(from);
    if (this.partial.length > LINE_MAX_CHARS) {
      this.partial = "";
      this.skipping = true;
    }
  }

  stderr(_chunk: string): void {}

  /** The CLI run ended: its last line is read — and its whole stdout, when it streamed none (an injected runner). */
  endRun(cli: CliResult): void {
    if (!this.heard && cli.stdout) this.stdout(cli.stdout);
    this.flush();
  }

  /** The kinds of command it ran, each once: "git reset --hard, git clean -f". */
  summary(): string {
    return [...new Set(this.hits.map((hit) => hit.what))].join(", ");
  }

  private flush(): void {
    const rest = this.partial;
    this.partial = "";
    this.skipping = false;
    if (rest && this.jsonl) this.line(rest);
  }

  private line(line: string): void {
    let entries: TranscriptEntry[];
    try {
      entries = this.normalizer.line(line);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.kind !== "tool_call") continue;
      const command = commandOf(entry);
      if (command === null || !/\bgit\b/.test(command)) continue;
      for (const { what, scope } of destructiveGitCommands(command)) {
        if (this.isolated && scope === "worktree") continue;
        const shown = oneLine(command);
        const key = `${what}\u0000${shown}`;
        if (this.seen.has(key)) continue; // Codex shows a command as it starts and again as it ends
        this.seen.add(key);
        const hit: DestructiveGitHit = { command: shown, what, scope };
        if (this.hits.length >= HITS_KEPT) {
          this.more++;
          continue;
        }
        this.hits.push(hit);
        this.onHit(hit);
      }
    }
  }
}
