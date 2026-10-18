/**
 * `odw doctor --local` (ODW extension): read-only probes of a local Ollama or
 * OpenAI-compatible (LM Studio) server, and the `--smoke` truncation probe —
 * all against a fake server on 127.0.0.1, never a real model service.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { main } from "../src/cli.ts";
import {
  isLocalHost,
  localModelChecks,
  normalizeEndpoint,
  truncationPrompt,
  versionAtLeast,
} from "../src/local-models.ts";

interface Fake {
  url: string;
  /** Every request: method, path and parsed JSON body. */
  seen: { method: string; path: string; body: Record<string, unknown> | undefined }[];
  close(): Promise<void>;
}

type Routes = Record<string, (body: Record<string, unknown> | undefined) => [number, unknown]>;

const servers: Server[] = [];
after(async () => {
  for (const s of servers) await new Promise((done) => s.close(done));
});

async function fake(routes: Routes): Promise<Fake> {
  const seen: Fake["seen"] = [];
  const read = (req: IncomingMessage) =>
    new Promise<string>((done) => {
      let d = "";
      req.on("data", (c) => (d += c)).on("end", () => done(d));
    });
  const server = createServer(async (req, res) => {
    const text = await read(req);
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
    const path = (req.url ?? "/").split("?")[0]!;
    seen.push({ method: req.method ?? "GET", path, body });
    const route = routes[`${req.method} ${path}`];
    const [status, json] = route ? route(body) : [404, { error: "not found" }];
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(json));
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise((done) => server.close(() => done())),
  };
}

/**
 * A model that sees only the last `keep` characters of its prompt — what a too-small
 * context does — and answers with the passphrase only if it is still there.
 */
function chat(keep: number, extra: Record<string, unknown> = {}) {
  return (body: Record<string, unknown> | undefined): [number, unknown] => {
    const prompt = String((body!.messages as { content: string }[])[0]!.content);
    const visible = prompt.slice(-keep);
    const pass = /ODW-[0-9A-F]{8}/.exec(visible)?.[0];
    return [
      200,
      {
        choices: [{ message: { role: "assistant", content: pass ? `${pass}` : "I do not see a passphrase." } }],
        usage: { prompt_tokens: Math.round(visible.length / 4) },
        ...extra,
      },
    ];
  };
}

function ollama(opts: { version?: string; ctx?: number; tools?: boolean; keep?: number; cloud?: boolean; loaded?: boolean } = {}): Routes {
  const name = opts.cloud ? "gpt-oss:120b-cloud" : "qwen3-coder:30b";
  return {
    "GET /api/version": () => [200, { version: opts.version ?? "0.13.5" }],
    "GET /api/ps": () => [
      200,
      { models: opts.loaded === false ? [] : [{ name, model: name, context_length: opts.ctx ?? 4096 }] },
    ],
    "GET /api/tags": () => [200, { models: [{ name }, { name: "llama3.2:3b" }] }],
    "POST /api/show": (body) =>
      body?.model === name || body?.model === "llama3.2:3b"
        ? [
            200,
            {
              capabilities: opts.tools === false ? ["completion"] : ["completion", "tools"],
              model_info: { "general.architecture": "qwen3moe", "qwen3moe.context_length": 262144 },
              parameters: body?.model === "llama3.2:3b" ? "num_ctx 8192\ntemperature 0.7" : "",
              ...(opts.cloud ? { remote_host: "https://ollama.com:443", remote_model: "gpt-oss:120b" } : {}),
            },
          ]
        : [404, { error: `model '${body?.model}' not found` }],
    "POST /v1/chat/completions": chat(opts.keep ?? 1_000_000),
  };
}

const ids = (checks: { id: string; status: string }[]) => checks.map((c) => `${c.id.replace(/^local:http:\/\/127\.0\.0\.1:\d+/, "")}=${c.status}`);
const generations = (f: Fake) => f.seen.filter((r) => r.path.endsWith("/chat/completions"));

test("local: an Ollama model loaded under 32K warns with how to set OLLAMA_CONTEXT_LENGTH", async () => {
  const f = await fake(ollama({ ctx: 4096 }));
  const checks = await localModelChecks({ endpoints: [f.url], smoke: false });
  assert.deepEqual(ids(checks), ["=ok", "#qwen3-coder:30b=warn"]);
  assert.match(checks[0]!.detail, /0\.13\.5 at .* 1 loaded, 2 installed/);
  const model = checks[1]!;
  assert.match(model.detail, /context 4K of 256K — under 32K/);
  assert.match(model.detail, /tool calling: yes/);
  assert.match(model.hint!, /OLLAMA_CONTEXT_LENGTH=32768 ollama serve/);
  assert.match(model.hint!, /ollama ps/);
  // Read-only: no generation without --smoke, and nothing that pulls or loads.
  assert.equal(generations(f).length, 0);
  assert.ok(f.seen.every((r) => ["/api/version", "/api/ps", "/api/tags", "/api/show"].includes(r.path)));
});

