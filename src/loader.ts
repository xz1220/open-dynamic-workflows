/**
 * Workflow loader / transform — THE crux of this runtime.
 *
 * Claude Code's workflow dialect is neither a normal ES module nor a plain
 * script. A file like `deep-research.js` has `export const meta = {...}` at the
 * top, then a *body* that uses top-level `await` AND top-level `return` while
 * referencing *injected globals* (`agent`, `parallel`, `pipeline`, `phase`,
 * `log`, `args`, `budget`, `workflow`) that are never imported.
 *
 * So "loading" is a source transform, done here and nowhere else:
 *
 *   1. Extract the `meta` literal up front (so the runtime can register the
 *      workflow's name/phases before the body runs).
 *   2. Strip the `export` keyword from it.
 *   3. Wrap the remaining body in an async function whose parameters ARE the
 *      injected primitives (plus `args`), so the body's top-level `return`
 *      becomes the workflow's result and its top-level `await` is legal.
 *
 * Scanning is **string/comment/regex aware**: a masked copy of the source (with
 * strings, template literals, comments and regex literals blanked) drives every
 * search, so an `export const meta =` or a brace that lives inside a string or
 * comment is never mistaken for the real declaration.
 *
 * `meta` is **parsed, never evaluated**: listing workflows (the dashboard, `odw
 * workflows`, run-by-name) reads the meta of every file it finds, so evaluating
 * it would run arbitrary code from any of them. Claude Code's own contract is
 * that meta is a pure literal — no variables, calls, or interpolation — and the
 * parser below accepts exactly that subset (see {@link readMetaLiteral}). The
 * body is only compiled here; it runs when, and only when, the workflow does.
 */

import { Script } from "node:vm";

import { WorkflowScriptError } from "./errors.js";
import type { WorkflowGlobals } from "./primitives.js";

export interface WorkflowPhaseMeta {
  title: string;
  detail?: string;
  model?: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  phases?: WorkflowPhaseMeta[];
  model?: string;
}

export interface LoadedWorkflow {
  meta: WorkflowMeta;
  /** Execute the transformed body with the injected globals and `args`. */
  run(globals: WorkflowGlobals, args: unknown): Promise<unknown>;
}

// The injected names, in the order the wrapper function receives them. These
// eight are Claude Code's exact Workflow-tool globals, so the parameter list a
// script compiles against matches both runtimes.
const CLAUDE_PARAM_NAMES = [
  "agent",
  "parallel",
  "pipeline",
  "phase",
  "log",
  "args",
  "budget",
  "workflow",
] as const;
// `validate` and `exec` are ODW-only extensions. Injecting one as an extra
// formal parameter would make `const validate = …` in a body a
// duplicate-declaration compile error — and Claude Code does NOT reserve these
// names, so a perfectly valid Claude-authored script would break only on odw.
// So each is injected only when the body does not declare its own binding of
// that name (the script's own binding then wins, exactly as it would on Claude
// Code).
const EXTENSION_PARAM_NAMES = ["validate", "exec"] as const;
type ExtensionName = (typeof EXTENSION_PARAM_NAMES)[number];

/** Whether masked code declares its own binding of an extension's name. */
function declaresOwn(masked: string, name: ExtensionName): boolean {
  return new RegExp(`\\b(?:const|let|var|function|class)\\s+${name}\\b`).test(masked);
}

