import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import { collectConfigWarnings, defaultConfig, loadConfig } from "../src/adapters/config.js";
import { nativeSchemaArgs, planSchema } from "../src/adapters/native-schema.js";
import { commandAt } from "../src/adapters/permissions.js";
import type { CommandRunner } from "../src/adapters/runner.js";
import type { CliResult, Config, Settings } from "../src/adapters/types.js";
import { Bridge, type BridgeOptions } from "../src/bridge.js";
import { buildContext } from "../src/context.js";
import { AdapterExecutionError, AgentError, SchemaValidationError } from "../src/errors.js";
import { AGENT_FAILED, LOG, MemorySink } from "../src/events.js";
import { createPrimitives } from "../src/primitives.js";
import { RunStore } from "../src/runtime/run-store.js";
import { executeRun } from "../src/runtime/worker.js";

// Native structured output (ODW extension): a schema is audited before its
// agent starts, handed to a CLI that validates schemas itself (claude inline,
// codex as a file), and still validated by ODW on every reply.

const ok = (stdout: string): CliResult => ({ returncode: 0, stdout, stderr: "", timedOut: false, duration: 0.01 });

/** Claude Code's stream-json, ending in a successful result event with `fields` over it. */
function claudeStream(fields: Record<string, unknown>): string {
  const events = [
    { type: "system", subtype: "init", session_id: "s" },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "",
      usage: { input_tokens: 3, output_tokens: 4 },
      total_cost_usd: 0.002,
      session_id: "s",
      ...fields,
    },
  ];
  return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

function configFor(adapter: string, settings: Partial<Settings> = {}): Config {
  const config = defaultConfig();
  config.settings.defaultAdapter = adapter;
  Object.assign(config.settings, settings);
  return config;
}

interface Run {
  command: string[];
  stdin: string;
}

/** A bridge whose runner records every CLI run and answers it with `reply`. */
function recording(config: Config, reply: (run: Run, n: number) => string | CliResult, options: BridgeOptions = {}) {
  const runs: Run[] = [];
  const runner: CommandRunner = async (command, opts) => {
    const run = { command, stdin: opts?.stdin ?? "" };
    runs.push(run);
    const answer = reply(run, runs.length);
    return typeof answer === "string" ? ok(answer) : answer;
  };
  return { runs, bridge: new Bridge(config, { source: "/repo", runner, ...options }) };
}

const VERDICT = {
  type: "object",
  required: ["verdict"],
  properties: { verdict: { enum: ["pass", "fail"] }, note: { type: "string" } },
};
/** VERDICT as OpenAI's strict mode wants it: closed, every property required. */
const STRICT_VERDICT = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "note"],
  properties: { verdict: { enum: ["pass", "fail"] }, note: { type: "string" } },
};
/** The prompt describes the schema (schema.ts describeSchema). */
const DESCRIBED = /JSON Schema:/;
const claudeArgv = (tier: "read" | "edit" = "edit") => commandAt(defaultConfig().adapters.claude!, tier);
const codexArgv = () => commandAt(defaultConfig().adapters.codex!, "edit").map((part) => (part === "{workspace}" ? "/repo" : part));

// --- the plan -------------------------------------------------------------------------

test("planSchema: a schema ODW checks whole goes natively to a CLI that takes it, else in the prompt", () => {
  const { adapters, settings } = defaultConfig();
  assert.deepEqual(planSchema(adapters.claude!, VERDICT, settings), {
    native: { args: ["--json-schema"], mode: "inline" },
    check: VERDICT,
    describe: false,
  });
  assert.deepEqual(planSchema(adapters.gemini!, VERDICT, settings), { native: null, check: VERDICT, describe: true });
  assert.equal(planSchema(adapters.claude!, VERDICT, { ...settings, schemaPrompt: "always" }).describe, true);
  // codex takes only strict schemas natively; any other is described to it, and that is said.
  assert.deepEqual(planSchema(adapters.codex!, STRICT_VERDICT, settings), {
    native: { args: ["--output-schema"], mode: "file", strict: true },
    check: STRICT_VERDICT,
    describe: false,
  });
  const loose = planSchema(adapters.codex!, VERDICT, settings);
  assert.deepEqual([loose.native, loose.check, loose.describe, loose.error], [null, VERDICT, true, undefined]);
  assert.equal(
    loose.note,
    `adapter 'codex' takes only strict schemas natively (an object at the root, and every object "additionalProperties": false ` +
      `with all its properties "required"): this schema goes in the prompt, and ODW alone checks the reply`,
  );
});

