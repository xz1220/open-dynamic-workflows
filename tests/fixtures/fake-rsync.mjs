#!/usr/bin/env node
/**
 * A fake rsync for the remote-run tests: `ODW_RSYNC` points at it. It reads
 * `<src> <dest>` past the options, maps a `host:path` side to the fake ssh's
 * remote home ($SSH_FAKE_HOME/path, or path itself when absolute), and copies
 * src's contents (a trailing slash, as odw always passes) into dest, leaving
 * out what an `--exclude=PATTERN` names (by file name; a leading or trailing
 * slash is dropped). --no-links leaves symbolic links out, as rsync does.
 * --delete and --filter are taken and ignored.
 *
 *   RSYNC_FAKE_LOG      every call's argv appended as a JSON line
 *   RSYNC_FAKE_FAIL     set: exit 12, as rsync does when the remote end has no rsync
 *   RSYNC_FAKE_PARTIAL  set: copy, then exit 23, as rsync does when some files could not be transferred
 *
 * Used only by the test suite.
 */

import { appendFileSync, cpSync, lstatSync, mkdirSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

const argv = process.argv.slice(2);
if (process.env.RSYNC_FAKE_LOG) appendFileSync(process.env.RSYNC_FAKE_LOG, JSON.stringify(argv) + "\n");
if (process.env.RSYNC_FAKE_FAIL) {
  process.stderr.write("rsync: connection unexpectedly closed (0 bytes received so far) [Receiver]\n");
  process.exit(12);
}

const excludes = [];
const paths = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "-e") i++;
  else if (arg.startsWith("--exclude=")) excludes.push(arg.slice("--exclude=".length).replace(/^\/|\/$/g, ""));
  else if (!arg.startsWith("-")) paths.push(arg);
}
const [src, dest] = paths.map((p) => {
  const m = /^(?:[^/:]+@)?(?:\[[^\]]+\]|[^/:]+):(.*)$/.exec(p);
  if (!m) return p;
  return isAbsolute(m[1]) ? m[1] : join(process.env.SSH_FAKE_HOME, m[1]);
});
mkdirSync(dest, { recursive: true });
const noLinks = argv.includes("--no-links");
cpSync(src, dest, {
  recursive: true,
  force: true,
  filter: (from) => !excludes.includes(basename(from)) && !(noLinks && lstatSync(from).isSymbolicLink()),
});
if (process.env.RSYNC_FAKE_PARTIAL) {
  process.stderr.write("rsync error: some files/attrs were not transferred (code 23)\n");
  process.exit(23);
}
