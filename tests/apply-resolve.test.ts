import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execPath } from "node:process";
import { PassThrough } from "node:stream";

import { captureChanges } from "../src/changes.js";
import { main } from "../src/cli.js";
import { applyAgents } from "../src/runtime/apply.js";
import { resolverRuns } from "../src/runtime/apply-resolve.js";
import { changedAgents } from "../src/runtime/changes-view.js";
import { agentRows } from "../src/runtime/agents-view.js";
import { detail } from "../src/runtime/runs-view.js";
import { RunStore } from "../src/runtime/run-store.js";

// odw apply --resolve (ODW extension): a conflict goes to a resolver agent —
// a real run of a mock CLI, in a temporary worktree — whose change is
// checked (only the conflicting files, no markers), verified there, and only
// then applied; the resolver run is linked from the run being applied.

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

const commit = (dir: string, message: string): string =>
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--no-gpg-sign", "-m", message);

/** `n` numbered lines, with some of them replaced. */
const lines = (n: number, change: Record<number, string> = {}): string =>
  Array.from({ length: n }, (_, i) => change[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";

async function cli(argv: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  (process.stdout as { write: unknown }).write = (s: unknown) => {
    out.push(String(s));
    return true;
  };
  (process.stderr as { write: unknown }).write = (s: unknown) => {
    err.push(String(s));
    return true;
  };
  const home = process.cwd();
  process.chdir(cwd);
  try {
    const code = await main(argv);
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    process.chdir(home);
    process.stdout.write = so;
    process.stderr.write = se;
  }
}

/** What the mock resolver does: writes these files in its workspace (relative paths), and its prompt to `prompt`. */
interface Plan {
  writes: Record<string, string>;
  prompt: string;
}

/** A mock CLI: reads its prompt, keeps it, writes the plan's files where it runs, replies. */
const RESOLVER =
  "const fs=require('fs');let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{" +
  "const p=JSON.parse(process.argv[1]);fs.writeFileSync(p.prompt,d);" +
  "for(const [f,c] of Object.entries(p.writes))fs.writeFileSync(f,c);" +
  "process.stdout.write('merged both sides')})";

interface Fixture {
  root: string;
  repo: string;
  store: RunStore;
  runId: string;
  flags: string[];
  prompt: string;
}

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * A repository holding `files`, a run whose isolated agents made `edits` in
 * worktrees of that commit (kept as diffs), then a commit of `user` on top —
 * the user's own change, that the agents' may conflict with. The config's
 * default adapter is the mock resolver, following `plan`.
 */
async function setup(files: Record<string, string>, edits: Array<Record<string, string>>, user: Record<string, string>, plan: Omit<Plan, "prompt">): Promise<Fixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "odw-resolve-")));
  roots.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q");
  for (const [path, data] of Object.entries(files)) writeFileSync(join(repo, path), data);
  git(repo, "add", "-A");
  commit(repo, "init");
  const base = git(repo, "rev-parse", "HEAD").trim();
  const store = new RunStore(join(root, "runs"));
  const runId = store.create({ script: join(root, "wf.js"), args: null, source: repo });
  store.updateStatus(runId, { state: "done", name: "wf" });
  for (const [i, edit] of edits.entries()) {
    const agentId = i + 1;
    const work = join(root, `wt-${agentId}`);
    git(repo, "worktree", "add", "-q", "--detach", work, base);
    for (const [path, data] of Object.entries(edit)) writeFileSync(join(work, path), data);
    const diff = store.agentDiffPath(runId, agentId);
    mkdirSync(dirname(diff), { recursive: true });
    const scratch = mkdtempSync(join(root, "scratch-"));
    const kept = await captureChanges({ top: repo, work, base, scratch }, { paths: new Map(), ignoredDirs: [] }, { path: diff, maxDiffBytes: 1 << 21 });
    git(repo, "worktree", "remove", "--force", work);
    const fields = { agentId, label: `edit-${agentId}`, phase: null, adapter: "edit" };
    appendFileSync(store.eventsPath(runId), JSON.stringify({ ts: agentId * 10, type: "agent_started", ...fields }) + "\n");
    appendFileSync(store.eventsPath(runId), JSON.stringify({ ts: agentId * 10 + 5, type: "agent_finished", attempts: 1, changes: kept?.changes ?? null, ...fields }) + "\n");
  }
  for (const [path, data] of Object.entries(user)) writeFileSync(join(repo, path), data);
  git(repo, "add", "-A");
  commit(repo, "user");
  const prompt = join(root, "prompt.txt");
  const configPath = join(root, "odw.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      defaultAdapter: "fix",
      adapters: { fix: { command: [execPath, "-e", RESOLVER, JSON.stringify({ ...plan, prompt })], stdin: "{prompt}" } },
    }),
  );
  return { root, repo, store, runId, flags: ["--runs-root", store.root, "--config", configPath], prompt };
}

