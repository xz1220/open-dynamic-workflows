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
 *   run -d …              the same, detached: prints an id and exits at once
 *                         (an egress proxy: it gets ODW_EGRESS_PORT=0, so it
 *                         listens on a free port of this host).
 *   network create|rm …   $DOCKER_FAKE_STATE/net.<name> exists while it does. While
 *                         $DOCKER_FAKE_STATE/fail.netrm exists, an rm fails once
 *                         (and removes it), as a busy network's does.
 *   network connect …     nothing; logs.
 *
 * A container's command arguments under a bind mount's target are mapped to
 * its source (the proxy's script and config), and a `@<name>:` in an --env
 * value — a proxy URL naming a running container — becomes `@127.0.0.1:`,
 * as the engine's DNS would resolve it.
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
  "--memory", "--cpus", "--network", "--workdir", "--mount", "--env", "--pull", "--entrypoint",
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
} else if (sub === "network") {
  const [action, ...names] = rest;
  const name = names[names.length - 1];
  if (action === "create") writeFileSync(join(state, `net.${name}`), "");
  else if (action === "rm") {
    if (existsSync(join(state, "fail.netrm"))) {
      rmSync(join(state, "fail.netrm"), { force: true });
      process.stderr.write(`Error response from daemon: error while removing network: network ${name} has active endpoints\n`);
      process.exit(1);
    }
    if (!existsSync(join(state, `net.${name}`))) {
      process.stderr.write(`Error: network ${name} not found\n`);
      process.exit(1);
    }
    rmSync(join(state, `net.${name}`), { force: true });
  }
  process.exit(0);
} else if (sub === "logs") {
  process.exit(0);
} else if (sub === "kill" || sub === "rm") {
  if (sub === "rm" && rest.length > 2) {
    // rm --force a b …: each of them.
    for (const name of rest.slice(1)) stop(name);
    process.exit(0);
  }
  const name = rest[rest.length - 1];
  if (stop(name)) process.exit(0);
  process.stderr.write(`Error: No such container: ${name}\n`);
  process.exit(1);
} else if (sub === "run") {
  let i = 0;
  let name = "anon";
  let workdir = process.cwd();
  let entrypoint = null;
  let detach = false;
  const env = { PATH: process.env.PATH };
  const mounts = [];
  for (; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("-")) break;
    if (arg === "-d") detach = true;
    if (!WITH_VALUE.has(arg)) continue;
    const value = rest[++i];
    if (arg === "--name") name = value;
    else if (arg === "--entrypoint") entrypoint = value;
    else if (arg === "--workdir") workdir = value;
    else if (arg === "--mount") mounts.push(Object.fromEntries(value.split(",").map((f) => f.split("="))));
    else if (arg === "--env") {
      const eq = value.indexOf("=");
      if (eq === -1) {
        if (process.env[value] !== undefined) env[value] = process.env[value];
      } else env[value.slice(0, eq)] = value.slice(eq + 1);
    }
  }
  const mapPath = (arg) => {
    const mount = mounts.find((m) => m.target !== m.source && arg.startsWith(m.target + "/"));
    return mount ? mount.source + arg.slice(mount.target.length) : arg;
  };
  const command = [...(entrypoint ? [entrypoint] : []), ...rest.slice(i + 1)].map(mapPath);
  // The container's HOME is a host directory bound there: map it back.
  const home = mounts.find((m) => m.target === env.HOME);
  if (home) env.HOME = home.source;
  // Container names resolve to this host.
  for (const [key, value] of Object.entries(env)) {
    env[key] = value.replace(/@([A-Za-z0-9_.-]+):/g, (whole, host) => (existsSync(join(state, host)) ? "@127.0.0.1:" : whole));
  }
  if (detach) {
    // The proxy's log paths in its config are container paths: the fake maps its config file.
    const configArg = command.find((arg) => arg.endsWith("config.json"));
    if (configArg && existsSync(configArg)) {
      const config = JSON.parse(readFileSync(configArg, "utf8"));
      for (const key of ["log", "ready"]) if (config[key]) config[key] = mapPath(config[key]);
      writeFileSync(configArg, JSON.stringify(config));
    }
    const child = spawn(command[0], command.slice(1), { cwd: workdir, env: { ...env, ODW_EGRESS_PORT: "0" }, detached: true, stdio: "ignore" });
    child.unref();
    writeFileSync(join(state, name), String(child.pid));
    process.stdout.write(`fake-${name}\n`);
    process.exit(0);
  }
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
