import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import { RunStore } from "../src/runtime/run-store.js";
import { AUTH_GLOBAL_FAILURES, failureKey, generateToken, isValidToken, TokenGate } from "../src/runtime/serve-auth.js";
import { startServer, type ServeHandle } from "../src/runtime/server.js";

// Remote read-only access (ODW extension; src/runtime/serve-auth.ts): with
// `odw serve --token`, every /api request and the SSE stream need the token —
// header, ?token= (which sets a cookie) or that cookie — wrong ones are rate
// limited per address, and writes stay refused off loopback whatever the token.

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const TOKEN = "test-token-0123456789abcdef";

async function withServer(
  opts: { host?: string; token?: string | null; authLimit?: { failures: number; windowMs: number } },
  body: (base: string, store: RunStore, handle: ServeHandle) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "odw-serve-auth-"));
  const store = new RunStore(join(root, "runs"));
  const handle = await startServer({
    store,
    port: 0,
    host: opts.host ?? "0.0.0.0",
    claudeProjectsRoot: join(root, "no-claude"),
    token: opts.token === undefined ? TOKEN : opts.token,
    authLimit: opts.authLimit,
  });
  try {
    await body(`http://127.0.0.1:${handle.port}`, store, handle);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
}

/** A finished run to read and (try to) control. */
function aRun(store: RunStore): string {
  const runId = store.create({ script: "", inlineSource: "return 1", args: null, source: "/tmp" });
  store.updateStatus(runId, { state: "done" });
  return runId;
}

const bearer = { authorization: `Bearer ${TOKEN}` };

test("--token: every /api read needs it; the HTML shell does not", async () => {
  await withServer({}, async (base) => {
    const shell = await fetch(`${base}/`);
    assert.equal(shell.status, 200, "the shell loads (and shows a token screen)");
    assert.match(shell.headers.get("content-type") ?? "", /text\/html/);
    await shell.text();
    for (const path of ["/api/runs", "/api/capabilities", "/api/settings", "/api/activity", "/api/workflows", "/api/schedules", "/api/chat/sessions", "/api/nope"]) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 401, path);
      assert.deepEqual(await res.json(), { error: "this dashboard needs a token (odw serve --token)", auth: "token" });
    }
  });
});

test("--token: a Bearer header passes; a wrong one is refused", async () => {
  await withServer({}, async (base, store) => {
    const runId = aRun(store);
    const ok = await fetch(`${base}/api/runs`, { headers: bearer });
    assert.equal(ok.status, 200);
    assert.deepEqual(((await ok.json()) as Array<{ runId: string }>).map((r) => r.runId), [runId]);
    assert.equal(ok.headers.get("set-cookie"), null, "a header sets no cookie");
    const caps = (await (await fetch(`${base}/api/capabilities`, { headers: bearer })).json()) as Record<string, unknown>;
    assert.deepEqual(caps, { writable: false, auth: "token", bundle: null });
    for (const authorization of [`Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(0, -1)}`, "Bearer short", `Basic ${TOKEN}`]) {
      const res = await fetch(`${base}/api/runs`, { headers: { authorization } });
      assert.equal(res.status, 401, authorization);
    }
  });
});

test("--token: ?token= sets an HttpOnly SameSite=Strict cookie, which then suffices — for the SSE stream too", async () => {
  await withServer({}, async (base, store, handle) => {
    aRun(store);
    const first = await fetch(`${base}/api/capabilities?token=${TOKEN}`);
    assert.equal(first.status, 200);
    const setCookie = first.headers.get("set-cookie") ?? "";
    assert.match(setCookie, new RegExp(`^odw_token_${handle.port}=${TOKEN}; `));
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Path=\//);
    const cookie = setCookie.split(";")[0]!;
    assert.equal((await fetch(`${base}/api/runs`, { headers: { cookie } })).status, 200);
    // Another server's cookie (another port) is not this one's.
    assert.equal((await fetch(`${base}/api/runs`, { headers: { cookie: `odw_token_1=${TOKEN}` } })).status, 401);
    // The shell takes a ?token= too.
    const shell = await fetch(`${base}/?token=${TOKEN}`);
    assert.match(shell.headers.get("set-cookie") ?? "", /HttpOnly/);
    await shell.text();

    // The stream: refused without, open with the cookie (and the header).
    const refused = await fetch(`${base}/api/stream`);
    assert.equal(refused.status, 401);
    await refused.text();
    for (const headers of [{ cookie }, bearer]) {
      const abort = new AbortController();
      const res = await fetch(`${base}/api/stream?delta=1`, { headers, signal: abort.signal });
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
      const reader = res.body!.getReader();
      let text = "";
      while (!text.includes("event: runs")) text += new TextDecoder().decode((await reader.read()).value);
      abort.abort();
    }
  });
});

