import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultConfig } from "../src/adapters/config.js";
import type { Config } from "../src/adapters/types.js";
import { waitFor } from "../src/runtime/launcher.js";
import { RunStore } from "../src/runtime/run-store.js";
import { startServer } from "../src/runtime/server.js";
import { TRIGGER_MAX_BODY_BYTES, triggerLines, type TriggerStart } from "../src/runtime/trigger-route.js";
import { buildTriggers, signatureHeaders, type TriggerVerify } from "../src/triggers.js";

// POST /api/triggers/<name> (ODW extension; src/runtime/trigger-route.ts):
// a signed webhook starts its trigger's workflow, untrusted by default, and
// answers 202 with the run id; everything else is refused or deduped.

const SECRET = "whsec-route-0123456789abcdef";

interface Harness {
  base: string;
  port: number;
  store: RunStore;
  root: string;
  starts: TriggerStart[];
  /** Run ids the stub launcher reports as still active. */
  active: Set<string>;
  post(name: string, body: string, opts?: { verify?: TriggerVerify; secret?: string; headers?: Record<string, string>; now?: number }): Promise<{ status: number; json: Record<string, unknown>; headers: Headers }>;
}

async function withTriggers(
  triggers: Record<string, unknown>,
  body: (h: Harness) => Promise<void>,
  opts: { host?: string; token?: string; env?: NodeJS.ProcessEnv; realStart?: boolean; failures?: number; config?: (c: Config) => void } = {},
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "odw-trigger-route-"));
  const store = new RunStore(join(root, "runs"));
  const config = defaultConfig();
  config.settings.triggers = buildTriggers(triggers);
  opts.config?.(config);
  const starts: TriggerStart[] = [];
  const active = new Set<string>();
  let n = 0;
  const handle = await startServer({
    store,
    port: 0,
    host: opts.host ?? "127.0.0.1",
    cwd: root,
    config,
    claudeProjectsRoot: join(root, "no-claude"),
    token: opts.token ?? null,
    triggerSeams: {
      ...(opts.realStart
        ? {}
        : {
            start: (spec: TriggerStart) => {
              starts.push(spec);
              const runId = `20261018-120000-run${++n}`;
              active.add(runId);
              return runId;
            },
            isActive: (runId: string) => active.has(runId),
          }),
      env: opts.env ?? {},
      log: () => {},
      ...(opts.failures ? { failureLimit: { failures: opts.failures, windowMs: 60_000 } } : {}),
    },
  });
  const base = `http://127.0.0.1:${handle.port}`;
  const post: Harness["post"] = async (name, text, o = {}) => {
    const verify = o.verify ?? "github";
    const signed = signatureHeaders(verify, o.secret ?? SECRET, text, o.now ?? Date.now());
    const res = await fetch(`${base}/api/triggers/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...signed, ...o.headers },
      body: text,
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown>, headers: res.headers };
  };
  try {
    await body({ base, port: handle.port, store, root, starts, active, post });
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const GH = {
  gh: {
    workflow: "triage",
    secret: SECRET,
    verify: "github",
    args: { issue: "$.issue.number", title: "$.issue.title", missing: "$.nope" },
    dedupe: "$.issue.number",
  },
};

function issueEvent(number: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: "labeled",
    issue: { number, title: `Bug ${number}`, html_url: `https://github.com/acme/app/issues/${number}` },
    repository: { full_name: "acme/app", html_url: "https://github.com/acme/app" },
    ...extra,
  });
}

test("a signed delivery starts its workflow untrusted, with mapped args and context: 202 with the run id", async () => {
  await withTriggers(GH, async ({ post, starts, root }) => {
    const res = await post("gh", issueEvent(7), { headers: { "x-github-event": "issues", "x-github-delivery": "dlv-1" } });
    assert.equal(res.status, 202);
    assert.deepEqual(res.json, { ok: true, trigger: "gh", runId: "20261018-120000-run1" });
    assert.equal(starts.length, 1);
    const start = starts[0]!;
    assert.equal(start.workflow, "triage");
    assert.equal(start.untrusted, true, "untrusted by default: issue text is untrusted input");
    assert.deepEqual(start.args, { issue: 7, title: "Bug 7" });
    assert.equal(start.source, root);
    assert.deepEqual(start.context, {
      trigger: "gh",
      provider: "github",
      event: "issues.labeled",
      deliveryId: "dlv-1",
      id: "7",
      url: "https://github.com/acme/app/issues/7",
      repo: "acme/app",
      dedupe: "7",
    });
  });
});

