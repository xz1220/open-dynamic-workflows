/**
 * `POST /api/triggers/<name>` (an ODW extension): start a run from a signed
 * webhook — a GitHub, Linear or Slack event, or anything that signs the
 * ODW way (see ../triggers for the config and each provider's signature).
 *
 * The signature is the credential, as an approve link is its own: the route
 * passes the dashboard's `--token` gate and loopback-only write rule — a
 * webhook sender can carry neither — and answers off loopback too. On a
 * loopback bind the DNS-rebinding Host guard still holds, letting through
 * loopback hosts and the `--public-url`'s host only (a tunnel's), so a page
 * a browser opened cannot reach it. It stays narrow: only a trigger named in
 * the user's own config can start a run (see {@link triggersToServe}: never
 * the repository's), only the workflow and the arg mapping it gives,
 * untrusted unless that config says `"untrusted": false`.
 *
 * In order, each step answering when it refuses:
 *   413  a body past 1 MiB (read no further)
 *   401  no trigger of that name, its secret not set (`secretEnv` unset, or
 *        under 16 characters; `odw serve` says which on its stderr), a missing
 *        or bad signature, or a stale timestamp — one answer for all, so a
 *        caller without the secret cannot tell which triggers exist — and 429
 *        once an address has sent too many (a good signature is never held back)
 *   200  `{ duplicate: true }` — this signature was accepted before (a replay, a retry);
 *        one refused with a 429 or 500 below is not remembered, so its retry counts.
 *        A GitHub delivery's signature and `X-GitHub-Delivery` id are kept for 30
 *        days across restarts (./trigger-seen); the others' signed timestamps expire
 *   400  a body that is neither JSON nor a form
 *   200  `{ challenge }` for Slack's url_verification, `{ pong: true }` for GitHub's ping
 *   200  `{ ignored }` — an event type the trigger's `events` does not list
 *   200  `{ deduped: true, runId }` — a run with the same `dedupe` value is still active
 *   429  the trigger's `concurrency` runs are active, or its `rateLimit` is spent (retry-after)
 *   202  `{ ok: true, trigger, runId }` — the run started (`untrusted`, with its `context`)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, resolve } from "node:path";

import { randomBytes } from "node:crypto";

import { expandHome, loadConfig } from "../adapters/config.js";
import type { Config, PermissionTier } from "../adapters/types.js";
import { InputSchemaError } from "../input-schema.js";
import {
  MIN_SECRET_LENGTH,
  ReplayCache,
  TRIGGER_NAME_RE,
  dedupeKey,
  eventTypes,
  mapArgs,
  parseDeliveryBody,
  triggerContext,
  verifySignature,
  type TriggerContext,
  type TriggerSettings,
} from "../triggers.js";
import { sendJson } from "./http-util.js";
import { startRun } from "./launcher.js";
import { isRunActive } from "./run-liveness.js";
import type { RunStore } from "./run-store.js";
import { FailureLimiter, failureKey, type TokenGateOptions } from "./serve-auth.js";
import { SeenDeliveries, seenFile } from "./trigger-seen.js";
import { untrustedConfigSwap } from "../untrusted.js";

/** The largest delivery a trigger reads: GitHub's issue and PR events are tens of KiB. */
export const TRIGGER_MAX_BODY_BYTES = 1024 * 1024;

/** The one 401 answer: an unknown trigger, a secret not set and a bad signature look alike to the caller. */
export const UNAUTHENTICATED = "no trigger of that name accepts this signature";

/** A GitHub delivery's keys in the seen file: its signature, and its `X-GitHub-Delivery` id when well-formed. */
function githubKeys(name: string, signature: string, delivery: string | string[] | undefined): string[] {
  const keys = [`${name}:sig:${signature}`];
  if (typeof delivery === "string" && /^[A-Za-z0-9-]{1,64}$/.test(delivery.trim())) keys.push(`${name}:delivery:${delivery.trim()}`);
  return keys;
}

/** What a trigger asks to start: the route's seam onto the launcher. */
export interface TriggerStart {
  workflow: string;
  args: Record<string, unknown>;
  untrusted: boolean;
  /** The trigger's `permissions`; null: the config's — read-only for untrusted input (see ../untrusted-input). */
  permissions: PermissionTier | null;
  /** Whether an untrusted run asks before its first agent that may write (the trigger's `approve`). */
  approve: boolean;
  source: string;
  configPath: string | null;
  runsRoot: string;
  context: TriggerContext;
  /** Who the run is attributed to (ODW extension; see ../identity): `trigger:<name>`, kept in meta as `launchedBy`. */
  launchedBy: string;
}

