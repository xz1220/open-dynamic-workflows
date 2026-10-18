/**
 * `odw new` — start a workflow from a template (an ODW extension).
 *
 *   odw new                                   list the templates, one line each
 *   odw new <template> [--name N] [--force] [--yes]
 *
 * The templates are embedded in the binary (src/templates.generated.ts, from
 * templates/index.json — see scripts/embed-templates.mjs), so a binary-only
 * install has them too. A template writes, in the current directory:
 *
 *   .odw/workflows/<name>.js    the workflow (`odw run <name>`)
 *   .odw/tests/<name>.json      starter tests: scripted replies, so
 *                               `odw test <name>` passes at once, for $0
 *   .odw/evals/<name>.json      for the review-ish templates: an eval skeleton
 *                               (real runs — edit it before `odw eval <name>`)
 *
 * `<name>` (default: the template's) replaces the template's own name in all
 * three. A file that exists with other content is never overwritten without
 * `--force`: nothing is written then, and the exit code is 1. A file that
 * already holds exactly what would be written counts as done, so running the
 * same command again is harmless.
 *
 * In a git repository with no `.worktreeinclude`, it also suggests one — the
 * dependency directories its lockfiles imply, and its `.env*` files — so the
 * agents of `isolation: "worktree"` start with what the checkout has. It
 * prints what it would write, and writes it with `--yes` or when asked at a
 * terminal; never otherwise.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, relative } from "node:path";

import { envTruthy } from "./runtime/live-view.js";
import { SAFE_GIT } from "./git-safety.js";
import { TEMPLATES, type EmbeddedTemplate } from "./templates.generated.js";
import { detectCaps, glyphs, palette } from "./tty.js";
import { WORKTREE_INCLUDE_FILE } from "./worktree-setup.js";

/** An unanswered prompt (a PTY harness with nobody home) must not wedge anything. */
export const PROMPT_TIMEOUT_MS = 120_000;

/**
 * A workflow name `odw new` writes: what `odw run <name>` resolves as a name
 * (not a path) and `odw test`/`odw eval` take — so no leading dot and no
 * script extension.
 */
const NEW_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface NewFlags {
  template?: string;
  name?: string;
  force?: boolean;
  yes?: boolean;
}

/** Streams/env/cwd injected for tests; production callers pass nothing. */
export interface NewIO {
  cwd: string;
  input: NodeJS.ReadableStream & { isTTY?: boolean };
  out: NodeJS.WritableStream & { isTTY?: boolean };
  err: NodeJS.WritableStream & { isTTY?: boolean };
  env: Record<string, string | undefined>;
}

/** The embedded templates, in their listing order. */
export function listTemplates(): readonly EmbeddedTemplate[] {
  return TEMPLATES;
}

export function findTemplate(name: string): EmbeddedTemplate | null {
  return TEMPLATES.find((t) => t.name === name) ?? null;
}

export function isNewName(name: string): boolean {
  return NEW_NAME_RE.test(name) && !/\.(?:[cm]?js|ts)$/i.test(name);
}

/** One file a template writes. */
export interface TemplateFile {
  kind: "workflow" | "test" | "eval";
  path: string;
  content: string;
}

/** The files `template` writes as `name` under `cwd`, with the name put in. */
export function templateFiles(template: EmbeddedTemplate, name: string, cwd: string): TemplateFile[] {
  const files: TemplateFile[] = [
    { kind: "workflow", path: join(cwd, ".odw", "workflows", `${name}.js`), content: renamed(template.workflow, template.name, name) },
    { kind: "test", path: join(cwd, ".odw", "tests", `${name}.json`), content: renamed(template.test, template.name, name) },
  ];
  if (template.eval !== null) {
    files.push({ kind: "eval", path: join(cwd, ".odw", "evals", `${name}.json`), content: renamed(template.eval, template.name, name) });
  }
  return files;
}

/** What writing a template did. */
export interface WriteOutcome {
  written: TemplateFile[];
  /** Files that already held exactly this content. */
  unchanged: TemplateFile[];
  /** Files that exist with other content: nothing was written (without force). */
  conflicts: TemplateFile[];
}

/** Write a template's files — all of them, or (a conflict, no force) none. */
export function writeTemplate(template: EmbeddedTemplate, name: string, cwd: string, force = false): WriteOutcome {
  const files = templateFiles(template, name, cwd);
  const unchanged: TemplateFile[] = [];
  const conflicts: TemplateFile[] = [];
  const todo: TemplateFile[] = [];
  for (const f of files) {
    if (!existsSync(f.path)) todo.push(f);
    else if (statSync(f.path).isFile() && readFileSync(f.path, "utf8") === f.content) unchanged.push(f);
    else conflicts.push(f);
  }
  if (conflicts.length > 0 && !force) return { written: [], unchanged, conflicts };
  const written = [...todo, ...conflicts];
  for (const f of written) {
    mkdirSync(dirname(f.path), { recursive: true });
    writeFileSync(f.path, f.content, "utf8");
  }
  return { written, unchanged, conflicts: [] };
}

