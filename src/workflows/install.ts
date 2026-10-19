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
 *
 * A file from the repository is taken only under a name `odw run` resolves
 * (letters, digits and . _ -; never `__proto__`, `constructor` or
 * `prototype`), and what is printed of the repository's paths is stripped of
 * escapes. Nothing is written through a symlink: not the workflow, its test
 * or eval, the lock, nor any directory from the project (or, `--global`, the
 * workflows directory's parent) down to them — each is written to a temporary
 * file beside it and renamed over it (../runtime/safe-write).
 */

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { parseArgs } from "node:util";

import { loadConfig, resolveWorkflowsRoot } from "../adapters/config.js";
import type { Config } from "../adapters/types.js";
import { checkCapabilities, formatCheck } from "../check.js";
import type { DoctorCheck } from "../doctor.js";
import { ConfigError } from "../errors.js";
import { askYesNo, canPrompt } from "../new.js";
import { unifiedDiff } from "../runtime/compare.js";
import { UnsafeWriteError, unsafeTarget, writeInside } from "../runtime/safe-write.js";
import { sanitizeText, stripEscapes } from "../tty.js";
import { fetchGitSource, normalizeRepoPath, parseGitSource, type FetchedRepo, type TreeFile } from "./git-source.js";
import {
  EXTRA_DIRS,
  EXTRA_KINDS,
  describeSource,
  isLockableName,
  lockPathFor,
  lockedExtraPath,
  lockedWorkflowPath,
  readLock,
  sha256File,
  sha256Of,
  verifyLock,
  writeLock,
  type WorkflowLock,
  type ExtraKind,
  type LockEntry,
  type VerifiedFile,
} from "./lock.js";
import { projectLevels } from "../project-levels.js";

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

/** Below which nothing an install writes may be a symlink: the project, or (global) the workflows directory's parent. */
function installRoot(global: boolean, dir: string, cwd: string): string {
  return global ? dirname(dir) : cwd;
}

/** The lock, written as {@link writeInside} writes: never through a symlink. */
function writeLockInside(root: string, lockPath: string, lock: WorkflowLock): void {
  const unsafe = unsafeTarget(root, lockPath);
  if (unsafe) throw new UnsafeWriteError(unsafe);
  writeLock(lockPath, lock);
}

/** Something is at `path` — a file, a directory, or a symlink, dangling or not. */
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
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
  return sanitizeText(rel && !rel.startsWith("..") ? rel.split(sep).join("/") : path, 1000);
}

