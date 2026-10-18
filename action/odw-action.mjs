#!/usr/bin/env node
/**
 * The steps of the composite GitHub Action in ./action.yml (an ODW
 * extension), as one zero-dependency Node script the runner's own `node`
 * runs. Each step is a subcommand; the decisions are pure exported functions
 * the test suite checks (tests/action.test.ts), since the Action itself
 * cannot run there.
 *
 *   install   install the pinned odw release binary with scripts/install.sh
 *             (SHA-256 checked against the release's SHA256SUMS; binary only,
 *             ODW_SKILL=0) and put it on $GITHUB_PATH
 *   run       odw run <workflow> --wait --deadline <s>, the deadline a margin
 *             before the job's timeout, so the run is STOPPED (diffs and
 *             finished agents kept) while the job still has time for the
 *             summary and the bundle; outputs run-id, state, exit-code
 *   summary   the run's spend receipt, agent table and failures, appended to
 *             $GITHUB_STEP_SUMMARY
 *
 * Inputs arrive as ODW_INPUT_<NAME> variables (action.yml maps them): a
 * composite action's run steps get no INPUT_* of their own.
 */

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// --- decisions (pure) ------------------------------------------------------------

/**
 * The odw release to install: the `version` input, else this action's own
 * package version — so `uses: …/action@v0.7.0` installs odw 0.7.0.
 */
export function resolveVersion(input, packageJsonText) {
  const given = String(input ?? "").trim();
  const version = given || String(JSON.parse(packageJsonText).version ?? "");
  const bare = version.replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(bare)) {
    throw new Error(`version must be a release such as 0.7.0; got '${version}'`);
  }
  return bare;
}

/** Events whose text anyone can write: their runs are untrusted under `untrusted: auto`. */
const UNTRUSTED_EVENTS = new Set([
  "issues", "issue_comment", "discussion", "discussion_comment", "pull_request_review", "pull_request_review_comment",
]);

/**
 * Whether the run goes `--untrusted`: `true`/`false` as given; `auto` (the
 * default) for a pull request from a fork, and for events carrying text
 * anyone can write (issues, comments, reviews, discussions).
 */
export function untrustedFor(input, eventName, event) {
  const value = String(input ?? "auto").trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value !== "auto") throw new Error(`untrusted must be auto, true or false; got '${input}'`);
  if (UNTRUSTED_EVENTS.has(eventName)) return true;
  if (eventName === "pull_request" || eventName === "pull_request_target") {
    const pr = event && typeof event === "object" ? event.pull_request : null;
    const head = pr?.head?.repo?.full_name;
    const base = pr?.base?.repo?.full_name;
    return !head || !base || head !== base || pr?.head?.repo?.fork === true;
  }
  return false;
}

/**
 * Seconds the run gets: the job's timeout less the margin kept for the
 * summary and the bundle, less what the action spent before the run. Throws
 * when nothing is left.
 */
export function deadlineSeconds({ timeoutMinutes, marginSeconds, elapsedSeconds = 0 }) {
  const timeout = Number(timeoutMinutes);
  const margin = Number(marginSeconds);
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error(`timeout-minutes must be a positive number; got '${timeoutMinutes}'`);
  if (!Number.isFinite(margin) || margin < 0) throw new Error(`margin-seconds must be a non-negative number; got '${marginSeconds}'`);
  const left = Math.floor(timeout * 60 - margin - Math.max(0, Number(elapsedSeconds) || 0));
  if (left < 1) {
    throw new Error(`timeout-minutes ${timeout} leaves no time for the run after margin-seconds ${margin}; raise the job's timeout-minutes (and this input with it)`);
  }
  return left;
}

/** The `odw run` argv the run step executes. */
export function runArgv({ workflow, args, config, adapter, permissions }, deadline, untrusted) {
  if (!String(workflow ?? "").trim()) throw new Error("the workflow input is required");
  const argv = ["run", String(workflow), "--wait", "--deadline", String(deadline)];
  if (untrusted) argv.push("--untrusted");
  if (String(args ?? "").trim()) argv.push("--args", String(args));
  if (String(config ?? "").trim()) argv.push("--config", String(config));
  if (String(adapter ?? "").trim()) argv.push("--adapter", String(adapter));
  if (String(permissions ?? "").trim()) argv.push("--permissions", String(permissions));
  return argv;
}

