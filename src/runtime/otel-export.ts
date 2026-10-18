/**
 * Exporting runs as OpenTelemetry traces (an ODW extension): read a run
 * directory into ../otel's mapper, and send what it makes over OTLP/HTTP with
 * JSON encoding — `odw export <run> --otlp [--out <file> | --send]`, and, when
 * the config has `otel`, the worker once a run's terminal state is on disk.
 *
 * Off unless configured. The standard variables alone never turn it on: people
 * set OTEL_* for the other tools they run, and would not expect odw to start
 * sending what their agents did. With `otel` in the config they supply what it
 * leaves out, as every OTLP exporter reads them:
 *
 *   endpoint  `otel.endpoint`, else OTEL_EXPORTER_OTLP_TRACES_ENDPOINT (used as
 *             it is), else OTEL_EXPORTER_OTLP_ENDPOINT, else
 *             http://localhost:4318 — a base URL gets `/v1/traces` appended
 *             (unless it already ends with it)
 *   headers   OTEL_EXPORTER_OTLP_HEADERS, then OTEL_EXPORTER_OTLP_TRACES_HEADERS,
 *             then `otel.headers` (`key=value,key2=value2`, percent-decoded)
 *   resource  service.name from OTEL_SERVICE_NAME, else OTEL_RESOURCE_ATTRIBUTES,
 *             else "odw"; the rest of OTEL_RESOURCE_ATTRIBUTES as given
 *   content   `otel.captureContent`, or OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT
 *             set to true, SPAN_ONLY or SPAN_AND_EVENT (any case)
 *
 * Header values are secrets: they are sent, and never logged, shown or put in
 * an event — `odw doctor` names the headers, never their values, and shows the
 * endpoint as scheme and host. Captured content leaves the machine, so it is
 * redacted once more on its way out — the values of the environment's
 * secret-named variables and token shapes — whatever `redact` says: an export
 * never carries an environment value.
 *
 * The worker posts each run's trace exactly once, with a short time limit
 * ({@link OTEL_EXPORT_TIMEOUT_MS} at most; OTEL_EXPORTER_OTLP_TIMEOUT may shorten it); it never retries, never delays the run's
 * outcome (already written) and never fails it: a failure is one line in the
 * run's worker.log, never an event.
 */

import { readFileSync } from "node:fs";

import type { Config, OtelSettings } from "../adapters/types.js";
import type { DoctorCheck } from "../doctor.js";
import { CONTENT_MAX_CHARS, runTrace, type OtlpTraces, type RunRecord, type TraceOptions } from "../otel.js";
import { createRedactor } from "../redact.js";
import { VERSION } from "../version.generated.js";
import type { RunStore } from "./run-store.js";

/** Milliseconds the worker's export may take, answer included. */
export const OTEL_EXPORT_TIMEOUT_MS = 5_000;
/** Milliseconds `odw export --send` may take. */
export const OTEL_SEND_TIMEOUT_MS = 10_000;
/** Where OTLP/HTTP goes when nothing says otherwise (the specification's default). */
export const OTLP_DEFAULT_ENDPOINT = "http://localhost:4318";

type Env = Readonly<Record<string, string | undefined>>;

/** Where a trace is sent: the URL that is POSTed, what may be shown of it, and the headers (secrets). */
export interface OtlpTarget {
  url: string;
  /** Scheme and host: all of the endpoint that is ever logged or shown. */
  origin: string;
  headers: Record<string, string>;
}

/** Read a run directory as the mapper takes it: transcripts and replies lazily, one agent at a time. */
export function readRunRecord(store: RunStore, runId: string): RunRecord {
  return {
    runId,
    meta: store.readMeta(runId),
    status: store.readStatus(runId),
    events: store.readEvents(runId),
    error: store.readError(runId),
    ...(store.hasResult(runId) ? { result: () => store.readResult(runId) } : {}),
    agentResult: (agentId) => store.readAgentResult(runId, agentId),
    transcript: (agentId) => {
      try {
        return readFileSync(store.agentTranscriptPaths(runId, agentId).transcript, "utf8").split("\n");
      } catch {
        return null; // it kept none
      }
    },
  };
}

/** Whether the conventions' variable asks for content: true, SPAN_ONLY or SPAN_AND_EVENT, in any case. */
export function captureFromEnv(env: Env): boolean {
  const value = (env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT ?? "").trim().toLowerCase();
  return value === "true" || value === "span_only" || value === "span_and_event";
}

/**
 * `key1=value1,key2=value2`, as the OTEL_* variables write headers and
 * resource attributes (W3C Baggage-like, values percent-decoded). Null when
 * any pair is malformed: the specification discards the whole value then.
 */
