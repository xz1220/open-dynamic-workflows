import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectConfigWarnings, loadConfig } from "../src/adapters/config.js";
import { ConfigError } from "../src/errors.js";
import { contextEnv, describeRunEnd, notifyEnv, webhookPayload, waitingPayload, describeWaiting } from "../src/runtime/notify.js";
import { RunStore } from "../src/runtime/run-store.js";
import {
  ReplayCache,
  buildTriggers,
  dedupeKey,
  evalPath,
  eventTypes,
  mapArgs,
  parseDeliveryBody,
  parsePath,
  signatureHeaders,
  triggerContext,
  verifySignature,
  type TriggerVerify,
} from "../src/triggers.js";

// Signed inbound triggers (ODW extension; src/triggers.ts): each provider's
// signature checked as its docs say, against vectors computed here with
// node:crypto directly (not with the code under test), the replay windows,
// the JSONPath subset, the config, and the context a run carries to notify.

const SECRET = "whsec-test-0123456789abcdef";
const NOW = Date.UTC(2026, 9, 18, 12, 0, 0); // Unix ms
const hex = (key: string, data: string) => createHmac("sha256", key).update(data).digest("hex");

test("github: X-Hub-Signature-256 is sha256= over the raw body (GitHub's documented example too)", () => {
  // The example in GitHub's "Validating webhook deliveries" page.
  const docs = verifySignature("github", "It's a Secret to Everybody", {
    headers: { "x-hub-signature-256": "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17" },
    body: Buffer.from("Hello, World!"),
    now: NOW,
  });
  assert.equal(docs.ok, true);

  const body = '{"action":"labeled","issue":{"number":7}}';
  const headers = { "x-hub-signature-256": `sha256=${hex(SECRET, body)}` };
  assert.equal(verifySignature("github", SECRET, { headers, body: Buffer.from(body), now: NOW }).ok, true);
  // Upper-case hex is the same signature.
  assert.equal(verifySignature("github", SECRET, { headers: { "x-hub-signature-256": headers["x-hub-signature-256"].toUpperCase().replace("SHA256=", "sha256=") }, body: Buffer.from(body), now: NOW }).ok, true);
  const bad = (h: Record<string, string>, b = body) => verifySignature("github", SECRET, { headers: h, body: Buffer.from(b), now: NOW });
  assert.deepEqual(bad(headers, body.replace("7", "8")), { ok: false, error: "bad signature" }, "a changed body");
  assert.deepEqual(bad({ "x-hub-signature-256": `sha256=${hex("another-secret-0123456789", body)}` }), { ok: false, error: "bad signature" });
  assert.match(String((bad({}) as { error: string }).error), /missing or malformed X-Hub-Signature-256/);
  assert.match(String((bad({ "x-hub-signature-256": hex(SECRET, body) }) as { error: string }).error), /malformed/, "no sha256= prefix");
  assert.match(String((bad({ "x-hub-signature-256": "sha256=abc" }) as { error: string }).error), /malformed/, "too short");
  // The old SHA-1 header alone is not enough.
  assert.equal(bad({ "x-hub-signature": `sha1=${createHmac("sha1", SECRET).update(body).digest("hex")}` }).ok, false);
});

test("linear: Linear-Signature is the bare hex HMAC; webhookTimestamp must be within a minute", () => {
  const body = JSON.stringify({ action: "create", type: "Issue", data: { id: "uuid-1" }, webhookTimestamp: NOW - 30_000 });
  const headers = { "linear-signature": hex(SECRET, body) };
  assert.equal(verifySignature("linear", SECRET, { headers, body: Buffer.from(body), now: NOW }).ok, true);
  assert.deepEqual(verifySignature("linear", SECRET, { headers, body: Buffer.from(body), now: NOW + 31_000 }), {
    ok: false,
    error: "stale delivery: webhookTimestamp is over a minute off",
  });
  const noTs = JSON.stringify({ action: "create" });
  assert.match(
    String((verifySignature("linear", SECRET, { headers: { "linear-signature": hex(SECRET, noTs) }, body: Buffer.from(noTs), now: NOW }) as { error: string }).error),
    /webhookTimestamp/,
  );
  assert.equal(verifySignature("linear", SECRET, { headers: { "linear-signature": `sha256=${hex(SECRET, body)}` }, body: Buffer.from(body), now: NOW }).ok, false);
});

