import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import { RunStore, TERMINAL_STATES } from "../src/runtime/run-store.js";
import { parseSshTarget, shQuote, sshArgv, takeOnFlag } from "../src/runtime/remote.js";
import { cli, pendingIds, stopProcessRun, until } from "./checkpoint-project.js";

// odw run --on ssh://host, odw pull and the status/logs/attach pass-through
// (ODW extension), end to end with a fake ssh that runs the remote command
// here in a temp "remote home", and a fake rsync: the remote odw is this
// repository's CLI, so a real detached run starts, waits, finishes and is
// pulled back.

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const FAKE_SSH = fileURLToPath(new URL("./fixtures/fake-ssh.mjs", import.meta.url));
const FAKE_RSYNC = fileURLToPath(new URL("./fixtures/fake-rsync.mjs", import.meta.url));

const WAITING_WF =
  "export const meta = { name: 'remote-demo', description: 'waits for a go, then answers' }\n" +
  "const ok = await checkpoint('Go on?')\n" +
  "return { ok: ok.approved, got: args }\n";
const FAST_WF = "export const meta = { name: 'remote-fast', description: 'answers at once' }\nreturn { got: args }\n";

let base: string;
let home: string; // the remote's home
let bin: string; // the remote's PATH: odw and the tools a workdir needs
let bareBin: string; // the same without odw
let project: string; // the local project
let localRuns: string;
const remoteRuns = () => join(home, ".odw", "runs");
const saved: Record<string, string | undefined> = {};

function sh(file: string, body: string): string {
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

function git(args: string[], cwd = project): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

/** `git status --porcelain` of `dir`, its lines sorted and joined with commas. */
const porcelain = (dir: string): string => git(["status", "--porcelain"], dir).split("\n").filter(Boolean).sort().join(",");

const sshLog = () => (existsSync(join(base, "ssh.log")) ? readFileSync(join(base, "ssh.log"), "utf8") : "");
const rsyncLog = () => (existsSync(join(base, "rsync.log")) ? readFileSync(join(base, "rsync.log"), "utf8") : "");

before(() => {
  base = mkdtempSync(join(tmpdir(), "odw-remote-"));
  home = join(base, "remote-home");
  bin = join(base, "remote-bin");
  bareBin = join(base, "remote-bin-bare");
  project = join(base, "myproj");
  localRuns = join(base, "local-runs");
  for (const dir of [home, bin, bareBin, project]) mkdirSync(dir, { recursive: true });
  // The remote's tools are this machine's, by name only: no odw, no npx in the bare PATH.
  for (const tool of ["sh", "git", "tar", "cat", "mkdir", "rm", "ls", "cp", "grep", "env"]) {
    const found = spawnSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    assert.ok(found, `${tool} is needed by the remote-run tests`);
    symlinkSync(found, join(bin, tool));
    symlinkSync(found, join(bareBin, tool));
  }
  const loader = process.execArgv.filter((a) => !a.startsWith("--test"));
  sh(join(bin, "odw"), `exec ${[execPath, ...loader, CLI].map(shQuote).join(" ")} "$@"`);

  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "T"]);
  writeFileSync(join(project, "README.md"), "committed\n");
  writeFileSync(join(project, ".gitignore"), "build/\n");
  writeFileSync(join(project, "wait.js"), WAITING_WF);
  writeFileSync(join(project, "fast.js"), FAST_WF);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);

  for (const key of ["ODW_SSH", "ODW_RSYNC", "SSH_FAKE_HOME", "SSH_FAKE_PATH", "SSH_FAKE_LOG", "RSYNC_FAKE_LOG", "SSH_FAKE_UNREACHABLE", "ODW_CONFIG"]) {
    saved[key] = process.env[key];
  }
  delete process.env.ODW_CONFIG;
  process.env.ODW_SSH = sh(join(base, "ssh"), `exec ${shQuote(execPath)} ${shQuote(FAKE_SSH)} "$@"`);
  process.env.ODW_RSYNC = sh(join(base, "rsync"), `exec ${shQuote(execPath)} ${shQuote(FAKE_RSYNC)} "$@"`);
  process.env.SSH_FAKE_HOME = home;
  process.env.SSH_FAKE_PATH = bin;
  process.env.SSH_FAKE_LOG = join(base, "ssh.log");
  process.env.RSYNC_FAKE_LOG = join(base, "rsync.log");
});

after(async () => {
  // A run a failed assertion left waiting keeps its worker alive: stop it.
  const store = new RunStore(remoteRuns());
  for (const { runId } of store.listRuns()) await stopProcessRun(store, runId).catch(() => {});
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(base, { recursive: true, force: true });
});