export interface TriggerRouteOptions {
  triggers: Record<string, TriggerSettings>;
  store: RunStore;
  /** Where `odw serve` runs: a trigger's runs work there unless it sets `source`. */
  cwd: string;
  configPath: string | null;
  /** Start the run; returns its id. Defaults to the launcher's startRun. */
  start?: (spec: TriggerStart) => string;
  /** Whether a run is still active. Defaults to its status and worker. */
  isActive?: (runId: string) => boolean;
  /** The secrets' environment (`secretEnv`). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Unix milliseconds (tests). */
  now?: () => number;
  /** The bad-signature limit (tests). */
  failureLimit?: TokenGateOptions;
  /** Where a started run is logged; defaults to stderr. */
  log?: (line: string) => void;
}

/** The runs a trigger has active, by id → their dedupe value. */
type ActiveRuns = Map<string, string | null>;

export class TriggerRoute {
  private readonly limiter: FailureLimiter;
  private readonly replays = new ReplayCache();
  /** GitHub's deliveries, kept across restarts: GitHub signs no time (see ./trigger-seen). */
  private readonly seen: SeenDeliveries;
  private readonly active = new Map<string, ActiveRuns>();
  private readonly starts = new Map<string, number[]>();
  private seeded = false;
  private readonly now: () => number;
  /** What an unknown trigger's delivery is checked against: so it takes as long as a known one's. */
  private readonly decoy = randomBytes(32).toString("hex");

  constructor(private readonly options: TriggerRouteOptions) {
    this.limiter = new FailureLimiter("bad trigger signatures", options.failureLimit);
    this.now = options.now ?? Date.now;
    this.seen = new SeenDeliveries(seenFile(options.store.root), options.log ?? defaultLog);
  }