export function parseKeyValues(text: string | undefined): Record<string, string> | null {
  const out: Record<string, string> = {};
  if (!text || !text.trim()) return out;
  for (const pair of text.split(",")) {
    if (!pair.trim()) continue;
    const eq = pair.indexOf("=");
    if (eq <= 0) return null;
    try {
      const key = decodeURIComponent(pair.slice(0, eq).trim());
      const value = decodeURIComponent(pair.slice(eq + 1).trim());
      if (!key) return null;
      out[key] = value;
    } catch {
      return null;
    }
  }
  return out;
}

/** The resource a trace describes: service.name (OTEL_SERVICE_NAME first), service.version, OTEL_RESOURCE_ATTRIBUTES. */
export function resourceFromEnv(env: Env): Record<string, string> {
  const given = parseKeyValues(env.OTEL_RESOURCE_ATTRIBUTES) ?? {};
  const name = env.OTEL_SERVICE_NAME?.trim();
  return {
    "service.version": VERSION,
    ...given,
    "service.name": name || given["service.name"] || "odw",
  };
}

/** A header name and value fetch() accepts. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * Where a trace goes and with which headers (see the module doc). Throws on
 * an OTEL_* endpoint that is not an http(s) URL — without echoing it.
 */
export function otlpTarget(otel: OtelSettings | false | null, env: Env): OtlpTarget {
  let url: string;
  if (otel && otel.endpoint) url = tracesUrl(otel.endpoint, "otel.endpoint");
  else if (env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim()) {
    url = checkedUrl(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT.trim(), "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT").href;
  } else if (env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()) url = tracesUrl(env.OTEL_EXPORTER_OTLP_ENDPOINT.trim(), "OTEL_EXPORTER_OTLP_ENDPOINT");
  else url = tracesUrl(OTLP_DEFAULT_ENDPOINT, "the default endpoint");
  const headers: Record<string, string> = {};
  for (const source of [env.OTEL_EXPORTER_OTLP_HEADERS, env.OTEL_EXPORTER_OTLP_TRACES_HEADERS]) {
    for (const [name, value] of Object.entries(parseKeyValues(source) ?? {})) {
      // A header fetch() would refuse is left out — its value never reaches an error message.
      if (HEADER_NAME.test(name) && !/[\r\n\0]/.test(value)) headers[name] = value;
    }
  }
  Object.assign(headers, otel ? otel.headers : {});
  const { protocol, host } = new URL(url);
  return { url, origin: `${protocol}//${host}`, headers };
}

/** A base endpoint's traces URL: `/v1/traces` appended, unless it is there already. */
function tracesUrl(base: string, what: string): string {
  const url = checkedUrl(base, what);
  if (!/\/v1\/traces\/?$/.test(url.pathname)) url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1/traces`;
  return url.href;
}

function checkedUrl(text: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${what} is not an absolute URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${what} is not an http(s) URL`);
  if (url.username || url.password) throw new Error(`${what} embeds credentials (user:password@): put them in a header`);
  return url;
}

/** How a run's trace is built under `config` and `env`: content capture, resource, provider names, the way-out redactor. */
export function traceOptionsFor(config: Config, env: Env): TraceOptions {
  const capture = (config.settings.otel !== false && config.settings.otel.captureContent) || captureFromEnv(env);
  const options: TraceOptions = {
    captureContent: capture,
    resource: resourceFromEnv(env),
    executables: Object.fromEntries(Object.entries(config.adapters).map(([name, adapter]) => [name, adapter.command[0] ?? ""])),
    version: VERSION,
  };
  if (capture) {
    // Whatever `redact` says: content that leaves the machine carries no environment value nor token.
    const redactor = createRedactor(
      { env: true, patterns: true, extra: config.settings.redact ? config.settings.redact.extra : [] },
      { env: [env, ...Object.values(config.adapters).map((adapter) => adapter.env)] },
    );
    options.redact = (text) => redactor.text(text);
  }
  return options;
}

/**
 * How long an export may take: OTEL_EXPORTER_OTLP_TRACES_TIMEOUT, else
 * OTEL_EXPORTER_OTLP_TIMEOUT (milliseconds), but never more than `max`.
 */
export function exportTimeout(env: Env, max: number): number {
  const given = Number(env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT ?? env.OTEL_EXPORTER_OTLP_TIMEOUT);
  return Number.isFinite(given) && given > 0 ? Math.min(given, max) : max;
}

/** A run's trace, read from its directory. */
export function exportRun(store: RunStore, runId: string, config: Config, env: Env = process.env): OtlpTraces {
  return runTrace(readRunRecord(store, runId), traceOptionsFor(config, env));
}

