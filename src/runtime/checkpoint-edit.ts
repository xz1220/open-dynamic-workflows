/**
 * Approving a checkpoint() with an edited payload from a terminal (L6, an ODW
 * extension): `odw approve <run> --payload JSON|@file`, or `--edit`, which
 * opens `$VISUAL` / `$EDITOR` (else `vi`; `notepad` on Windows) on the
 * waiting checkpoint's payload, the way git opens one on a commit message.
 *
 * The payload goes pretty-printed into a private temp file — a fresh
 * directory only its owner can enter, the file readable by its owner only —
 * and the editor runs on it. Then:
 *
 *   - the same JSON (whitespace aside): approve as is, no edit sent;
 *   - an empty file: abort without answering, as git does for an empty
 *     commit message;
 *   - not JSON, or an edit the checkpoint does not take (over 256 KiB, off
 *     its schema): abort with the error, and keep the file — the caller says
 *     where — so the edit is not lost.
 *
 * The file is removed in every other case (an edit, once it is sent).
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CheckedEdit } from "../checkpoint.js";
import { hasMarker } from "../redact.js";
import { deepEqual } from "../schema.js";

/** What `--payload` gave: inline JSON, or `@file.json`. */
export function readPayloadOption(raw: string): { value: unknown } | { error: string } {
  let text = raw;
  if (raw.startsWith("@")) {
    try {
      text = readFileSync(raw.slice(1), "utf8");
    } catch (err) {
      return { error: `cannot read ${raw.slice(1)}: ${(err as Error).message}` };
    }
  }
  try {
    return { value: JSON.parse(text.replace(/^﻿/, "")) as unknown };
  } catch (err) {
    return { error: `not JSON: ${(err as Error).message} (a string payload is quoted: '"text"')` };
  }
}

/** The editor `--edit` runs: `$VISUAL`, else `$EDITOR`, else `vi` (`notepad` on Windows). */
export function editorCommand(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  return env.VISUAL?.trim() || env.EDITOR?.trim() || (platform === "win32" ? "notepad" : "vi");
}

/**
 * Why `--edit` cannot edit a payload as its event shows it, or null when it
 * can: one cut to 64 KiB is only its start, and one with secrets redacted
 * would send the markers back in their place.
 */
export function editBlocker(cp: { payload: unknown; truncated?: boolean }): string | null {
  if (cp.truncated) return "its payload was cut to 64 KiB in the run's events, so --edit would only see its start";
  if (hasMarker(JSON.stringify(cp.payload) ?? "")) {
    return "its payload had likely secrets redacted in the run's events (shown as «redacted:…»), so an edit would send the markers back in their place";
  }
  return null;
}

/** How an `--edit` session ended. */
export type EditOutcome =
  /** The same JSON came back: approve as is. The file is gone. */
  | { kind: "unchanged" }
  /** The file was emptied: do not answer. The file is gone. */
  | { kind: "empty" }
  /** An edit the checkpoint takes, as JSON: send it, then `discard()` the file. */
  | { kind: "edited"; value: unknown; file: string; discard(): void }
  /** Not JSON, or refused by `check`: the file is kept. */
  | { kind: "refused"; message: string; problems: string[]; file: string }
  /** The editor could not start, or failed: the file is kept when it holds a change (`file`), else gone. */
  | { kind: "editor-failed"; message: string; file: string | null };

export interface EditOptions {
  /** The editor command line, run through the shell with the file as its last argument. */
  editor: string;
  /** What the checkpoint takes ({@link checkEdit} with its schema). */
  check: (value: unknown) => CheckedEdit;
  /** Where the temp directory goes (the OS temp directory by default). */
  tmpRoot?: string;
}

/** Open the editor on `payload` (JSON, as the checkpoint's event shows it) and read back what the person made of it. */
export async function editPayload(payload: unknown, options: EditOptions): Promise<EditOutcome> {
  // mkdtemp makes the directory 0700; the file is the owner's alone too.
  const dir = mkdtempSync(join(options.tmpRoot ?? tmpdir(), "odw-approve-"));
  const file = join(dir, "payload.json");
  const discard = (): void => rmSync(dir, { recursive: true, force: true });
  const shown = `${JSON.stringify(payload, null, 2) ?? "null"}\n`;
  let ran: { code: number | null; signal: NodeJS.Signals | null };
  try {
    writeFileSync(file, shown, { mode: 0o600, flag: "wx" });
    ran = await runEditor(options.editor, file);
  } catch (err) {
    discard();
    return { kind: "editor-failed", message: `could not start the editor (${options.editor}): ${(err as Error).message}`, file: null };
  }
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    discard();
    return { kind: "editor-failed", message: `could not read the edited file back: ${(err as Error).message}`, file: null };
  }
  const changed = text !== shown;
  if (ran.code !== 0) {
    if (!changed) discard();
    const how = ran.signal ? `was killed by ${ran.signal}` : `exited with code ${ran.code}`;
    return { kind: "editor-failed", message: `the editor (${options.editor}) ${how}`, file: changed ? file : null };
  }
  // A Windows editor may save a byte-order mark; JSON has none.
  const body = text.replace(/^﻿/, "");
  if (body.trim() === "") {
    discard();
    return { kind: "empty" };
  }
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (err) {
    const message = `the edited payload is not JSON: ${(err as Error).message}`;
    return { kind: "refused", message, problems: [message], file };
  }
  if (!changed || sameJson(value, payload)) {
    discard();
    return { kind: "unchanged" };
  }
  const checked = options.check(value);
  if (!checked.ok) return { kind: "refused", message: checked.message, problems: checked.problems, file };
  return { kind: "edited", value: checked.value, file, discard };
}

function sameJson(a: unknown, b: unknown): boolean {
  try {
    return deepEqual(a, b);
  } catch {
    return false; // nested too deep to compare: an edit, then
  }
}

/**
 * Run the editor on `file` with the terminal, through the shell (an editor
 * setting may carry arguments: `code --wait`). The file is passed as `"$@"`,
 * never spliced into the command line. While it runs, Ctrl-C is the editor's
 * business — as with git — not a reason for odw to die under it.
 */
function runEditor(editor: string, file: string): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const ignore = (): void => {};
    process.on("SIGINT", ignore);
    const done = (): void => void process.off("SIGINT", ignore);
    const child =
      process.platform === "win32"
        ? spawn(`${editor} "${file}"`, { stdio: "inherit", shell: true })
        : spawn("/bin/sh", ["-c", `${editor} "$@"`, editor, file], { stdio: "inherit" });
    child.once("error", (err) => {
      done();
      reject(err);
    });
    child.once("exit", (code, signal) => {
      done();
      resolve({ code, signal });
    });
  });
}
