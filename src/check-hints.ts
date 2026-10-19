/**
 * `odw check`'s hints (an ODW extension): two shapes of script that run
 * without an error and do nothing — read off the source, never run, and
 * never a reason to refuse it. No general JS lint: these two only.
 *
 *   1. `filter-null`: a `parallel()` or `pipeline()` result filtered with
 *      `.filter(Boolean)` (or `x => x`, `x => x != null`), and nothing after
 *      it checks how many are left — a fan-out that came back all null goes
 *      on as an empty list. A parallel() with `minOk` (see ./fanout) is not
 *      hinted: it throws first.
 *   2. `empty-match`: a list chosen by matching what an agent wrote — a
 *      `.filter()` whose test reads a field of an agent's result, or a
 *      filter over an agent's result that compares one of its fields — and
 *      nothing after it checks it is not empty. When the agent's free text
 *      matches nothing, the steps over that list do nothing, and the run
 *      reads as if they passed (anthropics/claude-code#94535).
 *
 * "Checks": a later `name.length`, `!name`, or `name` in a comparison
 * (for a count, `.filter(…).length`). The scan is over a mask of the source
 * (./loader `maskCode`: strings and comments blanked), by name, in the order
 * written: a result kept under another name, or checked in a helper, is not
 * followed — a hint, not a verdict.
 */

import { locationAt, maskCode } from "./loader.js";

export interface CheckHint {
  /** Which shape: `filter-null` or `empty-match`. */
  rule: "filter-null" | "empty-match";
  message: string;
  /** 1-based. */
  line: number;
  column: number;
}

const IDENT = "[A-Za-z_$][\\w$]*";

/** Every hint for `source`, in source order. */
export function scanHints(source: string): CheckHint[] {
  const masked = maskCode(source, { keepInterpolations: true });
  const found = new Map<number, CheckHint>();
  const hint = (rule: CheckHint["rule"], at: number, message: string): void => {
    if (found.has(at)) return;
    const { line, column } = locationAt(source, at);
    found.set(at, { rule, message, line, column });
  };
  filterNullHints(masked, hint);
  emptyMatchHints(masked, hint);
  return [...found.entries()].sort((a, b) => a[0] - b[0]).map(([, h]) => h);
}

type Hint = (rule: CheckHint["rule"], at: number, message: string) => void;

