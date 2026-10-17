/**
 * A collapsible JSON tree built from <details> — no JS for expand/collapse, and
 * `data-preserve="open"` keeps the user's toggles across live re-renders.
 * Objects and arrays open by default down to depth 2.
 */
import { esc } from "../util";

const OPEN_DEPTH = 2;
const MAX_CHILDREN = 400;

function scalar(v: unknown): string {
  if (v === null) return `<span class="z">null</span>`;
  switch (typeof v) {
    case "string":
      return `<span class="s">"${esc(v)}"</span>`;
    case "number":
      return `<span class="n">${esc(v)}</span>`;
    case "boolean":
      return `<span class="b">${v}</span>`;
    default:
      return `<span class="z">${esc(String(v))}</span>`;
  }
}

function node(key: string | null, v: unknown, path: string, depth: number): string {
  const label = key == null ? "" : `<span class="k">${esc(key)}</span>: `;
  if (v === null || typeof v !== "object") return `<div class="row">${label}${scalar(v)}</div>`;
  const isArr = Array.isArray(v);
  const entries = isArr ? (v as unknown[]).map((x, i) => [String(i), x] as const) : Object.entries(v as object);
  const [open, close] = isArr ? ["[", "]"] : ["{", "}"];
  if (entries.length === 0) return `<div class="row">${label}${open}${close}</div>`;
  const shown = entries.slice(0, MAX_CHILDREN);
  const more =
    entries.length > shown.length ? `<div class="row meta">… ${entries.length - shown.length} more</div>` : "";
  const kids = shown.map(([k, x]) => node(isArr ? null : k, x, `${path}.${k}`, depth + 1)).join("");
  const count = `<span class="meta">${entries.length} ${isArr ? "items" : "keys"}</span>`;
  return (
    `<details data-key="j${esc(path)}" data-preserve="open"${depth < OPEN_DEPTH ? " open" : ""}>` +
    `<summary>${label}${open} ${count}</summary>` +
    `<div class="kids">${kids}${more}</div><div class="row" style="padding-left:6px">${close}</div></details>`
  );
}

/** Render any JSON value; long or multi-line strings read as prose. */
export function renderJson(value: unknown): string {
  if (typeof value === "string") return `<div class="prose">${esc(value)}</div>`;
  return `<div class="json">${node(null, value, "$", 0)}</div>`;
}
