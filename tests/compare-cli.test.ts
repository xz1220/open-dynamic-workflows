import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";

import { main } from "../src/cli.js";
import { compareRuns, readCompareRun } from "../src/runtime/compare.js";
import { RunStore } from "../src/runtime/run-store.js";
import { startServer } from "../src/runtime/server.js";
import { executeRun } from "../src/runtime/worker.js";
import { displayWidth } from "../src/tty.js";

// `odw compare <runA> <runB> [--json] [--agent]` and GET /api/compare over two
// real runs of one workflow: a reply edited, a verdict flipped, an agent that
// newly fails and one only the second run has.

const MOCK =
  "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{" +
  "if(d.includes('BREAK')){process.stderr.write('boom');process.exit(1)}" +
  "const j=d.match(/JUDGE-(\\w)/);" +
  "if(j){process.stdout.write(JSON.stringify(j[1]==='a'?{verdict:'pass',score:1}:{verdict:'fail',score:0.5}));return}" +
  "const v=(d.match(/PLAN (\\w)/)||[])[1]||'-';" +
  "process.stdout.write(['step one','step two '+v,'step three','step four'].join('\\n'))})";

const WORKFLOW = `export const meta = { name: 'cmp', description: 'compare me', phases: [{ title: 'Plan' }, { title: 'Work' }] }
phase('Plan')
const plan = await agent('PLAN ' + args.variant, { label: 'plan' })
phase('Work')
const verdict = await agent('JUDGE-' + args.variant, {
  label: 'judge',
  schema: { type: 'object', required: ['verdict'], properties: { verdict: { type: 'string' }, score: { type: 'number' } } },
})
let broke = null
try { await agent(args.variant === 'b' ? 'BREAK' : 'fine', { label: 'breaks' }) } catch (e) { broke = String(e) }
if (args.variant === 'b') await agent('one more', { label: 'extra' })
return { plan, verdict, broke }
`;

async function twoRuns(root: string): Promise<{ store: RunStore; a: string; b: string }> {
  const configPath = join(root, "odw.config.json");
  writeFileSync(configPath, JSON.stringify({ defaultAdapter: "mock", adapters: { mock: { command: [execPath, "-e", MOCK], stdin: "{prompt}" } } }));
  const script = join(root, "cmp.js");
  writeFileSync(script, WORKFLOW);
  const store = new RunStore(join(root, "runs"));
  const a = store.create({ script, args: { variant: "a" }, source: root, configPath });
  assert.equal(await executeRun(store.runDir(a)), "done");
  const b = store.create({ script, args: { variant: "b" }, source: root, configPath });
  assert.equal(await executeRun(store.runDir(b)), "done");
  return { store, a, b };
}

async function cli(argv: string[], tty = false): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  const wasTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  if (tty) Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
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
    if (tty) {
      if (wasTTY) Object.defineProperty(process.stdout, "isTTY", wasTTY);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
  }
}

