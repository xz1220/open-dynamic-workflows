/**
 * Workflows installed from git, pinned by a lock (ODW extension;
 * src/workflows/{git-source,lock,install}.ts): `odw workflows add|update|verify`
 * against local repositories, what `list`, `doctor` and a run make of an
 * installed workflow, and the URLs and refs the fetch refuses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execPath } from "node:process";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";

import { defaultConfig, loadConfig } from "../src/adapters/config.js";
import { main } from "../src/cli.js";
import { ConfigError } from "../src/errors.js";
import { RunStore } from "../src/runtime/run-store.js";
import { listWorkflowSummaries } from "../src/runtime/workflows-view.js";
import { resolveScriptContext } from "../src/script-context.js";
import { fetchGitSource, parseGitSource } from "../src/workflows/git-source.js";
import { cmdWorkflowsAdd, cmdWorkflowsUpdate, cmdWorkflowsVerify, lockedWorkflowsCheck, type InstallIo } from "../src/workflows/install.js";
import { installedWorkflowFor, modifiedLockedMessage, readLock, sha256Of } from "../src/workflows/lock.js";
import { listWorkflows, resolveWorkflow } from "../src/workflows/resolve.js";

const flow = (name: string, body = "return typeof process + ' ' + (await agent('TASK'))\n") =>
  `export const meta = { name: '${name}', description: '${name} from git' }\n${body}`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=odw-test", "-c", "user.email=odw-test@example.com", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

interface Fixture {
  root: string;
  /** The source repository. */
  src: string;
  /** The project workflows are installed into. */
  project: string;
  write(path: string, text: string): void;
  commit(message: string): string;
  cleanup(): void;
}

function fixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "odw-wflock-")));
  const src = join(root, "src");
  const project = join(root, "project");
  mkdirSync(src);
  mkdirSync(project);
  git(src, "init", "-q");
  git(project, "init", "-q");
  return {
    root,
    src,
    project,
    write(path, text) {
      mkdirSync(dirname(join(src, path)), { recursive: true });
      writeFileSync(join(src, path), text);
    },
    commit(message) {
      git(src, "add", "-A");
      git(src, "commit", "-q", "-m", message);
      return git(src, "rev-parse", "HEAD");
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Prompts and their answers in memory; `tty` makes it look like a terminal. */
function io(cwd: string, opts: { tty?: boolean; answer?: string } = {}): InstallIo & { text(): string } {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  const err = new PassThrough() as PassThrough & { isTTY?: boolean };
  const chunks: string[] = [];
  err.on("data", (c) => chunks.push(String(c)));
  if (opts.tty) {
    input.isTTY = true;
    err.isTTY = true;
  }
  if (opts.answer !== undefined) err.on("data", (c) => String(c).includes("[y/N]") && input.write(opts.answer));
  return { input, err, env: { TERM: "xterm" }, cwd, text: () => chunks.join("") };
}

/** stdout written while `fn` runs (node:test's own buffer writes pass through). */
async function stdout<T>(fn: () => Promise<T> | T): Promise<{ value: T; out: string }> {
  const out: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: unknown }).write = (s: unknown) => {
    if (Buffer.isBuffer(s)) return so(s);
    out.push(String(s));
    return true;
  };
  try {
    const value = await fn();
    return { value, out: out.join("") };
  } finally {
    process.stdout.write = so;
  }
}

async function cli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  (process.stdout as { write: unknown }).write = (s: unknown) => (Buffer.isBuffer(s) ? so(s) : (out.push(String(s)), true));
  (process.stderr as { write: unknown }).write = (s: unknown) => (Buffer.isBuffer(s) ? se(s) : (err.push(String(s)), true));
  try {
    const code = await main(argv);
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
  }
}

