// Guards for the build-time embeds (scripts/embed-*.mjs): the committed
// src/*.generated.ts files must only ever be regenerated from their real
// sources, never from a silent fallback.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("the committed embed is in the generated format (typed as a plain string)", () => {
  const text = readFileSync(new URL("../src/dashboard.generated.ts", import.meta.url), "utf8");
  assert.ok(exported(text, "DASHBOARD_HTML").length > 1000);
});

test("typecheck only generates the gitignored version file, never the committed embeds", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts.pretypecheck, "node scripts/generate-version.mjs");
});

test("the build embeds the odw new templates too", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(pkg.scripts.embed, /node scripts\/embed-templates\.mjs/);
});

test("embed-templates fails loudly when a template's source is missing", (t) => {
  const { root, run } = sandbox(t, "embed-templates.mjs");
  mkdirSync(join(root, "templates"));
  writeFileSync(join(root, "templates", "index.json"), JSON.stringify([{ name: "hello", description: "d", workflow: "templates/hello.js", test: "templates/hello.json" }]));
  writeFileSync(join(root, "templates", "hello.js"), "return 1\n");
  const r = run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /template 'hello': test templates\/hello\.json not found/);
  assert.equal(existsSync(join(root, "src", "templates.generated.ts")), false);
});

test("embed-templates inlines each template's files byte-for-byte, typed (no literal types in the .d.ts)", (t) => {
  const { root, run } = sandbox(t, "embed-templates.mjs");
  mkdirSync(join(root, "templates"));
  mkdirSync(join(root, "examples"));
  const wf = "export const meta = { name: 'x', description: `${'d'}` }\n// \"quotes\" \\ 中文\nreturn 1\n";
  writeFileSync(join(root, "examples", "x.js"), wf);
  writeFileSync(join(root, "templates", "x.json"), '{ "cases": [] }\n');
  writeFileSync(
    join(root, "templates", "index.json"),
    JSON.stringify([{ name: "x", description: "an x", workflow: "examples/x.js", test: "templates/x.json" }]),
  );
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  const generated = readFileSync(join(root, "src", "templates.generated.ts"), "utf8");
  const m = /^export const TEMPLATES: readonly EmbeddedTemplate\[\] = ([\s\S]*);\n$/m.exec(generated);
  assert.ok(m, generated.slice(0, 300));
  assert.deepEqual(JSON.parse(m[1]!), [{ name: "x", description: "an x", workflow: wf, test: '{ "cases": [] }\n', eval: null }]);
});

test("the committed template embed matches its sources (templates/index.json and the files it names)", (t) => {
  const { root, run } = sandbox(t, "embed-templates.mjs");
  const repo = fileURLToPath(new URL("../", import.meta.url));
  cpSync(join(repo, "templates"), join(root, "templates"), { recursive: true });
  cpSync(join(repo, "examples"), join(root, "examples"), { recursive: true });
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    readFileSync(join(root, "src", "templates.generated.ts"), "utf8"),
    readFileSync(join(repo, "src", "templates.generated.ts"), "utf8"),
    "src/templates.generated.ts drifted: run npm run build (or node scripts/embed-templates.mjs) and commit it",
  );
});
