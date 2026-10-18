/**
 * `odw memory` (an ODW extension; see ../memory): read and tend a
 * repository's workflow memory, `.odw/memory/<workflow>.jsonl`.
 *
 *   odw memory list [<wf>] [--stale] [--json]
 *       every entry (of one workflow, or of all), each marked stale when a
 *       file its paths match changed since its commit; --stale: only those
 *   odw memory add <wf> "<text>" [--paths GLOB,…] [--kind note|correction|lesson]
 *       keep an entry by hand (kind "note" by default), at HEAD, redacted
 *   odw memory prune [<wf>] --stale | <wf> --id N
 *       drop the stale entries (of one workflow, or of all), or one by its id
 *
 * `--source DIR` picks the repository (default: the current directory);
 * `--config` the config whose `memoryDir` and `redact` apply.
 */

import { parseArgs } from "node:util";

import { loadConfig } from "../adapters/config.js";
import {
  MEMORY_KINDS,
  addMemory,
  checkMemoryPaths,
  formatEntry,
  headCommitOf,
  listMemory,
  memoryDirFor,
  memoryFile,
  memoryWorkflows,
  readMemory,
  staleEntries,
  writeMemory,
  type MemoryEntry,
  type MemoryKind,
} from "../memory.js";
import { redactorFor } from "../redact.js";
import { sanitizeText } from "../tty.js";
import { repositoryRoot } from "../untrusted.js";

const USAGE = [
  "usage: odw memory list [<wf>] [--stale] [--json]",
  '       odw memory add <wf> "<text>" [--paths GLOB,…] [--kind note|correction|lesson]',
  "       odw memory prune [<wf>] --stale | odw memory prune <wf> --id N",
  "       (--source DIR: the repository, default .; --config FILE)",
].join("\n");