test("--token: wrong tokens are rate limited per address — 429 with retry-after, even for the right one, until the window passes", async () => {
  let now = 0;
  const gate = new TokenGate(TOKEN, "odw_token_test", { failures: 3, windowMs: 60_000, now: () => now });
  const req = (authorization?: string, address = "10.0.0.1") =>
    ({ headers: authorization ? { authorization } : {}, socket: { remoteAddress: address } }) as unknown as IncomingMessage;
  const url = new URL("http://x/api/runs");
  for (let i = 0; i < 3; i++) assert.deepEqual(gate.check(req("Bearer wrong-token-xxxxxxxx"), url), { ok: false, status: 401, error: "wrong token" });
  const locked = gate.check(req(`Bearer ${TOKEN}`), url);
  assert.equal(locked.ok, false);
  assert.equal(!locked.ok && locked.status, 429);
  assert.equal(!locked.ok && locked.retryAfter, 60);
  // Another address is not locked; a missing token never counts.
  assert.equal(gate.check(req(`Bearer ${TOKEN}`, "10.0.0.2"), url).ok, true);
  for (let i = 0; i < 10; i++) assert.equal((gate.check(req(undefined, "10.0.0.3"), url) as { status: number }).status, 401);
  assert.equal(gate.check(req(`Bearer ${TOKEN}`, "10.0.0.3"), url).ok, true);
  now = 30_000;
  assert.equal((gate.check(req(`Bearer ${TOKEN}`), url) as { retryAfter: number }).retryAfter, 30);
  now = 60_000;
  assert.equal(gate.check(req(`Bearer ${TOKEN}`), url).ok, true, "the window passed");

  // Over HTTP.
  await withServer({ authLimit: { failures: 2, windowMs: 60_000 } }, async (base) => {
    const wrong = { authorization: "Bearer not-the-token-at-all" };
    assert.equal((await fetch(`${base}/api/runs`, { headers: wrong })).status, 401);
    assert.equal((await fetch(`${base}/api/runs?token=also-not-the-token`)).status, 401);
    const res = await fetch(`${base}/api/runs`, { headers: bearer });
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get("retry-after")) > 0);
    assert.match(((await res.json()) as { error: string }).error, /too many wrong tokens/);
  });
});

test("--token: writes stay refused off loopback, whatever the token; on a loopback bind it gates them as reads", async () => {
  await withServer({}, async (base, store) => {
    const runId = aRun(store);
    const post = (path: string, headers: Record<string, string>) =>
      fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ action: "stop" }) });
    assert.equal((await post(`/api/runs/${runId}/control`, {})).status, 401, "no token: 401 before anything");
    for (const path of [`/api/runs/${runId}/control`, `/api/runs/${runId}/checkpoint`, "/api/chat/sessions"]) {
      const res = await post(path, bearer);
      assert.equal(res.status, 409, path);
      assert.match(((await res.json()) as { error: string }).error, /loopback-only/);
    }
    assert.equal(store.readControl(runId), null, "nothing was written");
  });
  await withServer({ host: "127.0.0.1" }, async (base, store) => {
    const runId = aRun(store);
    const post = (headers: Record<string, string>) =>
      fetch(`${base}/api/runs/${runId}/control`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ action: "stop" }) });
    assert.equal((await post({})).status, 401);
    assert.equal((await post(bearer)).status, 200);
    assert.equal(store.readControl(runId), "stop");
    const caps = (await (await fetch(`${base}/api/capabilities`, { headers: bearer })).json()) as Record<string, unknown>;
    assert.equal(caps.writable, true);
  });
});

test("without --token nothing changes: reads open, capabilities say auth none", async () => {
  await withServer({ token: null }, async (base) => {
    assert.equal((await fetch(`${base}/api/runs`)).status, 200);
    assert.deepEqual(await (await fetch(`${base}/api/capabilities`)).json(), { writable: false, auth: "none", bundle: null });
  });
});

test("tokens: what --token VALUE accepts, and a generated one", () => {
  assert.ok(isValidToken(TOKEN));
  for (const bad of ["short", "has space in it 12345", "semi;colon-0123456789", "a".repeat(257), "ünïcödé-0123456789"]) assert.ok(!isValidToken(bad), bad);
  const a = generateToken();
  assert.ok(isValidToken(a));
  assert.notEqual(a, generateToken());
  assert.throws(() => new TokenGate("short", "c"));
});

