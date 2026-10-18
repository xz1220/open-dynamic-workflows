/**
 * The egress allowlist of a container sandbox (ODW extension): the matcher,
 * the tighten-only intersection, the config, the proxy against local test
 * servers (allowed, denied, logged; in process and as its standalone
 * script), and the argv of the internal network, the sidecar, the cleanup
 * and the backstop — no engine. The run path against a fake engine is in
 * egress-run.test.ts.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { loadConfig } from "../src/adapters/config.ts";
import {
  buildEgressAllow,
  egressProxyScript,
  hostAllowed,
  intersectAllow,
  normalizeAllowEntry,
  startEgressProxy,
} from "../src/adapters/egress.ts";
import {
  DEFAULT_NETWORK,
  NO_PROXY,
  PROXY_DIR,
  PROXY_LOG_DIR,
  egressCleanupArgvs,
  networkConnectArgv,
  networkCreateArgv,
  parseDenial,
  proxyEnv,
  proxyRunArgv,
} from "../src/adapters/egress-run.ts";
import {
  CONTAINER_DEFAULTS,
  CONTAINER_HOME,
  TMPFS,
  backstopCommands,
  containerArgv,
  describeContainer,
  planSandbox,
  sandboxView,
  type ContainerRun,
} from "../src/adapters/sandbox.ts";
import type { ContainerSandbox } from "../src/adapters/types.ts";
import { ConfigError } from "../src/errors.ts";

const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "odw-egress-"));
  made.push(dir);
  return dir;
}

const box = (over: Partial<ContainerSandbox> = {}): ContainerSandbox => ({ ...CONTAINER_DEFAULTS, image: "odw-agents:1", mounts: [], ...over });
const allow = (...hosts: string[]) => ({ allow: hosts });

// --- the matcher ---------------------------------------------------------------

test("hostAllowed: exact hosts, *. wildcards over subdomains only, ports 443/80 unless one is named", () => {
  const list = ["api.anthropic.com", "*.npmjs.org", "example.com:8443"];
  assert.equal(hostAllowed(list, "api.anthropic.com", 443), true);
  assert.equal(hostAllowed(list, "API.Anthropic.com.", 443), true, "case and a trailing dot do not matter");
  assert.equal(hostAllowed(list, "api.anthropic.com", 80), true);
  assert.equal(hostAllowed(list, "api.anthropic.com", 22), false, "no port named: only 443 and 80");
  assert.equal(hostAllowed(list, "evil-api.anthropic.com", 443), false);
  assert.equal(hostAllowed(list, "anthropic.com", 443), false);
  assert.equal(hostAllowed(list, "registry.npmjs.org", 443), true);
  assert.equal(hostAllowed(list, "a.b.npmjs.org", 443), true, "any depth");
  assert.equal(hostAllowed(list, "npmjs.org", 443), false, "a wildcard is not its own domain");
  assert.equal(hostAllowed(list, "npmjs.org.evil.com", 443), false);
  assert.equal(hostAllowed(list, "evilnpmjs.org", 443), false);
  assert.equal(hostAllowed(list, "example.com", 8443), true);
  assert.equal(hostAllowed(list, "example.com", 443), false, "a named port is the only one");
  assert.equal(hostAllowed(list, "example.com", 0), false);
});

test("hostAllowed: IP literals are refused unless listed — a wildcard never matches one, nor a numeric name", () => {
  assert.equal(hostAllowed(["*.0.0.1", "*.com"], "127.0.0.1", 443), false);
  assert.equal(hostAllowed(["api.anthropic.com"], "160.79.104.10", 443), false);
  assert.equal(hostAllowed(["10.0.0.5"], "10.0.0.5", 443), true);
  assert.equal(hostAllowed(["10.0.0.5:5432"], "10.0.0.5", 5432), true);
  assert.equal(hostAllowed(["[::1]:8080"], "::1", 8080), true);
  assert.equal(hostAllowed(["[::1]:8080"], "[::1]", 8080), true);
  assert.equal(hostAllowed(["*.com"], "::1", 443), false);
  // Names a resolver could read as an address.
  assert.equal(hostAllowed(["*.1"], "2130706433", 443), false);
  assert.equal(hostAllowed(["*.1"], "0x7f.1", 443), false);
  assert.equal(hostAllowed(["*.com"], "a b.com", 443), false);
});

test("normalizeAllowEntry and the config: hosts, wildcards, IPs and ports; '*' and junk are ConfigErrors", () => {
  assert.equal(normalizeAllowEntry("API.Anthropic.com.", "x"), "api.anthropic.com");
  assert.equal(normalizeAllowEntry("*.NPMJS.org", "x"), "*.npmjs.org");
  assert.equal(normalizeAllowEntry("example.com:8443", "x"), "example.com:8443");
  assert.equal(normalizeAllowEntry("10.0.0.5", "x"), "10.0.0.5");
  assert.equal(normalizeAllowEntry("[::1]:80", "x"), "[::1]:80");
  for (const bad of ["*", "*.", "https://api.anthropic.com", "a.com:0", "a.com:70000", "a..com", "*.*.com", "1.2.3", "[nope]", "", 42]) {
    assert.throws(() => normalizeAllowEntry(bad, "sandbox.network.allow[0]"), ConfigError, String(bad));
  }
  assert.deepEqual(buildEgressAllow({ allow: "adapter" }, "n"), { allow: ["adapter"] });
  assert.deepEqual(buildEgressAllow({ allow: ["adapter", "A.com", "a.com"], proxyImage: "node:22" }, "n"), {
    allow: ["adapter", "a.com"],
    proxyImage: "node:22",
  });
  assert.throws(() => buildEgressAllow({ allow: ["a.com"], deny: [] }, "sandbox.network"), /unknown field "deny"/);
  assert.throws(() => buildEgressAllow({}, "sandbox.network"), /sandbox.network.allow must be "adapter" or a list/);

  const dir = tmp();
  const file = join(dir, "odw.config.json");
  writeFileSync(
    file,
    JSON.stringify({
      sandbox: { kind: "container", image: "odw-agents:1", network: { allow: ["api.anthropic.com", "*.npmjs.org"] } },
      adapters: { mine: { command: ["mine"], egressHosts: ["api.example.com"] } },
    }),
  );
  const config = loadConfig(file, { quiet: true });
  assert.deepEqual((config.settings.sandbox as ContainerSandbox).network, { allow: ["api.anthropic.com", "*.npmjs.org"] });
  assert.deepEqual(config.adapters.mine!.egressHosts, ["api.example.com"]);
  assert.deepEqual(config.adapters.claude!.egressHosts, ["api.anthropic.com", "claude.ai", "platform.claude.com"]);
  assert.ok(config.adapters.codex!.egressHosts!.includes("api.openai.com"));
  assert.ok(config.adapters.codex!.egressHosts!.includes("chatgpt.com"));
  assert.ok(config.adapters.gemini!.egressHosts!.length > 0);
  assert.ok(config.adapters.agy!.egressHosts!.length > 0);
  writeFileSync(file, JSON.stringify({ sandbox: { kind: "container", image: "i", network: { allow: ["*"] } } }));
  assert.throws(() => loadConfig(file, { quiet: true }), /cannot allow every host/);
  writeFileSync(file, JSON.stringify({ sandbox: { kind: "container", image: "i", network: "open" } }));
  assert.throws(() => loadConfig(file, { quiet: true }), /must be "none" or "default", or \{ "allow"/);
});

// --- tighten only ------------------------------------------------------------------

test("intersectAllow: exactly what both lists allow", () => {
  assert.deepEqual(intersectAllow(["*.npmjs.org", "a.com"], ["registry.npmjs.org", "b.com"]), ["registry.npmjs.org"]);
  assert.deepEqual(intersectAllow(["registry.npmjs.org"], ["*.npmjs.org"]), ["registry.npmjs.org"]);
  assert.deepEqual(intersectAllow(["*.a.com"], ["*.x.a.com"]), ["*.x.a.com"]);
  assert.deepEqual(intersectAllow(["a.com"], ["a.com:443"]), ["a.com:443"]);
  assert.deepEqual(intersectAllow(["a.com"], ["a.com:8443"]), [], "8443 is not one of a bare entry's ports");
  assert.deepEqual(intersectAllow(["10.0.0.5"], ["*.0.5"]), []);
  assert.deepEqual(intersectAllow(["a.com"], []), []);
});

test("planSandbox: allowlists — 'adapter' is the adapter's hosts; an adapter or a call only narrows; never back to default", () => {
  const claude = { egressHosts: ["api.anthropic.com", "claude.ai"] };
  const run = box({ network: allow("adapter", "*.npmjs.org") });
  assert.deepEqual(planSandbox(run, claude).box!.network, allow("api.anthropic.com", "claude.ai", "*.npmjs.org"));
  assert.deepEqual(planSandbox(box({ network: allow("adapter") }), {}).box!.network, allow(), "no hosts declared: none allowed");

  // An adapter's own list meets the run's.
  const adapter = { ...claude, sandbox: { kind: "container" as const, network: allow("api.anthropic.com", "registry.npmjs.org", "evil.com") } };
  assert.deepEqual(planSandbox(run, adapter).box!.network, allow("api.anthropic.com", "registry.npmjs.org"));
  // On a default network, an adapter's list is the list; "none" wins over any.
  assert.deepEqual(planSandbox(box(), adapter).box!.network, adapter.sandbox.network);
  assert.equal(planSandbox(box({ network: "none" }), adapter).box!.network, "none");

  // A call: a list narrows, "none" takes it away, "default" or a list where there is no network fails.
  assert.deepEqual(planSandbox(run, claude, { network: { allow: ["claude.ai", "x.com"] } }).box!.network, allow("claude.ai"));
  assert.deepEqual(planSandbox(box(), claude, { network: { allow: "adapter" } }).box!.network, allow("api.anthropic.com", "claude.ai"));
  assert.equal(planSandbox(run, claude, { network: "none" }).box!.network, "none");
  assert.match(planSandbox(run, claude, { network: "default" }).error ?? "", /would lift its sandbox's egress allowlist/);
  assert.match(planSandbox(box({ network: "none" }), claude, { network: { allow: ["a.com"] } }).error ?? "", /network its sandbox has none of/);
  assert.match(planSandbox(run, claude, { network: { allow: ["*"] } }).error ?? "", /cannot allow every host/);
});

test("sandboxView and describeContainer: an allowlist shows as one, with its hosts", () => {
  const b = box({ network: allow("api.anthropic.com", "claude.ai", "*.npmjs.org") });
  assert.deepEqual(sandboxView(b, () => true), {
    kind: "container",
    engine: "docker",
    image: "odw-agents:1",
    network: "allowlist",
    allow: ["api.anthropic.com", "claude.ai", "*.npmjs.org"],
  });
  assert.match(describeContainer(b, () => true), /network allowlist \(api\.anthropic\.com, claude\.ai \+1\)/);
  assert.match(describeContainer(box({ network: allow() }), () => true), /network allowlist \(empty: every host refused\)/);
});

// --- argv -------------------------------------------------------------------------------

test("argv: the internal network, the proxy sidecar, joining it, its variables, the cleanup", () => {
  assert.deepEqual(networkCreateArgv("docker", "odw-r1-net1-abcdef", "r1"), [
    "docker", "network", "create", "--internal", "--label", "odw.run=r1", "odw-r1-net1-abcdef",
  ]);
  assert.deepEqual(networkConnectArgv("docker", "odw-r1-net1-abcdef", "p"), ["docker", "network", "connect", "odw-r1-net1-abcdef", "p"]);
  assert.equal(DEFAULT_NETWORK.docker, "bridge");
  const proxy = proxyRunArgv({
    engine: "podman",
    image: "odw-agents:1",
    name: "odw-r1-egress1-abcdef",
    network: DEFAULT_NETWORK.podman,
    user: { uid: 1000, gid: 1000 },
    runId: "r1",
    configDir: "/tmp/odw-egress-x",
    logDir: "/runs/r1/egress",
  });
  assert.deepEqual(proxy, [
    "podman", "run", "-d", "--init", "--pull", "never", "--name", "odw-r1-egress1-abcdef",
    "--label", "odw.run=r1", "--label", "odw.role=egress-proxy",
    "--user", "1000:1000", "--userns", "keep-id",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--tmpfs", TMPFS, "--pids-limit", "64",
    "--network", "podman",
    "--mount", `type=bind,source=/tmp/odw-egress-x,target=${PROXY_DIR},readonly`,
    "--mount", `type=bind,source=/runs/r1/egress,target=${PROXY_LOG_DIR}`,
    "--entrypoint", "node", "odw-agents:1", `${PROXY_DIR}/proxy.mjs`, `${PROXY_DIR}/config.json`,
  ]);
  const env = proxyEnv("odw-r1-egress1-abcdef", 3128, 7);
  assert.equal(env.HTTPS_PROXY, "http://7:odw@odw-r1-egress1-abcdef:3128");
  assert.equal(env.http_proxy, env.HTTPS_PROXY);
  assert.equal(env.NO_PROXY, NO_PROXY);
  assert.equal(env.NODE_USE_ENV_PROXY, "1");
  assert.equal(proxyEnv("p", 3128, "c2").HTTP_PROXY, "http://c2:odw@p:3128");

  // The agent joins the internal network — not none, not the default — with the proxy set by value.
  const agent: ContainerRun = {
    engine: "docker",
    image: "odw-agents:1",
    name: "odw-r1-3-abcdef",
    user: null,
    workdir: "/w",
    mounts: [{ source: "/tmp/h", target: CONTAINER_HOME, readonly: false }],
    network: allow("api.anthropic.com"),
    networkName: "odw-r1-net1-abcdef",
    passEnv: ["ANTHROPIC_API_KEY"],
    setEnv: { HOME: CONTAINER_HOME, ...env },
    memory: null,
    cpus: null,
    pids: 512,
    labels: {},
    command: ["claude"],
  };
  const argv = containerArgv(agent);
  assert.deepEqual(argv.slice(argv.indexOf("--network"), argv.indexOf("--network") + 2), ["--network", "odw-r1-net1-abcdef"]);
  assert.equal(argv.filter((a) => a === "--network").length, 1);
  assert.ok(argv.includes(`HTTPS_PROXY=${env.HTTPS_PROXY}`));
  assert.throws(() => containerArgv({ ...agent, networkName: undefined }), /needs its run's internal network/);

  assert.deepEqual(egressCleanupArgvs("docker", ["p1", "p2"], ["n1", "n2"]), [
    ["docker", "rm", "--force", "p1", "p2"],
    ["docker", "network", "rm", "n1"],
    ["docker", "network", "rm", "n2"],
  ]);
  assert.deepEqual(egressCleanupArgvs("docker", [], []), []);
});

test("backstopCommands: rm --force per container; with networks, one shell that removes containers first, names as arguments", async () => {
  assert.deepEqual(backstopCommands("docker", ["a", "b"], []), [
    ["docker", ["rm", "--force", "a"]],
    ["docker", ["rm", "--force", "b"]],
  ]);
  const [[file, args]] = backstopCommands("podman", ["agent-1", "proxy-1"], ["net-1", "net-2"]) as [[string, string[]]];
  assert.equal(file, "/bin/sh");
  assert.deepEqual(args.slice(2), ["odw-backstop", "podman", "net-1 net-2", "agent-1", "proxy-1"]);
  // What it runs, in order, with a stand-in engine.
  const dir = tmp();
  const engine = join(dir, "engine");
  writeFileSync(engine, `#!/bin/sh\necho "$*" >> ${join(dir, "log")}\n`, { mode: 0o755 });
  const [[, real]] = backstopCommands("docker", ["c1", "c2"], ["n1", "n2"]) as [[string, string[]]];
  real[3] = engine;
  await new Promise((done) => spawn("/bin/sh", real, { stdio: "ignore" }).on("exit", done));
  assert.deepEqual(readFileSync(join(dir, "log"), "utf8").trim().split("\n"), ["rm --force c1 c2", "network rm n1", "network rm n2"]);
});

test("parseDenial: an agent id or a step's, else null; junk lines are skipped", () => {
  assert.deepEqual(parseDenial('{"ts":1,"host":"evil.com","port":443,"agent":"3","method":"CONNECT"}'), {
    host: "evil.com",
    port: 443,
    method: "CONNECT",
    agent: 3,
  });
  assert.deepEqual(parseDenial('{"ts":1,"host":"x.org","port":80,"agent":"c2","method":"HTTP"}'), {
    host: "x.org",
    port: 80,
    method: "HTTP",
    agent: null,
    commandId: 2,
  });
  assert.equal(parseDenial('{"host":"x","agent":null}')!.agent, null);
  assert.equal(parseDenial("not json"), null);
  assert.equal(parseDenial('{"port":1}'), null);
});

// --- the proxy ---------------------------------------------------------------------------

/** A local server that answers `hello` to HTTP, and echoes whatever a raw TCP client sends. */
async function upstream(): Promise<{ port: number; close: () => void }> {
  const server = http.createServer((req, res) => res.end(`hello ${req.url}`));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { port: (server.address() as net.AddressInfo).port, close: () => server.close() };
}

