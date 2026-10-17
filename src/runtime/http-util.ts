/**
 * HTTP plumbing shared by the dashboard server's routes (L5): the write-path
 * guards, JSON request/response helpers, and SSE client writes. Nothing here
 * knows about runs or chat sessions — see {@link ./server} for the routes and
 * their security model.
 */

import { createHash } from "node:crypto";
import { closeSync, createReadStream, fstatSync, openSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Body cap for write endpoints, in bytes. The largest legitimate payload is a
 * chat message (the other writes are a few fields), so 128 KiB leaves ample
 * room for pasted logs/code while bounding what a request can make us buffer.
 */
export const MAX_BODY_BYTES = 128 * 1024;

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

/**
 * A percent-decoded path segment, or null when its escapes are malformed
 * (`%E0%A4%A`, `%ZZ`): decodeURIComponent throws on those, which is the
 * client's error (400), not the server's (500).
 */
export function decodeSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
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

export type JsonBody =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; status: 400 | 413; error: string };

/**
 * Read and JSON-parse a request body (empty → `{}`). The raw chunks are kept
 * as Buffers and decoded once at the end — decoding chunk by chunk mangles a
 * multi-byte UTF-8 character split across two chunks — and the cap counts
 * bytes, not UTF-16 units.
 *
 * Past `maxBytes` it settles at once with a 413 and keeps DRAINING the rest
 * without buffering it: destroying the socket instead would make the client
 * see a connection reset rather than the answer. Settles exactly once, even
 * if the client aborts (a `close` with neither `end` nor `error`).
 */
export function readJsonBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<JsonBody> {
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (value: JsonBody): void => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      resolvePromise(value);
    };
    const invalid = (): JsonBody => ({ ok: false, status: 400, error: "body must be a JSON object" });
    req.on("data", (chunk: Buffer | string) => {
      if (settled) return; // over the cap: drain, never buffer
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > maxBytes) {
        settle({ ok: false, status: 413, error: `request body exceeds ${maxBytes} bytes` });
        return;
      }
      chunks.push(buf);
    });
    req.on("error", () => settle(invalid()));
    req.on("close", () => settle(invalid())); // an aborted upload
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        const parsed = JSON.parse(text || "{}") as unknown;
        settle(
          parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
            ? { ok: true, value: parsed as Record<string, unknown> }
            : invalid(),
        );
      } catch {
        settle(invalid());
      }
    });
  });
}

/**
 * The request's JSON-object body, or null once a 400 (not a JSON object) or
 * 413 (too large; `connection: close`, as the rest is only drained) has been
 * sent.
 */
export async function jsonBodyOrReply(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Record<string, unknown> | null> {
  const body = await readJsonBody(req);
  if (body.ok) return body.value;
  sendJson(res, body.status, { error: body.error }, body.status === 413 ? { connection: "close" } : {});
  return null;
}

export function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...headers,
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

/**
 * Stream a file as a 200 with an ETag from its inode, size and mtime, or a
 * bodiless 304 when If-None-Match already holds it — for a large artifact (an
 * agent's diff) a client fetches whole and keeps. The file is opened first, so
 * one replaced meanwhile is still served whole. False when there is no such
 * file: the caller answers 404.
 */
export function sendFileCached(req: IncomingMessage, res: ServerResponse, path: string, contentType: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return false;
  }
  const info = fstatSync(fd);
  const etag = `W/"${createHash("sha1").update(`${info.ino}:${info.size}:${info.mtimeMs}`).digest("base64url")}"`;
  // nosniff: a diff is whatever the agent wrote, HTML included — it is never rendered.
  const common = { etag, "cache-control": "no-cache", "x-content-type-options": "nosniff" };
  if (etagMatches(req.headers["if-none-match"], etag)) {
    closeSync(fd);
    res.writeHead(304, common);
    res.end();
    return true;
  }
  res.writeHead(200, { ...common, "content-type": contentType, "content-length": info.size });
  const stream = createReadStream(path, { fd, autoClose: true }); // reads the descriptor, not the path
  stream.on("error", () => res.destroy());
  stream.pipe(res);
  return true;
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

const lastLogged = new Map<string, number>();
const LOG_REPEAT_MS = 30_000;

/**
 * Log a background failure (timer, fs watcher, stream flush) to stderr instead
 * of letting it crash `odw serve`: one EACCES/ENOSPC must not take the
 * dashboard down. A repeat of the same message is muted for 30s so a
 * persistent fault (a full disk) logs once, not every tick.
 */
export function logServeError(context: string, err: unknown): void {
  const message = `odw serve: ${context}: ${(err as Error)?.message ?? String(err)}`;
  const now = Date.now();
  if (now - (lastLogged.get(message) ?? -Infinity) < LOG_REPEAT_MS) return;
  lastLogged.set(message, now);
  if (lastLogged.size > 100) lastLogged.delete(lastLogged.keys().next().value!);
  try {
    process.stderr.write(`${message}\n`);
  } catch {
    /* stderr gone: nothing left to tell */
  }
}

/** Run `fn` for a background caller; a throw is logged, never propagated. */
export function guarded(context: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    logServeError(context, err);
  }
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
