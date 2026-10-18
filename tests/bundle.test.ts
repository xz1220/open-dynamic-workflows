import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/adapters/config.js";
import { main } from "../src/cli.js";
import {
  BundleError,
  bundleRedactor,
  checkBundle,
  createBundle,
  openBundle,
  readBundle,
  unpackBundle,
  type RunBundle,
} from "../src/runtime/bundle.js";
import { RunStore } from "../src/runtime/run-store.js";
import { executeRun } from "../src/runtime/worker.js";

// `odw bundle` (ODW extension; src/runtime/bundle.ts): one redacted file of a
// run, and `odw serve FILE.odwrun` / `odw view FILE` showing it read-only.

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

/** A GitHub-shaped token, made up here from fragments so no real-looking one sits in the source. */
const gh = (c: string): string => ["gh", "p_", c.repeat(36)].join("");
const TOKEN = gh("Q");
/** A secret-named variable's value, as the machine bundling a run has it. */
const ENV_NAME = "ODW_BUNDLE_TEST_API_KEY";
const ENV_VALUE = ["bundle", "secret", "value", "42"].join("-");

// The agent prints the token and the variable's value; the workflow returns and logs them.
const MOCK = `let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{process.stdout.write('found ${TOKEN} and ${ENV_VALUE}')})`;
const WORKFLOW = `export const meta = { name: 'share-me', description: 'a run to share', phases: [{ title: 'Work' }] }
phase('Work')
const said = await agent('look around', { label: 'looker' })
log('the agent said: ' + said)
return { said, args }
`;

/** A finished run made with `redact: false`: everything in it as printed, secrets included. */
async function plainRun(root: string): Promise<{ store: RunStore; runId: string; configPath: string }> {
  const configPath = join(root, "odw.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({ redact: false, notify: { webhook: "https://hooks.example.com/YOUR/PATH", on: ["stopped"] }, defaultAdapter: "mock", adapters: { mock: { command: [execPath, "-e", MOCK], stdin: "{prompt}" } } }),
  );
  const script = join(root, "share-me.js");
  writeFileSync(script, WORKFLOW);
  const store = new RunStore(join(root, "runs"));
  const runId = store.create({ script, args: { repo: "demo", key: TOKEN }, source: root, configPath });
  assert.equal(await executeRun(store.runDir(runId)), "done");
  // A kept diff, as an isolated agent leaves it, with a token in the code it changed.
  writeFileSync(store.agentDiffPath(runId, 1), `--- a/.env\n+++ b/.env\n@@ -0,0 +1 @@\n+GITHUB_TOKEN=${TOKEN}\n`);
  return { store, runId, configPath };
}

const tempRoot = () => mkdtempSync(join(tmpdir(), "odw-bundle-"));

