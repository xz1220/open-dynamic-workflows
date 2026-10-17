/**
 * A tiny DOM morpher: patch the live tree to match freshly rendered HTML.
 *
 * Views stay pure `state → HTML string` functions, but instead of swapping
 * innerHTML on every emit (which restarts every CSS animation, resets scroll
 * positions and drops focus) the new markup is parsed into an inert template
 * and reconciled into the existing nodes:
 *
 *   - nodes are matched by `data-key` (or `id`) when present, otherwise by
 *     position + node type + tag name;
 *   - matched elements keep their identity: only changed attributes and text
 *     are written, so transitions run from the old value to the new one and
 *     `animation`s fire exactly once — when an element is first inserted;
 *   - a focused form field keeps its live value and caret;
 *   - `data-preserve="open other-attr"` leaves the listed attributes as the user
 *     left them (e.g. a toggled <details>), and `data-morph="skip"` freezes a
 *     subtree that its owner patches imperatively.
 */

function keyOf(n: Node): string | null {
  if (n.nodeType !== Node.ELEMENT_NODE) return null;
  const el = n as Element;
  return el.getAttribute("data-key") ?? (el.id ? `#${el.id}` : null);
}

function sameKind(a: Node, b: Node): boolean {
  if (a.nodeType !== b.nodeType) return false;
  if (a.nodeType !== Node.ELEMENT_NODE) return true;
  return (a as Element).tagName === (b as Element).tagName;
}

function syncAttributes(from: Element, to: Element): void {
  const keep = new Set((from.getAttribute("data-preserve") ?? "").split(/\s+/).filter(Boolean));
  for (const attr of Array.from(from.attributes)) {
    if (keep.has(attr.name)) continue;
    if (!to.hasAttribute(attr.name)) from.removeAttribute(attr.name);
  }
  for (const attr of Array.from(to.attributes)) {
    if (keep.has(attr.name)) continue;
    if (from.getAttribute(attr.name) !== attr.value) from.setAttribute(attr.name, attr.value);
  }
}

function syncFormValue(from: Element, to: Element): void {
  const focused = from === document.activeElement;
  if (from instanceof HTMLTextAreaElement) {
    const next = (to as HTMLTextAreaElement).value;
    if (!focused && from.value !== next) from.value = next;
  } else if (from instanceof HTMLInputElement) {
    const next = to as HTMLInputElement;
    if (!focused && from.value !== next.value) from.value = next.value;
    if (from.checked !== next.checked) from.checked = next.checked;
  } else if (from instanceof HTMLSelectElement) {
    const next = (to as HTMLSelectElement).value;
    if (!focused && from.value !== next) from.value = next;
  }
}

function patchNode(from: Node, to: Node): void {
  if (from.nodeType !== Node.ELEMENT_NODE) {
    if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
    return;
  }
  const el = from as Element;
  const next = to as Element;
  if (el.getAttribute("data-morph") === "skip" && next.getAttribute("data-morph") === "skip") {
    // The owner patches this subtree; only refresh it when its version changes.
    if (el.getAttribute("data-v") === next.getAttribute("data-v")) return;
  }
  syncAttributes(el, next);
  if (el instanceof HTMLTextAreaElement) {
    syncFormValue(el, next);
    return;
  }
  patchChildren(el, next instanceof HTMLTemplateElement ? next.content : next);
  syncFormValue(el, next);
}

function patchChildren(parent: Node, next: Node): void {
  const incomingKeys = new Set<string>();
  for (let c = next.firstChild; c; c = c.nextSibling) {
    const k = keyOf(c);
    if (k) incomingKeys.add(k);
  }
  // Remove keyed nodes that are gone before walking: otherwise one removal
  // near the top stalls the cursor and every later sibling gets moved (losing
  // focus and replaying its entry animation).
  const keyed = new Map<string, Node>();
  for (let c: Node | null = parent.firstChild; c; ) {
    const after: Node | null = c.nextSibling;
    const k = keyOf(c);
    if (k && !incomingKeys.has(k)) parent.removeChild(c);
    else if (k) keyed.set(k, c);
    c = after;
  }
  let cursor: Node | null = parent.firstChild;
  const incoming = Array.from(next.childNodes);
  for (const nk of incoming) {
    const key = keyOf(nk);
    let match: Node | null = null;
    if (key) {
      const cand = keyed.get(key);
      if (cand && sameKind(cand, nk)) {
        match = cand;
        keyed.delete(key);
      }
    } else if (cursor && !keyOf(cursor) && sameKind(cursor, nk)) {
      match = cursor;
    }
    if (match) {
      if (match === cursor) cursor = cursor.nextSibling;
      else parent.insertBefore(match, cursor);
      patchNode(match, nk);
    } else {
      parent.insertBefore(nk, cursor);
    }
  }
  while (cursor) {
    const after: Node | null = cursor.nextSibling;
    parent.removeChild(cursor);
    cursor = after;
  }
}

const parser = document.createElement("template");

/** Reconcile `target`'s children with `html`. */
export function morph(target: Element, html: string): void {
  parser.innerHTML = html;
  patchChildren(target, parser.content);
  parser.innerHTML = "";
}
