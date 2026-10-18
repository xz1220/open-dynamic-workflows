/**
 * The approve-link route of `odw serve --public-url` (ODW extension; see
 * ./approve-links): the one remote write it opens — a decision on the
 * checkpoint a link was minted for — and nothing else.
 *
 *   GET  /approve/<token>   a minimal confirmation page: the run, the
 *                           checkpoint's title, a summary of its payload and
 *                           one button (Approve or Reject: the link's action).
 *                           It never decides: link previews and prefetchers
 *                           only GET. It sets a random CSRF cookie
 *                           (HttpOnly, SameSite=Strict, scoped to the link's
 *                           path) that the form carries too.
 *   POST /approve/<token>   decides, once: the form (`csrf` matching the
 *                           cookie, `action` the link's), or a client that
 *                           names the link's action in an `X-ODW-Action`
 *                           header (an ntfy http button) — a header no
 *                           cross-site page can send without a CORS preflight,
 *                           which this server never grants. An Origin, when
 *                           sent, must be the public URL's or the Host's.
 *                           Written with `by: "link"`.
 *
 * Every answer is a small HTML page — a used (410), expired (410), tampered
 * (403) or unknown link gets one saying so, never a stack trace. Tampered and
 * malformed links and failed CSRF checks count against the client address in
 * a {@link FailureLimiter}, as wrong tokens do; past it, 429.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { ACTION_HEADER, claimLink, linkUsed, verifyLinkToken, type LinkClaims } from "./approve-links.js";
import { logServeError } from "./http-util.js";
import type { RunSource } from "./run-source.js";
import type { PendingCheckpoint } from "./runs-view.js";
import { cookie, failureKey, type FailureLimiter } from "./serve-auth.js";

/** What the route needs of the server. */
export interface ApproveRouteContext {
  /** The runs root's link secret. */
  secret: Buffer;
  /** `--public-url`, normalized: links point here, and a form's Origin may be it. */
  publicUrl: string;
  /** The ODW run source: what a link's run is looked up in and decided through. */
  source: RunSource;
  /** Where each run's used links are recorded. */
  runDir: (runId: string) => string;
  limiter: FailureLimiter;
  /** The clock, ms (tests). */
  now?: () => number;
}

const CSRF_COOKIE = "odw_approve_csrf";
/** A form body is two short fields. */
const FORM_MAX_BYTES = 4096;
/** Characters of a payload shown on the confirmation page. */
const PAYLOAD_SHOWN = 4000;

/** Answer a request under /approve/. Never throws: an unexpected error is a plain 500 page. */
export async function approveRoute(req: IncomingMessage, res: ServerResponse, path: string, ctx: ApproveRouteContext): Promise<void> {
  try {
    await route(req, res, path, ctx);
  } catch (err) {
    logServeError("approve link", err);
    if (!res.headersSent) page(res, 500, "Something went wrong", "The decision was not recorded. Try the link again, or answer with odw approve|reject.");
    else res.destroy();
  }
}

/** The answer under /approve/ of a server that answers no links (no --public-url, or a shared bundle). */
export function approveLinksOff(res: ServerResponse): void {
  page(res, 404, "Approve links are off", "This odw serve answers no approve links: it was started without --public-url.");
}