test("unknown trigger 404; bad or missing signature 401; unset secret 503; oversize 413", async () => {
  await withTriggers(
    { ...GH, envd: { workflow: "w", secretEnv: "ODW_TEST_UNSET_SECRET", verify: "github" } },
    async ({ post, base, starts }) => {
      assert.equal((await post("nope", issueEvent(1))).status, 404);
      assert.equal((await post("..%2Fgh", issueEvent(1))).status, 404, "an encoded path is no name");
      const bad = await post("gh", issueEvent(1), { secret: "a-different-secret-0123456789" });
      assert.equal(bad.status, 401);
      assert.equal(bad.json.error, "bad signature");
      const missing = await fetch(`${base}/api/triggers/gh`, { method: "POST", headers: { "content-type": "application/json" }, body: issueEvent(1) });
      assert.equal(missing.status, 401);
      await missing.text();
      const unset = await post("envd", issueEvent(1));
      assert.equal(unset.status, 503);
      assert.match(String(unset.json.error), /ODW_TEST_UNSET_SECRET/);
      const big = await post("gh", JSON.stringify({ pad: "x".repeat(TRIGGER_MAX_BODY_BYTES) }));
      assert.equal(big.status, 413);
      const get = await fetch(`${base}/api/triggers/gh`);
      assert.equal(get.status, 405);
      await get.text();
      assert.equal(starts.length, 0, "nothing started");
    },
  );
});

test("dedupe: one active run per key; a new one once it ended", async () => {
  await withTriggers(GH, async ({ post, starts, active }) => {
    const first = await post("gh", issueEvent(7));
    assert.equal(first.status, 202);
    // Another delivery about the same issue (another body, so another signature).
    const again = await post("gh", issueEvent(7, { label: { name: "again" } }));
    assert.equal(again.status, 200);
    assert.equal(again.json.deduped, true);
    assert.equal(again.json.runId, first.json.runId);
    const other = await post("gh", issueEvent(8));
    assert.equal(other.status, 202, "another issue is another key");
    active.delete(String(first.json.runId));
    const later = await post("gh", issueEvent(7, { label: { name: "third" } }));
    assert.equal(later.status, 202, "the first run ended: a new one starts");
    assert.equal(starts.length, 3);
  });
});

test("replays: the same signed delivery twice starts one run", async () => {
  await withTriggers(GH, async ({ post, starts }) => {
    const text = issueEvent(9);
    const now = Date.now();
    assert.equal((await post("gh", text, { now })).status, 202);
    const replay = await post("gh", text, { now });
    assert.equal(replay.status, 200);
    assert.equal(replay.json.duplicate, true);
    assert.equal(starts.length, 1);
  });
});

test("concurrency and the per-trigger rate limit answer 429 with retry-after", async () => {
  await withTriggers(
    {
      one: { workflow: "w", secret: SECRET, verify: "hmac-sha256", concurrency: 1 },
      rated: { workflow: "w", secret: SECRET, verify: "hmac-sha256", rateLimit: { max: 2, windowSec: 600 } },
    },
    async ({ post, starts, active }) => {
      const a = await post("one", '{"n":1}', { verify: "hmac-sha256" });
      assert.equal(a.status, 202);
      const busy = await post("one", '{"n":2}', { verify: "hmac-sha256" });
      assert.equal(busy.status, 429);
      assert.match(String(busy.json.error), /concurrency/);
      assert.ok(Number(busy.headers.get("retry-after")) > 0);
      active.delete(String(a.json.runId));
      // The refused delivery was not remembered as seen: its retry starts the run.
      assert.equal((await post("one", '{"n":2}', { verify: "hmac-sha256" })).status, 202);

      assert.equal((await post("rated", '{"n":1}', { verify: "hmac-sha256" })).status, 202);
      assert.equal((await post("rated", '{"n":2}', { verify: "hmac-sha256" })).status, 202);
      const limited = await post("rated", '{"n":3}', { verify: "hmac-sha256" });
      assert.equal(limited.status, 429);
      assert.match(String(limited.json.error), /rate limit/);
      const retryAfter = Number(limited.headers.get("retry-after"));
      assert.ok(retryAfter > 590 && retryAfter <= 600, String(retryAfter));
      assert.equal(starts.length, 4);
    },
  );
});

test("handshakes and event filters start nothing; untrusted: false is honoured", async () => {
  await withTriggers(
    {
      gh: { workflow: "w", secret: SECRET, verify: "github", events: ["issues.labeled"], untrusted: false },
      sl: { workflow: "w", secret: SECRET, verify: "slack", args: { text: "$.event.text" } },
    },
    async ({ post, starts }) => {
      const ping = await post("gh", '{"zen":"hi"}', { headers: { "x-github-event": "ping" } });
      assert.deepEqual(ping.json, { ok: true, pong: true });
      const opened = await post("gh", issueEvent(1, { action: "opened" }), { headers: { "x-github-event": "issues" } });
      assert.equal(opened.status, 200);
      assert.match(String(opened.json.ignored), /issues\.opened/);
      const labeled = await post("gh", issueEvent(1), { headers: { "x-github-event": "issues" } });
      assert.equal(labeled.status, 202);
      assert.equal(starts[0]!.untrusted, false);

      const challenge = await post("sl", '{"type":"url_verification","challenge":"c-123"}', { verify: "slack" });
      assert.deepEqual(challenge.json, { challenge: "c-123" });
      const stale = await post("sl", '{"type":"event_callback","event":{"type":"app_mention","text":"go"}}', { verify: "slack", now: Date.now() - 10 * 60_000 });
      assert.equal(stale.status, 401, "outside Slack's five-minute window");
      const mention = await post("sl", '{"type":"event_callback","event":{"type":"app_mention","text":"go","channel":"C1","ts":"1.5"}}', { verify: "slack" });
      assert.equal(mention.status, 202);
      assert.deepEqual(starts[1]!.args, { text: "go" });
      assert.equal(starts[1]!.context.threadTs, "1.5");
      assert.equal(starts.length, 2);
    },
  );
});

