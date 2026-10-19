/**
 * `odw types` (an ODW extension; src/editor-types.ts): the embedded
 * declarations are types/workflow.d.ts byte for byte; what it writes makes a
 * real TypeScript language service complete the primitives and their options
 * in .odw/workflows and .claude/workflows, with the ODW extensions tagged on
 * hover, and no error on any template; a user's own jsconfig.json is kept;
 * `odw doctor` tells a stale copy; `odw new` writes it unless --no-types.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import ts from "typescript";

import { main } from "../src/cli.js";
import { typesCheck } from "../src/doctor.js";
import { JSCONFIG_MARK, cmdTypes, typesHeader, typesStatus, typesText, writeTypes } from "../src/editor-types.js";
import { cmdNew } from "../src/new.js";
import { TEMPLATES } from "../src/templates.generated.js";
import { WORKFLOW_DTS } from "../src/types.generated.js";
import { VERSION } from "../src/version.generated.js";

const ROOT = join(import.meta.dirname, "..");

async function withDir(fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "odw-types-")));
  try {
    writeFileSync(join(dir, "odw.config.json"), "{}\n");
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function sink(): PassThrough & { text(): string } {
  const s = new PassThrough() as PassThrough & { text(): string };
  let buf = "";
  s.on("data", (c: Buffer) => (buf += String(c)));
  s.text = () => buf;
  return s;
}

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** The config TypeScript's own loader reads from `jsconfig`: its options and files. */
function readConfig(jsconfig: string): ts.ParsedCommandLine {
  const read = ts.readConfigFile(jsconfig, ts.sys.readFile);
  assert.equal(read.error, undefined, read.error && ts.flattenDiagnosticMessageText(read.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(jsconfig), undefined, jsconfig);
  assert.deepEqual(parsed.errors, []);
  return parsed;
}

/** A language service over what `jsconfig` brings in — what an editor runs for a file next to it. */
function service(jsconfig: string): ts.LanguageService {
  const parsed = readConfig(jsconfig);
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => parsed.options,
    getScriptFileNames: () => parsed.fileNames,
    getScriptVersion: () => "1",
    getScriptSnapshot: (f) => (existsSync(f) ? ts.ScriptSnapshot.fromString(readFileSync(f, "utf8")) : undefined),
    getCurrentDirectory: () => dirname(jsconfig),
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  return ts.createLanguageService(host);
}

const SCRIPT = `export const meta = { name: 'x', description: 'x' }
const r = await agent('p', {  })
ag
return r
`;

function completions(ls: ts.LanguageService, file: string, at: string, offset = 0): string[] {
  const text = readFileSync(file, "utf8");
  const pos = text.indexOf(at) + offset;
  return (ls.getCompletionsAtPosition(file, pos, {})?.entries ?? []).map((e) => e.name);
}

test("the embedded declarations are types/workflow.d.ts (CI rebuilds and diffs it too)", () => {
  assert.equal(WORKFLOW_DTS, readFileSync(join(ROOT, "types", "workflow.d.ts"), "utf8"));
});

test("the declarations parse: no comment closed early, no syntax error", () => {
  const sf = ts.createSourceFile("odw.d.ts", WORKFLOW_DTS, ts.ScriptTarget.ES2022, true);
  const diags = (sf as unknown as { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics;
  assert.deepEqual(diags.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")), []);
});

test("odw types writes the declarations, versioned, and a jsconfig.json covering both workflow directories", () =>
  withDir((dir) => {
    const err = sink();
    assert.equal(cmdTypes({}, { cwd: dir, err, env: {} }), 0);
    const dts = readFileSync(join(dir, ".odw", "types", "odw.d.ts"), "utf8");
    assert.equal(dts, typesText());
    assert.ok(dts.startsWith(`// odw types ${VERSION} `));
    assert.ok(dts.endsWith(WORKFLOW_DTS));
    const jsconfig = join(dir, ".odw", "jsconfig.json");
    assert.ok(readFileSync(jsconfig, "utf8").startsWith(JSCONFIG_MARK));
    put(join(dir, ".odw", "workflows", "a.js"), SCRIPT);
    put(join(dir, ".claude", "workflows", "b.js"), SCRIPT);
    const parsed = readConfig(jsconfig);
    assert.equal(parsed.options.checkJs, false);
    assert.equal(parsed.options.allowJs, true);
    assert.deepEqual(
      parsed.fileNames.map((f) => f.slice(dir.length + 1)).sort(),
      [".claude/workflows/b.js", ".odw/types/odw.d.ts", ".odw/workflows/a.js"],
    );
    // .claude/workflows did not exist when it ran: no jsconfig there.
    assert.equal(existsSync(join(dir, ".claude", "workflows", "jsconfig.json")), false);
    assert.match(err.text(), /wrote \.odw\/types\/odw\.d\.ts/);
    assert.match(err.text(), /wrote \.odw\/jsconfig\.json/);
  }));

test("an editor completes the primitives and their options, and hover tags the ODW extensions", () =>
  withDir((dir) => {
    put(join(dir, ".odw", "workflows", "a.js"), SCRIPT);
    put(join(dir, ".claude", "workflows", "b.js"), SCRIPT);
    writeTypes(dir);
    // An editor takes the nearest config upward: .claude/workflows gets its own.
    const claudeConfig = join(dir, ".claude", "workflows", "jsconfig.json");
    assert.ok(existsSync(claudeConfig));
    for (const [file, jsconfig] of [
      [join(dir, ".odw", "workflows", "a.js"), join(dir, ".odw", "jsconfig.json")],
      [join(dir, ".claude", "workflows", "b.js"), claudeConfig],
    ] as const) {
      const ls = service(jsconfig);
      const globals = completions(ls, file, "\nag\n", 3);
      for (const name of ["agent", "parallel", "pipeline", "phase", "log", "budget", "args", "workflow", "exec", "checkpoint"]) {
        assert.ok(globals.includes(name), `${file}: ${name} not completed`);
      }
      const options = completions(ls, file, "{  }", 2);
      for (const name of ["schema", "label", "isolation", "adapter", "expect", "permissions", "keep"]) {
        assert.ok(options.includes(name), `${file}: agent option ${name} not completed`);
      }
      // Hover over agent: its doc. Over an extension option: the @remarks tag.
      const text = readFileSync(file, "utf8");
      const info = ls.getQuickInfoAtPosition(file, text.indexOf("agent("));
      assert.match(ts.displayPartsToString(info?.displayParts), /function agent\(prompt: string, opts\?: AgentOptions\)/);
      const keep = ls.getCompletionEntryDetails(file, text.indexOf("{  }") + 2, "keep", undefined, undefined, undefined, undefined);
      const remarks = keep?.tags?.find((t) => t.name === "remarks");
      assert.match(ts.displayPartsToString(remarks?.text), /ODW extension — Claude Code ignores it/);
      const label = ls.getCompletionEntryDetails(file, text.indexOf("{  }") + 2, "label", undefined, undefined, undefined, undefined);
      assert.equal(label?.tags?.find((t) => t.name === "remarks"), undefined, "label is the dialect's");
    }
  }));

test("no template shows an error in an editor with what odw types writes", () =>
  withDir((dir) => {
    for (const t of TEMPLATES) put(join(dir, ".odw", "workflows", `${t.name}.js`), t.workflow);
    writeTypes(dir);
    const ls = service(join(dir, ".odw", "jsconfig.json"));
    for (const t of TEMPLATES) {
      const file = join(dir, ".odw", "workflows", `${t.name}.js`);
      const diags = [...ls.getSyntacticDiagnostics(file), ...ls.getSemanticDiagnostics(file)];
      assert.deepEqual(diags.map((d) => `${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`), [], t.name);
    }
    const dts = join(dir, ".odw", "types", "odw.d.ts");
    assert.deepEqual([...ls.getSyntacticDiagnostics(dts), ...ls.getSemanticDiagnostics(dts)].map((d) => d.messageText), []);
  }));

test("running it again changes nothing; a user's own jsconfig.json is kept unless --force; odw's own is rewritten", () =>
  withDir((dir) => {
    writeTypes(dir);
    assert.deepEqual(writeTypes(dir).files.map((f) => f.state), ["unchanged", "unchanged"]);

    const jsconfig = join(dir, ".odw", "jsconfig.json");
    writeFileSync(jsconfig, '{ "compilerOptions": { "strict": true } }\n');
    const err = sink();
    assert.equal(cmdTypes({}, { cwd: dir, err, env: {} }), 0);
    assert.equal(readFileSync(jsconfig, "utf8"), '{ "compilerOptions": { "strict": true } }\n');
    assert.match(err.text(), /\.odw\/jsconfig\.json is not odw's: left as it is/);
    assert.match(err.text(), /\["types\/odw\.d\.ts","workflows\/\*\*\/\*\.js","\.\.\/\.claude\/workflows\/\*\*\/\*\.js"\]/);

    assert.equal(cmdTypes({ force: true }, { cwd: dir, err: sink(), env: {} }), 0);
    assert.ok(readFileSync(jsconfig, "utf8").startsWith(JSCONFIG_MARK));

    // One it wrote, edited below its first line, is still its own.
    writeFileSync(jsconfig, `${JSCONFIG_MARK}\n{}\n`);
    assert.equal(writeTypes(dir).files[1]!.state, "updated");
    // The declarations are always rewritten.
    writeFileSync(join(dir, ".odw", "types", "odw.d.ts"), "// mine\n");
    assert.equal(writeTypes(dir).files[0]!.state, "updated");
    assert.equal(readFileSync(join(dir, ".odw", "types", "odw.d.ts"), "utf8"), typesText());
  }));

test("review: odw types never writes through a symlink — a linked odw.d.ts, a dangling jsconfig.json link, a linked .odw/types", () =>
  withDir((dir) => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "odw-types-outside-")));
    try {
      const victim = join(outside, "victim.txt");
      writeFileSync(victim, "keep me\n");
      // The declarations: a link to a file elsewhere is refused, the file untouched.
      mkdirSync(join(dir, ".odw", "types"), { recursive: true });
      symlinkSync(victim, join(dir, ".odw", "types", "odw.d.ts"));
      // A dangling jsconfig.json link does not count as missing.
      symlinkSync(join(outside, "created.json"), join(dir, ".odw", "jsconfig.json"));
      const err = sink();
      assert.equal(cmdTypes({}, { cwd: dir, err, env: {} }), 1);
      assert.deepEqual(writeTypes(dir).files.map((f) => f.state), ["refused", "refused"]);
      assert.equal(readFileSync(victim, "utf8"), "keep me\n");
      assert.equal(existsSync(join(outside, "created.json")), false);
      assert.match(err.text(), /odw\.d\.ts not written: .*odw\.d\.ts is a symbolic link/);
      assert.match(err.text(), /jsconfig\.json not written: .*jsconfig\.json is a symbolic link/);

      // A linked directory on the way down: .odw/types → elsewhere.
      rmSync(join(dir, ".odw"), { recursive: true, force: true });
      mkdirSync(join(dir, ".odw"));
      symlinkSync(outside, join(dir, ".odw", "types"));
      const linked = writeTypes(dir).files;
      assert.deepEqual(linked.map((f) => f.state), ["refused", "written"]);
      assert.match(linked[0]!.reason!, /\.odw\/types is a symbolic link/);
      assert.equal(existsSync(join(outside, "odw.d.ts")), false);
      // And the project's own .odw a link: nothing under it is written.
      rmSync(join(dir, ".odw"), { recursive: true, force: true });
      symlinkSync(outside, join(dir, ".odw"));
      assert.deepEqual(writeTypes(dir).files.map((f) => f.state), ["refused", "refused"]);
      assert.deepEqual(readdirSync(outside), ["victim.txt"], "nothing written outside, no temporary file left");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  }));

test("--dir puts them elsewhere, the include paths still reaching .odw/workflows and .claude/workflows", () =>
  withDir(async (dir) => {
    mkdirSync(join(dir, ".claude", "workflows"), { recursive: true });
    put(join(dir, ".odw", "workflows", "a.js"), SCRIPT);
    put(join(dir, ".claude", "workflows", "b.js"), SCRIPT);
    assert.equal(cmdTypes({ dir: "editor" }, { cwd: dir, err: sink(), env: {} }), 0);
    assert.ok(existsSync(join(dir, "editor", "types", "odw.d.ts")));
    assert.equal(existsSync(join(dir, ".odw", "types")), false);
    assert.deepEqual(
      readConfig(join(dir, "editor", "jsconfig.json")).fileNames.map((f) => f.slice(dir.length + 1)).sort(),
      [".claude/workflows/b.js", ".odw/workflows/a.js", "editor/types/odw.d.ts"],
    );
    assert.deepEqual(
      readConfig(join(dir, ".claude", "workflows", "jsconfig.json")).fileNames.map((f) => f.slice(dir.length + 1)).sort(),
      [".claude/workflows/b.js", "editor/types/odw.d.ts"],
    );
    // A file where the directory should be is a usage error.
    writeFileSync(join(dir, "plain"), "x");
    const err = sink();
    assert.equal(cmdTypes({ dir: "plain" }, { cwd: dir, err, env: {} }), 2);
    assert.match(err.text(), /plain is not a directory/);
  }));

test("odw types through the CLI: help names it; a bad flag is a usage error", () =>
  withDir(async (dir) => {
    const was = process.cwd();
    const se = process.stderr.write.bind(process.stderr);
    const so = process.stdout.write.bind(process.stdout);
    const err: string[] = [];
    const out: string[] = [];
    (process.stderr as { write: unknown }).write = (s: unknown) => (err.push(String(s)), true);
    (process.stdout as { write: unknown }).write = (s: unknown) => (out.push(String(s)), true);
    process.chdir(dir);
    try {
      assert.equal(await main(["types"]), 0);
      assert.equal(await main(["types", "--nope"]), 2);
      assert.equal(await main(["--help"]), 0);
    } finally {
      process.chdir(was);
      process.stderr.write = se;
      process.stdout.write = so;
    }
    assert.ok(existsSync(join(dir, ".odw", "types", "odw.d.ts")));
    assert.match(err.join(""), /usage: odw types \[--dir D\] \[--force\]/);
    assert.match(out.join(""), /odw types \[--dir \.odw\] \[--force\]/);
  }));

test("odw doctor: nothing until odw types ran, ok while current, a warning once an upgrade changed the declarations", () =>
  withDir((dir) => {
    assert.equal(typesCheck(dir), null);
    writeTypes(dir);
    assert.equal(typesCheck(dir)?.status, "ok");
    // Another version string with the same declarations (a dev build moves its version every commit): still current.
    const dts = join(dir, ".odw", "types", "odw.d.ts");
    writeFileSync(dts, typesText("0.0.1"));
    assert.deepEqual(typesStatus(dir), { path: dts, version: "0.0.1", stale: false });
    // Declarations an older odw wrote.
    writeFileSync(dts, typesHeader("0.4.0") + WORKFLOW_DTS.replace("keep?: boolean;", ""));
    const stale = typesCheck(dir)!;
    assert.equal(stale.status, "warn");
    assert.match(stale.detail, /stale: written by odw 0\.4\.0/);
    assert.equal(stale.hint, "run `odw types` to rewrite it");
    writeTypes(dir);
    assert.equal(typesCheck(dir)?.status, "ok");
  }));

test("odw new writes them alongside the workflow; --no-types leaves them out", () =>
  withDir(async (dir) => {
    const err = sink();
    assert.equal(await cmdNew({ template: "hello" }, { cwd: dir, input: new PassThrough(), out: sink(), err, env: {} }), 0);
    assert.equal(readFileSync(join(dir, ".odw", "types", "odw.d.ts"), "utf8"), typesText());
    assert.ok(existsSync(join(dir, ".odw", "jsconfig.json")));
    assert.match(err.text(), /wrote \.odw\/types\/odw\.d\.ts/);

    const other = join(dir, "other");
    mkdirSync(other);
    assert.equal(await cmdNew({ template: "hello", types: false }, { cwd: other, input: new PassThrough(), out: sink(), err: sink(), env: {} }), 0);
    assert.ok(existsSync(join(other, ".odw", "workflows", "hello.js")));
    assert.equal(existsSync(join(other, ".odw", "types")), false);
    assert.equal(existsSync(join(other, ".odw", "jsconfig.json")), false);
  }));