/** A call of the injected `exec` — not a member call such as `re.exec(text)`. */
const CALLS_EXEC = /(?<![\w$])(?<!\.\s*)exec\s*\(/;


const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (...callArgs: unknown[]) => Promise<unknown>;

const EXPORT_META = /\bexport\s+const\s+meta\s*=/;

/**
 * A workflow's validated `meta` alone — parsed as a pure literal; the body is
 * neither compiled nor run. For listings (dashboard, `odw workflows`), which
 * read every file they find and must never execute any of them.
 */
export function readWorkflowMeta(source: string, filename: string): WorkflowMeta {
  return extractMeta(source, filename).meta;
}

/** Parse + transform a workflow script's source into a runnable form. */
export function loadWorkflowScript(source: string, filename: string): LoadedWorkflow {
  const { meta, body } = extractMeta(source, filename);

  // Inject each extension only if the body does not bind that identifier
  // itself. Check the masked body so a declaration inside a string/comment
  // never counts.
  const maskedBody = maskCode(body);
  const extensions = EXTENSION_PARAM_NAMES.filter((name) => !declaresOwn(maskedBody, name));
  const paramNames = [...CLAUDE_PARAM_NAMES, ...extensions];

  let factory: (...callArgs: unknown[]) => Promise<unknown>;
  try {
    // First compile the body on its own: the AsyncFunction constructor accepts
    // only a self-contained function body, so a body containing `})` cannot
    // close the wrapper below early and run code at load time. This compiles;
    // it never runs anything.
    new AsyncFunction(...paramNames, body);
    // Then the real compile: an async function expression whose body starts on
    // line 2, with lineOffset -1 so stack traces and log frames point at the
    // script's own line numbers (the AsyncFunction would put them two lines off).
    const wrapped = `(async function (${paramNames.join(", ")}) {\n${body}\n})`;
    factory = new Script(wrapped, { filename, lineOffset: -1 }).runInThisContext() as typeof factory;
  } catch (err) {
    throw new WorkflowScriptError(`failed to compile workflow ${filename}: ${(err as Error).message}`);
  }

  return {
    meta,
    run(globals: WorkflowGlobals, args: unknown): Promise<unknown> {
      // The first eight never move; the injected extensions follow in the
      // order of their parameters.
      return factory(
        globals.agent,
        globals.parallel,
        globals.pipeline,
        globals.phase,
        globals.log,
        args,
        globals.budget,
        globals.workflow,
        ...extensions.map((name) => globals[name]),
      );
    },
  };
}

/**
 * Scan a workflow source for APIs that compile and run fine under ODW but are
 * BANNED in Claude Code's Workflow tool (they break its resume journal):
 * `Date.now()`, `Math.random()`, and arg-less `new Date()`.
 *
 * The scan runs over a mask that blanks comments and ordinary strings AND the
 * *text* of template literals, but KEEPS the code inside `${…}` interpolations
 * visible — `agent(`as of ${Date.now()}`)` runs that banned call for real, so
 * the warning must catch it (the default mask, used for meta extraction, blanks
 * whole template literals and would miss it).
 *
 * It also flags calls to `exec()`, an ODW extension Claude Code does not
 * provide at all — unless the script declares its own `exec`, which is then the
 * one it calls (member calls such as `re.exec(text)` never count).
 *
 * These come back as *warnings*, not errors — ODW itself executes them — so a
 * caller (the generate-workflow repair loop, a linter) can decide how hard to
 * push for dual-compatibility.
 */
export function scanDualCompat(source: string): string[] {
  const masked = maskCode(source, { keepInterpolations: true });
  const warnings: string[] = [];
  const rules: Array<[RegExp, string]> = [
    [/\bDate\s*\.\s*now\s*\(/, "Date.now() is banned in Claude Code workflows — pass timestamps in via args"],
    [/\bMath\s*\.\s*random\s*\(/, "Math.random() is banned in Claude Code workflows — vary prompts by index instead"],
    [/\bnew\s+Date\s*\(\s*\)/, "arg-less new Date() is banned in Claude Code workflows — pass timestamps in via args"],
  ];
  for (const [re, message] of rules) {
    if (re.test(masked)) warnings.push(message);
  }
  if (CALLS_EXEC.test(masked) && !declaresOwn(masked, "exec")) {
    warnings.push(
      "exec() is an ODW extension, not portable to Claude Code — its Workflow tool has no exec global, so the script fails there",
    );
  }
  return warnings;
}

/**
 * Read a workflow's `export const meta` literal WITHOUT compiling or running
 * anything. Returns null when the source has no meta declaration (outside
 * strings and comments); throws {@link MetaLiteralError} when the declaration's
 * value is not a pure object literal.
 *
 * The accepted grammar is the static subset Claude Code documents for meta:
 *
 *   - object literals with identifier, string, or numeric keys — no computed
 *     keys, shorthand properties, spreads, methods, or accessors
 *   - array literals (no holes)
 *   - strings in single or double quotes with the standard escapes; template
 *     literals only without `${…}`
 *   - numbers: decimal (with fraction/exponent), hex `0x`, octal `0o`, binary
 *     `0b`, numeric separators, and one leading `-` or `+`
 *   - `true`, `false`, `null`
 *   - line/block comments and trailing commas wherever JavaScript allows them
 *
 * Everything else — identifiers (including `undefined`, `NaN`, `Infinity`),
 * calls, operators, regex literals, BigInts, legacy octal — is rejected, so the
 * result is always JSON-compatible. Keys are created as own data properties
 * (a `"__proto__"` key never swaps the prototype), and the last duplicate wins.
 */
export function readMetaLiteral(source: string): Record<string, unknown> | null {
  const decl = locateMeta(maskCode(source));
  return decl ? parseMetaLiteral(source, decl.valueStart) : null;
}

/** The meta declaration is not a pure literal; the message says what and where. */
export class MetaLiteralError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetaLiteralError";
  }
}

// --- internals ---------------------------------------------------------------

function extractMeta(source: string, filename: string): { meta: WorkflowMeta; body: string } {
  const masked = maskCode(source);

  const decl = locateMeta(masked);
  if (!decl) {
    throw new WorkflowScriptError(`workflow ${filename} must 'export const meta = { ... }'`);
  }
  const { exportStart } = decl;
  const exportLen = "export".length;

  let meta: Record<string, unknown>;
  try {
    meta = parseMetaLiteral(source, decl.valueStart);
  } catch (err) {
    if (err instanceof MetaLiteralError) {
      throw new WorkflowScriptError(`workflow ${filename}: ${err.message}`);
    }
    throw err;
  }
  assertMeta(meta, filename);

  // Reject any *other* top-level export/import: blank the meta `export` keyword
  // in the masked copy, then look for a stray one outside strings/comments.
  const restMasked =
    masked.slice(0, exportStart) + " ".repeat(exportLen) + masked.slice(exportStart + exportLen);
  if (/\b(?:export|import)\b/.test(restMasked)) {
    throw new WorkflowScriptError(
      `workflow ${filename}: a workflow body may only 'export const meta'; other top-level ` +
        `export/import statements are not supported (the primitives are injected, not imported)`,
    );
  }

  // Strip just the `export` keyword; keep `const meta = <literal>` in the body
  // so the body remains a valid statement sequence.
  const body = source.slice(0, exportStart) + source.slice(exportStart + exportLen);
  return { meta, body };
}

/** Where `export const meta =` is, found in the masked source; null if absent. */
function locateMeta(masked: string): { exportStart: number; valueStart: number } | null {
  const match = EXPORT_META.exec(masked);
  return match ? { exportStart: match.index, valueStart: match.index + match[0].length } : null;
}

function assertMeta(meta: unknown, filename: string): asserts meta is WorkflowMeta {
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
    throw new WorkflowScriptError(`workflow ${filename}: meta must be an object`);
  }
  const m = meta as Record<string, unknown>;
  if (typeof m.name !== "string" || m.name.length === 0) {
    throw new WorkflowScriptError(`workflow ${filename}: meta.name must be a non-empty string`);
  }
  if (typeof m.description !== "string") {
    throw new WorkflowScriptError(`workflow ${filename}: meta.description must be a string`);
  }
}

