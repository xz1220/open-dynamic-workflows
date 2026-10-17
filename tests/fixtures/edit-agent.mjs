#!/usr/bin/env node
/**
 * File-editing mock agent, for the kept-diff tests.
 *
 * Reads the prompt from stdin and carries out, in its working directory, the
 * edits in the one-line JSON object that follows the prompt's `EDITS:` marker:
 *
 *   { "write": { "<path>": "<text>" },   create or overwrite text files
 *     "bytes": { "<path>": [0, 1, 2] },  create or overwrite binary files
 *     "remove": ["<path>"],              delete files
 *     "reply": "<text>",                 what to print (default "edited")
 *     "exit": 3 }                        exit with this code after the edits
 *
 * Used only by the test suite.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const at = input.indexOf("EDITS:");
  const edits = at === -1 ? {} : JSON.parse(input.slice(at + "EDITS:".length).trim().split("\n")[0]);
  const put = (path, data) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
  };
  for (const [path, text] of Object.entries(edits.write ?? {})) put(path, text);
  for (const [path, bytes] of Object.entries(edits.bytes ?? {})) put(path, Buffer.from(bytes));
  for (const path of edits.remove ?? []) rmSync(path, { force: true, recursive: true });
  process.stdout.write(edits.reply ?? "edited");
  if (edits.exit) process.exitCode = edits.exit;
});
