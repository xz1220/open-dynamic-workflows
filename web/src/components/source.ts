/**
 * Workflow source: a small JS highlighter (comments, strings, keywords, ODW
 * primitives, numbers) with per-line wrapping for the gutter, and a static
 * outline — which phases the script declares and which primitives each one
 * calls. Display-only: nothing here evaluates the script.
 */
import { t } from "../i18n";
import { esc } from "../util";

const TOKEN =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\[\s\S]|[^`\\])*`)|\b(export|const|let|var|await|async|return|for|of|in|if|else|function|new|while|try|catch|finally|throw|import|from|default|class|break|continue|switch|case|typeof|null|undefined|true|false|this)\b|\b(agent|parallel|pipeline|phase|log|workflow|validate|budget|args|meta)\b|\b(\d[\d_]*(?:\.\d+)?)\b/g;
const CLASS = ["", "tk-c", "tk-s", "tk-k", "tk-f", "tk-n"];

/** Highlighted source, one `.ln` span per line (the gutter numbers come from CSS counters). */
export function highlightSource(src: string): string {
  const pieces: Array<[string, string]> = [];
  let last = 0;
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(src); m; m = TOKEN.exec(src)) {
    if (m.index > last) pieces.push(["", src.slice(last, m.index)]);
    const group = m.findIndex((g, i) => i > 0 && g !== undefined);
    pieces.push([CLASS[group] ?? "", m[0]]);
    last = m.index + m[0].length;
  }
  if (last < src.length) pieces.push(["", src.slice(last)]);

  const lines: string[] = [];
  let cur = "";
  for (const [cls, text] of pieces) {
    const parts = text.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) {
        lines.push(cur);
        cur = "";
      }
      if (part) cur += cls ? `<span class="${cls}">${esc(part)}</span>` : esc(part);
    });
  }
  lines.push(cur);
  return lines.map((l) => `<span class="ln">${l || " "}</span>`).join("");
}

export interface OutlineOp {
  kind: "agent" | "parallel" | "pipeline" | "workflow" | "log";
  n: number;
}
export interface OutlinePhase {
  title: string;
  ops: OutlineOp[];
}

const KINDS: OutlineOp["kind"][] = ["parallel", "pipeline", "agent", "workflow", "log"];

/** Mask comments and string contents so primitive names inside them don't count. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

/**
 * Split the script at its `phase('…')` calls and count the primitives inside
 * each segment. Declared-but-never-entered phases still show (with no ops).
 */
export function outlineSource(src: string, declared: string[]): OutlinePhase[] {
  const code = codeOnly(src);
  const marks: Array<{ title: string; at: number }> = [];
  const re = /\bphase\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;
  for (let m = re.exec(code); m; m = re.exec(code)) marks.push({ title: m[2]!, at: m.index });
  const count = (seg: string): OutlineOp[] =>
    KINDS.map((kind) => ({ kind, n: (seg.match(new RegExp(`\\b${kind}\\(`, "g")) ?? []).length })).filter(
      (o) => o.n > 0,
    );
  const out: OutlinePhase[] = [];
  const pre = code.slice(0, marks[0]?.at ?? code.length).replace(/export\s+const\s+meta\s*=\s*\{[\s\S]*?\n\}/, "");
  const preOps = count(pre);
  if (preOps.length && marks.length) out.push({ title: t("Setup"), ops: preOps });
  marks.forEach((mk, i) => {
    const seg = code.slice(mk.at + 6, marks[i + 1]?.at ?? code.length);
    const existing = out.find((p) => p.title === mk.title);
    if (existing) {
      for (const op of count(seg)) {
        const same = existing.ops.find((o) => o.kind === op.kind);
        if (same) same.n += op.n;
        else existing.ops.push(op);
      }
    } else out.push({ title: mk.title, ops: count(seg) });
  });
  if (!marks.length) {
    const ops = count(pre);
    if (declared.length) return declared.map((title, i) => ({ title, ops: i === 0 ? ops : [] }));
    return ops.length ? [{ title: t("Script"), ops }] : [];
  }
  for (const d of declared) if (!out.some((p) => p.title === d)) out.push({ title: d, ops: [] });
  return out;
}
