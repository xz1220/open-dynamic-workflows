// Guards for the build-time embeds (scripts/embed-*.mjs): the committed
// src/*.generated.ts files must only ever be regenerated from their real
// sources, never from a silent fallback.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const scripts = fileURLToPath(new URL("../scripts/", import.meta.url));

/** A throwaway checkout holding a copy of one embed script (it resolves paths from its own location). */
function sandbox(t: TestContext, script: string) {
  const root = mkdtempSync(join(tmpdir(), "odw-embed-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "src"));
  copyFileSync(join(scripts, script), join(root, "scripts", script));
  return {
    root,
    run: () => spawnSync(process.execPath, [join(root, "scripts", script)], { encoding: "utf8" }),
  };
}

/**
 * The string a generated module exports, decoded from its JSON literal. The
 * export must carry an explicit `: string` — without it tsc copies the whole
 * payload into the emitted .d.ts as a literal type, doubling it in the package.
 */
function exported(generated: string, name: string): string {
  const m = new RegExp(`^export const ${name}: string = (".*");$`, "m").exec(generated);
  assert.ok(m, `expected 'export const ${name}: string = "…";' in:\n${generated.slice(0, 300)}`);
  return JSON.parse(m[1]!) as string;
}

test("embed-dashboard fails loudly without a web build instead of falling back", (t) => {
  const { root, run } = sandbox(t, "embed-dashboard.mjs");
  writeFileSync(join(root, "src", "dashboard.html"), "<p>the removed legacy dashboard</p>");
  const r = run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /web\/dist\/index\.html not found[\s\S]*npm run build:web/);
  assert.equal(existsSync(join(root, "src", "dashboard.generated.ts")), false);
});

test("embed-dashboard inlines web/dist/index.html byte-for-byte", (t) => {
  const { root, run } = sandbox(t, "embed-dashboard.mjs");
  const html = '<!DOCTYPE html>\n<script>const a = `${1}`; // "quotes" \\ </script>\n<p>中文</p>\n';
  mkdirSync(join(root, "web", "dist"), { recursive: true });
  writeFileSync(join(root, "web", "dist", "index.html"), html);
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  const generated = readFileSync(join(root, "src", "dashboard.generated.ts"), "utf8");
  assert.match(generated, /Source: web\/dist\/index\.html \(client SPA\)/);
  assert.equal(exported(generated, "DASHBOARD_HTML"), html);
});

test("embed-skill inlines SKILL.md byte-for-byte", (t) => {
  const { root, run } = sandbox(t, "embed-skill.mjs");
  const md = "---\nname: x\n---\n\n# A `dialect` doc with ${braces} and \"quotes\"\n";
  mkdirSync(join(root, "skills", "open-dynamic-workflows"), { recursive: true });
  writeFileSync(join(root, "skills", "open-dynamic-workflows", "SKILL.md"), md);
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(exported(readFileSync(join(root, "src", "skill.generated.ts"), "utf8"), "SKILL_MD"), md);
});

test("the committed embeds are in the generated format (typed as plain strings)", () => {
  for (const [file, name] of [
    ["dashboard.generated.ts", "DASHBOARD_HTML"],
    ["skill.generated.ts", "SKILL_MD"],
  ] as const) {
    const text = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
    assert.ok(exported(text, name).length > 1000, file);
  }
});

test("typecheck only generates the gitignored version file, never the committed embeds", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts.pretypecheck, "node scripts/generate-version.mjs");
});
