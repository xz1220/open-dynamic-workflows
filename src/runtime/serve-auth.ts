/**
 * Token auth for `odw serve --token` (ODW extension): remote, read-only
 * access to the dashboard.
 *
 * With a token set, every `/api` request — the SSE stream included — must
 * carry it, one of three ways:
 *
 *   Authorization: Bearer <token>   scripts, curl
 *   ?token=<token>                  a browser's first load: the answer sets the
 *                                   cookie below, so the token need not stay in
 *                                   the address bar (the dashboard reads it from
 *                                   `#token=`, which no request carries, and trades
 *                                   it for the cookie once)
 *   Cookie: odw_token_<port>=<token>  HttpOnly, SameSite=Strict: what the
 *                                   dashboard's fetches and EventSource send
 *
 * Only one is judged: `?token=` first (it replaces a stale cookie), then the
 * header, then the cookie.
 * The HTML shell loads without one (it shows a "needs a token" screen). A
 * token is compared in constant time (both sides hashed first, so their
 * lengths say nothing). A request that presents a wrong token counts as a
 * failure of its client address: past {@link AUTH_FAILURES} in
 * {@link AUTH_WINDOW_MS}, that address is answered 429 — whatever it sends —
 * until the window has passed. A request with no token at all is answered 401
 * without counting (the dashboard asks once before it shows its token screen).
 *
 * The token never makes anything writable: writes stay loopback-only (see
 * ./http-util writeGuard) — except, with `--token-scope approve`, checkpoint
 * decisions (see ./server).
 *
 * Named tokens (ODW extension: `odw serve --tokens FILE`; see ./serve-tokens)
 * sit beside the unnamed `--token`: each has a name and a scope of its own,
 * and the file keeps only their sha256. A presented token is hashed and
 * looked up by its digest — no comparison ever runs over the token itself —
 * and a match says who is asking: what they do is attributed to that name.
 */

import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";

import type { NamedToken, TokenScope } from "./serve-tokens.js";

/** A token: 16–256 URL- and cookie-safe characters (RFC 3986 unreserved). */
const TOKEN_RE = /^[A-Za-z0-9._~-]{16,256}$/;

/** Wrong tokens an address may present per window before it is answered 429. */
export const AUTH_FAILURES = 10;
/** The failure window, in ms. */
export const AUTH_WINDOW_MS = 60_000;
/** Addresses tracked at most; past it the oldest is forgotten. */
const MAX_TRACKED = 10_000;
/**
 * Wrong tokens the whole server takes per window, from every address
 * together: past it, no token is even checked until the window has passed.
 * One address is not one attacker — an IPv6 network hands out millions —
 * so the per-address limit alone would not bound guessing.
 */
export const AUTH_GLOBAL_FAILURES = 100;

