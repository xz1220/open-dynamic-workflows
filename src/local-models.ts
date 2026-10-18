/**
 * `odw doctor --local` (ODW extension) — is the local model server an agent CLI
 * would route to actually fit for agent work?
 *
 * A local server's failure mode is silent: Ollama loads a model with a small
 * context window and, when a prompt does not fit, cuts its front — the CLI's
 * tool instructions — and still answers HTTP 200. Its OpenAI-compatible `/v1`
 * endpoint ignores a request's `num_ctx`; only the server's
 * `OLLAMA_CONTEXT_LENGTH` (or a Modelfile's `num_ctx`) raises it.
 *
 * Read-only probes, per endpoint: Ollama's `/api/version`, `/api/ps` (what is
 * loaded, at which context length), `/api/tags` and `/api/show` (the model's
 * declared capabilities — `tools` — and trained context); else an
 * OpenAI-compatible server's `/v1/models`, plus LM Studio's `/api/v0/models`
 * when it answers (state, loaded and maximum context, `tool_use`). Nothing is
 * pulled, loaded or changed.
 *
 * `--smoke` adds one generation request: a prompt of roughly 10K tokens with a
 * random passphrase at its very start and, at its end, the instruction to
 * reply with it. A model that answers without the passphrase lost the front of
 * its prompt (or ignored the end) — the truncation an agent run would never
 * report. The probe goes only to an endpoint on this machine or the local
 * network, never to an Ollama cloud model, and carries no credentials.
 */

import { randomBytes } from "node:crypto";
import { isIP } from "node:net";

import type { DoctorCheck } from "./doctor.js";

/** The endpoints probed when none is named: Ollama's and LM Studio's default ports. */
export const DEFAULT_LOCAL_ENDPOINTS = ["http://127.0.0.1:11434", "http://127.0.0.1:1234"];

/** Below this many tokens of context an agent CLI's system prompt and tools leave little room (and get cut). */
export const MIN_LOCAL_CONTEXT = 32768;

/** The Ollama version `codex --oss` guides ask for. */
export const MIN_OLLAMA_FOR_CODEX_OSS = "0.13.4";

/** Roughly how many tokens the smoke probe's prompt holds (comfortably over 8K). */
export const SMOKE_PROMPT_TOKENS = 10_000;

export interface LocalProbeOptions {
  /** Endpoints the user named (`--endpoint`); empty = the defaults, which may be absent. */
  endpoints: string[];
  /** Send the long-prompt truncation probe (`--smoke`). */
  smoke: boolean;
  /** The model to report on and smoke-test (`--model`); default: what the server has loaded. */
  model?: string;
  /** Milliseconds per read-only request (default 5000). */
  timeoutMs?: number;
  /** Milliseconds for the smoke request (default 180000). */
  smokeTimeoutMs?: number;
  /** The endpoints tried when none is named (default {@link DEFAULT_LOCAL_ENDPOINTS}). */
  defaults?: string[];
}

/** One model as a server reports it. */
interface LocalModel {
  name: string;
  loaded: boolean;
  /** The context it is loaded with — what a request actually gets. */
  context?: number;
  /** The most the model supports (trained, or the server's maximum). */
  maxContext?: number;
  /** A Modelfile's `num_ctx` (Ollama), applied when it loads. */
  numCtx?: number;
  /** Declares tool calling; undefined = the server does not say. */
  tools?: boolean;
  /** An Ollama cloud model: it runs on this host, not here. */
  cloud?: string;
}

/** Whether `host` (a URL's hostname) is this machine or the local network. */
export function isLocalHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  const v = isIP(h);
  if (v === 4) {
    const [a, b] = h.split(".").map(Number) as [number, number];
    return (
      a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) // CGNAT: Tailscale and the like
    );
  }
  if (v === 6) {
    if (h === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    if (mapped) return isLocalHost(mapped[1]!);
    return /^f[cd]/.test(h) || /^fe[89ab]/.test(h); // unique local, link-local
  }
  // A bare machine name, or a name only the local network resolves.
  return !h.includes(".") || /\.(local|lan|internal|home\.arpa)$/.test(h);
}

