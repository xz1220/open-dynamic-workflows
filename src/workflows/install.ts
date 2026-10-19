/**
 * `odw workflows add|update|verify` (an ODW extension): install workflows from
 * git, pinned by a lock (./lock), and check them against it.
 *
 *   odw workflows add <git-url>[#ref] [--path P] [--name N] [--global] [--yes] [--force]
 *   odw workflows update [<name>] [--global] [--yes] [--force]
 *   odw workflows verify [<name>] [--project|--global] [--json]
 *
 * `add` fetches the source (./git-source: shallow, bare, nothing checked out,
 * no hooks, no submodules, https/ssh/file only), picks the workflow files —
 * `--path` (a file, or a directory's `.js` files), else the first of
 * `.odw/workflows`, `.claude/workflows`, `workflows` and the repository's
 * root that has any — keeps those whose `meta` checks (compiled, never run),
 * prints what each reaches outside the dialect (`odw check --capabilities`),
 * asks, and copies them into `.odw/workflows` (`~/.odw/workflows` with
 * `--global`) with a lock entry each. A project install also copies the
 * workflow's `.odw/tests/<stem>.json` and `.odw/evals/<stem>.json` when the
 * repository has them beside it. Nothing from the repository is executed.
 *
 * `update` re-fetches each entry's ref, and shows the diff of every file that
 * changed before writing it; `verify` hashes every locked file (exit 1 when
 * one is modified or missing).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { parseArgs } from "node:util";

import { loadConfig, resolveWorkflowsRoot } from "../adapters/config.js";
import type { Config } from "../adapters/types.js";
import { checkCapabilities, formatCheck } from "../check.js";
import type { DoctorCheck } from "../doctor.js";
import { ConfigError } from "../errors.js";
import { askYesNo, canPrompt } from "../new.js";
import { unifiedDiff } from "../runtime/compare.js";
import { fetchGitSource, normalizeRepoPath, parseGitSource, type FetchedRepo, type TreeFile } from "./git-source.js";
import {
  EXTRA_DIRS,
  EXTRA_KINDS,
  describeSource,
  lockPathFor,
  lockedExtraPath,
  lockedWorkflowPath,
  readLock,
  sha256File,
  sha256Of,
  verifyLock,
  writeLock,
  type ExtraKind,
  type LockEntry,
  type VerifiedFile,
} from "./lock.js";
import { projectLevels } from "../project-levels.js";
import { isValidWorkflowName } from "./resolve.js";

/** Where the prompts go and come from; tests pass their own. */
export interface InstallIo {
  input: NodeJS.ReadableStream & { isTTY?: boolean };
  err: NodeJS.WritableStream & { isTTY?: boolean };
  env: Record<string, string | undefined>;
  cwd: string;
}

const defaultIo = (): InstallIo => ({ input: process.stdin, err: process.stderr, env: process.env, cwd: process.cwd() });

/** Where `odw workflows add` puts a workflow without `--path`: the first of these with any `.js` file. */
const DEFAULT_DIRS = [".odw/workflows", ".claude/workflows", "workflows", ""];

/** The workflows directory an install writes to: `<cwd>/.odw/workflows`, or the global one. */
function installDir(global: boolean, config: Config, cwd: string): string {
  return global ? resolveWorkflowsRoot(config.settings.workflowsRoot) : join(cwd, ".odw", "workflows");
}

/** Every workflows directory a lock may sit beside: each `.odw/workflows` from `cwd` up to its repository root, then the global one. */
export function lockedDirs(cwd: string, config: Config, scope: "project" | "global" | "all" = "all"): string[] {
  const dirs: string[] = [];
  if (scope !== "global") for (const level of projectLevels(cwd)) dirs.push(join(level, ".odw", "workflows"));
  if (scope !== "project") dirs.push(resolveWorkflowsRoot(config.settings.workflowsRoot));
  return [...new Set(dirs)];
}

/** Ask, or refuse when no one can answer: `--yes` is the way to say yes without a terminal. */
async function confirm(question: string, yes: boolean, io: InstallIo): Promise<boolean> {
  if (yes) return true;
  if (!canPrompt(io.input, io.err, io.env)) {
    io.err.write("not writing anything: no terminal to ask on — pass --yes to accept\n");
    return false;
  }
  return (await askYesNo(question, false, io.input, io.err)) === true;
}

function display(path: string, cwd: string): string {
  const rel = relative(cwd, path);
  return rel && !rel.startsWith("..") ? rel.split(sep).join("/") : path;
}

