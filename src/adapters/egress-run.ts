/**
 * An egress allowlist at run time (an ODW extension; see ./egress): the
 * run's internal networks and their proxy sidecars.
 *
 * The first container of a run whose sandbox has an allowlist brings up, for
 * that allowlist (and proxy image):
 *
 *   <engine> network create --internal --label odw.run=<run> odw-<run>-net<n>-<rand>
 *   <engine> run -d --init --pull never --name odw-<run>-egress<n>-<rand> --network <bridge|podman>
 *            --user <you> --cap-drop ALL --read-only … --entrypoint node <image> /odw/egress-proxy/proxy.mjs …
 *   <engine> network connect <that network> <the proxy>
 *   <engine> inspect --format <its IP on that network> <the proxy>
 *
 * — the proxy is the network's only way out, and listens only on its address
 * there (written to its config directory once known), so it is no open proxy
 * for the engine's default network — and every container with that
 * allowlist joins the network (`--network`) with `HTTPS_PROXY`, `HTTP_PROXY`
 * (and their lower-case spellings) pointing at the proxy, its agent id as the
 * proxy user name so a denial names the agent, `NO_PROXY` for loopback, and
 * `NODE_USE_ENV_PROXY=1` so Node's own fetch honours them. Agents with
 * another allowlist get a network and a proxy of their own: an agent can
 * reach no proxy but its own.
 *
 * The proxy's script and its config are written to a private temporary
 * directory, bound read-only; it appends each denial to
 * `<run dir>/egress/proxy<n>.jsonl`, which the run tails into
 * `egress_denied` events. At the run's end the proxies are removed and then
 * the networks; the worker's backstop does the same (./sandbox).
 *
 * The argv is built by pure functions, unit-tested without an engine.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigError } from "../errors.js";
import { EGRESS_LOG_MAX_BYTES, EGRESS_PORT, egressProxyScript, type EgressAllow, type EgressDenial, type EgressProxyConfig } from "./egress.js";
import type { CommandRunner } from "./runner.js";
import { clientEnv, containerName, hostUser, TMPFS, trackContainer, trackNetwork, type SandboxEngine } from "./sandbox.js";

/** Where the proxy's script and config are bound in its container. */
export const PROXY_DIR = "/odw/egress-proxy";
/** Where its denial log and ready file are bound. */
export const PROXY_LOG_DIR = "/odw/egress-log";
/** The file in {@link PROXY_DIR} that tells it the address to listen on. */
export const LISTEN_FILE = "listen";

/** The engine's default network: what the proxy also joins, to reach out. */
export const DEFAULT_NETWORK: Record<SandboxEngine, string> = { docker: "bridge", podman: "podman" };

/** Variables that leave loopback alone. */
export const NO_PROXY = "localhost,127.0.0.1,::1";

/** `<engine> network create --internal`: a network with no route out. */
export function networkCreateArgv(engine: SandboxEngine, name: string, runId: string | undefined): string[] {
  return [engine, "network", "create", "--internal", "--label", `odw.run=${runId ?? "none"}`, name];
}

/** `<engine> inspect`: a container's IP address on `network` (empty when it has none). */
export function proxyAddressArgv(engine: SandboxEngine, network: string, container: string): string[] {
  return [engine, "inspect", "--format", `{{with index .NetworkSettings.Networks ${JSON.stringify(network)}}}{{.IPAddress}}{{end}}`, container];
}

/** `<engine> network connect <network> <container>`. */
export function networkConnectArgv(engine: SandboxEngine, network: string, container: string): string[] {
  return [engine, "network", "connect", network, container];
}

/** Everything the proxy sidecar's `run` needs. */
export interface ProxyRun {
  engine: SandboxEngine;
  image: string;
  name: string;
  /** The network it starts on: the engine's default (it joins the internal one after). */
  network: string;
  user: { uid: number; gid: number } | null;
  runId: string | undefined;
  /** The host directory with its script and config (bound read-only). */
  configDir: string;
  /** The host directory its denial log and ready file go to (bound read-write). */
  logDir: string;
}

