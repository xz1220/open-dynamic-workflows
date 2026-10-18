import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";

import { loadConfig } from "../src/adapters/config.js";
import { main } from "../src/cli.js";
import { runDoctor } from "../src/doctor.js";
import { AGENT_STARTED } from "../src/events.js";
import { waitFor } from "../src/runtime/launcher.js";
import { attachRun } from "../src/runtime/live-view.js";
import { RunStore } from "../src/runtime/run-store.js";
import { FakeTerm } from "./fake-term.js";

// Permission tiers at the command line (ODW extension): `--permissions` on
// run, rerun and resume reaches the worker; every start prints the run's
// tier per adapter; `odw doctor` lists each adapter's tiers.

/** Replies with the tier flags it was started with: "tier:read", "tier:edit", "tier:full" (or "(none)"). */
const ECHO_ARGS = "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(process.argv.slice(1).join(' ')||'(none)'))";

interface Project {
  root: string;
  config: string;
  runsRoot: string;
  store: RunStore;
  script(name: string, body: string): string;
}

function project(settings: Record<string, unknown> = {}): Project {
  const root = mkdtempSync(join(tmpdir(), "odw-perm-run-"));
  const config = join(root, "odw.config.json");
  const echo = (permissionArgs: Record<string, string[]>) => ({
    command: [execPath, "-e", ECHO_ARGS, "{permission_args}"],
    stdin: "{prompt}",
    permissionArgs,
  });
  writeFileSync(
    config,
    JSON.stringify({
      defaultAdapter: "probe",
      ...settings,
      adapters: {
        probe: echo({ read: ["tier:read"], edit: ["tier:edit"], full: ["tier:full"] }),
        solo: echo({ edit: ["tier:edit"] }),
      },
    }),
  );
  const runsRoot = join(root, "runs");
  return {
    root,
    config,
    runsRoot,
    store: new RunStore(runsRoot),
    script(name, body) {
      const path = join(root, `${name}.js`);
      writeFileSync(path, `export const meta = { name: '${name}', description: 'd' }\n${body}`);
      return path;
    },
  };
}

/** Run the CLI with stdout/stderr captured (node:test's own buffer writes pass through). */
async function cli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  (process.stdout as { write: unknown }).write = (s: unknown) => {
    if (Buffer.isBuffer(s)) return so(s);
    out.push(String(s));
    return true;
  };
  (process.stderr as { write: unknown }).write = (s: unknown) => {
    if (Buffer.isBuffer(s)) return se(s);
    err.push(String(s));
    return true;
  };
  try {
    const code = await main(argv);
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
  }
}

const TWO_AGENTS = "const a = await agent('TASK one')\nconst b = await agent('TASK two', { permissions: 'read' })\nreturn { a, b }\n";

/** The id of the run a `--wait` start printed ("running <id> ..."). */
const waitedRun = (err: string): string => /running (\S+) \.\.\./.exec(err)![1]!;