// The keywords tests/schema.test.ts documents as the portability boundary: each
// one fails the call, precisely, before anything is spawned.
const UNCHECKED_FIELDS: Array<[string, Record<string, unknown>]> = [
  ['"oneOf"', { oneOf: [{ const: "a" }, { const: "b" }] }],
  ['"anyOf"', { anyOf: [{ type: "string" }, { type: "null" }] }],
  ['"allOf"', { allOf: [{ type: "string" }] }],
  ['"$ref"', { $ref: "#/$defs/s", $defs: { s: { type: "string" } } }],
  ['"const"', { const: "a" }],
  ['"pattern"', { type: "string", pattern: "^a" }],
  ['"format"', { type: "string", format: "date-time" }],
  ['"minimum"', { type: "number", minimum: 0 }],
  ['"maxItems"', { type: "array", items: { type: "string" }, maxItems: 2 }],
  ['a type union ["string","null"]', { type: ["string", "null"] }],
];
for (const [what, field] of UNCHECKED_FIELDS) {
  test(`preflight: ${what} fails the call before its CLI starts, saying where it is and what would let it run`, async () => {
    const { runs, bridge } = recording(configFor("claude"), () => claudeStream({}));
    const schema = { type: "object", required: ["field"], properties: { field } };
    await assert.rejects(
      () => bridge.run({ prompt: "p", schema }),
      (err: unknown) =>
        err instanceof AgentError &&
        err.message ===
          `agent() schema uses JSON Schema that ODW's validator does not check: ${what} at #/properties/field — ` +
            `remove it (a "description" can still ask the agent for it), or set "schemaKeywords": "native" ` +
            `to leave it to adapter 'claude', which validates the schema itself`,
    );
    assert.equal(runs.length, 0, "nothing was spawned");
  });
}

