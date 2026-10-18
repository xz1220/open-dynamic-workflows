import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/adapters/config.js";
import {
  APPROVE_SECRET_FILE,
  APPROVE_SERVE_FILE,
  announceServe,
  claimLink,
  ensureApproveSecret,
  linkUsed,
  liveServe,
  mintCheckpointLinks,
  mintLinkToken,
  newNonce,
  ntfyActions,
  parsePublicUrl,
  readApproveSecret,
  verifyLinkToken,
  withdrawServe,
  type LinkClaims,
} from "../src/runtime/approve-links.js";
import { linksEnv, withLinks } from "../src/runtime/notify.js";
import { RunStore } from "../src/runtime/run-store.js";
import { startServer, type ServeHandle } from "../src/runtime/server.js";
import { cli, pendingIds, project, until, type Project } from "./checkpoint-project.js";

// Approve links (ODW extension; src/runtime/approve-links.ts, approve-route.ts):
// signed one-time approve/reject URLs for a waiting checkpoint(), minted into
// the "waiting" notify hooks while `odw serve --public-url` runs — and the one
// remote write they open, with `--token-scope approve` the only other one.

const PUBLIC = "https://odw.example.test";
const TOKEN = "test-token-0123456789abcdef";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "odw-approve-"));
}

function claims(over: Partial<LinkClaims> = {}): LinkClaims {
  return { runId: "20261018-120000-abc123", checkpointId: 1, action: "approve", exp: 2_000_000_000, nonce: newNonce(), ...over };
}

// --- minting and verification ----------------------------------------------------------