/** The run id `odw run --wait` names on stderr ("running <id> ..."), or null. */
export function runIdFrom(stderr) {
  const match = /^running (\S+) \.\.\.$/m.exec(String(stderr));
  return match && /^[A-Za-z0-9._-]+$/.test(match[1]) ? match[1] : null;
}

/** What the run's exit code says, in a word. */
export function stateFor(exitCode) {
  switch (exitCode) {
    case 0: return "done";
    case 3: return "stopped-at-deadline";
    case 124: return "timed-out";
    default: return "failed";
  }
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** Text for one table cell: no pipes, line breaks, HTML or backticks to break out with; bounded. */
export function cell(value, max = 120) {
  const text = String(value ?? "").replace(ANSI, "").replace(/[\r\n\t]+/g, " ").trim();
  const cut = text.length > max ? `${text.slice(0, max - 1)}…` : text;
  return cut.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\|/g, "\\|").replace(/`/g, "'") || " ";
}

/** `text` in a fenced block whose fence no run of backticks inside can close. */
function fenced(text) {
  const longest = Math.max(2, ...[...String(text).matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}

function seconds(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/**
 * The job summary, as Markdown: the outcome; the spend receipt (`odw
 * status`'s usage and spend-by-phase lines); the agent table (`odw agents
 * --json`); and the failures — each failed agent's error, and the run's own.
 * Everything the run printed is treated as untrusted text.
 */
export function renderSummary({ runId, workflow, exitCode, statusText = "", agents = [], runError = "" }) {
  const state = stateFor(exitCode);
  const icon = { done: "✅", "stopped-at-deadline": "⏱️", "timed-out": "⏳", failed: "❌" }[state];
  const lines = [`## ${icon} odw · ${cell(workflow, 80)} · ${state}`, ""];
  lines.push(`Run \`${cell(runId ?? "(none)", 60)}\` exited ${Number(exitCode)}.`);
  if (state === "stopped-at-deadline") {
    lines.push("", "The run reached its `--deadline` before the job's timeout and was stopped: its finished agents and their diffs are kept in the bundle.");
  }
  const status = String(statusText).replace(ANSI, "");
  const receipt = status.split("\n").filter((line) => /^\s{2}(usage|spend|dispatched|CLIs)\b|^\s{4}\S/.test(line));
  if (receipt.length > 0) lines.push("", "### Spend", "", fenced(receipt.join("\n")));
  const rows = Array.isArray(agents) ? agents : [];
  if (rows.length > 0) {
    lines.push("", "### Agents", "", "| # | state | label | phase | adapter | time | value / error |", "| --- | --- | --- | --- | --- | --- | --- |");
    for (const a of rows.slice(0, 200)) {
      lines.push(
        `| ${cell(a.agentId)} | ${cell(a.state)} | ${cell(a.label, 60)} | ${cell(a.phase, 40)} | ${cell(a.adapter, 30)} | ${cell(seconds(a.durationMs))} | ${cell(a.state === "failed" ? a.error : a.preview)} |`,
      );
    }
    if (rows.length > 200) lines.push("", `… and ${rows.length - 200} more: \`odw agents ${cell(runId, 60)}\` in the bundle.`);
  }
  const failed = rows.filter((a) => a.state === "failed");
  const runFailure = String(runError ?? "").replace(ANSI, "").trim();
  if (failed.length > 0 || runFailure) {
    lines.push("", "### Failures", "");
    for (const a of failed.slice(0, 50)) lines.push(`- **${cell(a.label, 60)}** (agent ${cell(a.agentId)}): ${cell(a.error, 400)}`);
    if (runFailure) lines.push(`- **run**: ${cell(runFailure, 600)}`);
  }
  lines.push("", `Open it locally: download the \`odw-${cell(runId ?? "run", 60)}\` artifact, then \`odw view <file>.odwrun\`.`, "");
  return lines.join("\n");
}

// --- the steps ---------------------------------------------------------------------

function input(name, fallback = "") {
  const value = process.env[`ODW_INPUT_${name.toUpperCase().replace(/-/g, "_")}`];
  return value === undefined || value === "" ? fallback : value;
}

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (file) appendFileSync(file, `${name}=${String(value).replace(/[\r\n]/g, " ")}\n`);
}

