import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bothEnds,
  createRedactor,
  extraProblem,
  hasMarker,
  isSecretName,
  marker,
  MIN_SECRET_CHARS,
  PATTERN_KINDS,
  redactorFor,
} from "../src/redact.js";
import { collectConfigWarnings, defaultConfig, loadConfig } from "../src/adapters/config.js";

// Redaction (ODW extension): the redactor on its own — each token shape and its
// near misses, the secret-name rules, the environment's values, NAME=value,
// extra expressions, the off switch, records and JSONL lines, and text that
// arrives in chunks.
//
// No realistic-looking secret is ever written out in this file (GitHub push
// protection scans for them): every test token is built at runtime from
// fragments.

/** Letters and digits, deterministic per seed. */
function chars(n: number, seed = 1): string {
  const alphabet = "aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0z";
  return Array.from({ length: n }, (_, i) => alphabet[(i * 7 + seed * 13) % alphabet.length]).join("");
}

const BEGIN = (what: string): string => `-----BEGIN ${what ? `${what} ` : ""}PRIV` + "ATE KEY-----";
const END = (what: string): string => `-----END ${what ? `${what} ` : ""}PRIV` + "ATE KEY-----";

/** A private key block of `lines` base64 lines. */
function keyBlock(what = "RSA", lines = 4): string {
  const body = Array.from({ length: lines }, (_, i) => chars(64, i + 2));
  return [BEGIN(what), ...body, chars(20, 9) + "==", END(what)].join("\n");
}

/** One token of each shape `redact.patterns` knows, as each provider prints them. */
const TOKENS: Record<string, string[]> = {
  anthropic: [["sk", "ant", "api03", chars(93)].join("-") + "AA", ["sk", "ant", "oat01", chars(80, 2)].join("-")],
  openai: [["sk", "proj", chars(120)].join("-"), ["sk", "svcacct", chars(60, 3)].join("-"), "sk" + "-" + chars(48, 4)],
  github: ["gh" + "p_" + chars(36), "gh" + "s_" + chars(36, 2), "gh" + "o_" + chars(36, 3), "github" + "_pat_" + chars(22) + "_" + chars(59, 5)],
  slack: [["xo" + "xb", "2345678901", "3456789012", chars(24)].join("-"), ["xo" + "xp", "1", "2345678901", chars(32, 6)].join("-")],
  aws: ["AK" + "IA" + "QWERTYUIOP234567", "AS" + "IA" + "ZXCVBNMASDFGHJ23"],
  google: ["AI" + "za" + chars(35)],
  jwt: [["ey" + "JhbGciOiJIUzI1NiJ9", "ey" + "J" + chars(40), chars(43, 7)].join(".")],
  private_key: [keyBlock("RSA"), keyBlock("OPENSSH", 6), keyBlock("EC", 2)],
};

const redactor = createRedactor(undefined, {});

test("every token shape is redacted as its kind, in prose, in JSON, in a URL", () => {
  assert.deepEqual(new Set(PATTERN_KINDS), new Set([...Object.keys(TOKENS), "bearer"]));
  for (const [kind, tokens] of Object.entries(TOKENS)) {
    for (const token of tokens) {
      const hidden = marker(kind);
      assert.equal(redactor.text(`found ${token} in config`), `found ${hidden} in config`, `${kind}: ${token.slice(0, 12)}…`);
      assert.equal(redactor.text(`"key":"${token}"`), `"key":"${hidden}"`, `${kind} in JSON`);
      assert.equal(redactor.text(`(${token})\n`), `(${hidden})\n`, `${kind} in parentheses`);
    }
  }
  const url = `https://api.example.com/v1?key=${TOKENS.google![0]}&q=1`;
  assert.equal(redactor.text(url), `https://api.example.com/v1?key=${marker("google")}&q=1`);
});

