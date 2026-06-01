/**
 * Workflow loader / transform — THE crux of this runtime.
 *
 * Claude Code's workflow dialect is neither a normal ES module nor a plain
 * script. A file like `deep-research.js` has `export const meta = {...}` at the
 * top, then a *body* that uses top-level `await` AND top-level `return` while
 * referencing *injected globals* (`agent`, `parallel`, `pipeline`, `phase`,
 * `log`, `args`, `budget`, `workflow`) that are never imported.
 *
 * So "loading" is a source transform, done here and nowhere else:
 *
 *   1. Extract the `meta` literal up front (so the runtime can register the
 *      workflow's name/phases before the body runs).
 *   2. Strip the `export` keyword from it.
 *   3. Wrap the remaining body in an async function whose parameters ARE the
 *      injected primitives (plus `args`), so the body's top-level `return`
 *      becomes the workflow's result and its top-level `await` is legal.
 *
 * The transform stays dependency-free: a balanced-brace scan finds the `meta`
 * object literal, and `AsyncFunction` provides the async-with-injected-params
 * wrapper.
 */

import { WorkflowScriptError } from "./errors.js";
import type { WorkflowGlobals } from "./primitives.js";

export interface WorkflowPhaseMeta {
  title: string;
  detail?: string;
  model?: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  phases?: WorkflowPhaseMeta[];
  model?: string;
}

export interface LoadedWorkflow {
  meta: WorkflowMeta;
  /** Execute the transformed body with the injected globals and `args`. */
  run(globals: WorkflowGlobals, args: unknown): Promise<unknown>;
}

// The injected names, in the order the wrapper function receives them.
const PARAM_NAMES = [
  "agent",
  "parallel",
  "pipeline",
  "phase",
  "log",
  "args",
  "budget",
  "workflow",
] as const;

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (...callArgs: unknown[]) => Promise<unknown>;

/** Parse + transform a workflow script's source into a runnable form. */
export function loadWorkflowScript(source: string, filename: string): LoadedWorkflow {
  const { meta, body } = extractMeta(source, filename);

  let factory: (...callArgs: unknown[]) => Promise<unknown>;
  try {
    factory = new AsyncFunction(...PARAM_NAMES, `${body}\n//# sourceURL=${filename}`);
  } catch (err) {
    throw new WorkflowScriptError(`failed to compile workflow ${filename}: ${(err as Error).message}`);
  }

  return {
    meta,
    run(globals: WorkflowGlobals, args: unknown): Promise<unknown> {
      return factory(
        globals.agent,
        globals.parallel,
        globals.pipeline,
        globals.phase,
        globals.log,
        args,
        globals.budget,
        globals.workflow,
      );
    },
  };
}

// --- internals ---------------------------------------------------------------

function extractMeta(source: string, filename: string): { meta: WorkflowMeta; body: string } {
  const match = /export\s+const\s+meta\s*=/.exec(source);
  if (!match) {
    throw new WorkflowScriptError(`workflow ${filename} must 'export const meta = { ... }'`);
  }
  const valueStart = source.indexOf("{", match.index + match[0].length);
  if (valueStart === -1) {
    throw new WorkflowScriptError(`workflow ${filename}: could not find the meta object literal`);
  }
  const end = balancedBraceEnd(source, valueStart);
  if (end === null) {
    throw new WorkflowScriptError(`workflow ${filename}: unterminated meta object literal`);
  }

  const literal = source.slice(valueStart, end + 1);
  let meta: unknown;
  try {
    meta = new Function(`return (${literal});`)();
  } catch (err) {
    throw new WorkflowScriptError(
      `workflow ${filename}: meta must be a literal expression (${(err as Error).message})`,
    );
  }
  assertMeta(meta, filename);

  // Strip the `export` keyword; keep `const meta = <literal>` in the body so the
  // body remains a valid statement sequence.
  const body = source.slice(0, match.index) + "const meta =" + source.slice(match.index + match[0].length);
  return { meta, body };
}

/** Index of the `}` that closes the object opening at `start`, ignoring strings. */
function balancedBraceEnd(text: string, start: number): number | null {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return null;
}

function assertMeta(meta: unknown, filename: string): asserts meta is WorkflowMeta {
  if (meta === null || typeof meta !== "object") {
    throw new WorkflowScriptError(`workflow ${filename}: meta must be an object`);
  }
  const m = meta as Record<string, unknown>;
  if (typeof m.name !== "string" || m.name.length === 0) {
    throw new WorkflowScriptError(`workflow ${filename}: meta.name must be a non-empty string`);
  }
  if (typeof m.description !== "string") {
    throw new WorkflowScriptError(`workflow ${filename}: meta.description must be a string`);
  }
}
