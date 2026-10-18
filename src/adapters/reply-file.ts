/**
 * Reply files (an ODW extension): a CLI that writes its final reply to a file
 * of its own — `codex exec --output-last-message <file>` — is handed a path
 * where its command has `{reply_file}`. Each CLI run gets a fresh path in a
 * private temporary directory (mkdtemp: this user's alone); the CLI creates
 * the file, ODW reads it once the CLI has exited and then removes the
 * directory, whatever happened. Like the schema file of `flags.schema.mode:
 * "file"` (see native-schema.ts), it lives only as long as its CLI run.
 *
 * What the file holds is the CLI's own word on its reply, so it does not
 * depend on the shape of the CLI's stdout (see output.ts).
 */

import { constants } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Adapter } from "./types.js";

export const REPLY_FILE_TOKEN = "{reply_file}";

/** The most of a reply file that is read: the runner's own stdout cap. */
export const MAX_REPLY_FILE_BYTES = 32 * 1024 * 1024;

/** Whether an adapter's command (or stdin) asks for a reply file. */
export function usesReplyFile(adapter: Pick<Adapter, "command" | "stdin">): boolean {
  return adapter.command.some((part) => part.includes(REPLY_FILE_TOKEN)) || (adapter.stdin?.includes(REPLY_FILE_TOKEN) ?? false);
}

/** What one CLI run left in its reply file. */
export interface ReplyRead {
  /** Its text, or null when the CLI wrote no file. */
  text: string | null;
  /** Something the run's log should hear: a file past the cap, or one that could not be read. */
  note?: string;
}

/** One CLI run's reply file: where it goes, how to read it, and what removes it. */
export interface ReplyFile {
  path: string;
  read(): Promise<ReplyRead>;
  /** Remove the file and its directory. Never throws. */
  cleanup(): Promise<void>;
}

/** A fresh reply-file path for one CLI run, in a directory of its own. The file itself is the CLI's to create. */
export async function replyFile(maxBytes = MAX_REPLY_FILE_BYTES): Promise<ReplyFile> {
  const dir = await mkdtemp(join(tmpdir(), "odw-reply-"));
  const path = join(dir, "reply.txt");
  return {
    path,
    read: () => readReply(path, maxBytes),
    cleanup: () => rm(dir, { recursive: true, force: true }).catch(() => {}),
  };
}

async function readReply(path: string, maxBytes: number): Promise<ReplyRead> {
  let file;
  try {
    // The CLI owns the reply file's directory (in a container sandbox it is
    // mounted read-write), so the file may be anything it chose to make
    // there: a link to a host file would hand that file over as the reply,
    // and a FIFO would block this open forever. Open without following a
    // link or waiting on a pipe, and read regular files only.
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { text: null };
    if (code === "ELOOP") return { text: null, note: "its reply file is a link — not read" };
    return { text: null, note: `its reply file could not be read: ${(err as Error).message}` };
  }
  try {
    const info = await file.stat();
    if (!info.isFile()) return { text: null, note: "its reply file is not a regular file — not read" };
    const { size } = info;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await file.read(buffer, read, length - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    const text = buffer.subarray(0, read).toString("utf8");
    return size > maxBytes ? { text, note: `its reply file holds ${size} bytes: the first ${maxBytes} are the reply` } : { text };
  } catch (err) {
    return { text: null, note: `its reply file could not be read: ${(err as Error).message}` };
  } finally {
    await file.close().catch(() => {});
  }
}