test("a Bearer token keeps its scheme; prose about bearers is not a token", () => {
  const token = chars(40) + "==";
  assert.equal(redactor.text(`Authorization: Bearer ${token}`), `Authorization: Bearer ${marker("bearer")}`);
  assert.equal(redactor.text(`authorization: bearer\t${chars(30, 2)}`), `authorization: bearer\t${marker("bearer")}`);
  // A JWT behind Bearer is the bearer's.
  assert.equal(redactor.text(`Bearer ${TOKENS.jwt![0]}`), `Bearer ${marker("bearer")}`);
  for (const prose of ["Bearer authentication is described in RFC 6750", "the bearer of this note", "Bearer tok3n", "Bearer <token>"]) {
    assert.equal(redactor.text(prose), prose);
  }
});

test("near misses of each shape are left alone", () => {
  const nearMisses = [
    // anthropic / openai: too short, inside a longer word, or a package name
    "sk-ant-" + chars(10),
    "task-" + chars(40),
    "risk-" + chars(40),
    "sk-learn",
    "sk-learn-compatible-estimators",
    "sk-" + chars(20),
    "sk-proj-" + chars(12),
    // github
    "gh" + "p_" + chars(12),
    "gh" + "x_" + chars(36),
    "my" + "ghp_" + chars(36),
    "github" + "_pat_short",
    // slack
    "xo" + "xo-" + chars(20),
    "xo" + "xb-short",
    // aws: too short, lowercase, inside a longer run
    "AK" + "IA" + "QWERTY",
    "ak" + "ia" + "qwertyuiop234567",
    "X" + "AK" + "IA" + "QWERTYUIOP234567",
    "AK" + "IA" + "QWERTYUIOP2345678",
    // google
    "AI" + "za" + chars(20),
    // jwt: one or two parts only
    "ey" + "J" + chars(30),
    ["ey" + "J" + chars(20), "ey" + "J" + chars(20)].join("."),
    // a private key's header alone is not its body, a public key is no secret
    "-----BEGIN PUBLIC KEY-----",
    "-----BEGIN CERTIFICATE-----\n" + chars(64),
  ];
  for (const text of nearMisses) assert.equal(redactor.text(text), text, text.slice(0, 40));
});

test("a private key is redacted whole — as printed, JSON-escaped, on one line, or cut off before its end", () => {
  const block = TOKENS.private_key![0]!;
  assert.equal(redactor.text(`before\n${block}\nafter`), `before\n${marker("private_key")}\nafter`);
  // A service account key printed as JSON text: its line breaks are \n escapes.
  const json = JSON.stringify({ type: "service_account", private_key: `${block}\n`, client_email: "a@b.c" });
  assert.equal(redactor.text(json), JSON.stringify({ type: "service_account", private_key: `${marker("private_key")}\n`, client_email: "a@b.c" }));
  // On one line, as some tools print it.
  assert.equal(redactor.text(`${BEGIN("")}${chars(200)}${END("")}`), marker("private_key"));
  // `head -3 id_rsa`: the header and the body lines that follow go; the prose line after stays.
  const cut = [BEGIN("RSA"), chars(64), chars(64, 3)].join("\n");
  assert.equal(redactor.text(`${cut}\nnot base64 here.`), `${marker("private_key")}\nnot base64 here.`);
  // An encrypted key: headers and a blank line before its body.
  const encrypted = [BEGIN("RSA"), "Proc-Type: 4,ENCRYPTED", "DEK-Info: AES-128-CBC,0123456789ABCDEF", "", chars(64), chars(30, 4), END("RSA")].join("\n");
  assert.equal(redactor.text(`x\n${encrypted}\ny`), `x\n${marker("private_key")}\ny`);
});

