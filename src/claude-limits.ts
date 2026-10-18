/**
 * Claude Code's documented limits that ODW does not share, read off a
 * workflow's source so `odw check` (and `validate()`) can say a script that
 * runs here would be refused there. Nothing is enforced: ODW runs it.
 *
 * One limit so far: Claude Code's runtime rejects a `parallel()` or
 * `pipeline()` of more than 4,096 items with an error, where ODW has no such
 * cap. Only a list whose length the source settles as a literal is counted:
 *
 *   parallel([a, b, c, …])                    an array literal (no spread)
 *   parallel(Array.from({ length: 5000 }, f))  Array.from with a literal length
 *   parallel(Array(5000).fill(…).map(…))      Array(n) / new Array(n)
 *   parallel([...Array(5000).keys()])         a spread of Array(n) (or its keys), alone in its literal
 *
 * each optionally followed by `.map(…)`, `.fill(…)` or `.keys()`, which keep
 * the length. Anything else — a variable, a `.filter(…)`, a computed length —
 * is not counted, so a warning is never a guess.
 */

/** Claude Code's cap on the items of one `parallel()` or `pipeline()` call. */
export const CLAUDE_CODE_FANOUT_CAP = 4096;

/** A `parallel(`/`pipeline(` call — not `obj.parallel(` and not `myparallel(`. */
const FANOUT_CALL = /(?<![\w$])(?<!\.\s*)(parallel|pipeline)\s*\(/g;
const NUMBER = String.raw`(\d[\d_]*)`;
const ARRAY_FROM = new RegExp(String.raw`^Array\s*\.\s*from\s*\(\s*\{\s*length\s*:\s*${NUMBER}\s*\}`);
const ARRAY_N = new RegExp(String.raw`^(?:new\s+)?Array\s*\(\s*${NUMBER}\s*\)`);
const SPREAD_ARRAY_N = new RegExp(String.raw`^\[\s*\.\.\.\s*(?:new\s+)?Array\s*\(\s*${NUMBER}\s*\)\s*(?:\.\s*keys\s*\(\s*\)\s*)?\]`);
/** A call that keeps an array's length. */
const KEEPS_LENGTH = /^\.\s*(?:map|fill|keys)\s*\(/;

/**
 * The warnings for a workflow's `source`, given `masked` (it with strings, comments and
 * regexes blanked — ./loader `maskCode`): one per call over the cap, with
 * its line. A script that declares its own `parallel`/`pipeline` is not
 * calling the primitive, and gets none for that name.
 */
export function scanClaudeCodeLimits(source: string, masked: string): string[] {
  const warnings: string[] = [];
  for (const m of masked.matchAll(FANOUT_CALL)) {
    const name = m[1]!;
    if (new RegExp(String.raw`\b(?:const|let|var|function|class)\s+${name}\b`).test(masked)) continue;
    const items = literalLength(masked, source, m.index + m[0].length);
    if (items === null || items <= CLAUDE_CODE_FANOUT_CAP) continue;
    const line = masked.slice(0, m.index).split("\n").length;
    warnings.push(
      `${name}() on line ${line} is given ${items.toLocaleString("en-US")} items — Claude Code's Workflow tool rejects a ` +
        `parallel() or pipeline() of more than ${CLAUDE_CODE_FANOUT_CAP.toLocaleString("en-US")} with an error ` +
        `(ODW runs it): split the list into batches to run it there`,
    );
  }
  return warnings;
}

/** The length of the first argument starting at `at`, when the source settles it; else null. */
function literalLength(src: string, source: string, at: number): number | null {
  let i = skipSpace(src, at);
  const rest = src.slice(i);
  let length: number | null = null;
  let m: RegExpExecArray | null;
  if ((m = SPREAD_ARRAY_N.exec(rest))) {
    length = toNumber(m[1]!);
    i += m[0].length;
  } else if ((m = ARRAY_FROM.exec(rest))) {
    // Array.from({ length: n }) or Array.from({ length: n }, f): through its closing paren.
    const close = matching(src, i + rest.indexOf("("));
    if (close === null) return null;
    length = toNumber(m[1]!);
    i = close + 1;
  } else if ((m = ARRAY_N.exec(rest))) {
    length = toNumber(m[1]!);
    i += m[0].length;
  } else if (rest.startsWith("[")) {
    const close = matching(src, i);
    if (close === null) return null;
    length = countElements(src.slice(i + 1, close), source.slice(i + 1, close));
    i = close + 1;
  }
  if (length === null) return null;
  // Calls that keep the length, then the argument must end.
  for (;;) {
    i = skipSpace(src, i);
    const call = KEEPS_LENGTH.exec(src.slice(i));
    if (!call) break;
    const close = matching(src, i + call[0].length - 1);
    if (close === null) return null;
    i = close + 1;
  }
  const end = src[skipSpace(src, i)];
  return end === "," || end === ")" ? length : null;
}

/** The elements of an array literal's inside; null with a spread (its length is not the literal's). */
function countElements(inner: string, original: string): number | null {
  let depth = 0;
  let count = 0;
  let pending = false;
  for (let k = 0; k < inner.length; k++) {
    const c = inner[k]!;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0 && c === ".") {
      if (inner.startsWith("...", k)) return null;
    } else if (depth === 0 && c === ",") {
      count++;
      pending = false;
      continue;
    }
    if (!/\s/.test(original[k]!)) pending = true;
  }
  return count + (pending ? 1 : 0);
}

/** The index of the bracket closing the one at `open`, or null. */
function matching(src: string, open: number): number | null {
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    const c = src[k];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return k;
    }
  }
  return null;
}

function skipSpace(src: string, i: number): number {
  while (i < src.length && /\s/.test(src[i]!)) i++;
  return i;
}

function toNumber(digits: string): number {
  return Number(digits.replace(/_/g, ""));
}