test("local: a 32K context with tools is ok; a model without tool calling warns; an old Ollama warns for codex --oss", async () => {
  const good = await fake(ollama({ ctx: 32768 }));
  const okChecks = await localModelChecks({ endpoints: [good.url], smoke: false });
  assert.deepEqual(ids(okChecks), ["=ok", "#qwen3-coder:30b=ok"]);
  assert.match(okChecks[1]!.detail, /context 32K of 256K · tool calling: yes/);

  const noTools = await fake(ollama({ ctx: 65536, tools: false, version: "0.12.0" }));
  const checks = await localModelChecks({ endpoints: [noTools.url], smoke: false });
  assert.deepEqual(ids(checks), ["=warn", "#qwen3-coder:30b=warn"]);
  assert.match(checks[0]!.hint!, /codex --oss.*0\.13\.4/);
  assert.match(checks[1]!.detail, /tool calling: not declared/);
});

test("local: nothing loaded warns and lists what is installed; --model reports one that is not loaded", async () => {
  const f = await fake(ollama({ loaded: false }));
  const none = await localModelChecks({ endpoints: [f.url], smoke: false });
  assert.deepEqual(ids(none), ["=ok", "#models=warn"]);
  assert.match(none[1]!.detail, /none loaded.*qwen3-coder:30b, llama3\.2:3b/);

  const named = await localModelChecks({ endpoints: [f.url], smoke: false, model: "llama3.2:3b" });
  assert.deepEqual(ids(named), ["=ok", "#llama3.2:3b=warn"]);
  assert.match(named[1]!.detail, /not loaded .*Modelfile num_ctx 8K/);

  const missing = await localModelChecks({ endpoints: [f.url], smoke: false, model: "nope:1b" });
  assert.deepEqual(ids(missing), ["=ok", "#nope:1b=fail"]);
});

test("local --smoke: a prompt whose front survives passes; a cut one fails as a doctor check", async () => {
  const whole = await fake(ollama({ ctx: 32768 }));
  const ok = await localModelChecks({ endpoints: [whole.url], smoke: true });
  assert.deepEqual(ids(ok), ["=ok", "#qwen3-coder:30b=ok", "#smoke=ok"]);
  assert.match(ok[2]!.detail, /instruction at the end of a ~10K-token prompt was followed.*prompt tokens counted/);
  const [req] = generations(whole);
  assert.equal(req!.body!.model, "qwen3-coder:30b");
  assert.equal(req!.body!.stream, false);
  assert.equal(req!.body!.options, undefined, "no num_ctx: the probe sees what agents see");

  // 4K tokens' worth of the end survives: the passphrase on the first line is gone.
  const cut = await fake(ollama({ ctx: 4096, keep: 16_000 }));
  const failed = await localModelChecks({ endpoints: [cut.url], smoke: true });
  const smoke = failed.find((c) => c.id.endsWith("#smoke"))!;
  assert.equal(smoke.status, "fail");
  assert.equal(smoke.title, "Smoke qwen3-coder:30b");
  assert.match(smoke.detail, /lacks the passphrase/);
  assert.match(smoke.hint!, /OLLAMA_CONTEXT_LENGTH/);
});

test("local --smoke never probes an Ollama cloud model", async () => {
  const f = await fake(ollama({ cloud: true }));
  const checks = await localModelChecks({ endpoints: [f.url], smoke: true });
  assert.match(checks[1]!.detail, /cloud model \(runs on https:\/\/ollama\.com:443, not here\)/);
  const smoke = checks.find((c) => c.id.endsWith("#smoke"))!;
  assert.equal(smoke.status, "skip");
  assert.equal(generations(f).length, 0);

  const named = await localModelChecks({ endpoints: [f.url], smoke: true, model: "gpt-oss:120b-cloud" });
  assert.equal(named.find((c) => c.id.endsWith("#smoke"))!.status, "skip");
  assert.equal(generations(f).length, 0);
});

