/**
 * Approve links (ODW extension): signed, one-time approve/reject URLs for a
 * checkpoint() that waits for a person, so it can be answered from a phone
 * while nothing else of the dashboard becomes writable.
 *
 * Who does what:
 *   odw serve --public-url URL   keeps the per-runs-root secret (created on
 *                                first use, 0600, `--rotate-approve-secret`
 *                                replaces it), announces itself in the runs
 *                                root while it runs, and answers the links
 *                                (see ./approve-route)
 *   the worker                   mints a checkpoint's two links when its
 *                                `waiting` notify hooks fire — only while such
 *                                a server runs; otherwise the hooks say why
 *
 *   <runsRoot>/.approve-secret        32 random bytes, hex; mode 0600
 *   <runsRoot>/.approve-serve.json    { publicUrl, pid, startedAt }: the server that answers links
 *   <runDir>/approve-links/<nonce>    one file per link used (created exclusively): a replay is refused
 *
 * A link is `<publicUrl>/approve/<body>.<mac>`: `body` is the base64url JSON
 * `[1, runId, checkpointId, action, exp, nonce]` and `mac` its HMAC-SHA256
 * under the secret (domain-separated), so nothing in it can be changed — not
 * the run, the checkpoint, the action or the expiry (Unix seconds). A
 * checkpoint's approve and reject links share one nonce: using either one
 * spends both.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { isCheckpointId } from "../control.js";
import { readJsonFile, writeJsonAtomic } from "./fs-util.js";
import { RUN_ID_RE } from "./run-source.js";

export const APPROVE_SECRET_FILE = ".approve-secret";
export const APPROVE_SERVE_FILE = ".approve-serve.json";
/** The run directory's record of the links used, one file per nonce. */
export const USED_LINKS_DIR = "approve-links";
/** The header a non-browser client (an ntfy http action) names its action in, instead of the form's CSRF value. */
export const ACTION_HEADER = "x-odw-action";

export type LinkAction = "approve" | "reject";

/** What a link says, all of it signed. */
export interface LinkClaims {
  runId: string;
  checkpointId: number;
  action: LinkAction;
  /** When it stops working, Unix seconds. */
  exp: number;
  /** 16 random bytes, base64url: what marks it used. Shared by a checkpoint's two links. */
  nonce: string;
}

export type LinkCheck =
  | { ok: true; claims: LinkClaims }
  | { ok: false; reason: "malformed" | "tampered" | "expired" };

/** A checkpoint's two links, for the notify hooks. */
export interface CheckpointLinks {
  approveUrl: string;
  rejectUrl: string;
  /** When both stop working, Unix seconds. */
  expiresAt: number;
}

/** Minted links, or why there are none. */
export type MintResult = { ok: true; links: CheckpointLinks } | { ok: false; reason: string };

/** The server that answers links, as it announces itself in the runs root. */
export interface ServeAnnouncement {
  publicUrl: string;
  pid: number;
  startedAt: number;
}

const TOKEN_MAX = 2048;
const B64URL = /^[A-Za-z0-9_-]+$/;
const NONCE_RE = /^[A-Za-z0-9_-]{22}$/;
const SECRET_RE = /^[0-9a-f]{64}$/;
/** Domain separation: this key signs nothing else, but a MAC should say what it is for. */
const MAC_DOMAIN = "odw-approve-link-v1.";

// --- the secret ------------------------------------------------------------------

/**
 * The runs root's link secret, for the server: created when missing, and
 * replaced when `rotate` — which kills every link minted before — or when it
 * is malformed or readable by anyone but its owner (a secret others could
 * read is no secret).
 */
export function ensureApproveSecret(root: string, options: { rotate?: boolean } = {}): Buffer {
  const current = options.rotate ? null : readApproveSecret(root);
  if (current) return current;
  const secret = randomBytes(32);
  mkdirSync(root, { recursive: true });
  const path = join(root, APPROVE_SECRET_FILE);
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, secret.toString("hex") + "\n", { mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return secret;
}

/** The runs root's link secret, or null when there is none usable (missing, malformed, or open to others). */
export function readApproveSecret(root: string): Buffer | null {
  const path = join(root, APPROVE_SECRET_FILE);
  try {
    if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) return null;
    const hex = readFileSync(path, "utf8").trim();
    return SECRET_RE.test(hex) ? Buffer.from(hex, "hex") : null;
  } catch {
    return null;
  }
}

