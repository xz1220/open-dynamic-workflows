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
 * comment is never mistaken for the real declaration. The literal is then sliced
 * from the *original* source so its quoted content and comments survive `eval`.
 */

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
// `validate` is an ODW-only extension. Injecting it as a 9th formal parameter
// would make `const validate = …` in a body a duplicate-declaration compile
// error — and Claude Code does NOT reserve the name, so a perfectly valid
// Claude-authored script would break only on odw. So we inject it only when the
// body does not declare its own `validate` (the script's own binding then wins,
// exactly as it would on Claude Code).
const VALIDATE_PARAM = "validate";
const DECLARES_VALIDATE = /\b(?:const|let|var|function|class)\s+validate\b/;

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (...callArgs: unknown[]) => Promise<unknown>;

const EXPORT_META = /\bexport\s+const\s+meta\s*=/;

/** Parse + transform a workflow script's source into a runnable form. */
export function loadWorkflowScript(source: string, filename: string): LoadedWorkflow {
  const { meta, body } = extractMeta(source, filename);

  // Inject `validate` only if the body does not bind that identifier itself.
  // Check the masked body so a `validate` inside a string/comment never counts.
  const injectValidate = !DECLARES_VALIDATE.test(maskNonCode(body));
  const paramNames = injectValidate ? [...CLAUDE_PARAM_NAMES, VALIDATE_PARAM] : [...CLAUDE_PARAM_NAMES];

  let factory: (...callArgs: unknown[]) => Promise<unknown>;
  try {
    factory = new AsyncFunction(...paramNames, `${body}\n//# sourceURL=${filename}`);
  } catch (err) {
    throw new WorkflowScriptError(`failed to compile workflow ${filename}: ${(err as Error).message}`);
  }

  return {
    meta,
    run(globals: WorkflowGlobals, args: unknown): Promise<unknown> {
      // Extra trailing args are ignored by JS, so passing validate even when the
      // factory has eight params is harmless — the order of the first eight is
      // what matters and never moves.
      return factory(
        globals.agent,
        globals.parallel,
        globals.pipeline,
        globals.phase,
        globals.log,
        args,
        globals.budget,
        globals.workflow,
        globals.validate,
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
 * the warning must catch it (the generic `maskNonCode`, used for meta
 * extraction, blanks whole template literals and would miss it).
 *
 * These come back as *warnings*, not errors — ODW itself executes them — so a
 * caller (the generate-workflow repair loop, a linter) can decide how hard to
 * push for dual-compatibility.
 */
export function scanDualCompat(source: string): string[] {
  const masked = maskForDualScan(source);
  const warnings: string[] = [];
  const rules: Array<[RegExp, string]> = [
    [/\bDate\s*\.\s*now\s*\(/, "Date.now() is banned in Claude Code workflows — pass timestamps in via args"],
    [/\bMath\s*\.\s*random\s*\(/, "Math.random() is banned in Claude Code workflows — vary prompts by index instead"],
    [/\bnew\s+Date\s*\(\s*\)/, "arg-less new Date() is banned in Claude Code workflows — pass timestamps in via args"],
  ];
  for (const [re, message] of rules) {
    if (re.test(masked)) warnings.push(message);
  }
  return warnings;
}

/**
 * Like {@link maskNonCode}, but template-literal *interpolations* stay visible:
 * only comments, ordinary strings, and template *text* are blanked. Strings,
 * comments, and nested templates inside an interpolation are themselves masked,
 * so the result is "code as it executes" with only inert text removed.
 */
function maskForDualScan(src: string): string {
  const out = src.split("");
  const n = src.length;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };

  // src[i] is the char after an opening backtick; returns the index after the
  // closing backtick. Blanks literal text, recurses into ${…} as code.
  const scanTemplate = (start: number): number => {
    let i = start;
    let textStart = i;
    while (i < n) {
      const ch = src[i];
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "`") {
        blank(textStart, i);
        return i + 1;
      }
      if (ch === "$" && src[i + 1] === "{") {
        blank(textStart, i + 2); // text + the "${" delimiter
        i = scanInterp(i + 2); // interior visible (its own strings blanked)
        textStart = i;
        continue;
      }
      i++;
    }
    blank(textStart, i);
    return i;
  };

  // src[i] is the char after "${"; returns the index after the matching "}".
  const scanInterp = (start: number): number => {
    let i = start;
    let depth = 1;
    while (i < n && depth > 0) {
      const ch = src[i];
      const next = src[i + 1];
      if (ch === "/" && next === "/") {
        let j = i + 2;
        while (j < n && src[j] !== "\n") j++;
        blank(i, j);
        i = j;
        continue;
      }
      if (ch === "/" && next === "*") {
        let j = i + 2;
        while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++;
        j = Math.min(n, j + 2);
        blank(i, j);
        i = j;
        continue;
      }
      if (ch === '"' || ch === "'") {
        i = scanString(i, ch);
        continue;
      }
      if (ch === "`") {
        i = scanTemplate(i + 1);
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      i++;
    }
    return i;
  };

  const scanString = (start: number, quote: string): number => {
    let j = start + 1;
    let escaped = false;
    while (j < n) {
      const c = src[j];
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === quote) {
        j++;
        break;
      }
      j++;
    }
    blank(start, j);
    return j;
  };

  let i = 0;
  let prevSig = "";
  while (i < n) {
    const ch = src[i]!;
    const next = src[i + 1];
    if (ch === "/" && next === "/") {
      let j = i + 2;
      while (j < n && src[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (ch === "/" && next === "*") {
      let j = i + 2;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++;
      j = Math.min(n, j + 2);
      blank(i, j);
      i = j;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = scanString(i, ch);
      prevSig = ch;
      continue;
    }
    if (ch === "`") {
      i = scanTemplate(i + 1);
      prevSig = "`";
      continue;
    }
    if (ch === "/" && regexAllowed(prevSig)) {
      const j = scanRegex(src, i, n);
      if (j !== null) {
        blank(i, j);
        i = j;
        prevSig = "/";
        continue;
      }
    }
    if (!/\s/.test(ch)) prevSig = ch;
    i++;
  }
  return out.join("");
}

/** A terminated regex literal starting at `start`, or null. Shared shape with maskNonCode. */
function scanRegex(src: string, start: number, n: number): number | null {
  let j = start + 1;
  let escaped = false;
  let inClass = false;
  while (j < n) {
    const c = src[j]!;
    if (escaped) escaped = false;
    else if (c === "\\") escaped = true;
    else if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "\n") return null;
    else if (c === "/" && !inClass) return j + 1;
    j++;
  }
  return null;
}

// --- internals ---------------------------------------------------------------

function extractMeta(source: string, filename: string): { meta: WorkflowMeta; body: string } {
  const masked = maskNonCode(source);

  const match = EXPORT_META.exec(masked);
  if (!match) {
    throw new WorkflowScriptError(`workflow ${filename} must 'export const meta = { ... }'`);
  }
  const exportStart = match.index;
  const exportLen = "export".length;

  const braceStart = masked.indexOf("{", exportStart + match[0].length);
  if (braceStart === -1) {
    throw new WorkflowScriptError(`workflow ${filename}: could not find the meta object literal`);
  }
  const end = matchBrace(masked, braceStart);
  if (end === null) {
    throw new WorkflowScriptError(`workflow ${filename}: unterminated meta object literal`);
  }

  // The literal comes from the ORIGINAL source so its strings/comments survive.
  const literal = source.slice(braceStart, end + 1);
  let meta: unknown;
  try {
    meta = new Function(`return (${literal});`)();
  } catch (err) {
    throw new WorkflowScriptError(
      `workflow ${filename}: meta must be a literal expression (${(err as Error).message})`,
    );
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

/** Index of the `}` that closes the brace opening at `start` (masked source). */
function matchBrace(masked: string, start: number): number | null {
  let depth = 0;
  for (let i = start; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return null;
}

/**
 * Return a copy of `src` with every string, template literal, comment and regex
 * literal replaced by spaces (newlines preserved). Code structure — braces,
 * keywords, positions — is untouched, so simple scans over the result only ever
 * see real code.
 */
function maskNonCode(src: string): string {
  const out = src.split("");
  const n = src.length;
  let prevSig = "";

  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };

  let i = 0;
  while (i < n) {
    const ch = src[i]!;
    const next = src[i + 1];

    if (ch === "/" && next === "/") {
      let j = i + 2;
      while (j < n && src[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (ch === "/" && next === "*") {
      let j = i + 2;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++;
      j = Math.min(n, j + 2);
      blank(i, j);
      i = j;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      let escaped = false;
      while (j < n) {
        const c = src[j]!;
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === ch) {
          j++;
          break;
        }
        j++;
      }
      blank(i, j);
      i = j;
      prevSig = ch;
      continue;
    }
    if (ch === "/" && regexAllowed(prevSig)) {
      let j = i + 1;
      let escaped = false;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const c = src[j]!;
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "\n") break;
        else if (c === "/" && !inClass) {
          j++;
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        blank(i, j);
        i = j;
        prevSig = "/";
        continue;
      }
      // Not a terminated regex — treat the `/` as ordinary code (division).
    }

    if (!/\s/.test(ch)) prevSig = ch;
    i++;
  }
  return out.join("");
}

/** Whether a `/` at this point can begin a regex literal (vs. division). */
function regexAllowed(prevSig: string): boolean {
  return prevSig === "" || "([{,;:=!&|?+-*%<>~^".includes(prevSig);
}

function assertMeta(meta: unknown, filename: string): asserts meta is WorkflowMeta {
  if (meta === null || typeof meta !== "object") {
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
