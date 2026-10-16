/**
 * Command palette (⌘K / Ctrl+K / "/"): jump to any view, run or workflow, or
 * flip a preference — fuzzy-matched, keyboard-first. It owns its own overlay
 * element outside #app, so the app's live re-renders never disturb it.
 */
import { icons } from "../icons";
import { t } from "../i18n";
import { glyph } from "./glyph";
import { esc, fuzzy, markHits } from "../util";

export interface PaletteItem {
  id: string;
  group: string;
  title: string;
  hint?: string;
  icon: string;
  run: () => void;
  /** Extra text that matches but isn't shown (run ids, descriptions). */
  keywords?: string;
}

let el: HTMLElement | null = null;
let items: PaletteItem[] = [];
let shown: Array<{ item: PaletteItem; hits: number[] }> = [];
let sel = 0;
let source: () => PaletteItem[] = () => [];
let restoreFocus: Element | null = null;

export function isPaletteOpen(): boolean {
  return Boolean(el?.classList.contains("open"));
}

function ensure(): HTMLElement {
  if (el) return el;
  el = document.createElement("div");
  el.id = "palette";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.innerHTML =
    `<div class="pal">` +
    `<div class="pal-in">${icons.search}<input id="pal-q" autocomplete="off" spellcheck="false" aria-label="${esc(t("Search"))}"/><kbd>esc</kbd></div>` +
    `<div class="pal-list" role="listbox"></div>` +
    `<div class="pal-foot"><span><kbd>↑</kbd><kbd>↓</kbd>${esc(t("navigate"))}</span><span><kbd>↵</kbd>${esc(t("open"))}</span><span><kbd>esc</kbd>${esc(t("close"))}</span></div>` +
    `</div>`;
  document.body.appendChild(el);
  const input = el.querySelector<HTMLInputElement>("#pal-q")!;
  input.addEventListener("input", () => filter(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      activate(sel);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closePalette();
    }
  });
  el.addEventListener("mousedown", (e) => {
    if (e.target === el) closePalette();
  });
  el.querySelector(".pal-list")!.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-pi]");
    if (row) activate(Number(row.dataset.pi));
  });
  el.querySelector(".pal-list")!.addEventListener("mousemove", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-pi]");
    if (row && Number(row.dataset.pi) !== sel) {
      sel = Number(row.dataset.pi);
      paint(false);
    }
  });
  return el;
}

function filter(q: string): void {
  const query = q.trim();
  const scored: Array<{ item: PaletteItem; hits: number[]; score: number }> = [];
  for (const item of items) {
    const m = fuzzy(query, item.title);
    if (m) {
      scored.push({ item, hits: m.hits, score: m.score + 2 });
      continue;
    }
    if (query && item.keywords) {
      const k = fuzzy(query, item.keywords);
      if (k) scored.push({ item, hits: [], score: k.score });
    }
  }
  if (query) scored.sort((a, b) => b.score - a.score);
  shown = scored.slice(0, 60);
  sel = 0;
  paint(true);
}

function paint(scrollTop: boolean): void {
  const list = el!.querySelector<HTMLElement>(".pal-list")!;
  if (shown.length === 0) {
    list.innerHTML = `<div class="pal-empty">${esc(t("Nothing matches."))}</div>`;
    return;
  }
  let html = "";
  let group = "";
  shown.forEach(({ item, hits }, i) => {
    if (item.group !== group) {
      group = item.group;
      html += `<div class="pal-group">${esc(group)}</div>`;
    }
    html +=
      `<div class="pal-item${i === sel ? " sel" : ""}" data-pi="${i}" role="option" aria-selected="${i === sel}">` +
      `${item.icon}<span class="t">${markHits(item.title, hits)}</span>` +
      `<span class="h">${esc(item.hint ?? "")}</span></div>`;
  });
  list.innerHTML = html;
  if (scrollTop) list.scrollTop = 0;
  list.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
}

function move(d: number): void {
  if (!shown.length) return;
  sel = (sel + d + shown.length) % shown.length;
  paint(false);
}

function activate(i: number): void {
  const hit = shown[i];
  if (!hit) return;
  closePalette(false);
  hit.item.run();
}

export function setPaletteSource(fn: () => PaletteItem[]): void {
  source = fn;
}

export function openPalette(initial = ""): void {
  const root = ensure();
  restoreFocus = document.activeElement;
  items = source();
  root.classList.add("open");
  const input = root.querySelector<HTMLInputElement>("#pal-q")!;
  input.placeholder = t("Search runs, workflows and commands…");
  input.value = initial;
  filter(initial);
  input.focus();
}

export function closePalette(refocus = true): void {
  if (!el) return;
  el.classList.remove("open");
  if (refocus && restoreFocus instanceof HTMLElement) restoreFocus.focus();
}

/** Glyph helper for run rows. */
export function runIcon(state: string): string {
  return glyph(state);
}
