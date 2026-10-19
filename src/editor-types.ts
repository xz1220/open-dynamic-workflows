/**
 * `odw types` — editor completion for workflow scripts (an ODW extension).
 *
 *   odw types [--dir D] [--force]
 *
 * Workflow scripts are plain JavaScript run with the primitives injected as
 * globals, so an editor knows nothing of agent(), parallel() or their options.
 * The dialect's declarations (types/workflow.d.ts) are embedded in the binary
 * (src/types.generated.ts — see scripts/embed-types.mjs), and this writes them
 * into the project, with the editor config that brings them to every script:
 *
 *   D/types/odw.d.ts               the declarations, odw's version in its header;
 *                                  rewritten every time (`odw doctor` says when
 *                                  an upgrade left it stale)
 *   D/jsconfig.json                its `include` covers D/types, .odw/workflows
 *                                  and .claude/workflows (for `tsc -p D`)
 *   .claude/workflows/jsconfig.json  when that directory exists: an editor looks
 *                                  for the config nearest a file, upward, so a
 *                                  script there needs its own
 *
 * D defaults to `.odw`, relative to the current directory. A jsconfig.json
 * this wrote starts with {@link JSCONFIG_MARK}, and is rewritten; one without
 * it is the user's and is left as it is (its snippet is printed instead)
 * unless `--force`. `odw new` runs this too (`--no-types` leaves it out).
 *
 * `checkJs` stays off: the dialect's top-level `return` is TS1108 to a type
 * checker, so a `// @ts-check` script shows an error on its last line. A
 * script that wants checking opts in with `// @ts-check` itself. Nothing here
 * compiles or checks anything (zero dependencies).
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { detectCaps, glyphs, palette } from "./tty.js";
import { WORKFLOW_DTS } from "./types.generated.js";
import { VERSION } from "./version.generated.js";

/** Where the declarations go, under the types directory (default `.odw`). */
export const TYPES_DIR = ".odw";
export const TYPES_FILE = join("types", "odw.d.ts");

/** The first line of a jsconfig.json `odw types` wrote, and so may rewrite. */
export const JSCONFIG_MARK = "// odw types: editor completion for workflow scripts (ODW extension).";

const HEADER_RE = /^\/\/ odw types (\S+) /;

/** The header `odw types` puts ahead of the declarations: the version that wrote them. */
export function typesHeader(version: string = VERSION): string {
  return (
    `// odw types ${version} — the workflow dialect's declarations, for editors (ODW extension).\n` +
    "// Written by `odw types`, which rewrites this file: edit nothing here. `odw doctor` says when it is stale.\n"
  );
}

/** What `D/types/odw.d.ts` holds. */
export function typesText(version: string = VERSION): string {
  return typesHeader(version) + WORKFLOW_DTS;
}

/** The version a written odw.d.ts names, or null (no header). */
export function typesVersion(text: string): string | null {
  return HEADER_RE.exec(text)?.[1] ?? null;
}

/** A path for a jsconfig `include`: relative, forward slashes. */
function includePath(from: string, to: string): string {
  const r = relative(from, to).split(sep).join("/");
  return r === "" ? "." : r;
}

/** The compiler options every jsconfig `odw types` writes shares. */
const COMPILER_OPTIONS = {
  allowJs: true,
  // Off: the dialect's top-level `return` is TS1108 to a checker; `// @ts-check` opts a script in.
  checkJs: false,
  noEmit: true,
  target: "es2022",
  module: "es2022",
  // Each script is its own module: a top-level const in one is not a global in the next.
  moduleDetection: "force",
  // The scripts' globals are the dialect's, not the DOM's or Node's.
  lib: ["es2022"],
  types: [] as string[],
};

function jsconfigText(include: string[]): string {
  return (
    `${JSCONFIG_MARK}\n` +
    "// Written by `odw types`, which rewrites it while the line above stays: delete that line to keep your own edits.\n" +
    JSON.stringify({ compilerOptions: COMPILER_OPTIONS, include }, null, 2) +
    "\n"
  );
}

/** One file `odw types` writes. */
export interface TypesFile {
  kind: "types" | "jsconfig";
  path: string;
  content: string;
  /** For a jsconfig: what its `include` must hold — the snippet printed when the file is the user's. */
  include?: string[];
}

/** The files `odw types` writes for the project at `cwd`, the types directory at `dir` (relative to `cwd`, or absolute). */
export function typesFiles(cwd: string, dir: string = TYPES_DIR, version: string = VERSION): TypesFile[] {
  const base = resolve(cwd, dir);
  const dts = join(base, TYPES_FILE);
  const odwWorkflows = join(cwd, ".odw", "workflows");
  const claudeWorkflows = join(cwd, ".claude", "workflows");
  const mainInclude = [includePath(base, dts), `${includePath(base, odwWorkflows)}/**/*.js`, `${includePath(base, claudeWorkflows)}/**/*.js`];
  const files: TypesFile[] = [
    { kind: "types", path: dts, content: typesText(version) },
    { kind: "jsconfig", path: join(base, "jsconfig.json"), content: jsconfigText(mainInclude), include: mainInclude },
  ];
  // An editor takes the config nearest a file, looking upward: D's never covers .claude/workflows.
  if (isDir(claudeWorkflows) && resolve(claudeWorkflows) !== base) {
    const include = ["**/*.js", includePath(claudeWorkflows, dts)];
    files.push({ kind: "jsconfig", path: join(claudeWorkflows, "jsconfig.json"), content: jsconfigText(include), include });
  }
  return files;
}

