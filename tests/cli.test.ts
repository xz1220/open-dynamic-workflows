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

test("help groups flags by section: serve flags and -h/-v are not listed as run modes", () => {
  const help = helpText();
  const section = (title: string): string => {
    const start = help.indexOf(`\n${title}`);
    assert.notEqual(start, -1, `missing section '${title}'`);
    const end = help.indexOf("\n\n", start + 1);
    return help.slice(start, end === -1 ? undefined : end);
  };
  const runModes = section("Run modes");
  assert.doesNotMatch(runModes, /--port|--host|--open|--help|--version/);
  const serve = section("Serve options");
  for (const flag of ["--port <n>", "--host <addr>", "--open"]) assert.ok(serve.includes(flag), flag);
  assert.match(section("Options:"), /-h, --help[\s\S]*-v, --version/);
});

/** Run the CLI capturing stderr (node:test's own buffer writes pass through). */
async function cliErr(argv: string[]): Promise<{ code: number; err: string }> {
  const chunks: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = (s: unknown) => {
    if (Buffer.isBuffer(s)) return write(s);
    chunks.push(String(s));
    return true;
  };
  try {
    return { code: await main(argv), err: chunks.join("") };
  } finally {
    process.stderr.write = write;
  }
}

test("run and rerun validate --timeout and the run mode in the same order, before any lookup", async () => {
  // Same flags → same first complaint for both commands, and rerun complains
  // before it looks for the run (no 'no such run' for a usage mistake).
  for (const cmd of ["run", "rerun"]) {
    const target = cmd === "run" ? "wf.js" : "no-such-run";
    let r = await cliErr([cmd, target, "--fg", "--detach", "--timeout", "abc"]);
    assert.deepEqual(r, { code: 2, err: `odw ${cmd}: --timeout must be a non-negative number of seconds\n` });
    r = await cliErr([cmd, target, "--fg", "--detach"]);
    assert.deepEqual(r, { code: 2, err: `odw ${cmd}: --fg and --detach are mutually exclusive\n` });
    r = await cliErr([cmd, target, "--detach", "--timeout", "5"]);
    assert.deepEqual(r, {
      code: 2,
      err: `odw ${cmd}: --timeout needs --wait or --fg (a detached start returns immediately)\n`,
    });
  }
});

test("attach rejects a bad --timeout as a usage error before looking up the run", async () => {
  for (const bad of ["-1", "abc", "Infinity"]) {
    const r = await cliErr(["attach", "no-such-run", `--timeout=${bad}`]);
    assert.deepEqual(r, { code: 2, err: "odw attach: --timeout must be a non-negative number of seconds\n" });
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

// --- --args parsing: JSON-looking input must parse, plain strings pass through ---

import { parseArgsValue } from "../src/cli.js";
import { writeFileSync } from "node:fs";

test("parseArgsValue: valid JSON, raw strings, and @file all work", () => {
  assert.deepEqual(parseArgsValue('{"q": 1}'), { q: 1 });
  assert.equal(parseArgsValue("hello world"), "hello world");
  assert.equal(parseArgsValue(undefined), null);
  const dir = mkdtempSync(join(tmpdir(), "odw-args-"));
  try {
    const p = join(dir, "args.json");
    writeFileSync(p, '{"from": "file"}');
    assert.deepEqual(parseArgsValue(`@${p}`), { from: "file" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseArgsValue: input that looks like JSON but fails to parse throws loudly", () => {
  for (const bad of ['{bad json', '{"q": }', "[1, 2,", '  {"unterminated": "str']) {
    assert.throws(
      () => parseArgsValue(bad),
      /looks like JSON but failed to parse/,
      `expected '${bad}' to be rejected`,
    );
  }
});
