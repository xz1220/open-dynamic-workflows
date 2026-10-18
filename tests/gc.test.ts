import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { loadConfig } from "../src/adapters/config.js";
import { main } from "../src/cli.js";
import { diskCheck } from "../src/doctor.js";
import { parseAge } from "../src/runtime/gc-cli.js";
import { GC_FILE, PIN_FILE, applyGc, orphanedWorktreesOf, pinRun, planGc, readPin, readTrimmed, scanWorktrees } from "../src/runtime/gc.js";
import { OdwRunSource } from "../src/runtime/odw-run-source.js";
import { RunStore } from "../src/runtime/run-store.js";
import { executeRun } from "../src/runtime/worker.js";
import { OWNER_FILE, withWorkspace } from "../src/workspace.js";

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

function commit(dir: string, message: string): void {
  git(dir, "add", "-A");
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--no-gpg-sign", "-m", message);
}

/** A one-commit repository, by its real path (macOS /var is /private/var). */
function makeRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "odw-gc-src-")));
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, "init", "-q");
  commit(dir, "init");
  return dir;
}

/** A pid that was a process and is one no more. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  return child.pid!;
}

/** An isolated agent's worktree as odw makes it — `<tmpRoot>/odw-wt-XXXXXX/<repo>` — with an owner file unless `owner` is null. */
function fakeWorktree(repo: string, tmpRoot: string, owner: { pid: number; run?: string | null } | null): { dir: string; work: string } {
  const dir = mkdtempSync(join(tmpRoot, "odw-wt-"));
  const work = join(dir, basename(repo));
  if (owner) writeFileSync(join(dir, OWNER_FILE), JSON.stringify({ pid: owner.pid, run: owner.run ?? null, repo, at: 0 }));
  git(repo, "worktree", "add", "-q", "--detach", work, "HEAD");
  return { dir, work };
}

function registered(repo: string): string[] {
  return git(repo, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length))
    .filter((p) => p !== repo);
}

/** A finished run of `source` in `store`, `daysAgo` since its last activity. */
function endedRun(store: RunStore, source: string, daysAgo: number, state = "done"): string {
  const script = join(store.root, "wf.js");
  writeFileSync(script, "export const meta = { name: 'w', description: 'd' }\nreturn 1");
  const runId = store.create({ script, args: null, source, workflowName: "w" });
  store.updateStatus(runId, { state });
  const status = JSON.parse(readFileSync(join(store.runDir(runId), "status.json"), "utf8"));
  writeFileSync(join(store.runDir(runId), "status.json"), JSON.stringify({ ...status, updatedAt: Date.now() / 1000 - daysAgo * 86_400 }));
  return runId;
}