test("odw run --permissions sets the run's tier: banner, meta, and every agent's flags", async () => {
  const p = project();
  try {
    const script = p.script("tiers", TWO_AGENTS);
    const flags = ["--config", p.config, "--runs-root", p.runsRoot, "--source", p.root];
    let r = await cli(["run", script, "--permissions", "full", "--wait", ...flags]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(JSON.parse(r.out), { a: "tier:full", b: "tier:read" }, "the call's read still lowers it");
    assert.match(r.err, /^running \S+ \.\.\.\npermissions: full — /);
    assert.match(r.err, /probe full/);
    assert.match(r.err, /solo edit \(no full mode\)/);
    const id = waitedRun(r.err);
    assert.equal(p.store.readMeta(id).permissions, "full");
    assert.deepEqual(
      p.store.readEvents(id).filter((e) => e.type === AGENT_STARTED).map((e) => e.permissions),
      ["full", "read"],
    );

    // No flag: the config's tier (the default, edit), and nothing in meta.
    r = await cli(["run", script, "--wait", ...flags]);
    assert.deepEqual(JSON.parse(r.out), { a: "tier:edit", b: "tier:read" });
    assert.match(r.err, /permissions: edit — .*probe edit/);
    assert.equal(p.store.readMeta(waitedRun(r.err)).permissions, null);

    // A bad tier is a usage error, before anything is created.
    const runs = p.store.listRuns().length;
    r = await cli(["run", script, "--permissions", "write", ...flags]);
    assert.deepEqual([r.code, r.err], [2, "odw run: --permissions must be read, edit or full; got 'write'\n"]);
    assert.equal(p.store.listRuns().length, runs);
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("the config's permissions is the run's tier; a detached start prints the banner too", async () => {
  const p = project({ permissions: "read" });
  try {
    const script = p.script("refuse", "try { return await agent('TASK x', { adapter: 'solo' }) } catch (e) { return String(e) }\n");
    const r = await cli(["run", script, "-d", "--config", p.config, "--runs-root", p.runsRoot, "--source", p.root]);
    assert.equal(r.code, 0, r.err);
    const id = r.out.trim();
    assert.match(r.err, new RegExp(`^started run ${id} \\(use 'odw status ${id}'\\)\\npermissions: read — .*solo refused \\(no read mode\\)`));
    assert.equal((await waitFor(p.store, id, { timeoutMs: 15_000, pollIntervalMs: 20 })).state, "done");
    // The advice names an installed adapter that can (probe here, or a real CLI found on PATH).
    assert.match(
      String(p.store.readResult(id)),
      /^AgentError: solo cannot run read-only \(adapter 'solo' declares no "read" permissionArgs\); use an adapter that can \(--adapter \w+, .*\), or run with --permissions edit$/,
    );
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("rerun and resume keep the source run's tier; --permissions overrides it", async () => {
  const p = project();
  try {
    const script = p.script("tiers", TWO_AGENTS);
    const flags = ["--runs-root", p.runsRoot];
    let r = await cli(["run", script, "--permissions", "full", "--wait", "--config", p.config, ...flags]);
    const source = waitedRun(r.err);

    r = await cli(["rerun", source, "--wait", ...flags]);
    assert.deepEqual(JSON.parse(r.out), { a: "tier:full", b: "tier:read" }, "rerun keeps full");
    assert.equal(p.store.readMeta(waitedRun(r.err)).permissions, "full");
    r = await cli(["rerun", source, "--permissions", "read", "--wait", ...flags]);
    assert.deepEqual(JSON.parse(r.out), { a: "tier:read", b: "tier:read" });
    assert.match(r.err, /permissions: read — /);

    // A resume replays both (unchanged) calls; their events keep the tier they ran at.
    r = await cli(["resume", source, "--permissions", "edit", "--wait", ...flags]);
    assert.equal(r.code, 0, r.err);
    const resumed = waitedRun(r.err);
    assert.equal(p.store.readMeta(resumed).permissions, "edit");
    const started = p.store.readEvents(resumed).filter((e) => e.type === AGENT_STARTED);
    assert.deepEqual(started.map((e) => [e.cached, e.permissions]), [[true, "full"], [true, "read"]]);

    // Usage errors come before any lookup.
    for (const cmd of ["rerun", "resume"]) {
      r = await cli([cmd, "no-such-run", "--permissions", "all", ...flags]);
      assert.deepEqual([r.code, r.err], [2, `odw ${cmd}: --permissions must be read, edit or full; got 'all'\n`]);
    }
    // A paused run continues in place: a new tier makes no sense there.
    const paused = p.store.create({ script, args: null, source: p.root, configPath: p.config });
    p.store.updateStatus(paused, { state: "paused", pid: process.pid });
    r = await cli(["resume", paused, "--permissions", "read", ...flags]);
    assert.equal(r.code, 2);
    assert.match(r.err, /is paused, so resume continues it in place — --permissions applies only when resume starts a new run/);
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("the live view puts the banner under its header; the line stream prints it first", async () => {
  const store = new RunStore(mkdtempSync(join(tmpdir(), "odw-perm-live-")));
  try {
    for (const live of [true, false]) {
      const runId = store.create({ script: "/x/wf.js", args: null, source: process.cwd(), workflowName: "demo" });
      store.updateStatus(runId, { state: "done", pid: process.pid, name: "demo" });
      store.writeResult(runId, "ok");
      const err = live ? new FakeTerm(200) : { chunks: [] as string[], isTTY: false, write(s: string) { this.chunks.push(s); } };
      const out = { write: () => {} };
      const banner = "permissions: read — claude read, kimi refused (no read mode)";
      assert.equal(await attachRun(store, runId, { out, err, live, signals: false, env: { TERM: "xterm" }, banner }), 0);
      if (err instanceof FakeTerm) {
        const screen = err.lines.join("\n");
        assert.match(screen, /demo .*\n .*\^C detaches.*\n  permissions: read — claude read, kimi refused \(no read mode\)\n/);
      } else {
        assert.equal(err.chunks[0], `${banner}\n`);
      }
    }
  } finally {
    rmSync(store.root, { recursive: true, force: true });
  }
});

test("odw doctor shows each adapter's supported tiers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-perm-doctor-"));
  try {
    const path = join(dir, "odw.config.json");
    const node = { command: [execPath, "-e", "", "{permission_args}"], permissionArgs: { read: [], edit: [] } };
    writeFileSync(path, JSON.stringify({ runsRoot: join(dir, "runs"), adapters: { node, bare: { command: [execPath] } } }));
    const report = await runDoctor({ config: loadConfig(path, { quiet: true }), configPath: path, cwd: dir, smoke: [] });
    const check = (id: string) => report.checks.find((c) => c.id === id)!;
    assert.match(check("adapter:node").detail, / · tiers: read, edit · untrusted: no way declared$/);
    assert.deepEqual(check("adapter:node").tiers, ["read", "edit"]);
    assert.match(check("adapter:bare").detail, / · tiers: none declared \(runs as configured\) · untrusted: no way declared$/);
    assert.deepEqual(check("adapter:kimi").tiers, ["edit"], "uninstalled ones too");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
