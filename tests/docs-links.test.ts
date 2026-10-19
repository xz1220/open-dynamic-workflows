import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// The docs are split across README*.md and docs/ (Diataxis): every relative link
// between them, and every #anchor into a Markdown file, has to land somewhere.

const repo = fileURLToPath(new URL("..", import.meta.url));

/** README*.md at the root and every .md under docs/, relative to the repository. */
function docFiles(): string[] {
  const files = readdirSync(repo).filter((f) => /^README.*\.md$/.test(f));
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(repo, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".md")) files.push(path);
    }
  };
  walk("docs");
  return files.sort();
}

/** The lines of a Markdown file outside fenced code blocks, with their line numbers. */
function proseLines(text: string): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  let fence: string | null = null;
  text.split("\n").forEach((line, i) => {
    const m = line.match(/^\s*(`{3,}|~{3,})/);
    if (m) {
      if (!fence) fence = m[1]![0]!;
      else if (m[1]![0] === fence) fence = null;
      return;
    }
    if (!fence) out.push([i + 1, line]);
  });
  return out;
}

/** GitHub's heading anchor: lowercase, punctuation dropped, spaces to hyphens. */
function slugBase(heading: string): string {
  const text = heading.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/<[^>]+>/g, "").replace(/`/g, "");
  return text.trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "").replace(/ /g, "-");
}

/** Every anchor a Markdown file has: its headings (repeats get -1, -2, …) and explicit ids. */
function anchorsOf(text: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  for (const [, line] of proseLines(text)) {
    const h = line.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    if (h) {
      const base = slugBase(h[1]!);
      let slug = base;
      if (seen.has(base)) {
        let n = seen.get(base)!;
        do slug = `${base}-${++n}`; while (anchors.has(slug));
        seen.set(base, n);
      } else seen.set(base, 0);
      anchors.add(slug);
    }
    for (const m of line.matchAll(/\b(?:id|name)="([^"]+)"/g)) anchors.add(m[1]!);
  }
  return anchors;
}

/** The relative link targets on a line, outside inline code: Markdown links and src/href attributes. */
function linksOn(line: string): string[] {
  const prose = line.split(/(`+[^`]*`+)/).filter((_, i) => i % 2 === 0).join(" ");
  const targets = [
    ...[...prose.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[1]!),
    ...[...prose.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]!),
  ];
  return targets.filter((t) => !/^[a-z][a-z0-9+.-]*:/i.test(t) && !t.startsWith("//"));
}

const anchorCache = new Map<string, Set<string>>();
function anchorsAt(file: string): Set<string> {
  let anchors = anchorCache.get(file);
  if (!anchors) {
    anchors = anchorsOf(readFileSync(join(repo, file), "utf8"));
    anchorCache.set(file, anchors);
  }
  return anchors;
}

test("the GitHub-style anchors: punctuation dropped, CJK kept, repeats numbered", () => {
  const anchors = anchorsOf([
    "# Open Dynamic Workflows",
    "## Check an agent's work (ODW extension)",
    "## Editor completion: `odw types` (ODW extension)",
    "## 编辑器补全:`odw types`(ODW 扩展)",
    "## 恢复运行（ODW 扩展）",
    "```",
    "# not a heading",
    "```",
    "### Recipe",
    "### Recipe",
    '<a id="by-hand"></a>',
  ].join("\n"));
  assert.deepEqual([...anchors], [
    "open-dynamic-workflows",
    "check-an-agents-work-odw-extension",
    "editor-completion-odw-types-odw-extension",
    "编辑器补全odw-typesodw-扩展",
    "恢复运行odw-扩展",
    "recipe",
    "recipe-1",
    "by-hand",
  ]);
});

test("every relative link and #anchor in README*.md and docs/**/*.md resolves", () => {
  const files = docFiles();
  assert.ok(files.includes("README.md") && files.includes("docs/tutorial.md"), "the docs are where this test looks");
  const broken: string[] = [];
  let checked = 0;
  for (const file of files) {
    for (const [n, line] of proseLines(readFileSync(join(repo, file), "utf8"))) {
      for (const target of linksOn(line)) {
        checked++;
        const hashAt = target.indexOf("#");
        const path = hashAt < 0 ? target : target.slice(0, hashAt);
        const fragment = hashAt < 0 ? "" : decodeURIComponent(target.slice(hashAt + 1));
        const to = path === "" ? file : relative(repo, join(repo, dirname(file), decodeURIComponent(path))).split("\\").join("/");
        if (to.startsWith("..") || !existsSync(join(repo, to))) {
          broken.push(`${file}:${n}: ${target} — no such file`);
          continue;
        }
        if (fragment && to.endsWith(".md") && statSync(join(repo, to)).isFile() && !anchorsAt(to).has(fragment)) {
          broken.push(`${file}:${n}: ${target} — ${to} has no heading #${fragment}`);
        }
      }
    }
  }
  assert.ok(checked > 300, `only ${checked} links found: is the parser reading the docs?`);
  assert.deepEqual(broken, []);
});

/** The quoted names in the source between `start` and the next `]` or `;` (a const list or a union type). */
function namesIn(file: string, start: RegExp): string[] {
  const text = readFileSync(join(repo, file), "utf8");
  const at = text.search(start);
  assert.ok(at >= 0, `${file}: ${start} not found`);
  const rest = text.slice(at);
  const block = rest.slice(0, rest.search(/\];|;\n/));
  return [...block.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/"([a-zA-Z_]+)"/g)].map((m) => m[1]!);
}

test("the reference pages name every config key, event type and failure reason the source has", () => {
  const keys = namesIn("src/adapters/config.ts", /const KNOWN_TOP_KEYS = \[/);
  const events = [...readFileSync(join(repo, "src/events.ts"), "utf8").matchAll(/^export const [A-Z_]+ = "([a-z_]+)";/gm)].map((m) => m[1]!);
  const reasons = namesIn("src/adapters/failures.ts", /export type FailureReason =/);
  assert.ok(keys.includes("defaultAdapter") && events.includes("run_started") && reasons.includes("rate_limit"), "the source lists were found");
  for (const lang of ["", "zh-CN/"]) {
    const config = readFileSync(join(repo, `docs/${lang}reference/config.md`), "utf8");
    const eventsPage = readFileSync(join(repo, `docs/${lang}reference/events.md`), "utf8");
    assert.deepEqual(keys.filter((k) => !config.includes(`\`${k}\``)), [], `docs/${lang}reference/config.md: keys missing`);
    assert.deepEqual(events.filter((e) => !eventsPage.includes(`\`${e}\``)), [], `docs/${lang}reference/events.md: event types missing`);
    assert.deepEqual(reasons.filter((r) => !eventsPage.includes(`| \`${r}\` |`)), [], `docs/${lang}reference/events.md: failure reasons missing`);
  }
});

test("the READMEs are a front door: short, and they point into docs/", () => {
  for (const [file, docs] of [["README.md", "docs/README.md"], ["README.zh-CN.md", "docs/zh-CN/README.md"]] as const) {
    const text = readFileSync(join(repo, file), "utf8");
    const lines = text.split("\n").length;
    assert.ok(lines <= 420, `${file} has ${lines} lines: move the detail into docs/`);
    assert.ok(text.includes(`](${docs})`), `${file} links ${docs}`);
  }
});