test("a git source is https, ssh or file; anything else, an option-shaped URL or ref, is refused", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "odw-wflock-url-")));
  try {
    assert.deepEqual(parseGitSource("https://example.com/acme/flows.git#v1.2.0"), { url: "https://example.com/acme/flows.git", ref: "v1.2.0" });
    assert.deepEqual(parseGitSource("ssh://git@example.com/acme/flows.git"), { url: "ssh://git@example.com/acme/flows.git", ref: null });
    assert.deepEqual(parseGitSource("git@example.com:acme/flows.git#main"), { url: "git@example.com:acme/flows.git", ref: "main" });
    assert.deepEqual(parseGitSource("file:///srv/flows.git"), { url: "file:///srv/flows.git", ref: null });
    assert.deepEqual(parseGitSource(".", dir), { url: pathToFileURL(dir).href, ref: null }, "a local directory is its file URL");
    for (const bad of ["http://example.com/x.git", "git://example.com/x.git", "ext::sh -c touch% /tmp/pwned", "fd::17", "--upload-pack=touch /tmp/x", "./nope-not-here"]) {
      assert.throws(() => parseGitSource(bad, dir), ConfigError, bad);
    }
    for (const ref of ["--upload-pack=x", "a..b", "a:b", "", "-x", "a b"]) {
      assert.throws(() => parseGitSource(`https://example.com/x.git#${ref}`), ConfigError, ref);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("odw workflows add copies the checked workflows and their test, skips symlinks and submodules, and locks url, ref, commit, path and sha256", async () => {
  const f = fixture();
  try {
    f.write(".odw/workflows/audit.js", flow("audit"));
    f.write(".odw/workflows/notes.txt", "not a workflow");
    f.write(".odw/workflows/broken.js", "this is not a workflow\n");
    f.write(".odw/tests/audit.json", '{"workflow":"audit","cases":[]}\n');
    symlinkSync("/etc/passwd", join(f.src, ".odw", "workflows", "link.js"));
    const first = f.commit("one");
    // A gitlink (a submodule) named like a workflow: never fetched, never followed.
    git(f.src, "update-index", "--add", "--cacheinfo", `160000,${first},.odw/workflows/sub.js`);
    git(f.src, "commit", "-q", "-m", "submodule");
    git(f.src, "tag", "v1");
    const commit = git(f.src, "rev-parse", "v1");

    const out = io(f.project);
    const code = await cmdWorkflowsAdd([`${f.src}#v1`, "--yes"], out);
    assert.equal(code, 0, out.text());
    const text = out.text();
    assert.match(text, /audit\.js:2:\d+: capability: process — outside the dialect; not in a strict context/, "the capability report comes first");
    assert.match(text, /note: skipped \.odw\/workflows\/link\.js: a symlink/);
    assert.match(text, /note: skipped \.odw\/workflows\/sub\.js: a submodule/);
    assert.match(text, /note: skipped \.odw\/workflows\/broken\.js: not a workflow odw can load/);
    assert.match(text, /\.odw\/workflows\/audit\.js → \.odw\/workflows\/audit\.js \(\+ tests\/audit\.json\)/);
    assert.match(text, /third-party: they run in a strict script context/);

    const installed = readFileSync(join(f.project, ".odw", "workflows", "audit.js"), "utf8");
    assert.equal(installed, flow("audit"));
    assert.equal(readFileSync(join(f.project, ".odw", "tests", "audit.json"), "utf8"), '{"workflow":"audit","cases":[]}\n');
    assert.equal(existsSync(join(f.project, ".odw", "workflows", "link.js")), false);
    assert.equal(existsSync(join(f.project, ".odw", "workflows", "broken.js")), false);
    const lock = readLock(join(f.project, ".odw", "workflows.lock.json"));
    assert.deepEqual(Object.keys(lock.workflows), ["audit"]);
    const entry = lock.workflows.audit!;
    assert.equal(entry.url, pathToFileURL(f.src).href);
    assert.equal(entry.ref, "v1");
    assert.equal(entry.commit, commit);
    assert.equal(entry.path, ".odw/workflows/audit.js");
    assert.equal(entry.sha256, sha256Of(installed));
    assert.deepEqual(entry.test, { path: ".odw/tests/audit.json", sha256: sha256Of('{"workflow":"audit","cases":[]}\n') });
    assert.equal(entry.eval, undefined);

    // Again: already installed — that is update's job; a file it did not install is never replaced without --force.
    const again = io(f.project);
    assert.equal(await cmdWorkflowsAdd([`${f.src}#v1`, "--yes"], again), 1);
    assert.match(again.text(), /'audit' is already installed from .* — odw workflows update audit/);
    writeFileSync(join(f.project, ".odw", "workflows", "mine.js"), flow("mine"));
    const mine = io(f.project);
    assert.equal(await cmdWorkflowsAdd([f.src, "--path", ".odw/workflows/audit.js", "--name", "mine", "--yes"], mine), 1);
    assert.match(mine.text(), /\.odw\/workflows\/mine\.js exists and odw workflows add did not install it — pass --force/);
    assert.equal(readFileSync(join(f.project, ".odw", "workflows", "mine.js"), "utf8"), flow("mine"));
  } finally {
    f.cleanup();
  }
});

test("odw workflows add asks before writing: no terminal and no --yes writes nothing; a terminal's 'y' installs", async () => {
  const f = fixture();
  try {
    f.write("flows/one.js", flow("one"));
    f.write("flows/two.js", flow("two"));
    const commit = f.commit("one");

    const quiet = io(f.project);
    assert.equal(await cmdWorkflowsAdd([f.src, "--path", "flows"], quiet), 1);
    assert.match(quiet.text(), /no terminal to ask on — pass --yes/);
    assert.equal(existsSync(join(f.project, ".odw")), false, "nothing written");

    const many = io(f.project);
    assert.equal(await cmdWorkflowsAdd([f.src, "--path", "flows", "--name", "x", "--yes"], many), 2);
    assert.match(many.text(), /--name names one workflow, and 2 were found/);

    const no = io(f.project, { tty: true, answer: "n\n" });
    assert.equal(await cmdWorkflowsAdd([f.src, "--path", "flows/one.js"], no), 1);
    assert.equal(existsSync(join(f.project, ".odw")), false);

    // By commit id, renamed, after a 'y'.
    const yes = io(f.project, { tty: true, answer: "y\n" });
    assert.equal(await cmdWorkflowsAdd([`${f.src}#${commit}`, "--path", "flows/one.js", "--name", "first"], yes), 0, yes.text());
    assert.match(yes.text(), /install it\? \[y\/N\]/);
    const lock = readLock(join(f.project, ".odw", "workflows.lock.json"));
    assert.equal(lock.workflows.first!.commit, commit);
    assert.equal(lock.workflows.first!.ref, commit);
    assert.equal(lock.workflows.first!.path, "flows/one.js");
    assert.equal(readFileSync(join(f.project, ".odw", "workflows", "first.js"), "utf8"), flow("one"));

    const none = io(f.project);
    assert.equal(await cmdWorkflowsAdd([f.src, "--yes"], none), 1, "nothing in the default directories");
    assert.match(none.text(), /no workflow found .* — pass --path/);
    assert.throws(() => fetchGitSource({ url: pathToFileURL(join(f.root, "missing")).href, ref: null }), /could not fetch/);
  } finally {
    f.cleanup();
  }
});

test("odw workflows update shows the diff before writing, moves the lock, and never overwrites a local edit without --force", async () => {
  const f = fixture();
  try {
    f.write(".odw/workflows/audit.js", flow("audit"));
    f.commit("one");
    assert.equal(await cmdWorkflowsAdd([`${f.src}#main`, "--yes"], io(f.project)), 0);
    const target = join(f.project, ".odw", "workflows", "audit.js");
    const lockPath = join(f.project, ".odw", "workflows.lock.json");

    const same = io(f.project);
    assert.equal(await cmdWorkflowsUpdate([], same), 0);
    assert.match(same.text(), /audit: up to date at [0-9a-f]{12}/);

    f.write(".odw/workflows/audit.js", flow("audit", "return 'v2 ' + (await agent('TASK'))\n"));
    const second = f.commit("two");
    const asked = io(f.project);
    const shown = await stdout(() => cmdWorkflowsUpdate(["audit"], asked));
    assert.equal(shown.value, 1, "no terminal, no --yes: shown, not written");
    assert.match(shown.out, /^--- a\/\.odw\/workflows\/audit\.js\t[0-9a-f]{12}\n\+\+\+ b\/\.odw\/workflows\/audit\.js\t[0-9a-f]{12}\n@@ /);
    assert.match(shown.out, /\n-return typeof process \+ ' ' \+ \(await agent\('TASK'\)\)\n\+return 'v2 ' \+ \(await agent\('TASK'\)\)\n/);
    assert.equal(readFileSync(target, "utf8"), flow("audit"));

    const edited = flow("audit") + "// mine\n";
    writeFileSync(target, edited);
    const refused = io(f.project);
    assert.equal(await stdout(() => cmdWorkflowsUpdate(["--yes"], refused)).then((r) => r.value), 1);
    assert.match(refused.text(), /was modified since it was installed — not overwriting it \(--force does\)/);
    assert.equal(readFileSync(target, "utf8"), edited);

    const forced = io(f.project);
    assert.equal(await stdout(() => cmdWorkflowsUpdate(["--yes", "--force"], forced)).then((r) => r.value), 0, forced.text());
    assert.match(forced.text(), /updated audit to [0-9a-f]{12}/);
    const now = flow("audit", "return 'v2 ' + (await agent('TASK'))\n");
    assert.equal(readFileSync(target, "utf8"), now);
    const entry = readLock(lockPath).workflows.audit!;
    assert.equal(entry.commit, second);
    assert.equal(entry.sha256, sha256Of(now));
    assert.equal(entry.ref, "main");

    const unknown = io(f.project);
    assert.equal(await cmdWorkflowsUpdate(["nope"], unknown), 1);
    assert.match(unknown.text(), /no workflow 'nope'/);
  } finally {
    f.cleanup();
  }
});

test("odw workflows verify hashes every locked file (exit 1 on a modified or missing one); list, doctor and the dashboard flag them third-party", async () => {
  const f = fixture();
  const cwd = process.cwd();
  try {
    f.write(".odw/workflows/audit.js", flow("audit"));
    f.write(".odw/evals/audit.json", '{"cases":[]}\n');
    f.commit("one");
    assert.equal(await cmdWorkflowsAdd([f.src, "--yes"], io(f.project)), 0);
    const target = join(f.project, ".odw", "workflows", "audit.js");
    const config = defaultConfig();
    // The global directory is somewhere of the test's own.
    config.settings.workflowsRoot = join(f.root, "global");

    const ok = await stdout(() => cmdWorkflowsVerify([], io(f.project)));
    assert.equal(ok.value, 0);
    assert.match(ok.out, /^ok {8}audit {2}\.odw\/workflows\/audit\.js {2}file:\/\/\S+ @ [0-9a-f]{12}\nok {8}audit \(eval\) {2}\.odw\/evals\/audit\.json/);
    assert.equal(lockedWorkflowsCheck(f.project, config)?.status, "ok");
    assert.equal(resolveWorkflow("audit", { cwd: f.project, config }).installed?.modified, false);

    writeFileSync(target, flow("audit") + "// changed\n");
    rmSync(join(f.project, ".odw", "evals", "audit.json"));
    const bad = io(f.project);
    const r = await stdout(() => cmdWorkflowsVerify([], bad));
    assert.equal(r.value, 1);
    assert.match(r.out, /^MODIFIED {2}audit {2}/m);
    assert.match(r.out, /^MISSING {3}audit \(eval\) {2}/m);
    assert.match(bad.text(), /2 locked files no longer match the lock/);
    const json = await stdout(() => cmdWorkflowsVerify(["--json"], io(f.project)));
    const report = JSON.parse(json.out) as { ok: boolean; files: Array<{ status: string; kind: string }> };
    assert.equal(report.ok, false);
    assert.deepEqual(report.files.map((x) => `${x.kind}:${x.status}`), ["workflow:modified", "eval:missing"]);
    assert.equal((await stdout(() => cmdWorkflowsVerify(["nope"], io(f.project)))).value, 1);

    const check = lockedWorkflowsCheck(f.project, config)!;
    assert.equal(check.status, "warn");
    assert.match(check.detail, /audit modified; audit \(eval\) missing/);
    assert.equal(lockedWorkflowsCheck(f.project, { ...config, settings: { ...config.settings, lockedWorkflows: "fail" } })!.status, "fail");

    const listed = listWorkflows(f.project, config).find((w) => w.name === "audit")!;
    assert.equal(listed.installed?.modified, true);
    const summary = listWorkflowSummaries(f.project, config).find((w) => w.name === "audit")!;
    assert.equal(summary.installed?.url, pathToFileURL(f.src).href);
    assert.equal(summary.installed?.modified, true);
    process.chdir(f.project);
    const l = await cli(["workflows", "list"]);
    assert.match(l.out, /^audit .*audit\.js {2}third-party: file:\/\/\S+ @ [0-9a-f]{12} {2}MODIFIED since install \(odw workflows verify\)$/m);
  } finally {
    process.chdir(cwd);
    f.cleanup();
  }
});

test("--global installs into the global directory with its lock beside it, and no test or eval", async () => {
  const f = fixture();
  try {
    f.write(".odw/workflows/audit.js", flow("audit"));
    f.write(".odw/tests/audit.json", "{}\n");
    f.commit("one");
    const global = join(f.root, "home-flows");
    const configPath = join(f.root, "odw.config.json");
    writeFileSync(configPath, JSON.stringify({ workflowsRoot: global }));
    assert.equal(await cmdWorkflowsAdd([f.src, "--global", "--yes", "--config", configPath], io(f.project)), 0);
    assert.ok(existsSync(join(global, "audit.js")));
    assert.equal(existsSync(join(f.root, "tests")), false);
    const lock = readLock(`${global}.lock.json`);
    assert.equal(lock.workflows.audit!.test, undefined);
    assert.equal(installedWorkflowFor(join(global, "audit.js"))?.entry.url, pathToFileURL(f.src).href);
    const verified = await stdout(() => cmdWorkflowsVerify(["--global", "--config", configPath], io(f.project)));
    assert.equal(verified.value, 0);
    assert.match(verified.out, /^ok {8}audit {2}/);
  } finally {
    f.cleanup();
  }
});

test("a workflow installed from git runs strict by default, records where it came from, and a modified one warns — or, under lockedWorkflows: fail, does not start", async () => {
  const f = fixture();
  try {
    f.write(".odw/workflows/audit.js", flow("audit"));
    f.commit("one");
    assert.equal(await cmdWorkflowsAdd([f.src, "--yes"], io(f.project)), 0);
    const mock = { command: [execPath, "-e", "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('ok'))"], stdin: "{prompt}" };
    const config = join(f.root, "mine.json");
    writeFileSync(config, JSON.stringify({ defaultAdapter: "mock", adapters: { mock } }));
    const runsRoot = join(f.root, "runs");
    const flags = ["--config", config, "--runs-root", runsRoot, "--source", f.project, "--wait"];

    const r = await cli(["run", "audit", ...flags]);
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out), "undefined ok", "no process in a strict context");
    assert.match(r.err, /\nworkflow: audit is third-party, installed from file:\/\/\S+ @ [0-9a-f]{12}\n/);
    const store = new RunStore(runsRoot);
    const id = /running (\S+) \.\.\./.exec(r.err)![1]!;
    const meta = store.readMeta(id) as { installed?: Record<string, unknown> };
    assert.equal(meta.installed?.url, pathToFileURL(f.src).href);
    assert.equal(meta.installed?.modified, false);
    assert.equal(store.readStatus(id).scriptContext, "strict");
    const logs = store.readEvents(id).filter((e) => e.type === "log").map((e) => String(e.message));
    assert.ok(logs.some((m) => /^workflow audit is third-party: installed from file:\/\//.test(m)), logs.join("\n"));
    assert.ok(logs.some((m) => /strict script context — the workflow is third-party, installed from file:\/\//.test(m)), logs.join("\n"));

    // A host run's nested workflow() of it runs it strict too.
    writeFileSync(join(f.project, "parent.js"), "export const meta = { name: 'parent', description: 'p' }\nreturn typeof process + ' / ' + (await workflow('audit'))\n");
    const nested = await cli(["run", "./parent.js", ...flags]);
    assert.equal(nested.code, 0, nested.err);
    assert.equal(JSON.parse(nested.out), "object / undefined ok");
    const nid = /running (\S+) \.\.\./.exec(nested.err)![1]!;
    assert.ok(
      store.readEvents(nid).some((e) => e.type === "log" && /▸ workflow audit runs in a strict script context — the workflow is third-party, installed from file:/.test(String(e.message))),
    );

    // The config's "host" takes the strict default away, as for a plugin's.
    writeFileSync(config, JSON.stringify({ defaultAdapter: "mock", adapters: { mock }, scriptContext: "host" }));
    const host = await cli(["run", "audit", ...flags]);
    assert.equal(JSON.parse(host.out), "object ok");

    // Modified: loud, still runs (warn).
    writeFileSync(config, JSON.stringify({ defaultAdapter: "mock", adapters: { mock } }));
    writeFileSync(join(f.project, ".odw", "workflows", "audit.js"), flow("audit") + "// edited\n");
    const warned = await cli(["run", "audit", ...flags]);
    assert.equal(warned.code, 0, warned.err);
    assert.match(warned.err, /\n⚠ workflow audit was installed from file:\/\/\S+ @ [0-9a-f]{12} but was modified since: its sha256 is not the one in /);
    const wid = /running (\S+) \.\.\./.exec(warned.err)![1]!;
    assert.ok(store.readEvents(wid).some((e) => e.type === "log" && /^⚠ workflow audit was installed from .* but was modified since/.test(String(e.message))));

    // lockedWorkflows: "fail" — no run starts.
    writeFileSync(config, JSON.stringify({ defaultAdapter: "mock", adapters: { mock }, lockedWorkflows: "fail" }));
    const before = store.listRuns().length;
    const failed = await cli(["run", "audit", ...flags]);
    assert.notEqual(failed.code, 0);
    assert.match(failed.err, /was modified since/);
    assert.equal(store.listRuns().length, before, "no run was created");
    assert.throws(() => defaultConfigWith({ lockedWorkflows: "maybe" }), ConfigError);
    assert.equal((defaultConfigWith({}) as ReturnType<typeof defaultConfig>).settings.lockedWorkflows, "warn");
  } finally {
    f.cleanup();
  }
});

test("fetching runs no hook — not even one the user's own git config would run — and leaves no temp repository behind", { skip: process.platform === "win32" }, () => {
  const f = fixture();
  const saved = process.env.GIT_CONFIG_GLOBAL;
  try {
    f.write(".odw/workflows/audit.js", flow("audit"));
    f.commit("one");
    const hooks = join(f.root, "hooks");
    const marker = join(f.root, "hook-ran");
    mkdirSync(hooks);
    writeFileSync(join(hooks, "reference-transaction"), `#!/bin/sh\necho ran >> '${marker}'\n`, { mode: 0o755 });
    const gitconfig = join(f.root, "gitconfig");
    writeFileSync(gitconfig, `[core]\n\thooksPath = ${hooks}\n`);
    process.env.GIT_CONFIG_GLOBAL = gitconfig;
    // The hook is real: a plain fetch under this config runs it.
    const plain = join(f.root, "plain");
    git(f.root, "init", "-q", "--bare", plain);
    execFileSync("git", ["-C", plain, "fetch", "-q", f.src, "main:refs/heads/main"], { stdio: "ignore", env: process.env });
    assert.ok(existsSync(marker), "the control fetch ran the hook");
    rmSync(marker);

    const repo = fetchGitSource({ url: pathToFileURL(f.src).href, ref: null });
    assert.equal(repo.list(".odw/workflows/audit.js")?.kind, "file");
    assert.ok(existsSync(repo.dir));
    repo.cleanup();
    assert.equal(existsSync(repo.dir), false, "the temp repository is gone");
    assert.equal(existsSync(marker), false, "odw's fetch ran no hook");
  } finally {
    if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = saved;
    f.cleanup();
  }
});

test("resolveScriptContext: an installed workflow is strict unless the config says otherwise", () => {
  const run = { plugin: false, untrustedInput: false, untrustedRepo: false, installedFrom: "https://example.com/x.git" };
  assert.deepEqual(resolveScriptContext(null, run), { context: "strict", why: "the workflow is third-party, installed from https://example.com/x.git" });
  assert.equal(resolveScriptContext("host", run).overrode, "the workflow is third-party, installed from https://example.com/x.git");
  assert.equal(resolveScriptContext(null, { ...run, installedFrom: null }).context, "host");
});

/** A config file of `raw`, loaded (and so validated) as odw loads one. */
function defaultConfigWith(raw: Record<string, unknown>): unknown {
  const dir = mkdtempSync(join(tmpdir(), "odw-wflock-cfg-"));
  try {
    const path = join(dir, "odw.config.json");
    writeFileSync(path, JSON.stringify(raw));
    return loadConfig(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- found in review -----------------------------------------------------------------

/** A lock of one entry `name`, as a cloned checkout could carry it. */
function lockOf(entries: Record<string, Record<string, unknown>>): string {
  const workflows: Record<string, unknown> = {};
  for (const [name, e] of Object.entries(entries)) {
    workflows[name] = { ref: null, commit: "0".repeat(40), sha256: "0".repeat(64), installedAt: "", ...e };
  }
  return JSON.stringify({ version: 1, workflows });
}

test("add and update never write through a symlink: a dangling workflow link, a linked tests directory, a linked .odw", { skip: process.platform === "win32" }, async () => {
  const f = fixture();
  try {
    f.write(".odw/workflows/foo.js", flow("foo"));
    f.write(".odw/tests/foo.json", "{}\n");
    f.commit("one");
    const outside = join(f.root, "outside");
    mkdirSync(outside);

    // A checkout's committed lock, and its workflow a dangling link out of the project: update refuses it.
    mkdirSync(join(f.project, ".odw", "workflows"), { recursive: true });
    const lockPath = join(f.project, ".odw", "workflows.lock.json");
    const lockText = lockOf({ foo: { url: pathToFileURL(f.src).href, path: ".odw/workflows/foo.js" } });
    writeFileSync(lockPath, lockText);
    symlinkSync(join(outside, "victim.js"), join(f.project, ".odw", "workflows", "foo.js"));
    const update = io(f.project);
    assert.equal(await stdout(() => cmdWorkflowsUpdate(["--yes"], update)).then((r) => r.value), 1);
    assert.match(update.text(), /foo: not writing \.odw\/workflows\/foo\.js: \S+foo\.js is a symbolic link — a symlink is never written through/);
    assert.equal(existsSync(join(outside, "victim.js")), false, "nothing written outside the project");
    assert.equal(readFileSync(lockPath, "utf8"), lockText, "the lock is left as it was");

    // add: the same dangling link is something there (never "missing"), and --force does not write through it.
    rmSync(lockPath);
    const add = io(f.project);
    assert.equal(await cmdWorkflowsAdd([f.src, "--yes"], add), 1);
    assert.match(add.text(), /\.odw\/workflows\/foo\.js exists and odw workflows add did not install it/);
    const forced = io(f.project);
    assert.equal(await cmdWorkflowsAdd([f.src, "--yes", "--force"], forced), 1);
    assert.match(forced.text(), /not writing \.odw\/workflows\/foo\.js: \S+ is a symbolic link/);
    assert.equal(existsSync(join(outside, "victim.js")), false);
    rmSync(join(f.project, ".odw", "workflows", "foo.js"));

    // A linked .odw/tests: the test is not written there, and nothing is installed.
    symlinkSync(outside, join(f.project, ".odw", "tests"));
    const extras = io(f.project);
    assert.equal(await cmdWorkflowsAdd([f.src, "--yes"], extras), 1);
    assert.match(extras.text(), /not writing \.odw\/tests\/foo\.json: \S+tests is a symbolic link/);
    assert.equal(existsSync(join(outside, "foo.json")), false);
    assert.equal(existsSync(join(f.project, ".odw", "workflows", "foo.js")), false, "all or nothing: refused before writing");
    rmSync(join(f.project, ".odw"), { recursive: true });

    // A linked .odw itself.
    mkdirSync(join(outside, "odw"));
    symlinkSync(join(outside, "odw"), join(f.project, ".odw"));
    const linked = io(f.project);
    assert.equal(await cmdWorkflowsAdd([f.src, "--yes"], linked), 1);
    assert.match(linked.text(), /\.odw is a symbolic link/);
    assert.deepEqual(readdirSync(join(outside, "odw")), []);
    rmSync(join(f.project, ".odw"));

    // Installed for real, then the tests directory swapped for a link: update refuses before fetching.
    assert.equal(await cmdWorkflowsAdd([f.src, "--yes"], io(f.project)), 0);
    rmSync(join(f.project, ".odw", "tests"), { recursive: true });
    symlinkSync(outside, join(f.project, ".odw", "tests"));
    f.write(".odw/tests/foo.json", '{"cases":[]}\n');
    f.commit("two");
    const swapped = io(f.project);
    assert.equal(await stdout(() => cmdWorkflowsUpdate(["--yes"], swapped)).then((r) => r.value), 1);
    assert.match(swapped.text(), /tests is a symbolic link/);
    assert.equal(existsSync(join(outside, "foo.json")), false);
  } finally {
    f.cleanup();
  }
});

test("a repository's file whose name is no workflow name is skipped, with its name stripped of escapes; __proto__ never installs", { skip: process.platform === "win32" }, async () => {
  const f = fixture();
  try {
    f.write(".odw/workflows/good.js", flow("good"));
    f.write(".odw/workflows/x y\u001b[2J.js", flow("bad"));
    f.write(".odw/workflows/__proto__.js", flow("proto"));
    f.write(".odw/workflows/constructor.js", flow("ctor"));
    f.commit("one");
    const out = io(f.project);
    assert.equal(await cmdWorkflowsAdd([f.src, "--yes"], out), 0, out.text());
    const text = out.text();
    assert.equal(text.includes("\u001b"), false, "no escape reaches the terminal");
    assert.match(text, /note: skipped \.odw\/workflows\/x y\.js: not a workflow name/);
    assert.match(text, /note: skipped \.odw\/workflows\/__proto__\.js: not a workflow name/);
    assert.match(text, /note: skipped \.odw\/workflows\/constructor\.js: not a workflow name/);
    assert.deepEqual(readdirSync(join(f.project, ".odw", "workflows")), ["good.js"]);
    const lock = readLock(join(f.project, ".odw", "workflows.lock.json"));
    assert.deepEqual(Object.keys(lock.workflows), ["good"]);
    assert.equal(Object.getPrototypeOf(lock.workflows), null);
    assert.equal(installedWorkflowFor(join(f.project, ".odw", "workflows", "good.js"))?.modified, false);
    const named = io(f.project);
    assert.equal(await cmdWorkflowsAdd([f.src, "--path", ".odw/workflows/good.js", "--name", "__proto__", "--yes"], named), 2);
  } finally {
    f.cleanup();
  }
});

test("a lock that cannot be read makes every workflow beside it third-party from an unknown source and modified; verify and doctor say so", async () => {
  const f = fixture();
  try {
    f.write(".odw/workflows/audit.js", flow("audit"));
    f.commit("one");
    assert.equal(await cmdWorkflowsAdd([f.src, "--yes"], io(f.project)), 0);
    const lockPath = join(f.project, ".odw", "workflows.lock.json");
    const good = readFileSync(lockPath, "utf8");
    writeFileSync(join(f.project, ".odw", "workflows", "mine.js"), flow("mine"));
    const config = defaultConfig();
    config.settings.workflowsRoot = join(f.root, "global");

    for (const broken of ["{not json", lockOf({ "x y": { url: pathToFileURL(f.src).href, path: "a.js" } }), '{"version":1,"workflows":{"__proto__":{}}}']) {
      writeFileSync(lockPath, broken);
      for (const name of ["audit", "mine"]) {
        const w = installedWorkflowFor(join(f.project, ".odw", "workflows", `${name}.js`));
        assert.ok(w, `${name} beside ${broken}`);
        assert.equal(w.modified, true);
        assert.match(w.lockError!, /not a workflow lock/);
      }
      const resolved = resolveWorkflow("mine", { cwd: f.project, config });
      assert.match(modifiedLockedMessage(resolved.installed!), /sits beside a workflow lock that cannot be read .* third-party from an unknown source/);
      const verified = io(f.project);
      assert.equal(await stdout(() => cmdWorkflowsVerify(["--project"], verified)).then((r) => r.value), 1);
      assert.match(verified.text(), /not a workflow lock/);
      const check = lockedWorkflowsCheck(f.project, config)!;
      assert.equal(check.status, "fail");
      assert.match(check.detail, /not a workflow lock/);
    }

    // A run of one under lockedWorkflows: "fail" does not start; under "warn" it runs strict, said loudly.
    const mock = { command: [execPath, "-e", "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('ok'))"], stdin: "{prompt}" };
    const configPath = join(f.root, "mine.json");
    const runsRoot = join(f.root, "runs");
    const flags = ["--config", configPath, "--runs-root", runsRoot, "--source", f.project, "--wait"];
    writeFileSync(configPath, JSON.stringify({ defaultAdapter: "mock", adapters: { mock }, lockedWorkflows: "fail" }));
    const refused = await cli(["run", "mine", ...flags]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.err, /lock that cannot be read/);
    writeFileSync(configPath, JSON.stringify({ defaultAdapter: "mock", adapters: { mock } }));
    const warned = await cli(["run", "mine", ...flags]);
    assert.equal(warned.code, 0, warned.err);
    assert.equal(JSON.parse(warned.out), "undefined ok", "strict: no process");
    assert.match(warned.err, /⚠ workflow mine sits beside a workflow lock that cannot be read/);

    writeFileSync(lockPath, good);
    assert.equal(installedWorkflowFor(join(f.project, ".odw", "workflows", "mine.js")), null, "a readable lock that does not name it: not third-party");
  } finally {
    f.cleanup();
  }
});

test("update refuses a fetched file that does not check, as add does", async () => {
  const f = fixture();
  try {
    f.write(".odw/workflows/audit.js", flow("audit"));
    f.commit("one");
    assert.equal(await cmdWorkflowsAdd([f.src, "--yes"], io(f.project)), 0);
    const target = join(f.project, ".odw", "workflows", "audit.js");
    f.write(".odw/workflows/audit.js", "this is not a workflow\n");
    f.commit("two");
    const out = io(f.project);
    assert.equal(await stdout(() => cmdWorkflowsUpdate(["--yes"], out)).then((r) => r.value), 1);
    assert.match(out.text(), /audit: \.odw\/workflows\/audit\.js at [0-9a-f]{12} is not a workflow odw can load — left as installed/);
    assert.equal(readFileSync(target, "utf8"), flow("audit"));
  } finally {
    f.cleanup();
  }
});

test("a lock's url, ref and paths are checked as add checks its own; in update, one entry that fails fails alone", async () => {
  const f = fixture();
  try {
    const lockPath = join(f.root, "workflows.lock.json");
    const ok = { url: "https://example.com/x.git", path: ".odw/workflows/a.js" };
    for (const bad of [
      { url: "ssh://-oProxyCommand=touch$IFS/tmp/x/y" },
      { url: "ext::sh -c touch% /tmp/x" },
      { url: "--upload-pack=touch /tmp/x" },
      { url: "-u@host:x" },
      { url: "http://example.com/x.git" },
      { ref: "--upload-pack=touch /tmp/x" },
      { ref: "a..b" },
      { path: "../x.js" },
      { path: "/etc/passwd" },
      { path: "" },
      { test: { path: "a/../../b.json", sha256: "0".repeat(64) } },
    ]) {
      writeFileSync(lockPath, lockOf({ a: { ...ok, ...bad } }));
      assert.throws(() => readLock(lockPath), ConfigError, JSON.stringify(bad));
    }
    writeFileSync(lockPath, lockOf({ a: ok }));
    assert.equal(readLock(lockPath).workflows.a!.url, ok.url);

    // Two entries: one whose source is gone fails alone; the other still updates.
    f.write(".odw/workflows/audit.js", flow("audit"));
    f.commit("one");
    assert.equal(await cmdWorkflowsAdd([f.src, "--yes"], io(f.project)), 0);
    const projectLock = join(f.project, ".odw", "workflows.lock.json");
    const lock = JSON.parse(readFileSync(projectLock, "utf8")) as { workflows: Record<string, Record<string, unknown>> };
    lock.workflows.gone = { ...lock.workflows.audit, url: pathToFileURL(join(f.root, "no-such-repo")).href };
    writeFileSync(join(f.project, ".odw", "workflows", "gone.js"), flow("audit"));
    writeFileSync(projectLock, JSON.stringify(lock));
    f.write(".odw/workflows/audit.js", flow("audit", "return 'v2'\n"));
    const second = f.commit("two");
    const out = io(f.project);
    assert.equal(await stdout(() => cmdWorkflowsUpdate(["--yes"], out)).then((r) => r.value), 1);
    assert.match(out.text(), /gone: could not fetch/);
    assert.match(out.text(), /updated audit to [0-9a-f]{12}/);
    assert.equal(readLock(projectLock).workflows.audit!.commit, second);
  } finally {
    f.cleanup();
  }
});
