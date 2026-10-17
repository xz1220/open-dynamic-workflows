import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";

import { runCommand, TAIL_CHARS } from "../src/adapters/runner.js";

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

test(
  "Windows PATH command shims run through their PowerShell companion without shell interpolation",
  { skip: process.platform !== "win32" },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "odw-runner-shim-"));
    try {
      const name = "odw-runner-shim";
      writeFileSync(join(dir, `${name}.cmd`), "@echo off\r\nexit /b 99\r\n");
      writeFileSync(
        join(dir, `${name}.ps1`),
        'param([string]$Value)\n$body = [Console]::In.ReadToEnd()\n[Console]::Out.Write(\"$Value|$body\")\n',
      );
      const result = await runCommand([name, "safe&literal"], {
        stdin: "stdin-value",
        env: { ...process.env, PATH: dir, PATHEXT: ".CMD" } as Record<string, string>,
      });
      assert.equal(result.returncode, 0);
      assert.equal(result.stdout, "safe&literal|stdin-value");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "Windows PATH executables use their resolved PATHEXT path",
  { skip: process.platform !== "win32" },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "odw-runner-exe-"));
    try {
      const name = "odw-runner-exe";
      copyFileSync(execPath, join(dir, `${name}.exe`));
      const result = await runCommand([name, "--version"], {
        env: { ...process.env, PATH: dir, PATHEXT: ".EXE" } as Record<string, string>,
      });
      assert.equal(result.returncode, 0);
      assert.match(result.stdout, /^v\d+/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("a timeout kills the process and flags timedOut", async () => {
  const r = await runCommand([execPath, "-e", "setTimeout(() => {}, 10000)"], { timeout: 0.2 });
  assert.equal(r.timedOut, true);
});

/** Whether `pid` is a live (non-zombie) process. POSIX only. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    // A killed process can linger as a zombie until its new parent reaps it.
    return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z");
  } catch {
    return false; // ps exits non-zero once the pid is gone
  }
}

async function eventually(check: () => boolean, ms = 2000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

test(
  "a timeout kills the agent's whole process group, grandchildren included",
  { skip: process.platform === "win32" },
  async () => {
    const started = Date.now();
    // The shell waits on a background grandchild that shares its stdout pipe:
    // killing only the shell used to leave the pipe open until `sleep` exited.
    const r = await runCommand(["sh", "-c", "sleep 30 & echo $!; wait"], { timeout: 0.3 });
    const took = Date.now() - started;
    assert.equal(r.timedOut, true);
    assert.equal(r.returncode, -1);
    assert.ok(took < 5000, `runCommand returned after ${took}ms; the grandchild kept it waiting`);
    const grandchild = Number(r.stdout.trim());
    assert.ok(grandchild > 0, `expected the grandchild pid on stdout, got ${JSON.stringify(r.stdout)}`);
    assert.ok(await eventually(() => !isRunning(grandchild)), `grandchild ${grandchild} survived the timeout`);
  },
);

test(
  "a descendant still holding the pipes after the agent exits cannot stall the result",
  { skip: process.platform === "win32" },
  async () => {
    const started = Date.now();
    // The shell exits at once; its background child inherits stdout and never closes it.
    const r = await runCommand(["sh", "-c", "sleep 30 & echo $!"]);
    const took = Date.now() - started;
    assert.equal(r.returncode, 0, "the agent itself exited cleanly");
    assert.equal(r.timedOut, false);
    assert.ok(took < 6000, `runCommand returned after ${took}ms; it waited on the straggler`);
    const straggler = Number(r.stdout.trim());
    assert.ok(straggler > 0);
    assert.ok(await eventually(() => !isRunning(straggler)), `straggler ${straggler} was left running`);
  },
);

test("runaway output is capped before it can exhaust the worker heap", async () => {
  const r = await runCommand(
    [
      execPath,
      "-e",
      "for (let i = 0; i < 1024; i++) process.stdout.write('x'.repeat(1024)); setTimeout(() => {}, 10000)",
    ],
    { maxOutputBytes: 4096 },
  );
  assert.notEqual(r.returncode, 0);
  assert.equal(r.timedOut, false);
  assert.ok(Buffer.byteLength(r.stdout) <= 4096);
  assert.match(r.stderr, /process output exceeded 4096 bytes/);
});

test("chatty stderr is kept as a bounded tail and never counts as runaway output", async () => {
  const r = await runCommand(
    [
      execPath,
      "-e",
      "for (let i = 0; i < 2000; i++) process.stderr.write('progress ' + i + ' ' + 'x'.repeat(100) + '\\n');" +
        "process.stderr.write('FINAL ERROR LINE\\n'); process.stdout.write('ok')",
    ],
    { maxOutputBytes: 4096 },
  );
  assert.equal(r.returncode, 0, "stderr beyond the stdout cap must not kill the agent");
  assert.equal(r.stdout, "ok");
  assert.ok(r.stderr.length <= TAIL_CHARS + 100, `stderr kept ${r.stderr.length} chars`);
  assert.match(r.stderr, /^\[… \d+ earlier characters omitted\]\n/);
  assert.match(r.stderr, /FINAL ERROR LINE\n$/, "the tail, where the final error lands, is kept");
});

test("streamed stdout reaches the consumer whole and is not cut off at the stdout cap", async () => {
  let received = "";
  const r = await runCommand(
    [execPath, "-e", "for (let i = 0; i < 64; i++) process.stdout.write('y'.repeat(1023) + '\\n')"],
    { maxOutputBytes: 4096, onStdout: (chunk) => void (received += chunk) },
  );
  assert.equal(r.returncode, 0);
  assert.equal(received.length, 64 * 1024, "the consumer saw every byte");
  assert.ok(r.stdout.length <= TAIL_CHARS, "only a diagnostic tail is retained on the result");
  assert.ok(received.endsWith(r.stdout));
});

test("a stdout consumer can terminate the process, reported like an output overrun", async () => {
  const started = Date.now();
  const r = await runCommand(
    [execPath, "-e", "process.stdout.write('first chunk\\n'); setTimeout(() => {}, 30000)"],
    { onStdout: (_chunk, terminate) => terminate("stdout line 1 is unusable") },
  );
  assert.ok(Date.now() - started < 5000, "the consumer's kill was not honoured promptly");
  assert.equal(r.returncode, 1);
  assert.equal(r.timedOut, false);
  assert.match(r.stderr, /\[stdout line 1 is unusable; terminated\]/);
});
