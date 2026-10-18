#!/usr/bin/env node
/**
 * A fake container engine for the sandbox tests (no Docker needed).
 *
 * Linked onto PATH as `docker` (or `podman`); configured by DOCKER_FAKE_*
 * variables, which reach it as any DOCKER_* does. Every invocation appends its
 * argv as a JSON line to $DOCKER_FAKE_LOG. Subcommands:
 *
 *   run … <image> <cmd…>  runs <cmd…> directly — in its OWN process group,
 *                         as a daemon-owned container would be, so killing
 *                         this client does not stop it — with the --workdir,
 *                         only the --env variables (NAME=VALUE, or NAME read
 *                         from this client's environment) plus this PATH, and
 *                         HOME mapped back to the host directory bound at it.
 *                         While it runs, $DOCKER_FAKE_STATE/<name> holds its pid.
 *   kill <name>           SIGKILLs that container's group, removes its file.
 *   rm --force <name>     the same; quiet when it is gone.
 *   image inspect … <img> exit 0 when <img> is in $DOCKER_FAKE_IMAGES (comma list).
 *
 * Used only by the test suite.
 */

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
if (process.env.DOCKER_FAKE_LOG) appendFileSync(process.env.DOCKER_FAKE_LOG, JSON.stringify(argv) + "\n");
const state = process.env.DOCKER_FAKE_STATE ?? "/tmp";

const WITH_VALUE = new Set([
  "--name", "--label", "--user", "--userns", "--cap-drop", "--security-opt", "--tmpfs", "--pids-limit",
  "--memory", "--cpus", "--network", "--workdir", "--mount", "--env", "--pull",
]);

function stop(name) {
  const file = join(state, name);
  if (!existsSync(file)) return false;
  const pid = Number(readFileSync(file, "utf8"));
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* gone */
  }
  rmSync(file, { force: true });
  return true;
}

const [sub, ...rest] = argv;
if (sub === "image" && rest[0] === "inspect") {
  const image = rest[rest.length - 1];
  const images = (process.env.DOCKER_FAKE_IMAGES ?? "").split(",");
  if (images.includes(image)) {
    process.stdout.write("sha256:fake\n");
    process.exit(0);
  }
  process.stderr.write(`Error: No such image: ${image}\n`);
  process.exit(1);
} else if (sub === "kill" || sub === "rm") {
  const name = rest[rest.length - 1];
  if (stop(name)) process.exit(0);
  process.stderr.write(`Error: No such container: ${name}\n`);
  process.exit(1);
} else if (sub === "run") {
  let i = 0;
  let name = "anon";
  let workdir = process.cwd();
  const env = { PATH: process.env.PATH };
  const mounts = [];
  for (; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("-")) break;
    if (!WITH_VALUE.has(arg)) continue;
    const value = rest[++i];
    if (arg === "--name") name = value;
    else if (arg === "--workdir") workdir = value;
    else if (arg === "--mount") mounts.push(Object.fromEntries(value.split(",").map((f) => f.split("="))));
    else if (arg === "--env") {
      const eq = value.indexOf("=");
      if (eq === -1) {
        if (process.env[value] !== undefined) env[value] = process.env[value];
      } else env[value.slice(0, eq)] = value.slice(eq + 1);
    }
  }
  const command = rest.slice(i + 1);
  // The container's HOME is a host directory bound there: map it back.
  const home = mounts.find((m) => m.target === env.HOME);
  if (home) env.HOME = home.source;
  const child = spawn(command[0], command.slice(1), { cwd: workdir, env, detached: true, stdio: ["pipe", "inherit", "inherit"] });
  writeFileSync(join(state, name), String(child.pid));
  process.stdin.pipe(child.stdin);
  child.stdin.on("error", () => {});
  child.on("error", (err) => {
    rmSync(join(state, name), { force: true });
    process.stderr.write(`fake docker: ${err.message}\n`);
    process.exit(127);
  });
  child.on("exit", (code) => {
    rmSync(join(state, name), { force: true });
    process.exit(code ?? 137);
  });
} else {
  process.stderr.write(`fake docker: unknown ${argv.join(" ")}\n`);
  process.exit(2);
}
