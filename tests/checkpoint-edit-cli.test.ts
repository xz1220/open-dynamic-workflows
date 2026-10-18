import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import { CHECKPOINT_EDIT_MAX_BYTES } from "../src/checkpoint.js";
import { cli, pendingIds, project, until, type Project } from "./checkpoint-project.js";

// `odw approve --payload JSON|@file` and `odw approve --edit` (ODW extension):
// approving a checkpoint() with an edited payload from a terminal. --edit runs
// a fake $EDITOR (fixtures/fake-editor.mjs) through the shell, as it would vi.

const POSIX_ONLY = { skip: process.platform === "win32" };
const FAKE_EDITOR = fileURLToPath(new URL("./fixtures/fake-editor.mjs", import.meta.url));
const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

const PLAN = {
  type: "object",
  properties: { steps: { type: "array", items: { type: "string" }, minItems: 1 } },
  required: ["steps"],
};

/** A run waiting at one checkpoint with a schema; it returns what the checkpoint resolved to. */
async function waitingRun(p: Project, payload: unknown = { steps: ["a", "b"] }) {
  const started = p.start(
    `const r = await checkpoint('Run the plan?', { payload: ${JSON.stringify(payload)}, schema: ${JSON.stringify(PLAN)} })\n` +
      "return r\n",
  );
  await until(() => pendingIds(p.store, started.id).length === 1);
  return started;
}

/** The answers in the run's decision log, without their timestamps. */
const answers = (p: Project, id: string) => p.store.readCheckpointRequests(id).map(({ at: _at, ...r }) => r);

/**
 * Run `odw approve --edit` as if from a terminal, with the fake editor as
 * $EDITOR: `text` (when given) is what the person leaves in the file.
 */