/** `odw serve …` as a child process, until it says it listens. */
async function serveCli(args: string[]): Promise<{ out: string; err: string; stop: () => Promise<void> }> {
  const runsRoot = mkdtempSync(join(tmpdir(), "odw-serve-auth-cli-"));
  const child = spawn(execPath, [...process.execArgv, cli, "serve", "--port", "0", "--runs-root", runsRoot, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stderr!.on("data", (c) => (err += c));
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`serve did not start: ${out} ${err}`)), 20_000);
    child.stdout!.on("data", (c) => {
      out += c;
      if (out.includes("press Ctrl-C")) {
        clearTimeout(timer);
        resolve();
      }
    });
    void exited.then(() => reject(new Error(`serve exited: ${out} ${err}`)));
  });
  return {
    get out() {
      return out;
    },
    get err() {
      return err;
    },
    stop: async () => {
      child.kill("SIGTERM");
      await exited;
      rmSync(runsRoot, { recursive: true, force: true });
    },
  };
}

test("odw serve --token with no VALUE prints a generated token once, in the URL, and nowhere else", { skip: process.platform === "win32" }, async () => {
  const served = await serveCli(["--host", "127.0.0.1", "--token"]);
  try {
    const m = /odw dashboard → (http:\/\/127\.0\.0\.1:(\d+))\/#token=([A-Za-z0-9_-]+)\n/.exec(served.out);
    assert.ok(m, served.out);
    const [, base, , token] = m!;
    assert.equal(served.out.split(token!).length - 1, 1, "printed once");
    assert.ok(!served.err.includes(token!), "not on stderr");
    assert.equal((await fetch(`${base}/api/runs`)).status, 401);
    assert.equal((await fetch(`${base}/api/runs`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
  } finally {
    await served.stop();
  }
});

test("odw serve --token VALUE never prints it; a bad VALUE is a usage error; off loopback without a token warns loudly", { skip: process.platform === "win32" }, async () => {
  const given = await serveCli(["--host", "127.0.0.1", `--token=${TOKEN}`]);
  try {
    assert.ok(!given.out.includes(TOKEN) && !given.err.includes(TOKEN));
    assert.match(given.out, /reads need the token given with --token/);
  } finally {
    await given.stop();
  }
  const open = await serveCli(["--host", "0.0.0.0"]);
  try {
    // stderr is its own pipe: it may land after stdout's last line.
    const deadline = Date.now() + 5000;
    while (!open.err.includes("--token\n") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.match(open.err, /WARNING: bound to 0\.0\.0\.0 with no --token/);
    assert.match(open.err, /odw serve --host 0\.0\.0\.0 --token/);
  } finally {
    await open.stop();
  }
  const guarded = await serveCli(["--host", "0.0.0.0", "--token", TOKEN]);
  try {
    assert.ok(!guarded.err.includes("WARNING"));
  } finally {
    await guarded.stop();
  }
  const bad = spawn(execPath, [...process.execArgv, cli, "serve", "--port", "0", "--token", "short"], { stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  bad.stderr!.on("data", (c) => (err += c));
  const code = await new Promise<number | null>((resolve) => bad.once("exit", resolve));
  assert.equal(code, 2);
  assert.match(err, /--token VALUE must be 16-256 characters/);
});

test("wrong tokens count against an IPv6 address's /64, and the whole server takes a bounded number per window", () => {
  assert.equal(failureKey("203.0.113.9"), "203.0.113.9");
  assert.equal(failureKey("::ffff:203.0.113.9"), "203.0.113.9", "IPv4-mapped is the IPv4 address");
  assert.equal(failureKey("2001:db8:1:2:aaaa::1"), "2001:db8:1:2::/64");
  assert.equal(failureKey("2001:db8:1:2:ffff:ffff:ffff:fffe"), "2001:db8:1:2::/64", "one /64, one count");
  assert.equal(failureKey("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(failureKey("fe80::1%eth0"), "fe80:0:0:0::/64");

  let now = 1_000_000;
  const gate = new TokenGate(TOKEN, "odw_token_test", { failures: 1_000_000, windowMs: 60_000, now: () => now });
  const req = (address: string, authorization?: string) =>
    ({ headers: authorization ? { authorization } : {}, socket: { remoteAddress: address } }) as unknown as IncomingMessage;
  const url = new URL("http://h/api/runs");
  // Each guess from a fresh address: the per-address limit never trips, the server's does.
  for (let i = 0; i < AUTH_GLOBAL_FAILURES; i++) assert.equal(gate.check(req(`198.51.${i >> 8}.${i & 255}`, "Bearer wrong-token-0000000"), url).ok, false);
  const locked = gate.check(req("192.0.2.1", `Bearer ${TOKEN}`), url);
  assert.equal(locked.ok, false, "past the budget not even the right token is checked");
  assert.equal(!locked.ok && locked.status, 429);
  now += 60_000;
  assert.equal(gate.check(req("192.0.2.1", `Bearer ${TOKEN}`), url).ok, true, "a new window checks again");
});