  /** Answer a request for trigger `rawName` (the path segment, still %-encoded). */
  async handle(req: IncomingMessage, res: ServerResponse, rawName: string): Promise<void> {
    if ((req.method ?? "GET") !== "POST") {
      sendJson(res, 405, { error: "a trigger is POSTed to" }, { allow: "POST" });
      return;
    }
    let name: string;
    try {
      name = decodeURIComponent(rawName);
    } catch {
      name = "";
    }
    const trigger = TRIGGER_NAME_RE.test(name) && Object.hasOwn(this.options.triggers, name) ? this.options.triggers[name]! : null;
    // Every delivery is read and its signature checked, a known trigger's or not:
    // a caller without the secret gets the same answer either way (401), so it
    // cannot learn which triggers exist, nor which have no secret set yet.
    const body = await readRawBody(req, TRIGGER_MAX_BODY_BYTES);
    if (!body.ok) {
      sendJson(res, body.status, { error: body.error }, body.status === 413 ? { connection: "close" } : {});
      return;
    }
    const log = this.options.log ?? defaultLog;
    const secret = trigger ? (trigger.secret ?? (trigger.secretEnv ? ((this.options.env ?? process.env)[trigger.secretEnv] ?? "") : "")) : "";
    const ready = trigger !== null && secret.length >= MIN_SECRET_LENGTH;
    if (trigger && !ready) {
      // Which variable is the operator's to know (odw serve says it at start), not the sender's.
      log(`odw serve: trigger ${name} refused a delivery: $${trigger.secretEnv} is unset or under ${MIN_SECRET_LENGTH} characters`);
    }
    const now = this.now();
    const address = failureKey(req.socket.remoteAddress ?? "unknown");
    const verdict = verifySignature(trigger?.verify ?? "github", ready ? secret : this.decoy, { headers: req.headers, body: body.bytes, now });
    if (!ready || !verdict.ok) {
      const blocked = this.limiter.blocked(address);
      if (blocked) {
        sendJson(res, 429, { error: blocked.error }, { "retry-after": String(blocked.retryAfter) });
        return;
      }
      this.limiter.fail(address);
      // Why is the operator's to know: a known, ready trigger's reason goes to the server's log.
      if (ready && !verdict.ok) log(`odw serve: trigger ${name} refused a delivery: ${verdict.error}`);
      sendJson(res, 401, { error: UNAUTHENTICATED });
      return;
    }
    const known = trigger!;
    // GitHub signs no time: its deliveries are kept across restarts, by signature and delivery id.
    const keys = known.verify === "github" ? githubKeys(name, verdict.replayKey, req.headers["x-github-delivery"]) : null;
    const replayKey = `${name}:${verdict.replayKey}`;
    const fresh = keys ? this.seen.remember(keys, now) : this.replays.remember(replayKey, verdict.replayTtlSec, now);
    if (!fresh) {
      sendJson(res, 200, { ok: true, duplicate: true, error: "this delivery was received before: nothing started" });
      return;
    }
    const forget = (): void => (keys ? this.seen.forget(keys, now) : this.replays.forget(replayKey));
    const parsed = parseDeliveryBody(body.bytes, req.headers["content-type"]);
    if (parsed === null || typeof parsed !== "object") {
      sendJson(res, 400, { error: "the body must be JSON (or a form, for Slack)" });
      return;
    }
    const delivery = parsed as Record<string, unknown>;
    // The providers' handshakes start nothing.
    if (known.verify === "slack" && delivery.type === "url_verification" && typeof delivery.challenge === "string") {
      sendJson(res, 200, { challenge: delivery.challenge });
      return;
    }
    const types = eventTypes(known.verify, req.headers, delivery);
    if (known.verify === "github" && types[0] === "ping") {
      sendJson(res, 200, { ok: true, pong: true });
      return;
    }
    if (known.events && !types.some((type) => known.events!.includes(type))) {
      sendJson(res, 200, { ok: true, ignored: `event ${types.join(" / ") || "(none)"} is not one of this trigger's events` });
      return;
    }

    const active = this.activeRuns(name);
    const key = dedupeKey(delivery, known.dedupe);
    if (key !== null) {
      for (const [runId, value] of active) {
        if (value === key) {
          sendJson(res, 200, { ok: true, deduped: true, runId, error: `a run for ${key} is still active` });
          return;
        }
      }
    }
    if (known.concurrency !== null && active.size >= known.concurrency) {
      forget();
      sendJson(res, 429, { error: `trigger ${name} has ${active.size} active run(s), its concurrency` }, { "retry-after": "60" });
      return;
    }
    const windowMs = known.rateLimit.windowSec * 1000;
    const recent = (this.starts.get(name) ?? []).filter((at) => now - at < windowMs);
    this.starts.set(name, recent);
    if (recent.length >= known.rateLimit.max) {
      const retryAfter = Math.max(1, Math.ceil((recent[0]! + windowMs - now) / 1000));
      forget();
      sendJson(res, 429, { error: `trigger ${name} started ${recent.length} runs in ${known.rateLimit.windowSec}s, its rate limit` }, { "retry-after": String(retryAfter) });
      return;
    }

    const context: TriggerContext = { ...triggerContext(name, known.verify, req.headers, delivery), ...(key !== null ? { dedupe: key } : {}) };
    const source = known.source ? resolve(this.options.cwd, expandHome(known.source)) : this.options.cwd;
    let runId: string;
    try {
      runId = (this.options.start ?? startTriggerRun)({
        workflow: known.workflow,
        args: mapArgs(delivery, known.args),
        untrusted: known.untrusted,
        permissions: known.permissions,
        approve: known.approve,
        source: isAbsolute(source) ? source : resolve(source),
        configPath: this.options.configPath,
        runsRoot: this.options.store.root,
        context,
        launchedBy: `trigger:${name}`,
      });
    } catch (err) {
      forget();
      // Args its workflow's meta.input refuses (ODW extension; see ../input-schema): the delivery's fault, not the server's.
      sendJson(res, err instanceof InputSchemaError ? 422 : 500, { error: `trigger ${name} could not start its run: ${(err as Error).message}` });
      return;
    }
    recent.push(now);
    active.set(runId, key);
    (this.options.log ?? defaultLog)(`odw serve: trigger ${name} started run ${runId}${context.event ? ` (${context.event})` : ""}`);
    sendJson(res, 202, { ok: true, trigger: name, runId });
  }

  /**
   * The trigger's runs still active. The first call also finds the ones a
   * previous `odw serve` started (meta.context.trigger), so a restart keeps
   * dedupe and concurrency.
   */
  private activeRuns(name: string): ActiveRuns {
    const isActive = this.options.isActive ?? ((runId: string) => isRunActive(this.options.store, runId));
    if (!this.seeded) {
      this.seeded = true;
      for (const runId of this.options.store.listRunIds()) {
        try {
          if (!isActive(runId)) continue;
          const ctx = this.options.store.readMeta(runId).context as { trigger?: unknown; dedupe?: unknown } | undefined;
          if (!ctx || typeof ctx.trigger !== "string" || !Object.hasOwn(this.options.triggers, ctx.trigger)) continue;
          this.runsOf(ctx.trigger).set(runId, typeof ctx.dedupe === "string" ? ctx.dedupe : null);
        } catch {
          /* an unreadable run is no active one */
        }
      }
    }
    const runs = this.runsOf(name);
    for (const runId of [...runs.keys()]) if (!isActive(runId)) runs.delete(runId);
    return runs;
  }

  private runsOf(name: string): ActiveRuns {
    let runs = this.active.get(name);
    if (!runs) this.active.set(name, (runs = new Map()));
    return runs;
  }
}

