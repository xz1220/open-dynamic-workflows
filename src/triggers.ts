/**
 * Signed inbound triggers (an ODW extension): the config's `triggers`, the
 * signature each provider puts on its webhooks, the tiny JSONPath subset that
 * maps a delivery's body into a run's args, and the `context` a run started
 * this way carries to its notify hooks. Pure: the HTTP route that uses it is
 * ../runtime/trigger-route.
 *
 *   "triggers": {
 *     "<name>": {
 *       "workflow": "fix-issue",                 // a path or a managed workflow name
 *       "secretEnv": "LINEAR_WEBHOOK_SECRET",    // or "secret": "…" (16+ characters)
 *       "verify": "github" | "linear" | "slack" | "hmac-sha256",
 *       "args": { "issue": "$.data.identifier", "body": "$.data.description" },
 *       "events": ["Issue.create"],              // optional: which deliveries start a run
 *       "dedupe": "$.data.id",                   // optional: one active run per value
 *       "concurrency": 1,                        // optional: active runs at once
 *       "rateLimit": { "max": 30, "windowSec": 3600 },
 *       "untrusted": true,                       // the default: issue text is untrusted input
 *       "source": "~/src/app"                    // optional: the run's working directory
 *     }
 *   }
 *
 * How each provider signs (each verified exactly as its documentation says):
 *
 *   github  `X-Hub-Signature-256: sha256=<hex HMAC-SHA256(secret, raw body)>`.
 *           https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
 *           GitHub signs no timestamp: a replayed delivery is caught by its
 *           signature or its `X-GitHub-Delivery` id having been seen — kept
 *           under the runs root for 30 days, across restarts (see
 *           ../runtime/trigger-seen, which says what that leaves).
 *   linear  `Linear-Signature: <hex HMAC-SHA256(secret, raw body)>`, and the
 *           body's `webhookTimestamp` (Unix ms) within a minute of now, as the
 *           docs recommend against replays.
 *           https://linear.app/developers/webhooks#securing-webhooks
 *   slack   `X-Slack-Signature: v0=<hex HMAC-SHA256(secret, "v0:" + ts + ":" + raw body)>`
 *           with `X-Slack-Request-Timestamp: <ts>` (Unix seconds) within five
 *           minutes of now.
 *           https://api.slack.com/authentication/verifying-requests-from-slack
 *   hmac-sha256  ODW's own, for anything else (a CI job, a script):
 *           `X-ODW-Signature: sha256=<hex HMAC-SHA256(secret, ts + "." + raw body)>`
 *           with `X-ODW-Timestamp: <ts>` (Unix seconds) within five minutes.
 *
 * Every comparison is constant-time, and the HMAC is always over the raw bytes
 * received — never over a re-serialized parse.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { ConfigError } from "./errors.js";

/** How a trigger's deliveries are signed. */
export type TriggerVerify = "github" | "linear" | "slack" | "hmac-sha256";

export const TRIGGER_VERIFY: readonly TriggerVerify[] = ["github", "linear", "slack", "hmac-sha256"];

/** One configured trigger (see the module comment). */
export interface TriggerSettings {
  workflow: string;
  /** The shared secret inline; null when it comes from `secretEnv`. */
  secret: string | null;
  /** The environment variable of `odw serve` that holds the secret. */
  secretEnv: string | null;
  verify: TriggerVerify;
  /** Run arg → JSONPath into the delivery's body. */
  args: Record<string, string>;
  /** The provider event types that start a run; null: every one. */
  events: string[] | null;
  /** JSONPath of the value only one active run may have at a time; null: none. */
  dedupe: string | null;
  /** How many of its runs may be active at once; null: no cap. */
  concurrency: number | null;
  /** Runs it may start per window. */
  rateLimit: { max: number; windowSec: number };
  /** Start runs `--untrusted` (the default). */
  untrusted: boolean;
  /** The runs' working directory; null: where `odw serve` runs. */
  source: string | null;
}

