#!/usr/bin/env node
/**
 * Live development server for the client.
 *
 * Every page load rebuilds the SPA from source (unminified, ~50ms), and every
 * `/api/*` request — the SSE stream included — is proxied to a running
 * `odw serve`, so you edit web/src and refresh. The Origin header is rewritten
 * to the API's own origin so the server's same-origin write guard still passes.
 *
 *   odw serve --port 4317 &                      # or point --api elsewhere
 *   node web/dev.mjs [--port 5173] [--api http://127.0.0.1:4317]
 *
 * Seed realistic data first with `node web/demo-fixtures.mjs <runs> <project> --live`.
 */
import http from "node:http";
import { bundleHtml } from "./bundle.mjs";

function flag(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const port = Number(flag("--port", "5173"));
const api = new URL(flag("--api", "http://127.0.0.1:4317"));

function proxy(req, res) {
  const target = new URL(req.url, api);
  const headers = { ...req.headers, host: target.host };
  if (headers.origin) headers.origin = api.origin;
  const upstream = http.request(target, { method: req.method, headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  upstream.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `dev proxy: ${err.message}` }));
  });
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
}

const server = http.createServer(async (req, res) => {
  const url = req.url ?? "/";
  if (url.startsWith("/api/")) return proxy(req, res);
  if (req.method === "GET" && (url === "/" || url.startsWith("/?") || url.startsWith("/#"))) {
    try {
      const html = await bundleHtml({ minify: false });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(String(err?.stack ?? err));
    }
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(port, "127.0.0.1", () => {
  console.error(`odw web dev → http://127.0.0.1:${port}/  (api: ${api.origin})`);
});
