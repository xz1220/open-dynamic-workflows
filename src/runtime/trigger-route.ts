/**
 * `POST /api/triggers/<name>` (an ODW extension): start a run from a signed
 * webhook — a GitHub, Linear or Slack event, or anything that signs the
 * ODW way (see ../triggers for the config and each provider's signature).
 *
 * The signature is the credential, as an approve link is its own: the route
 * passes the dashboard's Host guard, `--token` gate and loopback-only write
 * rule — a webhook sender can carry none of those — and answers off loopback
 * too. It stays narrow: only a trigger named in the config can start a run,
 * only the workflow and the arg mapping the config gives it, untrusted unless
 * the config says `"untrusted": false`.
 *
 * In order, each step answering when it refuses:
 *   404  no trigger of that name (or the server shows a shared bundle: 409)
 *   413  a body past 1 MiB (read no further)
 *   503  the trigger's secret is not set (`secretEnv` unset, or under 16 characters)
 *   401  a missing or bad signature, or a stale timestamp — and 429 once an
 *        address has sent too many (a good signature is never held back)
 *   200  `{ duplicate: true }` — this signature was accepted before (a replay, a retry);
 *        one refused with a 429 or 500 below is not remembered, so its retry counts
 *   400  a body that is neither JSON nor a form
 *   200  `{ challenge }` for Slack's url_verification, `{ pong: true }` for GitHub's ping
 *   200  `{ ignored }` — an event type the trigger's `events` does not list
 *   200  `{ deduped: true, runId }` — a run with the same `dedupe` value is still active
 *   429  the trigger's `concurrency` runs are active, or its `rateLimit` is spent (retry-after)
 *   202  `{ ok: true, trigger, runId }` — the run started (`untrusted`, with its `context`)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, resolve } from "node:path";

import { expandHome } from "../adapters/config.js";
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

/** The largest delivery a trigger reads: GitHub's issue and PR events are tens of KiB. */
export const TRIGGER_MAX_BODY_BYTES = 1024 * 1024;

/** What a trigger asks to start: the route's seam onto the launcher. */
export interface TriggerStart {
  workflow: string;
  args: Record<string, unknown>;
  untrusted: boolean;
  source: string;
  configPath: string | null;
  runsRoot: string;
  context: TriggerContext;
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
  private readonly active = new Map<string, ActiveRuns>();
  private readonly starts = new Map<string, number[]>();
  private seeded = false;
  private readonly now: () => number;