/** A workflow picked from the fetched repository. */
interface Pick {
  file: TreeFile;
  name: string;
  bytes: Buffer;
  /** Its test and eval in the repository, when it has them beside it. */
  extras: Partial<Record<ExtraKind, { file: TreeFile; bytes: Buffer }>>;
}

/** The files of `repo` at `path` (or the default directories) that check as workflows; notes for the rest. */
function pickWorkflows(repo: FetchedRepo, path: string | undefined, notes: string[]): TreeFile[] {
  const isFile = (f: TreeFile) => f.mode === "100644" || f.mode === "100755";
  const candidates = (files: TreeFile[]) =>
    files.filter((f) => {
      if (!f.path.endsWith(".js")) return false;
      if (!isFile(f)) {
        notes.push(`skipped ${f.path}: ${f.mode === "120000" ? "a symlink" : f.mode === "160000" ? "a submodule" : "not a regular file"}`);
        return false;
      }
      return true;
    });
  if (path !== undefined) {
    const at = normalizeRepoPath(path);
    const found = repo.list(at);
    if (!found) throw new ConfigError(`${repo.url} has no '${at}' at ${repo.commit.slice(0, 12)}`);
    if (found.kind === "file") {
      if (!found.file.path.endsWith(".js")) throw new ConfigError(`'${at}' is not a .js workflow`);
      const files = candidates([found.file]);
      if (files.length === 0) throw new ConfigError(`'${at}' is ${notes.pop()?.replace(/^skipped [^:]+: /, "") ?? "not a regular file"}`);
      return files;
    }
    return candidates(found.files);
  }
  for (const dir of DEFAULT_DIRS) {
    const found = repo.list(dir);
    if (found?.kind !== "dir") continue;
    const files = candidates(found.files);
    if (files.length > 0) return files;
  }
  return [];
}

/** The workflow's test or eval in the repository: `<root>/.odw/{tests,evals}/<stem>.json` for a workflow at `<root>/.odw/workflows/<stem>.js`. */
function extrasOf(repo: FetchedRepo, file: TreeFile): Pick["extras"] {
  const m = /^(?:(.*)\/)?\.odw\/workflows\/([^/]+)\.js$/.exec(file.path);
  if (!m) return {};
  const root = m[1] ? `${m[1]}/` : "";
  const out: Pick["extras"] = {};
  for (const kind of EXTRA_KINDS) {
    const found = repo.list(`${root}.odw/${EXTRA_DIRS[kind]}/${m[2]}.json`);
    if (found?.kind === "file" && (found.file.mode === "100644" || found.file.mode === "100755")) {
      out[kind] = { file: found.file, bytes: repo.read(found.file) };
    }
  }
  return out;
}

