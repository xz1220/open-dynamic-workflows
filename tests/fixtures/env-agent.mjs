#!/usr/bin/env node
/**
 * Environment-reporting mock agent, for the worktree environment tests.
 *
 * Reads the prompt from stdin, then replies with a JSON object: the ODW_*
 * variables it was started with, its working directory, and the trimmed
 * content of each file named on the command line (null when absent) — what
 * .worktreeinclude and the worktree setup left in its workspace. With
 * `--barrier <dir> <n>` first, it checks in under <dir> and waits (at most
 * 30s) until n agents have, so a test knows they all ran at the same time.
 * Used only by the test suite.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const files = process.argv.slice(2);
const barrier = files[0] === "--barrier" ? { dir: files[1], count: Number(files[2]) } : null;
if (barrier) files.splice(0, 3);

process.stdin.resume();
process.stdin.on("end", async () => {
  if (barrier) await checkIn(barrier);
  const read = (name) => (existsSync(name) ? readFileSync(name, "utf8").trim() : null);
  process.stdout.write(
    JSON.stringify({
      runId: process.env.ODW_RUN_ID ?? null,
      agentId: process.env.ODW_AGENT_ID ?? null,
      port: process.env.ODW_PORT ?? null,
      cwd: process.cwd(),
      files: Object.fromEntries(files.map((name) => [name, read(name)])),
    }),
  );
});

async function checkIn({ dir, count }) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `agent-${process.pid}`), "");
  const deadline = Date.now() + 30_000;
  while (readdirSync(dir).length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