async function editWith(p: Project, argv: string[], editor: { text?: string; exit?: number } = {}) {
  const seen = join(p.root, `seen-${Date.now()}-${Math.random()}.json`);
  const env = {
    VISUAL: undefined,
    EDITOR: `${quote(execPath)} ${quote(FAKE_EDITOR)}`,
    FAKE_EDITOR_SEEN: seen,
    FAKE_EDITOR_TEXT: editor.text,
    FAKE_EDITOR_EXIT: editor.exit === undefined ? undefined : String(editor.exit),
  };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  const tty = (on: boolean) => {
    for (const stream of [process.stdin, process.stdout]) {
      if (on) Object.defineProperty(stream, "isTTY", { value: true, configurable: true });
      else delete (stream as { isTTY?: boolean }).isTTY;
    }
  };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  tty(true);
  try {
    const r = await cli(argv);
    const opened = existsSync(seen) ? (JSON.parse(readFileSync(seen, "utf8")) as { file: string; text: string; mode: number; dirMode: number }) : null;
    return { ...r, opened };
  } finally {
    tty(false);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("odw approve --payload: inline JSON and @file; the run gets the edit", async () => {
  const p = project();
  try {
    const flags = ["--runs-root", p.runsRoot];
    const first = await waitingRun(p);
    let r = await cli(["approve", first.id, "--payload", '{"steps":["b"]}', "--note", "just b", ...flags]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /approve requested for checkpoint #1 "Run the plan\?" of .*, with an edited payload/);
    assert.deepEqual(answers(p, first.id), [{ action: "approve", checkpointId: 1, note: "just b", payload: { steps: ["b"] }, by: "cli" }]);
    assert.equal(await first.run, "done");
    assert.deepEqual(p.store.readResult(first.id), { approved: true, note: "just b", by: "cli", payload: { steps: ["b"] }, edited: true });

    const second = await waitingRun(p);
    const file = join(p.root, "plan.json");
    writeFileSync(file, '\n{\n  "steps": ["c", "d", "e"]\n}\n');
    r = await cli(["approve", second.id, "--payload", `@${file}`, ...flags]);
    assert.equal(r.code, 0, r.err);
    assert.equal(await second.run, "done");
    assert.deepEqual((p.store.readResult(second.id) as { payload: unknown }).payload, { steps: ["c", "d", "e"] });
  } finally {
    await p.cleanup();
  }
});

test("odw approve --payload refuses what the run would refuse, and writes nothing", async () => {
  const p = project();
  try {
    const flags = ["--runs-root", p.runsRoot];
    const { id } = await waitingRun(p);
    const cases: Array<[string[], number, RegExp]> = [
      [["approve", id, "--payload", "{steps: [1]}"], 2, /odw approve: --payload: not JSON: /],
      [["approve", id, "--payload", "@" + join(p.root, "missing.json")], 2, /--payload: cannot read .*missing\.json/],
      [["approve", id, "--payload", JSON.stringify("x".repeat(CHECKPOINT_EDIT_MAX_BYTES))], 2, /the payload is 262146 bytes of JSON; the limit is 262144 \(256 KiB\)/],
      [["reject", id, "--payload", "{}"], 2, /odw reject: --payload and --edit go with odw approve only/],
      [["reject", id, "--edit"], 2, /odw reject: --payload and --edit go with odw approve only/],
      [["approve", id, "--payload", "{}", "--edit"], 2, /mutually exclusive/],
      [["approve", id, "--payload", '{"steps":[]}'], 1, /the payload does not match the checkpoint's schema: \$\.steps: expected at least 1 items, got 0 — not answering; checkpoint #1 still waits/],
      [
        ["approve", id, "--payload", '{"steps":[1,2]}'],
        1,
        /does not match checkpoint #1's schema — not answering; it still waits:\n  \$\.steps\[0\]: expected string, got integer\n  \$\.steps\[1\]: expected string, got integer\n$/,
      ],
    ];
    for (const [argv, code, message] of cases) {
      const r = await cli([...argv, ...flags]);
      assert.equal(r.code, code, `${argv.join(" ")}: ${r.err}`);
      assert.match(r.err, message);
    }
    assert.deepEqual(answers(p, id), [], "nothing was written");
  } finally {
    await p.cleanup();
  }
});

test("odw approve --edit opens $EDITOR on the payload in a private file; the edit is sent and the file removed", POSIX_ONLY, async () => {
  const p = project();
  try {
    const { id, run } = await waitingRun(p);
    const r = await editWith(p, ["approve", id, "--edit", "--runs-root", p.runsRoot], { text: '{ "steps": ["a", "b", "c"] }\n' });
    assert.equal(r.code, 0, r.err);
    assert.ok(r.opened, "the editor ran");
    assert.equal(r.opened!.text, '{\n  "steps": [\n    "a",\n    "b"\n  ]\n}\n', "pretty-printed");
    assert.equal(r.opened!.mode, 0o600);
    assert.equal(r.opened!.dirMode, 0o700);
    assert.equal(existsSync(r.opened!.file), false, "removed once sent");
    assert.match(r.err, /with an edited payload/);
    assert.equal(await run, "done");
    assert.deepEqual(p.store.readResult(id), { approved: true, note: null, by: "cli", payload: { steps: ["a", "b", "c"] }, edited: true });
  } finally {
    await p.cleanup();
  }
});

test("odw approve --edit: unchanged approves as is; empty aborts; invalid keeps the file and says where", POSIX_ONLY, async () => {
  const p = project();
  try {
    const flags = ["--runs-root", p.runsRoot];
    const { id, run } = await waitingRun(p);

    // Empty: nothing answered, nothing kept — as git does for an empty commit message.
    let r = await editWith(p, ["approve", id, "--edit", ...flags], { text: "  \n" });
    assert.equal(r.code, 1);
    assert.match(r.err, /the payload file was empty — not answering; checkpoint #1 still waits/);
    assert.equal(existsSync(r.opened!.file), false);

    // Not JSON: the edit is kept, and named.
    r = await editWith(p, ["approve", id, "--edit", ...flags], { text: '{ "steps": ["a", }' });
    assert.equal(r.code, 1);
    assert.match(r.err, /the edited payload is not JSON: .* — not answering; checkpoint #1 still waits\n  your edit is kept in (.+)\n/);
    assert.ok(r.err.includes(r.opened!.file));
    assert.equal(readFileSync(r.opened!.file, "utf8"), '{ "steps": ["a", }');
    rmSync(dirname(r.opened!.file), { recursive: true });

    // Off the schema: the same.
    r = await editWith(p, ["approve", id, "--edit", ...flags], { text: '{ "steps": [] }' });
    assert.equal(r.code, 1);
    assert.match(r.err, /does not match the checkpoint's schema: \$\.steps: expected at least 1 items, got 0 .*\n  your edit is kept in /);
    assert.equal(existsSync(r.opened!.file), true);
    rmSync(dirname(r.opened!.file), { recursive: true });

    // The editor failed (vim's :cq): nothing answered; an untouched file is not kept.
    r = await editWith(p, ["approve", id, "--edit", ...flags], { exit: 1 });
    assert.equal(r.code, 1);
    assert.match(r.err, /the editor \(.*\) exited with code 1 — not answering/);
    assert.equal(existsSync(r.opened!.file), false);
    assert.deepEqual(answers(p, id), [], "none of those answered");

    // Unchanged (reformatted counts as unchanged): approved as is, no edit sent.
    r = await editWith(p, ["approve", id, "--edit", "--note", "fine", ...flags], { text: '{"steps":["a","b"]}' });
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /payload unchanged — approving checkpoint #1 as is/);
    assert.doesNotMatch(r.err, /with an edited payload/);
    assert.equal(existsSync(r.opened!.file), false);
    assert.deepEqual(answers(p, id), [{ action: "approve", checkpointId: 1, note: "fine", by: "cli" }]);
    assert.equal(await run, "done");
    assert.deepEqual(p.store.readResult(id), { approved: true, note: "fine", by: "cli", payload: { steps: ["a", "b"] }, edited: false });
  } finally {
    await p.cleanup();
  }
});

test("odw approve --edit without a terminal is a clear error; a cut payload cannot be edited", async () => {
  const p = project();
  try {
    const flags = ["--runs-root", p.runsRoot];
    const { id } = await waitingRun(p);
    const r = await cli(["approve", id, "--edit", ...flags]);
    assert.equal(r.code, 2);
    assert.match(r.err, /--edit opens an editor, which needs a terminal .* --payload '<json>' or --payload @file\.json/);

    const long = await waitingRun(p, { steps: ["x".repeat(70_000)] });
    const cut = await editWith(p, ["approve", long.id, "--edit", ...flags], { text: "{}" });
    assert.equal(cut.code, 1);
    assert.match(cut.err, /cannot --edit checkpoint #1: its payload was cut to 64 KiB/);
    assert.equal(cut.opened, null, "no editor was opened");
    assert.deepEqual(answers(p, id), []);
  } finally {
    await p.cleanup();
  }
});