test("slack: v0= over v0:<ts>:<body>, timestamp within five minutes (replay window)", () => {
  const body = "token=x&command=%2Fodw&text=fix+the+bug&channel_id=C1";
  const ts = String(Math.floor(NOW / 1000));
  const headers = { "x-slack-request-timestamp": ts, "x-slack-signature": `v0=${hex(SECRET, `v0:${ts}:${body}`)}` };
  const at = (now: number, h: Record<string, string> = headers) => verifySignature("slack", SECRET, { headers: h, body: Buffer.from(body), now });
  assert.equal(at(NOW).ok, true);
  assert.equal(at(NOW + 299_000).ok, true, "inside the window");
  assert.deepEqual(at(NOW + 301_000), { ok: false, error: "stale delivery: its timestamp is over five minutes off" });
  assert.equal(at(NOW - 301_000).ok, false, "a timestamp from the future is as stale");
  // The timestamp is signed: moving it breaks the signature.
  const later = String(Number(ts) + 10);
  assert.deepEqual(at(NOW, { ...headers, "x-slack-request-timestamp": later }), { ok: false, error: "bad signature" });
  assert.equal(at(NOW, { ...headers, "x-slack-request-timestamp": "soon" }).ok, false);
  // A signature over the body alone (GitHub's scheme) does not pass.
  assert.equal(at(NOW, { ...headers, "x-slack-signature": `v0=${hex(SECRET, body)}` }).ok, false);
});

test("hmac-sha256: X-ODW-Signature over <ts>.<body>, X-ODW-Timestamp within five minutes", () => {
  const body = '{"id":42,"url":"https://ci.example.com/42"}';
  const ts = String(Math.floor(NOW / 1000));
  const headers = { "x-odw-timestamp": ts, "x-odw-signature": `sha256=${hex(SECRET, `${ts}.${body}`)}` };
  assert.equal(verifySignature("hmac-sha256", SECRET, { headers, body: Buffer.from(body), now: NOW }).ok, true);
  assert.equal(verifySignature("hmac-sha256", SECRET, { headers, body: Buffer.from(body), now: NOW + 301_000 }).ok, false);
  assert.equal(verifySignature("hmac-sha256", SECRET, { headers: { "x-odw-signature": headers["x-odw-signature"] }, body: Buffer.from(body), now: NOW }).ok, false);
});

test("signatureHeaders signs what verifySignature accepts, for every provider", () => {
  for (const verify of ["github", "linear", "slack", "hmac-sha256"] as TriggerVerify[]) {
    const body = JSON.stringify({ webhookTimestamp: NOW, hello: verify });
    const headers = signatureHeaders(verify, SECRET, body, NOW);
    assert.equal(verifySignature(verify, SECRET, { headers, body: Buffer.from(body), now: NOW }).ok, true, verify);
    assert.equal(verifySignature(verify, `${SECRET}x`, { headers, body: Buffer.from(body), now: NOW }).ok, false, `${verify}: another secret`);
  }
});

test("ReplayCache: a signature is accepted once within its window, again after it, and forget() lets a retry in", () => {
  const cache = new ReplayCache();
  assert.equal(cache.remember("a", 10, 0), true);
  assert.equal(cache.remember("a", 10, 9_000), false, "a replay inside the window");
  assert.equal(cache.remember("a", 10, 10_001), true, "after the window it is new again (the timestamp check refuses it anyway)");
  cache.forget("a");
  assert.equal(cache.remember("a", 10, 10_002), true);
  const small = new ReplayCache(2);
  small.remember("x", 100, 0);
  small.remember("y", 100, 0);
  small.remember("z", 100, 0);
  assert.equal(small.remember("x", 100, 1), true, "bounded: the oldest is dropped");
});

test("JSONPath subset: dots, quoted keys, indexes; own properties only; anything else refused", () => {
  const body = JSON.parse('{"data":{"id":"u1","labels":[{"name":"bug"},{"name":"odw"}],"key with space":3,"a-b":1},"__proto__":{"x":1}}');
  assert.equal(evalPath(body, "$.data.id"), "u1");
  assert.equal(evalPath(body, "$.data.labels[1].name"), "odw");
  assert.equal(evalPath(body, "$['data']['key with space']"), 3);
  assert.equal(evalPath(body, '$["data"].a-b'), 1);
  assert.deepEqual(evalPath(body, "$"), body);
  assert.equal(evalPath(body, "$.data.labels[5].name"), undefined);
  assert.equal(evalPath(body, "$.data.missing"), undefined);
  assert.equal(evalPath(body, "$.data.id.length"), undefined, "no properties of strings");
  assert.equal(evalPath({}, "$.constructor"), undefined, "never the prototype chain");
  assert.equal(evalPath({}, "$.toString"), undefined);
  assert.deepEqual(evalPath(body, "$.__proto__"), { x: 1 }, "an own __proto__ key (JSON.parse makes one) is just a key");
  for (const bad of ["data.id", "$.", "$..id", "$.data[*]", "$[-1]", "$[01]", "$.data[?(@.id)]", "$['unterminated]", "$ .a", "$.1a"]) {
    assert.equal(parsePath(bad), null, bad);
  }
  assert.deepEqual(mapArgs(body, { issue: "$.data.id", label: "$.data.labels[0].name", none: "$.nope" }), { issue: "u1", label: "bug" });
  assert.equal(dedupeKey(body, "$.data.id"), '"u1"');
  assert.equal(dedupeKey(body, "$.nope"), null);
  assert.equal(dedupeKey(body, null), null);
});