// --- masking -------------------------------------------------------------------

export interface MaskOptions {
  /**
   * Keep the code inside template `${…}` interpolations visible — only the
   * template *text* and delimiters are blanked, and strings, comments and
   * nested templates inside the interpolation are masked in turn. Default:
   * blank whole template literals, interpolations included.
   */
  keepInterpolations?: boolean;
}

// After these words a `/` starts a regex literal, not a division.
const REGEX_AFTER_WORD = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

/**
 * Return a copy of `src` with every comment, string, template literal and regex
 * literal replaced by spaces (line breaks preserved). Code structure — braces,
 * keywords, positions — is untouched, so simple scans over the result only ever
 * see real code. This is the single tokenizer behind every scan in the loader.
 */
export function maskCode(src: string, opts: MaskOptions = {}): string {
  const keepInterpolations = opts.keepInterpolations === true;
  const n = src.length;
  const out = src.split("");
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
  };

  // Scan code from `start` to EOF or — inside an interpolation — to the `}`
  // that closes it. Returns where it stopped: that brace's index, or n.
  const scanCode = (start: number, inInterpolation: boolean): number => {
    let depth = 0;
    let prev = -1; // index of the last significant code character
    let i = start;
    while (i < n) {
      const ch = src[i]!;
      const next = src[i + 1];
      if (ch === "/" && (next === "/" || next === "*")) {
        // A comment: blanked, and not a token (`prev` stays put).
        const close = next === "/" ? lineEnd(src, i + 2) : src.indexOf("*/", i + 2);
        const end = next === "/" ? close : close === -1 ? n : close + 2;
        blank(i, end);
        i = end;
        continue;
      }
      let end: number | null = null;
      if (ch === '"' || ch === "'") end = stringEnd(src, i);
      else if (ch === "`") end = scanTemplate(i); // blanks as it goes
      else if (ch === "/" && regexAllowed(src, prev)) end = regexEnd(src, i); // null: a division
      if (end !== null) {
        if (ch !== "`") blank(i, end);
        prev = end - 1; // a literal ended here, so a following `/` is a division
        i = end;
        continue;
      }
      if (inInterpolation) {
        if (ch === "{") depth++;
        else if (ch === "}" && depth-- === 0) return i;
      }
      if (!/\s/.test(ch)) prev = i;
      i++;
    }
    return n;
  };

  // src[start] is a backtick; returns the index after the closing backtick.
  const scanTemplate = (start: number): number => {
    let textStart = start;
    let i = start + 1;
    while (i < n) {
      const ch = src[i];
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "`") {
        blank(textStart, i + 1);
        return i + 1;
      }
      if (ch === "$" && src[i + 1] === "{") {
        blank(textStart, i + 2); // template text + the "${" delimiter
        const close = scanCode(i + 2, true);
        if (!keepInterpolations) blank(i + 2, close);
        i = textStart = Math.min(close + 1, n); // the closing "}" is blanked with the text
        blank(close, i);
        continue;
      }
      i++;
    }
    blank(textStart, n);
    return n;
  };

  scanCode(0, false);
  return out.join("");
}

