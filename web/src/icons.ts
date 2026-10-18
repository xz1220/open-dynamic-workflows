/**
 * Inline SVG icons (strings) and the wordmark logo.
 *
 * The logo is the product's DAG motif — two ink nodes joined by a signal curve
 * with a fan-out branch. It inherits the theme through CSS custom properties,
 * and the branch node breathes while any run is active (`.logo.live`).
 */

export function logoSvg(live: boolean): string {
  return (
    `<svg class="logo${live ? " live" : ""}" viewBox="0 0 116 64" fill="none" aria-hidden="true">` +
    `<path class="lg-curve" d="M14 44 C44 44, 50 22, 78 22" stroke-width="11" stroke-linecap="round"/>` +
    `<path class="lg-branch" d="M62 30 L58 46" stroke-width="9" stroke-linecap="round"/>` +
    `<circle class="lg-ink" cx="14" cy="44" r="11"/><circle class="lg-ink" cx="92" cy="22" r="11"/>` +
    `<circle class="lg-sig" cx="55" cy="52" r="8"/></svg>`
  );
}

const stroke = (d: string, cls = "ic") =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

export const icons = {
  chat: stroke(`<path d="M20 14.5a3.5 3.5 0 0 1-3.5 3.5H9l-4.5 3V7.5A3.5 3.5 0 0 1 8 4h8.5A3.5 3.5 0 0 1 20 7.5z"/><path d="M8.5 9.5h7M8.5 13h4.5"/>`),
  activity: stroke(`<path d="M3 12h3.5l2.5-7 4.5 14 2.5-7H21"/>`),
  workspace: stroke(`<rect x="3.5" y="4" width="7" height="7" rx="1.5"/><rect x="13.5" y="4" width="7" height="7" rx="1.5"/><rect x="3.5" y="14" width="7" height="6" rx="1.5"/><path d="M13.5 17h7"/>`),
  jobs: stroke(`<circle cx="6" cy="6" r="2.2"/><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="12" r="2.2"/><path d="M8.2 6h3a4.5 4.5 0 0 1 4.5 4.5M8.2 18h3a4.5 4.5 0 0 0 4.5-4.5"/>`),
  settings: stroke(`<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>`),
  search: stroke(`<circle cx="11" cy="11" r="6.5"/><path d="M20.5 20.5 16 16"/>`),
  sun: stroke(`<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>`),
  moon: stroke(`<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>`),
  copy: stroke(`<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>`),
  stop: stroke(`<rect x="6" y="6" width="12" height="12" rx="2.5"/>`),
  close: stroke(`<path d="M6 6l12 12M18 6 6 18"/>`),
  arrow: stroke(`<path d="M5 12h14M13 6l6 6-6 6"/>`),
  back: stroke(`<path d="M19 12H5M11 6l-6 6 6 6"/>`),
  terminal: stroke(`<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M7 9.5l3 2.5-3 2.5M12.5 15H17"/>`),
  graph: stroke(`<circle cx="5.5" cy="12" r="2"/><circle cx="18.5" cy="6" r="2"/><circle cx="18.5" cy="18" r="2"/><path d="M7.5 12c5 0 5-6 9-6M7.5 12c5 0 5 6 9 6"/>`),
  timeline: stroke(`<path d="M4 6.5h9M8 12h11M4 17.5h7"/><path d="M4 3v18" opacity=".45"/>`),
  logs: stroke(`<path d="M8 6.5h12M8 12h12M8 17.5h8M4 6.5h.01M4 12h.01M4 17.5h.01"/>`),
  result: stroke(`<path d="M7 4.5h7l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-9.5A1.5 1.5 0 0 1 5.5 19V6A1.5 1.5 0 0 1 7 4.5z"/><path d="M13.5 4.5V9H18M9 13.5l2 2 4-4.5"/>`),
  bell: stroke(`<path d="M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 2h-15z"/><path d="M10 21h4"/>`),
  plus: stroke(`<path d="M12 5v14M5 12h14"/>`),
  zoomIn: stroke(`<circle cx="11" cy="11" r="6.5"/><path d="M20.5 20.5 16 16M8.5 11h5M11 8.5v5"/>`),
  zoomOut: stroke(`<circle cx="11" cy="11" r="6.5"/><path d="M20.5 20.5 16 16M8.5 11h5"/>`),
  fit: stroke(`<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/>`),
  follow: stroke(`<path d="M12 4v13M6.5 11.5 12 17l5.5-5.5M5 20.5h14"/>`),
  trash: stroke(`<path d="M4.5 7h15M10 11v6M14 11v6M6.5 7l1 12a1.5 1.5 0 0 0 1.5 1.4h6a1.5 1.5 0 0 0 1.5-1.4l1-12M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2"/>`),
  send: stroke(`<path d="M4.5 12 20 4.5 15 20l-3.5-6.5z"/><path d="M11.5 13.5 20 4.5"/>`),
  globe: stroke(`<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.6 2.6 14.4 0 17M12 3.5c-2.6 2.6-2.6 14.4 0 17"/>`),
  motion: stroke(`<path d="M3 12c3-6 6-6 9 0s6 6 9 0"/>`),
  evals: stroke(`<path d="M9 3.5h6M10 3.5v6.2L5.2 18a2 2 0 0 0 1.7 3h10.2a2 2 0 0 0 1.7-3L14 9.7V3.5"/><path d="M7.5 14.5h9"/>`),
  edit: stroke(`<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>`),
  compare: stroke(`<path d="M7 4v13M7 17l-3-3M7 17l3-3M17 20V7M17 7l-3 3M17 7l3 3"/>`),
  receipt: stroke(`<path d="M6 3.5h12v17l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4-2 1.4z"/><path d="M9 8.5h6M9 12h6M9 15.5h3.5"/>`),
  diff: stroke(`<rect x="4.5" y="3.5" width="15" height="17" rx="2.5"/><path d="M12 7v6M9 10h6M9 16.5h6"/>`),
  branch: stroke(`<circle cx="7" cy="5.5" r="2"/><circle cx="7" cy="18.5" r="2"/><circle cx="17" cy="7.5" r="2"/><path d="M7 7.5v9M17 9.5c0 4.5-10 2.5-10 7"/>`),
};