/** A trigger's name: what `/api/triggers/<name>` takes. */
export const TRIGGER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The shortest secret a trigger accepts: a short one can be guessed from a captured delivery. */
export const MIN_SECRET_LENGTH = 16;

/** The rate limit a trigger gets unless it sets one. */
export const DEFAULT_TRIGGER_RATE = { max: 30, windowSec: 3600 } as const;

/** Seconds a Slack or ODW-signed delivery's timestamp may be off from now. */
export const TIMESTAMP_WINDOW_SEC = 300;
/** Seconds a Linear delivery's `webhookTimestamp` may be off from now (Linear's docs: a minute). */
export const LINEAR_WINDOW_SEC = 60;
/**
 * How long a GitHub delivery's signature is remembered in memory. The route
 * keeps GitHub's deliveries on disk for 30 days instead (../runtime/trigger-seen).
 */
export const GITHUB_REPLAY_SEC = 3600;

const KNOWN_TRIGGER_KEYS = [
  "workflow", "secret", "secretEnv", "verify", "args", "events", "dedupe", "concurrency", "rateLimit", "untrusted", "source",
] as const;

// --- config -------------------------------------------------------------------

/**
 * Validate the config's `triggers`. Strict — an unknown key is an error, not a
 * warning: a misspelled `untrusted` must never quietly fall back.
 */
export function buildTriggers(raw: unknown): Record<string, TriggerSettings> {
  if (!isObject(raw)) throw new ConfigError(`"triggers" must be an object of named triggers; got ${kindOf(raw)}`);
  const out: Record<string, TriggerSettings> = {};
  for (const [name, spec] of Object.entries(raw)) {
    const where = `"triggers.${name}"`;
    if (!TRIGGER_NAME_RE.test(name)) {
      throw new ConfigError(`trigger name ${JSON.stringify(name)} must be 1-64 letters, digits, '.', '_' or '-', starting with a letter or digit`);
    }
    if (!isObject(spec)) throw new ConfigError(`${where} must be an object; got ${kindOf(spec)}`);
    for (const key of Object.keys(spec)) {
      if (!(KNOWN_TRIGGER_KEYS as readonly string[]).includes(key)) {
        throw new ConfigError(`${where} has no field "${key}"; use ${KNOWN_TRIGGER_KEYS.join(", ")}`);
      }
    }
    out[name] = buildTrigger(where, spec);
  }
  return out;
}

