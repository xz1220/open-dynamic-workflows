#!/usr/bin/env node
/**
 * Scripted mock agent, for the declared-scope tests.
 *
 * Reads the prompt from stdin and carries out, in its working directory, the
 * task on the line after the prompt's `TASK:` marker — a JSON object:
 *
 *   { "name": "<name>",                  what it logs itself as
 *     "write": { "<path>": "<text>" },   files to create or overwrite
 *     "barrier": <n> }                   then wait until n agents are up
 *
 * It appends `start <name>` to the log named by argv[2] as it starts and
 * `end <name>` as it ends, so a test reads who ran when from the log's order.
 * With a barrier it drops `<log>.up/<name>` and waits — polling, at most 20
 * seconds — until n such files exist: it replies `together` when they did,
 * `alone` when it gave up. Without one it replies `done`. Used only by the
 * test suite.
 */

import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const log = process.argv[2];
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const at = input.indexOf("TASK:");
  const task = at === -1 ? {} : JSON.parse(input.slice(at + "TASK:".length).trim().split("\n")[0]);
  const name = task.name ?? "?";
  appendFileSync(log, `start ${name}\n`);
  for (const [path, text] of Object.entries(task.write ?? {})) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  const finish = (reply) => {
    appendFileSync(log, `end ${name}\n`);
    process.stdout.write(reply);
  };
  if (!task.barrier) return finish("done");
  const up = `${log}.up`;
  mkdirSync(up, { recursive: true });
  writeFileSync(join(up, name), "");
  const deadline = Date.now() + 20_000;
  const timer = setInterval(() => {
    const together = readdirSync(up).length >= task.barrier;
    if (!together && Date.now() < deadline) return;
    clearInterval(timer);
    finish(together ? "together" : "alone");
  }, 20);
});