/** The proxy sidecar's argv: as locked down as an agent's container, detached, on the engine's default network. */
export function proxyRunArgv(run: ProxyRun): string[] {
  const argv = [run.engine, "run", "-d", "--init", "--pull", "never", "--name", run.name];
  argv.push("--label", `odw.run=${run.runId ?? "none"}`, "--label", "odw.role=egress-proxy");
  if (run.user) {
    argv.push("--user", `${run.user.uid}:${run.user.gid}`);
    if (run.engine === "podman") argv.push("--userns", "keep-id");
  }
  argv.push("--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--tmpfs", TMPFS, "--pids-limit", "64");
  argv.push("--network", run.network);
  argv.push("--mount", `type=bind,source=${run.configDir},target=${PROXY_DIR},readonly`);
  argv.push("--mount", `type=bind,source=${run.logDir},target=${PROXY_LOG_DIR}`);
  argv.push("--entrypoint", "node", run.image, `${PROXY_DIR}/proxy.mjs`, `${PROXY_DIR}/config.json`);
  return argv;
}

/** The variables a container behind the proxy gets: its agent id as the proxy user name. */
export function proxyEnv(proxy: string, port: number, agentId?: number | string): Record<string, string> {
  const user = agentId === undefined ? "odw" : String(agentId).replace(/[^A-Za-z0-9_.-]/g, "-");
  const url = `http://${user}:odw@${proxy}:${port}`;
  return {
    HTTPS_PROXY: url,
    HTTP_PROXY: url,
    https_proxy: url,
    http_proxy: url,
    NO_PROXY,
    no_proxy: NO_PROXY,
    NODE_USE_ENV_PROXY: "1",
  };
}

/** What a run's end runs: the proxies removed, then the networks. */
export function egressCleanupArgvs(engine: SandboxEngine, proxies: string[], networks: string[]): string[][] {
  return [...(proxies.length > 0 ? [[engine, "rm", "--force", ...proxies]] : []), ...networks.map((name) => [engine, "network", "rm", name])];
}

/** One allowlist's way out, up and listening. */
export interface EgressHandle {
  engine: SandboxEngine;
  network: string;
  proxy: string;
  port: number;
}

/** A denial as the run records it: `egress_denied` with these fields. */
export interface EgressDeniedEvent {
  host: string;
  port: number | null;
  method: string;
  /** The agent whose CLI asked; null when it did not say (a CLI that drops the proxy's user name). */
  agent: number | null;
  /** The exec() step that asked, instead of an agent. */
  commandId?: number;
}

export interface EgressProxiesOptions {
  runner: CommandRunner;
  runId?: string;
  /** The run's directory: denial logs go to its `egress/`. Absent: a temporary directory, removed at close. */
  runDir?: string;
  onDenied?: (denial: EgressDeniedEvent) => void;
  /** Told once, at the end, how many denials were not reported past {@link EGRESS_DENIALS_MAX}. */
  onNote?: (message: string, fields: Record<string, unknown>) => void;
  /** The host's environment, for the engine client. */
  hostEnv?: Record<string, string | undefined>;
  /** How long a proxy may take to listen (ms). */
  readyTimeoutMs?: number;
  /** How often the denial logs are read (ms). */
  pollMs?: number;
}

/** Denials a run reports as `egress_denied` events, at most; past it they are counted, and said once at its end. */
export const EGRESS_DENIALS_MAX = 200;

/** A run's egress proxies: brought up on first use, tailed while it runs, removed at its end. */
export class EgressProxies {
  private readonly started = new Map<string, Promise<EgressHandle>>();
  private readonly proxies: Array<{ engine: SandboxEngine; name: string; configDir: string; untrack: () => void }> = [];
  private readonly networks: Array<{ engine: SandboxEngine; name: string; untrack: () => void }> = [];
  private readonly logs: Array<{ path: string; offset: number; rest: string }> = [];
  private logDir: string | undefined;
  private ownLogDir = false;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  private count = 0;
  private reported = 0;
  private dropped = 0;
  private logCapped = false;

  constructor(private readonly opts: EgressProxiesOptions) {}

  /** The way out for `allow` on `engine` with `image`: one per distinct allowlist and image, started once. */
  for(engine: SandboxEngine, image: string, egress: EgressAllow): Promise<EgressHandle> {
    if (this.closed) return Promise.reject(new Error("sandbox: the run's egress proxies are closed"));
    const proxyImage = egress.proxyImage ?? image;
    const key = JSON.stringify([engine, proxyImage, [...egress.allow].sort()]);
    let handle = this.started.get(key);
    if (!handle) {
      handle = this.start(engine, proxyImage, egress.allow, proxyImage !== image);
      this.started.set(key, handle);
    }
    return handle;
  }

  /** The variables of a container behind `handle`'s proxy. */
  env(handle: EgressHandle, agentId?: number | string): Record<string, string> {
    return proxyEnv(handle.proxy, handle.port, agentId);
  }

