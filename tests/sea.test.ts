// Guards for the single-executable (SEA) plumbing: the SEA detector and the
// hidden `__worker` subcommand that a compiled binary re-execs into (since it
// has no separate worker.js on disk). See src/sea.ts and src/runtime/launcher.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../src/cli.js";
import { RunStore } from "../src/runtime/run-store.js";
import { isSeaBinary } from "../src/sea.js";

test("isSeaBinary() is false in a normal node process", () => {
  assert.equal(isSeaBinary(), false);
});

test("cli: the hidden __worker subcommand executes a run to done", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-sea-"));
  try {
    const store = new RunStore(root);
    const script = join(root, "wf.js");
    writeFileSync(script, "export const meta = { name: 't', description: 'd' }\nreturn 42");
    const id = store.create({ script, args: null, source: root, configPath: null });

    const code = await main(["__worker", store.runDir(id)]);

    assert.equal(code, 0);
    assert.equal(store.readStatus(id).state, "done");
    assert.equal(store.readResult(id), 42);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cli: __worker with no run dir is a usage error (exit 2)", async () => {
  const write = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = () => true;
  try {
    assert.equal(await main(["__worker"]), 2);
  } finally {
    process.stderr.write = write;
  }
});
