/**
 * An agent's transcript — what its CLI printed, normalized by the server into
 * entries — drawn as a log you can read top to bottom: the agent's words as
 * prose, each tool call as a chip with its input folded away, each result
 * with a ✓ or ✗ and its output folded away, retries as separators.
 *
 * Entries render one by one and in order, so a live transcript appends
 * (main.ts adds the new ones to a frozen host) instead of repainting.
 */
import { t } from "../i18n";
import { esc as plain, fmtUsd, markRedactions } from "../util";

/** Escape, and draw redaction markers as ink bars. */
const esc = (v: unknown): string => markRedactions(plain(v));

import type { TranscriptEntry } from "../types";

const REASON: Record<string, string> = {
  schema: "schema retry",
  stall: "stall restart",
  rate_limit: "rate-limit retry",
  expect: "expectation retry",
  fallback: "fallback",
};

function inputText(input: unknown): string {
  if (input === undefined || input === null) return "";
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function folded(label: string, body: string, open = false): string {
  return `<details class="tx-fold"${open ? " open" : ""}><summary>${esc(label)}</summary><pre>${esc(body)}</pre></details>`;
}

/** One entry's HTML. */
export function transcriptEntry(e: TranscriptEntry): string {
  const clipped =
    (e.clipped ? `<span class="tx-clip">${t("clipped")}</span>` : "") +
    (e.redacted ? `<span class="tx-clip" title="${t("secrets in it were replaced before it was saved")}">${t("redacted")}</span>` : "");
  switch (e.kind) {
    case "text":
      return e.thinking
        ? `<div class="tx tx-think" data-i="${e.i}"><span class="tx-k">${t("thinking")}</span><div class="tx-prose">${esc(e.text ?? "")}</div>${clipped}</div>`
        : `<div class="tx tx-text" data-i="${e.i}"><div class="tx-prose">${esc(e.text ?? "")}</div>${clipped}</div>`;
    case "tool_call": {
      const input = inputText(e.input);
      return (
        `<div class="tx tx-call" data-i="${e.i}"><div class="tx-line"><span class="tx-tool">▸ ${esc(e.tool ?? t("tool"))}</span>` +
        `<code class="tx-what">${esc(e.text ?? "")}</code>${clipped}</div>` +
        (input && input !== e.text ? folded(t("input"), input) : "") +
        `</div>`
      );
    }
    case "tool_result":
      return (
        `<div class="tx tx-res${e.isError ? " err" : ""}" data-i="${e.i}"><div class="tx-line"><span class="tx-mark">${e.isError ? "✗" : "✓"}</span>` +
        `<span class="tx-tool">${esc(e.tool ?? t("result"))}</span><span class="tx-what">${esc(e.text ?? "")}</span>${clipped}</div>` +
        (e.output ? folded(t("output"), e.output, Boolean(e.isError)) : "") +
        `</div>`
      );
    case "attempt":
      return (
        `<div class="tx tx-sep${e.reason === "fallback" ? " fallback" : ""}" data-i="${e.i}"><span>${esc(t("attempt {n}", { n: e.n ?? 2 }))}` +
        `${e.reason ? ` · ${esc(t(REASON[e.reason] ?? e.reason))}` : ""}${e.reason === "fallback" && e.adapter ? ` → ${esc(e.adapter)}` : ""}</span></div>`
      );
    case "result": {
      const bits = [e.isError ? t("ended with an error") : t("done")];
      if (e.turns != null) bits.push(t("{n} turns", { n: e.turns }));
      if (e.costUsd != null) bits.push(fmtUsd(e.costUsd));
      return (
        `<div class="tx tx-result${e.isError ? " err" : ""}" data-i="${e.i}"><span class="tx-mark">■</span><span>${esc(bits.join(" · "))}</span></div>` +
        (e.isError && e.text ? `<div class="tx tx-error" data-i="${e.i}-x">${esc(e.text)}</div>` : "")
      );
    }
    case "error":
      return `<div class="tx tx-error" data-i="${e.i}">${e.tool ? `<b>${esc(e.tool)}</b> ` : ""}${esc(e.text ?? "")}</div>`;
    case "truncated":
      return `<div class="tx tx-note" data-i="${e.i}">${esc(t("The transcript reached maxTranscriptBytes; later output was not kept."))}</div>`;
    default:
      return `<div class="tx tx-raw" data-i="${e.i}">${esc(e.text ?? "")}</div>`;
  }
}

/** Entries' HTML, in order. */
export function transcriptEntries(entries: TranscriptEntry[]): string {
  return entries.map(transcriptEntry).join("");
}