test("the secret-name rules: *_KEY, *TOKEN, *SECRET*, *PASSWORD*, AUTHORIZATION, cloud credentials", () => {
  const secret = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OPENAI_APIKEY",
    "SSH_KEY",
    "KEY",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "npm_config__authToken",
    "CLIENT_SECRET",
    "SECRET_KEY_BASE",
    "DB_PASSWORD",
    "PGPASSWORD",
    "MYSQL_PWD",
    "GPG_PASSPHRASE",
    "AUTHORIZATION",
    "HTTP_AUTHORIZATION",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AZURE_CLIENT_SECRET",
    "AZURE_STORAGE_CONNECTION_STRING",
    "GOOGLE_CREDENTIALS",
    "GOOGLE_CLOUD_KEYFILE_JSON",
    "GITHUB_APP_PRIVATE_KEY",
    "GITLAB_PAT",
    "SLACK_WEBHOOK_URL",
    "github_token",
  ];
  const ordinary = ["PATH", "HOME", "PWD", "OLDPWD", "MONKEY", "PUBKEY", "TOKENIZERS_PARALLELISM", "MAX_TOKENS", "SSH_AUTH_SOCK", "TERM", "KEYTIMEOUT", "LANG", "ODW_PORT", "AWS_REGION", "CLASSPATH"];
  for (const name of secret) assert.equal(isSecretName(name), true, name);
  for (const name of ordinary) assert.equal(isSecretName(name), false, name);
});

test("the environment's secret values are redacted exactly, wherever they appear, naming their variable", () => {
  const value = "demo-" + chars(24);
  const longer = value + "-and-more";
  const r = createRedactor(undefined, {
    env: [
      { DEMO_API_KEY: value, LONGER_TOKEN: longer, SHORT_TOKEN: "abc1234", HOME: "/home/someone", EDITOR: chars(20) },
      undefined,
      { ADAPTER_SECRET: "quote\"and\\slash-" + chars(8) },
    ],
  });
  assert.equal(r.text(`it is ${value}.`), `it is ${marker("env:DEMO_API_KEY")}.`);
  assert.equal(r.text(`inside${value}too`), `inside${marker("env:DEMO_API_KEY")}too`);
  // The longer value is matched whole, not as the shorter one plus a rest.
  assert.equal(r.text(longer), marker("env:LONGER_TOKEN"));
  // Under 8 characters, not secret-named: left alone.
  assert.equal(MIN_SECRET_CHARS, 8);
  assert.equal(r.text("abc1234 /home/someone " + chars(20)), "abc1234 /home/someone " + chars(20));
  // A value as JSON escapes it is matched too.
  const escaped = JSON.stringify("quote\"and\\slash-" + chars(8)).slice(1, -1);
  assert.equal(r.text(`{"v":"${escaped}"}`), `{"v":"${marker("env:ADAPTER_SECRET")}"}`);
  assert.equal(r.text("quote\"and\\slash-" + chars(8)), marker("env:ADAPTER_SECRET"));
  assert.deepEqual(r.coverage.variables, ["ADAPTER_SECRET", "DEMO_API_KEY", "LONGER_TOKEN"]);
});

test("a secret value of several lines is redacted whole, and line by line as a stream prints it", () => {
  const body = [chars(64), chars(64, 2), chars(40, 3)];
  const value = ["header line with spaces", ...body].join("\n");
  const r = createRedactor({ env: true, patterns: false, extra: [] }, { env: [{ APP_PRIVATE_KEY: value }] });
  assert.equal(r.text(`x ${value} y`), `x ${marker("env:APP_PRIVATE_KEY")} y`);
  // Printed line by line (a text transcript), each body line is still caught; a line with spaces is no secret alone.
  assert.equal(r.text(body[1]!), marker("env:APP_PRIVATE_KEY"));
  assert.equal(r.text("header line with spaces"), "header line with spaces");
});

