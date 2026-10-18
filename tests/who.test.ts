import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isCheckpointRequest } from "../src/control.js";
import { clean, cliActor, localLauncher, resetLocalUser } from "../src/identity.js";
import { mintCheckpointLinks } from "../src/runtime/approve-links.js";
import { RunStore } from "../src/runtime/run-store.js";
import { TokenGate } from "../src/runtime/serve-auth.js";
import { parseTokens, TokenFileError, tokenHash, type NamedToken } from "../src/runtime/serve-tokens.js";
import { startServer, type ServeHandle } from "../src/runtime/server.js";
import { cli, pendingIds, project, until, type Project } from "./checkpoint-project.js";

// Named tokens and who did what (ODW extension; src/runtime/serve-tokens.ts,
// src/identity.ts): `odw serve --tokens FILE` gives each person a token of
// their own, and runs, decisions and control actions record who.

// Placeholders, not real tokens: any 16-256 URL-safe characters pass.
const ALICE = "alice-placeholder-token-0001";
const BOB = "bob-placeholder-token-000002";
const UNNAMED = "unnamed-placeholder-token-03";
const NAMED: NamedToken[] = [
  { name: "alice", scope: "approve", hash: tokenHash(ALICE) },
  { name: "bob", scope: "read", hash: tokenHash(BOB) },
];

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "odw-who-"));
}

// --- the token file ---------------------------------------------------------------------

