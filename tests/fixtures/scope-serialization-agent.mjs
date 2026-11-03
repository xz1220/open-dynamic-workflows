#!/usr/bin/env node
/**
 * Scope-serialization mock agent, for the repository-alias lock tests.
 *
 * Usage: scope-serialization-agent.mjs <log> <release>
 *
 * Reads the prompt from stdin, then — in its working directory:
 *   1. appends "start A|B" to <log> (A when the prompt holds FIRST, else B),
 *   2. waits until the <release> file exists (the test writes it once both
 *      scoped calls are in flight, so an overlap is observable either way),
 *   3. appends its own marker line to shared.txt (read first, so concurrent
 *      read/modify/write loses a marker exactly when the calls overlapped),
 *   4. appends "end A|B" to <log> and replies "done".
 *
 * Used only by the test suite.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const [, , log, release] = process.argv;
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const name = input.includes("FIRST") ? "A" : "B";
  const before = readFileSync("shared.txt", "utf8");
  appendFileSync(log, `start ${name}\n`);
  const started = Date.now();
  while (!existsSync(release)) {
    if (Date.now() - started > 15_000) {
      process.stderr.write("scope-serialization-agent: timed out waiting for the release file\n");
      process.exit(2);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  writeFileSync("shared.txt", `${before}${name}\n`);
  appendFileSync(log, `end ${name}\n`);
  process.stdout.write("done");
});
