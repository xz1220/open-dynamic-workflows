/**
 * Runs on your own box over plain SSH (ODW extension): `odw run --on
 * ssh://host`, `odw pull`, and `odw status|logs|attach --on`.
 *
 * No daemon, on either side. Everything is one `ssh` call at a time — the
 * user's own ssh, with their ~/.ssh/config, keys and agent; `ODW_SSH`
 * replaces the binary (the tests use a fake) — that runs `sh -c <script>` on
 * the remote, with every value passed as a quoted positional argument, so no
 * remote login shell ever parses user input. No secret is put on a command
 * line: the run's `--args` travel as a file on ssh's stdin.
 *
 *   odw run <wf> --on ssh://[user@]host[:port][/path] [--sync git|rsync] [run flags]
 *     1. `odw --version` there (else `npx --no-install odw`), or a clear error
 *        with install hints;
 *     2. the project goes to the remote workdir (default ~/odw-remote/<repo>):
 *        `git` (the default) sends a `git bundle` of HEAD plus a patch of the
 *        uncommitted changes, untracked files included (made with a temporary
 *        index, so yours is never touched); `rsync` mirrors the directory,
 *        .gitignore'd files left out. The workdir is odw's: a directory there
 *        that odw did not make (no `.odw-remote/workdir` marker) is refused,
 *        never overwritten;
 *     3. `odw run … --detach` there; the remote run id is printed.
 *   The remote uses its own odw config and agent CLI logins: nothing of the
 *   user's ~/.config/odw is copied (a project's odw.config.json travels with
 *   the project, as any file in it does).
 *
 *   odw pull <run> --from ssh://host — the run directory comes back into the
 *   local runs root (rsync when this machine has it, else tar over ssh), as
 *   `origin: "remote"` with `remote: { url, host, dir, origin, pulledAt }` in
 *   meta.json, so status, diff, apply, compare and the dashboard read it. A
 *   run still going can be pulled again and again: its copy is a snapshot
 *   (the remote worker's pid is dropped, so it never names a local process).
 *
 *   odw status|logs|attach <run> --on ssh://host — the same command, run by
 *   the remote odw, with a terminal (`ssh -t`) for attach and logs --follow.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { loadConfig } from "../adapters/config.js";
import { isOnPath } from "../adapters/executable.js";
import { VERSION } from "../version.generated.js";
import { resolveWorkflow } from "../workflows/resolve.js";
import { readJsonFile, writeJsonAtomic } from "./fs-util.js";
import { RUN_ID_RE } from "./run-source.js";
import { RunStore, TERMINAL_STATES } from "./run-store.js";

/** A command-line mistake in a remote command: printed as-is, exit 2. */
export class RemoteUsageError extends Error {}

/** Where `--on` / `--from` points: `ssh://[user@]host[:port][/path/to/workdir]`. */
export interface SshTarget {
  /** The URL as given (no secrets can be in it: there is no password part). */
  url: string;
  user: string | null;
  /** The host or ssh config alias; an IPv6 address without its brackets. */
  host: string;
  port: number | null;
  /** The remote workdir from the URL's path (`~/…` is home-relative), else null for the default. */
  workdir: string | null;
}