  private async start(engine: SandboxEngine, image: string, allow: string[], inspectImage: boolean): Promise<EgressHandle> {
    const env = clientEnv(this.opts.hostEnv ?? process.env);
    const n = ++this.count;
    if (!this.logDir) {
      if (this.opts.runDir) this.logDir = join(this.opts.runDir, "egress");
      else {
        this.logDir = await mkdtemp(join(tmpdir(), "odw-egress-log-"));
        this.ownLogDir = true;
      }
      mkdirSync(this.logDir, { recursive: true });
    }
    const logDir = this.logDir;
    // The agent's image is known to be there; a proxy image of its own is asked for here.
    if (inspectImage) {
      const inspect = await this.opts.runner([engine, "image", "inspect", "--format", "{{.Id}}", image], { timeout: 30, env });
      if (inspect.returncode !== 0) {
        throw new ConfigError(`sandbox: the egress proxy's image '${image}' is not present in ${engine} (ODW never pulls) — build it, or set network.proxyImage`);
      }
    }
    // Its script and config: private, outside every workspace, bound read-only.
    const configDir = await mkdtemp(join(tmpdir(), "odw-egress-"));
    const config: EgressProxyConfig = {
      allow,
      port: EGRESS_PORT,
      log: `${PROXY_LOG_DIR}/proxy${n}.jsonl`,
      ready: `${PROXY_LOG_DIR}/proxy${n}.ready`,
      // It listens only on its address on the internal network, written here once it has one.
      listenFrom: `${PROXY_DIR}/${LISTEN_FILE}`,
    };
    await writeFile(join(configDir, "proxy.mjs"), egressProxyScript(), { mode: 0o644 });
    await writeFile(join(configDir, "config.json"), JSON.stringify(config), { mode: 0o644 });
    const network = containerName(this.opts.runId, `net${n}`);
    const proxy = containerName(this.opts.runId, `egress${n}`);
    const fail = (what: string, said: string): never => {
      throw new ConfigError(`sandbox: could not ${what} for the egress allowlist${said ? `; ${engine} said: ${said.trim().split("\n")[0]!.slice(0, 200)}` : ""}`);
    };
    const created = await this.opts.runner(networkCreateArgv(engine, network, this.opts.runId), { timeout: 60, env });
    if (created.returncode !== 0) {
      await rm(configDir, { recursive: true, force: true });
      fail(`create the run's internal network`, created.stderr || created.stdout);
    }
    this.networks.push({ engine, name: network, untrack: trackNetwork(network, engine) });
    this.proxies.push({ engine, name: proxy, configDir, untrack: trackContainer(proxy, engine, configDir) });
    const readyFile = join(logDir, `proxy${n}.ready`);
    const logFile = join(logDir, `proxy${n}.jsonl`);
    this.logs.push({ path: logFile, offset: 0, rest: "" });
    const ran = await this.opts.runner(
      // It starts on the engine's default network — its way out, and its DNS — and then joins the internal one.
      proxyRunArgv({ engine, image, name: proxy, network: DEFAULT_NETWORK[engine], user: hostUser(), runId: this.opts.runId, configDir, logDir }),
      { timeout: 60, env },
    );
    if (ran.returncode !== 0) fail("start the egress proxy", ran.stderr || ran.stdout);
    const connected = await this.opts.runner(networkConnectArgv(engine, network, proxy), { timeout: 60, env });
    if (connected.returncode !== 0) fail("connect the egress proxy to the run's internal network", connected.stderr || connected.stdout);
    // Not every interface: on the default network it would be an open proxy for every container there.
    const inspected = await this.opts.runner(proxyAddressArgv(engine, network, proxy), { timeout: 30, env });
    const address = inspected.stdout.trim();
    if (inspected.returncode !== 0 || !isIP(address)) {
      fail("find the egress proxy's address on the run's internal network", inspected.stderr || inspected.stdout);
    }
    const listenTmp = join(configDir, `.${LISTEN_FILE}`);
    await writeFile(listenTmp, address, { mode: 0o644 });
    await rename(listenTmp, join(configDir, LISTEN_FILE));
    const port = await this.waitReady(readyFile);
    if (port === null) {
      const logs = await this.opts.runner([engine, "logs", proxy], { timeout: 15, env }).catch(() => null);
      fail("start the egress proxy (it never listened; its image needs node on PATH)", logs ? logs.stderr || logs.stdout : "");
    }
    this.tail();
    return { engine, network, proxy, port: port! };
  }