function buildTrigger(where: string, spec: Record<string, unknown>): TriggerSettings {
  if (typeof spec.workflow !== "string" || spec.workflow.trim() === "") {
    throw new ConfigError(`${where}.workflow must name the workflow to run (a path or a managed name)`);
  }
  if (!TRIGGER_VERIFY.includes(spec.verify as TriggerVerify)) {
    throw new ConfigError(`${where}.verify must be one of ${TRIGGER_VERIFY.join(", ")}; got ${JSON.stringify(spec.verify) ?? "nothing"}`);
  }
  const hasSecret = spec.secret != null;
  const hasEnv = spec.secretEnv != null;
  if (hasSecret === hasEnv) throw new ConfigError(`${where} needs exactly one of "secret" or "secretEnv" (the name of a variable that holds it)`);
  if (hasSecret && (typeof spec.secret !== "string" || spec.secret.length < MIN_SECRET_LENGTH)) {
    throw new ConfigError(`${where}.secret must be a string of ${MIN_SECRET_LENGTH} or more characters`);
  }
  if (hasEnv && (typeof spec.secretEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(spec.secretEnv))) {
    throw new ConfigError(`${where}.secretEnv must be an environment variable name`);
  }
  const args: Record<string, string> = {};
  if (spec.args != null) {
    if (!isObject(spec.args)) throw new ConfigError(`${where}.args must map arg names to JSONPaths ("$.data.id"); got ${kindOf(spec.args)}`);
    for (const [key, path] of Object.entries(spec.args)) {
      args[key] = checkPath(`${where}.args.${key}`, path);
    }
  }
  let events: string[] | null = null;
  if (spec.events != null) {
    if (!Array.isArray(spec.events) || spec.events.length === 0 || !spec.events.every((e) => typeof e === "string" && e.length > 0)) {
      throw new ConfigError(`${where}.events must be a non-empty list of event types, e.g. ["issues.labeled"]`);
    }
    events = [...(spec.events as string[])];
  }
  const dedupe = spec.dedupe == null ? null : checkPath(`${where}.dedupe`, spec.dedupe);
  let concurrency: number | null = null;
  if (spec.concurrency != null) {
    if (typeof spec.concurrency !== "number" || !Number.isInteger(spec.concurrency) || spec.concurrency < 1) {
      throw new ConfigError(`${where}.concurrency must be a whole number, 1 or more`);
    }
    concurrency = spec.concurrency;
  }
  let rateLimit: { max: number; windowSec: number } = { ...DEFAULT_TRIGGER_RATE };
  if (spec.rateLimit != null) {
    const rate = spec.rateLimit;
    const whole = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 1;
    if (!isObject(rate) || !whole(rate.max) || !whole(rate.windowSec) || Object.keys(rate).some((k) => k !== "max" && k !== "windowSec")) {
      throw new ConfigError(`${where}.rateLimit must be { "max": <runs>, "windowSec": <seconds> }, both whole numbers 1 or more`);
    }
    rateLimit = { max: rate.max as number, windowSec: rate.windowSec as number };
  }
  if (spec.untrusted != null && typeof spec.untrusted !== "boolean") {
    throw new ConfigError(`${where}.untrusted must be true (the default) or false`);
  }
  if (spec.source != null && (typeof spec.source !== "string" || spec.source.trim() === "")) {
    throw new ConfigError(`${where}.source must be a directory path`);
  }
  return {
    workflow: spec.workflow,
    secret: hasSecret ? (spec.secret as string) : null,
    secretEnv: hasEnv ? (spec.secretEnv as string) : null,
    verify: spec.verify as TriggerVerify,
    args,
    events,
    dedupe,
    concurrency,
    rateLimit,
    untrusted: spec.untrusted !== false,
    source: spec.source == null ? null : (spec.source as string),
  };
}

function checkPath(where: string, path: unknown): string {
  if (typeof path !== "string" || parsePath(path) === null) {
    throw new ConfigError(
      `${where} must be a JSONPath such as "$.data.id", "$.issue.labels[0].name" or "$['key with spaces']"; got ${JSON.stringify(path) ?? "nothing"}`,
    );
  }
  return path;
}

// --- JSONPath (a tiny subset) ----------------------------------------------------

/** One step of a path: an object key or an array index. */
export type PathStep = string | number;

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$-]*/;

/**
 * Parse the JSONPath subset triggers take: `$`, then any of `.key`,
 * `['key']`, `["key"]` and `[n]`. No wildcards, filters or recursion: a path
 * names one value. Null when `path` is not one.
 */
export function parsePath(path: string): PathStep[] | null {
  if (!path.startsWith("$") || path.length > 512) return null;
  const steps: PathStep[] = [];
  let rest = path.slice(1);
  while (rest.length > 0) {
    if (rest.startsWith(".")) {
      const ident = IDENT.exec(rest.slice(1));
      if (!ident) return null;
      steps.push(ident[0]);
      rest = rest.slice(1 + ident[0].length);
      continue;
    }
    const index = /^\[(0|[1-9][0-9]{0,8})\]/.exec(rest);
    if (index) {
      steps.push(Number(index[1]));
      rest = rest.slice(index[0].length);
      continue;
    }
    const quoted = /^\[(?:'([^'\\]*)'|"([^"\\]*)")\]/.exec(rest);
    if (quoted) {
      steps.push(quoted[1] ?? quoted[2] ?? "");
      rest = rest.slice(quoted[0].length);
      continue;
    }
    return null;
  }
  return steps;
}