async function route(req: IncomingMessage, res: ServerResponse, path: string, ctx: ApproveRouteContext): Promise<void> {
  const address = failureKey(req.socket.remoteAddress ?? "unknown");
  const blocked = ctx.limiter.blocked(address);
  if (blocked) {
    page(res, 429, "Too many bad links", `${blocked.error}.`, { "retry-after": String(blocked.retryAfter) });
    return;
  }
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD" && method !== "POST") {
    page(res, 405, "Not allowed", "An approve link is opened (GET) or answered (POST).", { allow: "GET, HEAD, POST" });
    return;
  }
  const match = /^\/approve\/([^/]+)$/.exec(path);
  const nowMs = (ctx.now ?? Date.now)();
  const check = match ? verifyLinkToken(ctx.secret, match[1]!, Math.floor(nowMs / 1000)) : ({ ok: false, reason: "malformed" } as const);
  if (!check.ok) {
    if (check.reason === "expired") {
      page(res, 410, "This link has expired", "Answer the checkpoint with odw approve|reject, or in the dashboard.");
      return;
    }
    ctx.limiter.fail(address);
    page(res, 403, "This link is not valid", "It may have been cut short or changed, or the server's approve secret was rotated since it was sent.");
    return;
  }
  const claims = check.claims;
  const token = match![1]!;
  const runDir = ctx.runDir(claims.runId);
  const detail = ctx.source.detail(claims.runId);
  if (!detail) {
    page(res, 404, "No such run", `Run ${claims.runId} is not in this server's runs root.`);
    return;
  }
  if (linkUsed(runDir, claims.nonce)) {
    page(res, 410, "This link was already used", "Each approve link works once, and a checkpoint's approve and reject links are spent together.");
    return;
  }
  const target = (detail.pendingCheckpoints ?? []).find((cp) => cp.checkpointId === claims.checkpointId);
  if (!target) {
    page(res, 410, "Nothing to decide any more", `Checkpoint #${claims.checkpointId} of run ${claims.runId} is no longer waiting: it was answered, or the run ended.`);
    return;
  }

  if (method !== "POST") {
    const csrf = randomBytes(18).toString("base64url");
    const secure = ctx.publicUrl.startsWith("https:") ? "; Secure" : "";
    const setCookie = `${CSRF_COOKIE}=${csrf}; Path=/approve/${token}; Max-Age=3600; HttpOnly; SameSite=Strict${secure}`;
    const body = confirmPage(detail.name || claims.runId, claims, target, csrf);
    send(res, 200, method === "HEAD" ? "" : body, { "set-cookie": setCookie }, method === "HEAD" ? Buffer.byteLength(body) : undefined);
    return;
  }

  // POST: is this the person, through the page or their notification's button?
  const origin = req.headers.origin;
  if (origin !== undefined && !originAllowed(origin, ctx.publicUrl, req.headers.host)) {
    ctx.limiter.fail(address);
    page(res, 403, "Refused", "The answer came from another site's page.");
    return;
  }
  const named = req.headers[ACTION_HEADER];
  let action: string | null;
  if (typeof named === "string") {
    drain(req);
    action = named.trim().toLowerCase();
  } else {
    const form = await readForm(req);
    if (!form) {
      page(res, 400, "Not a decision", "Answer with the button on the link's page.", { connection: "close" });
      return;
    }
    const sent = form.get("csrf") ?? "";
    const kept = cookie(req.headers.cookie, CSRF_COOKIE) ?? "";
    if (!kept || !sameSecret(sent, kept)) {
      ctx.limiter.fail(address);
      page(res, 403, "This page went stale", "Open the link again and answer from the fresh page.");
      return;
    }
    action = form.get("action");
  }
  if (action !== claims.action) {
    ctx.limiter.fail(address);
    page(res, 400, "Wrong action", `This link can only ${claims.action} the checkpoint.`);
    return;
  }
  // Exactly one request gets past this, in any process.
  if (!claimLink(runDir, claims, Math.floor(nowMs / 1000))) {
    page(res, 410, "This link was already used", "Each approve link works once, and a checkpoint's approve and reject links are spent together.");
    return;
  }
  ctx.source.decide(claims.runId, { action: claims.action, checkpointId: claims.checkpointId, by: "link" });
  const clear = `${CSRF_COOKIE}=; Path=/approve/${token}; Max-Age=0; HttpOnly; SameSite=Strict`;
  page(
    res,
    200,
    claims.action === "approve" ? "Approved" : "Rejected",
    `Checkpoint #${claims.checkpointId} “${target.title}” of ${detail.name || claims.runId} was ${claims.action === "approve" ? "approved" : "rejected"}. The run takes it from here.`,
    { "set-cookie": clear },
  );
}

/** May a POST that says it comes from `origin` decide? The public URL's origin, or the Host's own. */
function originAllowed(origin: string, publicUrl: string, host: string | undefined): boolean {
  try {
    const url = new URL(origin);
    return url.origin === new URL(publicUrl).origin || (host !== undefined && url.host === host);
  } catch {
    return false;
  }
}

/** Constant-time equality of two CSRF values: both hashed first, so their lengths say nothing. */
function sameSecret(a: string, b: string): boolean {
  const h = (s: string) => createHash("sha256").update(s, "utf8").digest();
  return timingSafeEqual(h(a), h(b));
}

