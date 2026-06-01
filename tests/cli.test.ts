import { test } from "node:test";
import assert from "node:assert/strict";

import { helpText, versionText, main, COMMANDS } from "../src/cli.js";

test("help text lists the core commands", () => {
  const help = helpText();
  assert.match(help, /odw/);
  for (const command of ["run", "status", "logs", "result", "list"]) {
    assert.match(help, new RegExp(`\\b${command}\\b`), `help should mention '${command}'`);
  }
});

test("version text includes a semver-looking version", () => {
  assert.match(versionText(), /\d+\.\d+\.\d+/);
});

test("--help exits 0", async () => {
  assert.equal(await main(["--help"]), 0);
});

test("no command prints help and exits 2", async () => {
  assert.equal(await main([]), 2);
});

test("unknown command exits 2", async () => {
  assert.equal(await main(["frobnicate"]), 2);
});

test("known-but-unwired command exits 1 (not yet implemented)", async () => {
  assert.equal(await main(["run", "wf.js"]), 1);
});

test("COMMANDS covers the documented verbs", () => {
  for (const command of ["run", "status", "logs", "result", "list", "pause", "resume", "stop"]) {
    assert.ok((COMMANDS as readonly string[]).includes(command));
  }
});