test("--on and --from take ssh://[user@]host[:port][/path]; anything else is refused", () => {
  assert.deepEqual(parseSshTarget("ssh://box"), { url: "ssh://box", user: null, host: "box", port: null, workdir: null });
  assert.deepEqual(parseSshTarget("ssh://me@box.lan:2222/srv/work/"), {
    url: "ssh://me@box.lan:2222/srv/work/", user: "me", host: "box.lan", port: 2222, workdir: "/srv/work",
  });
  assert.equal(parseSshTarget("ssh://box/~/odw/x").workdir, "~/odw/x");
  assert.equal(parseSshTarget("ssh://box/my%20dir").workdir, "/my dir");
  assert.equal(parseSshTarget("ssh://[::1]:22").host, "::1");
  for (const bad of ["box", "ssh://", "ssh://-oProxyCommand=x", "ssh://me@-box", "ssh://box:0", "ssh://box:99999", "ssh://a b", "ssh://u;x@box", "http://box"]) {
    assert.throws(() => parseSshTarget(bad), /must be ssh:\/\/\[user@\]host/, bad);
  }
});

test("each ssh call runs sh -c with every value quoted, on the URL's port, the destination after --", () => {
  const argv = sshArgv(parseSshTarget("ssh://me@box:2200"), 'exec "$@"', ["status", "it's; rm -rf ~"], { tty: true });
  assert.deepEqual(argv.slice(0, 5), ["-p", "2200", "-t", "--", "me@box"]);
  assert.equal(argv[5], `sh -c 'exec "$@"' odw-remote 'status' 'it'\\''s; rm -rf ~'`);
  assert.deepEqual(takeOnFlag(["r1", "--on", "ssh://b", "--follow"]), { url: "ssh://b", rest: ["r1", "--follow"] });
  assert.deepEqual(takeOnFlag(["r1", "--on=ssh://b"]), { url: "ssh://b", rest: ["r1"] });
  assert.deepEqual(takeOnFlag(["r1"]), { url: null, rest: ["r1"] });
});

