import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectConfigWarnings, defaultConfig, listAdapters, loadConfig } from "../src/adapters/config.js";
import {
  commandAt,
  declaredTiers,
  minTier,
  permissionsBanner,
  planPermissions,
  readCapableAdapter,
  spliceArgs,
} from "../src/adapters/permissions.js";
import type { CommandRunner } from "../src/adapters/runner.js";
import type { Adapter, CliResult, PermissionTier } from "../src/adapters/types.js";
import { Bridge } from "../src/bridge.js";
import { AgentError, ConfigError } from "../src/errors.js";

// Permission tiers (ODW extension): every built-in's posture flags moved out
// of its command into permissionArgs, spliced at {permission_args}. The
// default tier must keep each built-in's argv byte for byte what it was.

/** Codex's exec options since it reports through `--json` (and its final message through a reply file). */
const CODEX_EXEC = ["--json", "--output-last-message", "{reply_file}"];

/** Every built-in's argv template as it was before tiers existed (codex's exec options since added). */
const BEFORE_TIERS: Record<string, string[]> = {
  codex: ["codex", "--search", "exec", ...CODEX_EXEC, "--skip-git-repo-check", "--sandbox", "workspace-write", "--cd", "{workspace}", "-"],
  claude: [
    "claude",
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    "WebSearch",
    "WebFetch",
    "--no-session-persistence",
  ],
  gemini: ["gemini", "--approval-mode", "auto_edit", "--prompt", "{prompt}"],
  qwen: ["qwen", "--approval-mode", "auto-edit", "--output-format", "text", "{prompt}"],
  kimi: ["kimi", "--work-dir", "{workspace}", "--print", "--input-format", "text", "--output-format", "text"],
  omp: ["omp", "--print", "--no-session", "--approval-mode", "yolo", "--cwd", "{workspace}"],
  kilo: ["kilo", "run", "--format", "json", "--auto", "--dir", "{workspace}"],
  opencode: ["opencode", "run", "--format", "json", "--auto", "--dir", "{workspace}"],
  cursor: ["agent", "--print", "--force", "--trust", "--output-format", "text", "--workspace", "{workspace}"],
};

/** The read and full argv templates of the built-ins that declare those tiers. */
const TIER_ARGV: Record<string, Partial<Record<PermissionTier, string[]>>> = {
  claude: {
    read: [
      "claude",
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "dontAsk",
      "--tools",
      "Read,Glob,Grep,WebSearch,WebFetch",
      "--allowedTools",
      "WebSearch",
      "WebFetch",
      "--strict-mcp-config",
      "--no-session-persistence",
    ],
    full: [
      "claude",
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
      "--no-session-persistence",
    ],
  },
  codex: {
    read: ["codex", "--search", "exec", ...CODEX_EXEC, "--skip-git-repo-check", "--sandbox", "read-only", "--cd", "{workspace}", "-"],
    full: ["codex", "--search", "exec", ...CODEX_EXEC, "--skip-git-repo-check", "--sandbox", "danger-full-access", "--cd", "{workspace}", "-"],
  },
  gemini: {
    read: ["gemini", "--approval-mode", "default", "--prompt", "{prompt}"],
    full: ["gemini", "--approval-mode", "yolo", "--prompt", "{prompt}"],
  },
  qwen: { full: ["qwen", "--approval-mode", "yolo", "--output-format", "text", "{prompt}"] },
};

const ok = (stdout: string): CliResult => ({ returncode: 0, stdout, stderr: "", timedOut: false, duration: 0.01 });

/** A bridge over the built-ins at `tier`, recording the argv each call would spawn. */
function recordingBridge(tier: PermissionTier): { bridge: Bridge; spawned: string[][] } {
  const config = defaultConfig();
  config.settings.permissions = tier;
  const spawned: string[][] = [];
  const runner: CommandRunner = async (command) => {
    spawned.push(command);
    return ok("done");
  };
  return { bridge: new Bridge(config, { source: "/repo", runner }), spawned };
}

/** `template` as the bridge expands it for a call in /repo whose task says TASK. */
function assertArgv(actual: string[] | undefined, template: string[], what: string): void {
  assert.ok(actual, `${what}: nothing was spawned`);
  assert.equal(actual.length, template.length, `${what}: ${JSON.stringify(actual)}`);
  template.forEach((part, i) => {
    if (part === "{prompt}") assert.match(actual[i]!, /TASK/, what);
    else if (part === "{reply_file}") assert.match(actual[i]!, /odw-reply-[^/\\]+[/\\]reply\.txt$/, what);
    else assert.equal(actual[i], part === "{workspace}" ? "/repo" : part, `${what}: element ${i}`);
  });
}