/** What became of one file. */
export type TypesFileState = "written" | "updated" | "unchanged" | "kept";

export interface TypesOutcome {
  files: Array<TypesFile & { state: TypesFileState }>;
}

/**
 * Write the declarations and the jsconfig files. The declarations are always
 * (re)written; a jsconfig.json is written when missing, rewritten when this
 * wrote it ({@link JSCONFIG_MARK}) or with `force`, and otherwise kept.
 */
export function writeTypes(cwd: string, dir: string = TYPES_DIR, force = false): TypesOutcome {
  const files: TypesOutcome["files"] = [];
  for (const f of typesFiles(cwd, dir)) {
    let state: TypesFileState;
    if (!existsSync(f.path)) state = "written";
    else {
      const old = isFile(f.path) ? readFileSync(f.path, "utf8") : null;
      if (old === f.content) state = "unchanged";
      else if (f.kind === "types" || force || (old !== null && old.startsWith(JSCONFIG_MARK))) state = "updated";
      else state = "kept";
    }
    if (state === "written" || state === "updated") {
      mkdirSync(dirname(f.path), { recursive: true });
      writeFileSync(f.path, f.content, "utf8");
    }
    files.push({ ...f, state });
  }
  return { files };
}

/** What `odw doctor` reports of `.odw/types/odw.d.ts`: null when it was never written. */
export interface TypesStatus {
  path: string;
  /** The odw version its header names; null when it has none. */
  version: string | null;
  /** Its declarations are not this odw's (an upgrade, or a hand edit). */
  stale: boolean;
}

export function typesStatus(cwd: string, dir: string = TYPES_DIR): TypesStatus | null {
  const path = join(resolve(cwd, dir), TYPES_FILE);
  if (!isFile(path)) return null;
  const text = readFileSync(path, "utf8");
  const version = typesVersion(text);
  // The declarations decide, not the version string: a dev build's version moves with every commit.
  const body = version === null ? text : text.split("\n").slice(typesHeader(version).split("\n").length - 1).join("\n");
  return { path, version, stale: body !== WORKFLOW_DTS };
}

export interface TypesFlags {
  dir?: string;
  force?: boolean;
}

export interface TypesIO {
  cwd: string;
  err: NodeJS.WritableStream & { isTTY?: boolean };
  env: Record<string, string | undefined>;
}

/** `odw types …`; returns the exit code. */
export function cmdTypes(flags: TypesFlags, io?: Partial<TypesIO>): number {
  const cwd = io?.cwd ?? process.cwd();
  const err = io?.err ?? process.stderr;
  const env = io?.env ?? process.env;
  const dir = flags.dir ?? TYPES_DIR;
  if (dir === "") {
    err.write("odw types: --dir needs a directory\n");
    return 2;
  }
  const base = resolve(cwd, dir);
  if (existsSync(base) && !isDir(base)) {
    err.write(`odw types: ${dir} is not a directory\n`);
    return 2;
  }
  const outcome = writeTypes(cwd, dir, flags.force === true);
  reportTypes(outcome, cwd, err, env);
  if (outcome.files.some((f) => f.state !== "kept")) {
    err.write(
      palette(detectCaps(err, env)).dim(
        "editors now complete agent(), parallel(), exec() … and their options in workflow scripts; hover tells the dialect from ODW extensions",
      ) + "\n",
    );
  }
  return 0;
}

/** One line per file written (also `odw new`'s), and a user's own jsconfig's snippet. */
export function reportTypes(outcome: TypesOutcome, cwd: string, err: NodeJS.WritableStream & { isTTY?: boolean }, env: Record<string, string | undefined>): void {
  const p = palette(detectCaps(err, env));
  const g = glyphs(detectCaps(err, env));
  for (const f of outcome.files) {
    const shown = rel(cwd, f.path);
    const what =
      f.kind === "types"
        ? `the workflow dialect's declarations, odw ${typesVersion(f.content) ?? VERSION}`
        : `brings them to ${f.include!.filter((i) => i.endsWith(".js")).join(", ")}`;
    if (f.state === "written" || f.state === "updated") {
      err.write(`${p.ok(g.ok)} ${f.state === "written" ? "wrote" : "updated"} ${shown}  ${p.dim(`(${what})`)}\n`);
    } else if (f.state === "unchanged") {
      err.write(p.dim(`${g.ok} ${shown} is up to date`) + "\n");
    } else {
      err.write(`${p.run("!")} ${shown} is not odw's: left as it is. For completion, its "include" needs:\n`);
      err.write(`    ${JSON.stringify(f.include)}\n`);
      err.write(p.dim("  (odw types --force replaces it)") + "\n");
    }
  }
}

// --- internals -----------------------------------------------------------------

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function rel(cwd: string, path: string): string {
  const r = relative(cwd, path);
  return r === "" || r.startsWith("..") || isAbsolute(r) ? path : r;
}