/** How many spans a trace holds. */
export function spanCount(trace: OtlpTraces): number {
  return trace.resourceSpans.reduce((n, rs) => n + rs.scopeSpans.reduce((m, ss) => m + ss.spans.length, 0), 0);
}

/**
 * POST a trace to `target`, once. Resolves with what went wrong, in a line
 * that names the endpoint by its origin and never holds a header's value —
 * or null when the receiver took it (all of it: a partial success says how
 * many spans it rejected). Never rejects.
 */
export async function postTrace(target: OtlpTarget, trace: OtlpTraces, timeoutMs: number): Promise<string | null> {
  try {
    const res = await fetch(target.url, {
      method: "POST",
      headers: { "user-agent": `odw/${VERSION}`, ...target.headers, "content-type": "application/json" },
      body: JSON.stringify(trace),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const said = (await res.text().catch(() => "")).trim();
    if (!res.ok) {
      const status = `${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
      return scrub(`${target.origin} answered ${status}${said ? `: ${said.slice(0, 200)}` : ""}`, target);
    }
    const rejected = rejectedSpans(said);
    return rejected ? scrub(`${target.origin} rejected ${rejected} span(s)`, target) : null;
  } catch (err) {
    const why =
      err instanceof Error && err.name === "TimeoutError"
        ? `timed out after ${timeoutMs / 1000}s`
        : err instanceof Error
          ? (err.cause instanceof Error ? err.cause.message : err.message)
          : String(err);
    return scrub(`${target.origin} failed: ${why}`, target);
  }
}

/** An OTLP partial success's rejected span count, when the answer has one. */
function rejectedSpans(body: string): number {
  try {
    const parsed = JSON.parse(body) as { partialSuccess?: { rejectedSpans?: unknown } };
    const n = Number(parsed?.partialSuccess?.rejectedSpans ?? 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** A line about an export with the endpoint's path and query, and every header value, taken out. */
function scrub(line: string, target: OtlpTarget): string {
  let out = line.split(target.url).join(target.origin);
  for (const value of Object.values(target.headers)) if (value.length >= 4) out = out.split(value).join("«header»");
  return out;
}

export interface ExportOptions {
  /** Where a failure goes; defaults to the worker's stderr (its worker.log). */
  log?: (line: string) => void;
  timeoutMs?: number;
  env?: Env;
}

/**
 * The worker's export of a run whose terminal state is on disk, when the config
 * has `otel`: one POST, bounded by {@link OTEL_EXPORT_TIMEOUT_MS}; a failure is
 * one line in `log`. Never rejects.
 */
export async function exportRunEnd(
  config: Config | null,
  run: { store: RunStore; runId: string },
  options: ExportOptions = {},
): Promise<void> {
  const otel = config?.settings.otel;
  if (!config || !otel) return;
  const log = options.log ?? ((line: string) => process.stderr.write(`odw: ${line}\n`));
  const env = options.env ?? process.env;
  let failure: string | null;
  try {
    const target = otlpTarget(otel, env);
    failure = await postTrace(target, exportRun(run.store, run.runId, config, env), options.timeoutMs ?? exportTimeout(env, OTEL_EXPORT_TIMEOUT_MS));
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }
  if (failure) log(`otel: the trace of run ${run.runId} was not exported: ${failure}`);
}

/** `odw doctor`'s line: whether runs are exported, and where to (scheme and host). */
export function otelCheck(config: Config, env: Env = process.env): DoctorCheck {
  const check = { id: "otel", title: "OpenTelemetry export" };
  const otel = config.settings.otel;
  if (!otel) {
    return {
      ...check,
      status: "skip",
      detail: 'off — set "otel" in the config to send each run\'s trace; odw export <run> --otlp writes one',
    };
  }
  let target: OtlpTarget;
  try {
    target = otlpTarget(otel, env);
  } catch (err) {
    return { ...check, status: "warn", detail: (err as Error).message, hint: 'set "otel.endpoint" to the OTLP/HTTP receiver, e.g. "http://localhost:4318"' };
  }
  const names = Object.keys(target.headers);
  const headers = names.length > 0 ? ` with header${names.length === 1 ? "" : "s"} ${names.join(", ")}` : "";
  const content =
    otel.captureContent || captureFromEnv(env) ? `content captured (cut at ${CONTENT_MAX_CHARS} characters)` : "content not captured";
  const grpc = (env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL)?.trim() === "grpc";
  return {
    ...check,
    status: grpc ? "warn" : "ok",
    detail: `on — each run's trace goes to ${target.origin} (OTLP/HTTP, JSON)${headers}; ${content}`,
    ...(grpc ? { hint: "OTEL_EXPORTER_OTLP_PROTOCOL is grpc, but odw sends OTLP/HTTP: point it at the receiver's HTTP port (4318)" } : {}),
  };
}
