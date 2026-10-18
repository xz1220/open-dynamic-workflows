/**
 * The egress allowlist of a container sandbox (an ODW extension): the hosts a
 * sandboxed agent may reach, and the proxy that enforces it.
 *
 * `sandbox.network: { allow: ["api.anthropic.com", "*.npmjs.org", …] }` puts
 * the agent's container on an internal network of its run (`<engine> network
 * create --internal`: no route out), whose only other member is an egress
 * proxy sidecar — a container of ODW's, also on the engine's default network
 * — that the agent reaches through `HTTPS_PROXY`/`HTTP_PROXY`. The proxy
 * tunnels CONNECT only to an allowlisted host's port 443 (or the port the
 * entry names) and forwards plain HTTP only to an allowlisted host, resolving
 * names itself; every refusal is a JSON line in a log file of the run, which
 * the run turns into `egress_denied` events. The enforcement sits outside the
 * agent's container: nothing the agent does in it changes what the proxy
 * lets through. A CLI that ignores the proxy variables gets no network at
 * all — the safe failure.
 *
 * An entry is a host name (`api.anthropic.com`), a `*.` wildcard over its
 * subdomains (`*.npmjs.org`: `registry.npmjs.org`, not `npmjs.org`), or an IP
 * literal (`10.0.0.5`, `[::1]`), each optionally with a port
 * (`example.com:8443`); without one it allows 443 and 80. A request for an
 * IP literal is refused unless that literal is listed: a wildcard never
 * matches one. `"adapter"` (alone, or as an entry) stands for the hosts the
 * agent's adapter declares it needs (`egressHosts`; the built-in adapters
 * declare theirs, from their docs).
 *
 * This module is the pure part — the matcher, the intersection that lets an
 * adapter or a call only tighten the list, and the proxy itself. The proxy is
 * one self-contained function ({@link runEgressProxy}), run by `odw
 * __egress-proxy` and written out as a standalone script
 * ({@link egressProxyScript}) for the sidecar, so its image needs only node.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";

import { ConfigError } from "../errors.js";

/** The entry that stands for the adapter's own hosts. */
export const ADAPTER_HOSTS = "adapter";

/** The port the sidecar listens on in its container. */
export const EGRESS_PORT = 3128;

/** A sandbox's allowlist, as the config gives it (entries normalized; `"adapter"` kept until an adapter is known). */
export interface EgressAllow {
  allow: string[];
  /** The image the proxy runs in; absent: the agent's own (which then needs node). */
  proxyImage?: string;
}

const NETWORK_KEYS = ["allow", "proxyImage"] as const;
const LABEL = "[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?";
const HOSTNAME = new RegExp(`^${LABEL}(\\.${LABEL})*$`);
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** Validate a `network: { allow, proxyImage? }` object; `where` names it in errors. */
export function buildEgressAllow(raw: Record<string, unknown>, where: string): EgressAllow {
  for (const key of Object.keys(raw)) {
    if (!(NETWORK_KEYS as readonly string[]).includes(key)) {
      throw new ConfigError(`${where} has an unknown field "${key}"; known: ${NETWORK_KEYS.join(", ")}`);
    }
  }
  const list = raw.allow === ADAPTER_HOSTS ? [ADAPTER_HOSTS] : raw.allow;
  if (!Array.isArray(list)) {
    throw new ConfigError(`${where}.allow must be "adapter" or a list of hosts such as ["api.anthropic.com", "*.npmjs.org"]; got ${JSON.stringify(raw.allow)}`);
  }
  const allow = [...new Set(list.map((entry, i) => (entry === ADAPTER_HOSTS ? ADAPTER_HOSTS : normalizeAllowEntry(entry, `${where}.allow[${i}]`))))];
  const out: EgressAllow = { allow };
  if (raw.proxyImage != null) {
    if (typeof raw.proxyImage !== "string" || !/^[A-Za-z0-9][^\s]*$/.test(raw.proxyImage)) {
      throw new ConfigError(`${where}.proxyImage must be an image reference (one with node in it); got ${JSON.stringify(raw.proxyImage)}`);
    }
    out.proxyImage = raw.proxyImage;
  }
  return out;
}