/** Run `fn` with these environment variables (undefined: unset), then put them back. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("odw compare: a table that fits 100 columns, red and green on a terminal, plain under NO_COLOR", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-compare-cli-"));
  try {
    const { a, b } = await twoRuns(root);
    const colored = await withEnv({ FORCE_COLOR: undefined, NO_COLOR: undefined, TERM: "xterm-256color", COLORTERM: undefined }, () =>
      cli(["compare", a, b, "--runs-root", join(root, "runs")], true),
    );
    assert.equal(colored.code, 0, colored.err);
    const lines = plain(colored.out).trimEnd().split("\n");
    for (const line of lines) assert.ok(displayWidth(line) <= 100, `fits 100 columns (${displayWidth(line)}): ${line}`);
    assert.match(colored.out, /\x1b\[31m[^\n]*done→failed/, "a newly failed agent is red");
    const text = lines.join("\n");
    assert.match(text, new RegExp(`^A  ${a}  done`, "m"));
    assert.match(text, new RegExp(`^B  ${b}  done`, "m"));
    assert.match(text, /^ {2}args\s+\{"variant":"a"\} → \{"variant":"b"\}$/m);
    assert.match(text, /^RUN\s+A\s+B\s+Δ$/m);
    assert.match(text, /^ {2}failed\s+0\s+1\s+\+1$/m);
    assert.match(text, /^ Plan$/m);
    assert.match(text, /^ {2}plan\s+done\s+mock\s+\S+ \S+\s+\S+.*differs \+1 -1$/m);
    assert.match(text, /^ {2}judge\s+done\s+mock\s+.*differs: 2 paths$/m);
    assert.match(text, /^ {2}breaks\s+done→failed\s+mock/m);
    assert.match(text, /^ {2}extra\s+only in B/m);
    assert.match(colored.err, new RegExp(`odw compare ${a} ${b} --agent <label\\|id>`));

    const noColor = await withEnv({ FORCE_COLOR: undefined, NO_COLOR: "1", TERM: "xterm-256color" }, () =>
      cli(["compare", a, b, "--runs-root", join(root, "runs")], true),
    );
    assert.equal(noColor.code, 0);
    assert.doesNotMatch(noColor.out, /\x1b\[/, "NO_COLOR: no escape sequences");
    assert.equal(noColor.out, plain(colored.out), "the same table, uncoloured");
    const piped = await withEnv({ FORCE_COLOR: undefined, NO_COLOR: undefined }, () => cli(["compare", a, b, "--runs-root", join(root, "runs")]));
    assert.doesNotMatch(piped.out, /\x1b\[/, "not a terminal: no escape sequences");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("odw compare --json prints the comparison with its documented keys", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-compare-cli-"));
  try {
    const { store, a, b } = await twoRuns(root);
    const r = await cli(["compare", a, b, "--json", "--runs-root", join(root, "runs")]);
    assert.equal(r.code, 0, r.err);
    const cmp = JSON.parse(r.out);
    assert.deepEqual(cmp, JSON.parse(JSON.stringify(compareRuns(readCompareRun(store, a), readCompareRun(store, b)))));
    assert.deepEqual(Object.keys(cmp), ["version", "a", "b", "notes", "setup", "totals", "agents"]);
    assert.deepEqual([cmp.a.runId, cmp.b.runId, cmp.a.live, cmp.b.state], [a, b, false, "done"]);
    assert.match(cmp.a.odwVersion, /^\d+\.\d+\.\d+/);
    assert.match(cmp.a.sourceHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(cmp.notes, []);
    assert.deepEqual(cmp.setup, [{ field: "args", a: { variant: "a" }, b: { variant: "b" } }], "same source, settings and adapters");
    assert.deepEqual(
      cmp.agents.map((row: { label: string; match: string | null; outcome: string; reply: { status: string; kind: string | null } }) => [
        row.label,
        row.match,
        row.outcome,
        row.reply.status,
        row.reply.kind,
      ]),
      [
        ["plan", "label", "unchanged", "differs", "text"],
        ["judge", "label", "unchanged", "differs", "json"],
        ["breaks", "label", "newly-failed", "none", null],
        ["extra", null, "only-b", "none", null],
      ],
    );
    assert.deepEqual(cmp.agents[0].reply.diff, ["@@ -1,4 +1,4 @@", " step one", "-step two a", "+step two b", " step three", " step four"]);
    assert.deepEqual(cmp.agents[1].reply.paths, [
      { path: "$.verdict", op: "changed", a: '"pass"', b: '"fail"' },
      { path: "$.score", op: "changed", a: "1", b: "0.5" },
    ]);
    assert.equal(cmp.agents[2].b.failureReason, "exit");
    assert.deepEqual(cmp.totals.failed, { a: 0, b: 1, delta: 1 });
    assert.deepEqual(cmp.totals.agents, { a: 3, b: 4, delta: 1 });
    assert.equal(typeof cmp.totals.wallMs.delta, "number");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("odw compare --agent shows one agent's whole reply diff; ambiguous and unknown agents are errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-compare-cli-"));
  try {
    const { a, b } = await twoRuns(root);
    const runs = ["--runs-root", join(root, "runs")];
    const text = await cli(["compare", a, b, "--agent", "plan", ...runs]);
    assert.equal(text.code, 0, text.err);
    const out = plain(text.out);
    assert.match(out, /^agent plan {2}\(matched by label\)$/m);
    assert.match(out, /^ {2}A {2}#1 {2}done {2}mock/m);
    assert.match(out, /^reply: differs \(\+1 -1 lines\)$/m);
    assert.match(out, new RegExp(`^--- A ${a} #1\\n\\+\\+\\+ B ${b} #1\\n@@ -1,4 \\+1,4 @@\\n step one\\n-step two a\\n\\+step two b\\n step three\\n step four$`, "m"));

    const json = await cli(["compare", a, b, "--agent", "judge", ...runs]);
    assert.match(plain(json.out), /^ {2}\$\.verdict {2}"pass" → "fail"$/m);
    const row = JSON.parse((await cli(["compare", a, b, "--agent", "judge", "--json", ...runs])).out);
    assert.deepEqual([row.label, row.reply.kind, row.reply.changed, row.reply.truncated], ["judge", "json", 2, false]);

    // By id: A's agent with it, else B's.
    const byId = await cli(["compare", a, b, "--agent", "4", ...runs]);
    assert.match(plain(byId.out), /^agent extra {2}\(only in B\)$/m);
    assert.match(plain(byId.out), /^reply: none to compare/m);
    const failed = await cli(["compare", a, b, "--agent", "breaks", ...runs]);
    assert.match(plain(failed.out), /^ {6}\[exit\] .*adapter 'mock' exited with code 1: boom$/m);

    const missing = await cli(["compare", a, b, "--agent", "nobody", ...runs]);
    assert.equal(missing.code, 1);
    assert.match(missing.err, /neither run has an agent 'nobody'/);
    assert.equal((await cli(["compare", a, "no-such-run", ...runs])).code, 1);
    const usage = await cli(["compare", a, ...runs]);
    assert.equal(usage.code, 2);
    assert.match(usage.err, /usage: odw compare <runA> <runB>/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GET /api/compare serves the comparison read-only; bad ids are 400, missing runs 404", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-compare-api-"));
  const { store, a, b } = await twoRuns(root);
  const handle = await startServer({ store, port: 0, host: "127.0.0.1", claudeProjectsRoot: join(root, "none") });
  const get = (query: string) => fetch(`${handle.url}/api/compare${query}`);
  try {
    const res = await get(`?a=${a}&b=${b}`);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get("etag"));
    assert.deepEqual(await res.json(), JSON.parse(JSON.stringify(compareRuns(readCompareRun(store, a), readCompareRun(store, b)))));

    for (const query of ["", `?a=${a}`, `?b=${b}`, `?a=${a}&b=`, `?a=..&b=${b}`, `?a=.&b=${b}`, `?a=${a}&b=..%2F..%2Fetc`, `?a=${a}&b=x%20y`]) {
      const bad = await get(query);
      assert.equal(bad.status, 400, query);
      assert.deepEqual(await bad.json(), { error: "a and b must each be a run id: /api/compare?a=<run>&b=<run>" });
    }
    const missing = await get(`?a=${a}&b=no-such-run`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "no such run: no-such-run" });
    assert.equal((await get(`?a=cc-abc&b=${b}`)).status, 404, "Claude Code runs are not compared");
    const post = await fetch(`${handle.url}/api/compare?a=${a}&b=${b}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(post.status, 404, "read-only");
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});