// --- the argv each built-in runs, per tier ------------------------------------

test("the default tier (edit) keeps every built-in's argv exactly as before tiers", async () => {
  const config = defaultConfig();
  assert.equal(config.settings.permissions, "edit");
  assert.deepEqual(Object.keys(BEFORE_TIERS).sort(), Object.keys(config.adapters).sort(), "every built-in is pinned");
  for (const [name, before] of Object.entries(BEFORE_TIERS)) {
    assert.deepEqual(commandAt(config.adapters[name]!, "edit"), before, name);
    // …and it is what a default run spawns.
    const { bridge, spawned } = recordingBridge("edit");
    await bridge.run({ prompt: "TASK", adapter: name });
    assertArgv(spawned[0], before, `${name} at edit`);
  }
});

test("read and full spawn each built-in's verified flags; a model flag still lands last", async () => {
  for (const tier of ["read", "full"] as const) {
    for (const [name, argv] of Object.entries(TIER_ARGV)) {
      const template = argv[tier];
      if (!template) continue;
      assert.deepEqual(commandAt(defaultConfig().adapters[name]!, tier), template, `${name} template at ${tier}`);
      const { bridge, spawned } = recordingBridge(tier);
      await bridge.run({ prompt: "TASK", adapter: name, model: "m-1" });
      assertArgv(spawned[0], [...template, "--model", "m-1"], `${name} at ${tier}`);
    }
  }
});

test("each built-in declares only the tiers its CLI's docs confirm", () => {
  const { adapters } = defaultConfig();
  const tiers = Object.fromEntries(Object.keys(BEFORE_TIERS).map((name) => [name, declaredTiers(adapters[name]!)]));
  assert.deepEqual(tiers, {
    codex: ["read", "edit", "full"],
    claude: ["read", "edit", "full"],
    gemini: ["read", "edit", "full"],
    qwen: ["edit", "full"],
    kimi: ["edit"],
    omp: ["edit"],
    kilo: ["edit"],
    opencode: ["edit"],
    cursor: ["edit"],
  });
  // claude's read tier leaves no tool that edits or runs code, and keeps the web.
  const read = adapters.claude!.permissionArgs!.read!;
  const tools = read[read.indexOf("--tools") + 1]!.split(",");
  for (const writer of ["Edit", "Write", "Bash", "NotebookEdit", "PowerShell", "Agent", "Skill", "Monitor"]) {
    assert.equal(tools.includes(writer), false, `${writer} must not be available read-only`);
  }
  assert.ok(tools.includes("WebSearch") && tools.includes("WebFetch"));
  assert.equal(read[read.indexOf("--permission-mode") + 1], "dontAsk");
});

test("a CLI with no read mode is refused before anything spawns; full runs its edit flags", async () => {
  for (const name of ["qwen", "kimi", "omp", "kilo", "opencode", "cursor"]) {
    const { bridge, spawned } = recordingBridge("read");
    await assert.rejects(
      () => bridge.run({ prompt: "TASK", adapter: name }),
      (err: unknown) => {
        assert.ok(err instanceof AgentError, String(err));
        assert.match(err.message, new RegExp(`^${name} cannot run read-only \\(adapter '${name}' declares no "read" permissionArgs\\)`));
        // It names an adapter that can, and how to lift the run's read.
        assert.match(err.message, /use an adapter that can \(--adapter \w+, or agent\(prompt, \{ adapter: "\w+" \}\)\), or run with --permissions edit$/);
        return true;
      },
    );
    assert.equal(spawned.length, 0, `${name}: nothing spawned`);
  }
  for (const name of ["kimi", "omp", "kilo", "opencode", "cursor"]) {
    const { bridge, spawned } = recordingBridge("full");
    await bridge.run({ prompt: "TASK", adapter: name });
    assertArgv(spawned[0], BEFORE_TIERS[name]!, `${name} at full runs its edit flags`);
  }
});

// --- min(run, adapter, call) and the escalation error -------------------------

const probe = (fields: Partial<Adapter> = {}): Adapter => ({
  name: "probe",
  command: ["probe", "{permission_args}"],
  permissionArgs: { read: ["-r"], edit: ["-e"], full: ["-f"] },
  ...fields,
});