test("bad signatures are rate limited per address; a good one still passes", async () => {
  await withTriggers(
    GH,
    async ({ post }) => {
      assert.equal((await post("gh", issueEvent(1), { secret: "wrong-secret-0123456789abc" })).status, 401);
      assert.equal((await post("gh", issueEvent(1), { secret: "wrong-secret-0123456789abc" })).status, 401);
      const limited = await post("gh", issueEvent(1), { secret: "wrong-secret-0123456789abc" });
      assert.equal(limited.status, 429);
      assert.equal((await post("gh", issueEvent(1))).status, 202, "a signature that checks out is never held back");
    },
    { failures: 2 },
  );
});

test("the signature is the credential: no token, a tunnel's Host, an off-loopback bind", async () => {
  await withTriggers(
    GH,
    async ({ post, port }) => {
      assert.equal((await post("gh", issueEvent(3))).status, 202, "no token needed");
      const runs = await fetch(`http://127.0.0.1:${port}/api/runs`);
      assert.equal(runs.status, 401, "while every other /api route needs it");
      await runs.text();
      // A tunnel forwards with its own Host: the trigger answers, the dashboard does not.
      const viaTunnel = (path: string, body: string | null) =>
        new Promise<number>((resolve, reject) => {
          const headers: Record<string, string> = { host: "hooks.example.com", "content-type": "application/json" };
          if (body !== null) Object.assign(headers, signatureHeaders("github", SECRET, body, Date.now()));
          const req = request({ host: "127.0.0.1", port, path, method: body === null ? "GET" : "POST", headers }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          });
          req.on("error", reject);
          req.end(body ?? undefined);
        });
      assert.equal(await viaTunnel("/api/triggers/gh", issueEvent(4)), 202);
      assert.equal(await viaTunnel("/api/runs", null), 403, "the DNS-rebinding guard still holds elsewhere");
    },
    { token: "route-test-token-0123456789" },
  );
  await withTriggers(GH, async ({ post, base }) => {
    assert.equal((await post("gh", issueEvent(5))).status, 202, "answered off loopback too");
    const control = await fetch(`${base}/api/runs/x/control`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"action":"stop"}' });
    assert.equal(control.status, 409, "other writes stay loopback-only");
    await control.text();
  }, { host: "0.0.0.0" });
});

test("no triggers configured: the route is a 404", async () => {
  await withTriggers({}, async ({ post }) => {
    assert.equal((await post("gh", issueEvent(1))).status, 404);
  });
});

test("end to end: the launcher starts a real untrusted run carrying its context", async () => {
  const wfDir = mkdtempSync(join(tmpdir(), "odw-trigger-wf-"));
  try {
    const wf = join(wfDir, "echo.js");
    writeFileSync(wf, "export const meta = { name: 'echo', description: 'x' }\nreturn args\n");
    mkdirSync(join(wfDir, "src"));
    await withTriggers(
      { gh: { workflow: wf, secret: SECRET, verify: "github", args: { issue: "$.issue.number" }, source: join(wfDir, "src") } },
      async ({ post, store }) => {
        const res = await post("gh", issueEvent(42), { headers: { "x-github-event": "issues" } });
        assert.equal(res.status, 202);
        const runId = String(res.json.runId);
        const meta = store.readMeta(runId);
        assert.equal(meta.trust, "untrusted");
        assert.equal(meta.origin, "trigger");
        assert.equal(meta.source, join(wfDir, "src"));
        assert.deepEqual(meta.args, { issue: 42 });
        assert.deepEqual((meta.context as Record<string, unknown>).trigger, "gh");
        const status = await waitFor(store, runId, { timeoutMs: 15_000 });
        assert.equal(status.state, "done");
        assert.deepEqual(store.readResult(runId), { issue: 42 });
      },
      { realStart: true },
    );
  } finally {
    rmSync(wfDir, { recursive: true, force: true });
  }
});

test("odw serve's trigger lines: where each answers, and a secret it lacks", () => {
  const triggers = buildTriggers({
    gh: { workflow: "triage", secretEnv: "GH_SECRET_FOR_TEST", verify: "github" },
    ci: { workflow: "ci", secret: SECRET, verify: "hmac-sha256", untrusted: false },
  });
  const lines = triggerLines(triggers, "https://odw.example.com", {});
  assert.match(lines[0]!, /trigger gh → POST https:\/\/odw\.example\.com\/api\/triggers\/gh \(github-signed; runs triage, untrusted\)/);
  assert.match(lines[1]!, /\$GH_SECRET_FOR_TEST is unset/);
  assert.match(lines[2]!, /trigger ci .*TRUSTED/);
  assert.equal(lines.length, 3);
  assert.equal(triggerLines(triggers, "http://x", { GH_SECRET_FOR_TEST: SECRET }).length, 2);
});