/** The common shape: the agent changed line 1 of c.txt (and a.txt cleanly); the user changed line 1 of c.txt too. */
function conflicting(plan: Omit<Plan, "prompt">): Promise<Fixture> {
  return setup(
    { "a.txt": lines(5), "c.txt": lines(5), "other.txt": "other\n" },
    [{ "a.txt": lines(5, { 5: "FIVE" }), "c.txt": lines(5, { 1: "agent one" }) }],
    { "c.txt": lines(5, { 1: "user one" }) },
    plan,
  );
}

const MERGED = lines(5, { 1: "user one, agent one" });

/** The resolver run `odw apply` named. */
function resolverOf(out: string): string {
  const m = /resolving the conflicts of agent 1 \(edit-1\) with an agent: run (\S+)\n/.exec(out);
  assert.ok(m, `no resolver run in:\n${out}`);
  return m[1]!;
}

test("--resolve: a conflict resolved and verified in a temporary worktree is applied, with the agent's clean files", async () => {
  const fx = await conflicting({ writes: { "c.txt": MERGED } });
  const r = await cli(["apply", fx.runId, "--all", "--resolve", "--verify", "grep -q 'user one, agent one' c.txt && grep -q FIVE a.txt", ...fx.flags], fx.repo);
  assert.equal(r.code, 0, r.err);
  const resolver = resolverOf(r.out);
  assert.match(r.out, /CONFLICT/);
  assert.match(r.out, /verified the resolution of agent 1 \(edit-1\): `grep -q .*` passed in/);
  assert.match(r.out, new RegExp(`applied agent 1 \\(edit-1\\) to \\S+ with its conflicts resolved by run ${resolver} \\(staged\\)`));
  assert.equal(readFileSync(join(fx.repo, "c.txt"), "utf8"), MERGED);
  assert.equal(readFileSync(join(fx.repo, "a.txt"), "utf8"), lines(5, { 5: "FIVE" }));
  assert.equal(git(fx.repo, "status", "--porcelain"), "M  a.txt\nM  c.txt\n");
  assert.equal(git(fx.repo, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1, "the temporary worktrees are gone");

  // The resolver was told the base, both sides and the conflicting lines.
  const prompt = readFileSync(fx.prompt, "utf8");
  assert.match(prompt, /=== c\.txt ===\n--- BASE \(before either change\) ---\nline 1\n/);
  assert.match(prompt, /--- OURS \(what the file holds now\) ---\nuser one\n/);
  assert.match(prompt, /--- THEIRS \(the other agent's version\) ---\nagent one\n/);
  assert.match(prompt, /<<<<<<< ours\nuser one\n=======\nagent one\n>>>>>>> theirs/);
  assert.match(prompt, /edit only these files/);
});

test("--resolve: the resolver run is a real run, linked both ways, that odw diff works on", async () => {
  const fx = await conflicting({ writes: { "c.txt": MERGED } });
  const r = await cli(["apply", fx.runId, "--agent", "edit-1", "--resolve", "--no-verify", ...fx.flags], fx.repo);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /no verify command .*checked for its files and conflict markers only/);
  const resolver = resolverOf(r.out);

  const meta = fx.store.readMeta(resolver);
  assert.equal(meta.origin, "apply-resolve");
  assert.deepEqual(meta.applyResolve, { runId: fx.runId, agentId: 1 });
  assert.equal(fx.store.readStatus(resolver).state, "done");
  assert.deepEqual(fx.store.readMeta(fx.runId).resolvedBy, [{ runId: resolver, agentId: 1 }]);
  const settled = fx.store.readEvents(fx.runId).filter((e) => e.type === "apply_resolved");
  assert.deepEqual(
    settled.map(({ agentId, resolverRunId, outcome, why }) => ({ agentId, resolverRunId, outcome, why })),
    [{ agentId: 1, resolverRunId: resolver, outcome: "applied", why: null }],
  );
  // The dashboard's detail carries the links.
  assert.deepEqual(detail(fx.store, resolver).applyResolve, { runId: fx.runId, agentId: 1 });
  assert.deepEqual(detail(fx.store, fx.runId).resolvedBy, [{ runId: resolver, agentId: 1 }]);

  // Its agent kept the resolution as its diff: odw diff shows it.
  const kept = changedAgents(fx.store, resolver, agentRows(fx.store, resolver));
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.row.label, "resolve:edit-1");
  const diff = await cli(["diff", resolver, ...fx.flags], fx.repo);
  assert.equal(diff.code, 0);
  assert.match(diff.out, /^-user one\n\+user one, agent one$/m);
  assert.doesNotMatch(diff.out, /a\.txt/, "the agent's clean files are the base it started from, not its change");
});

test("--resolve: a resolution that leaves conflict markers is refused, and nothing is applied", async () => {
  const fx = await conflicting({ writes: { "c.txt": "<<<<<<< ours\nuser one\n=======\nagent one\n>>>>>>> theirs\n" + lines(5).split("\n").slice(1).join("\n") } });
  const head = git(fx.repo, "rev-parse", "HEAD");
  const r = await cli(["apply", fx.runId, "--all", "--resolve", "--verify", "true", ...fx.flags], fx.repo);
  assert.equal(r.code, 1);
  const resolver = resolverOf(r.out);
  assert.match(r.err, new RegExp(`its resolution \\(run ${resolver}\\) was refused — it left conflict markers in c\\.txt \\(line 1\\)`));
  assert.match(r.out, /not applied: agent 1 \(edit-1\)/);
  assert.equal(git(fx.repo, "status", "--porcelain"), "", "the tree is as it was");
  assert.equal(git(fx.repo, "rev-parse", "HEAD"), head);
  const settled = fx.store.readEvents(fx.runId).find((e) => e.type === "apply_resolved");
  assert.equal(settled?.outcome, "refused");
  assert.match(String(settled?.why), /conflict markers/);
});

test("--resolve: a resolution that touches other files is refused", async () => {
  const fx = await conflicting({ writes: { "c.txt": MERGED, "other.txt": "changed too\n", "new.txt": "new\n" } });
  const r = await cli(["apply", fx.runId, "--all", "--resolve", "--verify", "true", ...fx.flags], fx.repo);
  assert.equal(r.code, 1);
  assert.match(r.err, /was refused — it may only edit the conflicting files \(c\.txt\), and it changed (new\.txt \(added\), other\.txt|other\.txt, new\.txt \(added\))/);
  assert.equal(git(fx.repo, "status", "--porcelain"), "");
  assert.equal(readFileSync(join(fx.repo, "other.txt"), "utf8"), "other\n");
  assert.equal(existsSync(join(fx.repo, "new.txt")), false);
});

test("--resolve: a resolution whose verify fails is not applied, and the tree is as it was", async () => {
  const fx = await conflicting({ writes: { "c.txt": MERGED } });
  const r = await cli(["apply", fx.runId, "--all", "--resolve", "--verify", "echo 'tests failed: 2' >&2; exit 2", ...fx.flags], fx.repo);
  assert.equal(r.code, 1);
  assert.match(r.err, /verifying the resolution of agent 1 \(edit-1\) in a temporary worktree: echo/);
  assert.match(r.err, /was refused — `echo .*` exited with code 2 after \d+\.\ds; the end of its output:\n {2}tests failed: 2\n/);
  assert.equal(git(fx.repo, "status", "--porcelain"), "");
  assert.equal(readFileSync(join(fx.repo, "c.txt"), "utf8"), lines(5, { 1: "user one" }));
});

test("--resolve: the agents after a resolved one are previewed again on top of it, and applied", async () => {
  const fx = await setup(
    { "a.txt": lines(5), "c.txt": lines(5) },
    [{ "c.txt": lines(5, { 1: "agent one" }) }, { "a.txt": lines(5, { 2: "TWO" }) }],
    { "c.txt": lines(5, { 1: "user one" }) },
    { writes: { "c.txt": MERGED } },
  );
  const r = await cli(["apply", fx.runId, "--all", "--resolve", "--verify", "true", ...fx.flags], fx.repo);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /previewing the 1 agent\(s\) after it again, on top of its resolution:\nagent 2 \(edit-2\) applies cleanly:/);
  assert.match(r.out, /applied to \S+ \(staged, as git apply --3way does\): agent 1 \(edit-1\), agent 2 \(edit-2\)\n/);
  assert.equal(git(fx.repo, "status", "--porcelain"), "M  a.txt\nM  c.txt\n");
});