test("an agent's tier is the lowest of the run's, its adapter's and its call's", () => {
  const tiers: PermissionTier[] = ["read", "edit", "full"];
  for (const run of tiers) {
    for (const cap of [undefined, ...tiers]) {
      const adapter = probe(cap ? { permissions: cap } : {});
      const ceiling = cap ? minTier(run, cap) : run;
      assert.deepEqual(planPermissions(adapter, run), {
        requested: ceiling,
        tier: ceiling,
        args: adapter.permissionArgs![ceiling],
      });
      for (const call of tiers) {
        const plan = planPermissions(adapter, run, call);
        if (tiers.indexOf(call) <= tiers.indexOf(ceiling)) {
          assert.deepEqual([plan.tier, plan.args, plan.error], [call, adapter.permissionArgs![call], undefined], `${run}/${cap}/${call}`);
        } else {
          assert.equal(plan.tier, undefined, `${run}/${cap}/${call} may not run`);
          assert.equal(plan.requested, call);
          assert.match(plan.error!, new RegExp(`^agent\\(\\) asked for permissions "${call}", but `));
          assert.match(plan.error!, /an agent may only lower its run's tier: read < edit < full/);
        }
      }
    }
  }
});

test("asking for more than the run allows names both tiers, and what caps it", () => {
  assert.equal(
    planPermissions(probe(), "edit", "full").error,
    'agent() asked for permissions "full", but the run allows only "edit" (an agent may only lower its run\'s tier: ' +
      'read < edit < full) — ask for "edit" or less, or start the run with --permissions full',
  );
  assert.equal(
    planPermissions(probe({ permissions: "read" }), "full", "edit").error,
    'agent() asked for permissions "edit", but adapter \'probe\' is capped at "read" by its "permissions" setting ' +
      '(an agent may only lower its run\'s tier: read < edit < full) — ask for "read" or less, or raise that setting',
  );
  const both = planPermissions(probe({ permissions: "read" }), "edit", "full").error!;
  assert.match(both, /but the run allows only "edit" and adapter 'probe' is capped at "read"/);
  assert.match(both, /ask for "read" or less, or start the run with --permissions full and raise that setting$/);
  assert.equal(
    planPermissions(probe(), "full", "write").error,
    'agent() option permissions must be "read", "edit" or "full"; got "write"',
  );
  assert.equal(planPermissions(probe(), "full", "write").requested, undefined);
});

test("a refusal says how to lift every read that applies", () => {
  const editOnly = probe({ name: "solo", permissionArgs: { edit: ["-e"] } });
  const reasons = (run: PermissionTier, cap?: PermissionTier, call?: PermissionTier, alt?: string) =>
    planPermissions(cap ? { ...editOnly, permissions: cap } : editOnly, run, call, alt).error!.split("); ")[1];
  assert.equal(reasons("read", undefined, undefined, "claude"), 'use an adapter that can (--adapter claude, or agent(prompt, { adapter: "claude" })), or run with --permissions edit');
  assert.equal(reasons("full", "read"), `set "permissions": "edit" on adapter 'solo'`);
  assert.equal(reasons("edit", undefined, "read"), 'drop permissions: "read" from the agent() call');
  assert.equal(
    reasons("read", "read", "read"),
    `drop permissions: "read" from the agent() call and set "permissions": "edit" on adapter 'solo' and run with --permissions edit`,
  );
});

test("a full request on an edit-only CLI runs its edit flags with a note; an undeclared CLI runs as configured", () => {
  assert.deepEqual(planPermissions(probe({ name: "solo", permissionArgs: { edit: ["--auto"] } }), "full"), {
    requested: "full",
    tier: "edit",
    args: ["--auto"],
    note: `adapter 'solo' has no "full" mode: its agents run with its "edit" flags (--auto)`,
  });
  const mine: Adapter = { name: "mine", command: ["mine", "--yolo"] };
  assert.deepEqual(planPermissions(mine, "edit"), { requested: "edit", tier: "edit", args: [] });
  for (const run of ["read", "full"] as const) {
    assert.deepEqual(planPermissions(mine, run), {
      requested: run,
      tier: "edit",
      args: [],
      note:
        `adapter 'mine' declares no permissionArgs, so ODW cannot make it run "${run}": ` +
        `its agents run with its command as configured (treated as "edit")`,
    });
  }
});

test("the refusal's advice prefers an installed read-capable adapter", () => {
  const config = defaultConfig();
  assert.equal(readCapableAdapter(config, "kimi", () => false), "claude", "none installed: the first by name");
  assert.equal(readCapableAdapter(config, "kimi", (a) => a.name === "gemini"), "gemini");
  assert.equal(readCapableAdapter(config, "claude", () => false), "codex", "never the adapter itself");
  config.adapters = { kimi: config.adapters.kimi! };
  assert.equal(readCapableAdapter(config, "kimi", () => true), null);
  const { bridge } = recordingBridge("read");
  assert.match(bridge.permissionsFor(defaultConfig().adapters.kimi!).error!, /--adapter (claude|codex|gemini)/);
});

test("spliceArgs puts a tier's flags where the token is, and leaves other commands alone", () => {
  assert.deepEqual(spliceArgs(["a", "{permission_args}", "b"], ["-x", "1"]), ["a", "-x", "1", "b"]);
  assert.deepEqual(spliceArgs(["a", "{permission_args}"], []), ["a"]);
  assert.deepEqual(spliceArgs(["a", "b"], ["-x"]), ["a", "b"]);
});

// --- configuration --------------------------------------------------------------

function withConfig<T>(raw: Record<string, unknown>, fn: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "odw-perm-cfg-"));
  try {
    const path = join(dir, "odw.config.json");
    writeFileSync(path, JSON.stringify(raw));
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the run's permissions setting loads and validates", () => {
  assert.equal(defaultConfig().settings.permissions, "edit");
  withConfig({ permissions: "read" }, (path) => assert.equal(loadConfig(path, { quiet: true }).settings.permissions, "read"));
  withConfig({ permissions: null }, (path) => assert.equal(loadConfig(path, { quiet: true }).settings.permissions, "edit"));
  for (const [raw, message] of [
    [{ permissions: "write" }, /"permissions" must be "read", "edit" or "full"; got "write"/],
    [{ permissions: 2 }, /"permissions" must be/],
  ] as const) {
    withConfig(raw, (path) => assert.throws(() => loadConfig(path, { quiet: true }), (err) => err instanceof ConfigError && message.test(err.message)));
  }
});