/**
 * One allowlist entry, normalized (lower case, no trailing dot): a host name,
 * `*.` and a domain, an IPv4 literal or a bracketed IPv6 one, and an
 * optional `:port`. Anything else is a ConfigError.
 */
export function normalizeAllowEntry(raw: unknown, where: string): string {
  const bad = (why: string): never => {
    throw new ConfigError(`${where} ${why}; got ${JSON.stringify(raw)}`);
  };
  if (typeof raw !== "string" || raw.trim() === "") return bad(`must be a host such as "api.anthropic.com", "*.npmjs.org" or "example.com:8443"`);
  const text = raw.trim().toLowerCase();
  if (text === "*" || text === "*:*") return bad(`cannot allow every host: use "network": "default" for that`);
  const parsed = parseEntry(text);
  if (!parsed) return bad(`must be a host name, "*.<domain>", an IP literal ("10.0.0.5", "[::1]"), each with an optional ":<port>"`);
  return formatEntry(parsed);
}

interface Entry {
  /** The host (no brackets), or the domain after `*.`. */
  host: string;
  wildcard: boolean;
  ip: boolean;
  /** null: 443 and 80. */
  port: number | null;
}

function parseEntry(text: string): Entry | null {
  let host = text;
  let port: number | null = null;
  const v6 = /^\[([0-9a-f:.]+)\](?::(\d+))?$/.exec(text);
  if (v6) {
    if (!net.isIPv6(v6[1]!)) return null;
    host = v6[1]!;
    port = v6[2] === undefined ? null : Number(v6[2]);
  } else {
    const withPort = /^(.*):(\d+)$/.exec(text);
    if (withPort) {
      host = withPort[1]!;
      port = Number(withPort[2]);
    }
    if (host.endsWith(".")) host = host.slice(0, -1);
  }
  if (port !== null && !(port >= 1 && port <= 65535)) return null;
  if (v6) return { host, wildcard: false, ip: true, port };
  if (IPV4.test(host)) return { host, wildcard: false, ip: true, port };
  const wildcard = host.startsWith("*.");
  const name = wildcard ? host.slice(2) : host;
  if (!HOSTNAME.test(name) || !/[a-z]/.test(name.split(".").pop()!)) return null;
  return { host: name, wildcard, ip: false, port };
}

function formatEntry(entry: Entry): string {
  const host = entry.wildcard ? `*.${entry.host}` : entry.ip && entry.host.includes(":") ? `[${entry.host}]` : entry.host;
  return entry.port === null ? host : `${host}:${entry.port}`;
}

/**
 * Whether `allow` lets a connection to `host`:`port` through. Self-contained
 * — it runs inside the proxy's standalone script, so it uses nothing but its
 * arguments. `allow` holds normalized entries ({@link normalizeAllowEntry}).
 * A wildcard matches subdomains (any depth), never the domain itself nor an
 * IP literal; an IP literal matches only itself; an entry without a port
 * allows 443 and 80.
 */
export function hostAllowed(allow: readonly string[], host: string, port: number): boolean {
  let h = String(host).toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h.endsWith(".")) h = h.slice(0, -1);
  const isIp = h.includes(":") || /^[0-9.]+$/.test(h);
  // A name the resolver could read as a number (`2130706433`, `0x7f.1`) is no name.
  if (!isIp && (!/^[a-z0-9_.-]+$/.test(h) || !/[a-z]/.test(h.split(".").pop() || ""))) return false;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  for (const entry of allow) {
    let pattern = entry;
    let entryPort: number | null = null;
    if (pattern.startsWith("[")) {
      const end = pattern.indexOf("]");
      if (pattern.length > end + 1) entryPort = Number(pattern.slice(end + 2));
      pattern = pattern.slice(1, end);
    } else {
      const colon = pattern.lastIndexOf(":");
      if (colon !== -1) {
        entryPort = Number(pattern.slice(colon + 1));
        pattern = pattern.slice(0, colon);
      }
    }
    if (entryPort === null ? port !== 443 && port !== 80 : port !== entryPort) continue;
    if (pattern.startsWith("*.")) {
      if (!isIp && h.endsWith(pattern.slice(1))) return true;
    } else if (h === pattern) {
      return true;
    }
  }
  return false;
}