  constructor(private readonly options: TriggerRouteOptions) {
    this.limiter = new FailureLimiter("bad trigger signatures", options.failureLimit);
    this.now = options.now ?? Date.now;
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
    if (!trigger) {
      // Drain the body unread: the answer must not wait on it, nor reset the connection.
      req.resume();
      sendJson(res, 404, { error: "no such trigger" });
      return;
    }
    const body = await readRawBody(req, TRIGGER_MAX_BODY_BYTES);
    if (!body.ok) {
      sendJson(res, body.status, { error: body.error }, body.status === 413 ? { connection: "close" } : {});
      return;
    }
    const secret = trigger.secret ?? (trigger.secretEnv ? ((this.options.env ?? process.env)[trigger.secretEnv] ?? "") : "");
    if (secret.length < MIN_SECRET_LENGTH) {
      sendJson(res, 503, { error: `trigger ${name} has no usable secret: set ${trigger.secretEnv ?? "its secret"} (${MIN_SECRET_LENGTH}+ characters) for odw serve` });
      return;
    }
    const now = this.now();
    const address = failureKey(req.socket.remoteAddress ?? "unknown");
    const verdict = verifySignature(trigger.verify, secret, { headers: req.headers, body: body.bytes, now });
    if (!verdict.ok) {
      const blocked = this.limiter.blocked(address);
      if (blocked) {
        sendJson(res, 429, { error: blocked.error }, { "retry-after": String(blocked.retryAfter) });
        return;
      }
      this.limiter.fail(address);
      sendJson(res, 401, { error: verdict.error });
      return;
    }
    const replayKey = `${name}:${verdict.replayKey}`;
    if (!this.replays.remember(replayKey, verdict.replayTtlSec, now)) {
      sendJson(res, 200, { ok: true, duplicate: true, error: "this delivery was received before: nothing started" });
      return;
    }
    const parsed = parseDeliveryBody(body.bytes, req.headers["content-type"]);
    if (parsed === null || typeof parsed !== "object") {
      sendJson(res, 400, { error: "the body must be JSON (or a form, for Slack)" });
      return;
    }
    const delivery = parsed as Record<string, unknown>;
    // The providers' handshakes start nothing.
    if (trigger.verify === "slack" && delivery.type === "url_verification" && typeof delivery.challenge === "string") {
      sendJson(res, 200, { challenge: delivery.challenge });
      return;
    }
    const types = eventTypes(trigger.verify, req.headers, delivery);
    if (trigger.verify === "github" && types[0] === "ping") {
      sendJson(res, 200, { ok: true, pong: true });
      return;
    }
    if (trigger.events && !types.some((type) => trigger.events!.includes(type))) {
      sendJson(res, 200, { ok: true, ignored: `event ${types.join(" / ") || "(none)"} is not one of this trigger's events` });
      return;
    }

    const active = this.activeRuns(name);
    const key = dedupeKey(delivery, trigger.dedupe);
    if (key !== null) {
      for (const [runId, value] of active) {
        if (value === key) {
          sendJson(res, 200, { ok: true, deduped: true, runId, error: `a run for ${key} is still active` });
          return;
        }
      }
    }
    if (trigger.concurrency !== null && active.size >= trigger.concurrency) {
      this.replays.forget(replayKey);
      sendJson(res, 429, { error: `trigger ${name} has ${active.size} active run(s), its concurrency` }, { "retry-after": "60" });
      return;
    }
    const windowMs = trigger.rateLimit.windowSec * 1000;
    const recent = (this.starts.get(name) ?? []).filter((at) => now - at < windowMs);
    this.starts.set(name, recent);
    if (recent.length >= trigger.rateLimit.max) {
      const retryAfter = Math.max(1, Math.ceil((recent[0]! + windowMs - now) / 1000));
      this.replays.forget(replayKey);
      sendJson(res, 429, { error: `trigger ${name} started ${recent.length} runs in ${trigger.rateLimit.windowSec}s, its rate limit` }, { "retry-after": String(retryAfter) });
      return;
    }

    const context: TriggerContext = { ...triggerContext(name, trigger.verify, req.headers, delivery), ...(key !== null ? { dedupe: key } : {}) };
    const source = trigger.source ? resolve(this.options.cwd, expandHome(trigger.source)) : this.options.cwd;
    let runId: string;
    try {
      runId = (this.options.start ?? startTriggerRun)({
        workflow: trigger.workflow,
        args: mapArgs(delivery, trigger.args),
        untrusted: trigger.untrusted,
        source: isAbsolute(source) ? source : resolve(source),
        configPath: this.options.configPath,
        runsRoot: this.options.store.root,
        context,
      });
    } catch (err) {
      this.replays.forget(replayKey);
      sendJson(res, 500, { error: `trigger ${name} could not start its run: ${(err as Error).message}` });
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

/** Start a trigger's run with the launcher: detached, as `odw run` does. */
function startTriggerRun(spec: TriggerStart): string {
  return startRun(spec.workflow, {
    args: spec.args,
    configPath: spec.configPath,
    runsRoot: spec.runsRoot,
    source: spec.source,
    trust: spec.untrusted ? "untrusted" : null,
    origin: "trigger",
    context: spec.context as unknown as Record<string, unknown>,
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
    const trust = trigger.untrusted ? "untrusted" : "TRUSTED";
    lines.push(`  trigger ${name} → POST ${base}/api/triggers/${name} (${trigger.verify}-signed; runs ${trigger.workflow}, ${trust})`);
    const secret = trigger.secret ?? (trigger.secretEnv ? (env[trigger.secretEnv] ?? "") : "");
    if (secret.length < MIN_SECRET_LENGTH) {
      lines.push(`  ⚠ trigger ${name}: $${trigger.secretEnv} is unset or under ${MIN_SECRET_LENGTH} characters — it answers 503 until it is set`);
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
