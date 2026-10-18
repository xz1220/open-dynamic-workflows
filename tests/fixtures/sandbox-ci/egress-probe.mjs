#!/usr/bin/env node
// A stand-in agent CLI for the real-engine egress check: through $HTTPS_PROXY
// it fetches https://<host>/ for each host its prompt names (`fetch a b`),
// and tries one connection around the proxy — answering with what it got, as
// one line of JSON. Node's own fetch ignores the proxy before Node 24, so
// this speaks CONNECT and TLS itself.
import * as net from "node:net";
import * as tls from "node:tls";

const viaProxy = (host) =>
  new Promise((done) => {
    const proxy = new URL(process.env.HTTPS_PROXY);
    const auth = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64");
    const socket = net.connect(Number(proxy.port), proxy.hostname);
    const timer = setTimeout(() => (socket.destroy(), done({ proxy: 0, https: 0 })), 30_000);
    let head = "";
    socket.on("error", () => (clearTimeout(timer), done({ proxy: 0, https: 0 })));
    socket.on("connect", () => socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`));
    socket.on("data", function onData(chunk) {
      head += chunk;
      if (!head.includes("\r\n\r\n")) return;
      socket.off("data", onData);
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? 0);
      if (status !== 200) {
        clearTimeout(timer);
        socket.destroy();
        return done({ proxy: status, https: 0 });
      }
      const secure = tls.connect({ socket, servername: host }, () => secure.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
      let reply = "";
      secure.on("data", (c) => {
        reply += c;
        const m = /^HTTP\/1\.[01] (\d{3})/.exec(reply);
        if (m) {
          clearTimeout(timer);
          secure.destroy();
          done({ proxy: 200, https: Number(m[1]) });
        }
      });
      secure.on("error", () => (clearTimeout(timer), done({ proxy: 200, https: 0 })));
    });
  });

const around = (host) =>
  new Promise((done) => {
    const socket = net.connect(443, host);
    const timer = setTimeout(() => (socket.destroy(), done(false)), 10_000);
    socket.on("connect", () => (clearTimeout(timer), socket.destroy(), done(true)));
    socket.on("error", () => (clearTimeout(timer), done(false)));
  });

let prompt = "";
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", async () => {
  const hosts = /fetch ([a-z0-9. ]+)/.exec(prompt)?.[1]?.trim().split(/\s+/) ?? [];
  const report = { proxyVar: process.env.HTTPS_PROXY ?? null, fetched: {} };
  for (const host of hosts) report.fetched[host] = await viaProxy(host);
  report.direct = await around(hosts[0] ?? "example.com");
  process.stdout.write(JSON.stringify(report));
});