test("--resolve: refuses --force and --check, and the flags that go with it need it", async () => {
  const fx = await conflicting({ writes: { "c.txt": MERGED } });
  for (const [argv, said] of [
    [["--all", "--resolve", "--force"], /--resolve does not apply over uncommitted changes/],
    [["--all", "--resolve", "--check"], /--resolve applies; --check previews only/],
    [["--all", "--confirm"], /--confirm goes with --resolve/],
    [["--all", "--adapter", "fix"], /--adapter goes with --resolve/],
    [["--resolve"], /--agent <id\|label> or --all is required/],
  ] as const) {
    const r = await cli(["apply", fx.runId, ...argv, ...fx.flags], fx.repo);
    assert.equal(r.code, 2, argv.join(" "));
    assert.match(r.err, said);
  }
  // A dirty path in the way: refused as ever, before any resolver runs.
  writeFileSync(join(fx.repo, "c.txt"), "dirty\n");
  const dirty = await cli(["apply", fx.runId, "--all", "--resolve", ...fx.flags], fx.repo);
  assert.equal(dirty.code, 1);
  assert.match(dirty.err, /uncommitted changes in the way/);
  assert.equal(fx.store.listRunIds().length, 1, "no resolver run started");
});

test("--resolve --confirm shows the resolved diff and applies it only on y, at a terminal", async () => {
  for (const answer of ["n", "y", null] as const) {
    const fx = await conflicting({ writes: { "c.txt": MERGED } });
    const out: string[] = [];
    const err: string[] = [];
    const input = new PassThrough() as PassThrough & { isTTY?: boolean };
    if (answer !== null) input.isTTY = true;
    const asked = new Promise<void>((done) => {
      const writer = {
        write: (s: string) => {
          err.push(s);
          if (s.includes("[y/N]")) done();
          return true;
        },
      };
      void run(writer);
    });
    let code: number | undefined;
    async function run(errWriter: { write(s: string): unknown }): Promise<void> {
      const rows = agentRows(fx.store, fx.runId);
      code = await applyAgents({
        cwd: fx.repo,
        runId: fx.runId,
        agents: changedAgents(fx.store, fx.runId, rows),
        all: true,
        check: false,
        force: false,
        verify: "true",
        timeout: null,
        resolve: { ...resolverRuns({ store: fx.store, runId: fx.runId, configPath: fx.flags[3]!, adapter: null }), confirm: true, input },
        out: { write: (s: string) => out.push(s) },
        err: errWriter,
        caps: { color: false, truecolor: false, unicode: false },
        width: 120,
      });
    }
    if (answer !== null) {
      await asked;
      input.write(`${answer}\n`);
    }
    while (code === undefined) await new Promise((done) => setTimeout(done, 20));
    const text = out.join("");
    if (answer === "y") {
      assert.equal(code, 0, err.join(""));
      assert.match(text, /the resolution of agent 1 \(edit-1\) \(run \S+\):\n(?: {2}.*\n)*? {2}-user one\n {2}\+user one, agent one\n/);
      assert.equal(readFileSync(join(fx.repo, "c.txt"), "utf8"), MERGED);
    } else {
      assert.equal(code, 1);
      assert.equal(git(fx.repo, "status", "--porcelain"), "");
      const why = answer === "n" ? /was not confirmed/ : /--confirm needs a terminal to ask on/;
      assert.match(err.join(""), why);
      assert.equal(fx.store.readEvents(fx.runId).find((e) => e.type === "apply_resolved")?.outcome, "declined");
    }
  }
});