test("a bundle redacts a token and an env value everywhere — redact: false notwithstanding — and keeps nothing of the machine", async () => {
  const root = tempRoot();
  try {
    const { store, runId, configPath } = await plainRun(root);
    // The run itself kept them as printed (redact: false).
    assert.ok(readFileSync(store.eventsPath(runId), "utf8").includes(TOKEN));
    assert.ok(readFileSync(store.agentTranscriptPaths(runId, 1).transcript, "utf8").includes(ENV_VALUE));

    const config = loadConfig(configPath, { quiet: true });
    const { bundle, json } = createBundle(store, runId, bundleRedactor(config, { [ENV_NAME]: ENV_VALUE }), { now: () => 1_800_000_000 });
    assert.ok(!json.includes(TOKEN), "no token survives anywhere");
    assert.ok(!json.includes(ENV_VALUE), "no env value survives anywhere");
    assert.equal(bundle.format, "odw-run-bundle");
    assert.equal(bundle.redacted, true);
    assert.equal(bundle.transcripts, true);
    assert.equal(bundle.runId, runId);
    assert.equal(bundle.bundledAt, 1_800_000_000);
    // Marked where something was replaced.
    assert.equal((bundle.meta.args as { key: string }).key, "«redacted:github»");
    assert.equal(bundle.meta.redacted, true);
    const said = bundle.events.find((ev) => ev.type === "log" && String(ev.message).startsWith("the agent said"))!;
    assert.match(String(said.message), /«redacted:github».*«redacted:env:ODW_BUNDLE_TEST_API_KEY»/);
    assert.equal(said.redacted, true);
    assert.equal(bundle.result?.redacted, true);
    const agent = bundle.agents.find((a) => a.agentId === 1)!;
    assert.equal(agent.record?.redacted, true);
    assert.match(String(agent.record?.value), /«redacted:github»/);
    assert.match(agent.diff!, /GITHUB_TOKEN=«redacted:/);
    assert.ok(agent.transcript && agent.transcript.length > 0);
    assert.equal(agent.redacted, true);
    // Nothing of the machine's setup: no config path, no worker pid, no config.
    assert.ok(!("configPath" in bundle.meta));
    assert.ok(!("resumedFromDir" in bundle.meta));
    assert.ok(!("pid" in bundle.status));
    assert.ok(!json.includes(configPath), "the config's path is not in it");
    assert.ok(!json.includes("hooks.example.com") && !json.includes('"notify"'), "nor its notify settings");

    // --no-transcripts: no transcripts, no stderr.
    const lean = createBundle(store, runId, bundleRedactor(config, {}), { transcripts: false }).bundle;
    assert.equal(lean.transcripts, false);
    assert.ok(lean.agents.every((a) => a.transcript === null && a.stderr === null));

    // The cap, with a clear error that names the ways out.
    assert.throws(
      () => createBundle(store, runId, bundleRedactor(config, {}), { maxBytes: 200 }),
      (err: Error) => err instanceof BundleError && /over the 200-byte cap/.test(err.message) && /--max-bytes/.test(err.message) && /--no-transcripts/.test(err.message),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("odw bundle: writes <run>.odwrun (or --out), refuses unknown runs, bad ids, Claude runs and an oversized bundle", async () => {
  const root = tempRoot();
  const cwd = process.cwd();
  const err = process.stderr.write.bind(process.stderr);
  const said: string[] = [];
  (process.stderr as { write: unknown }).write = (s: unknown) => (said.push(String(s)), true);
  try {
    const { store, runId } = await plainRun(root);
    process.chdir(root);
    assert.equal(await main(["bundle", runId, "--runs-root", store.root]), 0);
    const file = join(root, `${runId}.odwrun`);
    const bundle = readBundle(file);
    assert.equal(bundle.runId, runId);
    assert.ok(!readFileSync(file, "utf8").includes(TOKEN));
    assert.equal(statSync(file).mode & 0o077, 0, "only its owner reads it until they share it");
    assert.match(said.join(""), /likely secrets redacted/);

    const out = join(root, "elsewhere.odwrun");
    assert.equal(await main(["bundle", runId, "--runs-root", store.root, "--out", out, "--no-transcripts"]), 0);
    assert.equal(readBundle(out).transcripts, false);

    assert.equal(await main(["bundle", "20990101-000000-ffffff", "--runs-root", store.root]), 1);
    assert.equal(await main(["bundle", "../escape", "--runs-root", store.root]), 2);
    assert.equal(await main(["bundle", "cc-abc", "--runs-root", store.root]), 2);
    assert.equal(await main(["bundle", runId, "--runs-root", store.root, "--max-bytes", "nope"]), 2);
    assert.equal(await main(["view"]), 2, "odw view needs a bundle file");
    said.length = 0;
    assert.equal(await main(["bundle", runId, "--runs-root", store.root, "--out", join(root, "big.odwrun"), "--max-bytes", "100"]), 1);
    assert.match(said.join(""), /over the 100-byte cap/);
    assert.ok(!existsSync(join(root, "big.odwrun")), "nothing written past the cap");
  } finally {
    process.chdir(cwd);
    process.stderr.write = err;
    rmSync(root, { recursive: true, force: true });
  }
});

// --- opening one: nothing in the file is trusted -------------------------------------------

function sample(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: "odw-run-bundle",
    version: 1,
    odwVersion: "0.0.0-test",
    bundledAt: 1_800_000_000,
    runId: "20260101-000000-abcdef",
    redacted: false,
    transcripts: true,
    meta: { runId: "20260101-000000-abcdef", script: "/x/wf.js", args: null, createdAt: 1_799_999_000 },
    status: { runId: "20260101-000000-abcdef", state: "done", pid: 1 },
    events: [{ ts: 1, type: "run_started" }],
    result: { value: 42 },
    error: null,
    agents: [{ agentId: 0, record: { agentId: 0, key: "k", label: "a", value: "v" }, diff: "d", transcript: null, stderr: null }],
    ...over,
  };
}

test("a bundle's run id, agent ids and shape are checked: path traversal and junk are refused", () => {
  const refused = (over: Record<string, unknown>, pattern: RegExp) =>
    assert.throws(() => checkBundle(sample(over)), (err: Error) => err instanceof BundleError && pattern.test(err.message), JSON.stringify(over));
  refused({ runId: "../../etc" }, /runId must be a run id/);
  refused({ runId: "a/b" }, /runId/);
  refused({ runId: ".." }, /runId/);
  refused({ runId: "cc-claude-run" }, /runId/);
  refused({ runId: 7 }, /runId/);
  refused({ format: "zip" }, /format/);
  refused({ version: 2 }, /version 2/);
  refused({ meta: [] }, /meta must be an object/);
  refused({ events: [{ no: "type" }] }, /events/);
  refused({ result: "x" }, /result/);
  refused({ agents: {} }, /agents must be an array/);
  refused({ agents: Array.from({ length: 10_001 }, (_, agentId) => ({ agentId, record: null })) }, /more than 10000 agents/);
  for (const agentId of ["../../x", -1, 1.5, "0", Number.MAX_SAFE_INTEGER + 2]) {
    refused({ agents: [{ agentId, record: null }] }, /agentId must be a non-negative integer/);
  }
  refused({ agents: [{ agentId: 1, record: null }, { agentId: 1, record: null }] }, /appears twice/);
  refused({ agents: [{ agentId: 1, record: { agentId: 2 } }] }, /record must be null or a saved result with agentId 1/);
  refused({ agents: [{ agentId: 1, record: null, diff: { path: "/etc/passwd" } }] }, /diff must be a string/);
  assert.throws(() => checkBundle([]), BundleError);
  assert.throws(() => checkBundle(null), BundleError);
});

test("opening a bundle: size capped before it is read, unpacked only into its own temp dir, under fixed names", () => {
  const root = tempRoot();
  try {
    const parent = join(root, "tmp");
    mkdirSync(parent);
    const file = join(root, "x.odwrun");
    writeFileSync(file, JSON.stringify(sample()));

    // Oversized: refused before parsing, nothing unpacked.
    assert.throws(() => openBundle(file, 10, parent), (err: Error) => err instanceof BundleError && /over the 10-byte cap/.test(err.message));
    writeFileSync(join(root, "junk.odwrun"), "{ not json");
    assert.throws(() => openBundle(join(root, "junk.odwrun"), undefined, parent), /not a run bundle \(not JSON\)/);
    writeFileSync(join(root, "evil.odwrun"), JSON.stringify(sample({ runId: "../evil" })));
    assert.throws(() => openBundle(join(root, "evil.odwrun"), undefined, parent), /runId/);
    assert.throws(() => openBundle(root, undefined, parent), /is not a file/);
    assert.deepEqual(readdirSync(parent), [], "a refused bundle leaves nothing behind");
    assert.ok(!existsSync(join(root, "evil")));

    // A good one, with fields it should not carry: only the run's own fields reach the store.
    const opened = openBundle(
      (writeFileSync(file, JSON.stringify(sample({ meta: { runId: "other", configPath: "/home/me/odw.config.json", resumedFromDir: "/etc", bundle: "forged", script: "/x/wf.js" } }))), file),
      undefined,
      parent,
    );
    assert.equal(readdirSync(parent).length, 1);
    assert.ok(opened.root.startsWith(parent));
    assert.equal(statSync(opened.root).mode & 0o077, 0, "a private temp dir");
    const runDir = join(opened.root, "bundle", "20260101-000000-abcdef");
    assert.deepEqual(readdirSync(join(runDir, "agents")).sort(), ["0.diff", "0.json"]);
    const meta = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8"));
    assert.equal(meta.runId, "20260101-000000-abcdef", "the run id is the bundle's, checked");
    assert.ok(!("configPath" in meta) && !("resumedFromDir" in meta));
    assert.deepEqual(meta.bundle, { bundledAt: 1_800_000_000, odwVersion: "0.0.0-test" });
    assert.ok(!("pid" in JSON.parse(readFileSync(join(runDir, "status.json"), "utf8"))), "no pid to probe");
    assert.equal(opened.info.file, "x.odwrun");
    opened.cleanup();
    assert.ok(!existsSync(opened.root));
    opened.cleanup(); // idempotent
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unpacking writes nothing outside its temp dir, whatever the ids say", () => {
  const root = tempRoot();
  try {
    const parent = join(root, "tmp");
    mkdirSync(parent);
    // checkBundle is the gate; unpackBundle is only ever given what it passed.
    const bundle = checkBundle(sample({ agents: [{ agentId: 3, record: null, diff: "x", transcript: "{}\n", stderr: "e" }] })) as RunBundle;
    const opened = unpackBundle(bundle, "x.odwrun", parent);
    const all: string[] = [];
    const walk = (dir: string, prefix = ""): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name), `${prefix}${e.name}/`);
        else all.push(`${prefix}${e.name}`);
      }
    };
    walk(root);
    assert.ok(all.every((p) => p.startsWith("tmp/odw-bundle-")), all.join(", "));
    opened.cleanup();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- the round trip: odw bundle → odw serve --open FILE --------------------------------------

/** `odw serve …` as a child process: its output so far, and its URL once it listens. */
function serve(args: string[], env: NodeJS.ProcessEnv = {}): { child: ChildProcess; out: () => string; err: () => string; ready: Promise<string>; exited: Promise<number | null> } {
  const child = spawn(execPath, [...process.execArgv, cli, "serve", ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout!.on("data", (c) => (out += c));
  child.stderr!.on("data", (c) => (err += c));
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const ready = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`serve did not start: ${out} ${err}`)), 20_000);
    child.stdout!.on("data", () => {
      const url = /odw dashboard → (http:\/\/[^\s/]+)/.exec(out)?.[1];
      if (url && out.includes("press Ctrl-C")) {
        clearTimeout(timer);
        resolve(url);
      }
    });
    void exited.then(() => {
      clearTimeout(timer);
      reject(new Error(`serve exited: ${out} ${err}`));
    });
  });
  ready.catch(() => {}); // a test that expects the exit never awaits it
  return { child, out: () => out, err: () => err, ready, exited };
}