/** The address a failure counts against: an IPv6 address by its /64, which one host or network controls whole. */
export function failureKey(address: string): string {
  const v4mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (v4mapped) return v4mapped[1]!;
  if (!address.includes(":")) return address;
  const [head = ""] = address.split("%");
  const parts = head.split("::");
  const left = parts[0] ? parts[0].split(":") : [];
  const right = parts.length > 1 && parts[1] ? parts[1].split(":") : [];
  const full = parts.length > 1 ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
  return `${full.slice(0, 4).map((h) => h.toLowerCase().replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/** Is `value` usable as a token (`--token VALUE`)? */
export function isValidToken(value: string): boolean {
  return TOKEN_RE.test(value);
}

/** A fresh random token: 32 bytes, base64url (43 characters). */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export type AuthResult =
  | {
      ok: true;
      /** A Set-Cookie value to send with the answer (the token came as ?token=). */
      setCookie: string | null;
      /** The named token's name (`--tokens`), or null for the unnamed `--token`. */
      name: string | null;
      /** What the token may do: read, or answer checkpoints too. */
      scope: TokenScope;
    }
  | { ok: false; status: 401 | 429; error: string; retryAfter?: number };

export interface TokenGateOptions {
  /** Wrong tokens per window before 429 (default {@link AUTH_FAILURES}). */
  failures?: number;
  /** The window, ms (default {@link AUTH_WINDOW_MS}). */
  windowMs?: number;
  /** The clock (tests). */
  now?: () => number;
}

/** Why {@link FailureLimiter.blocked} refuses an address, and for how many seconds more. */
export interface Blocked {
  error: string;
  retryAfter: number;
}

/**
 * The failure limit behind a gate: failures per client address (see
 * {@link failureKey}) and, past {@link AUTH_GLOBAL_FAILURES} from every
 * address together, the whole server — each per window. The token gate keeps
 * one, and so do the approve links (ODW extension; see ./approve-links).
 */
export class FailureLimiter {
  private readonly failures = new Map<string, { count: number; since: number }>();
  private global = { count: 0, since: 0 };
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(
    /** What is being guessed, for the 429's message: "wrong tokens", "bad approve links". */
    private readonly what: string,
    options: TokenGateOptions = {},
  ) {
    this.limit = options.failures ?? AUTH_FAILURES;
    this.windowMs = options.windowMs ?? AUTH_WINDOW_MS;
    this.now = options.now ?? Date.now;
  }

  /** Why `address` (a failureKey) is refused before anything is checked, or null when it may try. */
  blocked(address: string): Blocked | null {
    const at = this.now();
    if (at - this.global.since >= this.windowMs) this.global = { count: 0, since: at };
    if (this.global.count >= AUTH_GLOBAL_FAILURES) {
      const retryAfter = Math.max(1, Math.ceil((this.global.since + this.windowMs - at) / 1000));
      return { error: `too many ${this.what}: none is checked for ${retryAfter}s`, retryAfter };
    }
    const record = this.failures.get(address);
    if (record && at - record.since >= this.windowMs) this.failures.delete(address);
    const current = this.failures.get(address);
    if (current && current.count >= this.limit) {
      const retryAfter = Math.max(1, Math.ceil((current.since + this.windowMs - at) / 1000));
      return { error: `too many ${this.what} from this address: try again in ${retryAfter}s`, retryAfter };
    }
    return null;
  }

  /** Count a failure against `address` (a failureKey), and against the server. */
  fail(address: string): void {
    this.global.count++;
    const record = this.failures.get(address);
    if (record) {
      record.count++;
      return;
    }
    this.failures.set(address, { count: 1, since: this.now() });
    if (this.failures.size > MAX_TRACKED) this.failures.delete(this.failures.keys().next().value!);
  }

  /** Forget `address`'s failures: it got through. */
  clear(address: string): void {
    this.failures.delete(address);
  }
}

/** Who holds a token, as a gate knows it by the token's digest. */
interface Holder {
  /** The named token's name; null for the unnamed `--token`. */
  name: string | null;
  scope: TokenScope;
}

/** A gate's setup beyond its unnamed token. */
export interface TokenGateSetup extends TokenGateOptions {
  /** The unnamed token's scope (`--token-scope`; default read). */
  scope?: TokenScope;
  /** Named tokens (`--tokens FILE`; ODW extension), each by its sha256. */
  named?: readonly NamedToken[];
}

/** The token check of one server: its tokens, its cookie, and the failures per address. */
export class TokenGate {
  /** sha256 hex of a token → who holds it: the unnamed token and the named ones. */
  private readonly holders = new Map<string, Holder>();
  private readonly limiter: FailureLimiter;

  constructor(
    /** The unnamed token (`--token`); null with named tokens only. */
    token: string | null,
    /** The cookie's name: per port, so two servers on one host keep apart. */
    readonly cookieName: string,
    options: TokenGateSetup = {},
  ) {
    if (token !== null) {
      if (!isValidToken(token)) throw new Error("a token is 16-256 characters of A-Z a-z 0-9 . _ ~ -");
      this.holders.set(hashHex(token), { name: null, scope: options.scope ?? "read" });
    }
    for (const named of options.named ?? []) {
      if (!this.holders.has(named.hash)) this.holders.set(named.hash, { name: named.name, scope: named.scope });
    }
    if (this.holders.size === 0) throw new Error("a token gate needs a token (--token) or named tokens (--tokens)");
    this.limiter = new FailureLimiter("wrong tokens", options);
  }

  /** May `req` (its URL parsed as `url`) read? A yes says whose token it is, and its scope. */
  check(req: IncomingMessage, url: URL): AuthResult {
    const address = failureKey(req.socket.remoteAddress ?? "unknown");
    const blocked = this.limiter.blocked(address);
    if (blocked) return { ok: false, status: 429, ...blocked };
    const { presented, fromQuery } = this.presented(req, url);
    if (presented === null || presented === "") return { ok: false, status: 401, error: "this dashboard needs a token (odw serve --token)" };
    const holder = this.lookup(presented);
    if (holder) {
      this.limiter.clear(address);
      return { ok: true, setCookie: fromQuery ? this.cookie(presented) : null, name: holder.name, scope: holder.scope };
    }
    this.limiter.fail(address);
    return { ok: false, status: 401, error: "wrong token" };
  }

  /**
   * The name of the named token `req` carries, or null — for a route with a
   * credential of its own (an approve link), to attribute what it does. It
   * answers nothing by it, so a wrong token here counts as no failure.
   */
  identify(req: IncomingMessage, url: URL): string | null {
    const { presented } = this.presented(req, url);
    return presented ? (this.lookup(presented)?.name ?? null) : null;
  }

  /** One credential is judged: ?token= first (it replaces a stale cookie of an earlier token), then the header, then the cookie. */
  private presented(req: IncomingMessage, url: URL): { presented: string | null; fromQuery: boolean } {
    const fromQuery = url.searchParams.get("token");
    return {
      presented: fromQuery ?? bearer(req.headers.authorization) ?? cookie(req.headers.cookie, this.cookieName),
      fromQuery: fromQuery !== null,
    };
  }

  /**
   * Constant-time in the token: it is hashed first, and only its digest is
   * looked up — what a lookup's timing could tell is about a sha256, not the token.
   */
  private lookup(value: string): Holder | null {
    return this.holders.get(hashHex(value)) ?? null;
  }

  private cookie(token: string): string {
    return `${this.cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict`;
  }
}

function hashHex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** The token of an `Authorization: Bearer <token>` header, or null. */
function bearer(header: string | undefined): string | null {
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header ?? "");
  return m ? m[1]! : null;
}

/** The value of cookie `name` in a Cookie header, or null. */
export function cookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}