const NAME_RE = /^[A-Za-z0-9._-]+$/;
const URL_RE = /^ssh:\/\/(?:([^@/?#]+)@)?(\[[0-9A-Fa-f:.]+\]|[^/:@?#[\]]+)(?::(\d+))?(\/[^?#]*)?$/;

/** Parse `ssh://[user@]host[:port][/path]`; throws RemoteUsageError on anything else. */
export function parseSshTarget(raw: string, flag = "--on"): SshTarget {
  const m = URL_RE.exec(raw);
  const bad = (why: string) =>
    new RemoteUsageError(`${flag} must be ssh://[user@]host[:port][/path/to/workdir] (${why}); got '${raw}'`);
  if (!m) throw bad("not an ssh:// URL");
  const [, user, hostPart, portText, pathPart] = m;
  if (user !== undefined && (!NAME_RE.test(user) || user.startsWith("-"))) throw bad("a user name is letters, digits and . _ -");
  const host = hostPart!.startsWith("[") ? hostPart!.slice(1, -1) : hostPart!;
  if (!hostPart!.startsWith("[") && (!NAME_RE.test(host) || host.startsWith("-"))) {
    throw bad("a host is a name or address: letters, digits and . _ -");
  }
  let port: number | null = null;
  if (portText !== undefined) {
    port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw bad("the port is 1-65535");
  }
  let workdir: string | null = null;
  if (pathPart !== undefined && pathPart !== "/" && pathPart !== "") {
    let path: string;
    try {
      path = decodeURIComponent(pathPart);
    } catch {
      throw bad("the path is not valid percent-encoding");
    }
    if (/[\0\n\r]/.test(path)) throw bad("the path holds a control character");
    // ssh://host/~/work is home-relative; ssh://host/srv/work is absolute.
    workdir = path === "/~" || path.startsWith("/~/") ? path.slice(1) : path;
    workdir = workdir.replace(/\/+$/, "") || "/";
  }
  return { url: raw, user: user ?? null, host, port, workdir };
}

/** `user@host` as ssh takes it. */
export function sshDestination(target: SshTarget): string {
  return target.user ? `${target.user}@${target.host}` : target.host;
}

/** The ssh binary: `ODW_SSH` (tests point it at a fake), else `ssh` from PATH. */
export function sshBinary(env: NodeJS.ProcessEnv = process.env): string {
  return env.ODW_SSH && env.ODW_SSH.trim() !== "" ? env.ODW_SSH : "ssh";
}

/** The rsync binary: `ODW_RSYNC`, else `rsync`; null when it is not there. */
function rsyncBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const bin = env.ODW_RSYNC && env.ODW_RSYNC.trim() !== "" ? env.ODW_RSYNC : "rsync";
  return isOnPath(bin) ? bin : null;
}

/** A single-quoted POSIX shell word. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A remote path as a shell expression: `~/x` → "$HOME"/'x', anything else quoted. */
function remotePathExpr(path: string): string {
  if (path === "~") return '"$HOME"';
  if (path.startsWith("~/")) return `"$HOME"/${shQuote(path.slice(2))}`;
  return shQuote(path);
}

/** A remote path as rsync names it: home-relative paths lose their `~/`. */
function rsyncRemotePath(target: SshTarget, path: string): string {
  const rel = path === "~" ? "." : path.startsWith("~/") ? path.slice(2) : path;
  const host = target.host.includes(":") ? `[${target.host}]` : target.host;
  return `${target.user ? `${target.user}@` : ""}${host}:${rel}`;
}

/** The argv for one ssh call that runs `sh -c script` there with `args` as $1…. */
export function sshArgv(target: SshTarget, script: string, args: string[], opts: { tty?: boolean } = {}): string[] {
  // ssh joins its trailing words with spaces for the remote login shell: one
  // pre-quoted command line, so that shell — whichever it is — only unquotes.
  const command = ["sh", "-c", shQuote(script), "odw-remote", ...args.map(shQuote)].join(" ");
  return [
    ...(target.port !== null ? ["-p", String(target.port)] : []),
    ...(opts.tty ? ["-t"] : []),
    "--",
    sshDestination(target),
    command,
  ];
}

/**
 * The remote odw, as a shell prelude: `odw` from the PATH a non-interactive
 * ssh session gets, else `npx --no-install odw` (a project's own copy, never
 * downloaded), prepended to "$@"; exit 127 when neither is there.
 */
const FIND_ODW =
  'if command -v odw >/dev/null 2>&1; then set -- odw "$@"; ' +
  'elif command -v npx >/dev/null 2>&1 && npx --no-install odw --version >/dev/null 2>&1; then set -- npx --no-install odw "$@"; ' +
  'else echo "odw-remote: no odw on the PATH of a non-interactive ssh session" >&2; exit 127; fi';

/** The default remote workdir for a local project: ~/odw-remote/<its directory's name>. */
export function defaultWorkdir(localRoot: string): string {
  const name = basename(localRoot).replace(/[^A-Za-z0-9._-]+/g, "-");
  return `~/odw-remote/${name === "" || /^\.+$/.test(name) ? "project" : name}`;
}

/** The project a command run here stands in: the git top level of `dir`, else `dir`. */
function projectRoot(dir: string): string {
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8" });
  return top.status === 0 && top.stdout.trim() !== "" ? top.stdout.trim() : resolve(dir);
}

function workdirOf(target: SshTarget, localDir: string): string {
  return target.workdir ?? defaultWorkdir(projectRoot(localDir));
}

interface Finished {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a process to its end. stdin: inherit, ignore, or a file to read.
 * stdout is captured or forwarded; stderr is forwarded (and kept, for the
 * message of a failure) — both as text through process.stdout/stderr.write.
 */
function runProcess(
  cmd: string,
  args: string[],
  opts: { stdin?: "inherit" | "ignore" | { file: string }; stdout: "capture" | "forward"; stdoutTo?: NodeJS.WritableStream; cwd?: string },
): Promise<Finished> {
  return new Promise((done) => {
    const stdinFd = typeof opts.stdin === "object" ? openSync(opts.stdin.file, "r") : null;
    const stdin: number | "inherit" | "ignore" = stdinFd ?? (typeof opts.stdin === "string" ? opts.stdin : "ignore");
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        stdio: [stdin, "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      if (stdinFd !== null) closeSync(stdinFd);
      done({ code: 127, stdout: "", stderr: (err as Error).message });
      return;
    }
    if (stdinFd !== null) closeSync(stdinFd);
    let stdout = "";
    let stderr = "";
    if (opts.stdoutTo) {
      child.stdout!.pipe(opts.stdoutTo);
    } else {
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => {
        if (opts.stdout === "capture") stdout += chunk;
        else process.stdout.write(chunk);
      });
    }
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-32 * 1024);
      process.stderr.write(chunk);
    });
    child.on("error", (err) => done({ code: 127, stdout, stderr: `${stderr}${(err as Error).message}` }));
    child.on("close", (code, signal) => done({ code: code ?? (signal ? 128 : 1), stdout, stderr }));
  });
}