/** CONNECT through the proxy; resolves with the status and, when tunnelled, what an HTTP GET over it returned. */
function connect(proxyPort: number, target: string, user = "4"): Promise<{ status: number; body?: string }> {
  return new Promise((done, fail) => {
    const socket = net.connect(proxyPort, "127.0.0.1");
    let data = "";
    let tunnelled = false;
    socket.on("connect", () =>
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Basic ${Buffer.from(`${user}:odw`).toString("base64")}\r\n\r\n`),
    );
    socket.on("data", (chunk) => {
      data += chunk;
      if (!tunnelled) {
        const m = /^HTTP\/1\.1 (\d{3})[^\r]*\r\n(?:[^\r]*\r\n)*\r\n/.exec(data);
        if (!m) return;
        const status = Number(m[1]);
        if (status !== 200) {
          socket.destroy();
          done({ status });
          return;
        }
        tunnelled = true;
        data = "";
        socket.write(`GET /tunnel HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
      }
    });
    socket.on("end", () => tunnelled && done({ status: 200, body: data }));
    socket.on("error", fail);
  });
}

async function listening(ready: string): Promise<number> {
  const end = Date.now() + 10_000;
  while (!existsSync(ready) || readFileSync(ready, "utf8") === "") {
    if (Date.now() > end) throw new Error("the proxy never listened");
    await new Promise((r) => setTimeout(r, 20));
  }
  return Number(readFileSync(ready, "utf8"));
}

