import { test } from "node:test";
import assert from "node:assert/strict";
import { execPath } from "node:process";

import { runCommand } from "../src/adapters/runner.js";

test("captures stdout and a clean exit", async () => {
  const r = await runCommand([execPath, "-e", "process.stdout.write('hello')"]);
  assert.equal(r.returncode, 0);
  assert.equal(r.stdout, "hello");
  assert.equal(r.timedOut, false);
});

test("passes stdin through to the process", async () => {
  const r = await runCommand([execPath, "-e", "process.stdin.pipe(process.stdout)"], {
    stdin: "echo-me",
  });
  assert.equal(r.stdout, "echo-me");
});

test("a non-zero exit is reported, not thrown", async () => {
  const r = await runCommand([execPath, "-e", "process.exit(3)"]);
  assert.equal(r.returncode, 3);
});

test("a missing executable becomes returncode 127", async () => {
  const r = await runCommand(["this-command-does-not-exist-odw"]);
  assert.equal(r.returncode, 127);
  assert.match(r.stderr, /failed to launch/);
});

test("a timeout kills the process and flags timedOut", async () => {
  const r = await runCommand([execPath, "-e", "setTimeout(() => {}, 10000)"], { timeout: 0.2 });
  assert.equal(r.timedOut, true);
});
