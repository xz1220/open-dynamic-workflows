/**
 * The egress allowlist end to end (ODW extension), against the fake engine
 * (tests/fixtures/fake-docker.mjs as `docker`): the run's internal network,
 * the proxy sidecar — ODW's real proxy script, run on this host — agents and
 * exec() steps behind it, denials as `egress_denied` events, the cleanup at
 * the run's end and in the backstop, and the doctor's smoke request. No real
 * engine, image or model; the allowed host is a local server.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { loadConfig } from "../src/adapters/config.ts";
import { killAllAgentProcesses } from "../src/adapters/runner.ts";
import { EgressProxies } from "../src/adapters/egress-run.ts";
import { EGRESS_DNS, trackNetwork } from "../src/adapters/sandbox.ts";
import { runCommand } from "../src/adapters/runner.ts";
import { sandboxChecks } from "../src/doctor.ts";
import { RunStore } from "../src/runtime/run-store.ts";
import { foldAgents } from "../src/runtime/runs-view.ts";
import { executeRun } from "../src/runtime/worker.ts";

const FAKE = fileURLToPath(new URL("./fixtures/fake-docker.mjs", import.meta.url));

// The agent CLI "in the image": CONNECTs through $HTTPS_PROXY to each target its prompt names.
const AGENT = `#!/usr/bin/env node
const net = require("node:net");
let prompt = "";
process.stdin.on("data", (c) => (prompt += c)).on("end", async () => {
  const proxy = new URL(process.env.HTTPS_PROXY);
  const auth = Buffer.from(proxy.username + ":" + proxy.password).toString("base64");
  const ask = (target) => new Promise((done) => {
    const s = net.connect(Number(proxy.port), proxy.hostname);
    let data = "";
    s.on("connect", () => s.write("CONNECT " + target + " HTTP/1.1\\r\\nProxy-Authorization: Basic " + auth + "\\r\\n\\r\\n"));
    s.on("data", (c) => { data += c; const m = /^HTTP\\/1\\.1 (\\d+)/.exec(data); if (m) { s.destroy(); done(Number(m[1])); } });
    s.on("error", () => done(0));
  });
  const out = {};
  for (const target of prompt.match(/[a-z0-9.-]+\\.[a-z0-9]+:\\d+/g) ?? []) out[target] = await ask(target);
  out.dns = await new Promise((done) => require("node:dns").lookup("example.com", (err) => done(!err)));
  out.proxyUser = proxy.username;
  out.nodeProxy = process.env.NODE_USE_ENV_PROXY ?? null;
  process.stdout.write(JSON.stringify(out));
});
`;

let root = "";
let state = "";
let log = "";
let upstream: http.Server;
let allowed = "";
const saved: Record<string, string | undefined> = {};

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "odw-egress-run-")));
  const bin = join(root, "bin");
  state = join(root, "state");
  log = join(root, "docker.log");
  for (const dir of [bin, state]) mkdirSync(dir, { recursive: true });
  chmodSync(FAKE, 0o755);
  symlinkSync(FAKE, join(bin, "docker"));
  writeFileSync(join(bin, "egress-agent"), AGENT, { mode: 0o755 });
  upstream = http.createServer((_req, res) => res.end("ok"));
  await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done));
  allowed = `127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const env: Record<string, string> = {
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    DOCKER_FAKE_LOG: log,
    DOCKER_FAKE_STATE: state,
    DOCKER_FAKE_IMAGES: "odw-test:1",
  };
  for (const [name, value] of Object.entries(env)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
});

after(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  upstream.close();
  rmSync(root, { recursive: true, force: true });
});

const calls = (): string[][] =>
  existsSync(log)
    ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[])
    : [];
const valuesOf = (argv: string[], flag: string): string[] => argv.flatMap((arg, i) => (arg === flag ? [argv[i + 1]!] : []));

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}

function project(network: unknown): { source: string; configPath: string; store: RunStore } {
  const source = mkdtempSync(join(root, "repo-"));
  const configPath = join(source, "odw.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      sandbox: { kind: "container", engine: "docker", image: "odw-test:1", cliConfig: "none", network },
      adapters: { boxed: { command: ["egress-agent"], stdin: "{prompt}", egressHosts: [allowed] } },
      defaultAdapter: "boxed",
    }),
  );
  return { source, configPath, store: new RunStore(join(source, "runs")) };
}

test("a run with an allowlist: an internal network and a proxy; agents and steps go out through it; denials are events; all removed", async () => {
  const { source, configPath, store } = project({ allow: ["adapter"] });
  const script = join(source, "wf.js");
  writeFileSync(
    script,
    "export const meta = { name: 'egress', description: 'd' }\n" +
      `const agentSaw = JSON.parse(await agent('${allowed} denied.example:443'))\n` +
      `await agent('${allowed}', { label: 'again' })\n` +
      `const step = await exec(['egress-agent'], { input: 'blocked.example:443', network: 'default', check: false })\n` +
      "return { agentSaw, stepSaw: JSON.parse(step.stdout) }\n",
  );
  const before = calls().length;
  const id = store.create({ script, args: null, source, configPath });
  assert.equal(await executeRun(store.runDir(id)), "done", JSON.stringify(store.readEvents(id).slice(-3)));

  const result = store.readResult(id) as { agentSaw: Record<string, unknown>; stepSaw: Record<string, unknown> };
  assert.equal(result.agentSaw[allowed], 200, "the adapter's host is reachable through the proxy");
  assert.equal(result.agentSaw["denied.example:443"], 403);
  assert.equal(result.agentSaw.proxyUser, "1", "its agent id is its proxy user name");
  assert.equal(result.agentSaw.nodeProxy, "1");
  assert.equal(result.agentSaw.dns, false, "an outside name does not resolve in its container");
  // A step's "default" is the run's allowlist, less "adapter": nothing.
  assert.equal(result.stepSaw["blocked.example:443"], 403);
  assert.equal(result.stepSaw.proxyUser, "c1");

  const mine = calls().slice(before);
  // One internal network and proxy per distinct allowlist: the agents' (the
  // adapter's host), and the step's (empty) — an agent can reach no proxy but its own.
  const creates = mine.filter((a) => a[0] === "network" && a[1] === "create");
  assert.equal(creates.length, 2);
  for (const create of creates) assert.deepEqual(create.slice(0, 3), ["network", "create", "--internal"]);
  const nets = creates.map((a) => a.at(-1)!);
  const proxyRuns = mine.filter((a) => a[0] === "run" && a.includes("-d"));
  const proxies = proxyRuns.map((a) => valuesOf(a, "--name")[0]!);
  assert.deepEqual(proxyRuns.map((a) => valuesOf(a, "--network")), [["bridge"], ["bridge"]], "a proxy starts on the default network");
  proxies.forEach((proxy, i) => {
    assert.ok(mine.some((a) => a.join(" ") === `network connect ${nets[i]} ${proxy}`), "and joins its internal network");
  });
  const boxed = mine.filter((a) => a[0] === "run" && !a.includes("-d"));
  assert.equal(boxed.length, 3, "two agents and a step");
  const expectOn = [nets[0], nets[0], nets[1]];
  boxed.forEach((argv, i) => {
    assert.deepEqual(valuesOf(argv, "--network"), [expectOn[i]], "on its internal network only");
    assert.deepEqual(valuesOf(argv, "--dns"), [EGRESS_DNS], "with no resolver for the outside");
    const pattern = new RegExp(`^HTTPS_PROXY=http://(1|2|c1):odw@${proxies[i === 2 ? 1 : 0]}:\\d+$`);
    assert.ok(valuesOf(argv, "--env").some((e) => pattern.test(e)), "its proxy by value, its id as the user");
  });

  const [first] = foldAgents(store.readEvents(id));
  assert.deepEqual(first!.sandbox, { kind: "container", engine: "docker", image: "odw-test:1", network: "allowlist", allow: [allowed] });

  const denied = store.readEvents(id).filter((e) => e.type === "egress_denied");
  assert.deepEqual(
    denied.map((e) => ({ host: e.host, port: e.port, agent: e.agent, commandId: e.commandId, method: e.method })),
    [
      { host: "denied.example", port: 443, agent: 1, commandId: undefined, method: "CONNECT" },
      { host: "blocked.example", port: 443, agent: null, commandId: 1, method: "CONNECT" },
    ],
  );
  const finished = store.readEvents(id).findIndex((e) => e.type === "run_finished");
  assert.ok(store.readEvents(id).findIndex((e) => e.type === "egress_denied") < finished, "denials are in before the run ends");
  assert.ok(existsSync(join(store.runDir(id), "egress", "proxy1.jsonl")));

  // The proxy, then the network, removed: nothing of the run left in the engine.
  const rmProxy = mine.findIndex((a) => a.join(" ") === `rm --force ${proxies.join(" ")}`);
  const rmNet = mine.findIndex((a) => a.join(" ") === `network rm ${nets[0]}`);
  assert.ok(rmProxy !== -1 && rmNet > rmProxy, "the proxy first, then its network");
  assert.deepEqual(readdirSync(state), [], "no container or network left");
});

test("a proxy image that is not there fails the run before any network is made", async () => {
  const { source, configPath, store } = project({ allow: ["adapter"], proxyImage: "no-such-proxy:1" });
  const script = join(source, "wf.js");
  writeFileSync(script, "export const meta = { name: 'egress-missing', description: 'd' }\nreturn await agent('x')\n");
  const before = calls().length;
  const id = store.create({ script, args: null, source, configPath });
  assert.equal(await executeRun(store.runDir(id)), "failed");
  assert.match(String(store.readEvents(id).find((e) => e.type === "run_failed")?.error), /proxy's image 'no-such-proxy:1' is not present/);
  assert.ok(!calls().slice(before).some((a) => a[0] === "network"), "no network made");
  assert.deepEqual(readdirSync(state), []);
});

test("the backstop removes a live network after the containers", async () => {
  writeFileSync(join(state, "net.odw-backstop-net"), "");
  const untrack = trackNetwork("odw-backstop-net", "docker");
  const before = calls().length;
  killAllAgentProcesses();
  await until(() => calls().slice(before).some((a) => a.join(" ") === "network rm odw-backstop-net"));
  untrack();
  assert.deepEqual(readdirSync(state), []);
});

test("a network whose rm fails at the run's end stays tracked: the backstop removes it", async () => {
  const proxies = new EgressProxies({ runner: runCommand, runId: "netrm" });
  const handle = await proxies.for("docker", "odw-test:1", { allow: [allowed] });
  assert.ok(existsSync(join(state, `net.${handle.network}`)));
  writeFileSync(join(state, "fail.netrm"), "");
  await proxies.close();
  assert.ok(existsSync(join(state, `net.${handle.network}`)), "the first rm failed: the network is still there");
  assert.ok(!existsSync(join(state, handle.proxy)), "its proxy is gone");
  const before = calls().length;
  killAllAgentProcesses();
  await until(() => !existsSync(join(state, `net.${handle.network}`)));
  assert.ok(calls().slice(before).some((a) => a.join(" ") === `network rm ${handle.network}`), "the backstop tried it again");
  assert.deepEqual(readdirSync(state), []);
});

test("doctor: the egress check brings up the proxy, gets 200 for a listed host and 403 for a reserved one, no outside DNS, and cleans up", async () => {
  const { configPath } = project({ allow: [allowed, "*.example.com"] });
  const config = loadConfig(configPath, { quiet: true });
  const before = calls().length;
  const checks = await sandboxChecks(config, runCommand, process.env, (cmd) => cmd === "docker", "linux");
  const egress = checks.find((c) => c.id === "sandbox:egress");
  assert.ok(egress, JSON.stringify(checks));
  assert.equal(egress.status, "ok", egress.detail);
  assert.match(egress.detail, new RegExp(`${allowed.replace(/\./g, "\\.")} was reached and odw-egress-check\\.invalid:443 refused; example\\.com did not resolve`));
  const mine = calls().slice(before);
  const probe = mine.find((a) => a[0] === "run" && a.includes("-e"))!;
  assert.deepEqual(valuesOf(probe, "--dns"), [EGRESS_DNS], "the probe has the agent's resolver");
  assert.ok(probe.includes("dns:example.com"));
  assert.ok(mine.some((a) => a[0] === "network" && a[1] === "rm"));
  assert.deepEqual(readdirSync(state), []);
});

test("doctor: an outside name that resolves on the internal network fails the egress check (CVE-2024-29018)", async () => {
  const { configPath } = project({ allow: [allowed] });
  const config = loadConfig(configPath, { quiet: true });
  process.env.DOCKER_FAKE_DNS_LEAK = "1";
  try {
    const checks = await sandboxChecks(config, runCommand, process.env, (cmd) => cmd === "docker", "linux");
    const egress = checks.find((c) => c.id === "sandbox:egress");
    assert.ok(egress, JSON.stringify(checks));
    assert.equal(egress.status, "fail", egress.detail);
    assert.match(egress.detail, /example\.com resolves in a container on the internal network/);
    assert.match(egress.hint ?? "", /CVE-2024-29018/);
  } finally {
    delete process.env.DOCKER_FAKE_DNS_LEAK;
  }
  assert.deepEqual(readdirSync(state), []);
});