/** Text from the repository (its paths, a check's report of them): escapes and control characters stripped, lines and their indent kept. */
const printable = stripEscapes;

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
  if (values.name !== undefined && !isLockableName(values.name)) {
    io.err.write(`odw workflows add: '${sanitizeText(values.name, 200)}' is not a workflow name (letters, digits and . _ -)\n`);
    return 2;
  }
  const config = loadConfig(values.config ?? null, { quiet: true, cwd: io.cwd });
  const source = parseGitSource(positionals[0]!, io.cwd);
  const dir = installDir(values.global === true, config, io.cwd);
  const root = installRoot(values.global === true, dir, io.cwd);
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
      const stem = file.path.slice(file.path.lastIndexOf("/") + 1, -".js".length);
      // Its name is its file's: one `odw run` resolves and a lock can key (unless --name gives it another).
      if (values.name === undefined && !isLockableName(stem)) {
        notes.push(`skipped ${file.path}: not a workflow name (letters, digits and . _ -) — --path and --name install it under one`);
        continue;
      }
      const report = checkCapabilities(text, file.path);
      for (const line of formatCheck(report)) io.err.write(`  ${printable(line)}\n`);
      if (!report.ok) {
        notes.push(`skipped ${file.path}: not a workflow odw can load`);
        continue;
      }
      picks.push({ file, name: stem, bytes, extras: values.global ? {} : extrasOf(repo, file) });
    }
    for (const note of notes) io.err.write(`  note: ${sanitizeText(note, 1000)}\n`);
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
      if (!locked && present(target) && !values.force) {
        io.err.write(`odw workflows add: ${display(target, io.cwd)} exists and odw workflows add did not install it — pass --force to replace it\n`);
        return 1;
      }
    }
    // Nothing is written through a symlink: the workflow, its test or eval, the lock, or a directory above them.
    const writes = [
      lockPath,
      ...picks.flatMap((p) => [lockedWorkflowPath(dir, p.name), ...EXTRA_KINDS.filter((k) => p.extras[k]).map((k) => lockedExtraPath(dir, p.name, k))]),
    ];
    for (const at of writes) {
      const unsafe = unsafeTarget(root, at);
      if (unsafe) {
        io.err.write(`odw workflows add: not writing ${display(at, io.cwd)}: ${sanitizeText(unsafe, 1000)} — a symlink is never written through\n`);
        return 1;
      }
    }

    io.err.write(`\nfrom ${repo.url}${repo.ref ? `#${repo.ref}` : ""} at ${repo.commit}:\n`);
    for (const p of picks) {
      const extras = EXTRA_KINDS.filter((k) => p.extras[k]).map((k) => `${EXTRA_DIRS[k]}/${p.name}.json`);
      io.err.write(`  ${sanitizeText(p.file.path, 1000)} → ${display(lockedWorkflowPath(dir, p.name), io.cwd)}${extras.length ? ` (+ ${extras.join(", ")})` : ""}\n`);
    }
    io.err.write("installed workflows are third-party: they run in a strict script context unless the config says scriptContext: \"host\"\n");
    if (!(await confirm(`install ${picks.length === 1 ? "it" : `these ${picks.length}`}?`, values.yes === true, io))) return 1;

    const installedAt = new Date().toISOString();
    for (const p of picks) {
      const target = lockedWorkflowPath(dir, p.name);
      writeInside(root, target, p.bytes);
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
        const before = present(at) ? sha256File(at) : null;
        const previous = Object.hasOwn(lock.workflows, p.name) ? lock.workflows[p.name]![kind] : undefined;
        if (before !== null && before !== previous?.sha256 && !values.force) {
          io.err.write(`  note: kept ${display(at, io.cwd)}: it exists and is not this workflow's (--force replaces it)\n`);
          continue;
        }
        writeInside(root, at, x.bytes);
        entry[kind] = { path: x.file.path, sha256: sha256Of(x.bytes) };
      }
      lock.workflows[p.name] = entry;
      io.err.write(`installed ${p.name} → ${display(target, io.cwd)}\n`);
    }
    writeLockInside(root, lockPath, lock);
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
  const root = installRoot(values.global === true, dir, io.cwd);
  const lockPath = lockPathFor(dir);
  const lock = readLock(lockPath);
  const names = Object.keys(lock.workflows).filter((n) => only === undefined || n === only).sort();
  if (names.length === 0) {
    io.err.write(
      only !== undefined
        ? `odw workflows update: no workflow '${sanitizeText(only, 200)}' in ${display(lockPath, io.cwd)}\n`
        : `odw workflows update: nothing installed from git in ${display(dir, io.cwd)}\n`,
    );
    return only !== undefined ? 1 : 0;
  }
  // One fetch per source.
  const repos = new Map<string, FetchedRepo>();
  let failed = 0;
  let changed = false;
  /** One entry: "updated", "failed", or "unchanged" (up to date, its commit perhaps moved). */
  const updateOne = async (name: string): Promise<"updated" | "failed" | "unchanged"> => {
    const entry = lock.workflows[name]!;
    const target = lockedWorkflowPath(dir, name);
    // Nothing is read or written through a symlink: the workflow, its test or eval, or a directory above them.
    for (const at of [target, ...EXTRA_KINDS.filter((k) => entry[k]).map((k) => lockedExtraPath(dir, name, k))]) {
      const unsafe = unsafeTarget(root, at);
      if (unsafe) {
        io.err.write(`${name}: not writing ${display(at, io.cwd)}: ${sanitizeText(unsafe, 1000)} — a symlink is never written through\n`);
        return "failed";
      }
    }
    const key = `${entry.url}#${entry.ref ?? ""}`;
    let repo = repos.get(key);
    if (!repo) {
      io.err.write(`fetching ${entry.url}${entry.ref ? `#${entry.ref}` : ""} …\n`);
      repo = fetchGitSource({ url: entry.url, ref: entry.ref });
      repos.set(key, repo);
    }
    const found = repo.list(entry.path);
    if (found?.kind !== "file" || (found.file.mode !== "100644" && found.file.mode !== "100755")) {
      io.err.write(`${name}: ${entry.path} is no longer a file in ${entry.url} at ${repo.commit.slice(0, 12)} — left as installed\n`);
      return "failed";
    }
    const bytes = repo.read(found.file);
    const text = bytes.toString("utf8");
    const sha256 = sha256Of(bytes);
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
      return "unchanged";
    }
    if (onDisk !== null && onDisk !== entry.sha256 && !values.force) {
      io.err.write(`${name}: ${display(target, io.cwd)} was modified since it was installed — not overwriting it (--force does)\n`);
      return "failed";
    }
    io.err.write(`\n${name}: ${entry.commit.slice(0, 12)} → ${repo.commit.slice(0, 12)} (${entry.url}${entry.ref ? `#${entry.ref}` : ""})\n`);
    if (sha256 !== entry.sha256) {
      const before = onDisk === null ? "" : readFileSync(target, "utf8");
      const diff = unifiedDiff(before, text, { maxLines: 400 });
      process.stdout.write(`--- a/${display(target, io.cwd)}\t${entry.commit.slice(0, 12)}\n+++ b/${display(target, io.cwd)}\t${repo.commit.slice(0, 12)}\n`);
      for (const line of diff.lines) process.stdout.write(`${printable(line)}\n`);
      if (diff.truncated) process.stdout.write(`… (diff cut: +${diff.added} −${diff.removed} in all)\n`);
      const report = checkCapabilities(text, entry.path);
      for (const line of formatCheck(report)) io.err.write(`  ${printable(line)}\n`);
      // As add: a file that does not check is never installed.
      if (!report.ok) {
        io.err.write(`${name}: ${entry.path} at ${repo.commit.slice(0, 12)} is not a workflow odw can load — left as installed\n`);
        return "failed";
      }
    }
    for (const x of extrasChanged) io.err.write(`  ${EXTRA_DIRS[x.kind]}/${name}.json changed too\n`);
    if (!(await confirm(`update ${name}?`, values.yes === true, io))) return "failed";
    writeInside(root, target, bytes);
    const next: LockEntry = { ...entry, commit: repo.commit, sha256, installedAt: new Date().toISOString() };
    for (const x of extrasChanged) {
      const at = lockedExtraPath(dir, name, x.kind);
      const local = sha256File(at);
      if (local !== null && local !== entry[x.kind]!.sha256 && !values.force) {
        io.err.write(`  note: kept ${display(at, io.cwd)}: modified since it was installed (--force replaces it)\n`);
        continue;
      }
      writeInside(root, at, x.bytes);
      next[x.kind] = { path: x.path, sha256: sha256Of(x.bytes) };
    }
    lock.workflows[name] = next;
    changed = true;
    io.err.write(`updated ${name} to ${repo.commit.slice(0, 12)}\n`);
    return "updated";
  };
  try {
    for (const name of names) {
      // One entry that cannot be updated (its source unreachable, a file refused) fails alone.
      try {
        if ((await updateOne(name)) === "failed") failed++;
      } catch (err) {
        io.err.write(`${name}: ${sanitizeText((err as Error).message, 1000)}\n`);
        failed++;
      }
    }
  } finally {
    for (const repo of repos.values()) repo.cleanup();
  }
  if (changed) {
    try {
      writeLockInside(root, lockPath, lock);
    } catch (err) {
      io.err.write(`odw workflows update: ${sanitizeText((err as Error).message, 1000)}\n`);
      return 1;
    }
  }
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
