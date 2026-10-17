/**
 * Terminal primitives for the live run view — zero-dependency ANSI, by design.
 *
 * Three concerns live here, all pure (no process/global reads inside the hot
 * paths — capabilities are detected once and passed in):
 *
 *   - capabilities  what this terminal supports (color depth, unicode)
 *   - styling       a palette bound to those capabilities; plain passthrough
 *                   when color is off, so callers never branch
 *   - text safety   sanitizing event-derived text (labels, log messages,
 *                   errors come from workflow scripts and adapter output —
 *                   untrusted as far as the terminal is concerned: a stray
 *                   ESC/OSC/CR could redraw our UI, retitle the window, or
 *                   worse) and display-width math (CJK-aware) so the repaint
 *                   cursor arithmetic stays exact
 *
 * The color values mirror the web client's design tokens (web/src/theme.css):
 * emerald for the brand/success, amber for "running", red for failure — the
 * dashboard and the terminal read as one product.
 */

export interface TermCaps {
  /** ANSI styling at all (false: emit plain text only). */
  color: boolean;
  /** 24-bit color (COLORTERM=truecolor|24bit); otherwise the 16-color set. */
  truecolor: boolean;
  /** Unicode glyphs (spinner, check marks). ASCII fallbacks otherwise. */
  unicode: boolean;
}

const ESC = "\x1b";

/**
 * Detect capabilities for a stream. Pure given its inputs; call once.
 *
 * Color, in precedence order:
 *   1. FORCE_COLOR decides when set: `0`/`false` force it off; any other value
 *      (including empty) forces it on — even for a pipe or TERM=dumb. As in
 *      Node itself, it outranks NO_COLOR; `FORCE_COLOR=3` also means 24-bit.
 *   2. A non-empty NO_COLOR turns it off (https://no-color.org).
 *   3. Otherwise only a TTY whose terminal is not `dumb` gets color. A missing
 *      TERM means no color, except on Windows, whose consoles (conhost, Windows
 *      Terminal) render ANSI but do not set TERM — the same rule as init's
 *      prompt gate.
 */
export function detectCaps(
  stream: { isTTY?: boolean },
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): TermCaps {
  const forced = env.FORCE_COLOR;
  const termOk = env.TERM === undefined ? platform === "win32" : env.TERM !== "dumb";
  const color =
    forced !== undefined
      ? forced !== "0" && forced.toLowerCase() !== "false"
      : !env.NO_COLOR && stream.isTTY === true && termOk;
  const truecolor =
    color && (/^(truecolor|24bit)$/i.test(env.COLORTERM ?? "") || forced === "3");
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  // macOS terminals are UTF-8 even when the locale vars are unset.
  const unicode = /utf-?8/i.test(locale) || (locale === "" && platform === "darwin");
  return { color, truecolor, unicode };
}

// --- styling ------------------------------------------------------------------

const RESET = `${ESC}[0m`;

/** One style: 16-color SGR fallback + optional truecolor upgrade. */
function style(caps: TermCaps, basic: string, rgb?: [number, number, number]) {
  if (!caps.color) return (s: string) => s;
  const open =
    caps.truecolor && rgb ? `${ESC}[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m` : `${ESC}[${basic}m`;
  return (s: string) => `${open}${s}${RESET}`;
}

export interface Palette {
  /** Brand accent (workflow name, final check) — emerald. */
  accent(s: string): string;
  /** Success — emerald. */
  ok(s: string): string;
  /** In flight — amber. */
  run(s: string): string;
  /** Failure — red. */
  err(s: string): string;
  /** Secondary text (ids, adapters, timings). */
  dim(s: string): string;
  bold(s: string): string;
}

/** Build the palette for a capability set (plain passthrough when color off). */
export function palette(caps: TermCaps): Palette {
  return {
    // The dashboard's inks (web/src/styles/tokens.css), tuned for dark terminals.
    accent: style(caps, "32", [46, 232, 142]), // --sig (night):#2ee88e
    ok: style(caps, "32", [46, 232, 142]),
    run: style(caps, "33", [255, 178, 36]), // --amber (night):#ffb224
    err: style(caps, "31", [255, 91, 57]), // --alarm (night):#ff5b39
    dim: style(caps, "90", [139, 142, 132]), // --mute (night):#8b8e84
    bold: caps.color ? (s: string) => `${ESC}[1m${s}${RESET}` : (s: string) => s,
  };
}

export interface Glyphs {
  spinner: string[];
  ok: string;
  fail: string;
  stop: string;
  /** A checkpoint() waiting for a person. */
  wait: string;
  bullet: string;
  header: string;
  rule: string;
}

export function glyphs(caps: TermCaps): Glyphs {
  return caps.unicode
    ? {
        spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"],
        ok: "✔",
        fail: "✖",
        stop: "■",
        wait: "◇",
        bullet: "·",
        header: "◆",
        rule: "─",
      }
    : {
        spinner: ["-", "\\", "|", "/"],
        ok: "ok",
        fail: "x",
        stop: "#",
        wait: "?",
        bullet: "-",
        header: "*",
        rule: "-",
      };
}

// --- cursor / screen control ---------------------------------------------------

export const cursor = {
  hide: `${ESC}[?25l`,
  show: `${ESC}[?25h`,
  up(n: number): string {
    return n > 0 ? `${ESC}[${n}A` : "";
  },
  /** To column 1. */
  toCol1: "\r",
  /** Erase from cursor to end of screen. */
  eraseDown: `${ESC}[0J`,
};

