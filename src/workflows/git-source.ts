/**
 * Reading workflows out of a git repository (an ODW extension; `odw workflows
 * add|update`), without running anything from it.
 *
 * The repository is fetched into a fresh, bare repository in a temp directory
 * — one commit deep (`--depth 1`), no tags, no submodules — and its files are
 * read as blobs (`git ls-tree`, `git cat-file`): nothing is ever checked out,
 * so no filter, attribute, symlink or hook of the repository's has a working
 * tree to act on. The temp repository is made from an empty template and
 * `core.hooksPath` points at an empty directory, so no hook runs either.
 * Only https, ssh and file URLs are accepted (`GIT_ALLOW_PROTOCOL`, which
 * also covers a redirect); `git` never prompts (`GIT_TERMINAL_PROMPT=0`).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { ConfigError } from "../errors.js";
import { expandHome } from "../adapters/config.js";

/** A source as given: `<url>[#ref]`. */
export interface GitSource {
  /** The URL fetched: https://, ssh://, scp-like `user@host:path`, or file:// (a local directory becomes one). */
  url: string;
  /** The ref after `#`: a branch, tag or commit id; null for the remote's HEAD. */
  ref: string | null;
}

/** A ref git takes as one fetch argument: no option, no refspec, no `..`. */
const REF_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/+-]{1,200}$/;
const SCP_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:(?!\/\/)[^\s]+$/;

/**
 * `<git-url>[#ref]` as a {@link GitSource}; a ConfigError for any other
 * scheme (http, git, ext::, …), an option-shaped argument, or a bad ref. A
 * local directory (`./flows`, `/abs/flows`, `~/flows`) is read as its file:// URL.
 */
export function parseGitSource(arg: string, cwd: string = process.cwd()): GitSource {
  const hash = arg.lastIndexOf("#");
  const base = hash >= 0 ? arg.slice(0, hash) : arg;
  const ref = hash >= 0 ? arg.slice(hash + 1) : null;
  if (ref !== null && !REF_RE.test(ref)) {
    throw new ConfigError(`'${ref}' is not a ref odw fetches: a branch, tag or commit id (letters, digits and . _ / + -)`);
  }
  if (!base || base.startsWith("-") || /\s/.test(base)) throw new ConfigError(`'${base}' is not a git URL`);
  let url: string;
  if (/^(https|ssh|file):\/\//i.test(base)) url = base;
  else if (SCP_RE.test(base)) url = base; // git@host:org/repo.git — ssh
  else if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(base) && !/^[A-Za-z]:[\\/]/.test(base)) {
    throw new ConfigError(`'${base}': odw fetches workflows over https, ssh or file only`);
  } else {
    const dir = resolve(cwd, expandHome(base));
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new ConfigError(`'${base}' is neither a git URL nor a local directory`);
    url = pathToFileURL(dir).href;
  }
  return { url, ref };
}

/** One file of the fetched commit. */
export interface TreeFile {
  path: string;
  /** `100644`/`100755` a file, `120000` a symlink, `160000` a submodule. */
  mode: string;
  blob: string;
}

export interface FetchedRepo {
  /** The temp directory the bare repository is in; {@link cleanup} removes it. */
  dir: string;
  url: string;
  ref: string | null;
  commit: string;
  /** The entries at `path` (a file, or a directory's direct children), files only; null when there is none. */
  list(path: string): { kind: "file"; file: TreeFile } | { kind: "dir"; files: TreeFile[] } | null;
  read(file: TreeFile): Buffer;
  cleanup(): void;
}

export interface FetchOptions {
  /** Milliseconds each git command may take (default 120 s). */
  timeoutMs?: number;
}