/** `odw workflows add <git-url>[#ref] [--path P] [--name N] [--global] [--yes] [--force]`. */
export async function cmdWorkflowsAdd(rest: string[], io: InstallIo = defaultIo()): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      path: { type: "string" },
      name: { type: "string" },
      global: { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      force: { type: "boolean" },
    },
  });
  if (positionals.length !== 1) {
    io.err.write("usage: odw workflows add <git-url>[#ref] [--path P] [--name N] [--global] [--yes] [--force]\n");
    return 2;
  }
  if (values.name !== undefined && !isValidWorkflowName(values.name)) {
    io.err.write(`odw workflows add: '${values.name}' is not a workflow name (letters, digits and . _ -)\n`);
    return 2;
  }
  const config = loadConfig(values.config ?? null, { quiet: true, cwd: io.cwd });
  const source = parseGitSource(positionals[0]!, io.cwd);
  const dir = installDir(values.global === true, config, io.cwd);
  const lockPath = lockPathFor(dir);
  const lock = readLock(lockPath);

  io.err.write(`fetching ${source.url}${source.ref ? `#${source.ref}` : ""} …\n`);
  const repo = fetchGitSource(source);
  try {
    const notes: string[] = [];
    const files = pickWorkflows(repo, values.path, notes);
    const picks: Pick[] = [];
    for (const file of files) {
      const bytes = repo.read(file);
      const text = bytes.toString("utf8");
      const report = checkCapabilities(text, file.path);
      for (const line of formatCheck(report)) io.err.write(`  ${line}\n`);
      if (!report.ok) {
        notes.push(`skipped ${file.path}: not a workflow odw can load`);
        continue;
      }
      const stem = file.path.slice(file.path.lastIndexOf("/") + 1, -".js".length);
      picks.push({ file, name: stem, bytes, extras: values.global ? {} : extrasOf(repo, file) });
    }
    for (const note of notes) io.err.write(`  note: ${note}\n`);
    if (picks.length === 0) {
      io.err.write(
        `odw workflows add: no workflow found in ${repo.url} at ${repo.commit.slice(0, 12)}` +
          `${values.path === undefined ? ` (looked in ${DEFAULT_DIRS.map((d) => d || "the root").join(", ")}) — pass --path` : ""}\n`,
      );
      return 1;
    }
    if (values.name !== undefined) {
      if (picks.length > 1) {
        io.err.write(`odw workflows add: --name names one workflow, and ${picks.length} were found — pick one with --path\n`);
        return 2;
      }
      picks[0]!.name = values.name;
    }
    // Never over a file this install did not put there, unless --force; never over one it did (that is update).
    for (const p of picks) {
      const target = lockedWorkflowPath(dir, p.name);
      const locked = Object.hasOwn(lock.workflows, p.name) ? lock.workflows[p.name] : undefined;
      if (locked && !values.force) {
        io.err.write(`odw workflows add: '${p.name}' is already installed from ${describeSource(locked)} — odw workflows update ${p.name}\n`);
        return 1;
      }
      if (!locked && existsSync(target) && !values.force) {
        io.err.write(`odw workflows add: ${display(target, io.cwd)} exists and odw workflows add did not install it — pass --force to replace it\n`);
        return 1;
      }
    }

    io.err.write(`\nfrom ${repo.url}${repo.ref ? `#${repo.ref}` : ""} at ${repo.commit}:\n`);
    for (const p of picks) {
      const extras = EXTRA_KINDS.filter((k) => p.extras[k]).map((k) => `${EXTRA_DIRS[k]}/${p.name}.json`);
      io.err.write(`  ${p.file.path} → ${display(lockedWorkflowPath(dir, p.name), io.cwd)}${extras.length ? ` (+ ${extras.join(", ")})` : ""}\n`);
    }
    io.err.write("installed workflows are third-party: they run in a strict script context unless the config says scriptContext: \"host\"\n");
    if (!(await confirm(`install ${picks.length === 1 ? "it" : `these ${picks.length}`}?`, values.yes === true, io))) return 1;

    mkdirSync(dir, { recursive: true });
    const installedAt = new Date().toISOString();
    for (const p of picks) {
      const target = lockedWorkflowPath(dir, p.name);
      writeFileSync(target, p.bytes);
      const entry: LockEntry = {
        url: repo.url,
        ref: repo.ref,
        commit: repo.commit,
        path: p.file.path,
        sha256: sha256Of(p.bytes),
        installedAt,
      };
      for (const kind of EXTRA_KINDS) {
        const x = p.extras[kind];
        if (!x) continue;
        const at = lockedExtraPath(dir, p.name, kind);
        const before = existsSync(at) ? sha256File(at) : null;
        const previous = Object.hasOwn(lock.workflows, p.name) ? lock.workflows[p.name]![kind] : undefined;
        if (before !== null && before !== previous?.sha256 && !values.force) {
          io.err.write(`  note: kept ${display(at, io.cwd)}: it exists and is not this workflow's (--force replaces it)\n`);
          continue;
        }
        mkdirSync(dirname(at), { recursive: true });
        writeFileSync(at, x.bytes);
        entry[kind] = { path: x.file.path, sha256: sha256Of(x.bytes) };
      }
      lock.workflows[p.name] = entry;
      io.err.write(`installed ${p.name} → ${display(target, io.cwd)}\n`);
    }
    writeLock(lockPath, lock);
    io.err.write(`locked in ${display(lockPath, io.cwd)} — odw workflows verify checks it, odw workflows update moves it\n`);
    return 0;
  } finally {
    repo.cleanup();
  }
}

/** `odw workflows update [<name>] [--global] [--yes] [--force]`. */
export async function cmdWorkflowsUpdate(rest: string[], io: InstallIo = defaultIo()): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      global: { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      force: { type: "boolean" },
    },
  });
  if (positionals.length > 1) {
    io.err.write("usage: odw workflows update [<name>] [--global] [--yes] [--force]\n");
    return 2;
  }
  const only = positionals[0];
  const config = loadConfig(values.config ?? null, { quiet: true, cwd: io.cwd });
  const dir = installDir(values.global === true, config, io.cwd);
  const lockPath = lockPathFor(dir);
  const lock = readLock(lockPath);
  const names = Object.keys(lock.workflows).filter((n) => only === undefined || n === only).sort();
  if (names.length === 0) {
    io.err.write(
      only !== undefined
        ? `odw workflows update: no workflow '${only}' in ${display(lockPath, io.cwd)}\n`
        : `odw workflows update: nothing installed from git in ${display(dir, io.cwd)}\n`,
    );
    return only !== undefined ? 1 : 0;
  }
  // One fetch per source.
  const repos = new Map<string, FetchedRepo>();
  let failed = 0;
  let changed = false;
  try {
    for (const name of names) {
      const entry = lock.workflows[name]!;
      const key = `${entry.url}#${entry.ref ?? ""}`;
      let repo = repos.get(key);
      if (!repo) {
        io.err.write(`fetching ${entry.url}${entry.ref ? `#${entry.ref}` : ""} …\n`);
        try {
          repo = fetchGitSource({ url: entry.url, ref: entry.ref });
        } catch (err) {
          io.err.write(`${name}: ${(err as Error).message}\n`);
          failed++;
          continue;
        }
        repos.set(key, repo);
      }
      const found = repo.list(entry.path);
      if (found?.kind !== "file" || (found.file.mode !== "100644" && found.file.mode !== "100755")) {
        io.err.write(`${name}: ${entry.path} is no longer a file in ${entry.url} at ${repo.commit.slice(0, 12)} — left as installed\n`);
        failed++;
        continue;
      }
      const bytes = repo.read(found.file);
      const text = bytes.toString("utf8");
      const sha256 = sha256Of(bytes);
      const target = lockedWorkflowPath(dir, name);
      const onDisk = sha256File(target);
      const extras = EXTRA_KINDS.map((kind) => {
        const x = entry[kind];
        if (!x) return null;
        const f = repo!.list(x.path);
        return f?.kind === "file" ? { kind, path: x.path, bytes: repo!.read(f.file) } : null;
      }).filter((x): x is { kind: ExtraKind; path: string; bytes: Buffer } => x !== null);
      const extrasChanged = extras.filter((x) => sha256Of(x.bytes) !== entry[x.kind]!.sha256);
      if (sha256 === entry.sha256 && extrasChanged.length === 0) {
        if (repo.commit !== entry.commit) {
          lock.workflows[name] = { ...entry, commit: repo.commit };
          changed = true;
        }
        io.err.write(`${name}: up to date at ${repo.commit.slice(0, 12)}${onDisk !== entry.sha256 ? " (but modified locally: odw workflows verify)" : ""}\n`);
        continue;
      }
      if (onDisk !== null && onDisk !== entry.sha256 && !values.force) {
        io.err.write(`${name}: ${display(target, io.cwd)} was modified since it was installed — not overwriting it (--force does)\n`);
        failed++;
        continue;
      }
      io.err.write(`\n${name}: ${entry.commit.slice(0, 12)} → ${repo.commit.slice(0, 12)} (${entry.url}${entry.ref ? `#${entry.ref}` : ""})\n`);
      if (sha256 !== entry.sha256) {
        const before = onDisk === null ? "" : readFileSync(target, "utf8");
        const diff = unifiedDiff(before, text, { maxLines: 400 });
        process.stdout.write(`--- a/${display(target, io.cwd)}\t${entry.commit.slice(0, 12)}\n+++ b/${display(target, io.cwd)}\t${repo.commit.slice(0, 12)}\n`);
        for (const line of diff.lines) process.stdout.write(`${line}\n`);
        if (diff.truncated) process.stdout.write(`… (diff cut: +${diff.added} −${diff.removed} in all)\n`);
        for (const line of formatCheck(checkCapabilities(text, entry.path))) io.err.write(`  ${line}\n`);
      }
      for (const x of extrasChanged) io.err.write(`  ${EXTRA_DIRS[x.kind]}/${name}.json changed too\n`);
      if (!(await confirm(`update ${name}?`, values.yes === true, io))) {
        failed++;
        continue;
      }
      writeFileSync(target, bytes);
      const next: LockEntry = { ...entry, commit: repo.commit, sha256, installedAt: new Date().toISOString() };
      for (const x of extrasChanged) {
        const at = lockedExtraPath(dir, name, x.kind);
        const local = sha256File(at);
        if (local !== null && local !== entry[x.kind]!.sha256 && !values.force) {
          io.err.write(`  note: kept ${display(at, io.cwd)}: modified since it was installed (--force replaces it)\n`);
          continue;
        }
        mkdirSync(dirname(at), { recursive: true });
        writeFileSync(at, x.bytes);
        next[x.kind] = { path: x.path, sha256: sha256Of(x.bytes) };
      }
      lock.workflows[name] = next;
      changed = true;
      io.err.write(`updated ${name} to ${repo.commit.slice(0, 12)}\n`);
    }
  } finally {
    for (const repo of repos.values()) repo.cleanup();
  }
  if (changed) writeLock(lockPath, lock);
  return failed > 0 ? 1 : 0;
}

/** `odw workflows verify [<name>] [--project|--global] [--json]`: exit 1 when a locked file is modified or missing. */
export function cmdWorkflowsVerify(rest: string[], io: InstallIo = defaultIo()): number {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      project: { type: "boolean" },
      global: { type: "boolean" },
      json: { type: "boolean" },
    },
  });
  if (positionals.length > 1 || (values.project && values.global)) {
    io.err.write("usage: odw workflows verify [<name>] [--project|--global] [--json]\n");
    return 2;
  }
  const config = loadConfig(values.config ?? null, { quiet: true, cwd: io.cwd });
  const scope = values.project ? "project" : values.global ? "global" : "all";
  const results: Array<VerifiedFile & { lock: string }> = [];
  const errors: string[] = [];
  for (const dir of lockedDirs(io.cwd, config, scope)) {
    const lockPath = lockPathFor(dir);
    if (!existsSync(lockPath)) continue;
    try {
      for (const r of verifyLock(dir, readLock(lockPath), positionals[0])) results.push({ ...r, lock: lockPath });
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  const bad = results.filter((r) => r.status !== "ok");
  if (values.json) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: bad.length === 0 && errors.length === 0,
          files: results.map((r) => ({
            name: r.name,
            kind: r.kind,
            file: r.file,
            lock: r.lock,
            status: r.status,
            expected: r.expected,
            actual: r.actual,
            url: r.entry.url,
            ref: r.entry.ref,
            commit: r.entry.commit,
          })),
          errors,
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    for (const r of results) {
      const mark = r.status === "ok" ? "ok      " : r.status === "modified" ? "MODIFIED" : "MISSING ";
      process.stdout.write(`${mark}  ${r.name}${r.kind === "workflow" ? "" : ` (${r.kind})`}  ${display(r.file, io.cwd)}  ${describeSource(r.entry)}\n`);
    }
    for (const e of errors) io.err.write(`${e}\n`);
    if (results.length === 0 && errors.length === 0) {
      io.err.write(positionals[0] !== undefined ? `no locked workflow '${positionals[0]}'\n` : "no workflows installed from git (no workflows.lock.json)\n");
    } else if (bad.length > 0) {
      io.err.write(
        `${bad.length} locked file${bad.length === 1 ? "" : "s"} no longer match${bad.length === 1 ? "es" : ""} the lock: ` +
          "restore it, or odw workflows update --force to take the source's again\n",
      );
    }
  }
  if (positionals[0] !== undefined && results.length === 0 && errors.length === 0) return 1;
  return bad.length > 0 || errors.length > 0 ? 1 : 0;
}

