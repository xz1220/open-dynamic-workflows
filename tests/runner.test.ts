import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test(
  "an abort kills the agent's process group at once and settles the result",
  { skip: process.platform === "win32" },
  async () => {
    const controller = new AbortController();
    let grandchild = 0;
    const started = Date.now();
    const pending = runCommand(["sh", "-c", "sleep 30 & echo $!; wait"], {
      signal: controller.signal,
      onStdout: (chunk) => {
        grandchild = Number(chunk.trim());
        controller.abort(new Error("run stopped"));
      },
    });
    const r = await pending;
    assert.ok(Date.now() - started < 5000, "the abort was not honoured promptly");
    assert.equal(r.returncode, -1);
    assert.equal(r.timedOut, false);
    assert.match(r.stderr, /\[aborted; process terminated\]/);
    assert.ok(grandchild > 0);
    assert.ok(await eventually(() => !isRunning(grandchild)), `grandchild ${grandchild} survived the abort`);
  },
);

test(
  "a stall timeout kills a silent agent's whole process group and flags stalled",
  { skip: process.platform === "win32" },
  async () => {
    const started = Date.now();
    // One line (the grandchild's pid), then silence while the grandchild runs.
    const r = await runCommand(["sh", "-c", "sleep 30 & echo $!; wait"], { stallTimeout: 0.3, timeout: 20 });
    const took = Date.now() - started;
    assert.equal(r.stalled, true);
    assert.equal(r.timedOut, false, "a stall is not reported as a timeout");
    assert.equal(r.returncode, -1);
    assert.ok(took >= 250 && took < 5000, `runCommand returned after ${took}ms`);
    const grandchild = Number(r.stdout.trim());
    assert.ok(grandchild > 0, `expected the grandchild pid on stdout, got ${JSON.stringify(r.stdout)}`);
    assert.ok(await eventually(() => !isRunning(grandchild)), `grandchild ${grandchild} survived the stall kill`);
  },
);

/** A node process writing '.' to `stream` at once and then every 50ms. */
const heartbeat = (stream: "stdout" | "stderr", then = "") => [
  execPath,
  "-e",
  `process.${stream}.write('.'); const beat = setInterval(() => process.${stream}.write('.'), 50);${then}`,
];

test("output on stdout or stderr keeps the stall watchdog at bay", async () => {
  // Alive for 2s in total — well past the 0.8s stall timeout — but never
  // silent for long, then a clean exit. Each stream alone must count.
  const done = "setTimeout(() => { clearInterval(beat); process.stdout.write('done'); }, 2000)";
  const results = await Promise.all(
    (["stdout", "stderr"] as const).map((stream) => runCommand(heartbeat(stream, done), { stallTimeout: 0.8 })),
  );
  for (const [i, r] of results.entries()) {
    assert.equal(r.returncode, 0, `heartbeat #${i} should keep the agent alive: ${r.stderr}`);
    assert.equal(r.stalled, false);
    assert.match(r.stdout, /done$/);
  }
});

test("the stall watchdog and the timeout are independent; the first to fire names the kill", async () => {
  const silent = [execPath, "-e", "setTimeout(() => {}, 30000)"];

  // Output keeps the stall away but never resets the overall timeout.
  let r = await runCommand(heartbeat("stderr"), { timeout: 1.6, stallTimeout: 0.8 });
  assert.equal(r.timedOut, true);
  assert.equal(r.stalled, false);

  // A timeout shorter than the stall timeout fires first …
  r = await runCommand(silent, { timeout: 0.2, stallTimeout: 5 });
  assert.equal(r.timedOut, true);
  assert.equal(r.stalled, false);

  // … and a stall timeout shorter than the timeout does.
  r = await runCommand(silent, { timeout: 5, stallTimeout: 0.2 });
  assert.equal(r.stalled, true);
  assert.equal(r.timedOut, false);
  assert.equal(r.returncode, -1);
});

test("without a stall timeout a silent agent is left alone", async () => {
  const r = await runCommand([execPath, "-e", "setTimeout(() => process.stdout.write('late'), 600)"]);
  assert.equal(r.returncode, 0);
  assert.equal(r.stalled, false);
  assert.equal(r.stdout, "late");
});

test(
  "silence after the agent exited is not a stall",
  { skip: process.platform === "win32" },
  async () => {
    // The shell exits at once; a silent straggler holds the pipes through the
    // 2s drain grace, long past the stall timeout.
    const r = await runCommand(["sh", "-c", "sleep 30 & echo $!"], { stallTimeout: 0.5 });
    assert.equal(r.returncode, 0, "the agent itself exited cleanly");
    assert.equal(r.stalled, false);
    const straggler = Number(r.stdout.trim());
    assert.ok(await eventually(() => !isRunning(straggler)), `straggler ${straggler} was left running`);
  },
);

test("an already-aborted signal never spawns the process", async (t) => {
  const controller = new AbortController();
  controller.abort(new Error("stopped"));
  const markerDir = mkdtempSync(join(tmpdir(), "odw-abort-"));
  t.after(() => rmSync(markerDir, { recursive: true, force: true }));
  const marker = join(markerDir, "spawned");
  const r = await runCommand([execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`], {
    signal: controller.signal,
  });
  assert.equal(r.returncode, -1);
  assert.match(r.stderr, /aborted before start/);
  assert.equal(existsSync(marker), false);
});

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

test("a terminated agent gets SIGTERM first, so it can stop the tools it started", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-term-"));
  const marker = join(dir, "cleaned-up");
  try {
    // Like an agent CLI whose tools run in process groups of their own: on
    // SIGTERM it cleans up (here: writes a marker) and exits.
    const script = `process.on("SIGTERM", () => { require("fs").writeFileSync(${JSON.stringify(marker)}, "ok"); process.exit(0) }); setInterval(() => {}, 1000)`;
    const res = await runCommand([execPath, "-e", script], { timeout: 0.5 });
    assert.equal(res.timedOut, true);
    assert.ok(existsSync(marker), "the agent's SIGTERM handler ran before any SIGKILL");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an agent that ignores SIGTERM is SIGKILLed after the grace period", { skip: process.platform === "win32" }, async () => {
  const started = Date.now();
  const res = await runCommand([execPath, "-e", `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)`], { timeout: 0.5 });
  assert.equal(res.timedOut, true);
  const took = Date.now() - started;
  assert.ok(took < 5000, `settled ${took}ms after start`);
});