test("an adapter's permissionArgs and permissions are validated where they would otherwise be lost", () => {
  const mock = (fields: Record<string, unknown>) => ({ adapters: { mock: { command: ["mock", "{permission_args}"], ...fields } } });
  for (const [raw, message] of [
    [mock({}), /adapter 'mock' has \{permission_args\} in its command but no "permissionArgs" to put there/],
    [mock({ permissionArgs: { read: ["-r"] } }), /'permissionArgs' must set "edit": the flags it runs with by default \(\[\] for none\)/],
    [mock({ permissionArgs: { edit: [], write: [] } }), /'permissionArgs' may set "read", "edit", "full"; got "write"/],
    [mock({ permissionArgs: { edit: "--auto" } }), /'permissionArgs.edit' must be an array of strings/],
    [mock({ permissionArgs: ["--auto"] }), /'permissionArgs' must be an object of flag lists/],
    [mock({ permissionArgs: { edit: ["{permission_args}"] } }), /'permissionArgs.edit' cannot hold \{permission_args\} itself/],
    [mock({ permissionArgs: { edit: [] }, permissions: "admin" }), /adapter 'mock' 'permissions' must be "read", "edit" or "full"; got "admin"/],
    [{ adapters: { mock: { command: ["mock"], permissionArgs: { edit: [] } } } }, /declares "permissionArgs" but its command has no \{permission_args\} element/],
    [{ adapters: { mock: { command: ["mock", "--x={permission_args}"], permissionArgs: { edit: [] } } } }, /may hold \{permission_args\} once, as an element of its own/],
    [{ adapters: { mock: { command: ["mock", "{permission_args}", "{permission_args}"], permissionArgs: { edit: [] } } } }, /once/],
    [{ adapters: { mock: { command: ["{permission_args}", "mock"], permissionArgs: { edit: [] } } } }, /after the executable/],
    [{ adapters: { mock: { command: ["mock", "{permission_args}"], stdin: "{permission_args}", permissionArgs: { edit: [] } } } }, /'stdin' cannot hold/],
  ] as const) {
    withConfig(raw, (path) => assert.throws(() => loadConfig(path, { quiet: true }), (err) => err instanceof ConfigError && message.test(err.message)));
  }
  // Comment keys are allowed, and a null tier is one left undeclared.
  withConfig(mock({ permissionArgs: { "//": "x", edit: ["-e"], full: null }, permissions: "read" }), (path) => {
    const mockAdapter = loadConfig(path, { quiet: true }).adapters.mock!;
    assert.deepEqual(mockAdapter.permissionArgs, { edit: ["-e"] });
    assert.equal(mockAdapter.permissions, "read");
  });
});

