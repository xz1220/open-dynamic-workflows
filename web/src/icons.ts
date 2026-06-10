/** Inline SVG icons (strings). The wordmark logo is the product's DAG motif. */

export const logoSvg = `<svg class="logo" viewBox="0 0 116 64" fill="none" aria-hidden="true"><path d="M14 44 C44 44, 50 22, 78 22" stroke="#16C079" stroke-width="11" stroke-linecap="round"/><path d="M62 30 L58 46" stroke="#16C079" stroke-width="9" stroke-linecap="round"/><circle cx="14" cy="44" r="11" fill="#15110F"/><circle cx="92" cy="22" r="11" fill="#15110F"/><circle cx="55" cy="52" r="8" fill="#16C079"/></svg>`;

const stroke = (d: string) =>
  `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

export const icons = {
  launch: stroke(`<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>`),
  activity: stroke(`<path d="M3 12h4l2-7 4 14 2-7h6"/>`),
  workspace: stroke(`<path d="M4 6h16M4 12h16M4 18h16"/>`),
  jobs: stroke(
    `<circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="12" r="2"/><path d="M8 6h4a4 4 0 0 1 4 4M8 18h4a4 4 0 0 0 4-4"/>`,
  ),
  settings: stroke(`<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>`),
  search: stroke(`<circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/>`),
};