// --- tokens ----------------------------------------------------------------------

/** A fresh nonce: 16 random bytes, base64url. */
export function newNonce(): string {
  return randomBytes(16).toString("base64url");
}

/** The path segment of a link: its signed claims and their MAC. */
export function mintLinkToken(secret: Buffer, claims: LinkClaims): string {
  const body = Buffer.from(
    JSON.stringify([1, claims.runId, claims.checkpointId, claims.action, claims.exp, claims.nonce]),
    "utf8",
  ).toString("base64url");
  return `${body}.${mac(secret, body).toString("base64url")}`;
}

/**
 * What a link's token says, once its MAC holds (compared in constant time)
 * and it has not expired at `nowSec`. The MAC is checked first: a token whose
 * expiry was changed is "tampered", never "expired".
 */
export function verifyLinkToken(secret: Buffer, token: string, nowSec: number): LinkCheck {
  if (token.length > TOKEN_MAX) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 2 || !B64URL.test(parts[0]!) || !B64URL.test(parts[1]!)) return { ok: false, reason: "malformed" };
  const [body, given] = parts as [string, string];
  const expected = mac(secret, body);
  const presented = Buffer.from(given, "base64url");
  // Canonical encoding only: a last character whose unused bits differ decodes the same, yet is another token.
  const canonical = presented.toString("base64url") === given;
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected) || !canonical) return { ok: false, reason: "tampered" };
  const claims = parseClaims(body);
  // Signed, yet not a shape this code mints: treat it as nothing it could act on.
  if (!claims) return { ok: false, reason: "malformed" };
  if (nowSec >= claims.exp) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}

function mac(secret: Buffer, body: string): Buffer {
  return createHmac("sha256", secret).update(MAC_DOMAIN + body, "utf8").digest();
}

function parseClaims(body: string): LinkClaims | null {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value.length !== 6 || value[0] !== 1) return null;
  const [, runId, checkpointId, action, exp, nonce] = value as unknown[];
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId) || /^\.+$/.test(runId)) return null;
  if (!isCheckpointId(checkpointId)) return null;
  if (action !== "approve" && action !== "reject") return null;
  if (typeof exp !== "number" || !Number.isSafeInteger(exp)) return null;
  if (typeof nonce !== "string" || !NONCE_RE.test(nonce)) return null;
  return { runId, checkpointId, action, exp, nonce };
}

// --- the server's announcement ---------------------------------------------------

/**
 * `odw serve --public-url`'s base URL, normalized (no trailing slash), or
 * null when it is not one: an absolute http(s) URL with no credentials, query
 * or fragment, and none of `, ; " '` or whitespace — so a link can stand in an
 * ntfy `Actions` header as it is. It is a root (`https://host[:port]`): the
 * server answers links at /approve/, so a URL with a path — a proxy serving
 * odw under one — would mint links it never answers ({@link publicUrlHasPath}).
 */
export function parsePublicUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || url.search || url.hash || raw.includes("?") || raw.includes("#")) return null;
  if (publicUrlHasPath(raw)) return null;
  const base = url.origin;
  return /[,;"'\s]/.test(base) ? null : base;
}

/** Does `raw`, an http(s) URL, have a path past its root (`https://host/base`)? */
export function publicUrlHasPath(raw: string): boolean {
  try {
    return new URL(raw).pathname.replace(/\/+$/, "") !== "";
  } catch {
    return false;
  }
}

/** Say, in the runs root, that this server answers links at `publicUrl`. */
export function announceServe(root: string, publicUrl: string, pid: number = process.pid): void {
  mkdirSync(root, { recursive: true });
  writeJsonAtomic(join(root, APPROVE_SERVE_FILE), { publicUrl, pid, startedAt: Math.floor(Date.now() / 1000) });
}