/** Lockfiles, and the dependency directory each implies an isolated worktree wants. */
const DEPENDENCY_DIRS: ReadonlyArray<{ lockfiles: readonly string[]; dir: string }> = [
  { lockfiles: ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"], dir: "node_modules" },
  { lockfiles: ["uv.lock", "poetry.lock", "Pipfile.lock", "pdm.lock"], dir: ".venv" },
  { lockfiles: ["composer.lock"], dir: "vendor" },
];

/** `.env` files that are examples, committed for people to copy: nothing to bring in. */
const ENV_EXAMPLE_RE = /\.(?:example|sample|template|dist)$/i;

/** The repository root `cwd` is in, or null (not a repository, or no git). */
export function gitRoot(cwd: string): string | null {
  try {
    const out = execFileSync("git", [...SAFE_GIT, "rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/**
 * The `.worktreeinclude` to suggest for the repository at `root`: null when it
 * has one already, or when nothing is worth bringing in. Its lockfiles name
 * the dependency directories (linked, not copied: `symlink:` is an ODW
 * extension); its `.env*` files are copied.
 */
export function suggestWorktreeInclude(root: string): string | null {
  if (existsSync(join(root, WORKTREE_INCLUDE_FILE))) return null;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return null;
  }
  const has = new Set(entries);
  const links: string[] = [];
  const found: string[] = [];
  for (const { lockfiles, dir } of DEPENDENCY_DIRS) {
    const lock = lockfiles.find((f) => has.has(f));
    if (lock && !links.includes(dir)) {
      links.push(dir);
      found.push(lock);
    }
  }
  const envs = entries
    .filter((f) => /^\.env(?:$|\.)/.test(f) && !ENV_EXAMPLE_RE.test(f) && isFile(join(root, f)))
    .sort();
  if (links.length === 0 && envs.length === 0) return null;
  const lines = [`# What an isolated agent's worktree brings in from this checkout (written by odw new).`];
  if (envs.length > 0) lines.push(...envs);
  if (links.length > 0) {
    lines.push(`# ${found.join(", ")}: the dependencies, linked rather than copied (symlink: is an ODW extension;`);
    lines.push(`# what an agent installs there lands in this checkout).`);
    lines.push(...links.map((d) => `symlink: ${d}`));
  }
  return lines.join("\n") + "\n";
}

/**
 * A prompt is offered only when both ends are a real terminal, the terminal is
 * sane, and no automation marker is set — the rule `odw init` and the run
 * live view share, so "odw never prompts your shell" stays one rule.
 */
export function canPrompt(
  input: { isTTY?: boolean },
  err: { isTTY?: boolean },
  env: Record<string, string | undefined>,
): boolean {
  // Windows consoles commonly omit TERM, but an explicit dumb terminal still
  // means automation and must never prompt.
  const termOk = env.TERM === undefined ? process.platform === "win32" : env.TERM !== "dumb";
  return input.isTTY === true && err.isTTY === true && termOk && !envTruthy(env.CI) && !envTruthy(env.ODW_DETACH);
}

/** Ask a yes/no question; Enter takes the default. Null: EOF, Ctrl-C or no answer in time. */
export async function askYesNo(
  question: string,
  defaultYes: boolean,
  input: NodeJS.ReadableStream,
  err: NodeJS.WritableStream,
  timeoutMs = PROMPT_TIMEOUT_MS,
): Promise<boolean | null> {
  const answer = await new Promise<string | null>((resolve) => {
    const rl = createInterface({ input, output: err });
    const timer = setTimeout(() => rl.close(), timeoutMs);
    timer.unref?.();
    rl.on("SIGINT", () => rl.close());
    rl.on("close", () => {
      clearTimeout(timer);
      resolve(null); // EOF/abort/timeout; a real answer resolved first
    });
    rl.question(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `, (a) => {
      clearTimeout(timer);
      resolve(a); // before close() — its 'close' event may fire synchronously
      rl.close();
    });
  });
  if (answer === null) {
    err.write("\n");
    return null;
  }
  const a = answer.trim().toLowerCase();
  if (a === "") return defaultYes;
  return a === "y" || a === "yes";
}

/** `odw new …`; returns the exit code. */
export async function cmdNew(flags: NewFlags, io?: Partial<NewIO>): Promise<number> {
  const cwd = io?.cwd ?? process.cwd();
  const input = io?.input ?? process.stdin;
  const out = io?.out ?? process.stdout;
  const err = io?.err ?? process.stderr;
  const env = io?.env ?? process.env;
  const p = palette(detectCaps(err, env));
  const g = glyphs(detectCaps(err, env));

  if (flags.template === undefined) {
    if (flags.name !== undefined || flags.force || flags.yes) {
      err.write("odw new: name a template first: odw new <template> [--name N] [--force] [--yes]\n");
      return 2;
    }
    const w = Math.max(...TEMPLATES.map((t) => t.name.length));
    for (const t of TEMPLATES) out.write(`${t.name.padEnd(w)}  ${t.description}\n`);
    err.write(p.dim(`odw new <template> [--name N]: writes .odw/workflows/<name>.js and a starter test (odw test <name>, $0)`) + "\n");
    return 0;
  }
  const template = findTemplate(flags.template);
  if (!template) {
    err.write(`odw new: no template '${flags.template}'; there are: ${TEMPLATES.map((t) => t.name).join(", ")}\n`);
    return 2;
  }
  const name = flags.name ?? template.name;
  if (!isNewName(name)) {
    err.write(`odw new: --name must be letters, digits and . _ - (not first), at most 128, not ending in .js; got '${name}'\n`);
    return 2;
  }

  const outcome = writeTemplate(template, name, cwd, flags.force === true);
  if (outcome.conflicts.length > 0) {
    for (const f of outcome.conflicts) err.write(`${p.err(g.fail)} ${rel(cwd, f.path)} exists\n`);
    err.write(`odw new: refusing to overwrite — nothing written; pass --force to replace, or --name for another name\n`);
    return 1;
  }
  const what: Record<TemplateFile["kind"], string> = {
    workflow: "the workflow",
    test: "starter tests: scripted replies, no model",
    eval: "an eval skeleton: real runs, edit it first",
  };
  for (const f of outcome.written) err.write(`${p.ok(g.ok)} wrote ${rel(cwd, f.path)}  ${p.dim(`(${what[f.kind]})`)}\n`);
  for (const f of outcome.unchanged) err.write(`${p.dim(`${g.ok} ${rel(cwd, f.path)} is already this template`)}\n`);

  const root = gitRoot(cwd);
  if (root !== null) await offerWorktreeInclude(root, template.name, name, flags.yes === true, { cwd, input, err, env });

  const next: Array<[string, string]> = [
    [`odw test ${name}`, "the starter tests, no model called ($0)"],
    [`odw run ${name} --dry`, "the live view and the phase tree, every agent stubbed ($0)"],
    [`odw run ${name}`, "the real run, on your default agent CLI"],
  ];
  if (template.eval !== null) next.push([`odw eval ${name}`, `real runs, scored: edit .odw/evals/${name}.json first`]);
  const w = Math.max(...next.map(([c]) => c.length));
  err.write(p.bold("next:") + "\n");
  for (const [command, about] of next) err.write(`  ${command.padEnd(w)}   ${p.dim(about)}\n`);
  return 0;
}

// --- internals -----------------------------------------------------------------

async function offerWorktreeInclude(
  root: string,
  template: string,
  name: string,
  yes: boolean,
  io: { cwd: string; input: NewIO["input"]; err: NewIO["err"]; env: NewIO["env"] },
): Promise<void> {
  const text = suggestWorktreeInclude(root);
  if (text === null) return;
  const file = join(root, WORKTREE_INCLUDE_FILE);
  const shown = rel(io.cwd, file);
  io.err.write(`\nthis repository has no ${WORKTREE_INCLUDE_FILE}: isolated agents' worktrees would start without these. Suggested ${shown}:\n`);
  for (const line of text.trimEnd().split("\n")) io.err.write(`  ${line}\n`);
  let write = yes;
  if (!write && canPrompt(io.input, io.err, io.env)) write = (await askYesNo(`write ${shown}?`, false, io.input, io.err)) === true;
  if (write) {
    writeFileSync(file, text, "utf8");
    io.err.write(`wrote ${shown}\n\n`);
  } else {
    const again = `odw new ${template}${name === template ? "" : ` --name ${name}`} --yes`;
    io.err.write(`not written — to write it: ${again}  (the files above are left as they are)\n\n`);
  }
}

/** Template names in the workflow, its test and its eval, renamed. */
function renamed(text: string, from: string, to: string): string {
  const f = from.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  // An example's comments run it from the repository's examples/: here it is a named workflow.
  text = text.replace(new RegExp(`\\bexamples/${f}\\.js\\b`, "g"), `.odw/workflows/${to}.js`);
  if (from === to) return text;
  return text
    .replace(new RegExp(`(\\bname: ')${f}(')`), `$1${to}$2`) // meta.name
    .replace(new RegExp(`("workflow": ")${f}(")`, "g"), `$1${to}$2`)
    .replace(new RegExp(`(\\.odw/(?:tests|evals)/)${f}(\\.json)`, "g"), `$1${to}$2`)
    .replace(new RegExp(`(\\bodw (?:run|test|eval|schedule add [\\w-]+) )${f}(?![\\w.-])`, "g"), `$1${to}`);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function rel(cwd: string, path: string): string {
  const r = relative(cwd, path);
  return r === "" || r.startsWith("..") ? path : r;
}