function workDir() {
  const dir = join(process.env.RUNNER_TEMP || process.cwd(), "odw-action");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function stepInstall() {
  writeFileSync(join(workDir(), "started-at"), String(Date.now()));
  const version = resolveVersion(input("version"), readFileSync(join(here, "..", "package.json"), "utf8"));
  const binDir = join(workDir(), "bin");
  const result = spawnSync("sh", [join(here, "..", "scripts", "install.sh")], {
    stdio: "inherit",
    env: { ...process.env, ODW_VERSION: version, ODW_BIN_DIR: binDir, ODW_SKILL: "0", ODW_ALLOW_UNVERIFIED: "" },
  });
  if (result.status !== 0) return result.status ?? 1;
  if (process.env.GITHUB_PATH) appendFileSync(process.env.GITHUB_PATH, `${binDir}\n`);
  setOutput("odw-version", version);
  return 0;
}

async function stepRun() {
  const startedAt = Number(readFileSafe(join(workDir(), "started-at"))) || Date.now();
  const deadline = deadlineSeconds({
    timeoutMinutes: input("timeout-minutes", "360"),
    marginSeconds: input("margin-seconds", "300"),
    elapsedSeconds: (Date.now() - startedAt) / 1000,
  });
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSafe(process.env.GITHUB_EVENT_PATH) || "{}") : {};
  const untrusted = untrustedFor(input("untrusted", "auto"), process.env.GITHUB_EVENT_NAME ?? "", event);
  const argv = runArgv(
    { workflow: input("workflow"), args: input("args"), config: input("config"), adapter: input("adapter"), permissions: input("permissions") },
    deadline,
    untrusted,
  );
  process.stderr.write(`odw ${argv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}\n`);
  const child = spawn("odw", argv, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => {
    out += chunk;
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    err += chunk;
    process.stderr.write(chunk);
  });
  const code = await new Promise((resolve) => {
    child.on("error", (e) => {
      err += `${e.message}\n`;
      resolve(127);
    });
    child.on("close", (c) => resolve(c ?? 1));
  });
  const runId = runIdFrom(err);
  writeFileSync(join(workDir(), "result.json"), out);
  writeFileSync(join(workDir(), "run-error.txt"), err.split("\n").filter((l) => /^run (failed|was stopped)|^timed out/.test(l)).join("\n"));
  setOutput("run-id", runId ?? "");
  setOutput("exit-code", code);
  setOutput("state", stateFor(code));
  setOutput("untrusted", untrusted);
  return code;
}

function stepSummary() {
  const runId = input("run-id");
  const exitCode = Number(input("exit-code", "1"));
  const odw = (args) => spawnSync("odw", args, { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  let agents = [];
  let statusText = "";
  if (runId) {
    statusText = odw(["status", runId]).stdout ?? "";
    try {
      agents = JSON.parse(odw(["agents", runId, "--json"]).stdout || "[]");
    } catch {
      agents = [];
    }
  }
  const markdown = renderSummary({
    runId,
    workflow: input("workflow"),
    exitCode,
    statusText,
    agents,
    runError: readFileSafe(join(workDir(), "run-error.txt")),
  });
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  else process.stdout.write(markdown);
  return 0;
}

function readFileSafe(path) {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}

async function main(step) {
  try {
    switch (step) {
      case "install": return stepInstall();
      case "run": return await stepRun();
      case "summary": return stepSummary();
      default:
        process.stderr.write("usage: odw-action.mjs install|run|summary\n");
        return 2;
    }
  } catch (err) {
    process.stderr.write(`::error::odw action: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]).then((code) => process.exit(code));
}