/** `odw doctor`'s "Locked workflows" check: every lock from `cwd` up and the global one; null when there is none. */
export function lockedWorkflowsCheck(cwd: string, config: Config): DoctorCheck | null {
  const results: VerifiedFile[] = [];
  const errors: string[] = [];
  let locks = 0;
  for (const dir of lockedDirs(cwd, config)) {
    const lockPath = lockPathFor(dir);
    if (!existsSync(lockPath)) continue;
    locks++;
    try {
      results.push(...verifyLock(dir, readLock(lockPath)));
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  if (locks === 0) return null;
  const check = { id: "locked-workflows", title: "Locked workflows" };
  const bad = results.filter((r) => r.status !== "ok");
  const names = new Set(results.map((r) => r.name)).size;
  if (bad.length === 0 && errors.length === 0) {
    return { ...check, status: "ok", detail: `${names} installed from git, every file matches its lock` };
  }
  const listed = bad.map((r) => `${r.name}${r.kind === "workflow" ? "" : ` (${r.kind})`} ${r.status}`);
  return {
    ...check,
    status: config.settings.lockedWorkflows === "fail" || errors.length > 0 ? "fail" : "warn",
    detail: [...errors, ...listed].join("; "),
    hint: "odw workflows verify shows each file; restore it, or odw workflows update --force",
  };
}