/** Whether a `/` after the code character at `prev` can begin a regex literal. */
function regexAllowed(src: string, prev: number): boolean {
  if (prev < 0) return true;
  const c = src[prev]!;
  if ("([{,;:=!&|?+-*%<>~^".includes(c)) return true;
  if (!/[a-z]/.test(c)) return false; // `)`, `]`, `}`, digits, identifiers: division
  let start = prev;
  while (start > 0 && /[\w$]/.test(src[start - 1]!)) start--;
  // `obj.return / 2` is a property, not the keyword.
  return src[start - 1] !== "." && REGEX_AFTER_WORD.has(src.slice(start, prev + 1));
}

/** Index of the line break ending a `//` comment that starts before `from`. */
function lineEnd(src: string, from: number): number {
  let j = from;
  while (j < src.length && src[j] !== "\n" && src[j] !== "\r") j++;
  return j;
}

/**
 * Index after the quoted string opening at `start`. An unescaped line break
 * ends it early — a JS string cannot span lines, so a stray quote (say, in a
 * regex the scan could not tell from a division) never swallows later code.
 */
function stringEnd(src: string, start: number): number {
  const quote = src[start];
  let j = start + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === "\\") {
      j += src[j + 1] === "\r" && src[j + 2] === "\n" ? 3 : 2; // escape or line continuation
      continue;
    }
    if (c === quote) return j + 1;
    if (c === "\n" || c === "\r") return j;
    j++;
  }
  return src.length;
}

/** Index after the regex literal opening at `start`, or null if it is not one. */
function regexEnd(src: string, start: number): number | null {
  let inClass = false;
  for (let j = start + 1; j < src.length; j++) {
    const c = src[j];
    if (c === "\n" || c === "\r") return null;
    if (c === "\\") {
      if (src[j + 1] === "\n" || src[j + 1] === "\r") return null;
      j++;
    } else if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) return j + 1;
  }
  return null;
}