test("NAME=value of a secret-looking name is redacted — a printed .env, env output, export", () => {
  const dotenv = [
    "DATABASE_HOST=db.internal",
    "DB_PASSWORD=hunter2hunter2",
    'STRIPE_SECRET_KEY="' + chars(30) + '"',
    "export NPM_TOKEN='" + chars(20, 2) + "'",
    "PATH=/usr/local/bin:/usr/bin",
    "MAX_TOKENS=100000000",
    "SHORT_TOKEN=abc",
    "lower_token=" + chars(20),
  ].join("\n");
  assert.equal(
    redactor.text(dotenv),
    [
      "DATABASE_HOST=db.internal",
      `DB_PASSWORD=${marker("env:DB_PASSWORD")}`,
      `STRIPE_SECRET_KEY="${marker("env:STRIPE_SECRET_KEY")}"`,
      `export NPM_TOKEN='${marker("env:NPM_TOKEN")}'`,
      "PATH=/usr/local/bin:/usr/bin",
      "MAX_TOKENS=100000000",
      "SHORT_TOKEN=abc",
      "lower_token=" + chars(20),
    ].join("\n"),
  );
  // A token shape is named by its kind; the assignment does not redact it again.
  const token = "gh" + "p_" + chars(36);
  assert.equal(redactor.text(`GITHUB_TOKEN=${token}`), `GITHUB_TOKEN=${marker("github")}`);
  // Redacting twice changes nothing.
  assert.equal(redactor.text(redactor.text(dotenv)), redactor.text(dotenv));
});

test("an environment value is named by its variable before any shape or assignment", () => {
  const token = "gh" + "p_" + chars(36, 4);
  const r = createRedactor(undefined, { env: [{ GH_TOKEN: token }] });
  assert.equal(r.text(`push with ${token}`), `push with ${marker("env:GH_TOKEN")}`);
  assert.equal(r.text(`OTHER_TOKEN=${token}`), `OTHER_TOKEN=${marker("env:GH_TOKEN")}`);
});

test("extra expressions are redacted as extra; a bad one is refused before a run starts", () => {
  const r = createRedactor({ env: false, patterns: false, extra: ["corp-[0-9a-f]{16}", "(?=x)"] }, {});
  assert.equal(r.text("id corp-0123456789abcdef ok"), `id ${marker("extra")} ok`);
  // An expression matching empty text somewhere marks nothing there.
  assert.equal(r.text("xyz"), "xyz");
  assert.equal(extraProblem("corp-[0-9a-f]{16}"), null);
  assert.match(extraProblem("(unclosed") ?? "", /^is not a valid regular expression: /);
  assert.match(extraProblem("a*") ?? "", /matches empty text/);
  assert.match(extraProblem("") ?? "", /non-empty string/);
  assert.match(extraProblem(42) ?? "", /non-empty string/);
});

test("the off switch and each part of redact turns its rules off", () => {
  const value = "demo-" + chars(24);
  const token = "gh" + "p_" + chars(36);
  const text = `${value} ${token} DB_PASSWORD=hunter2hunter2 corp-0123456789abcdef`;
  const env = [{ DEMO_API_KEY: value }];
  const off = createRedactor(false, { env });
  assert.equal(off.active, false);
  assert.equal(off.text(text), text);
  assert.equal(off.jsonLine(JSON.stringify({ text })), JSON.stringify({ text }));
  assert.equal(off.coverage.off, true);

  const noEnv = createRedactor({ env: false, patterns: true, extra: [] }, { env });
  assert.equal(noEnv.text(text), `${value} ${marker("github")} DB_PASSWORD=hunter2hunter2 corp-0123456789abcdef`);
  const noPatterns = createRedactor({ env: true, patterns: false, extra: [] }, { env });
  assert.equal(noPatterns.text(text), `${marker("env:DEMO_API_KEY")} ${token} DB_PASSWORD=${marker("env:DB_PASSWORD")} corp-0123456789abcdef`);
  const all = createRedactor({ env: true, patterns: true, extra: ["corp-[0-9a-f]{16}"] }, { env });
  assert.equal(all.text(text), `${marker("env:DEMO_API_KEY")} ${marker("github")} DB_PASSWORD=${marker("env:DB_PASSWORD")} ${marker("extra")}`);
  // A workflow's own value: shapes and extra only — never the variables' values, nor NAME=value.
  assert.equal(all.shapes.text(text), `${value} ${marker("github")} DB_PASSWORD=hunter2hunter2 ${marker("extra")}`);
});