/** The triggers `odw serve` answers, where they come from, and what it refused (see {@link triggersToServe}). */
export interface ServedTriggers {
  triggers: Record<string, TriggerSettings>;
  /** The config file a trigger's runs read: the one `odw serve` was given, or the user's own it served in its place. */
  configPath: string | null;
  /** What `odw serve` says at start, a line each: a repository's triggers it refused. */
  warnings: string[];
}

/**
 * The triggers `odw serve` may answer: only those of the user's own config —
 * `--config`, `$ODW_CONFIG`, or `~/.config/odw/config.json` outside the
 * repository it runs in (the test an untrusted run makes, ../untrusted). A
 * repository's own config (`./odw.config.json`) is code the repository
 * ships: a clone must not open a webhook that starts runs — trusted ones,
 * with `"untrusted": false` — on the user's machine. Its triggers are
 * refused, with a warning, and those of the user's own
 * `~/.config/odw/config.json` (outside the repository) are served in their
 * place; their runs read that config.
 */
export function triggersToServe(config: Config, configPath: string | null, cwd: string): ServedTriggers {
  const swap = untrustedConfigSwap(configPath, cwd, cwd);
  if (!swap) return { triggers: config.settings.triggers, configPath, warnings: [] };
  const warnings: string[] = [];
  const refused = Object.keys(config.settings.triggers);
  if (refused.length > 0) {
    warnings.push(
      `⚠ not serving the trigger${refused.length === 1 ? "" : "s"} ${refused.join(", ")} of ${swap.dropped}: it is the repository's own config, ` +
        `and a repository may not start runs on this machine — put triggers in a config of your own (--config, $ODW_CONFIG or ~/.config/odw/config.json)`,
    );
  }
  if (!swap.path) return { triggers: {}, configPath, warnings };
  try {
    return { triggers: loadConfig(swap.path, { quiet: true }).settings.triggers, configPath: swap.path, warnings };
  } catch (err) {
    warnings.push(`⚠ not serving the triggers of ${swap.path}: ${(err as Error).message}`);
    return { triggers: {}, configPath, warnings };
  }
}

/** Start a trigger's run with the launcher: detached, as `odw run` does. */
function startTriggerRun(spec: TriggerStart): string {
  return startRun(spec.workflow, {
    args: spec.args,
    configPath: spec.configPath,
    runsRoot: spec.runsRoot,
    source: spec.source,
    trust: spec.untrusted ? "untrusted" : null,
    permissions: spec.permissions,
    // An untrusted trigger's args are untrusted input too (ODW extension; see ../untrusted-input).
    untrustedInput: spec.untrusted ? { why: spec.launchedBy, approve: spec.approve } : null,
    origin: "trigger",
    context: spec.context as unknown as Record<string, unknown>,
    launchedBy: spec.launchedBy,
  }).runId;
}

/**
 * What `odw serve` says of its triggers at start: where each is answered,
 * what it runs, and a secret it cannot use yet. `base` is the URL senders
 * reach the server at (its --public-url, else its own).
 */
export function triggerLines(triggers: Record<string, TriggerSettings>, base: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const lines: string[] = [];
  for (const [name, trigger] of Object.entries(triggers)) {
    const trust = trigger.untrusted ? `untrusted input, agents ${trigger.permissions ?? "read"}${trigger.approve ? "" : ", writes without asking"}` : "TRUSTED";
    lines.push(`  trigger ${name} → POST ${base}/api/triggers/${name} (${trigger.verify}-signed; runs ${trigger.workflow}, ${trust})`);
    const secret = trigger.secret ?? (trigger.secretEnv ? (env[trigger.secretEnv] ?? "") : "");
    if (secret.length < MIN_SECRET_LENGTH) {
      lines.push(`  ⚠ trigger ${name}: $${trigger.secretEnv} is unset or under ${MIN_SECRET_LENGTH} characters — its deliveries are refused (401) until it is set`);
    }
  }
  return lines;
}

type RawBody = { ok: true; bytes: Buffer } | { ok: false; status: 400 | 413; error: string };

/**
 * The request's body as the bytes received — a signature covers exactly
 * those. Past `maxBytes` it answers 413 at once and drains the rest unbuffered.
 */
function readRawBody(req: IncomingMessage, maxBytes: number): Promise<RawBody> {
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (value: RawBody): void => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      resolvePromise(value);
    };
    req.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > maxBytes) {
        settle({ ok: false, status: 413, error: `request body exceeds ${maxBytes} bytes` });
        return;
      }
      chunks.push(buf);
    });
    req.on("error", () => settle({ ok: false, status: 400, error: "the request body could not be read" }));
    req.on("close", () => settle({ ok: false, status: 400, error: "the request body could not be read" }));
    req.on("end", () => settle({ ok: true, bytes: Buffer.concat(chunks) }));
  });
}

function defaultLog(line: string): void {
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    /* stderr gone */
  }
}