/** `127.0.0.1:11434`, `http://host:1234/v1/` → the server's base URL; an Error for anything else. */
export function normalizeEndpoint(raw: string): URL | Error {
  const text = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw.trim()) ? raw.trim() : `http://${raw.trim()}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return new Error(`not a URL: ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return new Error(`${raw}: only http and https endpoints`);
  if (url.username || url.password) return new Error(`${raw}: no credentials in the endpoint URL`);
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "") || "/";
  return url;
}

/** `a.b.c` ≥ `x.y.z`, numerically; true when either is not a version. */
export function versionAtLeast(have: string, want: string): boolean {
  const parse = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1).map(Number);
  const a = parse(have);
  const b = parse(want);
  if (!a || !b) return true;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return true;
}

const fmtTokens = (n: number) => (n >= 1024 && n % 1024 === 0 ? `${n / 1024}K` : String(n));

const OLLAMA_CONTEXT_HINT =
  `raise the context length on the server — the /v1 endpoint agent CLIs use ignores a request's num_ctx: ` +
  `\`OLLAMA_CONTEXT_LENGTH=${MIN_LOCAL_CONTEXT} ollama serve\` (the macOS app: ` +
  `\`launchctl setenv OLLAMA_CONTEXT_LENGTH ${MIN_LOCAL_CONTEXT}\` and restart it; systemd: ` +
  `\`Environment="OLLAMA_CONTEXT_LENGTH=${MIN_LOCAL_CONTEXT}"\` in \`systemctl edit ollama\`), ` +
  `then check the CONTEXT column of \`ollama ps\``;

const LMSTUDIO_CONTEXT_HINT =
  `reload the model with a context length of at least ${fmtTokens(MIN_LOCAL_CONTEXT)} in LM Studio's load settings`;

async function getJson(url: string, timeoutMs: number, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
  });
  const text = await res.text();
  let json: unknown = undefined;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON: json stays undefined */
  }
  return { status: res.status, json };
}

