import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";

import { collectConfigWarnings, defaultConfig, loadConfig } from "../src/adapters/config.js";
import type { Config } from "../src/adapters/types.js";
import { main } from "../src/cli.js";
import { runDoctor } from "../src/doctor.js";
import type { OtlpAnyValue, OtlpSpan, OtlpTraces } from "../src/otel.js";
import { isSecretName } from "../src/redact.js";
import {
  captureFromEnv,
  exportRunEnd,
  exportTimeout,
  otelCheck,
  otlpTarget,
  parseKeyValues,
  resourceFromEnv,
} from "../src/runtime/otel-export.js";
import { RunStore } from "../src/runtime/run-store.js";
import { executeRun } from "../src/runtime/worker.js";

// Exporting runs as OpenTelemetry traces (ODW extension): where they go, the
// `otel` setting, `odw doctor`, `odw export --otlp`, and the worker's export at a
// run's end against a local OTLP/HTTP receiver.

// --- helpers --------------------------------------------------------------------

interface Post {
  path: string | undefined;
  headers: IncomingHttpHeaders;
  body: OtlpTraces;
}

/** A local OTLP/HTTP receiver that records every POST; `respond` answers it. */
async function receiver(respond: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => res.end("{}")) {
  const posts: Post[] = [];
  const server = createServer((req, res) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (data += chunk));
    req.on("end", () => {
      posts.push({ path: req.url, headers: req.headers, body: JSON.parse(data) as OtlpTraces });
      respond(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    posts,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const spansOf = (trace: OtlpTraces): OtlpSpan[] => trace.resourceSpans[0]!.scopeSpans[0]!.spans;
const attr = (span: OtlpSpan, key: string): OtlpAnyValue | undefined => span.attributes.find((a) => a.key === key)?.value;

/** Capture what the worker writes to stderr (its worker.log) while `fn` runs. */
async function captureStderr<T>(fn: () => Promise<T>): Promise<{ value: T; stderr: string }> {
  const original = process.stderr.write.bind(process.stderr);
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { value: await fn(), stderr };
  } finally {
    process.stderr.write = original;
  }
}

/** Run the CLI, capturing what it prints. */
async function cli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  (process.stdout as { write: unknown }).write = (s: unknown) => (out.push(String(s)), true);
  (process.stderr as { write: unknown }).write = (s: unknown) => (err.push(String(s)), true);
  try {
    const code = await main(argv);
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
  }
}

/** Set environment variables while `fn` runs. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** The OTEL_* variables these tests set: none may leak in from the machine running them. */
const CLEAN_ENV = {
  OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: undefined,
  OTEL_EXPORTER_OTLP_HEADERS: undefined,
  OTEL_EXPORTER_OTLP_TRACES_HEADERS: undefined,
  OTEL_EXPORTER_OTLP_TIMEOUT: undefined,
  OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: undefined,
  OTEL_SERVICE_NAME: undefined,
  OTEL_RESOURCE_ATTRIBUTES: undefined,
  OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: undefined,
};

/**
 * A mock Claude Code printing stream-json: one Bash call and its result, then
 * the reply with usage and cost.
 */
const MOCK_CLAUDE = [
  execPath,
  "-e",
  `let prompt = '';
process.stdin.on('data', (c) => (prompt += c)).on('end', () => {
  const emit = (e) => process.stdout.write(JSON.stringify(e) + '\\n');
  emit({ type: 'system', subtype: 'init', session_id: 'sess', model: 'mock-model' });
  emit({ type: 'assistant', message: { model: 'mock-model-1', content: [{ type: 'tool_use', id: 'toolu_9', name: 'Bash', input: { command: 'ls' } }] } });
  emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: 'a.txt' }] } });
  emit({ type: 'result', subtype: 'success', is_error: false, result: 'listed', total_cost_usd: 0.02, usage: { input_tokens: 10, output_tokens: 5 } });
});`,
  // The model a call asks for reaches the CLI here (the mock ignores it), so agent_started records it.
  "{model}",
];

/** A runs root with a mock stream-json adapter and the given extra config. */
function project(extra: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "odw-otel-"));
  const configPath = join(root, "odw.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      defaultAdapter: "mockclaude",
      adapters: { mockclaude: { command: MOCK_CLAUDE, stdin: "{prompt}", output: defaultConfig().adapters.claude!.output } },
      ...extra,
    }),
  );
  const store = new RunStore(join(root, "runs"));
  let n = 0;
  const create = (body: string) => {
    const script = join(root, `wf-${++n}.js`);
    writeFileSync(script, `export const meta = { name: 'nightly', description: 'd' }\n${body}`);
    return store.create({ script, args: { token: "ARGS-SECRET-VALUE" }, source: root, configPath });
  };
  return { root, configPath, store, create, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function otelConfig(otel: unknown): Config {
  const dir = mkdtempSync(join(tmpdir(), "odw-otel-cfg-"));
  try {
    const path = join(dir, "odw.config.json");
    writeFileSync(path, JSON.stringify({ otel }));
    return loadConfig(path, { quiet: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- where traces go -------------------------------------------------------------------

test("OTEL_* key=value lists: percent-decoded; one malformed pair discards the whole value", () => {
  assert.deepEqual(parseKeyValues("Authorization=Basic%20abc%3D%3D, x-team = t1"), { Authorization: "Basic abc==", "x-team": "t1" });
  assert.deepEqual(parseKeyValues(""), {});
  assert.equal(parseKeyValues("a=1,b"), null);
  assert.equal(parseKeyValues("a=%E0%A4%A"), null);
});

test("the endpoint: otel.endpoint, else the traces variable as it is, else the base variable, else localhost:4318", () => {
  const on = { endpoint: null, headers: {}, captureContent: false };
  assert.equal(otlpTarget(on, {}).url, "http://localhost:4318/v1/traces");
  assert.equal(otlpTarget(on, { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" }).url, "http://collector:4318/v1/traces");
  assert.equal(otlpTarget(on, { OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.com/api/public/otel/" }).url, "https://otel.example.com/api/public/otel/v1/traces");
  assert.equal(
    otlpTarget(on, { OTEL_EXPORTER_OTLP_ENDPOINT: "http://a:4318", OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://b:4318/custom" }).url,
    "http://b:4318/custom",
    "the signal's own variable is used as it is",
  );
  const configured = { ...on, endpoint: "http://c:4318/v1/traces" };
  assert.equal(otlpTarget(configured, { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://b:4318" }).url, "http://c:4318/v1/traces", "the config wins; /v1/traces not doubled");
  assert.equal(otlpTarget(configured, {}).origin, "http://c:4318");
  assert.throws(() => otlpTarget(on, { OTEL_EXPORTER_OTLP_ENDPOINT: "not a url with SECRET" }), (err: Error) => {
    assert.equal(err.message, "OTEL_EXPORTER_OTLP_ENDPOINT is not an absolute URL");
    return true;
  });
});

test("the headers: the base variable, then the traces one, then otel.headers", () => {
  const target = otlpTarget(
    { endpoint: null, headers: { "x-team": "from-config" }, captureContent: false },
    { OTEL_EXPORTER_OTLP_HEADERS: "x-team=base,Authorization=Basic%20k", OTEL_EXPORTER_OTLP_TRACES_HEADERS: "x-extra=traces" },
  );
  assert.deepEqual(target.headers, { "x-team": "from-config", Authorization: "Basic k", "x-extra": "traces" });
});

test("the resource, the content switch and the time limit from the environment", () => {
  assert.equal(resourceFromEnv({})["service.name"], "odw");
  assert.ok(resourceFromEnv({})["service.version"]);
  const resource = resourceFromEnv({ OTEL_RESOURCE_ATTRIBUTES: "service.name=x,deployment.environment=ci", OTEL_SERVICE_NAME: "agents" });
  assert.equal(resource["service.name"], "agents", "OTEL_SERVICE_NAME wins");
  assert.equal(resource["deployment.environment"], "ci");
  assert.equal(resourceFromEnv({ OTEL_RESOURCE_ATTRIBUTES: "service.name=x" })["service.name"], "x");
  for (const on of ["true", "TRUE", "span_only", "SPAN_AND_EVENT"]) assert.equal(captureFromEnv({ OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: on }), true, on);
  for (const off of ["", "false", "1", "EVENT_ONLY", "NO_CONTENT"]) assert.equal(captureFromEnv({ OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: off }), false, off);
  assert.equal(exportTimeout({}, 5000), 5000);
  assert.equal(exportTimeout({ OTEL_EXPORTER_OTLP_TIMEOUT: "200" }, 5000), 200);
  assert.equal(exportTimeout({ OTEL_EXPORTER_OTLP_TIMEOUT: "60000" }, 5000), 5000, "never longer than the cap");
});

test("OTLP header variables count as secrets: what agents print of them is redacted", () => {
  assert.equal(isSecretName("OTEL_EXPORTER_OTLP_HEADERS"), true);
  assert.equal(isSecretName("OTEL_EXPORTER_OTLP_TRACES_HEADERS"), true);
  assert.equal(isSecretName("OTEL_EXPORTER_OTLP_ENDPOINT"), false);
});

// --- the setting -----------------------------------------------------------------------

test("otel: off by default; true or an object turns it on; bad values fail without echoing them", () => {
  assert.equal(defaultConfig().settings.otel, false);
  assert.equal(otelConfig(false).settings.otel, false);
  assert.deepEqual(otelConfig(true).settings.otel, { endpoint: null, headers: {}, captureContent: false });
  assert.deepEqual(otelConfig({ endpoint: "http://localhost:4318", headers: { "x-key": "v" }, captureContent: true }).settings.otel, {
    endpoint: "http://localhost:4318/",
    headers: { "x-key": "v" },
    captureContent: true,
  });
  const fails = (otel: unknown, pattern: RegExp) =>
    assert.throws(() => otelConfig(otel), (err: Error) => {
      assert.match(err.message, pattern);
      assert.doesNotMatch(err.message, /SECRET/, "never the value");
      return true;
    });
  fails("yes", /"otel" must be false, true, or/);
  fails({ endpoint: "ftp://SECRET" }, /"otel.endpoint" must be an http\(s\) URL/);
  fails({ endpoint: "http://user:SECRET@host" }, /must not embed credentials/);
  fails({ headers: { "x-key": "SECRET\nline" } }, /"otel.headers.x-key" must be a string on one line/);
  fails({ headers: { "bad name": "SECRET" } }, /must be HTTP header names/);
  assert.throws(() => otelConfig({ captureContent: "yes" }), /"otel.captureContent" must be true or false/);
  assert.deepEqual(collectConfigWarnings({ otel: { endpont: "x" } }), ['otel: unknown field "endpont" is ignored — did you mean "endpoint"?']);
});

test("the example config's commented-out otel block is valid once enabled", () => {
  const example = JSON.parse(readFileSync(join(process.cwd(), "odw.config.example.json"), "utf8"));
  const { "//otel": otel, ...rest } = example;
  assert.ok(otel, "the example shows an otel block");
  const enabled = { ...rest, otel };
  assert.deepEqual(collectConfigWarnings(enabled), []);
  const dir = mkdtempSync(join(tmpdir(), "odw-otel-ex-"));
  try {
    const p = join(dir, "odw.config.json");
    writeFileSync(p, JSON.stringify(enabled));
    const settings = loadConfig(p, { quiet: true }).settings.otel;
    assert.ok(settings && settings.captureContent === false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("odw doctor: whether runs are exported, and where to — scheme and host, header names, never their values", async () => {
  assert.equal(otelCheck(defaultConfig(), {}).status, "skip");
  const config = otelConfig({ endpoint: "https://otel.example.com/api/public/otel?tenant=PATHSECRET", headers: { Authorization: "Basic VALUESECRET" } });
  const check = otelCheck(config, {});
  assert.equal(check.status, "ok");
  assert.equal(check.detail, "on — each run's trace goes to https://otel.example.com (OTLP/HTTP, JSON) with header Authorization; content not captured");
  assert.equal(otelCheck(config, { OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" }).status, "warn");
  assert.equal(otelCheck(otelConfig(true), { OTEL_EXPORTER_OTLP_ENDPOINT: "nope" }).status, "warn");
  const report = await runDoctor({ config, configPath: null, cwd: process.cwd(), smoke: [], env: {}, runner: async () => ({ returncode: 0, stdout: "1.0", stderr: "", timedOut: false, duration: 0 }) });
  const line = report.checks.find((c) => c.id === "otel")!;
  assert.equal(line.title, "OpenTelemetry export");
  assert.doesNotMatch(JSON.stringify(report), /VALUESECRET|PATHSECRET/);
});

// --- odw export --------------------------------------------------------------------------

test("odw export --otlp: the run's trace on stdout or into a file, offline; --send posts it", async () => {
  const fx = project({ models: { fast: { mockclaude: "fast-id" } } });
  const hook = await receiver();
  try {
    await withEnv(CLEAN_ENV, async () => {
      const id = fx.create("phase('Work')\nreturn await agent('list the files', { label: 'lister', model: '@fast' })");
      assert.equal(await executeRun(fx.store.runDir(id)), "done");
      const flags = ["--config", fx.configPath, "--runs-root", fx.store.root];

      const printed = await cli(["export", id, "--otlp", ...flags]);
      assert.equal(printed.code, 0, printed.err);
      const trace = JSON.parse(printed.out) as OtlpTraces;
      const names = spansOf(trace).map((s) => s.name);
      assert.deepEqual(names, ["invoke_workflow nightly", "phase Work", "invoke_agent lister", "execute_tool Bash"]);
      const agent = spansOf(trace)[2]!;
      assert.deepEqual(attr(agent, "gen_ai.usage.output_tokens"), { intValue: "5" });
      assert.deepEqual(attr(agent, "odw.agent.cost_usd"), { doubleValue: 0.02 });
      assert.deepEqual(attr(agent, "gen_ai.response.model"), { stringValue: "mock-model-1" });
      assert.deepEqual(attr(agent, "gen_ai.request.model"), { stringValue: "fast-id" }, "the tier, resolved for its adapter");
      assert.doesNotMatch(printed.out, /ARGS-SECRET-VALUE|listed/, "no args, and no content by default");

      const file = join(fx.root, "trace.json");
      const written = await cli(["export", id, "--otlp", "--out", file, ...flags]);
      assert.equal(written.code, 0);
      assert.equal(readFileSync(file, "utf8"), printed.out, "the same trace: ids are derived from the run");
      assert.match(written.err, new RegExp(`wrote the trace of run ${id} \\(4 spans\\) to `));

      const content = await withEnv({ OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "true" }, () => cli(["export", id, "--otlp", ...flags]));
      assert.match(content.out, /gen_ai\.output\.messages/);
      assert.match(content.out, /listed/);

      const sent = await withEnv(
        { OTEL_EXPORTER_OTLP_ENDPOINT: hook.origin, OTEL_EXPORTER_OTLP_HEADERS: "x-api-key=HEADER-SECRET" },
        () => cli(["export", id, "--otlp", "--send", ...flags]),
      );
      assert.equal(sent.code, 0, sent.err);
      assert.equal(sent.err, `sent the trace of run ${id} (4 spans) to ${hook.origin}\n`);
      assert.equal(hook.posts.length, 1);
      assert.equal(hook.posts[0]!.path, "/v1/traces");
      assert.equal(hook.posts[0]!.headers["content-type"], "application/json");
      assert.equal(hook.posts[0]!.headers["x-api-key"], "HEADER-SECRET");
      assert.deepEqual(hook.posts[0]!.body, trace);

      assert.equal((await cli(["export", id, ...flags])).code, 2, "--otlp is required");
      assert.equal((await cli(["export", id, "--otlp", "--send", "--out", file, ...flags])).code, 2);
      const missing = await cli(["export", "20200101-000000-000000", "--otlp", ...flags]);
      assert.equal(missing.code, 1);
      assert.match(missing.err, /no such run/);
    });
  } finally {
    await hook.close();
    fx.cleanup();
  }
});

test("odw export --send: a refused export exits 1, saying so without the header's value", async () => {
  const fx = project({});
  const hook = await receiver((_req, res) => {
    res.writeHead(401, { "content-type": "text/plain" });
    res.end("bad key HEADER-SECRET");
  });
  try {
    await withEnv({ ...CLEAN_ENV, OTEL_EXPORTER_OTLP_ENDPOINT: hook.origin, OTEL_EXPORTER_OTLP_HEADERS: "authorization=HEADER-SECRET" }, async () => {
      const id = fx.create("return 1");
      assert.equal(await executeRun(fx.store.runDir(id)), "done");
      const sent = await cli(["export", id, "--otlp", "--send", "--config", fx.configPath, "--runs-root", fx.store.root]);
      assert.equal(sent.code, 1);
      assert.equal(sent.err, `odw export: ${hook.origin} answered 401 Unauthorized: bad key «header»\n`);
    });
  } finally {
    await hook.close();
    fx.cleanup();
  }
});

// --- the worker's export ------------------------------------------------------------------

test("with otel in the config, the worker posts the run's trace exactly once, at its end, with the headers", async () => {
  const hook = await receiver();
  const fx = project({ otel: { endpoint: hook.origin, headers: { "x-config-key": "CONFIG-SECRET" } } });
  try {
    await withEnv({ ...CLEAN_ENV, OTEL_EXPORTER_OTLP_HEADERS: "x-env-key=ENV-SECRET", OTEL_SERVICE_NAME: "nightly-agents" }, async () => {
      const id = fx.create("await agent('a', { label: 'one' })\nreturn 'ok'");
      assert.equal(await executeRun(fx.store.runDir(id)), "done");
      assert.equal(hook.posts.length, 1, "exactly one POST");
      const { path, headers, body } = hook.posts[0]!;
      assert.equal(path, "/v1/traces");
      assert.equal(headers["content-type"], "application/json");
      assert.equal(headers["x-config-key"], "CONFIG-SECRET");
      assert.equal(headers["x-env-key"], "ENV-SECRET");
      const root = spansOf(body)[0]!;
      assert.deepEqual(attr(root, "odw.run.state"), { stringValue: "done" }, "sent once the terminal state was on disk");
      assert.deepEqual(body.resourceSpans[0]!.resource.attributes.find((a) => a.key === "service.name")?.value, { stringValue: "nightly-agents" });
      const events = fx.store.readEvents(id);
      assert.equal(events.at(-1)!.type, "run_finished", "the export writes no event");
      assert.doesNotMatch(readFileSync(fx.store.eventsPath(id), "utf8"), /SECRET/);
    });
  } finally {
    await hook.close();
    fx.cleanup();
  }
});

test("the OTEL_* variables alone send nothing: export needs otel in the config", async () => {
  const hook = await receiver();
  const fx = project({});
  try {
    await withEnv({ ...CLEAN_ENV, OTEL_EXPORTER_OTLP_ENDPOINT: hook.origin }, async () => {
      assert.equal(await executeRun(fx.store.runDir(fx.create("return 1"))), "done");
      assert.equal(hook.posts.length, 0);
    });
  } finally {
    await hook.close();
    fx.cleanup();
  }
});

test("a failing endpoint changes nothing about the run: one line in worker.log, without the header's value", async () => {
  const hook = await receiver((_req, res) => {
    res.writeHead(503);
    res.end("busy");
  });
  const fx = project({ otel: { endpoint: `${hook.origin}/v1/traces?tenant=PATHSECRET`, headers: { authorization: "Bearer HEADER-SECRET" } } });
  try {
    await withEnv(CLEAN_ENV, async () => {
      const id = fx.create("throw new Error('kaboom')");
      const { value, stderr } = await captureStderr(() => executeRun(fx.store.runDir(id)));
      assert.equal(value, "failed");
      assert.equal(fx.store.readStatus(id).state, "failed");
      assert.equal(hook.posts.length, 1);
      const lines = stderr.split("\n").filter((line) => line.includes("otel"));
      assert.deepEqual(lines, [`odw: otel: the trace of run ${id} was not exported: ${hook.origin} answered 503 Service Unavailable: busy`]);
      assert.doesNotMatch(stderr, /SECRET/);
    });
  } finally {
    await hook.close();
    fx.cleanup();
  }
});

test("a slow endpoint holds the worker no longer than the export's time limit", async () => {
  const hook = await receiver(() => {}); // never answers
  const fx = project({ otel: { endpoint: hook.origin } });
  try {
    await withEnv({ ...CLEAN_ENV, OTEL_EXPORTER_OTLP_TIMEOUT: "300" }, async () => {
      const id = fx.create("return 'fine'");
      const started = Date.now();
      const { value, stderr } = await captureStderr(() => executeRun(fx.store.runDir(id)));
      assert.equal(value, "done");
      assert.ok(Date.now() - started < 4000, "the 300ms limit held");
      assert.equal(fx.store.readResult(id), "fine");
      assert.match(stderr, new RegExp(`odw: otel: the trace of run ${id} was not exported: ${hook.origin} failed: timed out after 0\\.3s`));
    });
  } finally {
    await hook.close();
    fx.cleanup();
  }
});

test("exportRunEnd never rejects: no config, an unreachable endpoint, a bad environment", async () => {
  const fx = project({});
  try {
    const id = fx.create("return 1");
    await exportRunEnd(null, { store: fx.store, runId: id });
    const lines: string[] = [];
    const config = otelConfig({ endpoint: "http://127.0.0.1:9" });
    await exportRunEnd(config, { store: fx.store, runId: id }, { log: (l) => lines.push(l), timeoutMs: 2000, env: {} });
    await exportRunEnd(otelConfig(true), { store: fx.store, runId: id }, { log: (l) => lines.push(l), env: { OTEL_EXPORTER_OTLP_ENDPOINT: "::" } });
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /^otel: the trace of run .* was not exported: http:\/\/127\.0\.0\.1:9 failed: /);
    assert.equal(lines[1], `otel: the trace of run ${id} was not exported: OTEL_EXPORTER_OTLP_ENDPOINT is not an absolute URL`);
  } finally {
    fx.cleanup();
  }
});
