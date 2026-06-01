import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withWorkspace } from "../src/workspace.js";

function makeSource(): string {
  const dir = mkdtempSync(join(tmpdir(), "odw-src-"));
  writeFileSync(join(dir, "a.txt"), "line1\nline2\n");
  return dir;
}

test("copy mode isolates the tree and diffs the agent's changes", async () => {
  const src = makeSource();
  try {
    const diff = await withWorkspace(src, "copy", async (ws) => {
      assert.notEqual(ws.path, src, "copy must run in a separate directory");
      await writeFile(join(ws.path, "a.txt"), "line1\nCHANGED\n");
      return ws.diff();
    });
    assert.match(diff, /a\/a\.txt/);
    assert.match(diff, /^-line2$/m);
    assert.match(diff, /^\+CHANGED$/m);
    // the real source tree must be untouched
    assert.equal(await readFile(join(src, "a.txt"), "utf8"), "line1\nline2\n");
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

test("inplace mode runs in the source and yields no diff", async () => {
  const src = makeSource();
  try {
    const out = await withWorkspace(src, "inplace", async (ws) => {
      assert.equal(ws.path, src);
      return ws.diff();
    });
    assert.equal(out, "");
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});