/**
 * The entries both lists allow — exactly, for this pattern language: a host
 * pattern and a port set meet in the narrower of the two, or not at all. What
 * an adapter's or a call's list does to the run's: it can only tighten it.
 */
export function intersectAllow(a: readonly string[], b: readonly string[]): string[] {
  const out = new Set<string>();
  for (const x of a) {
    for (const y of b) {
      const p = parseEntry(x);
      const q = parseEntry(y);
      if (!p || !q) continue;
      const host = narrowerHost(p, q) ?? narrowerHost(q, p);
      if (!host) continue;
      let port: number | null | undefined;
      if (p.port === q.port) port = p.port;
      else if (p.port === null) port = q.port === 443 || q.port === 80 ? q.port : undefined;
      else if (q.port === null) port = p.port === 443 || p.port === 80 ? p.port : undefined;
      if (port === undefined) continue;
      out.add(formatEntry({ ...host, port }));
    }
  }
  return [...out];
}

/** `p`'s host pattern when every host it matches `q` matches too; else null. */
function narrowerHost(p: Entry, q: Entry): Entry | null {
  if (!q.wildcard) return !p.wildcard && p.host === q.host ? p : null;
  if (p.ip) return null;
  return p.host.endsWith(`.${q.host}`) || (p.wildcard && p.host === q.host) ? p : null;
}

/** `allow` with `"adapter"` replaced by `hosts` (none: the adapter declares none). */
export function expandAdapterHosts(allow: readonly string[], hosts: readonly string[] | undefined): string[] {
  return [...new Set(allow.flatMap((entry) => (entry === ADAPTER_HOSTS ? (hosts ?? []) : [entry])))];
}

/** Validate an adapter's `egressHosts`: the hosts its CLI needs (what `allow: "adapter"` means). */
export function buildEgressHosts(name: string, raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new ConfigError(`adapter '${name}' 'egressHosts' must be a list of hosts its CLI needs; got ${JSON.stringify(raw)}`);
  }
  return raw.map((entry, i) => normalizeAllowEntry(entry, `adapter '${name}' 'egressHosts[${i}]'`));
}

// --- the proxy --------------------------------------------------------------------

/** What the proxy is told: its allowlist, where it logs denials, and where it says it is listening. */
export interface EgressProxyConfig {
  allow: string[];
  port: number;
  /** The address it listens on; default every interface. */
  listen?: string;
  /**
   * A file to wait for and read the address to listen on from, instead: its
   * address on the run's internal network, known only once it has joined it,
   * so it is no open proxy for the engine's default network.
   */
  listenFrom?: string;
  /** Denials, one JSON line each: `{ ts, host, port, agent, method }`. */
  log: string;
  /** Written with the port once it listens. */
  ready?: string;
}

/** One line of the proxy's denial log. */
export interface EgressDenial {
  ts: number;
  host: string;
  port: number | null;
  /** The agent id its client gave as the proxy user name (`HTTPS_PROXY=http://<agent>:odw@…`); null when it gave none. */
  agent: string | null;
  method: "CONNECT" | "HTTP";
}

/** What {@link runEgressProxy} is handed instead of importing: so it can run as a standalone script. */
export interface EgressProxyDeps {
  net: typeof net;
  http: typeof http;
  fs: Pick<typeof fs, "appendFileSync" | "writeFileSync" | "readFileSync">;
  hostAllowed: typeof hostAllowed;
}

