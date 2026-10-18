/**
 * Preloaded (`--require`) by tests/fixtures/fake-docker.mjs into a container
 * run with `--dns`: what that resolver gives the container — no name from
 * outside resolves (IP literals still "resolve" to themselves). With
 * DOCKER_FAKE_DNS_LEAK set, an engine that forwards its lookups out anyway
 * (CVE-2024-29018): every name resolves.
 *
 * Used only by the test suite.
 */
const dns = require("node:dns");
const net = require("node:net");

const leak = Boolean(process.env.DOCKER_FAKE_DNS_LEAK);
const refuse = (hostname) => Object.assign(new Error(`getaddrinfo EAI_AGAIN ${hostname}`), { code: "EAI_AGAIN", hostname });
const original = dns.lookup;
dns.lookup = function lookup(hostname, options, callback) {
  const done = typeof options === "function" ? options : callback;
  if (net.isIP(String(hostname))) return original.apply(this, arguments);
  const all = typeof options === "object" && options !== null && options.all;
  process.nextTick(() => (leak ? (all ? done(null, [{ address: "192.0.2.10", family: 4 }]) : done(null, "192.0.2.10", 4)) : done(refuse(hostname))));
  return {};
};
const originalPromise = dns.promises.lookup;
dns.promises.lookup = async (hostname, options) => {
  if (net.isIP(String(hostname))) return originalPromise(hostname, options);
  if (leak) return options && options.all ? [{ address: "192.0.2.10", family: 4 }] : { address: "192.0.2.10", family: 4 };
  throw refuse(hostname);
};