test("redact loads, defaults on, and rejects malformed values", () => {
  assert.deepEqual(defaultConfig().settings.redact, { env: true, patterns: true, extra: [] });
  const example = JSON.parse(readFileSync(new URL("../odw.config.example.json", import.meta.url), "utf8")) as Record<string, unknown>;
  assert.deepEqual(example.redact, { env: true, patterns: true, extra: [] });
  assert.deepEqual(collectConfigWarnings({ redact: { env: true, patterns: false, extra: ["x+"] } }), []);
  assert.deepEqual(collectConfigWarnings({ redact: { envs: true } }), ['redact: unknown field "envs" is ignored — did you mean "env"?']);
  const dir = mkdtempSync(join(tmpdir(), "odw-redact-config-"));
  try {
    const load = (redact: unknown) => {
      const path = join(dir, "odw.config.json");
      writeFileSync(path, JSON.stringify({ redact }));
      return loadConfig(path, { quiet: true }).settings.redact;
    };
    assert.equal(load(false), false);
    assert.deepEqual(load(null), { env: true, patterns: true, extra: [] });
    assert.deepEqual(load(true), { env: true, patterns: true, extra: [] });
    assert.deepEqual(load({ patterns: false }), { env: true, patterns: false, extra: [] });
    assert.deepEqual(load({ env: false, extra: ["corp-[0-9a-f]{32}"] }), { env: false, patterns: true, extra: ["corp-[0-9a-f]{32}"] });
    assert.throws(() => load("yes"), /"redact" must be \{ "env": true\|false, "patterns": true\|false, "extra": \["<regex>", …\] \}, or false/);
    assert.throws(() => load({ env: "no" }), /"redact.env" must be true or false; got "no"/);
    assert.throws(() => load({ extra: "x" }), /"redact.extra" must be a list of regular expressions; got "x"/);
    assert.throws(() => load({ extra: ["("] }), /"redact.extra\[0\]" is not a valid regular expression: .*; got "\("/);
    assert.throws(() => load({ extra: ["ok", "a*"] }), /"redact.extra\[1\]" matches empty text, so it would mark every position; got "a\*"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a run's redactor covers odw's own environment and every adapter's env", () => {
  const config = defaultConfig();
  config.adapters.mine = { name: "mine", command: ["mine"], env: { MINE_API_KEY: "adapter-" + chars(20) } };
  const r = redactorFor(config, { WORKER_TOKEN: "worker-" + chars(20), HOME: "/home/x" });
  assert.deepEqual(r.coverage.variables, ["MINE_API_KEY", "WORKER_TOKEN"]);
  assert.equal(r.text("adapter-" + chars(20)), marker("env:MINE_API_KEY"));
  assert.equal(r.text("worker-" + chars(20)), marker("env:WORKER_TOKEN"));
  assert.equal(redactorFor({ ...config, settings: { ...config.settings, redact: false } }, {}).active, false);
});

test("values are redacted deeply — keys too — and come back as they were when nothing was", () => {
  const token = "AK" + "IA" + "QWERTYUIOP234567";
  const value = { list: [token, 1, null, { deep: `x ${token}` }], [token]: true, when: new Date(0), n: 2 };
  const out = redactor.value(value) as Record<string, unknown>;
  assert.deepEqual(JSON.parse(JSON.stringify(out)), {
    list: [marker("aws"), 1, null, { deep: `x ${marker("aws")}` }],
    [marker("aws")]: true,
    when: "1970-01-01T00:00:00.000Z",
    n: 2,
  });
  const clean = { a: ["b", { c: "d" }], when: new Date(0) };
  assert.equal(redactor.value(clean), clean, "the same object when nothing was redacted");
  assert.equal(redactor.value("plain"), "plain");
  // A cycle is left alone (JSON.stringify refuses it as before); a shared object is redacted everywhere.
  const cyclic: Record<string, unknown> = { token };
  cyclic.self = cyclic;
  const shared = { token };
  const twice = redactor.value({ a: shared, b: shared }) as { a: { token: string }; b: { token: string } };
  assert.equal(twice.a.token, marker("aws"));
  assert.equal(twice.b.token, marker("aws"));
  assert.equal((redactor.value(cyclic) as { token: string }).token, marker("aws"));
  // A key named __proto__ stays an own key.
  const proto = redactor.value(JSON.parse(`{"__proto__":{"t":"${token}"}}`)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(proto), ["__proto__"]);
  assert.equal(Object.getPrototypeOf(proto), Object.prototype);
});

test("a record keeps the fields it is keyed by, and says when anything was redacted", () => {
  const token = "AI" + "za" + chars(35);
  const ev = { ts: 1, type: "log", runId: "r1", agentId: 3, adapter: "codex", reason: "quota", label: "L", message: `key ${token}` };
  const out = redactor.record(ev);
  assert.deepEqual(out, { ...ev, message: `key ${marker("google")}`, redacted: true });
  const clean = { ts: 1, type: "log", message: "nothing here" };
  assert.equal(redactor.record(clean), clean);
  // The resume key and the adapter are never touched, whatever an extra expression says.
  const greedy = createRedactor({ env: false, patterns: false, extra: ["[0-9a-f]{64}", "codex"] }, {});
  const rec = { agentId: 1, key: "a".repeat(64), adapter: "codex", value: "codex said " + "b".repeat(64) };
  assert.deepEqual(greedy.record(rec), { ...rec, value: `${marker("extra")} said ${marker("extra")}`, redacted: true });
});

test("a JSONL line with a secret is written anew, marked redacted; any other line comes back as received", () => {
  const token = ["sk", "ant", "api03", chars(93)].join("-");
  const event = { type: "assistant", message: { content: [{ type: "text", text: `the key is ${token}\nok` }] }, n: 1.5 };
  const line = JSON.stringify(event) + "\n";
  assert.equal(
    redactor.jsonLine(line),
    JSON.stringify({ ...event, message: { content: [{ type: "text", text: `the key is ${marker("anthropic")}\nok` }] }, redacted: true }) + "\n",
  );
  // Nothing to redact: byte for byte as received (spacing, escapes, number forms kept).
  const raw = '{ "type":"result", "n": 1.0, "s":"\\u00e9" }\r\n';
  assert.equal(redactor.jsonLine(raw), raw);
  assert.equal(redactor.jsonLine("Debugger attached.\r\n"), "Debugger attached.\r\n");
  // A line that is not JSON is redacted as text.
  assert.equal(redactor.jsonLine(`warning: ${token}\n`), `warning: ${marker("anthropic")}\n`);
  assert.equal(redactor.jsonLine(`{ not json ${token}`), `{ not json ${marker("anthropic")}`);
  // An array has no room for a mark: only its strings change.
  assert.equal(redactor.jsonLine(JSON.stringify([token, 1])), JSON.stringify([marker("anthropic"), 1]));
});

test("both ends of a long diagnostic never cut a marker in half; plain text is cut as before", () => {
  const hidden = marker("env:DEMO_API_KEY");
  assert.equal(bothEnds("short", 250), "short");
  const plain = "a".repeat(300) + "b".repeat(300);
  assert.equal(bothEnds(plain, 250), `${"a".repeat(250)} … ${"b".repeat(250)}`);
  // A marker across the head's cut is kept whole; so is one across the tail's.
  const text = "x".repeat(240) + hidden + "y".repeat(300) + hidden + "z".repeat(240);
  const cut = bothEnds(text, 250);
  assert.equal(cut, `${"x".repeat(240)}${hidden} … ${hidden}${"z".repeat(240)}`);
  assert.equal(cut.split(hidden).length, 3);
  // French quotes are not markers: cut where they fall.
  const quoted = "«".repeat(600);
  assert.equal(bothEnds(quoted, 250), `${"«".repeat(250)} … ${"«".repeat(250)}`);
});

test("hasMarker finds a redaction marker, and nothing else", () => {
  assert.equal(hasMarker(`a ${marker("env:GITHUB_TOKEN")} b`), true);
  assert.equal(hasMarker(marker("private_key")), true);
  assert.equal(hasMarker("«redacted:»"), false);
  assert.equal(hasMarker("redacted: github"), false);
});

// --- streams ------------------------------------------------------------------------

/** Feed `text` to a fresh stream in pieces cut at `cuts`; return what it let go, end included, and what each write returned. */
function streamed(text: string, cuts: number[], r = redactor): { out: string; writes: string[] } {
  const stream = r.stream();
  const writes: string[] = [];
  let from = 0;
  for (const at of [...cuts, text.length]) {
    writes.push(stream.write(text.slice(from, at)));
    from = at;
  }
  const out = writes.join("") + stream.end();
  return { out, writes };
}

test("a stream redacts a secret split across chunks, wherever the split falls", () => {
  const value = "demo-" + chars(24);
  const r = createRedactor(undefined, { env: [{ DEMO_API_KEY: value }] });
  for (const token of [TOKENS.github![0]!, TOKENS.jwt![0]!, value, "Bearer " + chars(40)]) {
    const text = `first line\nthe token is ${token} — ok\nlast`;
    const expected = r.text(text);
    assert.notEqual(expected, text);
    const start = text.indexOf(token);
    for (let at = start - 1; at <= start + token.length + 1; at++) {
      assert.equal(streamed(text, [at], r).out, expected, `split at ${at - start} of ${token.slice(0, 8)}…`);
    }
  }
});

test("a stream lets whole lines go at once and holds only the line still arriving", () => {
  const { writes } = streamed("one\ntwo\nthr", []);
  assert.equal(writes[0], "one\ntwo\n");
  const stream = redactor.stream();
  assert.equal(stream.write("partial"), "");
  assert.equal(stream.write(" line\nnext"), "partial line\n");
  assert.equal(stream.end(), "next");
  assert.equal(stream.end(), "", "nothing is held twice");
});

test("a stream holds a private key's lines until its end line, then redacts it whole", () => {
  const block = TOKENS.private_key![0]!;
  const text = `before\n${block}\nafter\n`;
  const stream = redactor.stream();
  const lines = text.split(/(?<=\n)/);
  const out: string[] = [];
  for (const line of lines) out.push(stream.write(line));
  out.push(stream.end());
  assert.equal(out.join(""), `before\n${marker("private_key")}\nafter\n`);
  assert.equal(out[0], "before\n", "the line before the key goes at once");
  assert.ok(out.slice(1, -3).every((piece) => piece === ""), "the key's lines wait for its end line");
  // Cut into 7-character chunks, the key is still redacted whole.
  const cuts = Array.from({ length: Math.floor(text.length / 7) }, (_, i) => (i + 1) * 7);
  assert.equal(streamed(text, cuts).out, `before\n${marker("private_key")}\nafter\n`);
  // A key whose end never comes is let go when the stream ends — redacted.
  assert.equal(streamed([BEGIN("RSA"), chars(64), chars(64, 2), ""].join("\n"), [30]).out, `${marker("private_key")}\n`);
});

test("a line too long to wait for goes in pieces, never cut inside a secret", () => {
  const token = TOKENS.github![0]!;
  const filler = "y ".repeat(20_000); // 40 000 characters, one line
  const text = `${filler}${token} ${filler}${token} end`;
  const stream = redactor.stream();
  const pieces: string[] = [];
  for (let at = 0; at < text.length; at += 1000) pieces.push(stream.write(text.slice(at, at + 1000)));
  assert.ok(pieces.some((piece) => piece.length > 0), "the long line was let go in pieces before it ended");
  pieces.push(stream.end());
  const out = pieces.join("");
  assert.equal(out, redactor.text(text));
  assert.equal(out.split(marker("github")).length, 3);
  assert.equal(out.includes(token.slice(0, 10)), false);
});
