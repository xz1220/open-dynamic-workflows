#!/usr/bin/env node
/**
 * Mock CLI for the accounts tests, run through a `claude` (or `codex`)
 * wrapper so ODW takes it for that CLI. Its login is the config directory
 * its variable points to ($CLAUDE_CONFIG_DIR, else $CODEX_HOME):
 *
 *   auth status | login status   exits 0 when <dir>/.credentials.json
 *                                exists ("logged in"), 1 when not
 *   --version                    prints a version
 *   (a prompt on stdin)          when <dir>/quota exists: writes partial.txt
 *                                in its working directory and fails as a
 *                                spent quota (Claude Code's message, exit 1);
 *                                else replies
 *                                `dir=<dir> partial=<yes|no> brief=<yes|no>`
 *
 * Each prompt run appends a line to <dir>/runs.log. Used only by the test suite.
 */

import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.CLAUDE_CONFIG_DIR ?? process.env.CODEX_HOME ?? "";
const args = process.argv.slice(2);

if ((args[0] === "auth" || args[0] === "login") && args[1] === "status") {
  const loggedIn = dir !== "" && existsSync(join(dir, ".credentials.json"));
  process.stdout.write(loggedIn ? `Logged in (${dir})\n` : "Not logged in\n");
  process.exit(loggedIn ? 0 : 1);
}
if (args[0] === "--version") {
  process.stdout.write("9.9.9 (mock)\n");
  process.exit(0);
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  if (dir) appendFileSync(join(dir, "runs.log"), "run\n");
  if (dir && existsSync(join(dir, "quota"))) {
    writeFileSync("partial.txt", "half done\n");
    process.stdout.write("wrote partial.txt\n");
    process.stderr.write("You've hit your usage limit. Upgrade to Pro.\n");
    process.exitCode = 1;
    return;
  }
  // odw doctor --smoke asks for its token.
  if (input.includes("ODW_DOCTOR_OK")) {
    process.stdout.write("ODW_DOCTOR_OK");
    return;
  }
  const yes = (b) => (b ? "yes" : "no");
  process.stdout.write(`dir=${dir} partial=${yes(existsSync("partial.txt"))} brief=${yes(input.includes("## Handoff: you are continuing work another agent started"))}`);
});
