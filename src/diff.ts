/**
 * A small, dependency-free unified diff over text.
 *
 * Node has no built-in diff, and we keep zero runtime dependencies, so this is a
 * compact LCS line diff grouped into unified-format hunks with three lines of
 * context. It is used by {@link withWorkspace} to report what an agent changed.
 * The +/- content is exact; hunk headers are best-effort at file edges.
 */

type OpType = "eq" | "del" | "ins";
interface Op {
  type: OpType;
  line: string;
}
interface AnnOp extends Op {
  a: number; // 1-based line number in the old text (-1 for inserts)
  b: number; // 1-based line number in the new text (-1 for deletes)
}

const CONTEXT = 3;

/** Unified diff of `aText` → `bText`; empty string when they are identical. */
export function unifiedDiff(aText: string, bText: string, fromFile: string, toFile: string): string {
  const aLines = splitLines(aText);
  const bLines = splitLines(bText);
  const ops = diffLines(aLines, bLines);
  if (ops.every((o) => o.type === "eq")) return "";

  const ann: AnnOp[] = [];
  let a = 1;
  let b = 1;
  for (const op of ops) {
    if (op.type === "eq") ann.push({ ...op, a: a++, b: b++ });
    else if (op.type === "del") ann.push({ ...op, a: a++, b: -1 });
    else ann.push({ ...op, a: -1, b: b++ });
  }

  const isChange = (k: number): boolean => ann[k]!.type !== "eq";
  const hunks: string[] = [];
  let k = 0;
  while (k < ann.length) {
    if (!isChange(k)) {
      k++;
      continue;
    }
    const ctxStart = Math.max(0, k - CONTEXT);
    // Extend the cluster, merging changes separated by <= CONTEXT equal lines.
    let end = k;
    while (end < ann.length) {
      if (isChange(end)) {
        end++;
        continue;
      }
      let run = end;
      while (run < ann.length && !isChange(run)) run++;
      if (run < ann.length && run - end <= CONTEXT) {
        end = run;
        continue;
      }
      break;
    }
    const ctxEnd = Math.min(ann.length, end + CONTEXT);
    const slice = ann.slice(ctxStart, ctxEnd);
    const aFirst = firstLineNo(slice, "a");
    const bFirst = firstLineNo(slice, "b");
    const aCount = slice.filter((o) => o.type !== "ins").length;
    const bCount = slice.filter((o) => o.type !== "del").length;
    const body = slice
      .map((o) => (o.type === "eq" ? " " : o.type === "del" ? "-" : "+") + o.line)
      .join("\n");
    hunks.push(`@@ -${aFirst},${aCount} +${bFirst},${bCount} @@\n${body}`);
    k = ctxEnd;
  }

  return `--- ${fromFile}\n+++ ${toFile}\n${hunks.join("\n")}\n`;
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const t = text.endsWith("\n") ? text.slice(0, -1) : text;
  return t.split("\n");
}

function diffLines(aLines: string[], bLines: string[]): Op[] {
  const n = aLines.length;
  const m = bLines.length;
  // LCS length table (suffix form).
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] =
        aLines[i] === bLines[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) {
      ops.push({ type: "eq", line: aLines[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ type: "del", line: aLines[i]! });
      i++;
    } else {
      ops.push({ type: "ins", line: bLines[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ type: "del", line: aLines[i++]! });
  while (j < m) ops.push({ type: "ins", line: bLines[j++]! });
  return ops;
}

function firstLineNo(slice: AnnOp[], which: "a" | "b"): number {
  for (const o of slice) {
    const v = which === "a" ? o.a : o.b;
    if (v > 0) return v;
  }
  return 1;
}
