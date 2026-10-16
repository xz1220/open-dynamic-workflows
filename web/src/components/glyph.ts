/**
 * Status glyphs — one small, consistent mark per state, used everywhere a run,
 * an agent or a chat turn reports progress:
 *
 *   running  a core dot inside a rotating orbit arc
 *   pending  a dashed hollow ring
 *   paused   two bars
 *   done     an ink disc with a check
 *   failed   a vermilion disc with a cross
 *   stopped  a rounded square
 *   stale    an amber dashed ring around a dot — alive on disk, silent in time
 */
import { t } from "../i18n";
import { esc } from "../util";

const MARKS: Record<string, string> = {
  running:
    `<circle class="g-core" cx="8" cy="8" r="2.6"/>` +
    `<circle class="g-orbit" cx="8" cy="8" r="6" pathLength="1"/>`,
  pending: `<circle class="g-ring" cx="8" cy="8" r="5.6"/>`,
  paused: `<rect class="g-bar" x="4.6" y="3.8" width="2.4" height="8.4" rx="1"/><rect class="g-bar" x="9" y="3.8" width="2.4" height="8.4" rx="1"/>`,
  done: `<circle class="g-disc" cx="8" cy="8" r="6.4"/><path class="g-tick" d="M5.1 8.3l1.9 1.9 3.9-4.3" pathLength="1"/>`,
  failed: `<circle class="g-disc" cx="8" cy="8" r="6.4"/><path class="g-tick" d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4"/>`,
  stopped: `<rect class="g-disc" x="3.4" y="3.4" width="9.2" height="9.2" rx="2.4"/>`,
  stale: `<circle class="g-ring" cx="8" cy="8" r="5.6"/><circle class="g-core" cx="8" cy="8" r="1.8"/>`,
  idle: `<circle class="g-ring" cx="8" cy="8" r="5.6"/>`,
};

/** The bare glyph for `state` (unknown states render as pending). */
export function glyph(state: string): string {
  const s = MARKS[state] ? state : "pending";
  return `<svg class="gly s-${s}" viewBox="0 0 16 16" aria-hidden="true">${MARKS[s]}</svg>`;
}

/** Glyph + translated label in a pill. */
export function pill(state: string, label?: string): string {
  return `<span class="pill s-${esc(state)}">${glyph(state)}<span>${esc(label ?? t(state))}</span></span>`;
}