/** The value at `path` in `root` (own properties only), or undefined when there is none. */
export function evalPath(root: unknown, path: string): unknown {
  const steps = parsePath(path);
  if (!steps) return undefined;
  let node: unknown = root;
  for (const step of steps) {
    if (typeof step === "number") {
      if (!Array.isArray(node) || step >= node.length) return undefined;
      node = node[step];
    } else {
      if (!isObject(node) || !Object.hasOwn(node, step)) return undefined;
      node = node[step];
    }
  }
  return node;
}

/** The run args a delivery maps to: each path's value, those it lacks left out. */
export function mapArgs(body: unknown, args: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, path] of Object.entries(args)) {
    const value = evalPath(body, path);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** The dedupe key a delivery has: its value at `path` as JSON, or null when it has none. */
export function dedupeKey(body: unknown, path: string | null): string | null {
  if (path === null) return null;
  const value = evalPath(body, path);
  if (value === undefined || value === null) return null;
  return JSON.stringify(value).slice(0, 512);
}

// --- signatures -----------------------------------------------------------------

/** What a signature check sees of a request. */
export interface SignedRequest {
  /** Header names lower-cased, as node:http gives them. */
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  /** Now, Unix milliseconds. */
  now: number;
}

/** A signature check's answer: `replayKey` names the delivery for the replay cache. */
export type Verdict = { ok: true; replayKey: string; replayTtlSec: number } | { ok: false; error: string };

/**
 * Check a request's signature the way `verify`'s provider documents it (see
 * the module comment). Linear's timestamp lives in the body: it is read only
 * after the signature over the raw bytes checked out.
 */
export function verifySignature(verify: TriggerVerify, secret: string, req: SignedRequest): Verdict {
  const hmac = (data: Buffer | string) => createHmac("sha256", secret).update(data).digest();
  switch (verify) {
    case "github": {
      const given = hexAfter(header(req.headers, "x-hub-signature-256"), "sha256=");
      if (!given) return { ok: false, error: "missing or malformed X-Hub-Signature-256" };
      if (!sameBytes(given, hmac(req.body))) return { ok: false, error: "bad signature" };
      return { ok: true, replayKey: given.toString("hex"), replayTtlSec: GITHUB_REPLAY_SEC };
    }
    case "linear": {
      const given = hexAfter(header(req.headers, "linear-signature"), "");
      if (!given) return { ok: false, error: "missing or malformed Linear-Signature" };
      if (!sameBytes(given, hmac(req.body))) return { ok: false, error: "bad signature" };
      const ts = linearTimestamp(req.body);
      if (ts === null) return { ok: false, error: "the body has no webhookTimestamp" };
      if (Math.abs(req.now - ts) > LINEAR_WINDOW_SEC * 1000) return { ok: false, error: "stale delivery: webhookTimestamp is over a minute off" };
      return { ok: true, replayKey: given.toString("hex"), replayTtlSec: 2 * LINEAR_WINDOW_SEC };
    }
    case "slack":
    case "hmac-sha256": {
      const slack = verify === "slack";
      const tsHeader = slack ? "x-slack-request-timestamp" : "x-odw-timestamp";
      const raw = header(req.headers, tsHeader);
      if (!raw || !/^\d{1,12}$/.test(raw)) return { ok: false, error: `missing or malformed ${slack ? "X-Slack-Request-Timestamp" : "X-ODW-Timestamp"}` };
      if (Math.abs(req.now / 1000 - Number(raw)) > TIMESTAMP_WINDOW_SEC) return { ok: false, error: "stale delivery: its timestamp is over five minutes off" };
      const given = slack
        ? hexAfter(header(req.headers, "x-slack-signature"), "v0=")
        : hexAfter(header(req.headers, "x-odw-signature"), "sha256=");
      if (!given) return { ok: false, error: `missing or malformed ${slack ? "X-Slack-Signature" : "X-ODW-Signature"}` };
      const base = slack ? Buffer.concat([Buffer.from(`v0:${raw}:`), req.body]) : Buffer.concat([Buffer.from(`${raw}.`), req.body]);
      if (!sameBytes(given, hmac(base))) return { ok: false, error: "bad signature" };
      return { ok: true, replayKey: given.toString("hex"), replayTtlSec: 2 * TIMESTAMP_WINDOW_SEC };
    }
  }
}

/**
 * The headers that sign `body` for `verify` — what a sender computes; the
 * tests' vectors and the docs' curl recipe (hmac-sha256) are made with it.
 * `now` is Unix milliseconds.
 */
export function signatureHeaders(verify: TriggerVerify, secret: string, body: string | Buffer, now: number): Record<string, string> {
  const bytes = typeof body === "string" ? Buffer.from(body) : body;
  const hex = (data: Buffer) => createHmac("sha256", secret).update(data).digest("hex");
  const ts = String(Math.floor(now / 1000));
  switch (verify) {
    case "github":
      return { "x-hub-signature-256": `sha256=${hex(bytes)}` };
    case "linear":
      return { "linear-signature": hex(bytes) };
    case "slack":
      return { "x-slack-request-timestamp": ts, "x-slack-signature": `v0=${hex(Buffer.concat([Buffer.from(`v0:${ts}:`), bytes]))}` };
    case "hmac-sha256":
      return { "x-odw-timestamp": ts, "x-odw-signature": `sha256=${hex(Buffer.concat([Buffer.from(`${ts}.`), bytes]))}` };
  }
}

/**
 * The signatures already accepted, each kept for its provider's window: the
 * same delivery twice — a replay, or a sender's retry — starts one run.
 */
export class ReplayCache {
  private readonly seen = new Map<string, number>();
  constructor(private readonly max = 10_000) {}

  /** Record `key` until `now + ttlSec`; false when it was already there (a replay). */
  remember(key: string, ttlSec: number, now: number): boolean {
    for (const [k, until] of this.seen) {
      if (until > now) break; // insertion order ≈ expiry order: stop at the first live one
      this.seen.delete(k);
    }
    const until = this.seen.get(key);
    if (until !== undefined && until > now) return false;
    this.seen.set(key, now + ttlSec * 1000);
    if (this.seen.size > this.max) this.seen.delete(this.seen.keys().next().value!);
    return true;
  }

  /** Forget `key`: its delivery started nothing yet (refused for now), so the sender's retry must count. */
  forget(key: string): void {
    this.seen.delete(key);
  }
}

function header(headers: SignedRequest["headers"], name: string): string | null {
  const value = headers[name];
  const one = Array.isArray(value) ? (value.length === 1 ? value[0] : undefined) : value;
  return typeof one === "string" ? one.trim() : null;
}

/** The 32 bytes a `<prefix><64 hex>` header carries, or null when it is not that. */
function hexAfter(value: string | null, prefix: string): Buffer | null {
  if (value === null || !value.startsWith(prefix)) return null;
  const hex = value.slice(prefix.length);
  return /^[0-9a-fA-F]{64}$/.test(hex) ? Buffer.from(hex, "hex") : null;
}

function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function linearTimestamp(body: Buffer): number | null {
  try {
    const parsed = JSON.parse(body.toString("utf8")) as unknown;
    const ts = isObject(parsed) ? parsed.webhookTimestamp : undefined;
    return typeof ts === "number" && Number.isFinite(ts) ? ts : null;
  } catch {
    return null;
  }
}

// --- what a delivery is ------------------------------------------------------------

/**
 * What a run started by a trigger records as `context` (meta.json) and hands
 * its notify hooks, so a hook can answer where the work came from: the
 * trigger, the provider, and — when the delivery has them — its event type,
 * delivery id, the subject's id and URL, the repository (GitHub), and the
 * Slack channel and thread.
 */
export interface TriggerContext {
  trigger: string;
  provider: TriggerVerify;
  event?: string;
  deliveryId?: string;
  id?: string;
  url?: string;
  repo?: string;
  channel?: string;
  threadTs?: string;
  /** The trigger's `dedupe` value for this delivery, as JSON. */
  dedupe?: string;
}

/** The event types a delivery answers to, most specific last: `issues`, `issues.labeled`. */
export function eventTypes(verify: TriggerVerify, headers: SignedRequest["headers"], body: unknown): string[] {
  const b = isObject(body) ? body : {};
  const withAction = (type: unknown, action: unknown): string[] =>
    typeof type === "string" && type ? (typeof action === "string" && action ? [type, `${type}.${action}`] : [type]) : [];
  switch (verify) {
    case "github":
      return withAction(header(headers, "x-github-event"), b.action);
    case "linear":
      return withAction(b.type, b.action);
    case "slack": {
      if (typeof b.command === "string") return [b.command]; // a slash command
      const event = isObject(b.event) ? b.event : {};
      return withAction(event.type, event.subtype);
    }
    case "hmac-sha256":
      return withAction(header(headers, "x-odw-event"), undefined);
  }
}

/** A delivery's context (see TriggerContext): only strings, each cut to 500 characters; URLs only http(s). */
export function triggerContext(
  name: string,
  verify: TriggerVerify,
  headers: SignedRequest["headers"],
  body: unknown,
): TriggerContext {
  const b = isObject(body) ? body : {};
  const types = eventTypes(verify, headers, body);
  const ctx: TriggerContext = { trigger: name, provider: verify };
  const set = (key: Exclude<keyof TriggerContext, "trigger" | "provider" | "dedupe">, value: unknown) => {
    const text = typeof value === "number" && Number.isFinite(value) ? String(value) : typeof value === "string" ? value : null;
    if (text === null || text === "") return;
    if (key === "url" && !/^https?:\/\//i.test(text)) return;
    ctx[key] = text.replace(/[\0-\x1f\x7f]/g, "").slice(0, 500);
  };
  set("event", types[types.length - 1]);
  switch (verify) {
    case "github": {
      const subject = [b.issue, b.pull_request, b.discussion].find(isObject);
      set("deliveryId", header(headers, "x-github-delivery"));
      set("id", subject?.number);
      const comment = isObject(b.comment) ? b.comment : null;
      set("url", comment?.html_url ?? subject?.html_url ?? (isObject(b.repository) ? b.repository.html_url : undefined));
      set("repo", isObject(b.repository) ? b.repository.full_name : undefined);
      break;
    }
    case "linear": {
      const data = isObject(b.data) ? b.data : {};
      set("deliveryId", header(headers, "linear-delivery") ?? b.webhookId);
      // A comment's issue is where an answer goes.
      set("id", typeof data.issueId === "string" ? data.issueId : data.id);
      set("url", b.url ?? data.url);
      break;
    }
    case "slack": {
      if (typeof b.command === "string") {
        set("id", b.trigger_id);
        set("channel", b.channel_id);
        break;
      }
      const event = isObject(b.event) ? b.event : {};
      set("deliveryId", b.event_id);
      set("id", event.ts);
      set("channel", event.channel);
      set("threadTs", event.thread_ts ?? event.ts);
      break;
    }
    case "hmac-sha256":
      set("deliveryId", header(headers, "x-odw-delivery"));
      set("id", b.id);
      set("url", b.url);
      break;
  }
  return ctx;
}

/**
 * The body a delivery carries, parsed: JSON, or a form (Slack's slash
 * commands and interactivity post `application/x-www-form-urlencoded`; an
 * interactivity form's `payload` field is JSON). Null when it is neither.
 */
export function parseDeliveryBody(body: Buffer, contentType: string | undefined): unknown {
  const essence = String(contentType ?? "").split(";")[0]!.trim().toLowerCase();
  const text = body.toString("utf8");
  if (essence === "application/x-www-form-urlencoded") {
    const form: Record<string, string> = {};
    for (const [key, value] of new URLSearchParams(text)) form[key] = value;
    if (typeof form.payload === "string") {
      try {
        return JSON.parse(form.payload) as unknown;
      } catch {
        return null;
      }
    }
    return form;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function kindOf(raw: unknown): string {
  if (Array.isArray(raw)) return "a list";
  return raw !== null && typeof raw === "object" ? "an object" : `a ${typeof raw}`;
}
