/**
 * The run's notes board (ODW extension; see src/notes.ts): agents posting
 * through their ODW_NOTES shim, later agents finding the notes in their
 * prompt, the interface-change note of an isolated agent's kept diff, the
 * caps and the redaction, `odw note`/`odw notes`, and GET /api/runs/:id/notes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import type { WorkflowEvent } from "../src/events.js";
import {
  BOARD_MAX_NOTES,
  NOTE_MAX_CHARS,
  NotesBoard,
  interfaceSummary,
  notesPrompt,
  readNotes,
  type Note,
} from "../src/notes.js";
import { createRedactor } from "../src/redact.js";
import { RunStore } from "../src/runtime/run-store.js";
import { startServer } from "../src/runtime/server.js";
import { executeRun } from "../src/runtime/worker.js";
import { main } from "../src/cli.js";

const POSIX_ONLY = { skip: process.platform === "win32" };
const NOTE_AGENT = fileURLToPath(new URL("./fixtures/note-agent.mjs", import.meta.url));

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "odw-notes-src-"));
  git(dir, "init", "-q");
  for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
  git(dir, "add", "-A");
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--no-gpg-sign", "-m", "init");
  return dir;
}

/** Run `body` over `source` with the notes mock agent as the default adapter. */
async function runFlow(root: string, source: string, body: string, config: Record<string, unknown> = {}) {
  const configPath = join(root, "odw.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({ defaultAdapter: "noter", adapters: { noter: { command: [execPath, NOTE_AGENT], stdin: "{prompt}" } }, ...config }),
  );
  const script = join(root, "wf.js");
  writeFileSync(script, `export const meta = { name: 'wf', description: 'd' }\n${body}`);
  const store = new RunStore(join(root, "runs"));
  const id = store.create({ script, args: null, source, configPath });
  return { id, state: await executeRun(store.runDir(id)), store };
}

type Reply = { prompt: string; notes: string | null; board: string | null };