/** Fetch `source` one commit deep into a temp bare repository (see the module comment). */
export function fetchGitSource(source: GitSource, opts: FetchOptions = {}): FetchedRepo {
  const tmp = mkdtempSync(join(tmpdir(), "odw-wf-fetch-"));
  const repo = join(tmp, "repo.git");
  const template = join(tmp, "template");
  const hooks = join(tmp, "no-hooks");
  mkdirSync(template);
  mkdirSync(hooks);
  const timeout = opts.timeoutMs ?? 120_000;
  const env = gitEnv();
  const base = ["-c", `core.hooksPath=${hooks}`, "-c", "core.fsmonitor=false", "-c", "protocol.file.allow=always"];
  const git = (args: string[], encoding: "utf8" | "buffer" = "utf8"): string | Buffer =>
    execFileSync("git", [...base, ...args], {
      cwd: tmp,
      env,
      timeout,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      ...(encoding === "utf8" ? { encoding: "utf8" as const } : {}),
    });
  const cleanup = () => rmSync(tmp, { recursive: true, force: true });
  try {
    try {
      git(["init", "-q", "--bare", `--template=${template}`, repo]);
    } catch (err) {
      throw new ConfigError(`odw workflows needs git on PATH: ${gitMessage(err)}`);
    }
    try {
      git(["-C", repo, "fetch", "-q", "--depth", "1", "--no-tags", "--recurse-submodules=no", "--", source.url, source.ref ?? "HEAD"]);
    } catch (err) {
      throw new ConfigError(`could not fetch ${source.url}${source.ref ? `#${source.ref}` : ""}: ${gitMessage(err)}`);
    }
    const commit = String(git(["-C", repo, "rev-parse", "--verify", "FETCH_HEAD^{commit}"])).trim();
    const tree = String(git(["-C", repo, "ls-tree", "-r", "-z", "--full-tree", commit]))
      .split("\0")
      .filter(Boolean)
      .map((line): TreeFile | null => {
        const m = /^(\d{6}) (\w+) ([0-9a-f]+)\t([\s\S]+)$/.exec(line);
        return m ? { mode: m[1]!, blob: m[3]!, path: m[4]! } : null;
      })
      .filter((f): f is TreeFile => f !== null);
    return {
      dir: tmp,
      url: source.url,
      ref: source.ref,
      commit,
      list(path) {
        const at = normalizeRepoPath(path);
        if (at === "") return { kind: "dir", files: tree.filter((f) => !f.path.includes("/")) };
        const file = tree.find((f) => f.path === at);
        if (file) return { kind: "file", file };
        const prefix = `${at}/`;
        const files = tree.filter((f) => f.path.startsWith(prefix) && !f.path.slice(prefix.length).includes("/"));
        return files.length > 0 || tree.some((f) => f.path.startsWith(prefix)) ? { kind: "dir", files } : null;
      },
      read(file) {
        return git(["-C", repo, "cat-file", "blob", file.blob], "buffer") as Buffer;
      },
      cleanup,
    };
  } catch (err) {
    cleanup();
    throw err;
  }
}

/** A path inside the repository: relative, `/`-separated, no `.` or `..` segment; ConfigError otherwise. */
export function normalizeRepoPath(path: string): string {
  const p = path.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (p === "" || p === ".") return "";
  if (isAbsolute(p) || p.startsWith("/") || p.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) {
    throw new ConfigError(`'${path}' is not a path inside the repository`);
  }
  return p;
}

/** The environment git runs in: the caller's, without anything that would aim it at another repository, never prompting, https/ssh/file only. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|CEILING_DIRECTORIES|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|EXEC_PATH|TEMPLATE_DIR|PROTOCOL_FROM_USER|ALLOW_PROTOCOL)$/.test(k)) continue;
    env[k] = v;
  }
  env.GIT_ALLOW_PROTOCOL = "https:ssh:file";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

function gitMessage(err: unknown): string {
  const e = err as { stderr?: Buffer | string; message?: string };
  const stderr = e.stderr ? String(e.stderr).trim() : "";
  return (stderr || e.message || String(err)).split("\n").slice(-3).join(" ");
}