/** `odw memory list|add|prune …`. Exit 0 on success, 1 when something failed, 2 on a usage error. */
export function cmdMemory(rest: string[], cwd: string = process.cwd()): number {
  const [sub, ...args] = rest;
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      source: { type: "string" },
      json: { type: "boolean" },
      stale: { type: "boolean" },
      id: { type: "string" },
      paths: { type: "string", multiple: true },
      kind: { type: "string" },
    },
  });
  const config = loadConfig(values.config ?? null);
  const source = values.source ?? cwd;
  const dir = memoryDirFor(source, config.settings.memoryDir);
  const root = repositoryRoot(source);
  const usage = (): number => {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  };
  const named = (workflow: string): string | null => {
    try {
      return memoryFile(dir, workflow);
    } catch (err) {
      process.stderr.write(`odw memory: ${(err as Error).message}\n`);
      return null;
    }
  };

  // A file too big (or not a regular file) is said, not read.
  const readable = (file: string): MemoryEntry[] | null => {
    try {
      return readMemory(file);
    } catch (err) {
      process.stderr.write(`odw memory ${sub}: ${sanitizeText((err as Error).message, 400)}\n`);
      return null;
    }
  };

  if (sub === "list") {
    if (positionals.length > 1 || values.id !== undefined || values.paths || values.kind) return usage();
    if (positionals[0] !== undefined && !named(positionals[0])) return 2;
    const listed = listMemory(source, config.settings.memoryDir, positionals[0]).map((wf) => ({
      ...wf,
      entries: wf.entries.filter((entry) => !values.stale || entry.stale),
    }));
    if (values.json) {
      process.stdout.write(JSON.stringify(listed, null, 2) + "\n");
      return 0;
    }
    // A file that was not read (too big, not a regular file) is said, and fails the list.
    const unread = listed.filter((wf) => wf.error);
    for (const wf of unread) process.stderr.write(`odw memory list: ${sanitizeText(wf.error, 400)}\n`);
    if (listed.every((wf) => wf.entries.length === 0)) {
      if (unread.length === 0) process.stderr.write(values.stale ? "no stale memory entries\n" : `no workflow memory in ${dir}\n`);
      return unread.length ? 1 : 0;
    }
    for (const wf of listed) {
      if (wf.entries.length === 0) continue;
      const stale = wf.entries.filter((entry) => entry.stale).length;
      process.stdout.write(`${sanitizeText(wf.workflow, 200)} — ${wf.entries.length} entr${wf.entries.length === 1 ? "y" : "ies"}${stale ? `, ${stale} stale` : ""} (${wf.file})\n`);
      for (const entry of wf.entries) process.stdout.write(entryLines(entry) + "\n");
    }
    return unread.length ? 1 : 0;
  }

  if (sub === "add") {
    if (positionals.length < 2 || values.stale || values.id !== undefined) return usage();
    const [workflow, ...words] = positionals as [string, ...string[]];
    const text = words.join(" ").trim();
    if (!text) return usage();
    const kind = (values.kind ?? "note") as MemoryKind;
    if (!(MEMORY_KINDS as readonly string[]).includes(kind)) {
      process.stderr.write(`odw memory add: --kind must be one of ${MEMORY_KINDS.join(", ")}; got "${values.kind}"\n`);
      return 2;
    }
    let paths: string[];
    try {
      paths = checkMemoryPaths((values.paths ?? []).flatMap((p) => p.split(",")).filter((p) => p.trim()));
    } catch (err) {
      process.stderr.write(`odw memory add: ${(err as Error).message}\n`);
      return 2;
    }
    const file = named(workflow);
    if (!file) return 2;
    const commit = headCommitOf(source);
    if (paths.length > 0 && !commit) {
      process.stderr.write("odw memory add: --paths needs a git repository with a commit: an entry is stale once those files change since it\n");
      return 1;
    }
    let done: ReturnType<typeof addMemory>;
    try {
      done = addMemory(file, [{ kind, text, paths }], { run: null, commit, redactor: redactorFor(config) });
    } catch (err) {
      process.stderr.write(`odw memory add: ${sanitizeText((err as Error).message, 400)}\n`);
      return 1;
    }
    const { added, pruned } = done;
    const entry = added[0];
    if (!entry) return usage();
    process.stdout.write(`kept #${entry.id} in ${file}${pruned ? ` (pruned the ${pruned} oldest)` : ""}\n`);
    return 0;
  }

  if (sub === "prune") {
    if (positionals.length > 1 || values.paths || values.kind || values.json) return usage();
    if (values.stale === (values.id !== undefined)) return usage(); // exactly one of them
    if (values.id !== undefined) {
      const workflow = positionals[0];
      const id = Number(values.id);
      if (workflow === undefined || !/^\d+$/.test(values.id) || !Number.isSafeInteger(id)) return usage();
      const file = named(workflow);
      if (!file) return 2;
      const entries = readable(file);
      if (!entries) return 1;
      const left = entries.filter((entry) => entry.id !== id);
      if (left.length === entries.length) {
        process.stderr.write(`odw memory prune: ${sanitizeText(workflow, 200)} has no entry #${id}\n`);
        return 1;
      }
      writeMemory(file, left);
      process.stdout.write(`pruned #${id} from ${file}\n`);
      return 0;
    }
    const workflows = positionals[0] !== undefined ? [positionals[0]] : memoryWorkflows(dir);
    let total = 0;
    for (const workflow of workflows) {
      const file = named(workflow);
      if (!file) return 2;
      const entries = readable(file);
      if (!entries) return 1;
      const stale = staleEntries(root, entries);
      if (stale.size === 0) continue;
      writeMemory(file, entries.filter((entry) => !stale.has(entry.id)));
      process.stdout.write(`pruned ${stale.size} stale entr${stale.size === 1 ? "y" : "ies"} from ${file}\n`);
      total += stale.size;
    }
    if (total === 0) process.stderr.write("no stale memory entries\n");
    return 0;
  }

  return usage();
}

/** An entry for the terminal: its id, the entry, then where it came from — nothing it says (text, paths, time, commit) can move the cursor. */
function entryLines(entry: MemoryEntry & { stale: boolean }): string {
  const text = formatEntry({
    ...entry,
    text: entry.text.split("\n").map((line) => sanitizeText(line, 4000)).join("\n"),
    paths: entry.paths.map((path) => sanitizeText(path, 200)),
    at: sanitizeText(entry.at, 40),
  });
  const from = [
    entry.commit ? `at ${sanitizeText(entry.commit, 64).slice(0, 12)}` : "outside git",
    entry.run ? `run ${sanitizeText(entry.run, 80)}` : "added by hand",
    ...(entry.agent ? [`agent ${sanitizeText(entry.agent, 80)}`] : []),
  ].join(", ");
  return `  #${entry.id}${entry.stale ? " STALE" : ""} ${text.replace(/^- /, "")}\n      ${from}`;
}