// --- the pure-literal grammar ----------------------------------------------------

const IDENTIFIER = /[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*/uy;
// Unsigned numeric literal: hex/octal/binary, or decimal with optional fraction
// and exponent; `_` separators only between digits. Leading-zero decimals
// (legacy octal like `017`) stop after the `0` and are rejected by the caller.
const NUMBER =
  /0[xX][\da-fA-F](?:_?[\da-fA-F])*|0[oO][0-7](?:_?[0-7])*|0[bB][01](?:_?[01])*|(?:(?:0|[1-9](?:_?\d)*)(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?/y;
// What may not directly follow a numeric literal (`3in`, `1n`, `08`, `1_`).
const AFTER_NUMBER = /[\p{ID_Start}$_\\\d]/u;
const MAX_DEPTH = 100;

/** Parse the meta object literal at `start` (just after `=`). Never evaluates. */
function parseMetaLiteral(src: string, start: number): Record<string, unknown> {
  return new MetaLiteralParser(src, start).parseMeta();
}

class MetaLiteralParser {
  private pos: number;
  private depth = 0;

  constructor(
    private readonly src: string,
    start: number,
  ) {
    this.pos = start;
  }

  parseMeta(): Record<string, unknown> {
    this.skipTrivia();
    const start = this.pos;
    const c = this.src[start];
    if (c !== "{") {
      // A literal of the wrong shape vs. anything computed get different advice.
      const literal = c === "[" || c === '"' || c === "'" || c === "`" || this.startsNumber(start) ||
        c === "-" || c === "+" || /^(?:true|false|null)$/.test(this.wordAt(start) ?? "");
      if (literal) {
        throw new MetaLiteralError(
          `meta must be an object literal (found ${this.describe(start)} at line ${this.lineCol(start)})`,
        );
      }
      throw this.fail(`found ${this.describe(start)}`, start);
    }
    const value = this.parseObject();
    this.checkEnd();
    return value;
  }

  private parseValue(): unknown {
    this.skipTrivia();
    const at = this.pos;
    const c = this.src[at];
    if (c === "{") return this.parseObject();
    if (c === "[") return this.parseArray();
    if (c === '"' || c === "'") return this.parseString();
    if (c === "`") return this.parseTemplate();
    if (c === "-" || c === "+") {
      this.pos++;
      this.skipTrivia();
      if (!this.startsNumber(this.pos)) {
        throw this.fail(`found ${this.describe(this.pos)} after '${c}'`, this.pos);
      }
      const n = this.parseNumber();
      return c === "-" ? -n : n;
    }
    if (this.startsNumber(at)) return this.parseNumber();
    const word = this.wordAt(at);
    if (word === "true" || word === "false" || word === "null") {
      this.pos += word.length;
      return word === "null" ? null : word === "true";
    }
    throw this.fail(`found ${this.describe(at)}`, at);
  }

  private parseObject(): Record<string, unknown> {
    this.enter();
    this.pos++; // "{"
    const obj: Record<string, unknown> = {};
    for (;;) {
      this.skipTrivia();
      if (this.src[this.pos] === "}") break;
      const keyStart = this.pos;
      const key = this.parseKey();
      this.skipTrivia();
      const c = this.src[this.pos];
      if (c !== ":") {
        if (c === "," || c === "}") throw this.fail(`found shorthand property '${key}'`, keyStart);
        if (c === "(" || ((key === "get" || key === "set" || key === "async") && c !== undefined)) {
          throw this.fail(`found method or accessor '${key}'`, keyStart);
        }
        throw this.fail(`expected ':' but found ${this.describe(this.pos)}`, this.pos);
      }
      this.pos++; // ":"
      // An own data property even for "__proto__" (as JSON.parse does).
      Object.defineProperty(obj, key, {
        value: this.parseValue(),
        writable: true,
        enumerable: true,
        configurable: true,
      });
      this.skipTrivia();
      const sep = this.src[this.pos];
      if (sep === "}") break;
      if (sep !== ",") throw this.fail(`expected ',' or '}' but found ${this.describe(this.pos)}`, this.pos);
      this.pos++;
    }
    this.pos++; // "}"
    this.depth--;
    return obj;
  }

  private parseArray(): unknown[] {
    this.enter();
    this.pos++; // "["
    const arr: unknown[] = [];
    for (;;) {
      this.skipTrivia();
      const c = this.src[this.pos];
      if (c === "]") break;
      if (c === ",") throw this.fail("found array hole ','", this.pos);
      arr.push(this.parseValue());
      this.skipTrivia();
      const sep = this.src[this.pos];
      if (sep === "]") break;
      if (sep !== ",") throw this.fail(`expected ',' or ']' but found ${this.describe(this.pos)}`, this.pos);
      this.pos++;
    }
    this.pos++; // "]"
    this.depth--;
    return arr;
  }

  private parseKey(): string {
    const at = this.pos;
    const c = this.src[at];
    if (c === '"' || c === "'") return this.parseString();
    if (c === "[") throw this.fail("found computed key '['", at);
    if (this.startsNumber(at)) return String(this.parseNumber());
    const word = this.wordAt(at);
    if (word === null) throw this.fail(`found ${this.describe(at)}`, at);
    this.pos += word.length; // any identifier name, reserved words included
    return word;
  }

  private parseString(): string {
    const start = this.pos;
    const quote = this.src[this.pos++];
    let out = "";
    for (;;) {
      const c = this.src[this.pos];
      if (c === undefined || c === "\n" || c === "\r") throw this.fail("unterminated string", start);
      if (c === quote) {
        this.pos++;
        return out;
      }
      if (c === "\\") out += this.parseEscape();
      else {
        out += c;
        this.pos++;
      }
    }
  }

  /** A template literal without interpolation (its cooked value). */
  private parseTemplate(): string {
    const start = this.pos++;
    let out = "";
    for (;;) {
      const c = this.src[this.pos];
      if (c === undefined) throw this.fail("unterminated template literal", start);
      if (c === "`") {
        this.pos++;
        return out;
      }
      if (c === "$" && this.src[this.pos + 1] === "{") {
        throw this.fail("found template interpolation '${'", this.pos);
      }
      if (c === "\\") out += this.parseEscape();
      else if (c === "\r") {
        // CR and CRLF in template text both read as LF.
        this.pos += this.src[this.pos + 1] === "\n" ? 2 : 1;
        out += "\n";
      } else {
        out += c;
        this.pos++;
      }
    }
  }

  /** The escape sequence at `pos` (a backslash), as the characters it denotes. */
  private parseEscape(): string {
    const at = this.pos;
    const c = this.src[at + 1];
    this.pos += 2;
    switch (c) {
      case undefined:
        throw this.fail("unterminated string", at);
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "v":
        return "\v";
      case "\r": // line continuation (CR or CRLF)
        if (this.src[this.pos] === "\n") this.pos++;
        return "";
      case "\n":
      case "\u2028":
      case "\u2029":
        return "";
      case "x":
        return String.fromCharCode(this.hexDigits(at, 2));
      case "u":
        if (this.src[this.pos] === "{") {
          const close = this.src.indexOf("}", this.pos);
          const hex = close === -1 ? "" : this.src.slice(this.pos + 1, close);
          const cp = /^[\da-fA-F]+$/.test(hex) ? parseInt(hex, 16) : NaN;
          if (!(cp <= 0x10ffff)) throw this.fail("invalid \\u{…} escape", at);
          this.pos = close + 1;
          return String.fromCodePoint(cp);
        }
        return String.fromCharCode(this.hexDigits(at, 4));
      default:
        if (c >= "0" && c <= "9" && !(c === "0" && !/\d/.test(this.src[this.pos] ?? ""))) {
          throw this.fail(`found legacy octal escape '\\${c}'`, at);
        }
        return c === "0" ? "\0" : c; // \' \" \\ \` \$ and the rest stand for themselves
    }
  }

  private hexDigits(at: number, count: number): number {
    const hex = this.src.slice(this.pos, this.pos + count);
    if (hex.length !== count || !/^[\da-fA-F]+$/.test(hex)) {
      throw this.fail(`invalid escape '${this.src.slice(at, this.pos + count)}'`, at);
    }
    this.pos += count;
    return parseInt(hex, 16);
  }

  /** An unsigned numeric literal at `pos`. */
  private parseNumber(): number {
    const at = this.pos;
    NUMBER.lastIndex = at;
    const m = NUMBER.exec(this.src);
    const after = m ? this.src[at + m[0].length] : undefined;
    if (!m || (after !== undefined && AFTER_NUMBER.test(after))) {
      const token = /^[\w.$]*/.exec(this.src.slice(at))![0] || this.src[at];
      throw this.fail(`found unsupported number '${token}'`, at);
    }
    this.pos += m[0].length;
    return Number(m[0].replace(/_/g, ""));
  }

  /**
   * After the literal: the declaration must end here. Anything that would
   * continue the expression (`.x`, `(…)`, `[…]`, a tagged template, an operator,
   * another declarator) means `meta` is not the literal itself.
   */
  private checkEnd(): void {
    const end = this.pos;
    // An unterminated comment here is the body's syntax error, not meta's.
    try {
      this.skipTrivia();
    } catch {
      return;
    }
    const at = this.pos;
    const c = this.src[at];
    if (c === undefined || c === ";") return;
    const next = this.src[at + 1];
    const newline = /[\n\r\u2028\u2029]/.test(this.src.slice(end, at));
    const word = this.wordAt(at);
    const continues =
      ".?[(`,=*/%<>&|^".includes(c) ||
      // `++`/`--` on a new line start a new statement (ASI); a lone `+`/`-` never does.
      ((c === "+" || c === "-") && !(newline && next === c)) ||
      (c === "!" && next === "=") ||
      word === "in" ||
      word === "instanceof";
    if (continues) throw this.fail(`found ${this.describe(at)} after the literal`, at);
  }

  private skipTrivia(): void {
    for (;;) {
      const c = this.src[this.pos];
      if (c === undefined) return;
      if (/\s/.test(c)) {
        this.pos++; // every JS whitespace and line terminator (NBSP, BOM, U+2028/9 too)
      } else if (c === "/" && this.src[this.pos + 1] === "/") {
        while (this.pos < this.src.length && !/[\n\r\u2028\u2029]/.test(this.src[this.pos]!)) this.pos++;
      } else if (c === "/" && this.src[this.pos + 1] === "*") {
        const close = this.src.indexOf("*/", this.pos + 2);
        if (close === -1) throw this.fail("unterminated comment", this.pos);
        this.pos = close + 2;
      } else {
        return;
      }
    }
  }

  private startsNumber(at: number): boolean {
    const c = this.src[at];
    return c !== undefined && (/\d/.test(c) || (c === "." && /\d/.test(this.src[at + 1] ?? "")));
  }

  private wordAt(at: number): string | null {
    IDENTIFIER.lastIndex = at;
    return IDENTIFIER.exec(this.src)?.[0] ?? null;
  }

  private enter(): void {
    if (++this.depth > MAX_DEPTH) throw this.fail("found nesting deeper than " + MAX_DEPTH, this.pos);
  }

  /** A short description of the token at `at`, for error messages. */
  private describe(at: number): string {
    if (at >= this.src.length) return "end of input";
    if (this.src.startsWith("...", at)) return "spread '...'";
    const c = this.src[at];
    if (c === '"' || c === "'") return "string";
    if (c === "`") return "template literal";
    const word = this.wordAt(at);
    if (word !== null) return `identifier '${word}'`;
    return `'${String.fromCodePoint(this.src.codePointAt(at)!)}'`;
  }

  private fail(what: string, at: number): MetaLiteralError {
    return new MetaLiteralError(`meta must be a pure literal (${what} at line ${this.lineCol(at)})`);
  }

  /** 1-based `line:column` of `at` in the whole source. */
  private lineCol(at: number): string {
    let line = 1;
    let lineStart = 0;
    for (let i = 0; i < at; i++) {
      const c = this.src[i];
      if (c === "\n" || c === "\u2028" || c === "\u2029" || (c === "\r" && this.src[i + 1] !== "\n")) {
        line++;
        lineStart = i + 1;
      }
    }
    return `${line}:${at - lineStart + 1}`;
  }
}