test("run --on, status --on, pull while it runs, then again after it ends", async () => {
  // Uncommitted work: a changed tracked file and an untracked one travel as the patch; an ignored one does not.
  writeFileSync(join(project, "README.md"), "committed\nand changed, not committed\n");
  writeFileSync(join(project, "notes.txt"), "untracked\n");
  mkdirSync(join(project, "build"), { recursive: true });
  writeFileSync(join(project, "build", "out.bin"), "ignored\n");
  const url = "ssh://me@box:2222";

  // Through a link to the project (as macOS's /var is to /private/var): git names the real path.
  const linked = join(dirname(project), "linked-proj");
  if (!existsSync(linked)) symlinkSync(project, linked);
  let r = await cli(["run", "wait.js", "--on", url, "--source", linked, "--args", '{"token":"PLACEHOLDER-not-a-secret"}']);
  assert.equal(r.code, 0, r.err);
  const id = r.out.trim();
  assert.match(id, /^\d{8}-\d{6}-[0-9a-f]{6}$/);
  assert.match(r.err, /syncing .*myproj to me@box:~\/odw-remote\/myproj: git bundle of HEAD [0-9a-f]+ \+ a patch of 2 uncommitted file\(s\)/);
  assert.match(r.err, new RegExp(`odw attach ${id} --on ${url}`));
  assert.match(r.err, new RegExp(`odw pull ${id} --from ${url}`));

  // The remote workdir holds HEAD plus the patch; the ignored file stayed here; the user's index is untouched.
  const workdir = join(home, "odw-remote", "myproj");
  assert.equal(readFileSync(join(workdir, "README.md"), "utf8"), "committed\nand changed, not committed\n");
  assert.equal(readFileSync(join(workdir, "notes.txt"), "utf8"), "untracked\n");
  assert.equal(existsSync(join(workdir, "build")), false);
  assert.ok(existsSync(join(workdir, ".odw-remote", "workdir")));
  assert.equal(porcelain(workdir), " M README.md,?? notes.txt");
  assert.equal(porcelain(project), " M README.md,?? notes.txt");

  // ssh was called on the URL's port and user; the args never went on a command line.
  assert.match(sshLog(), /"-p","2222"/);
  assert.match(sshLog(), /"me@box"/);
  assert.doesNotMatch(sshLog(), /PLACEHOLDER-not-a-secret/);

  const remote = new RunStore(remoteRuns());
  await until(() => remote.exists(id) && pendingIds(remote, id).length === 1, 20_000);

  // status passes through: the remote odw answers, exit code and all.
  r = await cli(["status", id, "--on", url]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`^${id}  \\[waiting\\]  remote-demo`));
  assert.match(r.out, /checkpoint #1: Go on\?/);
  r = await cli(["status", "no-such-run", "--on", url]);
  assert.equal(r.code, 1);
  assert.match(r.err, /no such run: no-such-run/);
  r = await cli(["logs", id, "--on", url]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /checkpoint/);

  // A pull while it runs: a snapshot, marked as remote, with no pid that could name a process here.
  r = await cli(["pull", id, "--from", url, "--runs-root", localRuns]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, new RegExp(`pulled ${id} \\[running\\] from me@box \\(rsync\\)`));
  assert.match(r.err, /still going there: this copy is a snapshot/);
  const local = new RunStore(localRuns);
  assert.ok(local.exists(id));
  assert.match(local.runDir(id), /remote-demo/);
  let meta = local.readMeta(id);
  assert.equal(meta.origin, "remote");
  assert.deepEqual({ ...(meta.remote as object), pulledAt: 0 }, {
    url, host: "me@box", dir: remote.runDir(id), origin: null, pulledAt: 0,
  });
  assert.equal("pid" in local.readStatus(id), false);
  assert.equal(existsSync(join(local.runDir(id), "worker.pid")), false);
  assert.match(rsyncLog(), /"--exclude=worker.pid"/);

  // It ends over there; a second pull brings the end, and local commands read it.
  r = await cli(["approve", id, "--runs-root", remoteRuns()]);
  assert.equal(r.code, 0, r.err);
  await until(() => TERMINAL_STATES.has(String(remote.readStatus(id).state)), 20_000);
  r = await cli(["pull", id, "--from", url, "--runs-root", localRuns]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /\[done\]/);
  assert.doesNotMatch(r.err, /still going/);
  meta = local.readMeta(id);
  assert.equal(meta.origin, "remote");
  assert.deepEqual(local.readResult(id), { ok: true, got: { token: "PLACEHOLDER-not-a-secret" } });
  r = await cli(["status", id, "--runs-root", localRuns]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /\[done\]/);
  assert.match(r.out, new RegExp(`pulled from ${url} at .* odw pull ${id} --from ${url} refreshes it`));

  // Without rsync here, tar over ssh does the same.
  process.env.ODW_RSYNC = join(base, "no-rsync-here");
  try {
    rmSync(local.runDir(id), { recursive: true, force: true });
    r = await cli(["pull", id, "--from", url, "--runs-root", localRuns]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /\(tar over ssh\)/);
    assert.deepEqual(new RunStore(localRuns).readResult(id), { ok: true, got: { token: "PLACEHOLDER-not-a-secret" } });
  } finally {
    process.env.ODW_RSYNC = join(base, "rsync");
  }

  // A run the remote does not have, and a local run of the same id that was not pulled, are refused.
  r = await cli(["pull", "20990101-000000-abcdef", "--from", url, "--runs-root", localRuns]);
  assert.equal(r.code, 1);
  assert.match(r.err, /has no run 20990101-000000-abcdef/);
  r = await cli(["pull", "../x", "--from", url, "--runs-root", localRuns]);
  assert.equal(r.code, 2);
  const metaPath = join(new RunStore(localRuns).runDir(id), "meta.json");
  writeFileSync(metaPath, JSON.stringify({ ...JSON.parse(readFileSync(metaPath, "utf8")), origin: null }));
  r = await cli(["pull", id, "--from", url, "--runs-root", localRuns]);
  assert.equal(r.code, 1);
  assert.match(r.err, /already exists here that was not pulled/);
});

test("--sync rsync mirrors the directory; a remote dir odw did not make is refused, never overwritten", async () => {
  const url = "ssh://box/~/elsewhere/proj";
  let r = await cli(["run", "fast.js", "--on", url, "--sync", "rsync", "--source", project, "--args", "7"]);
  assert.equal(r.code, 0, r.err);
  const id = r.out.trim();
  assert.match(r.err, /rsync of the project directory/);
  assert.match(rsyncLog(), /"--exclude=\/.odw-remote\/"/);
  assert.match(rsyncLog(), /"box:elsewhere\/proj\/"/);
  assert.ok(existsSync(join(home, "elsewhere", "proj", "fast.js")));
  const remote = new RunStore(remoteRuns());
  await until(() => remote.exists(id) && TERMINAL_STATES.has(String(remote.readStatus(id).state)), 20_000);
  assert.deepEqual(remote.readResult(id), { got: 7 });

  mkdirSync(join(home, "mine"), { recursive: true });
  writeFileSync(join(home, "mine", "keep.txt"), "mine\n");
  r = await cli(["run", "fast.js", "--on", "ssh://box/~/mine", "--source", project]);
  assert.equal(r.code, 1);
  assert.match(r.err, /box:~\/mine exists and was not made by odw run --on/);
  assert.deepEqual(readFileSync(join(home, "mine", "keep.txt"), "utf8"), "mine\n");
});