/** One ssh call: `sh -c script` there with `args`. */
function ssh(
  target: SshTarget,
  script: string,
  args: string[],
  opts: { stdin?: "inherit" | "ignore" | { file: string }; stdout: "capture" | "forward"; tty?: boolean; stdoutTo?: NodeJS.WritableStream },
): Promise<Finished> {
  return runProcess(sshBinary(), sshArgv(target, script, args, { tty: opts.tty }), opts);
}

/** What a failed ssh call means, in words: ssh's own 255, a missing odw's 127, or the remote command's code. */
function sshFailure(target: SshTarget, what: string, result: Finished): string {
  if (result.code === 255) {
    return `ssh could not reach ${sshDestination(target)} (exit 255) while ${what} — check that \`ssh ${sshDestination(target)}\` works on its own`;
  }
  if (result.code === 127 && /odw-remote: no odw/.test(result.stderr)) return missingOdwText(target);
  if (result.code === 127 && result.stdout === "" && /ENOENT|not found/i.test(result.stderr) && !/odw-remote/.test(result.stderr)) {
    return `could not run ${sshBinary()} (${result.stderr.trim() || "not found"}) — is ssh installed? (ODW_SSH overrides it)`;
  }
  return `${what} on ${sshDestination(target)} failed (exit ${result.code})`;
}

function missingOdwText(target: SshTarget): string {
  const dest = sshDestination(target);
  return [
    `odw is not installed on ${dest}, or not on the PATH a non-interactive ssh session gets.`,
    `  install it there:  ssh ${dest} 'npm install -g odw'   (Node.js 20 or later), or put the odw binary on that PATH`,
    `  then check:        ssh ${dest} odw --version`,
    "  the remote run uses the remote's own odw config and agent CLI logins (claude, codex, …): set those up there too",
  ].join("\n");
}

/** Ask the remote for its odw version; null (with the error printed) when there is none. */
async function probeOdw(target: SshTarget, workdir: string, cmd: string): Promise<string | null> {
  const script = `cd ${remotePathExpr(workdir)} 2>/dev/null || cd; ${FIND_ODW}; exec "$@"`;
  const result = await ssh(target, script, ["--version"], { stdout: "capture" });
  if (result.code !== 0) {
    process.stderr.write(`odw ${cmd}: ${sshFailure(target, "checking for odw", result)}\n`);
    return null;
  }
  const version = result.stdout.trim().split("\n").pop() ?? "";
  const local = `open-dynamic-workflows ${VERSION}`;
  if (version !== local) process.stderr.write(`note: ${sshDestination(target)} has ${version || "an odw of unknown version"}; this one is ${local}\n`);
  return version;
}

// --- odw run --on ------------------------------------------------------------

export interface RemoteRunOptions {
  ref: string;
  target: SshTarget;
  sync: "git" | "rsync";
  /** The local project directory (--source, else the cwd). */
  source: string;
  /** The run's input, parsed (null: none). Sent as a file, never on a command line. */
  args: unknown;
  /** Run flags passed on as they are: --adapter, --permissions, --untrusted, --sandbox… */
  flags: string[];
}