test("config: triggers validate strictly; untrusted defaults to true; a rate limit by default", () => {
  const built = buildTriggers({ fix: { workflow: "fix-issue", secretEnv: "FIX_SECRET", verify: "linear", args: { issue: "$.data.id" } } });
  assert.deepEqual(built.fix, {
    workflow: "fix-issue",
    secret: null,
    secretEnv: "FIX_SECRET",
    verify: "linear",
    args: { issue: "$.data.id" },
    events: null,
    dedupe: null,
    concurrency: null,
    rateLimit: { max: 30, windowSec: 3600 },
    untrusted: true,
    source: null,
  });
  assert.equal(buildTriggers({ t: { workflow: "w", secret: SECRET, verify: "github", untrusted: false } }).t!.untrusted, false);
  const refuse = (spec: unknown, re: RegExp) => assert.throws(() => buildTriggers(spec), (err: unknown) => err instanceof ConfigError && re.test(err.message));
  refuse([], /"triggers" must be an object/);
  refuse({ "bad name!": { workflow: "w", secret: SECRET, verify: "github" } }, /trigger name/);
  refuse({ t: { workflow: "w", secret: SECRET, verify: "github", untrused: false } }, /has no field "untrused"/);
  refuse({ t: { workflow: "w", secret: SECRET, secretEnv: "X", verify: "github" } }, /exactly one of "secret" or "secretEnv"/);
  refuse({ t: { workflow: "w", verify: "github" } }, /exactly one/);
  refuse({ t: { workflow: "w", secret: "short", verify: "github" } }, /16 or more characters/);
  refuse({ t: { workflow: "w", secretEnv: "1BAD", verify: "github" } }, /environment variable name/);
  refuse({ t: { workflow: "w", secret: SECRET, verify: "gitlab" } }, /verify must be one of/);
  refuse({ t: { secret: SECRET, verify: "github" } }, /workflow must name/);
  refuse({ t: { workflow: "w", secret: SECRET, verify: "github", args: { a: "data.id" } } }, /args\.a must be a JSONPath/);
  refuse({ t: { workflow: "w", secret: SECRET, verify: "github", dedupe: "$..x" } }, /dedupe must be a JSONPath/);
  refuse({ t: { workflow: "w", secret: SECRET, verify: "github", concurrency: 0 } }, /concurrency/);
  refuse({ t: { workflow: "w", secret: SECRET, verify: "github", rateLimit: { max: 1 } } }, /rateLimit/);
  refuse({ t: { workflow: "w", secret: SECRET, verify: "github", untrusted: "yes" } }, /untrusted must be/);
  refuse({ t: { workflow: "w", secret: SECRET, verify: "github", events: [] } }, /events/);

  // In a config file: a known top-level key, read into settings.
  const dir = mkdtempSync(join(tmpdir(), "odw-triggers-config-"));
  try {
    const path = join(dir, "odw.config.json");
    const raw = { triggers: { gh: { workflow: "triage", secretEnv: "GH_HOOK_SECRET", verify: "github", events: ["issues.labeled"] } } };
    writeFileSync(path, JSON.stringify(raw));
    assert.deepEqual(collectConfigWarnings(raw), []);
    const config = loadConfig(path, { quiet: true });
    assert.deepEqual(config.settings.triggers.gh!.events, ["issues.labeled"]);
    assert.deepEqual(loadConfig(null, { quiet: true, cwd: dir }).settings.triggers.gh!.verify, "github");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("event types and context, per provider", () => {
  const gh = {
    action: "labeled",
    issue: { number: 12, html_url: "https://github.com/acme/app/issues/12" },
    repository: { full_name: "acme/app", html_url: "https://github.com/acme/app" },
  };
  const ghHeaders = { "x-github-event": "issues", "x-github-delivery": "d-1" };
  assert.deepEqual(eventTypes("github", ghHeaders, gh), ["issues", "issues.labeled"]);
  assert.deepEqual(triggerContext("gh", "github", ghHeaders, gh), {
    trigger: "gh", provider: "github", event: "issues.labeled", deliveryId: "d-1", id: "12",
    url: "https://github.com/acme/app/issues/12", repo: "acme/app",
  });

  const linear = { action: "create", type: "Comment", url: "https://linear.app/acme/issue/ENG-1#comment-x", data: { id: "c-1", issueId: "i-1" } };
  assert.deepEqual(eventTypes("linear", {}, linear), ["Comment", "Comment.create"]);
  assert.deepEqual(triggerContext("lin", "linear", { "linear-delivery": "ld-1" }, linear), {
    trigger: "lin", provider: "linear", event: "Comment.create", deliveryId: "ld-1", id: "i-1", url: "https://linear.app/acme/issue/ENG-1#comment-x",
  });

  const slack = { type: "event_callback", event_id: "Ev1", event: { type: "app_mention", channel: "C1", ts: "1.2", thread_ts: "1.0" } };
  assert.deepEqual(eventTypes("slack", {}, slack), ["app_mention"]);
  assert.deepEqual(triggerContext("sl", "slack", {}, slack), {
    trigger: "sl", provider: "slack", event: "app_mention", deliveryId: "Ev1", id: "1.2", channel: "C1", threadTs: "1.0",
  });
  const unthreaded = triggerContext("sl", "slack", {}, { type: "event_callback", event: { type: "app_mention", channel: "C1", ts: "2.0" } });
  assert.equal(unthreaded.threadTs, "2.0", "a top-level message is answered in a thread under it");
  assert.deepEqual(eventTypes("slack", {}, { command: "/odw", channel_id: "C2" }), ["/odw"]);

  // Only http(s) URLs, no control characters, bounded.
  const odd = triggerContext("h", "hmac-sha256", { "x-odw-event": "deploy" }, { id: "a\u0000b\nc", url: "javascript:alert(1)" });
  assert.deepEqual(odd, { trigger: "h", provider: "hmac-sha256", event: "deploy", id: "abc" });
  assert.equal(triggerContext("h", "hmac-sha256", {}, { id: "x".repeat(2000) }).id!.length, 500);
});

test("delivery bodies: JSON, a Slack form, an interactivity payload; else null", () => {
  assert.deepEqual(parseDeliveryBody(Buffer.from('{"a":1}'), "application/json"), { a: 1 });
  assert.deepEqual(parseDeliveryBody(Buffer.from("command=%2Fodw&text=hi+there"), "application/x-www-form-urlencoded"), { command: "/odw", text: "hi there" });
  assert.deepEqual(
    parseDeliveryBody(Buffer.from(`payload=${encodeURIComponent('{"type":"block_actions"}')}`), "application/x-www-form-urlencoded; charset=utf-8"),
    { type: "block_actions" },
  );
  assert.equal(parseDeliveryBody(Buffer.from("not json"), "application/json"), null);
});

test("notify: a triggered run's context reaches the webhook payload and the command's environment", () => {
  const root = mkdtempSync(join(tmpdir(), "odw-trigger-notify-"));
  try {
    const store = new RunStore(root);
    const context = { trigger: "lin", provider: "linear", id: "i-1", url: "https://linear.app/acme/issue/ENG-1", event: "Issue.create" };
    const runId = store.create({ script: "/x/wf.js", args: null, source: root, context });
    store.updateStatus(runId, { state: "done", name: "fix" });
    assert.deepEqual(store.readMeta(runId).context, context);
    const end = describeRunEnd(store, runId, "done");
    assert.deepEqual(end.context, context);
    assert.deepEqual(webhookPayload(end).context, context);
    const env = notifyEnv(end);
    assert.equal(env.ODW_TRIGGER, "lin");
    assert.equal(env.ODW_EVENT_ID, "i-1");
    assert.equal(env.ODW_EVENT_URL, "https://linear.app/acme/issue/ENG-1");
    assert.deepEqual(JSON.parse(env.ODW_CONTEXT!), context);
    const waiting = describeWaiting(store, runId, { checkpointId: 1, title: "Ship?", since: Date.now() / 1000 } as never);
    assert.deepEqual(waitingPayload(waiting).context, context);

    // A run no trigger started has neither.
    const plain = store.create({ script: "/x/wf.js", args: null, source: root });
    store.updateStatus(plain, { state: "done" });
    const plainEnd = describeRunEnd(store, plain, "done");
    assert.equal("context" in webhookPayload(plainEnd), false);
    assert.equal(notifyEnv(plainEnd).ODW_TRIGGER, undefined);
    assert.deepEqual(contextEnv(undefined), {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