test("preflight: the advice fits the adapter — one without native schemas, or one that takes only strict ones", () => {
  const { adapters } = defaultConfig();
  const pattern = { type: "object", properties: { id: { type: "string", pattern: "^x" } } };
  const native = { schemaKeywords: "native", schemaPrompt: "auto" } as const;
  assert.match(
    planSchema(adapters.gemini!, pattern, native).error!,
    /: "pattern" at #\/properties\/id — adapter 'gemini' does not validate schemas itself, so nothing would enforce it: remove it .*, or run this agent on an adapter that does \(one with "flags\.schema", like the built-in claude\) and set "schemaKeywords": "native"$/,
  );
  assert.match(
    planSchema(adapters.codex!, pattern, native).error!,
    /— adapter 'codex' validates only strict schemas itself \(an object at the root, .*\), and this one is not: remove it .*, or make the schema strict$/,
  );
  assert.match(
    planSchema(adapters.codex!, pattern, { ...native, schemaKeywords: "odw" }).error!,
    /or make the schema strict and set "schemaKeywords": "native"$/,
  );
  // A strict schema runs natively on codex, which enforces its pattern; ODW checks the rest.
  const strict = { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string", pattern: "^x" } } };
  const plan = planSchema(adapters.codex!, strict, native);
  assert.deepEqual([plan.error, plan.native?.mode, plan.describe], [undefined, "file", false]);
  assert.deepEqual(plan.check, { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" } } });
  // Many keywords: the first eight, then how many more.
  const many = { type: "object", properties: Object.fromEntries([...Array(10).keys()].map((i) => [`f${i}`, { const: i }])) };
  assert.match(planSchema(adapters.claude!, many, { ...native, schemaKeywords: "odw" }).error!, /"const" at #\/properties\/f7; and 2 more — /);
});

test("preflight: what no validator could check fails in every mode, and a schema must be an object", async () => {
  const typo = { type: "object", properties: { a: { type: "string" } }, requird: ["a"] };
  for (const schemaKeywords of ["odw", "native"] as const) {
    assert.equal(
      planSchema(defaultConfig().adapters.claude!, typo, { schemaKeywords, schemaPrompt: "auto" }).error,
      'agent() schema is not JSON Schema ODW can check: unknown keyword "requird" (did you mean "required"?) at # — fix it',
    );
  }
  const { runs, bridge } = recording(configFor("claude", { schemaKeywords: "native" }), () => claudeStream({}));
  for (const [schema, kind] of [
    ["a string", "a string"],
    [[{ type: "string" }], "a list"],
    [true, "a boolean"],
    [5, "a number"],
  ] as const) {
    await assert.rejects(
      () => bridge.run({ prompt: "p", schema: schema as never }),
      new RegExp(`^AgentError: agent\\(\\) option schema must be a JSON Schema object; got ${kind}$`),
    );
  }
  assert.equal(runs.length, 0);
});

// --- handing the schema over --------------------------------------------------------

test("claude is handed the schema inline after every other argument; with no schema its argv is unchanged", async () => {
  const { runs, bridge } = recording(configFor("claude"), (run) =>
    claudeStream(
      run.command.includes("--json-schema") ? { result: "Reviewed.", structured_output: { verdict: "pass" } } : { result: "plain answer" },
    ),
  );
  const out = await bridge.run({ prompt: "Review it.", schema: VERDICT, model: "opus" });
  assert.deepEqual([out.value, out.text, out.attempts], [{ verdict: "pass" }, "Reviewed.", 1]);
  assert.deepEqual(runs[0]!.command, [...claudeArgv(), "--model", "opus", "--json-schema", JSON.stringify(VERDICT)]);
  assert.match(runs[0]!.stdin, /Review it\./);
  assert.doesNotMatch(runs[0]!.stdin, DESCRIBED, "a CLI handed the schema is not told it again");
  // The tier's flags stay where {permission_args} was, whatever the tier.
  await bridge.run({ prompt: "Read it.", schema: VERDICT, permissions: "read" });
  assert.deepEqual(runs[1]!.command, [...claudeArgv("read"), "--json-schema", JSON.stringify(VERDICT)]);
  // No schema: the default argv, byte for byte.
  assert.equal((await bridge.run({ prompt: "Just answer." })).value, "plain answer");
  assert.deepEqual(runs[2]!.command, claudeArgv());
});

test("the schema reaches the CLI as written: placeholders inside it are not expanded", async () => {
  const schema = {
    type: "object",
    required: ["path"],
    properties: { path: { type: "string", description: "a path under {workspace}, not {prompt}" } },
  };
  const { runs, bridge } = recording(configFor("claude"), () => claudeStream({ structured_output: { path: "src/a.ts" } }));
  assert.deepEqual((await bridge.run({ prompt: "p", schema })).value, { path: "src/a.ts" });
  assert.equal(runs[0]!.command.at(-1), JSON.stringify(schema));
});

test('"schemaPrompt": "always" describes the schema to a CLI handed it natively too', async () => {
  const { runs, bridge } = recording(configFor("claude", { schemaPrompt: "always" }), () => claudeStream({ structured_output: { verdict: "fail" } }));
  assert.deepEqual((await bridge.run({ prompt: "p", schema: VERDICT })).value, { verdict: "fail" });
  assert.match(runs[0]!.stdin, DESCRIBED);
  assert.equal(runs[0]!.command.at(-2), "--json-schema");
});

test("codex is handed a strict schema as a file in the run directory, there only while its CLI runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odw-schema-file-"));
  try {
    const path = join(dir, "agents", "7.schema.json");
    const held: unknown[] = [];
    const { runs, bridge } = recording(
      configFor("codex"),
      (run) => {
        held.push(JSON.parse(readFileSync(run.command.at(-1)!, "utf8")));
        return '{"verdict": "pass", "note": ""}';
      },
      { agentSchemaPath: (agentId) => join(dir, "agents", `${agentId}.schema.json`) },
    );
    const out = await bridge.run({ prompt: "Check it.", schema: STRICT_VERDICT }, { agentId: 7 });
    assert.deepEqual(out.value, { verdict: "pass", note: "" });
    assert.deepEqual(runs[0]!.command, [...codexArgv(), "--output-schema", path], "after `-`, as --model goes");
    assert.deepEqual(held, [STRICT_VERDICT], "the file held the schema while codex ran");
    assert.equal(existsSync(path), false, "and is gone once it has run");
    assert.doesNotMatch(runs[0]!.stdin, DESCRIBED);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("without a run directory a temp directory holds the file; every CLI run's goes after it — retried, failed or thrown", async () => {
  const paths: string[] = [];
  const answering = (answers: Array<string | CliResult>) => (run: Run, n: number) => {
    const path = run.command.at(-1)!;
    paths.push(path);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), STRICT_VERDICT, "written before the CLI starts");
    return answers[n - 1]!;
  };
  // A schema retry writes it again for its own run.
  const retried = recording(configFor("codex"), answering(["no JSON here", '{"verdict": "fail", "note": "n"}']));
  const out = await retried.bridge.run({ prompt: "p", schema: STRICT_VERDICT });
  assert.deepEqual([out.value, out.attempts], [{ verdict: "fail", note: "n" }, 2]);
  assert.ok(retried.runs.every((run) => run.command.at(-2) === "--output-schema"));
  // A failed CLI run, and a runner that throws.
  const failed = recording(configFor("codex"), answering([{ returncode: 1, stdout: "", stderr: "boom", timedOut: false, duration: 0 }]));
  await assert.rejects(() => failed.bridge.run({ prompt: "p", schema: STRICT_VERDICT }), AdapterExecutionError);
  const runner: CommandRunner = async (command) => {
    paths.push(command.at(-1)!);
    throw new Error("spawn exploded");
  };
  await assert.rejects(() => new Bridge(configFor("codex"), { source: "/repo", runner }).run({ prompt: "p", schema: STRICT_VERDICT }), /spawn exploded/);
  assert.equal(paths.length, 4);
  assert.equal(new Set(paths).size, 4, "a fresh file for every run");
  for (const path of paths) {
    assert.match(path, /odw-schema-[^/\\]+[/\\]schema\.json$/, "in a temp directory of its own");
    assert.equal(existsSync(dirname(path)), false, "removed with its directory");
  }
});

test("nativeSchemaArgs: inline is compact JSON; a file gets its directory made, and only the file is removed", async () => {
  const inline = await nativeSchemaArgs({ args: ["--json-schema"], mode: "inline" }, VERDICT);
  assert.deepEqual(inline.args, ["--json-schema", JSON.stringify(VERDICT)]);
  await inline.cleanup();
  const dir = mkdtempSync(join(tmpdir(), "odw-schema-args-"));
  try {
    const file = join(dir, "agents", "3.schema.json");
    const written = await nativeSchemaArgs({ args: ["--output-schema"], mode: "file" }, VERDICT, file);
    assert.deepEqual(written.args, ["--output-schema", file]);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), VERDICT);
    await written.cleanup();
    assert.equal(existsSync(file), false);
    assert.ok(existsSync(join(dir, "agents")), "the run's agents directory stays");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("codex is not handed a schema strict mode would refuse: it goes in the prompt, and the run says so once", async () => {
  const notes: string[] = [];
  const { runs, bridge } = recording(configFor("codex"), () => '{"verdict": "pass"}');
  for (const prompt of ["one", "two"]) {
    const out = await bridge.run({ prompt, schema: VERDICT }, { onNote: (message) => notes.push(message) });
    assert.deepEqual(out.value, { verdict: "pass" });
  }
  assert.deepEqual(
    runs.map((run) => run.command),
    [codexArgv(), codexArgv()],
  );
  assert.ok(runs.every((run) => DESCRIBED.test(run.stdin)), "described in the prompt instead");
  assert.equal(notes.length, 1, "once per run, not per agent");
  assert.match(notes[0]!, /^adapter 'codex' takes only strict schemas natively/);
});

test("an adapter without native schemas gets its schema in the prompt and an untouched argv, as before", async () => {
  const config = configFor("mine");
  config.adapters.mine = { name: "mine", command: ["mine", "--go"], stdin: "{prompt}" };
  const { runs, bridge } = recording(config, () => 'Answer: {"verdict": "pass"}');
  assert.deepEqual((await bridge.run({ prompt: "p", schema: VERDICT })).value, { verdict: "pass" });
  assert.deepEqual(runs[0]!.command, ["mine", "--go"]);
  assert.match(runs[0]!.stdin, DESCRIBED);
  for (const name of ["gemini", "qwen", "kimi", "omp", "kilo", "opencode", "cursor"]) {
    const jsonl = name === "kilo" || name === "opencode";
    const reply = '{"verdict": "pass"}';
    const built = recording(configFor(name), () => (jsonl ? JSON.stringify({ type: "text", part: { type: "text", text: reply } }) : reply));
    assert.deepEqual((await built.bridge.run({ prompt: "p", schema: VERDICT })).value, { verdict: "pass" }, name);
    const [run] = built.runs;
    assert.ok(!run!.command.some((part) => part === "--json-schema" || part === "--output-schema"), name);
    assert.match(run!.stdin || run!.command.join(" "), DESCRIBED, name);
  }
});

// --- what comes back -------------------------------------------------------------------

test("the value is claude's structured_output; without one the result text is read; a bad one is retried", async () => {
  const replies = [
    claudeStream({ result: "I reviewed it carefully.", structured_output: null }),
    claudeStream({ result: "", structured_output: { verdict: "maybe" } }),
    claudeStream({ result: "All good.", structured_output: { verdict: "fail", note: "edge case" } }),
  ];
  const replied: string[] = [];
  const { runs, bridge } = recording(configFor("claude", { schemaRetries: 2 }), (_run, n) => replies[n - 1]!);
  const out = await bridge.run({ prompt: "p", schema: VERDICT }, { onReply: (text) => replied.push(text) });
  assert.deepEqual([out.value, out.text, out.attempts], [{ verdict: "fail", note: "edge case" }, "All good.", 3]);
  assert.deepEqual(replied, ["I reviewed it carefully.", "", "All good."], "every attempt's reply is reported");
  assert.ok(runs.every((run) => run.command.at(-2) === "--json-schema"), "every retry hands the schema over again");
  // Each retry quotes what failed, and why.
  assert.match(runs[1]!.stdin, /<<<\nI reviewed it carefully\.\n>>>/);
  assert.match(runs[1]!.stdin, /- no JSON value found in the reply/);
  assert.match(runs[2]!.stdin, /<<<\n\{"verdict":"maybe"\}\n>>>/);
  assert.match(runs[2]!.stdin, /- \$\.verdict: "maybe" is not one of \["pass","fail"\]/);
});

test("a JSON reply text, or a structured_output that is a JSON string, is unwrapped as well", async () => {
  for (const fields of [
    { result: '{"verdict": "pass"}' },
    { result: "", structured_output: '{"verdict": "pass"}' },
    { result: 'Sure:\n```json\n{"verdict": "pass"}\n```' },
  ]) {
    const { bridge } = recording(configFor("claude"), () => claudeStream(fields));
    const out = await bridge.run({ prompt: "p", schema: VERDICT });
    assert.deepEqual([out.value, out.attempts], [{ verdict: "pass" }, 1], JSON.stringify(fields));
  }
});

test("the retries run out on a CLI that keeps handing over an invalid value", async () => {
  const { runs, bridge } = recording(configFor("claude", { schemaRetries: 1 }), () => claudeStream({ structured_output: { verdict: 7 } }));
  await assert.rejects(
    () => bridge.run({ prompt: "p", schema: VERDICT }),
    (err: unknown) =>
      err instanceof SchemaValidationError &&
      err.message === `adapter 'claude' did not satisfy the schema after 2 attempt(s); last problems: $.verdict: 7 is not one of ["pass","fail"]`,
  );
  assert.equal(runs.length, 2);
});

test('"schemaKeywords": "native" leaves what ODW does not check to a CLI that does, checks the rest, and says so once', async () => {
  const schema = {
    type: "object",
    required: ["status"],
    properties: { status: { oneOf: [{ const: "open" }, { const: "closed" }] }, count: { type: ["integer", "null"] } },
  };
  const notes: string[] = [];
  const values = [{ status: "open", count: null }, { count: 2 }, { status: "closed", count: 1 }];
  const { runs, bridge } = recording(configFor("claude", { schemaKeywords: "native", schemaRetries: 1 }), (_run, n) =>
    claudeStream({ structured_output: values[n - 1] }),
  );
  const first = await bridge.run({ prompt: "p", schema }, { onNote: (message) => notes.push(message) });
  assert.deepEqual(first.value, { status: "open", count: null }, "the oneOf and the union are claude's to check");
  assert.equal(runs[0]!.command.at(-1), JSON.stringify(schema), "claude gets the whole schema");
  // ODW still checks the part it knows: a missing required property is retried.
  const second = await bridge.run({ prompt: "q", schema }, { onNote: (message) => notes.push(message) });
  assert.deepEqual([second.value, second.attempts], [{ status: "closed", count: 1 }, 2]);
  assert.match(runs[2]!.stdin, /\$\.status: required property is missing/);
  assert.deepEqual(notes, [
    `schema keywords ODW does not check are left to adapter 'claude', which validates the schema itself ("schemaKeywords": "native"): ` +
      `"oneOf" at #/properties/status; a type union ["integer","null"] at #/properties/count — ODW checks the rest`,
  ]);
});

// --- through the engine ----------------------------------------------------------------

test("through the engine: a refused schema is its agent's failure, and the run logs a native-keywords note once", async () => {
  const config = configFor("claude", { schemaKeywords: "native", staggerFanOut: null });
  config.adapters.mine = { name: "mine", command: ["mine"], stdin: "{prompt}" };
  const sink = new MemorySink();
  const spawned: string[][] = [];
  const runner: CommandRunner = async (command) => {
    spawned.push(command);
    return ok(claudeStream({ structured_output: { pick: "left" } }));
  };
  const ctx = buildContext(config, { sink, source: "/repo" });
  ctx.bridge = new Bridge(config, { source: "/repo", runner });
  const p = createPrimitives(ctx);
  const PICK = { type: "object", required: ["pick"], properties: { pick: { const: "left" } } };
  const results = await p.parallel([
    () => p.agent("TASK a", { label: "a", schema: PICK }),
    () => p.agent("TASK b", { label: "b", schema: PICK }),
    () => p.agent("TASK c", { label: "c", adapter: "mine", schema: PICK }),
  ]);
  assert.deepEqual(results, [{ pick: "left" }, { pick: "left" }, null], "a recoverable failure: the batch goes on");
  assert.equal(ctx.scheduler.fatalError, undefined);
  assert.equal(spawned.length, 2, "the refused agent never spawned");
  const failed = sink.ofType(AGENT_FAILED);
  assert.deepEqual(
    failed.map((e) => e.label),
    ["c"],
  );
  assert.match(
    String(failed[0]!.error),
    /^AgentError: agent\(\) schema uses JSON Schema that ODW's validator does not check: "const" at #\/properties\/pick — adapter 'mine' does not validate schemas itself/,
  );
  const notes = sink.ofType(LOG).filter((e) => /left to adapter 'claude'/.test(String(e.message)));
  assert.equal(notes.length, 1);
  assert.match(String(notes[0]!.message), /^[ab]:\d+: schema keywords ODW does not check are left to adapter 'claude'/);
});

const nativeAgent = fileURLToPath(new URL("./fixtures/native-schema-agent.mjs", import.meta.url));
const mockAgent = fileURLToPath(new URL("./fixtures/mock-agent.mjs", import.meta.url));

test("end to end: CLIs handed schemas inline and as a run-directory file, beside one that is not, through the worker", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-native-e2e-"));
  try {
    const configPath = join(root, "odw.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        schemaKeywords: "native",
        staggerFanOut: null,
        adapters: {
          inline: {
            command: [execPath, nativeAgent],
            stdin: "{prompt}",
            flags: { schema: { args: ["--json-schema"], mode: "inline" } },
            output: {
              format: "jsonl",
              eventType: "result",
              textPath: ["result"],
              select: "last",
              structuredPath: ["structured_output"],
              usagePath: ["usage"],
              costPath: ["total_cost_usd"],
            },
          },
          file: {
            command: [execPath, nativeAgent, "--report"],
            stdin: "{prompt}",
            flags: { schema: { args: ["--output-schema"], mode: "file" } },
          },
          plain: { command: [execPath, mockAgent], stdin: "{prompt}" },
        },
      }),
    );
    const script = join(root, "native.js");
    writeFileSync(
      script,
      `export const meta = { name: 'native', description: 'native schemas end to end' }
const VERDICT = { type: 'object', required: ['verdict'], properties: { verdict: { enum: ['pass', 'fail'] } } }
const PICK = { type: 'object', required: ['pick'], properties: { pick: { const: 'left' } } }
const inline = await agent('Judge it.', { adapter: 'inline', schema: VERDICT, label: 'inline' })
const file = await agent('Judge it.', { adapter: 'file', schema: VERDICT, label: 'file' })
const picked = await agent('Pick one.', { adapter: 'inline', schema: PICK, label: 'picked' })
const plain = await agent('Judge it.', { adapter: 'plain', schema: VERDICT, label: 'plain' })
const [refused] = await parallel([() => agent('Pick one.', { adapter: 'plain', schema: PICK, label: 'refused' })])
return { inline, file, picked, plain, refused }
`,
    );
    const store = new RunStore(join(root, "runs"));
    const id = store.create({ script, args: null, source: root, configPath });
    assert.equal(await executeRun(store.runDir(id)), "done", JSON.stringify(store.readError(id)));
    assert.deepEqual(store.readResult(id), {
      inline: { verdict: "pass" },
      file: { verdict: "pass" },
      picked: { pick: "left" },
      plain: { verdict: "pass" },
      refused: null,
    });
    // The file agent (2) read its schema from the run directory, which keeps none once it ran.
    const stderr = readFileSync(store.agentTranscriptPaths(id, 2).stderr, "utf8");
    assert.ok(stderr.includes(`schema file: ${store.agentSchemaPath(id, 2)}`), stderr);
    assert.deepEqual(
      readdirSync(join(store.runDir(id), "agents")).filter((name) => name.endsWith(".schema.json")),
      [],
    );
    const events = store.readEvents(id);
    const notes = events.filter((e) => e.type === "log" && /left to adapter 'inline'/.test(String(e.message)));
    assert.equal(notes.length, 1);
    assert.match(String(notes[0]!.message), /"const" at #\/properties\/pick/);
    const refused = events.find((e) => e.type === "agent_failed");
    assert.equal(refused?.label, "refused");
    assert.match(String(refused?.error), /^AgentError: .*adapter 'plain' does not validate schemas itself/);
    // The native agents' usage still came from their result events.
    const finished = events.filter((e) => e.type === "agent_finished" && e.adapter === "inline");
    assert.ok(finished.every((e) => (e.usage as { outputTokens?: number } | undefined)?.outputTokens === 5), JSON.stringify(finished));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- configuration -----------------------------------------------------------------------

function loadFrom(raw: unknown): Config {
  const dir = mkdtempSync(join(tmpdir(), "odw-cfg-"));
  try {
    const path = join(dir, "odw.config.json");
    writeFileSync(path, JSON.stringify(raw));
    return loadConfig(path, { quiet: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the built-ins declare native schemas: claude inline with its structured_output, codex as a strict file", () => {
  const { adapters } = defaultConfig();
  assert.deepEqual(adapters.claude!.flags, { model: ["--model"], schema: { args: ["--json-schema"], mode: "inline" } });
  assert.deepEqual(adapters.claude!.output && "structuredPath" in adapters.claude!.output && adapters.claude!.output.structuredPath, [
    "structured_output",
  ]);
  assert.deepEqual(adapters.codex!.flags, { model: ["--model"], schema: { args: ["--output-schema"], mode: "file", strict: true } });
  for (const name of ["gemini", "qwen", "kimi", "omp", "kilo", "opencode", "cursor"]) {
    assert.equal(adapters[name]!.flags?.schema, undefined, name);
  }
});

test("flags.schema loads, is off when left out, and a malformed one fails the load naming what is wrong", () => {
  const { adapters } = loadFrom({
    adapters: {
      mine: { command: ["mine"], flags: { schema: { args: ["--schema-file"], mode: "file" } } },
      claude: { flags: { model: ["--model"] } },
      codex: { flags: { model: ["--model"], schema: null } },
    },
  });
  assert.deepEqual(adapters.mine!.flags, { schema: { args: ["--schema-file"], mode: "file" } });
  assert.deepEqual(adapters.claude!.flags, { model: ["--model"] }, "a built-in's flags given without schema: none");
  assert.deepEqual(adapters.codex!.flags, { model: ["--model"] });
  for (const [schema, message] of [
    ["--json-schema", /'flags\.schema' must be an object/],
    [{ mode: "inline" }, /'flags\.schema\.args' must be a non-empty array of strings/],
    [{ args: [], mode: "inline" }, /'flags\.schema\.args' must be a non-empty array of strings/],
    [{ args: ["--s"], mode: "stdin" }, /'flags\.schema\.mode' must be "inline" .* or "file" .*; got "stdin"/],
    [{ args: ["--s"], mode: "file", strict: "yes" }, /'flags\.schema\.strict' must be true or false; got "yes"/],
  ] as const) {
    assert.throws(() => loadFrom({ adapters: { bad: { command: ["b"], flags: { schema } } } }), message, JSON.stringify(schema));
  }
  assert.deepEqual(
    collectConfigWarnings({
      adapters: { x: { command: ["x"], flags: { modle: ["--model"], schema: { args: ["--s"], mode: "inline", stric: true } } } },
    }),
    [
      'adapter "x" flags: unknown field "modle" is ignored — did you mean "model"?',
      'adapter "x" flags.schema: unknown field "stric" is ignored — did you mean "strict"?',
    ],
  );
});

test("schemaKeywords and schemaPrompt load, default to odw and auto, and refuse anything else", () => {
  const defaults = defaultConfig().settings;
  assert.deepEqual([defaults.schemaKeywords, defaults.schemaPrompt], ["odw", "auto"]);
  const { settings } = loadFrom({ schemaKeywords: "native", schemaPrompt: "always" });
  assert.deepEqual([settings.schemaKeywords, settings.schemaPrompt], ["native", "always"]);
  assert.throws(() => loadFrom({ schemaKeywords: "all" }), /"schemaKeywords" must be "odw" or "native"; got "all"/);
  assert.throws(() => loadFrom({ schemaPrompt: true }), /"schemaPrompt" must be "auto" or "always"; got true/);
  assert.deepEqual(collectConfigWarnings({ schemaKeywords: "native", schemaPrompt: "auto" }), []);
  assert.deepEqual(collectConfigWarnings({ schemaKeyword: "native" }), ['unknown key "schemaKeyword" is ignored — did you mean "schemaKeywords"?']);
});