/** Take this server's announcement back — only its own: another server may have announced since. */
export function withdrawServe(root: string, pid: number = process.pid): void {
  const path = join(root, APPROVE_SERVE_FILE);
  if (readJsonFile<ServeAnnouncement>(path)?.pid === pid) rmSync(path, { force: true });
}

/** The server that answers links for this runs root, when one announced itself and its process is alive. */
export function liveServe(root: string): ServeAnnouncement | null {
  const found = readJsonFile<Record<string, unknown>>(join(root, APPROVE_SERVE_FILE));
  if (!found || typeof found.publicUrl !== "string" || !Number.isSafeInteger(found.pid) || (found.pid as number) <= 0) return null;
  const publicUrl = parsePublicUrl(found.publicUrl);
  if (!publicUrl || !processAlive(found.pid as number)) return null;
  return { publicUrl, pid: found.pid as number, startedAt: typeof found.startedAt === "number" ? found.startedAt : 0 };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// --- minting ---------------------------------------------------------------------

/**
 * The runs roots a run directory may sit in: `<root>/<bucket>/<runId>` or a
 * legacy flat `<root>/<runId>` — a worker knows its run directory, not which.
 */
export function runsRootsOf(runDir: string): string[] {
  return [dirname(dirname(runDir)), dirname(runDir)];
}

/**
 * A waiting checkpoint's approve and reject links, valid `ttlSec` from `now`
 * — or why there are none: no `odw serve --public-url` runs for the runs
 * root (the first of `roots` one announced itself in), or it has no usable secret.
 */
export function mintCheckpointLinks(
  roots: string | readonly string[],
  runId: string,
  checkpointId: number,
  ttlSec: number,
  now: number = Date.now(),
): MintResult {
  let root = "";
  let serve: ServeAnnouncement | null = null;
  for (const candidate of typeof roots === "string" ? [roots] : roots) {
    serve = liveServe(candidate);
    if (serve) {
      root = candidate;
      break;
    }
  }
  if (!serve) {
    return { ok: false, reason: "no `odw serve --public-url <url>` is running for this runs root, so no approve links were minted" };
  }
  const secret = readApproveSecret(root);
  if (!secret) return { ok: false, reason: "the runs root has no usable approve secret: restart `odw serve --public-url <url>`" };
  const exp = Math.floor(now / 1000) + Math.max(1, Math.floor(ttlSec));
  const nonce = newNonce();
  const url = (action: LinkAction) => `${serve.publicUrl}/approve/${mintLinkToken(secret, { runId, checkpointId, action, exp, nonce })}`;
  return { ok: true, links: { approveUrl: url("approve"), rejectUrl: url("reject"), expiresAt: exp } };
}

/**
 * The value of an ntfy `Actions` header with an Approve and a Reject button:
 * each an `http` action that POSTs to its link — naming its action in the
 * X-ODW-Action header, which stands in for the confirmation page's CSRF value
 * — and clears the notification once it succeeded. Format (simple header
 * form, actions separated by ";"): https://docs.ntfy.sh/publish/#action-buttons
 */
export function ntfyActions(links: CheckpointLinks): string {
  const button = (label: string, action: LinkAction, url: string) =>
    `http, ${label}, ${url}, method=POST, headers.X-ODW-Action=${action}, clear=true`;
  return [button("Approve", "approve", links.approveUrl), button("Reject", "reject", links.rejectUrl)].join("; ");
}

// --- single use ------------------------------------------------------------------

/** Has a link with this nonce been used in this run? */
export function linkUsed(runDir: string, nonce: string): boolean {
  return NONCE_RE.test(nonce) && existsSync(join(runDir, USED_LINKS_DIR, nonce));
}

/**
 * Mark a link used, atomically: true for the one request that got there
 * first, false for every other — another process's included (the record is
 * created exclusively).
 */
export function claimLink(runDir: string, claims: LinkClaims, nowSec: number = Math.floor(Date.now() / 1000)): boolean {
  if (!NONCE_RE.test(claims.nonce)) return false;
  const dir = join(runDir, USED_LINKS_DIR);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(join(dir, claims.nonce), JSON.stringify({ checkpointId: claims.checkpointId, action: claims.action, at: nowSec }) + "\n", {
      flag: "wx",
    });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}