/** Capture what a CLI call prints. */
async function capture(argv: string[], env: Record<string, string | undefined> = {}): Promise<{ code: number; out: string; err: string }> {
  const saved: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(env)) {
    saved[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  let out = "";
  let err = "";
  const write = { out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
  process.stdout.write = ((chunk: string) => ((out += chunk), true)) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => ((err += chunk), true)) as typeof process.stderr.write;
  try {
    return { code: await main(argv), out, err };
  } finally {
    process.stdout.write = write.out;
    process.stderr.write = write.err;
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("a note one parallel agent posts reaches a later agent's prompt; agents without notes get none", POSIX_ONLY, async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-notes-run-"));
  try {
    const { id, state, store } = await runFlow(
      root,
      root,
      `const [writer, quiet] = await parallel([
         () => agent('Rename the parser.\\nNOTE: renamed parseX to parse in src/parse.ts', { label: 'writer' }),
         () => agent('Write the docs.', { label: 'quiet' }),
       ], { notes: true })
       const later = await agent('Use the parser.', { label: 'later', notes: true })
       const off = await agent('No board here.', { label: 'off' })
       return { writer, quiet, later, off }`,
    );
    assert.equal(state, "done");
    const result = store.readResult(id) as Record<string, string>;
    const reply = (name: string): Reply => JSON.parse(result[name]!) as Reply;

    // Both parallel agents had the board: ODW_NOTES and how to post in the prompt.
    for (const name of ["writer", "quiet"]) {
      assert.ok(reply(name).notes, `${name} got ODW_NOTES`);
      assert.match(reply(name).prompt, /"\$ODW_NOTES" "<your note>"/);
    }
    // The later agent finds the note in its prompt, by who posted it.
    const later = reply("later");
    assert.match(later.prompt, /Notes from the other agents in this run:\n#1 \[agent 1 · writer\] renamed parseX to parse in src\/parse\.ts/);
    // …and reading the board prints it too.
    assert.match(later.board!, /#1 \[agent 1 · writer\] renamed parseX to parse/);
    // An agent without notes runs exactly as written: no variable, no board in its prompt.
    const off = reply("off");
    assert.equal(off.notes, null);
    assert.doesNotMatch(off.prompt, /notes board|ODW_NOTES/);

    // The board in the run directory, and its event.
    const notes = readNotes(store.runDir(id));
    assert.equal(notes.length, 1);
    assert.deepEqual({ ...notes[0], ts: 0 }, { noteId: 1, ts: 0, by: { agentId: 1, label: "writer" }, text: "renamed parseX to parse in src/parse.ts", kind: "note" });
    const added = store.readEvents(id).filter((e) => e.type === "note_added");
    assert.equal(added.length, 1);
    assert.equal(added[0]!.text, "renamed parseX to parse in src/parse.ts");
    assert.deepEqual(added[0]!.by, { agentId: 1, label: "writer" });
    // The note lands before its agent is seen to finish.
    const events = store.readEvents(id);
    const finished = events.findIndex((e) => e.type === "agent_finished" && e.agentId === 1);
    assert.ok(events.indexOf(added[0]!) < finished);

    // odw notes prints it; --json gives the board as kept.
    const printed = await capture(["notes", id, "--runs-root", join(root, "runs")]);
    assert.equal(printed.code, 0);
    assert.match(printed.out, /^#1 \[agent 1 · writer\] renamed parseX to parse in src\/parse\.ts\n$/);
    const json = await capture(["notes", id, "--json", "--runs-root", join(root, "runs")]);
    assert.equal((JSON.parse(json.out) as Note[])[0]!.text, "renamed parseX to parse in src/parse.ts");

    // GET /api/runs/:id/notes serves the same.
    const handle = await startServer({ store, port: 0, host: "127.0.0.1", claudeProjectsRoot: join(root, "no-claude") });
    try {
      const served = (await fetch(`${handle.url}/api/runs/${id}/notes`).then((r) => r.json())) as Note[];
      assert.deepEqual(served, notes);
      assert.equal((await fetch(`${handle.url}/api/runs/20990101-000000-abcdef/notes`)).status, 404);
    } finally {
      await handle.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the notes setting turns the board on for every agent; notes: false opts one out; parallel() checks its options", POSIX_ONLY, async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-notes-run-"));
  try {
    const { id, state, store } = await runFlow(
      root,
      root,
      `const on = await agent('one', { label: 'on' })
       const out = await agent('two', { label: 'out', notes: false })
       let bad = null
       try { await parallel([() => 1], { note: true }) } catch (e) { bad = String(e.message) }
       return { on, out, bad }`,
      { notes: true },
    );
    assert.equal(state, "done");
    const result = store.readResult(id) as { on: string; out: string; bad: string };
    assert.ok((JSON.parse(result.on) as Reply).notes);
    assert.match((JSON.parse(result.on) as Reply).prompt, /No notes from the other agents in this run yet\./);
    assert.equal((JSON.parse(result.out) as Reply).notes, null);
    assert.match(result.bad, /parallel\(\) has no option "note"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an isolated agent's kept change is broadcast: diff stat and the interface lines it touched, seen by the next agent", POSIX_ONLY, async () => {
  const src = makeRepo({ "parse.ts": "export function parseX(input: string) {\n  return input;\n}\n" });
  const root = mkdtempSync(join(tmpdir(), "odw-notes-run-"));
  try {
    const { id, state, store } = await runFlow(
      root,
      src,
      `await agent('WRITE: parse.ts export function parse(input: string): string {\\\\n  return input.trim();\\\\n}\\\\n', { label: 'rename', isolation: 'worktree', notes: true })
       return await agent('Now use it.', { label: 'user', notes: true })`,
    );
    assert.equal(state, "done");
    const notes = readNotes(store.runDir(id));
    assert.equal(notes.length, 1);
    const note = notes[0]!;
    assert.equal(note.kind, "interface");
    assert.deepEqual(note.by, { agentId: 1, label: "rename" });
    assert.match(note.text, /^finished with a change to 1 file \(\+2 -2\): parse\.ts \(\+2 -2\)$/m);
    assert.match(note.text, /^- export function parseX\(input: string\) \{$/m);
    assert.match(note.text, /^\+ export function parse\(input: string\): string \{$/m);
    const reply = JSON.parse(store.readResult(id) as string) as Reply;
    assert.match(reply.prompt, /#1 \[agent 1 · rename\] \(interface change\) finished with a change to 1 file/);
    assert.match(reply.prompt, /\+ export function parse\(input: string\): string \{/);
    // The source tree is untouched: the change is the run's to apply.
    assert.match(readFileSync(join(src, "parse.ts"), "utf8"), /parseX/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});

test("interfaceSummary reads a real git diff: per-file stats, declaration lines across languages, capped", POSIX_ONLY, () => {
  const src = makeRepo({
    "api.ts": "export function a() {}\nconst x = 1;\n",
    "lib.py": "def old(x):\n    return x\n",
    "main.go": "package main\n\nfunc Run() {}\n",
    "lib.rs": "fn private() {}\n",
  });
  try {
    writeFileSync(join(src, "api.ts"), "export function a(opts: Opts) {}\nconst x = 2;\nexport interface Opts { n: number }\n");
    writeFileSync(join(src, "lib.py"), "async def new(x, y):\n    return x\nclass Thing:\n    pass\n");
    writeFileSync(join(src, "main.go"), "package main\n\nfunc Run(ctx Context) error { return nil }\n");
    writeFileSync(join(src, "lib.rs"), "fn private() {}\npub fn public(n: u32) -> u32 { n }\npub(crate) fn inner() {}\n");
    const diff = git(src, "diff", "--no-color");
    const summary = interfaceSummary(diff)!;
    assert.match(summary, /^finished with a change to 4 files \(\+9 -4\): api\.ts \(\+3 -2\), lib\.py \(\+3 -1\), lib\.rs \(\+2 -0\), main\.go \(\+1 -1\)$/m);
    for (const line of [
      "- export function a() {}",
      "+ export function a(opts: Opts) {}",
      "+ export interface Opts { n: number }",
      "- def old(x):",
      "+ async def new(x, y):",
      "+ class Thing:",
      "- func Run() {}",
      "+ func Run(ctx Context) error { return nil }",
      "+ pub fn public(n: u32) -> u32 { n }",
      "+ pub(crate) fn inner() {}",
    ]) {
      assert.ok(summary.split("\n").includes(line), `summary names ${line}:\n${summary}`);
    }
    // Not declarations: a const, a private fn.
    assert.doesNotMatch(summary, /const x|fn private/);

    // Capped: at most 12 lines and 10 files named, each line cut.
    const many = Array.from({ length: 30 }, (_, i) =>
      `diff --git a/f${i}.ts b/f${i}.ts\n--- a/f${i}.ts\n+++ b/f${i}.ts\n@@ -1 +1 @@\n+export const v${i} = "${"x".repeat(300)}";`,
    ).join("\n");
    const capped = interfaceSummary(many)!;
    assert.match(capped, /, and 20 more\n/);
    assert.match(capped, /^… and 18 more$/m);
    assert.ok(capped.split("\n").every((line) => line.length <= 400));
    assert.equal(interfaceSummary(""), null);
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

test("the board caps each note and the board, redacts secrets, strips control characters, and says once when full", () => {
  const runDir = mkdtempSync(join(tmpdir(), "odw-notes-board-"));
  const events: WorkflowEvent[] = [];
  try {
    const redactor = createRedactor(undefined, { env: [{ NOTES_TEST_API_KEY: "s3cr3t-placeholder-value-1234" }] });
    const board = new NotesBoard({ runDir, redactor, emit: (ev) => events.push(ev) });
    const by = { agentId: 2, label: "w" };
    assert.equal(board.post(by, "   \n "), null, "an empty note is no note");
    const long = board.post(by, "y".repeat(NOTE_MAX_CHARS + 500))!;
    assert.equal(long.text.length, NOTE_MAX_CHARS);
    assert.equal(long.truncated, true);
    const secret = board.post(by, "the key is s3cr3t-placeholder-value-1234 now")!;
    assert.equal(secret.redacted, true);
    assert.doesNotMatch(secret.text, /s3cr3t/);
    assert.doesNotMatch(readFileSync(join(runDir, "notes.jsonl"), "utf8"), /s3cr3t/);
    const ctl = board.post(by, "a\u001b[31mred\u0007\r\nnext")!;
    assert.equal(ctl.text, "a[31mred\nnext");
    // Fill it: the cap holds, later notes are dropped, and the run says so once.
    for (let i = board.list().length; i < BOARD_MAX_NOTES; i++) assert.ok(board.post(by, `n${i} ${"z".repeat(100)}`));
    assert.equal(board.post(by, "one too many"), null);
    assert.equal(board.post(by, "two too many"), null);
    assert.equal(readNotes(runDir).length, BOARD_MAX_NOTES);
    assert.equal(events.filter((e) => e.type === "log" && /notes board is full/.test(String(e.message))).length, 1);
    assert.equal(events.filter((e) => e.type === "note_added").length, BOARD_MAX_NOTES);
    // The prompt shows the latest notes that fit, and says how many it left out.
    const prompt = notesPrompt(board.list());
    assert.ok(prompt.length < 9000);
    assert.ok(/\(\d+ earlier notes left out — run "\$ODW_NOTES" to read them all\)/.test(prompt), "says what it left out");
    assert.ok(prompt.endsWith(`#${BOARD_MAX_NOTES} [agent 2 · w] n${BOARD_MAX_NOTES - 1} ${"z".repeat(100)}`), "ends with the latest");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("an agent's shim posts into its own inbox, prints the board, and odw note does the same from its environment", POSIX_ONLY, async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-notes-shim-"));
  const runDir = join(root, "wf", "20260101-000000-abc123");
  mkdirSync(runDir, { recursive: true });
  const events: WorkflowEvent[] = [];
  try {
    const board = new NotesBoard({ runDir, emit: (ev) => events.push(ev), pollMs: 10 });
    const seven = board.openAgent(7, "seven");
    const shim = seven.env.ODW_NOTES!;
    assert.equal(shim, join(runDir, "notes", "7", "note"));
    assert.equal(execFileSync("sh", [shim], { encoding: "utf8" }), "(no notes yet)\n");
    execFileSync("sh", [shim, "it's", "a  note"]);
    // Picked up while the agent runs, within a poll or two.
    const deadline = Date.now() + 5000;
    while (board.list().length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    assert.equal(board.list()[0]?.text, "it's a  note");
    assert.equal(execFileSync("sh", [shim], { encoding: "utf8" }), "#1 [agent 7 · seven] it's a  note\n");

    // odw note, as the agent: its ODW_* variables say where.
    const env = { ODW_RUN_ID: "20260101-000000-abc123", ODW_AGENT_ID: "7", ODW_NOTES: shim };
    const posted = await capture(["note", "from", "odw", "note"], env);
    assert.equal(posted.code, 0, posted.err);
    // Mismatched ids are refused; outside an agent it says what it needs.
    const wrong = await capture(["note", "x"], { ...env, ODW_AGENT_ID: "8" });
    assert.equal(wrong.code, 1);
    assert.match(wrong.err, /not agent 8's/);
    const outside = await capture(["note", "x"], { ODW_RUN_ID: undefined, ODW_AGENT_ID: undefined, ODW_NOTES: undefined });
    assert.equal(outside.code, 1);
    assert.match(outside.err, /needs the ODW_RUN_ID and ODW_AGENT_ID/);
    assert.equal((await capture(["note"], env)).code, 2);

    // Its end takes what is left, at once.
    seven.close();
    assert.deepEqual(board.list().map((n) => n.text), ["it's a  note", "from odw note"]);
    assert.deepEqual(readdirSync(join(runDir, "notes", "7", "inbox")), []);
    // The container binds: its inbox read-write, its shim and the board read-only —
    // never its whole notes directory, from which it could swap the inbox for a link.
    const seven7 = join(runDir, "notes", "7");
    assert.deepEqual(seven.mounts, [
      { source: join(seven7, "inbox"), target: join(seven7, "inbox"), readonly: false },
      { source: join(seven7, "note"), target: join(seven7, "note"), readonly: true },
      { source: join(runDir, "notes", "board"), target: join(runDir, "notes", "board"), readonly: true },
    ]);
    assert.ok(existsSync(join(runDir, "notes.jsonl")));
    board.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an inbox swapped for a link to another directory is not swept: the file there is neither posted nor deleted", POSIX_ONLY, () => {
  const runDir = mkdtempSync(join(tmpdir(), "odw-notes-escape-"));
  const victimDir = mkdtempSync(join(tmpdir(), "odw-notes-victim-"));
  try {
    writeFileSync(join(victimDir, "id_rsa"), "host secret placeholder");
    const board = new NotesBoard({ runDir, emit: () => {}, pollMs: 60_000 });
    const notes = board.openAgent(1, "attacker");
    const inbox = join(runDir, "notes", "1", "inbox");
    // `rm -rf inbox; ln -s ~ inbox`, as an agent bound its whole notes directory could.
    rmSync(inbox, { recursive: true });
    symlinkSync(victimDir, inbox);
    notes.close();
    board.close();
    assert.equal(readFileSync(join(victimDir, "id_rsa"), "utf8"), "host secret placeholder", "the file outside survives");
    assert.deepEqual(board.list(), [], "and is not posted");
    assert.deepEqual(readNotes(runDir), []);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
    rmSync(victimDir, { recursive: true, force: true });
  }
});

test("a link or a FIFO dropped in an inbox is skipped — its target neither read nor deleted, the FIFO never waited on — and real notes still post", POSIX_ONLY, () => {
  const runDir = mkdtempSync(join(tmpdir(), "odw-notes-entries-"));
  const victimDir = mkdtempSync(join(tmpdir(), "odw-notes-victim-"));
  try {
    const victim = join(victimDir, "secret.txt");
    writeFileSync(victim, "host secret placeholder");
    const board = new NotesBoard({ runDir, emit: () => {}, pollMs: 60_000 });
    const notes = board.openAgent(1, "attacker");
    const inbox = join(runDir, "notes", "1", "inbox");
    symlinkSync(victim, join(inbox, "n-1-0"));
    execFileSync("mkfifo", [join(inbox, "n-1-1")]);
    writeFileSync(join(inbox, "n-1-2"), "a real note");
    notes.close(); // a FIFO opened for reading, blocking, would hang here
    board.close();
    assert.equal(readFileSync(victim, "utf8"), "host secret placeholder", "the link's target survives");
    assert.deepEqual(board.list().map((n) => n.text), ["a real note"], "only the regular file is posted");
    assert.ok(existsSync(join(inbox, "n-1-0")) && existsSync(join(inbox, "n-1-1")), "the link and the FIFO are left alone");
    assert.ok(!existsSync(join(inbox, "n-1-2")), "the note taken is removed");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
    rmSync(victimDir, { recursive: true, force: true });
  }
});