/** The same request, or undefined when the server is not there or answers anything but JSON 200. */
async function tryJson(url: string, timeoutMs: number, body?: unknown): Promise<Record<string, unknown> | undefined> {
  try {
    const { status, json } = await getJson(url, timeoutMs, body);
    return status === 200 && json && typeof json === "object" ? (json as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
const arr = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
const isCloudName = (name: string) => /[:-]cloud$/.test(name);

/** Every check `odw doctor --local` adds, endpoint by endpoint. */
export async function localModelChecks(opts: LocalProbeOptions): Promise<DoctorCheck[]> {
  const named = opts.endpoints.length > 0;
  const defaults = opts.defaults ?? DEFAULT_LOCAL_ENDPOINTS;
  const checks: DoctorCheck[] = [];
  for (const raw of named ? opts.endpoints : defaults) {
    checks.push(...(await endpointChecks(raw, named, opts)));
  }
  if (!named && checks.every((c) => c.status === "skip")) {
    checks.push({
      id: "local",
      title: "Local models",
      status: "warn",
      detail: `no Ollama or LM Studio server on ${defaults.join(" or ")}`,
      hint: "start one, or name it with --endpoint http://host:port",
    });
  }
  return checks;
}

async function endpointChecks(raw: string, named: boolean, opts: LocalProbeOptions): Promise<DoctorCheck[]> {
  const t = opts.timeoutMs ?? 5000;
  const url = normalizeEndpoint(raw);
  const id = `local:${url instanceof Error ? raw : url.origin + url.pathname.replace(/\/$/, "")}`;
  if (url instanceof Error) return [{ id, title: "Local endpoint", status: "fail", detail: url.message }];
  const base = url.href.replace(/\/$/, "");

  const version = await tryJson(`${base}/api/version`, t);
  if (version && typeof version.version === "string") return ollamaChecks(id, base, url, version.version, opts);

  const models = await tryJson(`${base}/v1/models`, t);
  if (models && Array.isArray(models.data)) return openAiChecks(id, base, url, models, opts);

  return [
    named
      ? {
          id,
          title: "Local endpoint",
          status: "fail",
          detail: `${base}: neither Ollama (/api/version) nor an OpenAI-compatible server (/v1/models) answered`,
          hint: "is the server running, and is this its address and port?",
        }
      : { id, title: "Local endpoint", status: "skip", detail: `nothing answering on ${base}` },
  ];
}

// --- Ollama --------------------------------------------------------------------------

async function ollamaChecks(id: string, base: string, url: URL, version: string, opts: LocalProbeOptions): Promise<DoctorCheck[]> {
  const t = opts.timeoutMs ?? 5000;
  const checks: DoctorCheck[] = [];
  const recent = versionAtLeast(version, MIN_OLLAMA_FOR_CODEX_OSS);
  const ps = arr((await tryJson(`${base}/api/ps`, t))?.models);
  const tags = arr((await tryJson(`${base}/api/tags`, t))?.models);
  checks.push({
    id,
    title: "Local Ollama",
    status: recent ? "ok" : "warn",
    detail: `${version} at ${base} · ${ps.length} loaded, ${tags.length} installed`,
    hint: recent ? undefined : `\`codex --oss\` guides ask for Ollama ${MIN_OLLAMA_FOR_CODEX_OSS} or newer — update it`,
  });

  // The loaded models, and the one --model names (loaded or not).
  const models = new Map<string, LocalModel>();
  for (const m of ps) {
    const name = String(m.name ?? m.model ?? "");
    if (name) models.set(name, { name, loaded: true, context: num(m.context_length) });
  }
  if (opts.model && !models.has(opts.model)) models.set(opts.model, { name: opts.model, loaded: false });
  if (models.size === 0) {
    const installed = tags.map((m) => String(m.name ?? m.model ?? "")).filter(Boolean);
    checks.push({
      id: `${id}#models`,
      title: "Local models",
      status: "warn",
      detail: installed.length
        ? `none loaded, so no context length to check (installed: ${installed.slice(0, 5).join(", ")}${installed.length > 5 ? ", …" : ""})`
        : "no model installed",
      hint: installed.length
        ? "load the model your agents use (`ollama run <model>`), or pass --model <name>, and run this again"
        : "`ollama pull <model>` one first",
    });
    return checks;
  }

  for (const m of models.values()) {
    const show = await tryJson(`${base}/api/show`, t, { model: m.name });
    if (!show) {
      checks.push({
        id: `${id}#${m.name}`,
        title: `Model ${m.name}`,
        status: "fail",
        detail: `${base}/api/show does not know it`,
        hint: "check the name with `ollama list`",
      });
      continue;
    }
    const info = (show.model_info ?? {}) as Record<string, unknown>;
    const ctxKey = Object.keys(info).find((k) => k.endsWith(".context_length"));
    if (ctxKey) m.maxContext = num(info[ctxKey]);
    const numCtx = /^num_ctx\s+(\d+)/m.exec(typeof show.parameters === "string" ? show.parameters : "");
    if (numCtx) m.numCtx = Number(numCtx[1]);
    if (Array.isArray(show.capabilities)) m.tools = show.capabilities.includes("tools");
    if (typeof show.remote_host === "string" && show.remote_host) m.cloud = show.remote_host;
    else if (show.remote_model || isCloudName(m.name)) m.cloud = "ollama.com";
    checks.push(modelCheck(id, m, "ollama"));
  }

  if (opts.smoke) checks.push(await smokeCheck(id, base, url, [...models.values()], opts, "ollama"));
  return checks;
}

// --- OpenAI-compatible (LM Studio) ---------------------------------------------------

async function openAiChecks(
  id: string,
  base: string,
  url: URL,
  list: Record<string, unknown>,
  opts: LocalProbeOptions,
): Promise<DoctorCheck[]> {
  const t = opts.timeoutMs ?? 5000;
  const ids = arr(list.data).map((m) => String(m.id ?? "")).filter(Boolean);
  // LM Studio's own REST API says what is loaded, at which context, and what can call tools.
  const v0 = await tryJson(`${base}/api/v0/models`, t);
  const lmstudio = !!v0 && Array.isArray(v0.data);
  const checks: DoctorCheck[] = [
    {
      id,
      title: lmstudio ? "Local LM Studio" : "Local endpoint",
      status: "ok",
      detail: `${lmstudio ? "LM Studio" : "OpenAI-compatible server"} at ${base} · ${ids.length} model(s)`,
    },
  ];

  const models = new Map<string, LocalModel>();
  if (lmstudio) {
    for (const m of arr(v0!.data)) {
      const name = String(m.id ?? "");
      if (!name || (m.type !== undefined && m.type !== "llm" && m.type !== "vlm")) continue;
      const loaded = m.state === "loaded";
      if (!loaded && name !== opts.model) continue;
      models.set(name, {
        name,
        loaded,
        context: loaded ? num(m.loaded_context_length) : undefined,
        maxContext: num(m.max_context_length),
        tools: Array.isArray(m.capabilities) ? m.capabilities.includes("tool_use") : undefined,
      });
    }
  }
  if (opts.model && !models.has(opts.model)) {
    if (!ids.includes(opts.model)) {
      checks.push({
        id: `${id}#${opts.model}`,
        title: `Model ${opts.model}`,
        status: "fail",
        detail: `${base}/v1/models does not list it`,
        hint: `it lists: ${ids.slice(0, 5).join(", ") || "nothing"}`,
      });
      return checks;
    }
    models.set(opts.model, { name: opts.model, loaded: false });
  }

  if (models.size === 0) {
    checks.push({
      id: `${id}#models`,
      title: "Local models",
      status: "warn",
      detail: lmstudio
        ? "none loaded, so no context length to check"
        : "this server does not report context length or tool calling",
      hint: lmstudio
        ? "load the model your agents use, or pass --model <id>, and run this again"
        : "--smoke sends a long prompt to find out whether it is cut",
    });
  }
  for (const m of models.values()) checks.push(modelCheck(id, m, lmstudio ? "lmstudio" : "openai"));

  if (opts.smoke) {
    // A plain server lists what it serves; LM Studio's loaded models come first.
    const candidates = models.size ? [...models.values()] : ids.map((name) => ({ name, loaded: false }));
    checks.push(await smokeCheck(id, base, url, candidates, opts, lmstudio ? "lmstudio" : "openai"));
  }
  return checks;
}

// --- one model ------------------------------------------------------------------------

function modelCheck(id: string, m: LocalModel, server: "ollama" | "lmstudio" | "openai"): DoctorCheck {
  const parts: string[] = [];
  let status: DoctorCheck["status"] = "ok";
  const hints: string[] = [];
  if (m.cloud) {
    parts.push(`cloud model (runs on ${m.cloud}, not here)`);
  } else if (m.context !== undefined) {
    parts.push(`context ${fmtTokens(m.context)}${m.maxContext ? ` of ${fmtTokens(m.maxContext)}` : ""}`);
    if (m.context < MIN_LOCAL_CONTEXT) {
      status = "warn";
      parts[parts.length - 1] += ` — under ${fmtTokens(MIN_LOCAL_CONTEXT)}, prompts get their front cut silently`;
      if (m.maxContext !== undefined && m.maxContext < MIN_LOCAL_CONTEXT) {
        hints.push(`the model itself stops at ${fmtTokens(m.maxContext)} — pick one with a longer context`);
      } else hints.push(server === "ollama" ? OLLAMA_CONTEXT_HINT : LMSTUDIO_CONTEXT_HINT);
    }
  } else if (m.loaded) {
    parts.push("context not reported");
    if (server === "ollama") hints.push("an Ollama this old does not report it: see the CONTEXT column of `ollama ps`");
    status = "warn";
  } else {
    const preset = m.numCtx;
    parts.push(
      `not loaded — context is set when it loads${preset ? ` (Modelfile num_ctx ${fmtTokens(preset)})` : ""}` +
        (m.maxContext ? `; supports ${fmtTokens(m.maxContext)}` : ""),
    );
    if (preset !== undefined && preset < MIN_LOCAL_CONTEXT) {
      status = "warn";
      hints.push(`its Modelfile sets num_ctx ${preset}; ${OLLAMA_CONTEXT_HINT}`);
    }
  }
  if (m.tools === true) parts.push("tool calling: yes");
  else if (m.tools === false) {
    parts.push("tool calling: not declared");
    status = "warn";
    hints.push("agent CLIs drive their tools through tool calls — pick a model that declares them");
  } else parts.push("tool calling: not reported");
  return {
    id: `${id}#${m.name}`,
    title: `Model ${m.name}`,
    status,
    detail: parts.join(" · "),
    hint: hints.length ? hints.join("; ") : undefined,
  };
}

// --- the truncation probe ---------------------------------------------------------------

/** The smoke prompt: a passphrase first, ~10K tokens of filler, the instruction last. */
export function truncationPrompt(passphrase: string): string {
  const lines = [`The passphrase for this check is ${passphrase}. Keep it in mind until the end.`, ""];
  // ~16 tokens a line.
  for (let i = 1; i <= Math.ceil(SMOKE_PROMPT_TOKENS / 16); i++) {
    lines.push(`Record ${i}: the shelf holds a routine ledger entry; nothing here needs an answer.`);
  }
  lines.push(
    "",
    "Instruction: begin your reply with the passphrase given in the very first line of this message, " +
      "exactly as written, and then stop. Do not use any tools.",
  );
  return lines.join("\n");
}

async function smokeCheck(
  id: string,
  base: string,
  url: URL,
  candidates: LocalModel[],
  opts: LocalProbeOptions,
  server: "ollama" | "lmstudio" | "openai",
): Promise<DoctorCheck> {
  const check = (status: DoctorCheck["status"], detail: string, hint?: string, model?: string): DoctorCheck => ({
    id: `${id}#smoke`,
    title: `Smoke ${model ?? "local"}`,
    status,
    detail,
    hint,
  });
  if (!isLocalHost(url.hostname)) {
    return check("skip", `${url.hostname} is not this machine or the local network — the long-prompt probe stays local`);
  }
  const pick = opts.model
    ? candidates.find((m) => m.name === opts.model)
    : candidates.find((m) => m.loaded && !m.cloud) ?? candidates.find((m) => !m.cloud);
  if (!pick) {
    return check("skip", "no local model to probe", "load one, or pass --model <name>");
  }
  if (pick.cloud || isCloudName(pick.name)) {
    return check("skip", `${pick.name} is a cloud model — the probe goes to local models only`, undefined, pick.name);
  }

  const passphrase = `ODW-${randomBytes(4).toString("hex").toUpperCase()}`;
  const started = Date.now();
  let res: { status: number; json: unknown };
  try {
    res = await getJson(`${base}/v1/chat/completions`, opts.smokeTimeoutMs ?? 180_000, {
      model: pick.name,
      messages: [{ role: "user", content: truncationPrompt(passphrase) }],
      temperature: 0,
      max_tokens: 512,
      stream: false,
    });
  } catch (err) {
    return check("fail", `no answer: ${(err as Error).message}`, `a ~${SMOKE_PROMPT_TOKENS / 1000}K-token prompt is slow on a CPU — try --timeout 600`, pick.name);
  }
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const body = (res.json ?? {}) as Record<string, unknown>;
  if (res.status !== 200) {
    const err = body.error as Record<string, unknown> | string | undefined;
    const msg = typeof err === "string" ? err : typeof err?.message === "string" ? err.message : `HTTP ${res.status}`;
    return check("fail", `the server refused the probe: ${msg.slice(0, 160)}`, undefined, pick.name);
  }
  const message = (arr(body.choices)[0]?.message ?? {}) as Record<string, unknown>;
  const said = [message.content, message.reasoning, message.reasoning_content].filter((s) => typeof s === "string").join("\n");
  const counted = num((body.usage as Record<string, unknown> | undefined)?.prompt_tokens);
  const tokens = counted ? ` · ${counted} prompt tokens counted` : "";
  if (said.includes(passphrase)) {
    return check("ok", `the instruction at the end of a ~${SMOKE_PROMPT_TOKENS / 1000}K-token prompt was followed in ${secs}s${tokens}`, undefined, pick.name);
  }
  return check(
    "fail",
    `the reply lacks the passphrase from the prompt's first line — its front was cut, or the end was ignored` +
      `${tokens} (${JSON.stringify(String(message.content ?? "").trim().slice(0, 60))})`,
    `agents on this model would lose their instructions without an error: ` +
      (server === "ollama" ? OLLAMA_CONTEXT_HINT : server === "lmstudio" ? LMSTUDIO_CONTEXT_HINT : "raise the server's context length"),
    pick.name,
  );
}
