/**
 * `odw doctor --smoke` runs a real agent CLI in its own process group, out of
 * the terminal's reach; Ctrl-C on doctor must still take it (and anything it
 * started) down.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
}

test("Ctrl-C during odw doctor --smoke kills the smoke agent and its children", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-doctor-sig-"));
  const pids = join(dir, "pids");
  const config = join(dir, "odw.config.json");
  writeFileSync(
    config,
    JSON.stringify({
      runsRoot: join(dir, "runs"),
      defaultAdapter: "slow",
      adapters: { slow: { command: ["sh", "-c", `sleep 30 & echo $! >> '${pids}'; wait`] } },
    }),
  );
  // Same loader flags as this test process, so the TypeScript entrypoint runs.
  const doctor = spawn(process.execPath, [...process.execArgv, cli, "doctor", "--smoke", "--config", config], {
    cwd: dir,
    stdio: "ignore",
  });
  try {
    assert.ok(await until(() => existsSync(pids), 20_000), "the smoke agent started");
    const tool = Number(readFileSync(pids, "utf8").trim().split("\n")[0]);
    assert.ok(alive(tool));
    const exited = new Promise<NodeJS.Signals | null>((resolve) => doctor.once("exit", (_code, signal) => resolve(signal)));
    doctor.kill("SIGINT");
    assert.equal(await exited, "SIGINT", "doctor dies by the signal it received");
    assert.ok(await until(() => !alive(tool), 5000), `the agent's child ${tool} outlived doctor`);
  } finally {
    doctor.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});
