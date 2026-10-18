#!/usr/bin/env node
/**
 * A fake ssh for the remote-run tests (no sshd needed): `ODW_SSH` points at
 * it. It takes ssh's options (-p N, -t, -o X, …), an optional `--` and the
 * destination, then runs the remote command line — the trailing words joined
 * with spaces, as ssh sends them — with /bin/sh, as a login shell would, in a
 * temp "remote home": HOME=$SSH_FAKE_HOME, PATH=$SSH_FAKE_PATH and nothing
 * else of this environment, so the "remote" never sees the test's own odw
 * settings. stdin, stdout and stderr pass straight through; its exit code is
 * the command's.
 *
 *   SSH_FAKE_LOG          every call's argv appended as a JSON line
 *   SSH_FAKE_UNREACHABLE  set: exit 255 at once, as ssh does when it cannot connect
 *
 * Used only by the test suite.
 */

import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (process.env.SSH_FAKE_LOG) appendFileSync(process.env.SSH_FAKE_LOG, JSON.stringify(argv) + "\n");
if (process.env.SSH_FAKE_UNREACHABLE) {
  process.stderr.write("ssh: connect to host box port 22: Connection refused\n");
  process.exit(255);
}

const WITH_VALUE = new Set(["-p", "-o", "-i", "-l", "-F", "-J", "-L", "-R", "-D", "-E", "-S", "-W", "-b", "-c", "-m", "-O", "-Q", "-w"]);
let i = 0;
while (i < argv.length) {
  const arg = argv[i];
  if (arg === "--") {
    i++;
    break;
  }
  if (!arg.startsWith("-")) break;
  i += WITH_VALUE.has(arg) ? 2 : 1;
}
const destination = argv[i];
const command = argv.slice(i + 1).join(" ");
if (!destination || command === "") {
  process.stderr.write("fake-ssh: no destination or command (interactive sessions are not faked)\n");
  process.exit(255);
}

const home = process.env.SSH_FAKE_HOME;
const child = spawn("/bin/sh", ["-c", command], {
  cwd: home,
  env: { HOME: home, PATH: process.env.SSH_FAKE_PATH ?? "/usr/bin:/bin", LANG: "C" },
  stdio: "inherit",
});
child.on("close", (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
