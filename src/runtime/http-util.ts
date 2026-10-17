/**
 * HTTP plumbing shared by the dashboard server's routes (L5): the write-path
 * guards, JSON request/response helpers, and SSE client writes. Nothing here
 * knows about runs or chat sessions — see {@link ./server} for the routes and
 * their security model.
 */

import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Body cap for write endpoints; inline scripts are the largest legitimate payload. */
export const MAX_BODY_BYTES = 512 * 1024;

const LOOPBACK_BINDS = new Set(["127.0.0.1", "localhost", "::1"]);
const LOOPBACK_HOST_NAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Whether the server was bound to a loopback address (the default). */
export function isLoopbackBind(host: string): boolean {
  return LOOPBACK_BINDS.has(host);
}

/** The hostname part of a Host header, with any port stripped ([::1]:p safe). */
export function hostHeaderName(header: string): string {
  const h = header.trim();
  if (h.startsWith("[")) return h.replace(/\]:\d+$/, "]"); // [::1]:4317 → [::1]
  return h.replace(/:\d+$/, "");
}

/** DNS-rebinding guard: on a loopback bind, only a loopback Host header may pass. */
export function isAllowedHost(boundHost: string, header: string | undefined): boolean {
  if (!isLoopbackBind(boundHost) || !header) return true;
  return LOOPBACK_HOST_NAMES.has(hostHeaderName(header));
}

/**
 * The write-path gate shared by every POST. Returns true when
 * the request may proceed; otherwise the response has been written.
 */
export function writeGuard(req: IncomingMessage, res: ServerResponse, boundHost: string): boolean {
  if (!isLoopbackBind(boundHost)) {
    sendJson(res, 409, { error: "writes are loopback-only; token auth is a future opt-in" });
    return false;
  }
  // Compare the MIME *essence* (type/subtype before any ";" parameters), not a
  // substring: `text/plain; x=application/json` is a CORS "simple request" and
  // must NOT pass, while `application/json; charset=utf-8` must.
  const essence = String(req.headers["content-type"] ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  if (essence !== "application/json") {
    sendJson(res, 415, { error: "write requests require Content-Type: application/json" });
    return false;
  }
  const origin = req.headers.origin;
  if (origin) {
    let sameOrigin = false;
    try {
      sameOrigin = new URL(origin).host === req.headers.host;
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin) {
      sendJson(res, 403, { error: "cross-origin write requests are rejected" });
      return false;
    }
  }
  return true;
}

/**
 * Read and JSON-parse a request body. Resolves `undefined` on invalid/empty
 * JSON OR when the body exceeds {@link MAX_BODY_BYTES} (the caller turns that
 * into a 400). Settling exactly once is guaranteed even on `destroy()`, whose
 * abort emits neither `end` nor `error` — a `close` listener catches it, so the
 * awaiting handler never hangs and the oversized buffer is dropped.
 */
export function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolvePromise) => {
    let body = "";
    let settled = false;
    const settle = (value: Record<string, unknown> | undefined): void => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    req.on("data", (chunk) => {
      if (settled) return;
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        settle(undefined); // too large → caller responds 400; stop buffering
        req.destroy();
      }
    });
    req.on("error", () => settle(undefined));
    req.on("close", () => settle(undefined)); // covers destroy() with no error
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body || "{}") as unknown;
        settle(
          parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : undefined,
        );
      } catch {
        settle(undefined);
      }
    });
  });
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * A 200 JSON response with a content-hash ETag, or a bodiless 304 when the
 * request's If-None-Match already holds it — for the polled read endpoints,
 * where most polls find nothing new. `cache-control: no-cache` makes browsers
 * revalidate every time, so a poller transparently gets 304s and its cached
 * body. `headers` take part in the tag (a 304 must not hide a changed header).
 */
export function sendJsonCached(
  req: IncomingMessage,
  res: ServerResponse,
  payload: unknown,
  headers: Record<string, string> = {},
): void {
  const body = JSON.stringify(payload);
  const hash = createHash("sha1").update(body).update(JSON.stringify(headers)).digest("base64url");
  const etag = `W/"${hash}"`;
  const common = { ...headers, etag, "cache-control": "no-cache" };
  if (etagMatches(req.headers["if-none-match"], etag)) {
    res.writeHead(304, common);
    res.end();
    return;
  }
  res.writeHead(200, {
    ...common,
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** If-None-Match semantics: `*` or any listed tag, compared weakly. */
function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const bare = (t: string) => t.trim().replace(/^W\//, "");
  return header.split(",").some((t) => t.trim() === "*" || bare(t) === bare(etag));
}

/** Register `res` as an SSE client and send it `firstFrame`. */
export function openStream(res: ServerResponse, clients: Set<ServerResponse>, firstFrame: string): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  clients.add(res);
  // Heartbeat so proxies/clients don't time the idle connection out.
  const beat = setInterval(() => safeWrite(res, ": ping\n\n", clients), 15000);
  beat.unref?.();
  const cleanup = () => {
    clearInterval(beat);
    clients.delete(res);
  };
  res.on("close", cleanup);
  res.on("error", cleanup); // a socket error must not become an uncaught throw
  safeWrite(res, ": connected\n\n", clients);
  safeWrite(res, firstFrame, clients);
}

/** Write to an SSE client; on failure drop it from the pool. Never throws. */
export function safeWrite(res: ServerResponse, data: string, clients: Set<ServerResponse>): void {
  try {
    res.write(data);
  } catch {
    clients.delete(res);
    try {
      res.end();
    } catch {
      /* already torn down */
    }
  }
}