test("odw token add|list|remove: the file keeps a name, a scope and a sha256 — never the token", async () => {
  const root = tmpRoot();
  const file = join(root, "tokens.json");
  try {
    const added = await cli(["token", "add", "alice", "--scope", "approve", "--file", file]);
    assert.equal(added.code, 0, added.err);
    const token = added.out.trim();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/, "printed once, alone on stdout");
    assert.match(added.err, /shown once and kept nowhere/);
    const text = readFileSync(file, "utf8");
    assert.ok(!text.includes(token), "the file never holds the token");
    assert.deepEqual(JSON.parse(text), [{ name: "alice", scope: "approve", hash: sha256(token) }]);
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);

    assert.equal((await cli(["token", "add", "bob", "--file", file])).code, 0);
    const again = await cli(["token", "add", "alice", "--file", file]);
    assert.equal(again.code, 1);
    assert.match(again.err, /already has a token named alice/);
    assert.equal((await cli(["token", "add", "not a name", "--file", file])).code, 1);
    assert.equal((await cli(["token", "add", "carol", "--scope", "write", "--file", file])).code, 2);
    assert.equal((await cli(["token", "add", "carol"])).code, 2, "--file is required");
    assert.equal((await cli(["token", "add", "--file", file])).code, 2, "a name is required");

    const listed = await cli(["token", "list", "--file", file, "--json"]);
    assert.deepEqual(JSON.parse(listed.out), [
      { name: "alice", scope: "approve" },
      { name: "bob", scope: "read" },
    ]);
    assert.match((await cli(["token", "list", "--file", file])).out, /^alice\s+approve\nbob\s+read\n$/);

    assert.equal((await cli(["token", "remove", "bob", "--file", file])).code, 0);
    assert.equal((await cli(["token", "remove", "bob", "--file", file])).code, 1);
    assert.deepEqual(JSON.parse((await cli(["token", "list", "--file", file, "--json"])).out), [{ name: "alice", scope: "approve" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a token file is checked: an array of names, read|approve scopes and sha256 hashes", () => {
  const hash = sha256("x");
  assert.deepEqual(parseTokens(JSON.stringify([{ name: "a@example.com", scope: "read", hash }])), [{ name: "a@example.com", scope: "read", hash }]);
  const refused: Array<[unknown, RegExp]> = [
    [{}, /must be a JSON array/],
    [[{ name: "a", scope: "write", hash }], /scope must be "read" or "approve"/],
    [[{ name: "a", scope: "read", hash: ALICE }], /never the token/],
    [[{ name: "a", scope: "read", hash: hash.toUpperCase() }], /64 lowercase hex/],
    [[{ name: "-a", scope: "read", hash }], /name must be/],
    [[{ name: "a:b", scope: "read", hash }], /name must be/],
    [[{ name: "a", scope: "read", hash }, { name: "a", scope: "read", hash: sha256("y") }], /the name a is there twice/],
    [[{ name: "a", scope: "read", hash }, { name: "b", scope: "read", hash }], /another token's too/],
  ];
  for (const [data, pattern] of refused) assert.throws(() => parseTokens(JSON.stringify(data)), (err: Error) => err instanceof TokenFileError && pattern.test(err.message));
  assert.throws(() => parseTokens("{"), /is not JSON/);
});

// --- the gate -----------------------------------------------------------------------------

test("TokenGate: a token is hashed and looked up — its name and scope; the unnamed one beside them", () => {
  const gate = new TokenGate(UNNAMED, "odw_token_1", { scope: "read", named: NAMED, failures: 2 });
  const req = (authorization?: string, address = "10.0.0.1") =>
    ({ headers: authorization ? { authorization } : {}, socket: { remoteAddress: address } }) as unknown as IncomingMessage;
  const api = new URL("http://localhost/api/runs");
  assert.deepEqual(gate.check(req(`Bearer ${ALICE}`), api), { ok: true, setCookie: null, name: "alice", scope: "approve" });
  assert.deepEqual(gate.check(req(`Bearer ${BOB}`), api), { ok: true, setCookie: null, name: "bob", scope: "read" });
  assert.deepEqual(gate.check(req(`Bearer ${UNNAMED}`), api), { ok: true, setCookie: null, name: null, scope: "read" });
  // ?token= sets the cookie, and still says whose it is.
  const viaQuery = gate.check(req(), new URL(`http://localhost/api/runs?token=${ALICE}`));
  assert.ok(viaQuery.ok && viaQuery.name === "alice" && viaQuery.setCookie?.startsWith(`odw_token_1=${ALICE};`));
  // Close is not equal: one character short, one more, another case.
  for (const [i, wrong] of [ALICE.slice(0, -1), `${ALICE}x`, ALICE.toUpperCase()].entries()) {
    const r = gate.check(req(`Bearer ${wrong}`, `10.0.1.${i}`), api);
    assert.ok(!r.ok && r.status === 401, wrong);
  }
  // identify() — an approve link's attribution — answers nothing, so wrong tokens there count as no failure.
  for (let i = 0; i < 5; i++) assert.equal(gate.identify(req("Bearer nope-nope-nope-nope", "10.0.0.2"), api), null);
  assert.equal(gate.identify(req(`Bearer ${BOB}`, "10.0.0.2"), api), "bob");
  assert.equal(gate.identify(req(`Bearer ${UNNAMED}`, "10.0.0.2"), api), null, "the unnamed token names nobody");
  assert.ok(gate.check(req(`Bearer ${ALICE}`, "10.0.0.2"), api).ok);
  // Named tokens alone are a gate; nothing at all is not.
  assert.ok(new TokenGate(null, "c", { named: NAMED }).check(req(`Bearer ${BOB}`), api).ok);
  assert.throws(() => new TokenGate(null, "c", {}), /needs a token/);
});

// --- the dashboard ------------------------------------------------------------------------

async function withServer(p: Project, options: Partial<Parameters<typeof startServer>[0]>, body: (h: ServeHandle, base: string) => Promise<void>): Promise<void> {
  const handle = await startServer({ store: p.store, port: 0, claudeProjectsRoot: join(p.root, "no-claude"), ...options });
  try {
    await body(handle, `http://127.0.0.1:${handle.port}`);
  } finally {
    await handle.close();
  }
}

const JSON_POST = { "content-type": "application/json" };
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

test("odw serve --tokens off loopback: capabilities say who; only an approve-scope name answers, and the answer carries it", async () => {
  const p = project();
  try {
    await withServer(p, { host: "0.0.0.0", namedTokens: NAMED }, async (_h, base) => {
      const caps = async (token: string) => (await fetch(`${base}/api/capabilities`, { headers: bearer(token) })).json();
      assert.deepEqual(await caps(BOB), { writable: false, auth: "token", bundle: null, decide: false, you: "bob" });
      assert.deepEqual(await caps(ALICE), { writable: false, auth: "token", bundle: null, decide: true, you: "alice" });

      const { id, run } = p.start("return await checkpoint('Ship?')\n");
      await until(() => pendingIds(p.store, id).length === 1);
      const decide = (token: string) =>
        fetch(`${base}/api/runs/${id}/checkpoint`, { method: "POST", headers: { ...JSON_POST, ...bearer(token) }, body: JSON.stringify({ action: "approve" }) });
      assert.equal((await decide(BOB)).status, 409, "a read token answers nothing off loopback");
      assert.equal((await decide(ALICE)).status, 200);
      assert.equal(await run, "done");
      assert.deepEqual(p.store.readResult(id), { approved: true, note: null, by: "dashboard", who: "alice", edited: false });
      const logged = readFileSync(p.store.decisionsPath(id), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.equal(logged.length, 1);
      assert.equal(logged[0].who, "alice");
      assert.equal(logged[0].by, "dashboard");
      const resolved = p.store.readEvents(id).find((e) => e.type === "checkpoint_resolved");
      assert.equal(resolved?.who, "alice");
      assert.equal(resolved?.by, "dashboard");
    });
  } finally {
    await p.cleanup();
  }
});

test("on loopback, a named token's pause and stop are logged with its name", async () => {
  const p = project();
  try {
    await withServer(p, { namedTokens: [{ name: "carol", scope: "read", hash: tokenHash(ALICE) }] }, async (_h, base) => {
      const { id, run } = p.start("const a = await checkpoint('Go?')\nawait agent('TASK one')\nreturn a.who\n");
      await until(() => pendingIds(p.store, id).length === 1);
      const post = (path: string, body: unknown) =>
        fetch(`${base}/api/runs/${id}/${path}`, { method: "POST", headers: { ...JSON_POST, ...bearer(ALICE) }, body: JSON.stringify(body) });
      assert.equal((await post("control", { action: "pause" })).status, 200);
      assert.equal(p.store.readControlRequest(id)?.who, "carol");
      // The answer lets it go on to its agent — where the pause holds it.
      assert.equal((await post("checkpoint", { action: "approve" })).status, 200);
      await until(() => p.store.readEvents(id).some((e) => e.type === "log" && e.who === "carol"));
      const paused = p.store.readEvents(id).find((e) => e.type === "log" && e.who === "carol")!;
      assert.equal(paused.message, "paused by carol");
      assert.equal((await post("control", { action: "stop" })).status, 200);
      assert.equal(await run, "stopped");
      const stopped = p.store.readEvents(id).find((e) => e.type === "run_stopped");
      assert.equal(stopped?.who, "carol");
      assert.equal(p.store.readStatus(id).stoppedBy, "carol");
      const resolved = p.store.readEvents(id).find((e) => e.type === "checkpoint_resolved");
      assert.equal(resolved?.who, "carol");
    });
  } finally {
    await p.cleanup();
  }
});

test("an approve link keeps by: link — and adds the name of a named token the request also carries", async () => {
  const p = project();
  try {
    await withServer(p, { host: "0.0.0.0", namedTokens: NAMED, publicUrl: "https://odw.example.test" }, async (handle, base) => {
      const { id, run } = p.start(
        "const a = await checkpoint('One?')\nconst b = await checkpoint('Two?')\nreturn [a.by, a.who ?? null, b.by, b.who ?? null]\n",
      );
      const follow = (checkpointId: number, cookie: string | null) => {
        const minted = mintCheckpointLinks(p.runsRoot, id, checkpointId, 600);
        assert.ok(minted.ok);
        return fetch(minted.links.approveUrl.replace("https://odw.example.test", base), {
          method: "POST",
          headers: { "x-odw-action": "approve", ...(cookie ? { cookie } : {}) },
        });
      };
      await until(() => pendingIds(p.store, id).join() === "1");
      assert.equal((await follow(1, `odw_token_${handle.port}=${BOB}`)).status, 200);
      await until(() => pendingIds(p.store, id).join() === "2");
      // A wrong token beside a good link: the link decides, and nobody is named.
      assert.equal((await follow(2, `odw_token_${handle.port}=not-a-token-at-all-000`)).status, 200);
      assert.equal(await run, "done");
      assert.deepEqual(p.store.readResult(id), ["link", "bob", "link", null]);
    });
  } finally {
    await p.cleanup();
  }
});

// --- the CLI and the run's meta -----------------------------------------------------------

test("CLI: meta.launchedBy is the local user unless given; pause|stop record cli:<user>; odw list --by filters", async () => {
  const root = tmpRoot();
  const runsRoot = join(root, "runs");
  try {
    const store = new RunStore(runsRoot);
    const src = "export const meta = { name: 'who', description: 'd' }\nreturn 1\n";
    const mine = store.create({ script: "", inlineSource: src, args: null, source: root });
    const alices = store.create({ script: "", inlineSource: src, args: null, source: root, launchedBy: "alice@example.com" });
    const triggered = store.create({ script: "", inlineSource: src, args: null, source: root, launchedBy: "trigger:gh" });
    assert.equal(store.readMeta(mine).launchedBy, localLauncher());
    assert.equal(store.readMeta(alices).launchedBy, "alice@example.com");

    const list = async (...args: string[]) => cli(["list", "--runs-root", runsRoot, ...args]);
    const ids = (out: string) => out.trim().split("\n").filter(Boolean).map((l) => l.split(/\s+/)[0]).sort();
    assert.deepEqual(ids((await list()).out), [mine, alices, triggered].sort());
    assert.deepEqual(ids((await list("--by", "alice@example.com")).out), [alices]);
    assert.deepEqual(ids((await list("--by", "ALICE@example.com")).out), [alices], "an email's case says nothing");
    assert.deepEqual(ids((await list("--by", "trigger:gh")).out), [triggered]);
    if (localLauncher()) assert.deepEqual(ids((await list("--by", "me")).out), [mine]);
    const none = await list("--by", "nobody");
    assert.equal(none.code, 0);
    assert.match(none.err, /no runs found launched by 'nobody'/);
    assert.equal((await list("--by", " ")).code, 2);

    assert.equal((await cli(["pause", alices, "--runs-root", runsRoot])).code, 0);
    assert.deepEqual(store.readControlRequest(alices), { action: "pause", at: store.readControlRequest(alices)!.at, who: cliActor() });
    assert.equal((await cli(["stop", alices, "--runs-root", runsRoot])).code, 0);
    assert.equal(store.readControlRequest(alices)?.who, cliActor());
    assert.match(cliActor(), /^cli(:|$)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("identity: cli:<$USER> <git user.email> for decisions and control, the email (else $USER) for launches", () => {
  const saved = { USER: process.env.USER, USERNAME: process.env.USERNAME, COUNT: process.env.GIT_CONFIG_COUNT, KEY: process.env.GIT_CONFIG_KEY_0, VALUE: process.env.GIT_CONFIG_VALUE_0 };
  const restore = (name: string, value: string | undefined) => (value === undefined ? delete process.env[name] : (process.env[name] = value));
  try {
    process.env.USER = "tester";
    // A config given on the command line's level outranks every file: the test's own email.
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "user.email";
    process.env.GIT_CONFIG_VALUE_0 = "tester@example.com";
    resetLocalUser();
    assert.equal(cliActor(), "cli:tester <tester@example.com>");
    assert.equal(localLauncher(), "tester@example.com");
    process.env.GIT_CONFIG_VALUE_0 = "";
    resetLocalUser();
    assert.equal(cliActor(), "cli:tester");
    assert.equal(localLauncher(), "tester");
  } finally {
    restore("USER", saved.USER);
    restore("USERNAME", saved.USERNAME);
    restore("GIT_CONFIG_COUNT", saved.COUNT);
    restore("GIT_CONFIG_KEY_0", saved.KEY);
    restore("GIT_CONFIG_VALUE_0", saved.VALUE);
    resetLocalUser();
  }
  // A name on record is printable and bounded; a decision log line with anything else is no request.
  assert.equal(clean(" a\u0007b\n "), "ab");
  assert.equal(clean("x".repeat(500))!.length, 200);
  assert.equal(clean("  "), null);
  assert.ok(isCheckpointRequest({ action: "approve", who: "alice" }));
  assert.ok(!isCheckpointRequest({ action: "approve", who: "al\nice" }));
  assert.ok(!isCheckpointRequest({ action: "approve", who: 7 }));
});

test("odw serve --tokens refuses a file it cannot use before anything starts", async () => {
  const root = tmpRoot();
  try {
    const bad = join(root, "bad.json");
    writeFileSync(bad, JSON.stringify([{ name: "a", scope: "read", hash: ALICE }]));
    const r = await cli(["serve", "--port", "0", "--runs-root", join(root, "runs"), "--tokens", bad]);
    assert.equal(r.code, 1);
    assert.match(r.err, /--tokens: .*never the token/);
    const empty = join(root, "empty.json");
    writeFileSync(empty, "[]\n");
    const e = await cli(["serve", "--port", "0", "--runs-root", join(root, "runs"), "--tokens", empty]);
    assert.equal(e.code, 1);
    assert.match(e.err, /has no tokens — add one with odw token add/);
    const missing = await cli(["serve", "--port", "0", "--runs-root", join(root, "runs"), "--tokens", join(root, "nope.json")]);
    assert.equal(missing.code, 1);
    assert.match(missing.err, /cannot read/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