test("a minted token verifies; a tampered, re-signed, expired or malformed one does not", () => {
  const root = tmpRoot();
  try {
    const secret = ensureApproveSecret(root);
    const c = claims();
    const token = mintLinkToken(secret, c);
    assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(verifyLinkToken(secret, token, 1_000), { ok: true, claims: c });

    // Wrong action, another run, a later expiry: each a new body under the old MAC.
    const [, mac] = token.split(".");
    const body = (fields: unknown[]) => Buffer.from(JSON.stringify(fields)).toString("base64url");
    for (const fields of [
      [1, c.runId, 1, "reject", c.exp, c.nonce],
      [1, "another-run", 1, "approve", c.exp, c.nonce],
      [1, c.runId, 2, "approve", c.exp, c.nonce],
      [1, c.runId, 1, "approve", c.exp + 86_400, c.nonce],
    ]) {
      assert.deepEqual(verifyLinkToken(secret, `${body(fields)}.${mac}`, 1_000), { ok: false, reason: "tampered" });
    }
    // One flipped MAC character; another secret; a token cut short.
    const flipped = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    assert.deepEqual(verifyLinkToken(secret, flipped, 1_000), { ok: false, reason: "tampered" });
    assert.deepEqual(verifyLinkToken(Buffer.alloc(32, 7), token, 1_000), { ok: false, reason: "tampered" });
    assert.deepEqual(verifyLinkToken(secret, token.slice(0, -5), 1_000), { ok: false, reason: "tampered" });
    for (const junk of ["", "abc", "a.b.c", "../../etc/passwd", "a b.c", "x".repeat(5000)]) {
      assert.deepEqual(verifyLinkToken(secret, junk, 1_000), { ok: false, reason: "malformed" }, junk.slice(0, 20));
    }
    // Expired: at exp itself and after — and only once the MAC holds.
    assert.deepEqual(verifyLinkToken(secret, token, c.exp), { ok: false, reason: "expired" });
    assert.deepEqual(verifyLinkToken(secret, token, c.exp + 1), { ok: false, reason: "expired" });
    // A signed body this code does not mint (dot-only run id, bad nonce) is malformed, never acted on.
    assert.deepEqual(verifyLinkToken(secret, mintLinkToken(secret, claims({ runId: ".." })), 1_000), { ok: false, reason: "malformed" });
    assert.deepEqual(verifyLinkToken(secret, mintLinkToken(secret, claims({ nonce: "../x" })), 1_000), { ok: false, reason: "malformed" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the secret: created 0600 in the runs root, kept, rotated on demand, replaced when others can read it", { skip: process.platform === "win32" }, () => {
  const root = tmpRoot();
  try {
    assert.equal(readApproveSecret(root), null, "none until a server makes one");
    const first = ensureApproveSecret(root);
    const path = join(root, APPROVE_SECRET_FILE);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.match(readFileSync(path, "utf8"), /^[0-9a-f]{64}\n$/);
    assert.deepEqual(ensureApproveSecret(root), first, "kept across restarts");
    assert.deepEqual(readApproveSecret(root), first);

    const token = mintLinkToken(first, claims());
    const rotated = ensureApproveSecret(root, { rotate: true });
    assert.notDeepEqual(rotated, first);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(verifyLinkToken(rotated, token, 1_000), { ok: false, reason: "tampered" }, "rotation kills old links");

    chmodSync(path, 0o644);
    assert.equal(readApproveSecret(root), null, "a secret others can read is not used");
    const replaced = ensureApproveSecret(root);
    assert.notDeepEqual(replaced, rotated);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("single use: the first claim of a nonce wins, every later one is refused", () => {
  const root = tmpRoot();
  try {
    const c = claims();
    assert.equal(linkUsed(root, c.nonce), false);
    assert.equal(claimLink(root, c), true);
    assert.equal(linkUsed(root, c.nonce), true);
    assert.equal(claimLink(root, c), false);
    assert.equal(claimLink(root, { ...c, action: "reject" }), false, "a checkpoint's two links share the nonce");
    assert.equal(claimLink(root, claims()), true, "another nonce is another link");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("minting needs a live odw serve --public-url for the runs root; otherwise it says why", () => {
  const root = tmpRoot();
  try {
    const none = mintCheckpointLinks(root, "r1", 1, 3600);
    assert.equal(none.ok, false);
    assert.match(!none.ok ? none.reason : "", /no `odw serve --public-url <url>` is running/);

    announceServe(root, PUBLIC);
    const noSecret = mintCheckpointLinks(root, "r1", 1, 3600);
    assert.match(!noSecret.ok ? noSecret.reason : "", /no usable approve secret/);

    const secret = ensureApproveSecret(root);
    const now = 1_800_000_000_000;
    const minted = mintCheckpointLinks(root, "r1", 2, 3600, now);
    assert.ok(minted.ok);
    const { approveUrl, rejectUrl, expiresAt } = minted.links;
    assert.equal(expiresAt, 1_800_000_000 + 3600);
    assert.ok(approveUrl.startsWith(`${PUBLIC}/approve/`) && rejectUrl.startsWith(`${PUBLIC}/approve/`));
    const approve = verifyLinkToken(secret, approveUrl.slice(`${PUBLIC}/approve/`.length), 1_800_000_000);
    const reject = verifyLinkToken(secret, rejectUrl.slice(`${PUBLIC}/approve/`.length), 1_800_000_000);
    assert.ok(approve.ok && reject.ok);
    assert.deepEqual([approve.claims.action, reject.claims.action], ["approve", "reject"]);
    assert.equal(approve.claims.nonce, reject.claims.nonce, "one nonce per checkpoint");
    assert.equal(approve.claims.checkpointId, 2);

    // A server whose process is gone answers nothing: no links.
    writeFileSync(join(root, APPROVE_SERVE_FILE), JSON.stringify({ publicUrl: PUBLIC, pid: 2 ** 22 + 12345, startedAt: 0 }));
    assert.equal(liveServe(root), null);
    assert.equal(mintCheckpointLinks(root, "r1", 1, 3600).ok, false);
    // Withdrawing takes back only one's own announcement.
    announceServe(root, PUBLIC, process.pid);
    withdrawServe(root, process.pid + 1);
    assert.ok(existsSync(join(root, APPROVE_SERVE_FILE)));
    withdrawServe(root, process.pid);
    assert.ok(!existsSync(join(root, APPROVE_SERVE_FILE)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--public-url: an http(s) base that can stand in an ntfy header as it is", () => {
  assert.equal(parsePublicUrl("https://odw.example.test/"), "https://odw.example.test");
  // A root only: links are answered at /approve/, so a base path would mint links nothing answers.
  assert.equal(parsePublicUrl("https://odw.example.test/base/"), null);
  assert.equal(parsePublicUrl("https://odw.example.test/base"), null);
  assert.equal(parsePublicUrl("https://odw.example.test:8443//"), "https://odw.example.test:8443");
  assert.equal(parsePublicUrl("http://127.0.0.1:4317"), "http://127.0.0.1:4317");
  for (const bad of ["ftp://x.test", "not a url", "https://u:p@x.test", "https://x.test/?q=1", "https://x.test/#f", "https://x.test/a,b", "https://x.test/a;b", "https://x.test/a'b"]) {
    assert.equal(parsePublicUrl(bad), null, bad);
  }
});

test("ntfy: two http action buttons in the Actions header's simple format", () => {
  const links = { approveUrl: `${PUBLIC}/approve/AAA.bbb`, rejectUrl: `${PUBLIC}/approve/CCC.ddd`, expiresAt: 1 };
  assert.equal(
    ntfyActions(links),
    `http, Approve, ${PUBLIC}/approve/AAA.bbb, method=POST, headers.X-ODW-Action=approve, clear=true; ` +
      `http, Reject, ${PUBLIC}/approve/CCC.ddd, method=POST, headers.X-ODW-Action=reject, clear=true`,
  );
  assert.deepEqual(linksEnv({ ok: true, links }), {
    ODW_APPROVE_URL: links.approveUrl,
    ODW_REJECT_URL: links.rejectUrl,
    ODW_LINKS_EXPIRE_AT: "1",
    ODW_NTFY_ACTIONS: ntfyActions(links),
  });
  assert.deepEqual(linksEnv({ ok: false, reason: "why" }), { ODW_LINKS_UNAVAILABLE: "why" });
  assert.deepEqual(linksEnv(null), {});
  const payload = withLinks({ text: "odw · x waits", content: "odw · x waits" }, { ok: true, links });
  assert.equal(payload.text, `odw · x waits · approve: ${links.approveUrl} · reject: ${links.rejectUrl}`);
  assert.equal(payload.content, payload.text);
  assert.deepEqual([payload.approveUrl, payload.rejectUrl, payload.linksExpireAt], [links.approveUrl, links.rejectUrl, 1]);
});

test("config: approveLinks.ttl defaults to 24h and takes 60s to 30 days", () => {
  const root = tmpRoot();
  try {
    const at = (body: unknown) => {
      const path = join(root, "c.json");
      writeFileSync(path, JSON.stringify(body));
      return loadConfig(path).settings.approveLinks;
    };
    assert.deepEqual(at({}), { ttl: 86_400 });
    assert.deepEqual(at({ approveLinks: { ttl: 900 } }), { ttl: 900 });
    for (const ttl of [59, 2_592_001, 1.5, "soon"]) assert.throws(() => at({ approveLinks: { ttl } }), /approveLinks\.ttl/);
    assert.throws(() => at({ approveLinks: 5 }), /"approveLinks" must be/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- through the worker and the server ----------------------------------------------------

/** A local webhook endpoint that records every JSON POST. */
async function receiver() {
  const posts: Array<Record<string, any>> = [];
  const server = createServer((req, res) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (data += c));
    req.on("end", () => {
      posts.push(JSON.parse(data));
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook/PLACEHOLDER`,
    posts,
    close: () => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))),
  };
}

/** A link as the phone would follow it — to this test's server instead of the public host. */
const local = (handle: ServeHandle, link: string) => link.replace(PUBLIC, `http://127.0.0.1:${handle.port}`);

/** The CSRF cookie and form value a confirmation page hands out. */
async function openPage(url: string): Promise<{ status: number; html: string; cookie: string; csrf: string; res: Response }> {
  const res = await fetch(url);
  const html = await res.text();
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
  return { status: res.status, html, cookie, csrf, res };
}

function postForm(url: string, fields: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

async function withLinksServer(
  p: Project,
  body: (handle: ServeHandle) => Promise<void>,
  options: { host?: string; approveLimit?: { failures: number; windowMs: number } } = {},
): Promise<void> {
  const handle = await startServer({
    store: p.store,
    port: 0,
    host: options.host ?? "0.0.0.0",
    claudeProjectsRoot: join(p.root, "no-claude"),
    token: TOKEN,
    publicUrl: PUBLIC,
    approveLimit: options.approveLimit,
  });
  try {
    await body(handle);
  } finally {
    await handle.close();
  }
}

test("end to end: the waiting hook carries the links; GET confirms, POST with CSRF decides once (by: link)", async () => {
  const hook = await receiver();
  const p = project({ notify: { webhook: hook.url, on: ["waiting"] }, approveLinks: { ttl: 600 } });
  try {
    await withLinksServer(p, async (handle) => {
      const { id, run } = p.start("return await checkpoint('Ship the release?', { payload: { version: '1.2.3', steps: ['tag', 'publish'] } })\n");
      await until(() => hook.posts.length === 1);
      const sent = hook.posts[0]!;
      assert.equal(sent.state, "waiting");
      assert.equal(sent.linksUnavailable, undefined);
      assert.ok(sent.approveUrl.startsWith(`${PUBLIC}/approve/`) && sent.rejectUrl.startsWith(`${PUBLIC}/approve/`));
      assert.ok(sent.linksExpireAt > Date.now() / 1000 && sent.linksExpireAt <= Date.now() / 1000 + 601);
      assert.equal(sent.linksUnavailable, undefined);
      assert.ok(sent.text.endsWith(`· approve: ${sent.approveUrl} · reject: ${sent.rejectUrl}`));
      const approveUrl = local(handle, sent.approveUrl);
      const rejectUrl = local(handle, sent.rejectUrl);

      // The page: title, payload, one button, a CSRF cookie; hardened headers; no token needed.
      const page = await openPage(approveUrl);
      assert.equal(page.status, 200);
      assert.match(page.html, /<h1>Ship the release\?<\/h1>/);
      assert.match(page.html, /&quot;version&quot;: &quot;1\.2\.3&quot;/);
      assert.match(page.html, /<button class="approve" type="submit">Approve<\/button>/);
      assert.doesNotMatch(page.html, />Reject</);
      assert.match(page.res.headers.get("set-cookie")!, /^odw_approve_csrf=[A-Za-z0-9_-]+; Path=\/approve\/[^;]+; Max-Age=3600; HttpOnly; SameSite=Strict; Secure$/);
      assert.equal(page.res.headers.get("x-frame-options"), "DENY");
      assert.equal(page.res.headers.get("referrer-policy"), "no-referrer");
      assert.equal(page.res.headers.get("cache-control"), "no-store");
      assert.match(page.res.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
      assert.deepEqual(pendingIds(p.store, id), [1], "opening the page decides nothing");

      // Refused: no CSRF, a CSRF without its cookie, the wrong cookie, the wrong action, another site's page.
      assert.equal((await postForm(approveUrl, { action: "approve" })).status, 403);
      assert.equal((await postForm(approveUrl, { action: "approve", csrf: page.csrf })).status, 403);
      assert.equal((await postForm(approveUrl, { action: "approve", csrf: page.csrf }, { cookie: "odw_approve_csrf=forged" })).status, 403);
      assert.equal((await postForm(approveUrl, { action: "reject", csrf: page.csrf }, { cookie: page.cookie })).status, 400);
      const crossSite = await postForm(approveUrl, { action: "approve", csrf: page.csrf }, { cookie: page.cookie, origin: "https://evil.example" });
      assert.equal(crossSite.status, 403);
      const stale = await fetch(approveUrl, { method: "POST", headers: { "content-type": "application/json", cookie: page.cookie }, body: "{}" });
      assert.equal(stale.status, 400, "only the form, or the action header, decides");
      assert.deepEqual(pendingIds(p.store, id), [1], "nothing refused was written");

      // Decided, once.
      const ok = await postForm(approveUrl, { action: "approve", csrf: page.csrf }, { cookie: page.cookie, origin: PUBLIC });
      assert.equal(ok.status, 200);
      assert.match(await ok.text(), /<h1>Approved<\/h1>/);
      assert.equal(await run, "done");
      assert.deepEqual(p.store.readResult(id), { approved: true, note: null, by: "link", payload: { version: "1.2.3", steps: ["tag", "publish"] }, edited: false });
      assert.deepEqual(
        p.store.readCheckpointRequests(id).map(({ action, checkpointId, by }) => ({ action, checkpointId, by })),
        [{ action: "approve", checkpointId: 1, by: "link" }],
      );

      // A replay — of either link — is 410, a clear page, never a stack trace.
      const replay = await postForm(approveUrl, { action: "approve", csrf: page.csrf }, { cookie: page.cookie });
      assert.equal(replay.status, 410);
      assert.match(await replay.text(), /already used/);
      const other = await fetch(rejectUrl);
      assert.equal(other.status, 410);
      assert.doesNotMatch(await other.text(), /at .*\.ts:\d+/);
    });
  } finally {
    await p.cleanup();
    await hook.close();
  }
});

test("an ntfy button decides with its X-ODW-Action header; tampered and expired links get clear pages", async () => {
  const p = project();
  try {
    await withLinksServer(p, async (handle) => {
      const { id, run } = p.start("const a = await checkpoint('First?')\nconst b = await checkpoint('Second?')\nreturn [a.approved, a.by, b.approved, b.by]\n");
      await until(() => pendingIds(p.store, id).length === 1);
      const secret = readApproveSecret(p.runsRoot)!;
      const minted = mintCheckpointLinks(p.runsRoot, id, 1, 600);
      assert.ok(minted.ok);
      const rejectUrl = local(handle, minted.links.rejectUrl);

      // The header must name the link's own action.
      const wrong = await fetch(rejectUrl, { method: "POST", headers: { "x-odw-action": "approve" } });
      assert.equal(wrong.status, 400);
      const ntfy = await fetch(rejectUrl, { method: "POST", headers: { "x-odw-action": "reject" } });
      assert.equal(ntfy.status, 200);
      await until(() => pendingIds(p.store, id).join() === "2");

      // Expired: a 410 page. Tampered (its action changed): 403. Unknown path shapes: 403.
      const base = `http://127.0.0.1:${handle.port}`;
      const now = Math.floor(Date.now() / 1000);
      const expired = mintLinkToken(secret, { runId: id, checkpointId: 2, action: "approve", exp: now - 1, nonce: newNonce() });
      const res = await fetch(`${base}/approve/${expired}`);
      assert.equal(res.status, 410);
      assert.match(await res.text(), /expired/);
      const good = mintLinkToken(secret, { runId: id, checkpointId: 2, action: "reject", exp: now + 600, nonce: newNonce() });
      const [body, mac] = good.split(".");
      const asApprove = Buffer.from(Buffer.from(body!, "base64url").toString().replace('"reject"', '"approve"')).toString("base64url");
      const tampered = await fetch(`${base}/approve/${asApprove}.${mac}`);
      assert.equal(tampered.status, 403);
      assert.match(tampered.headers.get("content-type")!, /^text\/html/);
      assert.match(await tampered.text(), /not valid/);
      assert.equal((await fetch(`${base}/approve/${good}/extra`)).status, 403);
      assert.equal((await fetch(`${base}/approve/${good}`, { method: "DELETE" })).status, 405);

      // The good one still works: approve the second through its page.
      const approve2 = mintLinkToken(secret, { runId: id, checkpointId: 2, action: "approve", exp: now + 600, nonce: newNonce() });
      const page = await openPage(`${base}/approve/${approve2}`);
      assert.equal(page.status, 200);
      assert.equal((await postForm(`${base}/approve/${approve2}`, { action: "approve", csrf: page.csrf }, { cookie: page.cookie })).status, 200);
      assert.equal(await run, "done");
      assert.deepEqual(p.store.readResult(id), [false, "link", true, "link"]);
      // A link for a checkpoint no longer waiting: 410.
      assert.equal((await fetch(`${base}/approve/${good}`)).status, 410);
    });
  } finally {
    await p.cleanup();
  }
});

test("bad links are rate limited per address like wrong tokens: 429 page with retry-after — a good link from there still works", async () => {
  const p = project();
  try {
    await withLinksServer(
      p,
      async (handle) => {
        const { id } = p.start("return await checkpoint('Go?')\n");
        await until(() => pendingIds(p.store, id).length === 1);
        const minted = mintCheckpointLinks(p.runsRoot, id, 1, 600);
        assert.ok(minted.ok);
        const base = `http://127.0.0.1:${handle.port}`;
        assert.equal((await fetch(`${base}/approve/not-a-link`)).status, 403);
        assert.equal((await fetch(`${base}/approve/still.not-a-link`)).status, 403);
        const locked = await fetch(`${base}/approve/a-third.bad-link`);
        assert.equal(locked.status, 429);
        assert.ok(Number(locked.headers.get("retry-after")) > 0);
        assert.match(await locked.text(), /too many bad approve links/);
        // The signature is checked first: bad links sent from the same address (a
        // tunnel's) cannot block the real ones. A good link opens, and decides.
        const url = local(handle, minted.links.approveUrl);
        const page = await openPage(url);
        assert.equal(page.status, 200);
        const decided = await postForm(url, { csrf: page.csrf, action: "approve" }, { cookie: page.cookie });
        assert.equal(decided.status, 200);
        assert.match(await decided.text(), /Approved/);
        assert.equal((await fetch(`${base}/approve/still.bad`)).status, 429, "bad ones still wait");
      },
      { approveLimit: { failures: 2, windowMs: 60_000 } },
    );
  } finally {
    await p.cleanup();
  }
});

test("off loopback, approve links open no other write; on a loopback bind the public host reaches /approve/ only", async () => {
  const p = project();
  try {
    await withLinksServer(p, async (handle) => {
      const { id } = p.start("return await checkpoint('Go?')\n");
      await until(() => pendingIds(p.store, id).length === 1);
      const base = `http://127.0.0.1:${handle.port}`;
      const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
      for (const [path, body] of [
        [`/api/runs/${id}/control`, { action: "stop" }],
        [`/api/runs/${id}/checkpoint`, { action: "approve" }],
        ["/api/chat/sessions", {}],
      ] as const) {
        const res = await fetch(`${base}${path}`, { method: "POST", headers: auth, body: JSON.stringify(body) });
        assert.equal(res.status, 409, path);
      }
      const caps = await (await fetch(`${base}/api/capabilities`, { headers: auth })).json();
      assert.deepEqual(caps, { writable: false, auth: "token", bundle: null, decide: false });
      assert.deepEqual(pendingIds(p.store, id), [1]);
      assert.equal(p.store.readControl(id), null);
    });
    await withLinksServer(
      p,
      async (handle) => {
        const base = `http://127.0.0.1:${handle.port}`;
        const publicHost = { host: new URL(PUBLIC).host };
        const viaPublic = await rawGet(handle.port, "/approve/x.y", publicHost);
        assert.equal(viaPublic.status, 403);
        assert.match(viaPublic.body, /This link is not valid/, "reaches the route: a bad link");
        const elsewhere = await rawGet(handle.port, "/api/runs", publicHost);
        assert.equal(elsewhere.status, 403);
        assert.match(elsewhere.body, /DNS rebinding/, "the guard holds for every other route");
        assert.match((await rawGet(handle.port, "/approve/x.y", { host: "evil.example" })).body, /DNS rebinding/);
        assert.match(await (await fetch(`${base}/approve/x.y`)).text(), /This link is not valid/);
      },
      { host: "127.0.0.1" },
    );
    // Without --public-url the route answers nothing.
    const plain = await startServer({ store: p.store, port: 0, host: "0.0.0.0", claudeProjectsRoot: join(p.root, "no-claude") });
    try {
      const res = await fetch(`http://127.0.0.1:${plain.port}/approve/x.y`);
      assert.equal(res.status, 404);
      assert.match(await res.text(), /Approve links are off/);
    } finally {
      await plain.close();
    }
  } finally {
    await p.cleanup();
  }
});

/** A GET with a Host header of our choosing (fetch will not send one). */
function rawGet(port: number, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    import("node:http").then(({ request }) => {
      const req = request({ host: "127.0.0.1", port, path, headers }, (res: IncomingMessage) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      req.end();
    }, reject);
  });
}

test("a waiting hook with no odw serve --public-url says why there are no links", async () => {
  const hook = await receiver();
  const p = project({ notify: { webhook: hook.url, on: ["waiting"] } });
  try {
    const { id } = p.start("return await checkpoint('Go?')\n");
    await until(() => hook.posts.length === 1);
    assert.equal(hook.posts[0]!.approveUrl, undefined);
    assert.match(hook.posts[0]!.linksUnavailable, /no `odw serve --public-url <url>` is running/);
    assert.equal(hook.posts[0]!.text, `odw · gate waits for a decision: Go? · odw approve|reject ${id} --checkpoint 1`);
  } finally {
    await p.cleanup();
    await hook.close();
  }
});

// --- --token-scope approve ------------------------------------------------------------------

test("--token-scope approve: a token holder answers checkpoints off loopback — and nothing else", async () => {
  const p = project();
  const handle = await startServer({
    store: p.store,
    port: 0,
    host: "0.0.0.0",
    claudeProjectsRoot: join(p.root, "no-claude"),
    token: TOKEN,
    tokenScope: "approve",
  });
  try {
    const { id, run } = p.start("return await checkpoint('Merge?')\n");
    await until(() => pendingIds(p.store, id).length === 1);
    const base = `http://127.0.0.1:${handle.port}`;
    const json = { "content-type": "application/json" };
    const bearer = { authorization: `Bearer ${TOKEN}` };
    const post = (path: string, body: unknown, headers: Record<string, string>) =>
      fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });

    assert.deepEqual(await (await fetch(`${base}/api/capabilities`, { headers: bearer })).json(), {
      writable: false,
      auth: "token",
      bundle: null,
      decide: true,
    });
    // No token: 401. Not JSON: 415. Another site's page: 403.
    assert.equal((await post(`/api/runs/${id}/checkpoint`, { action: "approve" }, json)).status, 401);
    assert.equal((await post(`/api/runs/${id}/checkpoint`, { action: "approve" }, { ...bearer, "content-type": "text/plain" })).status, 415);
    assert.equal((await post(`/api/runs/${id}/checkpoint`, { action: "approve" }, { ...bearer, ...json, origin: "https://evil.example" })).status, 403);
    // Stop, pause, chat: still refused.
    assert.equal((await post(`/api/runs/${id}/control`, { action: "stop" }, { ...bearer, ...json })).status, 409);
    assert.equal((await post(`/api/runs/${id}/control`, { action: "pause" }, { ...bearer, ...json })).status, 409);
    assert.equal((await post("/api/chat/sessions", {}, { ...bearer, ...json })).status, 409);
    assert.equal(p.store.readControl(id), null);

    const res = await post(`/api/runs/${id}/checkpoint`, { action: "approve", note: "from the train" }, { ...bearer, ...json });
    assert.equal(res.status, 200);
    assert.equal(await run, "done");
    assert.deepEqual(p.store.readResult(id), { approved: true, note: "from the train", by: "dashboard", edited: false });
  } finally {
    await handle.close();
    await p.cleanup();
  }
  await assert.rejects(
    async () => startServer({ store: new RunStore(join(tmpdir(), "odw-none")), port: 0, tokenScope: "approve" }),
    /--token-scope approve needs --token/,
  );
});

test("odw serve: --token-scope and --public-url are checked before anything starts", async () => {
  const usage = async (argv: string[], pattern: RegExp) => {
    const r = await cli(argv);
    assert.equal(r.code, 2, argv.join(" "));
    assert.match(r.err, pattern);
  };
  await usage(["serve", "--token-scope", "approve"], /--token-scope approve goes with --token/);
  await usage(["serve", "--token", TOKEN, "--token-scope", "write"], /--token-scope is read or approve/);
  await usage(["serve", "--public-url", "ftp://x.test"], /--public-url must be an http\(s\) URL/);
  await usage(["serve", "--public-url", "https://x.test/?a=1"], /--public-url must be/);
  await usage(["serve", "--public-url", "https://x.test/odw"], /--public-url must be a root URL \(https:\/\/host\[:port\]\), with no path/);
});
