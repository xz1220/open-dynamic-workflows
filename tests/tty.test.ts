import assert from "node:assert/strict";
import { test } from "node:test";

import {
  detectCaps,
  displayWidth,
  fmtDuration,
  fmtElapsed,
  palette,
  sanitizeText,
  truncateToWidth,
} from "../src/tty.js";

// --- capability detection ------------------------------------------------------

test("NO_COLOR, TERM=dumb, and non-TTY streams all disable color", () => {
  const tty = { isTTY: true };
  assert.equal(detectCaps(tty, { TERM: "xterm", NO_COLOR: "1" }).color, false);
  assert.equal(detectCaps(tty, { TERM: "dumb" }).color, false);
  assert.equal(detectCaps({ isTTY: false }, { TERM: "xterm" }).color, false);
  assert.equal(detectCaps(tty, { TERM: "xterm-256color" }).color, true);
});

test("Windows consoles get color without TERM; elsewhere a missing TERM still means none", () => {
  const tty = { isTTY: true };
  assert.equal(detectCaps(tty, {}, "win32").color, true);
  assert.equal(detectCaps(tty, {}, "linux").color, false);
  assert.equal(detectCaps(tty, {}, "darwin").color, false);
  // ...but an explicit dumb terminal, NO_COLOR, or a pipe still disables it there.
  assert.equal(detectCaps(tty, { TERM: "dumb" }, "win32").color, false);
  assert.equal(detectCaps(tty, { NO_COLOR: "1" }, "win32").color, false);
  assert.equal(detectCaps({ isTTY: false }, {}, "win32").color, false);
});

test("FORCE_COLOR forces color on, even piped or TERM=dumb; 0/false force it off", () => {
  const pipe = { isTTY: false };
  const tty = { isTTY: true };
  for (const value of ["", "1", "2", "3", "true"]) {
    assert.equal(detectCaps(pipe, { FORCE_COLOR: value }, "linux").color, true, `FORCE_COLOR=${value}`);
  }
  assert.equal(detectCaps(tty, { TERM: "dumb", FORCE_COLOR: "1" }, "linux").color, true);
  for (const value of ["0", "false", "FALSE"]) {
    const caps = detectCaps(tty, { TERM: "xterm-256color", COLORTERM: "truecolor", FORCE_COLOR: value }, "linux");
    assert.deepEqual([caps.color, caps.truecolor], [false, false], `FORCE_COLOR=${value}`);
  }
  // As in Node itself, an explicit FORCE_COLOR outranks NO_COLOR.
  assert.equal(detectCaps(tty, { TERM: "xterm", NO_COLOR: "1", FORCE_COLOR: "1" }, "linux").color, true);
  // FORCE_COLOR=3 asks for 24-bit; lower levels keep the 16-color set.
  assert.equal(detectCaps(pipe, { FORCE_COLOR: "3" }, "linux").truecolor, true);
  assert.equal(detectCaps(pipe, { FORCE_COLOR: "1" }, "linux").truecolor, false);
  assert.match(palette(detectCaps(pipe, { FORCE_COLOR: "1" }, "linux")).ok("x"), /\x1b\[32m/);
});

test("an empty NO_COLOR does not disable color (no-color.org: present and non-empty)", () => {
  assert.equal(detectCaps({ isTTY: true }, { TERM: "xterm", NO_COLOR: "" }, "linux").color, true);
});

test("truecolor needs COLORTERM; the palette upgrades to 24-bit codes", () => {
  const caps = detectCaps({ isTTY: true }, { TERM: "xterm", COLORTERM: "truecolor" });
  assert.equal(caps.truecolor, true);
  const p = palette(caps);
  assert.match(p.ok("x"), /\x1b\[38;2;46;232;142m/); // the dashboard's signal green (night ink)
  const basic = palette(detectCaps({ isTTY: true }, { TERM: "xterm" }));
  assert.match(basic.ok("x"), /\x1b\[32m/);
});

test("with color off the palette is a passthrough (no escapes at all)", () => {
  const p = palette(detectCaps({ isTTY: false }, {}));
  assert.equal(p.err(p.bold("plain")), "plain");
});

// --- sanitization ----------------------------------------------------------------

test("sanitizeText strips CSI/OSC/raw controls and flattens newlines", () => {
  assert.equal(sanitizeText("a\x1b[31mred\x1b[0mb"), "aredb");
  assert.equal(sanitizeText("t\x1b]0;pwned\x07itle"), "title");
  assert.equal(sanitizeText("multi\nline\r\ttext"), "multi line text");
  assert.equal(sanitizeText("nul\x00bel\x07"), "nulbel");
  assert.equal(sanitizeText(undefined), "");
});

test("sanitizeText clamps long input with an ellipsis", () => {
  const out = sanitizeText("x".repeat(600), 100);
  assert.equal(displayWidth(out) <= 100, true);
  assert.equal(out.endsWith("…"), true);
});

// --- width math -------------------------------------------------------------------

test("displayWidth counts CJK and wide symbols as two columns", () => {
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("中文"), 4);
  assert.equal(displayWidth("a中b"), 4);
  assert.equal(displayWidth("⌚"), 2); // U+231A — outside the CJK blocks
  assert.equal(displayWidth("✅"), 2); // U+2705
});

test("truncateToWidth never exceeds the budget and marks the cut", () => {
  assert.equal(truncateToWidth("hello", 10), "hello");
  assert.equal(truncateToWidth("hello world", 8), "hello w…");
  const cjk = truncateToWidth("中文标签很长", 7);
  assert.equal(displayWidth(cjk) <= 7, true);
  assert.equal(cjk.endsWith("…"), true);
  assert.equal(truncateToWidth("anything", 0), "");
});

test("displayWidth and truncateToWidth are ANSI-transparent", () => {
  const styled = "\x1b[38;2;16;185;129mgreen\x1b[0m and \x1b[1mbold\x1b[0m";
  assert.equal(displayWidth(styled), "green and bold".length);
  // fits by visible width → returned untouched, codes intact
  assert.equal(truncateToWidth(styled, 20), styled);
  // cut by visible width → escapes preserved, reset appended, no wrap
  const cut = truncateToWidth(styled, 8);
  assert.equal(displayWidth(cut) <= 8, true);
  assert.match(cut, /\x1b\[38;2;16;185;129m/);
  assert.equal(cut.endsWith("\x1b[0m"), true);
});

// --- durations --------------------------------------------------------------------

test("elapsed/duration formatting is stable and clamps clock skew", () => {
  assert.equal(fmtElapsed(-5000), "0:00");
  assert.equal(fmtElapsed(65_000), "1:05");
  assert.equal(fmtElapsed(3_723_000), "1:02:03");
  assert.equal(fmtDuration(3_210), "3.2s");
  assert.equal(fmtDuration(75_000), "1:15");
});