test("a second git sync replaces the first; a workflow from outside the project is sent along", async () => {
  const url = "ssh://box/~/resync";
  writeFileSync(join(project, "scratch.txt"), "for now\n");
  let r = await cli(["run", "fast.js", "--on", url, "--source", project]);
  assert.equal(r.code, 0, r.err);
  const workdir = join(home, "resync");
  assert.ok(existsSync(join(workdir, "scratch.txt")));
  // Gone here, gone there; a file the remote's own runs made under an ignored path stays.
  rmSync(join(project, "scratch.txt"));
  mkdirSync(join(workdir, "build"), { recursive: true });
  writeFileSync(join(workdir, "build", "cache"), "remote-only\n");
  const outside = join(base, "elsewhere.js");
  writeFileSync(outside, FAST_WF.replace("remote-fast", "remote-outside"));
  r = await cli(["run", outside, "--on", url, "--source", project, "--args", '"hi"']);
  assert.equal(r.code, 0, r.err);
  const id = r.out.trim();
  assert.match(r.err, /sending .*elsewhere\.js along \(it is outside the project\) as \.odw-remote\/workflows\/[0-9a-f]{12}-elsewhere\.js/);
  assert.equal(existsSync(join(workdir, "scratch.txt")), false);
  assert.ok(existsSync(join(workdir, "build", "cache")));
  const remote = new RunStore(remoteRuns());
  await until(() => remote.exists(id) && TERMINAL_STATES.has(String(remote.readStatus(id).state)), 20_000);
  assert.deepEqual(remote.readResult(id), { got: "hi" });
  assert.match(remote.runDir(id), /remote-outside/);
});

test("a remote with no odw gets install hints, and nothing is synced; an unreachable host says so", async () => {
  process.env.SSH_FAKE_PATH = bareBin;
  try {
    const r = await cli(["run", "fast.js", "--on", "ssh://box/~/nothing-here", "--source", project]);
    assert.equal(r.code, 1);
    assert.match(r.err, /odw is not installed on box, or not on the PATH a non-interactive ssh session gets/);
    assert.match(r.err, /ssh box 'npm install -g odw'/);
    assert.match(r.err, /its own odw config and agent CLI logins|remote's own odw config/);
    assert.equal(existsSync(join(home, "nothing-here")), false);
    const s = await cli(["status", "x", "--on", "ssh://box"]);
    assert.equal(s.code, 127);
    assert.match(s.err, /odw is not installed on box/);
  } finally {
    process.env.SSH_FAKE_PATH = bin;
  }
  process.env.SSH_FAKE_UNREACHABLE = "1";
  try {
    const r = await cli(["run", "fast.js", "--on", "ssh://box", "--source", project]);
    assert.equal(r.code, 1);
    assert.match(r.err, /ssh could not reach box \(exit 255\)/);
  } finally {
    delete process.env.SSH_FAKE_UNREACHABLE;
  }
});

test("run --on refuses flags that name something here or would watch the run here", async () => {
  for (const [flags, msg] of [
    [["--config", "x.json"], /--config names a file here/],
    [["--runs-root", "/tmp/x"], /--runs-root names a file here/],
    [["--wait"], /--on always starts detached/],
    [["--permissions", "root"], /--permissions must be read, edit or full/],
    [["--sync", "scp"], /--sync must be git or rsync/],
  ] as const) {
    const r = await cli(["run", "fast.js", "--on", "ssh://box", ...flags]);
    assert.equal(r.code, 2, flags.join(" "));
    assert.match(r.err, msg);
  }
  let r = await cli(["run", "fast.js", "--sync", "rsync"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /--sync goes with --on/);
  r = await cli(["run", "fast.js", "--on", "box"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /^odw run: --on must be ssh:\/\//);
  r = await cli(["pull", "x"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /--from ssh:\/\/.* is required/);
  // A plain directory with --sync git is refused before anything is sent.
  const plain = mkdtempSync(join(tmpdir(), "odw-plain-"));
  try {
    writeFileSync(join(plain, "fast.js"), FAST_WF);
    r = await cli(["run", "fast.js", "--on", "ssh://box", "--source", plain]);
    assert.equal(r.code, 2);
    assert.match(r.err, /is not a git repository .* use --sync rsync/);
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});
