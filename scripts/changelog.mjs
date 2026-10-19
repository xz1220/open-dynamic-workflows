#!/usr/bin/env node
// CHANGELOG.md sections, for the release workflow and CI.
//
//   node scripts/changelog.mjs check [--file CHANGELOG.md]
//     exits 1 unless the changelog has a `## Unreleased` section (CI).
//   node scripts/changelog.mjs notes <tag> [--file CHANGELOG.md] [--out notes.md]
//     prints (or writes) the body of the section named like the tag — `v0.9.0`
//     finds `## 0.9.0 — 2026-10-20` — and exits 1 when there is none or it is
//     empty (the release workflow: a release without its notes is not published).
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * The `## ` section whose heading's first word is `name` (a leading `v` on
 * either side is ignored), as line offsets: `{ heading, start, end, body }` —
 * `start` is the heading's line, `end` the next `## ` heading's (or the end).
 * Fenced code blocks are skipped, so a `## ` inside an example is not a heading.
 */
export function findSection(text, name) {
  const want = String(name).replace(/^v(?=\d)/, "");
  const lines = text.split("\n");
  let fenced = false;
  let found = null;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fenced = !fenced;
    if (fenced || !/^## /.test(lines[i])) continue;
    if (found) return { ...found, end: i, body: lines.slice(found.start + 1, i).join("\n").trim() };
    const word = lines[i].slice(3).trim().split(/\s+/)[0].replace(/^v(?=\d)/, "");
    if (word === want) found = { heading: lines[i], start: i };
  }
  return found ? { ...found, end: lines.length, body: lines.slice(found.start + 1).join("\n").trim() } : null;
}

/** The changelog has a `## Unreleased` section for the next release's entries. */
export function hasUnreleased(text) {
  return findSection(text, "Unreleased") !== null;
}

/** The release notes for `tag`: its section's body. Throws when missing or empty. */
export function releaseNotes(text, tag) {
  const section = findSection(text, tag);
  if (!section) throw new Error(`CHANGELOG.md has no section for ${tag} (expected a heading like "## ${String(tag).replace(/^v/, "")} — YYYY-MM-DD")`);
  if (!section.body) throw new Error(`CHANGELOG.md's section for ${tag} is empty`);
  return `${section.body}\n`;
}

function main(argv) {
  const [command, ...rest] = argv;
  let file = "CHANGELOG.md";
  let out = null;
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--file") file = rest[++i];
    else if (rest[i] === "--out") out = rest[++i];
    else positional.push(rest[i]);
  }
  const text = readFileSync(file, "utf8");
  if (command === "check" && positional.length === 0) {
    if (!hasUnreleased(text)) throw new Error(`${file} has no "## Unreleased" section: add one at the top for changes not yet released`);
    console.log(`${file}: "## Unreleased" section present`);
    return;
  }
  if (command === "notes" && positional.length === 1) {
    const notes = releaseNotes(text, positional[0]);
    if (out) writeFileSync(out, notes);
    else process.stdout.write(notes);
    return;
  }
  throw new Error("usage: changelog.mjs check [--file F] | notes <tag> [--file F] [--out F]");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try { main(process.argv.slice(2)); } catch (err) {
    console.error(`changelog: ${err.message}`);
    process.exit(1);
  }
}