/**
 * The egress proxy: an HTTP proxy that tunnels CONNECT to allowlisted
 * host:port pairs and forwards absolute `http://` requests to allowlisted
 * hosts, and refuses (403) and logs everything else. Self-contained — it
 * touches nothing but `deps`, `config` and globals — because
 * {@link egressProxyScript} writes its source out for the sidecar.
 * `$ODW_EGRESS_PORT` overrides the port (a test engine runs it on the host).
 */
export function runEgressProxy(deps: EgressProxyDeps, config: EgressProxyConfig): http.Server {
  const { net: netm, http: httpm, fs: fsm, hostAllowed: allowed } = deps;
  const agentOf = (req: http.IncomingMessage): string | null => {
    const header = req.headers["proxy-authorization"];
    const match = typeof header === "string" ? /^basic\s+(\S+)$/i.exec(header.trim()) : null;
    if (!match) return null;
    const user = Buffer.from(match[1]!, "base64").toString("utf8").split(":")[0] ?? "";
    return /^[A-Za-z0-9_.-]{1,64}$/.test(user) ? user : null;
  };
  const deny = (method: string, host: string, port: number | null, req: http.IncomingMessage): void => {
    const line = { ts: Date.now() / 1000, host: host.slice(0, 255), port, agent: agentOf(req), method };
    try {
      fsm.appendFileSync(config.log, JSON.stringify(line) + "\n");
    } catch {
      /* the log is gone: the refusal stands */
    }
  };
  const refusal = (host: string, port: number | null): string =>
    `odw egress: ${host}${port === null ? "" : `:${port}`} is not on this sandbox's allowlist\n`;
  const server = httpm.createServer((req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      res.writeHead(400, { "content-type": "text/plain" }).end("odw egress proxy: send an absolute http:// URL, or CONNECT\n");
      return;
    }
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const port = url.port ? Number(url.port) : 80;
    if (url.protocol !== "http:" || !allowed(config.allow, host, port)) {
      deny("HTTP", host, port, req);
      res.writeHead(403, { "content-type": "text/plain" }).end(refusal(host, port));
      return;
    }
    // The URL's host is the one checked, so it is the one the upstream sees: a
    // Host header naming another (a virtual host behind an allowed address) is
    // refused, and the header sent on is the URL's host and port.
    const claimed = req.headers.host;
    if (claimed !== undefined) {
      let named: URL | null = null;
      try {
        named = new URL(`http://${claimed}`);
      } catch {
        named = null;
      }
      const namedHost = named ? named.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "") : String(claimed);
      const namedPort = named && named.port ? Number(named.port) : 80;
      if (!named || named.username || named.pathname !== "/" || named.search || namedHost !== host.replace(/\.$/, "")) {
        deny("HTTP", namedHost, namedPort, req);
        res.writeHead(403, { "content-type": "text/plain" }).end(`odw egress: the Host header (${namedHost.slice(0, 255)}) is not the request's host (${host})\n`);
        return;
      }
    }
    const headers: http.IncomingHttpHeaders = { ...req.headers, host: url.host };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    const upstream = httpm.request({ host, port, method: req.method, path: url.pathname + url.search, headers }, (reply) => {
      res.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(res);
    });
    upstream.on("error", () => {
      if (res.headersSent) res.destroy();
      else res.writeHead(502, { "content-type": "text/plain" }).end(`odw egress: could not reach ${host}:${port}\n`);
    });
    req.pipe(upstream);
  });
  server.on("connect", (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    socket.on("error", () => {});
    const target = req.url ?? "";
    const match = /^\[([^\]]+)\]:(\d+)$/.exec(target) ?? /^([^:[\]]+):(\d+)$/.exec(target);
    const host = match ? match[1]!.toLowerCase() : target;
    const port = match ? Number(match[2]) : null;
    if (port === null || !allowed(config.allow, host, port)) {
      deny("CONNECT", host, port, req);
      socket.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\n${refusal(host, port)}`);
      return;
    }
    let open = false;
    const upstream = netm.connect(port, host, () => {
      open = true;
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => {
      if (open) socket.destroy();
      else socket.end(`HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n`);
    });
    socket.on("close", () => upstream.destroy());
  });
  server.on("clientError", (_err: Error, socket: net.Socket) => socket.destroy());
  const override = process.env.ODW_EGRESS_PORT;
  const port = override !== undefined && /^\d+$/.test(override) ? Number(override) : config.port;
  const listen = (host: string): void => {
    server.listen(port, host, () => {
      const address = server.address();
      if (config.ready) fsm.writeFileSync(config.ready, String(typeof address === "object" && address ? address.port : port));
    });
  };
  if (config.listenFrom) {
    const listenFrom = config.listenFrom;
    let closed = false;
    server.once("close", () => (closed = true));
    const wait = (): void => {
      if (closed) return;
      let host = "";
      try {
        host = String(fsm.readFileSync(listenFrom, "utf8")).trim();
      } catch {
        /* not yet */
      }
      if (netm.isIP(host)) listen(host);
      else setTimeout(wait, 50);
    };
    wait();
  } else {
    listen(config.listen ?? "0.0.0.0");
  }
  return server;
}

/**
 * The proxy as a standalone ES module: `node proxy.mjs <config.json>`. The
 * functions' own source, so it is the same code `odw __egress-proxy` runs.
 */
export function egressProxyScript(): string {
  return [
    "// The ODW egress proxy (written by odw for a sandbox's proxy sidecar; see src/adapters/egress.ts).",
    'import * as fs from "node:fs";',
    'import * as http from "node:http";',
    'import * as net from "node:net";',
    // A transpiler that keeps function names may call this helper.
    "const __name = (target) => target;",
    `const hostAllowed = (${hostAllowed.toString()});`,
    `const runEgressProxy = (${runEgressProxy.toString()});`,
    'const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));',
    "runEgressProxy({ net, http, fs, hostAllowed }, config);",
    'process.on("SIGTERM", () => process.exit(0));',
    "",
  ].join("\n");
}

/** `odw __egress-proxy <config.json>`: run the proxy in this process until it is killed. */
export function startEgressProxy(config: EgressProxyConfig): http.Server {
  return runEgressProxy({ net, http, fs, hostAllowed }, config);
}

/**
 * The doctor's probe, run in a container on the internal network: through
 * `$HTTPS_PROXY`, a CONNECT to each `host:port` given as an argument; prints
 * `{ "<host:port>": <status> }` (0: no answer). An argument `dns:<name>`
 * instead looks the name up in the container: 1 when it resolved, 0 when not.
 * Plain JS for `node -e`.
 */
export const EGRESS_PROBE = `
const net = require("node:net");
const dns = require("node:dns");
const resolves = (name) => new Promise((done) => {
  const timer = setTimeout(() => done(0), 20000);
  dns.lookup(name, (err) => { clearTimeout(timer); done(err ? 0 : 1); });
});
const proxy = new URL(process.env.HTTPS_PROXY);
const auth = proxy.username ? "Proxy-Authorization: Basic " + Buffer.from(decodeURIComponent(proxy.username) + ":" + decodeURIComponent(proxy.password)).toString("base64") + "\\r\\n" : "";
const ask = (target) => new Promise((done) => {
  const socket = net.connect(Number(proxy.port), proxy.hostname);
  let data = "";
  const timer = setTimeout(() => { socket.destroy(); done(0); }, 20000);
  socket.on("connect", () => socket.write("CONNECT " + target + " HTTP/1.1\\r\\nHost: " + target + "\\r\\n" + auth + "\\r\\n"));
  socket.on("data", (chunk) => {
    data += chunk;
    const m = /^HTTP\\/1\\.[01] (\\d{3})/.exec(data);
    if (m) { clearTimeout(timer); socket.destroy(); done(Number(m[1])); }
  });
  socket.on("error", () => { clearTimeout(timer); done(0); });
});
(async () => {
  const out = {};
  for (const target of process.argv.slice(1)) out[target] = target.startsWith("dns:") ? await resolves(target.slice(4)) : await ask(target);
  process.stdout.write(JSON.stringify(out) + "\\n");
})();
`;