const denials = (log: string) =>
  existsSync(log)
    ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];

test("the proxy: CONNECT to an allowlisted host:port tunnels; others get 403 and a log line naming the agent", async () => {
  const up = await upstream();
  const dir = tmp();
  const log = join(dir, "denied.jsonl");
  const ready = join(dir, "ready");
  const server = startEgressProxy({ allow: [`127.0.0.1:${up.port}`], port: 0, listen: "127.0.0.1", log, ready });
  try {
    const port = await listening(ready);
    const ok = await connect(port, `127.0.0.1:${up.port}`);
    assert.equal(ok.status, 200);
    assert.match(ok.body ?? "", /hello \/tunnel/);
    assert.deepEqual(denials(log), [], "nothing allowed is logged");

    assert.equal((await connect(port, `localhost:${up.port}`)).status, 403, "not the name: the literal is what is listed");
    assert.equal((await connect(port, "127.0.0.1:22", "c9")).status, 403, "not another port");
    assert.equal((await connect(port, "example.org:443")).status, 403);
    assert.deepEqual(
      denials(log).map((d) => [d.method, d.host, d.port, d.agent]),
      [
        ["CONNECT", "localhost", up.port, "4"],
        ["CONNECT", "127.0.0.1", 22, "c9"],
        ["CONNECT", "example.org", 443, "4"],
      ],
    );

    // Plain HTTP: forwarded to an allowed host, refused (and logged) otherwise, with no user name: agent null.
    const get = (url: string) =>
      new Promise<{ status: number; body: string }>((done, fail) => {
        const req = http.request({ host: "127.0.0.1", port, path: url, method: "GET" }, (res) => {
          let body = "";
          res.on("data", (c) => (body += c)).on("end", () => done({ status: res.statusCode!, body }));
        });
        req.on("error", fail).end();
      });
    assert.deepEqual(await get(`http://127.0.0.1:${up.port}/plain`), { status: 200, body: "hello /plain" });
    assert.equal((await get("http://example.org/")).status, 403);
    assert.equal((await get("/relative")).status, 400);
    assert.deepEqual(denials(log).at(-1), { ...denials(log).at(-1), method: "HTTP", host: "example.org", port: 80, agent: null });
  } finally {
    server.close();
    up.close();
  }
});

test("the proxy's standalone script: the same code runs under plain node, with the port from ODW_EGRESS_PORT", async () => {
  const up = await upstream();
  const dir = tmp();
  writeFileSync(join(dir, "proxy.mjs"), egressProxyScript());
  const log = join(dir, "denied.jsonl");
  const ready = join(dir, "ready");
  writeFileSync(join(dir, "config.json"), JSON.stringify({ allow: [`127.0.0.1:${up.port}`], port: 3128, listen: "127.0.0.1", log, ready }));
  const child = spawn(process.execPath, [join(dir, "proxy.mjs"), join(dir, "config.json")], {
    env: { PATH: process.env.PATH, ODW_EGRESS_PORT: "0" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  try {
    const port = await listening(ready).catch((err) => {
      throw new Error(`${err.message}: ${stderr}`);
    });
    assert.notEqual(port, 3128);
    assert.equal((await connect(port, `127.0.0.1:${up.port}`)).status, 200);
    assert.equal((await connect(port, "denied.example:443", "2")).status, 403);
    assert.deepEqual(denials(log).map((d) => [d.host, d.agent]), [["denied.example", "2"]]);
  } finally {
    child.kill("SIGTERM");
    up.close();
  }
});