  private async waitReady(file: string): Promise<number | null> {
    const end = Date.now() + (this.opts.readyTimeoutMs ?? 30_000);
    while (Date.now() < end) {
      if (existsSync(file)) {
        const port = Number(readFileSync(file, "utf8").trim());
        if (Number.isInteger(port) && port > 0) return port;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  }

  private tail(): void {
    if (this.timer || !this.opts.onDenied) return;
    this.timer = setInterval(() => this.drain(), this.opts.pollMs ?? 500);
    this.timer.unref();
  }

  /** Read what the logs gained since last time, and report each denial. */
  drain(): void {
    for (const log of this.logs) {
      if (!existsSync(log.path)) continue;
      const size = statSync(log.path).size;
      if (size <= log.offset) continue;
      const fd = openSync(log.path, "r");
      try {
        const buffer = Buffer.alloc(size - log.offset);
        readSync(fd, buffer, 0, buffer.length, log.offset);
        log.offset = size;
        const lines = (log.rest + buffer.toString("utf8")).split("\n");
        log.rest = lines.pop() ?? "";
        for (const line of lines) {
          if (line === '{"capped":true}') this.logCapped = true;
          const denial = parseDenial(line);
          if (!denial) continue;
          if (this.reported < EGRESS_DENIALS_MAX) {
            this.reported++;
            this.opts.onDenied?.(denial);
          } else {
            this.dropped++;
          }
        }
      } finally {
        closeSync(fd);
      }
    }
  }

  /** Stop tailing (after a last read), then remove every proxy and then every network. Never throws. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled([...this.started.values()]);
    if (this.timer) clearInterval(this.timer);
    try {
      this.drain();
    } catch {
      /* a log that cannot be read loses its last lines, nothing else */
    }
    if (this.dropped > 0 || this.logCapped) {
      const where = this.opts.runDir ? ` (all logged are in ${join(this.opts.runDir, "egress")})` : "";
      const parts: string[] = [];
      if (this.dropped > 0) {
        parts.push(`${EGRESS_DENIALS_MAX} egress denials were reported as events and ${this.dropped} more were not${where}`);
      }
      if (this.logCapped) parts.push(`a proxy's denial log reached ${EGRESS_LOG_MAX_BYTES / 1024 / 1024} MiB, and its later denials were not logged`);
      this.opts.onNote?.(parts.join("; "), { egress: "capped", dropped: this.dropped, logCapped: this.logCapped });
    }
    const env = clientEnv(this.opts.hostEnv ?? process.env);
    // Each is untracked only once its removal succeeded: what is left the worker's backstop tries again.
    const removed = new Set<string>();
    for (const engine of ["docker", "podman"] as const) {
      const proxies = this.proxies.filter((p) => p.engine === engine).map((p) => p.name);
      const networks = this.networks.filter((p) => p.engine === engine).map((p) => p.name);
      for (const argv of egressCleanupArgvs(engine, proxies, networks)) {
        const ran = await this.opts.runner(argv, { timeout: 30, env }).catch(() => null);
        if (ran?.returncode !== 0) continue;
        if (argv[1] === "rm") for (const name of proxies) removed.add(`container:${name}`);
        else removed.add(`network:${argv[argv.length - 1]}`);
      }
    }
    for (const proxy of this.proxies) {
      if (!removed.has(`container:${proxy.name}`)) continue;
      proxy.untrack();
      await rm(proxy.configDir, { recursive: true, force: true }).catch(() => undefined);
    }
    for (const network of this.networks) if (removed.has(`network:${network.name}`)) network.untrack();
    if (this.ownLogDir && this.logDir) await rm(this.logDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** One log line as an event's fields; null for a line that is not one. */
export function parseDenial(line: string): EgressDeniedEvent | null {
  let raw: Partial<EgressDenial>;
  try {
    raw = JSON.parse(line) as Partial<EgressDenial>;
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || typeof raw.host !== "string") return null;
  const who = typeof raw.agent === "string" ? raw.agent : "";
  const out: EgressDeniedEvent = {
    host: raw.host,
    port: typeof raw.port === "number" ? raw.port : null,
    method: raw.method === "HTTP" ? "HTTP" : "CONNECT",
    agent: /^\d+$/.test(who) ? Number(who) : null,
  };
  const step = /^c(\d+)$/.exec(who);
  if (step) out.commandId = Number(step[1]);
  return out;
}
