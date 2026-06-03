import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { helpText, versionText, main, COMMANDS, isCliEntrypoint } from "../src/cli.js";

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

test("CLI entrypoint detection follows npm bin symlinks", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "odw-cli-"));
  try {
    const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const linkedPath = join(tempDir, "odw");
    symlinkSync(cliPath, linkedPath);

    assert.equal(isCliEntrypoint(linkedPath, pathToFileURL(cliPath).href), true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("help and COMMANDS cover the workflows command", () => {
  assert.match(helpText(), /workflows list/);
  assert.match(helpText(), /workflows where/);
  assert.ok((COMMANDS as readonly string[]).includes("workflows"));
});

test("workflows: unknown subcommand and missing args are usage errors (exit 2)", async () => {
  assert.equal(await main(["workflows"]), 2); // no subcommand
  assert.equal(await main(["workflows", "bogus"]), 2); // unknown subcommand
  assert.equal(await main(["workflows", "where"]), 2); // missing <name>
  assert.equal(await main(["workflows", "list", "--project", "--global"]), 2); // mutually exclusive
});