// --- text safety ----------------------------------------------------------------

// ESC-introduced sequences (CSI, OSC with BEL or ST terminator, and any other
// ESC+final) must be stripped BEFORE the raw-control sweep, or the sweep would
// eat the ESC and leave the sequence payload behind as visible garbage.
const ANSI_SEQ = new RegExp(
  `${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^\\x07\\x1b]*(?:\\x07|${ESC}\\\\)|${ESC}[@-_]`,
  "g",
);
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/**
 * Make event-derived text safe to print: no escape sequences, no control
 * characters, newlines/tabs flattened to spaces, length clamped. Everything the
 * live view prints that originated in a workflow script or adapter output must
 * pass through here exactly once.
 */
export function sanitizeText(raw: unknown, maxLen = 500): string {
  const s = String(raw ?? "");
  const flat = s
    .replace(ANSI_SEQ, "")
    .replace(/[\r\n\t\v\f]+/g, " ")
    .replace(CONTROLS, "")
    .trim();
  return displayWidth(flat) > maxLen ? `${truncateToWidth(flat, maxLen)}` : flat;
}

// Display-width: ranges that render two columns wide (CJK & friends). An
// approximation (no dependency): covers the scripts a workflow label or log
// line realistically contains.
const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x231a, 0x231b], // watch, hourglass
  [0x2329, 0x232a], // angle brackets
  [0x23e9, 0x23ec], // media-control arrows
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], // small squares
  [0x2614, 0x2615], // umbrella, hot beverage
  [0x2648, 0x2653], // zodiac
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e], // CJK radicals, Kangxi, CJK punctuation
  [0x3041, 0x33ff], // Hiragana, Katakana, CJK compat
  [0x3400, 0x4dbf], // CJK ext A
  [0x4e00, 0x9fff], // CJK unified
  [0xa000, 0xa4cf], // Yi
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compat ideographs
  [0xfe30, 0xfe4f], // CJK compat forms
  [0xff00, 0xff60], // Fullwidth forms
  [0xffe0, 0xffe6],
  [0x1f004, 0x1f004], // mahjong red dragon
  [0x1f0cf, 0x1f0cf], // joker
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f2ff], // enclosed ideographic supplement
  [0x1f300, 0x1faff], // emoji blocks rendered double-width
  [0x20000, 0x2fffd], // CJK ext B+
  [0x30000, 0x3fffd],
];

function charWidth(cp: number): number {
  if (cp === 0) return 0;
  for (const [lo, hi] of WIDE) if (cp >= lo && cp <= hi) return 2;
  return 1;
}

/**
 * Length of the escape sequence starting at `i` (where `s[i]` is ESC). Used by
 * the width walkers so STYLED strings measure and truncate by their *visible*
 * columns — an SGR-heavy footer must not read as "too wide" and get cut.
 */
function escLen(s: string, i: number): number {
  const n = s[i + 1];
  if (n === "[") {
    let j = i + 2;
    while (j < s.length && !/[@-~]/.test(s[j]!)) j++;
    return Math.min(j + 1, s.length) - i;
  }
  if (n === "]") {
    let j = i + 2;
    while (j < s.length && s[j] !== "\x07" && !(s[j] === ESC && s[j + 1] === "\\")) j++;
    if (j >= s.length) return s.length - i;
    return (s[j] === "\x07" ? j + 1 : j + 2) - i;
  }
  return Math.min(2, s.length - i);
}

/** Terminal display width of a string; ANSI escape sequences count as zero. */
export function displayWidth(s: string): number {
  let w = 0;
  let i = 0;
  while (i < s.length) {
    if (s[i] === ESC) {
      i += escLen(s, i);
      continue;
    }
    const cp = s.codePointAt(i)!;
    w += charWidth(cp);
    i += String.fromCodePoint(cp).length;
  }
  return w;
}

/**
 * Hard-truncate to a display width, appending an ellipsis when cut. Escape
 * sequences pass through for free (and a reset is appended on a cut so styling
 * never bleeds past the line). Guarantees the result never wraps, which is what
 * keeps the repaint's cursor-up arithmetic exact — one logical line is one
 * physical line, always.
 */
export function truncateToWidth(s: string, max: number): string {
  if (max <= 0) return "";
  if (displayWidth(s) <= max) return s;
  let w = 0;
  let i = 0;
  let out = "";
  let sawEsc = false;
  while (i < s.length) {
    if (s[i] === ESC) {
      const len = escLen(s, i);
      out += s.slice(i, i + len);
      sawEsc = true;
      i += len;
      continue;
    }
    const cp = s.codePointAt(i)!;
    const cw = charWidth(cp);
    if (w + cw > max - 1) break;
    out += String.fromCodePoint(cp);
    w += cw;
    i += String.fromCodePoint(cp).length;
  }
  return `${out}…${sawEsc ? RESET : ""}`;
}

/** Pad with spaces to a display width (no-op if already wider). */
export function padEndWidth(s: string, w: number): string {
  const d = w - displayWidth(s);
  return d > 0 ? s + " ".repeat(d) : s;
}

/** mm:ss (or h:mm:ss past the hour), clamped at zero against clock skew. */
export function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

/** Seconds with one decimal for sub-minute agent timings ("3.2s", then "1:04"). */
export function fmtDuration(ms: number): string {
  const clamped = Math.max(0, ms);
  return clamped < 60_000 ? `${(clamped / 1000).toFixed(1)}s` : fmtElapsed(clamped);
}
