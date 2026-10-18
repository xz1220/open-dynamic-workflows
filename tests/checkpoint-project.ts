/**
 * Shared fixtures for the checkpoint() tests: a runs root whose mock adapter
 * answers at once, condition waits, and the CLI run in-process.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

import { main } from "../src/cli.js";
import { waitFor } from "../src/runtime/launcher.js";
import { RunStore, TERMINAL_STATES } from "../src/runtime/run-store.js";
import { detail } from "../src/runtime/runs-view.js";
import { executeRun } from "../src/runtime/worker.js";

export const META = "export const meta = { name: 'gate', description: 'd' }\n";

export async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition did not become true in time");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

export interface Project {
  root: string;
  runsRoot: string;
  store: RunStore;
  configPath: string;
  /** Write a workflow body (after META) and execute it in-process. */
  start(
    body: string,
    extra?: { resumedFrom?: { runId: string; dir: string }; breaks?: { at: string[]; step: boolean }; args?: unknown },
  ): { id: string; run: Promise<string> };
  /**
   * Stop every run still going — a failed assertion can leave one waiting at a
   * checkpoint, and a waiting run keeps the process alive — then remove the root.
   */
  cleanup(): Promise<void>;
}

const COUNTING_AGENT = fileURLToPath(new URL("./fixtures/counting-agent.mjs", import.meta.url));

/** A runs root whose 'mock' adapter answers at once and logs every real call; `extra` joins its config. */
export function project(extra: Record<string, unknown> = {}): Project {
  const root = mkdtempSync(join(tmpdir(), "odw-cp-"));
  const configPath = join(root, "odw.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      defaultAdapter: "mock",
      concurrency: 2,
      adapters: { mock: { command: [execPath, COUNTING_AGENT, join(root, "calls.log")], stdin: "{prompt}" } },
      ...extra,
    }),
  );
  const runsRoot = join(root, "runs");
  const store = new RunStore(runsRoot);
  const runs: Array<{ id: string; run: Promise<string> }> = [];
  let n = 0;
  return {
    root,
    runsRoot,
    store,
    configPath,
    start(body, more = {}) {
      const script = join(root, `wf-${++n}.js`);
      writeFileSync(script, META + body);
      const id = store.create({
        script,
        args: more.args ?? null,
        source: root,
        configPath,
        resumedFrom: more.resumedFrom ?? null,
        breaks: more.breaks ?? null,
      });
      const started = { id, run: executeRun(store.runDir(id)) };
      runs.push(started);
      return started;
    },
    async cleanup() {
      for (const r of runs) {
        if (!TERMINAL_STATES.has(String(store.readStatus(r.id).state))) store.writeControl(r.id, "stop");
      }
      await Promise.allSettled(runs.map((r) => r.run));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The same cleanup for a run in a detached worker process. */
export async function stopProcessRun(store: RunStore, runId: string): Promise<void> {
  if (TERMINAL_STATES.has(String(store.readStatus(runId).state))) return;
  store.writeControl(runId, "stop");
  await waitFor(store, runId, { timeoutMs: 15_000, pollIntervalMs: 50 });
}

/** The ids of the checkpoints a run waits at, as the dashboard and the CLI see them. */
export const pendingIds = (store: RunStore, id: string): number[] =>
  (detail(store, id).pendingCheckpoints ?? []).map((cp) => cp.checkpointId);

/** The TASK names the mock adapter really ran, in order. */
export const callsOf = (p: Project): string[] =>
  existsSync(join(p.root, "calls.log")) ? readFileSync(join(p.root, "calls.log"), "utf8").split("\n").filter(Boolean) : [];

/** Run the CLI with stdout/stderr captured (node:test's own buffer writes pass through). */
export async function cli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  (process.stdout as { write: unknown }).write = (s: unknown) => {
    if (Buffer.isBuffer(s)) return so(s);
    out.push(String(s));
    return true;
  };
  (process.stderr as { write: unknown }).write = (s: unknown) => {
    if (Buffer.isBuffer(s)) return se(s);
    err.push(String(s));
    return true;
  };
  try {
    const code = await main(argv);
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
  }
}
