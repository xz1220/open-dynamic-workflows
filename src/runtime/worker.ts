/**
 * Workflow worker (L5): load one script and run it to completion.
 *
 * The back end. It runs in its own Node process (started by the launcher), so
 * the workflow holds its entire plan in local variables while only the final
 * return value is written back to the run directory. Exactly one run executes
 * per worker process.
 *
 * `executeRun` is also callable in-process (that is how tests exercise the full
 * stack without spawning a subprocess).
 */

import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig } from "../adapters/config.js";
import { buildContext, type RunContext } from "../context.js";
import { RunStopped } from "../errors.js";
import { LOG, RUN_FAILED, RUN_FINISHED, RUN_STARTED, RUN_STOPPED, event } from "../events.js";
import { loadWorkflowScript } from "../loader.js";
import { createPrimitives } from "../primitives.js";
import { FileControl } from "./file-control.js";
import { JsonlSink, RunStore } from "./run-store.js";

/** Run the workflow described by `runDir`; return its terminal state. */
export async function executeRun(runDir: string): Promise<string> {
  const store = new RunStore(dirname(runDir));
  const runId = basename(runDir);

  const meta = store.readMeta(runId);
  const script = meta.script as string | undefined;
  if (!script) throw new Error(`no run metadata found at ${runDir}`);

  const sink = new JsonlSink(store.eventsPath(runId));
  const args = meta.args;
  // ctx is created inside the try so that a config or context-build failure is
  // still recorded as a failed run rather than leaving it stuck in "pending".
  let ctx: RunContext | undefined;
  const dispatched = () => ctx?.scheduler.dispatched ?? 0;

  try {
    const baseConfig = loadConfig((meta.configPath as string | null) ?? null);
    // Run-level adapter override (meta.adapter): becomes this run's default for
    // every `agent()` call that does not name one explicitly. Priority chain:
    // agent(p, { adapter }) > meta.adapter > config defaultAdapter > auto-pick.
    const adapterOverride =
      typeof meta.adapter === "string" && meta.adapter.length > 0 ? meta.adapter : null;
    const config = adapterOverride
      ? { ...baseConfig, settings: { ...baseConfig.settings, defaultAdapter: adapterOverride } }
      : baseConfig;
    const control = new FileControl({
      readAction: () => store.readControl(runId),
      onState: (state) => store.updateStatus(runId, { state, dispatched: dispatched() }),
    });
    ctx = buildContext(config, {
      source: meta.source as string | undefined,
      args,
      sink,
      control,
      budgetTotal: (meta.budgetTotal as number | null) ?? null,
    });

    store.updateStatus(runId, { state: "running", pid: process.pid });
    sink.emit(event(RUN_STARTED, { runId }));

    const source = readFileSync(script, "utf8");
    const loaded = loadWorkflowScript(source, script);
    // The run-by-name lookup keys on the filename stem, not meta.name. Flag a
    // divergence (through the event stream, so it shows in `odw logs` and the
    // dashboard) so the author knows which token actually invokes this file.
    const stem = basename(script).replace(/\.[^.]*$/, "");
    if (loaded.meta.name !== stem) {
      sink.emit(
        event(LOG, {
          message:
            `workflow file '${basename(script)}' declares meta.name '${loaded.meta.name}'; ` +
            `run it by name as '${stem}'`,
        }),
      );
    }
    store.updateStatus(runId, {
      name: loaded.meta.name,
      description: loaded.meta.description,
      phases: loaded.meta.phases,
    });
    const primitives = createPrimitives(ctx);
    const result = await loaded.run(primitives, args);

    store.writeResult(runId, result);
    sink.emit(event(RUN_FINISHED, { runId }));
    store.updateStatus(runId, { state: "done", dispatched: dispatched() });
    return "done";
  } catch (err) {
    if (err instanceof RunStopped) {
      sink.emit(event(RUN_STOPPED, { runId }));
      store.updateStatus(runId, { state: "stopped", dispatched: dispatched() });
      return "stopped";
    }
    const e = err as Error;
    sink.emit(event(RUN_FAILED, { runId, error: e.message ?? String(err) }));
    store.writeError(runId, { error: e.message ?? String(err), stack: e.stack ?? null });
    store.updateStatus(runId, { state: "failed", dispatched: dispatched() });
    return "failed";
  }
}

async function main(argv: string[]): Promise<number> {
  if (argv.length !== 1) {
    process.stderr.write("usage: node runtime/worker.js <run_dir>\n");
    return 2;
  }
  await executeRun(argv[0]!);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