function scratch(): { tmpRoot: string; runsRoot: string; store: RunStore; cleanup: () => void } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "odw-gc-")));
  const tmpRoot = join(base, "tmp");
  const runsRoot = join(base, "runs");
  mkdirSync(tmpRoot);
  mkdirSync(runsRoot);
  return { tmpRoot, runsRoot, store: new RunStore(runsRoot), cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test("an isolated agent's worktree names its owner beside it: the process, the run and the repository", async () => {
  const repo = makeRepo();
  try {
    const owner = await withWorkspace(repo, "worktree", async (ws) => JSON.parse(readFileSync(join(dirname(ws.path), OWNER_FILE), "utf8")), {
      owner: "20260101-000000-abcdef",
    });
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.run, "20260101-000000-abcdef");
    assert.equal(owner.repo, repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a worktree whose process is gone is an orphan; a live one, a recent unowned one and a stranger's directory are not", async () => {
  const repo = makeRepo();
  const { tmpRoot, store, cleanup } = scratch();
  try {
    const dead = fakeWorktree(repo, tmpRoot, { pid: deadPid(), run: "20260101-000000-aaaaaa" });
    const live = fakeWorktree(repo, tmpRoot, { pid: process.pid });
    const unowned = fakeWorktree(repo, tmpRoot, null);
    const stale = fakeWorktree(repo, tmpRoot, null);
    const old = Date.now() / 1000 - 2 * 86_400;
    utimesSync(stale.dir, old, old);
    // Not a worktree at all — a test's scratch directory of the same shape.
    mkdirSync(join(mkdtempSync(join(tmpRoot, "odw-wt-")), "runs"));

    const found = await scanWorktrees({ tmpRoot, store });
    const by = (dir: string) => found.find((f) => f.dir === dir);
    assert.equal(found.length, 4, "the stranger's directory is not looked at");
    assert.equal(by(dead.dir)?.orphan, true);
    assert.match(by(dead.dir)!.why, /process \d+ is gone \(run 20260101-000000-aaaaaa\)/);
    assert.equal(by(dead.dir)?.registered, true);
    assert.equal(by(dead.dir)?.repo, repo);
    assert.ok(by(dead.dir)!.bytes > 0, "an orphan is measured");
    assert.equal(by(live.dir)?.orphan, false);
    assert.match(by(live.dir)!.why, /in use by process/);
    assert.equal(by(unowned.dir)?.orphan, false);
    assert.equal(by(stale.dir)?.orphan, true);

    // The worker's look: this repository's registrations only, no walk of the trees.
    const orphans = await orphanedWorktreesOf(repo, store);
    assert.deepEqual(orphans.map((o) => o.dir).sort(), [dead.dir, stale.dir].sort());
    assert.ok(orphans.every((o) => o.bytes === 0));
  } finally {
    cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("odw gc reports by default and removes orphaned worktrees only with --yes; a pinned run's and a live one's stay", async () => {
  const repo = makeRepo();
  const { tmpRoot, store, cleanup } = scratch();
  try {
    const pinnedRun = endedRun(store, repo, 0);
    pinRun(store.runDir(pinnedRun), "cli:test");
    const dead = fakeWorktree(repo, tmpRoot, { pid: deadPid() });
    const pinned = fakeWorktree(repo, tmpRoot, { pid: deadPid(), run: pinnedRun });
    const live = fakeWorktree(repo, tmpRoot, { pid: process.pid });
    // A registration whose directory someone already deleted.
    const gone = fakeWorktree(repo, tmpRoot, { pid: deadPid() });
    rmSync(gone.dir, { recursive: true, force: true });

    const plan = await planGc({ store, olderThanDays: 30, transcripts: true, repos: [repo], tmpRoot });
    const orphans = plan.worktrees.filter((w) => w.orphan).map((w) => w.dir).sort();
    assert.deepEqual(orphans, [dead.dir, gone.dir].sort());
    assert.equal(plan.worktrees.find((w) => w.dir === pinned.dir)?.pinned, true);
    assert.equal(registered(repo).length, 4, "planning removes nothing");

    const result = await applyGc(plan, { store });
    assert.deepEqual(result.errors, []);
    assert.equal(result.worktrees, 2);
    assert.equal(existsSync(dead.dir), false);
    assert.ok(existsSync(pinned.dir) && existsSync(live.dir));
    assert.deepEqual(registered(repo).sort(), [pinned.work, live.work].sort());
  } finally {
    cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("keep branches go when HEAD holds their change or their run is past retention; others, and unknown runs', stay", async () => {
  const repo = makeRepo();
  const { tmpRoot, store, cleanup } = scratch();
  try {
    const young = endedRun(store, repo, 1);
    const old = endedRun(store, repo, 40);
    const pinned = endedRun(store, repo, 40);
    pinRun(store.runDir(pinned), null);
    // A change committed on a side branch, then committed on HEAD too (as odw apply + git commit leave it).
    const branchAt = (name: string, file: string, applied: boolean) => {
      git(repo, "switch", "-q", "-c", name);
      writeFileSync(join(repo, file), `${file}\n`);
      commit(repo, file);
      git(repo, "switch", "-q", "-");
      if (applied) {
        writeFileSync(join(repo, file), `${file}\n`);
        commit(repo, `apply ${file}`);
      }
    };
    branchAt(`odw/${young}/1-applied`, "b.txt", true);
    branchAt(`odw/${young}/2-open`, "c.txt", false);
    branchAt(`odw/${old}/1-expired`, "d.txt", false);
    branchAt(`odw/${pinned}/1-kept`, "e.txt", false);
    branchAt(`odw/20990101-000000-zzzzzz/1-elsewhere`, "f.txt", false);
    git(repo, "branch", "mine");

    const plan = await planGc({ store, olderThanDays: 30, transcripts: true, repos: [repo], tmpRoot });
    const got = plan.branches.candidates.map((c) => `${c.branch}:${c.reason}`).sort();
    assert.deepEqual(got, [`odw/${old}/1-expired:expired`, `odw/${young}/1-applied:applied`].sort());
    assert.deepEqual(plan.branches.unknown.map((u) => u.branch), ["odw/20990101-000000-zzzzzz/1-elsewhere"]);
    assert.equal(plan.branches.kept, 1);

    const result = await applyGc(plan, { store });
    assert.deepEqual(result.errors, []);
    assert.equal(result.branches, 2);
    const left = git(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/").split("\n").filter(Boolean).sort();
    assert.deepEqual(left, ["mine", `odw/${young}/2-open`, `odw/${pinned}/1-kept`, "odw/20990101-000000-zzzzzz/1-elsewhere", git(repo, "branch", "--show-current").trim()].sort());
  } finally {
    cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("an expired run has its transcripts and stderr trimmed — and nothing else; active, pinned and young runs are skipped", async () => {
  const { tmpRoot, store, cleanup } = scratch();
  try {
    const withFiles = (runId: string) => {
      const agents = join(store.runDir(runId), "agents");
      mkdirSync(agents, { recursive: true });
      writeFileSync(join(agents, "0.json"), "{}");
      writeFileSync(join(agents, "0.diff"), "diff\n");
      writeFileSync(join(agents, "0.transcript.jsonl"), "x".repeat(1000));
      writeFileSync(join(agents, "0.stderr.txt"), "y".repeat(100));
    };
    const old = endedRun(store, tmpRoot, 40);
    const young = endedRun(store, tmpRoot, 3);
    const pinned = endedRun(store, tmpRoot, 40);
    pinRun(store.runDir(pinned), null);
    const running = endedRun(store, tmpRoot, 40, "running");
    store.updateStatus(running, { pid: process.pid });
    for (const id of [old, young, pinned, running]) withFiles(id);

    const plan = await planGc({ store, olderThanDays: 30, transcripts: true, tmpRoot });
    assert.deepEqual(plan.runs.map((r) => r.runId), [old]);
    assert.equal(plan.runs[0]!.bytes, 1100);
    assert.deepEqual(plan.skipped.pinned, [pinned]);
    assert.deepEqual(plan.skipped.active, [running]);

    // retention.transcripts false: nothing of a run is trimmed.
    assert.deepEqual((await planGc({ store, olderThanDays: 30, transcripts: false, tmpRoot })).runs, []);

    const result = await applyGc(plan, { store });
    assert.equal(result.runs, 1);
    assert.equal(result.bytes, 1100);
    const agents = join(store.runDir(old), "agents");
    assert.equal(existsSync(join(agents, "0.transcript.jsonl")), false);
    assert.equal(existsSync(join(agents, "0.stderr.txt")), false);
    assert.ok(existsSync(join(agents, "0.json")) && existsSync(join(agents, "0.diff")), "results and diffs stay");
    assert.ok(existsSync(join(store.runDir(old), "meta.json")) && existsSync(join(store.runDir(old), "status.json")));
    assert.equal(readTrimmed(store.runDir(old))?.files, 2);
    assert.deepEqual(JSON.parse(readFileSync(join(store.runDir(old), GC_FILE), "utf8")).trimmed.sort(), ["0.stderr.txt", "0.transcript.jsonl"]);
    assert.ok(existsSync(join(store.runDir(young), "agents", "0.transcript.jsonl")));
    assert.ok(existsSync(join(store.runDir(pinned), "agents", "0.transcript.jsonl")));

    // The dashboard's detail says so, as it does a pin.
    const source = new OdwRunSource(store);
    assert.equal(source.detail(old)?.trimmed?.files, 2);
    assert.equal(source.detail(pinned)?.pinned?.by, null);
    assert.equal(source.detail(young)?.pinned, undefined);
  } finally {
    cleanup();
  }
});

test("odw gc: dry run by default, --yes deletes, --json, and usage errors", async () => {
  const { tmpRoot, runsRoot, store, cleanup } = scratch();
  const writes: string[] = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  const capture = () => {
    writes.length = 0;
    process.stdout.write = ((chunk: string) => (writes.push(String(chunk)), true)) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => (writes.push(String(chunk)), true)) as typeof process.stderr.write;
  };
  const restore = () => {
    process.stdout.write = out;
    process.stderr.write = err;
  };
  try {
    const old = endedRun(store, tmpRoot, 40);
    mkdirSync(join(store.runDir(old), "agents"));
    writeFileSync(join(store.runDir(old), "agents", "0.transcript.jsonl"), "x");
    const transcript = join(store.runDir(old), "agents", "0.transcript.jsonl");

    capture();
    let code = await main(["gc", "--runs-root", runsRoot, "--source", tmpRoot]);
    restore();
    assert.equal(code, 0);
    assert.match(writes.join(""), /dry run — nothing is deleted/);
    assert.match(writes.join(""), new RegExp(`${old}.*1 file`));
    assert.match(writes.join(""), /odw gc --yes/);
    assert.ok(existsSync(transcript));

    capture();
    code = await main(["gc", "--runs-root", runsRoot, "--source", tmpRoot, "--json", "--older-than", "50d"]);
    restore();
    assert.equal(code, 0);
    const json = JSON.parse(writes.join(""));
    assert.equal(json.dryRun, true);
    assert.equal(json.olderThanDays, 50);
    assert.deepEqual(json.runs, []);

    capture();
    code = await main(["gc", "--runs-root", runsRoot, "--source", tmpRoot, "--yes", "--json"]);
    restore();
    assert.equal(code, 0);
    assert.equal(JSON.parse(writes.join("")).removed.runs, 1);
    assert.equal(existsSync(transcript), false);

    capture();
    assert.equal(await main(["gc", "--runs-root", runsRoot, "--yes", "--dry-run"]), 2);
    assert.equal(await main(["gc", "--runs-root", runsRoot, "--older-than", "soon"]), 2);
    restore();
  } finally {
    restore();
    cleanup();
  }
});

test("odw pin marks a run, lists the pinned ones, and --remove unpins it", async () => {
  const { tmpRoot, runsRoot, store, cleanup } = scratch();
  const writes: string[] = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  try {
    const runId = endedRun(store, tmpRoot, 40);
    process.stdout.write = ((chunk: string) => (writes.push(String(chunk)), true)) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => (writes.push(String(chunk)), true)) as typeof process.stderr.write;
    assert.equal(await main(["pin", runId, "--runs-root", runsRoot]), 0);
    assert.ok(existsSync(join(store.runDir(runId), PIN_FILE)));
    assert.match(readPin(store.runDir(runId))!.by ?? "", /^cli/);
    writes.length = 0;
    assert.equal(await main(["pin", "--runs-root", runsRoot, "--json"]), 0);
    assert.equal(JSON.parse(writes.join(""))[0].runId, runId);
    assert.equal(await main(["pin", runId, "--remove", "--runs-root", runsRoot]), 0);
    assert.equal(readPin(store.runDir(runId)), null);
    assert.equal(await main(["pin", "../etc", "--runs-root", runsRoot]), 2);
    assert.equal(await main(["pin", "20990101-000000-nonexx", "--runs-root", runsRoot]), 1);
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
    cleanup();
  }
});

test("--older-than takes hours, days and weeks", () => {
  assert.equal(parseAge("30d"), 30);
  assert.equal(parseAge("12h"), 0.5);
  assert.equal(parseAge("2w"), 14);
  assert.equal(parseAge("7"), 7);
  assert.equal(parseAge("0d"), null);
  assert.equal(parseAge("soon"), null);
});

test("retention: defaults, overrides, and a malformed value is a config error", () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-gc-cfg-"));
  try {
    const at = (body: unknown) => {
      const path = join(dir, "odw.config.json");
      writeFileSync(path, JSON.stringify(body));
      return () => loadConfig(path, { quiet: true }).settings.retention;
    };
    assert.deepEqual(at({})(), { days: 30, transcripts: true });
    assert.deepEqual(at({ retention: { days: 7 } })(), { days: 7, transcripts: true });
    assert.deepEqual(at({ retention: { transcripts: false } })(), { days: 30, transcripts: false });
    assert.throws(at({ retention: { days: 0 } }), /retention\.days/);
    assert.throws(at({ retention: { days: 7, keep: 1 } }), /unknown key 'keep'/);
    assert.throws(at({ retention: 7 }), /"retention" must be/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor's disk line counts orphaned worktrees and points at odw gc", async () => {
  const repo = makeRepo();
  const { tmpRoot, runsRoot, cleanup } = scratch();
  try {
    assert.equal((await diskCheck(runsRoot, repo, tmpRoot)).status, "ok");
    fakeWorktree(repo, tmpRoot, { pid: deadPid() });
    const check = await diskCheck(runsRoot, repo, tmpRoot);
    assert.equal(check.status, "warn");
    assert.match(check.detail, /1 orphaned worktree/);
    assert.match(check.hint ?? "", /odw gc --yes/);
  } finally {
    cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a worker starting in a repository with orphaned worktrees says so once in the run's log", async () => {
  const repo = makeRepo();
  const { tmpRoot, store, cleanup } = scratch();
  try {
    fakeWorktree(repo, tmpRoot, { pid: deadPid() });
    const script = join(tmpRoot, "wf.js");
    writeFileSync(script, "export const meta = { name: 'g', description: 'd' }\nreturn 1");
    const id = store.create({ script, args: null, source: repo });
    assert.equal(await executeRun(store.runDir(id)), "done");
    const said = store.readEvents(id).filter((e) => e.type === "log" && /orphaned odw worktree/.test(String(e.message)));
    assert.equal(said.length, 1);
    assert.match(String(said[0]!.message), /1 orphaned odw worktree\(s\).*odw gc --yes/);
    assert.equal(registered(repo).length, 1, "the worker only looks");

    // A clean repository: nothing said.
    const clean = makeRepo();
    try {
      const id2 = store.create({ script, args: null, source: clean });
      await executeRun(store.runDir(id2));
      assert.equal(store.readEvents(id2).filter((e) => /orphaned odw worktree/.test(String(e.message ?? ""))).length, 0);
    } finally {
      rmSync(clean, { recursive: true, force: true });
    }
  } finally {
    cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});
