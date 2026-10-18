/**
 * `odw note` and `odw notes` (an ODW extension; see ../notes): post to a
 * run's notes board from inside one of its agents, and read a board.
 *
 *   odw note <text…>              post a note as the agent this runs in: its
 *                                 ODW_RUN_ID, ODW_AGENT_ID and ODW_NOTES say
 *                                 which (the same as `"$ODW_NOTES" "<text>"`)
 *   odw note --keep [--paths G,…] <text…>
 *                                 …and keep it as workflow memory once the run
 *                                 ends (see ../memory), stale once files the
 *                                 globs match change
 *   odw notes [<run_id>] [--json] print a run's notes board (the run this runs
 *                                 in when no id is given)
 */

import { parseArgs } from "node:util";

import { checkMemoryPaths } from "../memory.js";
import { dropNote, formatNote, inboxFromEnv, readNotes, type Note } from "../notes.js";
import { sanitizeText } from "../tty.js";
import type { RunStore } from "./run-store.js";

/** Store flags as cli.ts takes them, and how it opens the store from them. */
type StoreFrom = (values: { config?: string; "runs-root"?: string }) => RunStore;

/** `odw note <text…>`: drop the note in this agent's inbox; the run's worker posts it. */
export function cmdNote(rest: string[], storeFrom: StoreFrom, env: Record<string, string | undefined> = process.env): number {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      "runs-root": { type: "string" },
      keep: { type: "boolean" },
      paths: { type: "string", multiple: true },
    },
  });
  const text = positionals.join(" ").trim();
  if (!text || (values.paths && !values.keep)) {
    process.stderr.write(
      'usage: odw note [--keep [--paths GLOB,…]] "<text>"   (inside an agent of a run with notes on; odw notes <run_id> reads them)\n',
    );
    return 2;
  }
  // A kept note becomes workflow memory when the run ends (ODW extension; see ../memory).
  let keep: { paths: string[] } | undefined;
  if (values.keep) {
    try {
      keep = { paths: checkMemoryPaths((values.paths ?? []).flatMap((p) => p.split(",")).filter((p) => p.trim())) };
    } catch (err) {
      process.stderr.write(`odw note: ${(err as Error).message}\n`);
      return 2;
    }
  }
  let inbox: string;
  try {
    inbox = inboxFromEnv(env, (runId) => {
      const store = storeFrom(values);
      return store.exists(runId) ? store.runDir(runId) : null;
    });
  } catch (err) {
    process.stderr.write(`odw note: ${(err as Error).message}\n`);
    return 1;
  }
  dropNote(inbox, text, keep);
  process.stdout.write(keep ? "note posted, and kept for later runs of the workflow once this run ends\n" : "note posted\n");
  return 0;
}

/** `odw notes [<run_id>] [--json]`: a run's notes board, as text or JSON. */
export function cmdNotes(rest: string[], storeFrom: StoreFrom, env: Record<string, string | undefined> = process.env): number {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { config: { type: "string" }, "runs-root": { type: "string" }, json: { type: "boolean" } },
  });
  const runId = positionals[0] ?? env.ODW_RUN_ID;
  if (!runId || positionals.length > 1) {
    process.stderr.write("usage: odw notes <run_id> [--json]\n");
    return 2;
  }
  const store = storeFrom(values);
  if (!store.exists(runId)) {
    process.stderr.write(`no such run: ${runId}\n`);
    return 1;
  }
  const notes = readNotes(store.runDir(runId));
  if (values.json) {
    process.stdout.write(JSON.stringify(notes, null, 2) + "\n");
    return 0;
  }
  if (notes.length === 0) {
    process.stderr.write(`run ${runId} has no notes\n`);
    return 0;
  }
  for (const note of notes) process.stdout.write(formatNote(printable(note)) + "\n");
  return 0;
}

/** A note safe to print: no escape sequences or control characters in its lines or its author. */
function printable(note: Note): Note {
  const text = note.text
    .split("\n")
    .map((line) => sanitizeText(line, 4000))
    .join("\n");
  return { ...note, text, by: { agentId: note.by.agentId, label: sanitizeText(note.by.label, 80) } };
}