/** A urlencoded form body of at most {@link FORM_MAX_BYTES}, or null (another type, too large, aborted). */
function readForm(req: IncomingMessage): Promise<URLSearchParams | null> {
  const essence = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (essence !== "application/x-www-form-urlencoded") {
    drain(req);
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (value: URLSearchParams | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > FORM_MAX_BYTES) settle(null);
      else chunks.push(chunk);
    });
    req.on("end", () => settle(new URLSearchParams(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", () => settle(null));
    req.on("close", () => settle(null));
  });
}

/** Read and drop a body nobody needs, so the answer is not a connection reset. */
function drain(req: IncomingMessage): void {
  req.on("error", () => {});
  req.resume();
}

// --- pages -----------------------------------------------------------------------

const STYLE =
  "body{font:16px/1.45 system-ui,sans-serif;margin:0;padding:24px;background:#f6f6f4;color:#1d1d1b}" +
  "main{max-width:560px;margin:0 auto;background:#fff;border:1px solid #e2e2de;border-radius:12px;padding:20px 22px}" +
  "h1{font-size:20px;margin:4px 0 12px}.k{color:#6b6b66;font-size:13px;margin:0}" +
  "pre{background:#f3f3f0;border-radius:8px;padding:10px;overflow:auto;max-height:50vh;font-size:13px;white-space:pre-wrap;word-break:break-word}" +
  "button{font:inherit;font-weight:600;border:0;border-radius:8px;padding:12px 22px;color:#fff;cursor:pointer}" +
  ".approve{background:#1f7a3a}.reject{background:#a8322d}.n{color:#6b6b66;font-size:13px}" +
  "@media(prefers-color-scheme:dark){body{background:#151514;color:#ececea}main{background:#1e1e1c;border-color:#33332f}pre{background:#262623}}";

function confirmPage(runName: string, claims: LinkClaims, cp: PendingCheckpoint, csrf: string): string {
  const verb = claims.action === "approve" ? "Approve" : "Reject";
  const payload = payloadSummary(cp);
  const until = new Date(claims.exp * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  return shell(
    `${verb}: ${cp.title}`,
    `<p class="k">odw · ${esc(runName)} · checkpoint #${claims.checkpointId}</p>` +
      `<h1>${esc(cp.title)}</h1>` +
      (payload ? `<pre>${esc(payload)}</pre>` : "") +
      `<form method="post"><input type="hidden" name="csrf" value="${esc(csrf)}">` +
      `<input type="hidden" name="action" value="${claims.action}">` +
      `<button class="${claims.action}" type="submit">${verb}</button></form>` +
      `<p class="n">Run ${esc(claims.runId)}. This link works once, until ${until}; ` +
      `${claims.action === "approve" ? "to reject instead, use the reject link" : "to approve instead, use the approve link"} or odw ${claims.action === "approve" ? "reject" : "approve"}.</p>`,
  );
}

/** The checkpoint's payload as the page shows it: pretty JSON, cut short. */
function payloadSummary(cp: PendingCheckpoint): string {
  if (cp.payload === undefined || cp.payload === null) return "";
  const text = typeof cp.payload === "string" ? cp.payload : JSON.stringify(cp.payload, null, 2);
  const cut = text.length > PAYLOAD_SHOWN || cp.truncated;
  return cut ? `${text.slice(0, PAYLOAD_SHOWN)}\n… (cut; the dashboard and odw status show it all)` : text;
}

function page(res: ServerResponse, status: number, title: string, message: string, headers: Record<string, string> = {}): void {
  send(res, status, shell(title, `<p class="k">odw · approve link</p><h1>${esc(title)}</h1><p>${esc(message)}</p>`), headers);
}

function shell(title: string, body: string): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">` +
    `<meta name="robots" content="noindex"><title>${esc(title)}</title><style>${STYLE}</style></head>` +
    `<body><main>${body}</main></body></html>`
  );
}

/** Every answer: never cached, framed, sniffed, or leaking the link through a Referer. */
function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}, length?: number): void {
  res.writeHead(status, {
    ...headers,
    "content-type": "text/html; charset=utf-8",
    "content-length": length ?? Buffer.byteLength(body),
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  });
  res.end(body);
}

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