test("local: LM Studio reports loaded context and tool_use; --smoke goes through /v1", async () => {
  const f = await fake({
    "GET /v1/models": () => [200, { object: "list", data: [{ id: "qwen2.5-7b-instruct" }, { id: "text-embedding-nomic" }] }],
    "GET /api/v0/models": () => [
      200,
      {
        data: [
          { id: "qwen2.5-7b-instruct", type: "llm", state: "loaded", max_context_length: 32768, loaded_context_length: 4096, capabilities: ["tool_use"] },
          { id: "text-embedding-nomic", type: "embeddings", state: "loaded", max_context_length: 2048 },
        ],
      },
    ],
    "POST /v1/chat/completions": chat(16_000),
  });
  const checks = await localModelChecks({ endpoints: [`${f.url}/v1/`], smoke: true });
  assert.deepEqual(ids(checks), ["=ok", "#qwen2.5-7b-instruct=warn", "#smoke=fail"]);
  assert.equal(checks[0]!.title, "Local LM Studio");
  assert.match(checks[1]!.detail, /context 4K of 32K — under 32K.*tool calling: yes/);
  assert.match(checks[1]!.hint!, /LM Studio's load settings/);
  assert.match(checks[2]!.hint!, /LM Studio/);
  assert.equal(generations(f)[0]!.body!.model, "qwen2.5-7b-instruct");
});

test("local: a plain OpenAI-compatible server says what it cannot report; --smoke still checks", async () => {
  const f = await fake({
    "GET /v1/models": () => [200, { data: [{ id: "local-model" }] }],
    "POST /v1/chat/completions": chat(1_000_000),
  });
  const plain = await localModelChecks({ endpoints: [f.url], smoke: false });
  assert.deepEqual(ids(plain), ["=ok", "#models=warn"]);
  assert.match(plain[1]!.detail, /does not report context length or tool calling/);
  const smoked = await localModelChecks({ endpoints: [f.url], smoke: true });
  assert.equal(smoked.at(-1)!.status, "ok");
});

test("local: a named endpoint that does not answer fails; absent defaults are skipped with one warning", async () => {
  const f = await fake({});
  const named = await localModelChecks({ endpoints: [f.url], smoke: false });
  assert.deepEqual(ids(named), ["=fail"]);
  const defaults = await localModelChecks({ endpoints: [], smoke: true, defaults: [f.url] });
  assert.deepEqual(ids(defaults), ["=skip", "local=warn"]);
  assert.equal(generations(f).length, 0);
  const bad = await localModelChecks({ endpoints: ["ftp://127.0.0.1:1"], smoke: false });
  assert.equal(bad[0]!.status, "fail");
  assert.match(bad[0]!.detail, /only http and https/);
});

test("local: what counts as local, endpoint forms, versions, and the probe's shape", () => {
  for (const h of ["localhost", "127.0.0.1", "[::1]", "10.0.0.5", "172.20.1.1", "192.168.1.9", "100.101.1.2", "gpu-box", "studio.local", "fe80::1", "::ffff:127.0.0.1"]) {
    assert.equal(isLocalHost(h), true, h);
  }
  for (const h of ["api.openai.com", "ollama.com", "8.8.8.8", "172.32.0.1", "2001:db8::1", "example.org"]) {
    assert.equal(isLocalHost(h), false, h);
  }
  assert.equal(String(normalizeEndpoint("127.0.0.1:11434")), "http://127.0.0.1:11434/");
  assert.equal(String(normalizeEndpoint("http://h:1234/v1/")), "http://h:1234/");
  assert.ok(normalizeEndpoint("http://user:pw@h:1") instanceof Error);
  assert.equal(versionAtLeast("0.13.4", "0.13.4"), true);
  assert.equal(versionAtLeast("0.9.10", "0.13.4"), false);
  assert.equal(versionAtLeast("1.0.0-rc1", "0.13.4"), true);
  const prompt = truncationPrompt("ODW-ABCDEF01");
  assert.match(prompt.split("\n")[0]!, /ODW-ABCDEF01/);
  assert.equal(prompt.split("ODW-ABCDEF01").length, 2, "only the first line holds it");
  assert.match(prompt.split("\n").at(-1)!, /^Instruction: begin your reply with the passphrase/);
  assert.ok(prompt.length / 4 > 8192, "comfortably over 8K tokens");
});

test("cli: odw doctor --endpoint implies --local and reports in --json; --model needs --local", async () => {
  const f = await fake(ollama({ ctx: 4096 }));
  const dir = mkdtempSync(join(tmpdir(), "odw-doctor-local-"));
  const config = join(dir, "odw.config.json");
  writeFileSync(config, JSON.stringify({ runsRoot: join(dir, "runs"), adapters: {} }));
  // The test runner reports through stdout as Buffers: those pass, the CLI's strings are kept.
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  let out = "";
  (process.stdout as { write: unknown }).write = (s: unknown) => (Buffer.isBuffer(s) ? so(s) : ((out += String(s)), true));
  (process.stderr as { write: unknown }).write = (s: unknown) => (Buffer.isBuffer(s) ? se(s) : true);
  const home = process.cwd();
  process.chdir(dir);
  try {
    const code = await main(["doctor", "--config", config, "--endpoint", f.url, "--json"]);
    assert.equal(await main(["doctor", "--model", "x"]), 2);
    const report = JSON.parse(out) as { checks: { id: string; status: string }[] };
    const local = report.checks.filter((c) => c.id.startsWith("local:"));
    assert.deepEqual(ids(local), ["=ok", "#qwen3-coder:30b=warn"]);
    assert.equal(code, report.checks.some((c) => c.status === "fail") ? 1 : 0);
  } finally {
    process.chdir(home);
    process.stdout.write = so;
    process.stderr.write = se;
    rmSync(dir, { recursive: true, force: true });
  }
});