test("round trip: odw bundle, then odw serve --open FILE shows that run alone, tagged, read-only, and cleans up", { skip: process.platform === "win32" }, async () => {
  const root = tempRoot();
  try {
    const { store, runId } = await plainRun(root);
    const file = join(root, "shared.odwrun");
    const quiet = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = () => true;
    try {
      assert.equal(await main(["bundle", runId, "--runs-root", store.root, "--out", file]), 0);
    } finally {
      process.stderr.write = quiet;
    }
    // A stand-in browser opener records what --open asked it to open.
    const bin = join(root, "bin");
    mkdirSync(bin);
    const opened = join(root, "opened.txt");
    for (const name of ["xdg-open", "open"]) {
      writeFileSync(join(bin, name), `#!/bin/sh\necho "$@" >> '${opened}'\n`);
      chmodSync(join(bin, name), 0o755);
    }
    const tmp = join(root, "tmp");
    mkdirSync(tmp);
    const server = serve(["--open", file, "--port", "0"], { PATH: `${bin}:${process.env.PATH}`, TMPDIR: tmp });
    try {
      const url = await server.ready;
      assert.match(server.out(), /shared bundle shared\.odwrun/);
      const unpacked = /unpacked in (\S+)/.exec(server.out())![1]!;
      assert.ok(unpacked.startsWith(tmp) && existsSync(unpacked));

      const runs = (await (await fetch(`${url}/api/runs`)).json()) as Array<Record<string, any>>;
      assert.deepEqual(runs.map((r) => r.runId), [runId], "the bundle's run alone: no other runs, no Claude runs");
      assert.equal(runs[0]!.state, "done");
      assert.ok(runs[0]!.bundle, "tagged as a shared bundle");
      const detail = (await (await fetch(`${url}/api/runs/${runId}`)).json()) as Record<string, any>;
      assert.equal(detail.name, "share-me");
      assert.equal(detail.args.key, "«redacted:github»");
      assert.equal(detail.agents.length, 1);
      const events = (await (await fetch(`${url}/api/runs/${runId}/events`)).json()) as Array<Record<string, any>>;
      assert.ok(events.some((e) => e.type === "run_finished"));
      const result = (await (await fetch(`${url}/api/runs/${runId}/result`)).json()) as { value: { said: string } };
      assert.match(result.value.said, /«redacted:github»/);
      const diff = await (await fetch(`${url}/api/runs/${runId}/agents/1/diff`)).text();
      assert.match(diff, /GITHUB_TOKEN=«redacted:/);
      const transcript = (await (await fetch(`${url}/api/runs/${runId}/agents/1/transcript`)).json()) as { entries: unknown[] };
      assert.ok(Array.isArray(transcript.entries));
      const caps = (await (await fetch(`${url}/api/capabilities`)).json()) as Record<string, any>;
      assert.equal(caps.writable, false);
      assert.equal(caps.bundle.runId, runId);
      assert.equal(caps.bundle.file, "shared.odwrun");
      const settings = (await (await fetch(`${url}/api/settings`)).json()) as Record<string, any>;
      assert.equal(settings.runsRoot, "", "no local paths");
      assert.deepEqual(settings.adapters, []);
      assert.deepEqual(await (await fetch(`${url}/api/workflows`)).json(), []);
      assert.deepEqual(await (await fetch(`${url}/api/schedules`)).json(), []);
      // Writes are refused on loopback too.
      for (const [path, body] of [
        [`/api/runs/${runId}/control`, { action: "stop" }],
        [`/api/runs/${runId}/checkpoint`, { action: "approve" }],
        ["/api/chat/sessions", {}],
      ] as const) {
        const res = await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        assert.equal(res.status, 409, path);
      }
      // --open opened the run's page.
      const deadline = Date.now() + 5000;
      while (!existsSync(opened) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      assert.match(readFileSync(opened, "utf8"), new RegExp(`/#/job/${runId}`));

      server.child.kill("SIGTERM");
      assert.equal(await server.exited, 0);
      assert.ok(!existsSync(unpacked), "the unpacked bundle is removed on exit");
      assert.deepEqual(readdirSync(tmp).filter((name) => name.startsWith("odw-")), []); // (tsx keeps its cache there too)
    } finally {
      server.child.kill("SIGKILL");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("odw serve refuses a bundle that is too big or not a bundle, and unpacks nothing", { skip: process.platform === "win32" }, async () => {
  const root = tempRoot();
  try {
    const tmp = join(root, "tmp");
    mkdirSync(tmp);
    const file = join(root, "x.odwrun");
    writeFileSync(file, JSON.stringify(sample()));
    const big = serve([file, "--port", "0", "--max-bytes", "64"], { TMPDIR: tmp });
    assert.equal(await big.exited, 1);
    assert.match(big.err(), /over the 64-byte cap: --max-bytes <n> raises it/);
    writeFileSync(file, JSON.stringify(sample({ agents: [{ agentId: "../../x", record: null }] })));
    const evil = serve([file, "--port", "0"], { TMPDIR: tmp });
    assert.equal(await evil.exited, 1);
    assert.match(evil.err(), /agentId must be a non-negative integer/);
    assert.deepEqual(readdirSync(tmp).filter((name) => name.startsWith("odw-")), []); // (tsx keeps its cache there too)
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