/** Rule 1: a fan-out's result filtered for truthy values, its length never checked. */
function filterNullHints(masked: string, hint: Hint): void {
  const fanOut = /\bawait\s+(parallel|pipeline)\s*\(/g;
  for (const m of masked.matchAll(fanOut)) {
    const call = m[1] as "parallel" | "pipeline";
    const open = m.index + m[0].length - 1;
    const close = matchClose(masked, open);
    if (close < 0) continue;
    if (call === "parallel" && /\bminOk\b/.test(masked.slice(open, close))) continue;
    // `(await parallel(…)).filter(Boolean)`, straight on the call.
    const direct = /^\s*\)?\s*\.\s*filter\s*\(/.exec(masked.slice(close + 1));
    if (direct) {
      const filterOpen = close + direct[0].length;
      checkFiltered(masked, call, m.index, filterOpen, hint);
      continue;
    }
    // `const results = await parallel(…)`, then `results.filter(Boolean)`.
    const held = assignedName(masked, m.index);
    if (!held || !/^\s*;?\s*$/.test(masked.slice(close + 1, nextLineEnd(masked, close + 1)))) continue;
    const use = new RegExp(`(?<![\\w$.])${escapeName(held)}\\s*\\.\\s*filter\\s*\\(`, "g");
    use.lastIndex = close;
    for (const u of masked.matchAll(use)) {
      if (u.index < close) continue;
      checkFiltered(masked, call, u.index, u.index + u[0].length - 1, hint);
    }
  }
}

/** A `.filter(` at `filterOpen` over a fan-out's result: hint when its test keeps the truthy and nothing checks what is left. */
function checkFiltered(masked: string, call: "parallel" | "pipeline", exprStart: number, filterOpen: number, hint: Hint): void {
  const filterClose = matchClose(masked, filterOpen);
  if (filterClose < 0) return;
  if (!isTruthyTest(masked.slice(filterOpen + 1, filterClose))) return;
  const count = /^\s*\.\s*length\b/.test(masked.slice(filterClose + 1));
  const name = assignedName(masked, exprStart);
  if (name === null) {
    if (!/\breturn\s*\(?\s*$/.test(masked.slice(Math.max(0, exprStart - 40), exprStart))) return;
  } else if (isChecked(masked, name, filterClose, count)) return;
  const at = masked.lastIndexOf(".", filterOpen);
  hint(
    "filter-null",
    at < 0 ? filterOpen : at,
    `${call}() results filtered with .filter(Boolean) and nothing checks how many are left — ` +
      `a fan-out that came back all null goes on as an empty list; ` +
      (call === "parallel"
        ? `check ${name ? `${name}.length` : "its length"}, or pass { minOk } to parallel() so too few ok results throw`
        : `check ${name ? `${name}.length` : "its length"} before going on`),
  );
}

/** A filter test that keeps the truthy (or non-null) values: `Boolean`, `x => x`, `x => x != null`, `(x) => !!x`. */
function isTruthyTest(test: string): boolean {
  const t = test.trim();
  if (t === "Boolean") return true;
  const arrow = new RegExp(`^\\(?\\s*(${IDENT})\\s*\\)?\\s*=>\\s*(.*)$`, "s").exec(t);
  if (!arrow) return false;
  const [, param, body] = arrow;
  const p = escapeName(param!);
  return new RegExp(`^(?:!!\\s*)?${p}$|^${p}\\s*!==?\\s*(?:null|undefined)$|^(?:null|undefined)\\s*!==?\\s*${p}$`).test(body!.trim());
}

/** Rule 2: a list chosen by matching an agent's text, its emptiness never checked. */
function emptyMatchHints(masked: string, hint: Hint): void {
  const fromAgents = agentDerivedNames(masked);
  if (fromAgents.size === 0) return;
  const filter = /\.\s*filter\s*\(/g;
  for (const m of masked.matchAll(filter)) {
    const open = m.index + m[0].length - 1;
    const close = matchClose(masked, open);
    if (close < 0) continue;
    const test = masked.slice(open + 1, close);
    if (isTruthyTest(test)) continue; // rule 1's
    const receiver = new RegExp(`(?<![\\w$])(${IDENT})((?:\\s*\\??\\.\\s*${IDENT})*)\\s*$`).exec(masked.slice(Math.max(0, m.index - 200), m.index));
    if (!receiver) continue;
    const root = receiver[1]!;
    const receiverStart = m.index - receiver[0].length;
    let source: string | null = null;
    if (!fromAgents.has(root)) {
      // Others' items, chosen by what an agent wrote: `lenses.filter(l => verdict.rerun.includes(l.name))`.
      for (const name of fromAgents) {
        if (new RegExp(`(?<![\\w$.])${escapeName(name)}\\s*(?:\\??\\.\\s*${IDENT}|\\[)`).test(test)) {
          source = name;
          break;
        }
      }
    } else if (new RegExp(`\\.\\s*${IDENT}\\s*(?:[!=]==?|\\.\\s*(?:includes|startsWith|endsWith)\\s*\\()|(?:===?|!==?)\\s*${IDENT}\\s*\\??\\.\\s*${IDENT}`).test(test)) {
      // An agent's items, by one of their fields: `findings.filter(f => f.severity === "blocking")`.
      source = root;
    }
    if (source === null) continue;
    const count = /^\s*\.\s*length\b/.test(masked.slice(close + 1));
    const name = assignedName(masked, receiverStart);
    if (name === null || isChecked(masked, name, close, count)) continue;
    hint(
      "empty-match",
      m.index,
      `${name} is chosen by matching what an agent wrote (${source}) and nothing checks it is not empty — ` +
        `when its text matches nothing, ${count ? `${name} is 0` : `${name} is empty`} and what runs over it does nothing, ` +
        `as if it passed; check ${count ? name : `${name}.length`} and fail or log when nothing matched`,
    );
  }
}

/**
 * The names that hold what an agent returned: assigned from `await agent(…)`,
 * `parallel(…)`, `pipeline(…)` or `workflow(…)` (destructured names too), and
 * — once, in the order written — names assigned from an expression over one
 * of those.
 */
function agentDerivedNames(masked: string): Set<string> {
  const names = new Set<string>();
  const decl = new RegExp(`\\b(?:const|let|var)\\s+(${IDENT}|\\{[^}]*\\}|\\[[^\\]]*\\])\\s*=\\s*`, "g");
  for (const m of masked.matchAll(decl)) {
    const target = m[1]!;
    const start = m.index + m[0].length;
    const end = nextStatementEnd(masked, start);
    const expr = masked.slice(start, end);
    const fromAgent = /^\(?\s*await\s+(?:agent|parallel|pipeline|workflow)\s*\(/.test(expr);
    const derived = !fromAgent && [...names].some((n) => new RegExp(`(?<![\\w$.])${escapeName(n)}(?![\\w$])`).test(expr));
    if (!fromAgent && !derived) continue;
    if (/^[{[]/.test(target)) {
      for (const part of target.slice(1, -1).split(",")) {
        const id = new RegExp(`(${IDENT})\\s*(?:=.*)?$`).exec(part.split(":").pop()!.trim());
        if (id) names.add(id[1]!);
      }
    } else names.add(target);
  }
  return names;
}

/** Whether, after `from`, something checks `name` for emptiness: `.length`, `!name`, or a comparison (a count). */
function isChecked(masked: string, name: string, from: number, count: boolean): boolean {
  const n = escapeName(name);
  const after = masked.slice(from);
  if (new RegExp(`(?<![\\w$.])${n}\\s*\\??\\.\\s*(?:length|size)\\b`).test(after)) return true;
  if (!count) return false;
  return (
    new RegExp(`!\\s*${n}(?![\\w$])`).test(after) ||
    new RegExp(`(?<![\\w$.])${n}\\s*(?:[!=]==?|<=?|>=?)`).test(after) ||
    new RegExp(`(?:[!=]==?|<=?|>=?)\\s*${n}(?![\\w$])`).test(after) ||
    new RegExp(`\\bif\\s*\\(\\s*${n}\\s*\\)`).test(after)
  );
}

/** The name a `const|let|var name = ` right before `at` declares (an `await` and a `(` between allowed); null when none. */
function assignedName(masked: string, at: number): string | null {
  const before = masked.slice(Math.max(0, at - 120), at);
  const m = new RegExp(`\\b(?:const|let|var)\\s+(${IDENT})\\s*=\\s*(?:\\(\\s*)?(?:await\\s+)?(?:\\(\\s*)?$`).exec(before);
  return m ? m[1]! : null;
}

/** The index of the bracket closing the one at `open` (strings already masked); -1 if none. */
function matchClose(masked: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const stack: string[] = [];
  for (let i = open; i < masked.length; i++) {
    const ch = masked[i]!;
    if (ch in pairs) stack.push(pairs[ch]!);
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (stack.pop() !== ch) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/** Where the statement starting at `from` ends: a `;` or a line break outside brackets (or the end). */
function nextStatementEnd(masked: string, from: number): number {
  let depth = 0;
  for (let i = from; i < masked.length; i++) {
    const ch = masked[i]!;
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) return i;
      depth--;
    } else if (depth === 0 && (ch === ";" || ch === "\n")) return i;
  }
  return masked.length;
}

function nextLineEnd(masked: string, from: number): number {
  const i = masked.indexOf("\n", from);
  return i < 0 ? masked.length : i;
}

function escapeName(name: string): string {
  return name.replace(/\$/g, "\\$");
}