/** `path` with its links resolved, or as given when it cannot be (it does not exist yet). */
function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Is a `relative()` path outside its base: `..`, `../x` or absolute (a `..data` beside it is inside)? */
export function isOutside(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/** `odw run <wf> --on ssh://host`: check, sync, start detached there, print the remote run id. Returns the exit code. */
export async function remoteRun(opts: RemoteRunOptions): Promise<number> {
  const { target } = opts;
  // Links resolved: git names the project by its real path (macOS: /var is /private/var).
  const source = realPath(resolve(opts.source));
  const root = projectRoot(source);
  const workdir = target.workdir ?? defaultWorkdir(root);
  const where = `${sshDestination(target)}:${workdir}`;

  if (opts.sync === "git" && !isGitRepo(root)) {
    throw new RemoteUsageError(`odw run: ${root} is not a git repository — --sync git sends a git bundle; use --sync rsync to copy the directory as it is`);
  }
  // The source directory is where the remote run starts, relative to the project.
  const sub = relative(root, source);
  if (isOutside(sub)) throw new RemoteUsageError(`odw run: --source ${source} is outside the project ${root}`);

  const stage = mkdtempSync(join(tmpdir(), "odw-remote-"));
  try {
    const remoteRef = stageWorkflow(opts.ref, source, root, stage);

    if ((await probeOdw(target, workdir, "run")) === null) return 1;

    // Everything that travels on stdin: the bundle and patch (git), the args, a workflow from outside the project.
    let what: string;
    if (opts.sync === "git") {
      const made = makeBundle(root, stage);
      what = made.files > 0
        ? `git bundle of HEAD ${made.head} + a patch of ${made.files} uncommitted file(s) (untracked ones included)`
        : `git bundle of HEAD ${made.head} (no uncommitted changes)`;
    } else {
      what = "rsync of the project directory (.gitignore'd files left out)";
    }
    const argsName = opts.args === null || opts.args === undefined ? null : "args.json";
    if (argsName) writeFileSync(join(stage, argsName), JSON.stringify(opts.args));
    const tarFile = join(tmpdir(), `${basename(stage)}.tar`);
    try {
      const tar = spawnSync("tar", ["-cf", tarFile, "-C", stage, "."], { encoding: "utf8" });
      if (tar.status !== 0) {
        process.stderr.write(`odw run: could not pack the sync (tar: ${(tar.stderr || tar.error?.message || "").trim()})\n`);
        return 1;
      }
      process.stderr.write(`syncing ${root} to ${where}: ${what}\n`);
      const staged = await ssh(target, STAGE_SCRIPT, [workdir, opts.sync], {
        stdin: { file: tarFile },
        stdout: "capture",
      });
      if (staged.code !== 0) {
        process.stderr.write(
          `odw run: ${staged.code === 3 ? `${where} exists and was not made by odw run --on: pick another path (ssh://host/path)` : sshFailure(target, "syncing the project", staged)}\n`,
        );
        return 1;
      }
    } finally {
      rmSync(tarFile, { force: true });
    }
    if (opts.sync === "rsync") {
      const code = await rsyncPush(target, root, workdir);
      if (code !== 0) return 1;
    }

    const runArgs = ["run", remoteRef, "--detach", ...opts.flags, ...(argsName ? ["--args", `@.odw-remote/incoming/${argsName}`] : [])];
    const script = `cd ${remotePathExpr(workdir)} || exit 1; cd "$ODW_SUB" 2>/dev/null || true; ${FIND_ODW}; exec "$@"`;
    // ODW_SUB: --source inside the project, relative to its top. Set inline, so no remote env passing is needed.
    const started = await ssh(target, `ODW_SUB=${shQuote(sub === "" ? "." : sub.split(sep).join("/"))}; ${script}`, runArgs, { stdout: "capture" });
    const runId = started.stdout.trim().split("\n").pop()?.trim() ?? "";
    if (started.code !== 0 || !RUN_ID_RE.test(runId)) {
      process.stderr.write(`odw run: ${started.code !== 0 ? sshFailure(target, "starting the run", started) : `the remote odw printed no run id (${JSON.stringify(started.stdout.slice(0, 200))})`}\n`);
      return 1;
    }
    process.stdout.write(runId + "\n");
    process.stderr.write(
      `started run ${runId} on ${sshDestination(target)} in ${workdir} — it uses that machine's odw config and agent CLI logins\n` +
        `  odw status ${runId} --on ${target.url}\n` +
        `  odw attach ${runId} --on ${target.url}\n` +
        `  odw pull ${runId} --from ${target.url}   (copy it here for diff, apply, compare and the dashboard)\n`,
    );
    return 0;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/**
 * On the remote, with the staged tar on stdin: make (or reuse) the workdir —
 * refusing a non-empty one odw did not make — unpack into
 * .odw-remote/incoming, keep any workflow under .odw-remote/workflows, and
 * for git: fetch the bundle, check it out, clean, apply the patch. $1 the
 * workdir (~/… home-relative), $2 git|rsync.
 */
const STAGE_SCRIPT = [
  "set -e",
  'case "$1" in "~") W="$HOME" ;; "~/"*) W="$HOME/${1#"~/"}" ;; *) W="$1" ;; esac',
  'if [ -d "$W" ] && [ ! -f "$W/.odw-remote/workdir" ] && [ -n "$(ls -A "$W" 2>/dev/null)" ]; then exit 3; fi',
  'mkdir -p "$W/.odw-remote/workflows"',
  'cd "$W"',
  'echo "a workdir of odw run --on: odw may overwrite or clean everything here" > .odw-remote/workdir',
  "rm -rf .odw-remote/incoming",
  "mkdir .odw-remote/incoming",
  "tar -xf - -C .odw-remote/incoming",
  "if [ -d .odw-remote/incoming/workflows ]; then cp .odw-remote/incoming/workflows/* .odw-remote/workflows/; fi",
  'if [ "$2" = git ]; then',
  "  [ -d .git ] || git init -q",
  "  mkdir -p .git/info",
  "  grep -qx '/.odw-remote/' .git/info/exclude 2>/dev/null || echo '/.odw-remote/' >> .git/info/exclude",
  "  git fetch -q --force .odw-remote/incoming/repo.bundle HEAD:refs/odw/synced",
  "  git -c advice.detachedHead=false checkout -q -f --detach refs/odw/synced",
  "  git clean -fdq",
  "  if [ -s .odw-remote/incoming/changes.patch ]; then git apply --binary --whitespace=nowarn .odw-remote/incoming/changes.patch; fi",
  "fi",
].join("\n");

function isGitRepo(dir: string): boolean {
  return spawnSync("git", ["rev-parse", "--verify", "-q", "HEAD"], { cwd: dir, encoding: "utf8" }).status === 0;
}

/**
 * HEAD as a git bundle, and every uncommitted change — staged, unstaged,
 * untracked and not ignored — as one binary patch against it, made with a
 * temporary index so the user's own index is never touched.
 */
function makeBundle(root: string, stage: string): { head: string; files: number } {
  const git = (args: string[], env?: NodeJS.ProcessEnv) => {
    const r = spawnSync("git", args, { cwd: root, encoding: "buffer", env: env ? { ...process.env, ...env } : process.env, maxBuffer: 1 << 30 });
    if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr?.toString() || r.error?.message || "").trim()}`);
    return r.stdout;
  };
  git(["bundle", "create", join(stage, "repo.bundle"), "HEAD"]);
  const head = git(["rev-parse", "--short", "HEAD"]).toString().trim();
  const index = join(stage, "index");
  const env = { GIT_INDEX_FILE: index };
  // A copy of the real index keeps its stat cache (no rehash of every file); without one, HEAD's tree.
  const real = resolve(root, git(["rev-parse", "--git-path", "index"]).toString().trim());
  if (existsSync(real)) copyFileSync(real, index);
  else git(["read-tree", "HEAD"], env);
  git(["add", "-A"], env);
  const names = git(["diff", "--cached", "--name-only", "-z", "HEAD"], env).toString().split("\0").filter(Boolean);
  writeFileSync(join(stage, "changes.patch"), names.length > 0 ? git(["diff", "--cached", "--binary", "--no-color", "HEAD"], env) : "");
  rmSync(index, { force: true });
  return { head, files: names.length };
}

/**
 * The workflow as the remote should name it: a name that resolves in the
 * project (or nowhere here) as itself; a path inside the project relative to
 * the remote workdir; anything else — a global or plugin workflow, a file
 * outside the project — staged and sent along, kept under .odw-remote/workflows.
 */
function stageWorkflow(ref: string, source: string, root: string, stage: string): string {
  let scriptPath: string;
  let origin: string;
  try {
    const resolved = resolveWorkflow(ref, { cwd: source, config: loadConfig(null, { quiet: true, cwd: source }) });
    scriptPath = resolved.scriptPath;
    origin = resolved.origin;
  } catch (err) {
    // A name this machine does not know may be one the remote does.
    if (/^[A-Za-z0-9._:-]+$/.test(ref) && !/\.(?:js|mjs|cjs)$/i.test(ref) && !ref.startsWith(".")) return ref;
    throw err;
  }
  const rel = relative(root, realPath(scriptPath));
  const inside = !isOutside(rel);
  if (origin === "project" && inside) return ref;
  // The remote run starts in the source's place in the workdir: a path is relative to it, as here.
  if (origin === "path" && inside) return `./${relative(source, realPath(scriptPath)).split(sep).join("/")}`;
  const text = readFileSync(scriptPath);
  const name = `${createHash("sha256").update(text).digest("hex").slice(0, 12)}-${basename(scriptPath).replace(/[^A-Za-z0-9._-]+/g, "-")}`;
  mkdirSync(join(stage, "workflows"), { recursive: true });
  copyFileSync(scriptPath, join(stage, "workflows", name));
  process.stderr.write(`sending ${scriptPath} along (it is outside the project) as .odw-remote/workflows/${name}\n`);
  return `./.odw-remote/workflows/${name}`;
}

/** `--sync rsync`: mirror the project into the workdir, .gitignore'd files and odw's own .odw-remote/ left alone. */
async function rsyncPush(target: SshTarget, root: string, workdir: string): Promise<number> {
  const bin = rsyncBinary();
  if (!bin) {
    process.stderr.write("odw run: --sync rsync needs rsync on this machine (and on the remote) — or use --sync git\n");
    return 1;
  }
  const result = await runProcess(
    bin,
    [
      "-az",
      "--delete",
      "--protect-args",
      "--filter=:- .gitignore",
      "--exclude=/.odw-remote/",
      "-e",
      rsyncShell(target),
      `${root}/`,
      `${rsyncRemotePath(target, workdir)}/`,
    ],
    { stdout: "forward" },
  );
  if (result.code !== 0) process.stderr.write(`odw run: rsync to ${sshDestination(target)} failed (exit ${result.code})\n`);
  return result.code;
}

/** rsync's -e: the same ssh, on the same port. */
function rsyncShell(target: SshTarget): string {
  return [sshBinary(), ...(target.port !== null ? ["-p", String(target.port)] : [])].join(" ");
}

// --- odw pull ----------------------------------------------------------------

export interface PullOptions {
  runId: string;
  target: SshTarget;
  store: RunStore;
  /** The local directory the default workdir is named after (the cwd). */
  cwd: string;
}

/** Is `id` a run id odw would make or read (and safe as a path segment)? */
export function isRemoteRunId(id: string): boolean {
  return id.length <= 200 && RUN_ID_RE.test(id) && !/^\.+$/.test(id);
}

/** `odw pull <run> --from ssh://host`: copy the run directory here; returns the exit code. */
export async function pullRun(opts: PullOptions): Promise<number> {
  const { target, store, runId } = opts;
  if (!isRemoteRunId(runId)) throw new RemoteUsageError(`odw pull: '${runId}' is not a run id`);
  const workdir = workdirOf(target, opts.cwd);

  // Where the remote keeps it: its odw resolves its own runs root, from the workdir (a project config there counts).
  const script = `cd ${remotePathExpr(workdir)} 2>/dev/null || cd; ${FIND_ODW}; exec "$@"`;
  const found = await ssh(target, script, ["__run-dir", runId], { stdout: "capture" });
  if (found.code !== 0) {
    const why = /unknown command '__run-dir'/.test(found.stderr)
      ? `the odw on ${sshDestination(target)} is too old to be pulled from: upgrade it there (npm install -g odw)`
      : found.code === 1
        ? `${sshDestination(target)} has no run ${runId}`
        : sshFailure(target, "finding the run", found);
    process.stderr.write(`odw pull: ${why}\n`);
    return 1;
  }
  const remoteDir = found.stdout.trim().split("\n").pop()?.trim() ?? "";
  if (!remoteDir.startsWith("/") || basename(remoteDir) !== runId || /[\0\r]/.test(remoteDir)) {
    process.stderr.write(`odw pull: the remote odw named an unexpected run directory: ${JSON.stringify(remoteDir.slice(0, 300))}\n`);
    return 1;
  }

  let dest: string;
  if (store.exists(runId)) {
    dest = store.runDir(runId);
    if (store.readMeta(runId).origin !== "remote") {
      process.stderr.write(`odw pull: a run ${runId} already exists here that was not pulled (${dest}); not overwriting it\n`);
      return 1;
    }
  } else {
    const bucket = basename(dirname(remoteDir));
    dest = join(store.root, NAME_RE.test(bucket) && !/^\.+$/.test(bucket) ? bucket : "remote", runId);
  }

  // The copy lands in a staging directory first — deep enough that no listing
  // of the runs root sees it — and is checked and marked there, then moved
  // into place: a pull that fails leaves nothing that looks like a run (an
  // earlier copy stands as it was), and no local command reads half of one.
  const stagingRoot = join(store.root, PULL_STAGING);
  mkdirSync(stagingRoot, { recursive: true });
  const staging = mkdtempSync(join(stagingRoot, `${runId}-`));
  const stage = join(staging, "run");
  mkdirSync(stage);
  let status: Record<string, unknown> | null;
  let how: string | null;
  try {
    how = await copyRunDir(target, remoteDir, stage);
    if (how === null) return 1;

    // Links never come back: a remote `decisions.jsonl -> ~/.bashrc` would have
    // a local write land outside the runs root. Nor do devices, sockets or fifos.
    const dropped = dropNonFiles(stage);
    if (dropped.length > 0) {
      const named = dropped.slice(0, 5).map((path) => JSON.stringify(path.slice(0, 200))).join(", ");
      process.stderr.write(
        `odw pull: left out ${dropped.length} link(s) or special file(s) of the remote run directory: ${named}${dropped.length > 5 ? ", …" : ""}\n`,
      );
    }

    // Mark it, and drop the remote worker's pid: it names a process over there, never one here.
    const metaPath = join(stage, "meta.json");
    const meta = readJsonFile(metaPath);
    if (!meta) {
      process.stderr.write(`odw pull: the copy of ${runId} has no readable meta.json — is it a run? Nothing was kept here\n`);
      return 1;
    }
    const previous = (meta.remote ?? null) as { origin?: unknown } | null;
    const firstOrigin = meta.origin === "remote" && previous ? (previous.origin ?? null) : (meta.origin ?? null);
    writeJsonAtomic(metaPath, {
      ...meta,
      origin: "remote",
      remote: { url: target.url, host: sshDestination(target), dir: remoteDir, origin: firstOrigin, pulledAt: Date.now() / 1000 },
    });
    const statusPath = join(stage, "status.json");
    status = readJsonFile(statusPath);
    if (status && ("pid" in status || "pidStart" in status)) {
      delete status.pid;
      delete status.pidStart;
      writeJsonAtomic(statusPath, status);
    }
    rmSync(join(stage, "worker.pid"), { force: true });

    // Into place: an earlier copy steps aside first, and comes back if the move fails.
    mkdirSync(dirname(dest), { recursive: true });
    const aside = join(staging, "previous");
    const hadCopy = existsSync(dest);
    if (hadCopy) renameSync(dest, aside);
    try {
      renameSync(stage, dest);
    } catch (err) {
      if (hadCopy) renameSync(aside, dest);
      process.stderr.write(`odw pull: could not move the copy into ${dest}: ${(err as Error).message}\n`);
      return 1;
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
    try {
      rmdirSync(stagingRoot); // gone once no other pull stages a copy
    } catch {
      /* another pull's, or gone already */
    }
  }

  const state = String(status?.state ?? "?");
  process.stdout.write(runId + "\n");
  process.stderr.write(`pulled ${runId} [${state}] from ${sshDestination(target)} (${how}) into ${dest}\n`);
  if (!TERMINAL_STATES.has(state)) {
    process.stderr.write(
      `  still going there: this copy is a snapshot (it reads as stale here) — pull again for more, or watch it: odw attach ${runId} --on ${target.url}\n`,
    );
  }
  return 0;
}

/** Where `odw pull` stages its copies, under the runs root: a run there sits a level deeper than any listing looks. */
const PULL_STAGING = ".odw-pull";

/**
 * Remove every symbolic link — and device, socket or fifo — under `dir`,
 * never following one; returns their paths, relative to `dir`.
 */
export function dropNonFiles(dir: string): string[] {
  const dropped: string[] = [];
  const walk = (at: string, rel: string): void => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      const shown = rel === "" ? name : `${rel}/${name}`;
      const st = lstatSync(path);
      if (st.isDirectory()) walk(path, shown);
      else if (!st.isFile()) {
        rmSync(path, { force: true });
        dropped.push(shown);
      }
    }
  };
  walk(dir, "");
  return dropped;
}

/** Copy the remote run directory into `dest`: rsync when this machine has it, else (or when it fails) tar over ssh. */
async function copyRunDir(target: SshTarget, remoteDir: string, dest: string): Promise<string | null> {
  const bin = rsyncBinary();
  if (bin) {
    // No links, devices or specials (-a would keep them): a run directory makes none of its own.
    const result = await runProcess(
      bin,
      ["-a", "--no-links", "--no-D", "--protect-args", "--exclude=worker.pid", "-e", rsyncShell(target), `${rsyncRemotePath(target, remoteDir)}/`, `${dest}/`],
      { stdout: "forward" },
    );
    // 24: files vanished while it copied — a live run's temp files; the copy stands.
    if (result.code === 0 || result.code === 24) return "rsync";
    process.stderr.write(`odw pull: rsync failed (exit ${result.code}); trying tar over ssh\n`);
  }
  const untar = spawn("tar", ["-xf", "-", "-C", dest], { stdio: ["pipe", "ignore", "pipe"] });
  let untarErr = "";
  untar.stderr.setEncoding("utf8");
  untar.stderr.on("data", (c: string) => (untarErr += c));
  const untarDone = new Promise<number>((done) => {
    untar.on("error", (err) => {
      untarErr += err.message;
      done(127);
    });
    untar.on("close", (code) => done(code ?? 1));
  });
  // GNU tar exits 1 when a file changed as it read it (a live run): the archive is still whole.
  const sent = await ssh(target, 'cd "$1" && exec tar --exclude=worker.pid -cf - .', [remoteDir], {
    stdout: "forward",
    stdoutTo: untar.stdin as unknown as NodeJS.WritableStream,
  });
  const untarCode = await untarDone;
  if ((sent.code !== 0 && sent.code !== 1) || untarCode !== 0) {
    process.stderr.write(
      `odw pull: ${sent.code !== 0 && sent.code !== 1 ? sshFailure(target, "sending the run (tar)", sent) : `tar here failed: ${untarErr.trim()}`}\n`,
    );
    return null;
  }
  return "tar over ssh";
}

// --- odw status|logs|attach|approve|… --on ------------------------------------------------

/** `--on URL` / `--on=URL` out of `args`: the URL (null when absent) and the rest, untouched. */
export function takeOnFlag(args: string[], flag = "--on"): { url: string | null; rest: string[] } {
  const rest: string[] = [];
  let url: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      rest.push(...args.slice(i));
      break;
    }
    if (arg === flag) {
      const next = args[i + 1];
      if (next === undefined) throw new RemoteUsageError(`${flag} needs ssh://[user@]host[:port][/path]`);
      url = next;
      i++;
    } else if (arg.startsWith(`${flag}=`)) {
      url = arg.slice(flag.length + 1);
    } else {
      rest.push(arg);
    }
  }
  return { url, rest };
}

/** The commands `--on ssh://host` runs on the remote odw instead of here. */
export const PASS_THROUGH = ["status", "logs", "attach", "approve", "reject", "pause", "stop", "resume"] as const;
export type PassThroughCommand = (typeof PASS_THROUGH)[number];

/**
 * `odw status|logs|attach|approve|reject|pause|stop|resume <run> … --on
 * ssh://host`: the same command, run by the remote odw from the workdir (so
 * a project config there counts), its output and exit code passed back.
 * attach, logs --follow and approve --edit get a terminal there when this
 * one is a terminal (ssh -t), so attach shows the live view.
 */
export async function passThrough(command: PassThroughCommand, args: string[], target: SshTarget, cwd: string): Promise<number> {
  const workdir = workdirOf(target, cwd);
  const live =
    command === "attach" ||
    (command === "logs" && args.some((a) => a === "--follow" || a === "-f")) ||
    (command === "approve" && args.includes("--edit"));
  const tty = live && process.stdin.isTTY === true && process.stdout.isTTY === true;
  const script = `cd ${remotePathExpr(workdir)} 2>/dev/null || cd; ${FIND_ODW}; exec "$@"`;
  const result = await ssh(target, script, [command, ...args], { stdout: "forward", stdin: tty ? "inherit" : "ignore", tty });
  if (result.code === 255 || (result.code === 127 && /odw-remote: no odw/.test(result.stderr))) {
    process.stderr.write(`odw ${command}: ${sshFailure(target, `odw ${command}`, result)}\n`);
  }
  return result.code;
}

/**
 * Why a run pulled from a remote (`origin: "remote"`) is not answered or
 * controlled here — the decision or the control would only change this copy,
 * while the run goes on there — or null for a run of this machine. `command`:
 * what to run there instead, with `--on`.
 */
export function pulledRunRefusal(meta: Record<string, unknown>, runId: string, command: string): string | null {
  if (meta.origin !== "remote") return null;
  const remote = (meta.remote ?? null) as { url?: unknown } | null;
  const url = typeof remote?.url === "string" && URL_RE.test(remote.url) ? remote.url : "ssh://<host>";
  return (
    `run ${runId} was pulled from ${url}: this copy is a snapshot, and answering or controlling it here would change only the copy — ` +
    `the run itself is there. Do it there: odw ${command} ${runId} --on ${url}`
  );
}

/** Hidden `odw __run-dir <run>` (what `odw pull` asks the remote): the run's absolute directory, exit 1 when none. */
export function printRunDir(store: RunStore, runId: string | undefined): number {
  if (!runId || !isRemoteRunId(runId) || !store.exists(runId)) {
    process.stderr.write(`no such run: ${runId ?? ""}\n`);
    return 1;
  }
  process.stdout.write(resolve(store.runDir(runId)) + "\n");
  return 0;
}