test("an entry without a command changes only what it sets on the built-in of its name", () => {
  withConfig({ adapters: { codex: { permissions: "read" }, claude: { label: "Claude", command: null, timeout: 60 } } }, (path) => {
    const { adapters } = loadConfig(path, { quiet: true });
    const builtin = defaultConfig().adapters;
    assert.deepEqual(adapters.codex, { ...builtin.codex, permissions: "read" });
    assert.deepEqual(adapters.claude, { ...builtin.claude, label: "Claude", timeout: 60 });
  });
  // One with a command still replaces the built-in whole; a new name needs one.
  withConfig({ adapters: { codex: { command: ["codex", "exec", "-"] } } }, (path) => {
    assert.deepEqual(loadConfig(path, { quiet: true }).adapters.codex, { name: "codex", command: ["codex", "exec", "-"] });
  });
  withConfig({ adapters: { mine: { permissions: "read" } } }, (path) => {
    assert.throws(() => loadConfig(path, { quiet: true }), /adapter 'mine' must have a non-empty 'command' array/);
  });
});

test("config warnings: the tier keys are known, and a cap ODW cannot enforce is flagged", () => {
  assert.deepEqual(collectConfigWarnings({ permissions: "read", adapters: { codex: { permissions: "read" } } }), []);
  assert.deepEqual(collectConfigWarnings({ adapters: { mine: { command: ["mine"], permissions: "read" } } }), [
    `adapter "mine" sets "permissions" but declares no "permissionArgs", so ODW cannot enforce it: its agents run with its command as configured`,
  ]);
  assert.match(collectConfigWarnings({ permision: "read" })[0]!, /did you mean "permissions"/);
  assert.match(collectConfigWarnings({ adapters: { mine: { command: ["m"], permissionArg: {} } } })[0]!, /did you mean "permissionArgs"/);
});

// --- what the listings show ------------------------------------------------------

test("listAdapters shows each adapter's tiers and its posture at the configured tier", () => {
  const config = defaultConfig();
  const row = (name: string) => listAdapters(config).find((a) => a.name === name)!;
  assert.deepEqual(row("claude").tiers, ["read", "edit", "full"]);
  assert.equal(row("claude").permissionNote, "permission mode: acceptEdits", "the default note is unchanged");
  assert.equal(row("codex").permissionNote, "sandbox: workspace-write");
  assert.equal(row("cursor").permissionNote, "full autonomy (explicit denies remain)");
  config.settings.permissions = "read";
  assert.equal(row("claude").permissionNote, "permission mode: dontAsk");
  assert.equal(row("gemini").permissionNote, "approval mode: default");
  assert.equal(row("kimi").permissionNote, 'refused at permissions "read" (no read mode)');
  config.adapters.mine = { name: "mine", command: ["mine"] };
  assert.deepEqual(row("mine").tiers, []);
});

test("the start banner gives the run's tier and what each installed adapter runs", () => {
  const config = defaultConfig();
  config.adapters.mine = { name: "mine", command: ["mine"] };
  const installed = new Set(["claude", "codex", "kimi", "qwen", "mine"]);
  const banner = (tier: PermissionTier) => {
    config.settings.permissions = tier;
    return permissionsBanner(config, (a) => installed.has(a.name));
  };
  assert.equal(banner("edit"), "permissions: edit — claude edit, codex edit, kimi edit, mine edit, qwen edit");
  assert.equal(
    banner("read"),
    "permissions: read — claude read, codex read, kimi refused (no read mode), mine as configured (no tiers declared), qwen refused (no read mode)",
  );
  assert.equal(
    banner("full"),
    "permissions: full — claude full, codex full, kimi edit (no full mode), mine as configured (no tiers declared), qwen full",
  );
  config.adapters.codex = { ...config.adapters.codex!, permissions: "read" };
  assert.match(banner("edit"), /codex read \(adapter setting\)/);
  assert.equal(permissionsBanner(config, () => false), "permissions: edit");
});
